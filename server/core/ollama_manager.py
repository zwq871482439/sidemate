# -*- coding: utf-8 -*-
"""OllamaManager — Ollama 进程生命周期管理

负责：
- 启动/停止 Ollama 进程（ollama serve）
- 健康检查（GET /api/tags）
- 自动启动 + 等待就绪
- Watchdog 线程（定期检查 Ollama 是否存活）
"""
import os
import time
import socket
import logging
import subprocess
import threading
from typing import Optional

import httpx

log = logging.getLogger(__name__)


class OllamaManager:
    """Ollama 进程生命周期管理"""

    def __init__(self, ollama_path: str = "ollama",
                 host: str = "127.0.0.1", port: int = 11434):
        """初始化 Ollama 管理器。

        Args:
            ollama_path: ollama 可执行文件路径（默认从 PATH 查找）
            host: Ollama 服务监听地址
            port: Ollama 服务监听端口
        """
        self._ollama_path = ollama_path
        self._host = host
        self._port = port
        self._process: Optional[subprocess.Popen] = None
        self._watchdog_thread: Optional[threading.Thread] = None
        self._watchdog_stop = threading.Event()
        self._running = False
        self._restart_count = 0  # 连续重启失败计数
        self._MAX_RESTART_ATTEMPTS = 3  # 最大连续重启次数

    @property
    def base_url(self) -> str:
        """Ollama HTTP API 基础 URL"""
        return "http://%s:%d" % (self._host, self._port)

    def start(self) -> dict:
        """启动 Ollama 进程（ollama serve）。

        Returns:
            dict: {"status": "started"|"already_running"|"error", ...}
        """
        if self.is_healthy():
            return {"status": "already_running", "host": self._host, "port": self._port}

        # 检查端口是否被其他进程占用
        if self._is_port_in_use():
            log.info("[OLLAMA] 端口 %d 已被占用，尝试连接..." % self._port)
            if self.is_healthy():
                return {"status": "already_running", "host": self._host, "port": self._port}
            return {"status": "error", "error": "端口 %d 被占用但无法连接 Ollama API" % self._port}

        try:
            self._launch_process()
        except FileNotFoundError:
            return {"status": "error", "error": "找不到 ollama 命令，请先安装 Ollama"}
        except Exception as e:
            return {"status": "error", "error": "启动 Ollama 失败: %s" % str(e)[:200]}

        # 等待就绪
        if self._wait_ready(timeout=60):
            self._start_watchdog()
            self._restart_count = 0  # 启动成功后重置重启计数
            return {"status": "started", "host": self._host, "port": self._port}
        else:
            return {"status": "error", "error": "Ollama 启动超时（60s），请检查 Ollama 安装"}

    def stop(self) -> dict:
        """停止 Ollama 进程。

        Returns:
            dict: {"status": "stopped"|"not_running"}
        """
        self._watchdog_stop.set()
        if self._process is not None:
            try:
                self._process.terminate()
                self._process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._process.kill()
            except Exception as e:
                log.warning("[OLLAMA] 停止进程异常: %s" % str(e)[:80])
            finally:
                self._process = None
                self._running = False
            return {"status": "stopped"}
        return {"status": "not_running"}

    def is_healthy(self) -> bool:
        """检查 Ollama 服务是否健康。

        通过 GET /api/tags 检查。
        """
        try:
            resp = httpx.get(
                "%s/api/tags" % self.base_url,
                timeout=5.0,
            )
            return resp.status_code == 200
        except (httpx.ConnectError, httpx.TimeoutException, OSError):
            return False

    def ensure_running(self) -> bool:
        """确保 Ollama 正在运行，否则自动启动。

        Returns:
            True 表示 Ollama 正在运行。
        """
        if self.is_healthy():
            return True
        result = self.start()
        return result.get("status") in ("started", "already_running")

    def get_status(self) -> dict:
        """返回 Ollama 状态信息。"""
        healthy = self.is_healthy()
        status = {
            "healthy": healthy,
            "host": self._host,
            "port": self._port,
            "process_running": self._process is not None and self._process.poll() is None,
        }
        if healthy:
            try:
                resp = httpx.get(
                    "%s/api/tags" % self.base_url,
                    timeout=5.0,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    models = [m.get("name", "") for m in data.get("models", [])]
                    status["models"] = models
                    status["model_count"] = len(models)
            except Exception:
                status["models"] = []
                status["model_count"] = 0
        return status

    # ====== 内部方法 ======

    def _launch_process(self):
        """启动 ollama serve 子进程"""
        # P2-A2: 从 config 读取 GPU 参数，保留硬编码值作为默认
        try:
            from config import get as _cfg_get
            _gpu_overhead = str(_cfg_get("ollama_gpu_overhead", 2147483648))
            _gpu_layers = str(_cfg_get("ollama_gpu_layers", 99))
        except Exception:
            _gpu_overhead = "2147483648"
            _gpu_layers = "99"

        env = os.environ.copy()
        env["OLLAMA_HOST"] = "%s:%d" % (self._host, self._port)
        env["OLLAMA_VULKAN"] = "1"  # 启用 Vulkan GPU 加速（Intel Arc）
        env["OLLAMA_IGPU_ENABLE"] = "1"  # 允许使用集成显卡（iGPU）
        env["OLLAMA_GPU_LAYERS"] = _gpu_layers
        env["OLLAMA_GPU_OVERHEAD"] = _gpu_overhead
        # 模型存储路径（与 Go Launcher 一致：{root}/server/models）
        _server_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        models_dir = os.path.join(_server_dir, "models")
        env["OLLAMA_MODELS"] = models_dir

        creation_flags = 0
        if os.name == "nt":
            creation_flags = subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]

        self._process = subprocess.Popen(
            [self._ollama_path, "serve"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
            creationflags=creation_flags,
        )
        self._running = True
        log.info("[OLLAMA] 进程已启动 (PID=%d, host=%s, port=%d)" % (
            self._process.pid, self._host, self._port))

    def _wait_ready(self, timeout: int = 60) -> bool:
        """等待 Ollama 服务就绪。

        Args:
            timeout: 最大等待秒数

        Returns:
            True 表示就绪，False 表示超时
        """
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self._process is not None and self._process.poll() is not None:
                log.error("[OLLAMA] 进程意外退出 (exit=%d)" % self._process.returncode)
                return False
            if self.is_healthy():
                return True
            time.sleep(1.0)
        return False

    def _start_watchdog(self):
        """启动 watchdog 线程，定期检查 Ollama 是否存活"""
        if self._watchdog_thread is not None and self._watchdog_thread.is_alive():
            return
        self._watchdog_stop.clear()
        self._watchdog_thread = threading.Thread(target=self._watchdog_loop, daemon=True)
        self._watchdog_thread.start()

    def _watchdog_loop(self):
        """Watchdog 循环：定期检查 Ollama 健康，进程退出时自动重启"""
        while not self._watchdog_stop.wait(timeout=30):
            if self._process is not None and self._process.poll() is not None:
                log.warning("[OLLAMA] Watchdog: 进程已退出 (exit=%d)" % self._process.returncode)
                self._running = False

                # 自动重启逻辑
                if self._restart_count < self._MAX_RESTART_ATTEMPTS:
                    self._restart_count += 1
                    log.info("[OLLAMA] Ollama 进程异常退出，正在自动重启... (第 %d/%d 次)" % (
                        self._restart_count, self._MAX_RESTART_ATTEMPTS))
                    time.sleep(10)  # 重启间隔至少 10 秒
                    result = self.start()
                    if result.get("status") in ("started", "already_running"):
                        log.info("[OLLAMA] 自动重启成功")
                        self._restart_count = 0  # 成功后重置计数
                        continue
                    else:
                        log.warning("[OLLAMA] 自动重启失败: %s" % result.get("error", "unknown"))
                else:
                    log.error("[OLLAMA] 已连续重启失败 %d 次，停止自动重启" % self._MAX_RESTART_ATTEMPTS)
                    break

            if not self._watchdog_stop.is_set() and not self.is_healthy():
                log.warning("[OLLAMA] Watchdog: 健康检查失败")

    def _is_port_in_use(self) -> bool:
        """检查端口是否被占用"""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(1)
                result = s.connect_ex((self._host, self._port))
                return result == 0
        except OSError:
            return False

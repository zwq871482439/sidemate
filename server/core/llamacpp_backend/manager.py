# -*- coding: utf-8 -*-
"""LlamaCppManager — llama-server.exe 进程生命周期管理

P7-4 底座替换：替代 ollama_manager.py。

与 Ollama 的关键差异：
  - Ollama 是"一进程多模型"（ollama serve 无模型参数，运行时按需加载）
  - llama-server 是"一进程一模型"（启动时必须指定 --model，换模型=重启进程）
  - num_ctx 只能启动时定（--ctx-size），请求级不能改
  - GPU 路由：-ngl 0=纯CPU / -ngl 99=全offload

保留了 ollama_manager 的三大生产能力：
  - watchdog 自动重启（进程崩溃 3 次内自动恢复）
  - ownership 三态（MANAGED/EXTERNAL/None，避免误杀外部实例）
  - 端口占用重试（3 次重试避免误报）
"""
import os
import time
import socket
import logging
import subprocess
import threading
from typing import Optional, List

import httpx

log = logging.getLogger(__name__)


class LlamaCppManager:
    """llama-server 进程生命周期管理"""

    def __init__(self,
                 llama_server_path: str = "llama-server",
                 host: str = "127.0.0.1",
                 port: int = 11434,
                 ctx_size: int = 8192,
                 n_gpu_layers: int = 99,
                 n_threads: Optional[int] = None,
                 extra_args: Optional[List[str]] = None):
        self._llama_server_path = llama_server_path
        self._host = host
        self._port = port
        self._ctx_size = ctx_size
        self._n_gpu_layers = n_gpu_layers
        self._n_threads = n_threads
        self._extra_args = extra_args or []
        self._process: Optional[subprocess.Popen] = None
        self._current_model: Optional[str] = None
        self._restart_model: Optional[str] = None  # S2: watchdog 重启专用快照（不被 _do_stop 清空）
        # watchdog / ownership（从 ollama_manager 搬迁）
        self._watchdog_thread: Optional[threading.Thread] = None
        self._watchdog_stop = threading.Event()
        self._running = False
        self._restart_count = 0
        self._MAX_RESTART_ATTEMPTS = 3
        self._ownership = None  # MANAGED / EXTERNAL / None

    @property
    def base_url(self) -> str:
        """OpenAI 兼容 API 基础 URL"""
        return "http://%s:%d/v1" % (self._host, self._port)

    @property
    def host(self) -> str:
        return self._host

    @property
    def port(self) -> int:
        return self._port

    @property
    def current_model(self) -> Optional[str]:
        return self._current_model

    @property
    def ctx_size(self) -> int:
        return self._ctx_size

    def is_healthy(self) -> bool:
        """检查 llama-server 健康（GET /v1/models 返回 200 且有模型）

        P7-4: 必须验证 body 里有模型，否则会把残留的 Ollama 进程（/v1/models
        返回空或 data:null）误判为健康，走 EXTERNAL 复用而不启动 llama-server。
        """
        try:
            resp = httpx.get(
                "http://%s:%d/v1/models" % (self._host, self._port),
                timeout=5.0,
                trust_env=False,  # 直连本地，绕过系统代理
            )
            if resp.status_code != 200:
                return False
            # 验证是 llama-server 而非 Ollama：data 字段要有模型
            data = resp.json()
            models = data.get("data")
            return models is not None and len(models) > 0
        except (httpx.ConnectError, httpx.TimeoutException, OSError, Exception):
            return False

    def start(self, model_path: str = None, timeout: int = 120) -> dict:
        """启动 llama-server。

        Args:
            model_path: GGUF 文件绝对路径。如果已有进程在跑且加载的是同一模型，
                        则复用。None 时尝试复用已有进程。
            timeout: 等待就绪秒数

        Returns:
            dict: {"status": "started"|"already_running"|"error", ...}
        """
        # 已有健康进程
        if self.is_healthy():
            if model_path and self._current_model and os.path.abspath(self._current_model) != os.path.abspath(model_path):
                # 加载的是不同模型 → 需要重启切换
                log.info("[LLAMACPP] 当前模型 %s ≠ 目标 %s，重启切换" % (
                    os.path.basename(self._current_model or ""), os.path.basename(model_path)))
                self._do_stop()
            else:
                self._ownership = "EXTERNAL"
                log.info("[LLAMACPP] 检测到已有 llama-server 实例（EXTERNAL 模式）")
                return {"status": "already_running", "host": self._host, "port": self._port}

        # 端口被占但不健康（可能是 Ollama 残留或 llama-server 正在加载）
        if self._is_port_in_use() and not self.is_healthy():
            # 先重试等它变健康（llama-server 正在加载模型的情况）
            if self._wait_healthy_with_retry(retries=3, interval=3):
                self._ownership = "EXTERNAL"
                log.info("[LLAMACPP] 复用已有 llama-server 实例（EXTERNAL 模式）")
                return {"status": "already_running", "host": self._host, "port": self._port}
            # 仍不健康 → 可能是 Ollama 残留，杀掉占用端口的进程
            log.warning("[LLAMACPP] 端口 %d 被占用但不健康，尝试清理..." % self._port)
            self._kill_port_owner()
            time.sleep(2)

        if model_path and not os.path.exists(model_path):
            return {"status": "error", "error": "模型文件不存在: %s" % model_path}

        if not model_path:
            return {"status": "error", "error": "未指定模型文件路径"}

        # 启动进程
        try:
            self._launch_process(model_path)
        except FileNotFoundError:
            return {"status": "error", "error": "找不到 llama-server: %s" % self._llama_server_path}
        except Exception as e:
            return {"status": "error", "error": "启动失败: %s" % str(e)[:200]}

        # 等待就绪
        if self._wait_ready(timeout=timeout):
            self._ownership = "MANAGED"
            self._start_watchdog()
            self._restart_count = 0
            return {"status": "started", "host": self._host, "port": self._port, "model": model_path}
        else:
            return {"status": "error", "error": "llama-server 启动超时（%ds）" % timeout}

    def stop(self) -> dict:
        """停止 llama-server 进程（基于 ownership 决策）"""
        self._watchdog_stop.set()
        if self._ownership == "EXTERNAL":
            log.info("[LLAMACPP] stop: EXTERNAL 模式，不干预外部进程")
            self._ownership = None
            self._running = False
            return {"status": "external_not_managed"}

        self._do_stop()
        return {"status": "stopped"} if self._ownership == "MANAGED" else {"status": "not_running"}

    def _do_stop(self):
        """实际停止进程（内部用）"""
        if self._process is not None:
            try:
                self._process.terminate()
                self._process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                log.warning("[LLAMACPP] terminate 超时，强制 kill")
                self._process.kill()
            except Exception as e:
                log.warning("[LLAMACPP] 停止异常: %s" % str(e)[:80])
            finally:
                self._process = None
                self._running = False
                self._ownership = None
                self._current_model = None

    def ensure_running(self, model_path: str = None) -> bool:
        """确保 llama-server 正在运行"""
        if self.is_healthy():
            # 如果指定了模型且和当前不同，需要重启
            if model_path and self._current_model:
                if os.path.abspath(self._current_model) != os.path.abspath(model_path):
                    result = self.start(model_path)
                    return result.get("status") in ("started", "already_running")
            return True
        result = self.start(model_path)
        return result.get("status") in ("started", "already_running")

    def get_status(self) -> dict:
        """返回当前状态"""
        healthy = self.is_healthy()
        return {
            "healthy": healthy,
            "host": self._host,
            "port": self._port,
            "process_running": self._process is not None and self._process.poll() is None,
            "ownership": self._ownership,
            "current_model": self._current_model,
            "ctx_size": self._ctx_size,
            "n_gpu_layers": self._n_gpu_layers,
        }

    def switch_model(self, model_path: str, timeout: int = 120) -> dict:
        """切换模型（强制 kill 所有 llama-server + 重新启动）"""
        log.info("[LLAMACPP] 切换模型: %s → %s" % (
            os.path.basename(self._current_model or "?"), os.path.basename(model_path)))
        self._do_stop()
        # 确保旧进程彻底死了（_do_stop 在 EXTERNAL 模式下 _process=None 不杀）
        self._kill_port_owner()
        # 等端口彻底释放（llama-server 退出后端口可能有 TIME_WAIT）
        _wait_deadline = time.time() + 15
        while time.time() < _wait_deadline:
            if not self._is_port_in_use():
                break
            time.sleep(0.5)
        # 强制启动新模型（_force_start 跳过 EXTERNAL 复用检查）
        return self._force_start(model_path, timeout=timeout)

    def _force_start(self, model_path: str, timeout: int = 120) -> dict:
        """强制启动（不检查 EXTERNAL 复用，用于 switch_model 后）"""
        if not os.path.exists(model_path):
            return {"status": "error", "error": "模型文件不存在: %s" % model_path}
        try:
            self._launch_process(model_path)
        except FileNotFoundError:
            return {"status": "error", "error": "找不到 llama-server: %s" % self._llama_server_path}
        except Exception as e:
            return {"status": "error", "error": "启动失败: %s" % str(e)[:200]}
        if self._wait_ready(timeout=timeout):
            self._ownership = "MANAGED"
            self._start_watchdog()
            self._restart_count = 0
            return {"status": "started", "host": self._host, "port": self._port, "model": model_path}
        return {"status": "error", "error": "llama-server 启动超时（%ds）" % timeout}

    def update_ctx_size(self, ctx_size: int) -> dict:
        """更新 ctx_size（需要重启进程生效）"""
        self._ctx_size = ctx_size
        if self._current_model:
            log.info("[LLAMACPP] ctx_size 改为 %d，重启生效" % ctx_size)
            return self.switch_model(self._current_model)
        return {"status": "ok", "ctx_size": ctx_size}

    # ====== 内部方法 ======

    def _wait_healthy_with_retry(self, retries: int = 3, interval: float = 3.0) -> bool:
        """带重试的健康检查"""
        for attempt in range(1, retries + 1):
            if self.is_healthy():
                if attempt > 1:
                    log.info("[LLAMACPP] 第 %d/%d 次重试连接成功" % (attempt, retries))
                return True
            if attempt < retries:
                log.info("[LLAMACPP] 端口被占用但暂未响应，%ds 后重试 (%d/%d)..." % (interval, attempt, retries))
                time.sleep(interval)
        log.warning("[LLAMACPP] 重试 %d 次后仍无法连接" % retries)
        return False

    def _launch_process(self, model_path: str):
        """启动 llama-server 子进程"""
        cmd = [
            self._llama_server_path,
            "--model", model_path,
            "--host", self._host,
            "--port", str(self._port),
            "--ctx-size", str(self._ctx_size),
            "--n-gpu-layers", str(self._n_gpu_layers),
        ]
        if self._n_threads is not None:
            cmd += ["--threads", str(self._n_threads)]
        cmd += self._extra_args

        env = os.environ.copy()
        # Windows Vulkan GPU 加速（llama.cpp 用 GGML_VULKAN，不是 OLLAMA_VULKAN）
        env["GGML_VULKAN"] = "1"

        creation_flags = 0
        if os.name == "nt":
            creation_flags = subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]

        log.info("[LLAMACPP] 启动: %s" % " ".join(cmd))

        self._process = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
            creationflags=creation_flags,
        )
        self._running = True
        self._current_model = model_path
        self._restart_model = model_path  # S2: watchdog 重启用（不会被 _do_stop 清空）
        log.info("[LLAMACPP] 进程已启动 (PID=%d)" % self._process.pid)

    def _wait_ready(self, timeout: int = 60) -> bool:
        """等待 llama-server 就绪"""
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self._process is not None and self._process.poll() is not None:
                log.error("[LLAMACPP] 进程意外退出 (exit=%d)" % self._process.returncode)
                return False
            if self.is_healthy():
                return True
            time.sleep(1.0)
        return False

    def _start_watchdog(self):
        """启动 watchdog 线程"""
        if self._watchdog_thread is not None and self._watchdog_thread.is_alive():
            return
        self._watchdog_stop.clear()
        self._watchdog_thread = threading.Thread(target=self._watchdog_loop, daemon=True)
        self._watchdog_thread.start()

    def _watchdog_loop(self):
        """Watchdog：进程退出时自动重启（最多 3 次）"""
        while not self._watchdog_stop.wait(timeout=30):
            if self._process is not None and self._process.poll() is not None:
                log.warning("[LLAMACPP] Watchdog: 进程已退出 (exit=%d)" % self._process.returncode)
                self._running = False

                if self._restart_count < self._MAX_RESTART_ATTEMPTS:
                    self._restart_count += 1
                    log.info("[LLAMACPP] 自动重启... (第 %d/%d 次)" % (
                        self._restart_count, self._MAX_RESTART_ATTEMPTS))
                    time.sleep(10)
                    # S2: 用 _restart_model（不会被 _do_stop 清空）
                    if self._restart_model:
                        result = self.start(self._restart_model)
                        if result.get("status") in ("started", "already_running"):
                            log.info("[LLAMACPP] 自动重启成功")
                            self._restart_count = 0
                            if self._ownership == "EXTERNAL":
                                break
                            continue
                        else:
                            log.warning("[LLAMACPP] 自动重启失败: %s" % result.get("error", "unknown"))
                else:
                    log.error("[LLAMACPP] 连续重启失败 %d 次，停止" % self._MAX_RESTART_ATTEMPTS)
                    break

            if not self._watchdog_stop.is_set() and not self.is_healthy():
                log.warning("[LLAMACPP] Watchdog: 健康检查失败")

    def _is_port_in_use(self) -> bool:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(1)
                return s.connect_ex((self._host, self._port)) == 0
        except OSError:
            return False

    def _kill_port_owner(self):
        """杀掉占用端口的进程（覆盖 llama-server + Ollama 遗留）"""
        if os.name != "nt":
            return
        # S1 修复：必须含 llama-server.exe（之前漏了导致双进程）
        for name in ["llama-server.exe", "ollama.exe", "ollama_llama_server.exe"]:
            try:
                subprocess.run(
                    ["taskkill", "/IM", name, "/F"],
                    capture_output=True, timeout=5,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
            except Exception:
                pass
        log.info("[LLAMACPP] 已清理占用端口的旧进程")

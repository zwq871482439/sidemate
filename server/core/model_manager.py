# -*- coding: utf-8 -*-
"""
模型管理器 - Ollama HTTP API 后端

通过 Ollama HTTP API 管理 LLM 模型的加载、卸载和推理。
公共接口签名保持不变，内部实现全部委托给 Ollama。
"""
__version__ = "v2.0"

import time, os, threading, re, json, logging
from typing import Optional, List, Dict

from core.generate_queue import GenerateQueue, GenerateTicket
from core.prompt_builder import PromptBuilder
from core.stream_engine import StreamEngine
from core.think_processor import ThinkProcessor
from config import get as _cfg

log = logging.getLogger(__name__)
log_scan = logging.getLogger("local-ai")


class ModelManager:
    """单例模型管理器，线程安全（Ollama 后端）"""

    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._initialized = False
                cls._instance._init_lock = threading.Lock()
            return cls._instance

    def __init__(self):
        # P1-10: 使用实例级锁保护 __init__，防止并发初始化
        init_lock = getattr(self, '_init_lock', None)
        if init_lock is None:
            return
        with init_lock:
            if self._initialized:
                return
            self._initialized = True

        # 组合对象初始化
        self._think_processor = ThinkProcessor()
        self._prompt_builder = PromptBuilder(self)
        self._stream_engine = StreamEngine(self)

        # 项目根目录
        self.base_dir = os.path.dirname(os.path.abspath(__file__))
        self.base_dir = os.path.dirname(self.base_dir)

        # Ollama 配置
        try:
            from config import get as _cfg
            self._ollama_host = _cfg("ollama_host", "127.0.0.1")
            self._ollama_port = _cfg("ollama_port", 11434)
            self._ollama_model = _cfg("ollama_model", "qwen3-5-4b")
        except Exception:
            self._ollama_host = "127.0.0.1"
            self._ollama_port = 11434
            self._ollama_model = "qwen3-5-4b"

        self._ollama_base_url = "http://%s:%d" % (self._ollama_host, self._ollama_port)
        self._ollama_connect_timeout = 30
        self._ollama_read_timeout = 120
        self._keep_alive = _cfg("ollama_keep_alive", "24h")

        # 模型配置：构建 Ollama 模型条目
        self.model_configs = {}
        self._loaded = {}  # 必须在 _scan_ollama_models 之前初始化（该方法会写入 _loaded）
        self._scan_ollama_models()

        # 状态
        self._load_times = {}
        self._model_mem_mb = {}
        self._stop_generation = False
        self._stop_lock = threading.Lock()
        self._gen_lock = threading.RLock()
        self.generate_queue = GenerateQueue()
        self._gen_done = threading.Event()
        self._gen_done.set()
        self._last_loaded_model = None
        self._auto_reload_after_stop = False
        self._stopping = False
        self._stop_op_lock = threading.Lock()
        self._system_prompt_rules = None
        self._stats = {
            "total_requests": 0,
            "total_llm_chars": 0,
            "total_llm_time": 0,
        }
        self._stats_lock = threading.Lock()

        # 模型 profile 参数（字符数估算替代 token 计数）
        self._CHARS_PER_TOKEN = 1.5  # 平均每个 token 约 1.5 个字符
        self._MAX_PROMPT_CHARS = 28000  # Qwen3.5-4B 约 32K tokens 上下文

    # ====== stop_requested 属性 ======

    @property
    def stop_requested(self) -> bool:
        """线程安全地读取停止标志"""
        with self._stop_lock:
            return self._stop_generation

    @stop_requested.setter
    def stop_requested(self, value: bool) -> None:
        """线程安全地设置停止标志"""
        with self._stop_lock:
            self._stop_generation = value

    # ====== Think 标签方法（委托给 ThinkProcessor）======

    def _strip_think(self, text: str) -> str:
        """过滤思维链标签"""
        return self._think_processor._strip_think(text)

    def strip_think(self, text: str) -> str:
        """公开接口：过滤思维链标签"""
        return self._think_processor.strip_think(text)

    # ====== Prompt 构建方法（委托给 PromptBuilder）======

    def _get_system_prompt_rules(self):
        """延迟加载系统提示词"""
        return self._prompt_builder.get_system_prompt_rules()

    def _build_prompt(self, pipe, message: str, history: Optional[List] = None,
                      model_name: str = None, context_cache: str = None,
                      task_type: str = None,
                      signals: dict = None, kb_mode: bool = False,
                      strategy_enhancement: str = "",
                      kb_history_turns: int = 0,
                      think_mode: str = None) -> list:
        """构建 OpenAI messages 数组（pipe 参数保留签名兼容，内部不使用）"""
        return self._prompt_builder.build(pipe, message, history, model_name=model_name,
                                           context_cache=context_cache, task_type=task_type,
                                           signals=signals,
                                           kb_mode=kb_mode,
                                           strategy_enhancement=strategy_enhancement,
                                           kb_history_turns=kb_history_turns,
                                           think_mode=think_mode)

    # ====== 流式生成（委托给 StreamEngine）======

    def chat_stream(self, message: str, model: str = None,
                    max_tokens: int = None, history: Optional[List] = None,
                    context_cache: str = None,
                    _agent_mode: bool = False, override_task_type: str = None,
                    strategy_enhancement: str = "",
                    kb_mode: bool = False,
                    kb_history_turns: int = 0,
                    _priority: str = None):
        """LLM 流式对话生成器（根据 ai_mode 路由到本地或云端）"""
        ai_mode = _cfg("ai_mode", "local") if _cfg else "local"
        if ai_mode == "cloud":
            if not hasattr(self, '_cloud_engine'):
                from core.cloud_engine import CloudEngine
                self._cloud_engine = CloudEngine(self)
            yield from self._cloud_engine.run(message, model=model, max_tokens=max_tokens,
                                               history=history, context_cache=context_cache,
                                               _agent_mode=_agent_mode,
                                               override_task_type=override_task_type,
                                               strategy_enhancement=strategy_enhancement,
                                               kb_mode=kb_mode,
                                               kb_history_turns=kb_history_turns,
                                               _priority=_priority)
        else:
            yield from self._stream_engine.run(message, model=model, max_tokens=max_tokens,
                                                history=history, context_cache=context_cache,
                                                _agent_mode=_agent_mode,
                                                override_task_type=override_task_type,
                                                strategy_enhancement=strategy_enhancement,
                                                kb_mode=kb_mode,
                                                kb_history_turns=kb_history_turns,
                                                _priority=_priority)

    # ====== 环境检测 ======

    def _detect_env(self) -> str:
        """检测运行环境，返回简短环境描述文本"""
        import platform
        import importlib

        parts = []
        os_name = platform.system()
        if os_name == "Windows":
            parts.append("Windows 系统")
        elif os_name == "Darwin":
            parts.append("macOS 系统")
        else:
            parts.append("%s 系统" % os_name)

        py_ver = platform.python_version()
        parts.append("Python %s" % py_ver)
        parts.append("Ollama + %s" % self._ollama_model)

        data_libs = []
        for lib in ["numpy", "pandas", "PIL", "matplotlib", "requests"]:
            try:
                importlib.import_module(lib)
                data_libs.append(lib if lib != "PIL" else "Pillow")
            except ImportError:
                pass
        if data_libs:
            parts.append("已装: %s" % ", ".join(data_libs))

        env_text = "环境: " + "，".join(parts)
        log_scan.info("[ENV] %s" % env_text)
        return env_text

    # ====== Ollama 模型扫描 ======

    def _scan_ollama_models(self):
        """从 Ollama API 获取可用模型列表"""
        try:
            import httpx
            resp = httpx.get(
                "%s/api/tags" % self._ollama_base_url,
                timeout=5.0,
            )
            if resp.status_code == 200:
                data = resp.json()
                for m in data.get("models", []):
                    name = m.get("name", "")
                    if name:
                        self.model_configs[name] = {
                            "type": "llm",
                            "path": name,  # Ollama 模型没有本地路径，用名称代替
                            "device": "ollama",
                            "description": self._make_description(name, name),
                            "dir": name,
                            "size": m.get("size", 0),
                        }
                        # Ollama 模型随时可用，自动标记为 loaded
                        self._loaded[name] = True
                log_scan.info("[OLLAMA] 发现 %d 个模型: %s" % (
                    len(data.get("models", [])),
                    [m.get("name", "") for m in data.get("models", [])]))
                return
        except Exception as e:
            log_scan.warning("[OLLAMA] 扫描模型失败: %s" % str(e)[:80])

        # Ollama 不可用时，不填充假模型——前端以 available 为空展示引导
        log_scan.info("[OLLAMA] Ollama 不可用，available 将为空")

    def _scan_models(self):
        """重新扫描模型（委托给 _scan_ollama_models）"""
        # 清除旧的 LLM 配置
        self.model_configs = {k: v for k, v in self.model_configs.items() if v["type"] != "llm"}
        self._scan_ollama_models()

    # 已知模型的固定描述
    _KNOWN_MODELS = {
        "qwen3-5-4b": "Qwen3.5 4B - Ollama LLM",
        "qwen3.5-4b": "Qwen3.5 4B - Ollama LLM",
        "qwen3-0.6b": "Qwen3 0.6B - Ollama LLM",
        "qwen3-1.7b": "Qwen3 1.7B - Ollama LLM",
        "qwen3-4b":   "Qwen3 4B - Ollama LLM",
        "qwen3-8b":   "Qwen3 8B - Ollama LLM",
        "qwen3-14b":  "Qwen3 14B - Ollama LLM",
        "qwen2.5-7b": "Qwen2.5 7B - Ollama LLM",
        "qwen2.5-14b": "Qwen2.5 14B - Ollama LLM",
        "llama3.1-8b": "Llama3.1 8B - Ollama LLM",
    }

    @classmethod
    def _short_name(cls, model_id):
        """将 model_id 缩短为前端友好的显示名"""
        for known in cls._KNOWN_MODELS:
            if model_id == known or model_id.startswith(known + "-"):
                return known
        # Ollama 模型名可能有 :latest 后缀
        base = model_id.split(":")[0] if ":" in model_id else model_id
        return base

    def _make_description(self, model_id, dirname):
        """生成模型描述"""
        base = model_id.split(":")[0] if ":" in model_id else model_id
        return self._KNOWN_MODELS.get(base,
               self._KNOWN_MODELS.get(model_id, "Ollama LLM (%s)" % dirname))

    # ====== 状态报告 ======

    def status(self) -> Dict:
        """获取所有模型状态"""
        result = {}
        for name, cfg in self.model_configs.items():
            result[name] = {
                "description": cfg["description"],
                "type": cfg["type"],
                "device": cfg["device"],
                "loaded": True,  # Ollama 模型始终"就绪"
                "load_time": self._load_times.get(name),
                "model_type": "文字模型" if cfg["type"] == "llm" else cfg["type"],
            }
        result["_stats"] = getattr(self, "_stats", {
            "total_requests": 0,
            "total_llm_chars": 0,
            "total_llm_time": 0,
        })
        return result

    @staticmethod
    def _rss_mb() -> int:
        """获取当前进程 RSS（MB）"""
        try:
            import psutil
            return int(psutil.Process(os.getpid()).memory_info().rss / 1024 / 1024)
        except Exception as e:
            log.warning("[MODEL] psutil RSS 获取失败: %s" % str(e)[:80])
            return 0

    # ====== 模型加载/卸载（Ollama API 版）======

    def load(self, name: str, progress_callback=None) -> Dict:
        """加载模型（Ollama 版：检查模型是否存在）"""
        # Ollama 使用 model:tag 格式，尝试匹配
        matched_name = self._find_model_name(name)
        if matched_name is None:
            # 尝试 pull 模型
            return {"error": "Ollama 中未找到模型: %s，请先运行 ollama pull %s" % (name, name)}

        if progress_callback:
            progress_callback(50, "检查模型")

        self._loaded[matched_name] = True
        self._load_times[matched_name] = 0.0
        self._last_loaded_model = matched_name
        self._model_mem_mb[matched_name] = 0

        if progress_callback:
            progress_callback(100, "就绪")

        log.info("[Model] %s 已就绪（Ollama 管理）" % matched_name)
        return {"status": "loaded", "model": matched_name, "time": 0, "mem_mb": 0}

    def unload(self, name: str) -> Dict:
        """卸载模型（Ollama API：POST /api/generate with keep_alive: 0）"""
        matched_name = self._find_model_name(name)
        if matched_name is None:
            return {"status": "not_loaded", "model": name}

        try:
            import httpx
            httpx.post(
                "%s/api/generate" % self._ollama_base_url,
                json={"model": matched_name, "keep_alive": 0},
                timeout=10.0,
            )
        except Exception as e:
            log.warning("[Model] Ollama unload 失败: %s" % str(e)[:80])

        self._loaded.pop(matched_name, None)
        self._load_times.pop(matched_name, None)
        self._model_mem_mb.pop(matched_name, None)
        return {"status": "unloaded", "model": matched_name, "freed_mb": 0}

    def delete_model(self, name: str) -> Dict:
        """删除 Ollama 中的模型（DELETE /api/delete），释放磁盘空间"""
        matched_name = self._find_model_name(name)
        if matched_name is None:
            # 尝试直接用原名
            matched_name = name

        try:
            import httpx
            resp = httpx.request(
                "DELETE",
                "%s/api/delete" % self._ollama_base_url,
                json={"name": matched_name},
                timeout=30.0,
            )
            if resp.status_code == 200:
                self._loaded.pop(matched_name, None)
                self._load_times.pop(matched_name, None)
                self._model_mem_mb.pop(matched_name, None)
                # 从 model_configs 移除
                self.model_configs.pop(matched_name, None)
                log.info("[Model] 已删除模型: %s" % matched_name)
                return {"ok": True, "model": matched_name, "msg": "模型已删除"}
            else:
                err = resp.text[:200] if resp.text else "HTTP %d" % resp.status_code
                log.warning("[Model] Ollama delete 失败: %s" % err)
                return {"ok": False, "error": "删除失败: %s" % err}
        except Exception as e:
            log.warning("[Model] Ollama delete 异常: %s" % str(e)[:80])
            return {"ok": False, "error": "删除失败: %s" % str(e)[:100]}

    def load_all(self) -> Dict:
        """加载所有模型（Ollama 中为 no-op，模型按需加载）"""
        results = {}
        for name in self.model_configs:
            results[name] = self.load(name)
        return results

    # ====== 查询 ======

    def get_loaded_llms(self) -> list:
        """返回已加载的 LLM 模型名列表"""
        return [name for name, cfg in self.model_configs.items()
                if cfg["type"] == "llm" and name in self._loaded]

    def get_llm_mem_mb(self, name: str) -> int:
        """返回指定 LLM 的内存占用 MB（从 Ollama API 获取）"""
        cached = self._model_mem_mb.get(name, 0)
        if cached > 0:
            return cached
        # 尝试从 Ollama API 获取
        try:
            import httpx
            resp = httpx.get(
                "%s/api/ps" % self._ollama_base_url,
                timeout=3.0,
            )
            if resp.status_code == 200:
                data = resp.json()
                for m in data.get("models", []):
                    mname = m.get("name", "")
                    # 匹配模型名（带或不带 :latest 后缀）
                    if mname == name or mname == name + ":latest" or name.startswith(mname.split(":")[0]):
                        size_vram = m.get("size_vram", 0)
                        size_total = m.get("size", 0)
                        # VRAM 优先；CPU 模型 fallback 到总大小
                        size_bytes = size_vram if size_vram > 0 else size_total
                        if size_bytes > 0:
                            mem_mb = int(size_bytes / 1024 / 1024)
                            self._model_mem_mb[name] = mem_mb
                            return mem_mb
        except Exception:
            pass
        # 兜底：根据模型参数量估算（量化模型约 0.6GB/B, FP16 约 1.1GB/B）
        try:
            params_b = self._get_model_size(name)
            estimated_mb = int(params_b * 600)  # 量化模型约 600MB/B
            self._model_mem_mb[name] = estimated_mb
            return estimated_mb
        except Exception:
            pass
        return 0

    def _get_default_llm(self) -> Optional[str]:
        """返回默认 LLM 模型名，无模型时返回 None"""
        loaded = self.get_loaded_llms()
        if loaded:
            return loaded[0]
        llms = [name for name, cfg in self.model_configs.items() if cfg["type"] == "llm"]
        if not llms:
            return None
        # 优先选择配置的默认模型
        for pref in [self._ollama_model, "qwen3-5-4b", "qwen3.5-4b", "qwen3-8b", "qwen3-4b"]:
            for llm in llms:
                if llm.startswith(pref.split(":")[0]):
                    return llm
        return llms[0]

    # ====== 停止控制 ======

    def stop_generation(self):
        """中断当前正在进行的 LLM 生成"""
        if not self._stop_op_lock.acquire(blocking=False):
            log_scan.info("[STOP] 已有 stop 操作进行中，跳过重复请求")
            return
        try:
            self._stopping = True
            with self._stop_lock:
                self._stop_generation = True
            # 强制关闭 Ollama HTTP 连接，避免空跑
            if hasattr(self, '_stream_engine') and self._stream_engine:
                self._stream_engine.stop_generation()
            log_scan.info("[STOP] 收到停止生成信号，等待 generate 结束...")
            self._gen_done.wait(timeout=8.0)
            self._stopping = False
            self.generate_queue.cancel_all_low()
            if self._gen_lock.locked():
                try:
                    self._gen_lock.release()
                    log_scan.warning("[STOP] 强制释放 _gen_lock")
                except RuntimeError:
                    pass
            log_scan.info("[STOP] 停止完成")
        finally:
            self._stop_op_lock.release()

    # ====== 设备管理（Ollama 自动管理设备，保留接口兼容）======

    def get_available_devices(self):
        """返回可用设备列表（Ollama 版：返回 ollama）"""
        return {
            "devices": ["ollama"],
            "current": "ollama",
            "error": None,
        }

    def switch_device(self, new_device: str) -> dict:
        """切换推理设备（Ollama 版：no-op）"""
        return {"status": "same", "device": "ollama", "message": "Ollama 自动管理设备"}

    # ====== 模型大小自适应参数 ======

    _MODEL_PROFILES = {
        0.5: {
            "max_history_chars": 2500,
            "default_max_tokens": 1024,
            "max_rounds": 4,
            "temperature": 0.5,
            "top_p": 0.85,
        },
        1.5: {
            "max_history_chars": 3500,
            "default_max_tokens": 1536,
            "max_rounds": 5,
            "temperature": 0.55,
            "top_p": 0.88,
        },
        4: {
            "max_history_chars": 12000,
            "default_max_tokens": 4096,  # = MAX_OUTPUT_TOKENS（4B profile）
            "max_rounds": 6,
            "temperature": 0.6,
            "top_p": 0.9,
        },
        8: {
            "max_history_chars": 6000,
            "default_max_tokens": 5120,
            "max_rounds": 6,
            "temperature": 0.6,
            "top_p": 0.9,
        },
        14: {
            "max_history_chars": 8000,
            "default_max_tokens": 4096,  # = MAX_OUTPUT_TOKENS（14B profile）
            "max_rounds": 8,
            "temperature": 0.7,
            "top_p": 0.92,
        },
    }

    # 默认设备（Ollama 版无意义，保留兼容）
    _default_device = "ollama"

    def _get_model_size(self, model_name: str) -> float:
        """从模型名解析参数量（Billion）"""
        name_lower = (model_name or "").lower()
        m = re.search(r'(\d+\.?\d*)\s*b', name_lower)
        if not m:
            return 4  # 默认 4B
        size = float(m.group(1))
        keys = sorted(self._MODEL_PROFILES.keys())
        best = keys[0]
        for k in keys:
            if abs(k - size) <= abs(best - size):
                best = k
        return best

    def _get_profile(self, model_name: str) -> dict:
        """获取模型对应的运行参数 profile"""
        size_key = self._get_model_size(model_name)
        return self._MODEL_PROFILES.get(size_key, self._MODEL_PROFILES[4])

    def _get_device_token_limit(self, model_name=None, device=None):
        """获取 prompt token 上限（统一从 config 读取）"""
        from config import MAX_INPUT_TOKENS
        return MAX_INPUT_TOKENS

    def calc_output_reservation(self, kb_mode: bool = False, history_chars: int = 0) -> int:
        """动态计算输出预留（num_predict）。

        问题背景：原 MAX_OUTPUT_TOKENS=4096 固定占用一半 8K 窗口，导致历史空间不足
        （KB 模式下历史只剩 ~511 token）。本地 4B 模型实际生成通常 500-1500 字
        （~350-1000 token），预留 4096 是严重浪费。

        动态策略：
        - 无 KB（普通对话）：预留 2048（足够生成长回答，释放一半空间给历史）
        - 有 KB（知识库问答）：预留 1500（KB 回答通常更聚焦，且 KB context 已占 ~40%）
        - 历史很长时进一步压缩预留（按 history_chars 线性下调，但不低于 768）

        Args:
            kb_mode: 是否 KB 模式
            history_chars: 当前历史字符数（用于进一步压缩预留）

        Returns:
            int — 输出预留 token 数
        """
        from config import MAX_OUTPUT_TOKENS
        # 基线预留
        base = 1500 if kb_mode else 2048
        # 历史占用大时（>4000 字 ≈ 2700 token），逐步压缩预留到下限 768
        if history_chars > 4000:
            # 每 1000 字历史压缩 150 token 预留，但不低于 768
            compressed = base - (history_chars - 4000) / 1000 * 150
            base = max(768, int(compressed))
        # 不超过原 MAX_OUTPUT_TOKENS 上限
        return min(base, MAX_OUTPUT_TOKENS)

    def calc_kb_context_budget(self, kb_mode: bool = True, history_chars: int = 0) -> dict:
        """计算 KB 问答的 context 预算。

        Args:
            kb_mode: 是否 KB 模式（影响输出预留计算）
            history_chars: 当前历史字符数（透传给 calc_output_reservation）
        """
        max_prompt_tokens = self._get_device_token_limit()

        try:
            from prompts import KB_SYSTEM_PROMPT_TEMPLATE, KB_USER_PROMPT_TEMPLATE
            _template_filled = KB_USER_PROMPT_TEMPLATE.format(context="", question="")
            _overhead_chars = len(KB_SYSTEM_PROMPT_TEMPLATE) + len(_template_filled)
            _overhead_chars += 80
            overhead_tokens = int(_overhead_chars / 1.2) + 60
        except Exception:
            overhead_tokens = 500

        # 输出预留动态化：扣掉 calc_output_reservation（原代码完全没考虑输出预留）
        output_reservation = self.calc_output_reservation(kb_mode=kb_mode, history_chars=history_chars)
        safe_tokens = int((max_prompt_tokens - overhead_tokens - output_reservation) * 0.95)
        safe_tokens = max(200, safe_tokens)
        safe_chars = int(safe_tokens / 1.5)
        safe_chars = min(safe_chars, 8000)

        return {
            "max_prompt_tokens": max_prompt_tokens,
            "overhead_tokens": overhead_tokens,
            "output_reservation": output_reservation,
            "safe_tokens": safe_tokens,
            "safe_chars": safe_chars,
        }

    # ====== 非流式对话 ======

    def chat(self, message: str, model: str = None,
             max_tokens: int = None, history: Optional[List] = None,
             context_cache: str = None, _priority: str = None) -> Dict:
        """LLM 对话（非流式，根据 ai_mode 路由到本地或云端）"""
        ai_mode = _cfg("ai_mode", "local")
        if ai_mode == "cloud":
            return self._chat_cloud(message, model=model, max_tokens=max_tokens,
                                     history=history, context_cache=context_cache,
                                     _priority=_priority)

        # 以下为本地 Ollama 逻辑
        if model is None:
            model = self._get_default_llm()

        matched_name = self._find_model_name(model)
        if matched_name is None:
            return {"error": "未知模型: %s" % model}

        if model not in self._loaded:
            r = self.load(model)
            if "error" in r:
                return r

        profile = self._get_profile(matched_name)
        if max_tokens is None:
            max_tokens = profile["default_max_tokens"]

        messages = self._build_prompt(None, message, history, model_name=matched_name,
                                       context_cache=context_cache)

        t0 = time.time()
        queue_priority = _priority if _priority else GenerateQueue.HIGH
        ticket = self.generate_queue.submit(priority=queue_priority, timeout=60)
        if ticket is None:
            return {"error": "设备正忙，等待超时（60s）"}
        try:
            import httpx
            resp = httpx.post(
                "%s/api/chat" % self._ollama_base_url,
                json={
                    "model": matched_name,
                    "messages": messages,
                    "stream": False,
                    "keep_alive": self._keep_alive,
                    "options": {
                        "num_predict": max_tokens,
                        "temperature": profile["temperature"],
                        "top_p": profile["top_p"],
                    },
                },
                timeout=120.0,
            )
            if resp.status_code != 200:
                return {"error": "Ollama API 错误: %d %s" % (resp.status_code, resp.text[:200])}

            data = resp.json()
            text = data.get("message", {}).get("content", "")
            text = self._strip_think(text)

            elapsed = time.time() - t0
            with self._stats_lock:
                self._stats["total_requests"] += 1
                self._stats["total_llm_chars"] += len(text)
                self._stats["total_llm_time"] += elapsed

            return {
                "response": text,
                "model": matched_name,
                "chars": len(text),
                "time": elapsed,
                "speed": len(text) / elapsed if elapsed > 0 else 0,
            }
        except Exception as e:
            self.generate_queue.cancel_all_low()
            return {"error": str(e)[:200]}
        finally:
            ticket.release()

    # ====== 环境检测（从 env_check.py 合并）======

    @staticmethod
    def detect_devices():
        """检测可用设备列表（Ollama 版）"""
        return {"devices": ["ollama"], "default": "ollama", "error": None}

    @staticmethod
    def _detect_hardware():
        """检测具体硬件型号"""
        import subprocess
        import platform
        hw = {"cpu": "", "gpu": ""}
        try:
            if platform.system() == "Windows":
                r = subprocess.run(
                    ["wmic", "cpu", "get", "Name"],
                    capture_output=True, text=True, timeout=10,
                    creationflags=0x08000000,
                )
                lines = [l.strip() for l in r.stdout.strip().split("\n") if l.strip()]
                if len(lines) >= 2:
                    hw["cpu"] = lines[1]
        except Exception:
            pass
        return hw

    def get_env_report(self):
        """生成完整环境报告"""
        import platform
        report = {
            "os": platform.system(),
            "os_version": platform.version(),
            "os_release": platform.release(),
            "python": platform.python_version(),
            "arch": platform.machine(),
            "ollama_available": False,
            "devices": {"devices": ["ollama"], "default": "ollama", "error": None},
            "model_count": 0,
            "models": [],
            "warnings": [],
        }
        if report["os"] == "Windows":
            report["os_display"] = "Windows %s" % report["os_release"]
        elif report["os"] == "Darwin":
            report["os_display"] = "macOS %s" % report["os_release"]
        else:
            report["os_display"] = "%s %s" % (report["os"], report["os_release"])

        # 检查 Ollama 可用性
        try:
            import httpx
            resp = httpx.get("%s/api/tags" % self._ollama_base_url, timeout=5.0)
            if resp.status_code == 200:
                report["ollama_available"] = True
                data = resp.json()
                models = [m.get("name", "") for m in data.get("models", [])]
                report["model_count"] = len(models)
                report["models"] = models
        except Exception:
            report["warnings"].append("Ollama 服务未运行，请先启动 Ollama")

        report["devices"] = self.detect_devices()
        report["hardware"] = self._detect_hardware()
        return report

    # ====== 云端 AI 非流式对话 ======

    def _chat_cloud(self, message: str, model: str = None,
                    max_tokens: int = None, history: Optional[List] = None,
                    context_cache: str = None, _priority: str = None) -> Dict:
        """云端 AI 非流式对话"""
        try:
            from core.cloud_engine import CloudEngine
        except ImportError:
            return {"error": "openai 包未安装，请运行 pip install openai>=1.30"}

        if not hasattr(self, '_cloud_engine'):
            self._cloud_engine = CloudEngine(self)

        cloud_model = model if model else _cfg("cloud_model", "gpt-4o-mini")

        # 构建消息
        messages = self._cloud_engine._build_messages(
            message, history=history, context_cache=context_cache,
        )

        # max_tokens
        if max_tokens is None:
            _ce = CloudEngine.__new__(CloudEngine)
            model_caps = _ce._lookup_capabilities(cloud_model)
            max_tokens = model_caps["max_output"]

        t0 = time.time()
        try:
            client = self._cloud_engine._get_client()
            resp = client.chat.completions.create(
                model=cloud_model,
                messages=messages,
                max_tokens=max_tokens,
                stream=False,
                temperature=0.7,
            )
            text = resp.choices[0].message.content or ""
            elapsed = time.time() - t0

            with self._stats_lock:
                self._stats["total_requests"] += 1
                self._stats["total_llm_chars"] += len(text)
                self._stats["total_llm_time"] += elapsed

            return {
                "response": text,
                "model": cloud_model,
                "chars": len(text),
                "time": elapsed,
                "speed": len(text) / elapsed if elapsed > 0 else 0,
            }
        except Exception as e:
            return {"error": str(e)[:200]}

    # ====== 辅助方法 ======

    def _find_model_name(self, name: str) -> Optional[str]:
        """在 model_configs 中查找匹配的模型名（支持部分匹配和 :latest 后缀）"""
        if name in self.model_configs:
            return name
        # 尝试不带 :tag 后缀匹配
        base = name.split(":")[0]
        for cfg_name in self.model_configs:
            cfg_base = cfg_name.split(":")[0]
            if cfg_base == base:
                return cfg_name
        # 尝试 :latest 后缀
        if name + ":latest" in self.model_configs:
            return name + ":latest"
        return None

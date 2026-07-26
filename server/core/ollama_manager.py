# -*- coding: utf-8 -*-
"""OllamaManager — llama-server 进程生命周期管理（P7-4 底座替换后）

P7-4 变更：内部从 Ollama 进程委托到 LlamaCppManager。
保留类名 OllamaManager 和接口签名，最小化 import 链改动。

关键差异：
  - Ollama: ollama serve（无模型参数，运行时按需加载）
  - llama-server: llama-server --model X.gguf（启动时必须指定模型）
  - start() 无参时，从 ModelRegistry 找默认模型的 GGUF 路径
"""
import os
import logging

log = logging.getLogger(__name__)

# 模型目录（与 Go Launcher 一致：{root}/server/models）
_SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_MODELS_DIR = os.path.join(_SERVER_DIR, "models")


class OllamaManager:
    """进程生命周期管理（委托给 LlamaCppManager）

    保留原接口：start() / stop() / is_healthy() / ensure_running() / get_status() / base_url
    """

    def __init__(self, ollama_path: str = "llama-server",
                 host: str = "127.0.0.1", port: int = 11434):
        # P7-4: ollama_path 参数保留但实际指向 llama-server
        from core.llamacpp_backend import LlamaCppManager, ModelRegistry

        # 读配置
        try:
            from config import get as _cfg
            _ctx_size = _cfg("llamacpp_ctx_size", 8192)
            _n_gpu_layers = _cfg("llamacpp_gpu_layers", 99)
        except Exception:
            _ctx_size = 8192
            _n_gpu_layers = 99

        # 找 llama-server.exe 路径
        _exe_path = self._find_llama_server(ollama_path)

        self._impl = LlamaCppManager(
            llama_server_path=_exe_path,
            host=host,
            port=port,
            ctx_size=_ctx_size,
            n_gpu_layers=_n_gpu_layers,
        )
        self._registry = ModelRegistry(_MODELS_DIR)

    def _find_llama_server(self, fallback: str) -> str:
        """查找 llama-server.exe 路径"""
        # 1. lib/ollama/llama-server.exe（复用主仓已有文件）
        _candidates = [
            os.path.join(_SERVER_DIR, "..", "lib", "ollama", "llama-server.exe"),
            os.path.join(_SERVER_DIR, "lib", "ollama", "llama-server.exe"),
        ]
        for p in _candidates:
            if os.path.isfile(p):
                return os.path.abspath(p)
        # 2. fallback（PATH 查找）
        return fallback

    @property
    def base_url(self) -> str:
        """HTTP API 基础 URL（兼容旧代码：不带 /v1 后缀）"""
        return "http://%s:%d" % (self._impl.host, self._impl.port)

    @property
    def registry(self):
        """模型注册表"""
        return self._registry

    @property
    def impl(self):
        """底层 LlamaCppManager 实例（供 model_manager 等直接访问）"""
        return self._impl

    def start(self, model_path: str = None) -> dict:
        """启动 llama-server。

        Args:
            model_path: GGUF 文件路径。None 时从 ModelRegistry 找默认模型。
        """
        if model_path is None:
            model_path = self._find_default_model()
            if model_path is None:
                return {"status": "error", "error": "未找到可用的模型文件（models/ 下无 meta.json 或 GGUF）"}

        return self._impl.start(model_path)

    def stop(self) -> dict:
        return self._impl.stop()

    def is_healthy(self) -> bool:
        return self._impl.is_healthy()

    def ensure_running(self, model_path: str = None) -> bool:
        if model_path is None:
            model_path = self._find_default_model()
        return self._impl.ensure_running(model_path)

    def get_status(self) -> dict:
        return self._impl.get_status()

    def switch_model(self, model_path: str) -> dict:
        """切换模型（stop + start），成功后写 last_loaded_model 配置"""
        # P7 动态 ctx：切换前按目标模型的 default_num_ctx 更新 --ctx-size
        # （0.8B=4096、2B/4B=8192，让运行时窗口与显示一致）
        try:
            from pathlib import Path as _P
            _name = _P(model_path).stem
            for _m in self._registry.scan():
                if _m.gguf_filename and _m.gguf_filename.replace(".gguf", "") == _name:
                    _ctx = getattr(_m, "default_num_ctx", 0) or 0
                    if _ctx and _ctx != self._impl.ctx_size:
                        self._impl.update_ctx_size(_ctx)
                        log.info("[OLLAMA-MGR] 切换模型更新 ctx_size → %d" % _ctx)
                    break
        except Exception as e:
            log.warning("[OLLAMA-MGR] 更新 ctx_size 失败（用默认值）: %s" % str(e)[:80])

        result = self._impl.switch_model(model_path)
        if result.get("status") in ("started", "already_running"):
            # 切换成功：记忆到 config（从 path 推断 model_id）
            try:
                from pathlib import Path as _P
                _name = _P(model_path).stem  # 文件名不带后缀
                # 反查 meta.json 拿到 model_id
                for _m in self._registry.scan():
                    if _m.gguf_filename and _m.gguf_filename.replace(".gguf", "") == _name:
                        _model_id = _m.model_id
                        break
                else:
                    _model_id = _name
                from config import set_value as _cfg_set
                _cfg_set("last_loaded_model", _model_id)
                log.info("[OLLAMA-MGR] 记忆 last_loaded_model: %s" % _model_id)
                # P0 修复：同步 model_manager._loaded——对话接口的
                # get_loaded_llms() 门禁读这里，不标记会误报"请先在设置页加载模型"。
                # llama-server 是单模型常驻，先清空再标记当前模型。
                try:
                    from server import mgr as _mm
                    _mm._loaded.clear()
                    _mm._loaded[_model_id] = True
                except Exception:
                    pass
            except Exception as e:
                log.warning("[OLLAMA-MGR] 记忆 last_loaded_model 失败: %s" % str(e)[:80])
        return result

    def list_available_models(self) -> list:
        """枚举所有可用模型（GGUF 已下载），返回 [{model_id, display_name, ...}]"""
        try:
            models = self._registry.scan()
            # 当前加载的模型 ID（多级 fallback）
            _current_id = ""
            # 1. config.last_loaded_model
            try:
                from config import get as _cfg
                _current_id = _cfg("last_loaded_model", "")
            except Exception:
                pass
            # 2. LlamaCppManager 当前加载的模型路径 → 反查 model_id
            if not _current_id and self._impl.current_model:
                _current_id = self._model_id_from_path(self._impl.current_model)
            # 3. model_manager 的 get_loaded_llms（扫描后标记的）
            if not _current_id:
                try:
                    from server import mgr
                    _loaded = mgr.get_loaded_llms()
                    if _loaded:
                        _current_id = _loaded[0]
                except Exception:
                    pass
            return [
                {
                    "model_id": m.model_id,
                    "display_name": m.display_name,
                    "size_b": m.size_b,
                    "quant": m.quant,
                    "gguf_filename": m.gguf_filename,
                    "gguf_size_bytes": m.gguf_size_bytes,
                    "estimated_ram_gb": round(m.gguf_size_bytes / 1024**3 * 1.8 + 0.6, 1),
                    "min_ram_gb": m.min_ram_gb,
                    "gguf_path": str(m.gguf_path),
                    "current": m.model_id == _current_id,
                }
                for m in models if m.gguf_exists
            ]
        except Exception as e:
            log.warning("[OLLAMA-MGR] list_available_models 失败: %s" % str(e)[:80])
            return []

    def _model_id_from_path(self, gguf_path: str) -> str:
        """从 GGUF 文件路径反查 model_id"""
        try:
            for _m in self._registry.scan():
                if str(_m.gguf_path) == gguf_path:
                    return _m.model_id
        except Exception:
            pass
        return ""

    def _find_default_model(self):
        """从 ModelRegistry 找默认模型的 GGUF 路径

        优先级：
          1. config.last_loaded_model（用户上次主动选择的模型）
          2. 硬件过滤后选最大可用模型（recommend）
          3. 直接选最大可用（无硬件信息时）
          4. 无可用模型返回 None
        """
        try:
            models = self._registry.scan()
            available = [m for m in models if m.gguf_exists]
            if not available:
                log.info("[OLLAMA-MGR] 无可用模型（models/ 下无 GGUF）")
                return None

            # 1. 优先 config.last_loaded_model
            try:
                from config import get as _cfg
                _last = _cfg("last_loaded_model", "")
                if _last:
                    for m in available:
                        if m.model_id == _last:
                            log.info("[OLLAMA-MGR] 使用上次加载的模型: %s" % _last)
                            return str(m.gguf_path)
            except Exception:
                pass

            # 2. 硬件过滤后推荐最大可用
            vram_gb, ram_gb = self._detect_hardware()
            _recommended = self._registry.recommend(vram_gb=vram_gb, ram_gb=ram_gb)
            if _recommended:
                log.info("[OLLAMA-MGR] 硬件推荐模型: %s (%.1fB)" % (_recommended.model_id, _recommended.size_b))
                return str(_recommended.gguf_path)

            # 3. 兜底：直接选最大
            available.sort(key=lambda m: m.size_b, reverse=True)
            log.info("[OLLAMA-MGR] 无硬件信息，选最大可用: %s" % available[0].model_id)
            return str(available[0].gguf_path)
        except Exception as e:
            log.warning("[OLLAMA-MGR] 查找默认模型失败: %s" % str(e)[:80])
            return None

    def _detect_hardware(self):
        """检测可用 VRAM 和 RAM（GB），返回 (vram_gb, ram_gb)

        优先从 data/launcher.json 读（Go Launcher 写的），fallback 到 psutil。
        """
        import json as _json
        vram_gb = 0.0
        ram_gb = 0.0

        # 1. 优先从 launcher.json 读
        try:
            import os as _os
            _server_dir = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
            _launcher_json = _os.path.join(_server_dir, "..", "data", "launcher.json")
            if _os.path.isfile(_launcher_json):
                with open(_launcher_json, "r", encoding="utf-8") as f:
                    _data = _json.load(f)
                _gpu = _data.get("last_gpu_info", {})
                vram_bytes = _gpu.get("vram_bytes", 0)
                if vram_bytes:
                    vram_gb = vram_bytes / (1024 ** 3)
                ram_bytes = _gpu.get("available_ram_bytes", 0)
                if ram_bytes:
                    ram_gb = ram_bytes / (1024 ** 3)
        except Exception:
            pass

        # 2. fallback 到 psutil
        if ram_gb == 0:
            try:
                import psutil
                ram_gb = psutil.virtual_memory().available / (1024 ** 3)
            except Exception:
                pass

        return (round(vram_gb, 1), round(ram_gb, 1))

# -*- coding: utf-8 -*-
"""
recorder.py — 录音纪要核心模块
================================
录音会话管理 + 音频拼接 + 转写调度 + 处理队列控制 + 崩溃恢复

存储结构：
  data/recordings/
    ├── sessions.json         # 录音会话元信息
    ├── chunks/               # 实时录音块（临时，转写完成后可清理）
    │   └── {session_id}/
    │       ├── chunk_001.webm
    │       └── ...
    └── audio/                # 完整音频文件
        └── {session_id}.webm

设计原则：
  - Whisper 可选（扩展包），未安装时录音功能不可用但API不崩溃
  - 两阶段转写：Whisper粗稿 → 8B纠错润色
  - 转写期间锁定对话Tab（D22资源保护）
  - 录音chunk实时落盘（D36崩溃恢复）
  - 处理队列支持暂停/取消（D27）
  - 录音独立20个session额度（D39）
"""
__version__ = "v1.0"

import os
import json
import uuid
import time
import threading
import logging
import shutil
from typing import Optional, List, Dict, Any
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path

log = logging.getLogger(__name__)


# ===== 数据结构 =====

@dataclass
class RecordingSession:
    """录音会话"""
    session_id: str
    started_at: str
    finished_at: Optional[str] = None
    duration_seconds: float = 0.0
    chunk_count: int = 0
    source: str = "recording"         # recording | import
    audio_path: Optional[str] = None
    import_filename: Optional[str] = None  # 导入文件的原始文件名
    realtime_text: str = ""           # D25: 实时转写预览
    rough_draft: Optional[str] = None  # Phase 1: Whisper粗稿
    transcript: Optional[str] = None   # Phase 2: 8B纠错后最终稿
    summary: Optional[str] = None      # AI会议纪要
    status: str = "recording"          # recording/paused/transcribing/refining/summarizing/done/queued/cancelled/error
    progress: float = 0.0             # 总进度 0.0-1.0
    phase: Optional[str] = None       # "realtime"|"whisper"|"refine"|None
    whisper_progress: int = 0         # D36: Whisper转写进度
    refine_progress: int = 0          # D36: 8B纠错进度
    disk_size_bytes: int = 0          # D34: 音频文件占用空间
    error_msg: str = ""
    kb_doc_id: Optional[str] = None   # 入库后的文库文档ID
    refined: bool = False             # 是否经过 8B 纠错润色
    segments: Optional[List[Dict[str, Any]]] = None  # 转写时间戳段落 [{"start": float, "end": float, "text": str}]


# ===== 录音管理器 =====

class RecorderManager:
    """录音纪要管理器"""

    MAX_SESSIONS = 20  # D39: 录音session上限

    def __init__(self, data_dir: str = None):
        if data_dir is None:
            from config import RECORDER_DATA_DIR
            data_dir = RECORDER_DATA_DIR  # D1 重构：C:\Sidemate\data\recorder
        self.data_dir = data_dir
        self.chunks_dir = os.path.join(data_dir, "chunks")
        self.audio_dir = os.path.join(data_dir, "audio")
        self.sessions_file = os.path.join(data_dir, "sessions.json")
        self.sessions: Dict[str, RecordingSession] = {}

        # Whisper 相关（faster-whisper，可选）
        self._whisper_loaded = False
        self._whisper_model = None       # faster_whisper.WhisperModel 实例
        self._whisper_model_name = None  # "small" or "medium"
        self._whisper_mem_mb = 0
        # Whisper 自动卸载
        self._whisper_lock = threading.Lock()
        self._whisper_timer: Optional[threading.Timer] = None
        self._whisper_last_use: float = 0.0
        self._whisper_unloaded_at: float = 0.0

        # 转写锁（D22: 转写期间对话Tab锁定）
        self._transcribing = False
        self._transcribe_lock = threading.Lock()

        # 处理队列
        self._processing = False
        self._cancel_flag = threading.Event()

        # 确保目录存在
        os.makedirs(self.chunks_dir, exist_ok=True)
        os.makedirs(self.audio_dir, exist_ok=True)

        # 加载持久化数据
        self._load_sessions()

    # ===== 持久化 =====

    def _load_sessions(self):
        """加载录音会话数据"""
        if not os.path.exists(self.sessions_file):
            return
        try:
            with open(self.sessions_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            for sid, sdata in data.items():
                self.sessions[sid] = RecordingSession(**sdata)
            log.info("[RECORDER] 加载 %d 个录音会话" % len(self.sessions))
        except Exception as e:
            log.warning("[RECORDER] 加载会话数据失败: %s" % str(e))

    def _save_sessions(self):
        """持久化录音会话数据"""
        try:
            data = {}
            for sid, session in self.sessions.items():
                data[sid] = asdict(session)
            with open(self.sessions_file, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            log.error("[RECORDER] 保存会话数据失败: %s" % str(e))

    # ===== 扩展注册表 =====

    @staticmethod
    def _get_extensions_dir() -> str:
        """获取扩展注册目录（基于项目根目录）"""
        from config import EXTENSIONS_DIR
        return EXTENSIONS_DIR

    @staticmethod
    def _is_recorder_extension_installed() -> bool:
        """检查纪要扩展是否已安装"""
        try:
            from core.extension_manager import ExtensionRegistry
            registry = ExtensionRegistry(RecorderManager._get_extensions_dir())
            return registry.is_installed("recorder")
        except Exception:
            return False

    @staticmethod
    def _get_whisper_model_path() -> str:
        """从扩展注册表获取 Whisper 模型路径"""
        try:
            from core.extension_manager import ExtensionRegistry
            from config import ROOT_DIR, EXTENSIONS_DIR
            registry = ExtensionRegistry(EXTENSIONS_DIR)
            registered_path = registry.get_model_path("recorder", "whisper")
            if registered_path:
                return os.path.join(ROOT_DIR, registered_path)
        except Exception:
            pass
        # 默认路径
        _project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        return os.path.join(_project_dir, "models", "whisper")

    # ===== Whisper 状态检查 =====

    def get_whisper_status(self) -> Dict[str, Any]:
        """检查 Whisper 扩展状态
        返回: {"status": "not_installed"|"installed_not_loaded"|"ready", ...}
        """
        ext_installed = self._is_recorder_extension_installed()

        if not ext_installed:
            return {
                "status": "not_installed",
                "installed": False,
                "loaded": False,
                "model_name": None,
                "mem_mb": 0
            }

        return {
            "status": "ready" if self._whisper_loaded else "installed_not_loaded",
            "installed": True,
            "loaded": self._whisper_loaded,
            "model_name": self._whisper_model_name or "small",
            "mem_mb": self._whisper_mem_mb,
        }

    def load_whisper(self) -> Dict[str, Any]:
        """加载 Whisper 模型到 CPU 内存（faster-whisper）"""
        if self._whisper_loaded:
            return {"ok": True, "msg": "Whisper 已加载", "mem_mb": self._whisper_mem_mb}

        # 检查扩展是否安装
        if not self._is_recorder_extension_installed():
            return {"error": "纪要扩展未安装，请导入 sidemate-extension-recorder-*.sidemate 包"}

        # 取消已排定的卸载计时器
        if self._whisper_timer is not None:
            self._whisper_timer.cancel()
            self._whisper_timer = None
        self._whisper_last_use = time.time()

        model_path = self._get_whisper_model_path()

        if not os.path.isdir(model_path):
            return {"error": "Whisper 模型目录不存在: %s" % model_path}

        # 加载 faster-whisper
        try:
            from faster_whisper import WhisperModel
            log.info("[WHISPER] 从 faster-whisper 加载模型: %s", model_path)

            mem_before = 0
            try:
                import psutil
                mem_before = psutil.Process(os.getpid()).memory_info().rss
            except Exception:
                pass

            self._whisper_model = WhisperModel(model_path, device="cpu", compute_type="int8")
            self._whisper_loaded = True

            # 读取配置中的模型名
            try:
                from config import get as _cfg
                self._whisper_model_name = _cfg("whisper_model", "small")
            except Exception:
                self._whisper_model_name = "small"

            try:
                import psutil
                self._whisper_mem_mb = round((psutil.Process(os.getpid()).memory_info().rss - mem_before) / 1048576, 1)
                if self._whisper_mem_mb <= 0:
                    # 估算 small ≈ 461MB
                    self._whisper_mem_mb = 460
            except Exception:
                self._whisper_mem_mb = 460

            log.info("[WHISPER] faster-whisper 加载成功 (mem=%.0fMB)", self._whisper_mem_mb)
            return {"ok": True, "msg": "Whisper 已加载 (faster-whisper)", "mem_mb": self._whisper_mem_mb}
        except Exception as e:
            log.error("[WHISPER] faster-whisper 加载失败: %s", str(e)[:100])
            return {"error": "Whisper 加载失败 (faster-whisper): %s" % str(e)[:200]}

    def unload_whisper(self) -> Dict[str, Any]:
        """释放 Whisper 模型内存（D18退出机制）"""
        if not self._whisper_loaded:
            return {"ok": True, "msg": "Whisper 未加载", "freed_mb": 0}

        # 取消已排定的卸载计时器
        if self._whisper_timer is not None:
            self._whisper_timer.cancel()
            self._whisper_timer = None

        freed_mb = self._whisper_mem_mb
        self._whisper_model = None
        self._whisper_loaded = False
        self._whisper_model_name = None
        self._whisper_mem_mb = 0

        # 强制 GC
        import gc
        gc.collect()

        # 尝试释放OS内存页
        try:
            import ctypes
            ctypes.windll.kernel32.SetProcessWorkingSetSize(-1, -1, -1)
        except Exception:
            pass

        log.info("[WHISPER] 模型已释放，回收 ~%dMB" % freed_mb)
        return {"ok": True, "freed_mb": freed_mb}

    def _schedule_whisper_unload(self):
        """转写后调用：如果非常驻模式，启动空闲超时计时器

        计时器到期后执行 unload_whisper()，但受冷却期保护。
        """
        try:
            from config import get as _cfg
            resident = _cfg("recorder_resident", False)
        except Exception as e:
            log.warning("[WHISPER] 读取 recorder_resident 配置失败: %s", str(e)[:80])
            resident = False

        if resident:
            log.debug("[WHISPER] 常驻模式，跳过空闲卸载调度")
            return

        try:
            from config import get as _cfg
            timeout_sec = _cfg("reranker_idle_timeout_sec", 300)
        except Exception:
            timeout_sec = 300

        # 取消已有计时器
        if self._whisper_timer is not None:
            self._whisper_timer.cancel()
            self._whisper_timer = None

        def _on_timeout():
            self._whisper_timer = None
            # 冷却期检查：卸载后 30 秒内不再卸载
            if self._whisper_unloaded_at > 0 and (time.time() - self._whisper_unloaded_at) < 30:
                log.debug("[WHISPER] 冷却期内，跳过卸载")
                return
            self._do_whisper_unload()

        self._whisper_timer = threading.Timer(timeout_sec, _on_timeout)
        self._whisper_timer.daemon = True
        self._whisper_timer.start()
        log.debug("[WHISPER] 空闲卸载计时器已启动: %ds", timeout_sec)

    def _do_whisper_unload(self):
        """实际卸载 Whisper（线程安全，带冷却期记录）"""
        with self._whisper_lock:
            if not self._whisper_loaded:
                return
            result = self.unload_whisper()
            self._whisper_unloaded_at = time.time()
            if result.get("ok"):
                log.info("[WHISPER] 空闲超时，自动卸载完成，释放 ~%dMB", result.get("freed_mb", 0))

    def is_transcribing(self) -> bool:
        """当前是否正在转写（D22: 对话Tab锁定判断）"""
        return self._transcribing

    # ===== 录音会话管理 =====

    def start_session(self) -> Dict[str, Any]:
        """创建录音会话"""
        # 检查session上限
        if len(self.sessions) >= self.MAX_SESSIONS:
            return {"error": "录音数量已达上限（%d个），请先删除旧录音" % self.MAX_SESSIONS}

        session_id = str(uuid.uuid4())[:8]
        session = RecordingSession(
            session_id=session_id,
            started_at=datetime.now().isoformat(),
            status="recording",
            phase="realtime"
        )
        self.sessions[session_id] = session

        # 创建chunk目录
        chunk_dir = os.path.join(self.chunks_dir, session_id)
        os.makedirs(chunk_dir, exist_ok=True)

        self._save_sessions()
        log.info("[RECORDER] 创建录音会话: %s" % session_id)
        return {"ok": True, "session_id": session_id}

    def append_chunk(self, session_id: str, audio_bytes: bytes) -> Dict[str, Any]:
        """追加音频块（实时落盘 D36崩溃恢复）"""
        if session_id not in self.sessions:
            return {"error": "会话不存在"}

        session = self.sessions[session_id]
        if session.status != "recording":
            return {"error": "会话不在录音状态"}

        chunk_dir = os.path.join(self.chunks_dir, session_id)
        chunk_num = session.chunk_count + 1
        chunk_path = os.path.join(chunk_dir, "chunk_%03d.webm" % chunk_num)

        try:
            with open(chunk_path, "wb") as f:
                f.write(audio_bytes)
            session.chunk_count = chunk_num
            session.disk_size_bytes += len(audio_bytes)
            self._save_sessions()
            return {"ok": True, "chunk_num": chunk_num}
        except Exception as e:
            return {"error": "保存音频块失败: %s" % str(e)}

    def finish_session(self, session_id: str) -> Dict[str, Any]:
        """结束录音，拼接音频"""
        if session_id not in self.sessions:
            return {"error": "会话不存在"}

        session = self.sessions[session_id]
        if session.status != "recording":
            return {"error": "会话不在录音状态"}

        # 拼接音频块
        chunk_dir = os.path.join(self.chunks_dir, session_id)
        audio_path = os.path.join(self.audio_dir, "%s.webm" % session_id)

        try:
            with open(audio_path, "wb") as out_f:
                for i in range(1, session.chunk_count + 1):
                    chunk_path = os.path.join(chunk_dir, "chunk_%03d.webm" % i)
                    if os.path.exists(chunk_path):
                        with open(chunk_path, "rb") as in_f:
                            out_f.write(in_f.read())

            session.audio_path = audio_path
            session.finished_at = datetime.now().isoformat()
            session.status = "queued"  # 进入转写队列
            session.phase = None
            self._save_sessions()

            log.info("[RECORDER] 录音完成: %s, %d chunks, %d bytes" % (
                session_id, session.chunk_count, session.disk_size_bytes))
            return {"ok": True, "audio_path": audio_path}

        except Exception as e:
            session.status = "error"
            session.error_msg = str(e)
            self._save_sessions()
            return {"error": "拼接音频失败: %s" % str(e)}

    def import_audio(self, filename: str, audio_bytes: bytes) -> Dict[str, Any]:
        """导入已有音频文件（D16）"""
        if len(self.sessions) >= self.MAX_SESSIONS:
            return {"error": "录音数量已达上限（%d个）" % self.MAX_SESSIONS}

        session_id = str(uuid.uuid4())[:8]
        audio_path = os.path.join(self.audio_dir, "%s_%s" % (session_id, filename))

        try:
            with open(audio_path, "wb") as f:
                f.write(audio_bytes)
        except Exception as e:
            return {"error": "保存音频文件失败: %s" % str(e)}

        session = RecordingSession(
            session_id=session_id,
            started_at=datetime.now().isoformat(),
            finished_at=datetime.now().isoformat(),
            duration_seconds=0,
            source="import",
            audio_path=audio_path,
            import_filename=filename,
            status="queued",
            disk_size_bytes=len(audio_bytes)
        )
        self.sessions[session_id] = session
        self._save_sessions()

        log.info("[RECORDER] 导入音频: %s → %s (%d bytes)" % (filename, session_id, len(audio_bytes)))
        return {"ok": True, "session_id": session_id}

    # ===== 转写调度 =====

    def start_transcription(self, session_id: str, model_manager=None) -> Dict[str, Any]:
        """启动转写（Whisper + 8B纠错两阶段）

        Args:
            session_id: 录音会话ID
            model_manager: models.py 的 ModelManager 实例（用于8B纠错）
        """
        if session_id not in self.sessions:
            return {"error": "会话不存在"}

        session = self.sessions[session_id]

        if not self._whisper_loaded:
            return {"error": "Whisper 模型未加载"}

        if session.status not in ("queued", "paused"):
            return {"error": "会话状态不允许转写（当前: %s）" % session.status}

        if self._transcribing:
            return {"error": "已有转写任务进行中，请等待完成"}

        # 后台线程执行转写
        def _do_transcribe():
            try:
                self._transcribing = True
                self._cancel_flag.clear()
                session.status = "transcribing"
                session.phase = "whisper"
                session.error_msg = None
                self._save_sessions()

                # === 断点续传：如果 rough_draft 已存在，跳过 Whisper 阶段 ===
                if session.rough_draft:
                    log.info("[RECORDER] 断点续传: 跳过 Whisper，使用已有粗稿 (%d 字符)" % len(session.rough_draft))
                    rough_draft = session.rough_draft
                    session.whisper_progress = 100
                    session.progress = 0.10
                    self._save_sessions()
                else:
                    session.progress = 0.05
                    session.whisper_progress = 0
                    self._save_sessions()

                    # === Phase 1: Whisper 转写粗稿 ===
                    rough_draft = self._whisper_transcribe(session)
                    if rough_draft is None:
                        return  # 被取消或出错

                    session.rough_draft = rough_draft
                    session.whisper_progress = 100
                    session.progress = 0.10  # Whisper 完成 → 10%
                    self._save_sessions()

                # 统一设置 transcript（粗稿作为最终稿，除非后续有纠错阶段）
                if not session.transcript:
                    session.transcript = rough_draft
                if not session.refined:
                    session.refined = False

                # 短暂延时让前端能看到 10% 进度
                import time
                time.sleep(1.2)

                session.status = "done"
                session.phase = None
                session.progress = 1.0
                session.finished_at = datetime.now().isoformat()
                self._save_sessions()

                log.info("[RECORDER] 转写完成: %s" % session_id)
                self._schedule_whisper_unload()

            except Exception as e:
                log.error("[RECORDER] 转写失败: %s" % str(e))
                session.status = "error"
                session.error_msg = str(e)
                self._save_sessions()
            finally:
                self._transcribing = False

        t = threading.Thread(target=_do_transcribe, daemon=True)
        t.start()
        return {"ok": True, "msg": "转写已启动"}

    def _whisper_transcribe(self, session: RecordingSession) -> Optional[str]:
        """Phase 1: Whisper 转写粗稿（faster-whisper）"""
        if not session.audio_path or not os.path.exists(session.audio_path):
            session.status = "error"
            session.error_msg = "音频文件不存在"
            self._save_sessions()
            return None

        if not self._whisper_loaded or self._whisper_model is None:
            session.status = "error"
            session.error_msg = "Whisper 引擎不可用（纪要扩展未安装或模型未加载）"
            self._save_sessions()
            return None

        return self._whisper_transcribe_fw(session)

    def _whisper_transcribe_fw(self, session: RecordingSession) -> Optional[str]:
        """faster-whisper 转写"""
        try:
            import config

            language = config.get("whisper_language", "zh")
            log.info("[WHISPER-FW] 开始转写: %s (language=%s)", session.session_id, language)

            model = self._whisper_model
            segments_generator, info = model.transcribe(
                session.audio_path,
                language=language if language != "auto" else None,
                beam_size=5,
                vad_filter=True,
            )

            text_parts = []
            segments_data = []

            for seg in segments_generator:
                start_ts = seg.start
                end_ts = seg.end
                text = seg.text.strip()
                if text:
                    min_s = int(start_ts // 60)
                    sec_s = int(start_ts % 60)
                    text_parts.append("[%02d:%02d] %s" % (min_s, sec_s, text))
                    segments_data.append({"start": float(start_ts), "end": float(end_ts), "text": text})

                # 检查取消
                if self._cancel_flag.is_set():
                    log.info("[WHISPER-FW] 转写被取消")
                    return None

            rough_draft = "\n".join(text_parts)

            # 繁体→简体转换（某些 Whisper 模型对 "zh" 输出繁体）
            # P6 讨论4: zhconv(GPLv2+)已移除以消除Copyleft传染风险。
            # 如需繁简转换,用户可自行安装 zhconv 或改用 OpenCC(BSD-3)。
            try:
                import zhconv
                rough_draft = zhconv.convert(rough_draft, 'zh-cn')
                for seg_item in segments_data:
                    seg_item['text'] = zhconv.convert(seg_item['text'], 'zh-cn')
                log.info("[WHISPER-FW] 已执行繁体→简体转换")
            except ImportError:
                pass  # zhconv 未安装,跳过繁简转换(不影响核心功能)

            session.segments = segments_data if segments_data else None

            session.whisper_progress = 100
            session.progress = 0.10
            self._save_sessions()

            log.info("[WHISPER-FW] 转写完成: %d 字符, %d 段", len(rough_draft), len(segments_data))
            return rough_draft

        except Exception as e:
            log.error("[WHISPER-FW] 转写出错: %s", str(e))
            session.status = "error"
            session.error_msg = "Whisper转写出错(faster-whisper): %s" % str(e)[:200]
            self._save_sessions()
            return None

    def live_transcribe(self, audio_blob: bytes) -> Dict[str, Any]:
        """实时转写：接收前端 VAD 检测到的音频段，快速转写返回文本。

        audio_blob: 前端 MediaRecorder 生成的 webm/opus 音频片段
        返回: {"ok": True, "text": "..."} 或 {"ok": False, "error": "..."}
        """
        if not self._whisper_loaded or self._whisper_model is None:
            return {"ok": False, "error": "Whisper 模型未加载"}

        if len(audio_blob) < 500:
            return {"ok": True, "text": ""}  # 太短，跳过

        # 写入临时文件（faster-whisper 需要文件路径）
        import tempfile
        tmp_path = None
        try:
            tmp_dir = tempfile.mkdtemp(prefix="whisper_live_")
            tmp_path = os.path.join(tmp_dir, "live.webm")
            with open(tmp_path, "wb") as f:
                f.write(audio_blob)

            import config
            language = config.get("whisper_language", "zh")
            model = self._whisper_model
            segments_generator, info = model.transcribe(
                tmp_path,
                language=language if language != "auto" else None,
                beam_size=3,
                vad_filter=False,
            )

            text_parts = []
            for seg in segments_generator:
                t = seg.text.strip()
                if t:
                    text_parts.append(t)

            text = " ".join(text_parts)
            if text:
                # 繁体→简体
                try:
                    import zhconv
                    text = zhconv.convert(text, 'zh-cn')
                except ImportError:
                    pass
                log.info("[LIVE-FW] 实时转写: %d 字符", len(text))
            return {"ok": True, "text": text}

        except Exception as e:
            log.error("[LIVE-FW] 实时转写失败: %s", str(e))
            return {"ok": False, "error": "实时转写失败: %s" % str(e)[:100]}
        finally:
            # 清理临时文件
            if tmp_path:
                try:
                    shutil.rmtree(os.path.dirname(tmp_path), ignore_errors=True)
                except Exception:
                    pass

    def _refine_with_llm(self, session: RecordingSession, rough_draft: str, model_manager) -> Optional[str]:
        """Phase 2: 8B 纠错润色（滑动窗口分批，上下文衔接）"""
        import config
        batch_chars = config.get("whisper_refine_batch_chars", 1000)
        OVERLAP_CHARS = 200  # 滑动窗口重叠字符数
        FULL_TEXT_THRESHOLD = 4000  # ≤此值一次性纠错，不分批

        # 短文本：一次性全文纠错
        if len(rough_draft) <= FULL_TEXT_THRESHOLD:
            prompt = (
                "你是中文语音转写纠错助手。Whisper 语音识别常产生以下错误：\n"
                "- 同音错字：办公→版公、流程→留成、提升→提成/一无法、质量→指量\n"
                "- 漏字吞字：深度融入→深度入、人工智能→人工能\n"
                "- 口语连读误识：并影响→并一响、的确认→的确任\n\n"
                "请逐句修正转写文本，修正所有明显的同音错别字，保持原意和口语风格。\n"
                "保持每行 [时间戳] 格式不变。\n"
                "重要：如果修正后的词和原文发音差异超过 2 个字，保持原文不改。\n"
                "只修正同音/近音字误，不要改写、不要脑补、不要润色人名地名。\n\n"
                "输出时先写\"###修正文本开始###\"，然后写修正后的完整文本，最后写\"###修正文本结束###\"。\n"
                "这两个标记之间只能放修正后的转写文本，不要放任何说明、解释、前缀或后缀。\n\n"
                "示例：\n"
                "###修正文本开始###\n"
                "[00:01] 人工智能深度融入现代办公流程\n"
                "[00:05] 并影响决策质量\n"
                "###修正文本结束###\n\n"
                "转写文本：\n%s" % rough_draft
            )
            try:
                result_text = ""
                char_count = 0
                estimated_total = len(rough_draft) * 0.9  # 纠错后预计字符数
                for phase, content in model_manager.chat_stream(
                    message=prompt,
                    max_tokens=len(rough_draft) + 200,
                    _priority="low",
                ):
                    if phase == "raw":
                        result_text += content
                    elif phase == "text":
                        result_text += content
                        char_count += len(content)
                        # 按产出 token 推进真实进度（15%→95%）
                        if estimated_total > 0:
                            pct = 0.15 + 0.80 * min(char_count / estimated_total, 1.0)
                            session.progress = round(pct, 3)
                            self._save_sessions()
                if result_text.strip():
                    # 从 ###修正文本### 标记中截取内容
                    import re
                    m = re.search(r'###修正文本开始###\s*(.+?)\s*###修正文本结束###', result_text, re.DOTALL)
                    if m:
                        filtered = m.group(1).strip()
                    else:
                        # 兜底：旧版正则过滤
                        filtered = result_text.strip()
                        filtered = re.sub(r'^(修正后(的)?文本(如下)?[：:]?\s*)', '', filtered)
                        filtered = filtered.split('【修正要点】')[0].split('【修改要点】')[0].strip()
                    log.info("[REFINE] 短文本一次性纠错完成: %d → %d 字符" % (len(rough_draft), len(filtered)))
                    return filtered
                else:
                    log.warning("[REFINE] 短文本纠错返回空，用原文")
                    return rough_draft
            except Exception as e:
                log.error("[REFINE] 短文本纠错失败: %s" % str(e))
                raise  # 向上抛出让 _do_refine 正确标记错误

        # 长文本：滑动窗口分批纠错
        step = batch_chars - OVERLAP_CHARS
        chunks = []
        for i in range(0, len(rough_draft), step):
            chunks.append(rough_draft[i:i + batch_chars])

        refined_parts = []
        total = len(chunks)
        prev_tail = ""  # 上一批纠错结果的末尾，作为下批上下文

        for idx, chunk in enumerate(chunks):
            if self._cancel_flag.is_set():
                log.info("[REFINE] 纠错被取消 at batch %d/%d" % (idx, total))
                return None

            # 构造带上下文的 prompt
            if prev_tail:
                prompt = (
                    "你是中文语音转写纠错助手。请修正以下文本的同音错字、漏字和识别错误。\n"
                    "常见错误：办公→版公、融入→深度入、提升→提成/一无法、影响→一响\n"
                    "只修正同音/近音字误，发音差异超过2字的保留原文，保持口语风格和 [时间戳] 格式。\n"
                    "输出时先写###修正文本开始###，再写修正后的文本，最后写###修正文本结束###。\n"
                    "两个标记之间只放修正后的文本，不要放说明或解释。\n\n"
                    "上一段末尾（参考上下文）：\n%s\n\n"
                    "当前段：\n%s" % (prev_tail, chunk)
                )
            else:
                prompt = (
                    "你是中文语音转写纠错助手。请修正以下文本的同音错字、漏字和识别错误。\n"
                    "常见错误：办公→版公、融入→深度入、提升→提成/一无法、影响→一响\n"
                    "只修正同音/近音字误，发音差异超过2字的保留原文，保持口语风格和 [时间戳] 格式。\n"
                    "输出时先写###修正文本开始###，再写修正后的文本，最后写###修正文本结束###。\n"
                    "两个标记之间只放修正后的文本，不要放说明或解释。\n\n"
                    "转写文本：\n%s" % chunk
                )

            try:
                result_text = ""
                batch_char_count = 0
                batch_estimated = len(chunk) * 0.9
                for phase, content in model_manager.chat_stream(
                    message=prompt,
                    max_tokens=len(chunk) + 200,
                    _priority="low",
                ):
                    if phase == "raw":
                        result_text += content
                    elif phase == "text":
                        result_text += content
                        batch_char_count += len(content)
                        # 当前批次内 token 进度 + 整体进度（15%→95%）
                        if batch_estimated > 0 and total > 0:
                            batch_pct = min(batch_char_count / batch_estimated, 1.0)
                            overall = 0.15 + 0.80 * (idx + batch_pct) / total
                            session.progress = round(overall, 3)
                            self._save_sessions()

                if result_text.strip():
                    refined = result_text.strip()
                    # 从 ###修正文本### 标记中截取内容
                    m = re.search(r'###修正文本开始###\s*(.+?)\s*###修正文本结束###', refined, re.DOTALL)
                    if m:
                        refined = m.group(1).strip()
                    refined_parts.append(refined)
                    prev_tail = refined[-OVERLAP_CHARS:] if len(refined) >= OVERLAP_CHARS else refined
                else:
                    refined_parts.append(chunk)
                    prev_tail = chunk[-OVERLAP_CHARS:] if len(chunk) >= OVERLAP_CHARS else chunk

            except Exception as e:
                log.warning("[REFINE] 批次 %d 纠错失败: %s，用原文" % (idx, str(e)))
                refined_parts.append(chunk)
                prev_tail = chunk[-OVERLAP_CHARS:] if len(chunk) >= OVERLAP_CHARS else chunk

            # 更新进度
            session.refine_progress = int((idx + 1) / total * 100)
            session.progress = 0.15 + 0.80 * (idx + 1) / total
            self._save_sessions()

        refined = "\n".join(refined_parts)
        log.info("[REFINE] 滑动窗口纠错完成: %d → %d 字符 (%d批)" % (len(rough_draft), len(refined), total))
        return refined

    # ===== 会话操作 =====

    def get_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        """获取单个会话信息"""
        if session_id not in self.sessions:
            return None
        return asdict(self.sessions[session_id])

    def get_sessions(self) -> List[Dict[str, Any]]:
        """获取所有录音会话列表（按时间倒序）"""
        sessions = [asdict(s) for s in self.sessions.values()]
        sessions.sort(key=lambda x: x.get("started_at", ""), reverse=True)
        return sessions

    def get_transcript(self, session_id: str) -> Dict[str, Any]:
        """获取最终转写结果（纠错后）"""
        if session_id not in self.sessions:
            return {"error": "会话不存在"}
        session = self.sessions[session_id]
        return {"ok": True, "transcript": session.transcript or ""}

    def get_rough_draft(self, session_id: str) -> Dict[str, Any]:
        """获取原始粗稿（D23）"""
        if session_id not in self.sessions:
            return {"error": "会话不存在"}
        session = self.sessions[session_id]
        return {"ok": True, "rough_draft": session.rough_draft or ""}

    def refine_transcript(self, session_id: str, model_manager) -> Dict[str, Any]:
        """手动触发 8B 纠错润色"""
        if session_id not in self.sessions:
            return {"error": "会话不存在"}
        session = self.sessions[session_id]
        if session.status != "done":
            return {"error": "转写未完成，无法纠错"}
        if not session.rough_draft:
            return {"error": "无原始转写稿，无法纠错"}
        if session.refined:
            return {"error": "已经过AI纠错润色，如需重新纠错请先编辑原文"}
        if not model_manager:
            return {"error": "8B 模型未加载，请先加载模型"}

        # 后台线程执行纠错
        def _do_refine():
            try:
                session.status = "refining"
                session.phase = "refine"
                session.progress = 0.15  # 纠错开始 15%，token 流会继续推进
                self._cancel_flag.clear()
                self._save_sessions()

                refined = self._refine_with_llm(session, session.rough_draft, model_manager)
                if refined:
                    session.transcript = refined
                    session.refined = True

                session.status = "done"
                session.phase = None
                session.progress = 1.0
                session.finished_at = datetime.now().isoformat()
                self._save_sessions()
                log.info("[REFINE] 手动纠错完成: %s" % session_id)

            except Exception as e:
                log.error("[REFINE] 手动纠错失败: %s" % str(e))
                session.status = "done"
                session.phase = None
                session.error_msg = "纠错失败: %s" % str(e)[:200]
                self._save_sessions()

        import threading
        t = threading.Thread(target=_do_refine, daemon=True)
        t.start()
        return {"ok": True, "message": "纠错已启动"}

    def update_transcript(self, session_id: str, text: str) -> Dict[str, Any]:
        """D38: 用户编辑转写稿"""
        if session_id not in self.sessions:
            return {"error": "会话不存在"}
        session = self.sessions[session_id]
        if session.status != "done":
            return {"error": "会话未完成转写，不可编辑"}
        session.transcript = text
        self._save_sessions()
        return {"ok": True}

    def delete_session(self, session_id: str) -> Dict[str, Any]:
        """D34: 删除录音（文件+转写数据+粗稿/最终稿）"""
        if session_id not in self.sessions:
            return {"error": "会话不存在"}

        session = self.sessions[session_id]

        # 删除音频文件
        if session.audio_path and os.path.exists(session.audio_path):
            try:
                os.remove(session.audio_path)
            except Exception:
                pass

        # 删除chunk目录
        chunk_dir = os.path.join(self.chunks_dir, session_id)
        if os.path.exists(chunk_dir):
            try:
                shutil.rmtree(chunk_dir)
            except Exception:
                pass

        freed_mb = session.disk_size_bytes / 1024 / 1024

        del self.sessions[session_id]
        self._save_sessions()

        log.info("[RECORDER] 删除录音: %s，释放 %.1fMB" % (session_id, freed_mb))
        return {"ok": True, "freed_mb": round(freed_mb, 1)}

    # ===== 队列控制（D27）=====

    def pause_processing(self, session_id: str) -> Dict[str, Any]:
        """暂停处理"""
        if session_id not in self.sessions:
            return {"error": "会话不存在"}
        session = self.sessions[session_id]
        if session.status in ("transcribing", "refining"):
            session.status = "paused"
            self._cancel_flag.set()
            self._save_sessions()
            return {"ok": True}
        return {"error": "当前状态不可暂停"}

    def resume_processing(self, session_id: str, model_manager=None) -> Dict[str, Any]:
        """恢复处理 / 重试失败的 session（支持 batch 级续传）"""
        if session_id not in self.sessions:
            return {"error": "会话不存在"}
        session = self.sessions[session_id]
        if session.status not in ("paused", "error"):
            return {"error": "当前状态不可恢复"}

        # 如果纠错也已完成（transcript 存在且 refined=True），直接标记完成
        if session.transcript and session.refined:
            session.status = "done"
            session.phase = None
            session.progress = 1.0
            session.error_msg = None
            session.finished_at = datetime.now().isoformat()
            self._cancel_flag.clear()
            self._save_sessions()
            return {"ok": True, "msg": "所有阶段已完成，直接标记完成"}

        # 恢复时保留已有进度
        session.status = "queued"
        session.error_msg = None
        self._cancel_flag.clear()
        self._save_sessions()
        return self.start_transcription(session_id, model_manager)

    def cancel_processing(self, session_id: str) -> Dict[str, Any]:
        """取消处理"""
        if session_id not in self.sessions:
            return {"error": "会话不存在"}
        session = self.sessions[session_id]
        if session.status in ("transcribing", "refining", "queued", "paused"):
            self._cancel_flag.set()
            session.status = "cancelled"
            session.phase = None
            self._save_sessions()
            return {"ok": True}
        return {"error": "当前状态不可取消"}

    # ===== 会议纪要生成（P6-15）=====

    def summarize(self, session_id: str, model_manager) -> Dict[str, Any]:
        """生成AI会议纪要"""
        if session_id not in self.sessions:
            return {"error": "会话不存在"}
        session = self.sessions[session_id]
        if session.status != "done":
            return {"error": "会话未完成转写"}
        if not session.transcript:
            return {"error": "转写稿为空"}
        if not model_manager:
            return {"error": "请先在「设置」页面加载 AI 模型，生成纪要需要模型支持"}

        prompt = (
            "将以下会议/谈话转写稿整理为结构化会议纪要。\n\n"
            "要求：\n"
            "1. 一句话总结会议主题\n"
            "2. 列出3-5个关键要点\n"
            "3. 列出待办事项（如有）\n"
            "4. 列出决策结论（如有）\n\n"
            "转写稿：\n%s" % session.transcript[:4000]
        )

        try:
            result_text = ""
            for phase, content in model_manager.chat_stream(
                message=prompt,
                max_tokens=1024,
                _priority="high",
            ):
                if phase == "raw":
                    if "[ERROR]" in content or "[TIMEOUT" in content:
                        log.warning("[RECORDER] 摘要生成中断: %s" % content[:100])
                        return {"error": "摘要生成中断: %s" % content[:100]}
                    result_text += content
                elif phase == "text":
                    result_text += content

            result_text = result_text.strip()
            if not result_text or len(result_text) < 10:
                return {"error": "摘要生成结果为空，请重试"}

            session.summary = result_text
            self._save_sessions()

            return {"ok": True, "summary": session.summary}

        except Exception as e:
            log.error("[RECORDER] 生成纪要失败: %s" % str(e))
            return {"error": "生成纪要失败: %s" % str(e)}

    # ===== 转写稿入库（P6-14）=====

    def import_to_kb(self, session_id: str, kb_manager) -> Dict[str, Any]:
        """转写稿导入文库（D39: 独立检索索引）"""
        if session_id not in self.sessions:
            return {"error": "会话不存在"}
        session = self.sessions[session_id]
        if session.status != "done":
            return {"error": "会话未完成转写"}
        if not session.transcript:
            return {"error": "转写稿为空"}
        if session.kb_doc_id:
            return {"error": "已导入文库", "doc_id": session.kb_doc_id}

        # 调用文库的 import_text
        filename = session.import_filename or ("录音_%s" % session.started_at[:16].replace("T", "_").replace(":", ""))
        result = kb_manager.import_document(
            filename="转写_%s.txt" % filename,
            text=session.transcript,
            file_type="txt",
            source="transcript"
        )

        if "error" in result:
            return result

        doc_id = result["doc_id"]
        session.kb_doc_id = doc_id

        # 异步处理（分块+嵌入）
        import threading
        t = threading.Thread(target=lambda: kb_manager.process_document(doc_id, session.transcript), daemon=True)
        t.start()

        self._save_sessions()
        log.info("[RECORDER] 转写稿入库: %s → doc %s" % (session_id, doc_id))
        return {"ok": True, "doc_id": doc_id}

    # ===== 统计 =====

    def get_storage_usage(self) -> Dict[str, Any]:
        """D34: 录音空间占用统计"""
        total_bytes = 0
        for session in self.sessions.values():
            total_bytes += session.disk_size_bytes

        return {
            "total_sessions": len(self.sessions),
            "max_sessions": self.MAX_SESSIONS,
            "total_bytes": total_bytes,
            "total_mb": round(total_bytes / 1024 / 1024, 1),
        }

    # ===== 崩溃恢复（D36）=====

    def recover_sessions(self) -> Dict[str, Any]:
        """启动时扫描未完成的session，尝试恢复"""
        recovered = []
        for sid, session in self.sessions.items():
            if session.status in ("recording", "transcribing", "refining"):
                if session.status == "recording" and session.chunk_count > 0:
                    session.status = "queued"
                    session.phase = None
                    recovered.append(sid)
                    log.info("[RECORDER] 恢复录音: %s (%d chunks)" % (sid, session.chunk_count))
                elif session.status in ("transcribing", "refining"):
                    session.status = "queued"
                    session.phase = None
                    session.progress = 0.0
                    recovered.append(sid)
                    log.info("[RECORDER] 恢复转写队列: %s" % sid)

        if recovered:
            self._save_sessions()
        return {"ok": True, "recovered": recovered}

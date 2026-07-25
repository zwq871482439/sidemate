# -*- coding: utf-8 -*-
"""download_engine.py — 模型下载引擎

流式下载 GGUF（LLM）和多文件模型包（KB embedding/reranker），
支持断点续传、进度回调、双源 fallback（ModelScope 优先 / HuggingFace 备选）。

职责边界（与 model_manager / registry 的分工）：
  - 本模块只管"把文件下载到指定路径"，不关心模型注册/加载。
  - LLM 下载完成后由调用方调 /api/rescan 刷新注册表。
  - KB 下载完成后由调用方复用 ExtensionRegistry 注册 + kb.load_models()。
"""
import os
import time
import threading
import queue
import logging
from typing import Optional, Dict, List, Callable

import httpx

log = logging.getLogger("download")

# 单例任务管理器（全局只允许同时跑一个下载任务，避免带宽抢占 + 写冲突）
_tasks: Dict[str, "DownloadTask"] = {}
_tasks_lock = threading.Lock()


# --------------------------------------------------------------------
# URL 构造：双源（ModelScope / HuggingFace）
# --------------------------------------------------------------------

def build_urls(repo_id: str, filename: str, source: str = "modelscope") -> List[str]:
    """构造文件的直接下载 URL 列表（首选源在前，备选源在后）。

    ModelScope resolve API 支持 Range 断点续传（已验证 HTTP 206）。
    HuggingFace resolve 同样支持 Range（国内需代理）。
    """
    ms_url = ("https://www.modelscope.cn/api/v1/models/%s/repo?Revision=master&FilePath=%s"
              % (repo_id, filename))
    hf_url = "https://huggingface.co/%s/resolve/main/%s" % (repo_id, filename)

    if source == "huggingface":
        return [hf_url, ms_url]  # HF 优先，MS 兜底
    return [ms_url, hf_url]  # 默认 ModelScope 优先


def list_repo_files(repo_id: str, source: str = "modelscope") -> List[dict]:
    """列出 ModelScope 仓库的文件清单（path + size）。

    返回 [{"path": "config.json", "size": 687}, ...]。
    HuggingFace 暂不支持列表（国内不可达），KB 走 ModelScope。
    """
    api = "https://www.modelscope.cn/api/v1/models/%s/repo/files?Revision=master" % repo_id
    resp = httpx.get(api, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    files = []
    for f in data.get("Data", {}).get("Files", []):
        path = f.get("Path", "")
        size = f.get("Size", 0)
        if path and not path.endswith("/"):  # 跳过目录条目
            try:
                size = int(size)
            except (TypeError, ValueError):
                size = 0
            files.append({"path": path, "size": size})
    return files


# --------------------------------------------------------------------
# 下载任务
# --------------------------------------------------------------------

class DownloadTask:
    """单个下载任务（LLM 单 GGUF 或 KB 多文件组合）。

    进度通过 queue 推送 SSE 事件：{"pct": int, "msg": str, "done": bool, "error": str}
    """

    def __init__(self, task_id: str, task_type: str, label: str):
        self.task_id = task_id
        self.type = task_type  # "llm" | "kb"
        self.label = label
        self.queue: queue.Queue = queue.Queue()
        self.status = "pending"  # pending → running → done | error | cancelled
        self.error: Optional[str] = None
        self.created_at = time.time()
        self._cancel = threading.Event()
        self._thread: Optional[threading.Thread] = None
        # 进度状态
        self.total_bytes = 0
        self.downloaded_bytes = 0
        self._speed_ts = 0.0
        self._speed_bytes = 0

    def cancel(self):
        self._cancel.set()
        self.status = "cancelled"

    def _emit(self, pct: int, msg: str, done: bool = False, error: str = None):
        self.queue.put({"pct": pct, "msg": msg, "done": done, "error": error})

    def _download_file(self, url_list: List[str], dest_path: str, expected_size: int = 0):
        """下载单个文件到 dest_path（支持断点续传）。

        url_list: 候选 URL 列表，依次尝试，首个成功即用。
        """
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        part_path = dest_path + ".part"
        # 断点续传：读已有 .part 大小
        resume_pos = os.path.getsize(part_path) if os.path.exists(part_path) else 0

        last_err = None
        for url in url_list:
            if self._cancel.is_set():
                raise RuntimeError("已取消")
            try:
                headers = {"Range": "bytes=%d-" % resume_pos} if resume_pos else {}
                with httpx.stream("GET", url, headers=headers, timeout=httpx.Timeout(60, connect=30, read=120),
                                  follow_redirects=True) as resp:
                    if resp.status_code not in (200, 206):
                        last_err = "HTTP %d" % resp.status_code
                        log.warning("[DL] %s 返回 %s，尝试下一个源", url, last_err)
                        continue

                    # 判断服务器是否真的支持续传（206=支持，200=不支持需重头下）
                    if resume_pos and resp.status_code == 200:
                        resume_pos = 0  # 不支持续传，从头来

                    # 总大小
                    content_length = resp.headers.get("content-length", "")
                    try:
                        cl = int(content_length)
                    except (TypeError, ValueError):
                        cl = 0
                    total = resume_pos + cl if cl else expected_size

                    mode = "ab" if resume_pos else "wb"
                    self._speed_ts = time.time()
                    self._speed_bytes = 0  # 速度窗口计数（不含续传起点，否则首秒速度虚高）

                    with open(part_path, mode) as f:
                        for chunk in resp.iter_bytes(chunk_size=256 * 1024):
                            if self._cancel.is_set():
                                raise RuntimeError("已取消")
                            f.write(chunk)
                            self.downloaded_bytes += len(chunk)
                            self._speed_bytes += len(chunk)
                            # 每秒推一次进度
                            now = time.time()
                            if now - self._speed_ts >= 1.0:
                                self._push_progress(total)
                                self._speed_ts = now
                                self._speed_bytes = 0  # 重置速度窗口，否则速度=累计下载量/1s
                    # 下载完成
                    self._push_progress(total)
                    os.rename(part_path, dest_path)
                    log.info("[DL] 完成 %s (%d bytes)", dest_path, os.path.getsize(dest_path))
                    return  # 成功，退出候选循环
            except RuntimeError:
                raise  # 取消，直接抛
            except Exception as e:
                last_err = str(e)
                log.warning("[DL] %s 下载失败: %s，尝试下一个源", url, e)
                continue

        raise RuntimeError("所有下载源均失败: %s" % (last_err or "未知错误"))

    def _push_progress(self, total: int):
        """推送进度事件（含速度 + 剩余时间）。"""
        self.total_bytes = total
        pct = int(self.downloaded_bytes * 100 / total) if total else 0
        if pct > 99:
            pct = 99  # 留 1% 给安装阶段
        dl = self.downloaded_bytes
        speed = self._speed_bytes / max(1, time.time() - self._speed_ts) if self._speed_ts else 0
        eta = (total - dl) / speed if speed > 0 else 0
        msg = "%s / %s · %s/s" % (_fmt_size(dl), _fmt_size(total), _fmt_size(speed))
        if eta > 0 and eta < 3600:
            if eta < 1:
                msg += " · 剩余 <1s"
            elif eta < 60:
                msg += " · 剩余 %ds" % int(eta)
            else:
                msg += " · 剩余 %dm%ds" % (int(eta) // 60, int(eta) % 60)
        self._emit(pct, msg)


def _fmt_size(n: float) -> str:
    """字节数格式化。"""
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return "%.1f%s" % (n, unit)
        n /= 1024
    return "%.1fTB" % n


# --------------------------------------------------------------------
# 任务管理 API（供 router 调用）
# --------------------------------------------------------------------

def create_task(task_type: str, label: str) -> DownloadTask:
    """创建并注册一个下载任务。"""
    import uuid
    task_id = uuid.uuid4().hex[:12]
    task = DownloadTask(task_id, task_type, label)
    with _tasks_lock:
        _tasks[task_id] = task
    _cleanup_old_tasks()
    return task


def get_task(task_id: str) -> Optional[DownloadTask]:
    return _tasks.get(task_id)


def has_running_task() -> Optional[DownloadTask]:
    """是否有正在运行的任务（同时只允许一个）。"""
    with _tasks_lock:
        for t in _tasks.values():
            if t.status in ("pending", "running"):
                return t
    return None


def _cleanup_old_tasks():
    """清理 1 小时前的已完成任务，避免内存泄漏。"""
    now = time.time()
    with _tasks_lock:
        expired = [tid for tid, t in _tasks.items()
                   if t.status in ("done", "error", "cancelled") and now - t.created_at > 3600]
        for tid in expired:
            _tasks.pop(tid, None)


# --------------------------------------------------------------------
# 下载执行（后台线程）
# --------------------------------------------------------------------

def run_llm_download(task: DownloadTask, meta: dict, models_dir: str, source: str, on_complete=None):
    """LLM 下载：单 GGUF 文件 + 复用已有 meta.json。

    meta: 来自 registry 的模型元数据（含 download.repo_id/filename + gguf_filename + gguf_size_bytes）
    on_complete: 下载成功后调用的回调（传入 task），负责安装收尾（rescan/注册）。
    """
    def _worker():
        try:
            task.status = "running"
            dl = meta.get("download", {})
            repo_id = dl.get("repo_id", "")
            filename = dl.get("filename", meta.get("gguf_filename", ""))
            gguf_filename = meta.get("gguf_filename", filename)
            expected = meta.get("gguf_size_bytes", 0)

            model_dir = os.path.join(models_dir, meta["model_id"])
            dest = os.path.join(model_dir, gguf_filename)
            task._emit(1, "开始下载 %s..." % meta.get("display_name", filename))

            urls = build_urls(repo_id, filename, source)
            task._download_file(urls, dest, expected)

            # meta.json 已由 Inno Setup 预装；若缺失则写一份（全新安装场景）
            meta_path = os.path.join(model_dir, "meta.json")
            if not os.path.exists(meta_path):
                import json
                with open(meta_path, "w", encoding="utf-8") as f:
                    json.dump(meta, f, ensure_ascii=False, indent=2)

            task.status = "done"  # 先置状态再推事件：SSE 消费端凭 status=="done" 补推 installed
            task._emit(100, "下载完成，正在刷新模型列表...", done=True)
            if on_complete:
                try:
                    on_complete(task)
                except Exception as e:
                    log.error("[DL] 安装收尾失败: %s", e)
        except Exception as e:
            task.status = "error"
            task.error = str(e)
            task._emit(0, "下载失败: %s" % e, done=True, error=str(e))
            log.error("[DL] LLM 下载失败: %s", e, exc_info=True)

    task._thread = threading.Thread(target=_worker, daemon=True)
    task._thread.start()


# KB 模型需要的文件清单（从 ModelScope 文件列表整理，已排除无用文件）
# 去除 onnx/（2.27GB 未用副本）、imgs/、assets/、README.md、long.jpg、.gitattributes
KB_EMBEDDING_FILES = [
    "pytorch_model.bin", "sparse_linear.pt", "colbert_linear.pt",
    "config.json", "config_sentence_transformers.json", "configuration.json",
    "modules.json", "sentence_bert_config.json",
    "sentencepiece.bpe.model", "tokenizer.json", "tokenizer_config.json",
    "special_tokens_map.json",
    "1_Pooling/config.json",
]
KB_RERANKER_FILES = [
    "model.safetensors",
    "config.json", "configuration.json",
    "sentencepiece.bpe.model", "tokenizer.json", "tokenizer_config.json",
    "special_tokens_map.json",
]
KB_REPOS = {
    "embedding": {"repo_id": "BAAI/bge-m3", "files": KB_EMBEDDING_FILES, "dest_subdir": "embedding"},
    "reranker": {"repo_id": "BAAI/bge-reranker-v2-m3", "files": KB_RERANKER_FILES, "dest_subdir": "reranker"},
}


def run_kb_download(task: DownloadTask, models_dir: str, source: str, on_complete=None):
    """KB 下载：embedding + reranker 多文件组合，下载到 models/embedding 和 models/reranker。
    on_complete: 下载成功后调用的回调（传入 task），负责安装收尾（注册扩展+加载模型）。
    """
    def _worker():
        try:
            task.status = "running"
            # 先获取所有文件的真实大小（用于总进度计算）
            task._emit(2, "获取文件清单...")
            file_list = []  # [(repo_id, filename, dest_path, size)]
            total_expected = 0
            for role, spec in KB_REPOS.items():
                repo_files = {f["path"]: f["size"] for f in list_repo_files(spec["repo_id"], source)}
                dest_dir = os.path.join(models_dir, spec["dest_subdir"])
                for fname in spec["files"]:
                    size = repo_files.get(fname, 0)
                    total_expected += size
                    file_list.append((spec["repo_id"], fname, os.path.join(dest_dir, fname), size))

            task.total_bytes = total_expected
            # 多文件下载：逐个下，进度按累计字节计算
            for idx, (repo_id, fname, dest_path, fsize) in enumerate(file_list):
                if task._cancel.is_set():
                    raise RuntimeError("已取消")
                # 跳过已存在的文件（支持断点续传到文件粒度）
                if os.path.exists(dest_path) and os.path.getsize(dest_path) == fsize and fsize > 0:
                    task.downloaded_bytes += fsize
                    continue
                task._emit(_pct(task.downloaded_bytes, total_expected),
                           "下载 %s (%d/%d)..." % (fname, idx + 1, len(file_list)))
                urls = build_urls(repo_id, fname, source)
                # 多文件场景：临时用子方法下载，但不让 _download_file 的进度推送覆盖全局进度
                task._download_file(urls, dest_path, fsize)

            task.status = "done"  # 先置状态再推事件：SSE 消费端凭 status=="done" 补推 installed
            task._emit(100, "知识库模型下载完成，正在安装...", done=True)
            if on_complete:
                try:
                    on_complete(task)
                except Exception as e:
                    log.error("[DL] KB 安装收尾失败: %s", e)
        except Exception as e:
            task.status = "error"
            task.error = str(e)
            task._emit(0, "下载失败: %s" % e, done=True, error=str(e))
            log.error("[DL] KB 下载失败: %s", e, exc_info=True)

    task._thread = threading.Thread(target=_worker, daemon=True)
    task._thread.start()


def _pct(done: int, total: int) -> int:
    return int(done * 95 / total) if total else 0  # 留 5% 给安装阶段


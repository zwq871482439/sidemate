# -*- coding: utf-8 -*-
"""
core/project_kb.py — 项目知识库（PLAN ②+++ 议题2 定稿落地，M2-5）
================================================================

KB 引擎（bge-m3/chunker 全复用）的项目作用域极简实例：
- 默认关闭，手动开关；仅在线模式用（离线走全局 KB 兜底）
- 入库两路径：项目内勾选 / 外部文件（复制源文件进项目根再入库）；
  逐文件勾选，绝不自动扫文件夹（.sidemate 产物不误入）
- 索引存 <项目>/.sidemate/index/（chunks.jsonl + vectors.npy + meta.json），
  随项目文件夹走；关闭开关或删项目即清索引（派生物，删除无损失）
- 项目规模检索用 numpy 余弦（百级 chunk，不上 faiss）
- 嵌入引擎由调用方注入（生产=全局 KB 的共享 bge-m3 embedder，测试=fake）——
  本模块不 import server/routers.deps（pytest 安全）
- 隐私：嵌入全程本地不出机；在线会话检索命中片段随 prompt 上云（文案写明）
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time

import numpy as np

log = logging.getLogger(__name__)

INDEX_DIRNAME = os.path.join(".sidemate", "index")
MAX_CHUNKS_PER_FILE = 60          # 单文件 chunk 上限（项目规模保护）
LARGE_FILE_BYTES = 50 * 1024      # 大文件提示阈值（≈1 万 token，200 token/KB）


# ---------- 路径与开关 ----------

def _index_dir(proj_dir):
    return os.path.join(proj_dir, INDEX_DIRNAME)


def _registry_flag(proj_dir, on=None):
    """读写注册表条目的 kb_enabled 标记（on=None 读，bool 写）。"""
    from session import projects
    data = projects._load()
    entry = projects._find(data, proj_dir)
    if on is None:
        return bool(entry and entry.get("kb_enabled"))
    if entry is None:
        # 未注册的项目（默认项目）也允许开：给默认项目造一条注册记录
        entry = {"dir": proj_dir, "display": os.path.basename(proj_dir.rstrip("\\/")),
                 "created_at": time.strftime("%Y-%m-%d %H:%M:%S")}
        data["projects"].append(entry)
    entry["kb_enabled"] = bool(on)
    projects._save(data)
    return bool(on)


def is_enabled(proj_dir):
    return _registry_flag(proj_dir)


def has_index(proj_dir):
    """项目知识库可用 = 开关开 + 索引非空。"""
    if not proj_dir or not is_enabled(proj_dir):
        return False
    p = os.path.join(_index_dir(proj_dir), "chunks.jsonl")
    return os.path.isfile(p) and os.path.getsize(p) > 0


def set_enabled(proj_dir, on):
    """开/关。关=清索引（索引是派生物，删除无损失；材料本体不动）。"""
    if on:
        os.makedirs(_index_dir(proj_dir), exist_ok=True)
        _registry_flag(proj_dir, True)
        log.info("[PROJ-KB] 开启：%s", proj_dir)
        return {"ok": True, "enabled": True}
    _clear_index(proj_dir)
    _registry_flag(proj_dir, False)
    log.info("[PROJ-KB] 关闭并清索引：%s", proj_dir)
    return {"ok": True, "enabled": False}


def _clear_index(proj_dir):
    import shutil
    d = _index_dir(proj_dir)
    if os.path.isdir(d):
        shutil.rmtree(d, ignore_errors=True)


def clear_index_if_exists(proj_dir):
    """删项目时的级联清理钩子（注册表移除处调用）。"""
    _clear_index(proj_dir)
    _registry_flag(proj_dir, False) if _registry_flag(proj_dir) else None


# ---------- 入库 ----------

def _file_hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for blk in iter(lambda: f.read(65536), b""):
            h.update(blk)
    return h.hexdigest()


def index_file(proj_dir, rel_path, embedder):
    """入库一个项目内文件：提取文本 → 分段 → 编码 → 写入索引。

    Args:
        proj_dir: 项目目录（绝对路径）
        rel_path: 项目内相对路径（防穿越校验）
        embedder: 嵌入引擎（encode(texts)/encode_query(q)）

    Returns:
        dict: {ok, path, chunks, message}
    """
    from core import project_write as _pw  # 复用防穿越
    ok, rel_or_err = _pw._safe_rel(rel_path)
    if not ok:
        return {"ok": False, "error": "path_violation", "message": rel_or_err}
    rel = rel_or_err
    abs_path = os.path.normpath(os.path.join(proj_dir, rel.replace("/", os.sep)))
    if not os.path.isfile(abs_path):
        return {"ok": False, "error": "not_found", "message": "文件不存在：%s" % rel}

    from knowledge.file_extractor import extract_text
    from knowledge.chunker import chunk_text
    text = extract_text(abs_path)
    if not text or not text.strip() or text.startswith("[不支持"):
        return {"ok": False, "error": "empty",
                "message": "没读到文本内容（格式不支持或文件为空）：%s" % rel}

    plan = chunk_text(text, max_chunks=MAX_CHUNKS_PER_FILE)
    chunks = [c.text for c in plan.chunks if c.text.strip()][:MAX_CHUNKS_PER_FILE]
    if not chunks:
        return {"ok": False, "error": "empty", "message": "分段后无有效内容：%s" % rel}

    vecs = embedder.encode(chunks)
    vecs = np.asarray(vecs, dtype=np.float32)

    # 同一文件重入库 = 先删旧 chunk（换版重建）
    _remove_file_chunks(proj_dir, rel)

    d = _index_dir(proj_dir)
    os.makedirs(d, exist_ok=True)
    chunks_path = os.path.join(d, "chunks.jsonl")
    vecs_path = os.path.join(d, "vectors.npy")
    meta_path = os.path.join(d, "meta.json")

    # 追加 chunks
    base_no = 0
    existing_vecs = None
    if os.path.isfile(chunks_path):
        with open(chunks_path, encoding="utf-8") as f:
            base_no = sum(1 for _ in f)
        existing_vecs = np.load(vecs_path) if os.path.isfile(vecs_path) else None

    with open(chunks_path, "a", encoding="utf-8") as f:
        for i, c in enumerate(chunks):
            f.write(json.dumps({"id": base_no + i, "path": rel, "chunk_no": i,
                                "text": c}, ensure_ascii=False) + "\n")
    new_vecs = vecs if existing_vecs is None else np.vstack([existing_vecs, vecs])
    np.save(vecs_path, new_vecs)

    # 文件元信息（换版检测用）
    try:
        meta = json.load(open(meta_path, encoding="utf-8"))
    except (OSError, ValueError):
        meta = {}
    st = os.stat(abs_path)
    meta[rel] = {"hash": _file_hash(abs_path), "mtime": int(st.st_mtime),
                 "size": st.st_size, "chunks": len(chunks),
                 "indexed_at": time.strftime("%Y-%m-%d %H:%M:%S")}
    from common.utils import atomic_write_json
    atomic_write_json(meta_path, meta)
    log.info("[PROJ-KB] 入库 %s：%d chunks", rel, len(chunks))
    return {"ok": True, "path": rel, "chunks": len(chunks),
            "message": "已入库 %s（%d 段）" % (rel, len(chunks))}


def _remove_file_chunks(proj_dir, rel):
    """从索引移除某文件的全部 chunk（重写 chunks.jsonl + vectors.npy）。"""
    d = _index_dir(proj_dir)
    chunks_path = os.path.join(d, "chunks.jsonl")
    vecs_path = os.path.join(d, "vectors.npy")
    meta_path = os.path.join(d, "meta.json")
    if not os.path.isfile(chunks_path):
        return
    rows = []
    with open(chunks_path, encoding="utf-8") as f:
        for ln in f:
            try:
                r = json.loads(ln)
            except ValueError:
                continue
            rows.append(r)
    keep_idx = [i for i, r in enumerate(rows) if r.get("path") != rel]
    if len(keep_idx) == len(rows):
        return
    with open(chunks_path, "w", encoding="utf-8") as f:
        for i in keep_idx:
            f.write(json.dumps(rows[i], ensure_ascii=False) + "\n")
    if os.path.isfile(vecs_path):
        vecs = np.load(vecs_path)
        np.save(vecs_path, vecs[keep_idx] if keep_idx else np.empty((0, vecs.shape[1]), dtype=np.float32))
    try:
        meta = json.load(open(meta_path, encoding="utf-8"))
        meta.pop(rel, None)
        from common.utils import atomic_write_json
        atomic_write_json(meta_path, meta)
    except (OSError, ValueError):
        pass


def remove_file(proj_dir, rel_path):
    _remove_file_chunks(proj_dir, rel_path)
    return {"ok": True, "path": rel_path}


# ---------- 检索 ----------

def query(proj_dir, q, embedder, top_k=5):
    """项目内语义检索（诊断框与 project_kb_search 工具共用）。

    Returns:
        list[dict]: [{path, chunk_no, text, score}]（按分数降序）
    """
    if not has_index(proj_dir):
        return []
    d = _index_dir(proj_dir)
    with open(os.path.join(d, "chunks.jsonl"), encoding="utf-8") as f:
        rows = [json.loads(ln) for ln in f if ln.strip()]
    vecs = np.load(os.path.join(d, "vectors.npy"))
    if not rows or vecs.shape[0] == 0:
        return []
    qv = np.asarray(embedder.encode_query(q), dtype=np.float32).reshape(-1)
    norms = np.linalg.norm(vecs, axis=1) * (np.linalg.norm(qv) + 1e-9)
    scores = (vecs @ qv) / np.maximum(norms, 1e-9)
    top = np.argsort(-scores)[:top_k]
    out = []
    for i in top:
        r = rows[i] if i < len(rows) else None
        if r:
            out.append({"path": r["path"], "chunk_no": r["chunk_no"],
                        "text": r["text"], "score": float(scores[i])})
    return out


# ---------- 状态与提示 ----------

def status(proj_dir):
    """开关状态 + 入库文件清单 + 体量 + 换版检测（源文件 hash/mtime 变了→提示重建）。"""
    enabled = is_enabled(proj_dir)
    d = _index_dir(proj_dir)
    meta_path = os.path.join(d, "meta.json")
    files = []
    size_bytes = 0
    if enabled and os.path.isfile(meta_path):
        try:
            meta = json.load(open(meta_path, encoding="utf-8"))
        except (OSError, ValueError):
            meta = {}
        for rel, m in meta.items():
            abs_path = os.path.join(proj_dir, rel.replace("/", os.sep))
            stale = False
            if os.path.isfile(abs_path):
                st = os.stat(abs_path)
                stale = (int(st.st_mtime) != m.get("mtime")
                         and _file_hash(abs_path) != m.get("hash"))
            else:
                stale = True  # 源文件没了
            files.append({"path": rel, "chunks": m.get("chunks", 0),
                          "indexed_at": m.get("indexed_at", ""), "stale": stale})
        for fn in ("chunks.jsonl", "vectors.npy"):
            fp = os.path.join(d, fn)
            if os.path.isfile(fp):
                size_bytes += os.path.getsize(fp)
    return {"enabled": enabled, "files": files, "chunks": sum(f["chunks"] for f in files),
            "size_bytes": size_bytes}


def large_material_hints(proj_dir, indexed_paths=None):
    """大文件提示：项目根下 >50KB 的可提取文本材料且未入库 → 建议入项目知识库。"""
    from knowledge.file_extractor import extract_text  # noqa: F401（存在性）
    exts = (".txt", ".md", ".csv", ".docx", ".xlsx", ".pdf", ".pptx",
            ".epub", ".html", ".htm", ".srt", ".rtf")
    indexed = set(indexed_paths or [])
    out = []
    try:
        for fn in sorted(os.listdir(proj_dir)):
            fp = os.path.join(proj_dir, fn)
            if not os.path.isfile(fp) or fn.startswith("."):
                continue
            if os.path.splitext(fn)[1].lower() not in exts:
                continue
            if os.path.getsize(fp) < LARGE_FILE_BYTES:
                continue
            if fn in indexed:
                continue
            out.append({"path": fn, "size": os.path.getsize(fp)})
    except OSError:
        pass
    return out[:5]

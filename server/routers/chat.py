# -*- coding: utf-8 -*-
"""
routers/chat.py — Chat/会话/QA/文件上传 Router

端点前缀 /api：
  POST /api/chat              — 非流式对话
  POST /api/chat/stream       — 流式对话（核心 ~700 行）
  GET  /api/chats             — 会话列表
  POST /api/chats/new         — 新建会话
  POST /api/chats/switch      — 切换会话
  DELETE /api/chats/{chat_name} — 删除会话
  GET  /api/chats/{chat_name}/messages — 获取消息历史
  POST /api/chats/{chat_name}/append   — 追加消息
  POST /api/qa/upload         — 问答Tab文件上传
  POST /api/qa/ask            — 问答Tab提问
  POST /api/file_upload       — 文件上传
"""
import os
import re
import json
import time
import logging
from typing import Optional

from fastapi import APIRouter, UploadFile, File, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from routers.deps import (
    get_mgr, get_kb,
    get_current_chat_file, get_current_chat, set_current_chat, get_default_llm,
    get_log, WORKSPACE_DIR, CHAT_DIR, UPLOAD_DIR, FILES_DIR,
)

# Patch 12: 从拆分后的模块导入
from session.chat_store import (
    safe_chat_name,
    today_str,
    new_chat_file,
    save_chat,
    load_chat,
    load_chat_cache,
    list_chats,
    rename_chat,
    _chat_save_lock,
)
from session.context_cache import (
    clean_history_for_model,
    clean_think_content_wrapped as clean_think_content,
    update_session_cache,
)
from session.continuation import (
    get_latest_chat,
    is_output_incomplete,
)

router = APIRouter()
log = get_log()


# ============================================================
#  Pydantic 请求模型
# ============================================================

class ChatRequest(BaseModel):
    """聊天请求通用模型"""
    message: str = ""
    model: Optional[str] = None
    max_tokens: Optional[int] = None
    history: Optional[list] = None
    chat_file: Optional[str] = None
    mode: Optional[str] = None
    scene: Optional[str] = None  # deprecated, keep for backward compat
    action_mode: Optional[str] = None  # "chat"|"kb"|"doc"|扩展ID
    file_path: Optional[str] = None
    doc_continue: Optional[str] = None  # Phase 2: 用户确认的提纲内容


# ============================================================
#  辅助函数（保留在此文件的）
# ============================================================

def _safe_filename(filename: str) -> str:
    """防止路径遍历 — 使用 pathlib 取纯文件名，再清理特殊字符"""
    if not filename:
        return "unnamed"
    from pathlib import PurePath
    filename = PurePath(filename).name
    filename = re.sub(r'[^\w\-.\u4e00-\u9fff]', '_', filename)
    if filename in (".", "..", ""):
        filename = "unnamed"
    return filename


def _is_safe_chat_id(chat_id: str) -> bool:
    """Patch4 v3.1：校验 chat_id 格式（YYYY-MM-DD_NNN 或 YYYY-MM-DD_NNN.json）"""
    if not chat_id:
        return False
    # 允许 .json 后缀
    cid = chat_id.replace(".json", "")
    # 格式：YYYY-MM-DD_NNN（日期-编号）
    return bool(re.match(r'^\d{4}-\d{2}-\d{2}_\d{3}$', cid))


def _sanitize_output(text: str) -> str:
    """轻量排版清理（不删正文内容，只做格式修整）

    V2 新增：首字修正（截掉开头的逗号/顿号，防幻觉续写兜底）

    处理项：
    1. 连续空格压缩（4+ 空格 → 1 空格）
    2. 连续空行限制（最多保留 2 个空行）
    3. 末尾残缺标签清理（<think, <thinking 等）
    4. V2 首字修正：截掉开头的标点（逗号/顿号/分号/冒号）
    5. 首尾空白清理
    """
    if not text or not text.strip():
        return text

    # 1. 连续空格压缩
    text = re.sub(r' {4,}', ' ', text)

    # 2. 连续空行限制
    text = re.sub(r'\n{4,}', '\n\n\n', text)

    # 3. 末尾残缺标签清理
    text = re.sub(r'<+<?\s*(think|thinking|reason|reasoning|thought)\s*[^\w]*$', '', text)

    # 4. V2 首字修正：截掉开头的标点（幻觉续写兜底）
    text = re.sub(r'^[，、；：]\s*', '', text)

    # 5. 首尾空白
    text = text.strip()

    return text


# （以下函数已移至 session/ 子模块，通过顶部 import 引入）
# - safe_chat_name, new_chat_file, save_chat, load_chat, load_chat_cache, list_chats
#   → session/chat_store.py
# - clean_history_for_model, clean_think_content, update_session_cache
#   → session/context_cache.py
# - get_latest_chat, is_output_incomplete
#   → session/continuation.py


# 旧名称兼容别名（供 sse_gen 内部闭包引用，指向新模块函数）
_safe_chat_name = safe_chat_name
_today_str = today_str
_new_chat_file = new_chat_file
_save_chat = save_chat
_list_chats = list_chats
_clean_history_for_model = clean_history_for_model
_clean_think_content = clean_think_content
_update_session_cache = update_session_cache
_get_latest_chat = get_latest_chat
_is_output_incomplete = is_output_incomplete



# ============================================================
#  非流式对话
# ============================================================

@router.post("/api/chat")
async def api_chat(req: ChatRequest):
    """非流式对话"""
    mgr = get_mgr()
    DEFAULT_LLM = get_default_llm()
    if not DEFAULT_LLM and not req.model:
        return JSONResponse({"error": "暂无可用模型，请先启动 Ollama 并安装模型"}, status_code=503)
    chat_file = req.chat_file or get_current_chat()
    context_cache = load_chat_cache(chat_file)
    return JSONResponse(mgr.chat(
        message=req.message,
        model=req.model or DEFAULT_LLM,
        max_tokens=req.max_tokens,
        history=req.history,
        context_cache=context_cache,
    ))


# ============================================================
#  流式对话（核心端点 ~700 行）
# ============================================================

@router.post("/api/chat/stream")
async def api_chat_stream(request: Request):
    """SSE 流式对话"""
    mgr = get_mgr()
    DEFAULT_LLM = get_default_llm()
    kb = get_kb()

    from config import get as _cfg_get

    try:
        body = await request.json()
    except Exception as _e:
        _err_msg = str(_e)[:100]
        log.error("[CHAT] request.json() parse failed: %s" % _err_msg)
        def _err_gen(msg=_err_msg):
            yield 'data: {"type": "error", "content": "请求体解析失败: %s"}\n\n' % msg
            yield 'data: [DONE]\n\n'
        return StreamingResponse(_err_gen(), media_type="text/event-stream")

    # 无模型防护：云模式跳过（使用云端模型），本地模式下既没有默认模型、请求也没指定模型时返回错误
    _ai_mode = _cfg_get("ai_mode", "local")
    if _ai_mode != "cloud" and not DEFAULT_LLM and not body.get("model"):
        async def _no_model_gen():
            yield 'data: {"type": "error", "content": "暂无可用模型，请先启动 Ollama 并安装模型"}\n\n'
            yield 'data: [DONE]\n\n'
        return StreamingResponse(_no_model_gen(), media_type="text/event-stream")

    try:
        req = ChatRequest(**{k: body.get(k) for k in ("message", "model", "max_tokens", "history", "chat_file", "mode", "action_mode", "file_path", "doc_continue") if k in body})
    except Exception as _e:
        _err_msg2 = str(_e)[:100]
        log.error("[CHAT] ChatRequest validation failed: body_keys=%s error=%s" % (list(body.keys()), _err_msg2))
        def _err_gen2(msg=_err_msg2):
            yield 'data: {"type": "error", "content": "请求参数校验失败: %s"}\n\n' % msg
            yield 'data: [DONE]\n\n'
        return StreamingResponse(_err_gen2(), media_type="text/event-stream")

    message = req.message
    model_name = req.model or DEFAULT_LLM
    max_tokens = req.max_tokens
    chat_file = req.chat_file or get_current_chat()
    history_raw = req.history or []
    action_mode = body.get("action_mode", "chat") or "chat"
    file_path = body.get("file_path")
    override_task_type = body.get("override_task_type")
    log.info("[CHAT] stream request: chat=%s model=%s action=%s msg_len=%d ai_mode=%s" % (
        os.path.basename(chat_file) if chat_file else "none", model_name, action_mode, len(message or ""),
        _ai_mode))
    mgr.stop_requested = False

    # (OCR 图片处理已移除 — OCR 已归档)

    prompt = message

    # 文件处理：支持上传文件路径 或 KB doc_id 引用
    file_info = None
    if file_path:
        if os.path.exists(file_path):
            # Patch5 G：上传文件不再截断，前端预检已确保 token 在预算内
            from knowledge.file_extractor import process_uploaded_file
            file_info = process_uploaded_file(file_path, message or "", max_chars=10**9)
            if file_info["status"] in ("ok", "truncated"):
                prompt = (message or "") + "\n\n[用户上传了文件 %s，内容如下：]\n%s" % (
                    file_info["filename"], file_info["text"])
        else:
            # Patch4 v3.1 BUG#27：支持多选 KB（doc_id 逗号分隔）
            # 拆分所有 doc_id，逐个取全文，合并注入
            doc_ids = [d.strip() for d in file_path.split(",") if d.strip()]
            from knowledge.file_extractor import calc_file_budget, smart_extract
            history_chars_kb = sum(len(m.get("content", "")) for m in history_raw) if history_raw else 0
            file_budget_kb = calc_file_budget(history_chars_kb)

            all_docs_text = []
            found_docs = []
            for did in doc_ids:
                kb_doc = kb.get_document(did)
                if kb_doc and kb_doc.status == "ready":
                    doc_texts = []
                    for chunk in kb.chunks.values():
                        if chunk.doc_id == did and chunk.text:
                            doc_texts.append(chunk.text)
                    if doc_texts:
                        doc_full = "\n\n".join(doc_texts)
                        all_docs_text.append("=== 文档：%s ===\n%s" % (kb_doc.filename, doc_full))
                        found_docs.append(kb_doc.filename)

            if all_docs_text:
                full_text = "\n\n".join(all_docs_text)
                # 多文档时预算放大 1.5 倍（单文档保持原预算）
                if len(doc_ids) > 1:
                    file_budget_kb = int(file_budget_kb * 1.5)
                if len(full_text) > file_budget_kb:
                    full_text = smart_extract(full_text, message or "", file_budget_kb)
                docs_label = "、".join(found_docs) if len(found_docs) <= 3 else ("%s 等 %d 篇" % (found_docs[0], len(found_docs)))
                prompt = (message or "") + "\n\n[用户引用了文库文档 %s，内容如下：]\n%s" % (docs_label, full_text)
                log.info("[CHAT] KB 多选引用: %d篇 (%d字/%d预算) — %s" % (len(found_docs), len(full_text), file_budget_kb, docs_label))
            else:
                log.warning("[CHAT] file_path 无效或文库无此文档: %s" % file_path)

    log.debug("[CHAT] model=%s msg=%s" % (model_name, prompt[:100]))

    # KB 文库检索注入
    kb_results = []
    kb_query = body.get("kb_query")

    # 读取 session 缓存
    context_cache = load_chat_cache(chat_file)

    # Patch5 C7: 清除上下文 — 只取最后一个 context_cutoff 标记之后的消息
    history_raw = list(history_raw or [])
    _cutoff_idx = -1
    for _i, _m in enumerate(history_raw):
        if isinstance(_m, dict) and _m.get("context_cutoff"):
            _cutoff_idx = _i
    if _cutoff_idx >= 0:
        history_raw = history_raw[_cutoff_idx + 1:]
        log.info("[CHAT] context_cutoff at idx %d, history_raw trimmed to %d msgs" % (_cutoff_idx, len(history_raw)))

    llm_history = _clean_history_for_model(history_raw, ai_mode=_ai_mode)

    # Patch5: drift 检测取消（误报率高，砍掉，不再注入 drift_hint）
    drift_result = {"drift": False}

    # 检查模型是否加载（云模式跳过）
    if _ai_mode != "cloud":
        loaded = mgr.get_loaded_llms()
        if not loaded:
            def error_gen():
                yield 'data: {"type": "error", "content": "请先在设置页加载模型"}\n\n'
                yield 'data: [DONE]\n\n'
            return StreamingResponse(error_gen(), media_type="text/event-stream")
        model_choice = loaded[0]
    else:
        model_choice = _cfg_get("cloud_model", "gpt-4o-mini")

    # 检查 KB 是否正在使用模型
    kb_stats = kb.get_stats()
    if kb_stats.get("summarizing_documents", 0) > 0:
        def _kb_busy_gen():
            yield 'data: {"type": "error", "content": "⚠️ 文库正在处理文档摘要，请等待完成后再对话（约需10-30秒）"}\n\n'
            yield 'data: [DONE]\n\n'
        return StreamingResponse(_kb_busy_gen(), media_type="text/event-stream")

    # ===== 构建 StreamContext 并路由到管道 ======
    from pipelines._base import StreamContext

    # Patch3: 文库对比模式判断
    kb_compare = body.get("kb_compare", False)
    _is_kb_compare = (action_mode == "kb" and _ai_mode == "cloud" and kb_compare is True)

    ctx = StreamContext(
        message=message,
        model_name=model_name,
        max_tokens=max_tokens,
        chat_file=chat_file,
        history_raw=history_raw,
        action_mode=action_mode,
        file_path=file_path,
        ai_mode=_ai_mode,
        mgr=mgr,
        kb=kb,
        prompt=prompt,
        llm_history=llm_history,
        context_cache=context_cache,
        drift_result=drift_result,
        model_choice=model_choice,
        doc_continue=body.get("doc_continue", ""),
        body=body,
        is_kb_compare=_is_kb_compare,
    )
    # 存储管道启动时间（供 Agent Loop 计算耗时）
    ctx._pipeline_t0 = time.time()

    log.info("[CHAT] 即将创建 StreamingResponse, ai_mode=%s, model_choice=%s" % (_ai_mode, model_choice))

    from pipelines import create_pipeline
    return StreamingResponse(
        create_pipeline(ctx),
        media_type="text/event-stream",
    )

# ============================================================
#  对话管理 API
# ============================================================

@router.get("/api/chats")
def api_chats_list():
    """列出所有对话"""
    chats = _list_chats()
    current = get_current_chat()
    for c in chats:
        c["current"] = (c["path"] == current)
    return {"chats": chats, "current": current}


@router.post("/api/chats/new")
def api_chats_new():
    """创建新对话"""
    filepath = _new_chat_file()
    name = os.path.basename(filepath)
    # 兼容：如果路径是文件夹，name 就是文件夹名（无 .json 后缀）
    return {"path": filepath, "name": name}


@router.post("/api/chats/switch")
async def api_chats_switch(request: Request):
    """切换对话"""
    body = await request.json()
    filepath = body.get("path")
    if not filepath:
        return JSONResponse({"error": "缺少 path 参数"}, status_code=400)
    # 安全校验：路径必须在 CHAT_DIR 内
    real_path = os.path.realpath(filepath)
    if not real_path.startswith(os.path.realpath(CHAT_DIR)):
        return JSONResponse({"error": "路径不合法，只能在对话目录内操作"}, status_code=400)
    # 支持 .json 文件和文件夹格式
    is_valid = real_path.endswith('.json') or os.path.isdir(real_path)
    if not is_valid:
        return JSONResponse({"error": "非法文件类型"}, status_code=400)
    if not os.path.exists(real_path):
        return JSONResponse({"error": "文件不存在: %s" % filepath}, status_code=404)
    set_current_chat(real_path)
    messages = load_chat(real_path)
    log.info("[CHAT] switched to: %s (%d messages)" % (os.path.basename(filepath), len(messages)))
    return {"path": filepath, "messages": messages}


@router.post("/api/chats/clear_context")
async def api_chats_clear_context(request: Request):
    """[Patch5 C7 已下线] 清除上下文按钮已移除，接口保留备用。

    保留原因：未来 P6 重做模式系统时可能复用 context_cutoff 机制。
    当前调用方已无（前端按钮已删除）。
    """
    return JSONResponse({"error": "此功能已下线", "deprecated": True}, status_code=410)


@router.delete("/api/chats/{chat_name}")
def api_chats_delete(chat_name: str):
    """删除对话（兼容文件夹和 .json 格式）"""
    safe_name = _safe_chat_name(chat_name)
    if not safe_name:
        return JSONResponse({"error": "非法对话名称"}, status_code=400)

    # 尝试文件夹格式
    folder_path = os.path.join(CHAT_DIR, safe_name)
    json_path = os.path.join(CHAT_DIR, safe_name + ".json")

    if os.path.isdir(folder_path):
        filepath = folder_path
    elif os.path.isfile(json_path):
        filepath = json_path
    elif os.path.isfile(folder_path):
        # Patch5 兼容：旧格式文件无 .json 后缀
        filepath = folder_path
    else:
        return JSONResponse({"error": "文件不存在"}, status_code=404)

    try:
        if os.path.isdir(filepath):
            import shutil
            shutil.rmtree(filepath)
        else:
            os.remove(filepath)
        log.info("[CHAT] deleted: %s (file removed)" % filepath)
        if get_current_chat() == filepath:
            set_current_chat(None)
            log.info("[CHAT] current pointer reset (no auto-create)")
        # P1-A3: 清理缓存
        try:
            from session.context_cache import clear_session_cache
            clear_session_cache(filepath)
        except Exception:
            pass
        return {"ok": True, "deleted": filepath}
    except Exception as e:
        log.error("[CHAT] delete failed: %s" % str(e))
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/api/chats/{chat_name}/rename")
async def api_chats_rename(chat_name: str, request: Request):
    """重命名对话"""
    body = await request.json()
    new_name = body.get("new_name", "").strip()
    if not new_name:
        return JSONResponse({"error": "缺少 new_name 参数"}, status_code=400)

    safe_old = _safe_chat_name(chat_name)
    if not safe_old:
        return JSONResponse({"error": "非法对话名称"}, status_code=400)

    result = rename_chat(safe_old, new_name)
    if "error" in result:
        return JSONResponse(result, status_code=400)

    # 如果重命名的是当前对话，更新指针
    old_path = os.path.join(CHAT_DIR, safe_old + ".json")
    new_full_path = result["new_file"]
    if get_current_chat() == old_path:
        set_current_chat(new_full_path)

    # 返回完整路径供前端更新 currentChatFile
    result["new_file"] = new_full_path
    return result


@router.get("/api/chats/{chat_name}/messages")
def api_chats_messages(chat_name: str):
    """获取对话消息（兼容文件夹和 .json 格式）"""
    safe_name = _safe_chat_name(chat_name)
    if not safe_name:
        return JSONResponse({"error": "非法对话名称"}, status_code=400)

    # 尝试文件夹格式
    folder_path = os.path.join(CHAT_DIR, safe_name)
    json_path = os.path.join(CHAT_DIR, safe_name + ".json")

    if os.path.isdir(folder_path):
        filepath = folder_path
    elif os.path.isfile(json_path):
        filepath = json_path
    else:
        filepath = json_path  # fallback

    messages = load_chat(filepath)
    return {"messages": messages}


@router.post("/api/chats/{chat_name}/append")
async def api_chats_append(chat_name: str, request: Request):
    """追加一条消息到对话文件"""
    body = await request.json()
    safe_name = _safe_chat_name(chat_name)
    if not safe_name:
        return JSONResponse({"error": "非法对话名称"}, status_code=400)

    # 尝试文件夹格式
    folder_path = os.path.join(CHAT_DIR, safe_name)
    json_path = os.path.join(CHAT_DIR, safe_name + ".json")

    if os.path.isdir(folder_path):
        filepath = folder_path
    elif os.path.isfile(json_path):
        filepath = json_path
    elif os.path.isfile(folder_path):
        # Patch5 兼容：旧格式文件无 .json 后缀
        filepath = folder_path
    else:
        return JSONResponse({"error": "文件不存在"}, status_code=404)

    role = body.get("role", "")
    content = body.get("content", "")
    ts = body.get("ts", "")
    file_tag = body.get("_file_tag")
    if not role:
        return JSONResponse({"error": "role 必填"}, status_code=400)
    if role not in ("user", "assistant", "system"):
        return JSONResponse({"error": "role 无效: " + role}, status_code=400)

    try:
        with _chat_save_lock:
            # 判断格式
            if os.path.isdir(filepath):
                # 文件夹格式：读写 messages.json
                msgs_path = os.path.join(filepath, "messages.json")
                with open(msgs_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, list):
                    data = {"version": 3, "messages": data}
                data.setdefault("messages", [])
                msg = {
                    "role": role,
                    "content": content,
                    "ts": ts or time.strftime("%H:%M:%S"),
                }
                if file_tag:
                    msg["_file_tag"] = file_tag
                # 传递前端附加字段（_aborted/_abort_reason 等）
                for _ek in ("_aborted", "_abort_reason", "think", "model", "chars",
                            "think_chars", "time", "speed", "task_type", "msg_hash",
                            "action_mode", "agent_timeline", "token_stats", "kb_sources",
                            "context_cutoff"):
                    _ev = body.get(_ek)
                    if _ev is not None:
                        msg[_ek] = _ev
                data["messages"].append(msg)
                tmp_path = msgs_path + ".tmp"
                with open(tmp_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp_path, msgs_path)
                # 更新 meta.json
                meta_path = os.path.join(filepath, "meta.json")
                meta = {}
                if os.path.exists(meta_path):
                    try:
                        with open(meta_path, "r", encoding="utf-8") as f:
                            meta = json.load(f)
                    except Exception:
                        pass
                meta["message_count"] = len(data["messages"])
                meta["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
                tmp_meta = meta_path + ".tmp"
                with open(tmp_meta, "w", encoding="utf-8") as f:
                    json.dump(meta, f, ensure_ascii=False, indent=2)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp_meta, meta_path)
                return {"ok": True, "msg_count": len(data["messages"])}
            else:
                # 旧 .json 格式
                with open(filepath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, list):
                    data = {"version": 2, "messages": data}
                data.setdefault("messages", [])
                msg = {
                    "role": role,
                    "content": content,
                    "ts": ts or time.strftime("%H:%M:%S"),
                }
                if file_tag:
                    msg["_file_tag"] = file_tag
                for _ek in ("_aborted", "_abort_reason", "think", "model", "chars",
                            "think_chars", "time", "speed", "task_type", "msg_hash",
                            "action_mode", "agent_timeline", "token_stats", "kb_sources",
                            "context_cutoff"):
                    _ev = body.get(_ek)
                    if _ev is not None:
                        msg[_ek] = _ev
                data["messages"].append(msg)
                data["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
                tmp_path = filepath + ".tmp"
                with open(tmp_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp_path, filepath)
                return {"ok": True, "msg_count": len(data["messages"])}
        return {"ok": True, "msg_count": len(data["messages"])}
    except Exception as e:
        return JSONResponse({"error": "追加失败: " + str(e)[:100]}, status_code=500)


@router.post("/api/chats/{chat_name}/enrich")
async def api_chats_enrich(chat_name: str, request: Request):
    """回写前端补充字段到最近的 assistant 消息（agent_timeline/token_stats/kb_sources/doc_url 等）

    前端在流式完成后调用，把流式过程中收集的额外数据同步到后端持久化。
    只更新最后一条 assistant 消息，不会新增消息。
    """
    body = await request.json()
    safe_name = _safe_chat_name(chat_name)
    if not safe_name:
        return JSONResponse({"error": "非法对话名称"}, status_code=400)

    folder_path = os.path.join(CHAT_DIR, safe_name)
    json_path = os.path.join(CHAT_DIR, safe_name + ".json")

    if os.path.isdir(folder_path):
        filepath = folder_path
    elif os.path.isfile(json_path):
        filepath = json_path
    elif os.path.isfile(folder_path):
        # Patch5 兼容：旧格式文件无 .json 后缀
        filepath = folder_path
    else:
        return JSONResponse({"error": "文件不存在"}, status_code=404)

    # 要回写的字段（白名单，只接受前端补充的元数据字段）
    enrich_fields = {}
    for key in ("agent_timeline", "agent_summary", "token_stats", "kb_sources", "doc_url", "doc_filename"):
        val = body.get(key)
        if val is not None:
            enrich_fields[key] = val

    if not enrich_fields:
        return {"ok": True, "updated": False, "reason": "no fields"}

    try:
        with _chat_save_lock:
            if os.path.isdir(filepath):
                msgs_path = os.path.join(filepath, "messages.json")
                with open(msgs_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                messages = data.get("messages", []) if isinstance(data, dict) else data
            else:
                with open(filepath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                messages = data.get("messages", []) if isinstance(data, dict) else data

            if not messages:
                return {"ok": True, "updated": False, "reason": "no messages"}

            # 找到最后一条 assistant 消息
            last_assistant_idx = -1
            for i in range(len(messages) - 1, -1, -1):
                if messages[i].get("role") == "assistant":
                    last_assistant_idx = i
                    break

            if last_assistant_idx < 0:
                return {"ok": True, "updated": False, "reason": "no assistant msg"}

            # 回写字段
            messages[last_assistant_idx].update(enrich_fields)

            # 原子写入
            if os.path.isdir(filepath):
                data["messages"] = messages
                tmp_path = msgs_path + ".tmp"
                with open(tmp_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp_path, msgs_path)
            else:
                data["messages"] = messages
                tmp_path = filepath + ".tmp"
                with open(tmp_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp_path, filepath)

        return {"ok": True, "updated": True, "fields": list(enrich_fields.keys())}
    except Exception as e:
        log.error("[CHAT] enrich failed: %s", str(e)[:100])
        return JSONResponse({"error": "回写失败: " + str(e)[:100]}, status_code=500)


# ============================================================
#  问答 Tab API
# ============================================================

@router.post("/api/qa/upload")
async def api_qa_upload(file: UploadFile = File(...)):
    """问答 Tab：上传文件，解析文本内容"""
    from config import get as _cfg_get
    _UPLOAD_MAX_SIZE = _cfg_get("upload_max_size")
    if not file.filename:
        return JSONResponse({"error": "未选择文件"}, status_code=400)
    content_bytes = await file.read()
    if len(content_bytes) > _UPLOAD_MAX_SIZE:
        return JSONResponse({"error": "文件过大（最大50MB）"}, status_code=400)

    ext = (file.filename or "").rsplit(".", 1)[-1].lower()
    text = ""
    _docx_tmp_path = None
    try:
        if ext in ("txt", "md", "csv"):
            text = content_bytes.decode("utf-8", errors="replace")
        elif ext == "docx":
            from knowledge.doc_reader import DocReader
            _docx_tmp_path = os.path.join(UPLOAD_DIR, _safe_filename(file.filename))
            os.makedirs(os.path.dirname(_docx_tmp_path), exist_ok=True)
            with open(_docx_tmp_path, "wb") as f:
                f.write(content_bytes)
            reader = DocReader()
            text = reader.extract_text(_docx_tmp_path)
        elif ext == "doc":
            text = "[不支持 .doc 旧格式，请用 Word 另存为 .docx 后重新上传]"
        elif ext == "xlsx":
            import io
            try:
                import openpyxl
                wb = openpyxl.load_workbook(io.BytesIO(content_bytes), read_only=True, data_only=True)
                for ws in wb.worksheets:
                    text += "## Sheet: " + (ws.title or "Sheet") + "\n"
                    for row in ws.iter_rows(max_row=100, values_only=True):
                        cells = [str(c) if c is not None else "" for c in row]
                        if any(cells):
                            text += " | ".join(cells) + "\n"
                    text += "\n"
                wb.close()
            except ImportError:
                text = "[Excel 解析失败：缺少 openpyxl 库]"
        elif ext == "xls":
            text = "[不支持 .xls 旧格式，请用 Excel 另存为 .xlsx 后重新上传]"
        elif ext == "pdf":
            try:
                import io
                try:
                    import pdfplumber
                    with pdfplumber.open(io.BytesIO(content_bytes)) as pdf:
                        for i, page in enumerate(pdf.pages[:50]):
                            page_text = page.extract_text() or ""
                            if page_text:
                                text += page_text + "\n"
                            tables = page.extract_tables()
                            for table in tables:
                                for row in table:
                                    cells = [str(c) if c else "" for c in row]
                                    if any(cells):
                                        text += " | ".join(cells) + "\n"
                                text += "\n"
                            if page_text or tables:
                                text += "\n"
                except ImportError:
                    from pypdf import PdfReader
                    pdf = PdfReader(io.BytesIO(content_bytes))
                    for page in pdf.pages[:50]:
                        page_text = page.extract_text()
                        if page_text:
                            text += page_text + "\n\n"
            except ImportError:
                text = "[PDF 解析失败：缺少 pdfplumber 或 pypdf 库]"
        else:
            text = "[不支持的文件格式: ." + ext + "]"
    except Exception as e:
        text = "[文件解析出错: " + str(e) + "]"
    finally:
        # P1-A1: 清理 docx 临时文件
        if _docx_tmp_path and os.path.exists(_docx_tmp_path):
            try:
                os.remove(_docx_tmp_path)
            except OSError:
                pass

    if len(text) > 100000:
        text = text[:100000] + "\n\n... [文件内容过长，已截断至前100K字符]"

    return {"ok": True, "content": text, "filename": file.filename, "size": len(content_bytes)}


@router.post("/api/qa/ask")
async def api_qa_ask(request: Request):
    """问答 Tab：基于文件内容回答问题"""
    mgr = get_mgr()
    body = await request.json()
    question = body.get("question", "").strip()
    file_content = body.get("file_content", "")
    file_name = body.get("file_name", "文件")

    if not question:
        return JSONResponse({"error": "请输入问题"}, status_code=400)
    if not file_content:
        return JSONResponse({"error": "请先上传文件"}, status_code=400)

    system_msg = "你是一个文件分析助手。基于用户提供的文件内容回答问题。如果文件中没有相关信息，如实说明。回答要简洁准确，必要时引用原文。"
    # P1-A2: 根据模型上下文窗口动态计算截断长度（预留 50% 给其他内容）
    context_window = mgr._get_device_token_limit()
    max_file_chars = int(context_window * 1.5 * 0.5)
    user_msg = "以下是文件「" + file_name + "」的内容：\n\n" + file_content[:max_file_chars] + "\n\n---\n问题：" + question

    try:
        full_msg = (system_msg + "\n\n" + user_msg)[:81000]
        result = mgr.chat(message=full_msg, max_tokens=1500)
        answer = result.get("response", "") if isinstance(result, dict) else str(result)
        return {"answer": answer}
    except Exception as e:
        return JSONResponse({"error": "生成回答失败: " + str(e)}, status_code=500)


# (OCR API 已在 Patch11 移除)

# ============================================================
#  文件上传
# ============================================================

@router.post("/api/file_upload")
async def api_file_upload(file: UploadFile = File(...), chat_id: str = ""):
    """上传文件。

    Patch4 v3.1：如果有 chat_id，存到 data/chats/{chat_id}/workspace/（session 级隔离）。
    没有 chat_id 时降级到全局 UPLOAD_DIR（兼容旧调用）。
    """
    from config import get as _cfg_get
    _UPLOAD_MAX_SIZE = _cfg_get("upload_max_size")
    if not file.filename:
        return JSONResponse({"error": "未选择文件"}, status_code=400)

    safe_name = _safe_filename(file.filename)
    content = await file.read()
    if len(content) > _UPLOAD_MAX_SIZE:
        return JSONResponse({"error": "文件过大（最大50MB）"}, status_code=400)

    # Patch4 v3.1：优先存到 session workspace
    # Patch5 G：彻底废弃 cache/uploads fallback，强制必须有 chat_id
    if chat_id and chat_id.replace(".json", ""):
        _cid = chat_id.replace(".json", "")
        # 安全校验：chat_id 只允许 YYYY-MM-DD_NNN 格式
        if not _is_safe_chat_id(_cid):
            return JSONResponse({"error": "非法 chat_id"}, status_code=400)
        from config import CHAT_DIR
        from session.chat_store import ensure_chat_subdirs
        ensure_chat_subdirs(_cid)
        ws_dir = os.path.join(CHAT_DIR, _cid, "workspace")
        os.makedirs(ws_dir, exist_ok=True)
        save_path = os.path.join(ws_dir, safe_name)
    else:
        # Patch5 G：拒绝无 chat_id 的上传（前端必须先新建会话）
        return JSONResponse({"error": "缺少 chat_id，请先新建会话"}, status_code=400)

    with open(save_path, "wb") as f:
        f.write(content)

    # Patch5 G.一致性：上传即算 token，前端用于预检
    file_tokens = 0
    try:
        from knowledge.file_extractor import process_uploaded_file
        _info = process_uploaded_file(save_path, "", max_chars=10**9)  # 不截断，全量
        if _info.get("status") in ("ok", "truncated"):
            _text = _info.get("text", "")
            # 粗估：中文 1.5字/token，英文 4字/token
            _cn = sum(1 for c in _text if '\u4e00' <= c <= '\u9fff')
            _other = len(_text) - _cn
            file_tokens = int(_cn / 1.5 + _other / 4.0)
    except Exception as _e:
        log.warning("[UPLOAD] token 估算失败: %s", str(_e)[:80])

    return {"path": save_path, "filename": safe_name, "size": len(content),
            "tokens": file_tokens,
            "in_workspace": bool(chat_id)}


# ============================================================
#  蒸馏 API（Patch 9 将删除）
# ============================================================


# ============================================================
#  文档下载 API
# ============================================================

@router.get("/api/doc/download/{filename}")
async def api_doc_download(filename: str):
    """下载 AI 生成的 .docx 文档"""
    # 安全检查：只允许 .docx 文件名
    if not filename.endswith('.docx') or '..' in filename or '/' in filename or '\\' in filename:
        return JSONResponse({"error": "非法文件名"}, status_code=400)

    from config import DOCS_DIR
    doc_path = os.path.join(DOCS_DIR, filename)
    if not os.path.exists(doc_path):
        return JSONResponse({"error": "文件不存在"}, status_code=404)

    from fastapi.responses import FileResponse
    return FileResponse(
        doc_path,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename=filename,
    )


# ============================================================
#  A6 — 上下文圆环（使用量查询）
#  A10 — 云端上下文自动压缩
# ============================================================

def _compress_cloud_history(mgr, history_raw: list, chat_file: str):
    """A10: 用云端模型压缩历史消息，保留最近几轮 + 压缩摘要

    Args:
        mgr: ModelManager 实例
        history_raw: 原始历史消息列表
        chat_file: 当前会话文件路径

    Returns:
        bool: 是否成功压缩
    """
    if not history_raw or len(history_raw) < 6:
        return False

    # 保留最近 3 轮（6 条消息）
    keep_recent = 6
    old_messages = history_raw[:-keep_recent]
    recent_messages = history_raw[-keep_recent:]

    if not old_messages:
        return False

    # 构建压缩 prompt
    old_text_parts = []
    for msg in old_messages:
        role = msg.get("role", "")
        content = msg.get("content", "")
        if role in ("user", "assistant") and content:
            old_text_parts.append("%s: %s" % ("用户" if role == "user" else "助手", content[:300]))

    old_text = "\n".join(old_text_parts)
    if len(old_text) > 4000:
        old_text = old_text[:4000] + "...[截断]"

    compress_prompt = (
        "请将以下对话历史压缩为简洁的摘要（不超过 500 字），保留关键信息和结论：\n\n"
        "---\n%s\n---\n\n"
        "摘要：" % old_text
    )

    try:
        if hasattr(mgr, '_cloud_engine'):
            cloud = mgr._cloud_engine
        else:
            from core.cloud_engine import CloudEngine
            cloud = CloudEngine(mgr)

        # 非流式调用获取压缩结果
        summary_text = ""
        for phase, content in cloud.run(
            compress_prompt,
            override_task_type="text",
            history=[],
        ):
            if phase == "text":
                summary_text += content

        if not summary_text.strip():
            return False

        # 构建压缩后的消息列表
        compressed_messages = [
            {"role": "system", "content": "[历史对话摘要]\n" + summary_text.strip()},
        ] + recent_messages

        # 保存压缩后的会话
        save_chat(chat_file, compressed_messages)
        log.info("[CTX] 云端历史压缩完成: %d条 → %d条 (摘要 %d 字)",
                 len(history_raw), len(compressed_messages), len(summary_text))
        return True

    except Exception as e:
        log.warning("[CTX] 云端压缩失败: %s", str(e)[:100])
        return False

def _calc_context_usage(chat_file: str = None):
    """计算当前会话的上下文使用量

    Returns:
        dict: {"used_tokens", "total_tokens", "percentage", "level"}
              level: "normal"(<60%), "warning"(60-85%), "critical"(>85%)
    """
    from config import get as _cfg_get

    ai_mode = _cfg_get("ai_mode", "local")

    # 获取会话消息
    if not chat_file:
        chat_file = get_current_chat()
    messages = []
    if chat_file:
        try:
            data = load_chat(chat_file)
            if isinstance(data, dict):
                messages = data.get("messages", [])
            elif isinstance(data, list):
                messages = data
        except Exception:
            pass

    # 估算 token 数：优先使用真实 token_stats 的 input_tokens，否则回退 chars/1.5
    total_chars = sum(len(m.get("content", "")) for m in messages)
    used_tokens = 0
    # 尝试从最近的 assistant 消息中获取真实 token 数据
    _last_token_stats = None
    for m in reversed(messages):
        if m.get("role") == "assistant" and m.get("token_stats"):
            _last_token_stats = m["token_stats"]
            break
    if _last_token_stats and _last_token_stats.get("input_tokens"):
        # 使用真实 input_tokens（包含 system prompt + FC schema + 历史消息的总开销）
        used_tokens = _last_token_stats["input_tokens"]
    else:
        used_tokens = int(total_chars / 1.5)

    # 获取模型上下文窗口大小
    if ai_mode == "cloud":
        # 优先用用户手动配置的上下文窗口
        user_ctx = _cfg_get("cloud_context_window", 0)
        if user_ctx and user_ctx > 0:
            total_tokens = user_ctx
        else:
            try:
                from core.cloud_engine import CloudEngine
                _ce = CloudEngine.__new__(CloudEngine)
                total_tokens = _ce._lookup_capabilities(
                    _cfg_get("cloud_model", "gpt-4o-mini")
                )["context_window"]
            except Exception:
                total_tokens = 32768
    else:
        total_tokens = 16000  # 本地模型固定 16K (num_ctx)

    # 计算百分比和等级
    percentage = round(used_tokens / total_tokens * 100, 1) if total_tokens > 0 else 0
    if percentage > 85:
        level = "critical"
    elif percentage > 60:
        level = "warning"
    else:
        level = "normal"

    return {
        "used_tokens": used_tokens,
        "total_tokens": total_tokens,
        "percentage": percentage,
        "level": level,
    }


@router.get("/api/context/usage")
def api_context_usage(chat_file: Optional[str] = None):
    """获取当前会话上下文使用量"""
    return _calc_context_usage(chat_file)


# ============================================================
#  排队取消 API（Patch 3 LLMScheduler）
# ============================================================

@router.post("/api/scheduler/cancel")
async def api_scheduler_cancel(request: Request):
    """取消排队中的任务"""
    body = await request.json()
    ticket_id = body.get("ticket_id")
    if ticket_id is None:
        return JSONResponse({"error": "缺少 ticket_id"}, status_code=400)
    try:
        import server as _srv
        scheduler = getattr(_srv, '_llm_scheduler', None)
        if not scheduler:
            return JSONResponse({"error": "调度器未初始化"}, status_code=503)
        cancelled = scheduler.cancel(int(ticket_id))
        return {"ok": cancelled, "ticket_id": ticket_id}
    except Exception as e:
        return JSONResponse({"error": str(e)[:100]}, status_code=500)


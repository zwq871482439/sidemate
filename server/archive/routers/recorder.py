# -*- coding: utf-8 -*-
"""
routers/recorder.py — 录音纪要 Router

端点前缀 /api/recorder：
  GET  /api/recorder/whisper/status       — Whisper状态
  POST /api/recorder/whisper/load         — 加载Whisper
  POST /api/recorder/whisper/unload       — 卸载Whisper
  POST /api/recorder/start                — 开始录音
  POST /api/recorder/chunk                — 上传音频块
  POST /api/recorder/finish               — 结束录音
  POST /api/recorder/import               — 导入音频
  GET  /api/recorder/locked               — 是否锁定
  GET  /api/recorder/sessions             — 历史录音
  GET  /api/recorder/{session_id}/status  — 转写进度
  GET  /api/recorder/{session_id}/transcript — 获取转写稿
  GET  /api/recorder/{session_id}/rough   — 获取粗稿
  GET  /api/recorder/{session_id}/segments — 时间戳段落
  GET  /api/recorder/{session_id}/audio   — 播放录音
  PUT  /api/recorder/{session_id}/transcript — 更新转写稿
  POST /api/recorder/{session_id}/summarize — AI纪要
  POST /api/recorder/{session_id}/import_kb  — 导入KB
  POST /api/recorder/{session_id}/pause   — 暂停
  POST /api/recorder/{session_id}/resume  — 恢复
  POST /api/recorder/{session_id}/cancel  — 取消
  DELETE /api/recorder/{session_id}       — 删除
  GET  /api/recorder/storage              — 空间统计
  POST /api/recorder/recover              — 崩溃恢复
  POST /api/recorder/live-transcribe      — 实时转写
  POST /api/recorder/{session_id}/refine  — 纠错润色
"""
import os
import logging
from typing import Optional

from fastapi import APIRouter, UploadFile, File, Request
from fastapi.responses import JSONResponse, FileResponse

from routers.deps import get_mgr, get_kb, get_recorder, get_log

router = APIRouter()
log = get_log()


# ============================================================
#  扩展可用性检查
# ============================================================

def _get_extensions_dir() -> str:
    """获取扩展注册目录"""
    from config import EXTENSIONS_DIR
    return EXTENSIONS_DIR


def _check_recorder_extension() -> Optional[JSONResponse]:
    """检查纪要扩展是否已安装，未安装时返回错误响应

    Returns:
        None 如果已安装，否则返回 JSONResponse 错误
    """
    try:
        from core.extension_manager import ExtensionRegistry
        registry = ExtensionRegistry(_get_extensions_dir())
        if not registry.is_installed("recorder"):
            return JSONResponse(
                {"error": "纪要扩展未安装，请导入 sidemate-extension-recorder-*.sidemate 包"},
                status_code=503
            )
    except Exception as e:
        log.warning("[RECORDER] 扩展检查失败: %s", str(e)[:80])
    return None


@router.get("/api/recorder/whisper/status")
def api_recorder_whisper_status():
    """检查Whisper状态（二态：installed + ready）"""
    recorder = get_recorder()
    ws = recorder.get_whisper_status()
    return {
        "installed": ws.get("installed", False),
        "ready": ws.get("status") == "ready",
        "model_name": ws.get("model_name"),
        "model_size_mb": ws.get("model_size_mb", 0),
        "mem_mb": ws.get("mem_mb", 0),
    }


@router.post("/api/recorder/whisper/load")
async def api_recorder_whisper_load():
    """加载Whisper模型到CPU内存（后台异步）"""
    ext_check = _check_recorder_extension()
    if ext_check is not None:
        return ext_check
    recorder = get_recorder()

    # 已加载 / 正在加载 → 立即返回
    ws = recorder.get_whisper_status()
    if ws.get("loaded"):
        return {"ok": True, "msg": "Whisper 已加载", "mem_mb": ws.get("mem_mb", 0)}
    if getattr(recorder, "_whisper_loading", False):
        return {"ok": True, "loading": True}

    recorder._whisper_loading = True

    def _do_load():
        try:
            result = recorder.load_whisper()
            if result.get("error"):
                log.error("[RECORDER] Whisper 加载失败: %s", result["error"])
        except Exception as e:
            log.error("[RECORDER] Whisper 加载异常: %s", str(e)[:200])
        finally:
            recorder._whisper_loading = False

    import threading
    threading.Thread(target=_do_load, daemon=True).start()
    log.info("[RECORDER] Whisper 加载已启动（后台线程）")
    return {"ok": True, "loading": True}


@router.post("/api/recorder/whisper/unload")
async def api_recorder_whisper_unload():
    """释放模型内存"""
    recorder = get_recorder()
    return recorder.unload_whisper()


@router.post("/api/recorder/start")
async def api_recorder_start():
    """开始录音会话"""
    recorder = get_recorder()
    return recorder.start_session()


@router.post("/api/recorder/chunk")
async def api_recorder_chunk(request: Request):
    """上传音频块（实时落盘）"""
    recorder = get_recorder()
    body = await request.body()
    session_id = request.query_params.get("session_id", "")
    if not session_id:
        return JSONResponse({"error": "缺少 session_id"}, status_code=400)
    return recorder.append_chunk(session_id, body)


@router.post("/api/recorder/finish")
async def api_recorder_finish(request: Request):
    """结束录音，触发转写"""
    ext_check = _check_recorder_extension()
    if ext_check is not None:
        return ext_check
    recorder = get_recorder()
    mgr = get_mgr()
    body = await request.json()
    session_id = body.get("session_id", "")
    if not session_id:
        return JSONResponse({"error": "缺少 session_id"}, status_code=400)

    result = recorder.finish_session(session_id)
    if "error" in result:
        return JSONResponse(result, status_code=400)

    # P1-09: 如果 Whisper 尚未加载，标记待转写，加载后自动触发
    if recorder._whisper_loaded:
        recorder.start_transcription(session_id, mgr)
    else:
        recorder._pending_transcriptions = getattr(recorder, '_pending_transcriptions', [])
        recorder._pending_transcriptions.append(session_id)

    return result


@router.post("/api/recorder/import")
async def api_recorder_import(file: UploadFile = File(...)):
    """导入已有音频文件（mp3/wav/m4a/webm）"""
    ext_check = _check_recorder_extension()
    if ext_check is not None:
        return ext_check
    recorder = get_recorder()
    mgr = get_mgr()
    if not file.filename:
        return JSONResponse({"error": "未选择文件"}, status_code=400)

    content = await file.read()
    if len(content) > 52428800:
        return JSONResponse({"error": "文件过大（最大50MB）"}, status_code=400)

    ext = (file.filename or "").rsplit(".", 1)[-1].lower()
    if ext not in ("mp3", "wav", "m4a", "webm", "ogg", "flac"):
        return JSONResponse({"error": "不支持的音频格式: ." + ext}, status_code=400)

    result = recorder.import_audio(file.filename, content)
    if "error" in result:
        return JSONResponse(result, status_code=400)

    if recorder._whisper_loaded:
        recorder.start_transcription(result["session_id"], mgr)

    return result


@router.get("/api/recorder/locked")
def api_recorder_locked():
    """对话Tab是否锁定"""
    recorder = get_recorder()
    return {"locked": recorder.is_transcribing()}


@router.get("/api/recorder/sessions")
def api_recorder_sessions():
    """历史录音列表"""
    recorder = get_recorder()
    return {"sessions": recorder.get_sessions(), "storage": recorder.get_storage_usage()}


@router.get("/api/recorder/{session_id}/status")
def api_recorder_session_status(session_id: str):
    """查询转写进度"""
    recorder = get_recorder()
    data = recorder.get_session(session_id)
    if not data:
        return JSONResponse({"error": "会话不存在"}, status_code=404)
    return data


@router.get("/api/recorder/{session_id}/transcript")
def api_recorder_transcript(session_id: str):
    """获取最终转写原文（纠错后）"""
    recorder = get_recorder()
    return recorder.get_transcript(session_id)


@router.get("/api/recorder/{session_id}/rough")
def api_recorder_rough(session_id: str):
    """获取原始粗稿"""
    recorder = get_recorder()
    return recorder.get_rough_draft(session_id)


@router.get("/api/recorder/{session_id}/segments")
def api_recorder_segments(session_id: str):
    """获取转写时间戳段落数据"""
    recorder = get_recorder()
    data = recorder.get_session(session_id)
    if not data:
        return JSONResponse({"error": "会话不存在"}, status_code=404)
    segments = data.get("segments") or []
    return {"ok": True, "segments": segments}


@router.get("/api/recorder/{session_id}/audio")
def api_recorder_audio(session_id: str):
    """播放录音文件"""
    recorder = get_recorder()
    session = recorder.get_session(session_id)
    if not session:
        return JSONResponse({"error": "会话不存在"}, status_code=404)
    audio_path = session.get("audio_path")
    if not audio_path or not os.path.exists(audio_path):
        return JSONResponse({"error": "音频文件不存在"}, status_code=404)
    return FileResponse(audio_path, media_type="audio/webm", filename=session_id + ".webm")


@router.put("/api/recorder/{session_id}/transcript")
async def api_recorder_update_transcript(session_id: str, request: Request):
    """更新转写稿（用户编辑后保存）"""
    recorder = get_recorder()
    body = await request.json()
    text = body.get("text", "")
    if not text.strip():
        return JSONResponse({"error": "文本内容为空"}, status_code=400)
    return recorder.update_transcript(session_id, text)


@router.post("/api/recorder/{session_id}/summarize")
async def api_recorder_summarize(session_id: str):
    """生成AI会议纪要"""
    mgr = get_mgr()
    recorder = get_recorder()
    loaded = mgr.get_loaded_llms()
    if not loaded:
        return {"error": "请先在「设置」页面加载 AI 模型，生成纪要需要模型支持"}
    return recorder.summarize(session_id, mgr)


@router.post("/api/recorder/{session_id}/import_kb")
async def api_recorder_import_kb(session_id: str):
    """转写稿导入文库"""
    recorder = get_recorder()
    kb = get_kb()
    return recorder.import_to_kb(session_id, kb)


@router.post("/api/recorder/{session_id}/pause")
def api_recorder_pause(session_id: str):
    """暂停处理"""
    recorder = get_recorder()
    return recorder.pause_processing(session_id)


@router.post("/api/recorder/{session_id}/resume")
async def api_recorder_resume(session_id: str):
    """恢复处理"""
    recorder = get_recorder()
    mgr = get_mgr()
    return recorder.resume_processing(session_id, mgr)


@router.post("/api/recorder/{session_id}/cancel")
def api_recorder_cancel(session_id: str):
    """取消处理"""
    recorder = get_recorder()
    return recorder.cancel_processing(session_id)


@router.delete("/api/recorder/{session_id}")
def api_recorder_delete(session_id: str):
    """删除录音session"""
    recorder = get_recorder()
    return recorder.delete_session(session_id)


@router.get("/api/recorder/storage")
def api_recorder_storage():
    """录音空间占用统计"""
    recorder = get_recorder()
    return recorder.get_storage_usage()


@router.post("/api/recorder/recover")
def api_recorder_recover():
    """手动触发崩溃恢复"""
    recorder = get_recorder()
    return recorder.recover_sessions()


@router.post("/api/recorder/live-transcribe")
async def api_recorder_live_transcribe(session_id: str, request: Request):
    """实时转写端点"""
    ext_check = _check_recorder_extension()
    if ext_check is not None:
        return ext_check
    recorder = get_recorder()
    if not recorder._whisper_loaded:
        return {"ok": False, "error": "Whisper 模型未加载"}
    audio_bytes = await request.body()
    if len(audio_bytes) < 500:
        return {"ok": True, "text": ""}
    return recorder.live_transcribe(audio_bytes)


@router.post("/api/recorder/{session_id}/refine")
def api_recorder_refine(session_id: str):
    """手动触发 8B 纠错润色"""
    ext_check = _check_recorder_extension()
    if ext_check is not None:
        return ext_check
    recorder = get_recorder()
    mgr = get_mgr()
    # Bug 6 fix: use get_loaded_llms() instead of _mm.manager (which doesn't exist)
    loaded_llms = mgr.get_loaded_llms()
    if not loaded_llms:
        return {"error": "8B 模型未加载，请先在设置中加载模型"}
    return recorder.refine_transcript(session_id, mgr)

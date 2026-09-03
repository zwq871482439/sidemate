# -*- coding: utf-8 -*-
"""管道注册 + 路由"""
from pipelines._base import StreamContext
from typing import Generator


def create_pipeline(ctx: StreamContext) -> Generator[str, None, None]:
    """根据 ctx.ai_mode 路由到对应管道

    Args:
        ctx: StreamContext 数据类实例

    Returns:
        Generator[str, None, None] — SSE 事件字符串生成器
    """
    # Patch3: 文库对比模式
    if getattr(ctx, 'is_kb_compare', False):
        from pipelines.compare_pipeline import run_compare_pipeline
        return run_compare_pipeline(ctx)

    # P6: 并行模式
    if ctx.ai_mode == "parallel":
        from pipelines.parallel_pipeline import run_parallel_pipeline
        return run_parallel_pipeline(ctx)

    if ctx.ai_mode == "cloud":
        from pipelines.cloud_pipeline import run_cloud_pipeline
        return run_cloud_pipeline(ctx)
    else:
        from pipelines.local_pipeline import run_local_pipeline
        return run_local_pipeline(ctx)


def run_text_once(prompt: str, ai_mode: str) -> str:
    """按模式选引擎做一次性文本生成（非流式小任务：交接/命名等）。

    模式分支集中于此（工厂同位，CI 白名单口径）；调用方只传 prompt 拿文本。
    """
    from routers.deps import get_mgr
    mgr = get_mgr()
    parts = []
    if ai_mode == "cloud":
        from core.cloud_engine import CloudEngine
        engine = CloudEngine(mgr)
        for phase, content in engine.run(prompt, _skip_queue=True):
            if phase == "text":
                parts.append(content)
    else:
        from core.stream_engine import StreamEngine
        engine = StreamEngine(mgr)
        for phase, content in engine.run(prompt):
            if phase == "text":
                parts.append(content)
    return "".join(parts).strip()


def can_generate_handoff(ai_mode: str, manual: bool) -> bool:
    """交接生成门禁（PLAN ②++ 隐私铁律）：离线会话只允许用户手动触发。

    模式比较集中在工厂（CI 白名单口径），路由只问结果不做比较。
    """
    if ai_mode == "local" and not manual:
        return False
    return True


def auto_name_if_default(chat_name: str, user_text: str, ai_mode: str) -> None:
    """首条消息后静默自动命名（PLAN 五点七-1 延迟归属①，M1-E）。

    触发条件：meta.title 仍是文件夹名（=从未命名过）且本轮有真实用户文本。
    引擎分模式：离线/并行=本地小模型（内容不出机，隐私铁律），在线=云端。
    只写 meta.title 显示名，文件夹名/路径不动（手动重命名仍走 rename_chat，
    后者会同步 meta.title）。任何失败静默跳过——命名是锦上添花，绝不能影响主流程。
    """
    import re as _re
    try:
        from session import chat_store
        meta = chat_store.read_meta(chat_name)
        if not meta or (meta.get("title") or chat_name) != chat_name:
            return  # 已命名过（自动或手动）
        text = (user_text or "").strip()
        if not text or text.startswith("["):  # doc_continue 等占位消息不命名
            return
        prompt = (
            "为下面的用户消息生成一个简短的中文会话标题。要求：6-14 个字，概括主题，"
            "不要标点收尾，不要引号书名号，只输出标题本身。\n\n用户消息：\n" + text[:300]
        )
        title = run_text_once(prompt, ai_mode)
        # 清洗：取首行、去首尾引号/书名号/标点、限长
        title = (title or "").splitlines()[0].strip() if title else ""
        title = _re.sub(r"^[\"'《<「『]+|[\"'》>」』。！？!?.:：,，;；\s]+$", "", title).strip()
        if not title or len(title) < 2:
            return
        chat_store.set_chat_title(chat_name, title[:20])
    except Exception:
        pass

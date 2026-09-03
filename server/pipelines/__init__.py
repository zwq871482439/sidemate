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

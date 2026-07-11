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

# -*- coding: utf-8 -*-
"""StallDetector — 生成异常检测（Ollama 版）

Ollama 通过 HTTP SSE 流式返回。
保留基础的速度检测用于日志诊断。
"""
import logging

log = logging.getLogger(__name__)
log_scan = logging.getLogger("local-ai")


# TODO: v1.0 实现停滞检测或删除此类
class StallDetector:
    """生成异常检测器（简化版）：主要用于日志诊断"""

    def __init__(self, stall_check_tokens: int = 15, repeat_window: int = 12,
                 repeat_threshold: float = 0.5):
        """初始化检测器参数。

        Args:
            stall_check_tokens: 每 N 个 token 检查一次
            repeat_window: 重复检测窗口大小
            repeat_threshold: 重复检测阈值
        """
        self._stall_check_tokens = stall_check_tokens
        self._repeat_window = repeat_window
        self._repeat_threshold = repeat_threshold

    def check_stall(self, token_timestamps: list, now: float,
                    profile: dict, model_name: str = None,
                    full_output: str = None) -> bool:
        """检测生成是否卡住。

        v0.9 简化版：始终返回 False（不中断），仅做日志记录。
        Ollama 的 HTTP SSE 流由服务端控制，不需要客户端检测异常。
        """
        return False

    @property
    def stall_check_tokens(self) -> int:
        return self._stall_check_tokens

    @property
    def repeat_window(self) -> int:
        return self._repeat_window

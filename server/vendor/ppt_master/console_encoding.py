#!/usr/bin/env python3
"""Console encoding helpers for PPT Master CLI scripts.

桌伴 vendor 版改动：去除官方分发身份校验与 transcript 录制
（vendor 抽取场景不适用；MIT 署名保留见 LICENSE-ppt-master），
仅保留 UTF-8 控制台流重配置。
"""

from __future__ import annotations

import io
import sys
from typing import TextIO


def _reconfigure_stream(stream: TextIO) -> TextIO:
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
        return stream
    except AttributeError:
        buffer = getattr(stream, "buffer", None)
        if buffer is None:
            return stream
        return io.TextIOWrapper(buffer, encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        return stream


def configure_utf8_stdio() -> None:
    """Configure CLI streams to UTF-8 (vendor 版：无门禁、无 transcript）。"""
    sys.stdout = _reconfigure_stream(sys.stdout)
    sys.stderr = _reconfigure_stream(sys.stderr)

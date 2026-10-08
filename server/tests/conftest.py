# -*- coding: utf-8 -*-
"""把 server/ 加进 sys.path，让 server/tests 下单个文件可独立运行。

此前全量跑能过，是靠字母序靠前的测试文件（test_anthropic_adapter 等）
先插入了路径；单文件运行则 ModuleNotFoundError: No module named 'session'。
conftest 在收集阶段前执行，在这里统一补齐。
"""
import os
import sys

_SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SERVER_DIR not in sys.path:
    sys.path.insert(0, _SERVER_DIR)

# -*- coding: utf-8 -*-
"""Patch4 DocAgent-Fix v2.1 — 回归测试"""
import sys, os

sys.path.insert(0, 'C:/Sidemate/server')
os.chdir('C:/Sidemate/server')
os.environ['PYTHONNOUSERSITE'] = '1'

failures = []
def check(cond, msg):
    if cond:
        print("OK:", msg)
    else:
        print("FAIL:", msg)
        failures.append(msg)

try:
    # 1. 各模块 import
    from core import agent_loop, agent_tools, cloud_engine
    from pipelines import cloud_pipeline
    from prompts import MERGE_FUSION_PROMPT
    from knowledge import search, ops
    print("OK: 所有模块 import 成功")
    print("    agent_loop / agent_tools / cloud_engine / cloud_pipeline / prompts / knowledge")

    # 2. 修复 3 常量
    check(agent_loop.MAX_ROUNDS == 20, "修复3: MAX_ROUNDS=20")
    check(agent_loop.LOW_ROUNDS_WARN == 5, "修复3: LOW_ROUNDS_WARN=5")
    check(agent_loop.TOOL_LIMITS.get("search_web") == 3 and agent_loop.TOOL_LIMITS.get("fetch_url") == 5,
          "修复3: TOOL_LIMITS search_web=3, fetch_url=5 正确")

    # 3. 修复 8 重试
    check(cloud_engine.MAX_RETRIES == 2, "修复8: cloud_engine.MAX_RETRIES=2")
    check(len(cloud_engine.RETRYABLE_ERRORS) >= 5, "修复8: RETRYABLE_ERRORS 至少 5 项")
    check(callable(cloud_engine._is_retryable), "修复8: _is_retryable 可调用")
    # _is_retryable 行为
    check(cloud_engine._is_retryable(Exception("read operation timed out")) is True,
          "修复8: _is_retryable 识别超时")
    check(cloud_engine._is_retryable(Exception("invalid api key")) is False,
          "修复8: _is_retryable 不误判非重试错误")

    # 4. 修复 6 prompt
    check("本地知识库" in MERGE_FUSION_PROMPT and "为准" in MERGE_FUSION_PROMPT,
          "修复6: MERGE_FUSION_PROMPT 含'本地知识库...为准'")
    check("max" in MERGE_FUSION_PROMPT.lower() and "1.2" in MERGE_FUSION_PROMPT,
          "修复6: 含长度上限 max×1.2")
    check("去重" in MERGE_FUSION_PROMPT, "修复6: 含'去重'")

    # 5. 修复 1 工具注册（Batch 1+2 已交付）
    tools = agent_tools.TOOL_REGISTRY
    for t in ("set_doc_status", "list_workspace", "read_workspace",
              "write_workspace", "delete_workspace"):
        check(t in tools, "工具注册: %s" % t)

    # 6. 修复 4 prompt
    dp = agent_tools._DOC_BASE_PROMPT
    check("工作流" in dp, "修复4: _DOC_BASE_PROMPT 含'工作流'")
    check("工具调用预算" in dp, "修复4: _DOC_BASE_PROMPT 含'工具调用预算'")
    cp = agent_tools._AGENT_BASE_PROMPT
    check("文档生成能力" in cp, "修复4: _AGENT_BASE_PROMPT 含'文档生成能力'")

    # 7. doc_session 模块（Batch 1）— Patch5 重构：DocSession 类已拆为函数式 API
    from core import doc_session
    check(hasattr(doc_session, "append_workspace_file") or hasattr(doc_session, "write_workspace_file"),
          "Batch1: doc_session 工作区函数式 API 存在")

    # 8. 总结
    print()
    if failures:
        print("=== %d 项失败 ===" % len(failures))
        for f in failures:
            print("  -", f)
        sys.exit(1)
    else:
        print("=== 全部 PASS（8 大类检查）===")

except Exception as e:
    import traceback
    traceback.print_exc()
    print("IMPORT FAIL:", e)
    sys.exit(2)

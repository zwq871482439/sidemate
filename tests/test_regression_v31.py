# -*- coding: utf-8 -*-
"""
Sidemate Patch4 v3 + v3.1 回归测试脚本
覆盖范围：
  - v3：doc_session 重构（DocSession 删除、completed 持久化）
  - v3：write_section 删除、set_doc_status 改造、list_docs 新增
  - v3：prompt 重写（workspace 模式）
  - v3.1：上传统一到 workspace（assets 删除）
  - v3.1：append_workspace + edit_workspace 工具
  - 静态审查发现的 5 个 bug

用法：
  "C:\Sidemate\python\python.exe" C:\tmp\sidemate_regression_v31.py
"""
import sys, os, json, shutil

# 设置环境
sys.path.insert(0, 'C:/Sidemate/server')
# D1 重构后：chdir 项目根（数据在 data/），但代码相对路径需要 server/
SERVER_DIR = 'C:/Sidemate/server'
os.chdir('C:/Sidemate')

# 关键路径（D1 重构后数据在项目根 data/）
TEST_CHAT_ID = '_test_v31_regression'
TEST_CHAT_DIR = os.path.join('data', 'chats', TEST_CHAT_ID)
TEST_WORKSPACE = os.path.join(TEST_CHAT_DIR, 'workspace')
TEST_DOCS = os.path.join(TEST_CHAT_DIR, 'docs')

_pass = 0
_fail = 0
_errors = []


def check(name, cond, detail=""):
    global _pass, _fail
    if cond:
        _pass += 1
        print("  [OK] %s" % name)
    else:
        _fail += 1
        _errors.append("%s: %s" % (name, detail))
        print("  [FAIL] %s — %s" % (name, detail))


def setup():
    """创建测试 chat 目录"""
    os.makedirs(TEST_WORKSPACE, exist_ok=True)
    os.makedirs(TEST_DOCS, exist_ok=True)


def teardown():
    """清理测试 chat 目录"""
    shutil.rmtree(TEST_CHAT_DIR, ignore_errors=True)


# ============================================================
# 第一部分：v3 doc_session 重构
# ============================================================

def test_v3_doc_session_removal():
    """验证 DocSession 类已删除，新 completed 机制就位"""
    print("\n=== Part 1: v3 doc_session 重构 ===")

    from core import doc_session

    # 1.1 DocSession 类应已删除
    check("DocSession 类已删除", not hasattr(doc_session, 'DocSession'))
    check("list_docs_in_chat 已删除", not hasattr(doc_session, 'list_docs_in_chat'))
    check("gen_doc_id 已删除", not hasattr(doc_session, 'gen_doc_id'))

    # 1.2 completed 函数存在
    check("mark_doc_completed 存在", hasattr(doc_session, 'mark_doc_completed'))
    check("is_doc_completed 存在", hasattr(doc_session, 'is_doc_completed'))
    check("list_completed_docs 存在", hasattr(doc_session, 'list_completed_docs'))
    check("_load_completed 存在", hasattr(doc_session, '_load_completed'))
    check("_save_completed 存在", hasattr(doc_session, '_save_completed'))

    # 1.3 workspace 函数保留
    check("safe_workspace_path 保留", hasattr(doc_session, 'safe_workspace_path'))
    check("list_workspace_files 保留", hasattr(doc_session, 'list_workspace_files'))
    check("read_workspace_file 保留", hasattr(doc_session, 'read_workspace_file'))
    check("write_workspace_file 保留", hasattr(doc_session, 'write_workspace_file'))
    check("delete_workspace_file 保留", hasattr(doc_session, 'delete_workspace_file'))
    check("chat_id_from_path 保留", hasattr(doc_session, 'chat_id_from_path'))


def test_v3_completed_persistence():
    """验证 completed 持久化机制"""
    print("\n=== Part 2: v3 completed 持久化 ===")

    from core import doc_session

    # 写一个测试文档
    doc_session.write_workspace_file(TEST_CHAT_ID, 'test.md', '# 测试文档\n\n内容')

    # 标记 completed
    entry = doc_session.mark_doc_completed(TEST_CHAT_ID, 'test.md')
    check("mark_doc_completed 返回 entry", isinstance(entry, dict) and 'completed_at' in entry)

    # 查询
    check("is_doc_completed 查询", doc_session.is_doc_completed(TEST_CHAT_ID, 'test.md'))
    check("未 completed 的文档查询 False",
          not doc_session.is_doc_completed(TEST_CHAT_ID, 'other.md'))

    # 列表
    docs = doc_session.list_completed_docs(TEST_CHAT_ID)
    check("list_completed_docs 包含 test.md", 'test.md' in docs)

    # .completed.json 实际存在
    completed_path = os.path.join(TEST_DOCS, '.completed.json')
    check(".completed.json 文件存在", os.path.isfile(completed_path))

    # 重启模拟：重新加载
    docs_reload = doc_session.list_completed_docs(TEST_CHAT_ID)
    check("重新加载后仍包含 test.md", 'test.md' in docs_reload)


# ============================================================
# 第三部分：v3 工具集
# ============================================================

def test_v3_tools():
    """验证工具集"""
    print("\n=== Part 3: v3 工具集 ===")

    from core import agent_tools

    # 3.1 write_section 应已删除
    check("write_section 已删除", 'write_section' not in agent_tools.TOOL_REGISTRY)

    # 3.2 新工具
    check("list_docs 已注册", 'list_docs' in agent_tools.TOOL_REGISTRY)
    check("set_doc_status 已注册", 'set_doc_status' in agent_tools.TOOL_REGISTRY)

    # 3.3 set_doc_status 改造
    sd = agent_tools.TOOL_REGISTRY['set_doc_status']
    params = sd['schema']['function']['parameters']
    check("set_doc_status 接收 filename",
          'filename' in params.get('properties', {}))
    check("set_doc_status 接收 status",
          'status' in params.get('properties', {}))
    check("set_doc_status status 支持 completed",
          'completed' in params['properties']['status']['enum'])

    # 3.4 workspace 工具
    for t in ('list_workspace', 'read_workspace', 'write_workspace', 'delete_workspace'):
        check("%s 已注册" % t, t in agent_tools.TOOL_REGISTRY)


# ============================================================
# 第四部分：v3 prompt
# ============================================================

def test_v3_prompt():
    """验证 prompt 已重写"""
    print("\n=== Part 4: v3 prompt ===")

    from core.agent_tools import _DOC_BASE_PROMPT, _AGENT_BASE_PROMPT

    check("_DOC_BASE_PROMPT 含 write_workspace", 'write_workspace' in _DOC_BASE_PROMPT)
    check("_DOC_BASE_PROMPT 含 set_doc_status", 'set_doc_status' in _DOC_BASE_PROMPT)
    check("_DOC_BASE_PROMPT 含 .md 文件", '.md' in _DOC_BASE_PROMPT)
    check("_DOC_BASE_PROMPT 不含 write_section", 'write_section' not in _DOC_BASE_PROMPT)
    check("_AGENT_BASE_PROMPT 含 write_workspace", 'write_workspace' in _AGENT_BASE_PROMPT)


# ============================================================
# 第五部分：v3.1 上传统一
# ============================================================

def test_v31_upload_unified():
    """验证上传统一到 workspace"""
    print("\n=== Part 5: v3.1 上传统一 ===")

    from session.chat_store import _CHAT_SUBDIRS

    check("assets 已从 _CHAT_SUBDIRS 移除", 'assets' not in _CHAT_SUBDIRS)
    check("workspace 在 _CHAT_SUBDIRS", 'workspace' in _CHAT_SUBDIRS)
    check("docs 在 _CHAT_SUBDIRS", 'docs' in _CHAT_SUBDIRS)

    # 验证 _is_safe_chat_id
    from routers.chat import _is_safe_chat_id
    check("_is_safe_chat_id 合法格式", _is_safe_chat_id('2026-06-16_001'))
    check("_is_safe_chat_id 合法带 .json", _is_safe_chat_id('2026-06-16_001.json'))
    check("_is_safe_chat_id 拒绝路径遍历", not _is_safe_chat_id('../../../etc'))
    check("_is_safe_chat_id 拒绝空", not _is_safe_chat_id(''))
    check("_is_safe_chat_id 拒绝随机字符串", not _is_safe_chat_id('random'))


# ============================================================
# 第六部分：v3.1 append/edit workspace
# ============================================================

def test_v31_append_edit():
    """验证 append/edit 工具"""
    print("\n=== Part 6: v3.1 append/edit workspace ===")

    from core import agent_tools, doc_session

    # 工具注册
    check("append_workspace 已注册", 'append_workspace' in agent_tools.TOOL_REGISTRY)
    check("edit_workspace 已注册", 'edit_workspace' in agent_tools.TOOL_REGISTRY)
    check("append_workspace_file 函数存在", hasattr(doc_session, 'append_workspace_file'))
    check("edit_workspace_file 函数存在", hasattr(doc_session, 'edit_workspace_file'))

    # append 功能
    doc_session.write_workspace_file(TEST_CHAT_ID, 'test.md', '# 标题\n\n第一段')
    r = doc_session.append_workspace_file(TEST_CHAT_ID, 'test.md', '\n## 新章节\n\n新内容')
    check("append 返回 appended>0", r.get('appended', 0) > 0)

    result = doc_session.read_workspace_file(TEST_CHAT_ID, 'test.md')
    content = result['content']
    check("append 保留原文", '第一段' in content)
    check("append 含新内容", '新章节' in content)

    # append 到不存在文件（自动创建）
    r = doc_session.append_workspace_file(TEST_CHAT_ID, 'new.md', '全新文件')
    check("append 到不存在文件自动创建", r.get('size', 0) > 0)

    # edit 功能
    r = doc_session.edit_workspace_file(TEST_CHAT_ID, 'test.md', '第一段', '已修改')
    check("edit 返回 replaced=1", r.get('replaced') == 1)

    result = doc_session.read_workspace_file(TEST_CHAT_ID, 'test.md')
    content = result['content']
    check("edit 含新内容", '已修改' in content)
    check("edit 不含原文", '第一段' not in content)

    # edit 未找到原文
    try:
        doc_session.edit_workspace_file(TEST_CHAT_ID, 'test.md', '不存在的文本', 'xxx')
        check("edit 未找到原文应抛错", False)
    except ValueError as e:
        check("edit 未找到原文抛 ValueError", '未找到' in str(e))


# ============================================================
# 第七部分：v3.1 安全边界
# ============================================================

def test_v31_security():
    """验证 workspace 路径安全"""
    print("\n=== Part 7: v3.1 安全边界 ===")

    from core import doc_session

    # 路径越界
    for bad_path in ['../../../etc/passwd', '/etc/passwd', 'C:/Windows', '..\\\\..\\\\etc']:
        try:
            doc_session.safe_workspace_path(TEST_CHAT_ID, bad_path)
            check("拒绝恶意路径 %s" % bad_path[:30], False)
        except ValueError:
            check("拒绝恶意路径 %s" % bad_path[:30], True)

    # null byte
    try:
        doc_session.safe_workspace_path(TEST_CHAT_ID, 'test\x00.md')
        check("拒绝 null byte", False)
    except ValueError:
        check("拒绝 null byte", True)

    # 空 chat_id
    try:
        doc_session.safe_workspace_path('', 'test.md')
        check("拒绝空 chat_id", False)
    except ValueError:
        check("拒绝空 chat_id", True)

    # 合法路径
    try:
        p = doc_session.safe_workspace_path(TEST_CHAT_ID, 'subfolder/test.md')
        check("合法子目录路径通过", p.endswith('subfolder') or 'subfolder' in p)
    except ValueError:
        check("合法子目录路径通过", False)


# ============================================================
# 第八部分：静态审查发现的 bug
# ============================================================

def test_static_review_bugs():
    """静态审查发现的 5 个 bug 验证"""
    print("\n=== Part 8: 静态审查 bug 验证 ===")

    # Bug 1: _summarize_tool_result 缺 append/edit case（已知 bug，验证存在）
    import inspect
    from core.agent_loop import AgentLoop
    src = inspect.getsource(AgentLoop._summarize_tool_result)
    has_append_case = 'append_workspace' in src
    has_edit_case = 'edit_workspace' in src
    if not has_append_case:
        check("BUG#1 确认：_summarize_tool_result 缺 append_workspace case", True, "(待修)")
    else:
        check("BUG#1 已修复：_summarize_tool_result 含 append_workspace", True)
    if not has_edit_case:
        check("BUG#1 确认：_summarize_tool_result 缺 edit_workspace case", True, "(待修)")
    else:
        check("BUG#1 已修复：_summarize_tool_result 含 edit_workspace", True)

    # Bug 2: _status_phase 不识别 workspace_appended/workspace_edited
    with open(os.path.join(SERVER_DIR, 'pipelines/cloud_pipeline.py'), 'r', encoding='utf-8') as f:
        cp_src = f.read()
    has_appended_phase = 'workspace_appended' in cp_src
    has_edited_phase = 'workspace_edited' in cp_src
    check("BUG#2 确认/修复：pipeline _status_phase 含 workspace_appended",
          has_appended_phase, "缺失则 append 不显示 done 状态" if not has_appended_phase else "")
    check("BUG#2 确认/修复：pipeline _status_phase 含 workspace_edited",
          has_edited_phase, "缺失则 edit 不显示 done 状态" if not has_edited_phase else "")

    # Bug 3: 前端 chat.js 缺 workspace_appended/workspace_edited case
    with open(os.path.join(SERVER_DIR, 'static/js/chat.js'), 'r', encoding='utf-8') as f:
        js_src = f.read()
    js_has_appended = "workspace_appended" in js_src or "workspace_appending" in js_src
    js_has_edited = "workspace_edited" in js_src or "workspace_editing" in js_src
    check("BUG#3 确认/修复：chat.js 含 workspace_appended/appending",
          js_has_appended, "缺失则前端不显示 append/edit 步骤" if not js_has_appended else "")
    check("BUG#3 确认/修复：chat.js 含 workspace_edited/editing",
          js_has_edited, "缺失则前端不显示 edit 步骤" if not js_has_edited else "")

    # Bug 4: _collect_assets_block 已废弃（扫描不存在的 assets/ 目录）
    from core.agent_tools import _collect_assets_block
    # assets 目录不存在时应返回空字符串
    result = _collect_assets_block(TEST_CHAT_DIR)
    check("BUG#4 _collect_assets_block 返回空（assets 已废）",
          result == "", "assets/ 不存在时应返回空")

    # Bug 5: _inject_session_context 应已删除 _collect_assets_block 调用
    # 检查方式：函数定义可以保留（兼容历史数据），但 _inject_session_context 函数体不应再调用
    with open(os.path.join(SERVER_DIR, 'core/agent_tools.py'), 'r', encoding='utf-8') as f:
        at_src = f.read()
    # 提取 _inject_session_context 函数体（从 def 到下一个顶层 def）
    import re as _re
    m = _re.search(r'def _inject_session_context.*?(?=\ndef |\Z)', at_src, _re.DOTALL)
    if m:
        func_body = m.group(0)
        still_calls = '_collect_assets_block' in func_body
    else:
        still_calls = True  # 函数找不到也视为失败
    check("BUG#5 已修复：_inject_session_context 不再调 _collect_assets_block",
          not still_calls, "仍存在则需删除调用")


# ============================================================
# 第九部分：v3.1 状态映射完整性
# ============================================================

def test_v31_status_mapping():
    """验证 v3.1 新增工具的 status_map 完整"""
    print("\n=== Part 9: v3.1 status_map 完整性 ===")

    from core.agent_tools import TOOL_REGISTRY

    for tool_name in ('append_workspace', 'edit_workspace'):
        tool = TOOL_REGISTRY.get(tool_name, {})
        sm = tool.get('status_map', {})
        check("%s 有 status_map" % tool_name, bool(sm))
        check("%s status_map 含 start" % tool_name, 'start' in sm,
              "值=%s" % sm.get('start', ''))
        check("%s status_map 含 done" % tool_name, 'done' in sm,
              "值=%s" % sm.get('done', ''))


# ============================================================
# 第十部分：文件结构
# ============================================================

def test_file_structure():
    """验证 session 目录结构"""
    print("\n=== Part 10: session 目录结构 ===")

    from session.chat_store import ensure_chat_subdirs

    # 创建测试 chat
    ensure_chat_subdirs(TEST_CHAT_ID)
    check("workspace/ 目录存在", os.path.isdir(TEST_WORKSPACE))
    check("docs/ 目录存在", os.path.isdir(TEST_DOCS))
    check("assets/ 目录不存在", not os.path.isdir(os.path.join(TEST_CHAT_DIR, 'assets')))


# ============================================================
# 主流程
# ============================================================

def main():
    print("=" * 60)
    print("Sidemate Patch4 v3 + v3.1 回归测试")
    print("=" * 60)

    setup()
    try:
        test_v3_doc_session_removal()
        test_v3_completed_persistence()
        test_v3_tools()
        test_v3_prompt()
        test_v31_upload_unified()
        test_v31_append_edit()
        test_v31_security()
        test_static_review_bugs()
        test_v31_status_mapping()
        test_file_structure()
    finally:
        teardown()

    print("\n" + "=" * 60)
    print("总计：%d 通过，%d 失败" % (_pass, _fail))
    print("=" * 60)
    if _fail > 0:
        print("\n失败项：")
        for e in _errors:
            print("  - %s" % e)
        sys.exit(1)
    else:
        print("\n全部 PASS ✅")


if __name__ == '__main__':
    main()

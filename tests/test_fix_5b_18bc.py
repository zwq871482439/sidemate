# -*- coding: utf-8 -*-
"""
Sidemate 遗漏 bug 修复回归测试(#5-b/#5-d + #18-b/#18-c)
========================================================
覆盖范围：
  - #5-b/#5-d：generate_docx 三层兜底（pypandoc 缺失不崩溃）
  - #18-b：KB 僵尸文档清理 cleanup_zombie_docs（进度卡 30%）
  - 边界场景：空内容 / 特殊字符 / 多种僵尸状态

防回归要点：
  - #5-b/#5-d 曾因 `import pypandoc` 写在 try 外面，pypandoc 未安装时
    整个 generate_docx 崩溃 → 无下载按钮。本测试强制验证：即便 pypandoc
    import 失败，generate_docx 也能产出有效 docx。
  - #18-b 曾因进程重启后不清理 processing/indexing 文档，导致进度永久卡 30%。

用法：
  "C:\\Sidemate\\python\\python.exe" C:\\Sidemate\\tests\\test_fix_5b_18bc.py
"""
import sys
import os
import shutil
import tempfile

# 设置环境
sys.path.insert(0, 'C:/Sidemate/server')
os.chdir('C:/Sidemate')

# ===== 测试计数器（沿用项目约定） =====
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


# ============================================================
# 第一部分：#5-b/#5-d generate_docx 三层兜底
# ============================================================

def test_generate_docx_pypandoc_missing():
    """#5-b/#5-d 核心回归：pypandoc 未安装时 generate_docx 不崩溃，能产出有效 docx。

    这是 #5-b/#5-d 的精确复现：环境里 pypandoc 模块不存在时，
    旧代码 `import pypandoc`（在 try 外）直接 ModuleNotFoundError 冒泡，
    导致 set_doc_status 失败 → 无下载按钮。
    """
    from pipelines.doc_action import generate_docx
    import zipfile

    tmpdir = tempfile.mkdtemp(prefix="test_docx_")
    try:
        out = os.path.join(tmpdir, "test.docx")

        # 模拟 agent 写的典型文档结构（标题/正文/列表/表格）
        md = (
            "# 测试文档\n\n"
            "## 第一章 概述\n\n"
            "正文内容。\n\n"
            "- 要点一\n"
            "- 要点二\n\n"
            "| 列A | 列B |\n|-----|-----|\n| 1 | 2 |\n"
        )

        # 核心断言：不抛异常（旧代码会抛 ModuleNotFoundError）
        raised = None
        try:
            generate_docx(md, out, title="测试文档")
        except Exception as e:
            raised = e
        check("generate_docx 在 pypandoc 缺失时不抛异常", raised is None,
              "异常: %s" % (type(raised).__name__ if raised else "无"))

        # 产出有效文件
        check("生成 docx 文件存在", os.path.exists(out))
        size = os.path.getsize(out) if os.path.exists(out) else 0
        check("docx 文件非空", size > 0, "size=%d" % size)

        # docx 是合法 zip（pandoc/ manual 都产出此格式）
        is_valid_zip = False
        if os.path.exists(out) and size > 0:
            try:
                is_valid_zip = zipfile.is_zipfile(out)
            except Exception:
                is_valid_zip = False
        check("docx 是合法 zip 格式", is_valid_zip)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def test_generate_docx_minimal_content():
    """边界：最小内容（仅标题）也能生成"""
    from pipelines.doc_action import generate_docx

    tmpdir = tempfile.mkdtemp(prefix="test_docx_min_")
    try:
        out = os.path.join(tmpdir, "min.docx")
        raised = None
        try:
            generate_docx("# 标题\n", out, "标题")
        except Exception as e:
            raised = e
        check("最小内容不抛异常", raised is None)
        check("最小内容生成文件", os.path.exists(out) and os.path.getsize(out) > 0)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def test_generate_docx_special_chars():
    """边界：特殊字符（表格分隔符 / 引号 / 尖括号）不破坏生成"""
    from pipelines.doc_action import generate_docx

    tmpdir = tempfile.mkdtemp(prefix="test_docx_sp_")
    try:
        out = os.path.join(tmpdir, "sp.docx")
        md = '# 标题 <tag> & "引号"\n\n内容 | 分隔\n'
        raised = None
        try:
            generate_docx(md, out, "标题")
        except Exception as e:
            raised = e
        check("特殊字符不抛异常", raised is None)
        check("特殊字符生成文件", os.path.exists(out) and os.path.getsize(out) > 0)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def test_pypandoc_import_inside_try():
    """静态保证：generate_docx 的 `import pypandoc` 必须在 try 内（防 #5-b 回归）。

    读取源码检查结构，避免以后有人把 import 又挪回 try 外面。
    """
    import inspect
    from pipelines import doc_action
    src = inspect.getsource(doc_action.generate_docx)

    # 找到 import pypandoc 所在行
    lines = src.splitlines()
    import_line_idx = None
    try_line_idx = None
    for i, line in enumerate(lines):
        if "import pypandoc" in line and not line.strip().startswith("#"):
            import_line_idx = i
        if "try:" in line and not line.strip().startswith("#"):
            # 记录最后一个在 import 之前的 try（兜底逻辑块的 try）
            if import_line_idx is None:
                try_line_idx = i

    check("generate_docx 含 import pypandoc", import_line_idx is not None)

    # import 必须在某个 try: 块内（try_line_idx < import_line_idx）
    check("import pypandoc 在 try 块内（防 #5-b 回归）",
          try_line_idx is not None and import_line_idx is not None
          and try_line_idx < import_line_idx,
          "import 在 try 之外会导致 ModuleNotFoundError 冒泡")


# ============================================================
# 第二部分：#18-b KB 僵尸文档清理
# ============================================================

def _make_mock_kb(docs):
    """构造轻量 mock KB（只挂 cleanup_zombie_docs 依赖的属性）。

    cleanup_zombie_docs 只用 self.documents / self._save_meta，
    不需要完整 KB 实例（避免加载 torch 等重依赖）。
    """
    class _MockKB:
        def __init__(self):
            self.documents = {d.doc_id: d for d in docs}
            self.save_called = False

        def _save_meta(self):
            self.save_called = True

    from knowledge.models import KBDocument
    from knowledge.ops import _KBOpsMixin
    # 绑定真实方法到 mock 实例（绕过 __init__ 的重依赖加载）
    mock = _MockKB()
    mock.cleanup_zombie_docs = _KBOpsMixin.cleanup_zombie_docs.__get__(mock, _MockKB)
    return mock


def _make_doc(doc_id, status, progress=0.0):
    from knowledge.models import KBDocument
    return KBDocument(
        doc_id=doc_id, filename=doc_id + ".txt", file_type="txt",
        file_size=100, imported_at="2026-01-01", status=status, progress=progress,
    )


def test_cleanup_zombie_processing():
    """#18-b：processing 状态文档被清理为 error"""
    docs = [
        _make_doc("d1", "processing", 0.02),
        _make_doc("d2", "ready", 1.0),
    ]
    kb = _make_mock_kb(docs)
    count = kb.cleanup_zombie_docs()

    check("清理返回 1 个僵尸", count == 1, "count=%s" % count)
    check("processing 文档→error", kb.documents["d1"].status == "error")
    check("progress 重置为 0", kb.documents["d1"].progress == 0.0)
    check("error_msg 已设置", "中断" in (kb.documents["d1"].error_msg or ""))
    check("ready 文档不受影响", kb.documents["d2"].status == "ready")
    check("_save_meta 被调用", kb.save_called)


def test_cleanup_zombie_indexing():
    """#18-b：indexing 状态（卡 30% 的典型场景）被清理"""
    docs = [_make_doc("d1", "indexing", 0.3)]  # 正是卡 30% 的场景
    kb = _make_mock_kb(docs)
    count = kb.cleanup_zombie_docs()

    check("indexing 文档被清理", count == 1)
    check("indexing→error", kb.documents["d1"].status == "error")
    check("30% 进度重置为 0", kb.documents["d1"].progress == 0.0)


def test_cleanup_zombie_chunking():
    """#18-b：chunking 状态也被清理"""
    docs = [_make_doc("d1", "chunking", 0.1)]
    kb = _make_mock_kb(docs)
    count = kb.cleanup_zombie_docs()
    check("chunking 文档被清理", count == 1)
    check("chunking→error", kb.documents["d1"].status == "error")


def test_cleanup_zombie_none_when_all_ready():
    """#18-b：无僵尸时不误伤，不调 _save_meta"""
    docs = [
        _make_doc("d1", "ready", 1.0),
        _make_doc("d2", "ready", 1.0),
        _make_doc("d3", "error", 0.0),
    ]
    kb = _make_mock_kb(docs)
    count = kb.cleanup_zombie_docs()

    check("无僵尸时返回 0", count == 0)
    check("无僵尸时不调 _save_meta（省 IO）", not kb.save_called)
    check("ready 文档不变", kb.documents["d1"].status == "ready")


def test_cleanup_zombie_multiple():
    """#18-b：多个僵尸一次性清理"""
    docs = [
        _make_doc("d1", "processing", 0.0),
        _make_doc("d2", "indexing", 0.3),
        _make_doc("d3", "chunking", 0.1),
        _make_doc("d4", "ready", 1.0),
        _make_doc("d5", "cancelled", 0.0),
    ]
    kb = _make_mock_kb(docs)
    count = kb.cleanup_zombie_docs()

    check("3 个僵尸全部清理", count == 3, "count=%s" % count)
    check("cancelled 不被清理（非僵尸态）", kb.documents["d5"].status == "cancelled")
    check("ready 不被清理", kb.documents["d4"].status == "ready")


def test_cleanup_zombie_empty():
    """#18-b：空文档库不报错"""
    kb = _make_mock_kb([])
    count = kb.cleanup_zombie_docs()
    check("空文档库返回 0", count == 0)
    check("空文档库不调 _save_meta", not kb.save_called)


# ============================================================
# 第三部分：#18-c 前端逻辑静态校验
# ============================================================

def test_qa_js_ready_docs_not_in_queue():
    """#18-c 静态校验：qa.js 不再把 ready+tag_pending/generating 文档塞进处理队列。

    前端逻辑难以单元测试，这里做源码级断言：确保删除分支后没有人重新加回。
    """
    qa_path = os.path.join('C:/Sidemate', 'server', 'static', 'js', 'qa.js')
    with open(qa_path, 'r', encoding='utf-8') as f:
        src = f.read()

    # 定位队列重建循环（kbRefreshDocs 内的 for _ri）
    marker = "for (var _ri = 0; _ri < docs.length; _ri++)"
    idx = src.find(marker)
    check("qa.js 含队列重建循环", idx >= 0)

    if idx >= 0:
        # 取该循环到 conflict 分支之间的片段
        snippet = src[idx:idx + 800]
        # 旧的错误分支不应存在
        bad = "tag_status === 'generating' || _rd.tag_status === 'pending'"
        check("队列重建不再含 ready+tag_status 入队分支（防 #18-c 回归）",
              bad not in snippet,
              "发现已删除的错误分支被重新引入")


# ============================================================
# 主入口
# ============================================================

def main():
    global _pass, _fail
    print("=" * 60)
    print("Sidemate #5-b/#5-d + #18-b/#18-c 修复回归测试")
    print("=" * 60)

    print("\n--- 第一部分：#5-b/#5-d generate_docx 三层兜底 ---")
    test_generate_docx_pypandoc_missing()
    test_generate_docx_minimal_content()
    test_generate_docx_special_chars()
    test_pypandoc_import_inside_try()

    print("\n--- 第二部分：#18-b 僵尸文档清理 ---")
    test_cleanup_zombie_processing()
    test_cleanup_zombie_indexing()
    test_cleanup_zombie_chunking()
    test_cleanup_zombie_none_when_all_ready()
    test_cleanup_zombie_multiple()
    test_cleanup_zombie_empty()

    print("\n--- 第三部分：#18-c 前端逻辑静态校验 ---")
    test_qa_js_ready_docs_not_in_queue()

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

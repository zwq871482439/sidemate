# -*- coding: utf-8 -*-
"""
core/file_converter.py — 工作区文件格式转换（format_convert 工具的核心逻辑）

支持的转换路径（仅工作区内文件，绝不碰知识库）：
  md → docx   复用 doc_action.generate_docx
  md → txt    剥离 markdown 标记
  docx → md   python-docx 读段落，重建简易 markdown
  docx → txt  python-docx 读纯文本
  pdf → txt   pdfplumber 提取文本
  txt → md    原样存（纯文本视为 markdown 段落）

不支持的转换（超出范围，工具返回明确错误）：
  docx → pdf / pdf → docx / 任意 → pdf（需要排版引擎，风险高）
"""
import os
import re
import logging

log = logging.getLogger(__name__)

# 支持的格式
SUPPORTED_FORMATS = ("md", "docx", "txt", "pdf")
# 可作为"源"读取的格式（pdf 只能读不能写）
READABLE = {"md", "docx", "txt", "pdf", "html"}
# 可作为"目标"写入的格式（pdf 经 Edge 无头打印直通道支持，见 convert）
WRITABLE = {"md", "docx", "txt", "pdf"}


def _strip_markdown(md_text: str) -> str:
    """把 markdown 剥离成纯文本（去标记，保留文字内容）。"""
    text = md_text
    # 代码块 → 保留内容
    text = re.sub(r"```[^\n]*\n(.*?)```", r"\1", text, flags=re.DOTALL)
    # 行内代码
    text = re.sub(r"`([^`]+)`", r"\1", text)
    # 图片/链接 → 链接文字或 URL
    text = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", text)
    # 加粗/斜体
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"\*([^*]+)\*", r"\1", text)
    text = re.sub(r"__([^_]+)__", r"\1", text)
    # 标题标记
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    # 列表标记
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*\d+\.\s+", "", text, flags=re.MULTILINE)
    # 引用
    text = re.sub(r"^\s*>\s?", "", text, flags=re.MULTILINE)
    # 水平线
    text = re.sub(r"^---+$", "", text, flags=re.MULTILINE)
    return text.strip()


def _read_docx(path: str) -> str:
    """读取 docx，返回 markdown 格式文本（标题/段落/列表简易重建）。"""
    from docx import Document
    doc = Document(path)
    lines = []
    for para in doc.paragraphs:
        text = (para.text or "").strip()
        if not text:
            lines.append("")
            continue
        style = (para.style.name or "").lower() if para.style else ""
        if style.startswith("heading"):
            # Heading 1 → #，Heading 2 → ##
            try:
                level = int(style.replace("heading", "").strip())
            except (ValueError, TypeError):
                level = 1
            level = max(1, min(6, level))
            lines.append("#" * level + " " + text)
        elif style == "list bullet":
            lines.append("- " + text)
        elif style.startswith("list"):
            lines.append("- " + text)
        else:
            lines.append(text)
    # 表格转 markdown
    for table in doc.tables:
        lines.append("")
        rows = table.rows
        if not rows:
            continue
        for ri, row in enumerate(rows):
            cells = [(c.text or "").strip().replace("|", "\\|") for c in row.cells]
            lines.append("| " + " | ".join(cells) + " |")
            if ri == 0:
                lines.append("| " + " | ".join(["---"] * len(cells)) + " |")
        lines.append("")
    return "\n".join(lines).strip()


def _read_pdf(path: str) -> str:
    """读取 pdf，返回纯文本（pdfplumber 提取）。"""
    try:
        import pdfplumber
        texts = []
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages:
                t = page.extract_text() or ""
                texts.append(t)
        return "\n\n".join(texts).strip()
    except ImportError:
        # fallback: pypdf
        from pypdf import PdfReader
        reader = PdfReader(path)
        texts = []
        for page in reader.pages:
            texts.append(page.extract_text() or "")
        return "\n\n".join(texts).strip()


def _write_docx(md_text: str, path: str, title: str = "文档"):
    """md → docx，复用 doc_action.generate_docx。"""
    from pipelines.doc_action import generate_docx
    generate_docx(md_text, path, title=title)


def _edge_path() -> str:
    """定位系统 Edge（Windows 10+ 自带，无头打印 html→pdf 零新增依赖）。"""
    import shutil
    for p in (
        os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(os.environ.get("ProgramFiles", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
        shutil.which("msedge") or "",
    ):
        if p and os.path.exists(p):
            return p
    return ""


def _html_to_pdf(src_html: str, dst_pdf: str) -> dict:
    """P0 #52：html → pdf（Edge 无头打印，保真含图表/样式）。

    LLM 的可视化产物（write_workspace 生成的 HTML 报告）此前无法转 PDF，
    用户「要 PDF」时只能拿到 HTML——补齐交付链最后一环。
    """
    import subprocess
    edge = _edge_path()
    _meta = {"src_format": "html", "dst_format": "pdf",
             "dst_name": os.path.basename(dst_pdf)}
    if not edge:
        return {"ok": False, "error": "未找到 Microsoft Edge，无法打印 PDF（Windows 10+ 自带，请确认安装）", **_meta}
    _profile = None
    try:
        import tempfile as _tf
        from urllib.parse import quote as _urlq
        # 中文/空格路径必须百分号编码——未编码的 file:/// URL Edge 静默打不开（实测）
        url = "file:///" + _urlq(src_html.replace("\\", "/"))
        # 独立 user-data-dir：①避免命令被用户正在运行的 Edge 实例接管（打印不执行）；
        # ②每次独立目录——固定目录一旦损坏/被上次崩溃残留锁定会持续静默失败（实测）
        _profile = _tf.mkdtemp(prefix="sidemate_edge_pdf_")
        import time as _time
        subprocess.run(
            [edge, "--headless", "--disable-gpu", "--no-pdf-header-footer",
             "--user-data-dir=" + _profile,
             "--print-to-pdf=" + dst_pdf, url],
            capture_output=True, timeout=90)
        # Edge 返回 rc=0 后 PDF 仍需 1-2s 异步落盘——立即检查会误判「无输出」（实测竞态）
        for _ in range(40):
            if os.path.exists(dst_pdf) and os.path.getsize(dst_pdf) > 100:
                _rmtree_safe(_profile)
                return {"ok": True, "chars": os.path.getsize(dst_pdf), **_meta}
            _time.sleep(0.3)
        _rmtree_safe(_profile)
        return {"ok": False, "error": "PDF 生成失败（Edge 无输出）", **_meta}
    except Exception as e:
        if _profile:
            _rmtree_safe(_profile)
        return {"ok": False, "error": "PDF 生成失败: %s" % str(e)[:100], **_meta}


def _rmtree_safe(path: str):
    import shutil
    try:
        shutil.rmtree(path, ignore_errors=True)
    except Exception:
        pass


def _md_to_pdf(md_text: str, dst_pdf: str, title: str = "文档") -> dict:
    """md/txt → pdf：包一层极简 HTML（中文字体+基础排版）再走 Edge 打印。

    仅做朴素渲染（保留换行的等宽块）——富排版路径是让 LLM 直接产 HTML 产物
    再转 PDF，这里只兜纯文本类交付。
    """
    import html as _h
    html_doc = ("<!doctype html><html><head><meta charset='utf-8'><style>"
                "body{font-family:'Microsoft YaHei','PingFang SC',sans-serif;"
                "max-width:820px;margin:24px auto;line-height:1.7;color:#222}"
                "pre{white-space:pre-wrap;font-family:'Microsoft YaHei',monospace}"
                "</style></head><body><h2>%s</h2><pre>%s</pre></body></html>"
                % (_h.escape(title), _h.escape(md_text)))
    tmp_html = dst_pdf[:-4] + ".tmp_print.html"
    with open(tmp_html, "w", encoding="utf-8") as f:
        f.write(html_doc)
    r = _html_to_pdf(tmp_html, dst_pdf)
    try:
        os.remove(tmp_html)
    except Exception:
        pass
    # 源头是 md——覆盖 _html_to_pdf 带回的 html 标记（#52：结果提示
    # 「已将 x 转为 None（None→None）」即缺这三个字段）
    r["src_format"] = "md"
    r["dst_format"] = "pdf"
    r["dst_name"] = os.path.basename(dst_pdf)
    return r


def convert(src_path: str, dst_path: str) -> dict:
    """执行格式转换。

    Args:
        src_path: 源文件绝对路径（调用方负责校验在工作区内）
        dst_path: 目标文件绝对路径（调用方负责校验在工作区内）

    Returns:
        {"ok": bool, "src_format": str, "dst_format": str, "chars": int, "error": str}
    """
    if not os.path.exists(src_path):
        return {"ok": False, "error": "源文件不存在: %s" % os.path.basename(src_path)}

    src_ext = os.path.splitext(src_path)[1].lower().lstrip(".")
    dst_ext = os.path.splitext(dst_path)[1].lower().lstrip(".")

    if src_ext not in READABLE:
        return {"ok": False, "error": "不支持的源格式: .%s（支持 %s）" % (src_ext, "/".join(sorted(READABLE)))}
    if dst_ext not in WRITABLE:
        return {"ok": False, "error": "不支持的目标格式: .%s（支持 %s）" % (dst_ext, "/".join(sorted(WRITABLE)))}
    if src_ext == dst_ext and src_path == dst_path:
        return {"ok": False, "error": "源和目标是同一文件"}
    if src_ext == "pdf" and dst_ext != "txt":
        return {"ok": False, "error": "PDF 只能转为 txt（提取文本），不能转为 %s" % dst_ext}

    # P0 #52：PDF 输出直通道（Edge 无头打印）——html 保真直转；md/txt 朴素排版。
    # 不走 md 中间格式（样式/图表保真），docx→pdf 暂不支持（提示走 HTML 产物）
    if dst_ext == "pdf":
        if src_ext == "html":
            return _html_to_pdf(src_path, dst_path)
        if src_ext in ("md", "txt"):
            with open(src_path, "r", encoding="utf-8") as f:
                return _md_to_pdf(f.read(), dst_path,
                                  title=os.path.splitext(os.path.basename(src_path))[0])
        if src_ext == "docx":
            return {"ok": False, "error": "docx 暂不支持直接转 PDF——请让 AI 生成 HTML 报告后再转（保真更好）"}
        return {"ok": False, "error": "该源格式暂不支持转 PDF"}

    try:
        # 1. 读源文件 → 统一的中间 markdown 文本
        if src_ext == "md":
            with open(src_path, "r", encoding="utf-8") as f:
                content_md = f.read()
        elif src_ext == "txt":
            with open(src_path, "r", encoding="utf-8") as f:
                content_md = f.read()  # txt 视为纯文本 markdown
        elif src_ext == "docx":
            content_md = _read_docx(src_path)
        elif src_ext == "pdf":
            content_md = _read_pdf(src_path)
        else:
            return {"ok": False, "error": "未知源格式"}

        # 2. 中间文本 → 目标格式
        os.makedirs(os.path.dirname(dst_path), exist_ok=True)
        if dst_ext == "md":
            with open(dst_path, "w", encoding="utf-8") as f:
                f.write(content_md)
        elif dst_ext == "txt":
            with open(dst_path, "w", encoding="utf-8") as f:
                f.write(_strip_markdown(content_md))
        elif dst_ext == "docx":
            title = os.path.splitext(os.path.basename(dst_path))[0]
            _write_docx(content_md, dst_path, title=title)
        else:
            return {"ok": False, "error": "未知目标格式"}

        chars = len(content_md)
        log.info("[CONVERT] %s → %s (%d字)", src_ext, dst_ext, chars)
        return {
            "ok": True,
            "src_format": src_ext,
            "dst_format": dst_ext,
            "chars": chars,
            "dst_name": os.path.basename(dst_path),
        }
    except Exception as e:
        log.error("[CONVERT] 转换失败 %s→%s: %s", src_ext, dst_ext, str(e)[:150])
        return {"ok": False, "error": "转换失败: %s" % str(e)[:150]}

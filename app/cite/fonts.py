#!/usr/bin/env python3
"""字体整理。壳做，不经模型。

没范本、用户也没提字体字号时整份统一成 Noto Sans SC（等宽的写 Consolas，符号字体不动）；
否则只把 Courier、日文和 Linux 字体这类黑名单换掉。两种模式都把 themeFontLang 的
eastAsia 改成 zh-CN、补 fontTable，让没装 Noto Sans SC 的电脑顶替成雅黑，不掉回宋体。
黑名单要扫到 stylesWithEffects（Word 2010 的样式副本，宏文本样式里也挂着 Courier）；
主题字体表里东亚 / 日文那几格换成当前用的中文字体，明朝、ゴシック不留。
"""
from __future__ import annotations

import os
import re
import unicodedata
from pathlib import Path

from docx import Document
from docx.opc.oxml import serialize_part_xml
from docx.oxml.parser import parse_xml
from lxml import etree

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
NOTO = "Noto Sans SC"
CONSOLAS = "Consolas"
FONT_HINTS = ("字体", "字号", "宋体", "仿宋", "楷体", "黑体", "雅黑", "等线", "方正", "Times", "Arial", "公文")
FONT_ATTRS = ("ascii", "hAnsi", "eastAsia", "cs")
THEME_ATTRS = ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme")
MONO_FONTS = {"consolas", "courier", "courier new", "lucida console"}
SYMBOL_FONTS = {"symbol", "wingdings", "webdings", "segoe ui symbol", "cambria math"}
COURIER_SWAP = {"courier", "courier new"}
JP_FONTS = {
    "ms mincho", "ms pmincho", "ms 明朝", "ms p明朝", "ms gothic", "ms pgothic",
    "ms ui gothic", "ms ゴシック", "ms pゴシック", "yu mincho", "游明朝",
    "yu gothic", "yu gothic ui", "游ゴシック", "meiryo", "meiryo ui", "メイリオ",
}
JP_PREFIXES = ("hiragino", "ヒラギノ")
LINUX_PREFIXES = ("liberation", "dejavu", "wenquanyi", "文泉驿", "droid", "ar pl", "noto sans cjk", "noto serif cjk")
# settings 和 fontTable 里孩子有固定顺序，插错了 Word 会挑刺
SETTINGS_AFTER_LANG = (
    "clrSchemeMapping", "doNotIncludeSubdocsInStats", "doNotAutoCompressPictures", "forceUpgrade",
    "captions", "readModeInkLockDown", "smartTagType", "schemaLibrary", "shapeDefaults",
    "doNotEmbedSmartTags", "decimalSymbol", "listSeparator",
)
FONT_CHILD_ORDER = ("altName", "panose1", "charset", "family", "notTrueType", "pitch", "sig",
                    "embedRegular", "embedBold", "embedItalic", "embedBoldItalic")


def log_line(text: str) -> None:
    # 只记日志不拦人的那种。给人看的是一句中文，库的原文只进日志。
    body = (text or "").strip()
    if not body:
        return
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".local" / "share")
    path = os.environ.get("SIDEMATE_LOG") or str(Path(base) / "sidemate" / "cite.log")
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(body + "\n")
    except OSError:
        pass


def norm_font(name: str) -> str:
    # 全角的ＭＳnormalize成半角才比对得上；只认精确名字或前缀，别用子串：Century Gothic 是正常字体。
    return unicodedata.normalize("NFKC", name or "").strip().lower()


def sweep_name(name: str) -> str:
    low = norm_font(name)
    if not low:
        return ""
    if low in COURIER_SWAP:
        return CONSOLAS
    if low in JP_FONTS or low.startswith(JP_PREFIXES) or low.startswith(LINUX_PREFIXES):
        return NOTO
    return ""


def unify_fonts(utterance: str, has_template: bool) -> bool:
    # 用户说了字体字号、或给了范本，就只扫黑名单，别整份统一。
    if has_template:
        return False
    return not any(hint in (utterance or "") for hint in FONT_HINTS)


def story_part(name: str) -> bool:
    stem = str(name).rsplit("/", 1)[-1]
    if not stem.endswith(".xml"):
        return False
    stem = re.sub(r"\d+$", "", stem[:-4])
    return stem in {"document", "styles", "stylesWithEffects", "numbering", "footnotes", "endnotes", "comments", "header", "footer"}


def theme_part(name: str) -> bool:
    return bool(re.fullmatch(r"theme\d+\.xml", str(name).rsplit("/", 1)[-1]))


def font_values(fonts_el) -> list[str]:
    return [fonts_el.get(f"{W}{key}") or "" for key in FONT_ATTRS]


def rewrite_fonts(fonts_el, unified: bool) -> bool:
    values = [norm_font(value) for value in font_values(fonts_el) if value]
    if any(value in SYMBOL_FONTS for value in values):
        return False
    if unified:
        target = CONSOLAS if any(value in MONO_FONTS for value in values) else NOTO
        for key in THEME_ATTRS:
            fonts_el.attrib.pop(f"{W}{key}", None)
        for key in FONT_ATTRS:
            fonts_el.set(f"{W}{key}", target)
        return True
    changed = False
    for key in FONT_ATTRS:
        swap = sweep_name(fonts_el.get(f"{W}{key}") or "")
        if swap and swap != fonts_el.get(f"{W}{key}"):
            fonts_el.set(f"{W}{key}", swap)
            changed = True
    return changed


def put_child(parent, tag: str, attrs: dict) -> bool:
    # 按字体表/settings 的固定顺序放孩子；已经对的就不动。
    child = parent.find(f"{W}{tag}")
    want = {f"{W}{key}": value for key, value in attrs.items()}
    if child is not None:
        if all(child.get(key) == value for key, value in want.items()):
            return False
        for key, value in want.items():
            child.set(key, value)
        return True
    child = etree.SubElement(parent, f"{W}{tag}", want)
    parent.remove(child)
    order = FONT_CHILD_ORDER if tag in FONT_CHILD_ORDER else (tag,)
    ahead = order[order.index(tag) + 1:] if tag in order else ()
    for node in parent:
        stem = etree.QName(node).localname if isinstance(node.tag, str) else ""
        if stem in ahead:
            index = list(parent).index(node)
            parent.insert(index, child)
            return True
    parent.append(child)
    return True


def tag_run(run_elm, name: str = NOTO) -> bool:
    # 我们写的批注 run 一个 rFonts 都没有，会掉回主题里的日文字体。
    rpr = run_elm.find(f"{W}rPr")
    fresh = False
    if rpr is None:
        rpr = etree.SubElement(run_elm, f"{W}rPr")
        run_elm.remove(rpr)
        run_elm.insert(0, rpr)
        fresh = True
    fonts = rpr.find(f"{W}rFonts")
    if fonts is None:
        fonts = etree.SubElement(rpr, f"{W}rFonts")
        rpr.remove(fonts)
        rstyle = rpr.find(f"{W}rStyle")
        rpr.insert(list(rpr).index(rstyle) + 1 if rstyle is not None else 0, fonts)
        fresh = True
    for key in FONT_ATTRS:
        if fonts.get(f"{W}{key}") != name:
            fonts.set(f"{W}{key}", name)
            fresh = True
    return fresh


def mark_comment(comment) -> None:
    # 批注是核对时写的，那时字体整理已经跑完，只好写的时候就带上。
    for paragraph in comment.paragraphs:
        for run in paragraph.runs:
            tag_run(run._element)


def fix_theme_lang(settings_elm) -> bool:
    node = settings_elm.find(f"{W}themeFontLang")
    if node is None:
        node = etree.SubElement(settings_elm, f"{W}themeFontLang", {f"{W}eastAsia": "zh-CN"})
        settings_elm.remove(node)
        for child in settings_elm:
            stem = etree.QName(child).localname if isinstance(child.tag, str) else ""
            if stem in SETTINGS_AFTER_LANG:
                settings_elm.insert(list(settings_elm).index(child), node)
                return True
        settings_elm.append(node)
        return True
    if node.get(f"{W}eastAsia") == "zh-CN":
        return False
    node.set(f"{W}eastAsia", "zh-CN")
    return True


def fix_font_table(table_elm) -> bool:
    changed = False
    for entry in list(table_elm.findall(f"{W}font")):
        if sweep_name(entry.get(f"{W}name") or ""):
            table_elm.remove(entry)
            changed = True
    entry = next((item for item in table_elm.findall(f"{W}font") if item.get(f"{W}name") == NOTO), None)
    if entry is None:
        entry = etree.SubElement(table_elm, f"{W}font", {f"{W}name": NOTO})
        changed = True
    changed = put_child(entry, "altName", {"val": "微软雅黑"}) or changed
    changed = put_child(entry, "charset", {"val": "86"}) or changed
    changed = put_child(entry, "family", {"val": "swiss"}) or changed
    changed = put_child(entry, "pitch", {"val": "variable"}) or changed
    return changed


def theme_face(face: str, target: str) -> str:
    # 主题表里扫到的黑名单：Courier 一类换 Consolas，日文 / Linux 换当前中文字体。
    swap = sweep_name(face)
    if not swap:
        return ""
    return CONSOLAS if swap == CONSOLAS else target


def fix_theme_group(group, unified: bool) -> bool:
    # 主题字体表只能写 typeface 这一个属性，别的（配色、latin）是范本自己的，不动。
    # 范本的中文字体看这组（major/minor）Hans 那格；没设或不干净就 Noto Sans SC。
    target = NOTO
    if not unified:
        for node in group.findall(f"{A}font"):
            face = node.get("typeface") or ""
            if (node.get("script") or "") == "Hans" and face and not sweep_name(face):
                target = face
                break
    changed = False
    for node in group:
        if not isinstance(node.tag, str):
            continue
        face = node.get("typeface") or ""
        if node.tag == f"{A}ea":
            # 东亚格空着或带了黑名单就补上中文字体，免得 Word 掉到日文那格去。
            swap = target if (unified or not face or sweep_name(face)) else ""
        elif node.tag == f"{A}font" and node.get("script") == "Jpan":
            swap = target if sweep_name(face) else ""
        else:
            swap = theme_face(face, target)
        if swap and swap != face:
            node.set("typeface", swap)
            changed = True
    return changed


def fix_theme_fonts(theme_elm, unified: bool) -> bool:
    changed = False
    for scheme in theme_elm.iter(f"{A}fontScheme"):
        for group in scheme:
            if isinstance(group.tag, str) and group.tag in (f"{A}majorFont", f"{A}minorFont"):
                changed = fix_theme_group(group, unified) or changed
    return changed


def xml_parts(doc: Document) -> list:
    found = []
    for part in doc.part.package.iter_parts():
        live = getattr(part, "_element", None)
        if live is not None:
            found.append({"part": part, "elm": live, "live": True, "dirty": False})
            continue
        blob = part.blob or b""
        if not blob.lstrip().startswith((b"<?xml", b"<")):
            continue
        try:
            elm = parse_xml(blob)
        except Exception:
            continue
        found.append({"part": part, "elm": elm, "live": False, "dirty": False})
    return found


def flush_parts(parts) -> None:
    for item in parts:
        if not item["live"] and item["dirty"]:
            item["part"]._blob = serialize_part_xml(item["elm"])


def tidy_docx(path: Path, utterance: str = "", has_template: bool = False) -> dict:
    unified = unify_fonts(utterance, has_template)
    doc = Document(path)
    parts = xml_parts(doc)
    changed = False
    for item in parts:
        name = str(item["part"].partname)
        elm = item["elm"]
        if story_part(name):
            for fonts_el in list(elm.iter(f"{W}rFonts")):
                if rewrite_fonts(fonts_el, unified):
                    item["dirty"] = True
            if re.sub(r"\d+$", "", name.rsplit("/", 1)[-1][:-4]) == "comments":
                for run_elm in elm.iter(f"{W}r"):
                    rpr = run_elm.find(f"{W}rPr")
                    if rpr is None or rpr.find(f"{W}rFonts") is None:
                        if tag_run(run_elm):
                            item["dirty"] = True
        elif name.endswith("settings.xml"):
            if fix_theme_lang(elm):
                item["dirty"] = True
        elif name.endswith("fontTable.xml"):
            if fix_font_table(elm):
                item["dirty"] = True
        elif theme_part(name):
            if fix_theme_fonts(elm, unified):
                item["dirty"] = True
        if item["dirty"]:
            changed = True
    flush_parts(parts)
    if changed:
        doc.save(path)
    return {"docx": str(path), "mode": "all" if unified else "bad", "changed": changed}

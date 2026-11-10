"""三个技能脚本的最小集成用例；用随包 Python 运行本文件。"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from docx import Document
from docx.oxml.ns import qn
from docx.shared import Pt
from openpyxl import Workbook

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "app" / "skills" / "sidemate-word" / "scripts"


def write_pdf(path, text="Hello PDF"):
    """仅为标准库测试构造一页 PDF，不是技能运行依赖。"""
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    data = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(f"{index} 0 obj\n".encode("ascii") + obj + b"\nendobj\n")
    xref = len(data)
    data.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    data.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        data.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    data.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii"))
    path.write_bytes(data)


class WordScriptsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get("BOXBOX_TMP_DIR") or None)
        self.work = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, name, *args):
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS / name), *map(str, args)],
            cwd=self.work,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def make_template(self):
        path = self.work / "范本.docx"
        doc = Document()
        normal = doc.styles["Normal"]
        normal.font.name = "Microsoft YaHei"
        normal.font.size = Pt(12)
        normal.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), "微软雅黑")
        normal.paragraph_format.line_spacing = 1.5
        normal.paragraph_format.space_after = Pt(8)
        heading = doc.styles["Heading 1"]
        heading.font.size = Pt(17)
        doc.add_heading("第一章", level=1)
        doc.add_paragraph("范本正文")
        doc.save(path)
        return path

    def test_inspect_template(self):
        result = self.run_script("inspect_template.py", self.make_template())
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["sections"][0]["level"], 1)
        self.assertEqual(result["styles"]["body"]["font_size_pt"], 12.0)
        self.assertEqual(result["styles"]["body"]["line_spacing"], {"value": 1.5, "unit": "multiple"})
        self.assertEqual(result["styles"]["headings"]["1"]["font_size_pt"], 17.0)

    def test_compile_docx(self):
        source = self.work / "正文.md"
        source.write_text(
            "# 第一章\n\n正文**加粗**与出处〔S01·p1〕。\n\n## 第二节\n\n### 第三层\n\n"
            "- 列表项\n\n| 项目 | 结论与出处 |\n| --- | --- |\n| 甲 | 通过〔S02·p3〕 |\n",
            encoding="utf-8",
        )
        result = self.run_script(
            "compile_docx.py", source, "成品.docx", "--template", self.make_template(), "--cover"
        )
        self.assertTrue(result["ok"])
        doc = Document(result["path"])
        self.assertIn("〔S01·p1〕", "\n".join(p.text for p in doc.paragraphs))
        self.assertEqual(doc.tables[0].cell(1, 1).text, "通过〔S02·p3〕")
        self.assertEqual(doc.styles["Heading 1"].font.size.pt, 17.0)
        self.assertIn(" PAGE ", doc.sections[0].footer.paragraphs[0]._p.xml)
        self.assertEqual([p.style.name for p in doc.paragraphs if p.text == "第三层"], ["Heading 3"])

    def test_read_material(self):
        docx_path = self.work / "材料.docx"
        doc = Document()
        doc.add_heading("材料标题", level=1)
        doc.add_paragraph("材料正文")
        table = doc.add_table(rows=2, cols=2)
        table.cell(0, 0).text = "名称"
        table.cell(0, 1).text = "数量"
        table.cell(1, 0).text = "甲"
        table.cell(1, 1).text = "2"
        doc.save(docx_path)
        docx = self.run_script("read_material.py", docx_path)
        self.assertIn("# 材料标题", docx["markdown"])
        self.assertIn("| 甲 | 2 |", docx["markdown"])

        pdf_path = self.work / "材料.pdf"
        write_pdf(pdf_path)
        pdf = self.run_script("read_material.py", pdf_path)
        self.assertEqual(pdf["pages"], 1)
        self.assertIn("Hello PDF", pdf["text"])

        xlsx_path = self.work / "材料.xlsx"
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "清单"
        sheet.append(["名称", "说明"])
        sheet.append(["甲", "含|竖线"])
        workbook.save(xlsx_path)
        xlsx = self.run_script("read_material.py", xlsx_path)
        self.assertEqual(xlsx["sheets"][0]["rows"], 2)
        self.assertIn("含\\|竖线", xlsx["markdown"])
        self.assertIn("甲\t含|竖线", xlsx["text"])


if __name__ == "__main__":
    unittest.main()

// 合成样例：用 python-docx 默认模板造一份「仿综述」（正文带标记、一张带「标记」列的
// 表、一段解释标记的说明段、Liberation Serif 和 Courier 两个 run），配一份两页的假材料，
// 走 prepare → review 全流程，把结果 docx 的表、段落、批注、字体导成文字。
// 用法：node test/cite/sample.mjs <输出.txt>。不放进 npm test（只在直接运行时干活），不碰真实用户文件。

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareFeed, pythonBin, reviewDocx } from '../../app/cite/index.mjs'

const python = pythonBin() || 'python3'
const pyEnv = {
  PATH: process.env.PATH,
  PYTHONUTF8: '1',
  PYTHONNOUSERSITE: '1',
  PYTHONDONTWRITEBYTECODE: '1',
}

function py(code, args = []) {
  const child = spawnSync(python, ['-c', code, ...args], { encoding: 'utf8', env: pyEnv })
  if (child.status !== 0) throw new Error(child.stderr || child.stdout)
  return child.stdout
}

function buildMaterial(file) {
  py(`import sys
from docx import Document
from docx.enum.text import WD_BREAK
doc = Document()
doc.add_paragraph("第一份文献指出，2024年国内市场规模达到186万元，负责人：陈屿。")
break_para = doc.add_paragraph()
break_para.add_run().add_break(WD_BREAK.PAGE)
doc.add_paragraph("第二份文献认为行业增速放缓，库存周转天数上升至45天。")
doc.save(sys.argv[1])`, [file])
}

function buildSample(file) {
  py(`import sys
from docx import Document
from docx.oxml.ns import qn
doc = Document()
doc.add_paragraph("2024年国内市场规模达到186万元，负责人：陈屿。〔S01·p1〕")
doc.add_paragraph("综合来看，行业面临的结构性压力短期内难以缓解。〔S01·p2〕")
table = doc.add_table(rows=3, cols=3)
table.style = "Table Grid"
rows = [
    ["文献", "要点", "标记"],
    ["文献一", "2024年国内市场规模达到186万元", "〔S01·p1〕"],
    ["文献二", "结构性压力短期内难以缓解", "〔S01·p2〕"],
]
for r, row in enumerate(rows):
    for c, text in enumerate(row):
        table.rows[r].cells[c].text = text
para = doc.add_paragraph()
one = para.add_run("Liberation Serif 样例 ")
one.font.name = "Liberation Serif"
two = para.add_run("Courier 样例")
two.font.name = "Courier"
two._element.rPr.rFonts.set(qn("w:eastAsia"), "Courier")
doc.add_paragraph("说明：文中〔S0x·pN〕为材料标记，S01—S05依次对应表1所列五份文献，pN表示该文献在tagged文本中的页码；句末标记置于句末标点之后，表格标记置于行末“标记”栏。")
doc.save(sys.argv[1])`, [file])
}

function dump(file) {
  return JSON.parse(py(`import json, re, sys, zipfile
from docx import Document
from docx.oxml.ns import qn
path = sys.argv[1]
doc = Document(path)
out = {}
tables = []
for t in doc.tables:
    header = [cell.text for cell in t.rows[0].cells]
    cols = len(t._tbl.tblGrid.findall(qn("w:gridCol")))
    tables.append({"header": header, "cols": cols})
out["tables"] = tables
out["paras"] = [p.text[:80] for p in doc.paragraphs]
out["comments"] = [c.text for c in doc.comments]
runs = {}
for p in doc.paragraphs:
    for r in p.runs:
        fonts = r._element.rPr.rFonts if (r._element.rPr is not None) else None
        key = "无" if fonts is None else "%s / %s" % (fonts.get(qn("w:ascii")) or "-", fonts.get(qn("w:eastAsia")) or "-")
        runs[key] = runs.get(key, 0) + 1
out["runs"] = runs
z = zipfile.ZipFile(path)
s = z.read("word/settings.xml").decode("utf-8")
m = re.search(r"<w:themeFontLang[^>]*>", s)
out["themeFontLang"] = m.group(0) if m else "（没有）"
ft = z.read("word/fontTable.xml").decode("utf-8")
out["fontTable"] = re.findall(r'<w:font w:name="([^"]+)"', ft)
out["notoAltName"] = bool(re.search(r'<w:font w:name="Noto Sans SC">.*?<w:altName w:val="微软雅黑"/>', ft, re.S))
json.dump(out, sys.stdout, ensure_ascii=False)`, [file]))
}

function render(title, result, info) {
  const lines = [`=== ${title} ===`, `review 返回：verified=${result.verified} missed=${result.missed} overlapMissed=${result.overlapMissed}`]
  lines.push('表：')
  if (!info.tables.length) lines.push('  （没有表）')
  info.tables.forEach((t, i) => lines.push(`  表${i + 1}（${t.cols} 列）：${t.header.join(' | ')}`))
  lines.push('段落（截 80 字）：')
  info.paras.forEach((p, i) => lines.push(`  ${i + 1}. ${p || '（空）'}`))
  lines.push('批注：')
  if (!info.comments.length) lines.push('  （没有批注）')
  info.comments.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`))
  lines.push('正文字体（按 run 计，ascii / eastAsia）：')
  Object.entries(info.runs).forEach(([k, n]) => lines.push(`  ${k}：${n} 个 run`))
  lines.push(`themeFontLang：${info.themeFontLang}`)
  lines.push(`fontTable：${info.fontTable.join('、')}`)
  lines.push(`fontTable 里 Noto Sans SC 带 altName 微软雅黑：${info.notoAltName ? '是' : '否'}`)
  return lines.join('\n')
}

async function main() {
  const out = process.argv[2]
  if (!out) throw new Error('用法：node test/cite/sample.mjs <输出.txt>')
  const root = mkdtempSync(join(tmpdir(), 'sidemate-sample-'))
  const ws = join(root, 'ws')
  mkdirSync(ws)
  const material = join(root, '假材料.docx')
  const sample = join(root, '仿综述.docx')
  buildMaterial(material)
  buildSample(sample)
  const fed = await prepareFeed({ python, workspace: ws, materials: [material], utterance: '写一份文献综述' })
  const result = await reviewDocx({
    python, docx: sample, chunks: fed.chunks,
    utterance: '写一份文献综述', hasTemplate: false,
  })
  writeFileSync(out, render('仿综述走完 prepare → review', result, dump(result.docx)) + '\n', 'utf8')
}

// 被 node --test 收进去时不当脚本跑（那时 NODE_TEST_CONTEXT 有值）
if (!process.env.NODE_TEST_CONTEXT) {
  await main()
}

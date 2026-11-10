import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test, { after, before } from 'node:test'
import { prepareFeed, pythonBin, reviewDocx, stripMarks, tidyDocx } from '../../app/cite/index.mjs'

const bundled = pythonBin()
const python = bundled || 'python3'
const root = mkdtempSync(join(tmpdir(), 'sidemate-cite-'))
const deps = join(root, 'deps')
const env = bundled ? undefined : { PYTHONPATH: deps }
const pyEnv = {
  PATH: process.env.PATH,
  PYTHONUTF8: '1',
  PYTHONNOUSERSITE: '1',
  PYTHONDONTWRITEBYTECODE: '1',
  ...(bundled ? {} : { PYTHONPATH: deps }),
}

function sha(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function runPy(code, args = [], input) {
  const child = spawnSync(python, ['-c', code, ...args], {
    encoding: 'utf8',
    env: pyEnv,
    input,
  })
  if (child.status !== 0) throw new Error(child.stderr || child.stdout)
  return child.stdout
}

function writeDocx(file, body) {
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    'word/styles.xml': '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
${body}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
</w:body></w:document>`,
  }
  runPy(`import json, sys, zipfile
path, files = sys.argv[1], json.loads(sys.stdin.read())
with zipfile.ZipFile(path, "w") as z:
    for name, text in files.items():
        z.writestr(name, text)`, [file], JSON.stringify(files))
}

function readPart(file, name) {
  return runPy(`import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
sys.stdout.write(z.read(sys.argv[2]).decode("utf-8") if sys.argv[2] in z.namelist() else "")`, [file, name])
}

function zipXml(file) {
  return runPy(`import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
found = {name: z.read(name).decode("utf-8") for name in z.namelist() if name.endswith(".xml")}
json.dump(found, sys.stdout, ensure_ascii=False)`, [file])
}

const sourceChunk = {
  marker: '〔S01·p2〕', file: '甲.docx', kind: 'page', locator: '2', index: 1,
  text: '预算186万元\n负责人：陈屿',
}

const multiChunks = [
  { marker: '〔S01·p1〕', file: '库存.csv', kind: 'page', locator: '1', index: 1, text: '青苔绿只够卖6天\n华东仓铅笔缺货' },
  { marker: '〔S02·p1〕', file: '库存.csv', kind: 'page', locator: '1', index: 2, text: '华东仓铅笔缺货' },
  { marker: '〔S03·p1〕', file: '渠道.pptx', kind: 'page', locator: '1', index: 3, text: '直播成交860单\n负责人：林夏' },
  { marker: '〔S04·p1〕', file: '其他.md', kind: 'page', locator: '1', index: 4, text: '另一份毫不相干的材料' },
  { marker: '〔S05·p1〕', file: '市场.pdf', kind: 'page', locator: '1', index: 5, text: '渠道直播效果好' },
]

function writePdf(file, pages) {
  runPy(`import json, sys
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
pages = json.loads(sys.argv[2])
w = PdfWriter()
for text in pages:
    w.add_blank_page(612, 792)
    page = w.pages[-1]
    stream = DecodedStreamObject()
    stream.set_data(f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode())
    page[NameObject("/Contents")] = stream
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({
            NameObject("/F1"): DictionaryObject({
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            })
        })
    })
w.write(sys.argv[1])`, [file, JSON.stringify(pages)])
}

function writeXlsx(file) {
  runPy(`import sys
from openpyxl import Workbook
book = Workbook()
east = book.active
east.title = "华东"
east["A1"] = "华东签约45万元，联系人：吴迪。"
south = book.create_sheet("华南")
south["A1"] = "华南回款28万元，联系人：郑兰。"
book.save(sys.argv[1])`, [file])
}

function writePptx(file) {
  runPy(`import sys
from pptx import Presentation
from pptx.util import Inches
deck = Presentation()
first = deck.slides.add_slide(deck.slide_layouts[1])
first.shapes.title.text = "季度汇报"
first.placeholders[1].text = "华东区 联系人：吴迪"
second = deck.slides.add_slide(deck.slide_layouts[6])
table = second.shapes.add_table(2, 2, Inches(1), Inches(1), Inches(4), Inches(2)).table
table.cell(0, 0).text = "项目"
table.cell(0, 1).text = "金额"
table.cell(1, 0).text = "华东签约"
table.cell(1, 1).text = "45万元"
third = deck.slides.add_slide(deck.slide_layouts[6])
group = third.shapes.add_group_shape()
group.shapes.add_textbox(Inches(1), Inches(1), Inches(3), Inches(1)).text_frame.text = "组合里的字"
deck.save(sys.argv[1])`, [file])
}

function writePptxWithBlank(file) {
  runPy(`import sys
from pptx import Presentation
from pptx.util import Inches
deck = Presentation()
first = deck.slides.add_slide(deck.slide_layouts[6])
first.shapes.add_textbox(Inches(1), Inches(1), Inches(3), Inches(1)).text_frame.text = "甲页"
deck.slides.add_slide(deck.slide_layouts[6])
third = deck.slides.add_slide(deck.slide_layouts[6])
third.shapes.add_textbox(Inches(1), Inches(1), Inches(3), Inches(1)).text_frame.text = "丙页"
deck.save(sys.argv[1])`, [file])
}

function boomOffice(log) {
  const file = join(root, 'boom.mjs')
  writeFileSync(file, `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(log)}, 'x')\nprocess.exit(1)\n`)
  return file
}

function fakeOffice(pdf) {
  const file = join(root, 'fake-dsoffice.mjs')
  const log = join(root, 'convert.log')
  writeFileSync(file, `import { appendFileSync, copyFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, 'convert\\n')
const output = process.argv[process.argv.indexOf('--output') + 1]
copyFileSync(${JSON.stringify(pdf)}, output)
`)
  return { file, log }
}

before(() => {
  if (bundled) return
  mkdirSync(deps, { recursive: true })
  const pip = spawnSync(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--target', deps, 'pypdf==6.1.1', 'python-docx==1.2.0', 'lxml', 'openpyxl', 'python-pptx==1.0.2'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONUTF8: '1' },
  })
  assert.equal(pip.status, 0, pip.stderr)
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

test('breaks cut docx pages and a sheet keeps its name', async () => {
  const broken = join(root, '分页.docx')
  const rendered = join(root, '渲染.docx')
  const sheet = join(root, '销售.xlsx')
  const note = join(root, '客服.md')
  writeDocx(broken, `<w:p><w:r><w:t>封面 联系人：周某</w:t></w:r></w:p>
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
<w:p><w:r><w:t>预算186万元，负责人：陈屿。</w:t></w:r></w:p>`)
  writeDocx(rendered, `<w:p><w:r><w:t>第一页</w:t></w:r><w:r><w:lastRenderedPageBreak/><w:t>第二页 预算186万元</w:t></w:r></w:p>`)
  writeXlsx(sheet)
  writeFileSync(note, '客服工单关闭63件，联系人：孙倩。\n')
  const ws = join(root, 'ws-a')
  mkdirSync(ws)
  const log = join(root, 'unused-convert')
  const before = sha(broken)
  const fed = await prepareFeed({
    python, env, workspace: ws, dsoffice: boomOffice(log),
    utterance: '汇成本周周报', template: join(root, '上周周报.docx'),
    materials: [broken, rendered, sheet, note],
  })
  assert.equal(existsSync(log), false)
  assert.equal(sha(broken), before)
  assert.deepEqual(fed.chunks.map(chunk => chunk.marker), ['〔S01·p1〕', '〔S01·p2〕', '〔S02·p1〕', '〔S02·p2〕', '〔S03·华东〕', '〔S03·华南〕', '〔S04·p1〕'])
  assert.match(fed.chunks[1].text, /186/)
  assert.equal(fed.chunks[1].text.includes('周某'), false)
  assert.match(fed.chunks[3].text, /186/)
  assert.equal(fed.chunks[4].comment, '来自《销售.xlsx》工作表「华东」')
  assert.equal(fed.chunks[6].comment, '来自《客服.md》第 1 页')
  assert.match(fed.prompt, /^汇成本周周报/)
  assert.match(fed.prompt, /范本：上周周报.docx/)
  assert.match(fed.prompt, /材料的带标副本在 tagged\/。/)
  assert.match(fed.prompt, /每句来自材料的话，句末原样保留它用到的标记。/)
  assert.match(fed.prompt, /表格的每一行也要在行末留标记。/)
  assert.match(fed.prompt, /表格的标记写在这一行最后一格文字的后面，不要为标记单独加一列。/)
  assert.match(fed.prompt, /文件里不要解释标记，不要提 tagged，回话里也不要提。/)
  assert.match(fed.prompt, /照正常文章分段，带标和不带标的句子可以在同一段；不要为了放标记一句一段。/)
  assert.match(fed.prompt, /新加的承诺（人员安排、时限、考核、保密、生效条款这类原文没有的）不要悄悄写进正文；要写就在回话里单列出来，让用户确认。/)
  assert.match(fed.prompt, /都没有就正文和标题都用 Noto Sans SC。/)
  assert.match(fed.prompt, /不要用 Courier、日文字体（明朝、ゴシック），也不要用 Linux 字体（Liberation、文泉驿、DejaVu）。/)
  assert.equal(fed.prompt.includes('186'), false)
  const tagged = readFileSync(join(ws, 'tagged', 'S01-分页.docx.txt'), 'utf8')
  assert.match(tagged, /〔S01·p2〕/)
  assert.match(tagged, /186/)
  assert.notEqual(statSync(join(ws, 'tagged')).mode & 0o200, 0)
  assert.equal(statSync(join(ws, 'tagged', 'S01-分页.docx.txt')).mode & 0o777, 0o444)
  const again = await prepareFeed({
    python, env, workspace: ws, dsoffice: boomOffice(log),
    utterance: '汇成本周周报', materials: [note],
  })
  assert.equal(again.chunks.length, 1)
})

// 材料恰好一份文档时（让改用户自己那一份稿），不切块、不打标、提示里不要句末标记
test('one document on its own is not cut and the prompt asks for no markers', async () => {
  const file = join(root, '原稿.docx')
  writeDocx(file, '<w:p><w:r><w:t>第一段 预算186万元</w:t></w:r></w:p>')
  const ws = join(root, 'ws-single')
  mkdirSync(ws)
  const fed = await prepareFeed({
    python, env, workspace: ws, dsoffice: boomOffice(join(root, 'unused-convert')),
    utterance: '把这份稿子扩写正式点', template: file, materials: [file], single: true,
  })
  assert.deepEqual(fed.chunks, [])
  assert.equal(existsSync(join(ws, 'tagged')), false)
  assert.match(fed.prompt, /^把这份稿子扩写正式点/)
  assert.match(fed.prompt, /范本：原稿.docx/)
  assert.match(fed.prompt, /这是用户自己的一份稿子/)
  assert.equal(fed.prompt.includes('tagged'), false, fed.prompt)
  assert.equal(fed.prompt.includes('句末原样保留'), false, fed.prompt)
  assert.match(fed.prompt, /新加的承诺（人员安排、时限、考核、保密、生效条款这类原文没有的）不要悄悄写进正文；要写就在回话里单列出来，让用户确认。/)
})

test('a document without page markers is cut from the converted pdf', async () => {
  const file = join(root, '无分页.docx')
  const pdf = join(root, 'pages.pdf')
  writeDocx(file, '<w:p><w:r><w:t>全部挤在一起没有分页</w:t></w:r></w:p>')
  writePdf(pdf, ['alpha 11 Zhou', 'beta 22'])
  const fake = fakeOffice(pdf)
  const ws = join(root, 'ws-b')
  mkdirSync(ws)
  const fed = await prepareFeed({
    python, env, workspace: ws, node: process.execPath, dsoffice: fake.file, materials: [file], utterance: '汇',
  })
  assert.equal(readFileSync(fake.log, 'utf8').trim(), 'convert')
  assert.equal(fed.chunks.length, 2)
  assert.match(fed.chunks[0].text, /alpha 11/)
  assert.match(fed.chunks[1].text, /beta 22/)
  assert.equal(fed.chunks[0].text.includes('全部挤在一起'), false)
  assert.equal(fed.chunks[0].file, '无分页.docx')
})

test('checked text becomes a comment and a bad number does not', async () => {
  const chunks = [
    { marker: '〔S01·p2〕', file: '甲.docx', kind: 'page', locator: '2', text: '结论：甲\n数据：预算186万元\n负责人：陈屿', index: 1 },
    { marker: '〔S02·正文〕', file: '乙.xlsx', kind: 'sheet', locator: '正文', text: '负责人：梁秋\n数据：1280本', index: 2 },
  ]
  const good = join(root, '对.docx')
  const bad = join(root, '错.docx')
  const bare = join(root, '无标记.docx')
  writeDocx(good, `<w:p><w:r><w:t>预算186万元，陈屿〔S01·p2〕</w:t></w:r></w:p>
<w:p><w:r><w:t>〔S01·p2〕预算186万元，负责人：陈屿</w:t></w:r></w:p>
<w:p><w:r><w:t>预算12万元〔S01·p2〕</w:t></w:r></w:p>
<w:p><w:r><w:t>12〔S02·正文〕</w:t></w:r></w:p>`)
  writeDocx(bad, '<w:p><w:r><w:t>这个项目应当开始做〔S01·p2〕</w:t></w:r></w:p>')
  writeDocx(bare, '<w:p><w:r><w:t>没有标记</w:t></w:r></w:p>')
  const bareHash = sha(bare)
  const result = await reviewDocx({ python, env, docx: good, chunks })
  const xml = readPart(good, 'word/document.xml')
  const comments = readPart(good, 'word/comments.xml')
  assert.equal(result.verified, 2)
  assert.equal(result.missed, 2)
  assert.equal(result.overlapMissed, 0)
  assert.equal(result.message, '有 2 处没核上')
  assert.equal(xml.includes('〔'), false)
  assert.match(xml, /预算12万元/)
  assert.match(comments, /来自《甲.docx》第 2 页/)
  assert.equal((comments.match(/<w:comment /g) || []).length, 4)
  assert.match(comments, /模型说出自《甲.docx》第 2 页，没能逐字核上，请自己翻一下/)
  assert.match(comments, /模型说出自《乙.xlsx》工作表「正文」，没能逐字核上，请自己翻一下/)
  assert.equal(comments.includes('出处未核实'), false)
  const missed = await reviewDocx({ python, env, docx: bad, chunks })
  assert.equal(missed.verified, 0)
  assert.equal(missed.missed, 1)
  assert.equal(missed.overlapMissed, 1)
  assert.match(readPart(bad, 'word/comments.xml'), /模型说出自《甲.docx》第 2 页，没能逐字核上，请自己翻一下/)
  assert.equal(readPart(bad, 'word/document.xml').includes('〔'), false)
  const quiet = await reviewDocx({ python, env, docx: bare, chunks })
  assert.deepEqual(quiet, { verified: 0, missed: 0, overlapMissed: 0, message: '', docx: bare })
  assert.equal(sha(bare), bareHash)
})

test('a phrase with no number and no name still needs six shared characters', async () => {
  const chunks = [{
    marker: '〔S01·p2〕', file: '甲.docx', kind: 'page', locator: '2', index: 1,
    text: '北岸灯塔建议立项',
  }]
  const file = join(root, '重合.docx')
  writeDocx(file, `<w:p><w:r><w:t>北岸灯塔建议立项〔S01·p2〕</w:t></w:r></w:p>`)
  const result = await reviewDocx({ python, env, docx: file, chunks })
  assert.equal(result.verified, 1)
  assert.equal(result.overlapMissed, 0)
  assert.match(readPart(file, 'word/comments.xml'), /来自《甲.docx》第 2 页/)
})

test('a table row is judged across its cells', async () => {
  const chunks = [{
    marker: '〔S01·p2〕', file: '甲.docx', kind: 'page', locator: '2', index: 1,
    text: '预算186万元\n负责人：陈屿',
  }]
  const file = join(root, '表格.docx')
  writeDocx(file, `<w:tbl>
<w:tr>
  <w:tc><w:p><w:r><w:t>预算186万元</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>陈屿〔S01·p2〕</w:t></w:r></w:p></w:tc>
</w:tr>
<w:tr>
  <w:tc><w:p><w:r><w:t>预算12万元</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>陈屿〔S01·p2〕</w:t></w:r></w:p></w:tc>
</w:tr>
</w:tbl>`)
  const result = await reviewDocx({ python, env, docx: file, chunks })
  const xml = readPart(file, 'word/document.xml')
  const comments = readPart(file, 'word/comments.xml')
  assert.equal(result.verified, 1)
  assert.equal(result.missed, 1)
  assert.equal(xml.includes('〔'), false)
  assert.match(xml, /预算12万元/)
  assert.equal((comments.match(/<w:comment /g) || []).length, 2)
  assert.match(comments, /来自《甲.docx》第 2 页/)
  assert.match(comments, /模型说出自《甲.docx》第 2 页，没能逐字核上，请自己翻一下/)
})

test('tagged copies stay beside the originals and the originals stay put', async () => {
  const note = join(root, '只读.md')
  writeFileSync(note, '唯一数字80000，联系人：周宁。\n')
  chmodSync(note, 0o644)
  const ws = join(root, 'ws-c')
  mkdirSync(ws)
  const before = sha(note)
  await prepareFeed({
    python, env, workspace: ws, dsoffice: join(root, 'missing.mjs'),
    materials: [note], utterance: '汇',
  })
  assert.equal(sha(note), before)
  assert.equal(existsSync(join(ws, '只读.md')), false)
  assert.match(readFileSync(join(ws, 'tagged', 'S01-只读.md.txt'), 'utf8'), /80000/)
})

test('a missing converter says so in plain language', async () => {
  const file = join(root, '缺转换.docx')
  writeDocx(file, '<w:p><w:r><w:t>没有分页标记</w:t></w:r></w:p>')
  const ws = join(root, 'ws-d')
  mkdirSync(ws)
  await assert.rejects(
    () => prepareFeed({
      python, env, workspace: ws, materials: [file], utterance: '汇',
      node: join(root, 'no-node'), dsoffice: join(root, 'no-cli.js'),
    }),
    /还不能把文档转成按页切的样子/,
  )
})

test('body paragraphs after a table are still checked', async () => {
  const chunks = [
    { marker: '〔S01·客服〕', file: '客服.xlsx', kind: 'sheet', locator: '客服', index: 1, text: '包装破损占了客服的一半\n投诉17起' },
    { marker: '〔S02·p1〕', file: '销售.md', kind: 'page', locator: '1', index: 2, text: '本周销售正常' },
    { marker: '〔S03·p1〕', file: '库存.md', kind: 'page', locator: '1', index: 3, text: '库存1.8万支\n负责人：梁秋' },
    { marker: '〔S04·p1〕', file: '生产.md', kind: 'page', locator: '1', index: 4, text: '负责人：何川\n良率98.1%' },
  ]
  const file = join(root, '混排.docx')
  writeDocx(file, `<w:p><w:r><w:t>包装破损占了客服的一半〔S01·客服〕</w:t></w:r></w:p>
<w:p><w:r><w:t>投诉17起〔S01·客服〕</w:t></w:r></w:p>
<w:p><w:r><w:t>投诉18起〔S01·客服〕</w:t></w:r></w:p>
<w:p><w:r><w:t>整体情况良好〔S02·p1〕</w:t></w:r></w:p>
<w:tbl>
<w:tr>
  <w:tc><w:p><w:r><w:t>库存</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>1.8万支</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>梁秋〔S03·p1〕</w:t></w:r></w:p></w:tc>
</w:tr>
<w:tr>
  <w:tc><w:p><w:r><w:t>良率</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>97%</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>何川〔S04·p1〕</w:t></w:r></w:p></w:tc>
</w:tr>
</w:tbl>`)
  const result = await reviewDocx({ python, env, docx: file, chunks })
  const placed = JSON.parse(runPy(`import json, sys
from docx import Document
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
doc = Document(sys.argv[1])
comments = {c.comment_id: c.text for c in doc.comments}
def notes(paragraph):
    found = []
    for node in paragraph._p.iter():
        if node.tag == f"{W}commentReference":
            found.append(comments.get(int(node.get(f"{W}id")), ""))
    return found
paras = [{"text": p.text, "notes": notes(p)} for p in doc.paragraphs]
rows = []
for table in doc.tables:
    for tr in table._tbl.findall(f"{W}tr"):
        texts, found = [], []
        for tc in tr.findall(f"{W}tc"):
            for item in tc.findall(f"{W}p"):
                from docx.text.paragraph import Paragraph
                paragraph = Paragraph(item, doc)
                texts.append(paragraph.text)
                found.extend(notes(paragraph))
        rows.append({"text": "\\n".join(texts), "notes": found})
mark = "〔" in "".join(p.text for p in doc.paragraphs) or any("〔" in row["text"] for row in rows)
json.dump({"paras": paras, "rows": rows, "mark": mark}, sys.stdout, ensure_ascii=False)`, [file]))
  assert.equal(result.verified, 3)
  assert.equal(result.missed, 3)
  assert.equal(result.overlapMissed, 1)
  assert.equal(result.message, '有 3 处没核上')
  assert.equal(placed.mark, false)
  assert.equal(placed.paras.filter(item => item.notes.length).map(item => item.text).join('|'), '包装破损占了客服的一半|投诉17起|投诉18起|整体情况良好')
  assert.equal(placed.rows.filter(item => item.notes.length).length, 2)
  assert.match(placed.rows[0].text, /1\.8万支/)
  assert.match(placed.rows[0].notes[0], /来自《库存.md》第 1 页/)
  assert.match(placed.rows[1].notes[0], /模型说出自《生产.md》第 1 页，没能逐字核上，请自己翻一下/)
  assert.match(placed.paras[0].notes[0], /来自《客服.xlsx》工作表「客服」/)
  assert.match(placed.paras[1].notes[0], /来自《客服.xlsx》工作表「客服」/)
  assert.match(placed.paras[3].notes[0], /模型说出自《销售.md》第 1 页，没能逐字核上，请自己翻一下/)
})

test('checking keeps run formatting and embedded objects', async () => {
  const file = join(root, '格式.docx')
  writeDocx(file, `<w:p>
  <w:r><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="宋体"/><w:b/><w:sz w:val="28"/><w:color w:val="C00000"/></w:rPr><w:t>预算186万元〔S01·p2〕</w:t></w:r>
  <w:hyperlink r:id="rId9" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>开源说明</w:t></w:r></w:hyperlink>
  <w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:docPr id="1" name="图"/></wp:inline></w:drawing></w:r>
  <w:r><w:footnoteReference w:id="1"/></w:r>
  <w:r><w:br w:type="page"/></w:r>
  <w:bookmarkStart w:id="0" w:name="此处"/>
  <w:bookmarkEnd w:id="0"/>
</w:p>`)
  const result = await reviewDocx({ python, env, docx: file, chunks: [sourceChunk], utterance: '照宋体写一份周报' })
  const xml = readPart(file, 'word/document.xml')
  assert.equal(result.verified, 1)
  assert.equal(result.missed, 0)
  assert.equal(xml.includes('〔'), false)
  assert.match(xml, /w:eastAsia="宋体"/)
  assert.match(xml, /<w:b\/>/)
  assert.match(xml, /w:val="C00000"/)
  assert.match(xml, /<w:hyperlink/)
  assert.match(xml, /开源说明/)
  assert.match(xml, /<w:drawing>/)
  assert.match(xml, /footnoteReference/)
  assert.match(xml, /w:type="page"/)
  assert.match(xml, /bookmarkStart/)
  assert.match(readPart(file, 'word/comments.xml'), /来自《甲.docx》第 2 页/)
})

test('a marker split across runs is removed without dropping the runs', async () => {
  const file = join(root, '拆开.docx')
  writeDocx(file, `<w:p>
  <w:r><w:rPr><w:b/></w:rPr><w:t>预算186〔S01</w:t></w:r>
  <w:r><w:rPr><w:rFonts w:eastAsia="宋体"/></w:rPr><w:t>·p2〕万元</w:t></w:r>
</w:p>`)
  const result = await reviewDocx({ python, env, docx: file, chunks: [sourceChunk], utterance: '照宋体写一份周报' })
  const xml = readPart(file, 'word/document.xml')
  assert.equal(result.verified, 1)
  assert.equal(xml.includes('〔'), false)
  assert.match(xml, /<w:b\/>/)
  assert.match(xml, /预算186/)
  assert.match(xml, /w:eastAsia="宋体"/)
  assert.match(xml, /万元/)
})

test('a text box is checked once and both copies stay', async () => {
  const file = join(root, '文本框.docx')
  writeDocx(file, `<w:p><w:r><w:t>正文</w:t></w:r><w:r>
<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
  <mc:Choice Requires="wps">
    <w:drawing><w:txbxContent><w:p><w:r><w:t>预算186万元〔S01·p2〕</w:t></w:r></w:p></w:txbxContent></w:drawing>
  </mc:Choice>
  <mc:Fallback>
    <w:pict><w:txbxContent><w:p><w:r><w:t>预算186万元〔S01·p2〕</w:t></w:r></w:p></w:txbxContent></w:pict>
  </mc:Fallback>
</mc:AlternateContent>
</w:r></w:p>`)
  const result = await reviewDocx({ python, env, docx: file, chunks: [sourceChunk] })
  const packed = JSON.parse(zipXml(file))
  const xml = packed['word/document.xml']
  const comments = packed['word/comments.xml'] || ''
  const refs = Object.values(packed).reduce((sum, text) => sum + (text.match(/<w:commentReference /g) || []).length, 0)
  assert.equal(result.verified, 1)
  assert.equal(result.missed, 0)
  assert.equal(xml.includes('〔'), false)
  assert.match(xml, /AlternateContent/)
  assert.equal((xml.match(/预算186万元/g) || []).length, 2)
  assert.equal((comments.match(/<w:comment /g) || []).length, 1)
  assert.equal(refs, 1)
})

test('headers, notes, and wrapped cells do not keep markers', async () => {
  const file = join(root, '边角.docx')
  runPy(`import sys, zipfile
from docx import Document
from docx.oxml import parse_xml
from lxml import etree
path = sys.argv[1]
doc = Document()
section = doc.sections[0]
section.different_first_page_header_footer = True
doc.settings.odd_and_even_pages_header_footer = True
section.first_page_header.is_linked_to_previous = False
section.first_page_header.paragraphs[0].text = "预算186万元〔S01·p2〕"
section.even_page_header.is_linked_to_previous = False
section.even_page_header.paragraphs[0].text = "预算186万元〔S01·p2〕"
section.even_page_footer.is_linked_to_previous = False
section.even_page_footer.paragraphs[0].text = "预算186万元〔S01·p2〕"
body = doc.element.body
sect = body[-1]
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
extra = parse_xml(f"""<w:tbl xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:tr><w:sdt><w:sdtContent><w:tc><w:p><w:r><w:t>预算186万元〔S01·p2〕</w:t></w:r></w:p></w:tc></w:sdtContent></w:sdt></w:tr></w:tbl>""")
body.insert(body.index(sect), extra)
doc.save(path)
with zipfile.ZipFile(path) as z:
    files = {name: z.read(name) for name in z.namelist()}
fn = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>预算186万元〔S01·p2〕</w:t></w:r></w:p></w:footnote></w:footnotes>"""
en = fn.replace("footnote", "endnote")
files["word/footnotes.xml"] = fn.encode()
files["word/endnotes.xml"] = en.encode()
rels = files["word/_rels/document.xml.rels"].decode()
rels = rels.replace("</Relationships>", """<Relationship Id="rIdFn" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
<Relationship Id="rIdEn" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>
</Relationships>""")
files["word/_rels/document.xml.rels"] = rels.encode()
types = files["[Content_Types].xml"].decode()
types = types.replace("</Types>", """<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
<Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>
</Types>""")
files["[Content_Types].xml"] = types.encode()
with zipfile.ZipFile(path, "w") as z:
    for name, blob in files.items():
        z.writestr(name, blob)
`, [file])
  const result = await reviewDocx({ python, env, docx: file, chunks: [sourceChunk] })
  const packed = JSON.parse(zipXml(file))
  const joined = Object.values(packed).join('\n')
  const refs = Object.values(packed).reduce((sum, text) => sum + (text.match(/<w:commentReference /g) || []).length, 0)
  assert.equal(result.verified, 6)
  assert.equal(result.missed, 0)
  assert.equal(joined.includes('〔'), false)
  assert.equal(refs, 6)
  assert.match(packed['word/header1.xml'] || packed['word/header2.xml'], /预算186万元/)
  assert.match(packed['word/footnotes.xml'], /预算186万元/)
  assert.match(packed['word/endnotes.xml'], /预算186万元/)
  assert.match(packed['word/document.xml'], /<w:sdt/)
})

test('markers in revisions and fields are checked, and a leftover is counted', async () => {
  const file = join(root, '藏着.docx')
  writeDocx(file, `<w:p><w:ins w:id="1" w:author="甲" w:date="2026-11-04T00:00:00Z"><w:r><w:t>预算186万元〔S01·p2〕</w:t></w:r></w:ins></w:p>
<w:p><w:smartTag><w:r><w:t>预算186万元〔S01·p2〕</w:t></w:r></w:smartTag></w:p>
<w:p><w:customXml><w:r><w:t>预算186万元〔S01·p2〕</w:t></w:r></w:customXml></w:p>
<w:p><w:fldSimple w:instr=" DATE "><w:r><w:t>预算186万元〔S01·p2〕</w:t></w:r></w:fldSimple></w:p>
<w:p><w:del w:id="2" w:author="甲"><w:r><w:delText>〔S09·p9〕</w:delText></w:r></w:del></w:p>`)
  const result = await reviewDocx({ python, env, docx: file, chunks: [sourceChunk] })
  const xml = readPart(file, 'word/document.xml')
  assert.equal(result.verified, 4)
  assert.equal(result.missed, 1)
  assert.equal(result.message, '有 1 处没核上')
  assert.equal(xml.includes('〔'), false)
  assert.match(xml, /<w:ins /)
  assert.match(xml, /fldSimple/)
  assert.match(xml, /smartTag/)
  assert.match(xml, /customXml/)
  assert.equal((readPart(file, 'word/comments.xml').match(/<w:comment /g) || []).length, 4)
})

test('a document without headers does not gain header parts', async () => {
  const file = join(root, '无页眉.docx')
  writeDocx(file, '<w:p><w:r><w:t>预算186万元〔S01·p2〕</w:t></w:r></w:p>')
  const before = JSON.parse(runPy(`import json, sys, zipfile
json.dump(zipfile.ZipFile(sys.argv[1]).namelist(), sys.stdout)`, [file]))
  const result = await reviewDocx({ python, env, docx: file, chunks: [sourceChunk] })
  const after = JSON.parse(runPy(`import json, sys, zipfile
json.dump(zipfile.ZipFile(sys.argv[1]).namelist(), sys.stdout)`, [file]))
  const xml = readPart(file, 'word/document.xml')
  assert.equal(result.verified, 1)
  assert.equal(before.some(name => /header|footer/i.test(name)), false)
  assert.equal(after.some(name => /header|footer/i.test(name)), false)
  assert.equal(xml.includes('headerReference'), false)
  assert.equal(xml.includes('footerReference'), false)
  assert.equal(xml.includes('〔'), false)
})

test('preparing again drops the previous tagged files', async () => {
  const first = join(root, '上一份.md')
  const second = join(root, '这一份.md')
  writeFileSync(first, '上一份材料。\n')
  writeFileSync(second, '这一份材料。\n')
  const ws = join(root, 'ws-again')
  mkdirSync(ws)
  await prepareFeed({
    python, env, workspace: ws, dsoffice: join(root, 'missing.mjs'),
    materials: [first, second], utterance: '汇',
  })
  assert.equal(readdirSync(join(ws, 'tagged')).length, 2)
  await prepareFeed({
    python, env, workspace: ws, dsoffice: join(root, 'missing.mjs'),
    materials: [second], utterance: '汇',
  })
  assert.deepEqual(readdirSync(join(ws, 'tagged')), ['S01-这一份.md.txt'])
})

test('turning markdown into docx does not replace an existing file', async () => {
  const md = join(root, '周报.md')
  const existing = join(root, '周报.docx')
  writeFileSync(md, '预算186万元，负责人：陈屿。〔S01·p2〕\n')
  writeDocx(existing, '<w:p><w:r><w:t>原件留着</w:t></w:r></w:p>')
  const before = sha(existing)
  const result = await reviewDocx({ python, env, docx: md, chunks: [sourceChunk] })
  assert.equal(sha(existing), before)
  assert.equal(result.docx.endsWith('周报-2.docx'), true)
  assert.match(readPart(result.docx, 'word/document.xml'), /预算186万元/)
  assert.equal(readPart(existing, 'word/document.xml').includes('预算186'), false)
  // markdown 转出来的 docx 也过一遍字体整理
  assert.equal(readPart(result.docx, 'word/styles.xml').includes('asciiTheme'), false)
  assert.match(readPart(result.docx, 'word/styles.xml'), /w:ascii="Noto Sans SC"/)
  assert.match(readPart(result.docx, 'word/settings.xml'), /w:eastAsia="zh-CN"/)
})

test('a failed page conversion is explained without the converter text', async () => {
  const file = join(root, '转失败.docx')
  writeDocx(file, '<w:p><w:r><w:t>没有分页标记</w:t></w:r></w:p>')
  const office = join(root, 'loud-fail.mjs')
  const log = join(root, 'pdf-fail.log')
  writeFileSync(office, `console.error('convert failed at /var/secret/cli.js ENOENT')\nprocess.exit(2)\n`)
  const ws = join(root, 'ws-pdf')
  mkdirSync(ws)
  await assert.rejects(
    () => prepareFeed({
      python, env: { ...pyEnv, SIDEMATE_LOG: log }, workspace: ws,
      materials: [file], utterance: '汇', node: process.execPath, dsoffice: office,
    }),
    (error) => {
      assert.equal(error.message, '这份文档转不成按页切的样子')
      assert.equal(error.message.includes('/var/secret'), false)
      return true
    },
  )
  assert.match(readFileSync(log, 'utf8'), /\/var\/secret\/cli\.js/)
})

test('a page conversion that runs too long uses the same explanation', async () => {
  const file = join(root, '转超时.docx')
  writeDocx(file, '<w:p><w:r><w:t>没有分页标记</w:t></w:r></w:p>')
  const office = join(root, 'sleep-office.mjs')
  const log = join(root, 'pdf-timeout.log')
  writeFileSync(office, 'setTimeout(() => {}, 30000)\n')
  const ws = join(root, 'ws-timeout')
  mkdirSync(ws)
  await assert.rejects(
    () => prepareFeed({
      python, env: { ...pyEnv, SIDEMATE_LOG: log, SIDEMATE_PDF_TIMEOUT: '1' }, workspace: ws,
      materials: [file], utterance: '汇', node: process.execPath, dsoffice: office,
    }),
    (error) => {
      assert.equal(error.message, '这份文档转不成按页切的样子')
      assert.equal(error.message.includes('Timeout'), false)
      return true
    },
  )
  assert.match(readFileSync(log, 'utf8'), /timeout/)
})

test('a slide deck is cut one slide at a time', async () => {
  const deck = join(root, '汇报.pptx')
  const blank = join(root, '有空页.pptx')
  writePptx(deck)
  writePptxWithBlank(blank)
  const ws = join(root, 'ws-pptx')
  mkdirSync(ws)
  const log = join(root, 'unused-convert-pptx')
  const before = sha(deck)
  const fed = await prepareFeed({
    python, env, workspace: ws, dsoffice: boomOffice(log),
    materials: [deck], utterance: '汇成本周汇报',
  })
  assert.equal(existsSync(log), false)
  assert.equal(sha(deck), before)
  assert.equal(fed.chunks.length, 3)
  assert.deepEqual(fed.chunks.map(chunk => chunk.marker), ['〔S01·p1〕', '〔S01·p2〕', '〔S01·p3〕'])
  assert.equal(fed.chunks[0].kind, 'page')
  assert.equal(fed.chunks[0].locator, '1')
  assert.equal(fed.chunks[2].locator, '3')
  assert.match(fed.chunks[0].text, /季度汇报/)
  assert.match(fed.chunks[0].text, /吴迪/)
  assert.match(fed.chunks[1].text, /项目\t金额/)
  assert.match(fed.chunks[1].text, /华东签约\t45万元/)
  assert.match(fed.chunks[2].text, /组合里的字/)
  assert.equal(fed.chunks[1].comment, '来自《汇报.pptx》第 2 页')
  const tagged = readFileSync(join(ws, 'tagged', 'S01-汇报.pptx.txt'), 'utf8')
  assert.match(tagged, /〔S01·p2〕/)
  assert.match(tagged, /华东签约/)
  const docx = join(root, '带标记.docx')
  writeDocx(docx, '<w:p><w:r><w:t>华东签约45万元〔S01·p2〕</w:t></w:r></w:p>')
  const result = await reviewDocx({ python, env, docx, chunks: fed.chunks })
  assert.equal(result.verified, 1)
  assert.equal(result.missed, 0)
  assert.match(readPart(docx, 'word/comments.xml'), /来自《汇报.pptx》第 2 页/)
  const gapped = await prepareFeed({
    python, env, workspace: ws, dsoffice: boomOffice(log),
    materials: [blank], utterance: '汇',
  })
  assert.deepEqual(gapped.chunks.map(chunk => chunk.marker), ['〔S01·p1〕', '〔S01·p2〕', '〔S01·p3〕'])
  assert.match(gapped.chunks[0].text, /甲页/)
  assert.equal(gapped.chunks[1].text.trim(), '')
  assert.match(gapped.chunks[2].text, /丙页/)
})

test('one marker keeps the original verdict and reason', () => {
  const found = JSON.parse(runPy(`import json, sys
sys.path.insert(0, sys.argv[1])
import cite
chunk = ${JSON.stringify(sourceChunk)}
by_marker = {chunk["marker"]: chunk}
cases = [
    ("预算186万元，陈屿", chunk["marker"]),
    ("预算12万元", chunk["marker"]),
    ("负责人：陈屿", "〔S02·p1〕"),
    ("负责人：林夏", chunk["marker"]),
    ("完全没有重合的话", chunk["marker"]),
    ("", chunk["marker"]),
    ("预算186万元", "〔S09·p9〕"),
]
json.dump([cite.judge_marks(text, [marker], by_marker, ["陈屿", "林夏"]) for text, marker in cases], sys.stdout, ensure_ascii=False)`, [join(process.cwd(), 'app', 'cite')]))
  assert.deepEqual(found, [
    [[true, '来自《甲.docx》第 2 页', '']],
    [[false, '', 'number']],
    [[false, '', 'missing']],
    [[false, '', 'name']],
    [[false, '', 'overlap']],
    [[false, '', 'missing']],
    [[false, '', 'missing']],
  ])
})

test('consecutive markers share their sentence but keep individual verdicts', async () => {
  const file = join(root, '连续标记.docx')
  writeDocx(file, `<w:p><w:r><w:t>青苔绿只够卖6天，华东仓铅笔缺货。〔S01·p1〕〔S02·p1〕</w:t></w:r></w:p>
<w:p><w:r><w:t>青苔绿只够卖6天。〔S01·p1〕〔S04·p1〕</w:t></w:r></w:p>
<w:p><w:r><w:t>青苔绿只够卖6天，华东仓铅笔缺货，直播成交860单。〔S01·p1〕〔S02·p1〕〔S03·p1〕</w:t></w:r></w:p>
<w:p><w:r><w:t>渠道直播效果好，直播成交860单。〔S05·p1〕〔S03·p1〕</w:t></w:r></w:p>
<w:p><w:r><w:t>〔S02·p1〕华东仓铅笔缺货</w:t></w:r></w:p>
<w:p><w:r><w:t>〔S01·p1〕华东仓铅笔缺货〔S02·p1〕</w:t></w:r></w:p>`)
  const result = await reviewDocx({ python, env, docx: file, chunks: multiChunks })
  const placed = JSON.parse(runPy(`import json, sys
from docx import Document
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
doc = Document(sys.argv[1])
comments = {c.comment_id: c.text for c in doc.comments}
found = []
for p in doc.paragraphs:
    notes = [comments[int(n.get(f"{W}id"))] for n in p._p.iter() if n.tag == f"{W}commentReference"]
    found.append({"text": p.text, "notes": notes})
json.dump(found, sys.stdout, ensure_ascii=False)`, [file]))
  assert.equal(result.verified, 6)
  assert.equal(result.missed, 0)
  assert.deepEqual(placed.map(item => item.notes.length), [2, 2, 3, 2, 1, 2])
  assert.equal(placed[1].text, '青苔绿只够卖6天。')
  // 同一个锤子点上几句批注，后写的挂在前面
  assert.match(placed[1].notes[1], /库存\.csv/)
  assert.match(placed[1].notes[0], /模型说出自《其他\.md》第 1 页，没能逐字核上/)
  assert.equal(placed.flatMap(item => item.notes).filter(note => note.includes('其他.md')).length, 1)
  assert.equal(placed.flatMap(item => item.notes).filter(note => note.includes('渠道.pptx')).length, 2)
})

test('an xlsx row checks and cites two consecutive markers', async () => {
  const file = join(root, '连续标记.xlsx')
  runPy(`import sys
from openpyxl import Workbook
book = Workbook()
book.active["A1"] = "渠道直播效果好，直播成交860单。〔S05·p1〕〔S03·p1〕"
book.save(sys.argv[1])`, [file])
  const result = await reviewDocx({ python, env, docx: file, chunks: multiChunks })
  assert.equal(result.verified, 1)
  assert.equal(result.missed, 0)
  const cells = JSON.parse(runPy(`import json, sys
from openpyxl import load_workbook
book = load_workbook(sys.argv[1])
ws = book.active
json.dump([ws["A1"].value, ws["B1"].value], sys.stdout, ensure_ascii=False)
book.close()`, [file]))
  assert.equal(cells[0], '渠道直播效果好，直播成交860单。')
  assert.equal(cells[1], '来自《市场.pdf》第 1 页；来自《渠道.pptx》第 1 页')
})

test('a broken file says so in chinese and keeps the library text in the log', async () => {
  const ws = join(root, 'ws-broken')
  mkdirSync(ws)
  const log = join(root, 'broken.log')
  const broken = [join(root, '坏演示.pptx'), join(root, '坏文档.docx')]
  for (const file of broken) writeFileSync(file, Buffer.from('this is not an office file at all'))
  for (const file of broken) {
    await assert.rejects(
      () => prepareFeed({
        python, env: { ...pyEnv, SIDEMATE_LOG: log }, workspace: ws,
        materials: [file], utterance: '汇',
      }),
      (error) => {
        const name = basename(file)
        assert.equal(error.message, `打不开《${name}》，可能坏了或者加了密码`)
        assert.equal(/File is not a zip file|not a zip file|Package not found/i.test(error.message), false)
        return true
      },
    )
  }
  assert.match(readFileSync(log, 'utf8'), /PackageNotFoundError/)
})

test('表里单加的「标记」列被拆掉，标记挪到行末再核', async () => {
  const chunks = [{
    marker: '〔S01·p1〕', file: '库存.md', kind: 'page', locator: '1', index: 1,
    text: '华东签约45万元',
  }]
  const file = join(root, '标记列.docx')
  writeDocx(file, `<w:tbl>
<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>
<w:tr>
  <w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>标记</w:t></w:r></w:p></w:tc>
</w:tr>
<w:tr>
  <w:tc><w:p><w:r><w:t>华东</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>签约45万元</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>〔S01·p1〕</w:t></w:r></w:p></w:tc>
</w:tr>
<w:tr>
  <w:tc><w:p><w:r><w:t>华南</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>签约12万元</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>〔S01·p1〕</w:t></w:r></w:p></w:tc>
</w:tr>
</w:tbl>`)
  const result = await reviewDocx({ python, env, docx: file, chunks, utterance: '写一份汇总' })
  const shape = JSON.parse(runPy(`import json, sys
from docx import Document
from docx.oxml.ns import qn
doc = Document(sys.argv[1])
found = []
for t in doc.tables:
    rows = []
    for tr in t._tbl.findall(qn("w:tr")):
        rows.append(["".join(n.text or "" for n in tc.iter(qn("w:t"))) for tc in tr.findall(qn("w:tc"))])
    found.append({"cols": len(t._tbl.tblGrid.findall(qn("w:gridCol"))), "rows": rows})
json.dump(found, sys.stdout, ensure_ascii=False)`, [file]))
  const comments = readPart(file, 'word/comments.xml')
  assert.equal(result.verified, 1)
  assert.equal(result.missed, 1)
  assert.equal(shape.length, 1)
  assert.equal(shape[0].cols, 2)
  assert.deepEqual(shape[0].rows, [['项目', '金额'], ['华东', '签约45万元'], ['华南', '签约12万元']])
  assert.equal(readPart(file, 'word/document.xml').includes('〔'), false)
  assert.equal((comments.match(/<w:comment /g) || []).length, 2)
  assert.match(comments, /来自《库存.md》第 1 页/)
  assert.match(comments, /模型说出自《库存.md》第 1 页，没能逐字核上，请自己翻一下/)
})

test('标记列碰到合并单元格（vMerge / gridSpan）的表不动，只记日志', async () => {
  const chunks = [{
    marker: '〔S01·p1〕', file: '库存.md', kind: 'page', locator: '1', index: 1,
    text: '华东签约45万元',
  }]
  const file = join(root, '合并表.docx')
  const log = join(root, 'merge.log')
  writeDocx(file, `<w:tbl>
<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>
<w:tr>
  <w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>标记</w:t></w:r></w:p></w:tc>
</w:tr>
<w:tr>
  <w:tc><w:p><w:r><w:t>华东</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>签约45万元</w:t></w:r></w:p></w:tc>
  <w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>〔S01·p1〕</w:t></w:r></w:p></w:tc>
</w:tr>
<w:tr>
  <w:tc><w:p><w:r><w:t>华南</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>签约12万元</w:t></w:r></w:p></w:tc>
  <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p><w:r><w:t></w:t></w:r></w:p></w:tc>
</w:tr>
</w:tbl>
<w:tbl>
<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>
<w:tr>
  <w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>标记</w:t></w:r></w:p></w:tc>
</w:tr>
<w:tr>
  <w:tc><w:p><w:r><w:t>华东</w:t></w:r></w:p></w:tc>
  <w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>〔S01·p1〕</w:t></w:r></w:p></w:tc>
</w:tr>
</w:tbl>`)
  const result = await reviewDocx({ python, env: { ...pyEnv, SIDEMATE_LOG: log }, docx: file, chunks, utterance: '写一份汇总' })
  const cols = JSON.parse(runPy(`import json, sys
from docx import Document
from docx.oxml.ns import qn
doc = Document(sys.argv[1])
json.dump([len(t._tbl.tblGrid.findall(qn("w:gridCol"))) for t in doc.tables], sys.stdout)`, [file]))
  assert.equal(result.verified, 2)
  assert.equal(result.missed, 0)
  assert.deepEqual(cols, [3, 3]) // 两张表都没动结构
  assert.equal(readPart(file, 'word/document.xml').includes('〔'), false)
  assert.equal(readPart(file, 'word/document.xml').includes('<w:vMerge'), true)
  assert.match(readFileSync(log, 'utf8'), /合并单元格/)
})

test('讲标记的说明段整段删掉，「肿瘤标记物」这种普通段落留着', async () => {
  const file = join(root, '说明段.docx')
  writeDocx(file, `<w:p><w:r><w:t>研究综述如下。</w:t></w:r></w:p>
<w:p><w:r><w:t>说明：文中〔S0x·pN〕为材料标记，S01—S05依次对应表1所列五份文献，pN表示该文献在tagged文本中的页码；句末标记置于句末标点之后，表格标记置于行末“标记”栏。</w:t></w:r></w:p>
<w:p><w:r><w:t>文中提到肿瘤标记物的检测要结合临床判断。</w:t></w:r></w:p>
<w:p><w:r><w:t>以上标记对应 tagged 里的材料。</w:t></w:r></w:p>`)
  await reviewDocx({ python, env, docx: file, chunks: [sourceChunk], utterance: '写一份综述' })
  const paras = JSON.parse(runPy(`import json, sys
from docx import Document
json.dump([p.text for p in Document(sys.argv[1]).paragraphs], sys.stdout, ensure_ascii=False)`, [file]))
  assert.deepEqual(paras, ['研究综述如下。', '文中提到肿瘤标记物的检测要结合临床判断。'])
})

test('整份统一：docDefaults 和正文都写 Noto Sans SC，等宽写 Consolas，符号字体不动', async () => {
  const file = join(root, '字体统一.docx')
  runPy(`import sys
from docx import Document
from docx.enum.style import WD_STYLE_TYPE
doc = Document()
para = doc.add_paragraph()
one = para.add_run("甲"); one.font.name = "Liberation Serif"
two = para.add_run("乙"); two.font.name = "Courier"
three = para.add_run("丙"); three.font.name = "Century Gothic"
mono = doc.styles.add_style("代码", WD_STYLE_TYPE.CHARACTER)
mono.font.name = "Consolas"
sym = doc.styles.add_style("符号", WD_STYLE_TYPE.CHARACTER)
sym.font.name = "Symbol"
doc.save(sys.argv[1])`, [file])
  const out = await tidyDocx({ python, env, docx: file, utterance: '写一份文献综述', hasTemplate: false })
  assert.equal(out.mode, 'all')
  const check = JSON.parse(runPy(`import json, sys
from docx import Document
from docx.oxml.ns import qn
doc = Document(sys.argv[1])
defaults = doc.styles.element.find(qn("w:docDefaults")).find(qn("w:rPrDefault")).find(qn("w:rPr")).find(qn("w:rFonts"))
style_fonts = []
for style in doc.styles.element.findall(qn("w:style")):
    rpr = style.find(qn("w:rPr"))
    fonts = rpr.find(qn("w:rFonts")) if rpr is not None else None
    if fonts is not None:
        style_fonts.append((style.get(qn("w:styleId")), fonts.get(qn("w:ascii"))))
runs = []
for p in doc.paragraphs:
    for r in p.runs:
        fonts = r._element.rPr.rFonts if (r._element.rPr is not None) else None
        runs.append(None if fonts is None else (fonts.get(qn("w:ascii")), fonts.get(qn("w:eastAsia"))))
json.dump({
    "defaults": {k: defaults.get(qn("w:" + k)) for k in ("ascii", "hAnsi", "eastAsia", "cs", "asciiTheme")},
    "styles": style_fonts, "runs": runs,
}, sys.stdout, ensure_ascii=False)`, [file]))
  assert.deepEqual(check.defaults, { ascii: 'Noto Sans SC', hAnsi: 'Noto Sans SC', eastAsia: 'Noto Sans SC', cs: 'Noto Sans SC', asciiTheme: null })
  assert.ok(check.styles.some(([id, ascii]) => ascii === 'Consolas'))
  assert.ok(check.styles.some(([id, ascii]) => ascii === 'Symbol'))
  assert.deepEqual(check.runs, [['Noto Sans SC', 'Noto Sans SC'], ['Consolas', 'Consolas'], ['Noto Sans SC', 'Noto Sans SC']])
  assert.match(readPart(file, 'word/settings.xml'), /w:eastAsia="zh-CN"/)
  const fontTable = readPart(file, 'word/fontTable.xml')
  assert.match(fontTable, /<w:font w:name="Noto Sans SC">/)
  assert.match(fontTable, /<w:altName w:val="微软雅黑"\/>/)
  assert.equal(fontTable.includes('ＭＳ 明朝'), false)
  assert.equal(fontTable.includes('ＭＳ ゴシック'), false)
})


test('用户提了字体或有范本：只扫黑名单，宋体仿宋和 Century Gothic 不动', async () => {
  const file = join(root, '字体黑名单.docx')
  const asTemplate = join(root, '字体范本.docx')
  runPy(`import sys
from docx import Document
from docx.oxml.ns import qn
doc = Document()
para = doc.add_paragraph()
for name in ("宋体", "仿宋", "ＭＳ 明朝", "Liberation Serif", "Courier New", "Century Gothic"):
    run = para.add_run(name)
    run.font.name = name
    run._element.rPr.rFonts.set(qn("w:eastAsia"), name)
doc.save(sys.argv[1])`, [file])
  runPy(`import shutil, sys; shutil.copyfile(sys.argv[1], sys.argv[2])`, [file, asTemplate])
  const out = await tidyDocx({ python, env, docx: file, utterance: '正文用宋体写一份综述', hasTemplate: false })
  assert.equal(out.mode, 'bad')
  const fonts = JSON.parse(runPy(`import json, sys
from docx import Document
from docx.oxml.ns import qn
doc = Document(sys.argv[1])
found = []
for p in doc.paragraphs:
    for r in p.runs:
        fonts = r._element.rPr.rFonts if (r._element.rPr is not None) else None
        found.append(None if fonts is None else (fonts.get(qn("w:ascii")), fonts.get(qn("w:eastAsia"))))
json.dump(found, sys.stdout, ensure_ascii=False)`, [file]))
  assert.deepEqual(fonts, [
    ['宋体', '宋体'], ['仿宋', '仿宋'],
    ['Noto Sans SC', 'Noto Sans SC'], ['Noto Sans SC', 'Noto Sans SC'],
    ['Consolas', 'Consolas'], ['Century Gothic', 'Century Gothic'],
  ])
  assert.match(readPart(file, 'word/settings.xml'), /w:eastAsia="zh-CN"/)
  assert.match(readPart(file, 'word/fontTable.xml'), /<w:altName w:val="微软雅黑"\/>/)
  const withTemplate = await tidyDocx({ python, env, docx: asTemplate, utterance: '写一份周报', hasTemplate: true })
  assert.equal(withTemplate.mode, 'bad')
  assert.match(readPart(asTemplate, 'word/document.xml'), /w:eastAsia="宋体"/)
})

test('stylesWithEffects 和主题字体表也清干净：全包搜不到 Courier 和日文字体', async () => {
  const file = join(root, '旧主题.docx')
  runPy(`import sys
from docx import Document
doc = Document()
doc.add_paragraph("预算186万元，负责人：陈屿。")
doc.save(sys.argv[1])`, [file])
  const out = await tidyDocx({ python, env, docx: file, utterance: '写一份文献综述', hasTemplate: false })
  assert.equal(out.mode, 'all')
  const parts = JSON.parse(zipXml(file))
  assert.ok('word/stylesWithEffects.xml' in parts)
  assert.ok('word/theme/theme1.xml' in parts)
  for (const [name, xml] of Object.entries(parts)) {
    for (const bad of ['Courier', '明朝', 'ゴシック', 'MS Mincho', 'MS Gothic']) {
      assert.equal(xml.includes(bad), false, `${name} 里还留着 ${bad}`)
    }
  }
  assert.match(parts['word/stylesWithEffects.xml'], /w:ascii="Consolas"/)
  assert.match(parts['word/theme/theme1.xml'], /<a:ea typeface="Noto Sans SC"\/>/)
  assert.match(parts['word/theme/theme1.xml'], /<a:font script="Jpan" typeface="Noto Sans SC"\/>/)
  const back = runPy(`import json, sys
from docx import Document
json.dump([p.text for p in Document(sys.argv[1]).paragraphs], sys.stdout, ensure_ascii=False)`, [file])
  assert.deepEqual(JSON.parse(back), ['预算186万元，负责人：陈屿。'])
})

test('有范本时主题只清黑名单：日文格跟范本的中文字体，latin 不动', async () => {
  const file = join(root, '主题范本.docx')
  runPy(`import sys
from docx import Document
doc = Document()
doc.add_paragraph("正文")
doc.save(sys.argv[1])`, [file])
  const out = await tidyDocx({ python, env, docx: file, utterance: '照上周的写', hasTemplate: true })
  assert.equal(out.mode, 'bad')
  const theme = readPart(file, 'word/theme/theme1.xml')
  // 范本（python-docx 默认模板）主题表 Hans 格是宋体：日文格照它，不再留明朝、ゴシック
  assert.match(theme, /<a:font script="Jpan" typeface="宋体"\/>/)
  assert.match(theme, /<a:latin typeface="Calibri"\/>/)
  assert.equal(theme.includes('明朝') || theme.includes('ゴシック'), false)
  assert.equal(readPart(file, 'word/stylesWithEffects.xml').includes('Courier'), false)
})

test('批注的每个 run 都带上 Noto Sans SC', async () => {
  const file = join(root, '批注字体.docx')
  writeDocx(file, `<w:p><w:r><w:t>预算186万元，陈屿〔S01·p2〕</w:t></w:r></w:p>
<w:p><w:r><w:t>这个项目应当开始做〔S01·p2〕</w:t></w:r></w:p>`)
  await reviewDocx({ python, env, docx: file, chunks: [sourceChunk], utterance: '照宋体写' })
  const comments = readPart(file, 'word/comments.xml')
  const runs = (comments.match(/<w:r>/g) || []).length
  const noto = (comments.match(/w:ascii="Noto Sans SC"/g) || []).length
  assert.ok(runs > 0)
  assert.equal(runs, noto)
  assert.match(comments, /模型说出自《甲.docx》第 2 页，没能逐字核上，请自己翻一下/)
})

test('xlsx 里没核上的照旧不写批注，计数也按句子', async () => {
  const file = join(root, '没核上的.xlsx')
  runPy(`import sys
from openpyxl import Workbook
book = Workbook()
book.active["A1"] = "库存只剩12万支。〔S02·p1〕"
book.save(sys.argv[1])`, [file])
  const result = await reviewDocx({ python, env, docx: file, chunks: multiChunks })
  assert.equal(result.verified, 0)
  assert.equal(result.missed, 1)
  const cells = JSON.parse(runPy(`import json, sys
from openpyxl import load_workbook
book = load_workbook(sys.argv[1])
ws = book.active
json.dump([ws["A1"].value, ws["B1"].value], sys.stdout, ensure_ascii=False)
book.close()`, [file]))
  assert.equal(cells[0], '库存只剩12万支。')
  assert.equal(cells[1], null)
})

// 核对没成时，壳在副本上把正文里的标记剥干净再交，不写批注
test('剥标记：正文里的〔S…·p…〕清干净，不核也不写批注', async () => {
  const file = join(root, '剥标记.docx')
  writeDocx(file, `<w:p><w:r><w:t>华东仓铅笔缺货〔S06·p2〕</w:t></w:r></w:p>
<w:p><w:r><w:t>这个项目应当开始做〔S01·p2〕</w:t></w:r></w:p>`)
  const out = await stripMarks({ python, env, docx: file })
  assert.equal(out.stripped, 2)
  const xml = readPart(file, 'word/document.xml')
  assert.equal(xml.includes('〔'), false)
  assert.match(xml, /华东仓铅笔缺货/)
  assert.equal(readPart(file, 'word/comments.xml'), '') // 不写批注
})

test('剥标记也管 md 和 txt', async () => {
  const file = join(root, '说明.md')
  writeFileSync(file, '第一句〔S01·p1〕第二句〔S02·p3〕' + String.fromCharCode(10))
  const out = await stripMarks({ python, env, docx: file })
  assert.equal(out.stripped, 2)
  assert.equal(readFileSync(file, 'utf8'), '第一句第二句' + String.fromCharCode(10))
})

test('整理字体时顺手把标记剥掉：没有材料也不会带着标记交出去', async () => {
  const file = join(root, '整理剥标记.docx')
  writeDocx(file, `<w:p><w:r><w:t>正文〔S01·p1〕</w:t></w:r></w:p>`)
  const out = await tidyDocx({ python, env, docx: file, utterance: '写一份周报', hasTemplate: false })
  assert.equal(out.mode, 'all')
  assert.equal(readPart(file, 'word/document.xml').includes('〔'), false)
})

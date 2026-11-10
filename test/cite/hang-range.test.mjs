import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { prepareFeed, pythonBin, reviewDocx } from '../../app/cite/index.mjs'

const bundled = pythonBin()
const python = bundled || 'python3'
const root = mkdtempSync(join(tmpdir(), 'sidemate-hang-'))
const deps = join(root, 'deps')
const env = bundled ? undefined : { PYTHONPATH: deps }
const pyEnv = {
  PATH: process.env.PATH,
  PYTHONUTF8: '1',
  PYTHONNOUSERSITE: '1',
  PYTHONDONTWRITEBYTECODE: '1',
  ...(bundled ? {} : { PYTHONPATH: deps }),
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

after(() => {
  rmSync(root, { recursive: true, force: true })
})

const chunks = [{
  marker: '〔S01·p1〕', file: '客服.md', kind: 'page', locator: '1', index: 1,
  text: '包装破损占客服投诉的一半\n本周投诉17起\n负责人：马乔',
}]

test('批注挂在整段上：加粗的标签和后面的正文一起被盖住', async () => {
  const file = join(root, '整段.docx')
  writeDocx(file, `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>客服：</w:t></w:r><w:r><w:t>包装破损占客服投诉的一半，本周投诉17起，负责人马乔〔S01·p1〕</w:t></w:r></w:p>`)
  const result = await reviewDocx({ python, env, docx: file, chunks })
  const xml = readPart(file, 'word/document.xml')
  const comments = readPart(file, 'word/comments.xml')
  assert.equal(result.verified, 1)
  assert.equal(result.missed, 0)
  assert.match(comments, /来自《客服\.md》第 1 页/)
  // 起批注的标记在加粗 run 前面，收批注的标记在正文 run 后面
  const start = xml.indexOf('<w:commentRangeStart')
  const bold = xml.indexOf('<w:b/>')
  const end = xml.indexOf('<w:commentRangeEnd')
  const body = xml.indexOf('包装破损')
  assert.ok(start >= 0 && end >= 0, xml)
  assert.ok(start < bold, `commentRangeStart 没在加粗 run 前面：${xml}`)
  assert.ok(end > body, `commentRangeEnd 没在正文 run 后面：${xml}`)
  // 批注锚住的字 = 整段去掉标记后的字
  const placed = JSON.parse(runPy(`import json, sys
from docx import Document
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
doc = Document(sys.argv[1])
found = []
for p in doc.paragraphs:
    anchored, started = [], False
    for node in p._p.iter():
        if node.tag == f"{W}commentRangeStart":
            started = True
        elif node.tag == f"{W}commentRangeEnd":
            started = False
        elif node.tag == f"{W}t" and started:
            anchored.append(node.text or "")
    found.append({"text": p.text, "anchored": "".join(anchored)})
json.dump(found, sys.stdout, ensure_ascii=False)`, [file]))
  assert.equal(placed.length, 1)
  assert.equal(placed[0].text, '客服：包装破损占客服投诉的一半，本周投诉17起，负责人马乔')
  assert.equal(placed[0].anchored, '客服：包装破损占客服投诉的一半，本周投诉17起，负责人马乔')
})

test('喂给模型的提示里写明：自己归纳的句子不要留标记', async () => {
  const material = join(root, '材料.md')
  writeFileSync(material, '包装破损占客服投诉的一半，本周投诉17起，负责人：马乔。\n')
  const ws = join(root, 'ws')
  mkdirSync(ws, { recursive: true })
  const fed = await prepareFeed({
    python, env, workspace: ws, dsoffice: join(root, 'missing.mjs'),
    materials: [material], utterance: '照范本出周报',
  })
  assert.match(fed.prompt, /每句来自材料的话，句末原样保留它用到的标记。/)
  assert.match(fed.prompt, /自己归纳、判断的句子（没有材料里的数字、人名或原话）不要留标记。/)
})

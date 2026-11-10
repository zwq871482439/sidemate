// 回话里的行内格式：** 粗体、` 代码、# 标题、- 列表；配不上的当普通字。

import assert from 'node:assert/strict'
import test from 'node:test'
import { parseInline, inlineSegments } from '../../app/task/inline.mjs'

// 一行的字拼起来，方便看内容
const words = (line) => line.map((one) => one.text).join('')

test('**字** 变粗体，星号不显示', () => {
  assert.deepEqual(parseInline('**要点**'), [[{ text: '要点', bold: true, code: false }]])
  assert.equal(words(parseInline('**要点**')[0]), '要点')
})

test('两段粗体各管各的', () => {
  assert.deepEqual(parseInline('**a** 和 **b**'), [
    [
      { text: 'a', bold: true, code: false },
      { text: ' 和 ', bold: false, code: false },
      { text: 'b', bold: true, code: false },
    ],
  ])
})

test('`字` 变代码，反引号不显示', () => {
  assert.deepEqual(parseInline('`文件名.docx`'), [[{ text: '文件名.docx', bold: false, code: true }]])
})

test('代码里的 ** 不解析，原样留着', () => {
  assert.deepEqual(parseInline('`a**b**`'), [[{ text: 'a**b**', bold: false, code: true }]])
})

test('行首 # 到 ###### 后面带空格，整行粗体、井号和空格去掉', () => {
  assert.deepEqual(parseInline('### 结构'), [[{ text: '结构', bold: true, code: false }]])
  assert.deepEqual(parseInline('# 一个'), [[{ text: '一个', bold: true, code: false }]])
  assert.deepEqual(parseInline('###### 六个'), [[{ text: '六个', bold: true, code: false }]])
})

test('行首 - * + 换成 · ，编号原样', () => {
  assert.deepEqual(parseInline('- 一、流派概览'), [[{ text: '· 一、流派概览', bold: false, code: false }]])
  assert.deepEqual(parseInline('* 甲'), [[{ text: '· 甲', bold: false, code: false }]])
  assert.deepEqual(parseInline('+ 乙'), [[{ text: '· 乙', bold: false, code: false }]])
  assert.deepEqual(parseInline('  - x'), [[{ text: '  · x', bold: false, code: false }]])
  assert.deepEqual(parseInline('1. x'), [[{ text: '1. x', bold: false, code: false }]])
})

test('配不上的标记当普通字', () => {
  assert.deepEqual(parseInline('**'), [[{ text: '**', bold: false, code: false }]])
  assert.deepEqual(parseInline('**没配对'), [[{ text: '**没配对', bold: false, code: false }]])
  assert.deepEqual(parseInline('`没配对'), [[{ text: '`没配对', bold: false, code: false }]])
  assert.deepEqual(parseInline('a ` b'), [[{ text: 'a ` b', bold: false, code: false }]])
})

test('链接、图片、表格、引用、斜体都不解析', () => {
  for (const one of [
    '[文字](http://x.cn/a)',
    '![图](http://x.cn/a.png)',
    '| a | b |',
    '> 引用',
    '*斜体*',
  ]) {
    assert.deepEqual(parseInline(one), [[{ text: one, bold: false, code: false }]], one)
  }
})

test('像 HTML 的字原样当字，不当标签', () => {
  for (const one of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<b>这不是粗体</b>']) {
    assert.deepEqual(parseInline(one), [[{ text: one, bold: false, code: false }]], one)
  }
})

test('空字符串和只有几个字符都不炸', () => {
  assert.deepEqual(parseInline(''), [[]])
  assert.deepEqual(parseInline('**'), [[{ text: '**', bold: false, code: false }]])
  assert.deepEqual(parseInline('`'), [[{ text: '`', bold: false, code: false }]])
})

test('换行照旧：几行还是几行，行里不塞换行', () => {
  assert.deepEqual(parseInline('一\n二').length, 2)
  assert.deepEqual(parseInline('一\n二'), [
    [{ text: '一', bold: false, code: false }],
    [{ text: '二', bold: false, code: false }],
  ])
  assert.deepEqual(parseInline('a\n'), [[{ text: 'a', bold: false, code: false }], []])
})

test('多行混着来：粗体、代码、标题、列表各一行', () => {
  const lines = parseInline('**写完了**，产出是 `中医文献综述.docx`。\n### 结构\n- 一、流派概览\n1. 表格 5 张\n<b>这不是粗体</b>')
  assert.equal(lines.length, 5)
  assert.equal(words(lines[0]), '写完了，产出是 中医文献综述.docx。')
  assert.equal(lines[0][0].bold, true)
  assert.equal(lines[0].some((one) => one.code), true)
  assert.equal(words(lines[1]), '结构')
  assert.equal(lines[1][0].bold, true)
  assert.equal(words(lines[2]), '· 一、流派概览')
  assert.equal(words(lines[3]), '1. 表格 5 张')
  assert.equal(words(lines[4]), '<b>这不是粗体</b>')
})

test('摊平以后行与行之间正好一个换行，不多空行', () => {
  const segs = inlineSegments('一\n二')
  assert.equal(segs.map((one) => one.text).join(''), '一\n二')
  assert.equal(segs.filter((one) => one.text === '\n').length, 1)
  const segs2 = inlineSegments('**写完了**\n- 二')
  assert.equal(segs2.map((one) => one.text).join(''), '写完了\n· 二')
})

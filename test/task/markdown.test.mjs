// 回话里的 Markdown 摊成块：标题、列表、表格、粗体、代码、链接、分隔线；不露星号。

import assert from 'node:assert/strict'
import test from 'node:test'
import { httpUrl, markdownBlocks } from '../../app/task/markdown.mjs'

const text = (blocks) => blocks.map((one) => one.segs.map((seg) => seg.text).join('')).join('')

test('标题：井号去掉，整行粗体', () => {
  const blocks = markdownBlocks('### 结构')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'h')
  assert.equal(blocks[0].level, 3)
  assert.equal(text(blocks), '结构')
})

test('列表：横排成 ul，编号成 ol', () => {
  const ul = markdownBlocks('- 一、流派概览\n- 二、病机')
  assert.equal(ul.length, 1)
  assert.equal(ul[0].type, 'ul')
  assert.equal(ul[0].items.length, 2)
  assert.equal(ul[0].items[0].map((one) => one.text).join(''), '一、流派概览')
  const ol = markdownBlocks('1. 表格 5 张\n2. 图 2 张')
  assert.equal(ol[0].type, 'ol')
  assert.equal(ol[0].items.length, 2)
})

test('表格：表头一行、数据若干行', () => {
  const blocks = markdownBlocks('| 文件 | 页 |\n| --- | --- |\n| 甲 | 3 |\n| 乙 | 5 |')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'table')
  assert.deepEqual(blocks[0].head.map((cell) => cell.map((one) => one.text).join('')), ['文件', '页'])
  assert.equal(blocks[0].rows.length, 2)
  assert.deepEqual(blocks[0].rows[1].map((cell) => cell.map((one) => one.text).join('')), ['乙', '5'])
})

test('粗体和代码：星号、反引号都不露出来', () => {
  const blocks = markdownBlocks('**写完了**，产出是 `中医文献综述.docx`。')
  const all = blocks.flatMap((one) => one.segs)
  assert.equal(all.some((one) => one.text.includes('*')), false)
  assert.equal(all.some((one) => one.text.includes('`')), false)
  assert.equal(all.find((one) => one.bold).text, '写完了')
  assert.equal(all.find((one) => one.code).text, '中医文献综述.docx')
})

test('段落和换行：空行分段，行内换行留着', () => {
  const blocks = markdownBlocks('第一段\n还是第一段\n\n第二段')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'p')
  assert.equal(blocks[1].type, 'p')
  assert.equal(blocks[0].segs.map((one) => one.text).join(''), '第一段\n还是第一段')
})

test('像 HTML 的字原样当字；代码块原样留着', () => {
  const html = markdownBlocks('<b>这不是粗体</b>')
  assert.equal(html[0].type, 'p')
  assert.equal(text(html), '<b>这不是粗体</b>')
  const code = markdownBlocks('```\nprint(1)\n```')
  assert.equal(code[0].type, 'code')
  assert.equal(code[0].text, 'print(1)')
})

test('空字符串不炸', () => {
  assert.deepEqual(markdownBlocks(''), [])
  assert.deepEqual(markdownBlocks(null), [])
})

test('链接：只显示文字，地址是原网址，前后的字都在', () => {
  const url = 'https://www.chinanews.com.cn/sh/2026/11-10/10294571.shtml'
  const blocks = markdownBlocks(`看[新华社报道](${url})了`)
  const all = blocks.flatMap((one) => one.segs ?? [])
  const link = all.find((one) => one.link)
  assert.equal(link.text, '新华社报道')
  assert.equal(link.link, url)
  assert.equal(all.map((one) => one.text).join(''), '看新华社报道了')
  // 粗体里的链接还是链接，也还是粗体
  const bold = markdownBlocks('**[报道](https://example.com/a)**').flatMap((one) => one.segs).find((one) => one.link)
  assert.equal(bold.bold, true)
  assert.equal(bold.link, 'https://example.com/a')
})

test('链接：javascript: 和 file: 不成链接，整串当普通字', () => {
  const blocks = markdownBlocks('[点我](javascript:alert(1)) 和 [文件](file:///C:/秘密.txt)')
  const all = blocks.flatMap((one) => one.segs ?? [])
  assert.equal(all.some((one) => one.link), false)
  assert.equal(all.map((one) => one.text).join(''), '[点我](javascript:alert(1)) 和 [文件](file:///C:/秘密.txt)')
})

test('裸网址：成链接，显示原网址；句尾的句读不算进网址', () => {
  const blocks = markdownBlocks('详见 https://example.com/a?b=1#c 再看 https://example.com/长。')
  const all = blocks.flatMap((one) => one.segs ?? [])
  const links = all.filter((one) => one.link)
  assert.equal(links.length, 2)
  assert.equal(links[0].text, 'https://example.com/a?b=1#c')
  assert.equal(links[0].link, 'https://example.com/a?b=1#c')
  assert.equal(links[1].text, 'https://example.com/长')
  assert.equal(links[1].link, 'https://example.com/长')
  assert.equal(all.map((one) => one.text).join(''), '详见 https://example.com/a?b=1#c 再看 https://example.com/长。')
})

test('分隔线：单独一行的 ---、***、___ 不露字符', () => {
  assert.deepEqual(markdownBlocks('---'), [{ type: 'hr' }])
  for (const bar of ['---', '***', '___', '----------']) {
    assert.deepEqual(markdownBlocks(`上段\n\n${bar}\n\n下段`).map((one) => one.type), ['p', 'hr', 'p'])
    assert.deepEqual(markdownBlocks(`上段\n${bar}\n下段`).map((one) => one.type), ['p', 'hr', 'p'])
  }
})

test('开链接：主进程那边只认 http(s)，带空白和控制字符的一律不开', () => {
  // 算数的：返回解析器规范化后的 href，不是原字符串
  assert.equal(httpUrl('https://example.com/a'), 'https://example.com/a')
  assert.equal(httpUrl('http://example.com'), 'http://example.com/')
  assert.equal(httpUrl('HTTPS://EXAMPLE.COM'), 'https://example.com/')
  // 带空格、换行、控制字符的一律不开：new URL 会默默吞掉这些，得先自己查
  assert.equal(httpUrl('https://evil .com'), null)
  assert.equal(httpUrl('https://evil\n.com'), null)
  assert.equal(httpUrl('  https://example.com '), null)
  assert.equal(httpUrl('https://evil\u0000.com'), null)
  // 没有 // 的 https:evil 会被 new URL 拼成 https://evil/，得先看开头
  assert.equal(httpUrl('https:evil'), null)
  assert.equal(httpUrl('javascript:alert(1)'), null)
  assert.equal(httpUrl('file:///C:/x.txt'), null)
  assert.equal(httpUrl(''), null)
  assert.equal(httpUrl(null), null)
})

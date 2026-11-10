// 回话里的 Markdown：标题、段落、列表、表格、引用、代码块、分隔线，加上行内的粗体、代码和链接。
// 纯函数：进一段字，出一批块；页面那边只管建节点，不碰 HTML。
// 认不出来的（图片、斜体）当普通字，不解析；链接只认 http(s)，别的协议整串当普通字。

import { inlineSegments } from './inline.mjs'

const HEAD = /^(#{1,6})\s+(.*)$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const ORDERED = /^\s*\d+[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const FENCE = /^\s*```/
const RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
// 单独一行的 ---、***、___：分隔线，不露字符
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
// [文字](网址) 优先，其次光秃秃的 http(s) 网址；网址里不带空格、尖括号和括号
const LINK = /\[([^\]\n]*)\]\(([^()\s]+)\)|(https?:\/\/[^\s<>()]+)/gi
// 网址尾巴上的句读不算网址的一部分；右括号要配上对才留下
const TAIL = /[.,;:!?、。，；：！？"”'’』」》]/

// 链接只认 http:// 和 https://，两头（摊开、主进程开浏览器前）都用这一个函数。
// 先看开头是不是 http(s)://，再看带不带空白或控制字符，再用 new URL 解析：
// 解析不动、协议不对的一律不算；算数的返回解析器规范化后的 href，
// 交给 shell.openExternal 的是它，不是原字符串。
export function httpUrl(candidate) {
  const url = String(candidate ?? '')
  if (!/^https?:\/\//i.test(url)) return null
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return null
  let parsed
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.href
}

// 光秃秃的网址尾巴：句读去掉，没配上的右括号也去掉
function trimTail(url) {
  let end = url.length
  while (end > 0) {
    const ch = url[end - 1]
    const head = url.slice(0, end)
    const opens = (head.match(/[(（]/g) || []).length
    const closes = (head.match(/[)）]/g) || []).length
    if (!TAIL.test(ch) && !((ch === ')' || ch === '）') && closes > opens)) break
    end -= 1
  }
  return url.slice(0, end)
}

// 一段字拆成普通片段和链接片段：{ text } 或 { text, link }；不认的协议整串留在普通片段里
function splitLinks(text) {
  const out = []
  let last = 0
  for (const hit of text.matchAll(LINK)) {
    const bare = hit[3] !== undefined
    const url = bare ? trimTail(hit[3]) : httpUrl(hit[2])
    if (!url) continue
    if (hit.index > last) out.push({ text: text.slice(last, hit.index) })
    out.push({ text: bare || !hit[1] ? url : hit[1], link: url })
    last = hit.index + (bare ? url.length : hit[0].length)
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out.length ? out : [{ text }]
}

// 行内片段过一遍链接：代码片段里的网址不当链接，其余的拆出 [文字](网址) 和裸网址
function withLinks(list) {
  const out = []
  for (const one of list) {
    if (one.code || !one.text) { out.push(one); continue }
    for (const piece of splitLinks(one.text)) {
      out.push(piece.link
        ? { text: piece.text, bold: one.bold, code: false, link: piece.link }
        : { text: piece.text, bold: one.bold, code: false })
    }
  }
  return out
}

const segs = (text) => withLinks(inlineSegments(String(text ?? '')))

// 一行表格拆成格子：去掉首尾的空格子
function cells(line) {
  const parts = String(line).split('|')
  if (parts.length && parts[0].trim() === '') parts.shift()
  if (parts.length && parts[parts.length - 1].trim() === '') parts.pop()
  return parts.map((one) => one.trim())
}

const isTable = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && RULE.test(lines[i + 1])

// 一段话摊成 [{ type, ... }]：
// h 标题 · p 段落 · ul / ol 列表 · table 表格 · quote 引用 · code 代码块 · hr 分隔线
export function markdownBlocks(text) {
  const lines = String(text ?? '').split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (FENCE.test(line)) {
      const buf = []
      i += 1
      while (i < lines.length && !FENCE.test(lines[i])) { buf.push(lines[i]); i += 1 }
      i += 1
      blocks.push({ type: 'code', text: buf.join('\n') })
      continue
    }
    if (isTable(lines, i)) {
      const head = cells(lines[i])
      i += 2
      const rows = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') { rows.push(cells(lines[i])); i += 1 }
      blocks.push({ type: 'table', head: head.map(segs), rows: rows.map((row) => row.map(segs)) })
      continue
    }
    if (HR.test(line)) { blocks.push({ type: 'hr' }); i += 1; continue }
    const head = HEAD.exec(line)
    if (head) { blocks.push({ type: 'h', level: head[1].length, segs: segs(head[2]) }); i += 1; continue }
    const bullet = BULLET.exec(line)
    if (bullet) {
      const items = []
      while (i < lines.length) {
        const one = BULLET.exec(lines[i])
        if (!one) break
        items.push(segs(one[1]))
        i += 1
      }
      blocks.push({ type: 'ul', items })
      continue
    }
    const ordered = ORDERED.exec(line)
    if (ordered) {
      const items = []
      while (i < lines.length) {
        const one = ORDERED.exec(lines[i])
        if (!one) break
        items.push(segs(one[1]))
        i += 1
      }
      blocks.push({ type: 'ol', items })
      continue
    }
    const quote = QUOTE.exec(line)
    if (quote) { blocks.push({ type: 'quote', segs: segs(quote[1]) }); i += 1; continue }
    if (line.trim() === '') { i += 1; continue }
    const buf = []
    while (i < lines.length && lines[i].trim() !== '' && !HEAD.test(lines[i]) && !BULLET.test(lines[i])
      && !ORDERED.test(lines[i]) && !QUOTE.test(lines[i]) && !HR.test(lines[i]) && !FENCE.test(lines[i]) && !isTable(lines, i)) {
      buf.push(lines[i])
      i += 1
    }
    if (!buf.length) { i += 1; continue }
    blocks.push({ type: 'p', segs: segs(buf.join('\n')) })
  }
  return blocks
}

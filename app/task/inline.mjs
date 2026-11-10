// 回话里的行内格式：只认 **粗体**、`代码`、# 标题、- 列表这四样。
// 别的（链接、图片、表格、引用、斜体）都当普通字，不解析。
// 纯函数：进一段字，出一批片段，页面那边只管建节点，不碰 HTML。

// 行首缩进留着、井号和后面的空格去掉，整行粗体
const HEADING = /^([ \t]*)(#{1,6})[ \t]+(.*)$/
// 行首缩进留着、- * + 换成 ·
const BULLET = /^([ \t]*)([-*+])[ \t]+(.*)$/

// 一段字拆成 [{ text, bold, code }]：bold 是整段粗、code 是整段代码
function inline(text, boldBase) {
  const out = []
  let buf = ''
  const flush = () => {
    if (!buf) return
    out.push({ text: buf, bold: boldBase === true, code: false })
    buf = ''
  }
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      if (end !== -1) {
        flush()
        // 代码里的 ** 不再看；粗体里的代码也不加粗
        out.push({ text: text.slice(i + 1, end), bold: false, code: true })
        i = end + 1
        continue
      }
      buf += ch
      i += 1
      continue
    }
    if (ch === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2)
      if (end !== -1) {
        flush()
        for (const one of inline(text.slice(i + 2, end), true)) out.push(one)
        i = end + 2
        continue
      }
      buf += '**'
      i += 2
      continue
    }
    buf += ch
    i += 1
  }
  flush()
  return out
}

// 整段话按行分好；一行是 [{ text, bold, code }] 的数组
export function parseInline(text) {
  const src = typeof text === 'string' ? text : String(text ?? '')
  return src.split('\n').map((line) => {
    const head = HEADING.exec(line)
    if (head) return inline(head[1] + head[3], true)
    const bullet = BULLET.exec(line)
    if (bullet) return inline(bullet[1] + '· ' + bullet[3], false)
    return inline(line, false)
  })
}

// 一段话摊平成片段序列，行与行之间用 \n 隔开（行数、换行照原样）
export function inlineSegments(text) {
  const lines = parseInline(text)
  const out = []
  lines.forEach((line, index) => {
    if (index > 0) out.push({ text: '\n', bold: false, code: false })
    for (const one of line) out.push(one)
  })
  return out
}

// 路径和名字的小工具：窗口标题、顶栏、产出卡都要用。纯函数，不碰文件。

import { extname, resolve } from 'node:path'

const isWin = process.platform === 'win32'

// 两条路径算不算同一条：resolve 后比，win32 再转小写
export function key(p) {
  const norm = resolve(String(p))
  return isWin ? norm.toLowerCase() : norm
}

export function baseName(p) {
  const s = String(p).replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i === -1 ? s : s.slice(i + 1)
}

function width(text) {
  let w = 0
  for (const ch of text) w += ch.codePointAt(0) <= 0x7f ? 1 : 2
  return w
}

function take(chars, budget) {
  const out = []
  let used = 0
  for (const ch of chars) {
    const w = ch.codePointAt(0) <= 0x7f ? 1 : 2
    if (used + w > budget) break
    out.push(ch)
    used += w
  }
  return out
}

// 从中间省：保头尾整字、保扩展名，省略号算 2
export function fitName(name, budget) {
  const text = String(name)
  if (width(text) <= budget) return text
  let ext = extname(text)
  if (Array.from(ext).length > 8) ext = ''
  const avail = budget - width(ext) - 2
  if (avail < 1) return '…'
  const headLen = Math.ceil(avail * 2 / 3)
  const body = Array.from(text.slice(0, text.length - ext.length))
  const head = take(body, headLen)
  const tail = take(body.slice().reverse(), avail - headLen).reverse()
  return head.join('') + '…' + tail.join('') + ext
}

// 路径从中间省：保第一段和最后一段
export function fitPath(path, budget) {
  const text = String(path)
  if (width(text) <= budget) return text
  const sep = text.includes('\\') ? '\\' : '/'
  const parts = text.split(sep).filter((part) => part !== '')
  if (parts.length < 3) return text
  return parts[0] + sep + ' … ' + sep + parts[parts.length - 1]
}

// 最近的文件夹：新的在前，最多 max 个
export function addRecent(list, dir, max = 5) {
  const mine = key(dir)
  const rest = (Array.isArray(list) ? list : []).filter((item) => key(item) !== mine)
  return [dir, ...rest].slice(0, max)
}

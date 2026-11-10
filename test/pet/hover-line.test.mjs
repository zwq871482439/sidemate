// 悬停冒出来的那一行：
// - 干活中只说「正在工作 · x 秒」
// - 字的起点在眼睛右边，还留了空
// - 字太长收成省略号，不裁
// 纯函数和样式检查，不拉起 Electron。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { bubbleOf } from '../../app/pet/bubble.mjs'
import { bubbleBoxWidth, theme } from '../../app/pet/theme.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(here, '../../app/pet/pet.html'), 'utf8')
const page = readFileSync(join(here, '../../app/pet/pet.js'), 'utf8')

// 样式块里挑出某一条规则
function rule(selector) {
  const found = html.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))
  assert.ok(found, `样式里没有 ${selector}`)
  return found[1]
}

test('干活中：只说「正在工作 · x 秒」，秒数自己走', () => {
  const line = bubbleOf({ mode: 'work', elapsed: '42 秒' })
  assert.equal(line.text, '正在工作 · 42 秒')
  assert.match(line.text, /^正在工作 · (\d+ 分 \d+ 秒|\d+ 秒)$/)
  assert.equal(bubbleOf({ mode: 'work', elapsed: '1 分 34 秒' }).text, '正在工作 · 1 分 34 秒')
  // 别的状态的字不变
  assert.equal(bubbleOf({ mode: 'done', artifact: '综述.docx' }).text, '做完了 · 点开看看')
  assert.equal(bubbleOf({ mode: 'look', message: '要不要再短一点？' }).text, '等你一句话：要不要再短一点？')
  assert.equal(bubbleOf({ mode: 'fail', message: '余额不够' }).text, '没干成：余额不够')
})

test('字从表情区右边开始，中间留了空', () => {
  // 左边 56 宽是表情区，中间空 8，字从 x=64 开始
  assert.equal(theme.eyeZone, 56)
  assert.equal(theme.zoneGap, 8)
  assert.ok(theme.eyeZone + theme.zoneGap >= 56 + 8)
  const bubble = rule('#bubble')
  assert.match(bubble, /left:\s*calc\(var\(--eye-zone\) \+ var\(--zone-gap\)\)/)
  // 右边留 16
  assert.ok(theme.padRight >= 16)
  assert.match(bubble, /right:\s*var\(--pad-right\)/)
  // 字在文字区里居中
  assert.match(bubble, /justify-content:\s*center/)
  assert.doesNotMatch(bubble, /justify-content:\s*flex-start/)
  assert.doesNotMatch(bubble, /justify-content:\s*flex-end/)
})

test('量字：整组一起量，窗口不会窄 8px', () => {
  // 量的时候把「字 + 空 + 能点的」整组搬过去：
  // 只搬字会少 8px（空的那一组也算一个间距），窗口就窄 8px，
  // 靠右排的字会往左溢出去，第一个字被裁掉
  assert.match(page, /bubbleText\.cloneNode\(true\),\s*bubbleActions\.cloneNode\(true\)/)
})

test('字太长：宽度封顶，字上出省略号，不裁', () => {
  const short = bubbleBoxWidth(80)
  assert.equal(short, 80 + theme.eyeZone + theme.zoneGap + theme.textPad * 2 + theme.padRight)
  const long = bubbleBoxWidth(2000)
  assert.equal(long, theme.bubbleHardMax)
  assert.ok(theme.bubbleHardMax - theme.eyeZone - theme.zoneGap - theme.padRight > 0)
  const text = rule('#bubble-text')
  assert.match(text, /text-overflow:\s*ellipsis/)
  assert.match(text, /overflow:\s*hidden/)
  // 整行不许超出窗口
  assert.match(rule('#bubble-inner'), /max-width:\s*100%/)
})

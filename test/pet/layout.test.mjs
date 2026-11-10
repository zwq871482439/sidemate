// 小岛的左右分区和字号缩放：
// - 收着时整条都是表情区，眼睛在整条正中
// - 冒一行时左边一段是表情区，右边是文字区，字在文字区里居中
// - 字号是一个变量：小岛高度、眼睛、表情区宽度、文字区边距都从它算出来
// 纯函数和样式检查，不拉起 Electron。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { BASE, expandedWidth, layoutFor, textZoneWidth } from '../../app/pet/layout.mjs'
import { bubbleBoxWidth, theme } from '../../app/pet/theme.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(here, '../../app/pet/pet.html'), 'utf8')

// 样式块里挑出某一条规则
function rule(selector) {
  const found = html.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))
  assert.ok(found, `样式里没有 ${selector}`)
  return found[1]
}

test('收着的时候整条都是表情区，眼睛在整条正中', () => {
  const box = layoutFor(13)
  assert.equal(box.island, 112)
  assert.equal(box.height, 30)
  // 眼睛那一对在 112 的正中：中心 56
  assert.equal((46 + 66) / 2, box.island / 2)
  // 冒一行时表情区是左边 56，眼睛在它正中（中心 28），比整条正中左移 28
  assert.equal(box.eyeZone, 56)
  assert.equal(box.eyeShift, 28)
  assert.equal(box.island / 2 - box.eyeShift, box.eyeZone / 2)
})

test('冒一行：左边表情区，右边文字区，宽度跟着字走', () => {
  const box = layoutFor(13)
  // 文字区：字宽 + 左右各 8
  assert.equal(textZoneWidth(100, box), 116)
  // 整条：表情区 56 + 空 8 + 文字区 + 右边留 16
  assert.equal(expandedWidth(100, box), 56 + 8 + 116 + 16)
  assert.equal(expandedWidth(100, box), 196)
  // 两区之间只留空、不画线
  assert.equal(box.zoneGap, 8)
  assert.doesNotMatch(html, /#eyes[^{]*\{[^}]*border[^}]*solid/)
  // 字在文字区里居中
  assert.match(rule('#bubble'), /justify-content:\s*center/)
  assert.doesNotMatch(rule('#bubble'), /justify-content:\s*flex-start/)
  assert.doesNotMatch(rule('#bubble'), /justify-content:\s*flex-end/)
})

test('冒一行：眼睛在左边表情区里，不压着字', () => {
  const bubble = rule('#bubble')
  // 字从表情区右边开始：表情区 + 空
  assert.match(bubble, /left:\s*calc\(var\(--eye-zone\) \+ var\(--zone-gap\)\)/)
  // 右边留 16
  assert.match(bubble, /right:\s*var\(--pad-right\)/)
  // 展开时眼睛往左挪 28
  assert.match(html, /body\[data-scene="expanded"\] #eye-shift[^{]*\{[^}]*translateX\(calc\(var\(--eye-shift\) \* -1px\)\)/)
})

test('字号改了：小岛高度、表情区宽度、边距都等比放大', () => {
  const box = layoutFor(16)
  // 16 号字配 37 高（round(16 × 30 / 13)）
  assert.equal(box.height, 37)
  // 表情区 56 → 69（round(56 × 16 / 13)）
  assert.equal(box.eyeZone, 69)
  // 整条也等比放大
  assert.equal(box.island, Math.round(112 * 16 / 13))
  // 边距跟着放大
  assert.equal(box.zoneGap, Math.round(8 * 16 / 13))
  assert.equal(box.padRight, Math.round(16 * 16 / 13))
  assert.equal(box.textPad, Math.round(8 * 16 / 13))
  // 眼睛也跟着放大
  assert.ok(box.eyeRadius > BASE.eyeRadius)
  // 主题里的字号是一个变量
  assert.equal(theme.font, 13)
  assert.equal(theme.height, 30)
  assert.equal(theme.eyeZone, 56)
})

test('字号变了，冒出来的那一行也跟着变宽', () => {
  assert.equal(bubbleBoxWidth(80), 80 + 56 + 8 + 16 + 16)
  assert.equal(bubbleBoxWidth(2000), theme.bubbleHardMax)
})

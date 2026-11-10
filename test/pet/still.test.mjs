// 关了「显示动画」（prefers-reduced-motion）：
// 不扫、不眨、不抬头，直接是往下看的静止帧（设计稿第三节「别的」）。
// 纯函数和样式检查，不拉起 Electron。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(here, '../../app/pet/pet.html'), 'utf8')
const page = readFileSync(join(here, '../../app/pet/pet.js'), 'utf8')

test('样式里认 prefers-reduced-motion：动画和过渡都不动', () => {
  assert.match(html, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?animation: none !important/)
  assert.match(html, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?transition-duration: 0s !important/)
})

test('页面认 prefers-reduced-motion：不安排扫、眨、抬头', () => {
  assert.match(page, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/)
  // still() 一为真，眨眼和抬头都不排
  assert.match(page, /const still = \(\) => forcedStill \|\| media\.matches/)
  assert.match(page, /function scheduleBlink\(\) \{[\s\S]*?if \(still\(\)\) return/)
  assert.match(page, /function scheduleThink\(\) \{[\s\S]*?if \(mode !== 'work' \|\| still\(\)\) return/)
  // 眨眼本身也守着 still
  assert.match(page, /function blink\(\) \{[\s\S]*?if \(still\(\)\) return/)
})

test('不动的时候就是往下看的静止帧', () => {
  // 干活中的形状是扁圆角条（往下看），不靠动画撑着
  assert.match(html, /class="sh sh-down" x="41" y="16" width="10" height="6" rx="3"/)
  assert.match(html, /body\[data-mode="work"\] #eye-scan \{ animation: eyes-scan/)
})

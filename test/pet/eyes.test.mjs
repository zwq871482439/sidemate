// 五个状态各是什么眼神（A 套）：
// 形状照 1:1 的图：收着时两只眼睛中心在 x=46、x=66、y=15。
// 干活的动画：往左看 → 停 0.5 秒 → 0.4 秒滑到右 → 停 0.5 秒 → 滑回左；3–5 秒眨一次；6–8 秒抬头想一下。
// 纯函数，不碰 electron，好测。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { A_SET, BLINK, EYE_MODES, SCAN, THINK, eyeArc, eyeLine, eyeOf, eyeXs } from '../../app/pet/eyes.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(here, '../../app/pet/pet.html'), 'utf8')

test('五个状态各是什么眼神', () => {
  assert.equal(eyeOf('idle'), 'open')
  assert.equal(eyeOf('work'), 'down')
  assert.equal(eyeOf('look'), 'wide')
  assert.equal(eyeOf('done'), 'smile')
  assert.equal(eyeOf('fail'), 'flat')
  assert.deepEqual(Object.keys(EYE_MODES), ['idle', 'work', 'look', 'done', 'fail'])
})

test('不认的状态当睁眼', () => {
  assert.equal(eyeOf(''), 'open')
  assert.equal(eyeOf('nope'), 'open')
})

test('A 套：待命是圆眼 r=5.3，眼睛中心在 x=46、x=66、y=15', () => {
  assert.equal(A_SET.radius, 5.3)
  assert.deepEqual(A_SET.xs, [46, 66])
  assert.equal(A_SET.y, 15)
  assert.match(html, /class="sh sh-round" cx="46" cy="15" r="5\.3"/)
  assert.match(html, /class="sh sh-round" cx="66" cy="15" r="5\.3"/)
})

test('A 套：干活中是 10×6 的扁圆角条，中心 y=19（往下 4）', () => {
  assert.equal(A_SET.down.w, 10)
  assert.equal(A_SET.down.h, 6)
  assert.equal(A_SET.down.y, 19)
  assert.equal(A_SET.down.y - A_SET.y, 4)
  assert.match(html, /class="sh sh-down" x="41" y="16" width="10" height="6" rx="3"/)
  assert.match(html, /class="sh sh-down" x="61" y="16" width="10" height="6" rx="3"/)
})

test('A 套：要你看一眼是 r=7 的圆眼加右上角红点（x=96, y=8.7, r=3）', () => {
  assert.equal(A_SET.wideRadius, 7)
  assert.deepEqual(A_SET.dot, { x: 96, y: 8.7, r: 3 })
  assert.match(html, /class="sh sh-wide" cx="46" cy="15" r="7"/)
  assert.match(html, /class="sh sh-wide" cx="66" cy="15" r="7"/)
})

test('A 套：做完了是向上拱的弧，不是填充的半圆', () => {
  assert.equal(A_SET.arc.width, 2.3)
  assert.equal(eyeArc(46), 'M 41.3 17 Q 46 10.3 50.7 17')
  assert.equal(eyeArc(66), 'M 61.3 17 Q 66 10.3 70.7 17')
  // 线：不填充、圆头、2.3 宽
  assert.match(html, /\.sh-arc, \.sh-line \{[^}]*fill: none[^}]*stroke-width: 2\.3[^}]*stroke-linecap: round/)
  assert.match(html, /class="sh sh-arc" d="M 41\.3 17 Q 46 10\.3 50\.7 17"/)
  assert.match(html, /class="sh sh-arc" d="M 61\.3 17 Q 66 10\.3 70\.7 17"/)
})

test('A 套：没干成是一条平线', () => {
  assert.equal(A_SET.line.width, 2.3)
  assert.equal(eyeLine(46), 'M 41.3 15 L 50.7 15')
  assert.equal(eyeLine(66), 'M 61.3 15 L 70.7 15')
  assert.match(html, /class="sh sh-line" d="M 41\.3 15 L 50\.7 15"/)
  assert.match(html, /class="sh sh-line" d="M 61\.3 15 L 70\.7 15"/)
})

test('眼睛在哪儿：收着在整条正中，冒一行在左边表情区正中', () => {
  assert.deepEqual(eyeXs('strip'), [46, 66])
  assert.deepEqual(eyeXs('expanded'), [18, 38])
  // 展开时从整条正中滑到左边 56 的正中：左移 28
  assert.equal((46 + 66) / 2 - (18 + 38) / 2, 28)
})

test('干活中：往左看 → 停 0.5 秒 → 0.4 秒滑到右 → 停 0.5 秒 → 滑回左', () => {
  assert.equal(SCAN.holdMs, 500)
  assert.equal(SCAN.slideMs, 400)
  assert.equal(SCAN.curve, 'ease-in-out')
  assert.equal(SCAN.cycleMs, 1800)
  assert.ok(SCAN.px > 0)
  // 样式里的关键帧：两个停、两个滑
  const frames = html.match(/@keyframes eyes-scan \{([\s\S]*?)\n  \}/)
  assert.ok(frames, '样式里没有 eyes-scan')
  assert.match(frames[1], /0%\s*\{[^}]*translateX\(calc\(var\(--scan\) \* -1px\)\)[^}]*animation-timing-function: linear/)
  assert.match(frames[1], /27\.778%\s*\{[^}]*animation-timing-function: ease-in-out/)
  assert.match(frames[1], /50%\s*\{[^}]*animation-timing-function: linear/)
  assert.match(frames[1], /77\.778%\s*\{[^}]*animation-timing-function: ease-in-out/)
})

test('眨眼：压到 1/10，80ms 闭 + 140ms 睁；干活中 3–5 秒一次', () => {
  assert.equal(BLINK.closeMs, 80)
  assert.equal(BLINK.openMs, 140)
  assert.equal(BLINK.minMs, 3000)
  assert.equal(BLINK.maxMs, 5000)
  assert.match(html, /#eyes\.blink [\s\S]*?scaleY\(0\.1\)/)
})

test('抬头想一下：6–8 秒一次，圆眼往上 2px，停 0.6 秒', () => {
  assert.equal(THINK.minMs, 6000)
  assert.equal(THINK.maxMs, 8000)
  assert.equal(THINK.holdMs, 600)
  assert.equal(THINK.up, 2)
  assert.match(html, /body\[data-thinking="1"\] #eyes \.eye \{ transform: translateY\(-2px\); \}/)
})

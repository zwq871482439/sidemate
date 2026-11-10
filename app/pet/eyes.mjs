// 五个状态各是什么眼神（设计稿第二节「五个状态」、第三节③「眼睛换神情」）。
// 待命睁眼 · 干活往下看 · 要你看一眼睁大 · 做完了笑眼 · 没干成平线。
// A 套的形状：1:1（小岛 112×30）时两只眼睛中心在 x=46、x=66、y=15。
// 纯函数，不碰 electron，好测。

import { BASE } from './layout.mjs'

export const EYE_MODES = {
  idle: 'open',
  work: 'down',
  look: 'wide',
  done: 'smile',
  fail: 'flat',
}

// A 套：五个状态的眼睛长什么样（数字都是 1:1 的）
export const A_SET = {
  y: BASE.eyeY, // 15
  xs: [46, 66], // 收着时两只眼睛的中心
  gap: BASE.eyeGap, // 20
  radius: BASE.eyeRadius, // 5.3：待命的圆眼
  wideRadius: 7, // 要你看一眼：圆眼大一号
  down: { w: 10, h: 6, y: 19 }, // 干活中：10×6 的扁圆角条，中心 y=19（往下 4）
  arc: { spread: 4.7, from: 17, control: 10.3, width: 2.3 }, // 做完了：向上拱的弧
  line: { spread: 4.7, y: 15, width: 2.3 }, // 没干成：一条平线
  dot: { x: 96, y: 8.7, r: 3 }, // 要你看一眼：右上角的红点
}

export function eyeOf(mode) {
  return EYE_MODES[mode] || 'open'
}

// 两只眼睛中心在哪儿：收着时在整条正中，冒一行时在左边表情区正中
export function eyeXs(scene) {
  const center = scene === 'expanded' ? BASE.eyeZone / 2 : BASE.island / 2
  return [center - A_SET.gap / 2, center + A_SET.gap / 2]
}

// 做完了：M(x-4.7, 17) Q(x, 10.3) (x+4.7, 17)
export function eyeArc(x) {
  const { spread, from, control } = A_SET.arc
  return `M ${x - spread} ${from} Q ${x} ${control} ${x + spread} ${from}`
}

// 没干成：(x-4.7, 15) → (x+4.7, 15)
export function eyeLine(x) {
  const { spread, y } = A_SET.line
  return `M ${x - spread} ${y} L ${x + spread} ${y}`
}

// 干活中：往左看 → 停 0.5 秒 → 0.4 秒 ease-in-out 滑到右 → 停 0.5 秒 → 滑回左
export const SCAN = { holdMs: 500, slideMs: 400, px: 8, curve: 'ease-in-out' }
// 一个来回：两个 0.5 秒的停 + 两个 0.4 秒的滑
SCAN.cycleMs = SCAN.holdMs * 2 + SCAN.slideMs * 2

// 眨眼：压到 1/10，80ms 闭 + 140ms 睁；干活中 3–5 秒一次
export const BLINK = { closeMs: 80, openMs: 140, minMs: 3000, maxMs: 5000 }

// 抬头想一下：圆眼、往上 2px，停 0.6 秒再低头接着扫；6–8 秒一次
export const THINK = { minMs: 6000, maxMs: 8000, holdMs: 600, up: 2 }

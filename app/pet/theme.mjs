// 小岛：墨色小条 + 一双眼睛。尺寸、时长、曲线照设计稿第二节「1. 小岛」和第三节「动画」。
// 字号是一个变量：theme.font = 13 时小岛 112×30、表情区 56；
// 字号改大，小岛高度、眼睛、表情区宽度、文字区边距都等比放大，没有写死的 30 / 56。

import { BASE, layoutFor } from './layout.mjs'

export const theme = {
  // 字号：13 号字配 30 高；别的尺寸都从它算出来
  font: BASE.font,
  // 字用 Noto Sans SC，没有就回退系统字体
  fontStack: '"Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif',

  // 颜色：小条深墨色，眼睛白，红点只给「要你看一眼」
  ink: '#1f1d1a',
  eye: '#f5f1e8',
  accent: '#c53a22',
  text: '#efe9df',
  muted: '#8f8a81',
  radius: 10,

  // 小条：收着 112×30（字号 13 的时候）；下面的数都由 applyFont 算出来
  island: 112,
  height: 30,

  // 冒一行：左边 eyeZone 宽是表情区，右边是文字区
  eyeZone: 56,
  eyeShift: 28, // 展开时眼睛往左挪这么多（SVG 用户单位）
  zoneGap: 8, // 两区之间的空
  padRight: 16, // 右边留 16
  textPad: 8, // 文字区里左右各留 8，字在中间

  // 冒的那一行：宽 112 → 跟着字走（字特别长的时候别裁，宽到 460）
  bubbleMin: 112,
  bubbleHardMax: 460,
  bubbleGap: 8, // 字和能点的按钮之间留的空

  // 另外两个样子（小球去掉了，小岛只能吸顶）
  receiveWidth: 360,
  receiveHeight: 123,
  lineWidth: 64,
  lineHeight: 4,

  // 时长（毫秒）
  hoverMs: 300, // 鼠标停 0.3 秒冒一行
  leaveMs: 400, // 鼠标离开约 0.4 秒收回
  expandMs: 240,
  textInMs: 120,
  collapseMs: 200,
  textOutMs: 100,
  blinkMinMs: 4000,
  blinkMaxMs: 8000,
  lookMs: 250,
  workMs: 250,
  backMs: 250,
  dotMs: 200,
  progressFadeMs: 200,
  sceneMs: 160,

  // 小岛被点那一下：缩到 0.96 再弹回（80ms 缩 + 120ms 回）
  pressScale: 0.96,
  pressDownMs: 80,
  pressBackMs: 120,

  // 三条曲线：出来、收回、弹一下
  curveOut: [0.2, 0.8, 0.2, 1],
  curveIn: [0.4, 0, 0.2, 1],
  curveBounce: [0.34, 1.56, 0.64, 1],
}

// 字号改了就把整套尺寸重算一遍
export function applyFont(size) {
  const box = layoutFor(size)
  theme.font = box.font
  theme.island = box.island
  theme.height = box.height
  theme.eyeZone = box.eyeZone
  theme.eyeShift = box.eyeShift
  theme.zoneGap = box.zoneGap
  theme.padRight = box.padRight
  theme.textPad = box.textPad
  theme.bubbleMin = box.island
  theme.bubbleHardMax = box.bubbleHardMax
  return box
}
applyFont(theme.font)

// 冒的那一行要占多宽：左边表情区 + 空 + 文字区（跟着字走）+ 右边留白；
// 字太长就封顶 bubbleHardMax，页面上用省略号收尾，不裁字
export function bubbleBoxWidth(textWidth) {
  const box = layoutFor(theme.font)
  const need = box.eyeZone + box.zoneGap + (Number(textWidth) || 0) + box.textPad * 2 + box.padRight
  return Math.round(Math.max(box.island, Math.min(box.bubbleHardMax, need)))
}

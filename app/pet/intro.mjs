// 首次运行小岛出场：小岛从顶边正中滑下来，冒一行「把一份范本和几份材料拖给我试试」。
// 照设计稿第九节第 3 步：滑下 320ms、出来曲线，从顶边上方 30px 到贴顶；
// 眼睛往上看、落定眨一下换睁眼；停 0.3 秒冒那一行，停 6 秒或鼠标离开就收回。
// 纯函数，不碰 electron，好测。

import { cubicBezier } from './ease.mjs'

export const INTRO_LINE = '把一份范本和几份材料拖给我试试'

export const introTiming = {
  fromOffset: -30, // 从顶边上方 30px
  slideMs: 320, // 滑下来 320ms
  pauseMs: 300, // 落定后停 0.3 秒
  holdMs: 6000, // 冒一行后停 6 秒
  expandMs: 240, // 展开 240ms
  textInMs: 120, // 字最后 120ms 淡入
  collapseMs: 200, // 收回 200ms
}

// 出来曲线：cubic-bezier(0.2, 0.8, 0.2, 1)
const easeOut = cubicBezier(0.2, 0.8, 0.2, 1)

// 离顶边多远：顶边上方 30px → 贴顶（0）
export function introOffset(elapsed) {
  const t = Math.min(1, Math.max(0, elapsed / introTiming.slideMs))
  return Math.round(introTiming.fromOffset * (1 - easeOut(t))) + 0
}

// 时间线上的时刻（毫秒，从开始算）
export function introMarks() {
  return {
    land: introTiming.slideMs,
    line: introTiming.slideMs + introTiming.pauseMs,
    close: introTiming.slideMs + introTiming.pauseMs + introTiming.holdMs,
  }
}

// 这一帧该是什么样：phase 是阶段，eyes 是眼睛，offset 是离顶边多远
export function introFrame(elapsed, still = false) {
  const marks = introMarks()
  if (still) {
    // 关了「显示动画」：直接到冒一行那一帧，6 秒后照常收回
    if (elapsed < introTiming.holdMs) return { phase: 'line', eyes: 'open', offset: 0 }
    if (elapsed < introTiming.holdMs + introTiming.collapseMs) return { phase: 'collapse', eyes: 'open', offset: 0 }
    return { phase: 'done', eyes: 'open', offset: 0 }
  }
  if (elapsed < marks.land) return { phase: 'slide', eyes: 'up', offset: introOffset(elapsed) }
  if (elapsed < marks.line) return { phase: 'land', eyes: 'open', offset: 0 }
  if (elapsed < marks.close) return { phase: 'line', eyes: 'open', offset: 0 }
  if (elapsed < marks.close + introTiming.collapseMs) return { phase: 'collapse', eyes: 'open', offset: 0 }
  return { phase: 'done', eyes: 'open', offset: 0 }
}

// 出场还在走吗：换了代（重新开始）或者已经冒完那一行，就别再往下走
// 免得兜底已经把那一行冒出来了，页面后来才回话，又滑一次
export function introAlive(gen, currentGen, busy) {
  return gen === currentGen && Boolean(busy)
}

// 开机那套跟出场撞上了怎么办（页面的 boot 回来得晚，出场先到了）：
// 场景照最新的来，眼神要是出场已经定过了就别盖回去，那一行更别盖回去
export function bootPlan({ introStarted = false, introLineSet = false, bootScene = 'strip', lastScene = 'strip' } = {}) {
  return {
    scene: introStarted ? lastScene : bootScene,
    keepEyes: introStarted,
    setBubble: !introLineSet,
  }
}

// 只放一次：byok 那边记着 introPlayed，放过就不再来一遍
export async function playIntroOnce(played, play) {
  if (played) return false
  try { await play() } catch { /* 大场面没放成也只试这一次 */ }
  return true
}

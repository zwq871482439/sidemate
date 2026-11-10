// 小岛被点那一下（设计稿第三节②）：缩到 0.96 再弹回（80ms 缩 + 120ms 回）。
// 跟开关一起触发：点下去那一下小岛先缩，任务窗接着垂下来。
// 关了「显示动画」就不动。

export const PRESS_SCALE = 0.96
export const PRESS_DOWN_MS = 80
export const PRESS_BACK_MS = 120

export function pressIsland({ send, still = () => false, scale = PRESS_SCALE, downMs = PRESS_DOWN_MS, backMs = PRESS_BACK_MS } = {}) {
  if (still()) return false
  send('pet:press', { scale, downMs, backMs })
  return true
}

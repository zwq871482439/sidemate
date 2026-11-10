// 任务窗的运动：露脸、收回、变高（设计稿第三节②）。
// 露脸：先按最终高度摆好，再露脸；页面第一帧是收起状态，下一帧才垂下来。
// 收回：动画放完才藏起来，藏之前不重排。
// 变高：内容变长了用 120ms 过渡，不跳。

export const DROP_MS = 260
export const ROLL_MS = 180
export const RESIZE_MS = 120
export const STEP_MS = 16

// 露脸：摆好位置 → 露脸 → 让页面开始垂下来
export function showTaskWindow(win, bounds, send) {
  win.setBounds(bounds)
  win.show()
  send('in')
}

// 变高：120ms 过渡。窗开着的时候内容变长了不跳一下
export function createResizer({ win, timers = { setInterval, clearInterval }, now = () => Date.now() }) {
  let timer = null
  const stop = () => {
    if (timer === null) return
    timers.clearInterval(timer)
    timer = null
  }
  return {
    stop,
    to(bounds) {
      stop()
      const from = win.getBounds()
      const started = now()
      timer = timers.setInterval(() => {
        const t = Math.min(1, (now() - started) / RESIZE_MS)
        win.setBounds(mix(from, bounds, t))
        if (t < 1) return
        stop()
        win.setBounds(bounds)
      }, STEP_MS)
    },
  }
}

function mix(from, to, amount) {
  const box = {}
  for (const key of ['x', 'y', 'width', 'height']) {
    box[key] = Math.round(from[key] + (to[key] - from[key]) * amount)
  }
  return box
}

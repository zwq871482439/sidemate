// 任务窗的开合：露脸（'in'）、往上收（'out'）、收完才藏起来。
// 失焦和点小岛都从这里收；两下挨得近时只放一段动画，不叠两段。
// 窗、计时器、通道都从外面拿：壳给真的窗，测试给假的。

import { createHider } from './hide.mjs'
import { ROLL_MS, showTaskWindow } from './motion.mjs'

export function createCloseCycle({
  getWin,                 // () => 窗（还没建的时候是 null）
  bounds = () => null,    // 露脸时摆哪儿
  send,                   // (kind) => void：'in' 露脸、'out' 收回
  gate,                   // 对话框开着的时候别收
  timers,                 // 假计时器（测试里给假的）
  delay = ROLL_MS,        // 收完等多久才藏
  onHidden = () => {},    // 藏起来了
  onBlurred = () => {},   // 因失焦收的
}) {
  let closing = false

  const hider = createHider({
    gate,
    isVisible: () => {
      const win = getWin()
      return !!win && !win.isDestroyed() && win.isVisible()
    },
    hide: (why) => {
      closing = false
      const win = getWin()
      if (win && !win.isDestroyed() && win.isVisible()) win.hide()
      onHidden(why)
    },
    animate: (kind) => {
      if (kind === 'out') closing = true
      send(kind)
    },
    delay,
    timers,
    onHide: (why) => { if (why === 'blur') onBlurred(why) },
  })

  const cycle = {
    // 窗开着没有（正在收的不算开着：这时候点一下该是再开）
    isOpen: () => cycle.visible() && !closing,
    // 窗看得见没有（正在收也算看得见）
    visible: () => {
      const win = getWin()
      return !!win && !win.isDestroyed() && win.isVisible()
    },
    // 正在收没有
    closing: () => closing,
    // 正在收的理由：'blur' 失焦、'toggle' 点小岛
    reason: () => hider.reason(),
    // 收：失焦（'blur'）或点小岛（'toggle'）
    close: (why = 'blur') => hider.soon(why),
    // 收起停掉：窗要再开
    cancel: () => {
      hider.cancel()
      closing = false
    },
    // 露脸：先按最终高度摆好，再露脸；页面下一帧才垂下来
    show: () => {
      cycle.cancel()
      const win = getWin()
      if (!win || win.isDestroyed()) return false
      const box = bounds()
      if (!box) return false
      showTaskWindow(win, box, send)
      win.focus?.()
      return true
    },
  }
  return cycle
}

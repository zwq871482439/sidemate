// 点窗外面（失焦）：往上收一会儿再藏起来，窗里的活接着干。
// 选文件的对话框开着时不能收（对话框一开，任务窗就失焦了），gate 管着这件事。

// soon(why)：why 说清楚是为什么收的（'blur' 失焦、'toggle' 点小岛）。
// 已经在收的时候再来一下：不重放动画，也不把藏窗的时刻往后推 —— 失焦和小岛那一下
// 挨着来也只收一段，不会先收一半又撑回去。
// 收完了 onHide 告诉外面收的是哪一种，外头才知道下一下点击该不该把窗弹出来。

import { ROLL_MS } from './motion.mjs'

export function createHider({ gate, isVisible, hide, animate, delay = ROLL_MS, onHide, timers = { setTimeout, clearTimeout } }) {
  let timer = null
  let reason = ''
  let closing = false
  const clear = () => {
    if (timer !== null) timers.clearTimeout(timer)
    timer = null
  }
  return {
    cancel: () => {
      clear()
      closing = false
      reason = ''
    },
    // 正在收没有
    closing: () => closing,
    // 正在收的理由：'blur' 失焦、'toggle' 点小岛
    reason: () => reason,
    soon(why = 'blur') {
      if (!isVisible()) return false
      if (gate?.picking) return false
      // 点小岛那一下比失焦更像人的意思：它说了算
      if (why === 'toggle') reason = 'toggle'
      else if (!reason) reason = why
      // 已经在收：不再放第二段动画，也不再顺延藏窗的时刻
      if (closing) return true
      closing = true
      clear()
      animate?.('out')
      const wait = typeof delay === 'function' ? delay() : delay
      timer = timers.setTimeout(() => {
        timer = null
        closing = false
        const done = reason
        reason = ''
        hide(done)
        onHide?.(done)
      }, wait)
      return true
    },
  }
}

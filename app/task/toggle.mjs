// 点小岛那一下：任务窗开着就收起来，收起不到半秒的别再弹出来。
// 收窗用收回动画（180ms），窗里的活接着干；关着的时候照旧打开：
// 有没收下的任务就回到那个任务，没有就开空的。

// 正在收的时候再来一下：同一下点（先失焦、后点小岛）就接着收；
// 再点一下小岛（收的理由已经是点小岛）就从收起一半的地方接着展开。

export function createToggler({ isOpen, open, hide, closing = () => false, reason = () => '', grace = 300, now = () => Date.now() }) {
  // 最近一次因失焦收起的时间：0 表示没有过
  let blurredAt = 0
  return {
    // 别的路子把窗叫出来了（拖文件进来、右键菜单）：上一次失焦不算数
    opened() {
      blurredAt = 0
    },
    // 因失焦把窗收起来了：记下时间，紧跟着的那一下点击别再把它弹出来
    blurred() {
      blurredAt = now()
    },
    isOpen() {
      return !!isOpen()
    },
    toggle() {
      // 正在收：这下点的是小岛
      if (closing()) {
        // 收的理由已经是点小岛：再点一下就是让它回来，从收起一半的地方接着展开
        if (reason() === 'toggle') {
          open()
          return 'opened'
        }
        // 同一下点（失焦先收的）：接着收
        hide()
        return 'closed'
      }
      // 开着：收
      if (isOpen()) {
        hide()
        return 'closed'
      }
      // 刚因为失焦收起来的：这一下别再弹出来，等它自己安静一会儿
      if (blurredAt && now() - blurredAt < grace) return 'closed'
      open()
      return 'opened'
    },
  }
}

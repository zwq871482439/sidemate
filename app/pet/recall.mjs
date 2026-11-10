// 叫回小岛
// 托盘图标、托盘菜单「显示桌伴」：小岛一定回到最前、看得见。
// 三种叫不回来的情况都算上：
//   1. 被「收到托盘」藏起来了；
//   2. 没勾「保持在最前」，被别的窗口盖住了；
//   3. 全屏程序盖住顶边，收成了一条细线。
// 叫的时候不改用户在右键菜单里勾的「保持在最前」：没勾就临时置顶一小会儿，
// 到了时候照旧不置顶；也不抢焦点（用户正在打字的窗口不该失焦）。
// 这一层不碰 Electron，方便拿假的窗来测。

// 临时置顶多久（毫秒）：够把小岛提到前面，又不至于一直压着别的窗口
export const RECALL_TOP_MS = 2000

// 叫回来以后小岛该是什么样子：细线变回小条，别的样子不动
export function recallScene(scene) {
  return scene === 'line' ? 'strip' : scene
}

// 叫回小岛的一摊
export function createRecaller(options = {}) {
  const getScene = options.getScene || (() => 'strip')
  const setScene = options.setScene || (() => {})
  // 露脸但不抢焦点
  const showWindow = options.showWindow || (() => {})
  // 提到前面（不抢焦点）
  const raiseWindow = options.raiseWindow || (() => {})
  // 用户勾没勾「保持在最前」
  const getOnTop = options.getOnTop || (() => true)
  // 直接往窗上设层级，不动存着的勾选
  const setWindowTop = options.setWindowTop || (() => {})
  // 任务窗开着就跟着到前面
  const showTask = options.showTask || (() => {})
  const setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer || ((timer) => clearTimeout(timer))

  let timer = null

  // 临时置顶到头了：照用户勾的来（没勾就是不置顶）
  function restoreTop() {
    timer = null
    setWindowTop(!!getOnTop())
  }

  function recall() {
    // 细线先变回小条，不然叫出来还是一条看不见的线
    const before = getScene()
    const after = recallScene(before)
    if (after !== before) setScene(after)
    // 藏到托盘的：重新露脸
    showWindow()
    if (!getOnTop()) {
      // 被别的窗口盖着：临时置顶一下，才提得到前面
      setWindowTop(true)
      raiseWindow()
      if (timer) clearTimer(timer)
      timer = setTimer(restoreTop, RECALL_TOP_MS)
    } else {
      // 勾着最前：层级本来就是对的，只要提到前面
      raiseWindow()
    }
    // 任务窗开着就跟着到前面
    showTask()
    return { scene: after, onTop: !!getOnTop() }
  }

  return {
    recall,
    restoreTop,
    get restoring() { return !!timer },
  }
}

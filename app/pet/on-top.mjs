// 置顶开关：小岛右键菜单里一个勾选项「保持在最前」。
// 勾上：小岛压在别的置顶窗口上面（层级 'screen-saver'）。
// 不勾：小岛跟普通窗口一样，会被别的窗口盖住；任务窗也跟着不置顶。
// 这一层不碰 Electron，方便拿假的窗来测。

// 勾上时的层级
export const ON_TOP_LEVEL = 'screen-saver'

// 存的值：没存过就默认勾上
export function onTopFromPlace(saved) {
  return saved && typeof saved.onTop === 'boolean' ? saved.onTop : true
}

// 往窗上设：勾上用 ON_TOP_LEVEL，不勾就退回普通层级
export function applyOnTop(win, onTop) {
  if (!win) return false
  try {
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return false
    if (onTop) win.setAlwaysOnTop(true, ON_TOP_LEVEL)
    else win.setAlwaysOnTop(false)
    return true
  } catch {
    return false
  }
}

// 置顶这一摊：记住勾没勾、菜单里给这一项、切换时往窗上设一遍
export function createOnTop(options = {}) {
  const getWindows = options.getWindows || (() => [])
  const persist = options.persist || (() => {})
  let onTop = options.initial === undefined ? true : !!options.initial

  function apply() {
    for (const win of getWindows()) applyOnTop(win, onTop)
    return onTop
  }

  function set(value) {
    onTop = !!value
    persist(onTop)
    apply()
    return onTop
  }

  // 菜单里那一条
  function menuItem() {
    return {
      type: 'checkbox',
      label: '保持在最前',
      checked: onTop,
      click: (item) => set(item && typeof item.checked === 'boolean' ? item.checked : !onTop),
    }
  }

  return { get onTop() { return onTop }, set, apply, menuItem }
}

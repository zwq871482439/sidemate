// 小岛的样子：
// - 有事不再自动冒字：状态变了只改眼神，不自己张开
// - 鼠标停 0.3 秒才张开冒一行（看进度用），离开约 0.4 秒收回
// - 首次运行出场那一行照旧
// 纯函数，不碰 electron，好测。

// 状态变了：不许自己冒一行
export function onStateChange() {
  return { expand: false }
}

// 鼠标停够 0.3 秒才冒一行：收着的才冒，托盘、细线不管
export function onHover(scene, waited, hoverMs) {
  return { expand: scene === 'strip' && waited >= hoverMs }
}

// 要张开的时候：托盘、细线、张着的都不再张开
export function onExpand(scene) {
  if (scene === 'tray' || scene === 'line') return { expand: false }
  if (scene === 'expanded') return { expand: false }
  return { expand: true }
}

// 鼠标离开：收回（不管什么状态）
export function onCollapse(scene) {
  return { collapse: scene === 'expanded' }
}

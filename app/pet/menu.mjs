// 小岛右键菜单的模板（不碰 Electron，好单测）。
// 最近 · 新任务 · 设置 · 保持在最前 ·（分隔）· 收到托盘 · 退出
//
// 「保持在最前」是勾选项：勾上小岛一直压在别的窗口上面，不勾就跟普通窗口一样会被盖住。

export function petMenuTemplate(options = {}) {
  const {
    recent = null,
    onTop = true,
    onToggleOnTop = () => {},
    onNewTask = () => {},
    onSettings = () => {},
    onTray = () => {},
    onQuit = () => {},
  } = options
  const items = []
  if (recent) items.push(recent)
  items.push(
    { label: '新任务', click: onNewTask },
    { label: '设置', click: onSettings },
    { type: 'checkbox', label: '保持在最前', checked: !!onTop, click: (item) => onToggleOnTop(item && typeof item.checked === 'boolean' ? item.checked : !onTop) },
    { type: 'separator' },
    { label: '收到托盘', click: onTray },
    { label: '退出', click: onQuit },
  )
  return items
}

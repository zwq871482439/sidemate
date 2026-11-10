// 测试钩子：只在环境变量 SIDEMATE_PET_TEST_HOOK 指了一个文件的时候才开。
// 用来在没有真人的机器上驱动托盘那一套（托盘单击、托盘菜单「显示桌伴」、「收到托盘」）。
// 文件里写一行 JSON，比如 {"action":"tray-click"}；内容变了才动，重复写同一个内容不重复触发。
// 平常启动（没有这个环境变量）什么也不做。

import { readFileSync } from 'node:fs'

export function startTestHook(actions = {}) {
  const file = process.env.SIDEMATE_PET_TEST_HOOK
  if (!file) return () => {}
  let last = ''
  const timer = setInterval(() => {
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { return }
    if (!text || text === last) return
    last = text
    let payload = {}
    try { payload = JSON.parse(text) } catch { payload = { action: text.trim() } }
    const fn = actions[payload?.action]
    if (typeof fn === 'function') fn(payload)
  }, 300)
  return () => clearInterval(timer)
}

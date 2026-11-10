import { app } from 'electron'
import { begin, openSettings } from '../byok/shell.mjs'
import { startPet } from '../pet/shell.mjs'
import { startTask } from '../task/shell.mjs'

let pet = null, task = null

// 第二个桌伴被双击起来了：把已经在跑的那个叫到前面。还没准备好就什么都不做。
function focusRunning() {
  if (!app.isReady() || !task) return
  try { if (!begin()) task.open() } catch { /* 叫不回来就算了 */ }
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', focusRunning)
  app.whenReady().then(() => {
    task = startTask({
      onPet: (event) => pet?.ingest(event),
      // 任务窗到前台了：小岛那三种状态收回去，回待命
      onOpen: () => pet?.clearHeld?.(),
      anchor: () => pet?.anchor?.(),
      // 任务窗收起来了：小岛再说一遍层级
      onHidden: () => pet?.refreshTop?.(),
    })
    pet = startPet({
      // 任务窗出来以后，小岛再说一遍层级
      openTask: (detail) => { task.open(detail); pet?.refreshTop?.() },
      toggleTask: task.toggle,
      openSettings,
      recent: task.recent,
      // 小岛的「保持在最前」：任务窗跟着
      setTaskTop: (value) => task.setOnTop(value),
      // 小岛被叫回最前时：任务窗跟着到前面
      raiseTask: () => task.raise?.(),
    })
    if (process.env.SIDEMATE_OPEN === 'settings') openSettings()
    if (!begin({ playIntro: () => pet.playIntro() })) task.open()
  })
}

app.on('window-all-closed', () => {})

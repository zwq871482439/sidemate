// 「加文件」对话框开着的时候，任务窗会失焦，这时候不能把窗收起来；
// 框关了以后再把窗叫回前面来。dialog 用假的顶。

import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { createHider } from '../../app/task/hide.mjs'
import { createPicker } from '../../app/task/pick.mjs'

test('选文件的对话框开着时失焦不收窗，框关了再把窗叫回来', async () => {
  let openDialog = null
  const focused = []
  const picker = createPicker({
    showOpenDialog: () => new Promise((resolve) => { openDialog = resolve }),
    focus: (target) => focused.push(target),
  })
  let hidden = 0
  const animated = []
  const hider = createHider({
    gate: picker,
    isVisible: () => true,
    hide: () => { hidden += 1 },
    animate: (kind) => animated.push(kind),
    delay: 30,
  })

  const win = { name: 'win' }
  const pending = picker.pick(win, { title: '加文件' })
  assert.equal(picker.picking, true, '对话框没开起来')

  // 对话框开着的时候任务窗失焦
  hider.soon()
  await sleep(80)
  assert.equal(hidden, 0, '对话框开着就把窗收了')
  assert.deepEqual(animated, [], '对话框开着就放了收回的动画')

  // 框关了：窗叫回前面来
  openDialog({ canceled: false, filePaths: ['a.docx'] })
  const chosen = await pending
  assert.deepEqual(chosen.filePaths, ['a.docx'])
  assert.equal(picker.picking, false, '框关了还占着')
  assert.deepEqual(focused, [win], '框关了没把窗叫回来')

  // 框关了以后再失焦，窗照收
  hider.soon()
  await sleep(80)
  assert.equal(hidden, 1, '框关了以后失焦没收窗')
})

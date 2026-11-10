// 收窗：失焦收和点小岛收是两回事，收完了要说清楚是哪一种。
// 外面才知道下一下点击该不该把窗弹出来。

import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { createHider } from '../../app/task/hide.mjs'

test('收完了说是哪一种收的', async () => {
  const hidden = []
  const whys = []
  const animated = []
  let visible = true
  const hider = createHider({
    isVisible: () => visible,
    hide: () => { hidden.push(Date.now()); visible = false },
    animate: (kind) => animated.push(kind),
    delay: 20,
    onHide: (why) => whys.push(why),
  })

  hider.soon('blur')
  await sleep(60)
  assert.equal(hidden.length, 1, '失焦没收窗')
  assert.deepEqual(whys, ['blur'], '没说清楚是失焦收的')
  assert.deepEqual(animated, ['out'], '没放收回的动画')

  // 窗已经收着了，再失焦就不收第二次
  visible = true
  hider.soon('blur')
  await sleep(60)
  assert.equal(hidden.length, 2)
  assert.deepEqual(whys, ['blur', 'blur'])
})

test('点小岛收的窗不算失焦', async () => {
  const whys = []
  const hider = createHider({
    isVisible: () => true,
    hide: () => {},
    animate: () => {},
    delay: 20,
    onHide: (why) => whys.push(why),
  })
  hider.soon('toggle')
  await sleep(60)
  assert.deepEqual(whys, ['toggle'])
})

test('取消了就没收', async () => {
  const hidden = []
  const hider = createHider({
    isVisible: () => true,
    hide: () => hidden.push(1),
    animate: () => {},
    delay: 20,
  })
  hider.soon('blur')
  hider.cancel()
  await sleep(60)
  assert.deepEqual(hidden, [], '取消了还收了窗')
})

test('对话框开着的时候不收，也不算收过', async () => {
  const hidden = []
  const whys = []
  const hider = createHider({
    gate: { picking: true },
    isVisible: () => true,
    hide: () => hidden.push(1),
    animate: () => {},
    delay: 20,
    onHide: (why) => whys.push(why),
  })
  assert.equal(hider.soon('blur'), false, '对话框开着还收')
  await sleep(60)
  assert.deepEqual(hidden, [])
  assert.deepEqual(whys, [])
})

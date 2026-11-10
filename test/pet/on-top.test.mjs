// 小岛右键菜单里的「保持在最前」
// 菜单模板有这一项、勾选状态跟存的值一致、切换会调 setAlwaysOnTop 对应参数。

import assert from 'node:assert/strict'
import test from 'node:test'
import { petMenuTemplate } from '../../app/pet/menu.mjs'
import { applyOnTop, createOnTop, onTopFromPlace, ON_TOP_LEVEL } from '../../app/pet/on-top.mjs'

// 假的窗：只记 setAlwaysOnTop 调了什么
function fakeWindow() {
  const calls = []
  return {
    calls,
    isDestroyed: () => false,
    setAlwaysOnTop: (...args) => calls.push(args),
  }
}

function topItem(template) {
  const item = template.find((one) => one.label === '保持在最前')
  assert.ok(item, '菜单里没有「保持在最前」')
  return item
}

test('右键菜单里有「保持在最前」这一项，是勾选项，默认勾上', () => {
  const template = petMenuTemplate({ onTop: true })
  const item = topItem(template)
  assert.equal(item.type, 'checkbox')
  assert.equal(item.checked, true)
  // 别的项还在
  assert.deepEqual(
    template.map((one) => one.label || one.type),
    ['新任务', '设置', '保持在最前', 'separator', '收到托盘', '退出'],
  )
})

test('勾选状态跟存的值一致：存了不勾就是不勾，没存过就默认勾上', () => {
  assert.equal(onTopFromPlace(null), true)
  assert.equal(onTopFromPlace({}), true)
  assert.equal(onTopFromPlace({ onTop: true }), true)
  assert.equal(onTopFromPlace({ onTop: false }), false)
  assert.equal(topItem(petMenuTemplate({ onTop: false })).checked, false)
  assert.equal(topItem(petMenuTemplate({ onTop: onTopFromPlace({ onTop: false }) })).checked, false)
})

test('点这一项会调 setAlwaysOnTop：勾上用 pop-up-menu 层级，不勾就退回普通', () => {
  const win = fakeWindow()
  const top = createOnTop({ initial: true, getWindows: () => [win] })
  const item = topItem(petMenuTemplate({ onTop: top.onTop, onToggleOnTop: (value) => top.set(value) }))

  item.click({ checked: false })
  assert.deepEqual(win.calls, [[false]])
  assert.equal(top.onTop, false)

  item.click({ checked: true })
  assert.deepEqual(win.calls, [[false], [true, ON_TOP_LEVEL]])
  assert.equal(top.onTop, true)
})

test('勾选状态存下来：换一次记一次，下次启动照存的来', () => {
  const saved = []
  const top = createOnTop({ initial: true, persist: (value) => saved.push(value) })
  top.set(false)
  top.set(true)
  assert.deepEqual(saved, [false, true])
  // 下次启动：存的是 false 就默认不勾
  const next = createOnTop({ initial: onTopFromPlace({ onTop: saved[saved.length - 1] }) })
  assert.equal(next.onTop, true)
  const off = createOnTop({ initial: onTopFromPlace({ onTop: false }) })
  assert.equal(off.onTop, false)
})

test('层级：勾上是 screen-saver（压得住别的置顶窗），不勾就是普通窗口', () => {
  assert.equal(ON_TOP_LEVEL, 'screen-saver')
  const win = fakeWindow()
  applyOnTop(win, true)
  applyOnTop(win, false)
  assert.deepEqual(win.calls, [[true, 'screen-saver'], [false]])
})

test('窗已经没了就别再设层级', () => {
  const gone = { isDestroyed: () => true, setAlwaysOnTop: () => assert.fail('不该再设') }
  assert.equal(applyOnTop(gone, true), false)
  assert.equal(applyOnTop(null, true), false)
})

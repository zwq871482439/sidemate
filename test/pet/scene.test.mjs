import assert from 'node:assert/strict'
import test from 'node:test'
import { onCollapse, onExpand, onHover, onStateChange } from '../../app/pet/scene.mjs'
import { theme } from '../../app/pet/theme.mjs'

test('有事不再自动冒字：状态变了不自己张开', () => {
  assert.equal(onStateChange().expand, false)
})

test('鼠标停 0.3 秒才冒一行', () => {
  assert.equal(theme.hoverMs, 300)
  assert.equal(onHover('strip', 299, theme.hoverMs).expand, false)
  assert.equal(onHover('strip', 300, theme.hoverMs).expand, true)
  // 已经张着的、张不开的那些（托盘、细线）不重复冒
  for (const scene of ['expanded', 'tray', 'line']) {
    assert.equal(onHover(scene, 300, theme.hoverMs).expand, false, scene)
  }
})

test('要张开的时候：托盘、细线、张着的都不再张开', () => {
  assert.equal(onExpand('strip').expand, true)
  for (const scene of ['expanded', 'tray', 'line']) {
    assert.equal(onExpand(scene).expand, false, scene)
  }
})

test('鼠标离开就收回，不管什么状态', () => {
  assert.equal(onCollapse('expanded').collapse, true)
  assert.equal(onCollapse('strip').collapse, false)
})

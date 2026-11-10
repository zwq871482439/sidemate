// 点小岛那一下：开着就收，关着就开；刚因为失焦收起来的别再弹出来。
// 窗、动画、时间都用假的，只看这一下的决定。

import assert from 'node:assert/strict'
import test from 'node:test'
import { createToggler } from '../../app/task/toggle.mjs'

function lab(start = { open: false, at: 1000 }) {
  const calls = []
  const state = { ...start }
  const toggler = createToggler({
    isOpen: () => state.open,
    open: () => { calls.push('open'); state.open = true },
    hide: () => { calls.push('hide'); state.open = false },
    now: () => state.at,
  })
  return { toggler, calls, state }
}

test('任务窗开着：点一下就收', () => {
  const { toggler, calls } = lab({ open: true, at: 1000 })
  assert.equal(toggler.isOpen(), true)
  assert.equal(toggler.toggle(), 'closed')
  assert.deepEqual(calls, ['hide'], '开着的时候点一下没收窗')
  assert.equal(toggler.isOpen(), false)
})

test('任务窗关着：点一下就开', () => {
  const { toggler, calls } = lab({ open: false, at: 1000 })
  assert.equal(toggler.toggle(), 'opened')
  assert.deepEqual(calls, ['open'], '关着的时候点一下没开窗')
  assert.equal(toggler.isOpen(), true)
})

test('开着点一下收起，再点一下又开', () => {
  const { toggler, calls } = lab({ open: true, at: 1000 })
  toggler.toggle()
  toggler.toggle()
  assert.deepEqual(calls, ['hide', 'open'], '收完再点没开回来')
})

test('因失焦收起后 300ms 内的点击不再把窗弹出来', () => {
  const { toggler, calls, state } = lab({ open: false, at: 1000 })
  toggler.blurred()
  state.at = 1000 + 299
  assert.equal(toggler.toggle(), 'closed')
  assert.deepEqual(calls, [], '刚失焦收起来的又被弹出来了')

  // 过了 300ms：这下就照旧打开
  state.at = 1000 + 300
  assert.equal(toggler.toggle(), 'opened')
  assert.deepEqual(calls, ['open'])
})

test('别的路子把窗叫出来以后，之前那次失焦不算数', () => {
  const { toggler, calls, state } = lab({ open: false, at: 1000 })
  toggler.blurred()
  // 拖文件进来：窗开了，之前的失焦不算数
  state.open = true
  toggler.opened()
  state.at = 1000 + 100
  assert.equal(toggler.toggle(), 'closed', '拖文件开着的时候点一下没收窗')
  assert.deepEqual(calls, ['hide'])

  // 收起是点小岛收的，不是失焦收的：下一下就该开回来
  state.at = 1000 + 200
  assert.equal(toggler.toggle(), 'opened')
  assert.deepEqual(calls, ['hide', 'open'])
})

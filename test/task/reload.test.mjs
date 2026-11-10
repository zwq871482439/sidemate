// 渲染进程没了以后要不要重载：纯函数，不 import electron。

import assert from 'node:assert/strict'
import test from 'node:test'
import { RENDER_GONE_LIMIT, RENDER_GONE_WINDOW_MS, createReloadGuard } from '../../app/task/reload-guard.mjs'

test('第一次没了：要重载', () => {
  const guard = createReloadGuard({ clock: () => 1_000 })
  const plan = guard.gone({ reason: 'crashed', exitCode: 1 })
  assert.equal(plan.reload, true)
  assert.equal(plan.gaveUp, false)
  assert.equal(plan.count, 1)
})

test('60 秒里连着没了：第 4 次不再重载', () => {
  let now = 0
  const guard = createReloadGuard({ clock: () => now })
  const plans = [0, 1, 2, 3].map(() => {
    now += 1_000
    return guard.gone({ reason: 'crashed', exitCode: 1 })
  })
  assert.deepEqual(plans.map((one) => one.reload), [true, true, true, false])
  assert.deepEqual(plans.map((one) => one.count), [1, 2, 3, 4])
  assert.equal(plans[3].gaveUp, true)
  assert.equal(RENDER_GONE_LIMIT, 3)
  assert.equal(RENDER_GONE_WINDOW_MS, 60_000)
})

test('过了 60 秒重新算：又能重载', () => {
  let now = 0
  const guard = createReloadGuard({ clock: () => now })
  for (let i = 0; i < 4; i += 1) {
    now += 1_000
    guard.gone({ reason: 'crashed', exitCode: 1 })
  }
  now += RENDER_GONE_WINDOW_MS + 1
  const plan = guard.gone({ reason: 'crashed', exitCode: 1 })
  assert.equal(plan.reload, true)
  assert.equal(plan.gaveUp, false)
  assert.equal(plan.count, 1)
})

test('自己退出的不重载，也不算数', () => {
  const guard = createReloadGuard()
  const plan = guard.gone({ reason: 'clean-exit', exitCode: 0 })
  assert.equal(plan.reload, false)
  assert.equal(plan.gaveUp, false)
  assert.equal(plan.count, 0)
  const after = guard.gone({ reason: 'crashed', exitCode: 1 })
  assert.equal(after.count, 1)
  assert.equal(after.reload, true)
})

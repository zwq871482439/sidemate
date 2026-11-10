// 小岛被点那一下（设计稿第三节②）：缩到 0.96 再弹回（80ms 缩 + 120ms 回）。

import assert from 'node:assert/strict'
import test from 'node:test'
import { pressIsland } from '../../app/pet/press.mjs'
import { petClick } from '../../app/pet/click.mjs'

test('小岛被点那一下：缩到 0.96 再弹回', () => {
  const sent = []
  const ok = pressIsland({ send: (channel, payload) => sent.push([channel, payload]) })
  assert.equal(ok, true)
  assert.deepEqual(sent, [['pet:press', { scale: 0.96, downMs: 80, backMs: 120 }]])
})

test('关了显示动画：小岛不动', () => {
  const sent = []
  const ok = pressIsland({ send: (channel, payload) => sent.push([channel, payload]), still: () => true })
  assert.equal(ok, false)
  assert.deepEqual(sent, [])
})

test('点一下：缩一下跟开关一起发生', () => {
  const calls = []
  petClick({ toggle: () => { calls.push('toggle'); return 'closed' }, press: () => calls.push('press') })
  assert.deepEqual(calls, ['toggle', 'press'])
})

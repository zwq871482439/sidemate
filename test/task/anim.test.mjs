// 帘子动画的方向：同一个方向不重放，反方向倒着走（从当前位置接着走）。

import assert from 'node:assert/strict'
import test from 'node:test'
import { animStep } from '../../app/task/anim.mjs'

test('没有动画在走：重新放一段', () => {
  assert.equal(animStep(null, 'in'), 'start')
  assert.equal(animStep(null, 'out'), 'start')
  assert.equal(animStep({ state: 'finished', dir: 'out' }, 'in'), 'start')
})

test('同一个方向：不重放', () => {
  assert.equal(animStep({ state: 'running', dir: 'out' }, 'out'), 'keep')
  assert.equal(animStep({ state: 'running', dir: 'in' }, 'in'), 'keep')
})

test('反方向：倒着走，从当前位置接着走', () => {
  assert.equal(animStep({ state: 'running', dir: 'in' }, 'out'), 'reverse')
  assert.equal(animStep({ state: 'running', dir: 'out' }, 'in'), 'reverse')
})

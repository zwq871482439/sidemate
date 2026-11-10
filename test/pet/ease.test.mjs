import assert from 'node:assert/strict'
import test from 'node:test'
import { cubicBezier } from '../../app/pet/ease.mjs'
import { theme } from '../../app/pet/theme.mjs'

test('出来曲线：起得快、落得稳', () => {
  const out = cubicBezier(...theme.curveOut)
  assert.equal(out(0), 0)
  assert.equal(out(1), 1)
  assert.ok(out(0.5) > 0.5, `出来曲线中点该过半：${out(0.5)}`)
  let last = -1
  for (let i = 0; i <= 20; i += 1) {
    const value = out(i / 20)
    assert.ok(value >= last - 1e-9, '曲线不能往回走')
    last = value
  }
})

test('收回曲线：头尾都在，起步慢', () => {
  const back = cubicBezier(...theme.curveIn)
  assert.equal(back(0), 0)
  assert.equal(back(1), 1)
  assert.ok(back(0.1) < 0.1, `收回曲线起步要慢：${back(0.1)}`)
})

test('弹一下：冲过头一点再回来', () => {
  const bounce = cubicBezier(...theme.curveBounce)
  assert.equal(bounce(0), 0)
  assert.equal(bounce(1), 1)
  let top = 0
  for (let i = 0; i <= 40; i += 1) top = Math.max(top, bounce(i / 40))
  assert.ok(top > 1, `弹一下要冲过头：${top}`)
})

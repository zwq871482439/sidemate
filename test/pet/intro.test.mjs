import assert from 'node:assert/strict'
import test from 'node:test'
import { INTRO_LINE, bootPlan, introAlive, introFrame, introMarks, introOffset, introTiming, playIntroOnce } from '../../app/pet/intro.mjs'

test('小岛从顶边上方 30px 滑到贴顶，320ms', () => {
  assert.equal(introTiming.slideMs, 320)
  assert.equal(introTiming.fromOffset, -30)
  assert.equal(introOffset(0), -30)
  assert.equal(introOffset(320), 0)
  assert.equal(introOffset(640), 0)
  const mid = introOffset(160)
  assert.ok(mid > -30 && mid < 0, String(mid))
})

test('落定后停 0.3 秒才冒那一行，冒完停 6 秒收回', () => {
  const marks = introMarks()
  assert.equal(marks.land, 320)
  assert.equal(marks.line, 620)
  assert.equal(marks.close, 620 + 6000)
  assert.equal(introTiming.pauseMs, 300)
  assert.equal(introTiming.holdMs, 6000)
  assert.equal(introTiming.collapseMs, 200)
})

test('冒的那一行跟设置页说的是同一句', () => {
  assert.equal(INTRO_LINE, '把一份范本和几份材料拖给我试试')
})

test('时序：滑 → 落定 → 冒一行 → 收回', () => {
  assert.equal(introFrame(0).phase, 'slide')
  assert.equal(introFrame(319).phase, 'slide')
  assert.equal(introFrame(320).phase, 'land')
  assert.equal(introFrame(619).phase, 'land')
  assert.equal(introFrame(620).phase, 'line')
  assert.equal(introFrame(6600).phase, 'line')
  assert.equal(introFrame(6620).phase, 'collapse')
  assert.equal(introFrame(6820).phase, 'done')
})

test('眼睛：滑的时候往上看，落定眨一下换睁眼', () => {
  assert.equal(introFrame(0).eyes, 'up')
  assert.equal(introFrame(200).eyes, 'up')
  assert.equal(introFrame(320).eyes, 'open')
  assert.equal(introFrame(620).eyes, 'open')
})

test('关了「显示动画」：直接到冒一行那一帧，6 秒后照常收回', () => {
  assert.equal(introFrame(0, true).phase, 'line')
  assert.equal(introFrame(0, true).offset, 0)
  assert.equal(introFrame(0, true).eyes, 'open')
  assert.equal(introFrame(5999, true).phase, 'line')
  assert.equal(introFrame(6000, true).phase, 'collapse')
  assert.equal(introFrame(6200, true).phase, 'done')
})

test('只放一次：放过就不再来一遍', async () => {
  let count = 0
  const play = async () => { count += 1 }
  assert.equal(await playIntroOnce(false, play), true)
  assert.equal(count, 1)
  assert.equal(await playIntroOnce(true, play), false)
  assert.equal(count, 1)
})

test('大场面没放成也只试这一次', async () => {
  let count = 0
  const play = async () => { count += 1; throw new Error('没放成') }
  assert.equal(await playIntroOnce(false, play), true)
  assert.equal(count, 1)
  assert.equal(await playIntroOnce(true, play), false)
  assert.equal(count, 1)
})

test('兜底冒完那一行就别再滑一次', () => {
  // 同一代、出场还在走：接着往下走
  assert.equal(introAlive(1, 1, true), true)
  // 兜底已经把那一行冒出来（不忙了）：别再滑
  assert.equal(introAlive(1, 1, null), false)
  // 重新放了一次（换代了）：上一代的不算
  assert.equal(introAlive(1, 2, true), false)
})

test('开机那套跟出场撞上了：场景照最新的，眼神和那一行别盖回去', () => {
  const late = bootPlan({ introStarted: true, introLineSet: true, bootScene: 'strip', lastScene: 'strip' })
  assert.equal(late.scene, 'strip')
  assert.equal(late.keepEyes, true)
  assert.equal(late.setBubble, false)

  // 出场先到了但还没冒行：场景照开机那套，眼神别盖回去
  const early = bootPlan({ introStarted: true, introLineSet: false, bootScene: 'strip', lastScene: 'strip' })
  assert.equal(early.keepEyes, true)
  assert.equal(early.setBubble, true)

  // 没出场：照开机那套全套来
  const plain = bootPlan({ bootScene: 'line' })
  assert.equal(plain.scene, 'line')
  assert.equal(plain.keepEyes, false)
  assert.equal(plain.setBubble, true)
})

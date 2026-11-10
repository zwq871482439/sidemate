// 点卡片上的「收下」：产出还在就留一行带「打开」，只聊天就只留一行字。

import assert from 'node:assert/strict'
import test from 'node:test'
import { TEXT, createTask, reduceTask, toTaskView } from '../../app/task/state.mjs'

const at = Date.UTC(2026, 10, 2, 12, 0, 0)
const usage = { at, inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, searches: 0 }
const OUT = 'C:/Users/slow/桌伴/任务/1106-汇成本周周报/桌伴输出'

function withCard() {
  let s = reduceTask(createTask(), { type: 'send', text: '汇成本周周报', runId: 'a1' }).state
  s = reduceTask(s, { type: 'output', taskId: 'a1', name: '本周周报.docx', to: `${OUT}/本周周报.docx`, pages: 3 }).state
  s = reduceTask(s, { type: 'usage', taskId: 'a1', ...usage }).state
  s = reduceTask(s, { type: 'end', taskId: 'a1', status: 'done' }).state
  return s
}

function chatOnly() {
  let s = reduceTask(createTask(), { type: 'send', text: '讲个笑话', runId: 'b1' }).state
  s = reduceTask(s, { type: 'reply', taskId: 'b1', text: '好。' }).state
  s = reduceTask(s, { type: 'end', taskId: 'b1', status: 'done' }).state
  return s
}

test('点收下：产出还在，留一行带打开', () => {
  const step = reduceTask(withCard(), { type: 'accept' })
  assert.equal(step.settle, true)
  assert.equal(step.pet, 'idle')
  assert.equal(step.state.phase, 'empty')
  assert.equal(step.state.flow.length, 1)
  const note = step.state.flow[0]
  assert.equal(note.kind, 'note')
  assert.equal(note.text, TEXT.settledKept)
  assert.deepEqual(note.buttons, [{ action: 'open-settled', label: TEXT.open }])
  assert.equal(step.state.settledDir, OUT)
  assert.deepEqual(step.state.cards, [])
  assert.deepEqual(toTaskView(step.state).flow, [
    { kind: 'note', text: TEXT.settledKept, tail: '', buttons: [{ action: 'open-settled', label: TEXT.open }] },
  ])
})

test('点收下：只聊天，只留一行字，没有按钮', () => {
  const step = reduceTask(chatOnly(), { type: 'accept' })
  assert.equal(step.settle, true)
  assert.equal(step.pet, 'idle')
  assert.equal(step.state.phase, 'empty')
  assert.equal(step.state.flow.length, 1)
  assert.equal(step.state.flow[0].kind, 'note')
  assert.equal(step.state.flow[0].text, TEXT.settled)
  assert.deepEqual(step.state.flow[0].buttons, [])
  assert.equal(step.state.settledDir, '')
  assert.deepEqual(toTaskView(step.state).flow, [
    { kind: 'note', text: TEXT.settled, tail: '', buttons: [] },
  ])
})

test('点收下：还在干活的窗不动', () => {
  const s = reduceTask(createTask(), { type: 'send', text: '写', runId: 'c1' }).state
  const step = reduceTask(s, { type: 'accept' })
  assert.equal(step.settle, false)
  assert.equal(step.state, s)
})

test('点收下和点新任务留的是同一行', () => {
  const accepted = reduceTask(withCard(), { type: 'accept' }).state
  const fresh = reduceTask(withCard(), { type: 'new' }).state
  assert.deepEqual(accepted.flow, fresh.flow)
  assert.equal(accepted.settledDir, fresh.settledDir)
  assert.equal(accepted.phase, fresh.phase)
})

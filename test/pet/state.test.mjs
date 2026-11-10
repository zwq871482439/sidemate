import assert from 'node:assert/strict'
import test from 'node:test'
import { clearAsk, createState, reduce } from '../../app/pet/state.mjs'

const at = 1

test('待命是第一态', () => {
  const state = createState()
  assert.equal(state.mode, 'idle')
  assert.equal(state.message, '')
})

test('第一个进度是干活中，那一行记着', () => {
  const step = reduce(createState(), { type: 'progress', taskId: 't1', at, text: '在看材料 2/5' })
  assert.equal(step.state.mode, 'work')
  assert.equal(step.state.taskId, 't1')
  assert.equal(step.state.message, '在看材料 2/5')
  assert.equal(step.notify, false)
})

test('产出和用量都还是干活中', () => {
  const working = reduce(createState(), { type: 'progress', taskId: 't1', at, text: '在写' }).state
  for (const type of ['artifact', 'usage']) {
    const step = reduce(working, { type, taskId: 't1', at })
    assert.equal(step.state.mode, 'work')
    assert.equal(step.state.message, '在写')
  }
})

test('做完了：笑眼，一直保持到点开小岛', () => {
  const done = reduce(createState(), { type: 'end', taskId: 't1', at, status: 'done' })
  assert.equal(done.state.mode, 'done')
  assert.equal(done.hold, true)
  assert.equal(done.state.notice, '做完了')
  const cancelled = reduce(done.state, { type: 'end', taskId: 't1', at, status: 'cancelled' })
  assert.equal(cancelled.state.mode, 'idle')
  assert.equal(cancelled.hold, false)
})

test('没干成是平线，不是等你说话', () => {
  const step = reduce(createState(), { type: 'error', taskId: 't1', at, message: '余额不够' })
  assert.equal(step.state.mode, 'fail')
  assert.equal(step.state.message, '余额不够')
  assert.equal(step.notify, true)
  const ended = reduce(createState(), { type: 'end', taskId: 't1', at, status: 'error', message: '没写成' })
  assert.equal(ended.state.mode, 'fail')
  assert.equal(ended.state.message, '没写成')
  const fallback = reduce(createState(), { type: 'end', taskId: 't1', at, status: 'error' })
  assert.equal(fallback.state.message, '这次没做成')
})

test('它问你一句：要你看一眼', () => {
  const step = reduce(createState(), { type: 'ask', taskId: 't1', at, message: '第三节要不要再短一点？' })
  assert.equal(step.state.mode, 'look')
  assert.equal(step.state.message, '第三节要不要再短一点？')
  assert.equal(step.hold, true)
  // 通知照旧是那句「等你一句话」，冒的那一行里是它问的那句
  const withNotice = reduce(createState(), { type: 'ask', taskId: 't1', at, message: '要不要再短一点？', notice: '等你一句话' })
  assert.equal(withNotice.state.notice, '等你一句话')
  assert.equal(withNotice.state.message, '要不要再短一点？')
})

test('开任务窗：做完了、要你看一眼、没干成都收回去，干活中不动', () => {
  const fail = reduce(createState(), { type: 'error', taskId: 't1', at, message: '看一眼' }).state
  assert.equal(clearAsk(fail).mode, 'idle')
  const done = reduce(createState(), { type: 'end', taskId: 't1', at, status: 'done' }).state
  assert.equal(clearAsk(done).mode, 'idle')
  const look = reduce(createState(), { type: 'ask', taskId: 't1', at, message: '要不要？' }).state
  assert.equal(clearAsk(look).mode, 'idle')
  const working = reduce(createState(), { type: 'progress', taskId: 't1', at, text: '在写' }).state
  assert.equal(clearAsk(working), working)
})

test('换个任务号也算开工了', () => {
  const step = reduce(createState(), { type: 'tick', taskId: 't9', at })
  assert.equal(step.state.mode, 'work')
})

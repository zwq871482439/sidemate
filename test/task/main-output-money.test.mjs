// 任务窗里不出现钱，也不出现用量：产出卡只写页数和出处。
// 0.2 的钱和用量都挪到设置页去了（另一张卡在改）。

import assert from 'node:assert/strict'
import test from 'node:test'
import { createTask, reduceTask, toTaskView } from '../../app/task/state.mjs'

const usage = { at: Date.UTC(2026, 10, 1, 12, 0, 0), inputTokens: 100_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0, searches: 0 }
const OUT = 'C:/Users/slow/桌伴/任务/1106-汇成本周周报/桌伴输出'

// 钱、用量、token 这些词，一个都不许出现在任务窗的视图里
const MONEY = /这次约|元|块钱|毛|分|token|用量|万|price|money|cost/i

function viewOf(events) {
  let s = createTask()
  for (const event of events) s = reduceTask(s, event).state
  return toTaskView(s, { root: 'C:/Users/slow/桌伴', recent: ['C:/Users/slow/Desktop/本周材料'] })
}

test('同一轮两张卡：卡上只有页数和出处，没有钱', () => {
  const v = viewOf([
    { type: 'send', text: '写', runId: 'r1' },
    { type: 'usage', taskId: 'r1', ...usage },
    { type: 'output', taskId: 'r1', name: '本周周报.docx', to: `${OUT}/本周周报.docx`, pages: 12, cite: { verified: 86, missed: 4 } },
    { type: 'output', taskId: 'r1', name: 'table_dump.txt', to: `${OUT}/table_dump.txt` },
  ])
  const cards = v.bottom.cards
  // 卡的顺序不动：新的在前
  assert.deepEqual(cards.map((one) => one.name), ['table_dump.txt', '本周周报.docx'])
  assert.equal(cards[0].line, '')
  assert.equal(cards[1].line, '12 页 · 86 句核上出处，4 句没逐字核上（批注里标了）')
  assert.equal(MONEY.test(JSON.stringify(v)), false, JSON.stringify(v))
})

test('这一轮只有一张 txt：卡上也没有钱', () => {
  const v = viewOf([
    { type: 'send', text: '写', runId: 'r2' },
    { type: 'usage', taskId: 'r2', ...usage },
    { type: 'output', taskId: 'r2', name: '说明.txt', to: `${OUT}/说明.txt` },
  ])
  assert.equal(v.bottom.cards.length, 1)
  assert.equal(v.bottom.cards[0].line, '')
  assert.equal(MONEY.test(JSON.stringify(v)), false, JSON.stringify(v))
})

test('不同轮各算各的：每一轮都不写钱', () => {
  const v = viewOf([
    { type: 'send', text: '写', runId: 'r3' },
    { type: 'usage', taskId: 'r3', ...usage },
    { type: 'output', taskId: 'r3', name: '第一轮.docx', to: `${OUT}/第一轮.docx` },
    { type: 'end', taskId: 'r3', status: 'done' },
    { type: 'send', text: '再写', runId: 'r4' },
    { type: 'usage', taskId: 'r4', searches: 1 },
    { type: 'output', taskId: 'r4', name: '第二轮.txt', to: `${OUT}/第二轮.txt` },
  ])
  const byName = Object.fromEntries(v.bottom.cards.map((one) => [one.name, one]))
  assert.deepEqual(Object.keys(byName).sort(), ['第一轮.docx', '第二轮.txt'])
  assert.equal(byName['第一轮.docx'].line, '')
  assert.equal(byName['第二轮.txt'].line, '')
  assert.equal(MONEY.test(JSON.stringify(v)), false, JSON.stringify(v))
})

test('只聊天没出文件：也不写钱', () => {
  const v = viewOf([
    { type: 'send', text: '讲个笑话', runId: 'r5' },
    { type: 'usage', taskId: 'r5', ...usage },
    { type: 'reply', taskId: 'r5', text: '好。' },
    { type: 'end', taskId: 'r5', status: 'done' },
  ])
  assert.deepEqual(v.bottom.none, { text: '没出文件' })
  assert.equal(MONEY.test(JSON.stringify(v)), false, JSON.stringify(v))
})

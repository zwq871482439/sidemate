// 用量记录：格式化（万）、合计公式、按月合计、跨月、最近 10 条、
// 记录文件坏了不崩、写不进不崩，以及 run.mjs 那一处调用真的落到文件上。

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test, { after } from 'node:test'
import { bindUsageStore, createUsageStore, dayLabel, formatCount, monthKey, noteUsage, taskTitle, usageTotal, usageView } from '../../app/usage/index.mjs'
import { createRunner } from '../../app/task/run.mjs'

const roots = []

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

after(() => {
  bindUsageStore(null)
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

const at = (year, month, day, hour = 12) => new Date(year, month - 1, day, hour).getTime()
const NOV = at(2026, 11, 8)
const row = (extra = {}) => ({ name: '汇成本周周报', at: NOV, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, searches: 0, ...extra })

test('合计公式：输入（没命中）+ 缓存读 + 缓存写 + 输出，四项全加', () => {
  assert.equal(usageTotal({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 50 }), 1550)
  assert.equal(usageTotal({ inputTokens: 1000, outputTokens: 200 }), 1200)
  assert.equal(usageTotal(null), 0)
  assert.equal(usageTotal({ inputTokens: -5, outputTokens: 'x', cacheReadTokens: null }), 0)
})

test('格式化：不到一万写原数，过万写「万」保留一位小数，整数不带 .0', () => {
  assert.equal(formatCount(0), '0')
  assert.equal(formatCount(9999), '9999')
  assert.equal(formatCount(10000), '1 万')
  assert.equal(formatCount(20000), '2 万')
  assert.equal(formatCount(31000), '3.1 万')
  assert.equal(formatCount(1246000), '124.6 万')
  assert.equal(formatCount(10500), '1.1 万')
  assert.equal(formatCount(99999), '10 万')
})

test('任务名：用户那句话前 20 字，换行折成空格', () => {
  assert.equal(taskTitle('汇成本周周报'), '汇成本周周报')
  assert.equal(taskTitle(''), '')
  assert.equal(taskTitle(null), '')
  const flat = '把这份 范本 和材料 整理成周报，今天下班前要交的那种，拜托了'
  assert.equal(taskTitle('  把这份\n范本\t和材料  整理成周报，今天下班前要交的那种，拜托了  '), flat.slice(0, 20))
  assert.equal(taskTitle('一'.repeat(25)).length, 20)
})

test('月份和日期标签用本地时间', () => {
  assert.equal(monthKey(NOV), '2026-11')
  assert.equal(dayLabel(NOV), '11-08')
  assert.equal(dayLabel(new Date(2026, 0, 3, 9).getTime()), '01-03')
})

test('按月合计只算当前月，跨月的不算', () => {
  const records = [
    row({ at: at(2026, 10, 31), inputTokens: 900000 }),
    row({ at: at(2026, 11, 1), inputTokens: 500000, cacheReadTokens: 500000 }),
    row({ at: at(2026, 11, 30, 23), outputTokens: 246000 }),
    row({ at: at(2026, 12, 1), inputTokens: 700000 }),
  ]
  const view = usageView(records, at(2026, 11, 15))
  assert.equal(view.heading, '11 月一共用了')
  assert.equal(view.total, '124.6 万') // 11 月两条：100 万 + 24.6 万
})

test('最近 10 条按时间倒序，每条 任务名 · 日期 · 用量', () => {
  const records = []
  for (let i = 1; i <= 12; i += 1) records.push(row({ at: at(2026, 11, i), name: `第${i}天的活`, inputTokens: i * 1000 }))
  const view = usageView(records, at(2026, 11, 20))
  assert.equal(view.recent.length, 10)
  assert.deepEqual(view.recent[0], { name: '第12天的活', date: '11-12', usage: '1.2 万' })
  assert.equal(view.recent[9].name, '第3天的活')
  assert.equal(view.recent[9].date, '11-03')
  assert.equal(view.recent[9].usage, '3000')
})

test('视图对坏行和没名字的行不崩', () => {
  const view = usageView([null, { at: 'x' }, { at: NOV }, { at: NOV, name: '', inputTokens: 12345 }], at(2026, 11, 9))
  assert.equal(view.total, '1.2 万')
  assert.deepEqual(view.recent, [
    { name: '一个任务', date: '11-08', usage: '0' },
    { name: '一个任务', date: '11-08', usage: '1.2 万' },
  ])
})

test('记录文件：add 落成 JSON，read 读回，searches 也存着', () => {
  const dir = scratch('sidemate-usage-')
  const store = createUsageStore({ file: join(dir, 'usage.json') })
  assert.equal(store.read().length, 0)
  assert.equal(store.add({ at: NOV, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 50, searches: 2 }, '汇成本周周报'), true)
  assert.equal(store.add({ at: at(2026, 11, 9), inputTokens: 100 }, '第二句话'), true)
  const rows = store.read()
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { name: '汇成本周周报', at: NOV, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 50, searches: 2 })
  assert.equal(rows[1].searches, 0)
  assert.equal(usageTotal(rows[0]), 1550)
})

test('记录文件坏了不崩：当没有，下一轮把它写成好的', () => {
  const file = join(scratch('sidemate-usage-'), 'usage.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '{不是 JSON', 'utf8')
  const store = createUsageStore({ file })
  assert.deepEqual(store.read(), [])
  assert.equal(store.add({ at: NOV, inputTokens: 7 }, '修好它'), true)
  assert.equal(store.read().length, 1)
  // 内容合法但形状不对（records 不是数组）：也当没有
  writeFileSync(file, '{"version": 1, "records": "nope"}', 'utf8')
  assert.deepEqual(store.read(), [])
})

test('写不进不崩：目标位置有个同名文件堵着，add 只回 false', () => {
  const dir = scratch('sidemate-usage-')
  const wall = join(dir, 'wall')
  writeFileSync(wall, '我是一个文件，不是目录', 'utf8')
  const store = createUsageStore({ file: join(wall, 'usage.json') })
  assert.equal(store.add({ at: NOV, inputTokens: 1 }, '写不进'), false)
  assert.deepEqual(store.read(), [])
})

test('bindUsageStore 之后 noteUsage 记进去，没绑过就什么都不记', () => {
  const store = bindUsageStore(scratch('sidemate-usage-'))
  assert.equal(noteUsage('这句话特别长特别长特别长特别长特别长', { at: NOV, inputTokens: 1000, outputTokens: 246000, searches: 1 }), true)
  const rows = store.read()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, '这句话特别长特别长特别长特别长特别长'.slice(0, 20))
  assert.equal(rows[0].searches, 1)
  assert.equal(usageView(rows, at(2026, 11, 9)).total, '24.7 万')
  bindUsageStore(null)
  assert.equal(noteUsage('没绑', { at: NOV, inputTokens: 1 }), false)
  bindUsageStore(dirname(store.file))
})

test('run.mjs 那一处调用：一轮结束真的写进 userData 下的 usage.json', async () => {
  const home = scratch('sidemate-userdata-')
  bindUsageStore(home)
  const root = scratch('sidemate-run-')
  const nodeSource = join(root, 'payload', 'node', 'node.exe')
  const nodeLow = join(root, 'payload', 'node-low', 'node.exe')
  mkdirSync(dirname(nodeSource), { recursive: true })
  writeFileSync(nodeSource, 'node-binary-for-tests')
  const workspace = join(root, 'task-ws')
  const runner = createRunner({
    root: () => join(root, '桌伴'),
    key: () => 'sk-test',
    extensions: ['.docx', '.txt'],
    recent: [],
    node: { source: nodeSource, low: nodeLow },
    log: () => {},
    prepareTask: () => ({ kind: 'none', workspace, outputDir: join(workspace, '桌伴输出'), copied: [], skipped: [], originals: [], snapshot: [] }),
    protectRuntime: () => ({ ok: true, message: '' }),
    prepareFeed: undefined,
    finishTask: () => ({ ok: true, changed: [], snapshot: [], outputs: [] }),
    deliverOutput: (input) => ({ to: join(root, '产出', input.name), name: input.name, locked: false }),
    clearWorkspace: () => {},
    snapshotWorkspace: () => [],
    runTask: (options) => {
      options.onEvent({ type: 'usage', taskId: options.taskId, at: NOV, inputTokens: 500000, outputTokens: 200000, cacheReadTokens: 300000, cacheWriteTokens: 246000, searches: 3 })
      return { sessionId: 's1', cancel() {}, done: Promise.resolve({ type: 'end', taskId: options.taskId, at: 9, status: 'done' }) }
    },
  })
  runner.act({ type: 'send', text: '把这份范本和三份材料汇成本周周报，语气照着范本来' })
  for (let i = 0; i < 400 && runner.view().phase !== 'done'; i += 1) await new Promise((done) => setTimeout(done, 5))
  assert.equal(runner.view().phase, 'done')
  const rows = JSON.parse(readFileSync(join(home, 'usage.json'), 'utf8')).records
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, '把这份范本和三份材料汇成本周周报，语气照')
  assert.equal(rows[0].searches, 3)
  const view = usageView(rows, at(2026, 11, 8))
  assert.equal(view.total, '124.6 万')
  assert.equal(view.recent[0].date, '11-08')
})

test('usage.json 存的形状一眼能看懂', () => {
  const dir = scratch('sidemate-usage-')
  const store = createUsageStore({ file: join(dir, 'usage.json') })
  store.add({ at: NOV, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, searches: 5 }, '一个任务')
  const text = readFileSync(store.file, 'utf8')
  assert.equal(basename(store.file), 'usage.json')
  assert.match(text, /"name": "一个任务"/)
  assert.match(text, /"searches": 5/)
})

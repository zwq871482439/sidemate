import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, describe } from 'node:test'
import { payloadLayout, runTask } from '../../app/dsh/index.mjs'
import { startFake } from './fake-messages.mjs'

const KEY = 'sidemate-test-key'
const layout = payloadLayout()
const roots = []

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

function ensureNode() {
  if (existsSync(layout.node)) return
  mkdirSync(join(layout.root, 'node'), { recursive: true })
  copyFileSync(process.execPath, layout.node)
  chmodSync(layout.node, 0o755)
}

// 假 dsh：从 stdin 读一行一个 JSON-RPC，按 prompt 文本里的计划写用量文件。
// 只能靠 prompt 文本区分（子进程只拿到那几个环境变量），所以计划直接编在 prompt 里。
const FAKE_DSH = String.raw`
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

let buffer = ''
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

function usageFile(sessionId, plan) {
  const dir = join(process.env.DSH_HOME, 'storages', 'session_projcache', 'sessions')
  mkdirSync(dir, { recursive: true })
  const totals = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  for (const step of plan.steps) {
    totals.uncachedInputTokens += step.u
    totals.outputTokens += step.o
    totals.cacheReadTokens += step.cr
    totals.cacheWriteTokens += step.cw
  }
  const row = {
    version: 7,
    record: {
      identity: { sessionId: sessionId },
      rows: {
        tokenUsage: { ver: 2, seq: plan.seq, val: { totals: totals, last: plan.last } },
        turnBoundary: { ver: 2, seq: plan.seq, val: plan.boundary },
      },
    },
  }
  writeFileSync(join(dir, sessionId + '.json'), JSON.stringify(row, null, 2))
}

const openBoundary = (turn) => ({
  openTurnStartSeq: 3,
  lastStepStartSeq: 1,
  lastStepBoundary: { kind: 'start', seq: 2 },
  lastTurn: turn,
})
const closedBoundary = (turn) => ({
  openTurnStartSeq: null,
  lastStepStartSeq: 1,
  lastStepBoundary: { kind: 'end', seq: 9 },
  lastTurn: turn,
})

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    const id = msg.id
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: id, result: { protocolVersion: 1 } })
    } else if (msg.method === 'session/new') {
      send({ jsonrpc: '2.0', id: id, result: { sessionId: 'fake-usage' } })
    } else if (msg.method === 'session/resume') {
      send({ jsonrpc: '2.0', id: id, result: {} })
    } else if (msg.method === 'session/prompt') {
      const text = (msg.params.prompt || []).map(part => part.text || '').join(' ')
      const plan = JSON.parse(text.replace(/^FAKE /, ''))
      const sessionId = msg.params.sessionId || 'fake-usage'
      if (plan.mode === 'late') {
        usageFile(sessionId, { steps: plan.steps.slice(0, 2), last: { turn: 1, step: 2, buckets: {} }, boundary: openBoundary(1), seq: 10 })
        send({ jsonrpc: '2.0', id: id, result: { stopReason: 'end_turn' } })
        setTimeout(() => {
          usageFile(sessionId, { steps: plan.steps, last: { turn: 1, step: 3, buckets: {} }, boundary: closedBoundary(1), seq: 20 })
        }, plan.delay)
      } else if (plan.mode === 'never') {
        usageFile(sessionId, { steps: plan.steps.slice(0, 2), last: { turn: 1, step: 2, buckets: {} }, boundary: openBoundary(1), seq: 10 })
        send({ jsonrpc: '2.0', id: id, result: { stopReason: 'end_turn' } })
      } else if (plan.mode === 'ontime') {
        usageFile(sessionId, { steps: plan.steps, last: { turn: 1, step: 3, buckets: {} }, boundary: closedBoundary(1), seq: 20 })
        send({ jsonrpc: '2.0', id: id, result: { stopReason: 'end_turn' } })
      } else if (plan.mode === 'resume') {
        send({ jsonrpc: '2.0', id: id, result: { stopReason: 'end_turn' } })
        setTimeout(() => {
          usageFile(sessionId, { steps: plan.steps, last: { turn: 2, step: 1, buckets: {} }, boundary: closedBoundary(2), seq: 30 })
        }, plan.delay)
      } else {
        send({ jsonrpc: '2.0', id: id, result: { stopReason: 'end_turn' } })
      }
    } else if (id !== undefined) {
      send({ jsonrpc: '2.0', id: id, error: { code: -32601, message: 'method not found' } })
    }
  }
})
`

function fakePayload() {
  const root = scratch('sidemate-fakepayload-')
  const lib = join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(lib, { recursive: true })
  writeFileSync(join(lib, 'bin.js'), FAKE_DSH)
  mkdirSync(join(root, 'python'), { recursive: true })
  return root
}

function fakeOptions(plan, extra = {}) {
  const workspace = scratch('sidemate-ws-')
  const lowRoot = scratch('sidemate-low-')
  return {
    taskId: 'fake-usage',
    apiKey: KEY,
    workspace,
    lowRoot,
    payloadRoot: fakePayload(),
    node: process.execPath,
    prompt: `FAKE ${JSON.stringify(plan)}`,
    stallMs: 30_000,
    ...extra,
  }
}

function usageFilePath(lowRoot, sessionId) {
  return join(lowRoot, 'dsh', 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
}

function writeUsageFile(lowRoot, sessionId, { totals, last, boundary, seq = 5 }) {
  const path = usageFilePath(lowRoot, sessionId)
  mkdirSync(join(lowRoot, 'dsh', 'storages', 'session_projcache', 'sessions'), { recursive: true })
  writeFileSync(path, JSON.stringify({
    version: 7,
    record: {
      identity: { sessionId },
      rows: {
        tokenUsage: { ver: 2, seq, val: { totals, last } },
        turnBoundary: { ver: 2, seq, val: boundary },
      },
    },
  }, null, 2))
}

const STEPS = [
  { u: 1, o: 2, cr: 0, cw: 0 },
  { u: 3, o: 4, cr: 0, cw: 0 },
  { u: 5, o: 6, cr: 0, cw: 0 },
]

function usageEvent(events) {
  return events.find(event => event.type === 'usage')
}

describe('usage waits for the file to catch up', { concurrency: 1 }, () => {
  test('a late boundary file is waited for', { timeout: 60_000 }, async () => {
    const events = []
    const logs = []
    const handle = runTask(fakeOptions({ mode: 'late', delay: 400, steps: STEPS }, {
      onEvent: event => events.push(event),
      onLog: line => logs.push(line),
    }))
    const end = await handle.done
    assert.equal(end.status, 'done', JSON.stringify(events))
    const usage = usageEvent(events)
    assert.equal(usage?.inputTokens, 9)
    assert.equal(usage?.outputTokens, 12)
    assert.equal(usage?.cacheReadTokens, 0)
    assert.equal(usage?.cacheWriteTokens, 0)
    assert.equal(logs.some(line => line.startsWith('usage caught up')), true, logs.join('\n'))
  })

  test('a file that never catches up still reports the round it has', { timeout: 60_000 }, async () => {
    const events = []
    const logs = []
    const handle = runTask(fakeOptions({ mode: 'never', steps: STEPS }, {
      usageWaitMs: 500,
      onEvent: event => events.push(event),
      onLog: line => logs.push(line),
    }))
    const end = await handle.done
    assert.equal(end.status, 'done', JSON.stringify(events))
    const usage = usageEvent(events)
    assert.equal(usage?.inputTokens, 4)
    assert.equal(usage?.outputTokens, 6)
    const stale = logs.filter(line => line.startsWith('usage stale'))
    assert.equal(stale.length, 1, logs.join('\n'))
    assert.match(stale[0], /^usage stale \d+ms step 2$/)
  })

  test('a file written before the turn ends is used as is', { timeout: 60_000 }, async () => {
    const events = []
    const logs = []
    const handle = runTask(fakeOptions({ mode: 'ontime', steps: STEPS }, {
      onEvent: event => events.push(event),
      onLog: line => logs.push(line),
    }))
    const end = await handle.done
    assert.equal(end.status, 'done', JSON.stringify(events))
    const usage = usageEvent(events)
    assert.equal(usage?.inputTokens, 9)
    assert.equal(usage?.outputTokens, 12)
    assert.equal(logs.some(line => line.startsWith('usage caught up')), true, logs.join('\n'))
  })

  test('a continued session counts only its own round', { timeout: 60_000 }, async () => {
    const options = fakeOptions({ mode: 'resume', delay: 300, steps: [STEPS[0], STEPS[1]] }, {
      sessionId: 'fake-usage',
    })
    // 上一轮收尾那份：上一轮最后一步重试过，tokenUsage.last 是空的。
    writeUsageFile(options.lowRoot, 'fake-usage', {
      totals: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      last: null,
      boundary: { openTurnStartSeq: null, lastStepStartSeq: 1, lastStepBoundary: { kind: 'end', seq: 4 }, lastTurn: 1 },
    })
    const events = []
    const logs = []
    options.onEvent = event => events.push(event)
    options.onLog = line => logs.push(line)
    const end = await runTask(options).done
    assert.equal(end.status, 'done', JSON.stringify(events))
    const usage = usageEvent(events)
    assert.equal(usage?.inputTokens, 3)
    assert.equal(usage?.outputTokens, 4)
    assert.equal(logs.some(line => line.startsWith('usage caught up')), true, logs.join('\n'))
  })

  test('three real steps add up to one usage event', { timeout: 180_000 }, async () => {
    ensureNode()
    const workspace = scratch('sidemate-ws-')
    const lowRoot = scratch('sidemate-low-')
    const first = join(workspace, 'one.txt')
    const second = join(workspace, 'two.txt')
    const fake = await startFake({
      expectKey: KEY,
      respond: (body) => {
        const raw = JSON.stringify(body)
        const done = (raw.match(/tool_result/g) || []).length
        if (done === 0) return { kind: 'tool', name: 'write', input: { file_path: first, content: '一' }, usage: { input_tokens: 5, output_tokens: 2 } }
        if (done === 1) return { kind: 'tool', name: 'write', input: { file_path: second, content: '二' }, usage: { input_tokens: 7, output_tokens: 3 } }
        return { kind: 'text', text: '写好了', usage: { input_tokens: 11, output_tokens: 4 } }
      },
    })
    const events = []
    const logs = []
    try {
      const handle = runTask({
        taskId: 'real-usage',
        apiKey: KEY,
        prompt: '写两个文件',
        workspace,
        lowRoot,
        baseUrl: fake.url,
        stallMs: 30_000,
        onEvent: event => events.push(event),
        onLog: line => logs.push(line),
      })
      const end = await handle.done
      assert.equal(end.status, 'done', JSON.stringify(events))
      assert.equal(readFileSync(first, 'utf8'), '一')
      assert.equal(readFileSync(second, 'utf8'), '二')
      const usage = usageEvent(events)
      assert.equal(usage?.inputTokens, 23)
      assert.equal(usage?.outputTokens, 9)
      assert.equal(logs.some(line => line.startsWith('usage caught up')), true, logs.join('\n'))
    } finally {
      await fake.close()
    }
  })
})

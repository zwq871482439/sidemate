import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, describe } from 'node:test'
import { classifyFailure, dshLaunch, patchFiles, payloadLayout, progressText, runTask } from '../../app/dsh/index.mjs'
import { startFake } from './fake-messages.mjs'

const KEY = 'sidemate-test-key'
const layout = payloadLayout()
const roots = []

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function ensureNode() {
  if (existsSync(layout.node)) return
  mkdirSync(join(layout.root, 'node'), { recursive: true })
  copyFileSync(process.execPath, layout.node)
  chmodSync(layout.node, 0o755)
}

function denyRead(file) {
  if (process.platform !== 'win32') return chmodSync(file, 0)
  const run = spawnSync('icacls', [file, '/deny', '*S-1-1-0:(RD)'], { encoding: 'utf8', windowsHide: true })
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
}

function allowRead(file) {
  if (process.platform !== 'win32') return chmodSync(file, 0o644)
  spawnSync('icacls', [file, '/remove:d', '*S-1-1-0'], { windowsHide: true })
}

function treeHas(dir, needle) {
  const pending = [dir]
  while (pending.length) {
    const current = pending.pop()
    let names
    try {
      names = readdirSync(current)
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(current, name)
      let st
      try {
        st = statSync(path)
      } catch {
        continue
      }
      if (st.isDirectory()) pending.push(path)
      else if (st.isFile() && st.size < 2_000_000) {
        try {
          if (readFileSync(path).includes(Buffer.from(needle))) return true
        } catch {
          // unreadable files are not our log
        }
      }
    }
  }
  return false
}

function taskOptions(extra) {
  const workspace = scratch('sidemate-ws-')
  const lowRoot = scratch('sidemate-low-')
  return { workspace, lowRoot, ...extra }
}

function replyTexts(events) {
  return events.filter(event => event.type === 'reply').map(event => event.text)
}

async function runScript(taskId, respond) {
  const events = []
  const logs = []
  const trace = []
  const fake = await startFake({ expectKey: KEY, respond })
  try {
    const handle = runTask(taskOptions({
      taskId,
      apiKey: KEY,
      prompt: '说',
      baseUrl: fake.url,
      searchBaseUrl: fake.url,
      stallMs: 30_000,
      onEvent: (event) => {
        events.push(event)
        if (event.type === 'reply' || event.type === 'progress') trace.push(`${event.type}:${event.text}`)
      },
      onLog: (line) => {
        logs.push(line)
        if (line.startsWith('usage_update')) trace.push('usage_update')
      },
    }))
    return { events, logs, trace, end: await handle.done, handle }
  } finally {
    await fake.close()
  }
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

test('progress text stays a sentence', () => {
  assert.equal(progressText({ sessionUpdate: 'tool_call', title: 'web_search' }), '正在查资料')
  assert.equal(progressText({
    sessionUpdate: 'tool_call',
    title: 'write',
    rawInput: { file_path: '/tmp/桌伴/hello.docx' },
  }), '正在写 hello.docx')
  assert.equal(progressText({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '  写好了 \n' },
  }), '')
  assert.equal(progressText({ sessionUpdate: 'usage_update', used: 1, size: 2 }), '')
})

test('failure text splits the five observed replies', () => {
  assert.equal(classifyFailure('Internal error: turn failed: Authentication Fails, Your api key is invalid'), 'key')
  assert.equal(classifyFailure('Internal error: turn failed: Insufficient Balance'), 'quota')
  assert.equal(classifyFailure('Internal error: turn failed: Rate limit reached for requests'), 'busy')
  assert.equal(classifyFailure('Internal error: turn failed: Internal server error'), 'busy')
  assert.equal(classifyFailure('Internal error: turn failed: DeepSeek Messages transport failed'), 'network')
  assert.equal(classifyFailure('Internal error: turn failed: something else'), 'other')
})

test('patches keep the three R3 files and pin PowerShell to SystemRoot', () => {
  const files = patchFiles()
  assert.equal(files.some(file => file.endsWith('office.patch.yml')), true)
  assert.equal(files.some(file => file.endsWith('ps51.patch.yml')), process.platform === 'win32')
  const office = readFileSync(new URL('../../app/dsh/office.patch.yml', import.meta.url), 'utf8')
  const never = readFileSync(new URL('../../app/dsh/never.patch.yml', import.meta.url), 'utf8')
  const ps51 = readFileSync(new URL('../../app/dsh/ps51.patch.yml', import.meta.url), 'utf8')
  assert.match(office, /load_workspace_dependencies|dsh-tool-workspace-dependencies/)
  assert.match(office, /DSH_PRIMARY_RUNTIME/)
  assert.match(never, /policy: never/)
  assert.match(ps51, /SystemRoot/)
  assert.doesNotMatch(ps51, /C:\\Windows/)
})

test('a missing runtime reports an error and stays up', async () => {
  const events = []
  const handle = runTask({
    taskId: 'missing',
    workspace: scratch('sidemate-ws-'),
    prompt: 'hi',
    apiKey: KEY,
    payloadRoot: scratch('sidemate-empty-'),
    lowRoot: scratch('sidemate-low-'),
    stallMs: 1000,
    onEvent: (event) => events.push(event),
  })
  const end = await handle.done
  assert.equal(end.status, 'error')
  assert.equal(events.some(event => event.type === 'error'), true)
  assert.equal(events.every(event => event.taskId === 'missing' && Number.isInteger(event.at)), true)
})

describe('fake messages', { concurrency: 1 }, () => {
  test('patches attach on the acp profile', { timeout: 60_000 }, () => {
    ensureNode()
    assert.equal(existsSync(layout.dsh), true)
    const options = taskOptions({ taskId: 'dump', apiKey: KEY, prompt: 'hi', workspace: scratch('sidemate-ws-') })
    const launch = dshLaunch(options)
    const dumped = spawnSync(launch.command, [...launch.args, '--dump-config'], {
      cwd: launch.cwd,
      env: launch.env,
      encoding: 'utf8',
      timeout: 40_000,
    })
    const text = `${dumped.stdout}\n${dumped.stderr}`
    assert.equal(dumped.status, 0, text)
    assert.match(text, /workspace-dependencies/)
    assert.match(text, /skill-office/)
    assert.match(text, /policy: never/)
    assert.match(text, /session-title-llm[\s\S]*disabled: true|disabled: true[\s\S]*session-title-llm/)
    assert.equal(text.includes(KEY), false)
  })

  test('ten scripted runs finish without a crash', { timeout: 180_000 }, async () => {
    ensureNode()
    const fake = await startFake({
      expectKey: KEY,
      respond: () => ({ kind: 'text', text: '好了', usage: { input_tokens: 11, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } }),
    })
    try {
      for (let i = 0; i < 10; i++) {
        const events = []
        const options = taskOptions({
          taskId: `run-${i}`,
          apiKey: KEY,
          prompt: '说一声好了',
          baseUrl: fake.url,
          stallMs: 30_000,
          onEvent: (event) => events.push(event),
        })
        const handle = runTask(options)
        const end = await handle.done
        assert.equal(end.status, 'done', JSON.stringify(events))
        const usage = events.find(event => event.type === 'usage')
        assert.equal(usage?.inputTokens, 11)
        assert.equal(usage?.outputTokens, 4)
        assert.equal(usage?.cacheReadTokens, 2)
        assert.equal(usage?.cacheWriteTokens, 1)
        assert.equal(usage?.searches, 0)
        assert.equal(events.some(event => event.type === 'reply' && event.text.includes('好了')), true)
        assert.equal(events.some(event => event.type === 'progress' && event.text.includes('好了')), false)
        const closing = events.filter(event => ['reply', 'artifact', 'usage', 'end'].includes(event.type)).map(event => event.type)
        assert.deepEqual(closing, ['reply', 'usage', 'end'])
        const log = readFileSync(handle.logPath, 'utf8')
        assert.equal(log.includes(KEY), false)
        assert.match(log, /usage_update/)
        assert.equal(treeHas(options.lowRoot, KEY), false)
      }
    } finally {
      await fake.close()
    }
  })

  test('silence becomes an error and the process is gone', { timeout: 60_000 }, async () => {
    ensureNode()
    const fake = await startFake({ expectKey: KEY, respond: () => ({ kind: 'hang' }) })
    const events = []
    try {
      const started = Date.now()
      const handle = runTask(taskOptions({
        taskId: 'stall',
        apiKey: KEY,
        prompt: '不要回',
        baseUrl: fake.url,
        stallMs: 2_000,
        onEvent: (event) => events.push(event),
      }))
      const end = await handle.done
      const elapsed = Date.now() - started
      assert.equal(end.status, 'error')
      assert.equal(events.some(event => event.type === 'error' && event.reason === 'stall' && event.message === '十分钟没动静，已经先停了'), true)
      assert.ok(elapsed >= 1_500, `elapsed ${elapsed}`)
      assert.ok(elapsed < 15_000, `elapsed ${elapsed}`)
      assert.throws(() => process.kill(handle.pid, 0))
    } finally {
      await fake.close()
    }
  })

  // 一个只说 ACP 的假对端：启动快、静默时长写在 peer.json 里，用来按毫秒验提示和停的节拍
  const PEER_SCRIPT = `
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const cfg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'peer.json'), 'utf8'))
let buf = ''
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
const say = (text) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'peer-1', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text } } } })
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })
    else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'peer-1' } })
    else if (msg.method === 'session/prompt') {
      say('开头')
      if (cfg.hang) return
      setTimeout(() => {
        say('好了')
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      }, cfg.waitMs)
    } else if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} })
  }
})
`

  function fakePeer(config) {
    const root = scratch('sidemate-peer-')
    mkdirSync(join(root, 'node'), { recursive: true })
    const node = join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
    copyFileSync(process.execPath, node)
    chmodSync(node, 0o755)
    const lib = join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'bin.js'), PEER_SCRIPT)
    writeFileSync(join(root, 'peer.json'), JSON.stringify(config))
    return root
  }

  test('a quiet stretch shows one hint and then finishes', { timeout: 60_000 }, async () => {
    const events = []
    const handle = runTask(taskOptions({
      taskId: 'quiet',
      apiKey: KEY,
      prompt: '写长一点',
      payloadRoot: fakePeer({ waitMs: 2_000 }),
      stallMs: 5_000,
      stallHintMs: 500,
      onEvent: (event) => events.push(event),
    }))
    const end = await handle.done
    assert.equal(end.status, 'done', JSON.stringify(events))
    const hint = '这一步要写的东西比较长，还在等它写完；不想等可以点停下。'
    assert.equal(events.filter(event => event.type === 'progress' && event.text === hint).length, 1, JSON.stringify(events.map(event => [event.type, event.text || event.message || ''])))
    assert.equal(events.some(event => event.type === 'reply' && event.text.includes('好了')), true)
    assert.equal(events.some(event => event.type === 'error'), false)
    assert.throws(() => process.kill(handle.pid, 0))
  })

  test('a peer that never answers warns once, then stops with the new text', { timeout: 60_000 }, async () => {
    const events = []
    const handle = runTask(taskOptions({
      taskId: 'hang-peer',
      apiKey: KEY,
      prompt: '不要回',
      payloadRoot: fakePeer({ hang: true }),
      stallMs: 2_000,
      stallHintMs: 500,
      onEvent: (event) => events.push(event),
    }))
    const end = await handle.done
    assert.equal(end.status, 'error', JSON.stringify(events))
    const hint = '这一步要写的东西比较长，还在等它写完；不想等可以点停下。'
    const hints = events.filter(event => event.type === 'progress' && event.text === hint)
    assert.equal(hints.length, 1, JSON.stringify(events.map(event => [event.type, event.text || event.message || ''])))
    assert.ok(events.indexOf(hints[0]) < events.findIndex(event => event.type === 'error'))
    const error = events.find(event => event.type === 'error')
    assert.equal(error.reason, 'stall')
    assert.equal(error.message, '十分钟没动静，已经先停了')
    assert.throws(() => process.kill(handle.pid, 0))
  })

  test('bundled python is what the workspace tool returns', { timeout: 60_000 }, async (t) => {
    ensureNode()
    if (!existsSync(join(layout.python, 'runtime.json'))) {
      t.skip('bundled python is not installed')
      return
    }
    let result = ''
    const fake = await startFake({
      expectKey: KEY,
      respond: (body) => {
        const raw = JSON.stringify(body)
        if (raw.includes('tool_result')) {
          result = raw
          return { kind: 'text', text: '好了' }
        }
        return { kind: 'tool', name: 'load_workspace_dependencies', input: {} }
      },
    })
    const events = []
    try {
      const end = await runTask({
        ...taskOptions({ taskId: 'py', apiKey: KEY, prompt: '准备', stallMs: 30_000, baseUrl: fake.url }),
        onEvent: (event) => events.push(event),
      }).done
      assert.equal(end.status, 'done', JSON.stringify(events))
      assert.match(result, process.platform === 'win32' ? /python\.exe/i : /python3/)
      assert.equal(/primary runtime|is_error":true/.test(result), false, result.slice(0, 1500))
    } finally {
      await fake.close()
    }
  })

  test('a scripted write shows up as an artifact', { timeout: 60_000 }, async () => {
    ensureNode()
    const options = taskOptions({ taskId: 'file', apiKey: KEY, prompt: '写', stallMs: 30_000 })
    const target = join(options.workspace, 'hello.txt')
    const fake = await startFake({
      expectKey: KEY,
      respond: (body) => {
        const raw = JSON.stringify(body)
        if (raw.includes('tool_result')) return { kind: 'text', text: '写好了' }
        return { kind: 'tool', name: 'write', input: { file_path: target, content: 'hello' } }
      },
    })
    const events = []
    try {
      options.baseUrl = fake.url
      options.onEvent = (event) => events.push(event)
      const end = await runTask(options).done
      assert.equal(end.status, 'done', JSON.stringify(events))
      assert.equal(readFileSync(target, 'utf8'), 'hello')
      assert.equal(events.some(event => event.type === 'artifact' && event.name === 'hello.txt' && event.path === target), true)
      assert.equal(events.some(event => event.type === 'progress' && event.text === '正在写 hello.txt'), true)
    } finally {
      await fake.close()
    }
  })

  test('cancel stops the process tree within two seconds', { timeout: 60_000 }, async () => {
    ensureNode()
    const fake = await startFake({ expectKey: KEY, respond: () => ({ kind: 'hang' }) })
    try {
      const handle = runTask(taskOptions({
        taskId: 'cancel',
        apiKey: KEY,
        prompt: '停',
        baseUrl: fake.url,
        stallMs: 60_000,
      }))
      await new Promise(resolve => setTimeout(resolve, 500))
      const started = Date.now()
      handle.cancel()
      const end = await handle.done
      assert.equal(end.status, 'cancelled')
      assert.ok(Date.now() - started < 2_000)
      await new Promise(resolve => setTimeout(resolve, 200))
      assert.throws(() => process.kill(handle.pid, 0))
    } finally {
      await fake.close()
    }
  })

  test('danger-full-access is rejected and the key stays out of the log', { timeout: 60_000 }, async () => {
    ensureNode()
    const outside = join(scratch('sidemate-out-'), 'secret.txt')
    let sawRejection = false
    const fake = await startFake({
      expectKey: KEY,
      respond: (body) => {
        const raw = JSON.stringify(body)
        if (raw.includes('tool_result') || raw.includes('rejected') || raw.includes('sandbox')) {
          sawRejection = /rejected|sandbox|denied|拒绝/i.test(raw)
          return { kind: 'text', text: '停了' }
        }
        return {
          kind: 'tool',
          name: 'write',
          input: {
            file_path: outside,
            content: 'nope',
            sandbox_permissions: 'danger-full-access',
            justification: 'need full access',
          },
        }
      },
    })
    const events = []
    const logs = []
    try {
      const handle = runTask(taskOptions({
        taskId: 'deny',
        apiKey: KEY,
        prompt: '写到外面',
        baseUrl: fake.url,
        stallMs: 30_000,
        onEvent: (event) => events.push(event),
        onLog: (line) => logs.push(line),
      }))
      const end = await handle.done
      assert.equal(end.status, 'done', JSON.stringify({ events, calls: fake.calls.length }))
      assert.equal(existsSync(outside), false)
      assert.equal(sawRejection, true, JSON.stringify(fake.calls).slice(0, 2000))
      const log = readFileSync(handle.logPath, 'utf8')
      assert.equal(log.includes(KEY), false)
      assert.equal(logs.some(line => line.includes(KEY)), false)
      assert.equal(JSON.stringify(events).includes(KEY), false)
    } finally {
      await fake.close()
    }
  })

  test('a dead process becomes an error without taking the caller down', { timeout: 60_000 }, async () => {
    ensureNode()
    const fake = await startFake({ expectKey: KEY, respond: () => ({ kind: 'hang' }) })
    const events = []
    try {
      const handle = runTask(taskOptions({
        taskId: 'crash',
        apiKey: KEY,
        prompt: '崩',
        baseUrl: fake.url,
        stallMs: 30_000,
        onEvent: (event) => events.push(event),
      }))
      await new Promise(resolve => setTimeout(resolve, 400))
      process.kill(handle.pid, 'SIGKILL')
      const end = await handle.done
      assert.equal(end.status, 'error')
      assert.equal(events.some(event => event.type === 'error' && event.reason === 'crash' && event.message === '没干成：后台程序中途退出了'), true)
    } finally {
      await fake.close()
    }
  })

  test('an echoed key is scrubbed from progress and the log', { timeout: 60_000 }, async () => {
    ensureNode()
    const fake = await startFake({
      expectKey: KEY,
      respond: () => ({ kind: 'text', text: `泄漏 ${KEY} 结束` }),
    })
    const events = []
    try {
      const handle = runTask(taskOptions({
        taskId: 'redact',
        apiKey: KEY,
        prompt: '重复',
        baseUrl: fake.url,
        stallMs: 30_000,
        onEvent: (event) => events.push(event),
      }))
      const end = await handle.done
      assert.equal(end.status, 'done')
      const blob = `${JSON.stringify(events)}\n${readFileSync(handle.logPath, 'utf8')}`
      assert.equal(blob.includes(KEY), false)
      assert.match(blob, /泄漏/)
    } finally {
      await fake.close()
    }
  })

  test('a second round resumes the same session and only counts its own usage', { timeout: 60_000 }, async () => {
    ensureNode()
    const shared = taskOptions({ apiKey: KEY, stallMs: 30_000, prompt: '第一轮' })
    let step = 0
    const fake = await startFake({
      expectKey: KEY,
      respond: () => {
        step += 1
        if (step === 1) {
          return { kind: 'text', text: '回复一\n下一行', usage: { input_tokens: 11, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } }
        }
        return { kind: 'text', text: '回复二', usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 } }
      },
    })
    try {
      const firstEvents = []
      const first = runTask({ ...shared, taskId: 'round-1', baseUrl: fake.url, onEvent: (event) => firstEvents.push(event) })
      assert.equal((await first.done).status, 'done', JSON.stringify(firstEvents))
      assert.equal(firstEvents.find(event => event.type === 'reply')?.text, '回复一\n下一行')
      assert.equal(firstEvents.find(event => event.type === 'usage')?.inputTokens, 11)
      const secondEvents = []
      const second = runTask({
        ...shared,
        taskId: 'round-2',
        sessionId: first.sessionId,
        prompt: '第二轮',
        baseUrl: fake.url,
        onEvent: (event) => secondEvents.push(event),
      })
      assert.equal((await second.done).status, 'done', JSON.stringify(secondEvents))
      assert.equal(second.sessionId, first.sessionId)
      const later = fake.calls.slice(1).map(call => JSON.stringify(call)).join('\n')
      assert.match(later, /第一轮/)
      assert.match(later, /回复一/)
      const usage = secondEvents.find(event => event.type === 'usage')
      assert.equal(usage?.inputTokens, 7)
      assert.equal(usage?.outputTokens, 3)
      assert.equal(usage?.cacheReadTokens, 1)
      assert.equal(usage?.cacheWriteTokens, 0)
    } finally {
      await fake.close()
    }
  })

  test('editing a file emits another artifact', { timeout: 60_000 }, async () => {
    ensureNode()
    const shared = taskOptions({ apiKey: KEY, stallMs: 30_000, prompt: '写' })
    const target = join(shared.workspace, 'hello.txt')
    let step = 0
    const fake = await startFake({
      expectKey: KEY,
      respond: () => {
        step += 1
        if (step === 1) return { kind: 'tool', name: 'write', input: { file_path: target, content: '第一份' } }
        if (step === 3) return { kind: 'tool', name: 'read', input: { file_path: target } }
        if (step === 4) return { kind: 'tool', name: 'write', input: { file_path: target, content: '第二份' } }
        return { kind: 'text', text: '好了' }
      },
    })
    try {
      const firstEvents = []
      const first = runTask({ ...shared, taskId: 'edit-1', baseUrl: fake.url, onEvent: (event) => firstEvents.push(event) })
      assert.equal((await first.done).status, 'done', JSON.stringify(firstEvents))
      assert.equal(readFileSync(target, 'utf8'), '第一份')
      assert.equal(firstEvents.filter(event => event.type === 'artifact' && event.name === 'hello.txt').length, 1)
      const secondEvents = []
      const second = runTask({
        ...shared,
        taskId: 'edit-2',
        sessionId: first.sessionId,
        prompt: '改',
        baseUrl: fake.url,
        onEvent: (event) => secondEvents.push(event),
      })
      assert.equal((await second.done).status, 'done', JSON.stringify(secondEvents))
      assert.equal(readFileSync(target, 'utf8'), '第二份')
      assert.equal(secondEvents.filter(event => event.type === 'artifact' && event.name === 'hello.txt').length, 1)
    } finally {
      await fake.close()
    }
  })

  test('http failures keep their reason', { timeout: 120_000 }, async () => {
    ensureNode()
    const cases = [
      { status: 401, body: { error: { type: 'authentication_error', message: 'Authentication Fails, Your api key is invalid' } }, reason: 'key' },
      { status: 403, body: { error: { type: 'permission_error', message: '403 Forbidden' } }, reason: 'key' },
      { status: 402, body: { error: { type: 'invalid_request_error', message: 'Insufficient Balance' } }, reason: 'quota' },
      { status: 429, body: { error: { type: 'rate_limit_error', message: 'Rate limit reached for requests' } }, reason: 'busy' },
      { status: 500, body: { error: { type: 'api_error', message: 'Internal server error' } }, reason: 'busy' },
    ]
    for (const item of cases) {
      const events = []
      const logs = []
      const fake = await startFake({
        expectKey: KEY,
        respond: () => ({ kind: 'status', status: item.status, body: JSON.stringify(item.body) }),
      })
      try {
        const handle = runTask(taskOptions({
          taskId: `http-${item.status}`,
          apiKey: KEY,
          prompt: '试',
          baseUrl: fake.url,
          stallMs: 60_000,
          onEvent: (event) => events.push(event),
          onLog: (line) => logs.push(line),
        }))
        const end = await handle.done
        assert.equal(end.status, 'error', `${item.status} ${JSON.stringify(events)}`)
        const error = events.find(event => event.type === 'error')
        assert.equal(error?.reason, item.reason, `${item.status} ${error?.message} ${logs.join('\n').slice(-500)}`)
        assert.equal(logs.join('\n').includes(KEY), false)
        assert.match(logs.join('\n'), /turn failed|Authentication|Balance|Rate limit|server error|403/)
      } finally {
        await fake.close()
      }
    }
    const events = []
    const handle = runTask(taskOptions({
      taskId: 'offline',
      apiKey: KEY,
      prompt: '试',
      baseUrl: 'http://127.0.0.1:1',
      stallMs: 60_000,
      onEvent: (event) => events.push(event),
    }))
    const end = await handle.done
    assert.equal(end.status, 'error')
    assert.equal(events.find(event => event.type === 'error')?.reason, 'network')
  })

  test('chunks that share a message id join into one reply', { timeout: 60_000 }, async () => {
    ensureNode()
    const { end, events } = await runScript('join', () => ({ kind: 'text', id: 'same', chunks: ['你', '好'] }))
    assert.equal(end.status, 'done', JSON.stringify(events))
    assert.deepEqual(replyTexts(events), ['你好'])
  })

  test('a new message id starts another reply', { timeout: 60_000 }, async () => {
    ensureNode()
    const { end, events } = await runScript('ids', (body) => {
      if (JSON.stringify(body).includes('tool_result')) return { kind: 'text', id: 'm2', chunks: ['乙', '方'] }
      return {
        kind: 'script',
        id: 'm1',
        blocks: [
          { type: 'text', text: '甲' },
          { type: 'text', text: '方' },
          { type: 'tool', name: 'web_search', input: { query: 'q' } },
        ],
      }
    })
    assert.equal(end.status, 'done', JSON.stringify(events))
    assert.deepEqual(replyTexts(events), ['甲方', '乙方'])
  })

  test('a tool call between text splits the reply once', { timeout: 60_000 }, async () => {
    ensureNode()
    const { end, events, trace } = await runScript('tool-split', (body) => {
      if (JSON.stringify(body).includes('tool_result')) return { kind: 'text', id: 'after', chunks: ['后', '面'] }
      return {
        kind: 'script',
        id: 'before',
        blocks: [
          { type: 'text', text: '前' },
          { type: 'text', text: '面' },
          { type: 'tool', name: 'web_search', input: { query: 'q' } },
        ],
      }
    })
    assert.equal(end.status, 'done', JSON.stringify(events))
    assert.deepEqual(replyTexts(events), ['前面', '后面'])
    assert.deepEqual(trace.filter(item => item.startsWith('reply:') || item.startsWith('progress:')), [
      'reply:前面',
      'progress:正在查资料',
      'reply:后面',
    ])
  })

  test('a usage update between text splits the reply once', { timeout: 60_000 }, async () => {
    ensureNode()
    const { end, events, trace } = await runScript('usage-split', (body) => {
      if (JSON.stringify(body).includes('tool_result')) return { kind: 'text', id: 'u2', chunks: ['下', '半'] }
      return {
        kind: 'script',
        id: 'u1',
        blocks: [
          { type: 'text', text: '上' },
          { type: 'text', text: '半' },
          { type: 'tool', name: 'web_search', input: { query: 'q' } },
        ],
      }
    })
    assert.equal(end.status, 'done', JSON.stringify(events))
    assert.deepEqual(replyTexts(events), ['上半', '下半'])
    assert.equal(trace[0], 'reply:上半')
    assert.equal(trace[1], 'usage_update')
    assert.ok(trace.indexOf('reply:下半') > 1)
  })

  test('a blank reply is not emitted', { timeout: 60_000 }, async () => {
    ensureNode()
    const only = await runScript('blank', () => ({ kind: 'text', id: 'blank', chunks: ['  \n', ' \t'] }))
    assert.equal(only.end.status, 'done', JSON.stringify(only.events))
    assert.deepEqual(replyTexts(only.events), [])
    const split = await runScript('blank-split', (body) => {
      if (JSON.stringify(body).includes('tool_result')) return { kind: 'text', id: 'real', text: '好了' }
      return {
        kind: 'script',
        id: 'gap',
        blocks: [
          { type: 'text', text: '  \n' },
          { type: 'tool', name: 'web_search', input: { query: 'q' } },
        ],
      }
    })
    assert.equal(split.end.status, 'done', JSON.stringify(split.events))
    assert.deepEqual(replyTexts(split.events), ['好了'])
  })

  test('two web searches count as two', { timeout: 60_000 }, async () => {
    ensureNode()
    let step = 0
    const { end, events } = await runScript('searches', () => {
      step += 1
      if (step === 1) return { kind: 'tool', name: 'web_search', messageId: 's1', input: { query: '第一次' } }
      if (step === 2) return { kind: 'tool', name: 'web_search', messageId: 's2', input: { query: '第二次' } }
      return { kind: 'text', id: 's3', text: '查完了' }
    })
    assert.equal(end.status, 'done', JSON.stringify(events))
    assert.equal(events.find(event => event.type === 'usage')?.searches, 2)
    assert.equal(events.filter(event => event.type === 'progress' && event.text === '正在查资料').length, 2)
  })

  test('a continued session with no usage baseline does not emit usage', { timeout: 120_000 }, async () => {
    ensureNode()
    let n = 0
    const fake = await startFake({
      expectKey: KEY,
      respond: () => {
        n += 1
        return { kind: 'text', text: `第${n}轮`, usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
      },
    })
    try {
      for (const mode of ['missing', 'unreadable', 'unparsed']) {
        const options = taskOptions({ apiKey: KEY, stallMs: 30_000, prompt: '接着', baseUrl: fake.url })
        const firstEvents = []
        const first = runTask({ ...options, taskId: `base-${mode}-1`, onEvent: (event) => firstEvents.push(event) })
        assert.equal((await first.done).status, 'done', `${mode} ${JSON.stringify(firstEvents)}`)
        assert.equal(firstEvents.some(event => event.type === 'usage'), true, mode)
        const file = join(options.lowRoot, 'dsh', 'storages', 'session_projcache', 'sessions', `${first.sessionId}.json`)
        assert.equal(existsSync(file), true, mode)
        if (mode === 'missing') rmSync(file)
        else if (mode === 'unreadable') {
          denyRead(file)
          assert.throws(() => readFileSync(file), mode)
        }
        else writeFileSync(file, '{')
        const events = []
        const logs = []
        const second = runTask({
          ...options,
          taskId: `base-${mode}-2`,
          sessionId: first.sessionId,
          prompt: '继续',
          onEvent: (event) => events.push(event),
          onLog: (line) => logs.push(line),
        })
        const end = await second.done
        if (mode === 'unreadable' && existsSync(file)) allowRead(file)
        assert.equal(end.status, 'done', `${mode} ${JSON.stringify(events)}\n${logs.join('\n').slice(-800)}`)
        assert.equal(events.some(event => event.type === 'reply'), true, mode)
        assert.equal(events.some(event => event.type === 'usage'), false, mode)
        assert.equal(logs.some(line => line === 'usage baseline unread'), true, logs.join('\n'))
      }
    } finally {
      await fake.close()
    }
  })
})

test('a private node copy can stand in for the payload node', () => {
  const options = taskOptions({ taskId: 'node', apiKey: KEY, prompt: 'hi', workspace: scratch('sidemate-ws-') })
  const copy = join(options.lowRoot, 'node-copy.exe')
  assert.equal(dshLaunch(options).command, payloadLayout(options.payloadRoot).node)
  assert.equal(dshLaunch({ ...options, node: copy }).command, copy)
})

import { spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deskRoot } from '../workspace/index.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')

// 假服务一轮不到 1 秒。真模型事件空档大约 22 秒，搜索工具自己的时限是 60 秒。
// 90 秒只提示、十分钟才停：dsh 的 5 分钟是模型流空闲（吐字就重计），这里量的是 stdout 沉默，
// 一步没写完不出声，所以要留得比最长一步还长。
export const DEFAULT_STALL_MS = 600_000
export const DEFAULT_STALL_HINT_MS = 90_000
export const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic'
const USAGE_WAIT_MS = 3_000

const KEEP_ENV = [
  'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LC_ALL', 'TZ',
  'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA',
  'USERNAME', 'USERDOMAIN', 'PROCESSOR_ARCHITECTURE',
]

const ZERO = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

const SAY = {
  key: '没干成：模型那边说 key 不对',
  quota: '没干成：模型那边余额不够',
  busy: '没干成：模型那边太忙',
  network: '没干成：连不上模型那边',
  stall: '十分钟没动静，已经先停了',
  stallHint: '这一步要写的东西比较长，还在等它写完；不想等可以点停下。',
  crashStart: '没干成：后台程序没起来',
  crashExit: '没干成：后台程序中途退出了',
  other: '没干成，原因记在日志里',
}

export function lowDir() {
  if (process.platform === 'win32') {
    return join(process.env.USERPROFILE || homedir(), 'AppData', 'LocalLow', '桌伴')
  }
  return join(homedir(), '.local', 'share', '桌伴')
}

export function payloadLayout(root = join(repo, 'payload')) {
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
  return {
    root,
    node: join(root, 'node', nodeName),
    dsh: join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    python: join(root, 'python'),
  }
}

export function patchFiles() {
  const files = [
    join(here, 'office.patch.yml'),
    join(here, 'skill.patch.yml'),
    join(here, 'word-skill.patch.yml'),
    join(here, 'never.patch.yml'),
    join(here, 'title.patch.yml'),
    join(here, 'rules.patch.yml'),
  ]
  if (process.platform === 'win32') files.push(join(here, 'ps51.patch.yml'))
  return files
}

function keptEnv() {
  const env = {}
  for (const name of KEEP_ENV) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return env
}

function redact(text, secret) {
  if (!secret || !text) return text ?? ''
  return String(text).split(secret).join('***')
}

function toolHint(update) {
  const input = update.rawInput && typeof update.rawInput === 'object' ? update.rawInput : {}
  const raw = input.file_path || input.path || input.query || ''
  if (typeof raw !== 'string' || raw === '') return ''
  return basename(raw)
}

export function progressText(update) {
  if (update.sessionUpdate !== 'tool_call') return ''
  const name = update.title || ''
  const hint = toolHint(update)
  if (name === 'web_search') return '正在查资料'
  if (name === 'web_fetch') return '正在打开网页'
  if (name === 'write' || name === 'edit') return hint ? `正在写 ${hint}` : '正在写文件'
  if (name === 'read') return hint ? `正在看 ${hint}` : '正在看文件'
  if (name === 'load_workspace_dependencies') return '正在准备写文件'
  return hint ? `正在处理 ${hint}` : '正在干活'
}

// ACP 只把对方的 message 原文包进 turn failed。下面这些字是 401 / 402 / 429 / 500 / 连不上各自打出来的。
export function classifyFailure(text) {
  const raw = text || ''
  if (/transport failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|fetch failed|socket hang up/i.test(raw)) return 'network'
  if (/authentication|api key|unauthorized|\b401\b|\b403\b/i.test(raw)) return 'key'
  if (/insufficient[\s_-]+(?:quota|balance|credits?)|(?:balance|credits?)[\s_-]+(?:exhausted|depleted)|\b402\b/i.test(raw)) return 'quota'
  if (/rate limit|\b429\b|too many requests|overloaded|internal server error|\b50[0234]\b/i.test(raw)) return 'busy'
  return 'other'
}

function walkFiles(dir, out = []) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    if (name.startsWith('.')) continue
    const path = join(dir, name)
    let st
    try {
      st = statSync(path)
    } catch {
      continue
    }
    if (st.isDirectory()) walkFiles(path, out)
    else if (st.isFile()) out.push(path)
  }
  return out
}

function killTree(child) {
  const pid = child?.pid
  if (!pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.on('error', () => {
      // a missing taskkill must not take the shell down
    })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

function runtimeCarrier(pythonRoot, dest) {
  const manifest = join(pythonRoot, 'runtime.json')
  if (!existsSync(manifest)) return pythonRoot
  const link = join(dest, 'dependencies', 'python')
  mkdirSync(join(dest, 'dependencies'), { recursive: true })
  if (!existsSync(link)) symlinkSync(pythonRoot, link, process.platform === 'win32' ? 'junction' : 'dir')
  else if (!lstatSync(link).isSymbolicLink() && process.platform !== 'win32') return pythonRoot
  copyFileSync(manifest, join(dest, 'runtime.json'))
  return dest
}

// 用量文件和边界是同一时刻的快照：tokenUsage 是数，turnBoundary 说这份是不是这一轮 turn/end 之后写的。
function readTokenUsage(dshHome, sessionId) {
  const path = join(dshHome, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const rows = parsed.record?.rows ?? parsed.rows
    if (!rows) return undefined
    return { token: rows.tokenUsage?.val, boundary: rows.turnBoundary?.val }
  } catch {
    return undefined
  }
}

// 跟上了 = turn/end 之后写的那份：openTurnStartSeq 归空，且轮号已经过了起点。
// 老版本 dsh 没有 turnBoundary 这行，只能照旧看 tokenUsage.last.turn。
function usageCaughtUp(rows, startTurn) {
  const boundary = rows?.boundary
  if (boundary) return boundary.openTurnStartSeq === null && (boundary.lastTurn ?? 0) > startTurn
  return (rows?.token?.last?.turn ?? 0) > startTurn
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function dshLaunch(options) {
  const layout = payloadLayout(options.payloadRoot)
  const home = options.lowRoot ?? lowDir()
  const dshHome = join(home, 'dsh')
  // dsh 默认还会扫用户自己的 ~/.agents（技能目录和 AGENTS.md）。指到桌伴自己的 agents 目录，
  // 用户装给别的 AI 工具用的东西就进不来。起进程前确保它存在，里面不放东西。
  const agentsHome = join(home, 'agents')
  mkdirSync(agentsHome, { recursive: true })
  const temp = join(home, 'temp')
  const env = {
    ...keptEnv(),
    // 随包 Python 在 PowerShell 5.1 的管道里默认按 GBK 输出，中文全是乱码。盖住用户机器上可能有的同名变量。
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    DEEPSEEK_API_KEY: options.apiKey,
    DEEPSEEK_BASE_URL: options.baseUrl ?? DEFAULT_BASE_URL,
    DSH_HOME: dshHome,
    DSH_AGENTS_HOME: agentsHome,
    DSH_PRIMARY_RUNTIME: runtimeCarrier(layout.python, join(home, 'runtime')),
    DSH_SKILL_DIR: join(repo, 'app', 'skills'),
    // 用户自己的技能放 ~/桌伴/技能。目录还没有时 dsh 只当它是空的（缺目录是合法的空状态），不报错。
    DSH_USER_SKILL_DIR: join(deskRoot(), '技能'),
    TEMP: temp,
    TMP: temp,
    DSH_TELEMETRY_MODE: 'DISABLED',
    DSH_TELEMETRY_DISABLED: '1',
  }
  if (options.searchBaseUrl) env.DEEPSEEK_SEARCH_BASE_URL = options.searchBaseUrl
  return {
    command: options.node || layout.node,
    args: [layout.dsh, '--profile', 'acp', ...patchFiles().flatMap(file => ['--patch', file])],
    env,
    cwd: options.workspace,
    home,
    dshHome,
    agentsHome,
    temp,
    logPath: join(home, 'logs', `${String(options.taskId).replace(/[^\w.-]+/g, '_')}.log`),
  }
}

export function runTask(options = {}) {
  const taskId = options.taskId
  const secret = options.apiKey
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS
  const stallHintMs = options.stallHintMs ?? DEFAULT_STALL_HINT_MS
  let settled = false
  let resolveDone
  const done = new Promise(resolve => { resolveDone = resolve })
  const seen = new Map()
  let child
  let sessionId = options.sessionId
  let stall
  let stallHint
  let hinted
  let spoken
  let logPath = ''
  let dshHome = ''
  let searches = 0
  let replyId
  const replyParts = []
  const pending = new Map()
  let seq = 0
  let buffer = ''
  const handle = {
    pid: undefined,
    sessionId,
    logPath: '',
    done,
    cancel() {
      if (settled) return
      if (sessionId) send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
      writeLog('cancel')
      finish('cancelled')
    },
  }

  const emit = (event) => {
    const full = { taskId, at: Date.now(), ...event }
    options.onEvent?.(full)
    return full
  }

  const writeLog = (line) => {
    const safe = redact(line, secret)
    options.onLog?.(safe)
    if (!logPath) return
    try {
      appendFileSync(logPath, `${safe}\n`)
    } catch {
      // a full disk must not take the shell down
    }
  }

  const send = (message) => {
    child?.stdin.write(`${JSON.stringify(message)}\n`)
  }

  const request = (method, params) => {
    const id = ++seq
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      send({ jsonrpc: '2.0', id, method, params })
    })
  }

  const flushReply = () => {
    const text = redact(replyParts.join(''), secret)
    replyParts.length = 0
    replyId = undefined
    if (text.trim()) emit({ type: 'reply', text })
  }

  const publishFiles = () => {
    for (const path of walkFiles(options.workspace)) {
      let mtime
      try {
        mtime = statSync(path).mtimeMs
      } catch {
        continue
      }
      if (seen.get(path) === mtime) continue
      seen.set(path, mtime)
      emit({ type: 'artifact', path, name: basename(path) })
    }
  }

  const stopChild = () => {
    const gone = !child || child.exitCode != null || child.signalCode != null
    killTree(child)
    if (gone || !child) {
      resolveDone(endEvent)
      return
    }
    const timer = setTimeout(() => resolveDone(endEvent), 2_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveDone(endEvent)
    })
  }

  let endEvent
  const finish = (status, failure) => {
    if (settled) return
    settled = true
    clearTimeout(stall)
    clearTimeout(stallHint)
    for (const { reject } of pending.values()) reject(new Error('stopped'))
    pending.clear()
    void (async () => {
      try {
        flushReply()
        if (status !== 'cancelled') publishFiles()
        if (status === 'done') await emitUsage()
        if (failure) {
          writeLog(failure.detail || failure.message)
          emit({ type: 'error', reason: failure.reason, message: failure.message })
        }
        endEvent = emit({ type: 'end', status })
      } catch (error) {
        writeLog(error?.message || 'finish')
        if (!endEvent) endEvent = emit({ type: 'end', status: 'error' })
      }
      stopChild()
    })()
  }

  const arm = () => {
    clearTimeout(stall)
    clearTimeout(stallHint)
    hinted = false
    if (spoken) stallHint = setTimeout(() => {
      if (hinted || settled) return
      hinted = true
      emit({ type: 'progress', text: SAY.stallHint })
    }, stallHintMs)
    stall = setTimeout(() => finish('error', { reason: 'stall', message: SAY.stall, detail: 'stall' }), stallMs)
  }

  async function emitUsage() {
    if (handle.omitUsage) return
    const startTurn = handle.usageTurn ?? 0
    const base = handle.usageBase ?? ZERO
    const started = Date.now()
    const limit = options.usageWaitMs ?? USAGE_WAIT_MS
    let rows = readTokenUsage(dshHome, sessionId)
    while (!usageCaughtUp(rows, startTurn) && Date.now() - started < limit) {
      await sleep(40)
      rows = readTokenUsage(dshHome, sessionId)
    }
    const waited = Date.now() - started
    const val = rows?.token
    const caught = usageCaughtUp(rows, startTurn)
    if (!val?.totals || (!caught && (val?.last?.turn ?? 0) <= startTurn)) {
      writeLog(`usage unread searches ${searches}`)
      return
    }
    if (caught) writeLog(`usage caught up ${waited}ms`)
    else writeLog(`usage stale ${waited}ms step ${val.last.step}`)
    const totals = val.totals
    emit({
      type: 'usage',
      inputTokens: totals.uncachedInputTokens - base.uncachedInputTokens,
      outputTokens: totals.outputTokens - base.outputTokens,
      cacheReadTokens: totals.cacheReadTokens - base.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens - base.cacheWriteTokens,
      searches,
    })
  }

  const onUpdate = (update) => {
    if (update.sessionUpdate === 'agent_thought_chunk') {
      writeLog(`thought ${(update.content?.text || '').length}`)
      return
    }
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      if (replyId !== undefined && update.messageId !== replyId) flushReply()
      replyId = update.messageId
      replyParts.push(update.content.text || '')
      return
    }
    if (update.sessionUpdate === 'usage_update') {
      flushReply()
      writeLog(`usage_update ${JSON.stringify({ used: update.used, size: update.size, cost: update.cost ?? null })}`)
      return
    }
    if (update.sessionUpdate === 'tool_call') {
      flushReply()
      if (update.title === 'web_search') searches += 1
    }
    const text = redact(progressText(update), secret)
    if (text) emit({ type: 'progress', text })
  }

  const onMessage = (message) => {
    if (message.method === 'session/request_permission') {
      writeLog(`permission rejected ${message.params?.toolCall?.toolCallId ?? ''}`)
      if (message.id !== undefined) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: { outcome: { outcome: 'selected', optionId: 'reject-once' } },
        })
      }
      return
    }
    if (message.method === 'session/update') {
      onUpdate(message.params?.update ?? {})
      return
    }
    if (message.method && message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } })
      writeLog(`ignored ${message.method}`)
      return
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message || 'request failed'))
      else waiter.resolve(message.result)
    }
  }

  const failNow = (reason, message) => {
    const at = Date.now()
    const error = { type: 'error', taskId, at, reason, message }
    const end = { type: 'end', taskId, at, status: 'error' }
    options.onEvent?.(error)
    options.onEvent?.(end)
    resolveDone(end)
    return { cancel() {}, done, pid: undefined, sessionId: undefined, logPath: '' }
  }

  if (!taskId || !secret || !options.workspace || !options.prompt) return failNow('other', SAY.other)
  if (!isAbsolute(options.workspace)) return failNow('other', SAY.other)

  let launch
  try {
    launch = dshLaunch(options)
  } catch {
    return failNow('crash', SAY.crashStart)
  }
  logPath = launch.logPath
  dshHome = launch.dshHome
  handle.logPath = logPath
  try {
    mkdirSync(launch.dshHome, { recursive: true })
    mkdirSync(launch.temp, { recursive: true })
    mkdirSync(dirname(logPath), { recursive: true })
    mkdirSync(options.workspace, { recursive: true })
  } catch {
    return failNow('crash', SAY.crashStart)
  }
  for (const path of walkFiles(options.workspace)) {
    try {
      seen.set(path, statSync(path).mtimeMs)
    } catch {
      // a file that vanishes before the turn is not an artifact
    }
  }
  writeLog(`start ${taskId}`)

  try {
    child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
  } catch {
    return failNow('crash', SAY.crashStart)
  }
  handle.pid = child.pid
  arm()
  child.on('error', () => finish('error', { reason: 'crash', message: SAY.crashStart, detail: 'spawn' }))
  child.on('exit', () => {
    if (!settled) finish('error', { reason: 'crash', message: SAY.crashExit, detail: 'exit' })
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    for (const line of chunk.split(/\r?\n/)) if (line.trim()) writeLog(line.trim())
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      spoken = true
      arm()
      try {
        onMessage(JSON.parse(line))
      } catch {
        writeLog(line)
      }
    }
  })

  const doneProxy = new Promise(resolve => {
    const prior = resolveDone
    resolveDone = (value) => {
      prior(value ?? endEvent)
      resolve(value ?? endEvent)
    }
  })
  handle.done = doneProxy

  ;(async () => {
    try {
      await request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'sidemate', version: '0.1.0' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      })
      if (settled) return
      if (sessionId) {
        await request('session/resume', { sessionId, cwd: options.workspace, mcpServers: [] })
      } else {
        const created = await request('session/new', { cwd: options.workspace, mcpServers: [] })
        sessionId = created?.sessionId
      }
      handle.sessionId = sessionId
      if (settled) return
      const prior = readTokenUsage(dshHome, sessionId)
      if (options.sessionId && (prior === undefined || prior.token === undefined)) {
        writeLog('usage baseline unread')
        handle.omitUsage = true
      } else {
        // 起点轮号看边界那行：上一轮最后一步重试过时 tokenUsage.last 是空的，用它会把上一轮收尾当这一轮。
        handle.usageTurn = prior?.boundary?.lastTurn ?? prior?.token?.last?.turn ?? 0
        handle.usageBase = prior?.token?.totals ?? ZERO
      }
      const result = await request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: options.prompt }],
      })
      if (settled) return
      finish(result?.stopReason === 'cancelled' ? 'cancelled' : 'done')
    } catch (error) {
      if (settled) return
      const detail = error?.message || ''
      const reason = classifyFailure(detail)
      finish('error', { reason, message: SAY[reason] || SAY.other, detail })
    }
  })()

  return handle
}

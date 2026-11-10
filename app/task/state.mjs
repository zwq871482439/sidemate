// 任务窗的纯状态层：事件归约、状态机。只算，不碰窗口和文件。
// 文案在 ./text.mjs，页面那份视图在 ./view.mjs，路径名字的小工具在 ./paths.mjs。

import { dirname } from 'node:path'
import { addRecent, baseName, key } from './paths.mjs'
import { TEXT } from './text.mjs'

export { TEXT } from './text.mjs'
export { addRecent, fitName, fitPath } from './paths.mjs'
export { toTaskView } from './view.mjs'

const RETRY = { action: 'retry', label: TEXT.retry }
const SETTINGS = { action: 'settings', label: TEXT.settings }
const OPEN_SETTLED = { action: 'open-settled', label: TEXT.open }
const SETTLED = new Set(['asking', 'done', 'error', 'stopped'])

const entry = (p) => ({ path: p, name: baseName(p) })
const item = (kind, text, round, buttons, extra) => ({ kind, text, ask: false, buttons: buttons || [], round, ...(extra || {}) })
const ageCards = (cards) => cards.map((c) => (c.old ? c : { ...c, old: true }))

function result(state, pet, notify, extra) {
  const more = extra || {}
  return {
    state,
    start: more.start || null,
    cancel: more.cancel === true,
    settle: more.settle === true,
    pet: pet || null,
    notify: notify || '',
    petText: more.petText || '',
  }
}

const same = (state) => result(state)

// 后台事件只认正在跑的这一轮；还没开跑（runId 空）也不收
const foreign = (state, event) => !state.runId || event.taskId !== state.runId

function failText(reason, message, name) {
  if (typeof TEXT.fail[reason] === 'string') return TEXT.fail[reason]
  if (reason === 'locked' && name) return TEXT.locked(name)
  if (reason === 'changed' && name) return TEXT.changed(name)
  const msg = typeof message === 'string' ? message.trim().replace(/^没干成[:：]\s*/, '').replace(/[。.！!]+$/, '') : ''
  return msg ? `${msg}，点重来再试。` : TEXT.fallback
}

// 统一的开跑：换状态、清旧按钮和 ask、记 prompt、给 start
function startRun(state, prompt, runId, round, resume, cards) {
  const flow = state.flow.map((one) => ({ ...one, ask: false, buttons: [] }))
  const files = []
  if (state.template) files.push(state.template.name)
  for (const m of state.materials) files.push(m.name)
  flow.push(item('user', prompt, round, [], { files }))
  const next = { ...state, phase: 'working', runId, prompt, round, flow, look: false, cards, startedAt: Date.now() }
  const start = { runId, round, prompt, resume, place: { kind: state.place.kind, dir: state.place.dir }, template: state.template ? state.template.path : null, materials: state.materials.map((m) => m.path) }
  return result(next, 'work', '', { start })
}

// 装一次拖进来的东西；没东西可装返回 null。带文件夹就清空重装。
function loadDrop(state, files, folder, cell) {
  if (folder) {
    const seen = new Set()
    const materials = []
    for (const p of files) {
      if (!p || seen.has(key(p))) continue
      seen.add(key(p))
      materials.push(entry(p))
    }
    return { ...state, place: { kind: 'folder', dir: folder }, template: null, materials, phase: 'ready' }
  }
  const seen = new Set()
  if (state.template) seen.add(key(state.template.path))
  for (const m of state.materials) seen.add(key(m.path))
  const fresh = []
  for (const p of files) {
    if (!p || seen.has(key(p))) continue
    seen.add(key(p))
    fresh.push(p)
  }
  if (!fresh.length) return null
  const place = state.place.kind === 'none' ? { kind: 'files', dir: '' } : state.place
  if (cell !== 'template') return { ...state, place, phase: 'ready', materials: [...state.materials, ...fresh.map(entry)] }
  const materials = [...state.materials]
  for (const p of fresh.slice(1)) materials.push(entry(p))
  if (state.template) materials.push(state.template)
  return { ...state, place, phase: 'ready', template: entry(fresh[0]), materials }
}

// 换成新的空任务，流里先放一条收好的 note；只记产出目录，不把路径交给页面按钮。
function freshTask(state) {
  const to = state.cards[0]?.to
  const dir = typeof to === 'string' && to ? dirname(to) : ''
  const note = item('note', dir ? TEXT.settledKept : TEXT.settled, 0, dir ? [OPEN_SETTLED] : [])
  return { ...createTask(), foreground: state.foreground, settledDir: dir, flow: [note] }
}

function onDrop(state, event) {
  const files = Array.isArray(event.files) ? event.files : []
  const folder = typeof event.folder === 'string' && event.folder ? event.folder : ''
  const cell = event.cell === 'template' ? 'template' : 'materials'
  if (state.phase === 'working') {
    const last = state.flow[state.flow.length - 1]
    if (last && last.kind === 'note' && last.text === TEXT.busyDrop) return same(state)
    return result({ ...state, flow: [...state.flow, item('note', TEXT.busyDrop, state.round)] }, null)
  }
  if (SETTLED.has(state.phase)) {
    const base = freshTask(state)
    const loaded = loadDrop(base, files, folder, cell)
    if (!loaded) return same(state)
    return result(loaded, 'idle', '', { settle: true })
  }
  const loaded = loadDrop(state, files, folder, cell)
  return loaded ? result(loaded, null) : same(state)
}

function onRemove(state, event) {
  if ((state.phase !== 'empty' && state.phase !== 'ready') || !event.path) return same(state)
  const template = state.template && key(state.template.path) === key(event.path) ? null : state.template
  const materials = state.materials.filter((m) => key(m.path) !== key(event.path))
  if (template === state.template && materials.length === state.materials.length) return same(state)
  let phase = state.phase
  let place = state.place
  if (!template && !materials.length && place.kind === 'files') {
    phase = 'empty'
    place = { kind: 'none', dir: '' }
  }
  return result({ ...state, template, materials, phase, place }, null)
}

function onMove(state, event) {
  if ((state.phase !== 'empty' && state.phase !== 'ready') || !event.path) return same(state)
  const want = key(event.path)
  if (event.to === 'template') {
    if (state.template && key(state.template.path) === want) return same(state)
    const idx = state.materials.findIndex((m) => key(m.path) === want)
    if (idx === -1) return same(state)
    const materials = state.materials.filter((_, i) => i !== idx)
    if (state.template) materials.push(state.template)
    return result({ ...state, template: state.materials[idx], materials, phase: 'ready' }, null)
  }
  if (event.to === 'materials') {
    if (state.materials.some((m) => key(m.path) === want)) return same(state)
    if (!state.template || key(state.template.path) !== want) return same(state)
    return result({ ...state, template: null, materials: [...state.materials, state.template], phase: 'ready' }, null)
  }
  return same(state)
}

function onSend(state, event) {
  const text = typeof event.text === 'string' ? event.text.trim() : ''
  if (!text || !event.runId || state.phase === 'working') return same(state)
  if (state.phase === 'empty' || state.phase === 'ready') return startRun(state, text, event.runId, 1, false, state.cards)
  if (state.phase === 'done' || state.phase === 'asking') return startRun(state, text, event.runId, state.round + 1, true, state.cards)
  return startRun(state, text, event.runId, state.round + 1, false, ageCards(state.cards))
}

function onNew(state) {
  if (state.phase === 'working') {
    const last = state.flow[state.flow.length - 1]
    if (last && last.kind === 'note' && last.text === TEXT.busyNew) return same(state)
    return result({ ...state, flow: [...state.flow, item('note', TEXT.busyNew, state.round)] }, null)
  }
  if (SETTLED.has(state.phase)) return result(freshTask(state), 'idle', '', { settle: true })
  if (state.phase === 'ready') return result({ ...createTask(), foreground: state.foreground }, null)
  return same(state)
}

// 壳给的三步：拷文件、收拾地方、核出处。
// 页面上不再有过程行，这三步只管把小岛留在「干活中」，别的什么都不做。
function onStep(state, event) {
  if (foreign(state, event)) return same(state)
  return result(state, state.phase === 'working' ? 'work' : null)
}

// 进收尾态时的宠和通知：前台不打扰
// 宠的五种：work 干活中 · done 做完了（笑眼）· look 要你看一眼 · fail 没干成（平线）· idle 待命
function finish(state, phase, flow, notifyText, petText) {
  const kind = phase === 'done' ? 'done' : phase === 'asking' ? 'look' : 'fail'
  // 任务窗开着、在前台：用户已经看着了，小岛就待命
  if (state.foreground) return result({ ...state, phase, flow, look: false }, 'idle', '', { petText })
  return result({ ...state, phase, flow, look: true }, kind, notifyText, { petText })
}

const enterError = (state, text, buttons) => finish(state, 'error', [...state.flow, item('error', text, state.round, buttons)], text, text)

function onEnd(state, event) {
  if (foreign(state, event) || state.phase !== 'working') return same(state)
  if (event.status === 'cancelled') {
    return result({ ...state, phase: 'stopped', flow: [...state.flow, item('note', TEXT.stopped, state.round, [RETRY])], look: false }, 'idle')
  }
  if (event.status === 'error') return enterError(state, TEXT.fallback, [RETRY])
  if (event.status !== 'done') return same(state)
  const hasCard = state.cards.some((c) => c.round === state.round)
  let lastReply = null
  for (const one of state.flow) {
    if (one.kind === 'reply' && one.round === state.round) lastReply = one
  }
  const tail = lastReply ? String(lastReply.text).replace(/\s+$/, '') : ''
  if (!hasCard && (tail.endsWith('？') || tail.endsWith('?'))) {
    return finish(state, 'asking', state.flow.map((one) => (one === lastReply ? { ...one, ask: true } : one)), TEXT.askTail, tail)
  }
  // 做完了：不再收过程行，对话流里就是回答和产出卡
  return finish(state, 'done', state.flow, TEXT.done, TEXT.done)
}

export function createTask() {
  return {
    phase: 'empty', place: { kind: 'none', dir: '' }, template: null, materials: [],
    flow: [], cards: [], usages: [], round: 0, runId: null, prompt: '',
    foreground: false, look: false, seq: 0, settledDir: '', startedAt: 0,
  }
}

export function reduceTask(state, event) {
  if (!state || !event || typeof event.type !== 'string') return same(state)
  switch (event.type) {
    case 'drop':
      return onDrop(state, event)
    case 'remove':
      return onRemove(state, event)
    case 'move':
      return onMove(state, event)
    case 'send':
      return onSend(state, event)
    case 'retry':
      if (!SETTLED.has(state.phase) || !state.prompt || !event.runId) return same(state)
      return startRun(state, state.prompt, event.runId, state.round + 1, false, ageCards(state.cards))
    case 'stop':
      return state.phase === 'working' ? result(state, null, '', { cancel: true }) : same(state)
    case 'accept':
      if (!SETTLED.has(state.phase)) return same(state)
      return result(freshTask(state), 'idle', '', { settle: true })
    case 'new':
      return onNew(state)
    case 'window': {
      const fg = event.foreground === true
      if (fg && state.look) return result({ ...state, foreground: true, look: false }, 'idle')
      if (state.foreground === fg) return same(state)
      return result({ ...state, foreground: fg }, null)
    }
    case 'step':
      return onStep(state, event)
    case 'workspace':
      if (foreign(state, event) || state.place.kind !== 'files' || state.place.dir === event.dir) return same(state)
      return result({ ...state, place: { ...state.place, dir: event.dir } }, null)
    case 'progress': {
      // 页面上不再有过程行：只把小岛留在「干活中」，原话进日志
      if (foreign(state, event) || typeof event.text !== 'string' || !event.text.trim()) return same(state)
      return result(state, state.phase === 'working' ? 'work' : null)
    }
    case 'reply': {
      if (foreign(state, event) || typeof event.text !== 'string' || !event.text.trim()) return same(state)
      const text = event.text
      const flow = state.flow
      const last = flow[flow.length - 1]
      // 同一段被流式补全：后一段是前一段长出来的，还是同一个气泡，不重复
      if (last && last.kind === 'reply' && last.round === state.round && last.text && text.startsWith(last.text)) {
        const merged = flow.slice(0, -1).concat([{ ...last, text }])
        return result({ ...state, flow: merged }, state.phase === 'working' ? 'work' : null)
      }
      return result({ ...state, flow: [...flow, item('reply', text, state.round)] }, state.phase === 'working' ? 'work' : null)
    }
    case 'usage': {
      if (foreign(state, event)) return same(state)
      const tokens = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].reduce((sum, one) => sum + (Number(event[one]) || 0), 0)
      if (!tokens && !event.searches) return same(state)
      return result({ ...state, usages: [...state.usages, { round: state.round, tokens, searches: Number(event.searches) || 0 }] }, null)
    }
    case 'output': {
      if (foreign(state, event) || typeof event.name !== 'string' || !event.name.trim()) return same(state)
      const card = { id: String(state.seq + 1), name: event.name, to: event.to, pages: event.pages == null ? null : event.pages, cite: event.cite || null, round: state.round, old: false }
      return result({ ...state, seq: state.seq + 1, cards: [card, ...state.cards] }, state.phase === 'working' ? 'work' : null)
    }
    case 'error':
      if (foreign(state, event) || state.phase !== 'working') return same(state)
      return enterError(state, failText(event.reason, event.message, event.name), event.reason === 'key' ? [SETTINGS, RETRY] : [RETRY])
    case 'end':
      return onEnd(state, event)
    default:
      return same(state)
  }
}

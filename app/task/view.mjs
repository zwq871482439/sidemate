// 页面画的那条对话流：顶栏、对话流、小签行、输入区、产出卡。
// 只算，不碰窗口和文件。文案在 ./text.mjs，路径名字的小工具在 ./paths.mjs。

import { join } from 'node:path'
import { baseName, fitName, fitPath } from './paths.mjs'
import { TEXT } from './text.mjs'

export { addRecent, fitName, fitPath } from './paths.mjs'

// 原始事件流给测试和日志看：只有四个字段，形状不变
const publicItem = (one) => ({
  kind: one.kind,
  text: one.text,
  tail: one.kind === 'reply' && one.ask ? TEXT.askTail : '',
  buttons: (one.buttons || []).map((b) => ({ action: b.action, label: b.label })),
})

// 产出卡那一行：有什么写什么，不写钱、不写用量
const citeLine = (cite) => (cite.note
  ? cite.note
  : `${cite.verified} 句核上出处${cite.missed ? `，${cite.missed} 句没逐字核上（批注里标了）` : ''}`)

function cardOf(c) {
  const pages = c.pages == null || c.pages === '' ? '' : `${c.pages} 页`
  const cite = c.cite ? citeLine(c.cite) : ''
  return {
    id: c.id,
    name: c.name,
    label: fitName(c.name, 36),
    path: c.to,
    line: [pages, cite].filter(Boolean).join(' · '),
    cite: c.cite ? { text: cite, miss: c.cite.missed || 0 } : null,
    old: !!c.old,
    round: c.round,
  }
}

// 对话流：一轮里模型说的每一段都成一个气泡，按顺序排；产出卡跟在它那一轮的最后一块后面
function blocksOf(state, cards) {
  const items = state.flow
  const byRound = new Map()
  for (const card of cards) {
    const list = byRound.get(card.round) || []
    list.push(card)
    byRound.set(card.round, list)
  }
  const blocks = []
  for (const one of items) {
    if (one.kind === 'user') blocks.push({ kind: 'user', round: one.round, text: one.text, files: one.files || [] })
    else if (one.kind === 'reply') blocks.push({ kind: 'reply', round: one.round, text: one.text, ask: !!one.ask })
    else if (one.kind === 'note') blocks.push({ kind: 'note', round: one.round, text: one.text, buttons: one.buttons || [] })
    else if (one.kind === 'error') blocks.push({ kind: 'error', round: one.round, text: one.text, buttons: one.buttons || [] })
  }
  // 产出卡跟在它那一轮的最后一块后面
  const out = []
  for (let i = 0; i < blocks.length; i++) {
    const one = blocks[i]
    out.push(one)
    const next = blocks[i + 1]
    if (one.round == null) continue
    if (next && next.round === one.round) continue
    for (const card of byRound.get(one.round) || []) out.push({ kind: 'card', round: one.round, card })
  }
  // 干活中：最下面留一行浅字「正在工作 · 14 秒」，干完就没了
  if (state.phase === 'working') out.push({ kind: 'working', round: state.round, text: TEXT.working, since: state.startedAt || 0 })
  return out
}

function inputOf(phase) {
  if (phase === 'working') return { mode: 'working', hint: TEXT.busyHint, button: 'stop', canSend: false, focus: false }
  if (phase === 'asking') return { mode: 'ask', hint: TEXT.askHint, button: 'send', canSend: true, focus: true }
  if (phase === 'empty') return { mode: 'empty', hint: TEXT.inputHint, button: 'send', canSend: true, focus: false }
  if (phase === 'ready') return { mode: 'files', hint: TEXT.filesHint, button: 'send', canSend: true, focus: true }
  return { mode: 'continue', hint: TEXT.continueHint, button: 'send', canSend: true, focus: false }
}

// 卡二只认这个形状，页面上每个字都从这里出
export function toTaskView(state, options = {}) {
  const root = options.root || ''
  const recent = Array.isArray(options.recent) ? options.recent : []
  const recentTasks = Array.isArray(options.recentTasks) ? options.recentTasks : []
  const phase = state.phase
  let path
  if (state.place.kind === 'none') {
    path = root ? { text: TEXT.random, title: join(root, TEXT.random), open: join(root, TEXT.random) } : { text: TEXT.random, title: TEXT.randomTitle, open: '' }
  } else if (state.place.kind === 'files' && !state.place.dir) {
    path = { text: TEXT.pending, title: TEXT.pending, open: root ? join(root, '任务') : '' }
  } else {
    path = { text: fitPath(state.place.dir, 40), title: state.place.dir, open: state.place.dir }
  }
  const cards = state.cards.map(cardOf)
  const tags = []
  if (state.template) tags.push({ path: state.template.path, name: state.template.name, label: fitName(state.template.name, 16), role: 'template' })
  for (const m of state.materials) tags.push({ path: m.path, name: m.name, label: fitName(m.name, 16), role: 'material' })
  let none = null
  if (!state.cards.length && (phase === 'done' || phase === 'asking')) none = { text: TEXT.noOutput }
  return {
    phase,
    title: TEXT.title,
    top: {
      path,
      recent: {
        enabled: phase !== 'working',
        items: recent.map((dir) => ({ dir, name: baseName(dir) })),
        tasks: recentTasks.map((one) => ({ dir: one.out, name: fitName(one.name, 40) })),
        allTasks: typeof options.allTasks === 'string' ? options.allTasks : '',
      },
      newTask: TEXT.newTask,
      locked: phase !== 'empty' && phase !== 'ready',
      template: { hint: TEXT.templateHint, file: state.template ? { path: state.template.path, name: state.template.name, label: fitName(state.template.name, 20) } : null },
      materials: { hint: TEXT.materialsHint, files: state.materials.map((m) => ({ path: m.path, name: m.name, label: fitName(m.name, 20) })), badge: state.materials.length ? `材料 ${state.materials.length}` : '' },
    },
    tags,
    flow: state.flow.map(publicItem),
    blocks: blocksOf(state, cards),
    flowHint: phase === 'empty' ? TEXT.flowHint : (phase === 'ready' ? TEXT.filesFlowHint : ''),
    input: inputOf(phase),
    // 底下这层页面不画：run.mjs 靠它认产出的路径
    bottom: { hint: !state.cards.length && !none ? TEXT.outputsHint : '', none, cards },
    labels: {
      addFile: TEXT.addFile, send: TEXT.send, stop: TEXT.stop, latest: TEXT.latest,
      open: TEXT.open, reveal: TEXT.reveal, retry: TEXT.retry, accept: TEXT.accept,
      settings: TEXT.settings, newTask: TEXT.newTask, askTail: TEXT.askTail,
      working: TEXT.working, newMsg: TEXT.newMsg,
      tagTemplate: TEXT.tagTemplate, tagMaterial: TEXT.tagMaterial, tagRemove: TEXT.tagRemove,
      markTemplate: TEXT.markTemplate,
      dropTemplate: TEXT.dropTemplate, dropTemplateHint: TEXT.dropTemplateHint,
      dropMaterial: TEXT.dropMaterial, dropMaterialHint: TEXT.dropMaterialHint,
    },
  }
}

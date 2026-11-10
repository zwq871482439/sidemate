import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { TEXT, addRecent, createTask, fitName, fitPath, reduceTask, toTaskView } from '../../app/task/state.mjs'

const at = Date.UTC(2026, 10, 1, 12, 0, 0) // 周日闲时
const usage = (extra = {}) => ({ at, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, searches: 0, ...extra })
const working = (text = '干活', runId = 'w1') => reduceTask(createTask(), { type: 'send', text, runId }).state

// 视图里每个值走一遍：不许有 undefined、不许有 NaN
const walk = (value, where = 'view') => {
  assert.notEqual(value, undefined, `${where} 是 undefined`)
  if (value === null) return
  if (Array.isArray(value)) {
    value.forEach((one, i) => walk(one, `${where}[${i}]`))
    return
  }
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) walk(value[k], `${where}.${k}`)
    return
  }
  assert.equal(Number.isNaN(value), false, `${where} 是 NaN`)
}

test('1 空任务的视图逐个对', () => {
  const s = createTask()
  assert.equal(s.phase, 'empty')
  assert.equal(s.round, 0)
  assert.equal(s.runId, null)
  assert.equal(s.prompt, '')
  assert.equal(s.foreground, false)
  assert.equal(s.look, false)
  const v = toTaskView(s)
  assert.equal(v.phase, 'empty')
  assert.equal(v.title, '桌伴')
  assert.deepEqual(v.top.path, { text: TEXT.random, title: TEXT.randomTitle, open: '' })
  assert.equal(v.top.newTask, TEXT.newTask)
  assert.equal(v.top.locked, false)
  assert.deepEqual(v.top.template, { hint: TEXT.templateHint, file: null })
  assert.deepEqual(v.top.materials, { hint: TEXT.materialsHint, files: [], badge: '' })
  assert.deepEqual(v.tags, [])
  assert.equal(v.top.recent.enabled, true)
  assert.deepEqual(v.top.recent.items, [])
  assert.deepEqual(v.top.recent.tasks, [])
  assert.equal(v.top.recent.allTasks, '')
  assert.deepEqual(v.input, { mode: 'empty', hint: TEXT.inputHint, button: 'send', canSend: true, focus: false })
  assert.deepEqual(v.flow, [])
  assert.deepEqual(v.blocks, [])
  assert.equal(v.flowHint, '把文件拖进来，或者直接说一句话')
  assert.deepEqual(v.bottom, { hint: TEXT.outputsHint, none: null, cards: [] })
  assert.deepEqual(v.labels, {
    addFile: TEXT.addFile, send: TEXT.send, stop: TEXT.stop, latest: TEXT.latest,
    open: TEXT.open, reveal: TEXT.reveal, retry: TEXT.retry, accept: TEXT.accept,
    settings: TEXT.settings, newTask: TEXT.newTask, askTail: TEXT.askTail,
    tagTemplate: TEXT.tagTemplate, tagMaterial: TEXT.tagMaterial, tagRemove: TEXT.tagRemove,
    markTemplate: TEXT.markTemplate,
    dropTemplate: TEXT.dropTemplate, dropTemplateHint: TEXT.dropTemplateHint,
    dropMaterial: TEXT.dropMaterial, dropMaterialHint: TEXT.dropMaterialHint,
    working: TEXT.working, newMsg: TEXT.newMsg,
  })
  const v2 = toTaskView(s, { root: 'C:/Users/slow/桌伴', recent: ['C:/Users/slow/Desktop/本周材料', 'C:/别的'] })
  assert.deepEqual(v2.top.path, { text: TEXT.random, title: join('C:/Users/slow/桌伴', '随手'), open: join('C:/Users/slow/桌伴', '随手') })
  assert.deepEqual(v2.top.recent.items, [
    { dir: 'C:/Users/slow/Desktop/本周材料', name: '本周材料' },
    { dir: 'C:/别的', name: '别的' },
  ])
  // 拖了文件还没开工：任务路径待定，输入框聚焦
  const r = reduceTask(s, { type: 'drop', files: ['C:/材料/一份.pdf'] }).state
  const rv = toTaskView(r)
  assert.equal(rv.phase, 'ready')
  assert.deepEqual(rv.top.path, { text: TEXT.pending, title: TEXT.pending, open: '' })
  assert.deepEqual(toTaskView(r, { root: 'C:/Users/slow/桌伴' }).top.path, { text: TEXT.pending, title: TEXT.pending, open: join('C:/Users/slow/桌伴', '任务') })
  assert.deepEqual(rv.input, { mode: 'files', hint: TEXT.filesHint, button: 'send', canSend: true, focus: true })
  assert.equal(rv.flowHint, TEXT.filesFlowHint)
  assert.equal(toTaskView(reduceTask(r, { type: 'send', text: '写', runId: 't1' }).state).flowHint, '')
})

test('2 两格：drop 的 cell 规则、去重、文件夹重装、move、remove', () => {
  let s = reduceTask(createTask(), { type: 'drop', files: ['C:/材料/范本.docx', 'C:/材料/一.pdf', 'C:/材料/二.pdf'], cell: 'template' }).state
  assert.equal(s.phase, 'ready')
  assert.equal(s.template.path, 'C:/材料/范本.docx')
  assert.equal(s.template.name, '范本.docx')
  assert.deepEqual(s.materials.map((m) => m.path), ['C:/材料/一.pdf', 'C:/材料/二.pdf'])
  assert.deepEqual(s.place, { kind: 'files', dir: '' })
  // 不带 cell 算材料，已在格里的跳过
  s = reduceTask(s, { type: 'drop', files: ['C:/材料/一.pdf', 'C:/材料/三.pdf'] }).state
  assert.deepEqual(s.materials.map((m) => m.path), ['C:/材料/一.pdf', 'C:/材料/二.pdf', 'C:/材料/三.pdf'])
  assert.equal(reduceTask(s, { type: 'drop', files: ['C:/材料/一.pdf'] }).state, s)
  // 拖进范本格：新来的当范本，旧的落到材料格末尾；一次拖多份时旧范本仍在最末尾
  s = reduceTask(s, { type: 'drop', files: ['C:/材料/新范本.docx'], cell: 'template' }).state
  assert.equal(s.template.path, 'C:/材料/新范本.docx')
  assert.deepEqual(s.materials.map((m) => m.path), ['C:/材料/一.pdf', 'C:/材料/二.pdf', 'C:/材料/三.pdf', 'C:/材料/范本.docx'])
  let m3 = reduceTask(createTask(), { type: 'drop', files: ['C:/材料/旧范本.docx'], cell: 'template' }).state
  m3 = reduceTask(m3, { type: 'drop', files: ['C:/材料/附件.pdf'] }).state
  m3 = reduceTask(m3, { type: 'drop', files: ['C:/材料/新1.docx', 'C:/材料/新2.docx', 'C:/材料/新3.docx'], cell: 'template' }).state
  assert.equal(m3.template.path, 'C:/材料/新1.docx')
  assert.deepEqual(m3.materials.map((m) => m.path), ['C:/材料/附件.pdf', 'C:/材料/新2.docx', 'C:/材料/新3.docx', 'C:/材料/旧范本.docx'])
  // move 互换
  const moved = reduceTask(s, { type: 'move', path: 'C:/材料/一.pdf', to: 'template' })
  assert.equal(moved.state.template.path, 'C:/材料/一.pdf')
  assert.deepEqual(moved.state.materials.map((m) => m.path), ['C:/材料/二.pdf', 'C:/材料/三.pdf', 'C:/材料/范本.docx', 'C:/材料/新范本.docx'])
  const back = reduceTask(moved.state, { type: 'move', path: 'C:/材料/一.pdf', to: 'materials' })
  assert.equal(back.state.template, null)
  assert.equal(back.state.materials.at(-1).path, 'C:/材料/一.pdf')
  // 已在目标格、两格里都没有 → 原样
  assert.equal(reduceTask(back.state, { type: 'move', path: 'C:/材料/一.pdf', to: 'materials' }).state, back.state)
  assert.equal(reduceTask(back.state, { type: 'move', path: 'C:/材料/没有.pdf', to: 'template' }).state, back.state)
  // 文件夹清空重装
  const re = reduceTask(back.state, { type: 'drop', folder: 'C:/周材料', files: ['C:/周材料/一.pdf', 'C:/周材料/二.pdf'] })
  assert.deepEqual(re.state.place, { kind: 'folder', dir: 'C:/周材料' })
  assert.equal(re.state.template, null)
  assert.deepEqual(re.state.materials.map((m) => m.path), ['C:/周材料/一.pdf', 'C:/周材料/二.pdf'])
  assert.equal(re.state.phase, 'ready')
  // remove：folder 的去空留 ready，files 的去空回 empty
  let t = re.state
  t = reduceTask(t, { type: 'remove', path: 'C:/周材料/一.pdf' }).state
  t = reduceTask(t, { type: 'remove', path: 'C:/周材料/二.pdf' }).state
  assert.equal(t.phase, 'ready')
  assert.deepEqual(t.place, { kind: 'folder', dir: 'C:/周材料' })
  let u = reduceTask(createTask(), { type: 'drop', files: ['C:/材料/一.pdf'] }).state
  u = reduceTask(u, { type: 'remove', path: 'C:/材料/一.pdf' }).state
  assert.equal(u.phase, 'empty')
  assert.deepEqual(u.place, { kind: 'none', dir: '' })
  // working 和收尾态里 remove、move 原样返回
  const w = working('干活')
  assert.equal(reduceTask(w, { type: 'remove', path: 'C:/材料/一.pdf' }).state, w)
  assert.equal(reduceTask(w, { type: 'move', path: 'C:/材料/一.pdf', to: 'template' }).state, w)
  let d = working('写', 'd1')
  d = reduceTask(d, { type: 'end', taskId: 'd1', status: 'done' }).state
  assert.equal(reduceTask(d, { type: 'remove', path: 'C:/材料/一.pdf' }).state, d)
  assert.equal(reduceTask(d, { type: 'move', path: 'C:/材料/一.pdf', to: 'template' }).state, d)
})

test('3 一整个任务：拖文件、发话、跑完出卡', () => {
  let s = createTask()
  const see = () => walk(toTaskView(s))
  s = reduceTask(s, { type: 'drop', files: ['C:/材料/周报范本.docx'], cell: 'template' }).state
  see()
  const six = ['一.pdf', '二.pdf', '三.pdf', '四.pdf', '五.pdf', '六.pdf'].map((n) => `C:/材料/${n}`)
  s = reduceTask(s, { type: 'drop', files: six }).state
  see()
  assert.equal(s.materials.length, 6)
  const sent = reduceTask(s, { type: 'send', text: ' 汇成本周周报 ', runId: 'r1' })
  s = sent.state
  see()
  assert.equal(sent.start.runId, 'r1')
  assert.equal(sent.start.round, 1)
  assert.equal(sent.start.prompt, '汇成本周周报')
  assert.equal(sent.start.resume, false)
  assert.deepEqual(sent.start.place, { kind: 'files', dir: '' })
  assert.equal(sent.start.template, 'C:/材料/周报范本.docx')
  assert.deepEqual(sent.start.materials, six)
  assert.equal(sent.pet, 'work')
  assert.equal(sent.notify, '')
  let v = toTaskView(s)
  assert.equal(s.phase, 'working')
  assert.equal(v.input.button, 'stop')
  assert.equal(v.input.canSend, false)
  assert.equal(v.input.hint, TEXT.busyHint)
  assert.equal(v.top.locked, true)
  assert.equal(v.top.recent.enabled, false)
  assert.equal(v.flow.at(-1).kind, 'user')
  assert.equal(v.flow.at(-1).text, '汇成本周周报')
  const before = s.flow.length
  s = reduceTask(s, { type: 'step', taskId: 'r1', step: 'prepare' }).state
  see()
  assert.equal(s.flow.length, before)
  s = reduceTask(s, { type: 'step', taskId: 'r1', step: 'copy' }).state
  see()
  assert.equal(s.flow.length, before)
  assert.equal(s.flow.some((one) => one.kind === 'progress'), false)
  // 干活中：对话流最下面一行浅字「正在工作 · x 秒」
  const workingBlocks = toTaskView(s).blocks
  assert.equal(workingBlocks.at(-1).kind, 'working')
  assert.equal(workingBlocks.at(-1).text, TEXT.working)
  assert.equal(workingBlocks.at(-1).since, s.startedAt)
  const dir = 'C:/Users/slow/桌伴/任务/1104-汇成本周周报'
  s = reduceTask(s, { type: 'workspace', taskId: 'r1', dir }).state
  v = toTaskView(s)
  assert.equal(v.top.path.text, fitPath(dir, 40))
  assert.equal(v.top.path.title, dir)
  assert.equal(v.top.path.open, dir)
  const p1 = reduceTask(s, { type: 'progress', taskId: 'r1', text: '正在写 本周周报.docx' })
  s = p1.state
  see()
  // 过程行没了：进度只把小岛留在干活中，对话流里不添东西
  assert.equal(s.flow.some((one) => one.kind === 'progress'), false)
  assert.equal(p1.pet, 'work')
  assert.equal(p1.petText, '')
  s = reduceTask(s, { type: 'reply', taskId: 'r1', text: '本周周报写好了。' }).state
  see()
  const u = usage({ inputTokens: 100_000, outputTokens: 2_000, cacheReadTokens: 50_000, cacheWriteTokens: 10_000 })
  s = reduceTask(s, { type: 'usage', taskId: 'r1', ...u }).state
  see()
  s = reduceTask(s, { type: 'output', taskId: 'r1', name: '本周周报.docx', to: `${dir}/桌伴输出/本周周报.docx`, pages: 3, cite: { verified: 12, missed: 1 } }).state
  see()
  const ended = reduceTask(s, { type: 'end', taskId: 'r1', status: 'done' })
  s = ended.state
  see()
  assert.equal(s.phase, 'done')
  assert.equal(s.flow.at(-1).kind, 'reply')
  assert.equal(s.flow.at(-1).text, '本周周报写好了。')
  assert.equal(s.flow.some((one) => one.kind === 'progress'), false)
  // 干完了：「正在工作」那一行没了
  assert.equal(toTaskView(s).blocks.some((one) => one.kind === 'working'), false)
  assert.equal(ended.pet, 'done')
  assert.equal(ended.notify, '做完了')
  assert.equal(s.look, true)
  v = toTaskView(s)
  const card = v.bottom.cards[0]
  assert.equal(card.id, '1')
  assert.equal(card.name, '本周周报.docx')
  assert.equal(card.path, `${dir}/桌伴输出/本周周报.docx`)
  assert.equal(card.line, '3 页 · 12 句核上出处，1 句没逐字核上（批注里标了）')
  assert.deepEqual(card.cite, { text: '12 句核上出处，1 句没逐字核上（批注里标了）', miss: 1 })
  assert.equal(card.old, false)
  assert.equal(v.bottom.hint, '')
  assert.equal(v.bottom.none, null)
})

test('4 taskId 对不上的一律原样返回', () => {
  const s = working('写', 't1')
  for (const event of [
    { type: 'step', taskId: '别的', step: 'prepare' },
    { type: 'workspace', taskId: '别的', dir: 'C:/任务/别的' },
    { type: 'progress', taskId: '别的', text: '正在写 本周周报.docx' },
    { type: 'reply', taskId: '别的', text: '好了。' },
    { type: 'usage', taskId: '别的', ...usage({ inputTokens: 1_000 }) },
    { type: 'output', taskId: '别的', name: 'a.docx', to: 'C:/o/a.docx' },
    { type: 'error', taskId: '别的', reason: 'network' },
    { type: 'end', taskId: '别的', status: 'done' },
  ]) {
    assert.equal(reduceTask(s, event).state, s)
  }
  // 还没开跑（runId 空）时后台事件一律不收；status 不认识也原样
  const fresh = createTask()
  assert.equal(reduceTask(fresh, { type: 'progress', taskId: null, text: '正在写 a.docx' }).state, fresh)
  assert.equal(reduceTask(fresh, { type: 'end', taskId: null, status: 'done' }).state, fresh)
  assert.equal(reduceTask(s, { type: 'end', taskId: 't1', status: 'weird' }).state, s)
  // error、end 只在 working 响应
  let d = working('写', 't2')
  d = reduceTask(d, { type: 'end', taskId: 't2', status: 'done' }).state
  assert.equal(reduceTask(d, { type: 'error', taskId: 't2', reason: 'key' }).state, d)
  assert.equal(reduceTask(d, { type: 'end', taskId: 't2', status: 'error' }).state, d)
})

test('5 等你回话：问句收尾进 asking', () => {
  const askOnce = (mark, fg) => {
    let s = createTask()
    if (fg) s = reduceTask(s, { type: 'window', foreground: true }).state
    s = reduceTask(s, { type: 'send', text: '把材料改成正式口吻', runId: 'q1' }).state
    assert.deepEqual(s.place, { kind: 'none', dir: '' })
    assert.equal(toTaskView(s).top.path.text, TEXT.random)
    s = reduceTask(s, { type: 'reply', taskId: 'q1', text: `你要哪一份材料${mark}` }).state
    return reduceTask(s, { type: 'end', taskId: 'q1', status: 'done' })
  }
  let step = askOnce('？', false)
  let s = step.state
  assert.equal(s.phase, 'asking')
  assert.equal(s.look, true)
  assert.equal(step.pet, 'look')
  assert.equal(step.notify, TEXT.askTail)
  let v = toTaskView(s)
  assert.equal(v.flow.at(-1).kind, 'reply')
  assert.equal(v.flow.at(-1).tail, TEXT.askTail)
  assert.deepEqual(v.input, { mode: 'ask', hint: TEXT.askHint, button: 'send', canSend: true, focus: true })
  assert.deepEqual(v.bottom.none, { text: '没出文件' })
  walk(v)
  step = askOnce('?', false)
  assert.equal(step.state.phase, 'asking')
  step = askOnce('？', true)
  assert.equal(step.pet, 'idle')
  assert.equal(step.notify, '')
  assert.equal(step.state.look, false)
  // 这一轮有卡就是 done
  let d = working('写', 'q2')
  d = reduceTask(d, { type: 'output', taskId: 'q2', name: '一.docx', to: 'C:/o/一.docx' }).state
  d = reduceTask(d, { type: 'reply', taskId: 'q2', text: '起这个名行吗？' }).state
  d = reduceTask(d, { type: 'end', taskId: 'q2', status: 'done' }).state
  assert.equal(d.phase, 'done')
  walk(toTaskView(d))
  // 接着发一句：上一轮的 ask 清掉
  const again = reduceTask(s, { type: 'send', text: '就用第一份', runId: 'q3' })
  assert.equal(again.start.resume, true)
  assert.equal(again.start.round, 2)
  assert.equal(toTaskView(again.state).flow.find((one) => one.kind === 'reply').tail, '')
})

test('6 只聊天：没卡不是问句 → done，收下回空', () => {
  let s = working('讲个笑话', 'c1')
  const u = usage({ inputTokens: 1_000 })
  s = reduceTask(s, { type: 'reply', taskId: 'c1', text: '好。' }).state
  s = reduceTask(s, { type: 'usage', taskId: 'c1', ...u }).state
  s = reduceTask(s, { type: 'end', taskId: 'c1', status: 'done' }).state
  assert.equal(s.phase, 'done')
  const none = toTaskView(s).bottom.none
  assert.equal(none.text, '没出文件')
  walk(toTaskView(s))
  const acc = reduceTask(s, { type: 'accept' })
  assert.equal(acc.settle, true)
  assert.equal(acc.pet, 'idle')
  assert.equal(acc.state.phase, 'empty')
  assert.deepEqual(acc.state.flow.map((one) => [one.kind, one.text, one.buttons]), [['note', TEXT.settled, []]])
  assert.equal(acc.state.cards.length, 0)
  // 没有 usage 时只写「没出文件」
  let t = working('再讲一个', 'c2')
  t = reduceTask(t, { type: 'reply', taskId: 'c2', text: '好。' }).state
  t = reduceTask(t, { type: 'end', taskId: 'c2', status: 'done' }).state
  assert.deepEqual(toTaskView(t).bottom.none, { text: '没出文件' })
  walk(toTaskView(t))
})

test('7 出错的话：每种 reason 的字和按钮', () => {
  const cases = [
    [{ reason: 'key', message: '没干成：模型那边说 key 不对' }, TEXT.fail.key, 2],
    [{ reason: 'quota' }, TEXT.fail.quota, 1],
    [{ reason: 'network' }, TEXT.fail.network, 1],
    [{ reason: 'stall' }, TEXT.fail.stall, 1],
    [{ reason: 'broken' }, TEXT.fail.broken, 1],
    [{ reason: 'busy', message: '没干成：模型那边太忙' }, '模型那边太忙，点重来再试。', 1],
    [{ reason: 'busy', message: '没干成：模型那边太忙。' }, '模型那边太忙，点重来再试。', 1],
    [{ reason: 'busy' }, TEXT.fallback, 1],
    [{ reason: 'locked', name: '周报范本.docx' }, TEXT.locked('周报范本.docx'), 1],
    [{ reason: 'locked' }, TEXT.fallback, 1],
    [{ reason: 'changed', name: '材料三.xlsx' }, TEXT.changed('材料三.xlsx'), 1],
    [{ reason: 'changed', message: '文件被人改了！' }, '文件被人改了，点重来再试。', 1],
    [{ reason: '没听过的' }, TEXT.fallback, 1],
  ]
  for (const [evt, text, n] of cases) {
    const step = reduceTask(working('写', 'e1'), { type: 'error', taskId: 'e1', ...evt })
    assert.equal(step.state.phase, 'error', text)
    const last = step.state.flow.at(-1)
    assert.equal(last.kind, 'error')
    assert.equal(last.text, text)
    assert.equal(last.buttons.length, n)
    assert.equal(step.pet, 'fail')
    assert.equal(step.notify, text)
    assert.equal(step.state.look, true)
    const bad = toTaskView(step.state)
    assert.equal(bad.flow.at(-1).text, text)
    walk(bad)
  }
  // 新文案：90 秒只提示、十分钟才停，别再叫人去查网络
  assert.equal(TEXT.fail.stall, '十分钟没动静，已经先停了。点重来再试一次；连着两次这样，再检查网络。')
  const keyStep = reduceTask(working('写', 'e2'), { type: 'error', taskId: 'e2', reason: 'key' })
  assert.deepEqual(keyStep.state.flow.at(-1).buttons, [{ action: 'settings', label: '去设置' }, { action: 'retry', label: '重来' }])
  // 前台不打扰
  const fg = reduceTask(reduceTask(createTask(), { type: 'window', foreground: true }).state, { type: 'send', text: '写', runId: 'e3' })
  const fgErr = reduceTask(fg.state, { type: 'error', taskId: 'e3', reason: 'network' })
  assert.equal(fgErr.pet, 'idle')
  assert.equal(fgErr.notify, '')
  // end error 前面没来 error → 兜底那句
  const endErr = reduceTask(working('写', 'e4'), { type: 'end', taskId: 'e4', status: 'error' })
  assert.equal(endErr.state.phase, 'error')
  assert.equal(endErr.state.flow.at(-1).text, TEXT.fallback)
  assert.deepEqual(endErr.state.flow.at(-1).buttons, [{ action: 'retry', label: '重来' }])
  assert.equal(endErr.pet, 'fail')
  assert.equal(endErr.notify, TEXT.fallback)
  walk(toTaskView(endErr.state))
})

test('8 停下：stop、end cancelled、stopped 里再发', () => {
  let s = working('写个总结', 's1')
  const stop = reduceTask(s, { type: 'stop' })
  assert.equal(stop.cancel, true)
  assert.equal(stop.state, s)
  assert.equal(stop.pet, null)
  s = reduceTask(s, { type: 'output', taskId: 's1', name: '半成品.docx', to: 'C:/o/半成品.docx' }).state
  const ended = reduceTask(s, { type: 'end', taskId: 's1', status: 'cancelled' })
  s = ended.state
  assert.equal(s.phase, 'stopped')
  const last = s.flow.at(-1)
  assert.equal(last.kind, 'note')
  assert.equal(last.text, TEXT.stopped)
  assert.deepEqual(last.buttons, [{ action: 'retry', label: '重来' }])
  assert.equal(ended.pet, 'idle')
  assert.equal(ended.notify, '')
  assert.equal(s.look, false)
  assert.equal(toTaskView(s).input.hint, TEXT.continueHint)
  walk(toTaskView(s))
  const resent = reduceTask(s, { type: 'send', text: '再写一次', runId: 's2' })
  assert.equal(resent.start.resume, false)
  assert.equal(resent.start.round, 2)
  assert.equal(resent.start.prompt, '再写一次')
  assert.equal(toTaskView(resent.state).bottom.cards[0].old, true)
  walk(toTaskView(resent.state))
})

test('9 重来：error 里 retry，working 里原样', () => {
  let s = reduceTask(createTask(), { type: 'drop', files: ['C:/材料/范本一.docx', 'C:/材料/一份.pdf'], cell: 'template' }).state
  s = reduceTask(s, { type: 'send', text: '照范本写一份', runId: 'r1' }).state
  s = reduceTask(s, { type: 'output', taskId: 'r1', name: '成品.docx', to: 'C:/o/成品.docx' }).state
  s = reduceTask(s, { type: 'error', taskId: 'r1', reason: 'network' }).state
  assert.equal(reduceTask(s, { type: 'retry' }).state, s)
  const retried = reduceTask(s, { type: 'retry', runId: 'r2' })
  assert.equal(retried.start.runId, 'r2')
  assert.equal(retried.start.resume, false)
  assert.equal(retried.start.round, 2)
  assert.equal(retried.start.prompt, '照范本写一份')
  assert.equal(retried.start.template, 'C:/材料/范本一.docx')
  assert.deepEqual(retried.start.materials, ['C:/材料/一份.pdf'])
  assert.equal(retried.state.phase, 'working')
  assert.equal(retried.pet, 'work')
  const user = retried.state.flow.filter((one) => one.kind === 'user')
  assert.equal(user.length, 2)
  assert.equal(retried.state.flow.at(-1).text, '照范本写一份')
  assert.equal(toTaskView(retried.state).bottom.cards[0].old, true)
  assert.deepEqual(retried.state.flow.find((one) => one.kind === 'error').buttons, [])
  assert.equal(reduceTask(retried.state, { type: 'retry', runId: 'r3' }).state, retried.state)
})

test('10 做完再说一句：算下一轮，卡不变旧', () => {
  let s = working('写周报', 'n1')
  s = reduceTask(s, { type: 'output', taskId: 'n1', name: '周报.docx', to: 'C:/o/周报.docx', pages: 2 }).state
  s = reduceTask(s, { type: 'end', taskId: 'n1', status: 'done' }).state
  const again = reduceTask(s, { type: 'send', text: '再补一段风险', runId: 'n2' })
  assert.equal(again.start.resume, true)
  assert.equal(again.start.round, 2)
  assert.equal(again.start.prompt, '再补一段风险')
  assert.equal(again.start.template, null)
  assert.deepEqual(again.start.materials, [])
  assert.equal(again.state.cards, s.cards)
  assert.equal(toTaskView(again.state).bottom.cards[0].old, false)
  assert.equal(toTaskView(again.state).bottom.cards.length, 1)
})

test('11 聊完再拖：settle 换新任务，new 的三种走法', () => {
  let s = working('写周报', 'd1')
  s = reduceTask(s, { type: 'output', taskId: 'd1', name: '周报.docx', to: 'C:/o/周伴输出/周报.docx' }).state
  s = reduceTask(s, { type: 'end', taskId: 'd1', status: 'done' }).state
  s = reduceTask(s, { type: 'window', foreground: true }).state
  const dropped = reduceTask(s, { type: 'drop', files: ['C:/材料/新.pdf'] })
  assert.equal(dropped.settle, true)
  assert.equal(dropped.pet, 'idle')
  assert.equal(dropped.state.phase, 'ready')
  assert.deepEqual(dropped.state.flow.map((one) => one.text), [TEXT.settledKept])
  assert.equal(dropped.state.cards.length, 0)
  assert.equal(dropped.state.usages.length, 0)
  assert.equal(dropped.state.materials.length, 1)
  assert.equal(dropped.state.foreground, true)
  // 没卡时是 settled
  let t = working('写', 'd2')
  t = reduceTask(t, { type: 'end', taskId: 'd2', status: 'done' }).state
  const dropped2 = reduceTask(t, { type: 'drop', folder: 'C:/周材料', files: ['C:/周材料/一.pdf'] })
  assert.deepEqual(dropped2.state.flow.map((one) => one.text), [TEXT.settled])
  assert.deepEqual(dropped2.state.place, { kind: 'folder', dir: 'C:/周材料' })
  // working 里拖 → 一条 busyDrop，再拖不重复
  const w = working('干活', 'd3')
  const d1step = reduceTask(w, { type: 'drop', files: ['C:/材料/x.pdf'] })
  assert.equal(d1step.state.flow.at(-1).kind, 'note')
  assert.equal(d1step.state.flow.at(-1).text, TEXT.busyDrop)
  assert.equal(d1step.settle, false)
  assert.equal(reduceTask(d1step.state, { type: 'drop', files: ['C:/材料/y.pdf'] }).state, d1step.state)
  // new：working → busyNew；done → settle + empty + note；ready → 回到空
  const w2 = reduceTask(d1step.state, { type: 'new' })
  assert.equal(w2.state.flow.at(-1).text, TEXT.busyNew)
  assert.equal(reduceTask(w2.state, { type: 'new' }).state, w2.state)
  const newed = reduceTask(s, { type: 'new' })
  assert.equal(newed.settle, true)
  assert.equal(newed.pet, 'idle')
  assert.equal(newed.state.phase, 'empty')
  assert.deepEqual(newed.state.flow.map((one) => one.text), [TEXT.settledKept])
  let ready = reduceTask(createTask(), { type: 'drop', files: ['C:/材料/一.pdf'] }).state
  const cleared = reduceTask(ready, { type: 'new' })
  assert.equal(cleared.settle, false)
  assert.equal(cleared.state.phase, 'empty')
  assert.deepEqual(cleared.state.flow, [])
  const empty = createTask()
  assert.equal(reduceTask(empty, { type: 'new' }).state, empty)
})

test('12 前台：look 被窗口接管后清掉', () => {
  let s = working('写', 'f1')
  s = reduceTask(s, { type: 'reply', taskId: 'f1', text: '哪一份？' }).state
  s = reduceTask(s, { type: 'end', taskId: 'f1', status: 'done' }).state
  assert.equal(s.phase, 'asking')
  assert.equal(s.look, true)
  const w1 = reduceTask(s, { type: 'window', foreground: true })
  assert.equal(w1.pet, 'idle')
  assert.equal(w1.state.look, false)
  assert.equal(w1.state.foreground, true)
  const w2 = reduceTask(w1.state, { type: 'window', foreground: true })
  assert.equal(w2.pet, null)
  assert.equal(w2.state, w1.state)
  const w3 = reduceTask(w1.state, { type: 'window', foreground: false })
  assert.equal(w3.state.foreground, false)
  // look 不是 true 时来前台：只记 foreground，宠不动
  const plain = reduceTask(working('写', 'f2'), { type: 'window', foreground: true })
  assert.equal(plain.state.foreground, true)
  assert.equal(plain.state.look, false)
  assert.equal(plain.pet, null)
})

test('13 产出卡不写钱、不写用量', () => {
  let s = working('写', 'm1')
  const u1 = usage({ inputTokens: 100_000, outputTokens: 2_000, cacheReadTokens: 50_000, cacheWriteTokens: 10_000 })
  s = reduceTask(s, { type: 'usage', taskId: 'm1', ...u1 }).state
  s = reduceTask(s, { type: 'output', taskId: 'm1', name: '一.docx', to: 'C:/o/一.docx' }).state
  s = reduceTask(s, { type: 'end', taskId: 'm1', status: 'done' }).state
  s = reduceTask(s, { type: 'send', text: '再改', runId: 'm2' }).state
  s = reduceTask(s, { type: 'usage', taskId: 'm2', ...usage({ searches: 1 }) }).state
  s = reduceTask(s, { type: 'output', taskId: 'm2', name: '二.docx', to: 'C:/o/二.docx', pages: 5 }).state
  const v = toTaskView(s)
  const [second, first] = v.bottom.cards
  // 卡上只有页数和出处，一分钱、一个 token 都不写
  assert.equal(first.line, '')
  assert.equal(second.line, '5 页')
  assert.equal(v.bottom.none, null)
  const money = /这次约|元|毛|分|token|用量|万/i
  for (const card of v.bottom.cards) assert.equal(money.test(card.line), false, card.line)
  assert.equal(money.test(JSON.stringify(v)), false)
  // 没 usage 的卡也是空的
  const dry = reduceTask(working('写', 'm3'), { type: 'output', taskId: 'm3', name: '三.docx', to: 'C:/o/三.docx' }).state
  assert.equal(toTaskView(dry).bottom.cards[0].line, '')
})

test('14 fitName、fitPath、addRecent', () => {
  assert.equal(fitName('第三季度工程项目建设进展情况汇报.docx', 30), '第三季度工程项目…况汇报.docx')
  assert.equal(fitName('短.docx', 30), '短.docx')
  assert.equal(fitName('第三季度工程项目建设进展情况汇报.docx', 19), '第三季度…汇报.docx')
  assert.equal(fitPath('C:/Users/slow/Desktop/很长很长的一个文件夹名字/本周材料', 20), 'C:/ … /本周材料')
  assert.equal(fitPath('C:\\Users\\slow\\Desktop\\很长很长的一个文件夹名字\\本周材料', 20), 'C:\\ … \\本周材料')
  assert.equal(fitPath('C:/本周材料', 4), 'C:/本周材料')
  assert.equal(fitPath('C:/两级/本周材料', 4), 'C:/ … /本周材料')
  assert.equal(fitPath('C:/Users/slow/Desktop/本周材料', 60), 'C:/Users/slow/Desktop/本周材料')
  assert.deepEqual(addRecent(['C:/a', 'C:/b'], 'C:/c'), ['C:/c', 'C:/a', 'C:/b'])
  assert.deepEqual(addRecent(['C:/a', 'C:/B'], 'c:/b'), ['c:/b', 'C:/a'])
  assert.deepEqual(addRecent(['C:/a', 'C:/b', 'C:/c', 'C:/d', 'C:/e'], 'C:/f'), ['C:/f', 'C:/a', 'C:/b', 'C:/c', 'C:/d'])
  assert.deepEqual(addRecent(undefined, 'C:/a'), ['C:/a'])
})

test('15 不改传进来的东西：全程冻住再喂', () => {
  const deepFreeze = (value) => {
    if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) deepFreeze(value[k])
      Object.freeze(value)
    }
    return value
  }
  let s = deepFreeze(createTask())
  const feed = (event) => {
    s = deepFreeze(reduceTask(s, deepFreeze({ ...event })).state)
  }
  feed({ type: 'drop', files: ['C:/材料/周报范本.docx'], cell: 'template' })
  feed({ type: 'drop', files: ['C:/材料/一.pdf', 'C:/材料/二.pdf', 'C:/材料/三.pdf', 'C:/材料/四.pdf', 'C:/材料/五.pdf', 'C:/材料/六.pdf'] })
  feed({ type: 'send', text: '汇成本周周报', runId: 'z1' })
  feed({ type: 'step', taskId: 'z1', step: 'prepare' })
  feed({ type: 'step', taskId: 'z1', step: 'copy' })
  feed({ type: 'workspace', taskId: 'z1', dir: 'C:/Users/slow/桌伴/任务/1104-汇成本周周报' })
  feed({ type: 'progress', taskId: 'z1', text: '正在写 本周周报.docx' })
  feed({ type: 'progress', taskId: 'z1', text: '正在写 本周周报.docx' })
  feed({ type: 'reply', taskId: 'z1', text: '写好了。' })
  feed({ type: 'usage', taskId: 'z1', ...usage({ inputTokens: 1_000 }) })
  feed({ type: 'output', taskId: 'z1', name: '本周周报.docx', to: 'C:/o/本周周报.docx', pages: 3, cite: { verified: 12, missed: 1 } })
  feed({ type: 'end', taskId: 'z1', status: 'done' })
  feed({ type: 'retry', runId: 'z2' })
  feed({ type: 'error', taskId: 'z2', reason: 'network' })
  feed({ type: 'retry', runId: 'z3' })
  feed({ type: 'stop' })
  feed({ type: 'end', taskId: 'z3', status: 'cancelled' })
  feed({ type: 'send', text: '再来', runId: 'z4' })
  feed({ type: 'end', taskId: 'z4', status: 'done' })
  feed({ type: 'accept' })
  assert.equal(s.phase, 'empty')
  toTaskView(s, deepFreeze({ root: 'C:/Users/slow/桌伴', recent: ['C:/周材料'] }))
})

test('16 界面字里没有禁词', () => {
  const bad = /terminal|git|patch|mcp|token/i
  const views = []
  let s = createTask()
  views.push(toTaskView(s))
  s = reduceTask(s, { type: 'drop', files: ['C:/材料/范本.docx'], cell: 'template' }).state
  views.push(toTaskView(s, { root: 'C:/Users/slow/桌伴', recent: ['C:/周材料'] }))
  s = reduceTask(s, { type: 'send', text: '汇成本周周报', runId: 'g1' }).state
  views.push(toTaskView(s))
  s = reduceTask(s, { type: 'error', taskId: 'g1', reason: 'key' }).state
  views.push(toTaskView(s))
  s = reduceTask(s, { type: 'retry', runId: 'g2' }).state
  s = reduceTask(s, { type: 'reply', taskId: 'g2', text: '哪一份？' }).state
  s = reduceTask(s, { type: 'end', taskId: 'g2', status: 'done' }).state
  views.push(toTaskView(s))
  s = reduceTask(s, { type: 'send', text: '第一份', runId: 'g3' }).state
  s = reduceTask(s, { type: 'usage', taskId: 'g3', ...usage({ inputTokens: 1_000 }) }).state
  s = reduceTask(s, { type: 'output', taskId: 'g3', name: '本周周报.docx', to: 'C:/o/本周周报.docx', pages: 3, cite: { verified: 12, missed: 0 } }).state
  // missed 为 0 只说前半句
  assert.equal(toTaskView(s).bottom.cards[0].cite.text, '12 句核上出处')
  s = reduceTask(s, { type: 'end', taskId: 'g3', status: 'cancelled' }).state
  views.push(toTaskView(s))
  // 带 bottom.none 的钱那句和带 cite 的卡的视图也扫
  let q = working('聊', 'g4')
  q = reduceTask(q, { type: 'usage', taskId: 'g4', ...usage({ inputTokens: 100_000 }) }).state
  q = reduceTask(q, { type: 'reply', taskId: 'g4', text: '好了。' }).state
  q = reduceTask(q, { type: 'end', taskId: 'g4', status: 'done' }).state
  views.push(toTaskView(q))
  for (const v of views) {
    assert.equal(bad.test(JSON.stringify(v)), false, JSON.stringify(v).slice(0, 120))
  }
  assert.equal(bad.test(JSON.stringify(TEXT)), false)
})

test('17 一份都装不上的 drop：原样返回、不收下', () => {
  const fresh = createTask()
  const e = reduceTask(fresh, { type: 'drop', files: [] })
  assert.equal(e.state, fresh)
  assert.equal(e.settle, false)
  assert.equal(e.pet, null)
  const ready = reduceTask(fresh, { type: 'drop', files: ['C:/材料/一.pdf'] }).state
  const r = reduceTask(ready, { type: 'drop', files: [] })
  assert.equal(r.state, ready)
  assert.equal(r.settle, false)
  assert.equal(r.pet, null)
  // done 有卡、done 没卡、error 里都一样
  let d = working('写', 'k1')
  d = reduceTask(d, { type: 'output', taskId: 'k1', name: '周.docx', to: 'C:/o/周.docx' }).state
  d = reduceTask(d, { type: 'end', taskId: 'k1', status: 'done' }).state
  const dres = reduceTask(d, { type: 'drop', files: [] })
  assert.equal(dres.state, d)
  assert.equal(dres.settle, false)
  assert.equal(dres.pet, null)
  let n = working('聊', 'k2')
  n = reduceTask(n, { type: 'reply', taskId: 'k2', text: '好。' }).state
  n = reduceTask(n, { type: 'end', taskId: 'k2', status: 'done' }).state
  const nres = reduceTask(n, { type: 'drop', files: [] })
  assert.equal(nres.state, n)
  assert.equal(nres.settle, false)
  assert.equal(nres.pet, null)
  let bad = working('写', 'k3')
  bad = reduceTask(bad, { type: 'error', taskId: 'k3', reason: 'network' }).state
  const bres = reduceTask(bad, { type: 'drop', files: [] })
  assert.equal(bres.state, bad)
  assert.equal(bres.settle, false)
  assert.equal(bres.pet, null)
})

test('18 非 working 里后台事件照收、宠不动；working 里 pet work', () => {
  let d = working('写', 'v1')
  d = reduceTask(d, { type: 'reply', taskId: 'v1', text: '好了。' }).state
  d = reduceTask(d, { type: 'end', taskId: 'v1', status: 'done' }).state
  assert.equal(d.phase, 'done')
  const flowBefore = d.flow.length
  const s1 = reduceTask(d, { type: 'step', taskId: 'v1', step: 'prepare' })
  assert.equal(s1.state.phase, 'done')
  assert.equal(s1.state.flow.length, flowBefore)
  assert.equal(s1.pet, null)
  const s2 = reduceTask(s1.state, { type: 'progress', taskId: 'v1', text: '正在写 本周.docx' })
  assert.equal(s2.state.flow.length, flowBefore)
  assert.equal(s2.state.flow.some((one) => one.kind === 'progress'), false)
  assert.equal(s2.pet, null)
  const s3 = reduceTask(s2.state, { type: 'reply', taskId: 'v1', text: '补一句。' })
  assert.equal(s3.state.flow.at(-1).kind, 'reply')
  assert.equal(s3.pet, null)
  const s4 = reduceTask(s3.state, { type: 'output', taskId: 'v1', name: '补.docx', to: 'C:/o/补.docx' })
  assert.equal(s4.state.cards.length, 1)
  assert.equal(s4.pet, null)
  walk(toTaskView(s4.state))
  const w = working('写', 'v2')
  assert.equal(reduceTask(w, { type: 'step', taskId: 'v2', step: 'prepare' }).pet, 'work')
  assert.equal(reduceTask(w, { type: 'progress', taskId: 'v2', text: '正在写 本周.docx' }).pet, 'work')
  assert.equal(reduceTask(w, { type: 'reply', taskId: 'v2', text: '好了。' }).pet, 'work')
  assert.equal(reduceTask(w, { type: 'output', taskId: 'v2', name: 'a.docx', to: 'C:/o/a.docx' }).pet, 'work')
})

test('19 空文本、缺名字的后台事件原样返回', () => {
  const w = working('写', 'v3')
  for (const event of [
    { type: 'progress', taskId: 'v3', text: '' },
    { type: 'progress', taskId: 'v3', text: '  \n ' },
    { type: 'progress', taskId: 'v3', text: 1 },
    { type: 'reply', taskId: 'v3', text: '' },
    { type: 'reply', taskId: 'v3', text: '  \n ' },
    { type: 'reply', taskId: 'v3', text: 1 },
    { type: 'output', taskId: 'v3', to: 'C:/o/a.docx' },
    { type: 'output', taskId: 'v3', name: '', to: 'C:/o/a.docx' },
    { type: 'output', taskId: 'v3', name: 123, to: 'C:/o/a.docx' },
  ]) {
    assert.equal(reduceTask(w, event).state, w)
  }
})

test('20 没出文件时只写没出文件，不写钱', () => {
  let s = working('聊', 'b1')
  s = reduceTask(s, { type: 'reply', taskId: 'b1', text: '好。' }).state
  s = reduceTask(s, { type: 'usage', taskId: 'b1', ...usage() }).state
  s = reduceTask(s, { type: 'end', taskId: 'b1', status: 'done' }).state
  assert.equal(toTaskView(s).bottom.none.text, '没出文件')
  let t = working('聊', 'b2')
  t = reduceTask(t, { type: 'reply', taskId: 'b2', text: '好。' }).state
  t = reduceTask(t, { type: 'end', taskId: 'b2', status: 'done' }).state
  assert.deepEqual(toTaskView(t).bottom.none, { text: TEXT.noOutput })
})

test('21 error 里 send 标旧卡；done、asking 里 retry', () => {
  let e = working('写', 'y1')
  e = reduceTask(e, { type: 'output', taskId: 'y1', name: '一.docx', to: 'C:/o/一.docx' }).state
  e = reduceTask(e, { type: 'error', taskId: 'y1', reason: 'network' }).state
  const sent = reduceTask(e, { type: 'send', text: '再来', runId: 'y2' })
  assert.equal(sent.start.resume, false)
  assert.equal(sent.start.round, 2)
  const cards = toTaskView(sent.state).bottom.cards
  assert.equal(cards.length, 1)
  assert.equal(cards[0].old, true)
  let d = working('写周报', 'y3')
  d = reduceTask(d, { type: 'output', taskId: 'y3', name: '周.docx', to: 'C:/o/周.docx' }).state
  d = reduceTask(d, { type: 'end', taskId: 'y3', status: 'done' }).state
  const dr = reduceTask(d, { type: 'retry', runId: 'y4' })
  assert.equal(dr.start.resume, false)
  assert.equal(dr.start.round, 2)
  assert.equal(dr.start.prompt, '写周报')
  assert.equal(dr.state.flow.filter((one) => one.kind === 'user').length, 2)
  assert.equal(dr.state.flow.at(-1).text, '写周报')
  let a = working('问', 'y5')
  a = reduceTask(a, { type: 'reply', taskId: 'y5', text: '哪一份？' }).state
  a = reduceTask(a, { type: 'end', taskId: 'y5', status: 'done' }).state
  assert.equal(a.phase, 'asking')
  const ar = reduceTask(a, { type: 'retry', runId: 'y6' })
  assert.equal(ar.start.resume, false)
  assert.equal(ar.start.round, 2)
  assert.equal(ar.state.flow.filter((one) => one.kind === 'user').length, 2)
})

test('23 收下记住产出目录并给打开按钮；最近分两组的视图形状', () => {
  let s = working('写周报', 'h1')
  const out = 'C:/桌伴/任务/2026-11-05-写周报/桌伴输出/周报.docx'
  s = reduceTask(s, { type: 'output', taskId: 'h1', name: '周报.docx', to: out }).state
  s = reduceTask(s, { type: 'end', taskId: 'h1', status: 'done' }).state
  const next = reduceTask(s, { type: 'new' }).state
  assert.equal(next.settledDir, 'C:/桌伴/任务/2026-11-05-写周报/桌伴输出')
  assert.deepEqual(next.flow[0].buttons, [{ action: 'open-settled', label: '打开' }])
  assert.equal(toTaskView(next).flow[0].buttons[0].action, 'open-settled')

  let empty = working('只聊天', 'h2')
  empty = reduceTask(empty, { type: 'end', taskId: 'h2', status: 'done' }).state
  const noCard = reduceTask(empty, { type: 'new' }).state
  assert.equal(noCard.settledDir, '')
  assert.deepEqual(noCard.flow[0].buttons, [])

  const task = { dir: 'C:/桌伴/任务/2026-11-05-写周报', out: 'C:/桌伴/任务/2026-11-05-写周报/桌伴输出', name: '11-05 写周报', mtime: 1 }
  const v = toTaskView(createTask(), { recentTasks: [task], allTasks: 'C:/桌伴/任务' })
  assert.deepEqual(v.top.recent.items, [])
  assert.deepEqual(v.top.recent.tasks, [{ dir: task.out, name: '11-05 写周报' }])
  assert.equal(v.top.recent.allTasks, 'C:/桌伴/任务')
  assert.equal(v.top.recent.enabled, true)
  const busy = toTaskView(working('忙', 'h3'), { recentTasks: [task] })
  assert.equal(busy.top.recent.enabled, false)
})

test('22 一轮出几张卡：卡上只有页数和出处；脚本不算产出', () => {
  const u = usage({ inputTokens: 100_000, outputTokens: 2_000, cacheReadTokens: 50_000, cacheWriteTokens: 10_000 })
  // 同一轮两张卡：卡上各写各的，一分钱不写
  let s = working('写', 'c1')
  s = reduceTask(s, { type: 'usage', taskId: 'c1', ...u }).state
  s = reduceTask(s, { type: 'output', taskId: 'c1', name: '周报.docx', to: 'C:/o/周报.docx', pages: 3 }).state
  s = reduceTask(s, { type: 'output', taskId: 'c1', name: '附表.xlsx', to: 'C:/o/附表.xlsx' }).state
  const one = toTaskView(s)
  assert.equal(one.bottom.cards.length, 2)
  assert.equal(one.bottom.cards[0].name, '附表.xlsx')
  assert.equal(one.bottom.cards[0].line, '')
  assert.equal(one.bottom.cards[1].line, '3 页')
  assert.equal(one.bottom.cards[1].line.includes('这次约'), false)
  walk(one)
  // 两轮各一张卡：各写各的
  const u2 = usage({ searches: 1 })
  let d = working('写', 'c2')
  d = reduceTask(d, { type: 'usage', taskId: 'c2', ...u }).state
  d = reduceTask(d, { type: 'output', taskId: 'c2', name: '一.docx', to: 'C:/o/一.docx' }).state
  d = reduceTask(d, { type: 'end', taskId: 'c2', status: 'done' }).state
  d = reduceTask(d, { type: 'send', text: '再写', runId: 'c3' }).state
  d = reduceTask(d, { type: 'usage', taskId: 'c3', ...u2 }).state
  d = reduceTask(d, { type: 'output', taskId: 'c3', name: '二.docx', to: 'C:/o/二.docx', pages: 5 }).state
  const two = toTaskView(d)
  assert.equal(two.bottom.cards.length, 2)
  assert.equal(two.bottom.cards[0].line, '5 页')
  assert.equal(two.bottom.cards[1].line, '')
  // 过程那行没了：进度只管把小岛留在干活中，对话流里不添东西
  const script = reduceTask(working('写', 'c4'), { type: 'progress', taskId: 'c4', text: '正在写 build_report.py' })
  assert.equal(script.pet, 'work')
  assert.equal(script.state.flow.some((one) => one.kind === 'progress'), false)
  assert.equal(toTaskView(script.state).blocks.some((one) => one.kind === 'progress'), false)
  const doc = reduceTask(working('写', 'c5'), { type: 'progress', taskId: 'c5', text: '正在写 周报.docx' })
  assert.equal(doc.pet, 'work')
  assert.equal(doc.state.flow.some((one) => one.kind === 'progress'), false)
  assert.equal(toTaskView(doc.state).blocks.some((one) => one.kind === 'progress'), false)
  // 只出了脚本、没出文档：照旧走「没出文件」那一套
  let n = working('写', 'c6')
  n = reduceTask(n, { type: 'usage', taskId: 'c6', ...u }).state
  n = reduceTask(n, { type: 'end', taskId: 'c6', status: 'done' }).state
  const nv = toTaskView(n)
  assert.deepEqual(nv.bottom.cards, [])
  assert.equal(nv.bottom.none.text, '没出文件')
})

test('24 过程那行没了：拷贝、准备、核出处都不上屏', () => {
  const copyText = /份文件拷一份/
  // 没范本没材料：copy 这一步什么都不加
  let s = working('说句话', 'n1')
  const before = s.flow.length
  s = reduceTask(s, { type: 'step', taskId: 'n1', step: 'copy' }).state
  assert.equal(s.flow.length, before)
  assert.equal(s.flow.some((one) => copyText.test(one.text)), false)
  // 显式给 0 也算 0：一样不加
  let z = working('说句话', 'n2')
  const before2 = z.flow.length
  z = reduceTask(z, { type: 'step', taskId: 'n2', step: 'copy', count: 0 }).state
  assert.equal(z.flow.length, before2)
  assert.equal(z.flow.some((one) => copyText.test(one.text)), false)
  // 1 份范本 + 2 份材料：也不加
  let f = reduceTask(createTask(), { type: 'drop', files: ['C:/材料/范本.docx'], cell: 'template' }).state
  f = reduceTask(f, { type: 'drop', files: ['C:/材料/一.pdf', 'C:/材料/二.pdf'] }).state
  f = reduceTask(f, { type: 'send', text: '汇成周报', runId: 'n3' }).state
  const before3 = f.flow.length
  f = reduceTask(f, { type: 'step', taskId: 'n3', step: 'copy' }).state
  assert.equal(f.flow.length, before3)
  assert.equal(f.flow.some((one) => copyText.test(one.text)), false)
  // 显式给数时也不加
  let g = working('说句话', 'n4')
  const before4 = g.flow.length
  g = reduceTask(g, { type: 'step', taskId: 'n4', step: 'copy', count: 2 }).state
  assert.equal(g.flow.length, before4)
  assert.equal(g.flow.some((one) => copyText.test(one.text)), false)
  // 页面上一个过程块也没有
  assert.equal(toTaskView(g).blocks.some((one) => one.kind === 'progress'), false)
})

test('25 小岛的五种：做完了是笑眼（done），没干成是平线（fail），要你看一眼是 look', () => {
  // 不在前台：做完了 → done（小岛笑眼），不是 look、不是 fail
  let s = working('写', 'p1')
  s = reduceTask(s, { type: 'output', taskId: 'p1', name: '周报.docx', to: 'C:/o/周报.docx' }).state
  s = reduceTask(s, { type: 'reply', taskId: 'p1', text: '写好了。' }).state
  const done = reduceTask(s, { type: 'end', taskId: 'p1', status: 'done' })
  assert.equal(done.pet, 'done')
  assert.equal(done.petText, TEXT.done)
  assert.equal(done.notify, TEXT.done)
  // 没干成 → fail（小岛平线）
  const fail = reduceTask(working('写', 'p2'), { type: 'error', taskId: 'p2', reason: 'quota' })
  assert.equal(fail.pet, 'fail')
  assert.equal(fail.petText, TEXT.fail.quota)
  // 它问你一句 → look（小岛睁大 + 红点）
  let q = working('写', 'p3')
  q = reduceTask(q, { type: 'reply', taskId: 'p3', text: '要不要再短一点？' }).state
  const ask = reduceTask(q, { type: 'end', taskId: 'p3', status: 'done' })
  assert.equal(ask.pet, 'look')
  assert.equal(ask.petText, '要不要再短一点？')
  assert.equal(ask.notify, TEXT.askTail)
  // 任务窗开着、在前台：小岛就待命，用户已经看着了
  const fore = reduceTask(reduceTask(createTask(), { type: 'window', foreground: true }).state, { type: 'send', text: '写', runId: 'p4' })
  const foreDone = reduceTask(fore.state, { type: 'end', taskId: 'p4', status: 'done' })
  assert.equal(foreDone.pet, 'idle')
  // 干活中：过程那一行没了，小岛只看「正在工作 · x 秒」
  // 进度只把小岛留在干活中，对话流里不添东西
  const progress = reduceTask(working('写', 'p5'), { type: 'progress', taskId: 'p5', text: '正在看 周报.docx' })
  assert.equal(progress.pet, 'work')
  assert.equal(progress.petText, '')
  assert.equal(toTaskView(progress.state).blocks.some((one) => one.kind === 'progress'), false)
  const withFile = reduceTask(
    reduceTask(createTask(), { type: 'drop', files: ['C:/材料/一.pdf'], cell: 'materials' }).state,
    { type: 'send', text: '写', runId: 'p6' },
  )
  const read = reduceTask(withFile.state, { type: 'progress', taskId: 'p6', text: '正在看 一.pdf' })
  assert.equal(read.pet, 'work')
  assert.equal(read.petText, '')
  assert.equal(read.state.flow.some((one) => one.kind === 'progress'), false)
})

test('26 过程那一行没了；模型说的每一段一个气泡', () => {
  let s = reduceTask(createTask(), { type: 'drop', files: ['C:/材料/范本.docx'], cell: 'template' }).state
  s = reduceTask(s, { type: 'send', text: '汇成本周周报', runId: 'm1' }).state
  // 过程、进度都不上屏：一个过程块也没有
  s = reduceTask(s, { type: 'step', taskId: 'm1', step: 'prepare' }).state
  s = reduceTask(s, { type: 'progress', taskId: 'm1', text: '正在看 一.pdf' }).state
  s = reduceTask(s, { type: 'progress', taskId: 'm1', text: '正在写 周报.docx' }).state
  s = reduceTask(s, { type: 'step', taskId: 'm1', step: 'cite' }).state
  assert.equal(toTaskView(s).blocks.some((one) => one.kind === 'progress'), false)
  assert.equal(s.flow.some((one) => one.kind === 'progress'), false)

  // 干活中：最下面一行浅字「正在工作 · x 秒」
  let blocks = toTaskView(s).blocks
  assert.deepEqual(blocks.map((one) => one.kind), ['user', 'working'])
  assert.equal(blocks.at(-1).text, TEXT.working)
  assert.equal(blocks.at(-1).since, s.startedAt)

  // 一轮里模型说了两段（中间夹着工具调用）：两个气泡，按顺序排
  s = reduceTask(s, { type: 'reply', taskId: 'm1', text: '没有什么工具，我先把材料看一遍。' }).state
  s = reduceTask(s, { type: 'reply', taskId: 'm1', text: '看完了，开始写周报。' }).state
  blocks = toTaskView(s).blocks
  const replies = blocks.filter((one) => one.kind === 'reply')
  assert.equal(replies.length, 2)
  assert.equal(replies[0].text, '没有什么工具，我先把材料看一遍。')
  assert.equal(replies[1].text, '看完了，开始写周报。')
  assert.deepEqual(blocks.map((one) => one.kind), ['user', 'reply', 'reply', 'working'])

  // 同一段被流式补全（那段话变长了）：还是同一个气泡，不重复
  s = reduceTask(s, { type: 'reply', taskId: 'm1', text: '看完了，开始写周报。这周有三条风险。' }).state
  blocks = toTaskView(s).blocks
  assert.equal(blocks.filter((one) => one.kind === 'reply').length, 2)
  assert.equal(blocks.filter((one) => one.kind === 'reply').at(-1).text, '看完了，开始写周报。这周有三条风险。')

  // 做完：过程行和「正在工作」都没了，回答和产出卡还在
  s = reduceTask(s, { type: 'output', taskId: 'm1', name: '本周周报.docx', to: 'C:/o/本周周报.docx', pages: 3 }).state
  s = reduceTask(s, { type: 'reply', taskId: 'm1', text: '周报写好了。' }).state
  s = reduceTask(s, { type: 'end', taskId: 'm1', status: 'done' }).state
  blocks = toTaskView(s).blocks
  assert.equal(blocks.some((one) => one.kind === 'working'), false)
  assert.equal(blocks.some((one) => one.kind === 'progress'), false)
  assert.deepEqual(blocks.map((one) => one.kind), ['user', 'reply', 'reply', 'reply', 'card'])
  walk(toTaskView(s))

  // 下一轮重新计时：秒数从这一轮开始算
  const again = reduceTask(s, { type: 'send', text: '再补一段', runId: 'm2' })
  const two = toTaskView(again.state).blocks
  assert.equal(two.at(-1).kind, 'working')
  assert.equal(two.at(-1).since, again.state.startedAt)
})

test('27 等你一句话：红字挂在这一轮最后一段上', () => {
  let s = working('写', 'a1')
  s = reduceTask(s, { type: 'reply', taskId: 'a1', text: '我先看看材料。' }).state
  s = reduceTask(s, { type: 'reply', taskId: 'a1', text: '用哪一份？' }).state
  const asked = reduceTask(s, { type: 'end', taskId: 'a1', status: 'done' })
  assert.equal(asked.state.phase, 'asking')
  const replies = toTaskView(asked.state).blocks.filter((one) => one.kind === 'reply')
  assert.equal(replies.length, 2)
  assert.equal(replies[0].ask, false)
  assert.equal(replies[1].ask, true)
  assert.equal(toTaskView(asked.state).flow.at(-1).tail, TEXT.askTail)
})

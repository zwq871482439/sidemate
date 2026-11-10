// 任务窗主进程这头的状态和流水线：一份任务状态、一轮的七个步骤、宠和收下。
// 外部能力（dsh、工作区、出处、key）全从 deps 传进来，不 import electron，node --test 直接测。
// deps：runTask / prepareTask / protectRuntime / prepareFeed / reviewDocx / finishTask / clearWorkspace /
// snapshotWorkspace / root / key / extensions / node{source,low} / recent / onRecent / onPet /
// onView / openSettings / pickFiles / openPath / log。

import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { addRecent, createTask, reduceTask, toTaskView } from './state.mjs'
import { recentTasks } from './recent-tasks.mjs'
import { noteUsage } from '../usage/index.mjs'

const beat = () => new Promise((done) => setImmediate(done))
const LOCKED = /^(EBUSY|EPERM|EACCES)$/
const REVIEW_EXT = new Set(['.docx', '.xlsx', '.md'])
// 后处理都在副本上做：产出先拷一份到工作区的这个目录，改完了再换进「桌伴输出」
const STAGE_DIR = '.后处理'
// 正文里的出处标记：〔S01·p1〕这种。交出去的稿子里不许留着
const MARK = /〔S\d+·[^〕]+〕/g
// snapshotWorkspace 给的是平台分隔符（Windows 是 tagged\…），两种都认
const TAGGED = /^tagged[\\/]/

const extOf = (path) => {
  const name = basename(String(path))
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i).toLowerCase() : ''
}

// 没给范本、材料里只有一份 .docx 时，这份原稿就当范本：后处理照「有范本」走，不整份换成 Noto Sans SC
function templateOf(start) {
  if (start.template) return start.template
  const list = Array.isArray(start.materials) ? start.materials : []
  if (list.length !== 1) return null
  return extOf(list[0]) === '.docx' ? list[0] : null
}

// 材料恰好一份文档、没给别的范本：这就是让改用户自己那一份稿。
// 只按「恰好一份」判断，不猜用户要干什么：不切块、不打标，交稿后不核出处、不挂批注；
// 字体照 A4 走：这份 .docx 原稿当范本。
function singleDoc(start) {
  if (start.template) return false
  const list = Array.isArray(start.materials) ? start.materials : []
  return list.length === 1 && Boolean(list[0])
}

// 拖进来的路径是文件还是文件夹；链接和不存在的一律不算
const kindOf = (path) => {
  try {
    const st = lstatSync(path)
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : ''
  } catch {
    return ''
  }
}

// 流式读，别为一个 node.exe 卡住主进程
function sha256(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', fail)
    stream.on('end', () => done(hash.digest('hex')))
  })
}

export function createRunner(deps = {}) {
  const log = deps.log || (() => {})
  let state = createTask()
  let recent = Array.isArray(deps.recent) ? deps.recent.slice() : []
  let task = null // 这个任务记着的工作区、范本材料副本、chunks、sessionId
  let current = null // 正在准备或在跑的这一轮
  let lastRun = null
  let chain = Promise.resolve() // 一轮和收下排成一条队：上一轮的 python 没退完，下一轮不碰工作区
  let seq = 0
  const newRunId = () => `run-${Date.now().toString(36)}-${(seq += 1)}`

  const view = () => {
    const root = deps.root?.() || ''
    const tasks = root ? recentTasks(root) : []
    const allTasks = root && existsSync(join(root, '任务')) ? join(root, '任务') : ''
    return toTaskView(state, { root, recent, recentTasks: tasks, allTasks })
  }

  function feed(event) {
    const step = reduceTask(state, event)
    const changed = step.state !== state
    state = step.state
    if (changed) deps.onView?.(view())
    if (event.type === 'step') log('step', { step: event.step, taskId: event.taskId })
    if (step.pet) toPet(step.pet, step.notify, step.petText)
    if (step.start) void begin(step.start)
    if (step.cancel) stop()
    if (step.settle) settle()
    return step
  }

  // 宠的五种：
  // work 干活中 · done 做完了（笑眼）· look 要你看一眼（睁大 + 红点）· fail 没干成（平线）· idle 待命
  function toPet(kind, notify, petText) {
    const taskId = state.runId || lastRun
    if (kind === 'work') deps.onPet?.({ type: 'progress', taskId, text: petText || '' })
    else if (kind === 'done') deps.onPet?.({ type: 'end', status: 'done', taskId })
    else if (kind === 'idle') deps.onPet?.({ type: 'end', status: 'cancelled', taskId })
    else if (kind === 'look') deps.onPet?.({ type: 'ask', taskId, message: petText || notify || '', notice: notify || '' })
    else if (kind === 'fail') deps.onPet?.({ type: 'error', taskId, message: petText || notify || '' })
  }

  function stop() {
    if (!current) return
    if (current.handle) { current.handle.cancel(); return } // dsh 自己发 end cancelled
    // 还在准备、在核出处、或在等上一轮退完：立刻停，后面每一步都会看到 stopped 悄悄收手
    current.stopped = true
    feed({ type: 'end', status: 'cancelled', taskId: current.runId })
  }

  // 收下也排队：等还在收尾的那一轮退完再清场
  function settle() {
    log('settle', { dir: task?.workspace || '' })
    const hold = task
    const prev = chain
    chain = (async () => {
      await prev
      if (hold?.workspace) {
        try { deps.clearWorkspace(hold.workspace) } catch (error) { log('clear-failed', { error: error?.message || '' }) }
      }
      if (task === hold) task = null
    })()
  }

  function fail(round, reason, message, name) {
    log('failed', { reason, message: message || '', name: name || '', taskId: round.runId })
    feed({ type: 'error', reason, message, name, taskId: round.runId })
    feed({ type: 'end', status: 'error', taskId: round.runId })
  }

  // Low 的 node：真拷一份（不能硬链接，Low 标签打在文件上），起之前核哈希，不一样就重拷
  async function privateNode() {
    const { source, low } = deps.node
    let stale = true
    try { stale = (await sha256(low)) !== (await sha256(source)) } catch { stale = true }
    if (stale) {
      mkdirSync(dirname(low), { recursive: true })
      copyFileSync(source, low)
    }
    return low
  }

  // 文件夹任务里用户从格上删掉的那几份，拷进来后从工作区删掉
  function removeDeleted(prepared, kept) {
    const hold = new Set(kept.map((path) => resolve(path)))
    for (const one of prepared.copied) {
      if (hold.has(resolve(one.from))) continue
      try { if (existsSync(one.to)) unlinkSync(one.to) } catch { /* 删不掉就留着 */ }
    }
  }

  // 交出去：把成品拷进「桌伴输出」。目标被占着就换带序号的新名，卡上指实际交的那份
  async function hand(round, from, name) {
    const done = deps.deliverOutput({
      outputDir: task.prepared.outputDir,
      from,
      name,
      used: [...round.delivered],
    })
    round.delivered.add(done.name)
    return done
  }

  // 后处理都在副本上做：先拷一份到工作区的 .后处理/，改完了再换进「桌伴输出」
  function stage(output) {
    try {
      const dir = join(task.workspace, STAGE_DIR)
      mkdirSync(dir, { recursive: true })
      const to = join(dir, output.name)
      copyFileSync(output.from, to)
      return to
    } catch (error) {
      // 副本拷不动就照原件做：宁可改原件，也不能不交稿
      log('stage-failed', { name: output.name, error: error?.message || '' })
      return output.from
    }
  }

  // 核对没成时：把标记从副本上剥干净再交，不让带〔S…·p…〕的稿子出去
  async function cleanMarks(path) {
    const ext = extOf(path)
    try {
      if (ext === '.docx' || ext === '.xlsx') {
        if (!deps.stripMarks) return path
        const done = await deps.stripMarks({ docx: path })
        return done?.docx || path
      }
      if (ext === '.md' || ext === '.txt' || ext === '.csv') {
        const text = readFileSync(path, 'utf8')
        const cleaned = text.replace(MARK, '')
        if (cleaned !== text) writeFileSync(path, cleaned, 'utf8')
      }
    } catch (error) {
      log('strip-failed', { name: basename(path), error: error?.message || '' })
    }
    return path
  }

  async function review(round, output) {
    const ext = extOf(output.from)
    const tidy = !task.chunks
    if (tidy ? ext !== '.docx' || !deps.tidyDocx : !REVIEW_EXT.has(ext)) {
      // 不核的也照样不能带着标记出去（txt、csv 这些）：拷一份再剥，原件不动
      const from = (!tidy && (ext === '.txt' || ext === '.csv')) ? await cleanMarks(stage(output)) : output.from
      const done = await hand(round, from, output.name)
      return { ...done, cite: null }
    }
    feed({ type: 'step', step: 'cite', taskId: round.runId })
    const staged = stage(output)
    let cite = null
    let target = staged
    try {
      if (tidy) {
        // 没材料也过一遍字体整理，免得整份掉回日文字体
        const tidied = await deps.tidyDocx({ docx: staged, utterance: round.utterance, hasTemplate: round.hasTemplate })
        target = tidied?.docx || staged
      } else {
        const checked = await deps.reviewDocx({ docx: staged, chunks: task.chunks, utterance: round.utterance, hasTemplate: round.hasTemplate })
        target = checked?.docx || staged
        cite = { verified: checked?.verified ?? 0, missed: checked?.missed ?? 0 }
      }
    } catch (error) {
      log('cite-failed', { name: output.name, error: error?.message || '' })
      target = await cleanMarks(staged)
      cite = tidy ? null : { verified: 0, missed: 0, note: '出处没核上' }
    }
    const done = await hand(round, target, basename(target))
    return { ...done, cite }
  }

  // 收尾：拷产出（改过的旧文件也算新的）→ 核出处 → 出卡 → 存着的出错 → 结束。
  // 每个让出点之后、每次喂之前都看一眼 stopped：停了就悄悄收手，已拷进「桌伴输出」的留着，不再出卡。
  async function collect(round, status) {
    if (round.stopped) return
    const taskId = round.runId
    const again = round.artifacts
      .map((one) => relative(task.workspace, resolve(one.path)))
      .filter((rel) => rel && rel !== '' && !rel.startsWith('..'))
    const snapshot = round.baseline.filter((rel) => TAGGED.test(rel) || !again.includes(rel))
    // defer：产出先留在工作区里，核出处和整理字体都在副本上做，做完再交进「桌伴输出」
    const result = deps.finishTask(task.prepared, { snapshot, artifacts: round.artifacts, defer: true })
    if (!result.ok) return fail(round, 'changed', '', result.changed.map((one) => basename(one.path)).join('、'))
    for (const output of result.outputs) {
      if (round.stopped) return
      const card = await review(round, output)
      if (round.stopped) return
      if (card.name !== output.name) {
        feed({
          type: 'reply',
          taskId,
          text: card.locked
            ? `交的是《${card.name}》：原来那份正被别的程序开着，桌伴另存了一份。`
            : `交的是《${card.name}》。`,
        })
      }
      feed({ type: 'output', taskId, name: card.name, to: card.to, pages: output.pages ?? null, cite: card.cite })
    }
    if (round.stopped) return
    if (round.failure) feed({ type: 'error', reason: round.failure.reason, message: round.failure.message, taskId })
    feed({ type: 'end', status, taskId })
  }

  async function begin(start) {
    const round = { runId: start.runId, stopped: false, handle: null, artifacts: [], failure: null, baseline: [], utterance: start.prompt || '', hasTemplate: Boolean(templateOf(start)), delivered: new Set() }
    current = round
    lastRun = start.runId
    log('start', { taskId: start.runId, round: start.round, resume: start.resume === true, place: start.place.kind })
    // 排在前面那轮后面：它没退完（python 还在写 tagged/）就不碰工作区；
    // 等的时候被停了，醒来悄悄收手，一次 prepareFeed / runTask 都不起
    const prev = chain
    const tail = (async () => {
      try {
        await prev
        if (round.stopped) return
        await work(start, round)
      } catch (error) {
        if (round.stopped) return
        if (LOCKED.test(String(error?.code || ''))) {
          return fail(round, 'locked', '', basename(String(error.path || error.dest || '')))
        }
        fail(round, 'other', error?.message || '')
      } finally {
        if (current === round) current = null
      }
    })()
    chain = tail.catch(() => {})
  }

  async function work(start, round) {
    const apiKey = deps.key?.()
    if (!apiKey) return fail(round, 'key', '') // 没 key 先说没 key：不拷文件、不拷 node、不 protect
    if (!task?.workspace) {
      feed({ type: 'step', step: 'copy', taskId: round.runId })
      await beat()
      if (round.stopped) return
      const paths = start.place.kind === 'folder' ? [start.place.dir]
        : start.place.kind === 'files' ? [start.template, ...start.materials].filter(Boolean)
        : []
      const prepared = await deps.prepareTask({ paths, prompt: start.prompt })
      if (round.stopped) return
      if (start.place.kind === 'folder') removeDeleted(prepared, [start.template, ...start.materials].filter(Boolean))
      task = { workspace: prepared.workspace, prepared, chunks: null, sessionId: undefined }
      log('workspace', { dir: prepared.workspace })
    }
    if (start.place.kind === 'files') feed({ type: 'workspace', dir: task.workspace, taskId: round.runId })
    if (round.stopped) return

    feed({ type: 'step', step: 'prepare', taskId: round.runId })
    await beat()
    if (round.stopped) return
    const node = await privateNode()
    if (round.stopped) return
    const guarded = deps.protectRuntime({ nodePath: node, workspace: task.workspace })
    if (!guarded.ok) return fail(round, 'other', guarded.message)
    if (round.stopped) return

    let prompt = start.prompt
    if (!start.resume && (start.template || start.materials.length)) {
      const copyOf = (path) => !path ? '' : (task.prepared.copied.find((one) => resolve(one.from) === resolve(path))?.to || '')
      const one = singleDoc(start)
      const given = await deps.prepareFeed({
        workspace: task.workspace,
        utterance: start.prompt,
        template: copyOf(templateOf(start)),
        materials: start.materials.map(copyOf).filter(Boolean),
        single: one,
      })
      if (round.stopped) return
      // 单份材料：没有出处标记可核，chunks 留空，后处理走「不核出处」那条路
      task.chunks = one ? null : given.chunks
      prompt = given.prompt
    }

    round.baseline = deps.snapshotWorkspace(task.workspace)
    round.handle = deps.runTask({
      taskId: round.runId,
      apiKey,
      workspace: task.workspace,
      prompt,
      sessionId: start.resume ? task.sessionId : undefined,
      node: deps.node.low,
      onEvent: (event) => {
        if (event.type === 'progress') feed({ type: 'progress', text: event.text, taskId: round.runId })
        else if (event.type === 'reply') feed({ type: 'reply', text: event.text, taskId: round.runId })
        else if (event.type === 'usage') {
          noteUsage(round.utterance, event) // 这一轮的用量记进设置里看的那份
          feed({ ...event, taskId: round.runId })
        }
        else if (event.type === 'artifact') round.artifacts.push(event)
        else if (event.type === 'error') round.failure = event
      },
    })
    const end = await round.handle.done
    task.sessionId = round.handle.sessionId ?? task.sessionId
    round.handle = null // dsh 已结束：这以后点停下走「立刻 cancelled」，不再空喊 cancel
    if (round.stopped || end.status === 'cancelled') {
      feed({ type: 'end', status: 'cancelled', taskId: round.runId })
      return
    }
    await collect(round, end.status)
  }

  function folderFiles(dir) {
    const ok = new Set(Array.isArray(deps.extensions) ? deps.extensions : [])
    try {
      return readdirSync(dir)
        .filter((name) => !name.startsWith('.') && !name.startsWith('~') && ok.has(extOf(name)))
        .sort((a, b) => a.localeCompare(b, 'zh'))
        .map((name) => join(dir, name))
        .filter((path) => kindOf(path) === 'file')
    } catch {
      return []
    }
  }

  // 拖放的总口：正好一个文件夹就装文件夹，否则只留普通文件
  function drop(paths, cell) {
    const list = (Array.isArray(paths) ? paths : []).filter((path) => typeof path === 'string' && path)
    if (list.length === 1 && kindOf(list[0]) === 'dir') {
      const folder = list[0]
      feed({ type: 'drop', folder, files: folderFiles(folder), cell })
      if (state.place.kind === 'folder' && state.place.dir === folder) {
        recent = addRecent(recent, folder)
        deps.onRecent?.(recent)
      }
      return
    }
    const files = list.filter((path) => kindOf(path) === 'file')
    if (files.length) feed({ type: 'drop', files, cell })
  }

  // 窗上那排按钮和宠那头的入口
  function act(action) {
    if (!action || typeof action.type !== 'string') return
    const type = action.type
    if (type === 'send' && typeof action.text === 'string') feed({ type: 'send', text: action.text, runId: newRunId() })
    else if (type === 'retry') feed({ type: 'retry', runId: newRunId() })
    else if (type === 'stop' || type === 'accept') feed({ type })
    else if (type === 'remove') feed({ type: 'remove', path: action.path })
    else if (type === 'move') feed({ type: 'move', path: action.path, to: action.to })
    else if (type === 'settings') deps.openSettings?.()
    else if (type === 'add') Promise.resolve(deps.pickFiles?.(action.cell)).catch((error) => log('pick-failed', { error: error?.message || '' }))
    else if (type === 'recent' && recent.includes(action.dir)) drop([action.dir])
    else if (type === 'open-settled') {
      const path = knownPath(state.settledDir)
      if (path) deps.openPath?.(path, false)
    } else if (type === 'open-recent' || type === 'all-tasks') {
      const now = view()
      const listed = type === 'all-tasks' ? now.top.recent.allTasks : ''
      const path = listed && listed === action.dir ? listed : knownPath(action.dir)
      const isTask = now.top.recent.tasks.some((one) => one.dir === path)
      if (path && (type === 'all-tasks' ? path === listed : isTask)) deps.openPath?.(path, false)
    } else if (type === 'open-folder' || type === 'open' || type === 'reveal') {
      const path = knownPath(action.path)
      if (path) deps.openPath?.(path, type === 'reveal')
    }
  }

  // 打开 / 显示只认当前视图里出现过的路径
  function knownPath(path) {
    if (typeof path !== 'string' || !path) return ''
    const now = view()
    if (now.top.path.open === path || now.top.recent.allTasks === path || state.settledDir === path) return path
    if (now.top.recent.tasks.some((one) => one.dir === path)) return path
    return now.bottom.cards.some((card) => card.path === path) ? path : ''
  }

  // 宠那头点开了任务窗：fresh 开新任务，recent 装那个文件夹，paths 当拖放
  function opened(detail) {
    if (!detail || typeof detail !== 'object') return
    if (detail.fresh === true) feed({ type: 'new' })
    else if (typeof detail.recent === 'string' && recent.includes(detail.recent)) drop([detail.recent])
    else if (Array.isArray(detail.paths)) drop(detail.paths, detail.cell === 'template' ? 'template' : 'materials')
  }

  function quit() {
    if (!current) return
    current.stopped = true
    current.handle?.cancel()
  }

  return { view, feed, act, drop, opened, quit, recent: () => recent.slice() }
}

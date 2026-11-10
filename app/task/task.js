// 任务窗页面：拿到视图就照着画，用户的动作原样发回主进程；自己不算状态、不存东西。
// 顶上顶着文件夹，下面一条对话流：我说的话 · 模型说的每一段 · 产出卡。

import { httpUrl, markdownBlocks } from './markdown.mjs'
import { elapsedText } from './timing.mjs'
import { scrollDecision } from './scroll.mjs'
import { animStep } from './anim.mjs'

const $ = (sel) => document.querySelector(sel)
const els = {
  top: $('#top'), box: $('#box'),
  path: $('#path'), recent: $('#recent'), menu: $('#menu'), newtask: $('#newtask'),
  flow: $('#flow'), latest: $('#latest'), tagrow: $('#tagrow'), tags: $('#tags'),
  addfile: $('#addfile'), input: $('#input'), send: $('#send'),
  drop: $('#dropmask'), tagmenu: $('#tagmenu'), docicon: $('#docicon'),
}
const bridge = window.task || null
const panel = document.getElementById('panel')
const stillMedia = matchMedia('(prefers-reduced-motion: reduce)')
let view = null
let lastJson = ''
let stick = true
let pendingNew = false // 用户往上翻着看的时候来了新内容
let forceBottom = false // 刚发完消息，一定滚到底
let lastBlocks = ''
let lastHeight = 0
let dropCell = 'materials'

const act = (action) => { if (bridge) bridge.act(action) }
const atBottom = () => els.flow.scrollHeight - els.flow.scrollTop - els.flow.clientHeight < 4

// 垂下来和收回（设计稿第三节②）：页面第一帧是收起状态，壳说一声才垂下来。
// 帘子往下拉开：露出的高度从 1 到整窗，同时从上方 16px 落到位，前 120ms 淡入。
// 收回：帘子往上收，窗往上走 12px，最后 120ms 淡出。
// 中途改了方向：倒着走，从当前位置接着走，不重放也不叠两段。
let anim = null // 现在这段动画
let animDir = '' // 这段动画的方向：'in' 往下拉开、'out' 往上收

// 停掉现在这段（不改落定的样子）
function stopAnim() {
  if (!anim) return
  const done = anim
  anim = null
  animDir = ''
  try { done.cancel() } catch { /* 停不了就算了 */ }
}

// 动画放完了：把落定的样子摆好（收起 = closed，展开 = 什么也不加）
function settle(dir) {
  stopAnim()
  panel.classList.remove('enter', 'leave')
  panel.classList.toggle('closed', dir === 'out')
}

function playAnim(kind) {
  const dir = kind === 'in' ? 'in' : 'out'
  if (stillMedia.matches) {
    // 关了「显示动画」：直接出现 / 直接消失，不动
    settle(dir)
    return
  }
  const step = animStep(anim ? { state: anim.playState, dir: animDir } : null, dir)
  // 已经在走这个方向：不重放
  if (step === 'keep') return
  // 反方向：倒着走，从当前位置接着走
  if (step === 'reverse') {
    anim.reverse()
    animDir = dir
    return
  }
  // 新的一段：先摆好起点，再放
  stopAnim()
  panel.classList.remove('enter', 'leave', 'closed')
  void panel.offsetHeight
  panel.classList.add(dir === 'in' ? 'enter' : 'leave')
  const name = dir === 'in' ? 'win-drop' : 'win-up'
  const running = panel.getAnimations
    ? panel.getAnimations().find((one) => one.animationName === name && one.playState === 'running')
    : null
  if (!running) { settle(dir); return }
  anim = running
  animDir = dir
  running.addEventListener('finish', () => { if (anim === running) settle(animDir) })
}

panel.addEventListener('animationend', (event) => {
  if (event.target !== panel) return
  if (event.animationName !== 'win-drop' && event.animationName !== 'win-up') return
  if (!animDir) return
  settle(animDir)
})

// 对话流有多高：量内容，不量被挤剩下的那点。
// 量的时候临时把高度放开，滚动位置会被压回 0；量完放回去，别让对话流跳顶。
function flowHeight() {
  const prev = els.flow.style.height
  const top = els.flow.scrollTop
  els.flow.style.height = 'auto'
  const height = els.flow.offsetHeight
  els.flow.style.height = prev
  els.flow.scrollTop = top
  return height
}

// 链接：点了交主进程用系统浏览器开，页面不自己跳；裸网址太长中间省一点，地址仍是原网址
function linkEl(one) {
  const a = document.createElement('a')
  a.href = one.link
  a.title = one.link
  const show = one.text === one.link && one.text.length > 42
    ? `${one.text.slice(0, 24)}…${one.text.slice(-12)}` : one.text
  if (one.bold) {
    const strong = document.createElement('strong')
    strong.textContent = show
    a.append(strong)
  } else {
    a.textContent = show
  }
  a.addEventListener('click', (event) => {
    event.preventDefault()
    if (bridge) bridge.openLink(one.link)
  })
  return a
}

// 行内的粗体、代码、链接：只建节点，文字一律走 textContent
function segs(node, list) {
  for (const one of list) {
    if (one.code) {
      const code = document.createElement('code')
      code.textContent = one.text
      node.append(code)
    } else if (one.link && httpUrl(one.link)) {
      node.append(linkEl(one))
    } else if (one.bold) {
      const strong = document.createElement('strong')
      strong.textContent = one.text
      node.append(strong)
    } else {
      node.append(document.createTextNode(one.text))
    }
  }
}

// 回话里的 Markdown：标题、列表、表格、分隔线照排，链接可点，不露星号
function markdownEl(text) {
  const wrap = document.createElement('div')
  wrap.className = 'md'
  for (const block of markdownBlocks(text)) {
    if (block.type === 'h') {
      const h = document.createElement(`h${Math.min(6, block.level + 2)}`)
      segs(h, block.segs)
      wrap.append(h)
    } else if (block.type === 'p') {
      const p = document.createElement('p')
      segs(p, block.segs)
      wrap.append(p)
    } else if (block.type === 'ul' || block.type === 'ol') {
      const list = document.createElement(block.type)
      for (const item of block.items) {
        const li = document.createElement('li')
        segs(li, item)
        list.append(li)
      }
      wrap.append(list)
    } else if (block.type === 'table') {
      const table = document.createElement('table')
      const head = document.createElement('thead')
      const hrow = document.createElement('tr')
      for (const cell of block.head) {
        const th = document.createElement('th')
        segs(th, cell)
        hrow.append(th)
      }
      head.append(hrow)
      table.append(head)
      const body = document.createElement('tbody')
      for (const row of block.rows) {
        const tr = document.createElement('tr')
        for (const cell of row) {
          const td = document.createElement('td')
          segs(td, cell)
          tr.append(td)
        }
        body.append(tr)
      }
      table.append(body)
      wrap.append(table)
    } else if (block.type === 'quote') {
      const quote = document.createElement('blockquote')
      segs(quote, block.segs)
      wrap.append(quote)
    } else if (block.type === 'code') {
      const pre = document.createElement('pre')
      pre.textContent = block.text
      wrap.append(pre)
    } else if (block.type === 'hr') {
      wrap.append(document.createElement('hr'))
    }
  }
  return wrap
}

function buttonEl(label, action, kind) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = label
  if (kind) btn.dataset.act = kind
  btn.addEventListener('click', () => act(action))
  return btn
}

// 我说的：靠右，底下一行小字写带了哪些文件
function userEl(block) {
  const el = document.createElement('div')
  el.className = 'user'
  const tx = document.createElement('div')
  tx.className = 'tx'
  tx.textContent = block.text
  el.append(tx)
  if (block.files && block.files.length) {
    const files = document.createElement('div')
    files.className = 'files'
    files.textContent = `带了 ${block.files.join('、')}`
    el.append(files)
  }
  return el
}

// 干活中：对话流最下面一行浅字「正在工作 · 14 秒」，秒数自己走
function workingEl(block) {
  const el = document.createElement('div')
  el.className = 'working'
  const since = Number(block.since) || Date.now()
  el.append(document.createTextNode(`${block.text} · `))
  const secs = document.createElement('span')
  secs.className = 'secs'
  secs.dataset.since = String(block.since || 0)
  secs.textContent = elapsedText(Date.now() - since)
  el.append(secs)
  return el
}

// 产出卡：文档图标 · 文件名 · 一行说明 · 打开 / 在文件夹里显示
function cardEl(block) {
  const card = block.card
  const el = document.createElement('article')
  el.className = 'card'
  el.dataset.path = card.path || ''
  const head = document.createElement('div')
  head.className = 'head'
  const icon = els.docicon.cloneNode(true)
  icon.removeAttribute('hidden')
  const nm = document.createElement('span')
  nm.className = 'nm'
  nm.textContent = card.label
  nm.title = card.name
  head.append(icon, nm)
  const sub = document.createElement('div')
  sub.className = 'sub'
  sub.textContent = card.line
  const btns = document.createElement('div')
  btns.className = 'btns'
  btns.append(buttonEl(view.labels.open, { type: 'open', path: card.path }, 'open'))
  btns.append(buttonEl(view.labels.reveal, { type: 'reveal', path: card.path }, 'reveal'))
  el.append(head, sub, btns)
  return el
}

function blockEl(block) {
  if (block.kind === 'user') return userEl(block)
  if (block.kind === 'working') return workingEl(block)
  if (block.kind === 'card') return cardEl(block)
  if (block.kind === 'error') {
    const el = document.createElement('div')
    el.className = 'error'
    el.append(document.createTextNode(block.text))
    if (block.buttons && block.buttons.length) {
      const btns = document.createElement('div')
      btns.className = 'btns'
      for (const one of block.buttons) btns.append(buttonEl(one.label, { type: one.action }))
      el.append(btns)
    }
    return el
  }
  const el = document.createElement('div')
  el.className = block.kind === 'reply' ? 'reply' : 'note'
  if (block.kind === 'reply') {
    el.append(markdownEl(block.text))
    if (block.ask) {
      const tail = document.createElement('span')
      tail.className = 'tail'
      tail.textContent = view.labels.askTail
      el.append(tail)
    }
    return el
  }
  el.textContent = block.text
  if (block.buttons && block.buttons.length) {
    const btns = document.createElement('div')
    btns.className = 'btns'
    for (const one of block.buttons) btns.append(buttonEl(one.label, { type: one.action }))
    el.append(btns)
  }
  return el
}

// 重画对话流：滚到哪，看离底多远。
// 用户自己在往上翻着看（离底超过 80px）就别硬拽，右下角露一个「↓ 有新消息」。
function renderFlow() {
  const el = els.flow
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight
  const decision = scrollDecision({ distance, force: forceBottom })
  const back = el.scrollTop
  const sig = JSON.stringify(view.blocks)
  el.textContent = ''
  if (!view.blocks.length && view.flowHint) {
    const hint = document.createElement('div')
    hint.className = 'fh'
    hint.textContent = view.flowHint
    el.append(hint)
  }
  for (const block of view.blocks) el.append(blockEl(block))
  if (decision === 'bottom') {
    el.scrollTop = el.scrollHeight
    stick = true
    pendingNew = false
  } else {
    el.scrollTop = back
    stick = false
    if (sig !== lastBlocks) pendingNew = true
  }
  lastBlocks = sig
  forceBottom = false
  updateLatest()
}

// 右下角那个小按钮：没新东西就写「回到最新」，有新东西就写「↓ 有新消息」
function updateLatest() {
  if (!view) return
  els.latest.hidden = stick
  els.latest.textContent = pendingNew ? view.labels.newMsg : view.labels.latest
}

// 小签：文件变成输入区上沿的小签，范本带黑底小标，签多了收成 +n
function tagEl(tag) {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = `tag ${tag.role}`
  el.dataset.path = tag.path
  if (tag.role === 'template') {
    const mark = document.createElement('span')
    mark.className = 'mark'
    mark.textContent = view.labels.markTemplate
    el.append(mark)
  }
  const nm = document.createElement('span')
  nm.className = 'nm'
  nm.textContent = tag.label
  nm.title = tag.name
  el.append(nm)
  el.addEventListener('click', (event) => {
    event.stopPropagation()
    // 干活中锁住：这一轮的文件不动
    if (view.input.mode === 'working') return
    openTagMenu(el, tag)
  })
  return el
}

function openTagMenu(anchor, tag) {
  els.tagmenu.textContent = ''
  const items = [
    { label: view.labels.tagTemplate, action: { type: 'move', path: tag.path, to: 'template' }, off: tag.role === 'template' },
    { label: view.labels.tagMaterial, action: { type: 'move', path: tag.path, to: 'materials' }, off: tag.role === 'material' },
    { label: view.labels.tagRemove, action: { type: 'remove', path: tag.path } },
  ]
  for (const one of items) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = one.label
    btn.disabled = !!one.off
    btn.addEventListener('click', () => { els.tagmenu.hidden = true; act(one.action) })
    els.tagmenu.append(btn)
  }
  els.tagmenu.hidden = false
  const box = anchor.getBoundingClientRect()
  els.tagmenu.style.left = `${Math.max(4, Math.min(box.left, innerWidth - 130))}px`
  els.tagmenu.style.top = `${box.bottom + 4}px`
}

function renderTags() {
  const tags = view.tags || []
  els.tagrow.hidden = tags.length === 0
  els.tags.textContent = ''
  const max = 3
  for (const tag of tags.slice(0, max)) els.tags.append(tagEl(tag))
  if (tags.length > max) {
    const more = document.createElement('span')
    more.className = 'more'
    more.textContent = `+${tags.length - max}`
    els.tags.append(more)
  }
}

function renderMenu() {
  els.menu.textContent = ''
  const group = (label, items, action) => {
    if (!items.length) return
    const box = document.createElement('div')
    box.className = 'menu-group'
    const head = document.createElement('div')
    head.className = 'menu-label'
    head.textContent = label
    box.append(head)
    for (const item of items) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.dataset.dir = item.dir
      btn.dataset.act = action
      btn.textContent = item.name
      btn.title = item.dir
      box.append(btn)
    }
    els.menu.append(box)
  }
  group('最近的文件夹', view.top.recent.items, 'recent')
  group('最近的任务', view.top.recent.tasks, 'open-recent')
  if (view.top.recent.allTasks) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'menu-all'
    btn.dataset.dir = view.top.recent.allTasks
    btn.dataset.act = 'all-tasks'
    btn.textContent = '全部任务…'
    btn.title = view.top.recent.allTasks
    els.menu.append(btn)
  }
}

// 窗高跟着内容长，最高 640，超了中间那段滚
function reportSize() {
  if (!bridge || !view) return
  const height = els.top.offsetHeight + els.tagrow.offsetHeight + els.box.offsetHeight + flowHeight()
  if (Math.abs(height - lastHeight) < 2) return
  lastHeight = height
  bridge.size(height)
}

// 「正在工作」那行上的秒数：自己走
function tick() {
  const now = Date.now()
  for (const one of document.querySelectorAll('.secs')) {
    const since = Number(one.dataset.since) || now
    one.textContent = elapsedText(now - since)
  }
}

function render(next) {
  const first = !view
  // 同一个视图不重画：重画会把按钮换掉，鼠标点下去就落空
  const json = JSON.stringify(next)
  if (json === lastJson) return
  lastJson = json
  const wasFocus = view ? view.input.focus : false
  view = next
  document.title = view.title
  els.path.textContent = view.top.path.text
  els.path.title = view.top.path.title
  els.path.disabled = !view.top.path.open
  els.recent.disabled = !(view.top.recent.enabled && (view.top.recent.items.length || view.top.recent.tasks.length || view.top.recent.allTasks))
  if (els.recent.disabled) els.menu.hidden = true
  els.newtask.textContent = view.top.newTask
  els.newtask.disabled = view.top.locked && view.phase === 'working'
  renderMenu()
  renderTags()
  els.input.placeholder = view.input.hint
  els.send.textContent = view.input.button === 'stop' ? view.labels.stop : view.labels.send
  els.send.classList.toggle('stop', view.input.button === 'stop')
  if (view.input.focus && (!wasFocus || first)) els.input.focus()
  renderFlow()
  requestAnimationFrame(reportSize)
}

function trySend() {
  if (!view || !view.input.canSend) return
  const text = els.input.value
  if (!text.trim()) return
  forceBottom = true // 发完滚到底，别跳顶
  act({ type: 'send', text })
  els.input.value = ''
}

function hideDrop() {
  els.drop.hidden = true
  for (const one of els.drop.querySelectorAll('.zone')) one.classList.remove('on')
}

function bind() {
  els.path.addEventListener('click', () => {
    if (view && view.top.path.open) act({ type: 'open-folder', path: view.top.path.open })
  })
  els.recent.addEventListener('click', () => { els.menu.hidden = !els.menu.hidden })
  els.menu.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-dir]')
    if (!btn) return
    els.menu.hidden = true
    act({ type: btn.dataset.act, dir: btn.dataset.dir })
  })
  els.newtask.addEventListener('click', () => act({ type: 'new' }))
  els.addfile.addEventListener('click', () => act({ type: 'add', cell: 'materials' }))
  addEventListener('pointerdown', (event) => {
    if (!els.menu.hidden && !els.menu.contains(event.target) && !els.recent.contains(event.target)) els.menu.hidden = true
    if (!els.tagmenu.hidden && !els.tagmenu.contains(event.target)) els.tagmenu.hidden = true
  }, true)
  addEventListener('keydown', (event) => { if (event.key === 'Escape') { els.menu.hidden = true; els.tagmenu.hidden = true } })
  els.input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
    event.preventDefault()
    trySend()
  })
  els.send.addEventListener('click', () => {
    if (!view) return
    if (view.input.button === 'stop') { act({ type: 'stop' }); return }
    trySend()
  })
  els.flow.addEventListener('scroll', () => {
    stick = atBottom()
    if (stick) pendingNew = false
    updateLatest()
  })
  els.latest.addEventListener('click', () => {
    stick = true
    pendingNew = false
    els.flow.scrollTop = els.flow.scrollHeight
    updateLatest()
  })
  // 拖着文件进窗：整窗分两块，压在哪块哪块变实线
  addEventListener('dragover', (event) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    els.drop.hidden = false
  })
  addEventListener('dragleave', (event) => { if (!event.relatedTarget) hideDrop() })
  addEventListener('drop', hideDrop)
  els.drop.addEventListener('dragover', (event) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    const zone = event.target.closest('.zone')
    dropCell = zone ? zone.dataset.cell : 'materials'
    for (const one of els.drop.querySelectorAll('.zone')) one.classList.toggle('on', one === zone)
  })
  els.drop.addEventListener('drop', (event) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    const cell = dropCell
    hideDrop()
    if (bridge) bridge.drop([...event.dataTransfer.files], cell)
  })
}

bind()
setInterval(tick, 1000)
if (bridge) {
  // 有壳才有收起状态：壳说一声才垂下来
  panel.classList.add('closed')
  bridge.onView((next) => render(next))
  bridge.onAnim((kind) => playAnim(kind))
  bridge.ready().then((first) => { if (first) render(first) }).catch(() => {})
}

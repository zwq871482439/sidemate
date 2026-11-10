// 任务窗预览壳：不走 app/main/main.mjs。起一个 460×680 的窗，把十种画面喂给页面、
// 逐张截图存 SIDEMATE_SHOTS，再在页面上真点一遍，收到的动作连同画面名记进 acts.json。

// 默认导入再解构：纯 node 下 'electron' 只导出可执行文件路径（没有具名导出），
// 具名导入会在链接时就报错；这个文件被 npm test 当测试扫到，必须纯 node 下也不炸。
import electron from 'electron'
const { app, BrowserWindow, ipcMain } = electron
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { createTask, reduceTask, toTaskView } from '../../app/task/state.mjs'
import { createReloadGuard } from '../../app/task/reload-guard.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = process.env.SIDEMATE_SHOTS
const only10 = process.argv.includes('--only-10')

const FOLDER = 'C:/Users/slow/Desktop/本周材料'
const TPL = FOLDER + '/第三季度工程项目建设进展情况汇报（定稿）.docx'
const MATS = ['三季度工程进度周报表.xlsx', '本周会议纪要.docx', '数据汇总（含三季度完整口径）.xlsx', '上周周报.docx', '各项目负责人沟通记录.docx', '三季度现场照片说明.docx', '口径备注与勘误.docx'].map((n) => FOLDER + '/' + n)
const OUT = 'C:/Users/slow/桌伴/任务/1104-汇成本周周报/桌伴输出'
const CARD = OUT + '/本周周报.docx'
const LONG = '一二三四五六七八九十'.repeat(12) // 120 个汉字
const OPTS = { root: 'C:/Users/slow/桌伴', recent: ['C:/Users/slow/Desktop/本周材料', 'C:/Users/slow/Desktop/三季度汇报材料', 'C:/Users/slow/Documents/年度总结材料'] }
const RECENT_OPTS = { ...OPTS, recentTasks: [{ dir: 'C:/Users/slow/桌伴/任务/2026-11-05-总结这些形成文献综述', out: 'C:/Users/slow/桌伴/任务/2026-11-05-总结这些形成文献综述/桌伴输出', name: '11-05 总结这些形成文献综述', mtime: 1 }], allTasks: 'C:/Users/slow/桌伴/任务' }
const usage = (extra = {}) => ({ at: Date.UTC(2026, 10, 6, 12, 0, 0), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, searches: 0, ...extra })

const feed = (state, event) => reduceTask(state, event).state

// 带上范本和七份材料的起点
function base() {
  let s = createTask()
  s = feed(s, { type: 'drop', folder: FOLDER, files: MATS })
  s = feed(s, { type: 'drop', files: [TPL], cell: 'template' })
  return s
}

function scene2() {
  let s = base()
  s = feed(s, { type: 'send', text: '汇成本周周报', runId: 'w1' })
  s = feed(s, { type: 'step', taskId: 'w1', step: 'prepare' })
  s = feed(s, { type: 'step', taskId: 'w1', step: 'copy' })
  s = feed(s, { type: 'progress', taskId: 'w1', text: '正在看 三季度工程进度周报表.xlsx' })
  s = feed(s, { type: 'progress', taskId: 'w1', text: '正在写 本周周报.docx' })
  return toTaskView(s, OPTS)
}

function scene5() {
  let s = base()
  s = feed(s, { type: 'send', text: '汇成本周周报', runId: 'r1' })
  s = feed(s, { type: 'step', taskId: 'r1', step: 'prepare' })
  s = feed(s, { type: 'step', taskId: 'r1', step: 'copy' })
  s = feed(s, { type: 'progress', taskId: 'r1', text: '正在看 三季度工程进度周报表.xlsx' })
  s = feed(s, { type: 'progress', taskId: 'r1', text: '正在写 本周周报.docx' })
  s = feed(s, { type: 'output', taskId: 'r1', name: '本周周报.docx', to: OUT + '/本周周报.docx', pages: 12, cite: { verified: 86, missed: 4 } })
  s = feed(s, { type: 'reply', taskId: 'r1', text: '周报写好了，十二页，格式照范本，数字取自三季度进度周报表。' })
  s = feed(s, { type: 'step', taskId: 'r1', step: 'cite' })
  s = feed(s, { type: 'end', taskId: 'r1', status: 'done' })
  return toTaskView(s, OPTS)
}

// 一轮里模型说了两段（中间夹着工具调用）：两个气泡
function sceneTwo() {
  let s = base()
  s = feed(s, { type: 'send', text: '汇成本周周报', runId: 't1' })
  s = feed(s, { type: 'reply', taskId: 't1', text: '没有什么工具，我先把七份材料看一遍。' })
  s = feed(s, { type: 'reply', taskId: 't1', text: '看完了：本周新增两条风险，累计口径按上周那版。' })
  s = feed(s, { type: 'end', taskId: 't1', status: 'done' })
  return toTaskView(s, OPTS)
}

// 长对话：回复一多就能滚了，用来试回车发消息前后的滚动位置
function longScene(count, extra = '') {
  let s = base()
  s = feed(s, { type: 'send', text: '汇成本周周报', runId: 'l1' })
  for (let i = 1; i <= count; i += 1) {
    s = feed(s, { type: 'reply', taskId: 'l1', text: `第 ${i} 段回答：这一段是为了把对话流撑长，撑到能滚。` })
  }
  s = feed(s, { type: 'end', taskId: 'l1', status: 'done' })
  if (extra) s = feed(s, { type: 'send', text: extra, runId: 'l2' })
  return toTaskView(s, OPTS)
}

// 回话带 Markdown 的画面：粗体、代码、标题、列表、表格
const FMT_TEXT = '**写完了**，产出是 `中医文献综述.docx`。\n### 结构\n- 一、流派概览\n- 二、病机十九条\n1. 表格 5 张\n| 文件 | 页 |\n| --- | --- |\n| 综述 | 12 |\n<b>这不是粗体</b>'

function sceneFmt() {
  let s = base()
  s = feed(s, { type: 'send', text: '写文献综述', runId: 'f1' })
  s = feed(s, { type: 'reply', taskId: 'f1', text: FMT_TEXT })
  s = feed(s, { type: 'end', taskId: 'f1', status: 'done' })
  return toTaskView(s, OPTS)
}

// 比多一份材料的画面（给「▾」开着时换画面用）
function moreView() {
  let s = base()
  s = feed(s, { type: 'drop', files: [FOLDER + '/补充说明.docx'] })
  return toTaskView(s, OPTS)
}

function buildScenes() {
  let q = base()
  q = feed(q, { type: 'send', text: '把材料改成正式口吻', runId: 'q1' })
  q = feed(q, { type: 'step', taskId: 'q1', step: 'prepare' })
  q = feed(q, { type: 'reply', taskId: 'q1', text: '材料三里有两张表：本周、累计。周报的数用哪张？' })
  q = feed(q, { type: 'end', taskId: 'q1', status: 'done' })
  let e = base()
  e = feed(e, { type: 'send', text: '汇成本周周报', runId: 'e1' })
  e = feed(e, { type: 'step', taskId: 'e1', step: 'prepare' })
  e = feed(e, { type: 'step', taskId: 'e1', step: 'copy' })
  e = feed(e, { type: 'error', taskId: 'e1', reason: 'key' })
  let c = createTask()
  c = feed(c, { type: 'send', text: '讲个笑话', runId: 'c1' })
  c = feed(c, { type: 'reply', taskId: 'c1', text: '改稿子最怕的两件事：别人不留底稿，和让自己留底稿。' })
  c = feed(c, { type: 'end', taskId: 'c1', status: 'done' })
  return [
    { name: '1-空的', view: toTaskView(createTask(), OPTS) },
    { name: '2-带了文件还没开始', view: toTaskView(base(), OPTS) },
    { name: '3-干活中', view: scene2() },
    { name: '4-等你回话', view: toTaskView(q, OPTS) },
    { name: '5-做完了', view: scene5() },
    { name: '6-没干成', view: toTaskView(e, OPTS) },
    { name: '7-只聊天', view: toTaskView(c, OPTS) },
    { name: '8-回话带格式', view: sceneFmt() },
    { name: '9-两段回答', view: sceneTwo() },
    { name: '10-新任务', view: toTaskView(base(), OPTS) },
    { name: '最近两组', view: toTaskView(base(), RECENT_OPTS) },
  ]
}

// 每种画面截完图后真点一遍的脚本；返回的值记进 checks
const CLICKS = {
  '1-空的': `(() => { document.querySelector('#input').value = '讲个笑话'; return true })()`,
  '2-带了文件还没开始': `(() => {
    const input = document.querySelector('#input')
    const key = (extra) => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, ...extra }))
    input.value = '汇成本周周报'
    key({ shiftKey: true })
    key({ isComposing: true, keyCode: 229, which: 229 })
    const held = input.value
    key({ keyCode: 13, which: 13 })
    document.querySelector('#addfile').click()
    const tags = [...document.querySelectorAll('#tags .tag')]
    tags[0].click()
    const items = [...document.querySelectorAll('#tagmenu button')].map((one) => one.textContent)
    document.querySelectorAll('#tagmenu button')[1].click()
    tags[1].click()
    document.querySelectorAll('#tagmenu button')[2].click()
    document.querySelector('#path').click()
    document.querySelector('#recent').click()
    document.querySelector('#menu button').click()
    return { held, cleared: input.value === '', items }
  })()`,
  '3-干活中': `(() => {
    const input = document.querySelector('#input')
    input.value = '这轮干完就能发'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }))
    document.querySelector('#send').click()
    return true
  })()`,
  '5-做完了': `(() => {
    const card = [...document.querySelectorAll('.card')].find((el) => el.dataset.path === ${JSON.stringify(OUT + '/本周周报.docx')})
    for (const btn of card.querySelectorAll('.btns button')) btn.click()
    return true
  })()`,
  '6-没干成': `(() => {
    for (const btn of document.querySelectorAll('#flow .error button')) btn.click()
    return true
  })()`,
  '9-两段回答': `(() => ({ replies: document.querySelectorAll('#flow .reply').length }))()`,
  '10-新任务': `(() => { document.querySelector('#newtask').click(); return true })()`,
  '最近两组': `(() => { document.querySelector('#recent').click(); document.querySelector('#menu button[data-act="open-recent"]').click(); return true })()`,
}

// 拖着文件进窗：整窗分两块
const DRAG = `(() => {
  const dt = new DataTransfer()
  dt.items.add(new File(['x'], 'x.docx'))
  document.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
  const zones = [...document.querySelectorAll('#dropmask .zone')]
  const on = zones.map((one) => one.classList.contains('on'))
  zones[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
  const left = zones[0].classList.contains('on')
  return { zones: zones.length, on, left, hidden: document.querySelector('#dropmask').hidden }
})()`

// 不带 preload 的窗里点一遍、拖一遍：console 里不该有 error
const NOBRIDGE = `(() => {
  document.querySelector('#send').click()
  document.querySelector('#path').click()
  document.querySelector('#recent').click()
  document.querySelector('#newtask').click()
  document.querySelector('#addfile').click()
  const input = document.querySelector('#input')
  input.value = 'abc'
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }))
  const dt = new DataTransfer()
  dt.items.add(new File(['x'], 'x.docx'))
  document.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
  document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  return true
})()`

const SCENE11 = '11-输入框120字'

// 界面上那几样东西的位置和样子：靠右、照排、红字只给两处
const DESIGN = `(() => {
  const flow = document.querySelector('#flow')
  const box = flow.getBoundingClientRect()
  const at = (sel) => document.querySelector(sel)
  const rect = (sel) => { const el = at(sel); return el ? el.getBoundingClientRect() : null }
  const user = rect('.user')
  const reply = rect('.reply')
  const md = at('.reply .md')
  const card = at('.card')
  const working = at('.working')
  const tail = at('.reply .tail')
  const err = at('.error')
  return {
    userRight: user ? Math.round(box.right - user.right) : -1,
    replyLeft: reply ? Math.round(reply.left - box.left) : -1,
    working: working ? working.textContent : '',
    replies: document.querySelectorAll('#flow .reply').length,
    tail: tail ? tail.textContent : '',
    tailColor: tail ? getComputedStyle(tail).color : '',
    err: err ? err.textContent : '',
    errColor: err ? getComputedStyle(err).color : '',
    md: md ? { h: md.querySelectorAll('h3,h4,h5,h6').length, ul: md.querySelectorAll('ul').length, table: md.querySelectorAll('table').length, stars: md.textContent.includes('*') } : null,
    card: card ? { icon: !!card.querySelector('svg'), buttons: card.querySelectorAll('.btns button').length, line: card.querySelector('.sub').textContent, name: card.querySelector('.nm').textContent } : null,
  }
})()`

// 截某些图之前先点一下
const PRE = {}

async function main() {
  if (!shots) throw new Error('SIDEMATE_SHOTS 未设置')
  mkdirSync(shots, { recursive: true })
  let current = null
  let readyResolve = null
  let readyCount = 0
  const readyOnce = new Promise((resolve) => { readyResolve = resolve })
  const acts = []
  const layout = {}
  const checks = { overlap: {}, menu: {}, flow: {}, sizes: {}, design: {} }
  let sendReply = null // 主进程收到「发送」后回的那个视图
  ipcMain.handle('task:ready', () => { readyCount += 1; readyResolve(); return current ? current.view : null })
  ipcMain.on('task:act', (_event, action) => {
    acts.push({ scene: current ? current.name : '', action })
    if (action.type === 'send' && sendReply) {
      current = { name: current ? current.name : '', view: sendReply }
      win.webContents.send('task:view', sendReply)
    }
  })
  ipcMain.on('task:drop', (_event, payload) => { acts.push({ scene: current ? current.name : '', action: { type: 'drop', ...payload } }) })

  const win = new BrowserWindow({
    width: 460, height: 680, show: false,
    webPreferences: { preload: join(root, 'app', 'task', 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  await win.loadFile(join(root, 'app', 'task', 'task.html'))
  await Promise.race([readyOnce, sleep(5_000)])
  win.show()
  const w = win.webContents
  // 露脸：页面第一帧是收起状态，壳说一声才垂下来（照 app/task/shell.mjs）
  w.send('task:anim', 'in')
  await sleep(400)
  const settle = () => w.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const overflow = '(() => { const de = document.documentElement; return { x: de.scrollWidth - de.clientWidth, y: de.scrollHeight - de.clientHeight } })()'
  const push = async (name, view) => { current = { name, view }; w.send('task:view', view); await settle() }
  // 截图等画面稳：capturePage 可能拿到合成器的旧帧，连着两次一样且跟上一次的画面不同才存
  const shot = async (stale) => {
    let prev = (await w.capturePage()).toPNG()
    for (let i = 0; i < 15; i++) {
      await sleep(120)
      const next = (await w.capturePage()).toPNG()
      if (next.equals(prev) && !next.equals(stale)) return next
      prev = next
    }
    return prev
  }
  const show = async (name, view) => {
    const stale = (await w.capturePage()).toPNG()
    await push(name, view)
    if (name === '最近两组') await w.executeJavaScript('document.querySelector("#recent").click()')
    if (PRE[name]) await w.executeJavaScript(PRE[name])
    layout[name] = await w.executeJavaScript(overflow)
    writeFileSync(join(shots, `${name}.png`), await shot(stale))
  }

  if (only10) {
    await show('10-做完了-1.5x', scene5())
    await sleep(150)
    app.exit(0)
    return
  }

  const scenes = buildScenes()
  const ready = scenes[1].view
  const working = scenes[2].view
  for (const one of scenes) await show(one.name, one.view)

  // 第 1 条：输入框 120 个汉字，#send 和 #input 两个矩形的交集该是 0；两种窗、两个按钮字都量
  const overlapJS = `(() => {
    const a = document.querySelector('#input').getBoundingClientRect()
    const b = document.querySelector('#send').getBoundingClientRect()
    const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
    return { area: Math.round(x * y), btn: document.querySelector('#send').textContent }
  })()`
  const stale11 = (await w.capturePage()).toPNG()
  await push(SCENE11, ready)
  await w.executeJavaScript(`document.querySelector('#input').value = ${JSON.stringify(LONG)}`)
  await settle()
  layout[SCENE11] = await w.executeJavaScript(overflow)
  writeFileSync(join(shots, `${SCENE11}.png`), await shot(stale11))
  checks.overlap['460x680-send'] = await w.executeJavaScript(overlapJS)
  await push(SCENE11, working)
  checks.overlap['460x680-stop'] = await w.executeJavaScript(overlapJS)

  // 第 2 条：顶栏 44、小签行 38、输入区 102；五种输入区一样高
  const sizesJS = `(() => {
    const h = (sel) => { const el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().height) : -1 }
    return { top: h('#top'), tags: h('#tagrow'), box: h('#box'), tagHidden: document.querySelector('#tagrow').hidden }
  })()`
  await push('尺寸', ready)
  checks.sizes.withFiles = await w.executeJavaScript(sizesJS)
  await push('尺寸', toTaskView(createTask(), OPTS))
  checks.sizes.empty = await w.executeJavaScript(sizesJS)

  // 第 3 条 a：「▾」开着时来新视图不收，点不开了才收
  const menuHidden = () => w.executeJavaScript('document.querySelector("#menu").hidden')
  await push('菜单-留开', ready)
  await w.executeJavaScript('document.querySelector("#recent").click()')
  checks.menu.opened = await menuHidden()
  await push('菜单-留开', ready)
  checks.menu.same = await menuHidden()
  await push('菜单-留开', moreView())
  checks.menu.extra = await menuHidden()
  await push('菜单-留开', working)
  checks.menu.closed = await menuHidden()

  // 第 3 条 b：每 50 ms 连推同一个视图，真按鼠标只该收到一条动作
  const centerOf = (expr) => w.executeJavaScript(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  const pushClick = async (name, view, expr) => {
    await push(name, view)
    const pt = await centerOf(expr)
    const before = acts.length
    const timer = setInterval(() => w.send('task:view', view), 50)
    w.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await sleep(150)
    w.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left' })
    await sleep(120)
    clearInterval(timer)
    await settle()
    return acts.slice(before).map((one) => one.action)
  }
  const openBtn = `document.querySelector(${JSON.stringify(`.card[data-path="${CARD}"] .btns button`)})`
  checks.openClicks = await pushClick('连推-做完了', scene5(), openBtn)
  checks.stopClicks = await pushClick('连推-干活中', working, 'document.querySelector("#send")')

  // 第 4 条：出卡那一帧在 MutationObserver 回调里量流末；底段高不超窗高 45%
  const frameAt = async () => {
    await push('流末', scene2())
    await w.executeJavaScript(`(() => {
      const f = document.querySelector('#flow')
      window.__gap = null
      new MutationObserver(() => { window.__gap = f.scrollHeight - f.scrollTop - f.clientHeight }).observe(f, { childList: true, subtree: true })
      return true
    })()`)
    await push('流末', scene5())
    return w.executeJavaScript('(() => { const f = document.querySelector("#flow"); return { gap: window.__gap, scroll: f.scrollHeight > f.clientHeight } })()')
  }
  checks.flow['460x680'] = await frameAt()

  // 第 5 条：拖着文件进窗，整窗分两块
  await push('拖着文件进窗', ready)
  checks.drag = await w.executeJavaScript(DRAG)
  await settle()
  writeFileSync(join(shots, '12-拖着文件进窗.png'), await w.capturePage().then((one) => one.toPNG()))

  // 第 6 条：界面上那几样东西的位置和样子
  await push('样子-做完了', scene5())
  checks.design.done = await w.executeJavaScript(DESIGN)
  await push('样子-回话带格式', sceneFmt())
  checks.design.fmt = await w.executeJavaScript(DESIGN)
  const askView = buildScenes()[3].view
  await push('样子-等你回话', askView)
  checks.design.ask = await w.executeJavaScript(DESIGN)
  const errView = buildScenes()[5].view
  await push('样子-没干成', errView)
  checks.design.fail = await w.executeJavaScript(DESIGN)
  await push('样子-干活中', working)
  checks.design.work = await w.executeJavaScript(DESIGN)

  // 第 7 条：回车发消息 → 滚到底；用户自己往上翻着看 → 来了新内容不硬拽
  const scrollJS = '(() => { const f = document.querySelector("#flow"); return { top: Math.round(f.scrollTop), height: f.scrollHeight, client: f.clientHeight } })()'
  const grab = async (name) => {
    await sleep(300)
    await settle()
    writeFileSync(join(shots, `${name}.png`), await w.capturePage().then((one) => one.toPNG()))
  }
  const toTop = '(() => { const f = document.querySelector("#flow"); f.scrollTop = 0; f.dispatchEvent(new Event("scroll")); return true })()'
  const longBefore = longScene(14)
  const longAfter = longScene(14, '再补一段')
  await push('长对话', longBefore)
  await w.executeJavaScript(toTop)
  await settle()
  const topBefore = await w.executeJavaScript(scrollJS)
  await grab('13-发消息前')
  sendReply = longAfter
  await w.executeJavaScript(`(() => {
    const input = document.querySelector('#input')
    input.value = '再补一段'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }))
    return true
  })()`)
  await sleep(400)
  await settle()
  const topAfter = await w.executeJavaScript(scrollJS)
  await grab('14-发消息后')
  checks.scroll = { before: topBefore, after: topAfter }
  sendReply = null

  // 用户自己往上翻着看：来了新内容不硬拽，右下角露「↓ 有新消息」
  await push('长对话-用户往上翻', longBefore)
  await w.executeJavaScript(toTop)
  await settle()
  const keptBefore = await w.executeJavaScript(scrollJS)
  await push('长对话-来了新内容', longAfter)
  await settle()
  const keptAfter = await w.executeJavaScript(scrollJS)
  const label = await w.executeJavaScript('document.querySelector("#latest").textContent')
  await grab('15-往上翻来新内容')
  checks.scrollKeep = { before: keptBefore, after: keptAfter, label }

  // 每种画面点一遍，收到的动作连同画面名记下来
  const clickChecks = {}
  for (const one of scenes) {
    const script = CLICKS[one.name]
    if (!script) continue
    await push(one.name, one.view)
    const back = await w.executeJavaScript(script)
    if (back && typeof back === 'object') Object.assign(clickChecks, back)
    await sleep(120)
  }

  // 第 6 条：不带 preload 的窗里点一遍、拖一遍，console 里 0 条 error
  const logs = []
  const bare = new BrowserWindow({ width: 460, height: 680, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
  bare.webContents.on('console-message', (_event, level, message) => { logs.push({ level, message }) })
  await bare.loadFile(join(root, 'app', 'task', 'task.html'))
  await bare.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await bare.webContents.executeJavaScript(NOBRIDGE)
  await sleep(250)
  checks.noPreload = { errors: logs.filter((one) => one.level === 3 || one.level === 'error' || /uncaught/i.test(one.message)).length, logs }
  bare.destroy()

  // 渲染进程崩了：页面自己回来，还是崩之前那个视图（10 秒内）
  const crashGuard = createReloadGuard()
  const crashes = []
  win.webContents.on('render-process-gone', (_event, details) => {
    const plan = crashGuard.gone({ reason: details.reason, exitCode: details.exitCode })
    crashes.push({ reason: details.reason, exitCode: details.exitCode, reload: plan.reload, count: plan.count })
    if (plan.reload) win.webContents.loadFile(join(root, 'app', 'task', 'task.html'))
  })
  const flowJS = '(() => { const items = document.querySelectorAll("#flow > div"); return { count: items.length, first: items[0] ? items[0].textContent : "" } })()'
  await push('崩之前', scene5())
  const before = await w.executeJavaScript(flowJS)
  const readyBefore = readyCount
  w.forcefullyCrashRenderer()
  let back = false
  for (let i = 0; i < 100 && !back; i += 1) {
    await sleep(100)
    if (readyCount > readyBefore) back = true
  }
  let after = null
  for (let i = 0; i < 50; i += 1) {
    try { after = await w.executeJavaScript(flowJS) } catch { after = null }
    if (after && after.count > 0) break
    await sleep(100)
  }
  checks.crash = { readyBefore, readyAfter: readyCount, back, before, after, crashes }

  writeFileSync(join(shots, 'acts.json'), JSON.stringify({ acts, checks: clickChecks, layout }, null, 2) + '\n')
  writeFileSync(join(shots, 'checks.json'), JSON.stringify(checks, null, 2) + '\n')
  await sleep(150)
  app.exit(0)
}

// 只在 Electron 里起窗；纯 node（npm test 把本文件当测试扫）下什么都不做，退出码 0
if (process.versions.electron) {
  app.whenReady().then(() => main().catch((error) => { console.error(error); app.exit(1) }))
}

// 小岛：贴在屏幕顶边的墨色小条，平时只有一双眼睛。
// 拖动不用 app-region：那块会被当成标题栏，页面收不到拖放；这里手动跟鼠标。
// 完整路径在 preload 里用 webUtils.getPathForFile 拿。

import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, screen, shell, systemPreferences } from 'electron'
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bubbleOf, elapsedText } from './bubble.mjs'
import { cubicBezier } from './ease.mjs'
import { petMenuTemplate } from './menu.mjs'
import { applyOnTop, createOnTop, onTopFromPlace } from './on-top.mjs'
import { createRecaller } from './recall.mjs'
import { readPlace, writePlace } from './place-store.mjs'
import { coversDisplay, watchForeground } from './foreground.mjs'
import { INTRO_LINE, introAlive, introTiming } from './intro.mjs'
import { centerX, displayAt, dragBounds, dragGrab, dropScene, expandedBounds, restorePlace, topStrip } from './place.mjs'
import { onCollapse, onExpand, onHover, onStateChange } from './scene.mjs'
import { clearHeld, createState, reduce } from './state.mjs'
import { petClick, petDrop } from './click.mjs'
import { pressIsland } from './press.mjs'
import { theme, bubbleBoxWidth } from './theme.mjs'
import { deskRoot } from '../workspace/index.mjs'
import { recentMenuTemplate, recentTasks } from '../task/recent-tasks.mjs'
import { iconPath } from '../assets/icon.mjs'
import { startTestHook } from './test-hook.mjs'

const dir = dirname(fileURLToPath(import.meta.url))
const easeOut = cubicBezier(...theme.curveOut)
const easeIn = cubicBezier(...theme.curveIn)

let pet, tray, logFile, rest = null, dragTimer = null, dragging = false, grab = null
let leaveTimer = null, hoverTimer = null, demoArmed = false
let introBusy = null, introGen = 0, introPhase = 'idle', introTimers = [], state = createState()
let openTask = () => {}, toggleTask = () => 'opened', openSettings = () => {}, recentList = () => []
let scene = 'strip', bubbleWidth = 0, animTimer = null, stopWatch = null, lineHoldUntil = 0
let rendererReady = false
let workSince = 0, workTimer = null
let topper = null
let setTaskTop = () => {}
let raiseTask = () => {}
let recaller = null
let stopHook = () => {}
// 叫回小岛时临时置顶着：别让别的置顶窗一激活就把它压回去
let tempTop = false

try { app.setAppUserModelId('cn.deskware.sidemate') } catch { /* Windows 通知才用得到 */ }

function log(event, data = {}) {
  if (!logFile) return
  try { appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), event, ...data })}\n`) } catch { /* 日志失败不能弄丢拖放 */ }
}

function stillMotion() {
  if (process.env.SIDEMATE_PET_STILL === '1') return true
  try { return systemPreferences.getAnimationSettings().prefersReducedMotion === true } catch { return false }
}

function send(channel, payload) {
  if (pet && !pet.isDestroyed()) pet.webContents.send(channel, payload)
}

function notify(body) {
  try { if (Notification.isSupported()) new Notification({ title: '桌伴', body, icon: iconPath }).show() } catch { /* 没有通知服务 */ }
}

// 小岛待的那块屏：只能吸顶，能贴到哪块屏的顶边就贴哪块
function homeDisplay() {
  const point = { x: (rest?.x ?? 0) + theme.island / 2, y: (rest?.y ?? 0) + 4 }
  return displayAt(screen, point)
}

function area() {
  return homeDisplay().workArea
}

// 最近一次产出：冒的那行里的「打开」用它
function latestOutput() {
  try {
    for (const task of recentTasks(deskRoot())) {
      if (!task.out || !existsSync(task.out)) continue
      for (const name of readdirSync(task.out)) {
        const path = join(task.out, name)
        try {
          const st = statSync(path)
          if (st.isFile()) return path
        } catch { /* 读不到就跳过 */ }
      }
    }
  } catch { /* 没有产出就算没干成 */ }
  return ''
}

function artifactName() {
  if (state.artifact) return basename(state.artifact)
  if (state.mode !== 'done') return ''
  const path = latestOutput()
  return path ? basename(path) : ''
}

function push() {
  const artifact = artifactName()
  send('pet:state', { mode: state.mode, message: state.message, artifact })
  send('pet:bubble', bubbleOf({ mode: state.mode, message: state.message, artifact, elapsed: elapsedText(workSince ? Date.now() - workSince : 0) }))
}

// 干活中那行后面的秒数自己走
function syncClock() {
  if (state.mode === 'work') {
    if (!workSince) workSince = Date.now()
    if (workTimer) return
    workTimer = setInterval(() => {
      send('pet:bubble', bubbleOf({ mode: state.mode, message: state.message, artifact: artifactName(), elapsed: elapsedText(Date.now() - workSince) }))
    }, 1000)
    return
  }
  workSince = 0
  clearInterval(workTimer)
  workTimer = null
}

function apply(event) {
  const step = reduce(state, event)
  state = step.state
  if (step.notify) notify(state.notice || state.message)
  syncClock()
  push()
  // 有事不再自动冒字：状态变了只改眼神，不自己张开
  if (onStateChange().expand) expand()
}

// 用户点开小岛 / 任务窗打开：做完了、要你看一眼、没干成这三种收回去，回待命
function resetHeld() {
  const next = clearHeld(state)
  if (next === state) return false
  state = next
  push()
  syncClock()
  return true
}

function taskOpened(detail) {
  if (detail) openTask(detail)
  else openTask()
  resetHeld()
}

// 窗子跟着样子改大小
function targetBounds() {
  const work = area()
  if (scene === 'tray') {
    const width = theme.receiveWidth
    return { ...topStrip(rest.x + (rest.width - width) / 2, work, width, theme.receiveHeight), y: work.y }
  }
  if (scene === 'line') {
    const width = theme.lineWidth
    return { ...topStrip(rest.x + (rest.width - width) / 2, work, width, theme.lineHeight), y: work.y }
  }
  if (scene === 'expanded') return expandedBounds(rest, expandedWidth(), work)
  return topStrip(rest.x, work, rest.width, rest.height)
}

function expandedWidth() {
  // 左边表情区 + 空 + 文字区（跟着字走）+ 右边留白；太长封顶 bubbleHardMax
  return bubbleBoxWidth(bubbleWidth)
}

function mix(from, to, amount) {
  const box = {}
  for (const key of ['x', 'y', 'width', 'height']) box[key] = Math.round(from[key] + (to[key] - from[key]) * amount)
  return box
}

function animateTo(to, duration, easing) {
  clearInterval(animTimer)
  animTimer = null
  if (!pet || pet.isDestroyed()) return
  if (stillMotion() || !duration) {
    pet.setBounds(to)
    return
  }
  const from = pet.getBounds()
  const started = Date.now()
  animTimer = setInterval(() => {
    const t = Math.min(1, (Date.now() - started) / duration)
    pet.setBounds(mix(from, to, easing(t)))
    if (t < 1) return
    clearInterval(animTimer)
    animTimer = null
    pet.setBounds(to)
  }, 16)
}

function applyScene(next, options = {}) {
  const changed = scene !== next
  const before = scene
  scene = next
  if (changed) {
    send('pet:scene', { scene: next })
    if (next === 'tray') log('expand', { scene: next })
    else if (before === 'tray') log('collapse', { scene: next })
  }
  const to = targetBounds()
  // 细线变回来的时候再说一遍层级
  if (next === 'strip' && before === 'line') refreshTop()
  if (options.immediate) {
    animateTo(to, 0, easeOut)
    return
  }
  const duration = next === 'expanded' ? theme.expandMs : next === 'strip' ? theme.collapseMs : theme.sceneMs
  animateTo(to, duration, next === 'strip' ? easeIn : easeOut)
}

function expand() {
  if (!onExpand(scene).expand) return
  scene = 'expanded'
  send('pet:scene', { scene })
  if (!bubbleWidth) {
    animateTo(targetBounds(), 0, easeOut)
    return
  }
  animateTo(targetBounds(), theme.expandMs, easeOut)
}

function collapse() {
  if (!onCollapse(scene).collapse) return
  scene = 'strip'
  send('pet:scene', { scene })
  animateTo(targetBounds(), theme.collapseMs, easeIn)
}

function trayIcon() {
  // ico 的 16/32 档是设计师对齐过像素的，Electron 读 ico 只挑最大那档（256）直接缩会糊；
  // 这里从 ico 目录里取对应档的 PNG 帧（make-icon.py 拼的五档都是 PNG 帧），取不到再兜底缩。
  const size = (screen.getPrimaryDisplay().scaleFactor || 1) >= 2 ? 32 : 16
  const raw = readFileSync(iconPath)
  for (let i = 0; i < raw.readUInt16LE(4); i++) {
    const at = 6 + i * 16 // 目录每档 16 字节：宽(+0，256 记 0)、数据大小(+8)、偏移(+12)
    if ((raw[at] || 256) !== size) continue
    const off = raw.readUInt32LE(at + 12)
    const len = raw.readUInt32LE(at + 8)
    if (raw[off] === 0x89 && raw[off + 1] === 0x50) return nativeImage.createFromBuffer(raw.subarray(off, off + len))
  }
  return nativeImage.createFromPath(iconPath).resize({ width: size, height: size })
}

function hideToTray() {
  pet.hide()
  log('menu', { item: '收到托盘' })
  const flag = join(app.getPath('userData'), 'pet-tray-hint')
  try { if (existsSync(flag)) return; writeFileSync(flag, '1') } catch { return }
  notify('收到托盘了。图标在任务栏「隐藏的图标」里，点 ^ 才看得到。')
}

function showMenu() {
  log('menu-open')
  const root = deskRoot(), all = join(root, '任务')
  const recent = recentMenuTemplate(
    recentList().map((dir) => ({ dir, name: basename(dir) })),
    recentTasks(root),
    existsSync(all) ? all : '',
    {
      openFolder: (dir) => { log('menu', { item: 'recent', dir }); taskOpened({ recent: dir }) },
      openTask: (out) => { log('menu', { item: 'recent-task', dir: out }); void shell.openPath(out) },
      openAll: (dir) => { log('menu', { item: 'all-tasks', dir }); void shell.openPath(dir) },
    },
  )
  Menu.buildFromTemplate(petMenuTemplate({
    recent,
    onTop: topper ? topper.onTop : true,
    onToggleOnTop: (value) => {
      log('menu', { item: '保持在最前', onTop: value })
      setTop(value)
    },
    onNewTask: () => { log('menu', { item: '新任务' }); taskOpened({ fresh: true }) },
    onSettings: () => { log('menu', { item: '设置' }); openSettings() },
    onTray: hideToTray,
    onQuit: () => app.quit(),
  })).popup({ window: pet })
}

// 托盘菜单「显示桌伴」：把小岛叫回最前
function trayShow() {
  const ok = recallIsland('tray-menu')
  log('tray', { item: '显示桌伴', recalled: ok })
}

// 托盘单击：跟「显示桌伴」一样，只管把小岛叫回来
function trayClick() {
  const ok = recallIsland('tray-click')
  log('tray', { item: 'click', recalled: ok })
}

function createTray() {
  tray = new Tray(trayIcon())
  tray.setToolTip('桌伴')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示桌伴', click: trayShow },
    { label: '退出', click: () => app.quit() },
  ]))
  tray.on('click', trayClick)
}

// 位置记住：下次启动还在那块屏的顶边
// display：那块屏的 id；displayBounds：那份 bounds，id 变了（拔了重插）还找得回来；x：相对那块屏工作区左边的偏移
function placeFile() {
  return join(app.getPath('userData'), 'pet-place.json')
}

function loadPlace() {
  return readPlace(placeFile())
}

function savePlace() {
  const display = homeDisplay(), work = display.workArea
  writePlace(placeFile(), {
    display: display.id,
    displayBounds: { ...display.bounds },
    x: (rest?.x ?? work.x) - work.x,
    onTop: topper ? topper.onTop : true,
  })
}

// 「保持在最前」的选择：跟位置记在同一个文件里
function saveTop(onTop) {
  const saved = loadPlace() || {}
  writePlace(placeFile(), { ...saved, onTop })
}

// 勾上/不勾：小岛自己改层级，任务窗跟着
function setTop(onTop) {
  if (!topper) return
  topper.set(onTop)
  setTaskTop(onTop)
}

// 再说一遍层级：别的置顶窗一被激活就会把小岛压下去
function refreshTop() {
  if (!topper) return
  // 叫回小岛时临时置顶着：这时别按用户勾的来，否则刚提到前面又被压回去
  if (tempTop) {
    if (pet && !pet.isDestroyed()) applyOnTop(pet, true)
    return
  }
  topper.apply()
}

// 把小岛叫回最前：
// 藏到托盘的、被别的窗盖住的、收成细线的，都叫得回来；不改用户勾的「保持在最前」，不抢焦点
function recallIsland(from) {
  if (!pet || pet.isDestroyed()) return false
  if (!recaller) return false
  const result = recaller.recall()
  log('recall', { from, ...result })
  return true
}

function createWindow() {
  const saved = loadPlace()
  topper = createOnTop({
    initial: onTopFromPlace(saved),
    persist: saveTop,
    getWindows: () => (pet && !pet.isDestroyed() ? [pet] : []),
  })
  const middle = process.env.SIDEMATE_PET_AT === 'center'
  // 存过就照存的放（哪块屏、那块屏顶边的哪个 x）；以前存过小球的一律当吸顶；那块屏不在了回主屏顶边正中
  const spot = middle ? null : restorePlace(saved, screen, theme.island)
  const work = middle ? screen.getPrimaryDisplay().workArea : spot.area
  const x = middle
    ? Math.round(work.x + (work.width - theme.island) / 2)
    : spot.x
  const y = middle ? Math.round(work.y + (work.height - theme.height) / 2) : work.y
  rest = { x, y, width: theme.island, height: theme.height }
  pet = new BrowserWindow({
    width: theme.island, height: theme.height, x, y,
    frame: false, transparent: true, resizable: false,
    maximizable: false, minimizable: false, fullscreenable: false, alwaysOnTop: topper.onTop,
    skipTaskbar: true, hasShadow: false, show: false, backgroundColor: '#00000000',
    webPreferences: { preload: join(dir, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  pet.loadFile(join(dir, 'pet.html'))
  // 建窗时只说了要不要置顶，层级在这儿补上
  refreshTop()
  pet.once('ready-to-show', () => { pet.showInactive(); refreshTop() })
  // 别的置顶窗一被激活，小岛就被压下去：窗口自己动的时候再说一遍层级
  pet.on('focus', refreshTop)
  pet.on('show', refreshTop)
  log('start', { bounds: pet.getBounds(), scene })
}

// 首次运行的小岛出场：
// 小岛放到顶边正中，从顶边上方 30px 滑到贴顶，320ms，出来曲线；
// 滑的时候眼睛往上看，落定眨一下换睁眼；停 0.3 秒冒一行「把一份范本和几份材料拖给我试试」；
// 停 6 秒或鼠标离开就收回。只放这一次。
export function playIntro() {
  if (!pet) return Promise.resolve()
  if (introBusy) return introBusy.promise
  const gen = ++introGen
  let resolve
  const promise = new Promise((done) => { resolve = done })
  introBusy = { promise, resolve, gen }
  clearIntroTimers()
  const still = stillMotion()
  const work = area()
  // 首次运行只有这一次：小岛放到顶边正中，不管用户之前把它挪到哪
  rest = { x: centerX(work, theme.island), y: work.y, width: theme.island, height: theme.height }
  scene = 'strip'
  introPhase = 'slide'
  send('pet:scene', { scene })
  const top = targetBounds()
  // 页面还没好就先等一下，别把出场动画丢了
  whenReady(gen, () => {
    // 兜底已经把那一行冒出来的话，就别再滑一次
    if (!introAlive(gen, introGen, introBusy)) return
    if (still) {
      // 关了「显示动画」：直接出现在贴顶、冒一行的那一帧
      pet.setBounds(top)
      introPhase = 'land'
      send('pet:intro', { phase: 'line', text: INTRO_LINE })
      return
    }
    // 从顶边上方 30px 滑到贴顶
    pet.setBounds({ ...top, y: top.y + introTiming.fromOffset })
    send('pet:intro', { phase: 'slide' })
    animateTo(top, introTiming.slideMs, easeOut)
    introTimers.push(setTimeout(() => {
      if (!introAlive(gen, introGen, introBusy)) return
      introPhase = 'land'
      send('pet:intro', { phase: 'land' })
      // 落定后停 0.3 秒再冒那一行
      introTimers.push(setTimeout(() => {
        if (!introAlive(gen, introGen, introBusy)) return
        send('pet:intro', { phase: 'line', text: INTRO_LINE })
      }, introTiming.pauseMs))
    }, introTiming.slideMs))
  })
  // 页面没回话也别把设置页吊着
  introTimers.push(setTimeout(() => showIntroLine(gen), introTiming.slideMs + introTiming.pauseMs + 2000))
  return promise
}

// 冒那一行：小岛张开，字最后 120ms 淡入。promise 到这就 resolve，不等 6 秒
function showIntroLine(gen, tries = 0) {
  if (!introAlive(gen, introGen, introBusy)) return
  // 正在接文件就先等着，别把接收托顶掉
  if (scene === 'tray' && tries < 40) {
    introTimers.push(setTimeout(() => showIntroLine(gen, tries + 1), 100))
    return
  }
  if (scene === 'strip') expand()
  introPhase = 'hold'
  finishIntro(gen)
  // 停 6 秒就收回；鼠标离开也收回（见 pet:leave）
  introTimers.push(setTimeout(() => {
    if (scene === 'expanded') collapse()
    introPhase = 'idle'
  }, introTiming.holdMs))
}

function whenReady(gen, cb) {
  if (rendererReady) { cb(); return }
  const timer = setTimeout(function poll() {
    if (!introAlive(gen, introGen, introBusy)) return
    if (!rendererReady) { introTimers.push(setTimeout(poll, 50)); return }
    cb()
  }, 50)
  introTimers.push(timer)
}

function clearIntroTimers() {
  for (const timer of introTimers) clearTimeout(timer)
  introTimers = []
}

function finishIntro(gen) {
  if (!introBusy || introBusy.gen !== gen) return
  const resolve = introBusy.resolve
  introBusy = null
  resolve()
}

function showDemo(name) {
  if (name === 'receive') return applyScene('tray')
  if (name === 'intro') return playIntro()
  if (name === 'line') return applyScene('line')
  const modes = { idle: 'idle', work: 'work', look: 'look', done: 'done', fail: 'fail' }
  const mode = modes[name]
  if (!mode) return
  state = { mode, taskId: null, message: mode === 'fail' ? 'DeepSeek 余额不够' : mode === 'look' ? '第三节要不要再短一点？' : '', artifact: '', notice: '' }
  // 干活中也要走秒（冒出来的是「正在工作 · x 秒」）
  syncClock()
  push()
  expand()
}

function startDemo() {
  const arg = process.argv.find((item) => item.startsWith('--pet='))
  const mode = arg ? arg.slice(6) : (process.env.SIDEMATE_PET || '')
  if (!mode) return
  if (mode !== 'demo') { showDemo(mode); return }
  const order = ['idle', 'work', 'look', 'done', 'fail']
  let index = 0
  const step = () => {
    showDemo(order[index++ % order.length])
    setTimeout(step, 1800)
  }
  setTimeout(step, 400)
}

// 全屏程序盖住顶边时收成一条细线
function startWatch() {
  if (process.env.SIDEMATE_PET_NO_FULLSCREEN === '1') return
  stopWatch = watchForeground((rect) => {
    if (!pet || dragging || introBusy) return
    let display
    try { display = screen.getDisplayNearestPoint({ x: rest.x, y: rest.y }) } catch { return }
    const covered = coversDisplay(rect, display.bounds)
    if (covered && scene !== 'line') {
      if (Date.now() < lineHoldUntil) return
      applyScene('line')
      log('line', { rect })
      return
    }
    if (!covered && scene === 'line') applyScene('strip')
  })
}

function bind() {
  ipcMain.handle('pet:ready', () => {
    rendererReady = true
    if (!demoArmed) { demoArmed = true; setTimeout(startDemo, 300) }
    const artifact = artifactName()
    return {
      still: stillMotion(),
      mode: state.mode,
      message: state.message,
      scene,
      bubble: bubbleOf({ mode: state.mode, message: state.message, artifact }),
    }
  })
  ipcMain.on('pet:hover', () => {
    if (introBusy) return
    if (scene === 'line') {
      // 细线被碰一下就变回来
      lineHoldUntil = Date.now() + 10000
      applyScene('strip')
      return
    }
    if (scene !== 'strip') return
    clearTimeout(leaveTimer)
    if (hoverTimer) return
    // 鼠标停 0.3 秒才冒一行
    hoverTimer = setTimeout(() => {
      hoverTimer = null
      if (onHover(scene, theme.hoverMs, theme.hoverMs).expand) expand()
    }, theme.hoverMs)
  })
  ipcMain.on('pet:leave', () => {
    clearTimeout(hoverTimer)
    hoverTimer = null
    clearTimeout(leaveTimer)
    leaveTimer = setTimeout(() => { leaveTimer = null; collapse() }, theme.leaveMs)
  })
  ipcMain.on('pet:measure', (_event, payload) => {
    // 页面量好那一行发过来的是一个数（早先发的是 { width }，两边对不上，条就一直没变宽）
    const raw = payload && typeof payload === 'object' ? payload.width : payload
    const width = Math.round(Number(raw))
    if (!Number.isFinite(width) || width === bubbleWidth) return
    bubbleWidth = width
    // 已经张开了就跟着改宽度，一改完字就放得下；别一边拉宽一边裁字
    if (scene === 'expanded') animateTo(targetBounds(), 0, easeOut)
  })
  ipcMain.on('pet:drag-start', () => {
    if (scene === 'tray' || introBusy) return
    dragging = true
    const point = screen.getCursorScreenPoint()
    // 拖动只有吸顶一种样子：张着的先收回小条再拖。
    // 收回时小条居中对着鼠标：别把在张开那块上按下的偏移（可能两三百 px）
    // 带给 112 宽的小条，不然小条一收就往左跳
    grab = dragGrab(scene, point, pet.getBounds(), theme.island)
    if (scene !== 'strip') {
      scene = 'strip'
      send('pet:scene', { scene })
    }
    clearInterval(dragTimer)
    dragTimer = setInterval(tickDrag, 16)
  })
  ipcMain.on('pet:drag-end', () => {
    if (!dragging) return
    dragging = false
    clearInterval(dragTimer)
    const point = screen.getCursorScreenPoint()
    const work = displayAt(screen, point).workArea
    const next = dragBounds(point, grab, { work, island: theme.island })
    scene = 'strip'
    rest = { ...rest, x: next.x, y: next.y }
    send('pet:scene', { scene })
    animateTo(targetBounds(), theme.collapseMs, easeIn)
    grab = null
    savePlace()
    log('drag-end', { bounds: pet.getBounds(), scene })
  })
  ipcMain.on('pet:drag-enter', () => {
    // 出场滑下来那一下别抢；滑完了拖文件照常接
    if (introPhase === 'slide') return
    const next = dropScene(scene)
    if (!next) return
    // 收成细线的时候也要张开接文件：不然从桌面拖过来落点只剩 64×4
    if (scene === 'line') {
      lineHoldUntil = Date.now() + 10000
      log('line-open', { scene })
    }
    applyScene(next)
  })
  ipcMain.on('pet:drag-leave', () => {
    clearTimeout(leaveTimer)
    leaveTimer = setTimeout(() => {
      leaveTimer = null
      if (scene === 'tray') applyScene('strip', { immediate: true })
    }, theme.leaveMs)
  })
  ipcMain.on('pet:drop', (_event, payload) => {
    clearTimeout(leaveTimer)
    const paths = Array.isArray(payload?.paths) ? payload.paths : []
    const bounds = pet.getBounds()
    const at = payload?.at || { x: 0, y: 0 }
    // 窗口可能正在张开（从细线变接收托），按比例算左右哪一块
    const ratio = bounds.width > 0 ? (at.x || 0) / bounds.width : 0.5
    const cell = ratio < 0.5 ? 'template' : 'materials'
    log('drop', { paths, cell, at, bounds })
    applyScene('strip')
    petDrop({ openTask, clearAsk: resetHeld, paths, cell })
  })
  // 点小岛：任务窗开着就收起来，收起不到半秒的别再弹出来
  ipcMain.on('pet:click', () => {
    const what = petClick({
      toggle: toggleTask,
      clearAsk: resetHeld,
      // 小岛被点那一下：缩到 0.96 再弹回（设计稿第三节②）
      press: () => pressIsland({ send, still: stillMotion, scale: theme.pressScale, downMs: theme.pressDownMs, backMs: theme.pressBackMs }),
    })
    log('click', { what })
  })
  ipcMain.on('pet:menu', showMenu)
  ipcMain.on('pet:action', (_event, payload) => {
    const id = payload?.id
    log('action', { id })
    if (id === 'open') {
      const path = latestOutput()
      if (path) { void shell.openPath(path); return }
      taskOpened()
      return
    }
    if (id === 'settings') openSettings()
  })
  // 页面量好那一行、准备好了：这时才把小岛张开
  ipcMain.on('pet:intro-line', () => {
    if (!introBusy) return
    showIntroLine(introBusy.gen)
  })
}

// 拖动：小岛只贴顶边，左右跟着鼠标走；鼠标在哪块屏就贴那块屏的顶边，拖多低都不离顶
function tickDrag() {
  if (!pet) return
  const point = screen.getCursorScreenPoint()
  const work = displayAt(screen, point).workArea
  const next = dragBounds(point, grab, { work, island: theme.island })
  rest = { ...rest, x: next.x, y: next.y }
  animateTo(targetBounds(), 0, easeOut)
}

export function startPet(options) {
  openTask = options.openTask
  if (typeof options.toggleTask === 'function') toggleTask = options.toggleTask
  openSettings = options.openSettings ?? (() => {})
  if (typeof options.recent === 'function') recentList = options.recent
  if (typeof options.setTaskTop === 'function') setTaskTop = options.setTaskTop
  if (typeof options.raiseTask === 'function') raiseTask = options.raiseTask
  logFile = process.env.SIDEMATE_PET_LOG || join(app.getPath('userData'), 'pet.log')
  bind()
  createWindow()
  // 叫回小岛的一摊
  recaller = createRecaller({
    getScene: () => scene,
    // 细线变回小条：走正常的场景切换，动画和层级都照旧
    setScene: (next) => applyScene(next),
    // 露脸但不抢焦点：用户正在打字的窗口不该失焦
    showWindow: () => { if (pet && !pet.isDestroyed()) pet.showInactive() },
    // 提到前面（也不抢焦点）
    raiseWindow: () => { try { pet.moveTop() } catch { /* 老版本没这个 API */ } },
    // 用户勾没勾「保持在最前」：只读，不改
    getOnTop: () => (topper ? topper.onTop : true),
    // 临时置顶只动窗上的层级，不动存着的勾选
    setWindowTop: (value) => {
      tempTop = !!value
      if (pet && !pet.isDestroyed()) applyOnTop(pet, value)
    },
    // 任务窗开着就跟着到前面
    showTask: () => raiseTask(),
  })
  // 任务窗跟着小岛：先把存着的选择给它
  setTaskTop(topper.onTop)
  createTray()
  startWatch()
  // 测试钩子：托盘那一套在没有真人的机器上也能驱动
  stopHook = startTestHook({
    'tray-click': trayClick,
    'tray-menu': trayShow,
    hide: () => hideToTray(),
    // 测试时把「保持在最前」关掉：走的是菜单那一项，存的值也跟着改
    'on-top-off': () => { setTop(false); log('test-hook', { action: 'on-top-off' }) },
    'on-top-on': () => { setTop(true); log('test-hook', { action: 'on-top-on' }) },
  })
  app.on('before-quit', () => {
    clearInterval(dragTimer)
    clearInterval(animTimer)
    clearInterval(workTimer)
    clearIntroTimers()
    stopWatch?.()
    stopHook?.()
    tray?.destroy()
    log('quit')
  })
  // 任务窗挂在小岛下面 8px 用：每次现算小岛收着时在屏幕上的位置
  const anchor = () => ({ x: rest?.x ?? 0, y: rest?.y ?? 0, width: theme.island, height: theme.height })
  // clearHeld：任务窗打开了，小岛那三种状态收回去，回待命
  // refreshTop：任务窗收起来了，小岛再说一遍层级
  return { ingest: apply, playIntro, getState: () => state, anchor, clearHeld: resetHeld, refreshTop }
}

// 任务窗的 Electron 这头：无边框的窗，挂在小岛正下方 8px，点外面就收回；
// 几个通道：ready / view / act / drop / size / link；选文件对话框、打开产出、前台判断、
// 最近的文件夹（recent.json）、task.log。状态和流水线在 ./run.mjs，这里只做桥。

import { app, BrowserWindow, dialog, ipcMain, screen, shell, systemPreferences } from 'electron'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentKey, openSettings } from '../byok/shell.mjs'
import { payloadLayout, runTask } from '../dsh/index.mjs'
import { iconPath } from '../assets/icon.mjs'
import { prepareFeed, reviewDocx, stripMarks, tidyDocx } from '../cite/index.mjs'
import { MATERIAL_EXTENSIONS, clearWorkspace, deliverOutput, deskRoot, finishTask, prepareTask, protectRuntime, snapshotWorkspace } from '../workspace/index.mjs'
import { createRunner } from './run.mjs'
import { applyOnTop } from '../pet/on-top.mjs'
import { RECALL_TOP_MS } from '../pet/recall.mjs'
import { createReloadGuard } from './reload-guard.mjs'
import { createCloseCycle } from './close.mjs'
import { createPicker } from './pick.mjs'
import { createToggler } from './toggle.mjs'
import { httpUrl } from './markdown.mjs'
import { GAP, MAX_H, MIN_H, WIDTH, taskWindowOptions } from './window.mjs'
import { ROLL_MS, createResizer } from './motion.mjs'

const dir = dirname(fileURLToPath(import.meta.url))

// 窗：宽 460，挂在小岛下面 8px，高跟着内容长，最高 640
// 拿不到小岛就当它在主屏顶边正中
const FALLBACK = { width: 112, height: 30 }

let runner = null
let win = null
let bound = false
let wasFore = false
let logFile = ''
let height = 320
// 页面报上来的高度：知道它才知道最终该多高，露脸前先按它摆好
let contentHeight = 320
let ready = false
let pendingOpen = false
let openFallback = null
let resizer = null
let anchorOf = null
let pendingAnim = ''
let onOpen = () => {}
let onTop = true
// 小岛叫回最前时，任务窗跟着到前面：临时置顶到头了再照勾的来
let raiseTimer = null
let raiseTop = false
// 任务窗收起来了：小岛该再说一遍层级
let onHidden = () => {}
const guard = createReloadGuard()

// 选文件的对话框：开着的时候任务窗会失焦，收窗前先问它一句
const picker = createPicker({
  showOpenDialog: (target, options) => dialog.showOpenDialog(target, options),
  focus: (target) => { if (target && !target.isDestroyed()) target.focus() },
})

// 失焦和小岛那一下都从这里收：180ms 往上收再藏起来；对话框开着就等一等。
// 收只有一段动画：两下挨着来也只放一段，不叠两段。
const cycle = createCloseCycle({
  getWin: () => win,
  bounds: () => boundsFor(contentHeight),
  // 收回动画放的这 180ms 里不重排：高度不跳
  send: (kind) => { if (kind === 'in' || !stillMotion()) sendAnim(kind) },
  gate: picker,
  delay: () => (stillMotion() ? 0 : ROLL_MS),
  onHidden: (why) => {
    log('hide', { why })
    // 任务窗收起来了：小岛再说一遍层级，别被别的置顶窗压住
    onHidden()
  },
  // 因失焦收起来的记一笔：紧跟着的那一下点击别再把窗弹出来
  onBlurred: () => toggler.blurred(),
})

// 收回：照收回动画往上收，收完活接着干
function hideWindow() {
  // 收起来了就别再等着露脸：迟到的「in」会把刚收的窗又撑开
  pendingOpen = false
  return cycle.close('toggle')
}

// 点小岛：开着就收，收起不到半秒的别再弹出来；关着照旧打开
const toggler = createToggler({
  isOpen: () => cycle.visible(),
  // 正在收的时候：同一下点接着收，再点一下从收起一半的地方接着展开
  closing: () => cycle.closing(),
  reason: () => cycle.reason(),
  open: () => open(),
  hide: () => hideWindow(),
})

function log(event, data = {}) {
  try { appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), event, ...data })}\n`) } catch { /* 日志坏了不能误事 */ }
}

function readRecent(file) {
  try {
    const list = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

// 窗在、看得见、没最小化、有焦点才算前台
function visible() {
  return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused()
}

function foreground() {
  const now = visible()
  if (now === wasFore) return
  wasFore = now
  runner?.feed({ type: 'window', foreground: now })
  // 任务窗到前台了：小岛那三种状态收回去，回待命
  if (now) onOpen()
}

function push(view) {
  if (win && !win.isDestroyed()) win.webContents.send('task:view', view)
}

// Windows 里关了动画就不动
function stillMotion() {
  try { return systemPreferences.getAnimationSettings().prefersReducedMotion === true } catch { return false }
}

// 小岛在哪儿：{x, y, width, height}；拿不到就退回主屏顶边正中
function anchorBox() {
  const box = typeof anchorOf === 'function' ? anchorOf() : null
  if (box && Number.isFinite(Number(box.x)) && Number.isFinite(Number(box.y))) {
    return { x: Number(box.x), y: Number(box.y), width: Number(box.width) || FALLBACK.width, height: Number(box.height) || FALLBACK.height }
  }
  const area = screen.getPrimaryDisplay().workArea
  return { x: Math.round(area.x + (area.width - FALLBACK.width) / 2), y: area.y, width: FALLBACK.width, height: FALLBACK.height }
}

// 挂在小岛正下方 8px，跟小岛水平居中；高度不够就贴着屏幕底
function boundsFor(next) {
  const box = anchorBox()
  const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
  const area = screen.getDisplayNearestPoint(point).workArea
  let x = Math.round(box.x + box.width / 2 - WIDTH / 2)
  x = Math.max(area.x, Math.min(x, area.x + area.width - WIDTH))
  const y = Math.round(box.y + box.height + GAP)
  const room = Math.max(MIN_H, area.y + area.height - y)
  const h = Math.max(MIN_H, Math.min(Math.round(next), MAX_H, room))
  height = h
  return { x, y, width: WIDTH, height: h }
}

// 高度变了：开着就用 120ms 过渡，不跳；收着的时候只记下高度，露脸前再摆
function place(next) {
  if (!win || win.isDestroyed()) return
  const bounds = boundsFor(next)
  if (!win.isVisible() || cycle.closing()) return
  resizer?.to(bounds)
}

function sendAnim(kind) {
  pendingAnim = kind
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
    win.webContents.send('task:anim', kind)
    pendingAnim = ''
  }
}

function createWindow() {
  win = new BrowserWindow({
    ...taskWindowOptions({ width: WIDTH, height, onTop, icon: iconPath }),
    webPreferences: { preload: join(dir, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  resizer = createResizer({ win })
  win.once('ready-to-show', () => { if (pendingAnim) sendAnim(pendingAnim) })
  // 别的置顶窗一被激活就会抢走层级：窗口自己动的时候再说一遍
  win.on('focus', () => applyOnTop(win, raiseTop || onTop))
  win.on('show', () => applyOnTop(win, raiseTop || onTop))
  for (const name of ['focus', 'blur', 'minimize', 'restore', 'show', 'hide', 'closed']) win.on(name, foreground)
  win.on('blur', () => { pendingOpen = false; cycle.close('blur') })
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('render-process-gone', (_event, details) => {
    const reason = details?.reason || 'unknown'
    const exitCode = details?.exitCode ?? null
    log('render-gone', { reason, exitCode })
    if (!win || win.isDestroyed() || reason === 'clean-exit') return
    const plan = guard.gone({ reason, exitCode })
    if (!plan.reload) {
      log('render-gave-up', { reason, exitCode, count: plan.count })
      return
    }
    log('render-reload', { reason, exitCode, count: plan.count })
    win.webContents.loadFile(join(dir, 'task.html'))
  })
  win.loadFile(join(dir, 'task.html'))
  applyOnTop(win, onTop)
}

// 露脸：先按最终高度摆好，再露脸；页面第一帧是收起状态，下一帧才垂下来
function showNow() {
  cycle.show()
  // 再说一遍层级：Windows 上别的置顶窗一激活就会抢走
  applyOnTop(win, onTop)
}

// 宠和托盘都从这里叫窗：没有就建，有就弄到前面；带 detail 就顺手喂事件
function open(detail) {
  toggler.opened()
  cycle.cancel()
  log('open', { detail: detail ? 1 : 0 })
  if (!win || win.isDestroyed()) createWindow()
  if (win.isMinimized()) win.restore()
  if (ready) {
    // 高度已经知道了：直接摆好露脸
    pendingOpen = false
    showNow()
  } else {
    // 页面还没报上来高度：先别露脸，等它报（免得先闪出一块，再跳一下）
    pendingOpen = true
  }
  if (detail) runner.opened(detail)
  // 小岛在等这个：任务窗开了，做完了、要你看一眼、没干成就收回去
  onOpen()
}

// ipcMain 只注册一次，只收任务窗自己 webContents 发来的
const mine = (event) => !!win && !win.isDestroyed() && event.sender === win.webContents

function bind() {
  if (bound) return
  bound = true
  ipcMain.handle('task:ready', (event) => {
    if (!mine(event)) return null
    const view = runner.view()
    log('ready', { phase: view.phase })
    if (pendingAnim) sendAnim(pendingAnim)
    // 页面还没报上来高度：兜底一秒多以后照旧露脸，别让窗一直不出现
    if (pendingOpen) {
      if (openFallback) clearTimeout(openFallback)
      openFallback = setTimeout(() => {
        openFallback = null
        if (!pendingOpen) return
        ready = true
        pendingOpen = false
        showNow()
      }, 1200)
    }
    return view
  })
  ipcMain.on('task:act', (event, action) => {
    if (!mine(event)) return
    // 「＋ 新任务」：run.mjs 里没有这个动作，壳自己喂状态
    if (action && action.type === 'new') { runner.feed({ type: 'new' }); return }
    runner.act(action)
  })
  ipcMain.on('task:drop', (event, payload) => { if (mine(event)) runner.drop(payload?.paths, payload?.cell) })
  ipcMain.on('task:size', (event, payload) => {
    if (!mine(event)) return
    const next = Number(payload?.height)
    if (!Number.isFinite(next) || next <= 0) return
    contentHeight = next
    ready = true
    if (openFallback) { clearTimeout(openFallback); openFallback = null }
    if (pendingOpen) {
      pendingOpen = false
      showNow()
      return
    }
    place(next)
  })
  // 回话里的链接：渲染进程已挑过一遍，这里再核一遍：new URL 解析得动、
  // 协议是 http(s)、不带空白和控制字符才开，开的是规范化后的 href
  ipcMain.on('task:link', (event, payload) => {
    if (!mine(event)) return
    const url = httpUrl(payload)
    if (url) void shell.openExternal(url)
  })
}

async function pickFiles(cell) {
  const chosen = await picker.pick(win, {
    title: '加文件',
    filters: [{ name: '文档', extensions: MATERIAL_EXTENSIONS.map((one) => one.slice(1)) }],
    properties: ['openFile', 'multiSelections'],
  })
  if (chosen && !chosen.canceled && chosen.filePaths.length) runner.drop(chosen.filePaths, cell)
}

function openPath(path, reveal) {
  if (reveal) return void shell.showItemInFolder(path)
  const root = deskRoot()
  for (const name of ['随手', '任务']) {
    if (path === join(root, name)) {
      try { mkdirSync(path, { recursive: true }) } catch { /* 建不了就交给打开 */ }
    }
  }
  void shell.openPath(path)
}

// 小岛被叫回最前时，任务窗跟着到前面
// 不抢焦点（用户正在打字的窗口不该失焦），也不改用户勾的「保持在最前」
function raiseFront() {
  if (!win || win.isDestroyed() || !win.isVisible()) return false
  try {
    win.showInactive()
    if (!onTop) {
      // 没勾「保持在最前」时它会被别的窗盖住：临时置顶一下，才提得到前面
      raiseTop = true
      applyOnTop(win, true)
      clearTimeout(raiseTimer)
      raiseTimer = setTimeout(() => { raiseTimer = null; raiseTop = false; applyOnTop(win, onTop) }, RECALL_TOP_MS)
    }
    win.moveTop()
  } catch {
    return false
  }
  return true
}

export function startTask(options = {}) {
  logFile = join(app.getPath('userData'), 'task.log')
  if (typeof options.onOpen === 'function') onOpen = options.onOpen
  if (typeof options.onHidden === 'function') onHidden = options.onHidden
  const layout = payloadLayout()
  const recentFile = join(app.getPath('userData'), 'recent.json')
  anchorOf = typeof options.anchor === 'function' ? options.anchor : null
  runner = createRunner({
    runTask, prepareTask, protectRuntime, prepareFeed, reviewDocx, tidyDocx, stripMarks, finishTask, deliverOutput, clearWorkspace, snapshotWorkspace,
    root: deskRoot, key: currentKey,
    extensions: MATERIAL_EXTENSIONS,
    recent: readRecent(recentFile),
    onRecent: (list) => { try { writeFileSync(recentFile, `${JSON.stringify(list, null, 2)}\n`) } catch { /* 存不下就只记内存 */ } },
    onPet: options.onPet,
    onView: push,
    openSettings,
    pickFiles,
    openPath,
    log,
    node: { source: layout.node, low: join(app.getPath('userData'), 'node-low', basename(layout.node)) },
  })
  bind()
  app.on('before-quit', () => { clearTimeout(raiseTimer); runner.quit() })
  log('boot')
  return {
    open,
    recent: () => runner.recent(),
    isOpen: () => cycle.isOpen(),
    toggle: () => toggler.toggle(),
    // 小岛的「保持在最顶」：任务窗跟着
    setOnTop: (value) => {
      onTop = !!value
      applyOnTop(win, onTop)
      return onTop
    },
    // 小岛叫回最前时，任务窗跟着到前面
    raise: raiseFront,
  }
}

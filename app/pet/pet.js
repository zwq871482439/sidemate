// 小岛这一页：墨色小条、一双眼睛、冒的那一行，还有接文件时的接收托。
// 界面纯 JavaScript，不用框架、不用打包器。

import { theme } from './theme.mjs'
import { bootPlan } from './intro.mjs'
import { endGesture, moveGesture, startGesture } from './gesture.mjs'
import { BLINK, SCAN, THINK, eyeOf } from './eyes.mjs'
import { layoutFor } from './layout.mjs'

const body = document.body
const strip = document.getElementById('strip')
const eyes = document.getElementById('eyes')
const bubbleText = document.getElementById('bubble-text')
const bubbleActions = document.getElementById('bubble-actions')
const measureBox = document.getElementById('measure')
const cells = [...document.querySelectorAll('.cell')]
const media = matchMedia('(prefers-reduced-motion: reduce)')

let scene = 'strip'
let mode = 'idle'
let forcedStill = false
let blinkTimer = null
let thinkTimer = null
let thinkHoldTimer = null
let gesture = null
let depth = 0
let introStarted = false
let introLineSet = false
let lastScene = 'strip'
// 冒的那一行有多宽（页面上量的自然宽度）
let lineWidth = 0

const still = () => forcedStill || media.matches

// 字号变了，小岛的高度、眼睛、表情区宽度、文字区边距都跟着变
function applyLayout(size = theme.font) {
  const box = layoutFor(size)
  const style = body.style
  style.setProperty('--font-size', `${box.font}px`)
  style.setProperty('--font-stack', theme.fontStack)
  style.setProperty('--island-w', `${box.island}px`)
  style.setProperty('--island-h', `${box.height}px`)
  style.setProperty('--eye-zone', `${box.eyeZone}px`)
  style.setProperty('--zone-gap', `${box.zoneGap}px`)
  style.setProperty('--pad-right', `${box.padRight}px`)
  style.setProperty('--text-pad', `${box.textPad}px`)
  style.setProperty('--dot-right', `${box.dotRight}px`)
  style.setProperty('--dot-top', `${box.dotTop}px`)
  style.setProperty('--dot-size', `${box.dotSize}px`)
  // SVG 里是用户单位，不随字号变
  style.setProperty('--eye-shift', `${box.eyeShift}`)
  style.setProperty('--scan', `${SCAN.px}`)
  style.setProperty('--scan-dur', `${SCAN.cycleMs}ms`)
  return box
}
applyLayout()

function applyScene(next) {
  scene = next
  body.dataset.scene = next
  if (next !== 'tray') for (const cell of cells) cell.classList.remove('hot')
  layoutLine()
}

function applyMode(next, options = {}) {
  mode = next
  body.dataset.mode = next
  if (!options.keepEyes) setEyes(eyeOf(next))
  eyes.style.setProperty('--eye-ms', `${next === 'look' ? theme.lookMs : theme.workMs}ms`)
  eyes.style.setProperty('--eye-curve', next === 'look' ? 'var(--curve-bounce)' : 'var(--curve-in)')
  stopThinking()
  scheduleBlink()
  scheduleThink()
}

// 换眼神：待命睁眼、干活往下看、要看一眼睁大、做完了笑眼、没干成一条平线
function setEyes(look) {
  for (const one of ['open', 'down', 'wide', 'smile', 'flat', 'up', 'closed']) eyes.classList.remove(`mode-${one}`)
  eyes.classList.add(`mode-${look}`)
}

// 待命时隔一阵眨一下：4–8 秒随机；干活中 3–5 秒随机一次
function scheduleBlink() {
  clearTimeout(blinkTimer)
  blinkTimer = null
  if (still()) return
  if (mode === 'idle') {
    const wait = theme.blinkMinMs + Math.random() * (theme.blinkMaxMs - theme.blinkMinMs)
    blinkTimer = setTimeout(() => { blink(); scheduleBlink() }, wait)
    return
  }
  if (mode === 'work') {
    const wait = BLINK.minMs + Math.random() * (BLINK.maxMs - BLINK.minMs)
    blinkTimer = setTimeout(() => { blink(); scheduleBlink() }, wait)
  }
}

// 干活中隔一阵抬头想一下：6–8 秒随机，圆眼往上 2px，停 0.6 秒再低头接着扫
function scheduleThink() {
  clearTimeout(thinkTimer)
  thinkTimer = null
  if (mode !== 'work' || still()) return
  const wait = THINK.minMs + Math.random() * (THINK.maxMs - THINK.minMs)
  thinkTimer = setTimeout(() => { think(); scheduleThink() }, wait)
}

function think() {
  if (mode !== 'work' || still()) return
  body.dataset.thinking = '1'
  clearTimeout(thinkHoldTimer)
  thinkHoldTimer = setTimeout(stopThinking, THINK.holdMs)
}

function stopThinking() {
  clearTimeout(thinkHoldTimer)
  thinkHoldTimer = null
  if (body.dataset.thinking) delete body.dataset.thinking
}

function blink() {
  if (still()) return
  eyes.style.setProperty('--eye-ms', `${BLINK.closeMs}ms`)
  eyes.classList.add('blink')
  setTimeout(() => {
    eyes.classList.remove('blink')
    eyes.style.setProperty('--eye-ms', `${BLINK.openMs}ms`)
  }, BLINK.closeMs)
}

function setBubble(line) {
  bubbleText.textContent = line?.text || ''
  bubbleActions.textContent = ''
  for (const action of line?.actions || []) {
    const button = document.createElement('button')
    button.className = 'action'
    button.type = 'button'
    button.textContent = action.label
    button.dataset.id = action.id
    button.addEventListener('pointerdown', (event) => event.stopPropagation())
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      pet.action(action.id)
    })
    bubbleActions.append(button)
  }
  measure()
}

// 量出那行字有多宽，壳照这个把条拉长
// 量的时候要把「字 + 空 + 能点的」整组一起量：
// 只量字会少 8px（空的那一组也算一个间距），窗口就窄 8px，
// 靠右排的字会往左溢出去，第一个字被裁掉
function measure() {
  measureBox.textContent = ''
  measureBox.append(bubbleText.cloneNode(true), bubbleActions.cloneNode(true))
  const width = measureBox.getBoundingClientRect().width
  lineWidth = width
  pet.measure(Math.ceil(width))
  layoutLine()
}

// 字放得下才露出来：
// 窗口从 112 长到够宽，中间那一下不露字，免得第一个字被裁掉半个；
// 顶到 460 还是放不下，字自己收成省略号。
function layoutLine() {
  if (scene !== 'expanded' || !lineWidth) { body.dataset.bubble = 'hidden'; return }
  const box = layoutFor(theme.font)
  // 文字区有多宽：字在区里居中，两边各留 8
  const room = body.clientWidth - box.eyeZone - box.zoneGap - box.padRight - box.textPad * 2
  if (room >= lineWidth - 0.5) { body.dataset.bubble = 'fit'; return }
  if (body.clientWidth >= box.bubbleHardMax - 0.5) { body.dataset.bubble = 'tight'; return }
  body.dataset.bubble = 'hidden'
}

function bindPointer() {
  strip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    try { strip.setPointerCapture(event.pointerId) } catch { /* 抓不住就算了 */ }
    // 先只记下起点：挪够 4px（DRAG_THRESHOLD_PX）才算拖，点一下不发 drag
    gesture = startGesture({ x: event.screenX, y: event.screenY })
  })
  document.addEventListener('pointermove', (event) => {
    if (!gesture) return
    const next = moveGesture(gesture, { x: event.screenX, y: event.screenY })
    if (next === gesture) return
    // 挪够了，这一下才算拖：这才开始收小条、跟鼠标走
    gesture = next
    pet.dragStart()
  })
  const release = (event) => {
    if (!gesture) return
    const what = endGesture(gesture, { x: event.screenX, y: event.screenY })
    gesture = null
    if (what === 'drag') pet.dragEnd()
    else pet.click()
  }
  document.addEventListener('pointerup', release)
  document.addEventListener('pointercancel', release)
  addEventListener('contextmenu', (event) => { event.preventDefault(); pet.menu() })
  document.addEventListener('mouseover', (event) => { if (!event.relatedTarget) pet.hover() })
  document.addEventListener('mouseout', (event) => { if (!event.relatedTarget) pet.leave() })
}

function bindDrop() {
  addEventListener('dragenter', (event) => {
    event.preventDefault()
    if (depth++ === 0) pet.dragEnter()
  })
  addEventListener('dragover', (event) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    const x = event.clientX
    for (const cell of cells) {
      const box = cell.getBoundingClientRect()
      cell.classList.toggle('hot', x >= box.left && x <= box.right)
    }
  })
  addEventListener('dragleave', () => { if (--depth === 0) pet.dragLeave() })
  addEventListener('drop', (event) => {
    event.preventDefault()
    depth = 0
    for (const cell of cells) cell.classList.remove('hot')
    pet.drop([...event.dataTransfer.files], { x: event.clientX, y: event.clientY })
  })
}

// 被点那一下：缩到 0.96 再弹回（设计稿第三节②）
function playPress(payload) {
  if (still()) return
  const scale = Number(payload?.scale) || 0.96
  const downMs = Number(payload?.downMs) || 80
  const backMs = Number(payload?.backMs) || 120
  strip.style.setProperty('--press-scale', String(scale))
  strip.classList.remove('press', 'press-back')
  void strip.offsetWidth
  strip.classList.add('press')
  setTimeout(() => {
    strip.classList.remove('press')
    strip.classList.add('press-back')
    setTimeout(() => strip.classList.remove('press-back'), backMs)
  }, downMs)
}

pet.onState((payload) => {
  applyMode(payload.mode || 'idle')
})
pet.onBubble((line) => setBubble(line))
pet.onScene((payload) => { lastScene = payload.scene || 'strip'; applyScene(lastScene) })
// 首次运行的小岛出场：壳说滑、说落定、说冒一行，这里只管眼睛和字
pet.onIntro((payload) => {
  introStarted = true
  const phase = payload?.phase || 'slide'
  if (phase === 'slide') { setEyes('up'); return }
  if (phase === 'land') { setEyes('open'); blink(); return }
  if (phase === 'line') {
    introLineSet = true
    setBubble({ text: payload.text || '', actions: [] })
    pet.introLine()
  }
})
pet.onPress((payload) => playPress(payload))

bindPointer()
bindDrop()
addEventListener('resize', layoutLine)
const boot = await pet.ready()
forcedStill = !!boot.still
if (forcedStill) body.classList.add('still')
// 场景和状态照开机那套来；眼神要是出场已经定过了就别盖回去
const plan = bootPlan({ introStarted, introLineSet, bootScene: boot.scene || 'strip', lastScene })
applyScene(plan.scene)
applyMode(boot.mode || 'idle', { keepEyes: plan.keepEyes })
// 出场已经冒过那一行了，就别拿开机那行盖回去
if (plan.setBubble) setBubble(boot.bubble || { text: '', actions: [] })

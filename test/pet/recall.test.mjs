// 托盘叫回小岛
// 点托盘图标、点托盘菜单「显示桌伴」：小岛一定回到最前、看得见。
// 三种叫不回来的情况：藏到托盘的、被别的窗盖住且没勾最前的、收成细线的。
// 叫的时候不改存着的「保持在最前」，也不抢焦点。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { RECALL_TOP_MS, createRecaller, recallScene } from '../../app/pet/recall.mjs'

const petShell = readFileSync(new URL('../../app/pet/shell.mjs', import.meta.url), 'utf8')

// 假的窗：只记调了什么
function fakeWindow() {
  const calls = []
  return {
    calls,
    visible: false,
    isDestroyed: () => false,
    isVisible() { return this.visible },
    showInactive() { this.visible = true; calls.push(['show']) },
    moveTop() { calls.push(['moveTop']) },
    setAlwaysOnTop: (...args) => calls.push(['setAlwaysOnTop', ...args]),
  }
}

// 假的一摊：场景、勾没勾最前、临时置顶
function harness({ scene = 'strip', onTop = true } = {}) {
  const win = fakeWindow()
  const scenes = []
  const tops = []
  const raised = []
  const tasks = []
  const timers = []
  let stored = onTop
  const recaller = createRecaller({
    getScene: () => scene,
    setScene: (next) => { scenes.push(next) },
    showWindow: () => win.showInactive(),
    raiseWindow: () => { win.moveTop(); raised.push(win.calls.length) },
    getOnTop: () => stored,
    setWindowTop: (value) => { tops.push(value); win.setAlwaysOnTop(value) },
    showTask: () => tasks.push('task'),
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t },
    clearTimer: (t) => { const at = timers.indexOf(t); if (at >= 0) timers.splice(at, 1) },
  })
  return {
    win, scenes, tops, raised, tasks, timers, recaller,
    get stored() { return stored },
    set stored(value) { stored = value },
  }
}

test('藏到托盘的小岛：叫回来就露脸，还提到前面', () => {
  const h = harness()
  h.win.visible = false
  const result = h.recaller.recall()
  assert.deepEqual(h.win.calls[0], ['show'], '没先露脸')
  assert.ok(h.win.calls.some((call) => call[0] === 'moveTop'), '没提到前面')
  assert.equal(result.scene, 'strip')
})

test('被别的窗盖住、没勾「保持在最前」：临时置顶一下提到前面，到时候照旧不置顶', () => {
  const h = harness({ onTop: false })
  h.recaller.recall()
  assert.deepEqual(h.tops, [true], '没临时置顶')
  assert.ok(h.win.calls.some((call) => call[0] === 'moveTop'), '没提到前面')
  // 临时置顶到头了：照用户勾的来（还是不勾）
  assert.equal(h.timers.length, 1)
  assert.equal(h.timers[0].ms, RECALL_TOP_MS)
  h.timers[0].fn()
  assert.deepEqual(h.tops, [true, false])
  // 存的勾选没被动过
  assert.equal(h.stored, false)
})

test('叫回来不改存着的「保持在最前」', () => {
  const h = harness({ onTop: false })
  h.recaller.recall()
  h.timers[0].fn()
  assert.equal(h.stored, false, '存的勾选被改了')
  const kept = harness({ onTop: true })
  kept.recaller.recall()
  assert.deepEqual(kept.tops, [], '勾着的时候不该动层级')
  assert.equal(kept.stored, true)
})

test('勾着「保持在最前」的小岛：叫回来直接提到前面，不临时置顶', () => {
  const h = harness({ onTop: true })
  const result = h.recaller.recall()
  assert.deepEqual(h.tops, [])
  assert.ok(h.win.calls.some((call) => call[0] === 'moveTop'))
  assert.equal(result.onTop, true)
})

test('收成细线的小岛：叫回来变回小条', () => {
  const h = harness({ scene: 'line' })
  const result = h.recaller.recall()
  assert.deepEqual(h.scenes, ['strip'])
  assert.equal(result.scene, 'strip')
  assert.equal(recallScene('line'), 'strip')
  assert.equal(recallScene('strip'), 'strip')
  assert.equal(recallScene('expanded'), 'expanded')
})

test('任务窗开着就跟着到前面', () => {
  const h = harness()
  h.recaller.recall()
  assert.deepEqual(h.tasks, ['task'])
})

test('叫回小岛不抢焦点：只 showInactive + moveTop，不调 focus', () => {
  const h = harness()
  h.recaller.recall()
  const methods = h.win.calls.map((call) => call[0])
  assert.ok(!methods.includes('focus'), '叫回小岛抢了焦点')
})

test('托盘单击和托盘菜单「显示桌伴」走的是同一个叫回小岛的入口', () => {
  // 托盘菜单「显示桌伴」
  assert.match(petShell, /label: '显示桌伴', click: trayShow/)
  // 托盘单击：以前是显示/隐藏来回切，现在跟「显示桌伴」一样只管叫回来
  assert.match(petShell, /tray\.on\('click', trayClick\)/)
  assert.match(petShell, /function trayShow\(\) \{\s*const ok = recallIsland\('tray-menu'\)/)
  assert.match(petShell, /function trayClick\(\) \{\s*const ok = recallIsland\('tray-click'\)/)
  // 不再是「显示/隐藏」来回切
  assert.doesNotMatch(petShell, /pet\.isVisible\(\)\) pet\.hide\(\)/)
})

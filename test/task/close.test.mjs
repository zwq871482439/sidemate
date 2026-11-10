// 收窗（假窗、假计时器）：收起只有一段往上的动画，收完才藏；
// 失焦和小岛那一下挨着来也只收一段；收起中途再点开，从收起一半的地方接着展开。

import assert from 'node:assert/strict'
import test from 'node:test'
import { createCloseCycle } from '../../app/task/close.mjs'
import { createToggler } from '../../app/task/toggle.mjs'
import { ROLL_MS } from '../../app/task/motion.mjs'

// 假时钟：setTimeout / setInterval 都记在这儿，advance(毫秒) 就往前拨
function clock() {
  let at = 0
  let seq = 0
  const jobs = new Map()
  const add = (fn, ms, every) => {
    seq += 1
    jobs.set(seq, { fn, at: at + ms, every })
    return seq
  }
  const timers = {
    setTimeout: (fn, ms) => add(fn, ms || 0, 0),
    clearTimeout: (handle) => jobs.delete(handle),
    setInterval: (fn, ms) => add(fn, ms || 0, Math.max(1, ms || 1)),
    clearInterval: (handle) => jobs.delete(handle),
  }
  const advance = (ms) => {
    const target = at + ms
    for (;;) {
      const due = [...jobs.entries()].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      const [handle, job] = due
      if (job.every) job.at = at + job.every
      else jobs.delete(handle)
      at = job.at
      job.fn()
    }
    at = target
  }
  return { timers, advance, now: () => at }
}

// 假窗：摆好、露脸、藏起来都记下来
function fakeWin() {
  const calls = []
  let visible = true
  return {
    calls,
    setBounds: (box) => calls.push(['setBounds', box]),
    show: () => { calls.push(['show']); visible = true },
    hide: () => { calls.push(['hide']); visible = false },
    focus: () => calls.push(['focus']),
    isVisible: () => visible,
    isDestroyed: () => false,
  }
}

// 窗、通道、计时器都是假的：只看次序和发了什么
function setup() {
  const { timers, advance } = clock()
  const win = fakeWin()
  const kinds = []
  const hidden = []
  const cycle = createCloseCycle({
    getWin: () => win,
    bounds: () => ({ x: 0, y: 0, width: 460, height: 320 }),
    send: (kind) => kinds.push(kind),
    timers,
    delay: ROLL_MS,
    onHidden: (why) => hidden.push(why),
  })
  const toggler = createToggler({
    isOpen: () => cycle.visible(),
    closing: () => cycle.closing(),
    reason: () => cycle.reason(),
    open: () => cycle.show(),
    hide: () => cycle.close('toggle'),
  })
  return { win, kinds, hidden, cycle, toggler, advance }
}

test('收起：只放一段往上的动画，动画放完才藏', () => {
  const { win, kinds, hidden, cycle, advance } = setup()
  cycle.close('blur')
  assert.deepEqual(kinds, ['out'], '没收的时候别发别的')
  advance(ROLL_MS - 1)
  assert.deepEqual(hidden, [], '动画没放完就藏起来了')
  advance(1)
  assert.deepEqual(hidden, ['blur'], '没说是失焦收的')
  assert.deepEqual(win.calls.map((one) => one[0]), ['hide'], '藏了不止一次')
})

test('失焦和小岛那一下挨着来：只放一段动画、只藏一次', () => {
  const { win, kinds, hidden, cycle, advance } = setup()
  cycle.close('blur')
  cycle.close('toggle')
  assert.deepEqual(kinds, ['out'], '放了两段动画')
  advance(ROLL_MS)
  assert.deepEqual(hidden, ['toggle'], '没说是点小岛收的')
  assert.deepEqual(win.calls.map((one) => one[0]), ['hide'], '藏了不止一次')
})

test('点小岛收起：只发 out，不发 in，窗也不变高', () => {
  const { win, kinds, cycle, toggler, advance } = setup()
  cycle.show()
  assert.deepEqual(kinds, ['in'], '露脸没发 in')
  const before = win.calls.length
  toggler.toggle()
  assert.deepEqual(kinds, ['in', 'out'], '收起时又发了一遍 in')
  assert.deepEqual(win.calls.slice(before).map((one) => one[0]), [], '收起时还动了窗')
  advance(ROLL_MS)
  assert.deepEqual(win.calls.map((one) => one[0]), ['setBounds', 'show', 'focus', 'hide'])
})

test('失焦收起：和小岛收起一样，只发一次 out', () => {
  const { win, kinds, cycle, advance } = setup()
  cycle.show()
  cycle.close('blur')
  assert.deepEqual(kinds, ['in', 'out'], '失焦收起多发了一遍')
  const before = win.calls.length
  advance(ROLL_MS)
  assert.deepEqual(win.calls.slice(before).map((one) => one[0]), ['hide'])
})

test('收起中途再点开：收起停掉，从收起一半的地方接着展开', () => {
  const { win, kinds, cycle, toggler, advance } = setup()
  cycle.show()
  toggler.toggle()
  advance(ROLL_MS / 2)
  assert.equal(cycle.closing(), true, '还没收完')
  toggler.toggle()
  assert.deepEqual(kinds, ['in', 'out', 'in'], '没有接着展开')
  advance(ROLL_MS * 2)
  assert.deepEqual(win.calls.filter((one) => one[0] === 'hide'), [], '窗又被藏了')
})

test('点一下小岛（先失焦、后点小岛）：接着收，不弹回来', () => {
  const { win, kinds, hidden, cycle, toggler, advance } = setup()
  cycle.show()
  cycle.close('blur') // 小岛抢到前面，任务窗先失焦
  toggler.toggle() // 这才是那一下点在小岛上的
  assert.deepEqual(kinds, ['in', 'out'], '又放了一段动画')
  advance(ROLL_MS)
  assert.deepEqual(hidden, ['toggle'], '没说是点小岛收的')
  assert.deepEqual(win.calls.map((one) => one[0]), ['setBounds', 'show', 'focus', 'hide'])
})

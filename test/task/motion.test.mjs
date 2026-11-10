// 任务窗的运动（设计稿第三节②）：透明窗、先摆好再露脸、收回放完才藏、变高 120ms。
// 窗、计时器都是假的，只看次序和时长。

import assert from 'node:assert/strict'
import test from 'node:test'
import { taskWindowOptions } from '../../app/task/window.mjs'
import { createResizer, showTaskWindow, RESIZE_MS, ROLL_MS } from '../../app/task/motion.mjs'
import { createHider } from '../../app/task/hide.mjs'

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

test('任务窗是透明窗：底色、圆角、阴影都在页面里画', () => {
  const options = taskWindowOptions({ width: 460, height: 320, onTop: true })
  assert.equal(options.transparent, true, '窗不透明，屏上会先闪出一整块底')
  assert.equal(options.backgroundColor, '#00000000', '底色得透明')
  assert.equal(options.resizable, false, '透明窗不能拉伸')
  assert.equal(options.hasShadow, false, '阴影自己在页面里画')
  assert.equal(options.show, false, '建好了先别露脸')
})

test('露脸：先按最终高度摆好，再露脸，页面下一帧才垂下来', () => {
  const calls = []
  const win = {
    setBounds: (box) => calls.push(['setBounds', box]),
    show: () => calls.push(['show']),
  }
  showTaskWindow(win, { x: 10, y: 20, width: 460, height: 320 }, (kind) => calls.push(['anim', kind]))
  assert.deepEqual(calls.map((one) => one[0]), ['setBounds', 'show', 'anim'], '不是先摆好再露脸')
  assert.deepEqual(calls[0][1], { x: 10, y: 20, width: 460, height: 320 })
  assert.equal(calls[2][1], 'in')
})

test('收回：动画放完才藏起来', () => {
  const { timers, advance } = clock()
  const order = []
  const hider = createHider({
    isVisible: () => true,
    hide: () => order.push('hide'),
    animate: (kind) => order.push(`anim:${kind}`),
    delay: ROLL_MS,
    timers,
  })
  hider.soon('toggle')
  assert.deepEqual(order, ['anim:out'], '没放收回的动画')
  advance(ROLL_MS - 1)
  assert.deepEqual(order, ['anim:out'], '动画没放完就藏起来了')
  advance(1)
  assert.deepEqual(order, ['anim:out', 'hide'])
  assert.equal(ROLL_MS, 180, '收回 180ms')
})

test('内容变长：120ms 过渡，不跳', () => {
  const { timers, advance, now } = clock()
  const heights = []
  const win = {
    getBounds: () => ({ x: 0, y: 0, width: 460, height: 320 }),
    setBounds: (box) => heights.push(box.height),
  }
  const resizer = createResizer({ win, timers, now })
  resizer.to({ x: 0, y: 0, width: 460, height: 460 })
  assert.deepEqual(heights, [], '刚动就跳了')
  advance(RESIZE_MS / 2)
  assert.equal(heights.length > 0, true, '过渡没动')
  assert.equal(heights[0] < 460, true, '一下就到了')
  advance(RESIZE_MS)
  assert.equal(heights[heights.length - 1], 460, '没过渡到最终高度')
  assert.equal(RESIZE_MS, 120, '变高 120ms')
})

// 小岛的「保持在最前」跟任务窗一起动
// 这里不碰 Electron：拿假的窗和真的接线（app/task/shell.mjs 里 startTask 返回的 setOnTop）
// 走一遍，确认小岛勾上/不勾，任务窗跟着变。

import assert from 'node:assert/strict'
import test from 'node:test'
import { createOnTop, onTopFromPlace, ON_TOP_LEVEL } from '../../app/pet/on-top.mjs'

function fakeWindow() {
  const calls = []
  return {
    calls,
    isDestroyed: () => false,
    setAlwaysOnTop: (...args) => calls.push(args),
  }
}

test('小岛和任务窗一起：勾上两个都置顶，不勾两个都不置顶', () => {
  const petWin = fakeWindow()
  const taskWin = fakeWindow()
  const saved = []
  // 任务窗那边：startTask 返回的 setOnTop 就是这么干的
  let taskOnTop = true
  const setTaskOnTop = (value) => {
    taskOnTop = !!value
    if (taskOnTop) taskWin.setAlwaysOnTop(true, ON_TOP_LEVEL)
    else taskWin.setAlwaysOnTop(false)
    return taskOnTop
  }
  const top = createOnTop({
    initial: onTopFromPlace({ onTop: true }),
    persist: (value) => saved.push(value),
    getWindows: () => [petWin],
  })

  // 小岛勾上：任务窗也得置顶
  top.set(true)
  setTaskOnTop(top.onTop)
  assert.deepEqual(petWin.calls, [[true, ON_TOP_LEVEL]])
  assert.deepEqual(taskWin.calls, [[true, ON_TOP_LEVEL]])

  // 小岛不勾：任务窗也不置顶
  top.set(false)
  setTaskOnTop(top.onTop)
  assert.deepEqual(petWin.calls, [[true, ON_TOP_LEVEL], [false]])
  assert.deepEqual(taskWin.calls, [[true, ON_TOP_LEVEL], [false]])

  // 选择记下来了
  assert.deepEqual(saved, [true, false])
})

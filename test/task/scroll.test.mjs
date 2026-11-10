// 滚动该往哪去：
// - 发完消息、来了新回答，都滚到底
// - 用户自己往上翻着看的时候，来了新内容不硬拽（离底超过 80px 就不动）
// 纯函数，好测；页面那边照着这个决定做。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { GAP, scrollDecision } from '../../app/task/scroll.mjs'
import { elapsedText } from '../../app/task/timing.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, '../../app/task/task.js'), 'utf8')

test('离底不远：滚到底', () => {
  assert.equal(scrollDecision({ distance: 0 }), 'bottom')
  assert.equal(scrollDecision({ distance: 10 }), 'bottom')
  assert.equal(scrollDecision({ distance: GAP }), 'bottom')
  assert.equal(scrollDecision({}), 'bottom')
})

test('用户往上翻着看：不硬拽', () => {
  assert.equal(scrollDecision({ distance: GAP + 1 }), 'keep')
  assert.equal(scrollDecision({ distance: 400 }), 'keep')
})

test('发完消息：一定滚到底', () => {
  assert.equal(scrollDecision({ distance: 400, force: true }), 'bottom')
  assert.equal(scrollDecision({ distance: 0, force: true }), 'bottom')
})

test('秒数：小岛和任务窗一个写法', () => {
  assert.equal(elapsedText(0), '0 秒')
  assert.equal(elapsedText(14000), '14 秒')
  assert.equal(elapsedText(20000), '20 秒')
  assert.equal(elapsedText(80000), '1 分 20 秒')
  assert.equal(elapsedText(94000), '1 分 34 秒')
})

test('回车发消息不跳顶：量高度时把滚动位置放回去，发完一定到底', () => {
  // 量对话流高度时临时把高度放开，滚动位置会被压回 0；量完要放回去
  assert.match(page, /function flowHeight\(\)[\s\S]*?const top = els\.flow\.scrollTop[\s\S]*?els\.flow\.scrollTop = top/)
  // 发完消息滚到底
  assert.match(page, /forceBottom = true[^\n]*\n[^\n]*act\(\{ type: 'send', text \}\)/)
  // 来了新内容按离底多远决定
  assert.match(page, /scrollDecision\(\{ distance, force: forceBottom \}\)/)
})

// 小岛上的两种手势：点一下、拖文件进来。
// 点一下走开关：任务窗开着就收，收起不到半秒的别再弹出来；
// 拖文件照旧打开任务窗，把文件带进去。

import assert from 'node:assert/strict'
import test from 'node:test'
import { petClick, petDrop } from '../../app/pet/click.mjs'

test('点小岛：任务窗开着就收，「等你一句话」不动', () => {
  const calls = []
  const what = petClick({
    toggle: () => { calls.push('toggle'); return 'closed' },
    clearAsk: () => calls.push('clearAsk'),
  })
  assert.equal(what, 'closed')
  assert.deepEqual(calls, ['toggle'], '收窗的时候把「等你一句话」也收了')
})

test('点小岛：任务窗关着就开，「等你一句话」照旧收回去', () => {
  const calls = []
  const what = petClick({
    toggle: () => { calls.push('toggle'); return 'opened' },
    clearAsk: () => calls.push('clearAsk'),
  })
  assert.equal(what, 'opened')
  assert.deepEqual(calls, ['toggle', 'clearAsk'])
})

test('拖文件到小岛：照旧打开任务窗，文件带进去', () => {
  const calls = []
  const ok = petDrop({
    openTask: (detail) => calls.push(['open', detail]),
    clearAsk: () => calls.push(['clearAsk']),
    paths: ['C:/材料/周报.docx'],
    cell: 'materials',
  })
  assert.equal(ok, true)
  assert.deepEqual(calls, [['open', { paths: ['C:/材料/周报.docx'], cell: 'materials' }], ['clearAsk']])
})

test('没拖到文件：不打开任务窗', () => {
  const calls = []
  const ok = petDrop({
    openTask: (detail) => calls.push(['open', detail]),
    clearAsk: () => calls.push(['clearAsk']),
    paths: [],
    cell: 'materials',
  })
  assert.equal(ok, false)
  assert.deepEqual(calls, [])
})

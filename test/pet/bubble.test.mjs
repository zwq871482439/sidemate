import assert from 'node:assert/strict'
import test from 'node:test'
import { bubbleOf, elapsedText } from '../../app/pet/bubble.mjs'

test('待命：一句提示，没有能点的', () => {
  const line = bubbleOf({ mode: 'idle' })
  assert.equal(line.text, '点一下开新任务，文件也能拖到这儿')
  assert.deepEqual(line.actions, [])
})

test('干活中：只说正在工作，不冒过程话', () => {
  assert.equal(bubbleOf({ mode: 'work', message: '在看材料 2/5' }).text, '正在工作')
  assert.equal(bubbleOf({ mode: 'work' }).text, '正在工作')
  assert.equal(bubbleOf({ mode: 'work', message: '写《综述》' }).text, '正在工作')
})

test('干活中：后面跟一句跑了多久', () => {
  assert.equal(bubbleOf({ mode: 'work', message: '看材料 2/5', elapsed: '1 分 20 秒' }).text, '正在工作 · 1 分 20 秒')
  assert.equal(elapsedText(0), '0 秒')
  assert.equal(elapsedText(20000), '20 秒')
  assert.equal(elapsedText(80000), '1 分 20 秒')
})

test('要你看一眼：等你一句话', () => {
  assert.equal(bubbleOf({ mode: 'look', message: '第三节要不要再短一点？' }).text, '等你一句话：第三节要不要再短一点？')
})

test('做完了：写通用的「做完了 · 点开看看」，有产出才带「打开」', () => {
  const line = bubbleOf({ mode: 'done', artifact: '综述.docx' })
  assert.equal(line.text, '做完了 · 点开看看')
  assert.deepEqual(line.actions, [{ id: 'open', label: '打开' }])
  // 没有产出文件：字还是那一句，「打开」不显示
  const bare = bubbleOf({ mode: 'done' })
  assert.equal(bare.text, '做完了 · 点开看看')
  assert.deepEqual(bare.actions, [])
})

test('没干成：写明原因，后面「去设置」能点', () => {
  const line = bubbleOf({ mode: 'fail', message: 'DeepSeek 余额不够' })
  assert.equal(line.text, '没干成：DeepSeek 余额不够')
  assert.deepEqual(line.actions, [{ id: 'settings', label: '去设置' }])
})

test('做完了不去设置：只有「打开」', () => {
  const line = bubbleOf({ mode: 'done', artifact: '综述.docx' })
  assert.equal(line.text, '做完了 · 点开看看')
  assert.deepEqual(line.actions.map((one) => one.id), ['open'])
  assert.equal(line.actions.some((one) => one.id === 'settings'), false)
})

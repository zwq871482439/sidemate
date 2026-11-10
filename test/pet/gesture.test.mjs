// 按下 → 移动 → 松手：挪够 4px 才算拖，没挪够松手是点击。
// 点一下绝不挪位置：dragStart 只在挪够阈值那一刻才发，
// 壳里的 rest、pet-place.json 只有真拖过（drag-start → drag-end）才动。
// 手势本身不分成张开还是收着：小岛张着点右半边、收着点小条，走的都是这一套。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DRAG_THRESHOLD_PX, endGesture, moveGesture, startGesture } from '../../app/pet/gesture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, '../../app/pet/pet.js'), 'utf8')
const shellSource = readFileSync(join(here, '../../app/pet/shell.mjs'), 'utf8')
const count = (source, pattern) => [...source.matchAll(pattern)].length

test('阈值 4px 是一个常量：pet.js 和测试共用，页面里不再自己写 4', () => {
  assert.equal(DRAG_THRESHOLD_PX, 4)
  assert.match(page, /import \{[^}]*startGesture[^}]*\} from '\.\/gesture\.mjs'/)
  assert.doesNotMatch(page, /moved < 4/)
})

test('挪 3px 松手是点击，挪 5px 是拖', () => {
  let slight = startGesture({ x: 100, y: 100 })
  slight = moveGesture(slight, { x: 103, y: 100 })
  assert.equal(slight.dragging, false, '3px 还不算拖')
  assert.equal(endGesture(slight, { x: 103, y: 100 }), 'click')

  let enough = startGesture({ x: 100, y: 100 })
  enough = moveGesture(enough, { x: 105, y: 100 })
  assert.equal(enough.dragging, true, '5px 就算拖')
  assert.equal(endGesture(enough, { x: 105, y: 100 }), 'drag')
})

test('按住不动松手是点击：张开着点一下、收着点一下都不挪位置', () => {
  const held = startGesture({ x: 400, y: 20 })
  assert.equal(endGesture(held, { x: 400, y: 20 }), 'click')
  const heldStill = moveGesture(held, { x: 401, y: 21 })
  assert.equal(heldStill, held, '没挪够时 moveGesture 原样返回，不发 dragStart')
})

test('挪够又挪回起点：还是拖（dragStart 已经发过了）', () => {
  let back = startGesture({ x: 100, y: 100 })
  back = moveGesture(back, { x: 108, y: 100 })
  assert.equal(back.dragging, true)
  back = moveGesture(back, { x: 100, y: 100 })
  assert.equal(back.dragging, true, '算过拖就一直算拖')
  assert.equal(endGesture(back, { x: 100, y: 100 }), 'drag')
})

test('斜着挪按直线距离算：斜 2×2 不算，斜 3×3 算', () => {
  let slight = startGesture({ x: 100, y: 100 })
  slight = moveGesture(slight, { x: 102, y: 102 })
  assert.equal(slight.dragging, false, '√8 ≈ 2.83 < 4')
  let enough = startGesture({ x: 100, y: 100 })
  enough = moveGesture(enough, { x: 103, y: 103 })
  assert.equal(enough.dragging, true, '√18 ≈ 4.24 ≥ 4')
})

test('没按下过：moveGesture 不接，endGesture 是 none', () => {
  assert.equal(moveGesture(null, { x: 0, y: 0 }), null)
  assert.equal(endGesture(null, { x: 0, y: 0 }), 'none')
})

test('pet.js 的接法：按下只记起点，dragStart 只从挪够阈值那条路发，松手只发其中一种', () => {
  assert.equal(count(page, /pet\.dragStart\(\)/g), 1, 'dragStart 只发一处')
  assert.equal(count(page, /pet\.dragEnd\(\)/g), 1)
  assert.equal(count(page, /pet\.click\(\)/g), 1)
  const down = page.slice(page.indexOf("strip.addEventListener('pointerdown'"), page.indexOf("document.addEventListener('pointermove'"))
  assert.ok(down.includes('startGesture('), '按下只记起点')
  assert.ok(!down.includes('pet.dragStart()'), '按下那一下不发 dragStart（点一下绝不挪位置）')
  const move = page.slice(page.indexOf("document.addEventListener('pointermove'"), page.indexOf('const release'))
  assert.ok(move.includes('moveGesture(') && move.includes('pet.dragStart()'), '挪够阈值才发 dragStart')
  const release = page.slice(page.indexOf('const release'), page.indexOf("document.addEventListener('pointerup'"))
  assert.ok(release.includes('endGesture('), '松手按 endGesture 说了算')
  assert.match(release, /if \(what === 'drag'\) pet\.dragEnd\(\)\s*\n\s*else pet\.click\(\)/, '拖了才 dragEnd，没拖够只 click')
})

test('壳的接法：只有真拖过才动位置、才写 pet-place.json，点击那一摊不碰', () => {
  // 存位置（pet-place.json）只在 drag-end 一处
  assert.equal(count(shellSource, /(?<!function )savePlace\(\)/g), 1)
  const dragEnd = shellSource.slice(shellSource.indexOf("'pet:drag-end'"), shellSource.indexOf("'pet:drag-enter'"))
  assert.ok(dragEnd.includes('savePlace()'), '存位置就在 drag-end 里')
  assert.match(dragEnd, /if \(!dragging\) return/, '没拖过（dragging 没立起来）就不收位置')
  // 点一下（pet:click）不碰位置、不碰拖动
  const click = shellSource.slice(shellSource.indexOf("'pet:click'"), shellSource.indexOf("'pet:menu'"))
  assert.ok(!/rest\s*=/.test(click), 'pet:click 不改 rest')
  assert.ok(!click.includes('savePlace'), 'pet:click 不写 pet-place.json')
  assert.ok(!click.includes('dragging'), 'pet:click 不碰拖动')
  // drag-start 只立 dragging、算抓的偏移；rest 只在拖动里改
  const dragStart = shellSource.slice(shellSource.indexOf("'pet:drag-start'"), shellSource.indexOf("'pet:drag-end'"))
  assert.ok(!/rest\s*=/.test(dragStart), 'drag-start 不改 rest')
})

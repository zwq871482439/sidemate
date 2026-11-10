import assert from 'node:assert/strict'
import test from 'node:test'
import { centerX, clampX, contains, displayAt, dragBounds, dragGrab, dropScene, expandedBounds, restorePlace, topStrip } from '../../app/pet/place.mjs'

const area = { x: 10, y: 20, width: 1200, height: 800 }

// 假 screen：两块屏左右排，右边那块矮一截、顶边低 200
const main = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
}
const second = {
  id: 2,
  bounds: { x: 1920, y: 200, width: 1280, height: 800 },
  workArea: { x: 1920, y: 200, width: 1280, height: 760 },
}
const fakeScreen = {
  getDisplayNearestPoint: (point) => (point.x >= 1920 ? second : main),
  getPrimaryDisplay: () => main,
  getAllDisplays: () => [main, second],
}

test('小条贴在顶边，左右挪不出屏幕', () => {
  assert.deepEqual(topStrip(400, area, 112, 30), { x: 400, y: 20, width: 112, height: 30 })
  assert.equal(clampX(400, area, 112), 400)
  assert.equal(clampX(-50, area, 112), 10)
  assert.equal(clampX(5000, area, 112), 10 + 1200 - 112)
})

test('冒一行时中心不动：左右各长出去，也不出屏幕', () => {
  const rest = { x: 400, y: 20, width: 112, height: 30 }
  const wide = expandedBounds(rest, 276, area)
  assert.equal(wide.width, 276)
  assert.equal(wide.height, 30)
  assert.equal(wide.y, 20)
  assert.equal(wide.x + wide.width / 2, rest.x + rest.width / 2)
  assert.ok(contains(area, wide), JSON.stringify(wide))
  const atLeft = expandedBounds({ x: 10, y: 20, width: 112, height: 30 }, 303, area)
  assert.ok(contains(area, atLeft), JSON.stringify(atLeft))
})

test('只能吸顶：往下拖很远也留在顶边，只是左右跟着鼠标走', () => {
  const grab = { x: 20, y: 10 }
  const at = dragBounds({ x: 300, y: 200 }, grab, { work: area, island: 112 })
  assert.equal(at.y, area.y)
  assert.equal(at.x, 280)
  // 拖到屏幕中间、拖出屏幕底下，都还在顶边
  const mid = dragBounds({ x: 400, y: 420 }, grab, { work: area, island: 112 })
  assert.equal(mid.y, area.y)
  const wayDown = dragBounds({ x: 400, y: 5000 }, grab, { work: area, island: 112 })
  assert.equal(wayDown.y, area.y)
  assert.equal(wayDown.x, 380)
})

test('贴顶时小条不出屏幕，抓哪儿还是哪儿', () => {
  const grab = { x: 20, y: 10 }
  assert.equal(dragBounds({ x: -100, y: area.y }, grab, { work: area, island: 112 }).x, area.x)
  assert.equal(dragBounds({ x: 5000, y: area.y }, grab, { work: area, island: 112 }).x, area.x + area.width - 112)
  // 按下时抓的偏移拿不到（比如别处直接调）：小岛居中对着鼠标
  assert.equal(dragBounds({ x: 300, y: 900 }, null, { work: area, island: 112 }).x, 300 - 56)
})

test('拖到另一块屏就贴那块屏的顶边', () => {
  // 鼠标在右边那块屏上，比那块屏的顶边低得多：小岛还是贴那块屏的顶边（y=200），不跟鼠标下去
  const point = { x: 2200, y: 900 }
  const work = displayAt(fakeScreen, point).workArea
  assert.equal(work.y, 200)
  const at = dragBounds(point, { x: 20, y: 10 }, { work, island: 112 })
  assert.equal(at.y, 200)
  assert.equal(at.x, 2180)
  assert.ok(at.x >= work.x && at.x <= work.x + work.width - 112)
  // 拖回左边那块屏，y 跟着回 0
  const back = dragBounds({ x: 300, y: 900 }, { x: 20, y: 10 }, { work: displayAt(fakeScreen, { x: 300, y: 900 }).workArea, island: 112 })
  assert.equal(back.y, 0)
})

test('从张开的样子开始拖：收回的小条居中对着鼠标，不往左跳', () => {
  // 小条 112 宽，冒一行长到 276：左右各长出去，中心不动；鼠标点在张开的右半边
  const rest = { x: 500, y: 20, width: 112, height: 30 }
  const wide = expandedBounds(rest, 276, area)
  const point = { x: wide.x + 220, y: 30 }
  const grab = dragGrab('expanded', point, wide, 112)
  assert.equal(grab.x, 112 / 2, '张开的偏移不带进小条：抓的是半条宽')
  const at = dragBounds(point, grab, { work: area, island: 112 })
  assert.equal(at.x, point.x - 56, '小条居中对着鼠标')
  // 以前拿张开那块的偏移（220）：小条会被放到鼠标左边 220，往左跳 164
  assert.equal(at.x - (point.x - 220), 164, '比旧账右了 164，不再往左跳')
})

test('从收着的小条开始拖：照旧保留按下时的偏移，抓哪儿还是哪儿', () => {
  const bounds = { x: 500, y: 20, width: 112, height: 30 }
  const point = { x: 520, y: 25 }
  assert.deepEqual(dragGrab('strip', point, bounds, 112), { x: 20, y: 5 })
  assert.equal(dragBounds(point, dragGrab('strip', point, bounds, 112), { work: area, island: 112 }).x, 500)
})

test('从细线开始拖也居中对着鼠标', () => {
  const line = { x: 524, y: 20, width: 64, height: 4 }
  const point = { x: 560, y: 22 }
  assert.equal(dragGrab('line', point, line, 112).x, 56)
})

test('拖着文件碰到小岛就张开接文件；收成细线时也一样', () => {
  assert.equal(dropScene('strip'), 'tray')
  assert.equal(dropScene('line'), 'tray')
  assert.equal(dropScene('expanded'), null)
  assert.equal(dropScene('tray'), null)
})

test('存了在哪块屏和相对那块屏的 x：读回来还在那块屏的顶边', () => {
  const saved = { display: 2, displayBounds: { x: 1920, y: 200, width: 1280, height: 800 }, x: 300, onTop: true }
  const back = restorePlace(saved, fakeScreen, 112)
  assert.equal(back.area.y, 200)
  assert.equal(back.x, 1920 + 300)
  // 存的 x 出了屏（比如那块屏换小了）：夹回来
  const moved = restorePlace({ ...saved, x: 5000 }, fakeScreen, 112)
  assert.equal(moved.x, 1920 + 1280 - 112)
})

test('存的那块屏不在了就回主屏顶边正中', () => {
  const saved = { display: 9, displayBounds: { x: -1920, y: 0, width: 1920, height: 1080 }, x: 300 }
  const back = restorePlace(saved, fakeScreen, 112)
  assert.equal(back.area.y, main.workArea.y)
  assert.equal(back.x, centerX(main.workArea, 112))
})

test('id 变了但那块屏还在（bounds 对得上）就还照存的放', () => {
  const saved = { display: 77, displayBounds: { x: 1920, y: 200, width: 1280, height: 800 }, x: 300 }
  const back = restorePlace(saved, fakeScreen, 112)
  assert.equal(back.area.y, 200)
  assert.equal(back.x, 1920 + 300)
})

test('以前存过小球的一律当吸顶：贴在球那块屏的顶边，x 用球心减半个小岛', () => {
  const ball = restorePlace({ x: 0, y: 0, scene: 'ball', ball: { x: 2200, y: 600 }, onTop: true }, fakeScreen, 112)
  assert.equal(ball.area.y, 200)
  assert.equal(ball.x, 2200 - 56)
  // 球在左边那块屏：贴左边那块屏的顶边
  const left = restorePlace({ scene: 'ball', ball: { x: 100, y: 300 } }, fakeScreen, 112)
  assert.equal(left.area.y, 0)
  assert.equal(left.x, 100 - 56)
  // 球在屏外：夹进屏内
  const edge = restorePlace({ scene: 'ball', ball: { x: 5000, y: 600 } }, fakeScreen, 112)
  assert.equal(edge.x, 1920 + 1280 - 112)
  // scene 不是 ball 但带球心（0.2 存过 ball 字段）：也一样迁
  const stray = restorePlace({ scene: 'strip', ball: { x: 100, y: 300 } }, fakeScreen, 112)
  assert.equal(stray.x, 100 - 56)
})

test('旧格式只存了绝对 x/y：那块屏还在就照旧的放，吸到那块屏的顶边', () => {
  const back = restorePlace({ x: 2200, y: 200, scene: 'strip', ball: null }, fakeScreen, 112)
  assert.equal(back.area.y, 200)
  assert.equal(back.x, 2200)
})

test('没存过就放主屏顶边正中', () => {
  const back = restorePlace(null, fakeScreen, 112)
  assert.equal(back.area.y, main.workArea.y)
  assert.equal(back.x, centerX(main.workArea, 112))
  const broken = restorePlace({ hello: true }, fakeScreen, 112)
  assert.equal(broken.x, centerX(main.workArea, 112))
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { coversDisplay, isDesktopClass, parseRect } from '../../app/pet/foreground.mjs'

test('前台窗口的矩形认得出', () => {
  assert.deepEqual(parseRect('0,0,1920,1080'), { x: 0, y: 0, width: 1920, height: 1080, className: '' })
  assert.deepEqual(parseRect(' 10,20,110,70 '), { x: 10, y: 20, width: 100, height: 50, className: '' })
  assert.deepEqual(parseRect('0,0,1920,1080,Windows.UI.Core.CoreWindow'), {
    x: 0, y: 0, width: 1920, height: 1080, className: 'Windows.UI.Core.CoreWindow',
  })
  assert.equal(parseRect('不是矩形'), null)
  assert.equal(parseRect(''), null)
})

test('全屏程序盖住整块屏才算盖住，最大化的不算', () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 }
  assert.equal(coversDisplay({ x: 0, y: 0, width: 1920, height: 1080 }, display), true)
  assert.equal(coversDisplay({ x: 0, y: 0, width: 1920, height: 1040 }, display), false)
  assert.equal(coversDisplay({ x: 100, y: 100, width: 800, height: 600 }, display), false)
  assert.equal(coversDisplay(null, display), false)
})

test('桌面本身不算全屏程序：小岛不能因此收成细线', () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 }
  const desktop = { x: 0, y: 0, width: 1920, height: 1080, className: 'Progman' }
  assert.equal(coversDisplay(desktop, display), false)
  assert.equal(coversDisplay({ ...desktop, className: 'WorkerW' }, display), false)
  assert.equal(coversDisplay({ ...desktop, className: 'Shell_TrayWnd' }, display), false)
  assert.equal(isDesktopClass('Progman'), true)
  assert.equal(isDesktopClass('WorkerW'), true)
  assert.equal(isDesktopClass('Shell_TrayWnd'), true)
  assert.equal(isDesktopClass('Windows.UI.Core.CoreWindow'), false)
  // 别的前台程序盖满整块屏还是算全屏
  assert.equal(coversDisplay({ ...desktop, className: 'ApplicationFrameWindow' }, display), true)
})

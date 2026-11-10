// 小岛的位置和置顶选择记在同一个文件里（pet-place.json）。

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPlace, writePlace } from '../../app/pet/place-store.mjs'

test('位置和「保持在最前」记在同一个文件里', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sidemate-place-'))
  try {
    const file = join(dir, 'pet-place.json')
    assert.equal(readPlace(file), null)
    writePlace(file, { display: 2, displayBounds: { x: 1920, y: 200, width: 1280, height: 800 }, x: 300, onTop: false })
    const saved = readPlace(file)
    assert.equal(saved.x, 300)
    assert.equal(saved.display, 2)
    assert.equal(saved.onTop, false)
    // 再存一次别的，别把前面的抹了
    writePlace(file, { ...saved, x: 33 })
    assert.equal(readPlace(file).x, 33)
    assert.equal(readPlace(file).onTop, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文件坏了就当没存过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sidemate-place-'))
  try {
    const file = join(dir, 'pet-place.json')
    writePlace(file, '不是 json')
    assert.equal(readPlace(file), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

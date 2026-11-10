import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { measure } from '../../build/lines.mjs'

function tree() {
  return mkdtempSync(join(tmpdir(), 'sidemate-lines-'))
}

test('blank lines do not count and an 801-line file fails', () => {
  const root = tree()
  try {
    writeFileSync(join(root, 'ok.mjs'), `a\n\n\nb\n`)
    const fine = measure([root], { fileMax: 800 })
    assert.equal(fine.total, 2)
    assert.deepEqual(fine.errors, [])
    writeFileSync(join(root, 'big.mjs'), `${'x\n'.repeat(801)}`)
    const over = measure([root])
    assert.equal(over.errors.length, 1)
    assert.match(over.errors[0], /801 > 800/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the dsh lock file is not shell code', () => {
  const root = tree()
  try {
    mkdirSync(join(root, 'dsh'))
    writeFileSync(join(root, 'dsh', 'package-lock.json'), `${'{"x":1}\n'.repeat(900)}`)
    writeFileSync(join(root, 'dsh', 'package.json'), '{}\n')
    const result = measure([root])
    assert.equal(result.total, 1)
    assert.deepEqual(result.errors, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the total is not capped when no total limit is passed', () => {
  const root = tree()
  try {
    writeFileSync(join(root, 'a.mjs'), `${'x\n'.repeat(800)}`)
    writeFileSync(join(root, 'b.mjs'), `${'y\n'.repeat(800)}`)
    writeFileSync(join(root, 'c.mjs'), `${'z\n'.repeat(800)}`)
    writeFileSync(join(root, 'd.mjs'), `${'w\n'.repeat(800)}`)
    writeFileSync(join(root, 'e.mjs'), `${'v\n'.repeat(800)}`)
    writeFileSync(join(root, 'f.mjs'), `${'u\n'.repeat(800)}`)
    writeFileSync(join(root, 'g.mjs'), `${'t\n'.repeat(800)}`)
    writeFileSync(join(root, 'h.mjs'), 'tail\n')
    const result = measure([root])
    assert.equal(result.total, 5601)
    assert.deepEqual(result.errors, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an explicit total limit still fails', () => {
  const root = tree()
  try {
    writeFileSync(join(root, 'a.mjs'), `${'x\n'.repeat(800)}`)
    writeFileSync(join(root, 'b.mjs'), `${'y\n'.repeat(800)}`)
    writeFileSync(join(root, 'c.mjs'), `${'z\n'.repeat(800)}`)
    writeFileSync(join(root, 'd.mjs'), `${'w\n'.repeat(800)}`)
    writeFileSync(join(root, 'e.mjs'), `${'v\n'.repeat(800)}`)
    writeFileSync(join(root, 'f.mjs'), `${'u\n'.repeat(800)}`)
    writeFileSync(join(root, 'g.mjs'), 'tail\n')
    const result = measure([root], { fileMax: 800, totalMax: 5000 })
    assert.equal(result.total, 4801)
    assert.deepEqual(result.errors, [])
    writeFileSync(join(root, 'h.mjs'), `${'t\n'.repeat(200)}`)
    const over = measure([root], { fileMax: 800, totalMax: 5000 })
    assert.equal(over.total, 5001)
    assert.match(over.errors.join('\n'), /total 5001 > 5000/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('this tree stays under the gate', () => {
  const result = measure(['app', 'build'])
  assert.ok(result.total > 0)
  assert.deepEqual(result.errors, [])
})

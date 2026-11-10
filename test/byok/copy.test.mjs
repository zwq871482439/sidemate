import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { measure } from '../../build/lines.mjs'
import { DOCS_URL, INTRO_HINT, PROBE_OK, SAFETY } from '../../app/byok/copy.mjs'
import { INTRO_LINE } from '../../app/pet/intro.mjs'

const dir = fileURLToPath(new URL('../../app/byok/', import.meta.url))

test('the first screen says the four lines and links to the official page', () => {
  assert.equal(SAFETY.length, 4)
  assert.equal(SAFETY[3], '桌伴能读你电脑上的文件，也能上网。')
  // 「测一下」通了只说「通了」，不再出钱
  assert.equal(PROBE_OK, '通了。')
  assert.equal(DOCS_URL, 'https://api-docs.deepseek.com/zh-cn/')
})

test('the third step says the same line the island shows', () => {
  // 小岛冒的那一行，设置页也说同一句；不提钱，不提字聚成球
  assert.equal(INTRO_HINT, INTRO_LINE)
  assert.equal(INTRO_HINT, '把一份范本和几份材料拖给我试试')
  assert.equal(/钱|元|球/.test(INTRO_HINT), false)
})

test('the screens do not use the banned words', () => {
  const banned = /terminal|git|patch|mcp|token/i
  for (const name of ['page.html', 'page.css', 'page.js', 'copy.mjs']) {
    const text = readFileSync(join(dir, name), 'utf8')
    assert.equal(banned.test(text), false, name)
  }
})

test('byok files stay within the per-file limit', () => {
  const result = measure([dir])
  assert.deepEqual(result.errors, [])
})

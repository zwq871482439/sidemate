import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { OUTPUT_NAME, copyOutputs } from '../../app/workspace/index.mjs'

const roots = []

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

test('这一轮出了成品，中间的 txt 不出卡也不拷进「桌伴输出」', () => {
  const root = scratch('sidemate-mid-')
  const ws = join(root, '任务', '这一轮')
  const outputDir = join(ws, OUTPUT_NAME)
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(ws, '本周周报.docx'), '成品')
  writeFileSync(join(ws, 'dd.txt'), '中间文件')
  writeFileSync(join(outputDir, 'table_dump.txt'), '表格转储')
  const made = copyOutputs({ workspace: ws, outputDir, snapshot: [] })
  assert.deepEqual(made.map((one) => one.name), ['本周周报.docx'])
  // 中间的 txt 没拷进「桌伴输出」
  assert.equal(existsSync(join(outputDir, 'dd.txt')), false)
  // 已经在「桌伴输出」里的照留不删
  assert.equal(existsSync(join(outputDir, 'table_dump.txt')), true)
  assert.equal(readdirSync(outputDir).sort().join(','), 'table_dump.txt,本周周报.docx')
})

test('这一轮只有 txt，没有成品，txt 照旧算产出', () => {
  const root = scratch('sidemate-only-txt-')
  const ws = join(root, '任务', '这一轮')
  const outputDir = join(ws, OUTPUT_NAME)
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(ws, '说明.txt'), '说明')
  const made = copyOutputs({ workspace: ws, outputDir, snapshot: [] })
  assert.deepEqual(made.map((one) => one.name), ['说明.txt'])
  assert.equal(made[0].to, join(outputDir, '说明.txt'))
  assert.equal(readdirSync(outputDir).sort().join(','), '说明.txt')
})

test('扩展名不分大小写：DOCX 也算成品，txt 照样被筛掉', () => {
  const root = scratch('sidemate-case-')
  const ws = join(root, '任务', '这一轮')
  const outputDir = join(ws, OUTPUT_NAME)
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(ws, '本周周报.DOCX'), '成品')
  writeFileSync(join(ws, 'dd.TXT'), '中间文件')
  const made = copyOutputs({ workspace: ws, outputDir, snapshot: [] })
  assert.deepEqual(made.map((one) => one.name), ['本周周报.DOCX'])
  assert.equal(existsSync(join(outputDir, 'dd.TXT')), false)
})

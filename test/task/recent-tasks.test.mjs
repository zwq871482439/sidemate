import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { recentTasks } from '../../app/task/recent-tasks.mjs'

test('只列有文件的产出目录：三个任务加随手，按修改时间排序、名字去掉日期', () => {
  const root = mkdtempSync(join(tmpdir(), 'sidemate-recent-'))
  const output = (dir, file = '产出.docx') => {
    const out = join(dir, '桌伴输出')
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, file), 'x')
    return out
  }
  const dirs = [
    join(root, '任务', '2026-11-03-旧任务'),
    join(root, '任务', '2026-11-05-总结这些形成文献综述'),
    join(root, '任务', '2026-11-04-中间任务'),
  ]
  const outs = dirs.map((dir) => output(dir))
  const randomOut = output(join(root, '随手'), '聊天.txt')
  mkdirSync(join(root, '任务', '2026-11-02-没有产出目录'), { recursive: true })
  mkdirSync(join(root, '任务', '2026-11-01-空产出', '桌伴输出'), { recursive: true })
  const times = [3, 5, 4]
  outs.forEach((out, i) => utimesSync(out, times[i], times[i]))
  utimesSync(randomOut, 6, 6)

  const found = recentTasks(root)
  assert.equal(found.length, 4)
  assert.deepEqual(found.map((one) => one.name), [
    '随手',
    '11-05 总结这些形成文献综述',
    '11-04 中间任务',
    '11-03 旧任务',
  ])
  assert.deepEqual(found[1], { dir: dirs[1], out: outs[1], name: '11-05 总结这些形成文献综述', mtime: statSync(outs[1]).mtimeMs })
  assert.ok(found.every((one) => one.mtime > 0))
  assert.deepEqual(recentTasks(join(root, '不存在')), [])
})

test('任务根目录不存在就为空；单个任务读不了会跳过', () => {
  const root = mkdtempSync(join(tmpdir(), 'sidemate-recent-empty-'))
  assert.deepEqual(recentTasks(root), [])
  mkdirSync(join(root, '任务'), { recursive: true })
  const real = { readdirSync, statSync }
  const broken = {
    ...real,
    readdirSync: (dir, options) => {
      if (String(dir).includes('坏任务')) throw new Error('读不了')
      return readdirSync(dir, options)
    },
  }
  for (const name of ['2026-11-05-好任务', '2026-11-04-坏任务']) {
    const out = join(root, '任务', name, '桌伴输出')
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'a.docx'), 'x')
  }
  assert.deepEqual(recentTasks(root, broken).map((one) => one.name), ['11-05 好任务'])
})

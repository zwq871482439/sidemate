// 单实例：同一个 userData 目录只跑一个桌伴，后双击的那个立刻退出（退出码 0），
// 不建窗、不起宠、不建托盘、不写 task.log；开着的那个收到 second-instance 就把窗叫到前面。
// 没设 SIDEMATE_SINGLE 就跳过，平时 npm test 不拉起 Electron。

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

function start(electron, args, env) {
  const child = spawn(electron, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  return { child, stderr: () => stderr }
}

async function list(port) {
  const all = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()).catch(() => [])
  return all.filter((item) => item.type === 'page')
}

async function waitPages(port, needle, count, tries = 120) {
  let pages = []
  for (let i = 0; i < tries; i++) {
    pages = await list(port)
    if (pages.filter((item) => item.url.includes(needle)).length >= count) break
    await sleep(250)
  }
  return pages
}

function bootCount(file) {
  if (!existsSync(file)) return 0
  return readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim() && JSON.parse(line).event === 'boot').length
}

test('one sidemate per user data', { skip: process.env.SIDEMATE_SINGLE ? false : 'set SIDEMATE_SINGLE=1', timeout: 180_000 }, async () => {
  const lab = mkdtempSync(path.join(tmpdir(), 'sidemate-single-'))
  const electron = createRequire(path.join(root, 'package.json'))('electron')
  const homeA = path.join(lab, 'home-a')
  const homeC = path.join(lab, 'home-c')
  const userA = path.join(lab, 'user-a')
  const userC = path.join(lab, 'user-c')
  mkdirSync(homeA)
  mkdirSync(homeC)
  const pids = []
  try {
    const a = start(electron, ['.', '--remote-debugging-port=9341', '--no-sandbox', '--disable-gpu', `--user-data-dir=${userA}`], {
      HOME: homeA, USERPROFILE: homeA, SIDEMATE_PET_STILL: '1',
    })
    pids.push(a.child.pid)
    const first = await waitPages(9341, 'page.html', 1)
    assert.equal(first.filter((item) => item.url.includes('page.html')).length, 1, `first run window missing: ${first.map((item) => item.url).join(' ')} ${a.stderr()}`)

    const b = start(electron, ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${userA}`], {
      HOME: homeA, USERPROFILE: homeA, SIDEMATE_PET_STILL: '1',
    })
    pids.push(b.child.pid)
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 15_000)
      b.child.on('exit', (value) => { clearTimeout(timer); resolve(value) })
    })
    assert.equal(code, 0, `second instance should exit 0, got ${code}: ${b.stderr()}`)

    assert.equal(a.child.exitCode, null, 'first instance died')
    const after = await list(9341)
    const pages = after.filter((item) => item.url.includes('page.html'))
    assert.equal(pages.length, 1, `expected 1 page.html, got ${pages.length}: ${after.map((item) => item.url).join(' ')}`)
    assert.equal(after.some((item) => item.url.includes('task.html')), false, 'task window appeared')
    assert.equal(bootCount(path.join(userA, 'task.log')), 1, 'task.log boot lines')

    const c = start(electron, ['.', '--remote-debugging-port=9342', '--no-sandbox', '--disable-gpu', `--user-data-dir=${userC}`], {
      HOME: homeC, USERPROFILE: homeC, SIDEMATE_PET_STILL: '1',
    })
    pids.push(c.child.pid)
    const own = await waitPages(9342, 'page.html', 1)
    assert.equal(own.filter((item) => item.url.includes('page.html')).length >= 1, true, `other user data blocked: ${c.stderr()}`)
  } finally {
    for (const pid of pids) spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' })
    await sleep(500)
    rmSync(lab, { recursive: true, force: true })
  }
})

// 首次运行和设置页。没设 SIDEMATE_BYOK 就跳过，平时 npm test 不拉起 Electron。
// Linux：xvfb-run -a -s "-screen 0 1280x800x24" env SIDEMATE_BYOK=1 node --test test/byok/screen.test.mjs

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { SAFETY } from '../../app/byok/copy.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

function evaluate(ws, source) {
  return new Promise((resolve, reject) => {
    const id = 1
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      ws.removeEventListener('message', onMessage)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result?.result?.value)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: source, returnByValue: true, awaitPromise: true } }))
  })
}

function connect(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    ws.addEventListener('open', () => resolve(ws), { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
}

test('first run and settings', { skip: process.env.SIDEMATE_BYOK ? false : 'set SIDEMATE_BYOK=1', timeout: 60_000 }, async () => {
  const lab = mkdtempSync(path.join(tmpdir(), 'sidemate-byok-screen-'))
  const home = path.join(lab, 'home')
  mkdirSync(home)
  const port = 9334
  const electron = createRequire(path.join(root, 'package.json'))('electron')
  const child = spawn(electron, ['.', `--remote-debugging-port=${port}`, '--no-sandbox', '--disable-gpu', `--user-data-dir=${path.join(lab, 'user')}`], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home, SIDEMATE_OPEN: 'settings', SIDEMATE_PET_STILL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const pages = async () => {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
    return list.filter((item) => item.type === 'page')
  }
  const sockets = []
  try {
    let list = []
    for (let i = 0; i < 50; i++) {
      list = await pages().catch(() => [])
      if (list.filter((item) => item.url.includes('page.html')).length >= 2) break
      await sleep(200)
    }
    const urls = list.map((item) => item.url)
    assert.equal(urls.some((url) => url.includes('task.html')), false, urls.join(' '))
    const targets = list.filter((item) => item.url.includes('page.html'))
    assert.equal(targets.length >= 2, true, stderr || urls.join(' '))
    let wizard
    let settings
    for (const target of targets) {
      const ws = await connect(target)
      sockets.push(ws)
      let kind = ''
      for (let i = 0; i < 25 && !kind; i++) {
        kind = await evaluate(ws, `document.querySelectorAll('#lines li').length >= 4 ? 'wizard' : (document.querySelector('#have').textContent ? 'settings' : '')`)
        if (!kind) await sleep(100)
      }
      if (kind === 'wizard') wizard = ws
      if (kind === 'settings') settings = ws
    }
    assert.ok(wizard, 'no first-run page')
    assert.ok(settings, 'no settings page')
    const safety = JSON.parse(await evaluate(wizard, `JSON.stringify([...document.querySelectorAll('#lines li')].map((item) => item.textContent))`))
    assert.deepEqual(safety, SAFETY)
    const body = await evaluate(wizard, 'document.body.innerText')
    assert.equal(/terminal|git|patch|mcp|token/i.test(body), false)
    await evaluate(wizard, `document.querySelector('#start').click()`)
    let empty = ''
    await evaluate(wizard, `document.querySelector('#test').click()`)
    for (let i = 0; i < 20 && empty !== '先贴上钥匙'; i++) {
      await sleep(50)
      empty = await evaluate(wizard, `document.querySelector('#key-result').textContent`)
    }
    assert.equal(empty, '先贴上钥匙')
    assert.equal(await evaluate(wizard, `document.querySelector('#intro').hidden`), true)
    assert.equal(await evaluate(settings, `document.querySelector('#have').textContent`), '还没有钥匙。')
    // 用量一节：月份跟着当前月，新机器上是 0，最近 10 个任务空着
    const month = `${new Date().getMonth() + 1} 月`
    assert.equal(await evaluate(settings, `document.querySelector('#usage-heading').textContent`), `${month}一共用了`)
    assert.equal(await evaluate(settings, `document.querySelector('#usage-total').textContent`), '0')
    assert.equal(await evaluate(settings, `document.querySelector('#usage-note').textContent`), '只记这台电脑上跑的任务。')
    assert.equal(await evaluate(settings, `document.querySelector('#usage-recent').children.length`), 0)
    const settingsBody = await evaluate(settings, 'document.body.innerText')
    assert.equal(settingsBody.includes('跟 DeepSeek 后台记的数对得上'), true)
    assert.equal(/terminal|git|patch|mcp|token/i.test(settingsBody), false)
    assert.equal(await evaluate(settings, `document.querySelector('#rate') === null && document.querySelector('#save-rate') === null`), true)
    assert.equal(await evaluate(settings, `document.querySelector('#price-hint') === null`), true)
    if (stderr.includes('Error')) console.log(stderr.slice(-2000))
  } finally {
    for (const ws of sockets) ws.close()
    child.kill()
    await sleep(200)
    rmSync(lab, { recursive: true, force: true })
  }
})

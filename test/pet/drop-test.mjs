// 页面层拖放。经调试协议往小岛上拖两个路径，对着日志判 5 项。
// 没设 SIDEMATE_DROP 就跳过，平时 npm test 不拉起 Electron。
// Linux：xvfb-run -a -s "-screen 0 1280x800x24" env SIDEMATE_DROP=1 node --test test/pet/drop-test.mjs

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

test('drop reaches the opened pet', { skip: process.env.SIDEMATE_DROP ? false : 'set SIDEMATE_DROP=1', timeout: 60_000 }, async () => {
  const lab = mkdtempSync(path.join(tmpdir(), 'sidemate-pet-'))
  const folder = path.join(lab, '材料 夹')
  mkdirSync(folder, { recursive: true })
  const files = [path.join(folder, '周报 范本.docx'), path.join(folder, '去年的')]
  writeFileSync(files[0], '范本')
  mkdirSync(files[1], { recursive: true })
  const logFile = path.join(lab, 'drop.log')
  const port = 9333
  const electron = createRequire(path.join(root, 'package.json'))('electron')
  const env = { ...process.env, SIDEMATE_PET_AT: 'center', SIDEMATE_PET_LOG: logFile }
  delete env.SIDEMATE_PET
  delete env.SIDEMATE_PET_STILL
  const child = spawn(electron, ['.', `--remote-debugging-port=${port}`, '--no-sandbox', '--disable-gpu', `--user-data-dir=${path.join(lab, 'user')}`], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  try {
    let target
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200)
      target = await fetch(`http://127.0.0.1:${port}/json/list`)
        .then((response) => response.json())
        .then((list) => list.find((item) => item.type === 'page' && item.url.includes('pet.html')))
        .catch(() => undefined)
    }
    assert.ok(target, stderr || 'no pet page')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', (message) => {
      const payload = JSON.parse(message.data)
      if (payload.error) console.log('调试协议报错', JSON.stringify(payload.error))
      if (payload.method === 'Runtime.exceptionThrown') {
        console.log('页面报错', payload.params.exceptionDetails.exception?.description ?? payload.params.exceptionDetails.text)
      }
      pending.get(payload.id)?.(payload)
      pending.delete(payload.id)
    })
    const send = (method, params) => new Promise((resolve) => {
      pending.set(++id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
    const drag = (type, x, y) => send('Input.dispatchDragEvent', {
      type, x, y, data: { items: [], files, dragOperationsMask: 1 },
    })
    await send('Runtime.enable')
    const width = async () => (await send('Runtime.evaluate', {
      expression: 'innerWidth',
      returnByValue: true,
    })).result.result.value
    const waitWidth = async (wanted) => {
      let current = await width()
      for (let i = 0; i < 40 && current !== wanted; i++) {
        await sleep(50)
        current = await width()
      }
      return current
    }
    const events = () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const readyState = async () => (await send('Runtime.evaluate', {
      expression: 'document.readyState',
      returnByValue: true,
    })).result.result.value
    // 窗一出来 innerWidth 就是 112，这时脚本可能还没挂上 dragenter。先等页面加载完。
    for (let i = 0; i < 50 && (await readyState()) !== 'complete'; i++) await sleep(100)
    await waitWidth(112)

    await drag('dragEnter', 64, 64)
    await drag('dragOver', 64, 64)
    const grown = await waitWidth(360)
    await drag('dragOver', 250, 140)
    await drag('drop', 250, 140)
    await waitWidth(112)
    await drag('dragEnter', 64, 64)
    await drag('dragOver', 64, 64)
    await waitWidth(360)
    await drag('dragOver', -20, -20)
    await waitWidth(112)
    const slow = events().length
    await drag('dragEnter', 64, 64)
    await drag('dragOver', 250, 140)
    await sleep(100)
    await drag('dragOver', 250, 140)
    await drag('drop', 250, 140)
    await waitWidth(112)
    const fast = events().length
    await drag('dragEnter', 64, 64)
    await drag('dragOver', 250, 140)
    await drag('drop', 250, 140)
    await sleep(300)
    const all = events()
    ws.close()

    for (const event of all) {
      console.log(event.event, JSON.stringify(event.paths ?? event.to ?? event.bounds ?? ''), event.at ? JSON.stringify(event.at) : '', event.reason ?? '')
    }
    const kinds = (from, to) => all.slice(from, to).map((event) => event.event).join(' ')
    console.log('进来立刻松手那次：', kinds(fast) || '什么都没发生')
    const drop = all.find((event) => event.event === 'drop')
    const checks = {
      '页面跟着长到 360': grown === 360,
      '进来张开、松手缩回、进来再出去': kinds(0, slow) === 'start expand drop collapse expand collapse',
      '完整路径（中文、空格、文件夹）': JSON.stringify(drop?.paths) === JSON.stringify(files),
      '落点在长出来的区域': drop?.bounds.width === 360 && drop.at.x > 180,
      '手快也不断': kinds(slow, fast) === 'expand drop collapse',
    }
    for (const [name, ok] of Object.entries(checks)) console.log(ok ? '过' : '没过', name)
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks))
    if (stderr.includes('Error')) console.log(stderr.slice(-2000))
  } finally {
    child.kill()
    await sleep(200)
    rmSync(lab, { recursive: true, force: true })
  }
})

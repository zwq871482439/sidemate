// Windows 上验原件动不了。云上没有完整性级别，这条会跳过。
// 本机先 `npm run payload`，再 `node --test test/workspace/escape.test.mjs`。
// 沙盒矩阵脚本（matrix.mjs）不在这个仓里，剧本按三条写入路子写：
// write / edit、PowerShell、再用随包 python.exe 写。
// 不改仓库里那份 node.exe。Low 打在临时目录的副本上，测完删掉。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { payloadLayout, runTask } from '../../app/dsh/index.mjs'
import { finishTask, integrityArgs, prepareTask, protectRuntime } from '../../app/workspace/index.mjs'
import { startFake } from '../dsh/fake-messages.mjs'

const KEY = 'sidemate-test-key'
const layout = payloadLayout()
const roots = []

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function ps(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function markLow(dir) {
  // %TEMP% 是普通完整性。node.exe 打成 Low 以后，在这里建目录会被拒。
  // 生产上这一层在 AppData\LocalLow，系统本来就是 Low。
  const result = spawnSync('icacls', [dir, ...integrityArgs('dir')], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`)
}

function removeJunction(path) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return
  } catch {
    return
  }
  try {
    unlinkSync(path)
  } catch {
    rmdirSync(path)
  }
}

// 仓库里那份 node.exe 不打标签。副本和联接都在 %TEMP%，打不了 Low 的目录里也能跑，测完删掉。
function privatePayload() {
  const root = mkdtempSync(join(tmpdir(), 'sidemate-escape-node-'))
  try {
    const nodeDir = join(root, 'node')
    mkdirSync(nodeDir)
    const nodePath = join(nodeDir, 'node.exe')
    copyFileSync(layout.node, nodePath)
    chmodSync(nodePath, 0o755)
    symlinkSync(join(layout.root, 'dsh'), join(root, 'dsh'), 'junction')
    symlinkSync(layout.python, join(root, 'python'), 'junction')
    return { root, nodePath }
  } catch (error) {
    removePrivatePayload(root)
    throw error
  }
}

function removePrivatePayload(root) {
  if (!root) return
  removeJunction(join(root, 'dsh'))
  removeJunction(join(root, 'python'))
  try {
    unlinkSync(join(root, 'node', 'node.exe'))
  } catch {
    // 副本可能还没拷上
  }
  try {
    rmdirSync(join(root, 'node'))
  } catch {
    // 目录还没有，或已经空了
  }
  try {
    rmdirSync(root)
  } catch {
    // 上面没清干净就留着，也不能跟着联接删进仓库
  }
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

test('scripted writes outside the workspace leave originals alone', { skip: process.platform !== 'win32', timeout: 180_000 }, async () => {
  if (!existsSync(layout.node)) {
    mkdirSync(join(layout.root, 'node'), { recursive: true })
    copyFileSync(process.execPath, layout.node)
    chmodSync(layout.node, 0o755)
  }
  assert.equal(existsSync(layout.dsh), true, '先跑 npm run payload，再跑 node --test test/workspace/escape.test.mjs')

  const root = scratch('sidemate-escape-')
  const folder = join(root, '用户 的文件夹')
  const original = join(folder, '原件.docx')
  const beside = join(folder, '隔壁.txt')
  mkdirSync(folder, { recursive: true })
  writeFileSync(original, '原文-不要动')
  writeFileSync(beside, '隔壁-不要动')
  const outside = join(root, '外面.txt')
  const task = prepareTask({ paths: [folder], prompt: '别动原件', root, now: new Date(2026, 10, 4) })
  const payload = privatePayload()
  let fake
  try {
    const guard = protectRuntime({ nodePath: payload.nodePath, workspace: task.workspace })
    assert.equal(guard.ok, true, guard.message)

    const junction = join(task.workspace, '联接')
    const through = join(junction, '原件.docx')
    const inside = join(task.workspace, '结果.txt')
    const plan = [
      () => ({ kind: 'tool', name: 'write', input: { file_path: inside, content: '可以' } }),
      () => ({ kind: 'tool', name: 'write', input: { file_path: outside, content: '不行' } }),
      () => ({ kind: 'tool', name: 'write', input: { file_path: original, content: '被写了' } }),
      () => ({ kind: 'tool', name: 'edit', input: { file_path: original, old_string: '原文-不要动', new_string: '被改了' } }),
      () => ({ kind: 'tool', name: 'pwsh', input: { command: `Remove-Item -LiteralPath ${ps(original)} -Force`, description: '删原件' } }),
      () => ({
        kind: 'tool',
        name: 'pwsh',
        input: {
          command: `New-Item -ItemType Junction -Path ${ps(junction)} -Target ${ps(folder)} | Out-Null; Set-Content -LiteralPath ${ps(through)} -Value 'junction' -Encoding utf8`,
          description: '经联接写',
        },
      }),
      () => ({ kind: 'tool', name: 'pwsh', input: { command: `Set-Content -LiteralPath ${ps(original)} -Value 'pwsh' -Encoding utf8`, description: '用命令写原件' } }),
      () => ({ kind: 'tool', name: 'load_workspace_dependencies', input: {} }),
      (raw) => {
        const found = String(raw).match(/[A-Za-z]:\\[^"'\\\s]+python\.exe/i)
        const exe = found?.[0] || join(layout.python, 'python.exe')
        const code = `open(${JSON.stringify(original)}, 'w', encoding='utf-8').write('py')`
        return { kind: 'tool', name: 'pwsh', input: { command: `& ${ps(exe)} -c ${ps(code)}`, description: '用 Python 写原件' } }
      },
    ]
    let index = 0
    fake = await startFake({
      expectKey: KEY,
      respond(body) {
        const raw = JSON.stringify(body)
        const hasResult = raw.includes('tool_result')
        if (!hasResult && index === 0) {
          index = 1
          return plan[0](raw)
        }
        if (hasResult && index < plan.length) {
          const step = plan[index]
          index += 1
          return step(raw)
        }
        return { kind: 'text', text: '停了' }
      },
    })
    const events = []
    const lowRoot = scratch('sidemate-escape-low-')
    markLow(lowRoot)
    const handle = runTask({
      taskId: 'escape',
      apiKey: KEY,
      prompt: '按剧本试',
      workspace: task.workspace,
      baseUrl: fake.url,
      lowRoot,
      payloadRoot: payload.root,
      stallMs: 60_000,
      onEvent: (event) => events.push(event),
    })
    const end = await handle.done
    assert.equal(end.status, 'done', JSON.stringify(events.map(event => event.type)))
    assert.ok(fake.calls.length >= plan.length, String(fake.calls.length))
    assert.equal(existsSync(outside), false)
    assert.equal(readFileSync(original, 'utf8'), '原文-不要动')
    assert.equal(readFileSync(beside, 'utf8'), '隔壁-不要动')
    const checked = finishTask(task)
    assert.equal(checked.ok, true, checked.message)
    assert.equal(checked.mark, '')
    const made = readFileSync(inside, 'utf8')
    assert.match(made, /可以/)
    assert.equal(readFileSync(join(folder, '桌伴输出', '结果.txt'), 'utf8'), made)
    const log = readFileSync(handle.logPath, 'utf8')
    assert.equal(log.includes(KEY), false)
  } finally {
    if (fake) await fake.close()
    removePrivatePayload(payload.root)
  }
})

test('the escape script is not run off Windows', { skip: process.platform === 'win32' }, () => {
  assert.equal(spawnSync('icacls', ['/?'], { windowsHide: true }).error?.code, 'ENOENT')
})

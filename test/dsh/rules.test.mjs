import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, describe } from 'node:test'
import { dshLaunch, payloadLayout, runTask } from '../../app/dsh/index.mjs'
import { startFake } from './fake-messages.mjs'

const KEY = 'sidemate-test-key'
const layout = payloadLayout()
const roots = []

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function ensureNode() {
  if (existsSync(layout.node)) return
  mkdirSync(join(layout.root, 'node'), { recursive: true })
  copyFileSync(process.execPath, layout.node)
  chmodSync(layout.node, 0o755)
}

function taskOptions(extra) {
  const workspace = scratch('sidemate-ws-')
  const lowRoot = scratch('sidemate-low-')
  return { workspace, lowRoot, ...extra }
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

const RULE_HEAD = '桌伴的干活规矩：'
const RULE_THREE = '3. 改已有的脚本或文本文件用 edit 工具。不要用 PowerShell 的 Get-Content、Set-Content 读写含中文的文件，会把中文读坏。'
const RULE_FOUR = '4. 成品写在工作区根目录；中间文件和调试输出写进 .草稿/ 目录；都不要写进「桌伴输出」，桌伴整轮干完自己拷过去。'
const RULE_OUT = '成品写在工作区根目录'
const CHINESE_PROBE = '中文测试一二三'
const RULE_FILE = new URL('../../app/dsh/rules.patch.yml', import.meta.url)

function toolResultText(body) {
  const parts = []
  for (const message of body?.messages || []) {
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type !== 'tool_result') continue
      if (typeof block.content === 'string') parts.push(block.content)
      else if (Array.isArray(block.content)) {
        for (const piece of block.content) if (typeof piece?.text === 'string') parts.push(piece.text)
      }
    }
  }
  return parts.join('\n')
}

function pythonPathFrom(text) {
  const full = text.match(/[A-Za-z]:[\\/][^\s"'<>|]*?python\.exe/i)
  if (full) return full[0]
  const loose = text.match(/[^\s"'<>|]*python\.exe/i)
  return loose ? loose[0] : ''
}

describe('dsh rules', { concurrency: 1 }, () => {
  test('the persona prefix is empty: the coding agent line is gone from the patch', () => {
    const text = readFileSync(RULE_FILE, 'utf8')
    assert.match(text, /personaPrefix: ''/, text)
    assert.equal(/coding agent/i.test(text), false, text)
  })

  test('the rules keep the product out of the output folder: the shell copies it over', () => {
    const text = readFileSync(RULE_FILE, 'utf8')
    // 成品先写在工作区根目录，桌伴整轮干完自己拷进「桌伴输出」：这句不能丢
    assert.ok(text.includes(RULE_OUT), text)
    assert.ok(text.includes(RULE_FOUR), text)
  })

  test('the launch env pins python output to utf-8', () => {
    const launch = dshLaunch(taskOptions({ taskId: 'env', apiKey: KEY, prompt: 'hi', workspace: scratch('sidemate-ws-') }))
    assert.equal(launch.env.PYTHONIOENCODING, 'utf-8')
    assert.equal(launch.env.PYTHONUTF8, '1')
  })

  test('the dumped config carries the persona and the rules', { timeout: 60_000 }, () => {
    ensureNode()
    assert.equal(existsSync(layout.dsh), true)
    const options = taskOptions({ taskId: 'dump', apiKey: KEY, prompt: 'hi', workspace: scratch('sidemate-ws-') })
    const launch = dshLaunch(options)
    const dumped = spawnSync(launch.command, [...launch.args, '--dump-config'], {
      cwd: launch.cwd,
      env: launch.env,
      encoding: 'utf8',
      timeout: 40_000,
    })
    const text = `${dumped.stdout}\n${dumped.stderr}`
    assert.equal(dumped.status, 0, text)
    // 人设那行显式写成空串：dsh 自带的「You are a coding agent ...」不许留在提示里
    assert.match(text, /personaPrefix: ''/, text.slice(0, 2000))
    assert.equal(/coding agent/i.test(text), false, text.slice(0, 2000))
    assert.ok(text.includes(RULE_HEAD), text.slice(0, 2000))
    // the yaml dump wraps long lines, so compare with the whitespace flattened
    const flat = text.replace(/\s+/g, ' ')
    assert.ok(flat.includes(RULE_THREE), text.slice(-2000))
    assert.ok(flat.includes(RULE_FOUR), text.slice(-2000))
  })

  test('python output through the pwsh tool keeps its chinese', { timeout: 90_000 }, async (t) => {
    if (process.platform !== 'win32') {
      t.skip('the pwsh tool check only runs on windows')
      return
    }
    ensureNode()
    if (!existsSync(join(layout.python, 'runtime.json'))) {
      t.skip('bundled python is not installed')
      return
    }
    let firstRequestError = null
    let python = ''
    let pwshOutput = ''
    const fake = await startFake({
      expectKey: KEY,
      respond: (body, nth) => {
        if (nth === 1) {
          try {
            const system = JSON.stringify(body.system)
            assert.ok(system.includes(RULE_HEAD), system.slice(0, 2000))
            assert.ok(system.includes(RULE_THREE), system.slice(0, 2000))
          } catch (error) {
            firstRequestError = error
          }
          return { kind: 'tool', name: 'load_workspace_dependencies', input: {} }
        }
        if (nth === 2) {
          const text = toolResultText(body)
          python = pythonPathFrom(text)
          if (!python) {
            firstRequestError = firstRequestError ?? new Error(`no python.exe in the workspace tool result: ${text.slice(0, 800)}`)
            return { kind: 'text', text: '好了' }
          }
          return {
            kind: 'tool',
            name: 'pwsh',
            input: {
              description: '打印一句中文',
              command: `& '${python}' -c "print('${CHINESE_PROBE}')"`,
            },
          }
        }
        pwshOutput = toolResultText(body)
        return { kind: 'text', text: '好了' }
      },
    })
    const events = []
    try {
      const end = await runTask({
        ...taskOptions({ taskId: 'rules', apiKey: KEY, prompt: '准备', stallMs: 30_000, baseUrl: fake.url }),
        onEvent: (event) => events.push(event),
      }).done
      assert.equal(end.status, 'done', JSON.stringify(events))
      if (firstRequestError) throw firstRequestError
      assert.ok(python, 'the workspace tool never reported a python.exe')
      assert.ok(pwshOutput.includes(CHINESE_PROBE), pwshOutput.slice(0, 1500))
      assert.equal(pwshOutput.includes('\uFFFD'), false, pwshOutput.slice(0, 1500))
    } finally {
      await fake.close()
    }
  })
})

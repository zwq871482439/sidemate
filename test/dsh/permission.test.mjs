import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
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

function taskOptions(extra) {
  const workspace = scratch('sidemate-permission-ws-')
  mkdirSync(workspace, { recursive: true })
  return {
    workspace,
    lowRoot: scratch('sidemate-permission-low-'),
    node: process.execPath,
    ...extra,
  }
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

describe('permission preset', { concurrency: 1 }, () => {
  test('the config names the workspace-write and never combination', { timeout: 60_000 }, (t) => {
    if (!existsSync(layout.dsh)) {
      t.skip('dsh payload is not linked under ./payload')
      return
    }
    const launch = dshLaunch(taskOptions({ taskId: 'permission-dump', apiKey: KEY, prompt: 'hi' }))
    const dumped = spawnSync(launch.command, [...launch.args, '--dump-config'], {
      cwd: launch.cwd,
      env: launch.env,
      encoding: 'utf8',
      timeout: 40_000,
      windowsHide: true,
    })
    const text = `${dumped.stdout}\n${dumped.stderr}`
    assert.equal(dumped.status, 0, text)
    assert.doesNotMatch(text, /did not activate|match no preset/)
    assert.match(text, /id: approval[\s\S]*?policy: never/)
    assert.match(text, /sidemate-workspace:\s*sandbox: workspace-write\s*approval: never/)
    assert.match(text, /defaultPreset: sidemate-workspace/)
    assert.doesNotMatch(text, /defaultPreset: workspace-write/)
    assert.equal(text.includes(KEY), false)
  })

  test('a wider-permission write is still rejected without an approval request', { timeout: 60_000 }, async (t) => {
    if (!existsSync(layout.dsh)) {
      t.skip('dsh payload is not linked under ./payload')
      return
    }
    const outside = join(scratch('sidemate-permission-out-'), 'secret.txt')
    let sawRejection = false
    const fake = await startFake({
      expectKey: KEY,
      respond: (body) => {
        const raw = JSON.stringify(body)
        if (raw.includes('tool_result') || raw.includes('rejected') || raw.includes('sandbox')) {
          sawRejection = /rejected|sandbox|denied|拒绝/i.test(raw)
          return { kind: 'text', text: '停了' }
        }
        return {
          kind: 'tool',
          name: 'write',
          input: {
            file_path: outside,
            content: 'nope',
            sandbox_permissions: 'danger-full-access',
            justification: 'need full access',
          },
        }
      },
    })
    const events = []
    const logs = []
    try {
      const handle = runTask(taskOptions({
        taskId: 'permission-deny',
        apiKey: KEY,
        prompt: '写到外面',
        baseUrl: fake.url,
        stallMs: 30_000,
        onEvent: event => events.push(event),
        onLog: line => logs.push(line),
      }))
      const end = await handle.done
      assert.equal(end.status, 'done', JSON.stringify({ events, calls: fake.calls.length }))
      assert.equal(existsSync(outside), false)
      assert.equal(sawRejection, true, JSON.stringify(fake.calls).slice(0, 2000))
      const log = readFileSync(handle.logPath, 'utf8')
      assert.doesNotMatch(log, /did not activate|match no preset/)
      assert.doesNotMatch(log, /permission rejected/)
      assert.equal(log.includes(KEY), false)
      assert.equal(logs.some(line => line.includes(KEY)), false)
    } finally {
      await fake.close()
    }
  })
})

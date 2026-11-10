import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { deskRoot } from '../../app/workspace/index.mjs'
import { dshLaunch, patchFiles, payloadLayout, runTask } from '../../app/dsh/index.mjs'
import { startFake } from './fake-messages.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
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

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

test('the bundled word skill has a valid dsh name and instructions', () => {
  const file = resolve(root, 'app/skills/sidemate-word/SKILL.md')
  const text = readFileSync(file, 'utf8')
  const name = text.match(/^name:\s*([^\r\n]+)$/m)?.[1]
  assert.equal(name, 'sidemate-word')
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.match(text, /^description:\s*\S+/m)
  for (const script of ['inspect_template.py', 'compile_docx.py', 'read_material.py']) {
    assert.match(text, new RegExp(`scripts/${script}`))
  }
})

test('the patch points customSkillDirs at the app skills directory', () => {
  assert.ok(patchFiles().some(file => file.endsWith('word-skill.patch.yml')))
  const patch = readFileSync(resolve(root, 'app/dsh/word-skill.patch.yml'), 'utf8')
  assert.match(patch, /@deepseek-ai\/dsh-skill-filesystem/)
  assert.match(patch, /customSkillDirs:/)
  assert.match(patch, /process\.env\.DSH_SKILL_DIR/)
  const launch = dshLaunch({
    taskId: 'word-skill',
    apiKey: 'test-placeholder',
    workspace: root,
    payloadRoot: resolve(root, 'missing-payload'),
    lowRoot: scratch('sidemate-low-'),
  })
  assert.equal(launch.env.DSH_SKILL_DIR, resolve(root, 'app/skills'))
})

test('the installer file glob includes bundled skills without another rule', () => {
  const config = readFileSync(resolve(root, 'build/builder.config.cjs'), 'utf8')
  assert.match(config, /files:\s*\['app\/\*\*\/\*', 'package\.json'\]/)
})

test('the agents home is the deskpet own empty dir, not the user ~/.agents', () => {
  const lowRoot = scratch('sidemate-low-')
  const launch = dshLaunch({
    taskId: 'agents-home',
    apiKey: KEY,
    workspace: root,
    payloadRoot: resolve(root, 'missing-payload'),
    lowRoot,
  })
  // 桌伴自己的 agents 目录：跟 DSH_HOME 同一个父目录，起进程前已建好，里面不放东西
  assert.equal(launch.env.DSH_AGENTS_HOME, join(lowRoot, 'agents'))
  assert.equal(launch.agentsHome, launch.env.DSH_AGENTS_HOME)
  assert.equal(resolve(launch.env.DSH_AGENTS_HOME, '..'), resolve(launch.dshHome, '..'))
  assert.notEqual(resolve(launch.env.DSH_AGENTS_HOME), resolve(homedir(), '.agents'))
  assert.equal(statSync(launch.env.DSH_AGENTS_HOME).isDirectory(), true)
  assert.deepEqual(readdirSync(launch.env.DSH_AGENTS_HOME), [])
  // 用户自己的技能目录是 ~/桌伴/技能，跟 patch 里那第二项对得上
  assert.equal(launch.env.DSH_USER_SKILL_DIR, join(deskRoot(), '技能'))
  const patch = readFileSync(resolve(root, 'app/dsh/word-skill.patch.yml'), 'utf8')
  assert.match(patch, /agentsHome:\s*!!js "process\.env\.DSH_AGENTS_HOME"/)
  const block = patch.slice(patch.indexOf('customSkillDirs:'))
  assert.match(block, /-\s*!!js "process\.env\.DSH_SKILL_DIR"\s*\n\s*-\s*!!js "process\.env\.DSH_USER_SKILL_DIR"/)
})

test('the dumped config carries both skill dirs and the pinned agents home', { timeout: 60_000 }, (t) => {
  ensureNode()
  if (!existsSync(layout.dsh)) {
    t.skip('dsh payload is not linked under ./payload')
    return
  }
  const launch = dshLaunch({
    taskId: 'dump',
    apiKey: KEY,
    workspace: scratch('sidemate-ws-'),
    payloadRoot: layout.root,
    lowRoot: scratch('sidemate-low-'),
  })
  const dumped = spawnSync(launch.command, [...launch.args, '--dump-config'], {
    cwd: launch.cwd,
    env: launch.env,
    encoding: 'utf8',
    timeout: 40_000,
  })
  const text = `${dumped.stdout}\n${dumped.stderr}`
  assert.equal(dumped.status, 0, text.slice(0, 2000))
  const start = text.indexOf('id: skill-filesystem')
  const section = text.slice(start, text.indexOf('# ==', start))
  assert.ok(start >= 0, text.slice(0, 2000))
  assert.match(section,
    /config:\s*\r?\n\s+agentsHome: !!js process\.env\.DSH_AGENTS_HOME\s*\r?\n\s+customSkillDirs:\s*\r?\n\s+- !!js process\.env\.DSH_SKILL_DIR\s*\r?\n\s+- !!js process\.env\.DSH_USER_SKILL_DIR/,
    section)
})

test('dsh never sees skills or instructions from a fake user ~/.agents', { timeout: 120_000 }, async (t) => {
  ensureNode()
  if (!existsSync(layout.dsh)) {
    t.skip('dsh payload is not linked under ./payload')
    return
  }
  const marker = 'SIDEMATE-FAKE-AGENTS'
  const fakeHome = scratch('sidemate-home-')
  const agentsDir = join(fakeHome, '.agents')
  mkdirSync(join(agentsDir, 'skills', 'fake-agents-skill'), { recursive: true })
  writeFileSync(join(agentsDir, 'skills', 'fake-agents-skill', 'SKILL.md'),
    `---\nname: fake-agents-skill\ndescription: ${marker} 装给别的 AI 工具的技能\n---\n\n${marker} 技能正文\n`)
  writeFileSync(join(agentsDir, 'AGENTS.md'), `${marker} 用户全局说明\n`)
  const saved = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'].map(name => [name, process.env[name]])
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome
  delete process.env.HOMEDRIVE
  delete process.env.HOMEPATH
  let sawBundled = false
  let fake
  try {
    fake = await startFake({
      expectKey: KEY,
      respond: (body) => {
        if (JSON.stringify(body).includes('sidemate-word')) sawBundled = true
        return { kind: 'text', text: '好了' }
      },
    })
    const end = await runTask({
      taskId: 'agents-leak',
      apiKey: KEY,
      prompt: '看一眼技能',
      workspace: scratch('sidemate-ws-'),
      lowRoot: scratch('sidemate-low-'),
      baseUrl: fake.url,
      stallMs: 30_000,
    }).done
    assert.equal(end.status, 'done', 'the round should finish')
    const seen = fake.calls.map(body => JSON.stringify(body)).join('\n')
    assert.equal(seen.includes('fake-agents-skill'), false, seen.slice(0, 1500))
    assert.equal(seen.includes(marker), false, seen.slice(0, 1500))
    // 随包技能照常进目录：技能机制本身在工作，没看到它说明目录坏了
    assert.equal(sawBundled, true, 'the bundled sidemate-word skill never reached the model')
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await fake?.close()
  }
})

// 任务窗卡三的流水线测试：runTask / prepareTask / protectRuntime / prepareFeed /
// reviewDocx / finishTask / clearWorkspace / snapshotWorkspace 全用假的，事件形状照 docs/事件.md。

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createRunner } from '../../app/task/run.mjs'
import { TEXT } from '../../app/task/state.mjs'
import { finishTask as realFinish, deliverOutput as realDeliver, snapshotWorkspace as realSnapshot } from '../../app/workspace/index.mjs'
import { pythonBin, reviewDocx as realReview } from '../../app/cite/index.mjs'

// 整套跑完必须是 0：谁也没接的 promise 会在这里现形
let unhandledRejections = 0
process.on('unhandledRejection', () => { unhandledRejections += 1 })

const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const idle = () => new Promise((done) => setImmediate(done))

function harness(over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sidemate-run-'))
  const nodeSource = join(root, 'payload', 'node', 'node.exe')
  const nodeLow = join(root, 'payload', 'node-low', 'node.exe')
  mkdirSync(dirname(nodeSource), { recursive: true })
  writeFileSync(nodeSource, 'node-binary-for-tests')
  const disk = { files: [] } // snapshotWorkspace 假装的工作区现状
  const ws = join(root, 'task-ws')
  const random = join(root, '桌伴', '随手')
  const seen = { run: [], prepare: [], guard: [], feed: [], review: [], tidy: [], strip: [], finish: [], deliver: [], clear: [], pet: [], recent: [], log: [], views: [], handles: [] }
  const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return path }
  const doneRun = (options, status) => ({ type: 'end', taskId: options.taskId, at: 9, status })
  const runner = createRunner({
    root: () => join(root, '桌伴'),
    key: () => (over.noKey ? '' : 'sk-test'),
    extensions: ['.docx', '.xlsx', '.pptx', '.pdf', '.csv', '.md', '.txt'],
    recent: over.recent ?? [],
    node: { source: nodeSource, low: nodeLow },
    log: (event, data) => seen.log.push([event, data]),
    onPet: (event) => seen.pet.push(event),
    onRecent: (list) => seen.recent.push([...list]),
    onView: (view) => seen.views.push(view),
    openSettings: () => { seen.settings = (seen.settings || 0) + 1 },
    openPath: (path, reveal) => { seen.open = { path, reveal } },
    pickFiles: over.pickFiles
      ? (cell) => over.pickFiles(cell, seen)
      : (cell) => { seen.pick = cell },
    prepareTask: over.prepareTask
      ? (input) => over.prepareTask(input, seen, root)
      : (input) => {
          seen.prepare.push(input)
          const workspace = input.paths.length ? ws : random
          return {
            kind: input.paths.length ? 'files' : 'none', workspace, outputDir: join(workspace, '桌伴输出'),
            copied: input.paths.map((from) => ({ from, to: join(workspace, basename(from)) })),
            skipped: [], originals: input.paths.map((from) => ({ path: from })), snapshot: [],
          }
        },
    protectRuntime: over.protectRuntime
      ? (input) => over.protectRuntime(input, seen)
      : (input) => { seen.guard.push(input); return { ok: true, message: '' } },
    prepareFeed: over.prepareFeed
      ? (input) => over.prepareFeed(input, seen)
      : (input) => { seen.feed.push(input); return { prompt: '带标记的提示', chunks: [{ index: 1, marker: 'S01', text: 'x' }] } },
    reviewDocx: over.reviewDocx
      ? (input) => over.reviewDocx(input, seen)
      : (input) => { seen.review.push(input); return { verified: 2, missed: 1, docx: input.docx } },
    tidyDocx: over.tidyDocx
      ? (input) => over.tidyDocx(input, seen)
      : undefined,
    stripMarks: over.stripMarks
      ? (input) => over.stripMarks(input, seen)
      : (input) => { seen.strip.push(input); return { docx: input.docx, stripped: 0 } },
    finishTask: over.finishTask
      ? (prepared, extra) => over.finishTask(prepared, extra, seen, disk)
      : (prepared, extra) => {
          seen.finish.push(extra)
          const before = new Set(extra.snapshot)
          const pagesOf = (rel) => extra.artifacts.find((one) => basename(one.path) === basename(rel))?.pages
          // defer：产出先留在工作区里，壳在副本上做后处理，做完再交
          const outputs = disk.files.filter((rel) => !before.has(rel)).map((rel) => {
            const pages = pagesOf(rel)
            const out = { rel, from: join(ws, rel), name: basename(rel) }
            return pages == null ? out : { ...out, pages }
          })
          for (const rel of outputs) {
            // 假的工作区：把这一轮的产出落个空文件，壳拷副本时拷得动
            if (!existsSync(rel.from)) {
              mkdirSync(dirname(rel.from), { recursive: true })
              writeFileSync(rel.from, rel.name)
            }
          }
          return { ok: true, changed: [], snapshot: disk.files.slice(), outputs }
        },
    deliverOutput: over.deliverOutput
      ? (input) => over.deliverOutput(input, seen)
      : (input) => {
          seen.deliver.push(input)
          return { to: join(root, '产出', input.name), name: input.name, locked: false }
        },
    clearWorkspace: over.clearWorkspace
      ? (dir) => over.clearWorkspace(dir, seen)
      : (dir) => { seen.clear.push(dir) },
    snapshotWorkspace: over.snapshotWorkspace
      ? (dir) => over.snapshotWorkspace(dir, seen, disk)
      : () => disk.files.slice(),
    runTask: (options) => {
      const handle = (over.runTask || defaultRun)(options, seen, { disk, doneRun })
      seen.run.push(options)
      seen.handles.push(handle)
      return handle
    },
  })
  function defaultRun(options, seen, kit) {
    options.onEvent({ type: 'progress', taskId: options.taskId, at: 1, text: '正在写 周报.docx' })
    options.onEvent({ type: 'reply', taskId: options.taskId, at: 2, text: '做好了' })
    options.onEvent({ type: 'usage', taskId: options.taskId, at: 3, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, searches: 0 })
    return { sessionId: 's1', cancel() { this.cancelled = true }, done: Promise.resolve(kit.doneRun(options, 'done')) }
  }
  return { runner, root, ws, random, seen, disk, write, nodeSource, nodeLow }
}

// 多份材料才走打标和核出处：给只放一份材料的测试补一份第二材料
function extra(h, name = '乙.md') {
  return h.write(join(h.root, name), 'y')
}

async function settled(runner, phase) {
  for (let i = 0; i < 400 && runner.view().phase !== phase; i += 1) await delay(5)
  assert.equal(runner.view().phase, phase)
}

async function until(predicate) {
  for (let i = 0; i < 400 && !predicate(); i += 1) await delay(5)
  assert.ok(predicate(), 'condition not reached')
}

// 模型把产出直接写进「桌伴输出」也要认。这几条用真 finishTask / snapshotWorkspace 走全链路，
// outputDir 照拖放的方式给：拖文件夹是原文件夹里的那份，其余是工作区里的那份。
function realWorld(over = {}) {
  const h = harness({
    ...over.deps,
    prepareTask: (input) => {
      const workspace = input.paths.length ? h.ws : h.random
      mkdirSync(workspace, { recursive: true })
      return {
        kind: input.paths.length ? 'files' : 'none', workspace,
        outputDir: over.folder ? join(over.folder, '桌伴输出') : join(workspace, '桌伴输出'),
        copied: [], skipped: [], originals: [], snapshot: realSnapshot(workspace),
      }
    },
    snapshotWorkspace: (dir) => realSnapshot(dir),
    finishTask: (prepared, extra) => realFinish(prepared, extra),
    deliverOutput: (input) => realDeliver(input),
  })
  return h
}

const bundled = pythonBin()

function runPy(code, args = [], input) {
  const child = spawnSync(bundled, ['-c', code, ...args], { encoding: 'utf8', input })
  if (child.status !== 0) throw new Error(child.stderr || child.stdout)
  return child.stdout
}

function writeMarkedDocx(file, body) {
  mkdirSync(dirname(file), { recursive: true })
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    'word/styles.xml': '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
${body}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
</w:body></w:document>`,
  }
  runPy(`import json, sys, zipfile
path, files = sys.argv[1], json.loads(sys.stdin.read())
with zipfile.ZipFile(path, "w") as z:
    for name, text in files.items():
        z.writestr(name, text)`, [file], JSON.stringify(files))
}

function readPart(file, name) {
  return runPy(`import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
sys.stdout.write(z.read(sys.argv[2]).decode("utf-8") if sys.argv[2] in z.namelist() else "")`, [file, name])
}

test('a 拖两份文件跑一轮：copy、workspace、prepare 三步上屏，产出卡带出处、不带钱', async () => {
  const h = harness({
    runTask: (options, seen, kit) => {
      options.onEvent({ type: 'progress', taskId: options.taskId, at: 1, text: '正在写 周报.docx' })
      options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: join(h.ws, '周报.docx'), name: '周报.docx', pages: 3 })
      options.onEvent({ type: 'usage', taskId: options.taskId, at: 3, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, searches: 0 })
      kit.disk.files = ['tagged/S01-甲.txt', '周报.docx']
      return { sessionId: 's1', cancel() { this.cancelled = true }, done: Promise.resolve(kit.doneRun(options, 'done')) }
    },
  })
  const f1 = h.write(join(h.root, '甲.docx'), 'x')
  const f2 = h.write(join(h.root, '乙.pdf'), 'y')
  h.disk.files = ['tagged/S01-甲.txt']
  h.runner.drop([f1, f2], 'materials')
  let v = h.runner.view()
  assert.equal(v.phase, 'ready')
  assert.equal(v.top.materials.files.length, 2)
  h.runner.act({ type: 'send', text: '汇成本周周报' })
  await settled(h.runner, 'done')
  v = h.runner.view()
  const texts = v.flow.map((one) => one.text)
  // 过程那行没了：拷贝、准备、核出处、正在写都不上屏
  assert.ok(!texts.some((one) => /份文件拷一份|收拾干活的地方|逐句核对出处|正在写/.test(one)), texts.join('|'))
  assert.equal(v.flow.some((one) => one.kind === 'progress'), false)
  assert.equal(v.top.path.title, h.ws)
  assert.equal(h.seen.run.length, 1)
  assert.equal(h.seen.run[0].prompt, '带标记的提示')
  assert.equal(h.seen.run[0].workspace, h.ws)
  assert.equal(h.seen.run[0].node, h.nodeLow)
  assert.equal(h.seen.feed.length, 1)
  assert.deepEqual(h.seen.feed[0].materials, [join(h.ws, '甲.docx'), join(h.ws, '乙.pdf')])
  assert.equal(h.seen.feed[0].node, undefined)
  assert.equal(h.seen.review.length, 1)
  assert.equal(h.seen.review[0].docx, join(h.ws, '.后处理', '周报.docx')) // 核出处在副本上做
  assert.equal(h.seen.review[0].utterance, '汇成本周周报')
  assert.equal(h.seen.review[0].hasTemplate, false)
  assert.equal(h.seen.tidy.length, 0)
  assert.equal(v.bottom.cards.length, 1)
  const card = v.bottom.cards[0]
  assert.equal(card.name, '周报.docx')
  assert.equal(card.path, join(h.root, '产出', '周报.docx'))
  assert.ok(card.line.includes('3 页'), card.line)
  assert.ok(!card.line.includes('这次约'), card.line)
  assert.equal(card.cite.text, '2 句核上出处，1 句没逐字核上（批注里标了）')
})

test('b 网络错了给人话、能重来；重来换 runId、还是同一个工作区', async () => {
  let calls = 0
  const h = harness({
    runTask: (options, seen, kit) => {
      calls += 1
      if (calls === 1) {
        options.onEvent({ type: 'error', taskId: options.taskId, at: 5, reason: 'network', message: '没干成：连不上模型那边' })
        return { sessionId: undefined, cancel() {}, done: Promise.resolve(kit.doneRun(options, 'error')) }
      }
      options.onEvent({ type: 'reply', taskId: options.taskId, at: 2, text: '好了' })
      options.onEvent({ type: 'usage', taskId: options.taskId, at: 3, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, searches: 0 })
      return { sessionId: 's2', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
    },
  })
  const file = h.write(join(h.root, '甲.docx'), 'x')
  h.runner.drop([file], 'materials')
  h.runner.act({ type: 'send', text: '干活' })
  await settled(h.runner, 'error')
  let v = h.runner.view()
  const bad = v.flow[v.flow.length - 1]
  assert.equal(bad.kind, 'error')
  assert.equal(bad.text, TEXT.fail.network)
  assert.deepEqual(bad.buttons.map((b) => b.action), ['retry'])
  const first = h.seen.run[0]
  h.runner.act({ type: 'retry' })
  await settled(h.runner, 'done')
  assert.equal(h.seen.run.length, 2)
  assert.notEqual(h.seen.run[1].taskId, first.taskId)
  assert.equal(h.seen.run[1].workspace, first.workspace)
  assert.equal(h.seen.prepare.length, 1)
})

test('c 准备中停下立刻停、一次都不起 dsh；跑起来再停调 handle.cancel', async () => {
  let release
  const gate = new Promise((done) => { release = done })
  const slow = harness({
    prepareTask: async (input) => {
      await gate
      return { workspace: 'C:/deskware/ws', outputDir: 'C:/deskware/ws/桌伴输出', copied: [], skipped: [], originals: [], snapshot: [] }
    },
  })
  slow.runner.act({ type: 'send', text: '干活' })
  await idle()
  slow.runner.act({ type: 'stop' })
  assert.equal(slow.runner.view().phase, 'stopped')
  release()
  await delay(30)
  assert.equal(slow.seen.run.length, 0)
  const running = harness({
    runTask: () => ({ sessionId: 's', cancel() { this.cancelled = true }, done: new Promise(() => {}) }),
  })
  running.runner.act({ type: 'send', text: '干活' })
  await until(() => running.seen.handles.length === 1)
  running.runner.act({ type: 'stop' })
  assert.equal(running.seen.handles[0].cancelled, true)
})

test('d 只聊天：不调 prepareFeed、工作区是随手、收下清场', async () => {
  const h = harness()
  h.runner.act({ type: 'send', text: '讲个笑话' })
  await settled(h.runner, 'done')
  assert.equal(h.seen.feed.length, 0)
  assert.equal(h.seen.run[0].workspace, h.random)
  const v = h.runner.view()
  assert.ok(v.bottom.none.text.startsWith(TEXT.noOutput), v.bottom.none.text)
  assert.ok(!v.bottom.none.text.includes('这次约'), v.bottom.none.text)
  h.runner.act({ type: 'accept' })
  assert.equal(h.runner.view().phase, 'empty')
  await until(() => h.seen.clear.length === 1) // 收下排队：上一轮退完才清
  assert.deepEqual(h.seen.clear, [h.random])
})

test('e 前台出错不打扰宠；不在前台才喂一次 error', async () => {
  const errorRun = (options, seen, kit) => {
    options.onEvent({ type: 'error', taskId: options.taskId, at: 5, reason: 'network', message: '没干成：连不上模型那边' })
    return { sessionId: undefined, cancel() {}, done: Promise.resolve(kit.doneRun(options, 'error')) }
  }
  const back = harness({ runTask: errorRun })
  back.runner.act({ type: 'send', text: '干活' })
  await settled(back.runner, 'error')
  const errors = back.seen.pet.filter((one) => one.type === 'error')
  assert.equal(errors.length, 1)
  assert.ok(errors[0].message.includes('网络'))
  const fore = harness({ runTask: errorRun })
  fore.runner.feed({ type: 'window', foreground: true })
  fore.runner.act({ type: 'send', text: '干活' })
  await settled(fore.runner, 'error')
  assert.equal(fore.seen.pet.filter((one) => one.type === 'error').length, 0)
  const last = fore.seen.pet[fore.seen.pet.length - 1]
  assert.deepEqual({ type: last.type, status: last.status }, { type: 'end', status: 'cancelled' })
})

test('e2 做完了喂小岛的是 end done：小岛笑眼，不会出去设置', async () => {
  const h = harness()
  h.runner.act({ type: 'send', text: '干活' })
  await settled(h.runner, 'done')
  assert.equal(h.seen.pet.filter((one) => one.type === 'error').length, 0, JSON.stringify(h.seen.pet))
  const last = h.seen.pet[h.seen.pet.length - 1]
  assert.deepEqual({ type: last.type, status: last.status }, { type: 'end', status: 'done' })
})

test('f 做完了往宠身上拖新文件：旧工作区清掉、新任务带上、流里先说收下了', async () => {
  const h = harness()
  h.runner.act({ type: 'send', text: '第一件' })
  await settled(h.runner, 'done')
  const oldWs = h.seen.run[0].workspace
  const file = h.write(join(h.root, '新.docx'), 'z')
  h.runner.opened({ paths: [file] })
  const v = h.runner.view()
  assert.equal(v.phase, 'ready')
  assert.equal(v.top.materials.files.length, 1)
  assert.equal(v.flow[0].text, TEXT.settled)
  await until(() => h.seen.clear.length === 1) // 收下排队：等旧轮退完再清
  assert.deepEqual(h.seen.clear, [oldWs])
})

test('h 小岛拖过来的文件认 cell：当范本当范本，其余当材料', () => {
  const h = harness()
  const one = h.write(join(h.root, '周报 范本.docx'), 'z')
  h.runner.opened({ paths: [one], cell: 'template' })
  const asTemplate = h.runner.view()
  assert.equal(asTemplate.top.template.file?.name, '周报 范本.docx')
  assert.equal(asTemplate.top.materials.files.length, 0)
  const h2 = harness()
  const two = h2.write(join(h2.root, '材料.docx'), 'z')
  h2.runner.opened({ paths: [two] })
  const asMaterial = h2.runner.view()
  assert.equal(asMaterial.top.template.file, null)
  assert.equal(asMaterial.top.materials.files.length, 1)
})

test('g Low 的 node：内容一致、不是硬链接、被改过会重拷、交给 protectRuntime 的是它', async () => {
  const h = harness()
  const file = h.write(join(h.root, '甲.docx'), 'x')
  h.runner.drop([file], 'materials')
  h.runner.act({ type: 'send', text: '干活' })
  await settled(h.runner, 'done')
  assert.equal(existsSync(h.nodeLow), true)
  assert.equal(readFileSync(h.nodeLow, 'utf8'), readFileSync(h.nodeSource, 'utf8'))
  assert.equal(lstatSync(h.nodeLow).nlink, 1)
  assert.equal(h.seen.guard[0].nodePath, h.nodeLow)
  assert.notEqual(h.seen.guard[0].nodePath, h.nodeSource)
  assert.equal(h.seen.feed[0].node, undefined)
  writeFileSync(h.nodeLow, 'X' + readFileSync(h.nodeLow, 'utf8').slice(1))
  h.runner.act({ type: 'retry' })
  await settled(h.runner, 'done')
  assert.equal(readFileSync(h.nodeLow, 'utf8'), readFileSync(h.nodeSource, 'utf8'))
  assert.equal(h.seen.guard.length, 2)
  assert.equal(h.seen.prepare.length, 1)
})

test('h tagged\ 下的不出卡：baseline 用真 snapshotWorkspace（Windows 是反斜杠）；改旧文件出新卡', async () => {
  const taggedRel = join('tagged', 'S01-甲.txt')
  const h = harness({
    snapshotWorkspace: (dir) => realSnapshot(dir),
    runTask: (options, seen, kit) => {
      // 这轮报了两个 artifact：一个 tagged 里的内部文件、一个上一轮留下的旧稿
      options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: join(h.ws, 'tagged', 'S01-甲.txt'), name: 'S01-甲.txt', pages: 1 })
      options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: join(h.ws, '周报.docx'), name: '周报.docx', pages: 2 })
      options.onEvent({ type: 'usage', taskId: options.taskId, at: 3, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, searches: 0 })
      return { sessionId: 's1', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
    },
  })
  const file = h.write(join(h.root, '甲.docx'), 'x')
  h.write(join(h.ws, 'tagged', 'S01-甲.txt'), '标记')
  h.write(join(h.ws, '周报.docx'), '第一轮的稿')
  h.disk.files = [taggedRel, '周报.docx']
  h.runner.drop([file], 'materials')
  h.runner.act({ type: 'send', text: '改上一轮的稿' })
  await settled(h.runner, 'done')
  // 传给 finishTask 的 snapshot：旧稿减掉（算新产出）、tagged 留着（不出卡）
  assert.deepEqual(h.seen.finish[0].snapshot, [taggedRel])
  const v = h.runner.view()
  assert.equal(v.bottom.cards.length, 1)
  assert.equal(v.bottom.cards[0].name, '周报.docx')
  assert.ok(v.bottom.cards.every((card) => !/^S\d+-/.test(card.name)))
})

test('i 原件被动过不出卡、说人话；拷文件被锁也给人话', async () => {
  const changed = harness({ finishTask: () => ({ ok: false, changed: [{ path: 'C:/材料/甲.docx' }], outputs: [] }) })
  changed.runner.act({ type: 'send', text: '干活' })
  await settled(changed.runner, 'error')
  let v = changed.runner.view()
  assert.equal(v.flow[v.flow.length - 1].text, TEXT.changed('甲.docx'))
  assert.equal(v.bottom.cards.length, 0)
  const locked = harness({
    prepareTask: () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY', path: 'C:/材料/乙.docx' })
    },
  })
  locked.runner.act({ type: 'send', text: '干活' })
  await settled(locked.runner, 'error')
  v = locked.runner.view()
  assert.equal(v.flow[v.flow.length - 1].text, TEXT.locked('乙.docx'))
})

test('j 文件夹装上才记最近；recent 只认列表里的；打开只认视图里出现过的路径', async () => {
  const h = harness({ recent: ['C:/旧的'] })
  const folder = join(h.root, '材料夹')
  h.write(join(folder, '甲.docx'), 'x')
  h.write(join(folder, '笔记.txt'), 'y')
  h.write(join(folder, '.隐藏.txt'), 'h')
  h.write(join(folder, '图.png'), 'p')
  h.runner.drop([folder], 'materials')
  let v = h.runner.view()
  assert.equal(v.top.path.title, folder)
  assert.equal(v.top.materials.files.length, 2)
  assert.deepEqual(h.seen.recent[h.seen.recent.length - 1], [folder, 'C:/旧的'])
  h.runner.act({ type: 'recent', dir: 'C:/没在列表里' })
  assert.equal(h.runner.view().top.materials.files.length, 2)
  h.runner.act({ type: 'open-folder', path: folder })
  assert.deepEqual(h.seen.open, { path: folder, reveal: false })
  h.seen.open = null
  h.runner.act({ type: 'open', path: 'C:/没出现过的.docx' })
  assert.equal(h.seen.open, null)
})

test('k 没 key 一上来就说，不拷文件不拷 node 不 protect；reviewDocx 抛错这张卡 cite 为 null 不算失败', async () => {
  const noKey = harness({ noKey: true })
  noKey.runner.act({ type: 'send', text: '干活' })
  await settled(noKey.runner, 'error')
  let v = noKey.runner.view()
  assert.equal(v.flow[v.flow.length - 1].text, TEXT.fail.key)
  assert.deepEqual(v.flow[v.flow.length - 1].buttons.map((b) => b.action), ['settings', 'retry'])
  assert.equal(noKey.seen.run.length, 0)
  assert.equal(noKey.seen.prepare.length, 0)
  assert.equal(noKey.seen.guard.length, 0)
  assert.equal(existsSync(noKey.nodeLow), false)
  const brokenCite = harness({
    runTask: (options, seen, kit) => {
      kit.disk.files = ['报告.md']
      return { sessionId: 's', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
    },
    reviewDocx: () => { throw new Error('出处核对没有完成') },
  })
  const material = brokenCite.write(join(brokenCite.root, '甲.docx'), 'x')
  brokenCite.runner.drop([material, extra(brokenCite)], 'materials')
  brokenCite.runner.act({ type: 'send', text: '干活' })
  await settled(brokenCite.runner, 'done')
  v = brokenCite.runner.view()
  assert.equal(v.bottom.cards.length, 1)
  // 核对没成：标记剥干净再交，卡上说一句出处没核上
  assert.equal(v.bottom.cards[0].cite.text, '出处没核上')
})

test('p1 文件夹任务挪进范本格：范本的工作区副本留着，prepareFeed 拿到的是工作区那份', async () => {
  const h = harness({
    prepareTask: (input, seen) => {
      seen.prepare.push(input)
      const src = input.paths[0]
      // 像 prepareTask 真的那样：文件夹任务把第一层每份都真拷进工作区
      const files = input.paths.length === 1
        ? readdirSync(src).sort((a, b) => a.localeCompare(b, 'zh')).map((name) => join(src, name))
        : input.paths
      const copied = files.map((from) => {
        const to = join(h.ws, basename(from))
        mkdirSync(h.ws, { recursive: true })
        copyFileSync(from, to)
        return { from, to }
      })
      return { kind: 'folder', workspace: h.ws, outputDir: join(h.ws, '桌伴输出'), copied, skipped: [], originals: [], snapshot: [] }
    },
  })
  const folder = join(h.root, '材料夹')
  h.write(join(folder, '范本.docx'), 'x')
  h.write(join(folder, '甲.md'), 'y')
  h.runner.drop([folder], 'materials')
  h.runner.act({ type: 'move', path: join(folder, '范本.docx'), to: 'template' })
  h.runner.act({ type: 'send', text: '照范本写周报' })
  await settled(h.runner, 'done')
  assert.equal(existsSync(join(h.ws, '范本.docx')), true) // 被删掉就是这条坏了
  assert.equal(h.seen.feed[0].template, join(h.ws, '范本.docx'))
  assert.deepEqual(h.seen.feed[0].materials, [join(h.ws, '甲.md')])
  assert.equal(h.seen.run[0].prompt, '带标记的提示')
})

test('p4a 文件夹第一层的 Word / WPS 临时文件（~$ 开头）不进材料格', () => {
  const h = harness()
  const folder = join(h.root, '材料夹')
  h.write(join(folder, '~$临时.docx'), 'x')
  h.write(join(folder, '.~临时.docx'), 'y')
  h.write(join(folder, '要点.md'), 'z')
  h.runner.drop([folder], 'materials')
  const names = h.runner.view().top.materials.files.map((f) => f.name)
  assert.deepEqual(names, ['要点.md'])
})

test('p6b 核出处时点停下：立刻 stopped，之后不出卡、不出错、不收尾', async () => {
  let release
  const gate = new Promise((done) => { release = done })
  const h = harness({
    runTask: (options, seen, kit) => {
      h.disk.files = ['周报.docx']
      options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: join(h.ws, '周报.docx'), name: '周报.docx', pages: 2 })
      return { sessionId: 's1', cancel() { this.cancelled = true }, done: Promise.resolve(kit.doneRun(options, 'done')) }
    },
    reviewDocx: async (input, seen) => {
      seen.review.push(input)
      await gate
      return { verified: 1, missed: 0, docx: input.docx }
    },
  })
  const file = h.write(join(h.root, '甲.docx'), 'x')
  h.runner.drop([file, extra(h)], 'materials')
  h.runner.act({ type: 'send', text: '干活' })
  await until(() => h.seen.review.length === 1) // 正在核出处
  assert.equal(h.runner.view().phase, 'working')
  h.runner.act({ type: 'stop' })
  assert.equal(h.runner.view().phase, 'stopped') // 不等核完，立刻停
  release()
  await delay(120)
  const v = h.runner.view()
  assert.equal(v.phase, 'stopped')
  assert.equal(v.bottom.cards.length, 0)
  assert.equal(v.flow[v.flow.length - 1].text, TEXT.stopped)
  assert.ok(!v.flow.some((one) => one.kind === 'error'))
})

test('p6a 停下后上一轮没退完：重来先排队，停下对排队的那一轮也立刻生效', async () => {
  let release
  const gate = new Promise((done) => { release = done })
  const h = harness({
    prepareFeed: async (input, seen) => {
      seen.feed.push(input)
      await gate
      return { prompt: '带标记的提示', chunks: [{ index: 1, marker: 'S01', text: 'x' }] }
    },
  })
  const file = h.write(join(h.root, '甲.docx'), 'x')
  h.runner.drop([file], 'materials')
  h.runner.act({ type: 'send', text: '干活' })
  await until(() => h.seen.feed.length === 1) // 第一轮的 prepareFeed 还在跑
  h.runner.act({ type: 'stop' })
  assert.equal(h.runner.view().phase, 'stopped')
  h.runner.act({ type: 'retry' }) // 第二轮要等第一轮的 python 退完
  assert.equal(h.runner.view().phase, 'working')
  await delay(150)
  assert.equal(h.seen.feed.length, 1) // 没有第二个 prepareFeed 在同时写 tagged/
  h.runner.act({ type: 'stop' }) // 对还在等的那一轮立刻生效
  assert.equal(h.runner.view().phase, 'stopped')
  release()
  await delay(200)
  assert.equal(h.seen.feed.length, 1) // 醒来悄悄收手：一次 prepareFeed / runTask 都没再起
  assert.equal(h.seen.run.length, 0)
  assert.equal(h.runner.view().phase, 'stopped')
})

test('p5 重来等上一轮退完再碰工作区；收下也等它退完再清场', async () => {
  let release
  const gate = new Promise((done) => { release = done })
  const h = harness({
    prepareFeed: async (input, seen) => {
      seen.feed.push(input)
      await gate
      return { prompt: '带标记的提示', chunks: [{ index: 1, marker: 'S01', text: 'x' }] }
    },
  })
  const file = h.write(join(h.root, '甲.docx'), 'x')
  h.runner.drop([file], 'materials')
  h.runner.act({ type: 'send', text: '干活' })
  await until(() => h.seen.feed.length === 1)
  h.runner.act({ type: 'stop' })
  h.runner.act({ type: 'retry' })
  await delay(120)
  assert.equal(h.seen.feed.length, 1)
  release() // 第一轮退完 → 第二轮才开始自己的 prepareFeed
  await until(() => h.seen.feed.length === 2)
  await settled(h.runner, 'done')
  assert.equal(h.seen.run.length, 1)
  assert.equal(h.seen.run[0].workspace, h.ws)
})

test('p5b 一轮没退完（停在核出处）时收下：等它退完再清场', async () => {
  let release
  const gate = new Promise((done) => { release = done })
  const h = harness({
    runTask: (options, seen, kit) => {
      h.disk.files = ['周报.docx']
      options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: join(h.ws, '周报.docx'), name: '周报.docx', pages: 2 })
      return { sessionId: 's1', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
    },
    reviewDocx: async (input, seen) => {
      seen.review.push(input)
      await gate
      return { verified: 1, missed: 0, docx: input.docx }
    },
  })
  const file = h.write(join(h.root, '甲.docx'), 'x')
  h.runner.drop([file, extra(h)], 'materials')
  h.runner.act({ type: 'send', text: '干活' })
  await until(() => h.seen.review.length === 1)
  h.runner.act({ type: 'stop' }) // 这轮停在核出处，尾巴还占着工作区
  const next = h.write(join(h.root, '新.docx'), 'z')
  h.runner.opened({ paths: [next] }) // 收下（排队）
  await delay(120)
  assert.equal(h.seen.clear.length, 0) // 那一轮没退完就不清
  release()
  await until(() => h.seen.clear.length === 1)
  assert.deepEqual(h.seen.clear, [h.ws])
})

test('p6c 选文件对话框炸了不连累主进程：接住、只记日志', async () => {
  const h = harness({ pickFiles: async () => { throw new Error('对话框炸了') } })
  h.runner.act({ type: 'add', cell: 'materials' })
  await until(() => h.seen.log.some((one) => one[0] === 'pick-failed'))
  assert.equal(h.runner.view().phase, 'empty')
})

test('m2 收尾顺序：产出 → 出错 → 结束', async () => {
  const h = harness({
    runTask: (options, seen, kit) => {
      h.disk.files = ['周报.docx']
      options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: join(h.ws, '周报.docx'), name: '周报.docx', pages: 1 })
      options.onEvent({ type: 'error', taskId: options.taskId, at: 5, reason: 'network', message: '没干成：连不上模型那边' })
      return { sessionId: 's1', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'error')) }
    },
  })
  const file = h.write(join(h.root, '甲.docx'), 'x')
  h.runner.drop([file], 'materials')
  h.runner.act({ type: 'send', text: '干活' })
  await settled(h.runner, 'error')
  const withCard = (view) => view.bottom.cards.length === 1
  const withErr = (view) => view.flow.some((one) => one.kind === 'error')
  const iCard = h.seen.views.findIndex(withCard)
  const iErr = h.seen.views.findIndex(withErr)
  assert.ok(iCard !== -1, '出过带产出卡的视图')
  assert.ok(iErr !== -1, '出过带出错的视图')
  assert.ok(iCard < iErr, '产出先喂，出错后喂')
  assert.equal(withErr(h.seen.views[iCard]), false, '出卡时还没说出错')
  const v = h.runner.view()
  assert.equal(v.phase, 'error')
  assert.equal(v.bottom.cards.length, 1)
  assert.equal(v.flow[v.flow.length - 1].text, TEXT.fail.network)
})

test('s1 收下后的打开只开 state 记住的产出目录', async () => {
  const h = harness({
    runTask: (options, seen, kit) => {
      h.disk.files = ['周报.docx']
      return { sessionId: 's1', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
    },
  })
  const file = h.write(join(h.root, '甲.docx'), 'x')
  h.runner.drop([file], 'materials')
  h.runner.act({ type: 'send', text: '写周报' })
  await settled(h.runner, 'done')
  const output = h.runner.view().bottom.cards[0].path
  h.runner.opened({ fresh: true })
  assert.deepEqual(h.runner.view().flow[0].buttons, [{ action: 'open-settled', label: '打开' }])
  h.runner.act({ type: 'open-settled' })
  assert.deepEqual(h.seen.open, { path: dirname(output), reveal: false })
})

test('s2 最近的任务只打开扫到的产出目录，不开新任务；全部任务和白名单也受限', () => {
  const h = harness()
  const out = join(h.root, '桌伴', '任务', '2026-11-05-写周报', '桌伴输出')
  h.write(join(out, '周报.docx'), 'x')
  const listed = h.runner.view().top.recent
  assert.deepEqual(listed.tasks, [{ dir: out, name: '11-05 写周报' }])
  assert.equal(listed.allTasks, join(h.root, '桌伴', '任务'))
  assert.equal(h.seen.run.length, 0)
  h.runner.act({ type: 'open-recent', dir: out })
  assert.deepEqual(h.seen.open, { path: out, reveal: false })
  assert.equal(h.seen.run.length, 0)
  h.seen.open = null
  h.runner.act({ type: 'open-recent', dir: join(h.root, '桌伴', '任务', '别处', '桌伴输出') })
  assert.equal(h.seen.open, null)
  h.runner.act({ type: 'all-tasks', dir: listed.allTasks })
  assert.deepEqual(h.seen.open, { path: listed.allTasks, reveal: false })
  h.seen.open = null
  h.runner.act({ type: 'all-tasks', dir: join(h.root, '别处') })
  assert.equal(h.seen.open, null)
})

test('q1 没材料的 docx 也过一遍字体整理：拿到原话；有范本时核对也带上；炸了不挡出卡', async () => {
  const writing = (h) => (options, seen, kit) => {
    const name = `周报${seen.run.length + 1}.docx` // 每轮写一份新的，别让旧稿占用快照
    h.disk.files = [name]
    options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: join(h.ws, name), name, pages: 2 })
    return { sessionId: 's1', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
  }
  const h = harness({
    runTask: (options, seen, kit) => writing(h)(options, seen, kit),
    tidyDocx: async (input, seen) => { seen.tidy.push(input); return { docx: input.docx, mode: 'all', changed: true } },
  })
  h.runner.act({ type: 'send', text: '写一份周报' }) // 没拖文件：没材料、没范本，没 chunks
  await settled(h.runner, 'done')
  assert.equal(h.seen.tidy.length, 1)
  assert.equal(h.seen.tidy[0].docx, join(h.random, '.后处理', '周报1.docx')) // 字体整理在副本上做
  assert.equal(h.seen.tidy[0].utterance, '写一份周报')
  assert.equal(h.seen.tidy[0].hasTemplate, false)
  assert.equal(h.seen.review.length, 0)
  const v = h.runner.view()
  assert.equal(v.bottom.cards.length, 1)
  assert.equal(v.bottom.cards[0].cite, null)

  const withTemplate = harness({ runTask: (options, seen, kit) => writing(withTemplate)(options, seen, kit) })
  const tpl = withTemplate.write(join(withTemplate.root, '范本.docx'), 'x')
  const mat = withTemplate.write(join(withTemplate.root, '甲.docx'), 'y')
  withTemplate.runner.drop([tpl], 'template')
  withTemplate.runner.drop([mat], 'materials')
  withTemplate.runner.act({ type: 'send', text: '照范本写周报' })
  await settled(withTemplate.runner, 'done')
  assert.equal(withTemplate.seen.review.length, 1)
  assert.equal(withTemplate.seen.review[0].utterance, '照范本写周报')
  assert.equal(withTemplate.seen.review[0].hasTemplate, true)
  assert.equal(withTemplate.seen.tidy.length, 0)

  let boom = false
  const broken = harness({
    runTask: (options, seen, kit) => writing(broken)(options, seen, kit),
    tidyDocx: async () => {
      if (boom) throw new Error('字体整理没有完成')
      return { docx: '', mode: 'all', changed: false }
    },
  })
  broken.runner.act({ type: 'send', text: '写一份周报' })
  await settled(broken.runner, 'done')
  assert.equal(broken.runner.view().bottom.cards.length, 1)
  boom = true
  broken.runner.act({ type: 'send', text: '再写一份' }) // 第二轮没材料，整理炸了：卡照出、cite 空
  await until(() => broken.runner.view().phase === 'done' && broken.runner.view().bottom.cards.length === 2)
  const v2 = broken.runner.view()
  assert.equal(v2.bottom.cards.length, 2)
  assert.ok(v2.bottom.cards.every((card) => card.cite === null))
  assert.ok(broken.seen.log.some((one) => one[0] === 'cite-failed'))
})

test('s69a 模型把周报直接写进「桌伴输出」：出一张卡、核出处、不另拷一份', async () => {
  const h = realWorld({
    deps: {
      runTask: (options, seen, kit) => {
        const docx = h.write(join(h.ws, '桌伴输出', '本周周报.docx'), '带〔S06·p2〕记号的正文')
        options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: docx, name: '本周周报.docx', pages: 3 })
        options.onEvent({ type: 'usage', taskId: options.taskId, at: 3, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, searches: 0 })
        return { sessionId: 's1', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
      },
    },
  })
  const file = h.write(join(h.root, '甲.docx'), 'x')
  h.runner.drop([file, extra(h)], 'materials')
  h.runner.act({ type: 'send', text: '汇成本周周报' })
  await settled(h.runner, 'done')
  const v = h.runner.view()
  const docx = join(h.ws, '桌伴输出', '本周周报.docx')
  assert.equal(v.bottom.cards.length, 1)
  assert.equal(v.bottom.cards[0].name, '本周周报.docx')
  assert.equal(v.bottom.cards[0].path, docx) // 卡上的 to 就是这份文件本身
  assert.equal(v.flow.some((one) => one.kind === 'progress'), false) // 核出处那步不上屏了
  assert.equal(h.seen.review.length, 1)
  assert.equal(h.seen.review[0].docx, join(h.ws, '.后处理', '本周周报.docx')) // 在副本上核，不动交出去的那份
  assert.deepEqual(readdirSync(join(h.ws, '桌伴输出')), ['本周周报.docx']) // 没有第二份副本
})

test('s69b 第二轮：上一轮留在「桌伴输出」里的不重报，只出这一轮那张卡', async () => {
  const h = realWorld({
    deps: {
      runTask: (options, seen, kit) => {
        const name = seen.run.length === 0 ? '本周周报.docx' : '下周计划.docx'
        const docx = h.write(join(h.ws, '桌伴输出', name), `第${seen.run.length}轮的产出`)
        options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: docx, name, pages: 2 })
        options.onEvent({ type: 'usage', taskId: options.taskId, at: 3, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, searches: 0 })
        return { sessionId: 's1', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
      },
    },
  })
  const file = h.write(join(h.root, '甲.docx'), 'x')
  h.runner.drop([file, extra(h)], 'materials')
  h.runner.act({ type: 'send', text: '汇成本周周报' })
  await settled(h.runner, 'done')
  assert.equal(h.runner.view().bottom.cards.length, 1)
  h.runner.act({ type: 'send', text: '再写下周计划' })
  await settled(h.runner, 'done')
  const v = h.runner.view()
  assert.equal(v.bottom.cards.length, 2)
  // 不许出副本：两张卡只指两份正品，路径一条条对上。
  // 别拿整条路径 includes('-2') 判副本：mkdtempSync 的随机后缀碰上 2 开头，路径里就有「-2」，会误报。
  assert.deepEqual(
    v.bottom.cards.map((card) => card.path).sort(),
    [join(h.ws, '桌伴输出', '本周周报.docx'), join(h.ws, '桌伴输出', '下周计划.docx')].sort(),
  )
  assert.equal(h.seen.review.length, 2)
  assert.equal(h.seen.review[1].docx, join(h.ws, '.后处理', '下周计划.docx'))
  assert.deepEqual(readdirSync(join(h.ws, '桌伴输出')).sort(), ['下周计划.docx', '本周周报.docx'])
})

test('s69c 第二轮改写上一轮那份（报了 artifact）：照新的算，不多出副本', async () => {
  const h = realWorld({
    deps: {
      runTask: (options, seen, kit) => {
        const docx = h.write(join(h.ws, '桌伴输出', '本周周报.docx'), seen.run.length === 0 ? '第一版' : '第二版')
        options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: docx, name: '本周周报.docx', pages: 2 })
        options.onEvent({ type: 'usage', taskId: options.taskId, at: 3, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, searches: 0 })
        return { sessionId: 's1', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
      },
    },
  })
  const file = h.write(join(h.root, '甲.docx'), 'x')
  h.runner.drop([file, extra(h)], 'materials')
  h.runner.act({ type: 'send', text: '汇成本周周报' })
  await settled(h.runner, 'done')
  assert.equal(h.runner.view().bottom.cards.length, 1)
  h.runner.act({ type: 'send', text: '改到第二版' })
  await settled(h.runner, 'done')
  const v = h.runner.view()
  const docx = join(h.ws, '桌伴输出', '本周周报.docx')
  assert.equal(v.bottom.cards.length, 2)
  assert.ok(v.bottom.cards.every((card) => card.path === docx))
  assert.deepEqual(readdirSync(join(h.ws, '桌伴输出')), ['本周周报.docx']) // 还是只有这一份
  assert.equal(h.seen.review.length, 2)
  assert.deepEqual(h.seen.review.map((one) => one.docx), [join(h.ws, '.后处理', '本周周报.docx'), join(h.ws, '.后处理', '本周周报.docx')])
  assert.equal(readFileSync(docx, 'utf8'), '第二版')
})

test('s69d 拖文件夹：模型写进工作区「桌伴输出」→ 拷到原文件夹的「桌伴输出」，卡上是那份', async () => {
  const folder = join(mkdtempSync(join(tmpdir(), 'sidemate-run-')), '周报 材料')
  let h
  h = realWorld({
    folder,
    deps: {
      runTask: (options, seen, kit) => {
        const docx = h.write(join(h.ws, '桌伴输出', '本周周报.docx'), '写在工作区里的')
        options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: docx, name: '本周周报.docx', pages: 2 })
        options.onEvent({ type: 'usage', taskId: options.taskId, at: 3, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, searches: 0 })
        return { sessionId: 's1', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
      },
    },
  })
  h.write(join(folder, '范本.docx'), 'x')
  h.write(join(folder, '乙.md'), 'y')
  h.runner.drop([folder], 'materials')
  h.runner.act({ type: 'send', text: '照范本写周报' })
  await settled(h.runner, 'done')
  const v = h.runner.view()
  const copied = join(folder, '桌伴输出', '本周周报.docx')
  assert.equal(v.bottom.cards.length, 1)
  assert.equal(v.bottom.cards[0].path, copied)
  assert.equal(existsSync(copied), true)
  assert.equal(readFileSync(copied, 'utf8'), '写在工作区里的')
  assert.equal(h.seen.review[0].docx, join(h.ws, '.后处理', '本周周报.docx'))
  assert.equal(existsSync(join(h.ws, '桌伴输出', '本周周报.docx')), true) // 工作区里那份留着
})

test('s69e 老路子不变：写在工作区根下的照样拷进「桌伴输出」、出卡', async () => {
  const h = realWorld({
    deps: {
      runTask: (options, seen, kit) => {
        h.write(join(h.ws, '报告.md'), '写在根下')
        options.onEvent({ type: 'usage', taskId: options.taskId, at: 3, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, searches: 0 })
        return { sessionId: 's1', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
      },
    },
  })
  const file = h.write(join(h.root, '甲.docx'), 'x')
  h.runner.drop([file, extra(h)], 'materials')
  h.runner.act({ type: 'send', text: '写份小结' })
  await settled(h.runner, 'done')
  const v = h.runner.view()
  const copied = join(h.ws, '桌伴输出', '报告.md')
  assert.equal(v.bottom.cards.length, 1)
  assert.equal(v.bottom.cards[0].path, copied)
  assert.equal(readFileSync(copied, 'utf8'), '写在根下')
  assert.equal(h.seen.review[0].docx, join(h.ws, '.后处理', '报告.md'))
  assert.equal(existsSync(join(h.ws, '报告.md')), true)
})

test('s69f 「随手」里攒着的产出：新任务一份不写就一张卡也不出', async () => {
  const h = realWorld()
  h.write(join(h.random, '桌伴输出', '上周的.docx'), '上一回的')
  h.write(join(h.random, '桌伴输出', '更早的.txt'), '更早的')
  h.runner.act({ type: 'send', text: '聊聊这周' })
  await settled(h.runner, 'done')
  const v = h.runner.view()
  assert.equal(v.bottom.cards.length, 0)
  assert.ok(v.bottom.none.text.startsWith(TEXT.noOutput))
  assert.deepEqual(readdirSync(join(h.random, '桌伴输出')).sort(), ['上周的.docx', '更早的.txt'])
})

test('s69r 真核出处：直接写进「桌伴输出」的周报记号清零、批注 > 0', { skip: !bundled }, async () => {
  const chunk = { marker: '〔S06·p2〕', file: '库存.csv', kind: 'page', locator: '2', index: 6, text: '华东仓铅笔缺货，本周先补货' }
  const h = realWorld({
    deps: {
      prepareFeed: async () => ({ prompt: '带标记的提示', chunks: [chunk] }),
      runTask: (options, seen, kit) => {
        writeMarkedDocx(join(h.ws, '桌伴输出', '本周周报.docx'), '<w:p><w:r><w:t>华东仓铅笔缺货，本周先补货〔S06·p2〕</w:t></w:r></w:p>')
        options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: join(h.ws, '桌伴输出', '本周周报.docx'), name: '本周周报.docx', pages: 2 })
        options.onEvent({ type: 'usage', taskId: options.taskId, at: 3, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, searches: 0 })
        return { sessionId: 's1', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
      },
      reviewDocx: (input) => realReview(input),
    },
  })
  const file = h.write(join(h.root, '甲.docx'), 'x')
  h.runner.drop([file, extra(h)], 'materials')
  h.runner.act({ type: 'send', text: '汇成本周周报' })
  await settled(h.runner, 'done')
  const v = h.runner.view()
  const docx = join(h.ws, '桌伴输出', '本周周报.docx')
  assert.equal(v.bottom.cards.length, 1)
  assert.equal(v.bottom.cards[0].path, docx)
  const xml = readPart(docx, 'word/document.xml')
  const comments = readPart(docx, 'word/comments.xml')
  assert.equal(xml.includes('〔'), false) // 记号清零
  assert.match(xml, /华东仓铅笔缺货/)
  assert.ok((comments.match(/<w:comment /g) || []).length > 0) // 批注 > 0
  assert.match(comments, /库存\.csv/)
  assert.deepEqual(readdirSync(join(h.ws, '桌伴输出')), ['本周周报.docx'])
})

test('z 整套没有未处理的 rejection', () => {
  assert.equal(unhandledRejections, 0)
})

// 核出处在副本上做，交出去的是改好的那份；目标被占着就换带序号的新名
test('核出处在副本上做，交出去的是改好的那份', async () => {
  const folder = join(mkdtempSync(join(tmpdir(), 'sidemate-run-')), '材料')
  let h
  h = realWorld({
    folder,
    deps: {
      reviewDocx: async (input, seen) => {
        seen.review.push(input)
        // 在副本上核：把副本改成核过以后的样子
        writeFileSync(input.docx, '核过的正文')
        return { verified: 3, missed: 0, docx: input.docx }
      },
      runTask: (options, seen, kit) => {
        h.write(join(h.ws, '售后服务方案.docx'), '模型写的正文〔S01·p1〕')
        options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: join(h.ws, '售后服务方案.docx'), name: '售后服务方案.docx', pages: 2 })
        return { sessionId: 's1', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
      },
    },
  })
  h.write(join(folder, '原稿.docx'), 'x')
  h.write(join(folder, '乙.md'), 'y')
  h.runner.drop([folder], 'materials')
  h.runner.act({ type: 'send', text: '照原稿扩写正式点' })
  await settled(h.runner, 'done')
  const v = h.runner.view()
  const delivered = join(folder, '桌伴输出', '售后服务方案.docx')
  assert.equal(v.bottom.cards.length, 1)
  assert.equal(v.bottom.cards[0].path, delivered)
  assert.equal(readFileSync(delivered, 'utf8'), '核过的正文') // 交的是副本改好的那份
  assert.equal(readFileSync(join(h.ws, '售后服务方案.docx'), 'utf8'), '模型写的正文〔S01·p1〕') // 原件不动
  assert.equal(h.seen.review[0].docx, join(h.ws, '.后处理', '售后服务方案.docx'))
})

test('交稿时目标正被 Word 占着：换带序号的新名，卡上指实际交的那份', async () => {
  const folder = join(mkdtempSync(join(tmpdir(), 'sidemate-run-')), '材料')
  let h
  h = realWorld({
    folder,
    deps: {
      runTask: (options, seen, kit) => {
        h.write(join(h.ws, '售后服务方案.docx'), '扩写的正文')
        options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: join(h.ws, '售后服务方案.docx'), name: '售后服务方案.docx', pages: 2 })
        return { sessionId: 's1', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
      },
    },
  })
  h.write(join(folder, '原稿.docx'), 'x')
  // 用户在 Word 里开着上一份「售后服务方案.docx」：只读，拷不进去
  const opened = h.write(join(folder, '桌伴输出', '售后服务方案.docx'), '开着的那份')
  chmodSync(opened, 0o444)
  h.runner.drop([folder], 'materials')
  h.runner.act({ type: 'send', text: '扩写正式点' })
  await settled(h.runner, 'done')
  const v = h.runner.view()
  const saved = join(folder, '桌伴输出', '售后服务方案2.docx')
  assert.equal(v.bottom.cards.length, 1)
  assert.equal(v.bottom.cards[0].name, '售后服务方案2.docx')
  assert.equal(v.bottom.cards[0].path, saved)
  assert.equal(readFileSync(saved, 'utf8'), '扩写的正文')
  assert.equal(readFileSync(opened, 'utf8'), '开着的那份') // 开着的那份没被动
  assert.ok(v.flow.some((one) => one.text.includes('售后服务方案2.docx')), '回话里说清交的是哪一份')
})

test('核对没成：副本上的标记剥干净再交，卡上说出处没核上', async () => {
  const h = harness({
    runTask: (options, seen, kit) => {
      kit.disk.files = ['报告.docx']
      options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: join(h.ws, '报告.docx'), name: '报告.docx', pages: 1 })
      return { sessionId: 's', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
    },
    reviewDocx: () => { throw new Error('出处核对没有完成') },
    stripMarks: async (input, seen) => {
      seen.strip.push(input)
      writeFileSync(input.docx, readFileSync(input.docx, 'utf8').replace(/〔S\d+·[^〕]+〕/g, ''))
      return { docx: input.docx, stripped: 1 }
    },
  })
  const material = h.write(join(h.root, '甲.docx'), 'x')
  h.runner.drop([material, extra(h)], 'materials')
  h.runner.act({ type: 'send', text: '干活' })
  await settled(h.runner, 'done')
  const v = h.runner.view()
  assert.equal(v.bottom.cards.length, 1)
  assert.equal(v.bottom.cards[0].cite.text, '出处没核上')
  assert.equal(h.seen.strip.length, 1)
  assert.equal(h.seen.strip[0].docx, join(h.ws, '.后处理', '报告.docx'))
  assert.ok(h.seen.log.some((one) => one[0] === 'cite-failed'))
})

// 模型的成品先留在工作区里，整轮干完桌伴才拷进「桌伴输出」
test('干活时成品不在「桌伴输出」里，干完了才拷过去', async () => {
  const h = harness({
    runTask: (options, seen, kit) => {
      const docx = h.write(join(h.ws, '售后服务方案.docx'), '写好的稿子')
      kit.disk.files = ['售后服务方案.docx']
      // 干活的时候「桌伴输出」里还没有成品：用户打不开半成品
      assert.equal(existsSync(join(h.ws, '桌伴输出', '售后服务方案.docx')), false)
      options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: docx, name: '售后服务方案.docx', pages: 2 })
      return { sessionId: 's1', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
    },
  })
  const material = h.write(join(h.root, '甲.docx'), 'x')
  h.runner.drop([material, extra(h)], 'materials')
  h.runner.act({ type: 'send', text: '干活' })
  await settled(h.runner, 'done')
  const v = h.runner.view()
  assert.equal(v.bottom.cards.length, 1)
  assert.equal(h.seen.deliver.length, 1)
  assert.equal(h.seen.deliver[0].from, join(h.ws, '.后处理', '售后服务方案.docx'))
  assert.equal(h.seen.deliver[0].outputDir, join(h.ws, '桌伴输出'))
})

// 没给范本、材料里只有一份 .docx 时，这份原稿就当范本；
// 单份材料不打标、不核出处，字体照原稿当范本走
test('只有一份 .docx 材料时当范本：后处理照有范本走', async () => {
  const one = harness({
    prepareTask: (input, seen) => {
      seen.prepare.push(input)
      const copied = input.paths.map((from) => ({ from, to: join(one.ws, basename(from)) }))
      return {
        kind: 'files', workspace: one.ws, outputDir: join(one.ws, '桌伴输出'),
        copied, skipped: [], originals: [], snapshot: [],
      }
    },
    runTask: (options, seen, kit) => {
      one.disk.files = ['扩写稿.docx']
      options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: join(one.ws, '扩写稿.docx'), name: '扩写稿.docx', pages: 2 })
      return { sessionId: 's1', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
    },
    tidyDocx: async (input, seen) => { seen.tidy.push(input); return { docx: input.docx, mode: 'all', changed: true } },
  })
  const only = one.write(join(one.root, '售后服务方案.docx'), 'x')
  one.runner.drop([only], 'materials')
  one.runner.act({ type: 'send', text: '扩写正式点' })
  await settled(one.runner, 'done')
  assert.equal(one.seen.feed[0].template, join(one.ws, '售后服务方案.docx')) // 这份原稿当范本
  assert.equal(one.seen.feed[0].single, true) // 单份材料：不打标
  assert.equal(one.seen.review.length, 0) // 单份材料：不核出处
  assert.equal(one.seen.tidy[0].hasTemplate, true) // 字体不整份换成 Noto Sans SC

  const two = harness({
    prepareTask: (input, seen) => {
      seen.prepare.push(input)
      const copied = input.paths.map((from) => ({ from, to: join(two.ws, basename(from)) }))
      return {
        kind: 'files', workspace: two.ws, outputDir: join(two.ws, '桌伴输出'),
        copied, skipped: [], originals: [], snapshot: [],
      }
    },
    runTask: (options, seen, kit) => {
      two.disk.files = ['扩写稿.docx']
      options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: join(two.ws, '扩写稿.docx'), name: '扩写稿.docx', pages: 2 })
      return { sessionId: 's1', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
    },
  })
  const first = two.write(join(two.root, '售后服务方案.docx'), 'x')
  const second = two.write(join(two.root, '笔记.md'), 'y')
  two.runner.drop([first, second], 'materials')
  two.runner.act({ type: 'send', text: '扩写正式点' })
  await settled(two.runner, 'done')
  assert.equal(two.seen.feed[0].template, '') // 多份材料照旧：没范本
  assert.equal(two.seen.review[0].hasTemplate, false)
})

test('不核出处的 txt 也不带标记出去', async () => {
  const h = harness({
    runTask: (options, seen, kit) => {
      kit.disk.files = ['要点.txt']
      h.write(join(h.ws, '要点.txt'), '第一句〔S01·p1〕第二句')
      options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: join(h.ws, '要点.txt'), name: '要点.txt', pages: 1 })
      return { sessionId: 's1', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
    },
  })
  const material = h.write(join(h.root, '甲.docx'), 'x')
  h.runner.drop([material, extra(h)], 'materials')
  h.runner.act({ type: 'send', text: '干活' })
  await settled(h.runner, 'done')
  assert.equal(h.seen.deliver.length, 1)
  const delivered = h.seen.deliver[0].from
  assert.equal(readFileSync(delivered, 'utf8'), '第一句第二句') // 标记剥掉了
  assert.equal(readFileSync(join(h.ws, '要点.txt'), 'utf8'), '第一句〔S01·p1〕第二句') // 原件不动
})

// 材料恰好一份文档时（让改用户自己那一份稿）：不切块打标、交稿后不核出处不挂批注
test('单份材料：不打标、不核出处，字体照原稿当范本', async () => {
  const h = harness({
    runTask: (options, seen, kit) => {
      h.disk.files = ['扩写稿.docx']
      options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: join(h.ws, '扩写稿.docx'), name: '扩写稿.docx', pages: 2 })
      return { sessionId: 's1', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
    },
    tidyDocx: async (input, seen) => { seen.tidy.push(input); return { docx: input.docx, mode: 'all', changed: true } },
  })
  const only = h.write(join(h.root, '售后服务方案.docx'), 'x')
  h.runner.drop([only], 'materials')
  h.runner.act({ type: 'send', text: '扩写正式点' })
  await settled(h.runner, 'done')
  const v = h.runner.view()
  assert.equal(h.seen.feed.length, 1)
  assert.equal(h.seen.feed[0].single, true) // 单份材料：按「恰好一份」判断，不猜用户要干什么
  assert.equal(h.seen.feed[0].materials.length, 1) // 原稿照旧给模型
  assert.equal(h.seen.review.length, 0) // 不核出处
  assert.equal(h.seen.strip.length, 0) // 不挂批注
  assert.equal(h.seen.tidy.length, 1) // 字体照 A4 整理
  assert.equal(h.seen.tidy[0].hasTemplate, true) // 这份原稿当范本
  assert.equal(v.bottom.cards.length, 1)
  assert.equal(v.bottom.cards[0].cite, null) // 卡上不冒出处
})

// 多份材料照旧打标、照旧核出处
test('多份材料照旧：打标、核对都还在', async () => {
  const h = harness({
    runTask: (options, seen, kit) => {
      h.disk.files = ['汇总稿.docx']
      options.onEvent({ type: 'artifact', taskId: options.taskId, at: 4, path: join(h.ws, '汇总稿.docx'), name: '汇总稿.docx', pages: 2 })
      return { sessionId: 's1', cancel() {}, done: Promise.resolve(kit.doneRun(options, 'done')) }
    },
  })
  const first = h.write(join(h.root, '甲.docx'), 'x')
  const second = h.write(join(h.root, '乙.md'), 'y')
  h.runner.drop([first, second], 'materials')
  h.runner.act({ type: 'send', text: '汇总成一份' })
  await settled(h.runner, 'done')
  const v = h.runner.view()
  assert.equal(h.seen.feed[0].single, false)
  assert.equal(h.seen.feed[0].materials.length, 2)
  assert.equal(h.seen.review.length, 1) // 照旧核出处
  assert.equal(v.bottom.cards.length, 1)
  assert.ok(v.bottom.cards[0].cite)
})

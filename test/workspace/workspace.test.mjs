import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { measure } from '../../build/lines.mjs'
import {
  MAX_FILE_BYTES, MAX_TOTAL_BYTES, OUTPUT_NAME, clearWorkspace, copyOutputs, deliverOutput, findOutputs,
  finishTask, integrityArgs, integrityIsLow, integrityText, isDeskWorkspace, prepareTask, protectRuntime,
  snapshotWorkspace,
} from '../../app/workspace/index.mjs'

const roots = []
const now = new Date(2026, 10, 4)

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function write(path, text) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  return path
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

test('three drop rules put output in the place the design names', () => {
  const root = scratch('sidemate-root-')
  const folder = join(root, '用户 的文件夹')
  const source = write(join(folder, '上周 周报.docx'), '范本')
  write(join(folder, '子目录', '不该拷.md'), '里面')
  const dropped = prepareTask({ paths: [folder], prompt: '汇成本周周报后面这些不要了', root, now })
  assert.equal(dropped.kind, 'folder')
  assert.equal(dropped.sourceDir, folder)
  assert.notEqual(dropped.workspace, folder)
  assert.equal(dropped.outputDir, join(folder, OUTPUT_NAME))
  assert.equal(dropped.workspace.endsWith(join('任务', '2026-11-04-汇成本周周报后面这些不要')), true)
  assert.equal(readFileSync(dropped.copied[0].to, 'utf8'), '范本')
  assert.equal(existsSync(dropped.outputDir), false)
  write(join(dropped.workspace, '本周周报.docx'), '新的')
  const folderDone = finishTask(dropped)
  assert.equal(folderDone.ok, true)
  assert.equal(readFileSync(join(folder, OUTPUT_NAME, '本周周报.docx'), 'utf8'), '新的')
  assert.equal(readFileSync(source, 'utf8'), '范本')

  const file = write(join(root, '桌面', '一份 材料.txt'), '只有这份')
  const files = prepareTask({ paths: [file], prompt: '看一眼', root, now })
  assert.equal(files.kind, 'files')
  assert.equal(files.outputDir, join(files.workspace, OUTPUT_NAME))
  assert.notEqual(files.workspace, join(root, '桌面'))
  write(join(files.workspace, '整理好的.txt'), '产出')
  finishTask(files)
  assert.equal(readFileSync(join(files.outputDir, '整理好的.txt'), 'utf8'), '产出')
  assert.equal(existsSync(join(root, '桌面', OUTPUT_NAME)), false)

  const none = prepareTask({ paths: [], prompt: '随便说说', root, now })
  const again = prepareTask({ paths: [], root, now })
  assert.equal(none.kind, 'none')
  assert.equal(none.workspace, join(root, '随手'))
  assert.equal(again.workspace, none.workspace)
  assert.equal(none.outputDir, join(root, '随手', OUTPUT_NAME))
  write(join(none.workspace, '随手记.md'), '记一下')
  finishTask(none)
  assert.equal(readFileSync(join(none.outputDir, '随手记.md'), 'utf8'), '记一下')
})

test('chinese names, spaces, and a long path all copy', () => {
  const root = scratch('sidemate-long-')
  let dir = join(root, '我的 材料')
  for (let i = 0; i < 6; i += 1) dir = join(dir, `第${i}层 很长的目录`)
  const name = `${'周'.repeat(40)} 报.docx`
  const source = write(join(dir, name), '长路径正文')
  const task = prepareTask({ paths: [source], prompt: '你好 世界', root, now })
  assert.equal(task.copied.length, 1)
  assert.equal(task.copied[0].to.endsWith(name), true)
  assert.equal(readFileSync(task.copied[0].to, 'utf8'), '长路径正文')
  assert.equal(task.copied[0].sha256, task.originals[0].sha256)
  assert.equal(task.workspace.endsWith(join('任务', '2026-11-04-你好 世界')), true)
})

test('copy keeps the first level, skips env, links, and the wrong type', (t) => {
  const root = scratch('sidemate-copy-')
  const folder = join(root, '材料')
  write(join(folder, '笔记.MD'), '正文')
  write(join(folder, '.env'), 'DSH_HOME=/tmp/nope')
  write(join(folder, '照片.png'), 'png')
  write(join(folder, '空.txt'), '')
  write(join(folder, '子目录', '里面.docx'), '不拷')
  const outside = write(join(root, '外面.docx'), '链接目标-不该出现')
  const linkPath = join(folder, '联接.docx')
  const linked = tryLink(t, outside, linkPath)
  const task = prepareTask({ paths: [folder], prompt: '汇成/本周:周报', root, now })
  const names = task.copied.map(item => item.to.split(/[/\\]/).pop()).sort()
  assert.deepEqual(names, ['空.txt', '笔记.MD'])
  assert.equal(task.workspace.includes('汇成本周周报'), true)
  assert.equal(task.skipped.some(item => item.reason === '环境文件'), true)
  if (linked) assert.equal(task.skipped.some(item => item.reason === '链接'), true)
  assert.equal(task.skipped.some(item => item.reason === '类型不对' && item.path.endsWith('照片.png')), true)
  assert.equal(task.skipped.some(item => item.reason === '不是文件'), false)
  assert.equal(task.originals.some(item => item.path.endsWith('.env')), true)
  assert.equal(task.originals.some(item => item.path.endsWith('里面.docx')), false)
  assert.equal(readFileSync(outside, 'utf8'), '链接目标-不该出现')
  if (linked) {
    const again = prepareTask({ paths: [linkPath], prompt: '链接', root, now })
    assert.equal(again.copied.length, 0)
    assert.equal(again.skipped[0].reason, '链接')
  }
})

test('a file or a batch over the cap is left out and still watched', () => {
  const root = scratch('sidemate-cap-')
  const folder = join(root, '材料')
  const small = write(join(folder, 'a.txt'), '12345678')
  const also = write(join(folder, 'b.txt'), 'abcdefgh')
  const huge = write(join(folder, 'c.txt'), '123456789')
  const task = prepareTask({
    paths: [folder],
    prompt: '上限',
    root,
    now,
    maxFileBytes: 8,
    maxTotalBytes: 12,
  })
  assert.equal(task.copied.length, 1)
  assert.equal(task.copied[0].from, small)
  assert.equal(task.skipped.filter(item => item.reason === '太大').map(item => item.path).sort().join(), [also, huge].sort().join())
  assert.equal(task.originals.length, 3)
  const watched = task.originals.find(item => item.path === huge)
  assert.equal(watched.sha256, null)
  assert.equal(finishTask(task).ok, true)
  writeFileSync(huge, '1234567890')
  const moved = finishTask(task)
  assert.equal(moved.ok, false)
  assert.equal(moved.changed.some(item => item.path === huge), true)
  assert.equal(MAX_FILE_BYTES, 32 * 1024 * 1024)
  assert.equal(MAX_TOTAL_BYTES, 128 * 1024 * 1024)
})

test('two sources with the same name and a repeat output get a number', () => {
  const root = scratch('sidemate-name-')
  const first = write(join(root, '甲', '周报.docx'), '甲')
  const second = write(join(root, '乙', '周报.docx'), '乙')
  const task = prepareTask({ paths: [first, second], prompt: '两份', root, now })
  const names = task.copied.map(item => item.to.split(/[/\\]/).pop()).sort()
  assert.deepEqual(names, ['周报-2.docx', '周报.docx'])
  write(join(task.workspace, '子', '周报.docx'), '新甲')
  write(join(task.workspace, '又', '周报.docx'), '新乙')
  mkdirSync(task.outputDir, { recursive: true })
  write(join(task.outputDir, '周报.docx'), '已经有了')
  const done = finishTask(task, { artifacts: [{ path: join(task.workspace, '子', '周报.docx'), pages: 3 }] })
  assert.equal(readFileSync(join(task.outputDir, '周报.docx'), 'utf8'), '已经有了')
  const made = done.outputs.map(item => item.name).sort()
  // 「桌伴输出」里那份是提前放进去的：也在快照之外，照直接写进去的算，卡上指它本身，不覆盖内容
  assert.deepEqual(made, ['周报-2.docx', '周报-3.docx', '周报.docx'])
  const paged = done.outputs.find(item => item.pages === 3)
  assert.equal(paged.name.startsWith('周报-'), true)
  const inPlace = done.outputs.find(item => item.name === '周报.docx')
  assert.equal(inPlace.to, join(task.outputDir, '周报.docx'))
  assert.equal(inPlace.from, inPlace.to)
  assert.equal(readFileSync(inPlace.to, 'utf8'), '已经有了')
  const next = finishTask(task, { snapshot: done.snapshot })
  assert.deepEqual(next.outputs, [])
})

test('a changed original is marked red and the output stays put', () => {
  const root = scratch('sidemate-hash-')
  const folder = join(root, '材料')
  const source = write(join(folder, '原件.txt'), '原文')
  const other = write(join(folder, '另一份.txt'), '也是')
  const task = prepareTask({ paths: [folder], prompt: '核', root, now })
  write(join(task.workspace, '结果.txt'), '新')
  const same = finishTask(task)
  assert.equal(same.ok, true)
  assert.equal(same.mark, '')
  assert.equal(same.outputs.length, 1)
  writeFileSync(source, '改了')
  writeFileSync(other, '也改了')
  const again = prepareTask({ paths: [folder], prompt: '核', root, now })
  write(join(again.workspace, '结果.txt'), '又一份')
  writeFileSync(source, '再改')
  unlinkSafe(other)
  const bad = finishTask(again)
  assert.equal(bad.ok, false)
  assert.equal(bad.mark, 'red')
  assert.match(bad.message, /^原件被动过了：/)
  assert.match(bad.message, /原件\.txt/)
  assert.match(bad.message, /另一份\.txt/)
  assert.equal(bad.outputs.length, 0)
  assert.equal(readFileSync(join(again.outputDir, '结果.txt'), 'utf8'), '新')
  assert.equal(existsSync(join(again.outputDir, '结果-2.txt')), false)
  assert.equal(bad.changed.find(item => item.path === other).after, null)
})

test('editing a copy is not a new output, and a link is not exported', (t) => {
  const root = scratch('sidemate-edit-')
  const source = write(join(root, '材料.txt'), '原文')
  const task = prepareTask({ paths: [source], prompt: '改副本', root, now })
  writeFileSync(task.copied[0].to, '副本改了')
  const outside = write(join(root, '别放.docx'), '别动')
  const linked = tryLink(t, outside, join(task.workspace, '指向.docx'))
  write(join(task.workspace, '真产出.docx'), '新文件')
  const done = finishTask(task)
  assert.deepEqual(done.outputs.map(item => item.name), ['真产出.docx'])
  assert.equal(readFileSync(source, 'utf8'), '原文')
  if (linked) assert.equal(readFileSync(outside, 'utf8'), '别动')
})

test('an output folder that is a link is refused', (t) => {
  const root = scratch('sidemate-outlink-')
  const source = write(join(root, '材料.txt'), '原文')
  const task = prepareTask({ paths: [source], prompt: '产出', root, now })
  const outside = join(root, '真实产出')
  mkdirSync(outside)
  const linked = tryLink(t, outside, task.outputDir, 'dir')
  write(join(task.workspace, '结果.docx'), '新')
  assert.equal(readFileSync(source, 'utf8'), '原文')
  if (!linked) return
  assert.throws(() => finishTask(task), /产出位置不对/)
  assert.equal(existsSync(join(outside, '结果.docx')), false)
})

test('cleanup removes the workspace file by file and keeps output', (t) => {
  const root = scratch('sidemate-clear-')
  const source = write(join(root, '用户', '原件.txt'), '留着')
  const task = prepareTask({ paths: [source], prompt: '清', root, now })
  write(join(task.workspace, '一层', '二层.txt'), '删')
  const outside = write(join(root, '链接目标.txt'), '不能删')
  const linked = tryLink(t, outside, join(task.workspace, '链出去.txt'))
  write(join(task.workspace, OUTPUT_NAME, '留下.txt'), '产出')
  clearWorkspace(task.workspace, root)
  assert.equal(existsSync(join(task.workspace, '一层')), false)
  if (linked) assert.equal(existsSync(join(task.workspace, '链出去.txt')), false)
  assert.equal(readFileSync(outside, 'utf8'), '不能删')
  assert.equal(readFileSync(join(task.workspace, OUTPUT_NAME, '留下.txt'), 'utf8'), '产出')
  assert.equal(readFileSync(source, 'utf8'), '留着')
  clearWorkspace(task.workspace, root)
  assert.equal(existsSync(task.workspace), true)

  const empty = prepareTask({ paths: [], root, now })
  write(join(empty.workspace, '临时.txt'), 'x')
  clearWorkspace(empty.workspace, root)
  assert.equal(existsSync(empty.workspace), true)
  assert.equal(existsSync(join(empty.workspace, '临时.txt')), false)
  clearWorkspace(join(root, '任务', '还没有'), root)

  const user = scratch('sidemate-user-')
  write(join(user, '我的.txt'), '我的')
  assert.throws(() => clearWorkspace(user, root), /只能清桌伴自己的工作区/)
  assert.throws(() => clearWorkspace(join(root, '随手', '没有'), root), /只能清桌伴自己的工作区/)
  assert.equal(readFileSync(join(user, '我的.txt'), 'utf8'), '我的')
  assert.equal(isDeskWorkspace(join(root, '任务'), root), false)
  assert.equal(isDeskWorkspace(task.workspace, root), true)
})

test('an empty task folder goes away, and a second task gets a number', () => {
  const root = scratch('sidemate-seq-')
  const source = write(join(root, 'a.txt'), 'a')
  const first = prepareTask({ paths: [source], prompt: '同一个', root, now })
  const second = prepareTask({ paths: [source], prompt: '同一个', root, now })
  assert.equal(second.workspace.endsWith('-2'), true)
  clearWorkspace(first.workspace, root)
  assert.equal(existsSync(first.workspace), false)
  const blank = prepareTask({ paths: [source], prompt: '   ???   ', root, now })
  assert.equal(blank.workspace.endsWith('-任务'), true)
})

test('low labels are recognized, and other systems skip the check', () => {
  assert.deepEqual(integrityArgs('file'), ['/setintegritylevel', 'low'])
  assert.deepEqual(integrityArgs('dir'), ['/setintegritylevel', '(OI)(CI)low'])
  assert.equal(integrityIsLow('Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)'), true)
  assert.equal(integrityIsLow('Mandatory Label\\Medium Mandatory Level:(NW)'), false)
  assert.equal(integrityIsLow('S-1-16-4096'), true)
  assert.equal(integrityIsLow('低强制性级别'), true)
  const gbk = Buffer.from([0xb5, 0xcd, 0xc7, 0xbf, 0xd6, 0xc6, 0xd0, 0xd4, 0xbc, 0xb6, 0xb1, 0xf0])
  assert.equal(integrityIsLow(integrityText(gbk)), true)
  const utf16 = Buffer.from('Mandatory Label\\Low Mandatory Level:(NW)\n', 'utf16le')
  assert.equal(integrityIsLow(integrityText(utf16)), true)
  if (process.platform !== 'win32') {
    const root = scratch('sidemate-low-')
    const task = prepareTask({ paths: [], root, now })
    const guard = protectRuntime({ nodePath: process.execPath, workspace: task.workspace })
    assert.equal(guard.ok, true)
    assert.equal(guard.node.skipped, true)
    assert.equal(guard.workspace.skipped, true)
    assert.equal(guard.message.includes('icacls'), false)
  }
})

test('windows labels the runtime and the workspace', { skip: process.platform !== 'win32' }, () => {
  const root = scratch('sidemate-win-low-')
  const nodePath = write(join(root, 'node.exe'), 'not a real runtime')
  const task = prepareTask({ paths: [], root, now })
  const guard = protectRuntime({ nodePath, workspace: task.workspace })
  assert.equal(guard.ok, true, guard.message)
  assert.equal(guard.message.includes('icacls'), false)
  const missing = protectRuntime({ nodePath: join(root, 'missing.exe'), workspace: task.workspace })
  assert.equal(missing.ok, false)
  assert.match(missing.message, /没能限制干活的程序/)
  assert.equal(missing.message.includes('icacls'), false)
})

test('a directory junction is not a workspace and is not copied', { skip: process.platform !== 'win32' }, () => {
  const root = scratch('sidemate-junction-')
  const real = join(root, '真文件夹')
  write(join(real, '原件.txt'), '原件')
  const link = join(root, '联接')
  symlinkSync(real, link, 'junction')
  const task = prepareTask({ paths: [link], prompt: '联接', root, now })
  assert.equal(task.kind, 'files')
  assert.equal(task.copied.length, 0)
  assert.equal(task.skipped[0].reason, '链接')
  assert.equal(readFileSync(join(real, '原件.txt'), 'utf8'), '原件')
})

test('only documents are outputs: scripts and data stay in the workspace', () => {
  const root = scratch('sidemate-docs-')
  const source = write(join(root, '材料.txt'), '原文')
  const task = prepareTask({ paths: [source], prompt: '写周报', root, now })
  write(join(task.workspace, 'a.docx'), '文档')
  write(join(task.workspace, 'build_report.py'), '脚本')
  write(join(task.workspace, 'notes.json'), '{}')
  write(join(task.workspace, '图.PNG'), '图')
  const done = finishTask(task)
  assert.deepEqual(done.outputs.map((item) => item.name).sort(), ['a.docx', '图.PNG'])
  const copied = readdirSync(task.outputDir)
  assert.deepEqual(copied.sort(), ['a.docx', '图.PNG'])
  assert.equal(copied.some((name) => name.endsWith('.py')), false)
  assert.equal(copied.some((name) => name.endsWith('.json')), false)
  // 脚本和配置留在工作区原处，不删不拷
  assert.equal(existsSync(join(task.workspace, 'build_report.py')), true)
  assert.equal(existsSync(join(task.workspace, 'notes.json')), true)
  // 只出了脚本就不算产出：「桌伴输出」也不建
  const only = prepareTask({ paths: [source], prompt: '只写脚本', root, now })
  write(join(only.workspace, 'build_report.py'), '脚本')
  const none = finishTask(only)
  assert.deepEqual(none.outputs, [])
  assert.equal(existsSync(only.outputDir), false)
  assert.equal(existsSync(join(only.workspace, 'build_report.py')), true)
})

test('workspace does not remove a tree in one call and each file stays within the per-file limit', () => {
  const source = readFileSync(new URL('../../app/workspace/index.mjs', import.meta.url), 'utf8')
  assert.equal(/\brmSync\b/.test(source), false)
  const result = measure(['app/workspace'])
  assert.deepEqual(result.errors, [])
})

function tryLink(t, target, path, type) {
  try {
    if (type) symlinkSync(target, path, type)
    else symlinkSync(target, path)
    return true
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
    t.diagnostic('建不了软链（普通用户没有这个权限），跟链接有关的断言跳过')
    return false
  }
}

function unlinkSafe(path) {
  try {
    unlinkSync(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

test('an output the model writes straight into the output folder is seen and kept in place', () => {
  const root = scratch('sidemate-direct-')
  const source = write(join(root, '材料.txt'), '原文')
  const task = prepareTask({ paths: [source], prompt: '写周报', root, now })
  const direct = write(join(task.workspace, OUTPUT_NAME, '本周周报.docx'), '模型直接写的')
  write(join(task.workspace, OUTPUT_NAME, 'build_report.py'), '脚本不算产出')
  // 快照看得见「桌伴输出」里的文件；产出照 isOutputName 的口径认，脚本不算
  const seen = snapshotWorkspace(task.workspace)
  assert.equal(seen.includes(join(OUTPUT_NAME, '本周周报.docx')), true)
  assert.equal(seen.includes(join(OUTPUT_NAME, 'build_report.py')), true)
  const done = finishTask(task, { artifacts: [{ path: direct, pages: 2 }] })
  assert.equal(done.ok, true)
  // 文件已经在该在的地方：卡上指它本身，不另拷一份，也不出现「本周周报-2.docx」
  assert.deepEqual(done.outputs, [{ from: direct, to: direct, name: '本周周报.docx', pages: 2 }])
  assert.deepEqual(readdirSync(task.outputDir).sort(), ['build_report.py', '本周周报.docx'])
  assert.equal(readFileSync(direct, 'utf8'), '模型直接写的')
  assert.equal(done.snapshot.includes(join(OUTPUT_NAME, '本周周报.docx')), true)

  // 第二轮：上一轮留在「桌伴输出」里的不重报、不重拷，只报这一轮新写的
  const fresh = write(join(task.workspace, OUTPUT_NAME, '另一份.docx'), '新的')
  const second = finishTask(task, { snapshot: done.snapshot })
  assert.deepEqual(second.outputs, [{ from: fresh, to: fresh, name: '另一份.docx' }])
  assert.deepEqual(readdirSync(task.outputDir).sort(), ['build_report.py', '另一份.docx', '本周周报.docx'])
})

test('copyOutputs keeps a file already inside the output dir and copies the rest', () => {
  const root = scratch('sidemate-copy-outputs-')
  const ws = join(root, '任务', '2026-11-04-直接写')
  const outputDir = join(ws, OUTPUT_NAME)
  const direct = write(join(outputDir, '本周周报.docx'), '直接写')
  write(join(ws, '报告.md'), '写在根下')
  const made = copyOutputs({ workspace: ws, outputDir, snapshot: [], artifacts: [{ path: direct, pages: 5 }] })
  const byName = Object.fromEntries(made.map((one) => [one.name, one]))
  assert.deepEqual(byName['本周周报.docx'], { from: direct, to: direct, name: '本周周报.docx', pages: 5 })
  assert.equal(byName['报告.md'].from, join(ws, '报告.md'))
  assert.equal(byName['报告.md'].to, join(outputDir, '报告.md'))
  assert.equal(readFileSync(join(outputDir, '报告.md'), 'utf8'), '写在根下')
  assert.deepEqual(readdirSync(outputDir).sort(), ['报告.md', '本周周报.docx'])
})

test('a folder task copies an output the model wrote into the workspace output folder', () => {
  const root = scratch('sidemate-direct-folder-')
  const folder = join(root, '周报 材料')
  write(join(folder, '范本.docx'), '范本')
  const folded = prepareTask({ paths: [folder], prompt: '照范本写', root, now })
  const inside = write(join(folded.workspace, OUTPUT_NAME, '本周周报.docx'), '模型写在工作区的')
  const moved = finishTask(folded)
  assert.equal(moved.ok, true)
  assert.deepEqual(moved.outputs, [{ from: inside, to: join(folder, OUTPUT_NAME, '本周周报.docx'), name: '本周周报.docx' }])
  assert.equal(readFileSync(join(folder, OUTPUT_NAME, '本周周报.docx'), 'utf8'), '模型写在工作区的')
  assert.equal(existsSync(inside), true) // 工作区里那份照旧留着
})

test('outputs saved earlier in the casual workspace are not reported or copied again', () => {
  const root = scratch('sidemate-casual-')
  const kept = write(join(root, '随手', OUTPUT_NAME, '上周的.md'), '上一回的')
  write(join(root, '随手', OUTPUT_NAME, '更早的.txt'), '更早的')
  const casual = prepareTask({ paths: [], prompt: '随便说说', root, now })
  write(join(casual.workspace, '随手记.txt'), '这一回的')
  const done = finishTask(casual)
  assert.deepEqual(done.outputs.map((one) => one.name), ['随手记.txt'])
  assert.equal(done.outputs[0].to, join(casual.outputDir, '随手记.txt'))
  assert.equal(readFileSync(kept, 'utf8'), '上一回的')
  assert.equal(existsSync(join(casual.outputDir, '上周的-2.md')), false)
  assert.deepEqual(readdirSync(casual.outputDir).sort(), ['上周的.md', '更早的.txt', '随手记.txt'])
})

test('word and wps temp files are neither copied nor remembered', () => {
  const root = scratch('sidemate-temp-')
  const folder = join(root, '材料夹')
  write(join(folder, '~$临时.docx'), 'word-temp')
  write(join(folder, '.~临时.docx'), 'wps-temp')
  write(join(folder, '要点.md'), '正文')
  const task = prepareTask({ paths: [folder], prompt: '整理材料', root, now })
  assert.deepEqual(task.copied.map(item => item.to.split(/[/\\]/).pop()), ['要点.md'])
  assert.equal(task.originals.length, 1)
  assert.ok(task.originals[0].path.endsWith('要点.md'))
  assert.equal(task.skipped.filter(item => item.reason === '临时文件').length, 2)
  // 文档关掉、临时文件消失以后，也不许算成「原件被人改过」
  unlinkSync(join(folder, '~$临时.docx'))
  unlinkSync(join(folder, '.~临时.docx'))
  const fin = finishTask(task, { snapshot: task.snapshot, artifacts: [] })
  assert.equal(fin.ok, true)
})

// Word 开着文档时留下的锁文件（~$ 开头、.~ 开头）不是产出，核对和收产出都不认它
test('word and wps lock files in the workspace are not outputs', () => {
  const root = scratch('sidemate-lock-')
  const source = write(join(root, '材料.txt'), '原文')
  const task = prepareTask({ paths: [source], prompt: '写周报', root, now })
  write(join(task.workspace, '本周周报.docx'), '真的产出')
  write(join(task.workspace, '~$本周周报.docx'), 'word 开着')
  write(join(task.workspace, '.~本周周报.docx'), 'wps 开着')
  write(join(task.outputDir, '上周周报.docx'), '上一回的')
  write(join(task.outputDir, '~$上周周报.docx'), 'word 开着')
  const seen = snapshotWorkspace(task.workspace)
  assert.equal(seen.some((rel) => rel.includes('~$')), false)
  assert.equal(seen.some((rel) => rel.includes('.~')), false)
  const found = findOutputs({ workspace: task.workspace, snapshot: task.snapshot })
  assert.deepEqual(found.map((one) => one.name).sort(), ['上周周报.docx', '本周周报.docx'])
  assert.equal(found.some((one) => one.name.includes('~$')), false)
  assert.equal(found.some((one) => one.name.includes('.~')), false)
  const done = finishTask(task, { snapshot: task.snapshot })
  assert.deepEqual(done.outputs.map((one) => one.name).sort(), ['上周周报.docx', '本周周报.docx'])
  assert.equal(readdirSync(task.outputDir).includes('~$上周周报.docx'), true) // 锁文件原样留着
})

// 目标被别的程序占着就换带序号的新名，交出去的是新名那份
test('a locked output is saved under a new name with a number', () => {
  const root = scratch('sidemate-locked-')
  const out = join(root, '产出')
  const staged = write(join(root, '副本.docx'), '整理好的稿子')
  const target = write(join(out, '周报.docx'), '开着的那份')
  chmodSync(target, 0o444) // 只读：拷不进去，就像 Word 开着一样
  const done = deliverOutput({ outputDir: out, from: staged, name: '周报.docx' })
  assert.equal(done.locked, true)
  assert.equal(done.name, '周报2.docx')
  assert.equal(done.to, join(out, '周报2.docx'))
  assert.equal(readFileSync(done.to, 'utf8'), '整理好的稿子')
  assert.equal(readFileSync(target, 'utf8'), '开着的那份') // 原样不动
})

test('a free output keeps its name, and a second one in the same round gets a number', () => {
  const root = scratch('sidemate-deliver-')
  const out = join(root, '产出')
  const first = deliverOutput({ outputDir: out, from: write(join(root, 'a.docx'), '一'), name: '周报.docx' })
  assert.equal(first.name, '周报.docx')
  assert.equal(first.locked, false)
  const second = deliverOutput({ outputDir: out, from: write(join(root, 'b.docx'), '二'), name: '周报.docx', used: ['周报.docx'] })
  assert.equal(second.name, '周报2.docx')
  assert.equal(readFileSync(second.to, 'utf8'), '二')
  assert.equal(readFileSync(first.to, 'utf8'), '一')
})

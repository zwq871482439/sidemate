import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { TextDecoder } from 'node:util'

// 工作区和原件。dsh 只在 ~/桌伴/任务 或 ~/桌伴/随手 里干活，绝不把用户的文件夹当工作区。
// 顺序：prepareTask → protectRuntime → 驱动层起进程 → finishTask。用户收完再 clearWorkspace。
// 清目录逐个删。dsh 改过权限以后，一次删一整棵会报成功，其实还在。

export const OUTPUT_NAME = '桌伴输出'
export const MATERIAL_EXTENSIONS = Object.freeze(['.docx', '.xlsx', '.pptx', '.pdf', '.csv', '.md', '.txt'])
// 只有文档类算产出：脚本、配置这些留在工作区原处，不拷、不出卡。名单只此一处，state.mjs 也用它。
export const OUTPUT_EXTENSIONS = Object.freeze(['.docx', '.doc', '.xlsx', '.xls', '.csv', '.pptx', '.ppt', '.pdf', '.txt', '.md', '.rtf', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'])
// 这张卡定的上限：一个文件 32 MiB，一次任务合计 128 MiB。超过的不拷。
export const MAX_FILE_BYTES = 32 * 1024 * 1024
export const MAX_TOTAL_BYTES = 128 * 1024 * 1024

const EXTENSIONS = new Set(MATERIAL_EXTENSIONS)
const OUTPUT_EXT_SET = new Set(OUTPUT_EXTENSIONS)
// 主产出：这一轮真正交给用户的成品。同一轮里出了这样的，中间文件（txt）就不算出产。
export const DELIVERABLE_EXTENSIONS = Object.freeze(['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.pdf', '.rtf'])
const DELIVERABLE_EXT_SET = new Set(DELIVERABLE_EXTENSIONS)

// 按扩展名认产出，不分大小写
export function isOutputName(name) {
  return OUTPUT_EXT_SET.has(extname(String(name || '')).toLowerCase())
}

// 按扩展名认主产出，不分大小写
export function isDeliverable(name) {
  return DELIVERABLE_EXT_SET.has(extname(String(name || '')).toLowerCase())
}
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
// Word / WPS 开着文档时的临时文件：~$ 开头、.~ 开头。收产出时也不认它们
const LOCKED_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])

export function isTempName(name) {
  const text = String(name || '')
  return text.startsWith('~') || text.startsWith('.~')
}
const LOW_LABEL = /low mandatory level|低强制|s-1-16-4096/i

export function deskRoot(home = homedir()) {
  return join(home, '桌伴')
}

export function integrityArgs(kind) {
  if (kind === 'dir') return ['/setintegritylevel', '(OI)(CI)low']
  return ['/setintegritylevel', 'low']
}

export function integrityIsLow(text) {
  return LOW_LABEL.test(text || '')
}

export function integrityText(buf) {
  const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''))
  const parts = [raw.toString('utf8'), raw.toString('latin1')]
  try {
    parts.push(new TextDecoder('gbk').decode(raw))
  } catch {
    // 没有 gbk 时仍认英文标签
  }
  return parts.join('\n').replace(/\u0000/g, '')
}

function dayStamp(now) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function slug(prompt) {
  const cleaned = [...(prompt || '')]
    .filter(ch => ch.codePointAt(0) >= 32 && !'\\/:*?"<>|'.includes(ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  const cut = [...cleaned].slice(0, 12).join('').replace(/[. ]+$/g, '')
  const name = cut || '任务'
  return RESERVED.test(name) ? `${name}_` : name
}

function contained(parent, target) {
  const rel = relative(resolve(parent), resolve(target))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function isDeskWorkspace(dir, root = deskRoot()) {
  const target = resolve(dir)
  if (target === resolve(root, '随手')) return true
  const rel = relative(resolve(root, '任务'), target)
  return rel.length > 0 && rel !== '..' && !rel.includes('/') && !rel.includes('\\') && !isAbsolute(rel)
}

function isRealDir(path) {
  try {
    const st = lstatSync(path)
    return st.isDirectory() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

function hashFile(path) {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(64 * 1024)
    let n = 0
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n))
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

function fingerprint(path, maxRead) {
  try {
    const st = lstatSync(path)
    if (!st.isFile() || st.isSymbolicLink()) return null
    // 超过单个上限的不整份读，用大小和修改时间盯着，避免开工前把一个很大的文件读完。
    if (st.size > maxRead) return { path, sha256: null, size: st.size, mtimeMs: st.mtimeMs }
    return { path, sha256: hashFile(path), size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

function limitsOf(input) {
  return {
    maxFileBytes: input.maxFileBytes ?? MAX_FILE_BYTES,
    maxTotalBytes: input.maxTotalBytes ?? MAX_TOTAL_BYTES,
  }
}

function taskDir(root, prompt, now) {
  const parent = join(root, '任务')
  mkdirSync(parent, { recursive: true })
  const base = `${dayStamp(now)}-${slug(prompt)}`
  let name = base
  for (let n = 2; existsSync(join(parent, name)); n += 1) name = `${base}-${n}`
  return join(parent, name)
}

function classify(paths) {
  if (paths.length === 0) return 'none'
  if (paths.length === 1 && isRealDir(paths[0])) return 'folder'
  return 'files'
}

function sourceList(kind, paths) {
  if (kind === 'none') return []
  if (kind === 'folder') {
    try {
      return readdirSync(paths[0]).sort((a, b) => a.localeCompare(b, 'zh')).map(name => join(paths[0], name))
    } catch {
      throw new Error('读不到这个文件夹')
    }
  }
  return paths
}

function judge(path, limits) {
  let st
  try {
    st = lstatSync(path)
  } catch {
    return { take: 'skip', reason: '找不到' }
  }
  // 符号链接和目录联接不拷。硬链接看起来像普通文件，拷走的是内容，链接关系不进工作区。
  if (st.isSymbolicLink()) return { take: 'skip', reason: '链接' }
  if (!st.isFile()) return { take: 'skip', reason: '不是文件' }
  const name = basename(path)
  if (name.toLowerCase() === '.env') return { take: 'watch', reason: '环境文件', size: st.size }
  // Word / WPS 开着文档时的临时文件（~$开头、.~开头）：不拷、不记进原件，免得关掉文档就变「原件被人改过」
  if (name.startsWith('~') || name.startsWith('.~')) return { take: 'skip', reason: '临时文件' }
  if (!EXTENSIONS.has(extname(name).toLowerCase())) return { take: 'watch', reason: '类型不对', size: st.size }
  if (st.size > limits.maxFileBytes) return { take: 'watch', reason: '太大', size: st.size }
  return { take: 'copy', size: st.size }
}

function uniqueName(dir, name) {
  if (!existsSync(join(dir, name))) return name
  const ext = extname(name)
  const stem = basename(name, ext)
  for (let n = 2; n < 10000; n += 1) {
    const candidate = `${stem}-${n}${ext}`
    if (!existsSync(join(dir, candidate))) return candidate
  }
  throw new Error('重名太多')
}

function remember(path, originals, skipped, reason, maxRead) {
  const mark = fingerprint(path, maxRead)
  if (!mark) {
    skipped.push({ path, reason: '读不到' })
    return
  }
  originals.push(mark)
  if (reason) skipped.push({ path, reason })
}

function copyIn(entries, workspace, limits, reportDirs) {
  const copied = []
  const skipped = []
  const originals = []
  let used = 0
  for (const path of entries) {
    const decision = judge(path, limits)
    if (decision.take === 'skip') {
      if (reportDirs || decision.reason !== '不是文件') skipped.push({ path, reason: decision.reason })
      continue
    }
    if (decision.take === 'watch') {
      remember(path, originals, skipped, decision.reason, limits.maxFileBytes)
      continue
    }
    if (used + decision.size > limits.maxTotalBytes) {
      remember(path, originals, skipped, '太大', limits.maxFileBytes)
      continue
    }
    const mark = fingerprint(path, limits.maxFileBytes)
    if (!mark) {
      skipped.push({ path, reason: '读不到' })
      continue
    }
    const to = join(workspace, uniqueName(workspace, basename(path)))
    copyFileSync(path, to)
    used += decision.size
    originals.push(mark)
    copied.push({ from: path, to, sha256: mark.sha256 })
  }
  return { copied, skipped, originals }
}

export function prepareTask(input = {}) {
  const paths = (input.paths ?? []).map(path => resolve(path))
  const root = resolve(input.root ?? deskRoot())
  const now = input.now ?? new Date()
  const kind = classify(paths)
  const sourceDir = kind === 'folder' ? paths[0] : undefined
  const workspace = kind === 'none' ? join(root, '随手') : taskDir(root, input.prompt, now)
  if (!isDeskWorkspace(workspace, root)) throw new Error('不能在原件所在的文件夹里干活')
  if (sourceDir && resolve(sourceDir) === resolve(workspace)) throw new Error('不能在原件所在的文件夹里干活')
  mkdirSync(workspace, { recursive: true })
  const reportDirs = kind === 'files'
  const brought = copyIn(sourceList(kind, paths), workspace, limitsOf(input), reportDirs)
  const outputDir = kind === 'folder' ? join(sourceDir, OUTPUT_NAME) : join(workspace, OUTPUT_NAME)
  return {
    kind,
    workspace,
    outputDir,
    sourceDir,
    ...brought,
    snapshot: snapshotWorkspace(workspace),
  }
}

function walkFiles(dir, root, out) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    // 点开头的是干活时留下的内部文件，不算出产。「桌伴输出」里的也看得见：模型直接写进去的产出照算。
    // ~$ 开头、.~ 开头的锁文件是 Word 开着文档时留下的，不算出产。
    if (name.startsWith('.')) continue
    if (isTempName(name)) continue
    const path = join(dir, name)
    let st
    try {
      st = lstatSync(path)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) walkFiles(path, root, out)
    else if (st.isFile()) out.push(relative(root, path))
  }
}

export function snapshotWorkspace(workspace) {
  const out = []
  walkFiles(workspace, workspace, out)
  return out.sort((a, b) => a.localeCompare(b, 'zh'))
}

function ensureOutputDir(dir) {
  if (existsSync(dir)) {
    const st = lstatSync(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('产出位置不对')
    return
  }
  mkdirSync(dir, { recursive: true })
  if (lstatSync(dir).isSymbolicLink()) throw new Error('产出位置不对')
}

function pagesOf(artifacts, workspace, rel) {
  const abs = resolve(workspace, rel)
  for (const item of artifacts) {
    if (!item || item.pages == null || !item.path) continue
    if (resolve(item.path) === abs) return item.pages
  }
  return undefined
}

// 这一轮的新产出：只找出来，不往「桌伴输出」里拷
export function findOutputs({ workspace, snapshot = null, artifacts = [] } = {}) {
  const before = new Set(snapshot ?? snapshotWorkspace(workspace))
  const fresh = snapshotWorkspace(workspace).filter((rel) => !before.has(rel))
  // ~$ 开头、.~ 开头的锁文件不是产出：Word 开着的时候它就躺在产出目录里
  const found = fresh.filter((rel) => isOutputName(rel) && !isTempName(basename(rel)))
  // 这一轮出了成品（docx/xlsx/pptx/pdf 这些），中间的 txt 就不算出产：不出卡，也不拷进「桌伴输出」。
  const docs = found.some((rel) => isDeliverable(rel))
    ? found.filter((rel) => extname(rel).toLowerCase() !== '.txt')
    : found
  return docs.map((rel) => {
    const from = join(workspace, rel)
    const pages = pagesOf(artifacts, workspace, rel)
    const one = { rel, from, name: basename(rel) }
    return pages == null ? one : { ...one, pages }
  })
}

// 带序号的新名：方案.docx → 方案2.docx。已经有的、这一轮用过的都跳过
function numberedName(dir, name, used = []) {
  const ext = extname(name)
  const stem = basename(name, ext)
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem}${n}${ext}`
    if (!existsSync(join(dir, candidate)) && !used.includes(candidate)) return candidate
  }
  throw new Error('重名太多')
}

// 交出去：把成品拷进「桌伴输出」。目标正被别的程序占着（Word 开着）就换带序号的新名。
export function deliverOutput({ outputDir, from, name = '', used = [] } = {}) {
  ensureOutputDir(outputDir)
  const base = name || basename(from)
  // 这一轮已经有同名的一份了：另存一个，不覆盖
  const target = used.includes(base) ? numberedName(outputDir, base, used) : base
  const to = join(outputDir, target)
  if (resolve(from) === resolve(to)) return { to, name: basename(to), locked: false }
  try {
    copyFileSync(from, to)
  } catch (error) {
    if (!LOCKED_CODES.has(String(error?.code || ''))) throw error
    const alt = join(outputDir, numberedName(outputDir, base, used))
    copyFileSync(from, alt)
    return { to: alt, name: basename(alt), locked: true }
  }
  return { to, name: basename(to), locked: false }
}

export function copyOutputs({ workspace, outputDir, snapshot, artifacts = [] }) {
  const docs = findOutputs({ workspace, snapshot, artifacts })
  if (docs.length === 0) return []
  ensureOutputDir(outputDir)
  const outputs = []
  for (const one of docs) {
    // 模型直接写进产出目录的：已经在该在的地方，卡上指它本身，不另拷一份
    const stay = contained(outputDir, one.from)
    const name = stay ? one.name : uniqueName(outputDir, one.name)
    const done = deliverOutput({ outputDir, from: one.from, name })
    outputs.push(one.pages == null
      ? { from: one.from, to: done.to, name: done.name }
      : { from: one.from, to: done.to, name: done.name, pages: one.pages })
  }
  return outputs
}

function sameOriginal(record) {
  let st
  try {
    st = lstatSync(record.path)
  } catch {
    return { ok: false, after: null }
  }
  if (!st.isFile() || st.isSymbolicLink()) return { ok: false, after: null }
  if (record.sha256 == null) {
    const ok = st.size === record.size && st.mtimeMs === record.mtimeMs
    return { ok, after: null }
  }
  const after = hashFile(record.path)
  return { ok: after === record.sha256, after }
}

export function verifyOriginals(records = []) {
  const changed = []
  for (const record of records) {
    const saw = sameOriginal(record)
    if (!saw.ok) changed.push({ path: record.path, before: record.sha256, after: saw.after })
  }
  const ok = changed.length === 0
  return {
    ok,
    changed,
    message: ok ? '' : `原件被动过了：${changed.map(item => basename(item.path)).join('、')}`,
    mark: ok ? '' : 'red',
  }
}

// defer：先把这一轮的产出留在工作区里（不往「桌伴输出」拷），壳在副本上做后处理，做完再交出去。
export function finishTask(prepared, extra = {}) {
  const check = verifyOriginals(prepared.originals)
  const snapshot = extra.snapshot ?? prepared.snapshot
  if (!check.ok) return { ...check, outputs: [], snapshot }
  const artifacts = extra.artifacts ?? []
  const outputs = extra.defer
    ? findOutputs({ workspace: prepared.workspace, snapshot, artifacts })
    : copyOutputs({ workspace: prepared.workspace, outputDir: prepared.outputDir, snapshot, artifacts })
  return { ...check, outputs, snapshot: snapshotWorkspace(prepared.workspace) }
}

function removeTree(path) {
  const st = lstatSync(path)
  if (st.isSymbolicLink()) {
    try {
      unlinkSync(path)
    } catch {
      rmdirSync(path)
    }
    return
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) removeTree(join(path, name))
    rmdirSync(path)
    return
  }
  unlinkSync(path)
}

export function clearWorkspace(dir, root = deskRoot()) {
  const target = resolve(dir)
  const base = resolve(root)
  if (!isDeskWorkspace(target, base)) throw new Error('只能清桌伴自己的工作区')
  if (!existsSync(target)) return
  for (const name of readdirSync(target)) {
    if (name === OUTPUT_NAME) continue
    removeTree(join(target, name))
  }
  if (target !== resolve(base, '随手') && readdirSync(target).length === 0) rmdirSync(target)
}

function readIntegrity(target) {
  const result = spawnSync('icacls', [target], { windowsHide: true })
  if (result.status !== 0) return ''
  return integrityText(result.stdout)
}

function setIntegrity(target, kind) {
  const result = spawnSync('icacls', [target, ...integrityArgs(kind)], { windowsHide: true })
  return result.status === 0 && integrityIsLow(readIntegrity(target))
}

function ensureLow(target, kind) {
  if (process.platform !== 'win32') return { ok: true, skipped: true, changed: false }
  if (!target || !existsSync(target)) return { ok: false, skipped: false, changed: false, message: '没能限制干活的程序，这次不开工' }
  if (integrityIsLow(readIntegrity(target))) return { ok: true, skipped: false, changed: false }
  const ok = setIntegrity(target, kind)
  return ok
    ? { ok: true, skipped: false, changed: true }
    : { ok: false, skipped: false, changed: false, message: '没能限制干活的程序，这次不开工' }
}

export function protectRuntime({ nodePath, workspace } = {}) {
  const node = ensureLow(nodePath, 'file')
  const dir = ensureLow(workspace, 'dir')
  const ok = node.ok && dir.ok
  return {
    ok,
    message: ok ? '' : '没能限制干活的程序，这次不开工',
    node,
    workspace: dir,
  }
}

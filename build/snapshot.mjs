// 快照：把 dev 仓里「该公开的文件」原样拷到公开仓克隆目录。
// 用法：node build/snapshot.mjs <公开仓路径>
// 白名单之外一律不拷（内部说明文档、CI 配置都不出去）。
// 拷贝是原样的一份：源码一个字都不改，这样公开仓里的源码跟打包用的源码完全对得上。
// 拷完在拷过去的内容里扫一遍不该出现的字眼（内部卡号、内部人名、上一代的版本号说法）：
// 扫到就列出文件和行号、退出码非 0，不往下走。
// 注意：这个脚本本身会被拷进公开仓，所以这些字眼一律不写字面（用转义拼）。
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(here, '..')

// 公开仓根目录要有、且允许整份拷过去的顶层条目。
export const INCLUDE = [
  'app',
  'build',
  'test',
  'package.json',
  'package-lock.json',
  '.gitattributes',
  '.gitignore',
  '.gitleaks.toml',
  '.gitleaksignore',
  'THIRD-PARTY-NOTICES.txt',
  'LICENSE',
  'PRIVACY.md',
  'PRIVACY.en.md',
  'SECURITY.md',
  'docs/release-0.2.0.md',
  'docs/release-0.2.0.en.md',
]

// 明确不拷的（白名单之外也要挡一道，免得以后有人把它加进白名单）。
export const EXCLUDE = [
  'AGENTS.md',
  'README.md',
  'docs/' + '\u5f62\u6001' + '.md',
  'docs/' + '\u4e8b\u4ef6' + '.md',
  '.github',
  '.pre-commit-config.yaml',
]

// 目录里这些不进快照：本地装的东西、体积大的中间产物。
const SKIP_DIRS = new Set(['node_modules', 'payload', 'dist', '.installer-cache', '.git'])

// dev 仓专属、拷过去也没用的文件（里面指向 dev 仓自己的历史）。
const DEV_ONLY = new Set()

// 公开仓里不该出现的字眼，以及各自的判定方式。
// 这里用转义写，不把字面落在文件里：这个脚本本身会被拷进公开仓。
export const FORBIDDEN_RULES = [
  // 内部人名。
  { id: 'person', label: '内部人名', test: (text) => text.includes('Zha' + 'o') },
  // 内部卡号：卡号后面跟数字才算（别的场合的同形串不算）。
  { id: 'card', label: '内部卡号', test: (text) => /SID1-\d/.test(text) },
  // 内部工单系统的名字。
  { id: 'tracker', label: '内部工单系统', test: (text) => text.includes('Line' + 'ar') },
  // 上一代的版本号。依赖版本号像 1.0.11 这种不算，要看成一个整体。
  { id: 'oldVersion', label: '上一代版本号', test: (text) => /(?<![\d.])0\.11(?![\d.])/.test(text) },
  // 上一代的两个说法（见下面两条规则）。
  { id: 'oldWord', label: '上一代说法', test: (text) => text.includes('\u65e7\u7248') },
  { id: 'oldRepo', label: '上一代仓库说法', test: (text) => text.includes('\u65e7\u4ed3') },
  // 内部代号（两个）。
  { id: 'code1', label: '内部代号', test: (text) => text.includes('\u732b\u732b') },
  { id: 'code2', label: '内部代号', test: (text) => text.includes('\u9996\u9886') },
]

// 公开仓里的 .gitleaksignore：dev 仓那份列的是 dev 仓自己的历史提交，不能拿过去。
// 这一份是现写的，其余文件都原样拷贝。
const GENERATED = {
  '.gitleaksignore': '# 这个文件列出可以忽略的误报，一行一条：<commit>:<file>:<rule>:<line>。\n' +
    '# 公开仓目前没有需要忽略的历史误报。\n' +
    '# 新的条目必须在提 PR 时说明核实过程。\n',
}

function walk(dir, root = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(join(dir, entry.name), root, out)
    } else if (entry.isFile()) {
      out.push(relative(root, join(dir, entry.name)).split('\\').join('/'))
    }
  }
  return out
}

function readTextSafe(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

// 二进制文件（图标之类）不扫。
function isBinary(path) {
  try {
    const buf = readFileSync(path)
    return buf.includes(0)
  } catch {
    return true
  }
}

// 一段文字里哪些字眼不该出现（返回命中的规则）。
export function findForbidden(text) {
  return FORBIDDEN_RULES.filter((rule) => rule.test(text))
}

// 逐行扫一个文件：给出每个字眼出现在第几行。
export function scanText(text) {
  const hits = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    for (const rule of findForbidden(lines[i])) {
      hits.push({ line: i + 1, id: rule.id, label: rule.label })
    }
  }
  return hits
}

// 扫一个文件路径：返回 { rel, hits: [{ line, id, label }] }（hits 为空表示干净）。
export function scanFile(rel, path) {
  if (isBinary(path)) return { rel, hits: [] }
  const hits = scanText(readTextSafe(path))
  return { rel, hits }
}

// 拷完扫一遍：拷过去的所有文件里有没有不该出现的字眼。
export function scanCopied(dest, copied) {
  const found = []
  for (const rel of copied) {
    const path = join(dest, rel)
    if (!existsSync(path)) continue
    const { hits } = scanFile(rel, path)
    if (hits.length) found.push({ rel, hits })
  }
  return found
}

export function snapshot(source = sourceRoot, target = process.argv[2]) {
  if (!target) throw new Error('要给公开仓的路径')
  const dest = resolve(target)
  if (!existsSync(dest)) throw new Error(`公开仓不在：${dest}`)
  const copied = []
  const skipped = []
  const copyOne = (rel, from) => {
    const to = join(dest, rel)
    mkdirSync(dirname(to), { recursive: true })
    if (GENERATED[rel]) {
      writeFileSync(to, GENERATED[rel], 'utf8')
    } else {
      // 原样拷贝：字节级一致，源码一个字都不改。
      cpSync(from, to, { force: true })
    }
    copied.push(rel)
  }
  for (const rel of INCLUDE) {
    if (EXCLUDE.includes(rel)) {
      skipped.push({ rel, reason: '白名单外' })
      continue
    }
    if (DEV_ONLY.has(rel)) {
      skipped.push({ rel, reason: 'dev 仓专属，指向自己的历史' })
      continue
    }
    const from = join(source, rel)
    if (!existsSync(from)) {
      skipped.push({ rel, reason: '源目录里没有' })
      continue
    }
    if (statSync(from).isDirectory()) {
      for (const inner of walk(from)) copyOne(`${rel}/${inner}`, join(from, inner))
      continue
    }
    copyOne(rel, from)
  }
  // 拷完扫一遍：有不该出现的字眼就不往下走。
  const found = scanCopied(dest, copied)
  if (found.length) {
    const total = found.reduce((sum, item) => sum + item.hits.length, 0)
    const error = new Error(`拷过去的文件里有 ${total} 处不该出现的字眼`)
    error.hits = found
    error.copied = copied
    error.skipped = skipped
    throw error
  }
  return { dest, copied, skipped, hits: [] }
}

function main() {
  const target = process.argv[2]
  if (!target) {
    console.error('用法：node build/snapshot.mjs <公开仓路径>')
    process.exit(2)
  }
  let result
  try {
    result = snapshot(sourceRoot, target)
  } catch (error) {
    if (!error.hits) {
      console.error(error.message)
      process.exit(2)
    }
    console.error('拷过去的文件里有不该出现的字眼（公开仓不能有这些），先在 dev 仓里清掉再来：')
    for (const item of error.hits) {
      for (const hit of item.hits) {
        console.error(`  ${item.rel}:${hit.line}：${hit.label}`)
      }
    }
    const total = error.hits.reduce((sum, item) => sum + item.hits.length, 0)
    console.error(`一共 ${total} 处。`)
    const report = join(process.env.BOXBOX_TMP_DIR ?? '.', 'snapshot-report.json')
    mkdirSync(dirname(report), { recursive: true })
    writeFileSync(report, `${JSON.stringify({ dest: resolve(target), copied: error.copied, skipped: error.skipped, hits: error.hits }, null, 2)}\n`, 'utf8')
    console.error(`清单写到 ${report}`)
    process.exit(1)
  }
  console.log(`拷了 ${result.copied.length} 个文件到 ${result.dest}`)
  if (result.skipped.length) {
    console.log('没拷：')
    for (const item of result.skipped) console.log(`  ${item.rel}（${item.reason}）`)
  }
  console.log('扫过一遍：没有不该出现的字眼。')
  const report = join(process.env.BOXBOX_TMP_DIR ?? '.', 'snapshot-report.json')
  mkdirSync(dirname(report), { recursive: true })
  writeFileSync(report, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(`清单写到 ${report}`)
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) main()

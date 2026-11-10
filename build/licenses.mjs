// 第三方许可核对：扫 payload 里实际带着的东西（dsh 的 npm 包、随包 Python 的包、Node、Electron、
// 7-Zip、技能目录里的许可文件），跟仓根 THIRD-PARTY-NOTICES.txt 里声明的清单对一遍。
// 实际带着、但清单里没写（或版本、许可对不上）的，打出来，退出码非 0。
// 用法：node build/licenses.mjs [payload 目录]（默认用仓里的 payload 联接）
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const NOTICES = join(repoRoot, 'THIRD-PARTY-NOTICES.txt')

// 清单里逐项那一段的标记：只在标记之间解析，前面的人话段落不看。
const LIST_BEGIN = '== 逐项清单 =='
const LIST_END = '== 清单结束 =='

const CLASSIFIER_LICENSE = {
  'License :: OSI Approved :: MIT License': 'MIT',
  'License :: OSI Approved :: BSD License': 'BSD-2-Clause',
  'License :: OSI Approved :: Apache Software License': 'Apache-2.0',
  'License :: OSI Approved :: ISC License (ISCL)': 'ISC',
  'License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)': 'MPL-2.0',
  'License :: OSI Approved :: Python Software Foundation License': 'PSF-2.0',
  'License :: OSI Approved :: GNU Lesser General Public License v2 or later (LGPLv2+)': 'LGPL-2.0-or-later',
}

export function normalizeName(name) {
  return String(name ?? '').trim().toLowerCase().replaceAll('_', '-')
}

export function normalizeLicense(license) {
  return String(license ?? '').trim().replace(/^\((.*)\)$/, '$1').replace(/\s+/g, ' ')
}

// npm 的 license 可能是字符串、{type}、或者 licenses 数组。
export function npmLicense(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) return pkg.license.type
  if (Array.isArray(pkg.licenses) && pkg.licenses[0]?.type) return pkg.licenses[0].type
  if (Array.isArray(pkg.licenses) && typeof pkg.licenses[0] === 'string') return pkg.licenses[0]
  return 'UNKNOWN'
}

function walkPackages(root) {
  const out = []
  const walk = (dir, depth) => {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (entry.name.startsWith('@')) {
        walk(full, depth + 1)
        continue
      }
      const manifest = join(full, 'package.json')
      if (existsSync(manifest)) {
        try {
          out.push(JSON.parse(readFileSync(manifest, 'utf8')))
        } catch {
          // 读不出来的 package.json 不算数
        }
      }
      const nested = join(full, 'node_modules')
      if (existsSync(nested)) walk(nested, depth + 1)
    }
  }
  if (existsSync(root)) walk(root, 0)
  return out
}

export function scanNpm(payloadRoot) {
  const seen = new Map()
  for (const pkg of walkPackages(join(payloadRoot, 'dsh', 'node_modules'))) {
    const name = pkg.name
    if (!name || !pkg.version) continue
    seen.set(`${name}@${pkg.version}`, { name, version: pkg.version, license: npmLicense(pkg), kind: 'npm' })
  }
  return [...seen.values()]
}

export function scanPython(payloadRoot) {
  const sitePackages = join(payloadRoot, 'python', 'Lib', 'site-packages')
  const out = []
  const runtime = join(payloadRoot, 'python', 'runtime.json')
  if (existsSync(runtime)) {
    try {
      const version = JSON.parse(readFileSync(runtime, 'utf8')).python
      if (version) out.push({ name: 'Python', version, license: 'PSF-2.0', kind: 'python' })
    } catch {
      // runtime.json 读不出来就不算这一项
    }
  }
  let entries = []
  try {
    entries = readdirSync(sitePackages, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.dist-info')) continue
    const metadata = join(sitePackages, entry.name, 'METADATA')
    if (!existsSync(metadata)) continue
    const body = readFileSync(metadata, 'utf8')
    const field = (key) => body.match(new RegExp(`^${key}: (.*)$`, 'm'))?.[1]?.trim() ?? ''
    const name = field('Name')
    const version = field('Version')
    if (!name || !version) continue
    let license = field('License-Expression') || field('License')
    if (!license) {
      for (const line of body.split(/\r?\n/)) {
        const value = line.match(/^Classifier: (License :: .*)$/)?.[1]
        if (value && CLASSIFIER_LICENSE[value]) {
          license = CLASSIFIER_LICENSE[value]
          break
        }
      }
    }
    out.push({ name, version, license: license || 'UNKNOWN', kind: 'python' })
  }
  return out
}

export function scanNode(payloadRoot, root = repoRoot) {
  if (!existsSync(join(payloadRoot, 'node', 'LICENSE'))) return []
  const source = readFileSync(join(root, 'build', 'payload.mjs'), 'utf8')
  const version = source.match(/NODE_VERSION = '([^']+)'/)?.[1]
  if (!version) return []
  return [{ name: 'Node.js', version: `v${version}`, license: 'MIT', kind: 'node' }]
}

export function scanElectron(root = repoRoot) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const version = pkg.devDependencies?.electron
  if (!version) return []
  return [{ name: 'Electron', version, license: 'MIT', kind: 'electron' }]
}

// 7-Zip 只在装的时候用（装完即删），不在 payload 里；版本从 electron-builder 缓存里的 7za 自己报。
export function scanSevenZip() {
  const cache = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache') : ''
  if (!cache || !existsSync(cache)) return []
  let found = null
  for (const entry of readdirSync(cache, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('7zip@')) continue
    const bin = join(cache, entry.name)
    for (const sub of readdirSync(bin, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue
      const exe = join(bin, sub.name, 'bin', '7za.exe')
      if (existsSync(exe)) {
        found = exe
        break
      }
    }
    if (found) break
  }
  if (!found) return []
  const run = spawnSync(found, [], { encoding: 'utf8', timeout: 30_000 })
  const version = `${run.stdout ?? ''}${run.stderr ?? ''}`.match(/7-Zip \(a\) (\d+\.\d+)/)?.[1]
  if (!version) return []
  return [{ name: '7-Zip', version, license: 'LGPL-2.1-or-later', kind: 'sevenzip' }]
}

// 技能目录里带来的第三方许可文件：清单里要提这些文件名。
export function scanSkillLicenses(root = repoRoot) {
  const skills = join(root, 'app', 'skills')
  const out = []
  let entries = []
  try {
    entries = readdirSync(skills, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(skills, entry.name, 'licenses')
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      if (!file.isFile()) continue
      const head = readFileSync(join(dir, file.name), 'utf8').slice(0, 400)
      let license = 'UNKNOWN'
      if (/Apache License/i.test(head)) license = 'Apache-2.0'
      else if (/MIT License/i.test(head)) license = 'MIT'
      const rel = `app/skills/${entry.name}/licenses/${file.name}`
      out.push({ name: rel, version: '-', license, kind: 'skill-license' })
    }
  }
  return out
}

export function scanAll(payloadRoot, root = repoRoot) {
  return [
    ...scanNpm(payloadRoot),
    ...scanPython(payloadRoot),
    ...scanNode(payloadRoot, root),
    ...scanElectron(root),
    ...scanSevenZip(),
    ...scanSkillLicenses(root),
  ]
}

// 清单里逐项那一段：`- 名字 版本 — 许可`
export function parseDeclared(text) {
  const begin = text.indexOf(LIST_BEGIN)
  const end = text.indexOf(LIST_END)
  if (begin < 0 || end < 0) return []
  const body = text.slice(begin + LIST_BEGIN.length, end)
  const out = []
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s+(\S+)\s+(\S+)\s+[—-]\s+(.+?)\s*$/)
    if (match) out.push({ name: match[1], version: match[2], license: match[3] })
  }
  return out
}

export function compare(components, declared) {
  const missing = []
  const mismatched = []
  const index = new Map()
  for (const item of declared) {
    const key = normalizeName(item.name)
    if (!index.has(key)) index.set(key, [])
    index.get(key).push(item)
  }
  for (const item of components) {
    const key = normalizeName(item.name)
    const candidates = index.get(key)
    if (!candidates) {
      missing.push(item)
      continue
    }
    const hit = candidates.find((d) => d.version === item.version)
    if (!hit) {
      missing.push({ ...item, note: `清单里只有 ${candidates.map((c) => c.version).join('、')}` })
      continue
    }
    if (normalizeLicense(hit.license) !== normalizeLicense(item.license)) {
      mismatched.push({ ...item, declared: hit.license })
    }
  }
  return { missing, mismatched }
}

// 把清单里「逐项清单」那一段按扫到的结果重写（只改标记之间的内容，人话段落不动）。
export function renderList(components) {
  const lines = [...components]
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
    .map((item) => `- ${item.name} ${item.version} — ${item.license}`)
  return lines.join('\n')
}

export function syncList(text, components) {
  const begin = text.indexOf(LIST_BEGIN)
  const end = text.indexOf(LIST_END)
  if (begin < 0 || end < 0) throw new Error('清单里没有逐项清单标记')
  const body = renderList(components)
  return `${text.slice(0, begin + LIST_BEGIN.length)}\n${body}\n${text.slice(end)}`
}

function main() {
  const args = process.argv.slice(2)
  const sync = args.includes('--sync')
  const payloadArg = args.find((arg) => !arg.startsWith('--'))
  const payloadRoot = resolve(payloadArg ?? join(repoRoot, 'payload'))
  if (!existsSync(payloadRoot)) {
    console.error(`payload 不在：${payloadRoot}`)
    process.exit(2)
  }
  const notices = readFileSync(NOTICES, 'utf8')
  const components = scanAll(payloadRoot, repoRoot)
  if (sync) {
    writeFileSync(NOTICES, syncList(notices, components), 'utf8')
    console.log(`清单里的逐项清单已按 ${components.length} 项重写`)
    return
  }
  const declared = parseDeclared(notices)
  const { missing, mismatched } = compare(components, declared)
  console.log(`扫到 ${components.length} 项，清单里声明 ${declared.length} 项`)
  for (const item of missing) {
    console.log(`漏：${item.name} ${item.version} — ${item.license}${item.note ? `（${item.note}）` : ''}`)
  }
  for (const item of mismatched) {
    console.log(`许可对不上：${item.name} ${item.version} — 实际 ${item.license}，清单写 ${item.declared}`)
  }
  if (missing.length || mismatched.length) {
    console.error(`第三方许可清单没跟上：漏 ${missing.length} 项，对不上 ${mismatched.length} 项`)
    process.exit(1)
  }
  console.log('第三方许可清单齐了')
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) main()

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const LOCK_URL = 'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/dsh-v0.2.1-rc.5/scripts/primary-runtime/lock.json'
const NODE_VERSION = '24.13.0'
const OFFICE = ['python-docx', 'lxml', 'typing-extensions', 'python-pptx', 'pillow', 'xlsxwriter', 'openpyxl', 'et-xmlfile']

// dsh 0.2.1-rc.5 的 runtime lock 里没有 pypdf。按 R2b 钉 6.1.1，跟 office wheel 一样校验后解进 site-packages。
export const PYPDF_WHEEL = {
  version: '6.1.1',
  url: 'https://files.pythonhosted.org/packages/07/ed/adae13756d9dabdddee483fc7712905bb5585fbf6e922b1a19aca3a29cd1/pypdf-6.1.1-py3-none-any.whl',
  sha256: '7781f99493208a37a7d4275601d883e19af24e62a525c25844d22157c2e4cde7',
}

const here = dirname(fileURLToPath(import.meta.url))
const payload = join(dirname(here), 'payload')

export function hostTarget() {
  const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return `${os}-${arch}`
}

function normPkg(name) {
  return name.toLowerCase().replaceAll('_', '-')
}

export function wheelKey(url) {
  const file = decodeURIComponent(url.split('/').pop() ?? '')
  return normPkg(file.split('-')[0])
}

export function selectWheels(lock, target) {
  const seen = new Set()
  const picked = []
  for (const wheel of [...lock.targets[target].wheels, ...lock.wheels]) {
    const key = wheelKey(wheel.url)
    if (!OFFICE.includes(key) || seen.has(key)) continue
    seen.add(key)
    picked.push(wheel)
  }
  const missing = OFFICE.filter(name => !seen.has(name))
  if (missing.length) throw new Error(`missing wheels: ${missing.join(', ')}`)
  return picked
}

export function officePackages(lock) {
  const out = {}
  for (const [name, version] of Object.entries(lock.pythonPackages)) {
    if (OFFICE.includes(normPkg(name))) out[name] = version
  }
  if (Object.keys(out).length !== OFFICE.length) throw new Error('lock is missing an office package')
  return out
}

export function bundledPackages(lock) {
  return { ...officePackages(lock), pypdf: PYPDF_WHEEL.version }
}

async function fetchBuf(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

async function downloadChecked(url, sha256) {
  const buf = await fetchBuf(url)
  const got = createHash('sha256').update(buf).digest('hex')
  if (got !== sha256) throw new Error(`sha256 mismatch for ${url}`)
  return buf
}

export function unzip(buf, dest) {
  let eocd = -1
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('zip: no end of central directory')
  const count = buf.readUInt16LE(eocd + 10)
  let pos = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('zip: bad central directory')
    const method = buf.readUInt16LE(pos + 10)
    const size = buf.readUInt32LE(pos + 20)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const local = buf.readUInt32LE(pos + 42)
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen)
    pos += 46 + nameLen + extraLen + commentLen
    if (name.includes('..')) throw new Error(`zip path ${name}`)
    const path = join(dest, name)
    if (name.endsWith('/')) { mkdirSync(path, { recursive: true }); continue }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    mkdirSync(dirname(path), { recursive: true })
    const data = buf.subarray(start, start + size)
    writeFileSync(path, method === 0 ? data : inflateRawSync(data))
  }
}

function run(cmd, args, cwd) {
  const child = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && cmd.endsWith('.cmd') })
  if (child.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`)
}

function stripPython(root) {
  const dropDir = new Set(['idlelib', 'tkinter', 'turtledemo', 'ensurepip', 'include', 'tcl8.6', 'tk8.6'])
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (dropDir.has(ent.name) || ent.name === 'pip' || ent.name.startsWith('pip-')) rmSync(path, { recursive: true, force: true })
        else walk(path)
      } else if (ent.name.startsWith('_tkinter') || ent.name.startsWith('tcl86') || ent.name.startsWith('tk86')) {
        rmSync(path, { force: true })
      }
    }
  }
  walk(root)
}

function sitePackages(root, version, windows) {
  if (windows) return join(root, 'Lib', 'site-packages')
  const minor = version.split('.').slice(0, 2).join('.')
  return join(root, 'lib', `python${minor}`, 'site-packages')
}

async function preparePython(lock, target) {
  const spec = lock.targets[target]
  if (!spec) throw new Error(`unknown target ${target}`)
  const windows = target.startsWith('win-')
  const file = `cpython-${lock.pythonVersion}+${lock.pythonRelease}-${spec.pythonTarget}-install_only_stripped.tar.gz`
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}/${encodeURIComponent(file)}`
  // GNU tar reads "C:\…" as a remote archive. Give it only the file name.
  const archive = `sidemate-${target}.tar.gz`
  writeFileSync(join(tmpdir(), archive), await downloadChecked(url, spec.pythonSha256))
  run('tar', ['-xzf', archive, '-C', payload], tmpdir())
  const dest = join(payload, 'python')
  stripPython(dest)
  const site = sitePackages(dest, lock.pythonVersion, windows)
  mkdirSync(site, { recursive: true })
  for (const wheel of selectWheels(lock, target)) unzip(await downloadChecked(wheel.url, wheel.sha256), site)
  unzip(await downloadChecked(PYPDF_WHEEL.url, PYPDF_WHEEL.sha256), site)
  const manifest = {
    desktopVersion: '0.1.0',
    platform: windows ? 'win32' : target.startsWith('linux-') ? 'linux' : 'darwin',
    arch: target.endsWith('-arm64') ? 'arm64' : 'x64',
    python: lock.pythonVersion,
    pythonPackages: bundledPackages(lock),
  }
  writeFileSync(join(dest, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  if (target === hostTarget()) {
    const bin = windows ? join(dest, 'python.exe') : join(dest, 'bin', 'python3')
    run(bin, ['-I', '-c', 'import docx, pptx, openpyxl, pypdf'])
  }
}

async function prepareNode(target) {
  const dir = join(payload, 'node')
  mkdirSync(dir, { recursive: true })
  if (target === 'win-x64') {
    const name = `node-v${NODE_VERSION}-win-x64.zip`
    const sums = (await fetchBuf(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`)).toString('utf8')
    const line = sums.split(/\r?\n/).find(item => item.endsWith(`  ${name}`))
    if (!line) throw new Error(`SHASUMS256.txt has no ${name}`)
    const staging = join(tmpdir(), `sidemate-node-${NODE_VERSION}`)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging)
    unzip(await downloadChecked(`https://nodejs.org/dist/v${NODE_VERSION}/${name}`, line.split(/\s+/)[0]), staging)
    const unpacked = join(staging, `node-v${NODE_VERSION}-win-x64`)
    cpSync(join(unpacked, 'node.exe'), join(dir, 'node.exe'))
    cpSync(join(unpacked, 'LICENSE'), join(dir, 'LICENSE'))
    return
  }
  if (target !== hostTarget()) throw new Error(`${target} node is only downloaded for win-x64`)
  const out = join(dir, process.platform === 'win32' ? 'node.exe' : 'node')
  cpSync(process.execPath, out)
  chmodSync(out, 0o755)
}

function prepareDsh(target) {
  const dir = join(payload, 'dsh')
  mkdirSync(dir, { recursive: true })
  cpSync(join(here, 'dsh', 'package.json'), join(dir, 'package.json'))
  cpSync(join(here, 'dsh', 'package-lock.json'), join(dir, 'package-lock.json'))
  const args = ['ci']
  if (target === 'win-x64') args.push('--os=win32', '--cpu=x64')
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, dir)
  const installed = (name) => existsSync(join(dir, 'node_modules', '@deepseek-ai', name, 'package.json'))
  if (!installed('dsh') || !installed('libreoffice-kit')) throw new Error('dsh or libreoffice-kit missing')
}

export async function prepare(target = hostTarget()) {
  rmSync(payload, { recursive: true, force: true })
  mkdirSync(payload, { recursive: true })
  const lock = JSON.parse((await fetchBuf(LOCK_URL)).toString('utf8'))
  if (lock.pythonVersion !== '3.12.14' || lock.pythonRelease !== '20260901') {
    throw new Error(`unexpected python lock ${lock.pythonVersion} ${lock.pythonRelease}`)
  }
  await preparePython(lock, target)
  await prepareNode(target)
  prepareDsh(target)
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  await prepare(process.argv[2] || hostTarget())
}

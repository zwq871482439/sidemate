// 把范本和材料的副本放进任务工作区。这里只往工作区写 tagged/，不改那些副本。
// 喂给干活进程的是短提示，带标正文在 tagged/ 里。核上的写成批注，核不上的只计数。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { payloadLayout } from '../dsh/index.mjs'

const citePy = fileURLToPath(new URL('./cite.py', import.meta.url))
const ENV_KEEP = ['PATH', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'SystemRoot', 'PATHEXT']

export function pythonBin(root = payloadLayout().python) {
  const win = join(root, 'python.exe')
  const unix = join(root, 'bin', 'python3')
  if (existsSync(win)) return win
  if (existsSync(unix)) return unix
  return ''
}

export function dsofficeBin(root = payloadLayout().root) {
  return join(root, 'dsh', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js')
}

function childEnv(extra) {
  // 代码页 936 上随包 Python 默认按 GBK 读写标准流，中文路径会坏。
  const env = { PYTHONUTF8: '1', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }
  for (const name of ENV_KEEP) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return Object.assign(env, extra)
}

function callCite(python, payload, env) {
  return new Promise((done, reject) => {
    const child = spawn(python, [citePy], { env: childEnv(env) })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(err.trim() || '出处核对没有完成'))
        return
      }
      try {
        done(JSON.parse(out))
      } catch {
        reject(new Error('出处核对没有完成'))
      }
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

export async function prepareFeed(options = {}) {
  const python = options.python || pythonBin()
  if (!python) throw new Error('没有找到随包的 Python')
  if (!options.workspace) throw new Error('还没有工作区')
  return callCite(python, {
    cmd: 'prepare',
    utterance: options.utterance ?? '',
    template: options.template ? basename(options.template) : '',
    materials: (options.materials ?? []).map(path => resolve(path)),
    single: options.single === true,
    workspace: resolve(options.workspace),
    node: options.node || payloadLayout().node,
    dsoffice: options.dsoffice || dsofficeBin(),
  }, options.env)
}

export async function reviewDocx(options = {}) {
  const python = options.python || pythonBin()
  if (!python) throw new Error('没有找到随包的 Python')
  return callCite(python, {
    cmd: 'review',
    docx: resolve(options.docx),
    chunks: options.chunks ?? [],
    utterance: options.utterance ?? '',
    hasTemplate: options.hasTemplate === true,
  }, options.env)
}

export async function tidyDocx(options = {}) {
  const python = options.python || pythonBin()
  if (!python) throw new Error('没有找到随包的 Python')
  return callCite(python, {
    cmd: 'tidy',
    docx: resolve(options.docx),
    utterance: options.utterance ?? '',
    hasTemplate: options.hasTemplate === true,
  }, options.env)
}

// 核对没成时用这个：把正文里的出处标记剥干净，不核、不写批注
export async function stripMarks(options = {}) {
  const python = options.python || pythonBin()
  if (!python) throw new Error('没有找到随包的 Python')
  return callCite(python, {
    cmd: 'strip',
    docx: resolve(options.docx),
  }, options.env)
}

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const FILE_MAX = 800

function skip(name) {
  // The dsh lock is pinned data, not hand-written code: it is past the 800-line
  // per-file cap, so it is skipped. Only the per-file cap is enforced.
  return name === 'node_modules' || name === 'package-lock.json'
}

export function measure(roots, limits = {}) {
  const fileMax = limits.fileMax ?? FILE_MAX
  const errors = []
  let total = 0
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (skip(name)) continue
      const path = join(dir, name)
      const st = statSync(path)
      if (st.isDirectory()) {
        walk(path)
        continue
      }
      if (!st.isFile()) continue
      const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(line => line.trim() !== '').length
      total += lines
      if (lines > fileMax) errors.push(`${path}: ${lines} > ${fileMax}`)
    }
  }
  for (const root of roots) walk(root)
  // No total cap by default: only check it when the caller passes one.
  if (limits.totalMax !== undefined && total > limits.totalMax) {
    errors.push(`total ${total} > ${limits.totalMax}`)
  }
  return { total, errors }
}

function main() {
  const { total, errors } = measure(['app', 'build'])
  console.log(`lines ${total}`)
  for (const error of errors) console.error(error)
  if (errors.length) process.exit(1)
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) main()

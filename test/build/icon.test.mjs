// 安装包、exe 的图标指到 build/icon.ico，nsis 装卸两个图标同一个；
// icon.ico 由 build/make-icon.py 拼出五档。
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createRequire } from 'node:module'

const root = fileURLToPath(new URL('../../', import.meta.url))
const config = createRequire(import.meta.url)('../../build/builder.config.cjs')

// ICO 头：00 00 01 00（保留字 0，类型 1 图标）
function isIco(path) {
  const head = readFileSync(path).subarray(0, 4)
  return head[0] === 0x00 && head[1] === 0x00 && head[2] === 0x01 && head[3] === 0x00
}

// 目录里每档 16 字节，宽高各一字节，256 记作 0
function icoSizes(path) {
  const buf = readFileSync(path)
  const sizes = []
  for (let i = 0; i < buf.readUInt16LE(4); i++) {
    const w = buf.readUInt8(6 + i * 16) || 256
    const h = buf.readUInt8(7 + i * 16) || 256
    sizes.push(`${w}x${h}`)
  }
  return sizes
}

test('win.icon 和 nsis 的装卸图标都是 build/icon.ico，文件在且是有效 ico', () => {
  assert.equal(config.win.icon, 'build/icon.ico')
  assert.equal(config.nsis.installerIcon, 'build/icon.ico')
  assert.equal(config.nsis.uninstallerIcon, 'build/icon.ico')
  for (const rel of [config.win.icon, config.nsis.installerIcon, config.nsis.uninstallerIcon]) {
    const file = join(root, rel)
    assert.ok(existsSync(file), file)
    assert.ok(isIco(file), `${file} 不是有效 ico`)
  }
})

test('ico 含 16/24/32/48/256 五档（make-icon.py 拼的）', () => {
  assert.deepEqual(icoSizes(join(root, 'build/icon.ico')), ['16x16', '24x24', '32x32', '48x48', '256x256'])
})

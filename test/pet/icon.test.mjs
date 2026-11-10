// 托盘、窗口、通知用的运行时图标在 app/assets/icon.ico（打包随 app/**/* 带上）；
// 这份 ico 由 build/make-icon.py 拼成五档（16/24/32/48/256）。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { iconPath } from '../../app/assets/icon.mjs'

const buildIcon = fileURLToPath(new URL('../../build/icon.ico', import.meta.url))
const petShell = fileURLToPath(new URL('../../app/pet/shell.mjs', import.meta.url))

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

test('托盘 trayIcon 用的 app/assets/icon.ico 存在、有效，且含 16/24/32/48/256 五档', () => {
  assert.ok(existsSync(iconPath), iconPath)
  assert.ok(isIco(iconPath), `${iconPath} 不是有效 ico`)
  assert.deepEqual(icoSizes(iconPath), ['16x16', '24x24', '32x32', '48x48', '256x256'])
})

test('app/assets/icon.ico 跟打包用的 build/icon.ico 是同一份', () => {
  const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
  assert.equal(digest(iconPath), digest(buildIcon))
})

test('shell.mjs 的 trayIcon 确实用 createFromPath 载这份 ico', () => {
  assert.match(readFileSync(petShell, 'utf8'), /nativeImage\.createFromPath\(iconPath\)/)
})

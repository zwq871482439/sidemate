// 小岛的位置和置顶选择记在同一个文件里（pet-place.json）。
// 这一层不碰 Electron，读写都拿文件路径来，方便单测。

import { readFileSync, writeFileSync } from 'node:fs'

export function readPlace(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

export function writePlace(file, value) {
  try {
    writeFileSync(file, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

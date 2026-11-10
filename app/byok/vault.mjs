import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const KEY_FILE = 'key.bin'
const SETTINGS_FILE = '设置.json'

export function createVault({ root, crypto }) {
  const keyPath = join(root, KEY_FILE)
  const settingsPath = join(root, SETTINGS_FILE)

  function readSettings() {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  function writeSettings(next) {
    mkdirSync(root, { recursive: true })
    const body = {}
    if (next.introPlayed === true) body.introPlayed = true
    writeFileSync(settingsPath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
  }

  return {
    root,
    hasKey() {
      return this.readKey() != null
    },
    unreadable() {
      return existsSync(keyPath) && this.readKey() == null
    },
    introPlayed() {
      return readSettings().introPlayed === true
    },
    markIntro() {
      writeSettings({ introPlayed: true })
    },
    saveKey(apiKey) {
      const text = String(apiKey ?? '').trim()
      if (!text) return { ok: false, message: '先贴上钥匙' }
      const current = readSettings()
      if (existsSync(settingsPath)) writeSettings({ introPlayed: current.introPlayed === true })
      if (!crypto.available()) return { ok: false, message: '这台电脑存不了钥匙' }
      const sealed = Buffer.from(crypto.encrypt(text))
      if (sealed.includes(Buffer.from(text))) return { ok: false, message: '这台电脑存不了钥匙' }
      mkdirSync(root, { recursive: true })
      writeFileSync(keyPath, sealed, { mode: 0o600 })
      return { ok: true }
    },
    readKey() {
      if (!existsSync(keyPath) || !crypto.available()) return null
      try {
        const text = crypto.decrypt(readFileSync(keyPath))
        return text ? String(text) : null
      } catch {
        return null
      }
    },
  }
}

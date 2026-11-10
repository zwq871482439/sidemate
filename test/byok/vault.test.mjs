import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createVault } from '../../app/byok/vault.mjs'

const KEY = 'sk-sidemate-vault-sample-key'

function xor() {
  return {
    available: () => true,
    encrypt(text) {
      const buf = Buffer.from(text, 'utf8')
      for (let i = 0; i < buf.length; i++) buf[i] ^= 0x5a
      return buf
    },
    decrypt(buf) {
      const copy = Buffer.from(buf)
      for (let i = 0; i < copy.length; i++) copy[i] ^= 0x5a
      return copy.toString('utf8')
    },
  }
}

function found(dir, text) {
  const needles = [Buffer.from(text, 'utf8'), Buffer.from(text, 'utf16le')]
  const walk = (current) => {
    let names
    try { names = readdirSync(current) } catch { return false }
    for (const name of names) {
      if (name === '.credentials.yaml') return true
      const path = join(current, name)
      const st = statSync(path)
      if (st.isDirectory()) {
        if (walk(path)) return true
      } else if (needles.some((needle) => readFileSync(path).includes(needle))) return true
    }
    return false
  }
  return walk(dir)
}

test('the data directory never holds the key in the clear', () => {
  const root = mkdtempSync(join(tmpdir(), 'sidemate-byok-'))
  try {
    writeFileSync(join(root, '设置.json'), `{"rate":8,"key":"${KEY}"}\n`)
    const vault = createVault({ root, crypto: xor() })
    assert.equal(vault.saveKey(`  ${KEY}  `).ok, true)
    assert.equal(vault.readKey(), KEY)
    assert.equal(vault.hasKey(), true)
    assert.equal(vault.unreadable(), false)
    assert.equal(found(root, KEY), false)
    assert.deepEqual(JSON.parse(readFileSync(join(root, '设置.json'), 'utf8')), {})
    assert.equal(vault.introPlayed(), false)
    vault.markIntro()
    assert.equal(vault.introPlayed(), true)
    assert.deepEqual(JSON.parse(readFileSync(join(root, '设置.json'), 'utf8')), { introPlayed: true })
    assert.equal(found(root, KEY), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('plaintext and a missing cipher are refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'sidemate-byok-'))
  try {
    let encrypted = false
    const off = createVault({
      root,
      crypto: {
        available: () => false,
        encrypt() { encrypted = true; return Buffer.from(KEY) },
        decrypt() { return KEY },
      },
    })
    assert.equal(off.saveKey(KEY).message, '这台电脑存不了钥匙')
    assert.equal(encrypted, false)
    assert.equal(off.hasKey(), false)
    const plain = createVault({
      root,
      crypto: {
        available: () => true,
        encrypt: (text) => Buffer.from(text),
        decrypt: (buf) => buf.toString('utf8'),
      },
    })
    assert.equal(plain.saveKey(KEY).message, '这台电脑存不了钥匙')
    assert.equal(plain.hasKey(), false)
    assert.equal(found(root, KEY), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a key that cannot be opened counts as none', () => {
  const root = mkdtempSync(join(tmpdir(), 'sidemate-byok-'))
  try {
    const vault = createVault({
      root,
      crypto: {
        available: () => true,
        encrypt(text) {
          const buf = Buffer.from(text, 'utf8')
          for (let i = 0; i < buf.length; i++) buf[i] ^= 0x5a
          return buf
        },
        decrypt() { throw new Error('os crypt') },
      },
    })
    assert.equal(vault.saveKey(KEY).ok, true)
    assert.equal(vault.readKey(), null)
    assert.equal(vault.hasKey(), false)
    assert.equal(vault.unreadable(), true)
    assert.equal(found(root, KEY), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy settings with rate can be read and rewritten', () => {
  const root = mkdtempSync(join(tmpdir(), 'sidemate-byok-'))
  try {
    writeFileSync(join(root, '设置.json'), '{"rate":8,"introPlayed":true}\n')
    const vault = createVault({ root, crypto: xor() })
    assert.equal(vault.introPlayed(), true)
    vault.markIntro()
    assert.deepEqual(JSON.parse(readFileSync(join(root, '设置.json'), 'utf8')), { introPlayed: true })
    assert.equal(vault.saveKey('').message, '先贴上钥匙')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

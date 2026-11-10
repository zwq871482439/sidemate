import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { findForbidden, INCLUDE, scanText, snapshot } from '../../build/snapshot.mjs'

// 这个文件会被拷进公开仓，所以不写内部字眼的字面：一律用转义拼。
const person = 'Zha' + 'o'
const tracker = 'Line' + 'ar'
const card = 'SID' + '1-'
const code1 = '\u732b\u732b'
const code2 = '\u9996\u9886'
const oldWord = '\u65e7\u7248'
const oldRepo = '\u65e7\u4ed3'

function tree() {
  return mkdtempSync(join(tmpdir(), 'sidemate-snapshot-'))
}

function makeSource(root) {
  mkdirSync(join(root, 'app', 'main'), { recursive: true })
  mkdirSync(join(root, 'build'), { recursive: true })
  mkdirSync(join(root, 'test'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'app', 'main', 'main.mjs'), 'export const a = 1\n')
  writeFileSync(join(root, 'app', 'main', 'note.md'), '# 说明\n')
  writeFileSync(join(root, 'build', 'icon.ico'), 'ico')
  writeFileSync(join(root, 'test', 'x.test.mjs'), 'test("x", () => {})\n')
  writeFileSync(join(root, 'docs', 'release-0.2.0.md'), '# 0.2.0\n')
  writeFileSync(join(root, 'package.json'), '{"name":"sidemate"}\n')
  writeFileSync(join(root, 'PRIVACY.md'), '# 隐私与使用声明\n')
  writeFileSync(join(root, 'PRIVACY.en.md'), '# Privacy and terms of use\n')
  writeFileSync(join(root, 'SECURITY.md'), '# Security policy\n')
  writeFileSync(join(root, 'AGENTS.md'), '内部说明\n')
  writeFileSync(join(root, 'README.md'), '说明\n')
}

test('the forbidden words are the ones the card lists', () => {
  assert.equal(findForbidden(person).length, 1)
  assert.equal(findForbidden(`${card}79`).length, 1)
  assert.equal(findForbidden(tracker).length, 1)
  assert.equal(findForbidden(code1 + code2).length, 2)
  assert.equal(findForbidden(oldWord).length, 1)
  assert.equal(findForbidden(oldRepo).length, 1)
  assert.equal(findForbidden('正常内容').length, 0)
})

test('a card number only counts when a digit follows', () => {
  assert.equal(findForbidden(card).length, 0)
  assert.equal(findForbidden(`${card}79`).length, 1)
})

test('a dependency version number is not the old version number', () => {
  assert.equal(findForbidden('ecdsa-sig-formatter 1' + '.0.11').length, 0)
  assert.equal(findForbidden('版本 0' + '.11 做的').length, 1)
})

test('the scan reports the line each word is on', () => {
  const hits = scanText('第一行\n第二行 ' + card + '79\n第三行\n')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].line, 2)
})

test('snapshot copies the whitelist as is and leaves the rest behind', () => {
  const source = tree()
  const target = tree()
  try {
    makeSource(source)
    const result = snapshot(source, target)
    assert.ok(result.copied.includes('app/main/main.mjs'))
    assert.ok(result.copied.includes('package.json'))
    assert.ok(result.copied.includes('docs/release-0.2.0.md'))
    // 公开仓里那三份声明从 dev 仓原样拷过去，不在公开仓单独改。
    assert.ok(result.copied.includes('PRIVACY.md'))
    assert.ok(result.copied.includes('PRIVACY.en.md'))
    assert.ok(result.copied.includes('SECURITY.md'))
    assert.deepEqual(
      readFileSync(join(target, 'PRIVACY.md')),
      readFileSync(join(source, 'PRIVACY.md')),
    )
    assert.ok(!existsSync(join(target, 'AGENTS.md')))
    assert.ok(!existsSync(join(target, 'README.md')))
    // 原样拷贝：逐字节一致。
    assert.deepEqual(
      readFileSync(join(target, 'app', 'main', 'main.mjs')),
      readFileSync(join(source, 'app', 'main', 'main.mjs')),
    )
    assert.deepEqual(
      readFileSync(join(target, 'package.json')),
      readFileSync(join(source, 'package.json')),
    )
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})

test('snapshot fails when a copied file has a word it must not have', () => {
  const source = tree()
  const target = tree()
  try {
    makeSource(source)
    writeFileSync(join(source, 'app', 'main', 'main.mjs'), `// ${card}79\nexport const a = 1\n`)
    let error = null
    try {
      snapshot(source, target)
    } catch (err) {
      error = err
    }
    assert.ok(error, '有字眼时要报错')
    assert.equal(error.hits.length, 1)
    assert.equal(error.hits[0].rel, 'app/main/main.mjs')
    assert.equal(error.hits[0].hits[0].line, 1)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})

test('snapshot skips node_modules and payload', () => {
  const source = tree()
  const target = tree()
  try {
    makeSource(source)
    mkdirSync(join(source, 'app', 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(source, 'app', 'node_modules', 'x', 'index.js'), 'x')
    mkdirSync(join(source, 'app', 'payload'), { recursive: true })
    writeFileSync(join(source, 'app', 'payload', 'big.bin'), 'x')
    snapshot(source, target)
    assert.ok(!existsSync(join(target, 'app', 'node_modules')))
    assert.ok(!existsSync(join(target, 'app', 'payload')))
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})

test('snapshot refuses a target that does not exist', () => {
  const source = tree()
  try {
    makeSource(source)
    assert.throws(() => snapshot(source, join(source, 'no-such-dir')), /公开仓不在/)
  } finally {
    rmSync(source, { recursive: true, force: true })
  }
})

test('the whitelist holds the public files only', () => {
  assert.ok(INCLUDE.includes('app'))
  assert.ok(INCLUDE.includes('build'))
  assert.ok(INCLUDE.includes('test'))
  assert.ok(!INCLUDE.includes('AGENTS.md'))
  assert.ok(!INCLUDE.includes('.github'))
})

test('the three notices are on the whitelist so the public repo gets them from here', () => {
  assert.ok(INCLUDE.includes('PRIVACY.md'))
  assert.ok(INCLUDE.includes('PRIVACY.en.md'))
  assert.ok(INCLUDE.includes('SECURITY.md'))
})

test('the scan covers the three notices too', () => {
  const source = tree()
  const target = tree()
  try {
    makeSource(source)
    writeFileSync(join(source, 'PRIVACY.md'), `# 隐私与使用声明\n${card}79\n`)
    let error = null
    try {
      snapshot(source, target)
    } catch (err) {
      error = err
    }
    assert.ok(error, '声明里有字眼时也要报错')
    assert.equal(error.hits.length, 1)
    assert.equal(error.hits[0].rel, 'PRIVACY.md')
    assert.equal(error.hits[0].hits[0].line, 2)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})

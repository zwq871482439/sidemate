import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { compare, normalizeLicense, normalizeName, npmLicense, parseDeclared, renderList, syncList } from '../../build/licenses.mjs'

test('package names normalize underscores and case', () => {
  assert.equal(normalizeName('et_xmlfile'), 'et-xmlfile')
  assert.equal(normalizeName('Pillow'), 'pillow')
})

test('license strings unwrap one layer of parentheses', () => {
  assert.equal(normalizeLicense('(MIT OR CC0-1.0)'), 'MIT OR CC0-1.0')
})

test('npm license may be a string, an object, or a licenses array', () => {
  assert.equal(npmLicense({ license: 'MIT' }), 'MIT')
  assert.equal(npmLicense({ license: { type: 'ISC' } }), 'ISC')
  assert.equal(npmLicense({ licenses: [{ type: 'BSD-3-Clause' }] }), 'BSD-3-Clause')
  assert.equal(npmLicense({}), 'UNKNOWN')
})

test('the declared list is read only between the markers', () => {
  const text = [
    '随便写一句 - 不是清单项',
    '== 逐项清单 ==',
    '- zod 4.6.7 — MIT',
    '- lxml 6.1.3 — BSD-3-Clause',
    '== 清单结束 ==',
    '- 清单外的不算 - x — y',
  ].join('\n')
  const declared = parseDeclared(text)
  assert.equal(declared.length, 2)
  assert.deepEqual(declared[0], { name: 'zod', version: '4.6.7', license: 'MIT' })
})

test('a component missing from the list is reported', () => {
  const { missing, mismatched } = compare(
    [{ name: 'zod', version: '4.6.7', license: 'MIT' }],
    [{ name: 'zod', version: '4.0.0', license: 'MIT' }],
  )
  assert.equal(missing.length, 1)
  assert.match(missing[0].note, /4\.0\.0/)
  assert.equal(mismatched.length, 0)
})

test('a license that does not match is reported', () => {
  const { missing, mismatched } = compare(
    [{ name: 'zod', version: '4.6.7', license: 'MIT' }],
    [{ name: 'zod', version: '4.6.7', license: 'Apache-2.0' }],
  )
  assert.equal(missing.length, 0)
  assert.equal(mismatched.length, 1)
  assert.equal(mismatched[0].declared, 'Apache-2.0')
})

test('names differing only in case or underscore count as the same', () => {
  const { missing } = compare(
    [{ name: 'et_xmlfile', version: '2.0.0', license: 'MIT' }],
    [{ name: 'et-xmlfile', version: '2.0.0', license: 'MIT' }],
  )
  assert.equal(missing.length, 0)
})

test('syncing the list only rewrites the marked part', () => {
  const text = ['开头的话', '== 逐项清单 ==', '- 旧的 1.0 — MIT', '== 清单结束 ==', '结尾的话'].join('\n')
  const out = syncList(text, [{ name: 'zod', version: '4.6.7', license: 'MIT' }])
  assert.match(out, /^开头的话/)
  assert.match(out, /- zod 4\.6\.7 — MIT/)
  assert.doesNotMatch(out, /- 旧的/)
  assert.match(out, /结尾的话$/)
})

test('the list is sorted by name then version', () => {
  const out = renderList([
    { name: 'b', version: '1.0.0', license: 'MIT' },
    { name: 'a', version: '2.0.0', license: 'MIT' },
    { name: 'a', version: '1.0.0', license: 'MIT' },
  ])
  assert.deepEqual(out.split('\n'), [
    '- a 1.0.0 — MIT',
    '- a 2.0.0 — MIT',
    '- b 1.0.0 — MIT',
  ])
})

test('the notices file in the repo has a list section that parses', () => {
  const root = join(import.meta.dirname, '..', '..')
  const text = readFileSync(join(root, 'THIRD-PARTY-NOTICES.txt'), 'utf8')
  const declared = parseDeclared(text)
  assert.ok(declared.length > 100, `只解析出 ${declared.length} 项`)
})

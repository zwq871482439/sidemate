import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const skillRoot = resolve(root, 'app/skills/sidemate-writing')

test('the bundled writing skill has a valid dsh name and usage instructions', () => {
  const text = readFileSync(resolve(skillRoot, 'SKILL.md'), 'utf8')
  const name = text.match(/^name:\s*([^\r\n]+)$/m)?.[1]
  assert.equal(name, 'sidemate-writing')
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.match(text, /^description:\s*\S+/m)
  assert.match(text, /^whenToUse:\s*\S+/m)
  assert.match(text, /scripts\/compile_docx\.py/)
})

test('the writing skill stays within the main instruction line budget', () => {
  const text = readFileSync(resolve(skillRoot, 'SKILL.md'), 'utf8')
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  assert.ok(lines.length <= 150, `SKILL.md has ${lines.length} lines, expected at most 150`)
})

test('the writing skill covers the required drafting and delivery checks', () => {
  const text = readFileSync(resolve(skillRoot, 'SKILL.md'), 'utf8')
  for (const required of [
    '读者测试', '通读全文', '通常至少 100 字', '待确认建议（未写入正文）',
    '不悄悄写进正文', '〔S01·p1〕', '不一句一段', '去 AI 味',
  ]) {
    assert.ok(text.includes(required), `missing writing instruction: ${required}`)
  }
})

test('every bundled writing reference license has a third-party notice', () => {
  const licenses = readdirSync(resolve(skillRoot, 'licenses'), { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
  assert.ok(licenses.length > 0, 'expected bundled reference licenses')
  const notices = readFileSync(resolve(root, 'THIRD-PARTY-NOTICES.txt'), 'utf8')
  for (const license of licenses) {
    const path = `app/skills/sidemate-writing/licenses/${license}`
    assert.ok(notices.includes(path), `THIRD-PARTY-NOTICES.txt has no entry for ${path}`)
  }
})

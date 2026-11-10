import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pruneInspector } from '../../build/installer-assets.mjs'

test('ACP payload pruning removes only the unused inspector package', () => {
  const root = mkdtempSync(join(tmpdir(), 'sidemate-installer-'))
  try {
    const inspector = join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-experimental-inspector')
    const sibling = join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-acp-app')
    mkdirSync(join(inspector, 'lib', 'devtools'), { recursive: true })
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(inspector, 'lib', 'devtools', 'long.md'), 'unused')
    writeFileSync(join(sibling, 'index.js'), 'used')
    assert.equal(pruneInspector(root), inspector)
    assert.equal(existsSync(inspector), false)
    assert.equal(existsSync(join(sibling, 'index.js')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('NSIS hooks avoid TEMP moves and localize missing Chinese messages', () => {
  const script = readFileSync(new URL('../../build/installer.nsh', import.meta.url), 'utf8')
  const check = script.match(/!macro customCheckAppRunning([\s\S]*?)!macroend/)?.[1]
  const remove = script.match(/!macro customRemoveFiles([\s\S]*?)!macroend/)?.[1]
  assert.match(check, /!insertmacro IS_POWERSHELL_AVAILABLE\s+!insertmacro _CHECK_APP_RUNNING[\s\S]*RMDir \/r "\$INSTDIR\\resources\\app\\payload"/)
  assert.doesNotMatch(check, /\$PLUGINSDIR|\$TEMP/)
  assert.match(remove, /SetOutPath \$TEMP/)
  assert.match(remove, /RMDir \/r "\$INSTDIR"/)
  assert.doesNotMatch(remove, /Rename|old-install|\$PLUGINSDIR/)
  for (const id of ['uninstallFailed', 'decompressionFailed', 'appClosing']) {
    assert.match(script, new RegExp(`LangString ${id} 2052`))
  }
})

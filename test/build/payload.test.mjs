import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { PYPDF_WHEEL, bundledPackages, hostTarget, officePackages, selectWheels, unzip, wheelKey } from '../../build/payload.mjs'

test('wheel names match the eight office packages', () => {
  assert.equal(wheelKey('https://files.pythonhosted.org/packages/aa/python_docx-1.2.0-py3-none-any.whl'), 'python-docx')
  assert.equal(wheelKey('https://files.pythonhosted.org/packages/aa/et_xmlfile-2.0.0-py3-none-any.whl'), 'et-xmlfile')
  assert.equal(wheelKey('https://files.pythonhosted.org/packages/aa/typing_extensions-4.16.0-py3-none-any.whl'), 'typing-extensions')
  assert.equal(wheelKey('https://files.pythonhosted.org/packages/aa/Pillow-nope.whl'), 'pillow')
})

test('selectWheels keeps office wheels and drops numpy', () => {
  const wheel = (name) => ({ url: `https://example.test/${name}-1.0.0-py3-none-any.whl`, sha256: 'abc' })
  const lock = {
    targets: { 'linux-x64': { wheels: [wheel('pillow'), wheel('lxml'), wheel('numpy')] } },
    wheels: ['python_docx', 'typing_extensions', 'python_pptx', 'xlsxwriter', 'openpyxl', 'et_xmlfile', 'pandas'].map(wheel),
    pythonPackages: {
      Pillow: '12.3.0', lxml: '6.1.3', 'python-docx': '1.2.0', typing_extensions: '4.16.0',
      'python-pptx': '1.0.2', XlsxWriter: '3.2.9', openpyxl: '3.1.5', et_xmlfile: '2.0.0', numpy: '2.3.5',
    },
  }
  const picked = selectWheels(lock, 'linux-x64').map(item => wheelKey(item.url)).sort()
  assert.deepEqual(picked, ['et-xmlfile', 'lxml', 'openpyxl', 'pillow', 'python-docx', 'python-pptx', 'typing-extensions', 'xlsxwriter'])
  assert.deepEqual(Object.keys(officePackages(lock)).sort(), ['Pillow', 'XlsxWriter', 'et_xmlfile', 'lxml', 'openpyxl', 'python-docx', 'python-pptx', 'typing_extensions'])
})

test('pypdf 6.1.1 is pinned beside the office wheels', () => {
  assert.equal(PYPDF_WHEEL.version, '6.1.1')
  assert.match(PYPDF_WHEEL.url, /\/pypdf-6\.1\.1-py3-none-any\.whl$/)
  assert.equal(PYPDF_WHEEL.sha256, '7781f99493208a37a7d4275601d883e19af24e62a525c25844d22157c2e4cde7')
  const lock = {
    pythonPackages: {
      Pillow: '12.3.0', lxml: '6.1.3', 'python-docx': '1.2.0', typing_extensions: '4.16.0',
      'python-pptx': '1.0.2', XlsxWriter: '3.2.9', openpyxl: '3.1.5', et_xmlfile: '2.0.0',
    },
  }
  assert.equal(bundledPackages(lock).pypdf, '6.1.1')
  assert.equal(officePackages(lock).pypdf, undefined)
})

test('selectWheels fails closed when a package is absent', () => {
  const lock = { targets: { 'linux-x64': { wheels: [] } }, wheels: [] }
  assert.throws(() => selectWheels(lock, 'linux-x64'), /missing wheels/)
})

function zip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data, method } of entries) {
    const nameBuf = Buffer.from(name)
    const stored = method === 0
    const body = stored ? data : deflateRawSync(data)
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    nameBuf.copy(local, 30)
    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(stored ? 0 : 8, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    locals.push(local, body)
    centrals.push(central)
    offset += local.length + body.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

test('unzip writes deflated files and refuses parent paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sidemate-zip-'))
  try {
    unzip(zip([
      { name: 'pkg/', data: Buffer.alloc(0), method: 0 },
      { name: 'pkg/hello.txt', data: Buffer.from('你好'), method: 8 },
    ]), dir)
    assert.equal(readFileSync(join(dir, 'pkg', 'hello.txt'), 'utf8'), '你好')
    assert.throws(() => unzip(zip([{ name: '../x', data: Buffer.from('no'), method: 0 }]), dir), /zip path/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('host target follows this machine', () => {
  if (process.platform === 'linux' && process.arch === 'x64') assert.equal(hostTarget(), 'linux-x64')
  if (process.platform === 'win32' && process.arch === 'x64') assert.equal(hostTarget(), 'win-x64')
})

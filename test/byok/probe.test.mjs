import assert from 'node:assert/strict'
import test from 'node:test'
import { PROBE_OK } from '../../app/byok/copy.mjs'
import { PROBE_URL, probeKey } from '../../app/byok/probe.mjs'

const KEY = 'sk-sidemate-probe-sample'

function fake(status, { throwNow = false } = {}) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (throwNow) throw new Error(`down ${KEY}`)
    return { ok: status >= 200 && status < 300, status, async text() { return KEY } }
  }
  return { fetchImpl, calls }
}

test('a 5-output messages probe accepts a key and rejects a bad one', async () => {
  const good = fake(200)
  const ok = await probeKey(`  ${KEY}  `, good)
  assert.deepEqual(ok, { ok: true, message: PROBE_OK })
  assert.equal(ok.message.includes(KEY), false)
  const call = good.calls[0]
  assert.equal(call.url, PROBE_URL)
  assert.equal(call.options.redirect, 'error')
  assert.equal(call.options.headers['x-api-key'], KEY)
  assert.equal(call.options.headers['anthropic-version'], '2023-06-01')
  const body = JSON.parse(call.options.body)
  assert.equal(body.model, 'deepseek-flash')
  assert.equal(body.max_tokens, 5)
  assert.deepEqual(body.thinking, { type: 'disabled' })
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }])

  const bad = await probeKey(KEY, fake(401))
  assert.equal(bad.ok, false)
  assert.equal(bad.message, '这把钥匙不对')
  assert.equal(bad.message.includes(KEY), false)
  assert.equal((await probeKey(KEY, fake(403))).message, '这把钥匙不对')
})

test('probe failures stay one plain sentence', async () => {
  const unused = fake(200)
  assert.equal((await probeKey('  ', unused)).message, '先贴上钥匙')
  assert.equal(unused.calls.length, 0)
  assert.equal((await probeKey(KEY, fake(402))).message, '余额不够，先去充值')
  assert.equal((await probeKey(KEY, fake(429))).message, '那边太忙，过一会儿再测')
  assert.equal((await probeKey(KEY, fake(503))).message, '那边太忙，过一会儿再测')
  assert.equal((await probeKey(KEY, fake(400))).message, '没测成，过一会儿再试')
  assert.equal((await probeKey(KEY, fake(500, { throwNow: true }))).message, '连不上，检查一下网络')
})

import { PROBE_OK } from './copy.mjs'

const MODEL = 'deepseek-flash'
export const PROBE_URL = 'https://api.deepseek.com/anthropic/v1/messages'

const FAIL = {
  empty: '先贴上钥匙',
  key: '这把钥匙不对',
  quota: '余额不够，先去充值',
  busy: '那边太忙，过一会儿再测',
  network: '连不上，检查一下网络',
  other: '没测成，过一会儿再试',
}

function fail(kind) {
  return { ok: false, message: FAIL[kind] }
}

export async function probeKey(apiKey, options = {}) {
  const key = String(apiKey ?? '').trim()
  if (!key) return fail('empty')
  const fetchImpl = options.fetchImpl ?? fetch
  let response
  try {
    response = await fetchImpl(options.url ?? PROBE_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 5,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
  } catch {
    return fail('network')
  }
  if (response.ok) return { ok: true, message: PROBE_OK }
  const status = response.status
  if (status === 401 || status === 403) return fail('key')
  if (status === 402) return fail('quota')
  if (status === 429 || status >= 500) return fail('busy')
  return fail('other')
}

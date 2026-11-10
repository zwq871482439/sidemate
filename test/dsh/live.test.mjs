import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import https from 'node:https'
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { describe } from 'node:test'
import { runTask } from '../../app/dsh/index.mjs'

const live = process.env.SIDEMATE_DSH_LIVE === '1'
const key = process.env.LLM_API_KEY_Deepseek
const roots = []

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function files(dir) {
  const out = []
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      if (name.startsWith('.')) continue
      const path = join(current, name)
      const st = statSync(path)
      if (st.isDirectory()) walk(path)
      else out.push(path)
    }
  }
  walk(dir)
  return out
}

function gaps(times) {
  const sorted = [...times].sort((a, b) => a - b)
  let max = 0
  for (let i = 1; i < sorted.length; i++) max = Math.max(max, sorted[i] - sorted[i - 1])
  return max
}

function startSearchProxy() {
  const usages = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const payload = Buffer.concat(chunks)
      const headers = { ...req.headers, host: 'api.deepseek.com', 'content-length': String(payload.length) }
      delete headers['transfer-encoding']
      delete headers['accept-encoding']
      const upstream = https.request({
        hostname: 'api.deepseek.com',
        path: `/anthropic${req.url}`,
        method: req.method,
        headers,
      }, (up) => {
        const body = []
        up.on('data', (chunk) => body.push(chunk))
        up.on('end', () => {
          let buf = Buffer.concat(body)
          const encoding = up.headers['content-encoding']
          if (encoding === 'gzip') buf = gunzipSync(buf)
          else if (encoding === 'deflate') buf = inflateSync(buf)
          else if (encoding === 'br') buf = brotliDecompressSync(buf)
          try {
            const parsed = JSON.parse(buf.toString('utf8'))
            if (parsed.usage) usages.push(parsed.usage)
          } catch {
            // a non-json error body has no usage to count
          }
          const headers = { ...up.headers }
          delete headers['transfer-encoding']
          delete headers['content-encoding']
          delete headers['content-length']
          res.writeHead(up.statusCode ?? 502, headers)
          res.end(buf)
        })
      })
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
      upstream.end(payload)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        usages,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

async function once(prompt, extra = {}) {
  const workspace = scratch('sidemate-live-')
  const lowRoot = scratch('sidemate-live-low-')
  const events = []
  const started = Date.now()
  const handle = runTask({
    taskId: extra.taskId ?? 'live',
    workspace,
    lowRoot,
    prompt,
    apiKey: key,
    stallMs: extra.stallMs ?? 240_000,
    searchBaseUrl: extra.searchBaseUrl,
    onEvent: (event) => {
      events.push(event)
      const text = event.text || event.name || event.message || event.status || ''
      console.log(`${event.type} ${text}`.slice(0, 160))
    },
  })
  const end = await handle.done
  let log = ''
  try {
    log = readFileSync(handle.logPath, 'utf8')
  } catch {
    log = ''
  }
  return { end, events, workspace, files: files(workspace), gap: gaps([started, ...events.map(event => event.at)]), log }
}

describe('live model', { concurrency: 1, skip: !live }, () => {
test('live hello.docx', { timeout: 300_000 }, async () => {
  assert.equal(typeof key, 'string')
  assert.ok(key.length > 8)
  try {
    const result = await once('写一份 hello.docx，文件名必须是 hello.docx，放在当前文件夹。', { taskId: 'hello' })
    console.log(`gap_ms ${result.gap}`)
    console.log(`files ${result.files.map(file => file.split('/').pop()).join(',')}`)
    if (result.end.status !== 'done') console.log(result.log.slice(-3000))
    assert.equal(result.end.status, 'done')
    assert.equal(result.files.some(file => file.endsWith('hello.docx')), true)
  } finally {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  }
})

test('live news.docx search usage', { skip: !live, timeout: 300_000 }, async () => {
  assert.equal(typeof key, 'string')
  const proxy = await startSearchProxy()
  try {
    const result = await once('查一下今天的一条新闻，写进 news.docx。文件名必须是 news.docx，放在当前文件夹。', {
      taskId: 'news',
      searchBaseUrl: proxy.url,
    })
    console.log(`gap_ms ${result.gap}`)
    console.log(`files ${result.files.map(file => file.split('/').pop()).join(',')}`)
    console.log(`search_usage ${JSON.stringify(proxy.usages)}`)
    if (result.end.status !== 'done') console.log(result.log.slice(-3000))
    assert.equal(result.end.status, 'done')
    assert.equal(result.files.some(file => file.endsWith('news.docx')), true)
    assert.ok(proxy.usages.length > 0)
  } finally {
    await proxy.close()
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  }
})
})

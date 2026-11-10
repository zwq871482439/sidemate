// 用量记录：每个任务每一轮结束，把这一轮的用量记进 userData 下的 usage.json，
// 设置页看「这个月一共用了多少」和「最近 10 个任务各用了多少」。只攒数，不乘单价、不算钱。
// 纯 Node、不碰 electron：node --test 直接测；壳（app/byok/shell.mjs）起进程时把 userData 交进来。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const USAGE_FILE = 'usage.json'
const NAME_MAX = 20
const RECENT_MAX = 10

// 合计公式（能跟 DeepSeek 后台对上的数）：
//   inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens
// 后台按「输入（缓存命中 + 没命中）+ 输出」记。dsh 报的四个数里 inputTokens 只是
// 「没命中的输入」，不含缓存读、也不含缓存写——dsh-llm 的 types.d.ts 写明
// “inputTokens is uncached input only; billed input = sum of the three”
// （inputTokens + cacheReadTokens + cacheWriteTokens），docs/事件.md 也写了
// 「cacheWriteTokens 按未命中价算」，即后台把缓存写记进没命中的输入。所以四项全加。
// 联网搜索按次数记在 searches，不折进这个数。
export function usageTotal(usage) {
  const row = usage || {}
  return Math.round(count(row.inputTokens) + count(row.outputTokens) + count(row.cacheReadTokens) + count(row.cacheWriteTokens))
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

// 任务名 = 用户那句话前 20 字左右：换行折成空格，免得名字里藏行
export function taskTitle(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
}

// 过万写「万」、保留一位小数（124.6 万、3.1 万），整数不带 .0（2 万）；不到一万写原数。
// 先除以 1000 再四舍五入：10500 → 1.1 万，不吃 1.05×10 的浮点亏。
export function formatCount(value) {
  const n = Math.max(0, Math.round(Number(value) || 0))
  if (n < 10_000) return String(n)
  const wan = Math.round(n / 1000) / 10
  return `${wan % 1 === 0 ? String(wan) : wan.toFixed(1)} 万`
}

const two = (n) => String(n).padStart(2, '0')

export function monthKey(at) {
  const date = new Date(at)
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}`
}

export function dayLabel(at) {
  const date = new Date(at)
  return `${two(date.getMonth() + 1)}-${two(date.getDate())}`
}

function validRow(row) {
  return !!row && typeof row === 'object' && typeof row.at === 'number' && Number.isFinite(row.at)
}

function readRows(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const rows = Array.isArray(parsed?.records) ? parsed.records : []
    return rows.filter(validRow)
  } catch {
    return [] // 文件坏了当没有：设置页照常开，下一轮会把它写成好的
  }
}

// 一份记录文件：add 一轮，read 全部。读写任一处失败都不抛，只回 false / 空表
export function createUsageStore({ file, now = () => Date.now() }) {
  return {
    file,
    read() {
      return readRows(file)
    },
    add(usage, utterance = '') {
      try {
        const rows = readRows(file)
        const row = usage || {}
        rows.push({
          name: taskTitle(utterance),
          at: typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : now(),
          inputTokens: count(row.inputTokens),
          outputTokens: count(row.outputTokens),
          cacheReadTokens: count(row.cacheReadTokens),
          cacheWriteTokens: count(row.cacheWriteTokens),
          searches: count(row.searches),
        })
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, `${JSON.stringify({ version: 1, records: rows }, null, 2)}\n`, 'utf8')
        return true
      } catch {
        return false // 写不进（盘满、目录只读）就丢这一轮的记录，不能崩
      }
    },
  }
}

let store = null

// 壳起进程时把 userData 交进来；传空等于解绑（测试收尾用）。没绑过就什么都不记
export function bindUsageStore(dir) {
  store = dir ? createUsageStore({ file: join(dir, USAGE_FILE) }) : null
  return store
}

// run.mjs 每轮收尾调用这一处：用户那句话当任务名 + 这一轮的用量（含 searches，界面先不显示）
export function noteUsage(utterance, usage) {
  if (!store) return false
  return store.add(usage, utterance)
}

// 设置页那份视图：当前月合计 + 最近 10 条，每条 任务名 · 日期（11-08）· 用量
export function usageView(records, now = Date.now()) {
  const rows = (Array.isArray(records) ? records : []).filter(validRow).slice()
  rows.sort((a, b) => b.at - a.at)
  const month = monthKey(now)
  const total = rows.filter((row) => monthKey(row.at) === month).reduce((sum, row) => sum + usageTotal(row), 0)
  return {
    heading: `${new Date(now).getMonth() + 1} 月一共用了`,
    total: formatCount(total),
    recent: rows.slice(0, RECENT_MAX).map((row) => ({
      name: typeof row.name === 'string' && row.name ? row.name : '一个任务',
      date: dayLabel(row.at),
      usage: formatCount(usageTotal(row)),
    })),
  }
}

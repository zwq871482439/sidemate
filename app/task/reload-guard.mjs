// 渲染进程没了以后要不要重载：纯函数，不 import electron，node --test 直接测。
// 60 秒里连着出事有上限：前 3 次重载，第 4 次起不再重载；过了 60 秒重新算。

export const RENDER_GONE_WINDOW_MS = 60_000
export const RENDER_GONE_LIMIT = 3

export function createReloadGuard(options = {}) {
  const windowMs = options.windowMs ?? RENDER_GONE_WINDOW_MS
  const limit = options.limit ?? RENDER_GONE_LIMIT
  const clock = options.clock ?? (() => Date.now())
  let seen = []
  return {
    // 记一次 render-process-gone；返回要不要重载、是不是放弃了
    gone(details = {}) {
      const reason = typeof details.reason === 'string' ? details.reason : 'unknown'
      const at = typeof details.at === 'number' ? details.at : clock()
      if (reason === 'clean-exit') return { reload: false, gaveUp: false, count: seen.length, reason }
      seen = seen.filter((one) => at - one < windowMs)
      const count = seen.length + 1
      seen.push(at)
      if (count > limit) return { reload: false, gaveUp: true, count, reason }
      return { reload: true, gaveUp: false, count, reason }
    },
    reset() { seen = [] },
  }
}

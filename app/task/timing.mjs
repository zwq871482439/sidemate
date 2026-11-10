// 跑了多久：一段毫秒 → 「14 秒」「1 分 34 秒」。
// 小岛悬停那行和任务窗「正在工作」那行用同一个函数、同一套写法。
// 纯函数，主进程和页面都能用。

export function elapsedText(ms) {
  const sec = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  const min = Math.floor(sec / 60)
  const rest = sec % 60
  return min ? `${min} 分 ${rest} 秒` : `${rest} 秒`
}

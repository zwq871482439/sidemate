// 小岛上的两种手势：点一下、拖文件进来。
// 点一下 → 任务窗开着就收起来，收起不到半秒的别再弹出来；
//          打开的时候照旧把「等你一句话」收回去，收起来的时候不动它 —— 活接着干。
//          那一下小岛还要缩到 0.96 再弹回（press）。
// 拖文件 → 照旧打开任务窗，把文件带进去（收窗的事不管）。

export function petClick({ toggle, clearAsk, press }) {
  const what = typeof toggle === 'function' ? toggle() : 'opened'
  if (typeof press === 'function') press()
  if (what === 'opened') clearAsk?.()
  return what
}

export function petDrop({ openTask, clearAsk, paths, cell }) {
  const list = Array.isArray(paths) ? paths : []
  if (!list.length) return false
  openTask({ paths: list, cell })
  clearAsk?.()
  return true
}

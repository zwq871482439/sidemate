// 小岛的位置：只能吸在屏幕顶边，沿顶边左右挪；有几块屏，就能拖到哪块屏的顶边。

export function clamp(value, lo, hi) {
  return Math.min(Math.max(value, lo), hi)
}

// 顶边正中（默认位置）
export function centerX(area, width) {
  return Math.round(area.x + (area.width - width) / 2)
}

// 沿顶边左右挪，不能出屏幕
export function clampX(x, area, width) {
  return Math.round(clamp(x, area.x, area.x + Math.max(0, area.width - width)))
}

// 顶边上的小条
export function topStrip(x, area, width, height) {
  return { x: clampX(x, area, width), y: area.y, width, height }
}

// 冒一行时中心不动：左右各长出去
export function expandedBounds(rest, width, area) {
  const cx = rest.x + rest.width / 2
  return {
    x: Math.round(clamp(cx - width / 2, area.x, area.x + Math.max(0, area.width - width))),
    y: rest.y,
    width,
    height: rest.height,
  }
}

// 鼠标（或小岛）在哪块屏：拿 Electron 的 screen 换那块屏；拿不到就回主屏
export function displayAt(scr, point) {
  try { return scr.getDisplayNearestPoint(point) } catch { return scr.getPrimaryDisplay() }
}

// 拖动开始时鼠标抓在小岛的哪儿：
// 从收着的小条开始拖，照旧保留按下时鼠标在条里的偏移，抓哪儿还是哪儿；
// 从张开的样子（或细线）开始拖，收回小条时小条居中对着鼠标（grab.x = 半条宽）——
// 张开那块有两三百宽，把在那上面按下的偏移带给 112 宽的小条，小条会往左跳。
export function dragGrab(scene, point, bounds, island) {
  if (scene === 'strip') return { x: point.x - bounds.x, y: point.y - bounds.y }
  return { x: island / 2, y: point.y - bounds.y }
}

// 拖动时算小岛该在哪儿。纯函数：鼠标位置和鼠标所在那块屏的 workArea 进，位置出。
// 不管拖多低都贴在那块屏的顶边，只是左右跟着鼠标走（保留按下时抓的偏移）。
// point：鼠标位置（逻辑像素，和 setBounds 一样，不用按缩放换算）
// grab：按下时鼠标在窗口里的偏移（相对左上角）
// options：{ work, island }
export function dragBounds(point, grab, options) {
  const { work, island } = options
  const offset = grab?.x ?? island / 2
  return { x: clampX(point.x - offset, work, island), y: work.y }
}

// 存的那块屏还在不在：先按 id 找，id 变了（拔了重插）再按 bounds 找
function displayOf(scr, saved) {
  let all
  try { all = scr.getAllDisplays() } catch { return null }
  const byId = all.find((item) => item.id === Number(saved.display))
  if (byId) return byId
  const bounds = saved.displayBounds
  if (!bounds || typeof bounds !== 'object') return null
  return all.find((item) => item.bounds.x === bounds.x && item.bounds.y === bounds.y
    && item.bounds.width === bounds.width && item.bounds.height === bounds.height) || null
}

// 启动恢复：算小岛该在哪块屏的顶边、x 是多少。纯函数，screen 拿假的也能测。
// 存过在哪块屏就照存的放；那块屏不在了就回主屏顶边正中。
// 以前存过小球（scene 是 'ball'，或带 ball 字段）的一律当吸顶：贴在球那块屏的顶边，x 用球心减半个小岛再夹进屏内。
export function restorePlace(saved, scr, island) {
  const primary = scr.getPrimaryDisplay()
  const old = saved && typeof saved === 'object' ? saved : null
  // 旧的小球数据：迁成吸顶
  if (old && old.ball && typeof old.ball === 'object' && Number.isFinite(Number(old.ball.x))) {
    const spot = {
      x: Number(old.ball.x),
      y: Number.isFinite(Number(old.ball.y)) ? Number(old.ball.y) : Number(old.ball.x),
    }
    const work = displayAt(scr, spot).workArea
    return { area: work, x: clampX(spot.x - island / 2, work, island) }
  }
  // 新格式：存了在哪块屏（display.id，外加那份 bounds 防 id 变）和相对那块屏左边的 x
  if (old && Number.isFinite(Number(old.display))) {
    const display = displayOf(scr, old)
    if (!display) return { area: primary.workArea, x: centerX(primary.workArea, island) }
    const work = display.workArea
    const rel = Number.isFinite(Number(old.x)) ? Number(old.x) : Math.round((work.width - island) / 2)
    return { area: work, x: clampX(work.x + rel, work, island) }
  }
  // 旧格式（只存了绝对 x/y）：那块屏还在就照旧的放
  if (old && Number.isFinite(Number(old.x))) {
    const work = displayAt(scr, {
      x: Number(old.x),
      y: Number.isFinite(Number(old.y)) ? Number(old.y) : Number(old.x),
    }).workArea
    return { area: work, x: clampX(Number(old.x), work, island) }
  }
  // 没存过：主屏顶边正中
  return { area: primary.workArea, x: centerX(primary.workArea, island) }
}

// 拖着文件碰到小岛时该变成什么样子。
// 收成细线的时候也要变回小岛接文件，不然从桌面拖文件过来落点只剩 64×4。
export function dropScene(current) {
  if (current === 'line') return 'tray'
  if (current === 'strip') return 'tray'
  return null
}

export function contains(outer, inner) {
  return inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5
    && inner.x + inner.width <= outer.x + outer.width + 0.5
    && inner.y + inner.height <= outer.y + outer.height + 0.5
}

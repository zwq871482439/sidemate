// 小岛上的按下 → 移动 → 松手：
// 鼠标按下后挪够 DRAG_THRESHOLD_PX 才算开始拖，没挪够松手就是点击。
// 点击绝不挪位置：dragStart 只在挪够阈值那一刻才发，点一下不发 dragStart / dragEnd，
// 壳里的位置（rest、pet-place.json）一个像素都不动。
// 纯函数：页面（pet.js）和测试共用这一个阈值，页面里不再自己写 4。

export const DRAG_THRESHOLD_PX = 4

// 按下：只记起点
export function startGesture(point) {
  return { startX: point.x, startY: point.y, dragging: false }
}

function movedFrom(state, point) {
  if (!point) return 0
  return Math.hypot(point.x - state.startX, point.y - state.startY)
}

// 移动：挪够阈值的那一刻从「按着」变「拖着」，之后一直是拖。
// 没到阈值时原样返回（同一个对象），到阈值换新对象，调用方看对象变没变就知道该不该发 dragStart。
export function moveGesture(state, point) {
  if (!state || state.dragging) return state
  if (movedFrom(state, point) >= DRAG_THRESHOLD_PX) return { ...state, dragging: true }
  return state
}

// 松手：'drag'（拖过了，壳收位置）、'click'（没挪够，只走开关）、'none'（没按下过）
export function endGesture(state, point) {
  if (!state) return 'none'
  if (state.dragging || movedFrom(state, point) >= DRAG_THRESHOLD_PX) return 'drag'
  return 'click'
}

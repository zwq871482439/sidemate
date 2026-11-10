// 帘子动画的方向：同一个方向不重放，反方向倒着走（从当前位置接着走）。
// 纯判断，不碰页面：页面那边（task.js）照这个结果做事。

// current：现在这段动画 { state: 'running' | ... , dir: 'in' | 'out' }，没有就是 null
// wanted：要去的方向 'in'（往下拉开）或 'out'（往上收）
// 返回：'start' 重新放一段、'keep' 别动、'reverse' 倒着走
export function animStep(current, wanted) {
  if (!current || current.state !== 'running') return 'start'
  if (current.dir === wanted) return 'keep'
  return 'reverse'
}

// 滚动该往哪去：纯函数，页面照着做，好测。
// 离底不超过 GAP：滚到底；超过 GAP：用户自己在往上翻着看，别硬拽。
// force 是「刚发完消息」这种一定要到底的情形。

export const GAP = 80

export function scrollDecision({ distance = 0, force = false } = {}) {
  if (force) return 'bottom'
  const gap = Number(distance) || 0
  return gap > GAP ? 'keep' : 'bottom'
}

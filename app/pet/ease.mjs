// 三条曲线（设计稿第三节）：出来 cubic-bezier(0.2,0.8,0.2,1)、收回 cubic-bezier(0.4,0,0.2,1)、
// 弹一下 cubic-bezier(0.34,1.56,0.64,1)。这里是同一个 bezier 求解器。

export function cubicBezier(x1, y1, x2, y2) {
  const A = (a, b) => 1 - 3 * b + 3 * a
  const B = (a, b) => 3 * b - 6 * a
  const C = (a) => 3 * a
  const calc = (t, a, b) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t
  const slope = (t, a, b) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a)
  return (x) => {
    if (!(x > 0)) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i += 1) {
      const d = slope(t, x1, x2)
      if (!d) break
      t -= (calc(t, x1, x2) - x) / d
    }
    return calc(t, y1, y2)
  }
}

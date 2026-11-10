// 小岛的分区和尺寸：
// 字号是一个变量（theme.font = 13），小岛高度、眼睛、表情区宽度、文字区边距都从它算出来，
// 没有写死的 30 / 56。
// 1:1 的样子（字号 13）：收着整条 112×30 都是表情区，眼睛中心在 x=46、x=66、y=15；
// 冒一行时左边 56 宽是表情区（眼睛在里面居中，中心 x=28），右边是文字区。

export const BASE = {
  font: 13, // 1:1 的字号
  height: 30, // 小岛高
  island: 112, // 收着时整条宽
  eyeZone: 56, // 冒一行时左边表情区宽
  eyeGap: 20, // 两只眼睛中心差
  eyeY: 15, // 眼睛中心的 y
  eyeRadius: 5.3, // 待命的圆眼半径
  zoneGap: 8, // 两区之间的空
  padRight: 16, // 右边留 16
  textPad: 8, // 文字区里左右各留 8，字在中间
  bubbleHardMax: 460, // 字特别长的时候封顶
}

// 按字号算出来的一套尺寸。字号 13 时就是 112×30、表情区 56。
export function layoutFor(fontSize = BASE.font) {
  const font = Number(fontSize) || BASE.font
  const scale = font / BASE.font
  const px = (value) => Math.round(value * scale)
  return {
    font,
    scale,
    height: px(BASE.height), // 30 → 字号 16 时 37
    island: px(BASE.island), // 112 → 138
    eyeZone: px(BASE.eyeZone), // 56 → 69
    // 收着时整条是表情区，眼睛在整条正中；冒一行时表情区只剩左边这一段，
    // 眼睛跟着往左挪（1:1 是 28；SVG 里是用户单位，不随字号变）
    eyeShift: (BASE.island - BASE.eyeZone) / 2,
    eyeGap: BASE.eyeGap * scale,
    eyeRadius: BASE.eyeRadius * scale,
    zoneGap: px(BASE.zoneGap),
    padRight: px(BASE.padRight),
    textPad: px(BASE.textPad),
    // 红点：1:1 时中心在 x=96、y=8.7、半径 3（贴着右边）
    dotRight: 13 * scale,
    dotTop: 5.7 * scale,
    dotSize: 6 * scale,
    bubbleHardMax: px(BASE.bubbleHardMax),
  }
}

// 文字区有多宽：跟着字走，左右各留 8，字在中间
export function textZoneWidth(textWidth, box) {
  return (Number(textWidth) || 0) + box.textPad * 2
}

// 冒一行时整条有多宽：左边表情区 + 空 + 文字区 + 右边留白
export function expandedWidth(textWidth, box) {
  const need = box.eyeZone + box.zoneGap + textZoneWidth(textWidth, box) + box.padRight
  return Math.round(Math.max(box.island, Math.min(box.bubbleHardMax, need)))
}

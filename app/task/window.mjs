// 任务窗的窗子：透明窗，底色、圆角、阴影都在页面里画（设计稿第三节②）。
// 透明窗在 Windows 上的坑：不能拉伸、系统阴影画不出来、全透明的地方收不到拖放。
// 所以 resizable: false、hasShadow: false，页面根节点留一层几乎看不见的底接着拖放。

export const WIDTH = 460
export const MAX_H = 640
export const MIN_H = 200
export const GAP = 8

// 建窗的选项：壳建窗时用，测试也照这个断言
export function taskWindowOptions({ width = WIDTH, height = 320, onTop = true, icon = '' } = {}) {
  return {
    width, height, show: false, frame: false,
    // 透明窗：屏上看到的只有在动的那块
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: onTop, skipTaskbar: true,
    // 阴影自己画（页面里 drop-shadow），系统阴影透明窗用不了
    hasShadow: false,
    title: '桌伴', icon,
  }
}

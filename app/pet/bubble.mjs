// 冒的那一行：五个状态各一行字，末尾可能有能点的「打开」「去设置」。
// 这一行只在鼠标停着（小岛张着）的时候出现；有事不再自动冒字。
// 纯函数，不碰 electron，好测。

// 干活中那行后面的秒数：1 分 20 秒。跟任务窗「正在工作」那行同一个函数。
import { elapsedText } from '../task/timing.mjs'

export { elapsedText }

export function bubbleOf(state) {
  const mode = state?.mode || 'idle'
  const message = (state?.message || '').trim()
  const artifact = (state?.artifact || '').trim()
  const elapsed = (state?.elapsed || '').trim()
  // 干活中只说「正在工作 · 跑了多久」：
  // 「看材料 2/5」「写《…》」这类过程话不往小岛上冒了
  if (mode === 'work') {
    return { text: elapsed ? `正在工作 · ${elapsed}` : '正在工作', actions: [] }
  }
  if (mode === 'look') {
    return { text: message ? `等你一句话：${message}` : '等你一句话', actions: [] }
  }
  if (mode === 'done') {
    // 做完了不再写文件名：写通用的「做完了 · 点开看看」；有产出才给「打开」
    return { text: '做完了 · 点开看看', actions: artifact ? [{ id: 'open', label: '打开' }] : [] }
  }
  if (mode === 'fail') {
    return { text: `没干成：${message || '这次没做成'}`, actions: [{ id: 'settings', label: '去设置' }] }
  }
  return { text: '点一下开新任务，文件也能拖到这儿', actions: [] }
}

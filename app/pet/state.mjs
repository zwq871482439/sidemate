// 宠的五个状态（设计稿第二节）：待命 / 干活中 / 要你看一眼 / 做完了 / 没干成。
// 状态来源还是 pet.ingest(event)：壳把 dsh 和任务窗的事件收成这五种。
// 做完了、要你看一眼、没干成这三种一直保持到用户点开小岛（任务窗打开）才回待命。

export const MODES = ['idle', 'work', 'look', 'done', 'fail']

// 做完了那一句：通知用
export const DONE_NOTE = '做完了'

export function createState() {
  return { mode: 'idle', taskId: null, message: '', artifact: '', notice: '' }
}

function textOf(event) {
  if (typeof event.message === 'string' && event.message.trim()) return event.message.trim()
  if (typeof event.reason === 'string' && event.reason.trim()) return event.reason.trim()
  return '这次没做成'
}

// 通知的话：事件里带了就用它（等你一句话），没带就用正文
function noticeOf(event, fallback) {
  return typeof event.notice === 'string' && event.notice.trim() ? event.notice.trim() : fallback
}

export function reduce(state, event) {
  const none = { state, notify: false, hold: false }
  if (!event || typeof event.type !== 'string') return none
  const taskId = event.taskId ?? null
  const artifact = typeof event.path === 'string' && event.path ? event.path : state.artifact
  // 任务窗问了一句：要你看一眼（睁大 + 红点，一直保持）
  if (event.type === 'ask' || event.type === 'question') {
    const message = textOf(event)
    return { state: { mode: 'look', taskId, message, artifact, notice: noticeOf(event, message) }, notify: true, hold: true }
  }
  // 没干成：平线，一直保持
  if (event.type === 'error' || (event.type === 'end' && event.status === 'error')) {
    const message = textOf(event)
    return { state: { mode: 'fail', taskId, message, artifact, notice: message }, notify: true, hold: true }
  }
  if (event.type === 'end' && event.status === 'cancelled') {
    return { state: createState(), notify: false, hold: false }
  }
  // 做完了：笑眼，一直保持（勾和「停一下回待命」都不要了）
  if (event.type === 'end' && event.status === 'done') {
    return { state: { mode: 'done', taskId, message: DONE_NOTE, artifact, notice: DONE_NOTE }, notify: true, hold: true }
  }
  // 干活中：往下看 + 左右慢慢扫
  if (event.type === 'progress' || event.type === 'artifact' || event.type === 'usage') {
    const text = typeof event.text === 'string' ? event.text.trim() : ''
    return {
      state: { mode: 'work', taskId, message: text || state.message, artifact, notice: '' },
      notify: false,
      hold: false,
    }
  }
  if (taskId && taskId !== state.taskId) {
    return { state: { mode: 'work', taskId, message: state.message, artifact, notice: '' }, notify: false, hold: false }
  }
  return none
}

// 用户点开小岛 / 任务窗打开：这三种收回去，回待命；干活中不动
export function clearHeld(state) {
  return state.mode === 'done' || state.mode === 'look' || state.mode === 'fail' ? createState() : state
}

// 老名字留着，别处还在用
export const clearAsk = clearHeld
export const clearLook = clearHeld

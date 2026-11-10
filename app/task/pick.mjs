// 「加文件」对话框：开着的时候任务窗会失焦，这时候不能把窗收起来；
// 对话框关掉以后再把窗叫回前面来。挑文件的事留在壳里，这里只管开框和收尾。

export function createPicker({ showOpenDialog, focus }) {
  let picking = false
  return {
    // 对话框开着没有：壳收窗前先问一句
    get picking() {
      return picking
    },
    async pick(win, options) {
      if (picking) return null
      picking = true
      try {
        return await showOpenDialog(win, options)
      } finally {
        picking = false
        // 框关了，窗叫回前面来；叫不回来也不能把活弄丢
        try { focus?.(win) } catch { /* 叫不回来就算了 */ }
      }
    },
  }
}

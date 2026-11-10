// 任务窗的桥，六个通道：task:ready 拿当前视图，task:view 收主进程推来的新视图，
// task:act 发用户的动作，task:drop 发拖进来的文件（路径用 webUtils 取，Electron 32 起没有 File.path），
// task:size 报窗里内容有多高（窗高跟着内容长），
// task:link 让主进程用系统浏览器开回话里的链接（主进程再核一遍协议）。

const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('task', {
  ready: () => ipcRenderer.invoke('task:ready'),
  onView: (fn) => ipcRenderer.on('task:view', (_event, view) => fn(view)),
  onAnim: (fn) => ipcRenderer.on('task:anim', (_event, kind) => fn(kind)),
  act: (action) => ipcRenderer.send('task:act', action),
  size: (height) => ipcRenderer.send('task:size', { height }),
  drop: (files, cell) => ipcRenderer.send('task:drop', { paths: [...files].map((file) => webUtils.getPathForFile(file)), cell }),
  openLink: (url) => ipcRenderer.send('task:link', url),
})

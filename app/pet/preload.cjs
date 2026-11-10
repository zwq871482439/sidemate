// Electron 32 起没有 File.path。完整路径在这里用 webUtils.getPathForFile 拿。

const { contextBridge, ipcRenderer, webUtils } = require('electron')
const send = (name) => (...args) => ipcRenderer.send(`pet:${name}`, ...args)
const on = (name, fn) => ipcRenderer.on(`pet:${name}`, (_event, payload) => fn(payload))

contextBridge.exposeInMainWorld('pet', {
  ready: () => ipcRenderer.invoke('pet:ready'),
  dragStart: send('drag-start'),
  dragEnd: send('drag-end'),
  dragEnter: send('drag-enter'),
  dragLeave: send('drag-leave'),
  drop: (files, at) => ipcRenderer.send('pet:drop', { paths: [...files].map((file) => webUtils.getPathForFile(file)), at }),
  click: send('click'),
  menu: send('menu'),
  action: send('action'),
  measure: send('measure'),
  hover: send('hover'),
  leave: send('leave'),
  introLine: send('intro-line'),
  onState: (fn) => on('state', fn),
  onScene: (fn) => on('scene', fn),
  onBubble: (fn) => on('bubble', fn),
  onIntro: (fn) => on('intro', (payload) => fn(payload)),
  onPress: (fn) => on('press', (payload) => fn(payload)),
})

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('byok', {
  boot: () => ipcRenderer.invoke('byok:boot'),
  probe: (key) => ipcRenderer.invoke('byok:probe', key),
  saveKey: (key) => ipcRenderer.invoke('byok:save-key', key),
  playIntro: () => ipcRenderer.invoke('byok:intro'),
  close: () => ipcRenderer.invoke('byok:close'),
  openDocs: () => ipcRenderer.invoke('byok:docs'),
})

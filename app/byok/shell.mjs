import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOCS_URL, INTRO_HINT, SAFETY } from './copy.mjs'
import { probeKey } from './probe.mjs'
import { createVault } from './vault.mjs'
import { playIntroOnce } from '../pet/intro.mjs'
import { bindUsageStore, usageView } from '../usage/index.mjs'
import { iconPath } from '../assets/icon.mjs'

const dir = dirname(fileURLToPath(import.meta.url))
let vault
let usageStore
let playIntro = async () => {}
let bound = false
let firstWin
let settingsWin

function systemCrypto() {
  return {
    available: () => {
      try { return safeStorage.isEncryptionAvailable() } catch { return false }
    },
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (buf) => safeStorage.decryptString(buf),
  }
}

function useVault() {
  if (!vault) vault = createVault({ root: join(homedir(), '桌伴'), crypto: systemCrypto() })
  return vault
}

function windowOptions() {
  return {
    width: 560,
    height: 760,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f1e8',
    title: '桌伴',
    icon: iconPath,
    webPreferences: {
      preload: join(dir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }
}

function open(view) {
  const current = view === 'settings' ? settingsWin : firstWin
  if (current && !current.isDestroyed()) {
    current.show()
    current.focus()
    return
  }
  const win = new BrowserWindow(windowOptions())
  win.once('ready-to-show', () => win.show())
  win.loadFile(join(dir, 'page.html'), { query: { view } })
  if (view === 'settings') settingsWin = win
  else firstWin = win
}

function bind() {
  if (bound) return
  bound = true
  usageStore = bindUsageStore(app.getPath('userData')) // 用量记录跟着壳的 userData
  ipcMain.handle('byok:boot', () => {
    const store = useVault()
    return {
      safety: SAFETY,
      hint: INTRO_HINT,
      hasKey: store.hasKey(),
      unreadable: store.unreadable(),
      step: store.hasKey() && !store.introPlayed() ? 'intro' : 'safety',
      usage: usageView(usageStore.read()),
    }
  })
  ipcMain.handle('byok:probe', (_event, key) => probeKey(key))
  ipcMain.handle('byok:save-key', (_event, key) => useVault().saveKey(key))
  ipcMain.handle('byok:intro', async () => {
    const store = useVault()
    // 只放这一次：放过就记着，不再来一遍
    const played = store.introPlayed()
    store.markIntro()
    await playIntroOnce(played, playIntro)
    return INTRO_HINT
  })
  ipcMain.handle('byok:close', () => {
    if (firstWin && !firstWin.isDestroyed()) firstWin.close()
  })
  ipcMain.handle('byok:docs', () => shell.openExternal(DOCS_URL))
}

export function begin(options = {}) {
  if (options.playIntro) playIntro = options.playIntro
  bind()
  const store = useVault()
  if (store.hasKey() && store.introPlayed()) return false
  open('first')
  return true
}

export function openSettings() {
  bind()
  useVault()
  open('settings')
}

export function currentKey() {
  return useVault().readKey()
}

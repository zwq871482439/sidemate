// 只读扫出还能找到产出的旧任务；也保存宠右键「最近」的纯菜单模板。

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const OUTPUT = '桌伴输出'

function outputEntry(fs, dir, name) {
  try {
    const out = join(dir, OUTPUT)
    const files = fs.readdirSync(out, { withFileTypes: true })
    if (!files.some((one) => one.isFile())) return null
    return { dir, out, name, mtime: fs.statSync(out).mtimeMs }
  } catch {
    return null
  }
}

function taskName(name) {
  const date = /^\d{4}-(\d{2})-(\d{2})-/.exec(name)
  return date ? `${date[1]}-${date[2]} ${name.slice(date[0].length)}` : name
}

// 最多五个命名任务，外加一条「随手」；全部按产出目录的修改时间排序。
export function recentTasks(root, fs = { readdirSync, statSync }) {
  let entries
  try {
    entries = fs.readdirSync(join(root, '任务'), { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const one of entries) {
    if (!one.isDirectory()) continue
    const item = outputEntry(fs, join(root, '任务', one.name), taskName(one.name))
    if (item) found.push(item)
  }
  found.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name, 'zh'))
  const random = outputEntry(fs, join(root, '随手'), '随手')
  const latest = found.slice(0, 5)
  if (random) latest.push(random)
  return latest.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name, 'zh'))
}

// 回调只从本函数拿到的条目闭包取路径，菜单本身不收外部路径。
export function recentMenuTemplate(folders, tasks, allTasks, actions = {}) {
  const submenu = []
  for (const dir of folders) {
    submenu.push({ label: dir.name, click: () => actions.openFolder?.(dir.dir) })
  }
  if (folders.length && tasks.length) submenu.push({ type: 'separator' })
  for (const task of tasks) {
    submenu.push({ label: task.name, click: () => actions.openTask?.(task.out) })
  }
  if (!folders.length && !tasks.length) submenu.push({ label: '（还没有）', enabled: false })
  if (allTasks) {
    if (submenu.length) submenu.push({ type: 'separator' })
    submenu.push({ label: '全部任务…', click: () => actions.openAll?.(allTasks) })
  }
  return { label: '最近', submenu }
}

// 全屏程序（放 PPT、看视频）会盖住顶边，这时小岛收成 64×4 的细线，鼠标碰一下变回来。
// Electron 问不到别的程序的窗口，借 Windows 的 PowerShell 问一次前台窗口的矩形和类名。
// 脚本是纯 ASCII，PowerShell 5.1 读得动；类名用来分出桌面（Progman/WorkerW），
// 桌面虽然也盖满整块屏，但它不算全屏程序。

import { spawn } from 'node:child_process'

const SCRIPT = [
  "$code = @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public class SidemateForeground {',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
  '}',
  "'@",
  'Add-Type -TypeDefinition $code',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$r = New-Object SidemateForeground+RECT',
  '$sb = New-Object System.Text.StringBuilder 256',
  'while ($true) {',
  '  $h = [SidemateForeground]::GetForegroundWindow()',
  '  [SidemateForeground]::GetWindowRect($h, [ref]$r) | Out-Null',
  '  $sb.Length = 0',
  '  [SidemateForeground]::GetClassName($h, $sb, 256) | Out-Null',
  '  Write-Output ("{0},{1},{2},{3},{4}" -f $r.Left, $r.Top, $r.Right, $r.Bottom, $sb.ToString())',
  '  Start-Sleep -Milliseconds 700',
  '}',
].join('\n')

// 导出来给自检脚本用（跑一遍看输出格式对不对）
export const SCRIPT_TEXT = SCRIPT

// 桌面和任务栏自己也是「盖满整块屏」，但它们不算全屏程序
export const DESKTOP_CLASSES = ['Progman', 'WorkerW', 'Shell_TrayWnd']

export function isDesktopClass(name) {
  return DESKTOP_CLASSES.includes(String(name || '').trim())
}

// 一行 "x,y,right,bottom,类名"；类名可以没有
export function parseRect(line) {
  const matched = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*(?:,(.*))?$/.exec(String(line || ''))
  if (!matched) return null
  const [, x, y, right, bottom, className] = matched
  return {
    x: Number(x),
    y: Number(y),
    width: Number(right) - Number(x),
    height: Number(bottom) - Number(y),
    className: String(className || '').trim(),
  }
}

// 前台窗口把整块屏都盖住了（放 PPT、看视频那种）
export function coversDisplay(rect, display, tolerance = 2) {
  if (!rect || !display) return false
  // 点一下桌面时前台窗口就是桌面本身，它的矩形正好是整块屏，不算全屏
  if (isDesktopClass(rect.className)) return false
  return rect.x <= display.x + tolerance
    && rect.y <= display.y + tolerance
    && rect.x + rect.width >= display.x + display.width - tolerance
    && rect.y + rect.height >= display.y + display.height - tolerance
}

// 起一个后台问前台窗口的进程。问不到就安静地不干活。
// 脚本走 -EncodedCommand（base64 的 UTF-16LE）：从 stdin 喂进去的多行 here-string
// 在 5.1 上会一口吃掉不输出，那样永远问不到前台窗口。
export function watchForeground(onRect, options = {}) {
  const command = options.command || 'powershell.exe'
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
  let child = null
  try {
    child = spawn(command, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return () => {}
  }
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      const rect = parseRect(line)
      if (rect) onRect(rect)
    }
  })
  child.on('error', () => {})
  return () => {
    try { child.kill() } catch { /* 已经走了 */ }
  }
}

// 运行时图标（app/assets/icon.ico，由 build/make-icon.py 拼），托盘、设置窗、任务窗、通知共用；
// 打包时 builder 的 files（app/**/*）会把它带上，安装包和 exe 的图标用 build/icon.ico。

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const iconPath = join(dirname(fileURLToPath(import.meta.url)), 'icon.ico')

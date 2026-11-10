// 装安装包的料：把 payload/ 里这台 win-x64 装不上的原生子剪掉（读文件头判定，不按目录名猜），
// 再把 payload 打成一个 7z、连同 7za 备到 .installer-cache/，给 builder.config.cjs 的 extraResources
// 和 installer.nsh 装时直解用。npm run dist 先跑这个，再跑 electron-builder。
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const payload = join(dirname(here), 'payload')
const cache = join(dirname(here), '.installer-cache')
const sevenza = join(process.env.LOCALAPPDATA ?? '.', 'electron-builder', 'Cache', '7zip@1.0.0', '7zip-win-x64-a34pt', 'bin', '7za.exe')

// PE x64 以外（ELF、Mach-O、PE arm64/x86…）在这台机器上永远 dlopen 不了
export function unloadable(buf) {
  if (buf.subarray(0, 2).toString() === 'MZ') return buf.readUInt16LE(buf.readUInt32LE(0x3c) + 4) !== 0x8664
  return (buf[0] === 0x7f && buf[1] === 0x45) || (buf[0] === 0xcf && buf[1] === 0xfa)
}

export function prune(rootDir) {
  const dropped = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const st = statSync(path)
      if (st.isDirectory()) walk(path)
      else if (/\.(node|dll|exe|so|dylib)$/i.test(name) && unloadable(readFileSync(path))) {
        rmSync(path, { force: true })
        dropped.push(path)
        if (readdirSync(dirname(path)).length === 0) rmSync(dirname(path), { recursive: true, force: true })
      }
    }
  }
  walk(rootDir)
  return dropped
}

function run(cmd, args, cwd) {
  const child = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (child.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${child.status})`)
}

// 桌伴只以 --profile acp 启动；dsh-acp-app 叠加 dsh-base，两者都不加载 inspector。
// inspector 的 devtools 长说明文件会让 0.1.0 卸载器的临时目录路径超过 Windows 上限。
export function pruneInspector(payloadRoot) {
  const inspector = join(payloadRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-experimental-inspector')
  rmSync(inspector, { recursive: true, force: true })
  return inspector
}

export function prepare() {
  if (!existsSync(join(payload, 'node', 'node.exe'))) throw new Error('payload/ 不在，先 npm run payload -- win-x64')
  if (!existsSync(sevenza)) throw new Error(`7za 不在：${sevenza}`)
  mkdirSync(cache, { recursive: true })
  rmSync(join(cache, 'payload.7z'), { force: true })
  const dropped = [pruneInspector(payload), ...prune(join(payload, 'dsh', 'node_modules'))]
  run(sevenza, ['a', '-t7z', '-mx=7', join(cache, 'payload.7z'), '.'], payload)
  copyFileSync(sevenza, join(cache, '7za.exe'))
  copyFileSync(join(dirname(sevenza), '..', 'LICENSE.txt'), join(cache, '7za-LICENSE.txt'))
  copyFileSync(join(dirname(sevenza), '..', 'COPYING'), join(cache, '7za-COPYING.txt'))
  return dropped
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  for (const path of prepare()) console.log(`pruned ${path}`)
  console.log(`payload.7z ${statSync(join(cache, 'payload.7z')).size} bytes`)
}

// 桌伴 Sidemate 前端构建链（M1-A 引入）
// 范围约束：仅构建 server/static/js/v2/ 新版 UI 源码；legacy 全局脚本
// （static/js/*.js、core/、lib/）保持原样由 bump_assets.py 指纹管理，不进本链。
// 用法：node esbuild.config.mjs [--watch] [--check]
import * as esbuild from 'esbuild';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const v2 = join(root, 'server', 'static', 'js', 'v2');
const outdir = join(v2, 'dist');
const watch = process.argv.includes('--watch');
const checkOnly = process.argv.includes('--check');

/** @type {import('esbuild').BuildOptions} */
const jsOptions = {
  entryPoints: [join(v2, 'index.js')],
  bundle: true,
  format: 'iife',
  target: 'chrome111', // 桌面 webview 基线（OKLCH/现代语法可用）
  sourcemap: watch,
  minify: !watch,
  outfile: join(outdir, 'bundle.js'),
  logLevel: 'info',
};

// CSS 入口预留（M1-D 三栏组件迁移时填充 v2/styles.css）
const cssEntry = join(v2, 'styles.css');
/** @type {import('esbuild').BuildOptions | null} */
const cssOptions = existsSync(cssEntry)
  ? {
      entryPoints: [cssEntry],
      bundle: true,
      minify: !watch,
      outfile: join(outdir, 'bundle.css'),
      logLevel: 'info',
    }
  : null;

if (checkOnly) {
  // CI 用：构建到内存不落盘，验证编译通过即可
  await esbuild.build({ ...jsOptions, write: false });
  if (cssOptions) await esbuild.build({ ...cssOptions, write: false });
  console.log('[check] v2 源码编译通过');
} else if (watch) {
  const ctxs = [await esbuild.context(jsOptions)];
  if (cssOptions) ctxs.push(await esbuild.context(cssOptions));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[watch] 监听 v2 源码变动…');
} else {
  await esbuild.build(jsOptions);
  if (cssOptions) await esbuild.build(cssOptions);
}

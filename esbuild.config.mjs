// 桌伴 Sidemate 前端构建链（M1-A 引入）
// 范围约束：仅构建 server/static/js/v2/ 新版 UI 源码；legacy 全局脚本
// （static/js/*.js、core/、lib/）保持原样由 bump_assets.py 指纹管理，不进本链。
// 用法：node esbuild.config.mjs [--watch] [--check]
import * as esbuild from 'esbuild';
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
  // index.js import './styles.css' → esbuild 自动产出伴随 bundle.css
};

if (checkOnly) {
  // CI 用：构建到内存不落盘，验证编译通过即可
  await esbuild.build({ ...jsOptions, write: false });
  console.log('[check] v2 源码编译通过');
} else if (watch) {
  const ctx = await esbuild.context(jsOptions);
  await ctx.watch();
  console.log('[watch] 监听 v2 源码变动…');
} else {
  await esbuild.build(jsOptions);
}

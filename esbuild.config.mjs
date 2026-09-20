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
  syncFingerprints();
}

// 构建后把 newUI.html 里 bundle.js/bundle.css 的 ?v= 指纹同步为产物内容哈希。
// 防旧缓存玄学：0.10.1 R2 验收实测——bundle 重建但指纹停在旧值，测试方浏览器
// 沿用 09-09 的缓存跑 R2，已修的 chip 泄漏被误报"修复失效"。
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
function syncFingerprints() {
  const htmlPath = join(root, 'server', 'newUI.html');
  let html = readFileSync(htmlPath, 'utf8');
  let changed = false;
  for (const name of ['bundle.js', 'bundle.css']) {
    const h = createHash('md5').update(readFileSync(join(outdir, name))).digest('hex').slice(0, 8);
    const re = new RegExp(`${name}\\?v=[a-f0-9]{8}`);
    if (re.test(html) && !html.includes(`${name}?v=${h}`)) {
      html = html.replace(re, `${name}?v=${h}`);
      changed = true;
      console.log(`[finger] ${name} → ?v=${h}`);
    }
  }
  if (changed) writeFileSync(htmlPath, html);
}

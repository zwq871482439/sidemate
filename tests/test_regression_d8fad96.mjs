// -*- coding: utf-8 -*-
/**
 * test_regression_d8fad96.mjs — d8fad96 之后的回归测试
 * ====================================================
 * 覆盖 4 个 commit 的功能:
 *   527f9bd mermaid 渲染失败自动修复(前端双位置提示)
 *   19f9a44 HTML 可视化报告(generate_html_report)
 *   de0da62 HTML 报告增强(mermaid缩放+组件库+提示条)
 *   57f7d69 PPT 演示文稿 + 下载 bug 修复
 *
 * 运行: node tests/test_regression_d8fad96.mjs
 * 前提: Sidemate 运行在 http://127.0.0.1:8976
 */

import { chromium } from 'playwright';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';

const BASE = 'http://127.0.0.1:8976';
let passed = 0, failed = 0;
const errors = [];

function assert(cond, name) {
  if (cond) { passed++; console.log('  ✅', name); }
  else { failed++; errors.push(name); console.log('  ❌', name); }
}

async function genReport(content, filename, title) {
  writeFileSync('tests/_gen_tmp.py', `import sys;sys.path.insert(0,'server')
from pipelines.doc_action import generate_html_report, generate_ppt_html
generate_html_report(${JSON.stringify(content)}, 'C:/Sidemate/tests/${filename}', title=${JSON.stringify(title||'测试')})
`, 'utf-8');
  execFileSync('python', ['tests/_gen_tmp.py'], { cwd: 'C:/Sidemate', encoding: 'utf-8', timeout: 30000 });
}
async function genPpt(content, filename, title) {
  writeFileSync('tests/_gen_tmp.py', `import sys;sys.path.insert(0,'server')
from pipelines.doc_action import generate_ppt_html
generate_ppt_html(${JSON.stringify(content)}, 'C:/Sidemate/tests/${filename}', title=${JSON.stringify(title||'演示')})
`, 'utf-8');
  execFileSync('python', ['tests/_gen_tmp.py'], { cwd: 'C:/Sidemate', encoding: 'utf-8', timeout: 30000 });
}

const browser = await chromium.launch({ headless: true });
console.log('=== d8fad96 之后回归测试 ===\n');

// ========== A. 后端语法/导入回归 ==========
console.log('[A] 后端模块导入回归');
const importResult = execFileSync('python', ['-c', `
import sys; sys.path.insert(0, 'server')
from pipelines.doc_action import generate_docx, generate_html_report, generate_ppt_html
from pipelines.cloud_pipeline import _run_agent_loop
from core.agent_loop import AgentLoop
from core.agent_tools import _AGENT_BASE_PROMPT, _DOC_BASE_PROMPT
from routers.chat import router
from routers.files import router as frouter
print('IMPORT_OK')
`], { cwd: 'C:/Sidemate', encoding: 'utf-8', timeout: 30000 });
assert(importResult.includes('IMPORT_OK'), '所有后端模块可导入');

// prompt 含 PPT 规则（直接读文件验证）
const promptSrc = await import('fs').then(fs => fs.readFileSync('server/core/agent_tools.py','utf-8'));
assert(promptSrc.includes('.ppt.html') && promptSrc.includes('幻灯片'), 'prompt 含 PPT 规则');
assert(promptSrc.includes('.html') && promptSrc.includes('可视化报告'), 'prompt 含 HTML 报告规则');
// 组件库：vibrant 必含（现代风格），callout 或 note 二选一（提示框，v0.9.7 起推荐 callout）
assert(promptSrc.includes('vibrant'), 'prompt 含 vibrant 风格指引');
assert(promptSrc.includes('callout') || promptSrc.includes('note'), 'prompt 含提示框指引(callout/note)');

// ========== B. HTML 报告生成 + 渲染 ==========
console.log('\n[B] HTML 可视化报告');
const htmlContent = `<h1>报告标题</h1>
<div class="stats"><div class="stat"><div class="stat-num">99%</div><div class="stat-label">完成</div></div></div>
<div class="card"><div class="card-title">卡片</div></div>
<div class="note">提示框</div>
\`\`\`mermaid
flowchart TD
  A --> B
\`\`\`
`;
await genReport(htmlContent, 'test_reg.html', '测试报告');
const page = await browser.newPage();
page.on('pageerror', err => errors.push('HTML报告JS错误: ' + err.message));
await page.goto('file:///C:/Sidemate/tests/test_reg.html', { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForTimeout(4000);

let s = await page.evaluate(() => ({
  h1: document.querySelector('h1')?.textContent,
  hasStats: !!document.querySelector('.stats'),
  hasCard: !!document.querySelector('.card'),
  hasNote: !!document.querySelector('.note'),
  hasTipbar: !!document.querySelector('.report-tipbar'),
  chartSvgs: document.querySelectorAll('.chart-stage svg').length,
  chartNodes: !!document.querySelector('svg .node'),
  enhanced: document.querySelector('[data-stage]')?._enhanced,
  zoomVal: document.querySelector('.zoom-val')?.textContent,
}));
assert(s.h1 === '报告标题', 'HTML 报告标题正确');
assert(s.hasStats && s.hasCard && s.hasNote, '组件库渲染(stats/card/note)');
assert(s.hasTipbar, '顶部提示条');
assert(s.chartSvgs >= 1 && s.chartNodes, 'mermaid 图渲染成 svg');
assert(s.enhanced, 'mermaid 缩放交互挂载');

// 缩放联动
const zoom = await page.evaluate(() => {
  document.querySelector('[data-act=in]').click();
  return document.querySelector('.zoom-val').textContent;
});
assert(zoom === '120%', '缩放按钮联动(100%→120%)');
await page.close();

// ========== C. PPT 演示文稿 ==========
console.log('\n[C] PPT 演示文稿');
const pptContent = `<section><h1>标题页</h1></section>
<section><h2>架构</h2>
\`\`\`mermaid
flowchart LR
  X --> Y
\`\`\`
</section>
<section><h2>表格</h2><table><tr><td>数据</td></tr></table></section>
`;
await genPpt(pptContent, 'test_reg.ppt.html', '测试PPT');
const ppage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
ppage.on('pageerror', err => errors.push('PPT的JS错误: ' + err.message));
await ppage.goto('file:///C:/Sidemate/tests/test_reg.ppt.html', { waitUntil: 'networkidle', timeout: 20000 });
await ppage.waitForTimeout(4000);

s = await ppage.evaluate(() => ({
  hasReveal: !!document.querySelector('.reveal'),
  sections: document.querySelectorAll('.reveal section').length,
  revealDefined: typeof Reveal,
  hasTipbar: !!document.querySelector('.ppt-tipbar'),
  currentSlide: Reveal?.getCurrentSlide()?.textContent?.trim()?.slice(0,10),
}));
assert(s.hasReveal, 'reveal.js 结构');
assert(s.sections === 3, '3 张幻灯片');
assert(s.revealDefined === 'function', 'Reveal 对象可用');
assert(s.hasTipbar, 'PPT 提示条');
assert(s.currentSlide?.includes('标题页'), '初始在第1页');

// 翻到第2页测 mermaid
await ppage.keyboard.press('ArrowRight');
await ppage.waitForTimeout(2000);
s = await ppage.evaluate(() => ({
  currentSlide: Reveal?.getCurrentSlide()?.textContent?.trim()?.slice(0,6),
  mermaidRendered: !!Reveal?.getCurrentSlide()?.querySelector('.chart-slot svg'),
}));
assert(s.currentSlide?.includes('架构'), '翻页到第2页');
assert(s.mermaidRendered, '第2页 mermaid 图渲染(slidechanged触发)');

// 翻到第3页测表格
await ppage.keyboard.press('ArrowRight');
await ppage.waitForTimeout(1000);
s = await ppage.evaluate(() => !!Reveal?.getCurrentSlide()?.querySelector('table'));
assert(s, '第3页表格正常');
await ppage.close();

// ========== D. 下载路由逻辑(不调真实服务，验证代码) ==========
console.log('\n[D] 下载 bug 修复验证');
// doc_id 白名单含 .
const filesSrc = await import('fs').then(fs => fs.readFileSync('server/routers/files.py','utf-8'));
assert(filesSrc.includes("\\w\\-.") || filesSrc.includes('w\\-.'), 'files.py doc_id 白名单含 .');
// cloud_pipeline 用 splitext
const cpSrc = await import('fs').then(fs => fs.readFileSync('server/pipelines/cloud_pipeline.py','utf-8'));
assert(cpSrc.includes('splitext'), 'cloud_pipeline.py 用 splitext 剥后缀');

// ========== E. set_doc_status 三分支 ==========
console.log('\n[E] set_doc_status 三分支');
const alSrc = await import('fs').then(fs => fs.readFileSync('server/core/agent_loop.py','utf-8'));
assert(alSrc.includes('.ppt.html') && alSrc.includes('generate_ppt_html'), 'set_doc_status 含 .ppt.html 分支');
assert(alSrc.includes('generate_html_report'), 'set_doc_status 含 .html 分支');
assert(alSrc.includes('generate_docx'), 'set_doc_status 含 .md 分支');

// ========== F. 聊天页面 mermaid 修复功能(需服务运行) ==========
console.log('\n[F] 聊天页面 mermaid 修复(在线)');
try {
  const cpage = await browser.newPage({ timeout: 8000 });
  await cpage.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 8000 });
  await cpage.waitForTimeout(2000);
  // 验证 fix-mermaid 接口路由存在(404=路由不存在, 422=存在但参数错)
  const resp = await cpage.evaluate(async () => {
    const r = await fetch('/api/chat/fix-mermaid', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
    return r.status;
  });
  assert(resp === 422 || resp === 400, 'fix-mermaid 接口存在(状态=' + resp + ')');
  await cpage.close();
} catch (e) {
  console.log('  ⚠️ 服务未运行，跳过在线测试');
}

// 清理
['tests/_gen_tmp.py', 'tests/test_reg.html', 'tests/test_reg.ppt.html'].forEach(f => existsSync(f) && unlinkSync(f));

await browser.close();

console.log('\n============================================');
console.log(`  回归测试: ${passed} 通过, ${failed} 失败`);
if (errors.length) {
  console.log('  失败项:');
  errors.forEach(e => console.log('    -', e));
}
console.log('============================================');
process.exit(failed > 0 ? 1 : 0);
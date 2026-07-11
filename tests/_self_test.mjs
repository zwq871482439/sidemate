// doc_action 自测 v2：纯浏览器渲染验证
import { chromium } from 'playwright';
import { execFileSync } from 'child_process';

console.log('Step 1: generating test HTML files...');
execFileSync('python', ['tests/_gen_selftest.py'], { cwd: 'C:/Sidemate', stdio: 'inherit' });

const cases = [
  { id: 'T1', desc: '空内容', checks: { markedLoaded: true, mermaidLoaded: true, hasMdSrc: false } },
  { id: 'T2', desc: '单个 mermaid', checks: { h1: 1, chartRendered: 1 } },
  { id: 'T3', desc: '多个 mermaid', checks: { chartRendered: 3 } },
  { id: 'T4', desc: '</script> 字面', checks: { h1: 1, markedLoaded: true, mermaidLoaded: true } },
  { id: 'T5', desc: 'HTML+Markdown 混用', checks: { lead: 1, h2: 1, li: 3, strong: 2, em: 1, code: 1 } },  // 1 个 HTML strong + 1 个 markdown strong = 2
  { id: 'T6', desc: '表格', checks: { table: 1, th: 3, td: 6 } },
  { id: 'T7', desc: '代码块', checks: { pre: 1, codeInPre: 1 } },
  { id: 'T8', desc: '中英文+emoji', checks: { h1: 1 } },
  { id: 'T9', desc: 'LLM class', checks: { callout: 1, badge: 2, lead: 1 } },
  { id: 'T10', desc: '50KB 长内容', checks: { h1: 1, table: 1, chartRendered: 1 } },
];

const browser = await chromium.launch();
const ctx = await browser.newContext();

let pass = 0, fail = 0;
const failedCases = [];

for (const c of cases) {
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE_ERR: ' + m.text()); });

  await page.goto(`file:///C:/Sidemate/tests/_selftest_out/${c.id}.html`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2500);

  const r = await page.evaluate(() => ({
    hasMdSrc: !!document.getElementById('md-src'),
    h1: document.querySelectorAll('h1').length,
    h2: document.querySelectorAll('h2').length,
    h3: document.querySelectorAll('h3').length,
    h4: document.querySelectorAll('h4').length,
    table: document.querySelectorAll('table').length,
    th: document.querySelectorAll('th').length,
    td: document.querySelectorAll('td').length,
    strong: document.querySelectorAll('strong').length,
    em: document.querySelectorAll('em').length,
    code: document.querySelectorAll('code').length,
    pre: document.querySelectorAll('pre').length,
    codeInPre: document.querySelectorAll('pre code').length,
    li: document.querySelectorAll('li').length,
    blockquote: document.querySelectorAll('blockquote').length,
    lead: document.querySelectorAll('.lead').length,
    callout: document.querySelectorAll('.callout').length,
    badge: document.querySelectorAll('.badge').length,
    chartFrame: document.querySelectorAll('.chart-frame').length,
    chartSlot: document.querySelectorAll('.chart-slot').length,
    chartRendered: document.querySelectorAll('.chart-rendered').length,
    tipbar: !!document.querySelector('.report-tipbar'),
    markedLoaded: typeof window.marked !== 'undefined',
    markedHasParse: !!(window.marked && window.marked.parse),
    mermaidLoaded: typeof window.mermaid !== 'undefined',
    mermaidHasRender: !!(window.mermaid && window.mermaid.render),
    bodyLen: document.body.innerText.length,
    bodyText: document.body.innerText.slice(0, 300),
  }));

  const checks = c.checks;
  const checkResults = {};
  let allOk = true;
  for (const [k, v] of Object.entries(checks)) {
    const got = r[k];
    const ok = (v === true) ? got === true : (typeof v === 'number') ? got === v : got === v;
    checkResults[k] = { expect: v, got, ok };
    if (!ok) allOk = false;
  }
  const noErr = errs.length === 0;
  const status = (allOk && noErr) ? 'PASS' : 'FAIL';

  if (status === 'PASS') pass++; else {
    fail++;
    failedCases.push({ id: c.id, desc: c.desc, checkResults, errs, r });
  }

  const statusColor = status === 'PASS' ? '✓' : '✗';
  console.log(`[${statusColor} ${status}] ${c.id}: ${c.desc}`);
  if (status === 'FAIL') {
    console.log('  checks:');
    for (const [k, v] of Object.entries(checkResults)) {
      console.log(`    ${v.ok ? '✓' : '✗'} ${k}: expect=${v.expect}, got=${v.got}`);
    }
    if (errs.length) console.log('  errors:', errs.join(' | '));
    console.log('  bodyText:', r.bodyText);
  }
  await page.close();
}

await browser.close();

console.log(`\n========================================`);
console.log(`Total: ${pass + fail}  PASS: ${pass}  FAIL: ${fail}`);
console.log(`========================================`);

if (fail > 0) {
  console.log('\n失败详情见上方。');
  process.exit(1);
}
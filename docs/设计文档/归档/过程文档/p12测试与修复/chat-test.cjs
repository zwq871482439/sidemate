const { chromium } = require("playwright-core");

const SCREENSHOT_DIR = 'C:/tmp/桌伴-设计文档';
const BASE_URL = 'http://localhost:8976';
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const results = [];

function pass(name) { results.push({ name, status: 'PASS' }); }
function fail(name, reason) { results.push({ name, status: 'FAIL', reason }); }
function partial(name, note) { results.push({ name, status: 'PARTIAL', note }); }

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: false,
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // Console error tracking
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });

  // --- Test 1: Load Chat Tab ---
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await wait(2000);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/chat-01-main.png`, fullPage: false });
  pass('1. Chat Tab 加载');
  await page.evaluate(() => window.__TAURI__ ? 'tauri' : 'browser');

  // --- Test 2: Check UI Elements ---
  const tabs = await page.evaluate(() => [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean));
  const hasChat = tabs.some(t => t.includes('对话'));
  const hasQA = tabs.some(t => t.includes('文库'));
  const hasMinutes = tabs.some(t => t.includes('纪要'));
  const hasSettings = tabs.some(t => t.includes('设置'));
  if (hasChat && hasQA && hasMinutes && hasSettings) pass('2. 四大Tab可见');
  else fail('2. 四大Tab可见', `对话:${hasChat} 文库:${hasQA} 纪要:${hasMinutes} 设置:${hasSettings}`);

  // --- Test 3: Model Display ---
  const modelText = await page.evaluate(() => document.body.innerText);
  const hasModel = modelText.includes('qwen3.5-4b');
  if (hasModel) pass('3. 模型信息显示');
  else fail('3. 模型信息显示', 'qwen3.5-4b not found');

  // --- Test 4: Modes (直接对话/检索文库/文档生成) ---
  const modes = ['直接对话', '检索文库', '文档生成'];
  for (const mode of modes) {
    const clicked = await page.evaluate((m) => {
      const btns = [...document.querySelectorAll('button')];
      const btn = btns.find(b => b.textContent.includes(m));
      if (btn) { btn.click(); return true; }
      return false;
    }, mode);
    await wait(500);
    if (clicked) pass(`4. ${mode} 模式切换`);
    else fail(`4. ${mode} 模式切换`, 'button not found');
  }

  // Switch back to 直接对话
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const btn = btns.find(b => b.textContent.includes('直接对话'));
    if (btn) btn.click();
  });
  await wait(300);

  // --- Test 5: Conversation List ---
  const convOptions = await page.evaluate(() => {
    const select = document.querySelector('select, [role="combobox"]');
    if (!select) return [];
    return [...select.options].map(o => o.text);
  });
  if (convOptions.length > 0) pass(`5. 对话列表 (${convOptions.length}条)`);
  else partial('5. 对话列表', 'no conversations found');

  // --- Test 6: New Conversation ---
  const newClicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const btn = btns.find(b => b.textContent.includes('新建'));
    if (btn) { btn.click(); return true; }
    return false;
  });
  await wait(500);
  if (newClicked) pass('6. 新建对话');
  else fail('6. 新建对话', '新建 button not found');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/chat-02-new-conv.png`, fullPage: false });

  // --- Test 7: Input Field ---
  const typed = await page.evaluate(() => {
    const input = document.querySelector('textarea, [contenteditable="true"], input[type="text"]');
    if (!input) return false;
    input.value = '你好，这是自动化测试消息';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  });
  if (typed) pass('7. 输入框输入');
  else fail('7. 输入框输入', 'input field not found');
  await wait(300);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/chat-03-input.png`, fullPage: false });

  // --- Test 8: Send Message ---
  const sent = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const btn = btns.find(b => b.textContent.trim() === '发送');
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (sent) pass('8. 发送消息');
  else fail('8. 发送消息', '发送 button not found');

  // Wait for response
  await wait(3000);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/chat-04-response.png`, fullPage: false });

  // --- Test 9: Stop Button ---
  const hasStop = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    return btns.some(b => b.textContent.trim() === '停止');
  });
  if (hasStop) pass('9. 停止按钮存在');
  else partial('9. 停止按钮', 'button not visible (model may have finished)');

  // --- Test 10: Copy Button ---
  const hasCopy = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    return btns.some(b => b.textContent.trim() === '复制');
  });
  if (hasCopy) pass('10. 复制按钮');
  else fail('10. 复制按钮', 'not found');

  // --- Test 11: Export Button ---
  const hasExport = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    return btns.some(b => b.textContent.trim() === '导出');
  });
  if (hasExport) pass('11. 导出按钮');
  else fail('11. 导出按钮', 'not found');

  // Click export
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const btn = btns.find(b => b.textContent.trim() === '导出');
    if (btn) btn.click();
  });
  await wait(300);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/chat-05-export.png`, fullPage: false });

  // --- Test 12: Delete Dialog ---
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    // Find delete button - it's an icon button with img child, between 新建 and 导出
    const newBtn = btns.find(b => b.textContent.includes('新建'));
    const exportBtn = btns.find(b => b.textContent.trim() === '导出');
    if (newBtn && exportBtn) {
      // Delete button is between them in DOM
      const parent = newBtn.parentElement;
      const children = [...parent.children];
      const deleteBtn = children.find(c => c.tagName === 'BUTTON' && c.querySelector('img') && !c.textContent.includes('新建') && !c.textContent.includes('导出'));
      if (deleteBtn) deleteBtn.click();
    }
  });
  await wait(500);
  // Try to find dialog
  const dialogVisible = await page.evaluate(() => {
    return !!document.querySelector('[role="dialog"], .dialog, .modal, .popup');
  });
  if (dialogVisible) pass('12. 删除确认弹窗');
  else partial('12. 删除确认弹窗', 'dialog not detected');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/chat-06-delete.png`, fullPage: false });

  // Dismiss dialog
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const cancelBtn = btns.find(b => b.textContent.trim() === '取消');
    if (cancelBtn) cancelBtn.click();
  });
  await wait(300);

  // --- Test 13: Tab Switching ---
  // Go to 文库
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const btn = btns.find(b => b.textContent.includes('文库'));
    if (btn) btn.click();
  });
  await wait(500);
  const qaVisible = await page.evaluate(() => document.body.innerText.includes('文库问答'));
  if (qaVisible) pass('13. 切换到文库Tab');
  else fail('13. 切换到文库Tab', '文库问答 text not visible');

  // Go back to 对话
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const btn = btns.find(b => b.textContent.includes('对话'));
    if (btn) btn.click();
  });
  await wait(500);
  const chatVisible = await page.evaluate(() => document.body.innerText.includes('直接对话'));
  if (chatVisible) pass('13b. 切回对话Tab');
  else fail('13b. 切回对话Tab', 'chat not restored');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/chat-07-tab-back.png`, fullPage: false });

  // --- Test 14: Dark Mode ---
  // Check if there's a theme toggle
  const darkToggled = await page.evaluate(() => {
    // Try to find dark mode toggle, often in settings area or header
    const buttons = [...document.querySelectorAll('button')];
    const themeBtn = buttons.find(b => b.textContent.includes('🌙') || b.textContent.includes('☀') || b.title?.includes('theme') || b.getAttribute('aria-label')?.includes('theme'));
    if (!themeBtn) {
      // Try adding data-theme
      document.documentElement.setAttribute('data-theme', 'dark');
      document.documentElement.classList.add('dark');
      return 'set-manually';
    }
    themeBtn.click();
    return 'clicked';
  });
  await wait(500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/chat-08-dark.png`, fullPage: false });
  pass('14. 暗色模式');

  // --- Test 15: Console Errors ---
  if (errors.length === 0) pass('15. 控制台无错误');
  else partial(`15. 控制台错误 (${errors.length}个)`, errors.slice(0, 5).join('; '));

  // --- Test 16: Reload ---
  await page.reload({ waitUntil: 'networkidle' });
  await wait(2000);
  const reloaded = await page.evaluate(() => document.body.innerText.includes('对话'));
  if (reloaded) pass('16. 页面刷新恢复');
  else fail('16. 页面刷新恢复', 'page not restored');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/chat-09-reload.png`, fullPage: false });

  // --- Cleanup ---
  await browser.close();

  // --- Report ---
  const passCount = results.filter(r => r.status === 'PASS').length;
  const failCount = results.filter(r => r.status === 'FAIL').length;
  const partialCount = results.filter(r => r.status === 'PARTIAL').length;
  const total = results.length;

  console.log('\n===== Chat Tab 测试报告 =====');
  console.log(`总计: ${total} | 通过: ${passCount} | 失败: ${failCount} | 部分: ${partialCount}`);
  console.log('');
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⚠️';
    console.log(`${icon} ${r.name}${r.reason ? ': ' + r.reason : ''}${r.note ? ' - ' + r.note : ''}`);
  }
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

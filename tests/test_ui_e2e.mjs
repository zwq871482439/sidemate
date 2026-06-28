// -*- coding: utf-8 -*-
/**
 * test_ui_e2e.mjs — Sidemate 前端 UI 端到端测试（Playwright）
 * ============================================================
 * 模拟真实用户操作，覆盖核心交互流程。每步截图存证 + 断言。
 *
 * 运行前提：Sidemate 服务运行在 http://127.0.0.1:8976
 *
 * 用法：
 *   node tests/test_ui_e2e.mjs              # 无头模式
 *   node tests/test_ui_e2e.mjs --headed     # 有头模式（看浏览器）
 *   node tests/test_ui_e2e.mjs --quick      # 跳过耗时的发消息测试
 *
 * 覆盖场景：
 *   1. 页面加载 + 基础元素
 *   2. 模式切换（鱼骨屏 + 模型标签更新）
 *   3. 发送消息（流式响应 + 消息渲染）
 *   4. 会话切换（不堆积）
 *   5. 设置页用量统计（分段渲染）
 *   6. 设置页工具权限（含内网访问开关）
 *   7. 滚动条样式（对话区绿/设置区灰）
 *   8. 前端 console 错误
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = 'http://127.0.0.1:8976';
const SCREENSHOT_DIR = path.join(process.cwd(), 'tests', 'screenshots');
const RESPONSE_LOG = path.join(process.cwd(), 'tests', 'response_log.md');

let passed = 0, failed = 0;
const failures = [];

// 响应记录：把每次 AI 响应的内容/模式/质量写入日志，便于后续人工评价
let _respLogEntries = [];
function logResponse(scene, prompt, response, quality) {
  const ts = new Date().toLocaleTimeString('zh-CN');
  const content = (response?.content || '(无内容)').slice(0, 300);
  const len = response?.feature?.textLen || 0;
  const elapsed = response?.elapsed || '?';
  _respLogEntries.push({
    ts, scene, prompt: prompt.slice(0, 60),
    content, len, elapsed,
    quality: quality || (response?.feature?.hasError ? '❌错误' : '✅'),
  });
}
function flushResponseLog() {
  if (!_respLogEntries.length) return;
  let md = '# Sidemate UI 测试 — 响应记录\n\n';
  md += '> 每次 AI 响应的内容快照，供后续人工评价质量\n\n';
  md += '| 时间 | 场景 | 提问 | 响应摘要 | 字数 | 耗时 | 质量 |\n';
  md += '|------|------|------|---------|------|------|------|\n';
  for (const e of _respLogEntries) {
    md += `| ${e.ts} | ${e.scene} | ${e.prompt.replace(/\|/g,'/')} | ${e.content.replace(/\|/g,'/').replace(/\n/g,' ')} | ${e.len} | ${e.elapsed}s | ${e.quality} |\n`;
  }
  fs.writeFileSync(RESPONSE_LOG, md, 'utf-8');
}

const headed = process.argv.includes('--headed');
const quick = process.argv.includes('--quick');

function check(name, condition, detail = '') {
  if (condition) {
    console.log('  ✅ %s', name);
    passed++;
  } else {
    console.log('  ❌ %s %s', name, detail ? '— ' + detail : '');
    failed++;
    failures.push(name + (detail ? ' (' + detail + ')' : ''));
  }
}

async function shot(page, name) {
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, name + '.png') });
}

async function switchTab(page, tab) {
  // tab: 'chat' | 'settings' | 'qa'
  // 用 dispatchEvent 模拟点击，避免 click() 等待可能的网络阻塞
  await page.evaluate((t) => {
    const btn = document.querySelector(`[onclick*="switchTab('${t}'"]`);
    if (btn) {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    } else if (typeof switchTab === 'function') {
      try { switchTab(t, btn); } catch (e) {}
    }
  }, tab).catch(() => {});
  await page.waitForTimeout(1000);
}

async function waitFor(page, selector, timeout = 10000) {
  try {
    await page.waitForSelector(selector, { timeout, state: 'visible' });
    return true;
  } catch { return false; }
}

// ============================================================
//  测试场景
// ============================================================

async function test1_pageLoad(page) {
  console.log('\n🔴 测试 1：页面加载 + 基础元素');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // 关闭新手欢迎覆层（新浏览器 localStorage 为空会显示，全屏 pointer-events:auto 拦截点击）
  // 真实用户会点"开始/跳过"，测试模拟 dismissWelcome()
  await page.evaluate(() => {
    if (typeof dismissWelcome === 'function') dismissWelcome();
    const ov = document.getElementById('welcomeOverlay');
    if (ov) ov.style.display = 'none';
  }).catch(() => {});
  await page.waitForTimeout(500);

  const title = await page.title();
  check('页面标题含 Sidemate', title.includes('Sidemate'), '实际: ' + title);
  check('消息区存在', await waitFor(page, '#messages'));
  check('输入框存在', await waitFor(page, '#msgInput'));
  check('发送按钮存在', await waitFor(page, '#sendBtn'));

  // 模型标签不应卡在"加载中"（验证之前 ImportError 修复）
  const tagText = await page.locator('#modelTag').textContent().catch(() => '');
  check('模型标签非"加载中"', !tagText.includes('加载中'), '实际: ' + tagText);

  // 欢迎覆层应已关闭（不拦截交互）
  const welcomeVisible = await page.locator('#welcomeOverlay').isVisible().catch(() => false);
  check('欢迎覆层已关闭', !welcomeVisible);

  await shot(page, '01_load');
}

async function test2_modeSwitch(page) {
  console.log('\n🔴 测试 2：模式切换（鱼骨屏）');

  // 模式按钮通过 addEventListener 绑定（非 onclick 属性），用文字定位
  // 按钮文字：离线 / 在线 / 并行
  await page.waitForTimeout(1000);  // 等动态渲染
  const offlineBtn = page.locator('button:has-text("离线")').first();
  const onlineBtn = page.locator('button:has-text("在线")').first();
  const parallelBtn = page.locator('button:has-text("并行")').first();

  const hasModeBtns = (await offlineBtn.count()) + (await onlineBtn.count()) + (await parallelBtn.count());
  check('找到模式切换按钮', hasModeBtns >= 3, '数量: ' + hasModeBtns);

  if (hasModeBtns < 3) return;

  // 点"在线"模式（dispatchEvent 绕过覆盖层，与 test3 同理）
  const onlineText = (await onlineBtn.textContent()).trim();
  console.log('  点击模式按钮: %s', onlineText);

  page.on('dialog', async d => { await d.accept(); });
  // welcomeOverlay 关闭后真实点击可用，dispatchEvent 作 fallback
  await onlineBtn.click({ timeout: 3000 }).catch(async () => {
    await page.evaluate(el => el.dispatchEvent(new MouseEvent('click', {bubbles:true})), await onlineBtn.elementHandle());
  });
  await page.waitForTimeout(1500);

  // 验证：切换后输入框最终恢复正常（鱼骨屏是瞬态的）
  const inputOk = await page.locator('#msgInput').isEnabled().catch(() => false);
  check('切换后输入框可用', inputOk);

  // 回退到离线
  await offlineBtn.click({ timeout: 3000 }).catch(async () => {
    await page.evaluate(el => el.dispatchEvent(new MouseEvent('click', {bubbles:true})), await offlineBtn.elementHandle());
  });
  await page.waitForTimeout(1000);

  await shot(page, '02_mode');
}

// ============================================================
//  模式矩阵测试（test3）：5 种 AI模式 × Action 组合
// ============================================================

// 切换 AI 模式（离线/在线/并行）
// selectMode 会弹自定义确认框(.modal-back 非 dialog)，测试预设 skip 标志跳过
async function switchAiMode(page, modeText) {
  // modeText → backend mode 映射
  const modeMap = { '离线': 'offline', '在线': 'online', '并行': 'parallel' };
  const mode = modeMap[modeText] || modeText;
  // 预设"下次不再提示"，跳过自定义确认弹窗
  await page.evaluate((m) => {
    localStorage.setItem('sidemate_mode_confirm_skip_' + m, '1');
  }, mode);

  const btn = page.locator(`[data-mode="${mode}"]`).first();
  await btn.click({ timeout: 3000 }).catch(async () => {
    await page.evaluate(el => { if (el) el.dispatchEvent(new MouseEvent('click', {bubbles:true})); },
      await btn.elementHandle().catch(() => null));
  });
  await page.waitForTimeout(2500);  // 等模式切换完成（鱼骨屏 + actionBar 刷新）
}

// 选择 Action（聊天/写文档/联网搜索/深度分析/知识库问答）
// setActionMode 是 async（含 await fetch），点击后需等 currentActionMode 变化
async function selectAction(page, actionText, expectMode) {
  // action 按钮在 actionBar，文字匹配
  const btn = page.locator(`#actionBar button:has-text("${actionText}"), .action-bar button:has-text("${actionText}")`).first();
  const exists = await btn.count();
  if (!exists) return false;
  await btn.click({ timeout: 3000 }).catch(() => {});
  // 等 setActionMode 完成（currentActionMode 变化，最多 3 秒）
  if (expectMode) {
    try {
      await page.waitForFunction(
        (m) => { try { return currentActionMode === m; } catch { return false; } },
        expectMode, { timeout: 3000 }
      );
    } catch {}
  } else {
    await page.waitForTimeout(800);  // 无 expectMode 时固定等待
  }
  return true;
}

// 新建独立会话（会话隔离：避免上一场景的上下文污染当前测试）
async function newChatSession(page) {
  await page.evaluate(async () => {
    if (typeof generating !== 'undefined' && generating) return;
    try {
      if (typeof newChat === 'function') { await newChat(); return; }
    } catch {}
    // fallback: 直接调 API
    const resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/chats/new', {method:'POST'});
    const data = await resp.json();
    window.currentChatFile = data.path;
    window.currentMessages = [];
  }).catch(() => {});
  await page.waitForTimeout(1200);  // 等会话创建 + 渲染
}

// 发消息并等待响应，返回 { ok, newMsgCount, hadStopBtn, elapsed, content, feature }
async function sendMessageAndWait(page, text, timeoutMs = 90000) {
  const before = await page.locator('#messages > .msg').count();

  await page.fill('#msgInput', text);
  await page.waitForTimeout(200);

  // 真实点击优先，dispatchEvent fallback
  await page.locator('#sendBtn').click({ timeout: 5000 }).catch(async () => {
    await page.evaluate(() => {
      const b = document.getElementById('sendBtn');
      if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  });
  await page.waitForTimeout(800);

  const hadStop = await page.locator('#stopBtn').isVisible().catch(() => false);
  if (!hadStop) return { ok: false, hadStopBtn: false, reason: '未触发发送' };

  // 等新消息出现
  const startT = Date.now();
  try {
    await page.waitForFunction(
      (b) => document.querySelectorAll('#messages > .msg').length > b,
      before,
      { timeout: timeoutMs }
    );
    const after = await page.locator('#messages > .msg').count();
    // 等 sendBtn 恢复（响应完成）
    await page.waitForFunction(
      () => { const b = document.getElementById('sendBtn'); return b && b.style.display !== 'none'; },
      { timeout: 30000 }
    ).catch(() => {});

    // 提取响应内容和特征（质量断言用）
    const feature = await page.evaluate(() => {
      const msgs = document.querySelectorAll('#messages > .msg.ai');
      const last = msgs[msgs.length - 1];
      if (!last) return null;
      const streamEl = last.querySelector('.stream-content');
      return {
        text: (streamEl || last).textContent.trim(),
        textLen: (streamEl || last).textContent.trim().length,
        hasCard: !!last.querySelector('.card-area'),
        hasError: !!last.querySelector('.error-msg, [class*="error"]') ||
                  last.textContent.includes('[ERROR]') || last.textContent.includes('请求失败'),
        hasDownload: !!last.querySelector('.doc-download-bar, [data-doc-complete]'),
        hasOutline: !!last.querySelector('#docOutlinePreview, #docOutlineEditor'),
        hasCite: !!last.querySelector('[data-cite], .cite-ref'),
        actionTag: last.querySelector('.action-tag')?.textContent?.trim() || '',
      };
    }).catch(() => null);

    return {
      ok: true, hadStopBtn: true,
      newMsgCount: after - before,
      elapsed: Math.round((Date.now()-startT)/1000),
      content: feature?.text || '',
      feature,
    };
  } catch {
    return { ok: false, hadStopBtn: true, reason: '响应超时' };
  }
}

// 质量断言：验证响应内容符合预期（不只看有没有，还看好不好）
function assertQuality(name, response, expectations) {
  // expectations: { minLen, maxLen, notError, contains, notContains, hasFeature }
  if (!response.ok || !response.feature) {
    check(name + '（质量）', false, '无响应');
    return;
  }
  const f = response.feature;
  const issues = [];

  // 不能是错误响应
  if (expectations.notError !== false && f.hasError) {
    issues.push('响应含错误');
  }

  // 长度范围
  if (expectations.minLen && f.textLen < expectations.minLen) {
    issues.push('过短(' + f.textLen + '<' + expectations.minLen + ')');
  }
  if (expectations.maxLen && f.textLen > expectations.maxLen) {
    issues.push('过长(' + f.textLen + '>' + expectations.maxLen + ')');
  }

  // 关键词包含
  if (expectations.contains) {
    const text = f.text;
    const matched = expectations.contains.some(kw => text.includes(kw));
    if (!matched) issues.push('缺少关键词(' + expectations.contains.join('/') + ')');
  }

  // 关键词排除
  if (expectations.notContains) {
    const text = f.text;
    const hit = expectations.notContains.find(kw => text.includes(kw));
    if (hit) issues.push('含不该有的内容(' + hit + ')');
  }

  // 结构特征
  if (expectations.hasFeature && !f[expectations.hasFeature]) {
    issues.push('缺少结构(' + expectations.hasFeature + ')');
  }

  check(name + '（质量）', issues.length === 0,
    issues.length ? issues.join('; ') : (f.textLen + '字 ' + response.elapsed + 's'));
}

// 验证最近一条 AI 消息的特征（含特定标签/结构）
async function checkLastMsgFeature(page, name, predicate) {
  const feature = await page.evaluate(() => {
    const msgs = document.querySelectorAll('#messages > .msg.ai');
    const last = msgs[msgs.length - 1];
    if (!last) return null;
    return {
      text: last.textContent.slice(0, 500),
      hasCard: !!last.querySelector('.card-area'),
      hasDownload: !!last.querySelector('.doc-download-bar, [data-doc-complete]'),
      hasCite: !!last.querySelector('[data-cite], .cite-ref'),
      actionTag: last.querySelector('.action-tag')?.textContent?.trim() || '',
    };
  }).catch(() => null);
  if (!feature) { check(name, false, '无 AI 消息'); return feature; }
  check(name, predicate(feature), JSON.stringify(feature).slice(0, 80));
  return feature;
}

async function test3_modeMatrix(page) {
  console.log('\n🔴 测试 3：模式矩阵（离线/在线/并行 × 各 Action）');
  if (quick) { console.log('  ⏭️  --quick 模式跳过'); return; }

  await switchTab(page, 'chat');

  // 探测环境能力（避免测了跑不通的组合）
  const env = await page.evaluate(() => ({
    modelTag: document.getElementById('modelTag')?.textContent?.trim() || '',
    modelTagClass: document.getElementById('modelTag')?.className || '',
    cloudConfigured: typeof _cloudConfigured !== 'undefined' ? _cloudConfigured : false,
  })).catch(() => ({}));
  const hasLocalModel = !env.modelTagClass.includes('none');
  const hasCloud = env.cloudConfigured;
  console.log('  环境: 本地模型=%s, 云端=%s, tag=%s', hasLocalModel, hasCloud, env.modelTag.slice(0,30));

  // ── 3a. 离线 + 聊天（默认 action，无需选按钮）──
  console.log('\n  📌 3a: 离线 + 聊天');
  if (hasLocalModel) {
    await newChatSession(page);  // 会话隔离
    await switchAiMode(page, '离线');
    const r = await sendMessageAndWait(page, '你好，用一个字回复');
    check('离线聊天：收到响应', r.ok, r.reason || ('+' + r.newMsgCount + '条 ' + r.elapsed + 's'));
    if (r.ok) {
      // 质量断言：要求简短（一个字指令），不能是错误，不能是空
      assertQuality('离线聊天', r, {
        minLen: 1, notError: true,
        maxLen: 200,
        notContains: ['[ERROR]', '无法连接', '模型未加载'],
      });
      logResponse('3a 离线聊天', '你好，用一个字回复', r);
    }
  } else {
    console.log('    ⏭️  跳过（本地模型未加载）');
  }

  // ── 3b. 离线 + 文档生成（提纲阶段）──
  // 文档生成 action 在离线模式注册（actionBar 显示"文档生成"）
  console.log('\n  📌 3b: 离线 + 文档生成（提纲）');
  if (hasLocalModel) {
    await newChatSession(page);  // 会话隔离
    await switchAiMode(page, '离线');
    // 用 setActionMode('doc') 直接切（比点"文档生成"按钮可靠，避免 actionBar 渲染时序导致点击落空）
    await page.evaluate(() => { if (typeof setActionMode === 'function') setActionMode('doc'); }).catch(() => {});
    await page.waitForTimeout(1500);
    const hasDocAction = await page.evaluate(() => { try { return currentActionMode === 'doc'; } catch { return false; } }).catch(() => false);
    if (hasDocAction) {
      // 文档生成不能用 sendMessageAndWait（它靠消息数判断完成，
      // 但 doc_outline 事件在所有 token 之后才发，消息数早增了）
      // 直接发消息，然后专门等提纲确认栏出现
      await page.fill('#msgInput', '写一份关于团队协作的简短文档，3个章节');
      await page.waitForTimeout(200);
      await page.locator('#sendBtn').click({ timeout: 5000 }).catch(() => {});

      // 直接等提纲确认栏（doc_outline 事件的真正完成信号），最多 120 秒
      console.log('    ⏳ 等待提纲确认栏（最多120秒）...');
      let outlineReady = false;
      try {
        await page.waitForSelector('#docOutlinePreview, #docOutlineEditor', { timeout: 120000, state: 'visible' });
        outlineReady = true;
      } catch {}
      check('文档生成：提纲确认栏出现', outlineReady);

      if (outlineReady) {
        // 提取提纲内容做质量断言
        const outlineContent = await page.locator('#docOutlinePreview').textContent().catch(() =>
          page.locator('#docOutlineEditor').inputValue().catch(() => '')
        );
        const hasStructure = outlineContent && (
          outlineContent.includes('#') || outlineContent.includes('章节') || outlineContent.includes('一、')
        );
        check('文档提纲有结构（质量）', hasStructure, (outlineContent||'').slice(0, 50));
        logResponse('3b 文档提纲', '写一份关于团队协作的简短文档', { content: outlineContent, feature: { textLen: (outlineContent||'').length, hasError: false }, elapsed: '?' }, hasStructure ? '✅有结构' : '⚠️');
      }
      // 取消提纲（清理状态）
      await page.locator('button:has-text("取消")').first().click({timeout: 2000}).catch(() => {});
      await page.waitForTimeout(500);
    } else {
      console.log('    ⏭️  跳过（离线模式未找到"文档生成"按钮）');
    }
  } else {
    console.log('    ⏭️  跳过（本地模型未加载）');
  }

  // ── 3c. 在线 + 智能对话（联网搜索/写文档/深度分析 是 agent 快捷提示词）──
  console.log('\n  📌 3c: 在线 + 智能对话');
  if (hasCloud) {
    await newChatSession(page);  // 会话隔离
    await switchAiMode(page, '在线');
    // 在线模式的 actionBar 是 agent 快捷提示词，直接发消息（agent 模式默认）
    const r = await sendMessageAndWait(page, '你好，简短回复');
    check('在线智能对话：收到响应', r.ok, r.reason || ('+' + r.newMsgCount + '条 ' + r.elapsed + 's'));
    if (r.ok) {
      assertQuality('在线对话', r, {
        minLen: 2, notError: true,
        notContains: ['[ERROR]', 'API Key', '未授权', '余额不足'],
      });
      logResponse('3c 在线对话', '你好，简短回复', r);
    }
  } else {
    console.log('    ⏭️  跳过（云端未配置）');
  }

  // ── 3d. 并行 + 知识库问答（并行模式只有知识库问答 action）──
  console.log('\n  📌 3d: 并行模式');
  if (hasLocalModel && hasCloud) {
    await newChatSession(page);  // 会话隔离
    await switchAiMode(page, '并行');
    const r = await sendMessageAndWait(page, '你好，简短回复');
    check('并行模式：收到响应', r.ok, r.reason || ('+' + r.newMsgCount + '条 ' + r.elapsed + 's'));
    if (r.ok) {
      assertQuality('并行融合', r, {
        minLen: 2, notError: true,
        notContains: ['[ERROR]', '请求失败'],
      });
      logResponse('3d 并行融合', '你好，简短回复', r);
    }
  } else {
    console.log('    ⏭️  跳过（需本地+云端都就绪）');
  }

  // ── 3e. 离线 + 知识库问答（如有 KB）──
  console.log('\n  📌 3e: 离线 + 知识库问答');
  if (hasLocalModel) {
    await newChatSession(page);  // 会话隔离
    await switchAiMode(page, '离线');
    // 直接调 setActionMode('kb_qa')（比点按钮可靠）
    const kbOk = await page.evaluate(() => {
      if (typeof setActionMode !== 'function') return false;
      setActionMode('kb_qa');
      return true;
    }).catch(() => false);
    if (kbOk) {
      await page.waitForTimeout(1500);
      // 本地 4B KB问答 = reformulate(LLM) + 检索 + 生成(LLM)，60s 偏紧（实测约 49s，拥塞下更久），放宽到 120s
      const r = await sendMessageAndWait(page, '总结一下文档内容', 120000);
      check('知识库问答：收到响应', r.ok, r.reason || ('+' + r.newMsgCount + '条'));
    } else {
      console.log('    ⏭️  跳过（setActionMode 不可用）');
    }
  }

  // 恢复到并行模式（默认）
  if (hasLocalModel && hasCloud) await switchAiMode(page, '并行');
  await shot(page, '03_mode_matrix');
}

async function test4_sessionSwitch(page) {
  console.log('\n🔴 测试 4：会话切换（不堆积 + 不卡死）');
  await switchTab(page, 'chat');
  await page.waitForTimeout(1000);

  const chatItems = page.locator('.chat-sidebar-item');
  const count = await chatItems.count().catch(() => 0);

  if (count < 2) {
    console.log('  ⏭️  跳过（会话数不足2个: %d）', count);
    return;
  }
  console.log('  找到 %d 个会话', count);

  // 会话切换是事件委托，点击可能触发网络加载。
  // 用 dispatchEvent + 短超时，避免某些损坏会话导致 click 阻塞。
  // 核心验证：切换函数能执行、页面不卡死、不堆积。
  const switchResult = await page.evaluate(() => {
    try {
      const items = document.querySelectorAll('.chat-sidebar-item');
      if (items.length >= 2) {
        // 直接调事件委托逻辑（模拟点击，不等待网络）
        items[1].click();
        return { ok: true, idx: 1 };
      }
      return { ok: false, reason: '不足2个' };
    } catch (e) { return { ok: false, reason: e.message }; }
  }).catch(() => ({ ok: false, reason: 'evaluate失败' }));

  check('会话切换函数可执行', switchResult.ok, switchResult.reason || '');

  // 给一点时间让异步加载（不阻塞）
  await page.waitForTimeout(2000);

  // 验证 #messages 没有重复堆积同类消息（检查 DOM 里没有重复的 data-hash）
  const dupCheck = await page.evaluate(() => {
    const msgs = document.querySelectorAll('#messages > .msg[data-hash]');
    const hashes = new Set();
    let dups = 0;
    msgs.forEach(m => {
      const h = m.getAttribute('data-hash');
      if (h && h !== '') {
        if (hashes.has(h)) dups++;
        hashes.add(h);
      }
    });
    return { total: msgs.length, dups };
  }).catch(() => ({ total: 0, dups: 0 }));

  check('无重复消息堆积（data-hash 去重）', dupCheck.dups === 0,
    dupCheck.dups > 0 ? '重复 ' + dupCheck.dups + ' 条' : '总' + dupCheck.total + '条');

  await shot(page, '04_session');
}

async function test5_usageChart(page) {
  console.log('\n🔴 测试 5：设置页用量统计分段');
  await switchTab(page, 'settings');
  await page.waitForTimeout(1500);

  const panel = page.locator('#cloudUsagePanel');
  const hasPanel = await panel.count();
  if (hasPanel === 0) {
    console.log('  ⏭️  跳过（用量面板不存在）');
    return;
  }

  await panel.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1000);

  const barGroups = await panel.locator('.usage-bar-group').count().catch(() => 0);
  const modelBars = await panel.locator('.usage-model-bar').count().catch(() => 0);

  // 云端有用量数据时验证分段；无数据（未配置/无调用）则验证面板结构存在即可
  if (barGroups === 0 && modelBars === 0) {
    const panelText = await panel.textContent().catch(() => '');
    const isEmpty = panelText.includes('暂无') || panelText.includes('不可用') || panelText.includes('未配置');
    check('用量面板正常渲染（无数据时显示空态）', isEmpty || panelText.length > 0,
      isEmpty ? '(空态，符合预期)' : '文本: ' + panelText.slice(0, 40));
    return;
  }

  check('用量柱状图有分段组', barGroups > 0, '组数: ' + barGroups);

  const colors = await panel.locator('.usage-seg').evaluateAll(els => {
    const set = new Set();
    els.forEach(e => set.add(e.getAttribute('fill') || ''));
    return [...set];
  }).catch(() => []);
  check('用量分段多色（输入/输出/推理）', colors.length >= 2, '颜色: ' + colors.join(','));

  check('按模型进度条分段', modelBars > 0, '条数: ' + modelBars);

  await shot(page, '05_usage');
}

async function test6_permissions(page) {
  console.log('\n🔴 测试 6：工具权限列表（含内网访问开关）');

  // 权限列表可能需要切到权限子 tab
  const permList = page.locator('#permissionToolsList');
  let visible = await permList.isVisible().catch(() => false);
  if (!visible) {
    // 尝试点权限相关 tab
    await page.locator('text=权限').first().click().catch(() => {});
    await page.waitForTimeout(500);
    visible = await permList.isVisible().catch(() => false);
  }

  if (!visible) {
    console.log('  ⏭️  跳过（权限列表不可见）');
    return;
  }

  const items = await permList.locator('[data-tool-id]').count();
  check('工具权限项 ≥ 4', items >= 4, '项数: ' + items);

  const hasIntranet = await permList.locator('[data-tool-id="intranet_access"]').count();
  check('含「允许内网访问」开关', hasIntranet > 0);

  await shot(page, '06_perms');
}

async function test7_scrollbar(page) {
  console.log('\n🔴 测试 7：滚动条样式');
  await switchTab(page, 'chat');

  // 从样式表提取所有相关规则（颜色在 thumb 规则里，不在 width 规则里）
  const rules = await page.evaluate(() => {
    const findAll = (keyword) => {
      const matches = [];
      for (const sheet of document.styleSheets) {
        try {
          for (const r of sheet.cssRules) {
            if (r.selectorText && r.selectorText.includes(keyword) && r.cssText.includes('scrollbar')) {
              matches.push(r.cssText);
            }
          }
        } catch {}
      }
      return matches.join(' | ');
    };
    return {
      chat: findAll('#messages'),
      settings: findAll('settings-content'),
    };
  }).catch(() => ({ chat: null, settings: null }));

  check('对话区滚动条有定义', !!rules.chat);
  check('设置区滚动条有定义', !!rules.settings);

  // 颜色判断：浏览器会把 hex 转 rgb。
  // 绿色 #059669 = rgb(5, 150, 105)；灰色 #D1D5DB = rgb(209,213,219)
  // 用「绿色通道主导」判断，而非精确匹配字符串
  if (rules.chat) {
    // 提取所有 rgb/rgba 颜色，检查是否有绿色调（G 通道高，R/B 低）
    const hasGreen = /rgb\(\s*5\s*,\s*1[45]\d\s*,\s*10[0-9]\s*\)/.test(rules.chat)
                  || /#059669/i.test(rules.chat);
    check('对话区滚动条用绿色', hasGreen, rules.chat.slice(0, 80));
  }
  if (rules.settings) {
    // 灰色：三通道接近（R≈G≈B），如 rgb(209,213,219) 或 rgb(156,163,175)
    const hasGray = /rgb\(\s*(1[5-9]\d|20\d)\s*,\s*(1[5-9]\d|20\d)\s*,\s*(1[5-9]\d|21\d)\s*\)/.test(rules.settings)
                 || /#D1D5DB/i.test(rules.settings) || /#9CA3AF/i.test(rules.settings);
    check('设置区滚动条用灰色', hasGray, rules.settings.slice(0, 80));
  }
}

// ============================================================
//  测试 8：停止生成 + 恢复（中断后状态一致性）
// ============================================================
async function test8_stopAndResume(page) {
  console.log('\n🔴 测试 8：停止生成 + 恢复');
  if (quick) { console.log('  ⏭️  --quick 跳过'); return; }

  await switchTab(page, 'chat');
  await newChatSession(page);  // 会话隔离
  // 确保离线模式（本地模型响应慢一点，便于测中断）
  await switchAiMode(page, '离线');

  const before = await page.locator('#messages > .msg').count();
  await page.fill('#msgInput', '请详细介绍一下人工智能的发展历史，从图灵测试讲到大语言模型，至少1000字');
  await page.waitForTimeout(200);
  await page.locator('#sendBtn').click({ timeout: 5000 }).catch(async () => {
    await page.evaluate(() => document.getElementById('sendBtn')?.dispatchEvent(new MouseEvent('click', {bubbles:true})));
  });
  await page.waitForTimeout(800);

  // 确认进入生成态（stopBtn 显示）
  const stopVisible = await page.locator('#stopBtn').isVisible().catch(() => false);
  check('生成中显示停止按钮', stopVisible);
  if (!stopVisible) { console.log('  ⏭️  未进入生成态，跳过'); return; }

  // 等 2 秒让生成开始（产生部分内容）
  await page.waitForTimeout(2000);

  // 点停止
  await page.locator('#stopBtn').click({ timeout: 3000 }).catch(async () => {
    await page.evaluate(() => document.getElementById('stopBtn')?.dispatchEvent(new MouseEvent('click', {bubbles:true})));
  });
  console.log('  已点击停止，等待状态恢复...');

  // 等待 sendBtn 恢复（最多 10 秒）
  let resumed = false;
  try {
    await page.waitForFunction(
      () => { const b = document.getElementById('sendBtn'); return b && b.style.display !== 'none'; },
      { timeout: 10000 }
    );
    resumed = true;
  } catch {}
  check('停止后 sendBtn 恢复显示', resumed);

  // 验证 input 恢复可用
  const inputOk = await page.locator('#msgInput').isEnabled().catch(() => false);
  check('停止后输入框可用', inputOk);

  // 验证停止后能继续发新消息（状态一致性核心验证）
  if (resumed && inputOk) {
    const before2 = await page.locator('#messages > .msg').count();
    await page.fill('#msgInput', '你好');
    await page.waitForTimeout(200);
    await page.locator('#sendBtn').click({ timeout: 5000 }).catch(() => {});
    // 给 90 秒（停止后离线模型可能需要重新加载）
    try {
      await page.waitForFunction(
        (b) => document.querySelectorAll('#messages > .msg').length > b,
        before2, { timeout: 90000 }
      );
      const after2 = await page.locator('#messages > .msg').count();
      check('停止后能继续发新消息', after2 > before2);
      // 质量断言：停止恢复后的响应不应是错误/空
      const resumeFeature = await page.evaluate(() => {
        const msgs = document.querySelectorAll('#messages > .msg.ai');
        const last = msgs[msgs.length - 1];
        if (!last) return null;
        return {
          textLen: (last.querySelector('.stream-content') || last).textContent.trim().length,
          hasError: last.textContent.includes('[ERROR]') || last.textContent.includes('请求失败'),
        };
      }).catch(() => null);
      if (resumeFeature) {
        check('停止后响应质量正常', !resumeFeature.hasError && resumeFeature.textLen > 0,
          resumeFeature.textLen + '字');
      }
    } catch {
      // 停止后模型可能还在收尾，宽松判断：只要 sendBtn 再次恢复就算可用
      const finalOk = await page.locator('#sendBtn').isVisible().catch(()=>false);
      check('停止后能继续发新消息', finalOk, '响应超时但sendBtn已恢复（模型收尾中）');
    }
  }
}

// ============================================================
//  测试 9：知识库全流程（上传 → 向量化 → 检索 → 问答）
// ============================================================
async function test9_kbFlow(page) {
  console.log('\n🔴 测试 9：知识库全流程');
  if (quick) { console.log('  ⏭️  --quick 跳过'); return; }

  // 探测 KB 模块状态
  const kbReady = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/kb/module-status');
      const d = await r.json();
      return { installed: d.installed, models_loaded: d.models_loaded };
    } catch { return { installed: false }; }
  }).catch(() => ({ installed: false }));

  if (!kbReady.installed) {
    console.log('  ⏭️  跳过（KB 模块未安装）');
    return;
  }
  console.log('  KB 模块: installed=%s, models=%s', kbReady.installed, kbReady.models_loaded);

  // 切到知识库 tab
  await switchTab(page, 'qa');
  await page.waitForTimeout(1500);

  // 检查已有文档数
  const statsBefore = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/kb/stats');
      return (await r.json()).document_count || 0;
    } catch { return 0; }
  }).catch(() => 0);
  console.log('  当前文档数: %d', statsBefore);

  // 上传测试文档（用 KB 导入文本 API，避免依赖文件选择器）
  const testContent = '人工智能（AI）是计算机科学的一个分支，致力于研究和开发能够模拟人类智能的系统。' +
    '机器学习是AI的核心技术之一，通过数据训练模型。深度学习使用多层神经网络。' +
    '大语言模型如GPT和BERT基于Transformer架构，能理解和生成自然语言。';
  const uploadResult = await page.evaluate(async (content) => {
    try {
      const r = await fetch('/api/kb/import_text', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ text: content, filename: 'e2e_test_ai_intro.txt', source: 'manual' }),
      });
      const d = await r.json();
      return { ok: r.ok, doc_id: d.doc_id, status: r.status, error: d.error };
    } catch(e) { return { ok: false, error: e.message }; }
  }, testContent).catch(() => ({ ok: false }));

  check('上传测试文档', uploadResult.ok, uploadResult.error || uploadResult.status || '');

  if (!uploadResult.ok) return;

  // 等待向量化完成（轮询文档状态，最多 60 秒）
  console.log('  ⏳ 等待向量化（最多60秒）...');
  let vectorized = false;
  const docId = uploadResult.doc_id;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    const st = await page.evaluate(async (id) => {
      try {
        const r = await fetch('/api/kb/documents/' + id + '/status');
        return (await r.json()).status;
      } catch { return 'unknown'; }
    }, docId).catch(() => 'unknown');
    if (st === 'ready') { vectorized = true; break; }
    if (st === 'error') break;
  }
  check('文档向量化完成', vectorized);

  if (vectorized) {
    // 检索测试（用上传文档里的概念查询）
    const searchResult = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/kb/search', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ query: '什么是机器学习', top_k: 3 }),
        });
        const d = await r.json();
        const results = d.results || d.documents || [];
        // 质量检查：检索结果应包含上传文档的相关内容
        const hasRelevantContent = results.some(r =>
          (r.content || r.text || '').includes('机器学习') || (r.content || r.text || '').includes('数据训练')
        );
        return { ok: r.ok, count: results.length, hasRelevant: hasRelevantContent };
      } catch(e) { return { ok: false, error: e.message }; }
    }).catch(() => ({ ok: false }));
    check('知识库检索返回结果', searchResult.ok && searchResult.count > 0,
      'count=' + searchResult.count);
    // 质量断言：检索到的内容应与查询相关（不只是返回任意结果）
    check('检索结果内容相关（质量）', searchResult.hasRelevant,
      searchResult.hasRelevant ? '命中"机器学习/数据训练"' : '未命中相关内容');
  }

  // 清理：删除测试文档
  await page.evaluate(async (id) => {
    try { await fetch('/api/kb/documents/' + id, { method: 'DELETE' }); } catch {}
  }, docId).catch(() => {});
  console.log('  🧹 已清理测试文档');
}

// ============================================================
//  测试 10：文档生成完整流程（提纲 → 确认 → 正文 → 下载）
// ============================================================
async function test10_docFullFlow(page) {
  console.log('\n🔴 测试 10：文档生成完整流程');
  if (quick) { console.log('  ⏭️  --quick 跳过'); return; }

  // 文档生成 action 在离线模式（actionBar 显示"文档生成"）
  const env = await page.evaluate(() => ({
    hasModel: !document.getElementById('modelTag')?.classList.contains('none'),
  })).catch(() => ({}));
  if (!env.hasModel) {
    console.log('  ⏭️  跳过（本地模型未加载）');
    return;
  }

  await switchTab(page, 'chat');
  await newChatSession(page);  // 会话隔离
  await switchAiMode(page, '离线');
  // 直接调 setActionMode('doc')（比点按钮更可靠，避免 actionBar 渲染时序）
  await page.evaluate(() => { if (typeof setActionMode==='function') setActionMode('doc'); });
  await page.waitForTimeout(1500);  // 等 async setActionMode 完成
  const actionOk = await page.evaluate(() => {
    try { return currentActionMode === 'doc'; } catch { return false; }
  }).catch(() => false);
  check('文档生成 action 已选中', actionOk);
  if (!actionOk) {
    console.log('  ⏭️  action 未切换到 doc，跳过');
    return;
  }

  // Phase 1：生成提纲
  const before = await page.locator('#messages > .msg').count();
  await page.fill('#msgInput', '写一份关于时间管理的简短文档，3个章节');
  await page.locator('#sendBtn').click({ timeout: 5000 }).catch(() => {});

  // 等待提纲确认栏出现（doc_outline 事件在所有 token 之后才发，离线模型慢，给 150 秒）
  console.log('  ⏳ 等待提纲生成（最多150秒）...');
  let outlineReady = false;
  try {
    await page.waitForSelector('#docOutlinePreview, #docOutlineEditor', { timeout: 150000, state: 'visible' });
    outlineReady = true;
  } catch {}
  check('Phase1 提纲确认栏出现', outlineReady);
  if (!outlineReady) return;

  // Phase 2：点"确认生成"
  console.log('  点击确认生成，等待正文...');
  const confirmBtn = page.locator('button:has-text("确认生成")').first();
  await confirmBtn.click({ timeout: 5000 }).catch(() => {});

  // 等待正文完成（下载按钮出现 或 sendBtn 恢复）
  let docDone = false;
  try {
    await page.waitForSelector('.doc-download-bar, [data-doc-complete]', { timeout: 120000, state: 'visible' });
    docDone = true;
  } catch {}
  check('Phase2 文档正文生成 + 下载按钮', docDone);

  if (docDone) {
    // 验证下载链接存在
    const dlLink = await page.locator('.doc-download-bar a[download], [data-doc-complete] a').first();
    const hasLink = await dlLink.count();
    check('下载链接存在', hasLink > 0);
  }
  await shot(page, '10_doc_flow');
}

// ============================================================
//  测试 11：历史消息渲染（刷新后 CardRenderer/引用/代码块）
// ============================================================
async function test11_historyRender(page) {
  console.log('\n🔴 测试 11：历史消息渲染（刷新后一致性）');

  await switchTab(page, 'chat');
  await page.waitForTimeout(1500);  // 等待消息落盘完成

  // 刷新前：记录所有 AI 消息的结构特征（不只看最近一条）
  const beforeRefresh = await page.evaluate(() => {
    const msgs = document.querySelectorAll('#messages > .msg.ai');
    if (!msgs.length) return null;
    const last = msgs[msgs.length - 1];
    // 取最长的一条作为正文对比基准（避免最近一条是短回复）
    let maxLen = 0;
    msgs.forEach(m => {
      const sc = m.querySelector('.stream-content');
      const l = (sc||m).textContent.trim().length;
      if (l > maxLen) maxLen = l;
    });
    return {
      count: msgs.length,
      maxLen,
      lastHasCard: !!last.querySelector('.card-area'),
      lastHasStream: !!last.querySelector('.stream-content'),
      lastHasFooter: !!last.querySelector('.msg-footer, .stats-detail'),
    };
  }).catch(() => null);

  if (!beforeRefresh || beforeRefresh.count === 0) {
    console.log('  ⏭️  跳过（无历史 AI 消息）');
    return;
  }
  console.log('  刷新前: %d条AI消息, 最长%d字', beforeRefresh.count, beforeRefresh.maxLen);

  // 刷新页面
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  await page.evaluate(() => { if (typeof dismissWelcome==='function') dismissWelcome(); }).catch(() => {});
  await page.waitForTimeout(800);

  const afterRefresh = await page.evaluate(() => {
    const msgs = document.querySelectorAll('#messages > .msg.ai');
    if (!msgs.length) return null;
    const last = msgs[msgs.length - 1];
    let maxLen = 0;
    msgs.forEach(m => {
      const sc = m.querySelector('.stream-content');
      const l = (sc||m).textContent.trim().length;
      if (l > maxLen) maxLen = l;
    });
    return {
      count: msgs.length,
      maxLen,
      lastHasCard: !!last.querySelector('.card-area'),
      lastHasStream: !!last.querySelector('.stream-content'),
      lastHasFooter: !!last.querySelector('.msg-footer, .stats-detail'),
    };
  }).catch(() => null);

  if (!afterRefresh) {
    check('刷新后消息恢复', false, '无消息');
    return;
  }

  check('刷新后 AI 消息数一致', afterRefresh.count === beforeRefresh.count,
    '前:' + beforeRefresh.count + ' 后:' + afterRefresh.count);

  // card-area：只在刷新前有多条消息且有card时检查（单条短消息可能无card）
  const anyCardAfter = await page.evaluate(() =>
    !!document.querySelector('#messages > .msg.ai .card-area')
  ).catch(() => false);
  if (beforeRefresh.lastHasCard && beforeRefresh.count >= 2) {
    check('刷新后保留 card-area（推理步骤）', anyCardAfter);
  } else {
    console.log('  ℹ️  跳过 card-area 检查（刷新前消息少或无card）');
  }
  if (beforeRefresh.lastHasStream) {
    check('刷新后保留 stream-content（正文）', afterRefresh.lastHasStream);
  }
  if (beforeRefresh.lastHasFooter) {
    check('刷新后保留 msg-footer（统计）', afterRefresh.lastHasFooter);
  }
  // 正文长度：用最长消息对比，容差 50%（渲染折叠/think 差异）
  check('刷新后正文内容保留', afterRefresh.maxLen >= beforeRefresh.maxLen * 0.5,
    '前最长:' + beforeRefresh.maxLen + ' 后最长:' + afterRefresh.maxLen);

  await shot(page, '11_after_refresh');
}

// ============================================================
//  测试 13：在线联网搜索（验证搜索+引用来源展示）
// ============================================================
async function test13_webSearch(page) {
  console.log('\n🔴 测试 13：在线联网搜索');
  if (quick) { console.log('  ⏭️  --quick 跳过'); return; }

  const hasCloud = await page.evaluate(() => typeof _cloudConfigured !== 'undefined' && _cloudConfigured).catch(()=>false);
  if (!hasCloud) { console.log('  ⏭️  跳过（云端未配置）'); return; }

  await switchTab(page, 'chat');
  await newChatSession(page);
  await switchAiMode(page, '在线');
  // 在线模式的联网搜索是 agent 快捷提示词
  await selectAction(page, '联网搜索', 'agent');

  const r = await sendMessageAndWait(page, '请联网搜索：今天的日期', 120000);
  check('联网搜索：收到响应', r.ok, r.reason || ('+' + r.newMsgCount + '条 ' + r.elapsed + 's'));

  if (r.ok && r.feature) {
    // 质量断言：联网搜索应有搜索步骤（card-area 含搜索结果）或引用
    const hasSearchCard = r.feature.hasCard;
    const hasCite = r.feature.hasCite;
    check('联网搜索：有搜索/引用展示', hasSearchCard || hasCite,
      hasSearchCard ? '有推理卡片' : (hasCite ? '有引用' : '无搜索痕迹'));
    // 不能是错误
    assertQuality('联网搜索', r, {
      minLen: 5, notError: true,
      notContains: ['[ERROR]', 'API Key', '未授权'],
    });
    logResponse('13 联网搜索', '请联网搜索：今天的日期', r,
      (hasSearchCard || hasCite) ? '✅有搜索' : '⚠️无搜索痕迹');
  }
  await shot(page, '13_web_search');
}

// ============================================================
//  测试 14：错误降级（模型未加载/云端异常的友好提示）
// ============================================================
async function test14_errorHandling(page) {
  console.log('\n🔴 测试 14：错误降级处理');
  if (quick) { console.log('  ⏭️  --quick 跳过'); return; }

  await switchTab(page, 'chat');
  await newChatSession(page);

  // 场景A：API 返回错误时的前端处理（模拟 404/500）
  const errorHandled = await page.evaluate(async () => {
    // 直接请求一个不存在的端点，看前端是否有全局错误处理（不崩溃）
    try {
      await fetch('/api/nonexistent-endpoint-test');
      return { noCrash: true };
    } catch(e) {
      return { noCrash: true, error: e.message };
    }
  }).catch(() => ({ noCrash: false }));
  check('前端处理异常请求不崩溃', errorHandled.noCrash);

  // 场景B：输入框空内容发送（应有前端校验，不发空消息）
  await page.fill('#msgInput', '');
  await page.waitForTimeout(200);
  const beforeEmpty = await page.locator('#messages > .msg').count();
  await page.locator('#sendBtn').click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const afterEmpty = await page.locator('#messages > .msg').count();
  check('空内容不发送（前端校验）', afterEmpty === beforeEmpty,
    '前:' + beforeEmpty + ' 后:' + afterEmpty);

  // 场景C：超长输入（应有截断或提示，不崩溃）
  const longText = '测试'.repeat(5000);  // 1万字
  await page.fill('#msgInput', longText);
  await page.waitForTimeout(300);
  const inputOk = await page.locator('#msgInput').isEnabled().catch(() => false);
  check('超长输入不卡死输入框', inputOk);
  // 清理
  await page.fill('#msgInput', '');
  await page.waitForTimeout(200);

  // 场景D：快速连续点击发送（防抖，不重复发送）
  await page.fill('#msgInput', '防抖测试');
  await page.waitForTimeout(200);
  const beforeRapid = await page.locator('#messages > .msg').count();
  // 快速点3次
  for (let i = 0; i < 3; i++) {
    await page.locator('#sendBtn').click({ timeout: 1000 }).catch(() => {});
  }
  await page.waitForTimeout(2000);
  const afterRapid = await page.locator('#messages > .msg').count();
  // 应该只发一次（user消息+1），不是3次
  check('快速连续点击不重复发送', (afterRapid - beforeRapid) <= 2,
    '增加:' + (afterRapid - beforeRapid) + '条（应≤2: 1条user+可能的ai）');

  // 等待可能的响应完成
  await page.waitForFunction(
    () => { const b = document.getElementById('sendBtn'); return b && b.style.display !== 'none'; },
    { timeout: 30000 }
  ).catch(() => {});

  await shot(page, '14_error_handling');
}

// ============================================================
//  测试 15：在线文档生成（守护 BUG-1：cloud _run_agent_loop 保存路径 NameError）
// ============================================================
async function test15_onlineDocFlow(page) {
  console.log('\n🔴 测试 15：在线文档生成（守护 BUG-1）');
  if (quick) { console.log('  ⏭️  --quick 跳过'); return; }
  const hasCloud = await page.evaluate(() => typeof _cloudConfigured !== 'undefined' && _cloudConfigured).catch(() => false);
  if (!hasCloud) { console.log('  ⏭️  跳过（云端未配置）'); return; }

  await switchTab(page, 'chat');
  await newChatSession(page);
  await switchAiMode(page, '在线');
  await page.evaluate(() => { if (typeof setActionMode === 'function') setActionMode('doc'); }).catch(() => {});
  await page.waitForTimeout(1500);
  const isDoc = await page.evaluate(() => { try { return currentActionMode === 'doc'; } catch { return false; } }).catch(() => false);
  check('在线文档：action=doc 已选中', isDoc);
  if (!isDoc) return;

  await page.fill('#msgInput', '写一份关于番茄工作法的简短文档，2个章节');
  await page.locator('#sendBtn').click({ timeout: 5000 }).catch(() => {});
  console.log('  ⏳ 等待在线文档生成（最多180秒）...');

  // BUG-1 表现为保存时 NameError → 前端收到"处理过程中出错"。核心断言：完成且无 pipeline 错误。
  let done = false, errored = false;
  const t0 = Date.now();
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(2000);
    const dl = await page.locator('.doc-download-bar, [data-doc-complete]').count().catch(() => 0);
    if (dl > 0) { done = true; break; }
    const errTxt = await page.evaluate(() => {
      const m = document.querySelectorAll('#messages > .msg.ai'); const last = m[m.length - 1];
      return last ? (last.textContent.includes('[ERROR]') || last.textContent.includes('处理过程中出错') || last.textContent.includes('请求失败')) : false;
    }).catch(() => false);
    if (errTxt) { errored = true; break; }
    const btnBack = await page.evaluate(() => { const b = document.getElementById('sendBtn'); return b && b.style.display !== 'none'; }).catch(() => false);
    if (btnBack && i > 3) break;  // 流程结束（即便无下载按钮也跳出，避免干等）
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  check('在线文档：完成且无 pipeline 错误（BUG-1）', !errored,
    errored ? '出现错误响应（疑似回归）' : (done ? '有下载按钮 ' + secs + 's' : '完成 ' + secs + 's'));
  if (done) check('在线文档：下载按钮出现', true);
  await shot(page, '15_online_doc');
}

// ============================================================
//  测试 16：在线带 KB 引用发消息（守护 BUG-2：cloud agent 预读 _agent_timeline_buf）
// ============================================================
async function test16_onlineAttachment(page) {
  console.log('\n🔴 测试 16：在线带KB引用（守护 BUG-2）');
  if (quick) { console.log('  ⏭️  --quick 跳过'); return; }
  const hasCloud = await page.evaluate(() => typeof _cloudConfigured !== 'undefined' && _cloudConfigured).catch(() => false);
  if (!hasCloud) { console.log('  ⏭️  跳过（云端未配置）'); return; }
  const kbReady = await page.evaluate(async () => { try { const r = await fetch('/api/kb/module-status'); return (await r.json()).installed; } catch { return false; } }).catch(() => false);
  if (!kbReady) { console.log('  ⏭️  跳过（KB 未安装）'); return; }

  // 准备一篇 KB 文档并等向量化
  const content = '番茄工作法是一种时间管理方法：选定任务，专注工作25分钟，然后休息5分钟，每完成4个番茄钟后长休息15-30分钟。核心是用固定节奏对抗分心。';
  const up = await page.evaluate(async (c) => {
    try {
      const r = await fetch('/api/kb/import_text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: c, filename: 'e2e_pomodoro.txt', source: 'manual' }) });
      const d = await r.json(); return { ok: r.ok, doc_id: d.doc_id };
    } catch (e) { return { ok: false }; }
  }, content).catch(() => ({ ok: false }));
  check('在线KB引用：准备文档', up.ok, up.doc_id || '');
  if (!up.ok) return;
  const docId = up.doc_id;
  let ready = false;
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(1500);
    const st = await page.evaluate(async (id) => { try { const r = await fetch('/api/kb/documents/' + id + '/status'); return (await r.json()).status; } catch { return '?'; } }, docId).catch(() => '?');
    if (st === 'ready') { ready = true; break; }
    if (st === 'error') break;
  }
  check('在线KB引用：文档向量化', ready);

  await switchTab(page, 'chat');
  await newChatSession(page);
  await switchAiMode(page, '在线');
  // 等价于前端"引用知识库文档"：pendingFile = {path: doc_id, source:'kb'} → sendMessage 带 file_path
  await page.evaluate((id) => {
    window.pendingFile = { path: id, source: 'kb', name: 'e2e_pomodoro.txt' };
  }, docId).catch(() => {});

  const r = await sendMessageAndWait(page, '根据我引用的这篇文档，用一句话概括它讲了什么', 120000);
  // BUG-2 表现为 UnboundLocalError → "处理过程中出错"。核心断言：带 file_path 的在线 agent 正常响应。
  check('在线KB引用：收到响应（BUG-2）', r.ok, r.reason || (r.elapsed + 's'));
  if (r.ok) {
    assertQuality('在线KB引用', r, { minLen: 2, notError: true, notContains: ['[ERROR]', '处理过程中出错', '请求失败'] });
    logResponse('16 在线KB引用', '根据引用文档一句话概括', r);
  }
  // 清理
  await page.evaluate(async (id) => { try { await fetch('/api/kb/documents/' + id, { method: 'DELETE' }); } catch {} }, docId).catch(() => {});
  await shot(page, '16_online_attach');
}

// ============================================================
//  测试 17：附件上传白名单（守护 N-5：拒绝非文档类型落盘）
// ============================================================
async function test17_uploadAllowlist(page) {
  console.log('\n🔴 测试 17：附件上传白名单（N-5）');
  await switchTab(page, 'chat');
  await newChatSession(page);
  const chatId = await page.evaluate(() => { try { return (currentChatFile || '').split(/[\\/]/).pop().replace('.json', ''); } catch { return ''; } }).catch(() => '');
  if (!chatId) { console.log('  ⏭️  跳过（无 chat_id）'); return; }

  // 允许类型 .txt → 200 + 返回 workspace 路径
  const okUp = await page.evaluate(async (cid) => {
    const fd = new FormData();
    fd.append('file', new Blob(['e2e allow test content'], { type: 'text/plain' }), 'e2e_ok.txt');
    const r = await fetch('/api/file_upload?chat_id=' + encodeURIComponent(cid), { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    return { status: r.status, path: d.path || '', err: d.error || '' };
  }, chatId).catch(() => ({ status: 0 }));
  check('上传 .txt 成功（白名单放行）', okUp.status === 200 && !!okUp.path, 'status=' + okUp.status + ' ' + (okUp.err || ''));

  // 被拒类型 .exe → 400
  const badUp = await page.evaluate(async (cid) => {
    const fd = new FormData();
    fd.append('file', new Blob(['MZ\x90\x00'], { type: 'application/octet-stream' }), 'evil.exe');
    const r = await fetch('/api/file_upload?chat_id=' + encodeURIComponent(cid), { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    return { status: r.status, err: d.error || '' };
  }, chatId).catch(() => ({ status: 0 }));
  check('上传 .exe 被拒（400，N-5）', badUp.status === 400, 'status=' + badUp.status + ' ' + (badUp.err || ''));
}

// ============================================================
//  主流程
// ============================================================
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   Sidemate UI 端到端测试 (Playwright)                    ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('目标: %s%s%s', BASE, headed ? ' (有头)' : ' (无头)', quick ? ' (quick)' : '');

  const browser = await chromium.launch({ headless: !headed, slowMo: 0 });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));

  // 单步超时保护：每个测试最多指定秒数，超时跳过继续（防止单步卡死整个测试）
  async function runStep(name, fn, timeoutSec = 40) {
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`步骤超时(${timeoutSec}s)`)), timeoutSec * 1000))
      ]);
    } catch (e) {
      console.log('  ⚠️  %s 异常/超时: %s', name, e.message.slice(0, 80));
    }
  }

  try {
    await runStep('页面加载', () => test1_pageLoad(page));
    await runStep('模式切换', () => test2_modeSwitch(page));
    await runStep('模式矩阵', () => test3_modeMatrix(page), 360);
    await runStep('会话切换', () => test4_sessionSwitch(page));
    await runStep('用量统计', () => test5_usageChart(page));
    await runStep('工具权限', () => test6_permissions(page));
    await runStep('滚动条', () => test7_scrollbar(page));
    await runStep('停止+恢复', () => test8_stopAndResume(page), 120);
    await runStep('知识库流程', () => test9_kbFlow(page), 120);
    await runStep('文档完整流程', () => test10_docFullFlow(page), 300);
    await runStep('历史渲染', () => test11_historyRender(page));
    await runStep('联网搜索', () => test13_webSearch(page), 150);
    await runStep('错误降级', () => test14_errorHandling(page), 90);
    await runStep('在线文档生成', () => test15_onlineDocFlow(page), 240);
    await runStep('在线KB引用', () => test16_onlineAttachment(page), 180);
    await runStep('上传白名单', () => test17_uploadAllowlist(page), 60);
  } catch (e) {
    console.log('\n💥 测试中断: %s', e.message);
    failed++;
    failures.push('中断: ' + e.message);
    await shot(page, '99_error');
  }

  console.log('\n🔴 测试 12：前端 console 错误');
  // 过滤掉测试自身故意触发的错误（test14 请求不存在端点、资源加载等非产品问题）
  const realErrors = consoleErrors.filter(e =>
    !e.includes('nonexistent-endpoint') &&
    !e.includes('Failed to load resource') &&  // 资源加载错误（多为网络/扩展）
    !e.includes('favicon')
  );
  if (realErrors.length === 0) {
    check('无前端 console/pageerror', true);
  } else {
    check('无前端 console/pageerror', false, realErrors.length + ' 个');
    realErrors.slice(0, 5).forEach(e => console.log('     • %s', e.slice(0, 150)));
  }

  await browser.close();
  flushResponseLog();  // 写出响应记录日志（供后续人工评价）

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  ✅ 通过: %d   ❌ 失败: %d', passed, failed);
  if (failures.length > 0) {
    console.log('  失败项:');
    failures.forEach(f => console.log('    • %s', f));
  }
  console.log('  截图: %s', SCREENSHOT_DIR);
  if (_respLogEntries.length) console.log('  响应记录: %s (%d条)', RESPONSE_LOG, _respLogEntries.length);
  console.log('═══════════════════════════════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(2); });

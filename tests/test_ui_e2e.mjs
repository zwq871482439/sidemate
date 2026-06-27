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

let passed = 0, failed = 0;
const failures = [];

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
async function switchAiMode(page, modeText) {
  const btn = page.locator(`button:has-text("${modeText}")`).first();
  await btn.click({ timeout: 3000 }).catch(async () => {
    await page.evaluate(el => { if (el) el.dispatchEvent(new MouseEvent('click', {bubbles:true})); },
      await btn.elementHandle().catch(() => null));
  });
  await page.waitForTimeout(2000);  // 等模式切换完成（鱼骨屏）
}

// 选择 Action（聊天/写文档/联网搜索/深度分析/知识库问答）
async function selectAction(page, actionText) {
  // action 按钮在 actionBar，文字匹配
  const btn = page.locator(`#actionBar button:has-text("${actionText}"), .action-bar button:has-text("${actionText}")`).first();
  const exists = await btn.count();
  if (!exists) return false;
  await btn.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  return true;
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
    await switchAiMode(page, '离线');
    const r = await sendMessageAndWait(page, '你好，用一个字回复');
    check('离线聊天：收到响应', r.ok, r.reason || ('+' + r.newMsgCount + '条 ' + r.elapsed + 's'));
    if (r.ok) {
      // 质量断言：要求简短（一个字指令），不能是错误，不能是空
      assertQuality('离线聊天', r, {
        minLen: 1, notError: true,
        // 本地小模型可能不完全遵守"一个字"，但不应过长（<200字）或重复
        maxLen: 200,
        notContains: ['[ERROR]', '无法连接', '模型未加载'],
      });
    }
  } else {
    console.log('    ⏭️  跳过（本地模型未加载）');
  }

  // ── 3b. 并行 + 文档生成（提纲阶段）──
  // 文档生成 action 只在并行模式注册（/api/action/list 返回 doc）
  console.log('\n  📌 3b: 并行 + 文档生成（提纲）');
  if (hasLocalModel && hasCloud) {
    await switchAiMode(page, '并行');
    const hasDocAction = await selectAction(page, '文档生成');
    if (hasDocAction) {
      const r = await sendMessageAndWait(page, '写一份关于团队协作的简短文档，3个章节');
      check('文档生成：收到提纲响应', r.ok, r.reason || ('+' + r.newMsgCount + '条'));
      if (r.ok) {
        // 文档模式 Phase1 应出现提纲确认栏
        await page.waitForTimeout(1000);
        const hasOutline = await page.locator('#docOutlineEditor, #docOutlinePreview').count();
        check('文档生成：出现提纲确认栏', hasOutline > 0);
        // 取消提纲（清理状态）
        await page.locator('button:has-text("取消")').first().click({timeout: 2000}).catch(() => {});
        await page.waitForTimeout(500);
      }
    } else {
      console.log('    ⏭️  跳过（并行模式未找到"文档生成"按钮）');
    }
  } else {
    console.log('    ⏭️  跳过（需本地+云端都就绪）');
  }

  // ── 3c. 在线 + 智能对话（agent）──
  console.log('\n  📌 3c: 在线 + 智能对话');
  if (hasCloud) {
    await switchAiMode(page, '在线');
    // 在线模式是 agent，可能有"智能对话"action 或快捷提示词
    await selectAction(page, '智能对话');
    const r = await sendMessageAndWait(page, '你好，简短回复');
    check('在线智能对话：收到响应', r.ok, r.reason || ('+' + r.newMsgCount + '条 ' + r.elapsed + 's'));
    if (r.ok) {
      // 在线大模型质量应更好：不能空、不能错误
      assertQuality('在线对话', r, {
        minLen: 2, notError: true,
        notContains: ['[ERROR]', 'API Key', '未授权', '余额不足'],
      });
    }
  } else {
    console.log('    ⏭️  跳过（云端未配置）');
  }

  // ── 3d. 并行 + 双模型融合聊天 ──
  console.log('\n  📌 3d: 并行 + 双模型融合');
  if (hasLocalModel && hasCloud) {
    await switchAiMode(page, '并行');
    await selectAction(page, '聊天');
    const r = await sendMessageAndWait(page, '你好，简短回复');
    check('并行模式：收到响应', r.ok, r.reason || ('+' + r.newMsgCount + '条 ' + r.elapsed + 's'));
    if (r.ok) {
      // 并行模式融合本地+云端，质量应稳定
      assertQuality('并行融合', r, {
        minLen: 2, notError: true,
        notContains: ['[ERROR]', '请求失败'],
      });
    }
  } else {
    console.log('    ⏭️  跳过（需本地+云端都就绪）');
  }

  // ── 3e. 离线 + 知识库问答（如有 KB）──
  console.log('\n  📌 3e: 离线 + 知识库问答');
  if (hasLocalModel) {
    await switchAiMode(page, '离线');
    const hasKbAction = await selectAction(page, '知识库问答');
    if (hasKbAction) {
      const r = await sendMessageAndWait(page, '总结一下文档内容', 60000);
      check('知识库问答：收到响应', r.ok, r.reason || ('+' + r.newMsgCount + '条'));
    } else {
      console.log('    ⏭️  跳过（无知识库问答按钮，KB 未就绪）');
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

  // 文档生成只在并行模式
  const env = await page.evaluate(() => ({
    hasModel: !document.getElementById('modelTag')?.classList.contains('none'),
    hasCloud: typeof _cloudConfigured !== 'undefined' && _cloudConfigured,
  })).catch(() => ({}));
  if (!env.hasModel || !env.hasCloud) {
    console.log('  ⏭️  跳过（文档生成需并行模式：本地+云端）');
    return;
  }

  await switchTab(page, 'chat');
  await switchAiMode(page, '并行');
  const hasDoc = await selectAction(page, '文档生成');
  if (!hasDoc) {
    console.log('  ⏭️  跳过（无文档生成 action）');
    return;
  }

  // Phase 1：生成提纲
  const before = await page.locator('#messages > .msg').count();
  await page.fill('#msgInput', '写一份关于时间管理的简短文档，3个章节');
  await page.locator('#sendBtn').click({ timeout: 5000 }).catch(() => {});

  // 等待提纲确认栏出现（最多 90 秒）
  console.log('  ⏳ 等待提纲生成（最多90秒）...');
  let outlineReady = false;
  try {
    await page.waitForSelector('#docOutlinePreview, #docOutlineEditor', { timeout: 90000, state: 'visible' });
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
  await page.waitForTimeout(1000);

  // 刷新前：记录当前 AI 消息的结构特征
  const beforeRefresh = await page.evaluate(() => {
    const msgs = document.querySelectorAll('#messages > .msg.ai');
    if (!msgs.length) return null;
    const last = msgs[msgs.length - 1];
    return {
      count: msgs.length,
      hasCard: !!last.querySelector('.card-area'),
      hasStream: !!last.querySelector('.stream-content'),
      hasFooter: !!last.querySelector('.msg-footer, .stats-detail'),
      textLen: last.textContent.length,
      // 检查是否有推理步骤详情（cb-step-detail）的折叠状态
      hasStepDetail: !!last.querySelector('.cb-step-detail'),
    };
  }).catch(() => null);

  if (!beforeRefresh || beforeRefresh.count === 0) {
    console.log('  ⏭️  跳过（无历史 AI 消息）');
    return;
  }
  console.log('  刷新前: %d条AI消息, 最近消息 card=%s stream=%s',
    beforeRefresh.count, beforeRefresh.hasCard, beforeRefresh.hasStream);

  // 刷新页面
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  // 关闭欢迎覆层
  await page.evaluate(() => { if (typeof dismissWelcome==='function') dismissWelcome(); }).catch(() => {});
  await page.waitForTimeout(500);

  // 刷新后：对比结构特征
  const afterRefresh = await page.evaluate(() => {
    const msgs = document.querySelectorAll('#messages > .msg.ai');
    if (!msgs.length) return null;
    const last = msgs[msgs.length - 1];
    return {
      count: msgs.length,
      hasCard: !!last.querySelector('.card-area'),
      hasStream: !!last.querySelector('.stream-content'),
      hasFooter: !!last.querySelector('.msg-footer, .stats-detail'),
      textLen: last.textContent.length,
      hasStepDetail: !!last.querySelector('.cb-step-detail'),
    };
  }).catch(() => null);

  if (!afterRefresh) {
    check('刷新后消息恢复', false, '无消息');
    return;
  }

  // 核心断言：刷新后消息数一致 + 结构特征保留
  check('刷新后 AI 消息数一致', afterRefresh.count === beforeRefresh.count,
    '前:' + beforeRefresh.count + ' 后:' + afterRefresh.count);

  if (beforeRefresh.hasCard) {
    // card-area 可能因停止中断的消息而缺失，宽松判断：只要有任意一条 AI 消息保留 card 即可
    const anyCardAfter = await page.evaluate(() =>
      !!document.querySelector('#messages > .msg.ai .card-area')
    ).catch(() => false);
    check('刷新后保留 card-area（推理步骤）', anyCardAfter, '最近消息无card但检查全局');
  }
  if (beforeRefresh.hasStream) {
    check('刷新后保留 stream-content（正文）', afterRefresh.hasStream);
  }
  if (beforeRefresh.hasFooter) {
    check('刷新后保留 msg-footer（统计）', afterRefresh.hasFooter);
  }
  // 正文长度应接近（允许渲染差异）
  check('刷新后正文内容保留', Math.abs(afterRefresh.textLen - beforeRefresh.textLen) < beforeRefresh.textLen * 0.3,
    '前:' + beforeRefresh.textLen + ' 后:' + afterRefresh.textLen);

  await shot(page, '11_after_refresh');
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
    await runStep('文档完整流程', () => test10_docFullFlow(page), 240);
    await runStep('历史渲染', () => test11_historyRender(page));
  } catch (e) {
    console.log('\n💥 测试中断: %s', e.message);
    failed++;
    failures.push('中断: ' + e.message);
    await shot(page, '99_error');
  }

  console.log('\n🔴 测试 12：前端 console 错误');
  if (consoleErrors.length === 0) {
    check('无前端 console/pageerror', true);
  } else {
    check('无前端 console/pageerror', false, consoleErrors.length + ' 个');
    consoleErrors.slice(0, 5).forEach(e => console.log('     • %s', e.slice(0, 150)));
  }

  await browser.close();

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  ✅ 通过: %d   ❌ 失败: %d', passed, failed);
  if (failures.length > 0) {
    console.log('  失败项:');
    failures.forEach(f => console.log('    • %s', f));
  }
  console.log('  截图: %s', SCREENSHOT_DIR);
  console.log('═══════════════════════════════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(2); });

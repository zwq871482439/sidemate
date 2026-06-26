// ===== welcome-tour.js — 阶段1欢迎弹窗 + 阶段2交互式引导 =====

// ── 阶段1: 欢迎弹窗 ─────────────────────────────────────
async function showWelcome() {
  // 确保关键函数已加载
  if (typeof iconSvg !== 'function') { return; }
  try {
    var resp = await fetch('/api/onboard/status');
    var status = await resp.json();
    var hasAI = status.llm_installed || status.cloud_configured;
    var hasKB = status.kb_installed;
    var hasCloud = status.cloud_configured;

    var card = document.getElementById('welcomeCard');
    if (!card) return;

    var routeIcon, routeTitle, routeDesc, routeActions;

    if (!hasAI) {
      routeIcon = 'welcome';
      routeTitle = '欢迎使用桌伴';
      routeDesc = '需要一个 AI 引擎才能开始工作。选择一种方式：';
      routeActions =
        '<div style="text-align:left;margin:16px 0">' +
          optionCard('home', '本地 AI', '安装 LLM 模型包，数据不出本机', 'var(--accent-color)') +
          optionCard('cloud', '云端 AI', '填入 API Key，无需本地模型', '#7F77DD') +
        '</div>' +
        '<button onclick="dismissWelcome();switchTab(\'settings\',document.querySelector(\'.tabs-nav button\'))" class="welcome-btn">前往设置</button>';
    } else if (!hasKB) {
      routeIcon = 'chat';
      routeTitle = 'AI 已就绪！';
      routeDesc = '你可以开始与 AI 对话。安装知识库扩展包可解锁文档问答能力。';
      routeActions =
        '<div style="text-align:left;margin:16px 0">' +
          featureItem('chat', 'Chat 对话', '自由聊天，支持上传文件') +
          featureItem('lock', '隐私优先', '所有数据存放在本机') +
          (hasCloud ? featureItem('cloud', '在线模式', '云端模型可检索本地知识库辅助回答') : '') +
        '</div>' +
        '<button onclick="dismissWelcome();startTour()" class="welcome-btn">开始使用</button>' +
        '<div style="font-size:.72em;color:var(--text-muted);margin-top:10px;cursor:pointer" onclick="dismissWelcome()">跳过新手引导，直接开始</div>';
    } else {
      routeIcon = 'check';
      routeTitle = '全功能就绪！';
      routeDesc = '所有模块已安装。来探索桌伴的完整能力吧。';
      routeActions =
        '<div style="text-align:left;margin:16px 0">' +
          featureItem('chat', 'Chat 对话', '三种 AI 模式：离线 / 在线 / 并行') +
          featureItem('book', '知识库', '上传文档，AI 基于你的资料回答') +
          featureItem('lock', '隐私设计', '数据不出本机，云端按需授权') +
        '</div>' +
        '<button onclick="dismissWelcome();startTour()" class="welcome-btn">开始浏览</button>' +
        '<div style="font-size:.72em;color:var(--text-muted);margin-top:10px;cursor:pointer" onclick="dismissWelcome()">跳过新手引导</div>';
    }

    card.innerHTML =
      '<div class="welcome-top-decoration"></div>' +
      '<div style="text-align:center;padding-top:8px">' +
        '<div class="welcome-icon-circle">' + iconCircleSvg(routeIcon, 28) + '</div>' +
        '<h2 style="font-size:1.15em;font-weight:700;margin:12px 0 4px;color:var(--text-primary)">' + routeTitle + '</h2>' +
        '<p style="font-size:.84em;color:var(--text-secondary);margin:0 0 4px;line-height:1.5">' + routeDesc + '</p>' +
      '</div>' +
      routeActions;

    var overlay = document.getElementById('welcomeOverlay');
    if (overlay) overlay.style.display = 'flex';
  } catch(e) {
    console.error('[welcome]', e);
  }
}

function optionCard(icon, title, desc, color) {
  return '<div style="padding:12px;border:1px solid var(--border-color);border-radius:10px;margin-bottom:8px;display:flex;align-items:center;gap:12px;cursor:pointer;transition:border-color .15s" onmouseenter="this.style.borderColor=\'' + color + '\'" onmouseleave="this.style.borderColor=\'var(--border-color)\'">' +
    '<div style="width:36px;height:36px;border-radius:10px;background:' + color + '15;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:' + color + '">' + iconSvg(icon, 16) + '</div>' +
    '<div><div style="font-size:.85em;font-weight:600;color:var(--text-primary)">' + title + '</div><div style="font-size:.75em;color:var(--text-secondary)">' + desc + '</div></div>' +
    '</div>';
}

function featureItem(icon, title, desc) {
  return '<div style="padding:10px 12px;border:1px solid var(--border-color);border-radius:10px;margin-bottom:6px;display:flex;align-items:center;gap:10px">' +
    '<span style="color:var(--text-muted);flex-shrink:0">' + iconSvg(icon, 14) + '</span>' +
    '<div><div style="font-size:.84em;font-weight:500;color:var(--text-primary)">' + title + '</div><div style="font-size:.74em;color:var(--text-muted)">' + desc + '</div></div>' +
    '</div>';
}

function iconCircleSvg(icon, size) {
  // 用圆形背景包裹图标
  var gradient = icon === 'welcome' ? 'linear-gradient(135deg,#534AB7,#A78BFA)' :
                 icon === 'chat' ? 'linear-gradient(135deg,#1E3A5F,#3270B0)' :
                 'linear-gradient(135deg,#534AB7,#3DA89E)';
  return '<div style="width:56px;height:56px;border-radius:28px;background:' + gradient + ';display:inline-flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(83,74,183,.25)">' +
    iconSvg(icon, size) + '</div>';
}

function dismissWelcome() {
  var overlay = document.getElementById('welcomeOverlay');
  if (overlay) overlay.style.display = 'none';
  localStorage.setItem('sidemate_welcomed', '1');
  fetch('/api/onboard/complete', {method: 'POST'}).catch(function(){});
}

window.showWelcome = showWelcome;
window.dismissWelcome = dismissWelcome;


// ── 阶段2: 交互式步骤引导 ─────────────────────────────────
var _tourStep = 0;
var _tourLastTab = '';
var _tourSteps = [
  { id: 'modes',    tab: 'chat', targetSel: '#chatMode',           title: '三种 AI 模式',         desc: '<b>离线</b> — 纯本地模型，无需联网<br><b>在线</b> — 云端大模型，需配 API Key<br><b>并行</b> — 本地 KB + 云端融合<br><br>在线/并行需在设置 → 云端 AI 中填写 API Key', pos: 'bottom' },
  { id: 'input',    tab: 'chat', targetSel: '#msgInput',           title: '开始对话',             desc: '在这里输入问题，按 <b>Enter</b> 发送。<br>支持上传文件和引用知识库文档。<br>上方 <b>Token 用量条</b> 显示剩余可用长度。', pos: 'top' },
  { id: 'offline',  tab: 'chat', targetSel: '#chatMode',           title: '离线模式',             desc: '位于离线模式时，你可以：<br>• 自由聊天提问<br>• 编写代码和文档<br>• 在对话中引用知识库文档<br><br><b>所有数据不出本机</b>，无需网络。', pos: 'bottom' },
  { id: 'online',   tab: 'chat', targetSel: '#chatMode',           title: '在线模式',             desc: '切换到在线模式后，支持：<br>• 联网搜索<br>• Agent 多步推理<br>• 调用 82 种云端大模型<br><br>需先在 <b>设置 → 云端 AI</b> 配置 API Key。', pos: 'bottom' },
  { id: 'parallel', tab: 'chat', targetSel: '#chatMode',           title: '并行模式',             desc: '本地检索知识库 + 云端补充通用知识<br>各自独立回答，本地自动融合。<br><br><b>知识库原文永不离开本机</b><br>云端只看到本地生成的摘要。', pos: 'bottom' },
  { id: 'kb',       tab: 'qa',   targetSel: '#kbAIOverview',       title: '知识库',               desc: '上传文档 → AI 自动打标分类<br>点击 <b>「整理」</b> 触发 AI 洞察分析<br><br>左侧侧栏可筛选分类<br>选中文档后可设为私密或批量操作', pos: 'bottom' },
  { id: 'recap',    tab: 'chat', targetSel: '.tabs-nav button[data-tab="settings"]', title: '设置入口',   desc: '需要配置云端 API Key？<br>需要安装扩展包或管理模型？<br><br>在 <b>设置 Tab</b> 中搞定一切。<br><br>这就是桌伴的全部功能，开始使用吧！', pos: 'bottom' }
];

function startTour() {
  _tourStep = 0;
  _tourLastTab = '';
  // 强制切到 Chat Tab（兼容从设置页"重新查看"触发）
  if (typeof switchTab === 'function') {
    var btn = document.querySelector('.tabs-nav button[data-tab="chat"], .tabs-nav-inline button[data-tab="chat"]');
    if (btn) { switchTab('chat', btn); _tourLastTab = 'chat'; }
  }
  // 先显示遮罩，再等 Chat Tab 渲染完成
  document.getElementById('tourOverlay').style.display = 'block';
  document.getElementById('tourCard').style.display = 'block';
  var tries = 0;
  var waitForChat = function() {
    var target = document.querySelector('#chatMode');
    if (target && target.offsetWidth > 0) {
      renderTourStep();
      return;
    }
    if (++tries > 20) { renderTourStep(); return; }  // 1s 超时兜底
    setTimeout(waitForChat, 50);
  };
  waitForChat();
}

function renderTourStep() {
  var step = _tourSteps[_tourStep];
  if (!step) return;
  var isLast = _tourStep >= _tourSteps.length - 1;

  // 自动切换 Tab
  if (step.tab && step.tab !== _tourLastTab && typeof switchTab === 'function') {
    var btn = document.querySelector('.tabs-nav button[data-tab="' + step.tab + '"], .tabs-nav-inline button[data-tab="' + step.tab + '"]');
    if (btn) { switchTab(step.tab, btn); _tourLastTab = step.tab; }
  }

  // 等 Tab 切换完成后再定位
  var doPosition = function() {
    var s = _tourSteps[_tourStep];
    document.getElementById('tourCardTitle').innerHTML = s.title;
    document.getElementById('tourCardDesc').innerHTML = s.desc;
    document.getElementById('tourNextBtn').textContent = isLast ? '完成' : '下一步';

    var dotsHtml = '';
    for (var i = 0; i < _tourSteps.length; i++) {
      dotsHtml += '<span style="width:6px;height:6px;border-radius:3px;background:' + (i === _tourStep ? 'var(--accent-color)' : 'var(--border-color)') + '"></span>';
    }
    document.getElementById('tourDots').innerHTML = dotsHtml;

    var target = findTourTarget(s);
    positionTourElements(target, s.pos);
  };

  if (step.tab === 'qa') {
    setTimeout(doPosition, 400);
  } else {
    setTimeout(doPosition, 150);
  }
}

function findTourTarget(step) {
  var el = document.querySelector(step.targetSel);
  if (el && isVisible(el)) return el;
  return null;
}

function isVisible(el) {
  return el.offsetWidth > 0 && el.offsetHeight > 0;
}

function positionTourElements(target, pos) {
  var spotlight = document.getElementById('tourSpotlight');
  var card = document.getElementById('tourCard');
  if (!spotlight || !card) return;
  var viewW = window.innerWidth || 800, viewH = window.innerHeight || 600;

  var tx, ty, tw, th, tRadius = '6px';

  if (target && target.getBoundingClientRect) {
    var rect = target.getBoundingClientRect();
    var pad = 4;
    tx = Math.round(rect.left - pad);
    ty = Math.round(rect.top - pad);
    tw = Math.round(rect.width + pad * 2);
    th = Math.round(rect.height + pad * 2);
    var cs = window.getComputedStyle(target);
    var br = cs.borderRadius;
    if (br && br !== '0px') tRadius = br;
  } else {
    // 兜底：目标元素不可见时，居中显示卡片不显示高亮
    tx = viewW / 2 - 80; ty = viewH / 3;
    tw = 160; th = 40;
  }

  // 用 clip-path 替代 box-shadow 做镂空遮罩，避免 overflow:hidden 裁剪
  var cpx = tx + tw / 2, cpy = ty + th / 2;
  var hw = tw / 2 + 4, hh = th / 2 + 4;
  var r = Math.max(6, parseInt(tRadius) || 6);
  // 圆角矩形镂空路径
  spotlight.style.clipPath =
    'path(evenodd, M0 0 H' + viewW + ' V' + viewH + ' H0 Z ' +
    'M' + (cpx - hw + r) + ' ' + (cpy - hh) + ' ' +
    'H' + (cpx + hw - r) + ' ' +
    'Q' + (cpx + hw) + ' ' + (cpy - hh) + ' ' + (cpx + hw) + ' ' + (cpy - hh + r) + ' ' +
    'V' + (cpy + hh - r) + ' ' +
    'Q' + (cpx + hw) + ' ' + (cpy + hh) + ' ' + (cpx + hw - r) + ' ' + (cpy + hh) + ' ' +
    'H' + (cpx - hw + r) + ' ' +
    'Q' + (cpx - hw) + ' ' + (cpy + hh) + ' ' + (cpx - hw) + ' ' + (cpy + hh - r) + ' ' +
    'V' + (cpy - hh + r) + ' ' +
    'Q' + (cpx - hw) + ' ' + (cpy - hh) + ' ' + (cpx - hw + r) + ' ' + (cpy - hh) + ' Z)';
  spotlight.style.borderRadius = '0';
  spotlight.style.left = '0';
  spotlight.style.top = '0';
  spotlight.style.width = viewW + 'px';
  spotlight.style.height = viewH + 'px';
  spotlight.style.background = 'rgba(0,0,0,0.45)';

  // 定位说明卡片
  var cardW = 280, cardH = 140;
  var cx, cy;
  if (pos === 'bottom') {
    cx = Math.max(16, Math.min(viewW - cardW - 16, tx + tw / 2 - cardW / 2));
    cy = ty + th + 12;
  } else if (pos === 'top') {
    cx = Math.max(16, Math.min(viewW - cardW - 16, tx + tw / 2 - cardW / 2));
    cy = ty - cardH - 12;
    if (cy < 8) { cy = ty + th + 12; pos = 'bottom'; }
  } else {
    cx = tx + tw + 12;
    cy = ty;
    if (cx + cardW > viewW - 8) cx = tx - cardW - 12;
  }

  card.style.left = Math.round(cx) + 'px';
  card.style.top = Math.round(cy) + 'px';

  if (pos === 'top') {
    card.style.setProperty('--tour-arrow-top', 'auto');
    card.style.setProperty('--tour-arrow-bottom', '-6px');
  } else {
    card.style.setProperty('--tour-arrow-top', '-6px');
    card.style.setProperty('--tour-arrow-bottom', 'auto');
  }
}

function nextTourStep() {
  _tourStep++;
  if (_tourStep >= _tourSteps.length) {
    endTour();
    return;
  }
  renderTourStep();
}

function endTour() {
  document.getElementById('tourOverlay').style.display = 'none';
  document.getElementById('tourCard').style.display = 'none';
  localStorage.setItem('sidemate_toured', '1');
}

function resetOnboarding() {
  localStorage.removeItem('sidemate_welcomed');
  localStorage.removeItem('sidemate_toured');
  endTour();
  showWelcome();
}

window.startTour = startTour;
window.nextTourStep = nextTourStep;
window.endTour = endTour;
window.resetOnboarding = resetOnboarding;


// ── Debug 快捷键 ─────────────────────────────────────────
window.addEventListener('keydown', function(e) {
  if (e.ctrlKey && e.shiftKey && e.key === 'O') {
    e.preventDefault();
    localStorage.removeItem('sidemate_welcomed');
    localStorage.removeItem('sidemate_toured');
    location.reload();
  }
});

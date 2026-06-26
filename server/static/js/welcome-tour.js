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
var _tourSteps = [
  {
    targetSel: '#chatMode',
    fallbackAnchor: {top: 8, left: '50%', offsetX: -60},
    title: 'AI 模式切换',
    desc: '顶栏可切换三种模式：<br><b>离线</b> — 纯本地，隐私安全<br><b>在线</b> — 云端大模型<br><b>并行</b> — 本地+云端融合回答',
    pos: 'bottom'
  },
  {
    targetSel: '#msgInput',
    title: '开始对话',
    desc: '在这里输入你的问题，按 <b>Enter</b> 发送。<br>支持上传文件和引用知识库文档。',
    pos: 'top'
  },
  {
    targetSel: '.tabs-nav button[data-tab="qa"]',
    fallbackAnchor: {top: 45, left: 140, offsetX: 0},
    title: '知识库',
    desc: '上传你的文档资料，AI 自动打标分类并生成洞察分析。支持批量操作和私密管理。',
    pos: 'bottom'
  },
  {
    targetSel: '.tabs-nav button[data-tab="settings"]',
    fallbackAnchor: {top: 45, left: 220, offsetX: 0},
    title: '设置',
    desc: '管理模型、配置云端 API、查看系统资源。需要在哪切换 AI 模式或安装扩展包？都在这里。',
    pos: 'bottom'
  }
];

function startTour() {
  _tourStep = 0;
  document.getElementById('tourOverlay').style.display = 'block';
  document.getElementById('tourCard').style.display = 'block';
  renderTourStep();
}

function renderTourStep() {
  var step = _tourSteps[_tourStep];
  if (!step) return;
  var isLast = _tourStep >= _tourSteps.length - 1;

  // 更新卡片内容
  document.getElementById('tourCardTitle').innerHTML = step.title;
  document.getElementById('tourCardDesc').innerHTML = step.desc;
  document.getElementById('tourNextBtn').textContent = isLast ? '完成' : '下一步';

  // 更新圆点
  var dotsHtml = '';
  for (var i = 0; i < _tourSteps.length; i++) {
    dotsHtml += '<span style="width:6px;height:6px;border-radius:3px;background:' + (i === _tourStep ? 'var(--accent-color)' : 'var(--border-color)') + '"></span>';
  }
  document.getElementById('tourDots').innerHTML = dotsHtml;

  // 定位高亮
  var target = findTourTarget(step);
  positionTourElements(target, step.pos);
}

function findTourTarget(step) {
  // 尝试找到目标元素
  var el = document.querySelector(step.targetSel);
  if (el && isVisible(el)) return el;
  // fallback: 用固定坐标
  if (step.fallbackAnchor) return null;
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

  var tx, ty, tw, th;

  if (target && target.getBoundingClientRect) {
    var rect = target.getBoundingClientRect();
    tx = rect.left - 4; ty = rect.top - 4;
    tw = rect.width + 8; th = rect.height + 8;
  } else {
    // fallback: 使用步骤中的固定锚点
    var fb = _tourSteps[_tourStep] && _tourSteps[_tourStep].fallbackAnchor;
    if (!fb) return;
    tw = 160; th = 40;
    tx = fb.left === '50%' ? viewW / 2 + fb.offsetX : fb.left;
    ty = fb.top;
  }

  spotlight.style.left = tx + 'px';
  spotlight.style.top = ty + 'px';
  spotlight.style.width = tw + 'px';
  spotlight.style.height = th + 'px';

  // 定位说明卡片
  var cardW = 280, cardH = 140;
  var cx, cy;
  if (pos === 'bottom') {
    cx = Math.max(16, Math.min(viewW - cardW - 16, tx + tw / 2 - cardW / 2));
    cy = ty + th + 12;
  } else if (pos === 'top') {
    cx = Math.max(16, Math.min(viewW - cardW - 16, tx + tw / 2 - cardW / 2));
    cy = ty - cardH - 12;
    if (cy < 8) cy = ty + th + 12;  // 空间不够就放下面
  } else {
    cx = tx + tw + 12;
    cy = ty;
    if (cx + cardW > viewW - 8) cx = tx - cardW - 12;
  }

  card.style.left = cx + 'px';
  card.style.top = cy + 'px';
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

window.startTour = startTour;
window.nextTourStep = nextTourStep;
window.endTour = endTour;


// ── Debug 快捷键 ─────────────────────────────────────────
window.addEventListener('keydown', function(e) {
  if (e.ctrlKey && e.shiftKey && e.key === 'O') {
    e.preventDefault();
    localStorage.removeItem('sidemate_welcomed');
    localStorage.removeItem('sidemate_toured');
    location.reload();
  }
});

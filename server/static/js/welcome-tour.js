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
  { id: 'modes',    tab: 'chat', targetSel: '#chatMode',           title: '三种 AI 模式',         desc: '<b>离线</b> — 本地模型，数据不出本机，无需联网<br><b>在线</b> — 云端大模型，联网搜索 + Agent 推理<br><b>并行</b> — 本地知识库 + 云端融合回答<br><br>在线 / 并行需先在设置配置 API Key', pos: 'bottom' },
  { id: 'input',    tab: 'chat', targetSel: '#msgInput',           title: '开始对话',             desc: '输入问题，按 <b>Enter</b> 发送。<br><br>不仅能聊天，还能让 AI 直接生成 Word 文档、引用知识库回答、上传文件辅助提问。<br>顶部 Token 条显示剩余可用长度。', pos: 'top' },
  { id: 'kb1',      tab: 'qa',   targetSel: '#kbToolbar button',   title: '上传你的文档',         desc: '上传文档后，<b>本地 AI</b> 会自动通读全文，<br>生成摘要、打上标签并归类——<br>全程在本机完成，<b>文档内容绝不外传</b>。', pos: 'bottom' },
  { id: 'kb2',      tab: 'qa',   targetSel: '#kbAIOverview .s-hdr', title: 'AI 洞察',             desc: '点击 <b>「整理」</b>，<b>本地 AI</b> 会通读你的整个文库，<br>给出主题归类、适用场景和建议追问。<br><br>同样全部在本机运行，<b>数据不出本机</b>。', pos: 'bottom' },
  { id: 'recap',    tab: 'chat', targetSel: '.tabs-nav button[onclick*="settings"]', title: '设置入口',   desc: '配置云端 API Key、安装扩展包、管理本地模型……<br>都在设置 Tab 里完成。<br><br>这就是桌伴的全部，开始使用吧！', pos: 'bottom' }
];

// 修复：tab 按钮实际用 onclick="switchTab('chat',this)"，没有 data-tab 属性。
// 旧的 [data-tab="chat"] 选择器永远匹配不到 → switchTab 不触发 → 无法切 tab。
// 这里用 onclick 内容匹配，兼容所有 tab。
function _tourFindTabBtn(tabName) {
  // 优先匹配 onclick 里的 switchTab('xxx',...)
  var btn = document.querySelector('.tabs-nav button[onclick*="switchTab(\'' + tabName + '\'"]');
  if (btn) return btn;
  // 兜底：按文本匹配
  var btns = document.querySelectorAll('.tabs-nav button');
  var labelMap = { chat: '对话', qa: '知识库', settings: '设置' };
  var label = labelMap[tabName];
  if (label) {
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].textContent.trim() === label) return btns[i];
    }
  }
  return null;
}

function startTour() {
  _tourStep = 0;
  // 强制切到 Chat Tab（兼容从设置页"重新查看"触发）
  if (typeof switchTab === 'function') {
    var btn = _tourFindTabBtn('chat');
    if (btn) { switchTab('chat', btn); }
  }
  _tourLastTab = 'chat';  // 标记已切到 chat，避免 renderTourStep 重复切
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

  // 自动切换 Tab（修复：用 _tourFindTabBtn 替代失效的 [data-tab] 选择器）
  if (step.tab && step.tab !== _tourLastTab && typeof switchTab === 'function') {
    var btn = _tourFindTabBtn(step.tab);
    if (btn) { switchTab(step.tab, btn); _tourLastTab = step.tab; }
  }

  // 等 Tab 切换完成后再定位
  var doPosition = function() {
    var s = _tourSteps[_tourStep];
    document.getElementById('tourCardTitle').innerHTML = s.title;
    document.getElementById('tourCardDesc').innerHTML = s.desc;
    document.getElementById('tourNextBtn').textContent = isLast ? '完成' : '下一步';
    // 上一步按钮：第一步隐藏
    var prevBtn = document.getElementById('tourPrevBtn');
    if (prevBtn) prevBtn.style.visibility = (_tourStep === 0) ? 'hidden' : 'visible';

    var dotsHtml = '';
    for (var i = 0; i < _tourSteps.length; i++) {
      dotsHtml += '<span style="width:6px;height:6px;border-radius:3px;background:' + (i === _tourStep ? 'var(--accent-color)' : 'var(--border-color)') + '"></span>';
    }
    document.getElementById('tourDots').innerHTML = dotsHtml;

    var target = findTourTarget(s);
    // KB 等可滚动 tab：目标可能在滚动容器视口外（getBoundingClientRect 的 top 很大或为负），
    // 先 scrollIntoView 让它进入视口，再定位（否则卡片会落到视口外/错误位置）。
    if (target) {
      var _r = target.getBoundingClientRect();
      var _inViewport = (_r.top >= 0 && _r.bottom <= (window.innerHeight || 600));
      if (!_inViewport) {
        target.scrollIntoView({ block: 'center', behavior: 'instant' });
        // scrollIntoView 是同步的，但布局重算放下一帧更稳
        requestAnimationFrame(function() {
          positionTourElements(findTourTarget(s), s.pos);
        });
        return;
      }
    }
    positionTourElements(target, s.pos);
  };

  // 切 tab 后目标可能需要异步渲染才可见（如 qa tab 的 kbRouteState 要 fetch 后才显示
  // kbFullInterface），固定延时不可靠 → 轮询等待目标真正可见再定位。
  // 静态 tab（chat）首次轮询即命中，行为不变；最多等 ~2s，超时走兜底定位。
  var _waitTries = 0;
  var _waitTarget = function() {
    if (findTourTarget(_tourSteps[_tourStep]) || ++_waitTries > 24) {
      doPosition();
      return;
    }
    setTimeout(_waitTarget, 80);
  };
  setTimeout(_waitTarget, 80);
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

  var tx, ty, tw, th, tRadius = 6;

  if (target && target.getBoundingClientRect && isVisible(target)) {
    var rect = target.getBoundingClientRect();
    var pad = 4;
    tx = Math.round(rect.left - pad);
    ty = Math.round(rect.top - pad);
    tw = Math.round(rect.width + pad * 2);
    th = Math.round(rect.height + pad * 2);
    var cs = window.getComputedStyle(target);
    var br = cs.borderRadius;
    if (br && br !== '0px') {
      // 解析圆角数值（如 "6px" → 6），忽略百分比（用默认）
      var _brNum = parseInt(br, 10);
      if (!isNaN(_brNum)) tRadius = _brNum;
    }
  } else {
    // 兜底：目标不可见 → 整屏纯遮罩 + 卡片居中。
    // 用显式 width/height（而非依赖 inset 隐式铺满），确保半透明遮罩一定铺满视口。
    spotlight.style.clipPath = 'none';
    spotlight.style.inset = 'auto';
    spotlight.style.left = '0';
    spotlight.style.top = '0';
    spotlight.style.width = viewW + 'px';
    spotlight.style.height = viewH + 'px';
    spotlight.style.boxShadow = 'none';
    spotlight.style.borderRadius = '0';
    spotlight.style.background = 'rgba(0,0,0,0.45)';
    var cardW = 280, cardH = 140;
    card.style.left = Math.round(Math.max(16, viewW / 2 - cardW / 2)) + 'px';
    card.style.top = Math.round(Math.max(16, viewH / 2 - cardH / 2)) + 'px';
    card.style.setProperty('--tour-arrow-top', 'auto');
    card.style.setProperty('--tour-arrow-bottom', 'auto');
    return;
  }

  // 镂空遮罩：spotlight 是盖在目标上的小方块，box-shadow 向四周扩散 9999px 形成半透明遮罩，
  // 中间天然镂空（露出目标）。比 clip-path: path() 更可靠——后者不支持 evenodd 填充规则参数，
  // path(evenodd, ...) 是无效语法，导致整屏纯暗色无镂空。
  // spotlight 在独立的 #tourOverlay 层（position:fixed/absolute，不在 overflow:hidden 容器内），
  // 不受 tabs-nav 等 overflow:hidden 裁剪影响。
  spotlight.style.clipPath = 'none';
  spotlight.style.inset = 'auto';  // 清除原 inset:0（否则会覆盖 left/top）
  spotlight.style.left = tx + 'px';
  spotlight.style.top = ty + 'px';
  spotlight.style.width = tw + 'px';
  spotlight.style.height = th + 'px';
  spotlight.style.borderRadius = tRadius + 'px';
  spotlight.style.background = 'transparent';
  spotlight.style.boxShadow = '0 0 0 9999px rgba(0,0,0,0.45)';

  // 定位说明卡片
  var cardW = 280, cardH = 140;
  var cx, cy;
  if (pos === 'bottom') {
    cx = Math.max(16, Math.min(viewW - cardW - 16, tx + tw / 2 - cardW / 2));
    cy = ty + th + 12;
    // 卡片底部超出视口 → 改放到目标上方
    if (cy + cardH > viewH - 8 && ty - cardH - 12 >= 8) {
      cy = ty - cardH - 12; pos = 'top';
    }
  } else if (pos === 'top') {
    cx = Math.max(16, Math.min(viewW - cardW - 16, tx + tw / 2 - cardW / 2));
    cy = ty - cardH - 12;
    if (cy < 8) { cy = ty + th + 12; pos = 'bottom'; }
  } else {
    cx = tx + tw + 12;
    cy = ty;
    if (cx + cardW > viewW - 8) cx = tx - cardW - 12;
  }

  // 最终兜底：卡片必须落在视口内（无论目标多大/在哪），否则会"掉出页面"。
  // 卡片高度可能因文案长短变化，用实际测量值更准。
  cx = Math.max(8, Math.min(viewW - cardW - 8, cx));
  cy = Math.max(8, Math.min(viewH - cardH - 8, cy));

  card.style.left = Math.round(cx) + 'px';
  card.style.top = Math.round(cy) + 'px';

  // 箭头水平位置：指向目标中心，而非固定卡片中心（修复"指针位置偏差"）。
  // 旧代码箭头恒在 left:50%（卡片中心），当卡片被屏幕边缘推开时，箭头就指偏了。
  var targetCenterX = tx + tw / 2;
  var arrowX = targetCenterX - cx;  // 相对卡片左边的偏移
  // clamp 到卡片内 [8, cardW-8]，避免箭头跑到卡片外
  arrowX = Math.max(8, Math.min(cardW - 8, arrowX));
  card.style.setProperty('--tour-arrow-x', arrowX + 'px');

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

function prevTourStep() {
  if (_tourStep > 0) {
    _tourStep--;
    renderTourStep();
  }
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
window.prevTourStep = prevTourStep;
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

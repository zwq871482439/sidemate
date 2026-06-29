// ===== chat-actions.js — Action 模式管理 =====
// 依赖: /api/action/list, 全局变量 currentActionMode

// 缓存上一次的 action 列表 + 模式，避免无变化时重渲染
var _lastActionIds = '';
var _lastActionMode = '';

// 提示词按钮选中状态管理（通用：在线快捷词 + 离线做总结）
var _promptActiveBtn = null;    // 当前选中的提示词按钮
var _promptBackupText = '';     // 填入提示词前的原文备份
var _promptSuppressSync = false; // 防止 togglePromptChip 触发的 input 事件误清除选中

// 用户手动编辑输入框时调用：若内容不再是提示词，取消按钮选中但保留用户输入
function _syncPromptChip() {
  if (_promptSuppressSync || !_promptActiveBtn) return;
  var input = document.getElementById('msgInput');
  if (!input) return;
  var expected = _promptActiveBtn.getAttribute('data-prompt');
  if (input.value !== expected) {
    _promptActiveBtn.classList.remove('active');
    _promptActiveBtn = null;
    _promptBackupText = '';
  }
}
window._syncPromptChip = _syncPromptChip;

// 点击提示词按钮：选中填词 / 再点取消还原 / 点别的切换
function togglePromptChip(btn, promptText) {
  var input = document.getElementById('msgInput');
  if (!input) return;
  _promptSuppressSync = true;  // 抑制接下来的 input 事件

  if (_promptActiveBtn === btn) {
    // 再点同一个 → 取消选中，还原原文
    btn.classList.remove('active');
    input.value = _promptBackupText;
    input.dispatchEvent(new Event('input'));
    _promptActiveBtn = null;
    _promptBackupText = '';
  } else {
    // 取消之前选中的
    if (_promptActiveBtn) _promptActiveBtn.classList.remove('active');
    // 备份当前内容（除非当前内容正是上次填的提示词）
    if (!(_promptActiveBtn && input.value === _promptActiveBtn.getAttribute('data-prompt'))) {
      _promptBackupText = input.value;
    }
    // 选中并填入
    btn.classList.add('active');
    btn.setAttribute('data-prompt', promptText);
    input.value = promptText;
    input.dispatchEvent(new Event('input'));
    input.focus();
    var len = input.value.length;
    input.setSelectionRange(len, len);
    _promptActiveBtn = btn;
  }
  // 延迟解除抑制（等 dispatchEvent 的 input 事件处理完）
  setTimeout(function() { _promptSuppressSync = false; }, 0);
}
window.togglePromptChip = togglePromptChip;

async function refreshActionBar() {
  try {
    var _apiBase = (typeof API !== 'undefined' ? API : '');
    var curMode = (typeof _currentMode !== 'undefined') ? _currentMode : 'local';

    // P6 审计修复 M3：缓存 key 必须包含 mode，否则切换后不重渲染
    var _modeKey = curMode || 'local';
    if (_lastActionMode !== _modeKey) {
      _lastActionIds = '';  // 强制刷新
      _lastActionMode = _modeKey;
    }

    // ===== 在线模式：快捷提示词按钮（agent 自动判断，按钮只填引导词）=====
    if (curMode === 'cloud') {
      var cacheKey = 'cloud|prompts';
      if (cacheKey === _lastActionIds) return;
      _lastActionIds = cacheKey;

      var bar = document.getElementById('actionBar');
      if (!bar) return;
      bar.innerHTML = '';

      currentActionMode = 'agent';

      // 快捷提示词：点击填入引导词，agent 模式不变
      var cloudPrompts = [
        { label: '联网搜索', tip: '请联网搜索以下主题的最新信息，总结关键要点：', icon: 'search' },
        { label: '写文档', tip: '请帮我撰写一份专业的 Word 文档，主题和要求如下：', icon: 'write' },
        { label: '可视化报告', tip: '请帮我制作一份图文并茂的可视化报告（含流程图/架构图等图表），主题如下：', icon: 'chart' },
        { label: '写PPT', tip: '请帮我制作一份专业的演示文稿，要求信息充实、排版美观、善用图表和卡片展示，主题如下：', icon: 'slides' },
        { label: '深度分析', tip: '请对以下内容进行深度分析，给出洞察、建议和行动方案：', icon: 'brain' }
      ];
      cloudPrompts.forEach(function(p) {
        var btn = document.createElement('button');
        btn.className = 'action-btn';
        btn.title = p.tip;
        btn.innerHTML = iconSvg(p.icon, '11') + ' ' + p.label;
        var tipText = p.tip;
        btn.onclick = function() { togglePromptChip(this, tipText); };
        bar.appendChild(btn);
      });

      // 更新输入框 placeholder
      var input = document.getElementById('msgInput');
      if (input) {
        input.placeholder = '问任何问题，或描述要生成的文档，AI 会自动处理...';
      }
      // 在线模式支持上传，确保附件按钮显示
      var _attachWrapCloud = document.querySelector('.attach-wrap');
      if (_attachWrapCloud) _attachWrapCloud.style.display = '';
      return;
    }

    // ===== P6 打磨 #4：并行模式 — 仅知识库问答 =====
    if (curMode === 'parallel') {
      var cacheKey2 = 'parallel|kb_qa';
      if (cacheKey2 === _lastActionIds) return;
      _lastActionIds = cacheKey2;

      var bar2 = document.getElementById('actionBar');
      if (!bar2) return;
      bar2.innerHTML = '';

      if (typeof currentActionMode !== 'undefined' && currentActionMode !== 'kb_qa') {
        currentActionMode = 'kb_qa';
      }

      var kbBtn = document.createElement('button');
      kbBtn.className = 'action-btn active';
      kbBtn.setAttribute('data-action', 'kb_qa');
      kbBtn.title = '知识库问答 — 本地模型检索知识库，结合云端 AI 综合回答';
      kbBtn.innerHTML = iconSvg('books', '14') + ' 知识库问答';
      kbBtn.onclick = function() { setActionMode('kb_qa', this); };
      bar2.appendChild(kbBtn);

      // 追加内联开关（云端辅助生成关键词）
      if (typeof _renderGearMenu === 'function') _renderGearMenu(bar2);

      // 并行模式不支持文件上传，隐藏附件按钮
      var _attachWrap = document.querySelector('.attach-wrap');
      if (_attachWrap) _attachWrap.style.display = 'none';
      return;
    }

    // ===== 本地模式：从后端获取 action 列表 =====
    var resp = await fetch(_apiBase + '/api/action/list');
    var data = await resp.json();
    var actions = data.actions || [];

    // P6 打磨 #2：补充知识库问答按钮（离线模式专属）
    actions.push({
      id: 'kb_qa',
      label: '知识库问答',
      title: '知识库问答 — 检索你的本地知识库，基于文档内容回答问题',
      icon_svg: iconSvg('books', '14')
    });

    // 缓存 key
    var ids = actions.map(function(a) { return a.id; }).sort().join(',');
    var cacheKey = ids + '|local|summary';
    if (cacheKey === _lastActionIds && _lastActionMode === curMode) return;
    _lastActionIds = cacheKey;
    _lastActionMode = curMode;

    var bar = document.getElementById('actionBar');
    if (!bar) return;
    bar.innerHTML = '';

    // 离线模式支持上传，确保附件按钮显示
    var _attachWrapLocal = document.querySelector('.attach-wrap');
    if (_attachWrapLocal) _attachWrapLocal.style.display = '';

    // 当前激活的 mode 如果不在最终按钮列表中，回退到 chat
    var validIds = actions.map(function(a) { return a.id; });
    if (typeof currentActionMode !== 'undefined' && validIds.indexOf(currentActionMode) === -1) {
      currentActionMode = 'chat';
    }

    actions.forEach(function(a) {
      var btn = document.createElement('button');
      btn.className = 'action-btn' + (currentActionMode === a.id ? ' active' : '');
      btn.setAttribute('data-action', a.id);
      btn.title = a.title || a.label || a.id;
      btn.onclick = function() { setActionMode(a.id, this); };
      var icon = a.icon_svg || (a.icon || '');
      var text = a.label || a.id;
      btn.innerHTML = icon + ' ' + text;
      bar.appendChild(btn);
    });

    // cacheKey 去掉 summary 后缀（不再追加做总结按钮）
    _lastActionIds = ids + '|local';

  } catch(e) {
    console.error('[chat.refreshActionBar]', e);
  }
}

async function setActionMode(mode, btn) {
  if (typeof generating !== 'undefined' && generating) return;
  
  // 清空文件引用状态（切换 Action 时总是清理）
  if (typeof clearFileRef === 'function') clearFileRef();
  if (typeof hideFileIndicator === 'function') hideFileIndicator();
  if (typeof clearPendingFile === 'function') clearPendingFile();

  // Action 模式是纯客户端状态：随每条 /api/chat/stream 请求以 action_mode 字段下发，
  // 无需单独的后端切换调用。旧的 POST /api/action/switch 无对应路由（命中 DELETE
  // /api/action/{action_id} 的路径 → 405 Method Not Allowed），属死代码，已移除。
  currentActionMode = mode;

  // 更新 UI 高亮
  document.querySelectorAll('.action-btn').forEach(function(b) {
    b.classList.remove('active');
    if (b.getAttribute('data-action') === mode) b.classList.add('active');
  });

  // 更新输入框 placeholder
  var input = document.getElementById('msgInput');
  if (input) {
    var placeholders = {
      chat: '说点什么...',
      agent: '问任何问题，AI 会自动搜索、阅读、回答...',
      doc: '描述要生成的文档...',
      research: '输入研究主题或问题...'
    };
    input.placeholder = placeholders[mode] || '输入内容...';
  }
}

window._lastActionIds = _lastActionIds;
window.refreshActionBar = refreshActionBar;
window.setActionMode = setActionMode;

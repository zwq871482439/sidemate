// ===== chat-actions.js — Action 模式管理 =====
// 依赖: /api/action/list, 全局变量 currentActionMode

// 缓存上一次的 action 列表 + 模式，避免无变化时重渲染
var _lastActionIds = '';
var _lastActionMode = '';

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

    // ===== 在线模式：硬编码 2 个按钮 =====
    if (curMode === 'cloud') {
      var cacheKey = 'cloud|agent|doc';
      if (cacheKey === _lastActionIds) return;
      _lastActionIds = cacheKey;

      var bar = document.getElementById('actionBar');
      if (!bar) return;
      bar.innerHTML = '';

      // 如果当前激活的 mode 不在在线按钮列表中，回退到 agent
      var validCloudIds = ['agent', 'chat', 'doc'];
      if (typeof currentActionMode !== 'undefined' && validCloudIds.indexOf(currentActionMode) === -1) {
        currentActionMode = 'agent';
      }

      // 智能对话按钮
      var agentBtn = document.createElement('button');
      agentBtn.className = 'action-btn' + (currentActionMode === 'agent' || currentActionMode === 'chat' ? ' active' : '');
      agentBtn.setAttribute('data-action', 'agent');
      agentBtn.title = '智能对话 — AI 自动搜索、阅读、回答';
      agentBtn.onclick = function() { setActionMode('agent', this); };
      var agentSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
      agentBtn.innerHTML = agentSvg + ' 智能对话';
      bar.appendChild(agentBtn);

      // 智能文档按钮
      var docBtn = document.createElement('button');
      docBtn.className = 'action-btn' + (currentActionMode === 'doc' ? ' active' : '');
      docBtn.setAttribute('data-action', 'doc');
      docBtn.title = '智能文档 — AI 自主搜索资料、规划大纲、撰写深度文档';
      docBtn.onclick = function() { setActionMode('doc', this); };
      var docSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
      docBtn.innerHTML = docSvg + ' 智能文档';
      bar.appendChild(docBtn);

      // 更新输入框 placeholder
      var input = document.getElementById('msgInput');
      if (input) {
        if (currentActionMode === 'doc') {
          input.placeholder = '描述要生成的文档，AI 会搜索资料并深度撰写...';
        } else {
          input.placeholder = '问任何问题，AI 会自动搜索、阅读、回答...';
        }
      }
      return;
    }

    // ===== 本地模式：从后端获取 action 列表 =====
    var resp = await fetch(_apiBase + '/api/action/list');
    var data = await resp.json();
    var actions = data.actions || [];

    // 缓存 key
    var ids = actions.map(function(a) { return a.id; }).sort().join(',');
    var cacheKey = ids + '|local';
    if (cacheKey === _lastActionIds && _lastActionMode === curMode) return;
    _lastActionIds = cacheKey;
    _lastActionMode = curMode;

    var bar = document.getElementById('actionBar');
    if (!bar) return;
    bar.innerHTML = '';

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

    // P6 T04: 并行模式下追加齿轮按钮
    if (curMode === 'parallel' && typeof _renderGearMenu === 'function') {
      _renderGearMenu(bar);
    }
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

  // 在线模式 agent 映射到 chat（后端 action_mode）
  var backendMode = mode;
  if (mode === 'agent') backendMode = 'chat';

  // 调用后端切换 Action
  try {
    var _apiBase = (typeof API !== 'undefined' ? API : '');
    await fetch(_apiBase + '/api/action/switch', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({action: backendMode})
    });
  } catch(e) {
    console.error('[chat.setActionMode]', e);
  }

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

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

    // ===== 在线模式：单个"在线"按钮（模块4合并：取消智能对话/智能文档子按钮）=====
    if (curMode === 'cloud') {
      var cacheKey = 'cloud|agent';
      if (cacheKey === _lastActionIds) return;
      _lastActionIds = cacheKey;

      var bar = document.getElementById('actionBar');
      if (!bar) return;
      bar.innerHTML = '';

      // 在线模式只有一个按钮，LLM 自己决定是对话还是写文档（agent_mode 由后端根据有无模板文件判断）
      currentActionMode = 'agent';
      var validCloudIds = ['agent'];

      var agentBtn = document.createElement('button');
      agentBtn.className = 'action-btn active';
      agentBtn.setAttribute('data-action', 'agent');
      agentBtn.title = '在线 — AI 自动搜索、阅读、回答，也可生成文档';
      agentBtn.onclick = function() { setActionMode('agent', this); };
      var agentSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
      agentBtn.innerHTML = agentSvg + ' 在线';
      bar.appendChild(agentBtn);

      // 更新输入框 placeholder
      var input = document.getElementById('msgInput');
      if (input) {
        input.placeholder = '问任何问题，或描述要生成的文档，AI 会自动处理...';
      }
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
      kbBtn.title = '知识库问答 — 本地模型检索文库，结合云端 AI 综合回答';
      kbBtn.innerHTML = iconSvg('books', '14') + ' 知识库问答';
      kbBtn.onclick = function() { setActionMode('kb_qa', this); };
      bar2.appendChild(kbBtn);

      // 追加齿轮按钮
      if (typeof _renderGearMenu === 'function') _renderGearMenu(bar2);
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
      title: '知识库问答 — 检索你的本地文库，基于文档内容回答问题',
      icon_svg: iconSvg('books', '14')
    });

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

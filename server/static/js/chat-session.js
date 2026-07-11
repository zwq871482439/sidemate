// ===== chat-session.js — 会话管理：列表、切换、新建、删除 =====

// ===== 事件代理：避免 inline onclick 传 Windows 路径（反斜杠转义问题） =====
document.addEventListener('click', function(e) {
  // 操作按钮（重命名/导出/删除）
  var actionBtn = e.target.closest('[data-idx].si-rename, [data-idx].si-delete');
  if (actionBtn) {
    e.stopPropagation();
    var path = actionBtn.closest('.chat-sidebar-item');
    if (!path) return;
    path = path._chatPath;
    if (!path) return;
    if (actionBtn.classList.contains('si-rename')) _sidebarRenameChat(path);
    else if (actionBtn.classList.contains('si-delete')) _sidebarDeleteChat(path);
    return;
  }
  // 点击会话项（切换）
  var item = e.target.closest('.chat-sidebar-item[data-idx]');
  if (item && item._chatPath) {
    _sidebarSelectChat(item._chatPath);
  }
});

// ===== Session 外部变化检测 =====
function startSessionPoll() {
  if (typeof _sessionPollTimer !== 'undefined' && _sessionPollTimer) return;
  if (typeof _sessionPollTimer === 'undefined') window._sessionPollTimer = null;
  _sessionPollTimer = setInterval(async function() {
    if (document.visibilityState === 'hidden') return;
    if ((typeof generating !== 'undefined' && generating) || !currentChatFile) return;
    try {
      var name = currentChatFile.split(/[\\/]/).pop().replace('.json','');
      var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/chats/' + encodeURIComponent(name) + '/messages');
      var data = await resp.json();
      var serverMsgs = (data.messages || []).length;
      if (typeof _lastMsgCount !== 'undefined' && _lastMsgCount > 0 && serverMsgs !== _lastMsgCount) {
        currentMessages = data.messages || [];
        renderMessages(true);  // 消息数变化：强制全量重建（数量增减都走全量，避免增量追加错位）
        await loadChatList();
      }
      _lastMsgCount = serverMsgs;
    } catch(e) { console.error('[chat.startSessionPoll]', e); }
  }, 5000);
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible' && currentChatFile) {
      var name = currentChatFile.split(/[\\/]/).pop().replace('.json','');
      fetch((typeof API !== 'undefined' ? API : '') + '/api/chats/' + encodeURIComponent(name) + '/messages')
.then(function(r) { return r.json(); })
        .then(function(data) {
          var serverMsgs = (data.messages || []).length;
          if (typeof _lastMsgCount !== 'undefined' && _lastMsgCount > 0 && serverMsgs !== _lastMsgCount) {
            currentMessages = data.messages || [];
            renderMessages(true);  // 消息数变化：强制全量重建
            loadChatList();
          }
          _lastMsgCount = serverMsgs;
        })
        .catch(function() {});
    }
  });
}

function stopSessionPoll() {
  if (_sessionPollTimer) {
    clearInterval(_sessionPollTimer);
    _sessionPollTimer = null;
  }
}

// ===== 对话管理 =====
async function loadChatList() {
  var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/chats');
  var data = await resp.json();
  var sel = document.getElementById('sessionSelect');
  if (sel) {
    sel.innerHTML = '';
    (data.chats || []).forEach(function(c) {
      var opt = document.createElement('option');
      opt.value = c.path;
      opt.textContent = c.label + (c.current ? ' ← 当前' : '');
      if (c.current) opt.selected = true;
      sel.appendChild(opt);
    });
  }
  // Patch2 PlanB: 更新侧边会话面板
  _renderChatSidebar(data.chats || [], data.current || '');
}

// ===== Patch2 PlanB: 侧边会话面板渲染 =====
function _renderChatSidebar(chats, currentPath) {
  var list = document.getElementById('chatSidebarList');
  if (!list) return;
  if (!chats.length) {
    list.innerHTML = '<div class="chat-sidebar-empty">暂无对话记录</div>';
    return;
  }
  var html = '';
  chats.forEach(function(c, idx) {
    var isActive = c.path === currentPath || c.current;
    // 使用 data-idx 索引而非内联路径字符串（避免 Windows 反斜杠被 JS 解释为转义字符）
    html += '<div class="chat-sidebar-item' + (isActive ? ' active' : '') + '" data-idx="' + idx + '" title="' + escAttr(c.label) + '">';
    // Patch4 v3.1 BUG#11：移除会话项的图标（think 图标视觉像两个环形，且 Tab 已有标识）
    html += '<span class="si-name">' + esc(c.label) + '</span>';
    if (c.msg_count != null) {
      html += '<span class="si-count">' + c.msg_count + '</span>';
    }
    html += '<span class="si-actions">';
    var encPath = encodeURIComponent(c.path);
    html += '<button class="si-rename" data-idx="' + idx + '" title="重命名" onclick="event.stopPropagation();_sidebarRenameByPath(\'' + encPath + '\')">' + iconSvg('write','11') + '</button>';
    html += '<button class="si-delete" data-idx="' + idx + '" title="删除" onclick="event.stopPropagation();_sidebarDeleteByPath(\'' + encPath + '\')">' + iconSvg('close','11') + '</button>';
    html += '</span>';
    html += '</div>';
  });
  list.innerHTML = html;
  // 缓存路径到 DOM 上，供事件代理使用
  chats.forEach(function(c, idx) {
    var item = list.querySelector('.chat-sidebar-item[data-idx="' + idx + '"]');
    if (item) item._chatPath = c.path;
  });
  var sel = document.getElementById('sessionSelect');
  if (sel && currentPath) sel.value = currentPath;
}

// 通过编码 path 直接调用重命名/删除（内联 onclick 用，最可靠）
function _sidebarRenameByPath(encPath) {
  var path = decodeURIComponent(encPath);
  if (path) _sidebarRenameChat(path);
}
function _sidebarDeleteByPath(encPath) {
  var path = decodeURIComponent(encPath);
  if (path) _sidebarDeleteChat(path);
}
window._sidebarRenameByPath = _sidebarRenameByPath;
window._sidebarDeleteByPath = _sidebarDeleteByPath;

function _sidebarSelectChat(path) {
  if (typeof generating !== 'undefined' && generating) return;
  // 直接切换，不走 hidden select
  if (!path) return;
  fetch((typeof API !== 'undefined' ? API : '') + '/api/chats/switch', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({path: path})
  }).then(function(resp) { return resp.json(); }).then(function(data) {
    currentChatFile = path;
    currentMessages = data.messages || [];
    _lastMsgCount = currentMessages.length;
    // P6: 清除残留的流式消息元素（防止切换会话后消息叠加）
    var _oldStream = document.getElementById('stream-msg');
    if (_oldStream) _oldStream.remove();
    renderMessages(true);  // P0 修复：切换会话强制全量重建，避免消息堆积
    loadChatList();
    // P6 T04: 切换会话后保持模式状态，刷新 action bar 和 placeholder
    if (typeof _currentMode !== 'undefined') {
      if (typeof refreshActionBar === 'function') refreshActionBar();
      if (typeof _updatePlaceholder === 'function') {
        var frontMode = _currentMode === 'local' ? 'offline' : (_currentMode === 'cloud' ? 'online' : _currentMode);
        _updatePlaceholder(frontMode);
      }
    }
    // 切换会话后刷新上下文指示器
    if (typeof fetchContextUsage === 'function') fetchContextUsage();
  }).catch(function(e) {
    showToast('切换会话失败', 'error');
  });
}

// 内联重命名弹窗（替代 prompt()）
function _showRenameModal(defaultName, callback) {
  // 移除已有弹窗
  var existing = document.getElementById('renameModalBackdrop');
  if (existing) existing.remove();

  var backdrop = document.createElement('div');
  backdrop.id = 'renameModalBackdrop';
  backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:1000;display:flex;align-items:center;justify-content:center;animation:fadeIn .15s ease';

  var card = document.createElement('div');
  card.className = 'modal-confirm-card';
  card.style.cssText = 'width:340px;padding:20px 24px';
  card.innerHTML =
    '<h3 style="font-size:15px;font-weight:600;margin:0 0 12px 0">重命名会话</h3>' +
    '<input type="text" id="renameModalInput" value="' + (defaultName || '').replace(/"/g, '&quot;') + '" ' +
    'style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border-color);border-radius:6px;font-size:14px;font-family:inherit;background:var(--bg-primary);color:var(--text-primary);outline:none">' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">' +
    '<button id="renameModalCancel" style="padding:6px 14px;border:1px solid var(--border-color);border-radius:6px;background:transparent;color:var(--text-muted);cursor:pointer;font-size:13px">取消</button>' +
    '<button id="renameModalOk" style="padding:6px 16px;border:none;border-radius:6px;background:var(--accent-color);color:var(--text-on-accent);cursor:pointer;font-size:13px;font-weight:500">确认</button>' +
    '</div>';
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  var input = document.getElementById('renameModalInput');
  var close = function() { backdrop.remove(); };
  var submit = function() {
    var val = input.value.trim();
    close();
    if (val && callback) callback(val);
  };

  input.focus();
  input.select();
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') close();
  });
  document.getElementById('renameModalOk').addEventListener('click', submit);
  document.getElementById('renameModalCancel').addEventListener('click', close);
  backdrop.addEventListener('click', function(e) { if (e.target === backdrop) close(); });
}

async function _sidebarRenameChat(path) {
  var name = path.split(/[\\/]/).pop().replace('.json','');
  _showRenameModal(name, async function(newName) {
    if (!newName || newName === name) return;
    try {
      var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/chats/' + encodeURIComponent(name) + '/rename', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({new_name: newName})
      });
      var data = await resp.json();
      if (data.ok) {
        if (data.new_file && currentChatFile === path) {
          currentChatFile = data.new_file;
        }
        if (typeof showToast === 'function') showToast('会话已重命名');
        await loadChatList();
      } else {
        if (typeof showToast === 'function') showToast(data.error || '重命名失败', 'error');
      }
    } catch(e) {
      if (typeof showToast === 'function') showToast('重命名失败', 'error');
    }
  });
}

function _sidebarExportChat(path) {
  if (path === currentChatFile) { exportChat(); return; }
  // 先切换到目标会话，导出，再切回
  var origPath = currentChatFile;
  fetch((typeof API !== 'undefined' ? API : '') + '/api/chats/switch', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({path: path})
  }).then(function(resp) { return resp.json(); }).then(function(data) {
    currentChatFile = path;
    exportChat();
    // 切回原会话
    if (origPath) {
      fetch((typeof API !== 'undefined' ? API : '') + '/api/chats/switch', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({path: origPath})
      }).then(function(r2) { return r2.json(); }).then(function(d2) {
        currentChatFile = origPath;
        currentMessages = d2.messages || [];
        renderMessages(true);  // 会话切换：强制全量重建
      });
    }
  });
}

async function _sidebarDeleteChat(path) {
  if (typeof generating !== 'undefined' && generating) return;
  var name = path.split(/[\\/]/).pop().replace('.json','');
  if (!(await showDialog('确认删除', '确定要删除对话 ' + name + '？此操作不可恢复。', {type: 'danger', confirm: true, confirmLabel: '删除', cancelLabel: '取消'}))) return;
  var delResp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/chats/' + encodeURIComponent(name), {method:'DELETE'});
  var delData = await delResp.json();
  if (!delResp.ok && !delData.ok) { showToast('删除失败: ' + (delData.error || '未知错误'), 'error'); return; }

  // P6: 自动撤销该会话关联的所有令牌
  fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/tokens/revoke_by_session', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({session_id: name})
  }).catch(function() {});  // 静默失败

  if (path === currentChatFile) {
    currentChatFile = null;
    currentMessages = [];
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/chats');
    var data = await resp.json();
    if (data.chats && data.chats.length > 0) {
      var latest = data.chats[0];
      currentChatFile = latest.path;
      var sel = document.getElementById('sessionSelect');
      if (sel) sel.value = latest.path;
      var swResp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/chats/switch', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({path: latest.path})
      });
      var swData = await swResp.json();
      currentMessages = swData.messages || [];
      renderMessages(true);  // 会话切换：强制全量重建
    } else {
      await newChat();
    }
  }
  await loadChatList();
}

async function onSessionChange() {
  if (typeof generating !== 'undefined' && generating) return;
  var path = document.getElementById('sessionSelect').value;
  if (!path) return;
  var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/chats/switch', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({path: path})
  });
  var data = await resp.json();
  currentChatFile = path;
  currentMessages = data.messages || [];
  _lastMsgCount = currentMessages.length;
  renderMessages(true);  // 会话切换：强制全量重建
  await loadChatList();
  // P6 T04: 切换会话后保持模式状态
  if (typeof _currentMode !== 'undefined') {
    if (typeof refreshActionBar === 'function') refreshActionBar();
    if (typeof _updatePlaceholder === 'function') {
      var _fm = _currentMode === 'local' ? 'offline' : (_currentMode === 'cloud' ? 'online' : _currentMode);
      _updatePlaceholder(_fm);
    }
  }
}

async function newChat() {
  if (typeof generating !== 'undefined' && generating) return;
  if (typeof pendingFile !== 'undefined') pendingFile = null;
  if (typeof hideFileIndicator === 'function') hideFileIndicator();
  var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/chats/new', {method:'POST'});
  var data = await resp.json();
  currentChatFile = data.path;
  currentMessages = [];
  renderMessages(true);  // 新建会话：强制全量重建
  await loadChatList();
  if (typeof fetchContextUsage === 'function') fetchContextUsage();
}

async function deleteChat() {
  if (typeof generating !== 'undefined' && generating) return;
  if (!currentChatFile) return;
  var name = currentChatFile.split(/[\\/]/).pop().replace('.json','');
  if (!(await showDialog('确认删除', '确定要删除对话 ' + name + '？此操作不可恢复。', {type: 'danger', confirm: true, confirmLabel: '删除', cancelLabel: '取消'}))) return;
  var delResp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/chats/' + encodeURIComponent(name), {method:'DELETE'});
  var delData = await delResp.json();
  if (!delResp.ok && !delData.ok) { showToast('删除失败: ' + (delData.error || '未知错误'), 'error'); return; }

  // P6: 自动撤销该会话关联的所有令牌
  fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/tokens/revoke_by_session', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({session_id: name})
  }).catch(function() {});  // 静默失败，令牌撤销不影响主流程

  currentChatFile = null;
  currentMessages = [];
  await loadChatList();
  var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/chats');
  var data = await resp.json();
  if (data.chats && data.chats.length > 0) {
    var latest = data.chats[0];
    currentChatFile = latest.path;
    var sel = document.getElementById('sessionSelect');
    if (sel) sel.value = latest.path;
    var swResp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/chats/switch', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({path: latest.path})
    });
    var swData = await swResp.json();
    currentMessages = swData.messages || [];
    renderMessages(true);  // 删除会话后切换：强制全量重建
  } else {
    await newChat();
  }
  await loadChatList();
}

window.startSessionPoll = startSessionPoll;
window.stopSessionPoll = stopSessionPoll;
window.loadChatList = loadChatList;
window.onSessionChange = onSessionChange;
window.newChat = newChat;
window.deleteChat = deleteChat;
window._renderChatSidebar = _renderChatSidebar;
window._sidebarSelectChat = _sidebarSelectChat;
window._sidebarRenameChat = _sidebarRenameChat;
window._sidebarExportChat = _sidebarExportChat;
window._sidebarDeleteChat = _sidebarDeleteChat;

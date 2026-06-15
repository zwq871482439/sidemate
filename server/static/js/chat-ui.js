// ===== chat-ui.js — UI 辅助函数 =====
// 依赖: utils.js, errors.js, 全局变量 currentMessages, currentChatFile, generating

// ===== 强制恢复聊天UI状态 =====
function _restoreChatUI() {
  var btn = document.getElementById('sendBtn');
  var stop = document.getElementById('stopBtn');
  var input = document.getElementById('msgInput');
  if (btn) { btn.style.display = ''; btn.disabled = false; btn.innerHTML = iconSvg('send','14'); }
  if (stop) { stop.style.display = 'none'; stop.innerHTML = iconSvg('stop','14'); }
  if (input) { input.disabled = false; }
  var ss = document.getElementById('sessionSelect');
  var nc = document.getElementById('newChatBtn');
  var dc = document.getElementById('delChatBtn');
  if (ss) ss.disabled = false;
  if (nc) nc.disabled = false;
  if (dc) dc.disabled = false;
}

// ===== 消息一键复制 =====
function copyMsgContent(btn) {
  var wrap = btn.closest('.msg-copy-wrap');
  if (!wrap) return;
  var clone = wrap.cloneNode(true);
  var removeSelectors = ['.ts', 'details', '.stats', '.msg-copy-btn'];
  removeSelectors.forEach(function(sel) {
    var els = clone.querySelectorAll(sel);
    els.forEach(function(el) { el.remove(); });
  });
  var text = (clone.textContent || '').trim();
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() {
      _showCopyFeedback(btn);
    }).catch(function() {
      _fallbackCopyMsg(text, btn);
    });
  } else {
    _fallbackCopyMsg(text, btn);
  }
}

function _showCopyFeedback(btn) {
  btn.classList.add('copied');
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  setTimeout(function() {
    btn.classList.remove('copied');
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  }, 1500);
}

function _fallbackCopyMsg(text, btn) {
  try {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    _showCopyFeedback(btn);
  } catch(e) {
    if (typeof showToast === 'function') showToast('复制失败', 'error');
  }
}

// ===== 话题漂移提示条 =====
function showDriftBar(reason, msgCount, swellThreshold, driftLevel, suggestion) {
  var old = document.querySelector('.drift-bar');
  if (old) old.remove();
  var el = document.getElementById('messages');
  if (!el) return;
  var level = driftLevel || 'moderate';
  var isSwell = level === 'swell';
  var bar = document.createElement('div');
  bar.className = 'drift-bar';
  if (isSwell) {
    bar.innerHTML = iconSvg('doc','14') + ' 当前对话已较长（' + msgCount + ' 条），建议新建对话以保持回复质量 ' +
      '<button onclick="driftNewChat(this)">新建对话</button>' +
      '<button onclick="driftDismiss(this)">继续当前</button>';
  } else if (level === 'hard') {
    bar.innerHTML = iconSvg('spin','14') + ' 检测到话题完全切换，已自动调整回复策略 ' +
      '<button onclick="driftNewChat(this)">新建对话</button>' +
      '<button onclick="driftDismiss(this)">继续当前</button>';
    bar.style.borderLeft = '3px solid var(--error-color)';
  } else {
    bar.innerHTML = iconSvg('spin','14') + ' 检测到话题可能切换，建议新建对话 ' +
      '<button onclick="driftNewChat(this)">新建对话</button>' +
      '<button onclick="driftDismiss(this)">继续当前</button>';
    bar.style.borderLeft = '3px solid var(--warning-color)';
  }
  el.appendChild(bar);
  el.scrollTop = el.scrollHeight;
}

async function driftNewChat(btn) {
  var bar = btn.closest('.drift-bar');
  var lastUserMsg = currentMessages.filter(function(m) { return m.role === 'user'; }).pop();
  var msgText = lastUserMsg ? lastUserMsg.content : '';
  if (bar) bar.remove();
  if (typeof generating !== 'undefined' && generating) {
    await stopGenerationAndWait();
    await new Promise(function(r) { setTimeout(r, 200); });
  }
  await newChat();
  if (msgText) {
    document.getElementById('msgInput').value = msgText;
    sendMessage();
  }
}

function driftDismiss(btn) {
  var bar = btn.closest('.drift-bar');
  if (bar) bar.remove();
}

// ===== 模型覆盖层 =====
async function updateChatOverlay() {
  var overlay = document.getElementById('chatModelOverlay');
  var lock = document.getElementById('chatOverlayLock');
  if (!overlay) return;
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/models');
    var data = await resp.json();
    var current = data.current;
    var hasLoadedModel = !!current;

    // 云端模式下不显示本地模型遮罩
    if (typeof _currentMode !== 'undefined' && _currentMode === 'cloud') {
      overlay.style.display = 'none';
      return;
    }

    if (hasLoadedModel) {
      overlay.style.display = 'none';
      return;
    }

    // 未预热 → 显示 lock 卡片
    lock.style.display = '';
    overlay.style.display = '';
  } catch(e) {
    console.error('[chat.updateChatOverlay]', e);
  }
}

function updateKbLockBar() {
  // KB 处理中锁定（由 qa.js 调用）
  // 空实现保留兼容，实际在 qa.js 中处理
}

// ===== 滚动控制 =====
function scrollToBottom() {
  var el = document.getElementById('messages');
  if (el) { el.scrollTop = el.scrollHeight; }
}

function checkScrollBtn() {
  var el = document.getElementById('messages');
  var btn = document.getElementById('scrollBottomBtn');
  if (!el || !btn) return;
  var dist = el.scrollHeight - el.scrollTop - el.clientHeight;
  btn.style.display = dist > 200 ? 'block' : 'none';
}

function clearFileRef() {
  if (typeof _refFilePath !== 'undefined') _refFilePath = null;
  if (typeof pendingFile !== 'undefined') pendingFile = null;
  if (typeof hideFileIndicator === 'function') hideFileIndicator();
  var input = document.getElementById('unifiedInput');
  if (input) input.value = '';
}

window.copyMsgContent = copyMsgContent;
window.showDriftBar = showDriftBar;
window.driftNewChat = driftNewChat;
window.driftDismiss = driftDismiss;
window.updateChatOverlay = updateChatOverlay;
window.updateKbLockBar = updateKbLockBar;
window.scrollToBottom = scrollToBottom;
window.checkScrollBtn = checkScrollBtn;
window.clearFileRef = clearFileRef;

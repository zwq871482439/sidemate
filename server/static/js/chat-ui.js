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
  // 优先从正文区 .stream-content 取文本（与流式/历史结构一致）；
  // fallback 到旧的 .msg-copy-wrap 行为。
  var msgEl = btn.closest('.msg');
  var sourceEl = null;
  if (msgEl) {
    sourceEl = msgEl.querySelector('.stream-content');
  }
  if (!sourceEl) {
    var wrap = btn.closest('.msg-copy-wrap');
    if (!wrap) return;
    sourceEl = wrap;
  }
  var clone = sourceEl.cloneNode(true);
  var removeSelectors = ['.ts', 'details', '.stats', '.msg-copy-btn', '.msg-footer', '.card-area', '.kb-sources-bar', '.doc-download-bar', '.msg-file-tag'];
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

// ===== P6: 话题漂移提示条已移除（T04）=====

// ===== 模型覆盖层 =====
async function updateChatOverlay() {
  var overlay = document.getElementById('chatModelOverlay');
  var lock = document.getElementById('chatOverlayLock');
  if (!overlay) return;
  try {
    var curMode = (typeof _currentMode !== 'undefined') ? _currentMode : 'local';

    // P6 审计修复：恢复模式相关的空状态检测
    // 云端/并行模式：检查 API 是否配置
    if (curMode === 'cloud' || curMode === 'parallel') {
      var cloudConfigured = (typeof _cloudConfigured !== 'undefined') ? _cloudConfigured : false;
      if (!cloudConfigured) {
        // 未配置云端 API → 显示配置提示卡片
        if (lock) lock.style.display = 'none';
        overlay.style.display = '';
        overlay.innerHTML =
          '<div class="overlay-card" style="margin:auto;max-width:340px;padding:24px;text-align:center">' +
            '<div style="opacity:.5;margin-bottom:12px">' + iconSvg('cloud', '32') + '</div>' +
            '<div style="font-weight:500;color:var(--text-primary);margin-bottom:6px">' +
              (curMode === 'parallel' ? '并行模式需要云端 API' : '在线模式需要云端 API') +
            '</div>' +
            '<div style="font-size:.9em;color:var(--text-secondary);margin-bottom:14px">' +
              '请先在设置页配置云端 AI 模型的 API 地址和密钥' +
            '</div>' +
            '<button class="btn btn-primary" onclick="switchTab(\'settings\');setTimeout(function(){switchSettingsTab(\'cloud\',document.querySelector(\'.settings-nav-item[data-stab=cloud]\'))},100);" style="padding:6px 16px">' +
              '前往设置' +
            '</button>' +
          '</div>';
        return;
      }
      // 已配置 → 隐藏遮罩
      overlay.style.display = 'none';
      if (lock) lock.style.display = 'none';
      return;
    }

    // 离线模式：检查 LLM 是否预热
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/models');
    var data = await resp.json();
    var current = data.current;
    var hasLoadedModel = !!current;

    if (hasLoadedModel) {
      overlay.style.display = 'none';
      if (lock) lock.style.display = 'none';
      return;
    }

    // 未预热 → 显示 lock 卡片
    if (lock) lock.style.display = '';
    overlay.style.display = '';
    // 恢复 overlay 原始内容（防止被云端 API 提示覆盖后残留）
    overlay.innerHTML =
      '<div class="overlay-card" style="margin:auto;max-width:340px;padding:24px;text-align:center">' +
        '<div style="opacity:.5;margin-bottom:12px">' + iconSvg('brain', '32') + '</div>' +
        '<div style="font-weight:500;color:var(--text-primary);margin-bottom:6px">本地模型未加载</div>' +
        '<div style="font-size:.9em;color:var(--text-secondary);margin-bottom:14px">' +
          '请在设置页加载本地 LLM 模型后开始对话' +
        '</div>' +
        '<button class="btn btn-primary" onclick="switchTab(\'settings\');setTimeout(function(){switchSettingsTab(\'general\',document.querySelector(\'.settings-nav-item[data-stab=general]\'))},100);" style="padding:6px 16px">' +
          '前往设置' +
        '</button>' +
      '</div>';
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
  if (typeof TokenEstimator !== 'undefined' && TokenEstimator.updateInputDisplay) {
    TokenEstimator.updateInputDisplay();
  }
  var input = document.getElementById('unifiedInput');
  if (input) input.value = '';
}

window.copyMsgContent = copyMsgContent;
window.updateChatOverlay = updateChatOverlay;
window.updateKbLockBar = updateKbLockBar;
window.scrollToBottom = scrollToBottom;
window.checkScrollBtn = checkScrollBtn;
window.clearFileRef = clearFileRef;

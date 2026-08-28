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

// ===== 会话侧边栏折叠/展开 =====
function toggleChatSidebar() {
  var sidebar = document.getElementById('chatSidebar');
  var expandBtn = document.getElementById('chatSidebarExpand');
  if (!sidebar) return;
  var collapsed = sidebar.classList.toggle('collapsed');
  if (expandBtn) expandBtn.style.display = collapsed ? 'flex' : 'none';
}
window.toggleChatSidebar = toggleChatSidebar;

// ===== 会话侧边栏折叠/展开 结束 =====

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
// P8-6：锁卡渲染全部从 AppState 派生视图驱动，不再自行拼状态。
// 卡片类型（view.lock）：
//   need_cloud_key               锁卡D：cloud/parallel 未配 Key
//   offline_no_model_cloud_ready 锁卡B：离线无本地模型但已配云端（C 方案引导卡）
//   no_engine                    锁卡C：无任何引擎（下载本地 + 配云端双选）
//   not_loaded                   锁卡A：已装模型未加载
//   none                         就绪，不显示
async function updateChatOverlay() {
  var overlay = document.getElementById('chatModelOverlay');
  var lock = document.getElementById('chatOverlayLock');
  if (!overlay) return;
  try {
    var view = await AppState.getView();
    if (!view) return;

    // onboard 未完成（或"重新引导"手动重弹）时欢迎弹窗独占空状态引导，
    // 状态锁不显示，避免两层引导冲突
    var welcomeEl = document.getElementById('welcomeOverlay');
    var welcomeShown = welcomeEl && welcomeEl.style.display && welcomeEl.style.display !== 'none';
    if (view.welcome || welcomeShown || view.lock === 'none') {
      overlay.style.display = 'none';
      if (lock) lock.style.display = 'none';
      return;
    }

    if (lock) lock.style.display = '';
    overlay.style.display = '';

    var goSettings = function(stab) {
      return 'switchTab(\'settings\');setTimeout(function(){switchSettingsTab(\'' + stab +
        '\',document.querySelector(\'.settings-nav-item[data-stab=' + stab + ']\'))},100);';
    };

    if (view.lock === 'need_cloud_key') {
      overlay.innerHTML =
        '<div class="overlay-card" style="margin:auto;max-width:340px;padding:24px;text-align:center">' +
          '<div style="opacity:.5;margin-bottom:12px">' + iconSvg('cloud', '32') + '</div>' +
          '<div style="font-weight:500;color:var(--text-primary);margin-bottom:6px">' +
            (view.mode === 'parallel' ? '并行模式需要在线 API' : '在线模式需要配置 API') +
          '</div>' +
          '<div style="font-size:.9em;color:var(--text-secondary);margin-bottom:14px">' +
            '请先在设置页配置在线 AI 的 API 地址和密钥' +
          '</div>' +
          '<button class="btn btn-primary" onclick="' + goSettings('cloud') + '" style="padding:6px 16px">' +
            '前往设置' +
          '</button>' +
        '</div>';
    } else if (view.lock === 'offline_no_model_cloud_ready') {
      // C 方案引导卡：文案直接给答案，一键切换到在线模式
      overlay.innerHTML =
        '<div class="overlay-card" style="margin:auto;max-width:360px;padding:24px;text-align:center">' +
          '<div style="opacity:.5;margin-bottom:12px">' + iconSvg('cloud', '32') + '</div>' +
          '<div style="font-weight:500;color:var(--text-primary);margin-bottom:6px">离线模型未安装</div>' +
          '<div style="font-size:.9em;color:var(--text-secondary);margin-bottom:14px">' +
            '你已配置在线 API（' + esc(window._cloudModelName || '在线模型') + '），可直接切换到在线模式开始使用' +
          '</div>' +
          '<div style="display:flex;gap:10px;justify-content:center">' +
            '<button class="btn btn-primary" onclick="guidedSwitchToOnline()" style="padding:6px 16px">' +
              '立即切换到在线模式 →' +
            '</button>' +
            '<button class="btn" onclick="' + goSettings('download') + '" style="padding:6px 16px">' +
              '下载离线模型' +
            '</button>' +
          '</div>' +
        '</div>';
    } else if (view.lock === 'no_engine') {
      overlay.innerHTML =
        '<div class="overlay-card" style="margin:auto;max-width:360px;padding:24px;text-align:center">' +
          '<div style="opacity:.5;margin-bottom:12px">' + iconSvg('brain', '32') + '</div>' +
          '<div style="font-weight:500;color:var(--text-primary);margin-bottom:6px">还没有可用的 AI 引擎</div>' +
          '<div style="font-size:.9em;color:var(--text-secondary);margin-bottom:14px">' +
            '下载离线模型本地运行，或配置在线 API 立即开始' +
          '</div>' +
          '<div style="display:flex;gap:10px;justify-content:center">' +
            '<button class="btn btn-primary" onclick="' + goSettings('download') + '" style="padding:6px 16px">' +
              '下载离线模型' +
            '</button>' +
            '<button class="btn" onclick="' + goSettings('cloud') + '" style="padding:6px 16px">' +
              '配置在线 API' +
            '</button>' +
          '</div>' +
        '</div>';
    } else { // not_loaded
      overlay.innerHTML =
        '<div class="overlay-card" style="margin:auto;max-width:340px;padding:24px;text-align:center">' +
          '<div style="opacity:.5;margin-bottom:12px">' + iconSvg('brain', '32') + '</div>' +
          '<div style="font-weight:500;color:var(--text-primary);margin-bottom:6px">离线模型未加载</div>' +
          '<div style="font-size:.9em;color:var(--text-secondary);margin-bottom:14px">' +
            '请在设置页加载离线模型后开始对话' +
          '</div>' +
          '<button class="btn btn-primary" onclick="' + goSettings('general') + '" style="padding:6px 16px">' +
            '前往设置' +
          '</button>' +
        '</div>';
    }
  } catch(e) {
    console.error('[chat.updateChatOverlay]', e);
  }
}

// C 方案：锁卡引导一键切换到在线模式。
// 用户已显式点击切换按钮，跳过模式确认弹窗。
function guidedSwitchToOnline() {
  if (typeof _executeModeSwitch === 'function') _executeModeSwitch('online');
  else if (typeof selectMode === 'function') selectMode('online');
}
window.guidedSwitchToOnline = guidedSwitchToOnline;

function updateKbLockBar() {
  // KB 处理中锁定（由 qa.js 调用）
  // 空实现保留兼容，实际在 qa.js 中处理
}

// ===== 滚动控制 =====
// 自动滚动策略：用户在底部时跟随新内容；用户手动上滚查看时停止自动滚动，
// 直到点「回到底部」回到底部才恢复。_lastScrollBottom 是跨文件的跟随状态。
function scrollToBottom() {
  var el = document.getElementById('messages');
  if (el) { el.scrollTop = el.scrollHeight; }
  // 用户主动点「回到底部」→ 恢复自动跟随
  if (typeof _lastScrollBottom !== 'undefined') _lastScrollBottom = true;
}

function checkScrollBtn() {
  var el = document.getElementById('messages');
  var btn = document.getElementById('scrollBottomBtn');
  if (!el) return;
  var dist = el.scrollHeight - el.scrollTop - el.clientHeight;
  // 实时更新自动跟随状态：距底部超过阈值视为用户主动上滚，停止自动滚动
  if (typeof _lastScrollBottom !== 'undefined') {
    _lastScrollBottom = dist < 120;
  }
  if (btn) {
    btn.style.display = dist > 200 ? 'block' : 'none';
  }
}

function clearFileRef() {
  // 0828 收口：清理逻辑统一走 resetAttachState（chat-files.js），
  // 消灭并存的第二套清理（曾出现 pendingFile 与 _pendingFileName 清理不一致的半态）
  if (typeof resetAttachState === 'function') {
    resetAttachState();
  } else {
    if (typeof _refFilePath !== 'undefined') _refFilePath = null;
    if (typeof pendingFile !== 'undefined') pendingFile = null;
    if (typeof hideFileIndicator === 'function') hideFileIndicator();
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

// ===== errors.js — 离线降级 UI + Toast 通知中心 + 心跳检测 =====
// 依赖: api.js (fetchWithTimeout), utils.js (esc)

/**
 * 静默日志：NetworkError / TypeError: Failed to fetch 等网络错误在启动阶段是正常预期的，
 * 不打印到控制台避免刷屏。其他错误正常打印。
 * 用法: catch(e) { silentLog('[模块.方法]', e); }
 */
function silentLog(tag, e) {
  if (!e) return;
  var msg = (e.message || String(e)).toLowerCase();
  if (msg.indexOf('networkerror') >= 0 || msg.indexOf('failed to fetch') >= 0 || msg.indexOf('network request failed') >= 0) {
    return; // 启动阶段后端未就绪的正常错误，静默跳过
  }
  console.error(tag, e);
}
window.silentLog = silentLog;

/**
 * 错误码映射表
 */
var ERROR_MAP = {
  MODEL_LOAD_ERROR: { message: '模型加载失败', action: '检查模型文件完整性' },
  KB_NOT_READY: { message: '文库未就绪', action: '请先安装文库模块' },
  AGENT_TIMEOUT: { message: 'Agent 响应超时', action: '请简化问题后重试' },
  NO_MODEL: { message: '未加载模型', action: '请先在设置中加载模型' },
  NETWORK_ERROR: { message: '网络连接异常', action: '检查网络或稍后重试' },
  UNKNOWN_ERROR: { message: '未知错误', action: '请刷新页面或重启服务' }
};

var FRIENDLY_ERRORS = {
  '500': '服务处理出错，请稍后重试',
  '502': '服务暂不可用，请稍后重试',
  '503': '服务繁忙，请稍后重试',
  'timeout': '服务响应较慢，请确认后台正在运行',
  'NetworkError': '无法连接服务，请检查是否已启动',
  'Failed to fetch': '无法连接服务，请检查是否已启动',
  'AbortError': '请求已取消'
};

function friendlyError(err) {
  if (!err) return '未知错误';
  var msg = String(err.message || err);
  for (var key in FRIENDLY_ERRORS) {
    if (FRIENDLY_ERRORS.hasOwnProperty(key) && msg.indexOf(key) >= 0) return FRIENDLY_ERRORS[key];
  }
  if (msg.indexOf('500') >= 0 || msg.indexOf('Internal Server Error') >= 0) return FRIENDLY_ERRORS['500'];
  return msg;
}

window.FRIENDLY_ERRORS = FRIENDLY_ERRORS;
window.friendlyError = friendlyError;

// ===== Toast 通知中心 =====

var _toastMaxVisible = 3;       // 同时最多显示 3 个
var _toastDedupMs = 5000;       // 相同 message 去重窗口 5 秒
var _toastRecent = {};          // message → timestamp (去重用)
var _toastKeyMap = {};          // key → toast element (防重入用)
var _toastQueue = [];           // 排队等待显示的 toast

/**
 * 显示 Toast 通知（统一入口）
 * @param {string} message - 通知文本
 * @param {string} [type='info'] - 'error' | 'warning' | 'success' | 'info'
 * @param {number} [duration=4000] - 显示时长（毫秒）
 * @param {string} [action] - 可操作建议（可选）
 * @param {string} [key] - 唯一标识，带 key 的 toast 同一时间只存在一个（可选）
 */
function showToast(message, type, duration, action, key) {
  // 默认值
  if (!type) type = 'info';
  if (!duration) duration = 4000;

  var container = document.getElementById('toastContainer');
  if (!container) return;

  // 支持传入错误码对象 { code, message, action }
  if (message && typeof message === 'object') {
    action = message.action || action;
    message = message.message || message.code || '未知错误';
  }

  // 规范化 type：允许 'warn' 和 'warning' 都映射到 'warning'
  if (type === 'warn') type = 'warning';

  // --- 去重：相同 message 在 _toastDedupMs 内不重复 ---
  var now = Date.now();
  if (_toastRecent[message] && (now - _toastRecent[message]) < _toastDedupMs) {
    return; // 已有相同 toast，跳过
  }
  _toastRecent[message] = now;

  // 定期清理过期的去重记录（避免内存泄漏）
  var keys = Object.keys(_toastRecent);
  if (keys.length > 50) {
    for (var i = 0; i < keys.length; i++) {
      if (now - _toastRecent[keys[i]] > _toastDedupMs) {
        delete _toastRecent[keys[i]];
      }
    }
  }

  // --- 防重入：相同 key 的 toast 只保留一个 ---
  if (key) {
    var existing = _toastKeyMap[key];
    if (existing && existing.parentNode) {
      // 已有相同 key 的 toast，先移除旧的
      existing.remove();
    }
  }

  // --- 排队：超出上限时排队等待 ---
  var visibleCount = container.querySelectorAll('.toast').length;
  if (visibleCount >= _toastMaxVisible) {
    _toastQueue.push({ message: message, type: type, duration: duration, action: action, key: key });
    return;
  }

  // --- 创建 toast 元素 ---
  var toast = document.createElement('div');
  toast.className = 'toast ' + type;

  var html = '<div class="toast-msg">' + (typeof esc === 'function' ? esc(message) : message) + '</div>';
  if (action) {
    html += '<div class="toast-action">' + iconSvg('idea','12') + ' ' + (typeof esc === 'function' ? esc(action) : action) + '</div>';
  }
  toast.innerHTML = html;

  // 关闭按钮
  var closeBtn = document.createElement('span');
  closeBtn.innerHTML = iconSvg('close','14');
  closeBtn.style.cssText = 'margin-left:auto;cursor:pointer;font-size:1.1em;opacity:.7;flex-shrink:0';
  closeBtn.onclick = function() { toast.remove(); };
  toast.style.display = 'flex';
  toast.style.alignItems = 'center';
  toast.style.gap = '6px';
  toast.appendChild(closeBtn);

  // 记录 key 映射
  if (key) {
    _toastKeyMap[key] = toast;
  }

  // 自动消失
  var timer = setTimeout(function() { dismissToast(toast, key); }, duration);
  toast._timer = timer;

  if (container.children.length >= 3) { container.firstChild.remove(); }
  container.appendChild(toast);
}

/**
 * 关闭 toast 并触发排队显示
 */
function dismissToast(toast, key) {
  if (!toast || !toast.parentNode) return;
  clearTimeout(toast._timer);
  toast.style.opacity = '0';
  toast.style.transform = 'translateX(20px)';
  toast.style.transition = 'all .3s ease';
  setTimeout(function() {
    if (toast.parentNode) toast.remove();
    if (key) delete _toastKeyMap[key];
    // 检查排队
    _flushToastQueue();
  }, 300);
}

/**
 * 处理排队中的 toast
 */
function _flushToastQueue() {
  var container = document.getElementById('toastContainer');
  if (!container) return;
  var visibleCount = container.querySelectorAll('.toast').length;
  while (_toastQueue.length > 0 && visibleCount < _toastMaxVisible) {
    var item = _toastQueue.shift();
    showToast(item.message, item.type, item.duration, item.action, item.key);
    visibleCount++;
  }
}

/**
 * 根据错误码显示友好错误提示
 * @param {string} code - 错误码
 * @param {string} fallback - 回退消息
 */
function showErrorByCode(code, fallback) {
  var entry = ERROR_MAP[code];
  if (entry) {
    showToast(entry.message, 'error', 5000, entry.action);
  } else {
    showToast(fallback || code, 'error', 4000);
  }
}

// ===== 离线降级 UI =====

/**
 * 显示离线横幅
 */
function showOfflineBanner() {
  var banner = document.getElementById('offlineBanner');
  if (banner) banner.classList.add('show');
  document.body.classList.add('has-offline-banner');
}

/**
 * 隐藏离线横幅
 */
function hideOfflineBanner() {
  var banner = document.getElementById('offlineBanner');
  if (banner) banner.classList.remove('show');
  document.body.classList.remove('has-offline-banner');
}

/**
 * 关闭离线横幅（用户点击 X）
 */
function dismissOfflineBanner() {
  hideOfflineBanner();
}

/**
 * 重试连接后端
 */
async function retryConnect() {
  try {
    var resp = await fetchWithTimeout((typeof API !== 'undefined' ? API : '') + '/api/status', {}, 3000);
    if (resp.ok) {
      hideOfflineBanner();
      showToast('服务已连接', 'success');
      if (typeof refreshStatus === 'function') await refreshStatus();
      if (typeof refreshActionBar === 'function') await refreshActionBar();
      if (typeof kbRouteState === 'function') {
        try { await kbRouteState(); } catch(e) { console.warn('[retry] kbRouteState 刷新失败:', e.message); }
      }
      if (typeof minutesRouteState === 'function') {
        try { await minutesRouteState(); } catch(e) { console.warn('[retry] minutesRouteState 刷新失败:', e.message); }
      }
      if (typeof refreshResourcePanel === 'function') {
        try { await refreshResourcePanel(); } catch(e) { console.warn('[retry] refreshResourcePanel 刷新失败:', e.message); }
      }
    }
  } catch(e) {
    showToast('服务仍未连接: ' + e.message, 'error');
  }
}

// ===== 心跳检测 =====

var _heartbeatTimer = null;
var _heartbeatPaused = false;

/**
 * 暂停心跳检测（安装扩展等长时间操作时使用，避免误报"无法连接"）
 */
function pauseHeartbeat() {
  _heartbeatPaused = true;
}

/**
 * 恢复心跳检测
 */
function resumeHeartbeat() {
  _heartbeatPaused = false;
}

/**
 * 停止心跳检测（页面卸载时调用）
 */
function stopHeartbeat() {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}

/**
 * 启动心跳检测（每30秒检测后端状态）
 */
function startHeartbeat() {
  if (_heartbeatTimer) return;
  console.log('[Heartbeat] 启动心跳检测 (30s)');
  _heartbeatTimer = setInterval(async function() {
    if (_heartbeatPaused) return;
    try {
      var resp = await fetchWithTimeout((typeof API !== 'undefined' ? API : '') + '/api/status', {}, 3000);
      if (resp.ok) {
        console.log('[Heartbeat] 后端在线');
        hideOfflineBanner();
      }
    } catch(e) {
      console.warn('[Heartbeat] 后端离线:', e.message);
      showOfflineBanner();
    }
  }, 30000);
}

// 页面不可见时暂停心跳，可见时恢复（避免后台标签页无意义请求）
document.addEventListener('visibilitychange', function() {
  if (document.hidden) {
    pauseHeartbeat();
  } else {
    resumeHeartbeat();
  }
});

// 暴露到全局
window.showOfflineBanner = showOfflineBanner;
window.hideOfflineBanner = hideOfflineBanner;
window.dismissOfflineBanner = dismissOfflineBanner;
window.retryConnect = retryConnect;
window.showToast = showToast;
window.dismissToast = dismissToast;
window.showErrorByCode = showErrorByCode;
window.ERROR_MAP = ERROR_MAP;
window._heartbeatTimer = _heartbeatTimer;
window.startHeartbeat = startHeartbeat;
window.pauseHeartbeat = pauseHeartbeat;
window.resumeHeartbeat = resumeHeartbeat;
window.stopHeartbeat = stopHeartbeat;

// ===== 自定义弹窗组件（替换原生alert/confirm） =====
var _activeDialog = null;

function showDialog(title, message, opts) {
  if (!opts) opts = {};
  if (_activeDialog) _activeDialog.remove();
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:500;display:flex;align-items:center;justify-content:center;animation:fadeIn .2s ease';
  var card = document.createElement('div');
  card.style.cssText = 'background:var(--bg-primary);border:0.5px solid var(--border-color);border-radius:12px;padding:20px 24px;max-width:380px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.18);animation:msgSlideIn .25s ease-out';
  var icon = opts.type === 'danger' ? '!' : 'i';
  var iconBg = opts.type === 'danger' ? 'rgba(239,68,68,.1)' : 'rgba(96,165,250,.1)';
  var iconColor = opts.type === 'danger' ? 'var(--error-color)' : 'var(--accent-color)';
  var html = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">' +
    '<div style="width:28px;height:28px;border-radius:50%;background:' + iconBg + ';display:flex;align-items:center;justify-content:center;font-size:14px;color:' + iconColor + ';flex-shrink:0">' + icon + '</div>' +
    '<span style="font-size:14px;font-weight:600;color:var(--text-primary)">' + esc(title) + '</span></div>' +
    '<p style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin:0 0 16px 0">' + esc(message) + '</p>';
  if (opts.confirm) {
    var confirmLabel = opts.confirmLabel || '确定';
    var cancelLabel = opts.cancelLabel || '取消';
    var confirmStyle = opts.type === 'danger' ? 'background:var(--error-color);color:var(--text-on-accent, #fff);border:none' : 'background:var(--accent-color);color:var(--text-on-accent, #fff);border:none';
    html += '<div style="display:flex;gap:8px;justify-content:flex-end">' +
      '<button class="dialog-cancel-btn" style="padding:6px 16px;border:0.5px solid var(--border-color);border-radius:6px;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:13px">' + esc(cancelLabel) + '</button>' +
      '<button class="dialog-confirm-btn" style="padding:6px 16px;border-radius:6px;cursor:pointer;font-size:13px;' + confirmStyle + '">' + esc(confirmLabel) + '</button></div>';
  } else {
    html += '<div style="display:flex;gap:8px;justify-content:flex-end">' +
      '<button class="dialog-ok-btn" style="padding:6px 20px;border:none;border-radius:6px;background:var(--accent-color);color:var(--text-on-accent, #fff);cursor:pointer;font-size:13px">确定</button></div>';
  }
  card.innerHTML = html;
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  _activeDialog = overlay;
  return new Promise(function(resolve) {
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) { overlay.remove(); _activeDialog = null; resolve(false); }
    });
    var okBtn = card.querySelector('.dialog-ok-btn');
    var confirmBtn = card.querySelector('.dialog-confirm-btn');
    var cancelBtn = card.querySelector('.dialog-cancel-btn');
    if (okBtn) okBtn.addEventListener('click', function() { overlay.remove(); _activeDialog = null; resolve(true); });
    if (confirmBtn) confirmBtn.addEventListener('click', function() { overlay.remove(); _activeDialog = null; resolve(true); });
    if (cancelBtn) cancelBtn.addEventListener('click', function() { overlay.remove(); _activeDialog = null; resolve(false); });
    document.addEventListener('keydown', function handler(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', handler); overlay.remove(); _activeDialog = null; resolve(false); }
      if (e.key === 'Enter') { document.removeEventListener('keydown', handler); overlay.remove(); _activeDialog = null; resolve(true); }
    });
    // 自动聚焦确认按钮，方便回车确认
    if (confirmBtn) confirmBtn.focus();
    else if (okBtn) okBtn.focus();
  });
}

// 暴露到全局
window.showDialog = showDialog;

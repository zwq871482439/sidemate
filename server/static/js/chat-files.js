// ===== chat-files.js — 文件/附件相关 =====
// 依赖: api.js, utils.js, 全局变量 _refFilePath, pendingFile

var _attachMenuOpen = false;

function toggleAttachMenu() {
  var menu = document.getElementById('attachMenu');
  if (!menu) return;
  _attachMenuOpen = !_attachMenuOpen;
  menu.style.display = _attachMenuOpen ? 'block' : 'none';
  if (_attachMenuOpen) {
    setTimeout(function() {
      document.addEventListener('click', _closeAttachMenu, {once: true});
    }, 50);
  }
}

function _closeAttachMenu(e) {
  var menu = document.getElementById('attachMenu');
  var btn = document.getElementById('attachBtn');
  if (!menu) return;
  if (e && (menu.contains(e.target) || (btn && btn.contains(e.target)))) {
    // 点击在菜单或按钮内部，重新绑定一次
    setTimeout(function() {
      document.addEventListener('click', _closeAttachMenu, {once: true});
    }, 50);
    return;
  }
  _attachMenuOpen = false;
  menu.style.display = 'none';
}

function doAttachUpload() {
  // Patch4 v3.1 BUG#24：同 doAttachKb，先阻止冒泡再关菜单
  if (window.event && typeof window.event.stopPropagation === 'function') {
    window.event.stopPropagation();
  }
  var menu = document.getElementById('attachMenu');
  if (menu) menu.style.display = 'none';
  _attachMenuOpen = false;
  document.removeEventListener('click', _closeAttachMenu);
  document.getElementById('unifiedInput').click();
}

function doAttachKb() {
  // Patch4 v3.1 BUG#24：先阻止冒泡再关菜单，避免 document 上的 once 监听器
  // 在 pickKbFile 的 picker.click() 之前消费掉，导致原生 select 不弹
  if (window.event && typeof window.event.stopPropagation === 'function') {
    window.event.stopPropagation();
  }
  // 直接关菜单 DOM，不走 _closeAttachMenu（避免 event 缺失导致逻辑错乱）
  var menu = document.getElementById('attachMenu');
  if (menu) menu.style.display = 'none';
  _attachMenuOpen = false;
  // 移除 document 上残留的 once 监听器（如果有的话）
  document.removeEventListener('click', _closeAttachMenu);
  pickKbFile();
}

var _pendingFileName = '';
var _pendingFileSource = '';

function showFileIndicator(name, source) {
  _pendingFileName = name;
  _pendingFileSource = source || 'upload';
  var bar = document.getElementById('fileIndicatorBar');
  if (!bar) return;
  bar.style.display = 'flex';
  bar.innerHTML = '<span class="file-indicator-tag">' +
    (_pendingFileSource === 'kb' ? iconSvg('books','12') : iconSvg('file','12')) +
    ' ' + esc(name) +
    '</span>' +
    '<button class="file-indicator-remove" onclick="clearPendingFile(event)" title="移除">' + iconSvg('close','12') + '</button>';
}

function hideFileIndicator() {
  _pendingFileName = '';
  _pendingFileSource = '';
  var bar = document.getElementById('fileIndicatorBar');
  if (bar) { bar.style.display = 'none'; bar.innerHTML = ''; }
  // P6 打磨 bug1: 清除文件后刷新 token 计数
  if (typeof TokenEstimator !== 'undefined' && TokenEstimator.updateInputDisplay) {
    TokenEstimator.updateInputDisplay();
  }
}

function clearPendingFile(e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  hideFileIndicator();
  if (typeof pendingFile !== 'undefined') pendingFile = null;
  if (typeof _refFilePath !== 'undefined') _refFilePath = null;
  var input = document.getElementById('unifiedInput');
  if (input) input.value = '';
  // 清除 KB 文件引用状态
  var kbPicker = document.getElementById('kbFilePickerSelect');
  if (kbPicker) kbPicker.value = '';
}
window.clearPendingFile = clearPendingFile;

function pickKbFile() {
  // Patch4 v3.1 BUG#24 重写：用自定义模态弹窗替代原生 select
  // 原生 select 在不可见区域 + 异步 click() 时浏览器拒绝弹下拉
  // 新方案：动态创建模态弹窗，支持多选

  fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/documents')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var files = Array.isArray(data) ? data : (data.files || []);
      // 只显示 ready 状态的文档
      files = files.filter(function(f) { return f.status === 'ready'; });

      if (files.length === 0) {
        if (typeof showToast === 'function') showToast('文库中没有文档，请先上传', 'warning');
        return;
      }

      _showKbPickerModal(files);
    })
    .catch(function(e) {
      console.error('[chat.pickKbFile]', e);
      if (typeof showToast === 'function') showToast('获取文库文件列表失败', 'error');
    });
}

// Patch4 v3.1 BUG#24：自定义 KB 选择器模态弹窗
var _kbSelectedDocs = [];  // 已选文档（多选）

function _showKbPickerModal(files) {
  // 移除已有的弹窗
  var existing = document.getElementById('kbPickerModal');
  if (existing) existing.remove();

  _kbSelectedDocs = [];

  // 创建遮罩
  var overlay = document.createElement('div');
  overlay.id = 'kbPickerModal';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:9999;display:flex;align-items:center;justify-content:center';

  // 弹窗卡片
  var card = document.createElement('div');
  card.style.cssText = 'background:var(--bg-primary,#fff);border-radius:12px;width:90%;max-width:520px;max-height:75vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.2)';

  // 头部
  var header = document.createElement('div');
  header.style.cssText = 'padding:16px 20px;border-bottom:1px solid var(--border-color,#e5e5e5);display:flex;justify-content:space-between;align-items:center';
  header.innerHTML = '<div style="font-weight:500;font-size:15px;color:var(--text-primary,#333)">选择文库文档</div>';
  var closeBtn = document.createElement('button');
  closeBtn.innerHTML = iconSvg ? iconSvg('close', '16') : '×';
  closeBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:var(--text-muted,#999);padding:4px;border-radius:4px';
  closeBtn.onclick = function() { overlay.remove(); };
  header.appendChild(closeBtn);
  card.appendChild(header);

  // 提示
  var hint = document.createElement('div');
  hint.style.cssText = 'padding:8px 20px;font-size:12px;color:var(--text-muted,#999)';
  hint.textContent = '可多选，选中的文档内容会注入到对话中';
  card.appendChild(hint);

  // 列表区（可滚动）
  var listWrap = document.createElement('div');
  listWrap.style.cssText = 'flex:1;overflow-y:auto;padding:4px 12px';

  files.forEach(function(f) {
    var item = document.createElement('div');
    item.style.cssText = 'padding:10px 12px;margin:2px 0;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:10px;transition:background .15s';
    item._docId = f.doc_id;
    item._filename = f.filename;
    item.onmouseenter = function() { item.style.background = 'var(--bg-secondary,#f5f5f5)'; };
    item.onmouseleave = function() {
      if (item._selected !== true) item.style.background = 'transparent';
    };
    item.onclick = function() {
      item._selected = !item._selected;
      if (item._selected) {
        item.style.background = 'var(--primary-50,#e6f0ff)';
        item.style.color = 'var(--accent-color,#185FA5)';
        _kbSelectedDocs.push({doc_id: f.doc_id, filename: f.filename, file_size: f.file_size || 0, total_chars: f.total_chars || 0});
      } else {
        item.style.background = 'transparent';
        item.style.color = '';
        _kbSelectedDocs = _kbSelectedDocs.filter(function(d) { return d.doc_id !== f.doc_id; });
      }
      // P6 打磨 bug3: 选择/取消 KB 文档后刷新 token 计数
      window._kbSelectedFiles = _kbSelectedDocs.slice();  // 同步给 token estimator
      if (typeof TokenEstimator !== 'undefined' && TokenEstimator.updateInputDisplay) {
        TokenEstimator.updateInputDisplay();
      }
      // 更新底部按钮文案
      var selCount = _kbSelectedDocs.length;
      var totalChars = 0;
      for (var i = 0; i < _kbSelectedDocs.length; i++) {
        totalChars += (_kbSelectedDocs[i].total_chars || 0);
      }
      var totalTokens = Math.ceil(totalChars / 1.5);  // 中文 token 估算
      var maxTokens = (typeof _maxPromptTokens !== 'undefined') ? _maxPromptTokens : 8192;
      var overLimit = totalTokens > maxTokens * 0.85;  // 85% 阈值

      var btnText = selCount > 0
        ? ('确认引用（' + selCount + '篇' + (totalTokens > 0 ? ' · 约' + (totalTokens/1000).toFixed(1) + 'K词元' : '') + '）')
        : '确认引用';

      if (overLimit) {
        btnText += ' — 超出容量限制';
        confirmBtn.style.cssText = confirmBtn.style.cssText + ';opacity:.5;cursor:not-allowed';
      } else {
        confirmBtn.style.cssText = confirmBtn.style.cssText.replace(';opacity:.5;cursor:not-allowed', '');
      }

      confirmBtn.disabled = selCount === 0 || overLimit;
      confirmBtn.textContent = btnText;
    };

    var iconSpan = document.createElement('span');
    iconSpan.innerHTML = iconSvg ? iconSvg('doc', '16') : iconSvg('doc', '16');
    iconSpan.style.cssText = 'flex-shrink:0';

    var nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px';
    nameSpan.textContent = f.filename || f.name;

    var metaSpan = document.createElement('span');
    metaSpan.style.cssText = 'font-size:11px;color:var(--text-muted,#999);flex-shrink:0';
    var tags = (f.tags && f.tags.length) ? f.tags.slice(0, 2).join(' / ') : '';
    // P6 打磨 bug2: 显示词元数而非段数
    var tokenEst = f.total_chars ? '约 ' + (Math.ceil(f.total_chars/1.5)/1000).toFixed(1) + 'K 词元' : (f.file_size ? '约 ' + Math.ceil(f.file_size/1024*200).toFixed(0) + ' 词元' : '');
    metaSpan.textContent = (tokenEst || '未知大小') + (tags ? ' · ' + tags : '');

    item.appendChild(iconSpan);
    item.appendChild(nameSpan);
    item.appendChild(metaSpan);
    listWrap.appendChild(item);
  });
  card.appendChild(listWrap);

  // 底部按钮
  var footer = document.createElement('div');
  footer.style.cssText = 'padding:12px 20px;border-top:1px solid var(--border-color,#e5e5e5);display:flex;justify-content:flex-end;gap:8px';

  var cancelBtn = document.createElement('button');
  cancelBtn.textContent = '取消';
  cancelBtn.style.cssText = 'padding:8px 16px;border:1px solid var(--border-color,#e5e5e5);background:var(--bg-primary,#fff);border-radius:6px;cursor:pointer;font-size:13px;color:var(--text-secondary,#666)';
  cancelBtn.onclick = function() { overlay.remove(); };

  var confirmBtn = document.createElement('button');
  confirmBtn.textContent = '确认引用';
  confirmBtn.disabled = true;
  confirmBtn.style.cssText = 'padding:8px 16px;border:none;background:var(--accent-color,#185FA5);color:#fff;border-radius:6px;cursor:pointer;font-size:13px';
  confirmBtn.style.opacity = '0.5';
  confirmBtn.onclick = function() {
    if (_kbSelectedDocs.length === 0) return;
    // 单选兼容旧逻辑（_refFilePath / pendingFile 只支持单个，取第一个）
    var first = _kbSelectedDocs[0];
    if (typeof _refFilePath !== 'undefined') _refFilePath = first.doc_id;
    if (typeof pendingFile !== 'undefined') {
      // 多选时把所有 doc_id 拼成逗号分隔，后端按逗号拆分（如支持）
      var allIds = _kbSelectedDocs.map(function(d) { return d.doc_id; }).join(',');
      pendingFile = {name: _kbSelectedDocs.length > 1 ? (_kbSelectedDocs.length + ' 篇文库文档') : first.filename, path: allIds, source: 'kb'};
    }
    // 显示文件指示器
    var displayName = _kbSelectedDocs.length > 1
      ? (_kbSelectedDocs.length + ' 篇文库文档')
      : first.filename;
    showFileIndicator(displayName, 'kb');
    // 多选时把所有文件名存到 window._kbSelectedFiles 供后端使用
    window._kbSelectedFiles = _kbSelectedDocs.slice();
    if (typeof showToast === 'function') showToast('已引用 ' + _kbSelectedDocs.length + ' 篇文库文档', 'success');
    overlay.remove();
  };
  // disabled 状态视觉同步
  var _origOnclick = confirmBtn.onclick;
  confirmBtn.addEventListener('click', function() {
    if (confirmBtn.disabled) return;
  }, true);

  footer.appendChild(cancelBtn);
  footer.appendChild(confirmBtn);
  card.appendChild(footer);

  // disabled 视觉联动
  var _updateDisabled = function() {
    confirmBtn.style.opacity = _kbSelectedDocs.length === 0 ? '0.5' : '1';
  };
  // 覆盖 item.onclick 的尾部来更新 disabled
  var origItemOnclicks = Array.prototype.slice.call(listWrap.children).map(function(item) {
    var orig = item.onclick;
    item.onclick = function(e) {
      orig && orig.call(item, e);
      _updateDisabled();
    };
  });

  overlay.appendChild(card);
  // 点遮罩关闭
  overlay.onclick = function(e) {
    if (e.target === overlay) overlay.remove();
  };

  document.body.appendChild(overlay);
}
window._showKbPickerModal = _showKbPickerModal;

function onUnifiedPicked(e) {
  var file = e.target.files && e.target.files[0];
  if (!file) return;

  // 更新文件引用
  if (typeof _refFilePath !== 'undefined') _refFilePath = file.name;
  if (typeof pendingFile !== 'undefined') pendingFile = file;

  showFileIndicator(file.name, 'upload');
  if (typeof showToast !== 'function') {} else showToast('已选择: ' + file.name, 'success');

  // Patch5 G：任何模式下都立即上传到 session workspace/，拿到真实 path 和 tokens
  // 没有当前会话则先新建（否则后端 fallback 到 cache/uploads，污染全局）
  var _doUpload = function() {
    var formData = new FormData();
    formData.append('file', file);
    formData.append('mode', 'chat_attach');
    var _preChatId = '';
    if (typeof currentChatFile !== 'undefined' && currentChatFile) {
      _preChatId = currentChatFile.split(/[\\/]/).pop().replace('.json','');
    }
    var _preUrl = (typeof API !== 'undefined' ? API : '') + '/api/file_upload';
    if (_preChatId) _preUrl += '?chat_id=' + encodeURIComponent(_preChatId);
    fetch(_preUrl, {
      method: 'POST',
      body: formData
    }).then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.path) {
          if (typeof pendingFile !== 'undefined') pendingFile = {
            name: file.name, path: d.path, source: 'upload',
            tokens: d.tokens || 0, size: file.size || 0
          };
          if (typeof TokenEstimator !== 'undefined' && TokenEstimator.updateInputDisplay) {
            TokenEstimator.updateInputDisplay();
          }
          if (typeof showToast === 'function') showToast('文件已上传', 'success');
        } else {
          if (typeof showToast === 'function') showToast(d.error || '上传失败', 'error');
          clearPendingFile();
        }
      })
      .catch(function() {
        if (typeof showToast === 'function') showToast('上传失败', 'error');
        clearPendingFile();
      });
  };

  // Patch5 G：没有 session 则先新建会话再上传，避免后端 fallback 到 cache/uploads
  if (typeof currentChatFile === 'undefined' || !currentChatFile) {
    if (typeof newChat === 'function') {
      newChat().then(_doUpload).catch(function() {
        if (typeof showToast === 'function') showToast('创建会话失败，请手动新建', 'error');
      });
    } else {
      _doUpload();
    }
  } else {
    _doUpload();
  }

  // 重置 input 以便再次选择同一文件
  e.target.value = '';
}

window.toggleAttachMenu = toggleAttachMenu;
window.doAttachUpload = doAttachUpload;
window.doAttachKb = doAttachKb;
window.showFileIndicator = showFileIndicator;
window.hideFileIndicator = hideFileIndicator;
window.pickKbFile = pickKbFile;
window.onUnifiedPicked = onUnifiedPicked;

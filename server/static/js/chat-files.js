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

  // KB 多文档：可点击展开浮窗，单独取消
  var kbFiles = (typeof window !== 'undefined' && window._kbSelectedFiles) ? window._kbSelectedFiles : [];
  if (source === 'kb' && kbFiles.length > 1) {
    bar.innerHTML = '<span class="file-indicator-tag" onclick="toggleFileIndicatorPopup()">' +
      iconSvg('books','12') + ' ' + esc(name) +
      '</span>' +
      '<button class="file-indicator-remove" onclick="clearPendingFile(event)" title="全部移除">' + iconSvg('close','12') + '</button>';
    // 构建浮窗
    var popup = document.createElement('div');
    popup.className = 'file-indicator-popup';
    popup.id = 'fileIndicatorPopup';
    kbFiles.forEach(function(f, idx) {
      // 词元估算：优先用 total_chars/1.5，无则用 file_size 估算
      var tokEst = 0;
      if (f.total_chars) tokEst = Math.ceil(f.total_chars / 1.5);
      else if (f.file_size) tokEst = Math.ceil(f.file_size / 1024 * 200);
      var tokStr = tokEst > 0 ? (tokEst >= 1000 ? (tokEst/1000).toFixed(1)+'K词元' : tokEst+'词元') : '';
      var item = document.createElement('div');
      item.className = 'file-indicator-popup-item';
      item.innerHTML = '<span class="pip-name">' + iconSvg('doc','11') + ' ' + esc(f.filename || f.doc_id || ('文档'+(idx+1))) + '</span>' +
        (tokStr ? '<span class="pip-tok">' + tokStr + '</span>' : '') +
        '<button class="pip-remove" onclick="removeSingleKbDoc(' + idx + ')" title="移除">' + iconSvg('close','11') + '</button>';
      popup.appendChild(item);
    });
    bar.appendChild(popup);
  } else {
    bar.innerHTML = '<span class="file-indicator-tag">' +
      (_pendingFileSource === 'kb' ? iconSvg('books','12') : iconSvg('file','12')) +
      ' ' + esc(name) +
      '</span>' +
      '<button class="file-indicator-remove" onclick="clearPendingFile(event)" title="移除">' + iconSvg('close','12') + '</button>';
  }
}

// 切换浮窗显隐
function toggleFileIndicatorPopup() {
  var popup = document.getElementById('fileIndicatorPopup');
  if (popup) popup.classList.toggle('show');
}
window.toggleFileIndicatorPopup = toggleFileIndicatorPopup;

// 单独移除一篇文档（KB 或上传文件，统一处理）
function removeSingleKbDoc(idx) {
  // 判断来源：上传文件还是 KB 文档
  var isUpload = (_pendingFileSource === 'upload') || (window._uploadedFiles && window._uploadedFiles.length > 0 && (!window._kbSelectedFiles || !window._kbSelectedFiles.length));
  if (isUpload) {
    if (!window._uploadedFiles) return;
    window._uploadedFiles.splice(idx, 1);
    if (window._uploadedFiles.length === 0) {
      clearPendingFile();
      return;
    }
    _syncUploadedPending();
    _refreshUploadIndicator();
  } else {
    if (!window._kbSelectedFiles) return;
    window._kbSelectedFiles.splice(idx, 1);
    if (window._kbSelectedFiles.length === 0) {
      clearPendingFile();
      return;
    }
    if (typeof pendingFile !== 'undefined') {
      var allIds = window._kbSelectedFiles.map(function(d) { return d.doc_id; }).join(',');
      pendingFile = {name: window._kbSelectedFiles.length + ' 篇知识库文档', path: allIds, source: 'kb'};
    }
    showFileIndicator(window._kbSelectedFiles.length + ' 篇知识库文档', 'kb');
  }
  // 重新展开浮窗 + 刷新 token
  var popup = document.getElementById('fileIndicatorPopup');
  if (popup) popup.classList.add('show');
  if (typeof TokenEstimator !== 'undefined' && TokenEstimator.updateInputDisplay) {
    TokenEstimator.updateInputDisplay();
  }
}
window.removeSingleKbDoc = removeSingleKbDoc;

// 统一清理引用/附件状态（新会话、切换会话时调用）。
// 之前 newChat 只清 pendingFile + 指示器，_refFilePath / _uploadedFiles / _kbSelectedFiles
// 跨会话残留，导致 A 会话的引用被悄悄带进 B 会话的首条消息。
function resetAttachState() {
  if (typeof pendingFile !== 'undefined') pendingFile = null;
  if (typeof _refFilePath !== 'undefined') _refFilePath = null;
  window._uploadedFiles = [];
  window._kbSelectedFiles = [];
  hideFileIndicator();
  if (typeof TokenEstimator !== 'undefined' && TokenEstimator.updateInputDisplay) {
    try { TokenEstimator.updateInputDisplay(); } catch (e) {}
  }
}
window.resetAttachState = resetAttachState;

function hideFileIndicator() {
  _pendingFileName = '';
  _pendingFileSource = '';
  var bar = document.getElementById('fileIndicatorBar');
  if (bar) { bar.style.display = 'none'; bar.innerHTML = ''; }
  // 注：TokenEstimator 由调用方在清理 pendingFile 后手动触发
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
  // P6: 清理 KB 选择状态
  if (typeof _kbSelectedDocs !== 'undefined') _kbSelectedDocs = [];
  if (typeof window !== 'undefined') {
    window._kbSelectedFiles = [];
    window._uploadedFiles = [];  // 清理上传文件状态
  }
  // P6: 清理文件后刷新 token（必须在 pendingFile=null 之后）
  if (typeof TokenEstimator !== 'undefined' && TokenEstimator.updateInputDisplay) {
    TokenEstimator.updateInputDisplay();
  }
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
        if (typeof showToast === 'function') showToast('知识库中没有文档，请先上传', 'warning');
        return;
      }

      _showKbPickerModal(files);
    })
    .catch(function(e) {
      console.error('[chat.pickKbFile]', e);
      if (typeof showToast === 'function') showToast('获取知识库文件列表失败', 'error');
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
  header.innerHTML = '<div style="font-weight:500;font-size:15px;color:var(--text-primary,#333)">选择知识库文档</div>';
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
      // P6: 检测剩余容量，不是纯上限
      var historyUsed = (typeof _historyTokenCount !== 'undefined') ? (_historyTokenCount || 0) : 0;
      var remainTokens = Math.max(0, maxTokens * 0.85 - historyUsed);
      var overLimit = totalTokens > remainTokens && remainTokens > 0;

      var btnText = selCount > 0
        ? ('确认引用（' + selCount + '篇' + (totalTokens > 0 ? ' · 约' + (totalTokens/1000).toFixed(1) + 'K词元' : '') + '）')
        : '确认引用';

      if (overLimit) {
        var overflowK = ((totalTokens - remainTokens) / 1000).toFixed(1);
        btnText += ' — 超出剩余容量 (超出 ' + overflowK + 'K 词元)';
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
      pendingFile = {name: _kbSelectedDocs.length > 1 ? (_kbSelectedDocs.length + ' 篇知识库文档') : first.filename, path: allIds, source: 'kb'};
    }
    // 显示文件指示器
    var displayName = _kbSelectedDocs.length > 1
      ? (_kbSelectedDocs.length + ' 篇知识库文档')
      : first.filename;
    showFileIndicator(displayName, 'kb');
    // 多选时把所有文件名存到 window._kbSelectedFiles 供后端使用
    window._kbSelectedFiles = _kbSelectedDocs.slice();
    if (typeof showToast === 'function') showToast('已引用 ' + _kbSelectedDocs.length + ' 篇知识库文档', 'success');
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
  var files = e.target.files;
  if (!files || !files.length) return;
  // 多文件：收集到 window._uploadedFiles
  if (typeof window._uploadedFiles === 'undefined') window._uploadedFiles = [];
  var fileArr = [];
  for (var fi = 0; fi < files.length; fi++) fileArr.push(files[fi]);

  var _doUploadAll = function() {
    var _preChatId = '';
    if (typeof currentChatFile !== 'undefined' && currentChatFile) {
      _preChatId = currentChatFile.split(/[\\/]/).pop().replace('.json','');
    }
    var uploaded = 0;
    fileArr.forEach(function(file) {
      var formData = new FormData();
      formData.append('file', file);
      formData.append('mode', 'chat_attach');
      var _preUrl = (typeof API !== 'undefined' ? API : '') + '/api/file_upload';
      if (_preChatId) _preUrl += '?chat_id=' + encodeURIComponent(_preChatId);
      fetch(_preUrl, { method: 'POST', body: formData })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.path) {
            window._uploadedFiles.push({
              filename: file.name,
              path: d.path,
              tokens: d.tokens || 0,
              file_size: file.size || 0,
              source: 'upload'
            });
            uploaded++;
            // 更新 pendingFile（多文件用数组第一个 path，或后端支持的逗号拼接）
            _syncUploadedPending();
            _refreshUploadIndicator();
            if (typeof TokenEstimator !== 'undefined' && TokenEstimator.updateInputDisplay) {
              TokenEstimator.updateInputDisplay();
            }
            if (uploaded === fileArr.length && typeof showToast === 'function') {
              showToast(fileArr.length + ' 个文件已上传', 'success');
            }
          } else {
            if (typeof showToast === 'function') showToast((d.error || '上传失败') + ': ' + file.name, 'error');
          }
        })
        .catch(function() {
          if (typeof showToast === 'function') showToast('上传失败: ' + file.name, 'error');
        });
    });
  };

  // 先显示指示器（上传中）
  _refreshUploadIndicator();

  if (typeof currentChatFile === 'undefined' || !currentChatFile) {
    if (typeof newChat === 'function') {
      newChat().then(_doUploadAll).catch(function() {
        if (typeof showToast === 'function') showToast('创建会话失败，请手动新建', 'error');
      });
    } else {
      _doUploadAll();
    }
  } else {
    _doUploadAll();
  }
  // 清空 input 允许重复选同一文件
  e.target.value = '';
}

// 同步 pendingFile 从 _uploadedFiles
function _syncUploadedPending() {
  if (typeof pendingFile === 'undefined') return;
  if (!window._uploadedFiles || !window._uploadedFiles.length) {
    pendingFile = null;
    return;
  }
  var paths = window._uploadedFiles.map(function(f) { return f.path; });
  pendingFile = {
    name: window._uploadedFiles.length > 1 ? (window._uploadedFiles.length + ' 个上传文件') : window._uploadedFiles[0].filename,
    path: paths.join(','),
    source: 'upload'
  };
}

// 刷新上传文件指示器（复用 showFileIndicator 浮窗逻辑）
function _refreshUploadIndicator() {
  var ufiles = window._uploadedFiles || [];
  if (!ufiles.length) {
    hideFileIndicator();
    return;
  }
  var name = ufiles.length > 1 ? (ufiles.length + ' 个上传文件') : ufiles[0].filename;
  // 临时把 _kbSelectedFiles 指向 _uploadedFiles，复用浮窗渲染
  var savedKb = window._kbSelectedFiles;
  window._kbSelectedFiles = ufiles.map(function(f) {
    return { filename: f.filename, doc_id: f.path, total_chars: f.tokens ? f.tokens * 1.5 : 0, file_size: f.file_size };
  });
  showFileIndicator(name, 'kb');  // 用 'kb' 走浮窗逻辑
  window._kbSelectedFiles = savedKb;  // 恢复
}

window.toggleAttachMenu = toggleAttachMenu;
window.doAttachUpload = doAttachUpload;
window.doAttachKb = doAttachKb;
window.showFileIndicator = showFileIndicator;
window.hideFileIndicator = hideFileIndicator;
window.pickKbFile = pickKbFile;
window.onUnifiedPicked = onUnifiedPicked;

// 0.9.7: 附件操作栏显隐控制
// 知识库问答(kb_qa)模式下不显示附件栏（KB 自动检索，手动附加会重复）
function _shouldShowAttachToolbar() {
  if (typeof currentActionMode === 'undefined') return true;
  // kb_qa 模式下不显示
  if (currentActionMode === 'kb_qa') return false;
  return true;
}

function onInputFocus() {
  if (_shouldShowAttachToolbar()) {
    var el = document.getElementById('attachToolbar');
    if (el) el.classList.add('show');
  }
}

function onInputBlur() {
  setTimeout(function() {
    var el = document.getElementById('attachToolbar');
    if (el) el.classList.remove('show');
  }, 200);
}

// 切换 action_mode 时调用（隐藏时不显示即使聚焦）
function updateAttachToolbarVisibility() {
  var el = document.getElementById('attachToolbar');
  if (!el) return;
  var input = document.getElementById('msgInput');
  var isFocused = input && document.activeElement === input;
  if (isFocused && _shouldShowAttachToolbar()) {
    el.classList.add('show');
  } else {
    el.classList.remove('show');
  }
}

window.onInputFocus = onInputFocus;
window.onInputBlur = onInputBlur;
window.updateAttachToolbarVisibility = updateAttachToolbarVisibility;

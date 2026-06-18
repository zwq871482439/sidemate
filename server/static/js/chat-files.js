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
  var picker = document.getElementById('kbFilePickerSelect');
  if (!picker) return;

  // 动态获取文库文件列表
  // Patch4 v3.1 BUG#14：API 路径修正 /api/kb/files → /api/kb/documents
  // 返回是数组（不是 {files: [...]}），字段名也不同（doc_id/filename/chunk_count）
  fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/documents')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      // /api/kb/documents 直接返回数组，每项含 doc_id/filename/chunk_count/status
      var files = Array.isArray(data) ? data : (data.files || []);
      picker.innerHTML = '';
      files.forEach(function(f) {
        var opt = document.createElement('option');
        // 用 doc_id 作为引用值（后端按 doc_id 查文档全文）
        opt.value = f.doc_id || f.path || f.name;
        opt.textContent = (f.filename || f.name) + (f.chunk_count ? ' (' + f.chunk_count + '段)' : '');
        picker.appendChild(opt);
      });

      if (files.length === 0) {
        if (typeof showToast === 'function') showToast('文库中没有文档，请先上传', 'warning');
        return;
      }

      // 触发选择（使用原生 select 弹窗）
      picker.focus();
      picker.click();

      // 监听选择变化
      var handler = function() {
        var selected = picker.value;
        if (!selected) return;
        // Patch4 v3.1 BUG#14：用 doc_id 匹配，filename 显示
        var selFile = files.find(function(f) { return (f.doc_id || f.path || f.name) === selected; });
        if (selFile) {
          var _docId = selFile.doc_id || selFile.path || selFile.name;
          var _fname = selFile.filename || selFile.name;
          if (typeof _refFilePath !== 'undefined') _refFilePath = _docId;
          showFileIndicator(_fname, 'kb');
          if (typeof pendingFile !== 'undefined') pendingFile = {name: _fname, path: _docId, source: 'kb'};
          if (typeof showToast === 'function') showToast('已引用文库: ' + _fname, 'success');
        }
        picker.removeEventListener('change', handler);
      };
      picker.addEventListener('change', handler, {once: true});
    })
    .catch(function(e) {
      console.error('[chat.pickKbFile]', e);
      if (typeof showToast === 'function') showToast('获取文库文件列表失败', 'error');
    });
}

function onUnifiedPicked(e) {
  var file = e.target.files && e.target.files[0];
  if (!file) return;

  // 更新文件引用
  if (typeof _refFilePath !== 'undefined') _refFilePath = file.name;
  if (typeof pendingFile !== 'undefined') pendingFile = file;

  showFileIndicator(file.name, 'upload');
  if (typeof showToast === 'function') showToast('已选择: ' + file.name, 'success');

  // 触发上传（如果是 chat 模式下的文件附件）
  if (typeof currentActionMode !== 'undefined' && currentActionMode === 'chat') {
    var formData = new FormData();
    formData.append('file', file);
    formData.append('mode', 'chat_attach');
    fetch((typeof API !== 'undefined' ? API : '') + '/api/upload', {
      method: 'POST',
      body: formData
    }).then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.ok) {
          if (typeof pendingFile !== 'undefined') pendingFile = {name: file.name, path: d.path, source: 'upload'};
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

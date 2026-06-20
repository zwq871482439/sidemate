// ===== qa.js — 问答 Tab：文库文档管理、语义检索、问答交互 =====
// 依赖: api.js, errors.js, utils.js, 全局变量 (API, _kbBusyProcessing)
// 被引用: chat.js (updateKbLockBar), settings.js (kbRouteState)

var _kbPollTimer = null;
var _kbSessionId = 'kb-' + Date.now();
var _kbModuleStatus = null;
var _kbBusyProcessing = false;
var _kbGenerating = false;
var _kbModelsLoaded = false;
var _kbPanelCollapsed = false;
var _kbPanelCollapseInited = false;
var _kbBusyLastState = false;
var _kbAbortCtrl = null;

// --- 文档列表渲染 ---

// --- 二态状态路由 ---
async function kbRouteState() {
  var loading = document.getElementById('kbLoading');
  var onboarding = document.getElementById('kbOnboarding');
  var fullInterface = document.getElementById('kbFullInterface');

  if (loading) loading.style.display = 'flex';
  if (onboarding) onboarding.style.display = 'none';
  if (fullInterface) fullInterface.style.display = 'none';

  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/module-status');
    var status = await resp.json();
    _kbModuleStatus = status;

    if (!status.installed) {
      if (loading) loading.style.display = 'none';
      if (onboarding) onboarding.style.display = 'flex';
      return;
    }

    // 二态：已安装即显示完整界面（安装时已自动加载）
    if (loading) loading.style.display = 'none';
    if (fullInterface) fullInterface.style.display = 'flex';
    kbRefreshDocs();
  } catch (e) {
    silentLog('[KB] 状态路由失败:', e);
    if (loading) loading.style.display = 'none';
    if (fullInterface) fullInterface.style.display = 'flex';
    kbRefreshDocs();
  }
}

// --- 安装模块 ---
async function kbInstallModule(file) {
  if (!file || !file.name.toLowerCase().endsWith('.zip')) {
    showToast('请选择 .zip 格式的安装包', 'warning');
    return;
  }

  var dropZone = document.getElementById('kbInstallDropZone');
  var progressDiv = document.getElementById('kbInstallProgress');
  var bar = document.getElementById('kbInstallBar');
  var statusEl = document.getElementById('kbInstallStatus');

  dropZone.style.display = 'none';
  progressDiv.style.display = 'block';
  bar.style.width = '20%';
  statusEl.textContent = '正在上传安装包...';

  try {
    var formData = new FormData();
    formData.append('file', file);

    bar.style.width = '40%';
    statusEl.textContent = '正在解压并安装...';

    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/install-module', { method: 'POST', body: formData });
    var result = await resp.json();

    if (resp.ok && result.success) {
      bar.style.width = '100%';
      statusEl.innerHTML = iconSvg('check','16') + ' 安装成功！模型: ' + (result.installed_models || []).join(', ');
      setTimeout(function() { kbRouteState(); }, 1500);
    } else {
      bar.style.width = '0%';
      statusEl.style.color = 'var(--error-color)';
      statusEl.innerHTML = iconSvg('cross','16') + ' ' + (result.error || '安装失败');
      setTimeout(function() {
        dropZone.style.display = 'block';
        progressDiv.style.display = 'none';
        statusEl.style.color = 'var(--accent-color)';
      }, 3000);
    }
  } catch (e) {
    bar.style.width = '0%';
    statusEl.style.color = 'var(--error-color)';
    statusEl.innerHTML = iconSvg('cross','16') + ' 网络错误: ' + e.message;
    setTimeout(function() {
      dropZone.style.display = 'block';
      progressDiv.style.display = 'none';
      statusEl.style.color = 'var(--accent-color)';
    }, 3000);
  }
}

function kbOnModuleFilePicked(event) {
  var file = event.target.files[0];
  if (file) kbInstallModule(file);
}

function kbOnModuleDrop(event) {
  event.preventDefault();
  var file = event.dataTransfer.files[0];
  if (file) kbInstallModule(file);
}

// updateChatOverlay — 由 chat.js 提供（后加载覆盖）

async function kbRefreshDocs() {
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/documents');
    var docs = await resp.json();
    var listEl = document.getElementById('kbDocList');
    var countEl = document.getElementById('kbDocCount');
    var statsResp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/stats');
    var stats = await statsResp.json();

    // Patch4 v3.1 BUG#32：折叠/展开计数器统一用 stats.ready_documents
    // 之前展开用 stats.ready_documents，折叠用 docs.length，两者不一致
    var _docCount = stats.ready_documents;
    var _maxDocs = stats.max_documents || 200;
    countEl.textContent = _docCount + '/' + _maxDocs;

    var collapsedCount = document.getElementById('kbCollapsedCount');
    if (collapsedCount) collapsedCount.innerHTML = '<div style="font-weight:600;font-size:1.1em;color:var(--text-primary);line-height:1.2">' + _docCount + '</div><div style="font-size:.6em;color:var(--text-muted)">/ ' + _maxDocs + '</div>';

    _kbModelsLoaded = stats.models_loaded || false;

    // 检查 KB 模型文件是否存在（区分"文件缺失" vs "加载失败"）
    _updateKbOverlay();

    if (docs.length > 0 && !_kbPanelCollapsed && !_kbPanelCollapseInited) {
      _kbPanelCollapseInited = true;
      // 延迟折叠，等待首次数据加载完成后再执行
      setTimeout(function() {
        _kbPanelCollapsed = true;
        var panel = document.getElementById('kbLeftPanel');
        if (panel) panel.classList.add('collapsed');
        var collapsedCount = document.getElementById('kbCollapsedCount');
        if (collapsedCount) {
          // Patch4 v3.1 BUG#32：跟展开时用同一个变量（stats.ready_documents）
          collapsedCount.innerHTML = '<div style="font-weight:600;font-size:1.1em;color:var(--text-primary);line-height:1.2">' + _docCount + '</div><div style="font-size:.6em;color:var(--text-muted)">/ ' + _maxDocs + '</div>';
        }
      }, 300);
    } else if (docs.length === 0 && _kbPanelCollapsed) {
      _kbPanelCollapsed = false;
      var panel2 = document.getElementById('kbLeftPanel');
      if (panel2) panel2.classList.remove('collapsed');
    }
    if (!_kbPanelCollapseInited) _kbPanelCollapseInited = true;

    var modelTag = document.getElementById('modelTag');
    // 用 KB 自己的 embedder 状态，而非 Chat 模型标签
    var modelLoaded = _kbModelsLoaded || (stats.models_loaded === true);

    var overlay = document.getElementById('kbModelOverlay');
    if (overlay) {
      overlay.style.display = !modelLoaded ? 'flex' : 'none';
    }

    var dropZone = document.getElementById('kbDropZone');
    if (dropZone) {
      if (!modelLoaded) {
        dropZone.style.opacity = '0.4';
        dropZone.style.pointerEvents = 'none';
      } else {
        dropZone.style.opacity = '1';
        dropZone.style.pointerEvents = 'auto';
      }
    }

    var bgeTag = document.getElementById('kbBgeTag');
    if (bgeTag) {
      bgeTag.style.display = 'none';
    }

    var hasSummarizing = (stats.summarizing_documents || 0) > 0;
    _kbBusyProcessing = hasSummarizing;
    if (typeof updateKbLockBar === 'function') updateKbLockBar();

    if (!docs.length) {
      listEl.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px 0;font-size:.82em">文库为空，点击上方「上传文档」开始添加</div>';
      document.getElementById('kbEmpty').style.display = 'flex';
      document.getElementById('kbChatArea').style.display = 'none';
      return;
    }

    document.getElementById('kbEmpty').style.display = 'none';
    document.getElementById('kbChatArea').style.display = 'flex';

    var kbInput = document.getElementById('kbInput');
    var kbBtn = document.getElementById('kbSendBtn');
    if (!modelLoaded) {
      kbInput.disabled = true;
      kbInput.placeholder = iconSvg('warn','12') + ' 请先加载 AI 模型（前往设置页）';
      kbInput.style.background = 'var(--bg-tertiary)';
      kbInput.style.cursor = 'not-allowed';
      if (kbBtn) { kbBtn.disabled = true; kbBtn.style.opacity = '0.5'; kbBtn.style.cursor = 'not-allowed'; }
    } else if (hasSummarizing) {
      kbInput.disabled = true;
      kbInput.placeholder = '文档摘要生成中，请稍候...';
      kbInput.style.background = 'var(--bg-secondary)';
      kbInput.style.cursor = 'not-allowed';
      if (kbBtn) { kbBtn.disabled = true; kbBtn.style.opacity = '0.5'; kbBtn.style.cursor = 'not-allowed'; }
    } else {
      kbInput.disabled = false;
      kbInput.placeholder = '基于文库内容提问...';
      kbInput.style.background = 'var(--bg-primary)';
      kbInput.style.cursor = 'text';
      if (kbBtn) { kbBtn.disabled = false; kbBtn.style.opacity = '1'; kbBtn.style.cursor = 'pointer'; }
    }

    var svgCheck = iconSvg('check','14');
    var svgErr = iconSvg('cross','14');
    var svgStop = iconSvg('cross','14');
    var svgSpin = iconSvg('spin','14');
    var svgPause = iconSvg('pause','14');
    var svgEdit = iconSvg('write','14');
    var html = '';
    for (var di = 0; di < docs.length; di++) {
      var d = docs[di];
      var statusIcon = d.status === 'ready' ? svgCheck :
                          d.status === 'error' ? svgErr :
                          d.status === 'cancelled' ? svgStop :
                          d.status === 'summarizing' ? svgEdit :
                          d.status === 'processing' || d.status === 'indexing' ? svgSpin :
                          d.status === 'paused' ? svgPause : svgSpin;
      var sizeStr = d.file_size > 1048576 ? (d.file_size/1048576).toFixed(1)+'MB' : d.file_size > 1024 ? (d.file_size/1024).toFixed(1)+'KB' : d.file_size+'B';
      var pct = Math.round(d.progress * 100);
      var progress = d.status === 'summarizing' ?
        '<div style="background:var(--border-color);height:6px;border-radius:3px;margin:4px 0;position:relative"><div style="background:linear-gradient(90deg,var(--accent-color),var(--accent-hover));height:6px;border-radius:3px;width:'+pct+'%;animation:kbPulse 2s ease-in-out infinite;transition:width .3s"></div></div>' +
        '<div style="font-size:.72em;color:var(--accent-color);font-weight:600;margin-bottom:2px">' + svgEdit + ' 正在生成摘要... '+pct+'%（可点击取消跳过）</div>' :
        (d.progress > 0 && d.progress < 1 ?
        '<div style="background:var(--border-color);height:6px;border-radius:3px;margin:4px 0;position:relative"><div style="background:linear-gradient(90deg,var(--accent-color),var(--accent-hover));height:6px;border-radius:3px;width:'+pct+'%;transition:width .3s"></div></div>' +
        '<div style="font-size:.72em;color:var(--accent-color);font-weight:600;margin-bottom:2px">'+pct+'%</div>' : '');

      // Patch5 B1/B3: 文档项 — 新增 checkbox + 🔒 私密标记 + 热力图标记
      var canSelect = (d.status === 'ready' || d.status === 'error' || d.status === 'cancelled');
      // Patch5 修复：kb-batch.js 在 qa.js 之后加载，_kbSelectedDocs 可能未定义
      // 用 typeof + 数组兜底（kb-batch.js 加载后会替换为 Set）
      var _selectedSet = (typeof _kbSelectedDocs !== 'undefined' && _kbSelectedDocs) ? _kbSelectedDocs : [];
      var _hasMethod = (typeof _selectedSet.has === 'function');
      var isChecked = (_hasMethod && _selectedSet.has(d.doc_id)) ? 'checked' : '';
      html += '<div class="kb-doc-item" data-doc-id="'+esc(d.doc_id)+'" style="padding:8px;margin-bottom:6px;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:6px;position:relative">';
      html += '<div style="display:flex;align-items:center;gap:4px;margin-bottom:2px">';
      // B1: checkbox（只有 ready/error/cancelled 状态才可选中）
      if (canSelect) {
        html += '<input type="checkbox" class="kb-doc-checkbox" data-doc-id="'+esc(d.doc_id)+'" '+isChecked+' onchange="kbToggleSelect(\''+esc(d.doc_id)+'\')" style="width:13px;height:13px;cursor:pointer;flex-shrink:0">';
      }
      html += '<span>'+statusIcon+'</span>';
      // B3: 私密文档 🔒 标记
      if (d.is_private) {
        html += '<span class="kb-lock-icon" title="私密文档（需令牌访问）" style="font-size:.85em">🔒</span>';
      }
      html += '<b style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(d.filename)+'</b>';
      // B4: 重复标记
      if (d.metadata && d.metadata.duplicate_of) {
        html += '<span class="kb-dup-mark" title="检测到与「'+esc(d.metadata.duplicate_of)+'」重复" style="cursor:help;font-size:.85em;color:var(--warning-color)">📋</span>';
      }
      // B1: 热力图标记
      if (d.hit_count && d.hit_count > 0) {
        var fireCount = d.hit_count >= 10 ? '🔥🔥' : d.hit_count >= 3 ? '🔥' : '·';
        html += '<span class="kb-heatmap-mark" title="被检索命中 '+d.hit_count+' 次" style="font-size:.75em;color:var(--text-muted);white-space:nowrap">'+fireCount+' '+d.hit_count+'</span>';
      } else {
        html += '<span class="kb-heatmap-mark" style="display:none"></span>';
      }
      if (d.metadata && d.metadata.has_images) {
        html += '<span title="文档包含'+(d.metadata.image_count||'')+'张图片，当前版本不支持图片内容提取" style="cursor:help;font-size:.85em">' + iconSvg('file','14') + '</span>';
      }
      html += '</div>';
      // 摘要展示（前200字预览，点击展开查看全文）
      var summaryHtml = '';
      if (d.summary) {
        summaryHtml = ' · <span class="kb-preview-toggle" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display===\'none\'?\'block\':\'none\'" style="cursor:pointer;color:var(--text-muted)">' + iconSvg('doc','12') + '预览</span><div style="display:none;position:absolute;right:8px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:4px;padding:8px;font-size:.82em;color:var(--text-secondary);max-width:280px;white-space:pre-wrap;line-height:1.5;z-index:10;box-shadow:0 2px 8px rgba(0,0,0,.15)">' + esc(d.summary) + '</div>';
      }
      html += '<div style="color:var(--text-muted);font-size:.78em">'+sizeStr;
      if (d.chunk_count) html += ' · '+d.chunk_count+'块';
      if (d.total_chars) html += ' · '+(d.total_chars/1000).toFixed(1)+'K字';
      html += '</div>';

      // Patch3: 标签 + AI 摘要展示
      if (d.tag_status === 'done' && d.tags && d.tags.length > 0) {
        html += '<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:3px">';
        for (var ti = 0; ti < d.tags.length; ti++) {
          html += '<span style="font-size:.7em;padding:1px 6px;border-radius:3px;background:var(--bg-secondary);color:var(--accent-color);border:0.5px solid var(--border-color)">' + esc(d.tags[ti]) + '</span>';
        }
        html += '</div>';
        if (d.summary && d.summary.length > 0) {
          var sumText = d.summary.length > 100 ? d.summary.substring(0, 100) + '...' : d.summary;
          html += '<div style="font-size:.72em;color:var(--text-secondary);margin-top:2px;line-height:1.4">' + esc(sumText) + '</div>';
        }
      } else if (d.tag_status === 'generating') {
        html += '<div style="font-size:.7em;color:var(--accent-color);margin-top:2px">' + iconSvg('spin','10') + ' AI 正在生成标签...</div>';
      } else if (d.tag_status === 'pending' && d.status === 'ready') {
        html += '<div style="font-size:.7em;color:var(--text-muted);margin-top:2px">' + iconSvg('clock','10') + ' AI 标签排队中...</div>';
      } else if (d.tag_status === 'failed' && d.status === 'ready') {
        html += '<div style="font-size:.7em;color:var(--error-color);margin-top:2px">' + iconSvg('cross','10') + ' AI 标签失败（可重新上传）</div>';
      }

      html += progress;

      html += '<div style="margin-top:4px;display:flex;gap:4px">';
      if (d.status === 'processing' || d.status === 'indexing') {
        html += '<button onclick="kbPauseDoc(\''+d.doc_id+'\')" style="font-size:.72em;padding:2px 6px;border:1px solid var(--border-color);border-radius:3px;cursor:pointer;background:var(--bg-primary)">' + iconSvg('pause','11') + ' 暂停</button>';
        html += '<button onclick="kbCancelDoc(\''+d.doc_id+'\')" style="font-size:.72em;padding:2px 6px;border:1px solid var(--border-color);border-radius:3px;cursor:pointer;background:var(--bg-primary);color:var(--error-color)">' + iconSvg('close','11') + ' 取消</button>';
      } else if (d.status === 'summarizing') {
        html += '<button onclick="kbCancelDoc(\''+d.doc_id+'\')" style="font-size:.72em;padding:2px 6px;border:1px solid var(--border-color);border-radius:3px;cursor:pointer;background:var(--bg-primary);color:var(--error-color)">' + iconSvg('close','11') + ' 取消</button>';
      } else if (d.status === 'paused') {
        html += '<button onclick="kbResumeDoc(\''+d.doc_id+'\')" style="font-size:.72em;padding:2px 6px;border:1px solid var(--border-color);border-radius:3px;cursor:pointer;background:var(--bg-primary)">' + iconSvg('play','11') + ' 继续</button>';
        html += '<button onclick="kbCancelDoc(\''+d.doc_id+'\')" style="font-size:.72em;padding:2px 6px;border:1px solid var(--border-color);border-radius:3px;cursor:pointer;background:var(--bg-primary);color:var(--error-color)">' + iconSvg('close','11') + ' 取消</button>';
      }
      if (d.status === 'ready' || d.status === 'error' || d.status === 'cancelled') {
        html += '<button onclick="kbDeleteDoc(\''+d.doc_id+'\')" style="font-size:.72em;padding:2px 6px;border:1px solid var(--border-color);border-radius:3px;cursor:pointer;background:var(--bg-primary);color:var(--error-color);margin-left:auto">' + iconSvg('trash','12') + ' 删除</button>';
      }
      html += '</div>';
      html += '</div>';
    }
    listEl.innerHTML = html;

    // Patch5 B1/B3/B4: 渲染后触发批量操作相关更新（Tag聚类 + 热力图 + checkbox 恢复）
    if (typeof kbOnDocsRendered === 'function') kbOnDocsRendered(docs);

    var hasProcessing = docs.some(function(d) { return ['processing', 'indexing', 'summarizing'].indexOf(d.status) >= 0; });
    var hasPendingTags = docs.some(function(d) { return ['pending','generating','failed'].indexOf(d.tag_status) >= 0 && d.status === 'ready'; });
    if ((hasProcessing || hasPendingTags) && !_kbPollTimer) {
      _kbPollTimer = setInterval(kbRefreshDocs, 3000);
    } else if (!hasProcessing && !hasPendingTags && _kbPollTimer) {
      clearInterval(_kbPollTimer);
      _kbPollTimer = null;
    }
  } catch (err) {
    silentLog('[KB] 刷新文档列表失败:', err);
  }
}

// --- KB 模型遮罩（区分文件缺失 vs 加载失败） ---
async function _updateKbOverlay() {
  var overlay = document.getElementById('kbModelOverlay');
  var titleEl = document.getElementById('kbOverlayTitle');
  var descEl = document.getElementById('kbOverlayDesc');
  var btnEl = document.getElementById('kbOverlayBtn');
  var btn2El = document.getElementById('kbOverlayBtn2');

  if (!overlay || !_kbModuleStatus || !_kbModuleStatus.installed) return;

  var models = _kbModuleStatus.models || {};
  var embedderPresent = (models.embedder && models.embedder.present);
  var rerankerPresent = (models.reranker && models.reranker.present);
  var embedderLoaded = (models.embedder && models.embedder.loaded);
  var allFilesPresent = embedderPresent && rerankerPresent;
  var allLoaded = embedderLoaded;

  if (allLoaded) {
    overlay.style.display = 'none';
    return;
  }

  overlay.style.display = 'flex';

  if (!allFilesPresent) {
    // 状态1: 模型文件缺失 → 需要重装
    var missing = [];
    if (!embedderPresent) missing.push('嵌入模型');
    if (!rerankerPresent) missing.push('精排模型');
    if (titleEl) titleEl.textContent = '模型文件缺失';
    if (descEl) descEl.textContent = missing.join('、') + ' 文件未找到，请重新安装文库模块。';
    if (btnEl) { btnEl.textContent = '前往扩展管理'; btnEl.style.display = ''; }
    if (btn2El) btn2El.style.display = 'none';
  } else {
    // 状态2: 文件存在但加载失败 → 可重试
    var err = _kbModuleStatus.error || '';
    if (titleEl) titleEl.textContent = '模型加载失败';
    if (descEl) {
      var msg = '文库模型未能成功加载，请重试。';
      if (err) msg += ' 错误信息：' + err;
      descEl.textContent = msg;
    }
    if (btnEl) { btnEl.textContent = '前往扩展管理'; btnEl.style.display = ''; }
    if (btn2El) { btn2El.textContent = '重试加载'; btn2El.style.display = ''; }
  }
}

// 按钮1: 前往扩展管理
function kbOverlayAction() {
  var settingsTab = document.querySelector('[data-tab="settings"]') || document.querySelector('[onclick*="settings"]');
  if (settingsTab) settingsTab.click();
  // 延迟滚动到扩展管理区域
  setTimeout(function() {
    var extSection = document.getElementById('extensionsSection') || document.querySelector('.extensions-list');
    if (extSection) extSection.scrollIntoView({behavior: 'smooth'});
  }, 300);
}

// 按钮2: 重试加载模型
async function kbOverlayAction2() {
  var btn2 = document.getElementById('kbOverlayBtn2');
  if (btn2) { btn2.disabled = true; btn2.textContent = '加载中...'; }
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/load-models', { method: 'POST' });
    var data = await resp.json();
    if (data.ok) {
      showToast('模型加载成功');
      setTimeout(function() { kbRouteState(); }, 500);
    } else {
      showToast('加载失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (e) {
    showToast('加载请求失败: ' + e.message, 'error');
  }
  if (btn2) { btn2.disabled = false; btn2.textContent = '重试加载'; }
}

// --- 文件上传 ---
async function kbOnFilePicked(e) {
  var files = Array.from(e.target.files);
  e.target.value = '';
  for (var i = 0; i < files.length; i++) {
    await kbUploadFile(files[i]);
  }
}

async function kbOnDrop(e) {
  e.preventDefault();
  e.currentTarget.style.borderColor = 'var(--border-color)';
  var files = Array.from(e.dataTransfer.files);
  for (var i = 0; i < files.length; i++) {
    await kbUploadFile(files[i]);
  }
}

async function kbUploadFile(f) {
  var formData = new FormData();
  formData.append('file', f);
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/upload', { method: 'POST', body: formData });
    var data = await resp.json();
    if (data.ok) {
      // Word 文档含图片时提示用户
      if (data.has_images && data.image_count > 0) {
        if (typeof showToast === 'function') {
          showToast('文档包含 ' + data.image_count + ' 张图片，当前版本不支持图片内容提取', 'warning', 5000);
        }
      }
      // Patch5 B4: 去重检测提示
      if (data.duplicate_detected && data.duplicate_info) {
        var dupMsg = '📄 检测到与「' + (data.duplicate_info.existing_filename || '已有文档') + '」重复，已标记';
        showToast(dupMsg, 'warning', 6000);
      }
      kbRefreshDocs();
    } else {
      showToast('上传失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('上传失败: ' + err.message, 'error');
  }
}

// --- 文档操作 ---
async function kbDeleteDoc(docId) {
  if (!(await showDialog('确认删除', '确定删除此文档？删除后无法恢复。', {type: 'danger', confirm: true, confirmLabel: '删除', cancelLabel: '取消'}))) return;
  try {
    await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/documents/' + docId, { method: 'DELETE' });
    kbRefreshDocs();
  } catch (err) { showToast('删除失败: ' + err.message, 'error'); }
}

async function kbPauseDoc(docId) {
  try { await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/documents/' + docId + '/pause', { method: 'POST' }); kbRefreshDocs(); }
  catch (err) { showToast('操作失败: ' + err.message, 'error'); }
}

async function kbResumeDoc(docId) {
  try { await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/documents/' + docId + '/resume', { method: 'POST' }); kbRefreshDocs(); }
  catch (err) { showToast('操作失败: ' + err.message, 'error'); }
}

async function kbCancelDoc(docId) {
  if (!(await showDialog('确认取消', '确定取消处理？已处理的部分将被清理。', {type: 'danger', confirm: true, confirmLabel: '取消处理', cancelLabel: '返回'}))) return;
  try { await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/documents/' + docId + '/cancel', { method: 'POST' }); kbRefreshDocs(); }
  catch (err) { showToast('操作失败: ' + err.message, 'error'); }
}

// (kbRetrySummary 已移除 — LLM 摘要功能砍掉)

// --- 问答交互 ---
function kbAddMsg(role, text) {
  var box = document.getElementById('kbMessages');
  var div = document.createElement('div');
  var baseStyle = 'margin:8px 0;padding:8px 14px;border-radius:8px;font-size:.88em;line-height:1.55;overflow-wrap:break-word;word-break:break-word;max-width:100%;box-sizing:border-box;overflow-x:hidden;';
  if (role === 'user') {
    div.style.cssText = baseStyle + 'white-space:pre-wrap;background:var(--accent-light,#EEEDFE);text-align:right;margin-left:40px';
  } else if (role === 'ai') {
    div.style.cssText = baseStyle + 'background:var(--bg-secondary);border:1px solid var(--border-color)';
  } else {
    div.style.cssText = baseStyle + 'white-space:pre-wrap;background:var(--bg-secondary);color:var(--success-color);text-align:center;font-size:.82em';
  }
  if (role === 'ai' && text && text[0] === '<') {
    div.innerHTML = text;
  } else {
    div.textContent = text;
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

// --- 来源卡片渲染 ---
function _renderSourceCards(sources) {
  if (!sources || !sources.length) return '';
  var html = '<div class="kb-sources-header">' + iconSvg('book','14') + ' 参考资料 <span class="badge">' + sources.length + ' 条</span></div>';
  sources.forEach(function(s, i) {
    var levelTag = '';
    var vs = s.vector_score || 0;
    var sc = s.score || 0;
    // 优先用 vector_score（原始余弦分数，绝对值有意义）
    // score 可能是归一化的 blended_score，只有当 vs=0（纯 BM25 结果）时才用 score
    var relevance = vs > 0 ? vs : sc;
    if (relevance >= 0.5) levelTag = '<span style="color:var(--success-color);font-weight:600">⬤ 高度相关</span>';
    else if (relevance >= 0.15) levelTag = '<span style="color:var(--warning-color);font-weight:600">◉ 相关</span>';
    else levelTag = '<span style="color:var(--text-muted)">○ 参考</span>';
    var snippet = esc(s.text_snippet || '');
    var heading = s.heading ? esc(s.heading) : '';
    html += '<div class="kb-source-card" onclick="this.querySelector(\'.src-text\').classList.toggle(\'expanded\')">';
    html += '<div class="src-label">[' + (i + 1) + '] ' + esc(s.source_label) + ' ' + levelTag + '</div>';
    if (heading) html += '<div style="color:var(--text-muted);font-size:.9em;margin-bottom:2px">§ ' + heading + '</div>';
    html += '<div class="src-text">' + snippet + '</div>';
    html += '</div>';
  });
  return html;
}

async function kbAsk() {
  var modelTag = document.getElementById('modelTag');
  var isLocalMode = typeof _currentMode === 'undefined' || _currentMode !== 'cloud';
  if (isLocalMode && (!modelTag || modelTag.classList.contains('none'))) {
    kbAddMsg('ai', iconSvg('warn','14') + ' 请先加载 AI 模型（前往「设置」页面），再使用文库问答功能。');
    return;
  }
  if (_kbGenerating) return;

  var input = document.getElementById('kbInput');
  var text = input.value.trim();
  if (!text) return;
  input.value = '';
  kbAddMsg('user', text);

  // Patch3: 对比模式 — 走 chat/stream 管道
  if (!isLocalMode && _kbCompareEnabled) {
    await _kbAskCompareMode(text);
    return;
  }

  var aiDiv = kbAddMsg('ai', '<div class="thinking-indicator">' + iconSvg('spin','14') + ' 思考中<div class="dots"><span></span><span></span><span></span></div></div>');
  var fullAnswer = '';
  var thinkText = '';
  var thinkLen = 0;
  var sourcesHtml = '';
  var thinkFoldShown = false;  // 思考折叠指示器是否已显示

  // StreamRenderer: 节流渲染，使用全局 STREAM_RENDER_INTERVAL
  var kbRenderer = new StreamRenderer(aiDiv, {
    renderFn: function(el) {
      var html = '';
      if (thinkFoldShown && thinkLen > 0) {
        var thinkDisplay = thinkText ? esc(thinkText) : '(思考 ' + thinkLen + ' 字)';
        html += '<details style="margin-bottom:8px"><summary style="cursor:pointer;color:var(--text-muted);font-size:.85em">' + iconSvg('think','12') + ' 思考过程 (' + thinkLen + '字)</summary><div style="color:var(--text-muted);font-size:.85em;padding:8px;background:var(--bg-secondary);border-radius:4px;white-space:pre-wrap;max-height:300px;overflow-y:auto;line-height:1.5">' + thinkDisplay + '</div></details>';
      }
      html += md(fullAnswer, false) + sourcesHtml;
      if (el._streaming) {
        html += '<span class="kb-cursor" style="display:inline-block;width:2px;height:1em;background:var(--accent-color);animation:blink 1s infinite;vertical-align:middle;margin-left:2px"></span>';
      }
      el.innerHTML = html;
      document.getElementById('kbMessages').scrollTop = document.getElementById('kbMessages').scrollHeight;
    }
  });
  aiDiv._streaming = true;

  _kbGenerating = true;
  _kbAbortCtrl = new AbortController();
  var kbBtn = document.getElementById('kbSendBtn');
  if (kbBtn) { kbBtn.disabled = false; kbBtn.innerHTML = iconSvg('stop','14'); kbBtn.className = 'btn-stop'; kbBtn.onclick = function() { kbStopGeneration(); }; kbBtn.style.opacity = '1'; }

  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: text,
        session_id: _kbSessionId,
      }),
      signal: _kbAbortCtrl.signal,
    });

    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    while (true) {
      var readResult = await reader.read();
      var done = readResult.done;
      var value = readResult.value;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      var lines = buffer.split('\n');
      buffer = lines.pop();

      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        if (!line.startsWith('data: ')) continue;
        var data = line.slice(6);
        if (data === '[DONE]') continue;

        try {
          var evt = JSON.parse(data);
          if (evt.type === 'status') {
            // 状态事件 — 仅在还没收到 think/fold 时显示
            if (!thinkText && !thinkFoldShown) {
              aiDiv.innerHTML = '<div class="thinking-indicator">' + esc(evt.content) + '<div class="dots"><span></span><span></span><span></span></div></div>';
            }
          } else if (evt.type === 'think') {
            // 思考内容实时流式展示（灰色小字）
            thinkText += evt.content;
            thinkLen = thinkText.length;
            // 在回答框内显示思考过程（灰色可读文字）+ 思考中指示
            aiDiv.innerHTML =
              '<div class="kb-think-live" style="color:var(--text-muted);font-size:.85em;line-height:1.5;white-space:pre-wrap;max-height:200px;overflow-y:auto;padding:8px;background:var(--bg-secondary);border-radius:6px;border-left:3px solid var(--accent-color);margin-bottom:8px">' + esc(thinkText) + '<span class="kb-think-cursor" style="display:inline-block;width:2px;height:.9em;background:var(--text-muted);animation:blink 1s infinite;vertical-align:middle;margin-left:2px"></span></div>' +
              '<div class="thinking-indicator" style="font-size:.8em">' + iconSvg('spin','14') + ' 思考完成中...</div>';
            // 自动滚动到最新思考内容
            var thinkBox = aiDiv.querySelector('.kb-think-live');
            if (thinkBox) thinkBox.scrollTop = thinkBox.scrollHeight;
            document.getElementById('kbMessages').scrollTop = document.getElementById('kbMessages').scrollHeight;
          } else if (evt.type === 'fold') {
            // 思考折叠事件 — 把实时思考内容折叠成 <details>
            thinkFoldShown = true;
            thinkLen = evt.think_len || thinkText.length || 0;
            // 如果有实时思考内容，用它；否则用 "思考了 N 字"
            var thinkDisplay = thinkText ? esc(thinkText) : '(思考 ' + thinkLen + ' 字)';
            var thinkHtml = '<details style="margin-bottom:8px"><summary style="cursor:pointer;color:var(--text-muted);font-size:.85em">' + iconSvg('think','12') + ' 思考过程 (' + thinkLen + '字)</summary><div style="color:var(--text-muted);font-size:.85em;padding:8px;background:var(--bg-secondary);border-radius:4px;white-space:pre-wrap;max-height:300px;overflow-y:auto;line-height:1.5">' + thinkDisplay + '</div></details>';
            aiDiv.innerHTML = thinkHtml + '<div class="thinking-indicator">' + iconSvg('write','14') + ' 生成回答中<div class="dots"><span></span><span></span><span></span></div></div>';
          } else if (evt.type === 'token') {
            fullAnswer += evt.content;
            kbRenderer.tick();
          } else if (evt.type === 'sources') {
            sourcesHtml = _renderSourceCards(evt.content);
            // sources 到达时立即渲染（不节流）
            kbRenderer.flush();
          } else if (evt.type === 'error') {
            aiDiv.innerHTML = iconSvg('cross','14') + ' ' + esc(evt.content || '未知错误');
          }
        } catch (_) { /* 忽略非 JSON 行 */ }
      }
    }

    // 流结束 — 最终渲染（去掉 streaming 光标）
    aiDiv._streaming = false;
    kbRenderer.finalize();

    if (fullAnswer) {
      aiDiv.innerHTML = md(fullAnswer) + sourcesHtml;
    } else if (sourcesHtml) {
      aiDiv.innerHTML = '<div style="color:var(--warning-color);margin-bottom:8px">' + iconSvg('warn','14') + ' AI 回答生成失败，以下是检索到的参考资料：</div>' + sourcesHtml;
    } else {
      aiDiv.innerHTML = '文库中未找到相关信息。';
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      aiDiv.innerHTML = '<span style="color:var(--text-muted);font-style:italic">' + iconSvg('stop','14') + ' 用户已手动终止响应</span>';
    } else {
      aiDiv.innerHTML = iconSvg('cross','14') + ' 请求失败: ' + esc(err.message);
    }
  } finally {
    _kbGenerating = false;
    if (kbBtn) { kbBtn.disabled = false; kbBtn.innerHTML = iconSvg('send','14'); kbBtn.className = 'btn-send'; kbBtn.onclick = function() { kbAsk(); }; kbBtn.style.opacity = '1'; }
    // Patch3: 完成后刷新上下文指示器
    if (typeof kbRefreshContextRing === 'function') kbRefreshContextRing();
  }
}

// --- 新建 KB 问答会话 ---
async function kbNewChat() {
  try {
    await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/new_session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: _kbSessionId })
    });
  } catch (_) { /* 忽略网络错误 */ }
  _kbSessionId = 'kb-' + Date.now();
  var box = document.getElementById('kbMessages');
  if (box) box.innerHTML = '';
}

// --- Patch3: 导出 KB 会话 ---
async function kbExportSession() {
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/session/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: _kbSessionId }),
    });
    if (!resp.ok) {
      var err = await resp.json();
      showToast('导出失败: ' + (err.error || '未知错误'), 'error');
      return;
    }
    var blob = await resp.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'kb_session_' + _kbSessionId.slice(-8) + '.txt';
    a.click();
    URL.revokeObjectURL(url);
    showToast('对话已导出', 'success');
  } catch (err) {
    showToast('导出失败: ' + err.message, 'error');
  }
}

// --- KB 左侧面板折叠 ---
function kbTogglePanel() {
  var panel = document.getElementById('kbLeftPanel');
  if (!panel) return;
  _kbPanelCollapsed = !_kbPanelCollapsed;
  if (_kbPanelCollapsed) {
    panel.classList.add('collapsed');
  } else {
    panel.classList.remove('collapsed');
  }
}

// --- Patch3: 文库 Tab 上下文指示器 ---
async function kbRefreshContextRing() {
  var ringWrap = document.getElementById('kbContextRing');
  var arc = document.getElementById('kbContextRingArc');
  var pctEl = document.getElementById('kbContextPct');
  if (!ringWrap || !arc || !pctEl) return;

  try {
    // 使用 KB 会话独立上下文接口
    var sid = (typeof _kbSessionId !== 'undefined') ? _kbSessionId : 'default';
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/session/context?session_id=' + encodeURIComponent(sid));
    var data = await resp.json();
    var pct = data.percentage || 0;
    var pctInt = Math.round(pct);

    // 更新圆弧
    var circumference = 2 * Math.PI * 15; // r=15
    var offset = circumference * (1 - pctInt / 100);
    arc.setAttribute('stroke-dashoffset', offset.toFixed(1));

    // 颜色规则：< 60% 绿色, 60-85% 黄色, > 85% 红色
    var color = 'var(--success-color)';
    var level = 'level-normal';
    var usedTokens = data.used_tokens || 0;
    var totalTokens = data.total_tokens || 0;
    var turns = data.turns || 0;
    var tooltip = 'KB会话: ' + turns + '轮, ' + usedTokens + '/' + totalTokens + ' tokens';
    if (pct >= 85) {
      color = 'var(--error-color)';
      level = 'level-critical';
      tooltip = 'KB会话接近上限，建议新建对话: ' + usedTokens + '/' + totalTokens + ' tokens';
    } else if (pct >= 60) {
      color = 'var(--warning-color)';
      level = 'level-warning';
      tooltip = iconSvg('warn','12') + ' KB会话使用较高: ' + usedTokens + '/' + totalTokens + ' tokens';
    }
    arc.setAttribute('stroke', color);
    ringWrap.className = 'context-ring-wrap ' + level;
    ringWrap.title = tooltip;
    pctEl.textContent = pctInt + '%';
    pctEl.style.color = color;
  } catch (e) {
    // 静默失败
  }
}

// updateKbLockBar — 由 chat.js 提供（后加载覆盖）

// --- 停止 KB 问答生成 ---
function kbStopGeneration() {
  // 中断前端 fetch stream
  if (_kbAbortCtrl) { _kbAbortCtrl.abort(); _kbAbortCtrl = null; }
  // 通知后端停止生成
  fetch((typeof API !== 'undefined' ? API : '') + '/api/stop', {method:'POST'}).catch(function() {});
  _kbGenerating = false;
  var kbBtn = document.getElementById('kbSendBtn');
  if (kbBtn) { kbBtn.disabled = false; kbBtn.innerHTML = iconSvg('send','14'); kbBtn.className = 'btn-send'; kbBtn.onclick = function() { kbAsk(); }; kbBtn.style.opacity = '1'; }
  showToast('已停止生成', 'info');
}

// 暴露到全局
window.kbRouteState = kbRouteState;
window.kbInstallModule = kbInstallModule;
window.kbOnModuleFilePicked = kbOnModuleFilePicked;
window.kbOnModuleDrop = kbOnModuleDrop;
// kbActivate removed (Patch10: 二态路由，安装即自动加载)
// updateChatOverlay / updateKbLockBar — 由 chat.js 提供（后加载覆盖），不在 qa.js 中暴露
window.kbRefreshDocs = kbRefreshDocs;
window.kbOnFilePicked = kbOnFilePicked;
window.kbOnDrop = kbOnDrop;
window.kbUploadFile = kbUploadFile;
window.kbDeleteDoc = kbDeleteDoc;
window.kbPauseDoc = kbPauseDoc;
window.kbResumeDoc = kbResumeDoc;
window.kbCancelDoc = kbCancelDoc;
// (kbRetrySummary export removed)
window.kbAddMsg = kbAddMsg;
window._renderSourceCards = _renderSourceCards;
window.kbAsk = kbAsk;
window.kbStopGeneration = kbStopGeneration;
window.kbNewChat = kbNewChat;
window.kbExportSession = kbExportSession;
window.kbTogglePanel = kbTogglePanel;
window.kbRefreshContextRing = kbRefreshContextRing;
// 使用 getter 保证 window._kbBusyProcessing 始终返回最新值
try { Object.defineProperty(window, '_kbBusyProcessing', { get: function() { return _kbBusyProcessing; }, configurable: true }); } catch(e) { window._kbBusyProcessing = _kbBusyProcessing; }

// ===== 文库功能说明弹窗 =====
function showKbInfo() {
  // 不能用 showDialog（会 esc HTML），自己构建弹窗
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:500;display:flex;align-items:center;justify-content:center;animation:fadeIn .2s ease';
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
  var card = document.createElement('div');
  card.style.cssText = 'background:var(--bg-primary);border:0.5px solid var(--border-color);border-radius:12px;padding:24px;max-width:420px;width:90%;box-shadow:0 12px 40px rgba(0,0,0,.2);animation:msgSlideIn .25s ease-out';
  card.innerHTML = [
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">',
    '<svg width="22" height="22" viewBox="0 0 64 64" fill="none"><rect x="8" y="6" width="20" height="20" rx="3" stroke="#1e3a5f" stroke-width="2"/><rect x="36" y="34" width="20" height="20" rx="3" stroke="#c9976c" stroke-width="2"/><path d="M14 14h8M14 20h12" stroke="rgba(30,58,95,.25)" stroke-width="1" stroke-linecap="round"/><path d="M42 44l4 4 8-8" stroke="#c9976c" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    '<span style="font-size:15px;font-weight:600;color:var(--text-primary)">文库功能介绍</span></div>',
    '<div style="line-height:1.7;font-size:.92em;color:var(--text-secondary)">',
    '<p style="margin:0 0 8px">文库是你的<b>本地知识库助手</b>，核心功能：</p>',
    '<ul style="padding-left:18px;margin:8px 0">',
    '<li><b>文档上传</b>：支持 TXT / MD / CSV / DOCX / PDF 等格式</li>',
    '<li><b>语义检索</b>：基于 Embedding 模型理解语义，精准匹配</li>',
    '<li><b>智能问答</b>：基于文档内容生成回答，带来源引用</li>',
    '</ul>',
    '<p style="margin:8px 0 0;color:var(--text-muted);font-size:.85em">' + iconSvg('info','12') + ' 文库模型会在后台自动加载，无需手动操作。</p>',
    '</div>',
    '<div style="margin-top:16px;display:flex;justify-content:flex-end">',
    '<button style="padding:6px 20px;border:none;border-radius:6px;background:var(--accent-color);color:var(--text-on-accent,#fff);cursor:pointer;font-size:13px" onclick="this.closest(\'div\').parentNode.parentNode.remove()">知道了</button>',
    '</div>'
  ].join('');
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}
window.showKbInfo = showKbInfo;

// ===== Patch3: 云端AI知识对比功能 =====
var _kbCompareEnabled = false;
var _kbComparePrivacyRead = false;

// 对比模式下的提问（走 /api/chat/stream 管道）
async function _kbAskCompareMode(question) {
  var aiDiv = kbAskCompare(question);

  _kbGenerating = true;
  var kbBtn = document.getElementById('kbSendBtn');
  if (kbBtn) { kbBtn.disabled = true; kbBtn.style.opacity = '0.5'; }

  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: question,
        action_mode: 'kb',
        kb_compare: true,
        kb_session_id: _kbSessionId,
      }),
    });

    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var localText = '';
    var cloudText = '';
    var mergeText = '';

    while (true) {
      var readResult = await reader.read();
      if (readResult.done) break;
      buffer += decoder.decode(readResult.value, { stream: true });

      var lines = buffer.split('\n');
      buffer = lines.pop();

      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        if (!line.startsWith('data: ')) continue;
        var data = line.slice(6);
        if (data === '[DONE]') continue;

        try {
          var evt = JSON.parse(data);
          var channel = evt.channel || '';

          // 进度步骤事件
          if (channel === 'progress' && evt.type === 'step') {
            updateCompareStep(evt.step, evt.status);
          }
          // 对比模式事件分发 — 实时流式 token
          else if (channel === 'local') {
            if (evt.type === 'stream') {
              localText += evt.content || '';
              updateKbCompareChannel(aiDiv, 'local', evt.content, true);
            } else if (evt.type === 'step') {
              // 本地步骤切换：searching / organizing / generating
              _updateLocalStepList(aiDiv, evt.step);
            } else if (evt.type === 'step_done') {
              // 本地步骤完成
              _markLocalStepDone(aiDiv, evt.step);
            } else if (evt.type === 'sources') {
              updateCompareSources(aiDiv, evt.sources);
            } else if (evt.type === 'mode_hint' && !localText) {
              var localEl = aiDiv.querySelector('#kbCompareLocal');
              if (localEl) localEl.innerHTML = '<span style="color:var(--text-muted);font-style:italic">' + esc(evt.message || '文库中未找到相关内容') + '</span>';
              // 标记所有步骤完成
              _markLocalStepDone(aiDiv, 'generate');
            } else if (evt.type === 'phase' && evt.phase === 'done') {
              // 完成时做最终 markdown 渲染（去掉光标）
              var localEl = aiDiv.querySelector('#kbCompareLocal');
              if (localEl && localText) updateKbCompareChannel(aiDiv, 'local', localText, false);
              if (!localText) {
                if (localEl && !localEl.textContent.trim()) localEl.innerHTML = '<span style="color:var(--text-muted)">无相关内容</span>';
              }
            }
          } else if (channel === 'cloud') {
            if (evt.type === 'stream') {
              cloudText += evt.content || '';
              updateKbCompareChannel(aiDiv, 'cloud', evt.content, true);
            } else if (evt.type === 'status') {
              // 云端状态切换：understanding / thinking / generating
              _updateCloudStatus(aiDiv, evt.status);
            } else if (evt.type === 'phase' && evt.phase === 'done') {
              var cloudEl = aiDiv.querySelector('#kbCompareCloud');
              if (cloudEl && cloudText) updateKbCompareChannel(aiDiv, 'cloud', cloudText, false);
              // 完成后标记所有步骤完成
              var cloudStepsEl = aiDiv.querySelector('#kbCompareCloudSteps');
              if (cloudStepsEl) {
                var allSteps = cloudStepsEl.querySelectorAll('.kb-step-item');
                var labels = ['理解问题', '深度思考', '生成回答'];
                for (var si = 0; si < allSteps.length; si++) {
                  allSteps[si].style.color = 'var(--success-color)';
                  allSteps[si].style.fontWeight = '600';
                  allSteps[si].innerHTML = iconSvg('check','10') + ' ' + (labels[si] || '');
                }
              }
              if (!cloudText) {
                if (cloudEl) cloudEl.innerHTML = '<span style="color:var(--text-muted)">云端未返回结果</span>';
              }
            }
          } else if (channel === 'merge') {
            if (evt.type === 'stream') {
              mergeText += evt.content || '';
              updateKbCompareChannel(aiDiv, 'merge', evt.content, true);
            } else if (evt.type === 'mode_hint') {
              // 融合提示，不再显示
            } else if (evt.type === 'phase' && evt.phase === 'done') {
              var mergeEl = aiDiv.querySelector('#kbCompareMerge');
              if (mergeEl && mergeText) updateKbCompareChannel(aiDiv, 'merge', mergeText, false);
              if (!mergeText) {
                if (mergeEl) mergeEl.innerHTML = '<span style="color:var(--text-muted)">融合分析暂不可用</span>';
              }
            }
          } else if (evt.type === 'done') {
            // 最终 done 事件，刷新上下文指示器
            kbRefreshContextRing();
          } else if (evt.type === 'error') {
            kbAddMsg('ai', iconSvg('cross','14') + ' ' + (evt.content || '未知错误'));
          }
        } catch(_) { /* 忽略非 JSON */ }
      }
    }
  } catch(err) {
    aiDiv.innerHTML = iconSvg('cross','14') + ' 请求失败: ' + err.message;
  } finally {
    _kbGenerating = false;
    if (kbBtn) { kbBtn.disabled = false; kbBtn.style.opacity = '1'; }
  }
}

// 初始化对比开关可见性（由模式切换调用）
function initKbCompareToggle() {
  var toggle = document.getElementById('kbCompareToggle');
  if (!toggle) return;
  // 只在云端模式下显示
  if (typeof _currentMode !== 'undefined' && _currentMode === 'cloud') {
    toggle.style.display = 'flex';
    // 加载开关状态
    loadKbCompareState();
  } else {
    toggle.style.display = 'none';
  }
}

// 加载对比开关状态
async function loadKbCompareState() {
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/cloud/config');
    var data = await resp.json();
    var serverEnabled = !!data.kb_compare_enabled;
    // 只在服务器状态和本地不一致时更新（避免覆盖用户当前操作）
    // 但如果本地还是初始值 false，直接同步服务器
    _kbCompareEnabled = serverEnabled;
    _kbComparePrivacyRead = !!data.kb_compare_privacy_read;
    var sw = document.getElementById('kbCompareSwitch');
    if (sw) sw.checked = _kbCompareEnabled;
  } catch(e) {
    silentLog('[KB-COMPARE] 加载状态失败:', e);
  }
}

// 切换对比开关
async function toggleKbCompare(enabled) {
  if (enabled && !_kbComparePrivacyRead) {
    // 首次开启：弹出隐私说明
    var confirmed = await showKbComparePrivacyDialog();
    if (!confirmed) {
      var sw = document.getElementById('kbCompareSwitch');
      if (sw) sw.checked = false;
      return;
    }
    _kbComparePrivacyRead = true;
  }
  _kbCompareEnabled = enabled;
  try {
    await fetch((typeof API !== 'undefined' ? API : '') + '/api/cloud/config', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        kb_compare_enabled: enabled,
        kb_compare_privacy_read: _kbComparePrivacyRead
      })
    });
  } catch(e) {
    silentLog('[KB-COMPARE] 保存状态失败:', e);
  }
}

// 隐私说明弹窗
function showKbComparePrivacyDialog() {
  return new Promise(function(resolve) {
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:500;display:flex;align-items:center;justify-content:center;animation:fadeIn .2s ease';
    var card = document.createElement('div');
    card.style.cssText = 'background:var(--bg-primary);border:0.5px solid var(--border-color);border-radius:12px;padding:24px;max-width:420px;width:90%;box-shadow:0 12px 40px rgba(0,0,0,.2);animation:msgSlideIn .25s ease-out';
    card.innerHTML = [
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">',
      '<svg width="22" height="22" viewBox="0 0 22 22" fill="none"><path d="M11 1L1 8v12h8v-6h4v6h8V8L11 1z" stroke="var(--accent-color)" stroke-width="1.5"/><rect x="8" y="8" width="6" height="4" rx="1" stroke="var(--accent-color)" stroke-width="1"/></svg>',
      '<span style="font-size:15px;font-weight:600;color:var(--text-primary)">隐私说明</span></div>',
      '<div style="line-height:1.7;font-size:.92em;color:var(--text-secondary)">',
      '<p style="margin:0 0 8px">开启「云端AI知识对比」后：</p>',
      '<ul style="padding-left:18px;margin:8px 0">',
      '<li>您的<b style="color:var(--success-color)">文档数据不会发送到云端</b></li>',
      '<li>本地模型在您的电脑上<b>安全融合</b>两路信息</li>',
      '<li>云端AI<b>无法看到</b>您的文档内容</li>',
      '</ul>',
      '<p style="margin:8px 0 0;color:var(--text-muted);font-size:.85em">仅问题文本会发送给云端AI，文库检索在本地完成。</p>',
      '</div>',
      '<div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">',
      '<button style="padding:6px 16px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px" id="kbPrivacyCancel">取消</button>',
      '<button style="padding:6px 20px;border:none;border-radius:6px;background:var(--accent-color);color:var(--text-on-accent,#fff);cursor:pointer;font-size:13px" id="kbPrivacyConfirm">我已了解，开启</button>',
      '</div>'
    ].join('');
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.getElementById('kbPrivacyConfirm').onclick = function() {
      overlay.remove();
      resolve(true);
    };
    document.getElementById('kbPrivacyCancel').onclick = function() {
      overlay.remove();
      resolve(false);
    };
  });
}

// 对比模式下的 SSE 处理 — 两列并排实时状态 + 融合在下方 + 来源标签
function kbAskCompare(question) {
  var aiDiv = kbAddMsg('ai', '');

  // 步骤行样式（3步骤列表）
  var stepLine = function(id, steps) {
    var html = '<div id="' + id + '" style="display:flex;flex-wrap:wrap;gap:2px 10px;font-size:.7em;line-height:1.4">';
    for (var i = 0; i < steps.length; i++) {
      // 第一个步骤默认显示为进行中（带旋转图标）
      var isFirst = (i === 0);
      var stepStyle = isFirst ? 'color:var(--accent-color);font-weight:600' : 'color:var(--text-muted)';
      var stepContent = isFirst ? iconSvg('spin','10') + ' ' + steps[i][1] : steps[i][1];
      html += '<span class="kb-step-item" data-step="' + steps[i][0] + '" style="' + stepStyle + '">' + stepContent + '</span>';
      if (i < steps.length - 1) html += '<span style="color:var(--border-color)">→</span>';
    }
    html += '</div>';
    return html;
  };

  // 两列并排（紧凑布局）
  var columnsHtml = [
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;min-width:0">',
    // 本地列
    '  <div class="kb-compare-col" style="border:1px solid var(--border-color);border-radius:8px;padding:6px 8px;background:var(--bg-primary);min-width:0;overflow-wrap:break-word;word-break:break-word">',
    '    <div style="font-size:.72em;font-weight:600;color:var(--success-color);margin-bottom:3px">' + iconSvg('lock','12') + ' 本地知识库</div>',
    stepLine('kbCompareLocalSteps', [['search','检索文库'],['organize','整理结果'],['generate','生成回答']]),
    '    <div id="kbCompareLocal" style="font-size:.84em;line-height:1.55;min-height:16px;color:var(--text-secondary);margin-top:3px"></div>',
    '    <div id="kbCompareSources" style="display:none;margin-top:3px;font-size:.68em;color:var(--text-muted);border-top:1px dashed var(--border-color);padding-top:3px"></div>',
    '  </div>',
    // 云端列
    '  <div class="kb-compare-col" style="border:1px solid var(--border-color);border-radius:8px;padding:6px 8px;background:var(--bg-primary);min-width:0;overflow-wrap:break-word;word-break:break-word">',
    '    <div style="font-size:.72em;font-weight:600;color:var(--accent-color);margin-bottom:3px">' + iconSvg('globe','12') + ' 云端AI</div>',
    '    <div id="kbCompareCloudSteps" style="font-size:.68em;display:flex;gap:8px;align-items:center;margin-bottom:2px;flex-wrap:wrap">',
    '      <span class="kb-step-item" data-step="understanding" style="color:var(--accent-color);font-weight:600">' + iconSvg('spin','10') + ' 理解问题</span>',
    '      <span style="color:var(--border-color)">→</span>',
    '      <span class="kb-step-item" data-step="thinking" style="color:var(--text-muted)">深度思考</span>',
    '      <span style="color:var(--border-color)">→</span>',
    '      <span class="kb-step-item" data-step="generating" style="color:var(--text-muted)">生成回答</span>',
    '    </div>',
    '    <div id="kbCompareCloudStatus" style="display:none"></div>',
    '    <div id="kbCompareCloud" style="font-size:.84em;line-height:1.55;min-height:16px;color:var(--text-secondary);margin-top:3px"></div>',
    '  </div>',
    '</div>',
  ].join('');

  // 融合列（初始隐藏）
  var mergeHtml = [
    '<div id="kbMergeSection" style="display:none;border:1px solid var(--border-color);border-radius:8px;padding:6px 8px;background:var(--bg-secondary);overflow-wrap:break-word;word-break:break-word">',
    '  <div style="font-size:.72em;font-weight:600;color:var(--warning-color);margin-bottom:3px">' + iconSvg('merge','12') + ' 综合分析（本地安全融合）</div>',
    '  <div id="kbCompareMerge" style="font-size:.84em;line-height:1.55;min-height:10px;color:var(--text-secondary)"></div>',
    '</div>',
  ].join('');

  aiDiv.innerHTML = columnsHtml + mergeHtml;
  return aiDiv;
}

// 更新进度步骤状态（本地3步骤列表 + 云端状态文字）
function updateCompareStep(stepId, status) {
  if (stepId === 'merge') {
    var mergeSection = document.getElementById('kbMergeSection');
    if (status === 'doing') {
      if (mergeSection) mergeSection.style.display = 'block';
    }
  }
}

// 更新本地列步骤列表状态（3步骤：检索→整理→生成）
function _updateLocalStepList(aiDiv, activeStep) {
  var stepsEl = aiDiv.querySelector('#kbCompareLocalSteps');
  if (!stepsEl) return;
  // activeStep 可能是 "searching"/"organizing"/"generating"/"reformulating"
  var stepMap = { searching: 'search', organizing: 'organize', generating: 'generate', reformulating: 'reformulate' };
  var mappedStep = stepMap[activeStep] || activeStep;
  var items = stepsEl.querySelectorAll('.kb-step-item');
  var stepOrder = ['reformulate', 'search', 'organize', 'generate'];
  var stepLabels = { reformulate: '补全追问', search: '检索文库', organize: '整理结果', generate: '生成回答' };
  var activeIdx = stepOrder.indexOf(mappedStep);

  // Reformulation 是预处理步骤，不在步骤列表中，改为临时更新第一个步骤文字
  if (mappedStep === 'reformulate') {
    var firstItem = items[0];
    if (firstItem) {
      firstItem.innerHTML = iconSvg('spin','10') + ' 补全追问';
      firstItem.style.color = 'var(--accent-color)';
      firstItem.style.fontWeight = '600';
    }
    return;
  }

  for (var i = 0; i < items.length; i++) {
    var step = items[i].getAttribute('data-step');
    var idx = stepOrder.indexOf(step);
    if (idx >= 0 && idx < activeIdx) {
      // 已完成
      items[i].innerHTML = iconSvg('check','10') + ' ' + stepLabels[step];
      items[i].style.color = 'var(--success-color)';
    } else if (idx === activeIdx) {
      // 执行中
      items[i].innerHTML = iconSvg('spin','10') + ' ' + stepLabels[step];
      items[i].style.color = 'var(--accent-color)';
    } else {
      // 待执行
      items[i].innerHTML = stepLabels[step];
      items[i].style.color = 'var(--text-muted)';
    }
  }
}

// 标记本地步骤完成
function _markLocalStepDone(aiDiv, stepName) {
  var stepsEl = aiDiv.querySelector('#kbCompareLocalSteps');
  if (!stepsEl) return;
  var items = stepsEl.querySelectorAll('.kb-step-item');
  var stepLabels = { search: '检索文库', organize: '整理结果', generate: '生成回答' };
  for (var i = 0; i < items.length; i++) {
    var step = items[i].getAttribute('data-step');
    if (step === stepName) {
      items[i].innerHTML = iconSvg('check','10') + ' ' + stepLabels[step];
      items[i].style.color = 'var(--success-color)';
    }
  }
}

// 更新云端状态文字
function _updateCloudStatus(aiDiv, statusName) {
  var stepsEl = aiDiv.querySelector('#kbCompareCloudSteps');
  if (!stepsEl) return;
  var steps = stepsEl.querySelectorAll('.kb-step-item');
  var stepMap = { understanding: 0, thinking: 1, generating: 2 };
  var labels = ['理解问题', '深度思考', '生成回答'];
  var activeIdx = stepMap[statusName];
  if (typeof activeIdx === 'undefined') return;
  
  for (var i = 0; i < steps.length; i++) {
    if (i < activeIdx) {
      // 已完成
      steps[i].style.color = 'var(--success-color)';
      steps[i].style.fontWeight = '600';
      steps[i].innerHTML = iconSvg('check','10') + ' ' + labels[i];
    } else if (i === activeIdx) {
      // 当前进行中
      steps[i].style.color = 'var(--accent-color)';
      steps[i].style.fontWeight = '600';
      steps[i].innerHTML = iconSvg('spin','10') + ' ' + labels[i];
    } else {
      // 待执行
      steps[i].style.color = 'var(--text-muted)';
      steps[i].style.fontWeight = '400';
      steps[i].textContent = labels[i];
    }
  }
}

// 清理打字机定时器
var _kbTypewriterTimers = {};

// 更新对比模式 SSE 事件 — 实时流式渲染（每个 token 直接拼接显示）
function updateKbCompareChannel(aiDiv, channel, content, isToken) {
  var elId = channel === 'local' ? 'kbCompareLocal' :
             channel === 'cloud' ? 'kbCompareCloud' :
             'kbCompareMerge';
  var el = aiDiv.querySelector('#' + elId);
  if (!el) return;

  if (!content) return;

  if (isToken) {
    // 实时 token 流：逐字符追加
    el.style.color = 'var(--text-primary)';
    // 清除之前的打字机光标
    var cursor = el.querySelector('.kb-cursor');
    // 直接追加纯文本（markdown 渲染在完成时做）
    if (!el._rawText) el._rawText = '';
    el._rawText += content;
    // 实时渲染当前累积的 markdown
    if (typeof md === 'function') {
      el.innerHTML = md(el._rawText, false) + '<span class="kb-cursor" style="display:inline-block;width:2px;height:.9em;background:var(--accent-color);animation:blink 1s infinite;vertical-align:middle;margin-left:1px"></span>';
    } else {
      el.textContent = el._rawText;
    }
  } else {
    // 完整文本（完成时或降级时）
    el.style.color = 'var(--text-primary)';
    if (typeof md === 'function') {
      el.innerHTML = md(content);
    } else {
      el.textContent = content;
    }
    el._rawText = content;
  }

  // 自动滚动
  var box = document.getElementById('kbMessages');
  if (box) box.scrollTop = box.scrollHeight;
}

// 更新来源标签
function updateCompareSources(aiDiv, sources) {
  var el = aiDiv.querySelector('#kbCompareSources');
  if (!el || !sources || !sources.length) return;
  var html = '<span style="color:var(--text-muted)">来源：</span>';
  for (var i = 0; i < sources.length; i++) {
    var label = sources[i].label || '?';
    if (i > 0) html += ' · ';
    html += '<span style="color:var(--text-secondary)">' + iconSvg('doc','12') + ' ' + label + '</span>';
  }
  el.innerHTML = html;
  el.style.display = 'block';
}

window.initKbCompareToggle = initKbCompareToggle;
window.loadKbCompareState = loadKbCompareState;
window.toggleKbCompare = toggleKbCompare;
window.kbAskCompare = kbAskCompare;
window.updateKbCompareChannel = updateKbCompareChannel;


// ===== qa.js — P6 知识库 Tab：文档档案管理（标签树 + 卡片网格 + AI概览） =====
// 依赖: api.js, errors.js, utils.js, 全局变量 (API)
// 被引用: chat.js (updateKbLockBar), kb-batch.js (kbOnDocsRendered)

var _kbPollTimer = null;
var _kbModuleStatus = null;
var _kbBusyProcessing = false;

// P6 审计修复 M5：切出 KB Tab 时清理轮询定时器，防止泄漏
function _kbStopPolling() {
  if (_kbPollTimer) {
    clearInterval(_kbPollTimer);
    _kbPollTimer = null;
  }
}
var _kbModelsLoaded = false;
var _kbTagClusters = [];
var _kbLastDocs = [];
var _kbViewMode = 'card';  // P6: 'card' | 'list'
var _kbQueueItems = [];  // P6 B4: 处理队列 [{{docId, filename, phase, pct, error}}]

// 标签分组（LLM 语义归并）
var _kbTagGroups = [];       // [{group, members, source}, ...]
var _kbGroupUngrouped = [];  // 未分组的标签列表
var _kbLastGroupTrigger = 0;  // 上次触发分组的时间戳 (ms)，用于冷却

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

    if (loading) loading.style.display = 'none';
    if (fullInterface) fullInterface.style.display = 'flex';
    kbRefreshDocs();
    kbRefreshAIOverview();  // P6: 页面加载时恢复洞察
  } catch (e) {
    silentLog('[KB] 状态路由失败:', e);
    if (loading) loading.style.display = 'none';
    if (fullInterface) fullInterface.style.display = 'flex';
    kbRefreshDocs();
    kbRefreshAIOverview();  // P6: 异常兜底也恢复洞察
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

// --- KB 模型遮罩 ---
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
    var missing = [];
    if (!embedderPresent) missing.push('嵌入模型');
    if (!rerankerPresent) missing.push('精排模型');
    if (titleEl) titleEl.textContent = '模型文件缺失';
    if (descEl) descEl.textContent = missing.join('、') + ' 文件未找到，请重新安装文库模块。';
    if (btnEl) { btnEl.textContent = '前往扩展管理'; btnEl.style.display = ''; }
    if (btn2El) btn2El.style.display = 'none';
  } else {
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

function kbOverlayAction() {
  var settingsTab = document.querySelector('[data-tab="settings"]') || document.querySelector('[onclick*="settings"]');
  if (settingsTab) settingsTab.click();
  setTimeout(function() {
    var extSection = document.getElementById('extensionsSection') || document.querySelector('.extensions-list');
    if (extSection) extSection.scrollIntoView({behavior: 'smooth'});
  }, 300);
}

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

// --- P6: 卡片网格渲染 ---
var _kbSkipFetch = false;
async function kbRefreshDocs() {
  try {
    var docs, stats;
    if (_kbSkipFetch) {
      docs = _kbLastDocs;
      stats = {};
      _kbSkipFetch = false;
    } else {
      var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/documents');
      docs = await resp.json();
      _kbLastDocs = docs;
      var statsResp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/stats');
      stats = await statsResp.json();
    }

    var _readyCount = stats.ready_documents || 0;
    var _maxDocs = stats.max_documents || 200;
    var _errorCount = 0;
    var _processingCount = 0;
    for (var di = 0; di < docs.length; di++) {
      var _st = docs[di].status;
      if (_st === 'error') _errorCount++;
      else if (_st === 'processing' || _st === 'indexing' || _st === 'summarizing') _processingCount++;
    }

    _kbModelsLoaded = stats.models_loaded || false;
    _updateKbOverlay();

    // 更新模型 overlay 和 dropzone
    var modelLoaded = _kbModelsLoaded || (stats.models_loaded === true);
    var overlay = document.getElementById('kbModelOverlay');
    if (overlay) overlay.style.display = !modelLoaded ? 'flex' : 'none';

    var hasSummarizing = (stats.summarizing_documents || 0) > 0;
    _kbBusyProcessing = hasSummarizing;

    // P6: 页面刷新后重建处理队列（从后端文档状态恢复）
    var _rebuildOne = function(_rd, _conflictInfo) {
      var _exists = false;
      for (var _ei = 0; _ei < _kbQueueItems.length; _ei++) {
        if (_kbQueueItems[_ei].docId === _rd.doc_id) { _exists = true; break; }
      }
      if (!_exists) {
        _kbAddToQueue(_rd.doc_id, _rd.filename, _conflictInfo || null);
        if (!_conflictInfo && typeof kbSubscribeProgress === 'function') {
          kbSubscribeProgress(_rd.doc_id, _rd.filename);
        }
      }
    };
    for (var _ri = 0; _ri < docs.length; _ri++) {
      var _rd = docs[_ri];
      if (_rd.status === 'processing' || _rd.status === 'indexing' || _rd.status === 'summarizing') {
        _rebuildOne(_rd);
      } else if (_rd.status === 'ready' && (_rd.tag_status === 'generating' || _rd.tag_status === 'pending')) {
        _rebuildOne(_rd);
      } else if (_rd.status === 'conflict') {
        // 重建冲突文档的队列条目
        var _cinfo = null;
        var _meta = _rd.metadata || {};
        var _dupOf = _meta.duplicate_of;
        if (_dupOf) {
          var _existFn = _dupOf;
          for (var _fi = 0; _fi < docs.length; _fi++) {
            if (docs[_fi].doc_id === _dupOf) { _existFn = docs[_fi].filename || _dupOf; break; }
          }
          _cinfo = {
            existing_doc_id: _dupOf,
            existing_filename: _existFn,
            level: _meta.duplicate_level || 'high',
            similarity: _meta.duplicate_similarity || 0.95
          };
        }
        _rebuildOne(_rd, _cinfo);
      }
    }
    _kbRenderQueue();

    // P6: 侧栏按文档 category 分组（不再依赖 tag_groups API）
    _kbRenderCategoryTree(docs);

    // 更新侧栏底部统计
    var ft = document.getElementById('kbSidebarFt');
    if (ft) {
      var catCount = 0;
      var seenCats = {};
      for (var ci = 0; ci < docs.length; ci++) {
        var cat = docs[ci].category || '';
        if (cat && !seenCats[cat]) { seenCats[cat] = 1; catCount++; }
      }
      ft.textContent = docs.length + '篇 · ' + catCount + '分类';
    }

    // 更新设置页知识库统计
    _updateKbSettingsStats(stats, docs);

    // 渲染标签树
    kbRenderTagTree(docs);

    // 空状态
    var emptyEl = document.getElementById('kbEmpty');
    var gridEl = document.getElementById('kbDocGrid');
    var overviewEl = document.getElementById('kbAIOverview');

    if (!docs.length) {
      if (emptyEl) emptyEl.style.display = 'flex';
      if (gridEl) gridEl.innerHTML = '';
      if (overviewEl) overviewEl.style.display = 'none';
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';
    if (overviewEl) overviewEl.style.display = '';

    // 构建卡片 HTML
    var svgLock = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none"><rect x="3" y="6" width="8" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M5 6V4a2 2 0 014 0v2" stroke="currentColor" stroke-width="1.2"/></svg>';
    var svgDup = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none"><rect x="3" y="1.5" width="8" height="11" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="1.5" y="3.5" width="8" height="9" rx="1" fill="var(--bg-secondary)" stroke="currentColor" stroke-width="1.2"/></svg>';
    var svgImg = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/><circle cx="5" cy="5.5" r="1.5" stroke="currentColor" stroke-width="0.8"/><path d="M3 10.5l2.5-2.5L8 10l2-2 2 2" stroke="currentColor" stroke-width="0.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    var html = '';
    for (var di = 0; di < docs.length; di++) {
      var d = docs[di];

      // P6: 按 category 筛选（一个文档只属于一个分类）
      if (_kbActiveTagFilter) {
        if (_kbActiveTagFilter === '__uncategorized__') {
          // 未分类：category 为空的文档
          if (d.category) continue;
        } else {
          // 精确匹配 category
          if (d.category !== _kbActiveTagFilter) continue;
        }
      }

      // 应用名称搜索筛选
      if (_kbNameFilter && d.filename.toLowerCase().indexOf(_kbNameFilter.toLowerCase()) === -1) continue;

      var sizeStr = d.file_size > 1048576 ? (d.file_size/1048576).toFixed(1)+'MB' : d.file_size > 1024 ? (d.file_size/1024).toFixed(1)+'KB' : d.file_size+'B';
      var tokenInfo = d.total_chars ? '约 ' + (Math.ceil(d.total_chars/1.5)/1000).toFixed(1) + 'K 词元' : '';
      var hitCount = d.hit_count || 0;
      var hitStr = '被搜索 ' + hitCount + ' 次';

      // 状态图标
      var iconsHtml = '';
      if (d.is_private) iconsHtml += '<span class="ic-lock" title="私密文档">' + svgLock + '</span>';
      if (d.metadata && d.metadata.duplicate_of) iconsHtml += '<span class="ic-dup" title="检测到重复">' + svgDup + '</span>';
      if (d.metadata && d.metadata.has_images) iconsHtml += '<span class="ic-img" title="含图片">' + svgImg + '</span>';

      // 热力图圆点
      var hmDotClass = hitCount >= 10 ? 'hot' : (hitCount >= 1 ? 'warm' : 'cold');
      var hmDotHtml = '<span style="display:flex;align-items:center;gap:3px"><span class="hm-dot ' + hmDotClass + '"></span>' + hitCount + '</span>';

      // 内容预览 (Fix B: 基于 doc status + tag_status 显示状态)
      var previewText = '';
      var previewExtraClass = '';
      if (d.status === 'processing' || d.status === 'indexing') {
        // P6: 从队列查找实时进度
        var _qi = null;
        for (var _qi2 = 0; _qi2 < _kbQueueItems.length; _qi2++) {
          if (_kbQueueItems[_qi2].docId === d.doc_id) { _qi = _kbQueueItems[_qi2]; break; }
        }
        if (_qi && _qi.phase && _qi.pct != null) {
          var _phaseLabels = { chunking: '切分段落', embedding: '向量化', queued: '排队中', tag_pending: '等AI摘要', tag_generating: 'AI摘要中' };
          previewText = (_phaseLabels[_qi.phase] || _qi.phase) + ' ' + _qi.pct + '%';
          previewExtraClass = ' generating';
        } else {
          previewText = '处理中...';
          previewExtraClass = ' generating';
        }
      } else if (d.status === 'conflict') {
        previewText = '检测到冲突';
        previewExtraClass = ' failed';
      } else if (d.status === 'ready') {
        if (d.tag_status === 'pending') {
          previewText = '排队等待 AI 生成摘要...';
        } else if (d.tag_status === 'generating') {
          previewText = 'AI 正在生成摘要...';
          previewExtraClass = ' generating';
        } else if (d.tag_status === 'done') {
          previewText = d.summary || d.content_snippet || '';
          if (previewText && previewText.length > 120) previewText = previewText.substring(0, 120) + '...';
          if (!previewText) previewText = '暂无摘要';
        } else if (d.tag_status === 'failed') {
          previewText = '摘要生成失败 · 点选后可重试';
          previewExtraClass = ' failed';
        } else {
          previewText = d.summary || d.content_snippet || '';
          if (previewText && previewText.length > 120) previewText = previewText.substring(0, 120) + '...';
          if (!previewText) previewText = '暂无摘要';
        }
      } else if (d.status === 'error') {
        previewText = '处理失败';
      } else {
        previewText = d.summary || d.content_snippet || '';
        if (previewText && previewText.length > 120) previewText = previewText.substring(0, 120) + '...';
        if (!previewText) previewText = '(暂无预览)';
      }

      // 标签
      var tagsHtml = '';
      if (d.tag_status === 'done' && d.tags && d.tags.length > 0) {
        for (var tgi = 0; tgi < Math.min(d.tags.length, 4); tgi++) {
          tagsHtml += '<span class="ctag">' + esc(d.tags[tgi]) + '</span>';
        }
      } else if (d.tag_status === 'generating') {
        tagsHtml = '<span class="ctag" style="background:var(--bg-tertiary);color:var(--text-muted)">标签生成中...</span>';
      }

      // 上传时间
      var uploadTime = '';
      if (d.created_at) {
        var dDate = new Date(d.created_at);
        var now = new Date();
        var diffDays = Math.floor((now - dDate) / 86400000);
        uploadTime = diffDays === 0 ? '今天上传' : diffDays === 1 ? '1 天前上传' : diffDays + ' 天前上传';
      }

      html += '<div class="kb-card" data-doc-id="' + esc(d.doc_id) + '" onclick="kbCardClick(\'' + esc(d.doc_id) + '\')">';
      // 1. 标题行
      html += '<div class="cbar">';
      html += '<span class="ctitle" title="' + esc(d.filename) + '">' + esc(d.filename) + '</span>';
      if (iconsHtml) html += '<div class="cicons">' + iconsHtml + '</div>';
      html += '</div>';
      // 2. 标签（紧跟标题）
      if (tagsHtml) html += '<div class="ctags">' + tagsHtml + '</div>';
      // 3. AI 摘要
      html += '<div class="cpreview' + previewExtraClass + '">';
      if (d.tag_status === 'generating' || d.status === 'processing' || d.status === 'indexing') {
        html += '<span class="cpreview-spinner"></span>';
      }
      html += esc(previewText) + '</div>';
      // 4. 文件信息 + 上传时间（下对齐）
      html += '<div class="cstats-bottom">';
      html += '<div class="cstats">';
      html += '<span>文件大小 ' + sizeStr + '</span>';
      if (tokenInfo) html += '<span>' + tokenInfo + '</span>';
      html += '<span>' + hitStr + '</span>';
      html += '</div>';
      html += '<div class="cmtime">' + uploadTime + '</div>';
      html += '</div>';
      // P6: 私密文档的令牌按钮
      if (d.is_private) {
        html += '<div class="ctoken-act">';
        html += '<button class="ctoken-btn" onclick="event.stopPropagation();kbGenerateToken(\'' + esc(d.doc_id) + '\')" title="生成访问令牌"><svg width="10" height="10" viewBox="0 0 14 14" fill="none"><rect x="3" y="6" width="8" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M5 6V4a2 2 0 014 0v2" stroke="currentColor" stroke-width="1.2"/></svg> 令牌</button>';
        html += '</div>';
      }
      // Fix B: 摘要生成失败 + 文档已选中 → 显示重试按钮
      if (d.tag_status === 'failed' && typeof _kbSelectedDocs !== 'undefined' && _kbSelectedDocs && _kbSelectedDocs.has(d.doc_id)) {
        html += '<div class="ctoken-act">';
        html += '<button class="ctoken-btn" onclick="event.stopPropagation();kbRetrySummary(\'' + esc(d.doc_id) + '\')" title="重新生成摘要">重新生成摘要</button>';
        html += '</div>';
      }
      html += '</div>';
    }

    var gridEl = document.getElementById('kbDocGrid');
    if (gridEl) {
      // P6: 根据 _kbViewMode 切换 class
      gridEl.className = _kbViewMode === 'list' ? 'kb-doc-list' : 'kb-doc-grid';
      gridEl.innerHTML = html;
    }

    // P6 打磨 #7：更新底部统计
    var statsEl = document.getElementById('kbStats');
    if (statsEl) {
      var totalDocs = docs.length;
      var totalChunks = 0, totalBytes = 0, totalChars = 0;
      docs.forEach(function(d) { totalChunks += (d.chunk_count || 0); totalBytes += (d.file_size || 0); totalChars += (d.total_chars || 0); });
      var sizeStr = totalBytes > 1073741824 ? (totalBytes/1073741824).toFixed(1)+'GB' : totalBytes > 1048576 ? (totalBytes/1048576).toFixed(1)+'MB' : (totalBytes/1024).toFixed(1)+'KB';
      var totalTokens = Math.ceil(totalChars / 1.5);
      var charsStr = totalTokens > 1000 ? (totalTokens/1000).toFixed(1)+'K 词元' : totalTokens + ' 词元';
      statsEl.style.display = totalDocs > 0 ? '' : 'none';
      statsEl.textContent = '共 ' + totalDocs + ' 篇文档 · ' + charsStr + ' · 已索引 ' + totalChunks + ' 块 · 占用 ' + sizeStr;
    }

    // 通知 kb-batch.js
    if (typeof kbOnDocsRendered === 'function') kbOnDocsRendered(docs);

    // 轮询管理
    var hasProcessing = docs.some(function(d) { return ['processing', 'indexing', 'summarizing'].indexOf(d.status) >= 0; });
    var hasPendingTags = docs.some(function(d) {
      return ['pending','generating','failed'].indexOf(d.tag_status) >= 0 && d.status === 'ready';
    });
    if ((hasProcessing || hasPendingTags) && !_kbPollTimer) {
      _kbPollTimer = setInterval(kbRefreshDocs, 3000);
    } else if (!hasProcessing && !hasPendingTags && _kbPollTimer) {
      clearInterval(_kbPollTimer);
      _kbPollTimer = null;
      // P6: 所有文档处理完毕（含标签），自动触发 AI 洞察整理 + 标签筛选刷新
      if (typeof kbRefreshOverviewLLM === 'function') {
        setTimeout(function() { kbRefreshOverviewLLM(); }, 300);
      }
    }

    // P6: 刷新令牌面板
    kbRefreshTokens();
    // P6: kbRefreshAIOverview 只统计概览（标签数/文档数），不覆盖 AI 洞察文本
    // AI 洞察由 kbRefreshOverviewLLM 独立管理，避免轮询覆盖 LLM 生成内容
    _kbRefreshOverviewStatsOnly();
    // P6 修复：同步队列条目和文档 tag_status
    _kbSyncQueueWithDocs(docs);
  } catch (err) {
    silentLog('[KB] 刷新文档列表失败:', err);
  }
}

// --- 更新设置页知识库统计 ---
function _updateKbSettingsStats(stats, docs) {
  var totalEl = document.getElementById('kbStatTotal');
  var readyEl = document.getElementById('kbStatReady');
  var procEl = document.getElementById('kbStatProcessing');
  var errEl = document.getElementById('kbStatError');
  var diskEl = document.getElementById('kbStatDisk');

  if (totalEl) totalEl.textContent = docs.length;
  if (readyEl) readyEl.textContent = stats.ready_documents || 0;

  var processingCount = 0;
  var errorCount = 0;
  for (var i = 0; i < docs.length; i++) {
    var s = docs[i].status;
    if (s === 'processing' || s === 'indexing' || s === 'summarizing') processingCount++;
    else if (s === 'error') errorCount++;
  }
  if (procEl) procEl.textContent = processingCount;
  if (errEl) errEl.textContent = errorCount;

  var totalSize = 0;
  for (var j = 0; j < docs.length; j++) {
    totalSize += docs[j].file_size || 0;
  }
  if (diskEl) {
    diskEl.textContent = totalSize > 1073741824 ? (totalSize/1073741824).toFixed(1)+' GB' :
                         totalSize > 1048576 ? (totalSize/1048576).toFixed(0)+' MB' :
                         (totalSize/1024).toFixed(0)+' KB';
  }
}

// --- P6: 标签树渲染（侧栏，基于 LLM 语义分组） ---
var _kbActiveTagFilter = null;
var _kbNameFilter = '';

var _kbExpandedGroups = new Set();  // 展开的分组名集合

// P6 重构：按文档 category 字段分组渲染侧栏（一个文档一个分类）
function _kbRenderCategoryTree(docs) {
  var listEl = document.getElementById('kbSidebarList');
  if (!listEl) return;
  docs = docs || _kbLastDocs || [];

  // 统计每个 category 下的文档数
  var catGroups = {};   // {category: [doc_id, ...]}
  var noCategoryCount = 0;
  for (var i = 0; i < docs.length; i++) {
    var d = docs[i];
    var cat = d.category || '';
    if (cat) {
      if (!catGroups[cat]) catGroups[cat] = [];
      catGroups[cat].push(d.doc_id);
    } else {
      noCategoryCount++;
    }
  }

  // 排序：按文档数倒序
  var catNames = Object.keys(catGroups);
  catNames.sort(function(a, b) { return catGroups[b].length - catGroups[a].length; });

  var totalDocs = docs.length;
  var html = '<div class="kb-tag all' + (_kbActiveTagFilter === null ? ' sel' : '') +
    '" data-tag="__all__" onclick="kbFilterByTag(null,this)"><span class="dot"></span>全部文档<span class="cnt">' +
    totalDocs + '</span></div>';

  // 渲染每个分类
  for (var ci = 0; ci < catNames.length; ci++) {
    var catName = catNames[ci];
    var count = catGroups[catName].length;
    var isSel = _kbActiveTagFilter === catName;
    var cls = 'kb-tag cat' + (isSel ? ' sel' : '');
    var escapedCat = catName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    html += '<div class="' + cls + '" data-tag="' + esc(catName) + '" onclick="kbFilterByTag(\'' + escapedCat + '\',this)">' +
      '<span class="dot"></span>' + esc(catName) +
      '<span class="cnt">' + count + '</span></div>';
  }

  // 没有 category 的文档（tag_status != done 的）
  if (noCategoryCount > 0) {
    var isUnSel = _kbActiveTagFilter === '__uncategorized__';
    html += '<div class="kb-tag cat' + (isUnSel ? ' sel' : '') + '" style="opacity:.6" data-tag="__uncategorized__" onclick="kbFilterByTag(\'__uncategorized__\',this)">' +
      '<span class="dot"></span>未分类' +
      '<span class="cnt">' + noCategoryCount + '</span></div>';
  }

  listEl.innerHTML = html;
}

// 兼容旧接口（保留空实现防止报错）
async function kbFetchTagGroups() { return Promise.resolve(); }
async function kbTriggerGrouping() { return Promise.resolve(); }
function _kbRenderTagTree() { _kbRenderCategoryTree(_kbLastDocs); }

// 切换分组展开/折叠
function kbToggleGroup(groupName, event) {
  if (event) event.stopPropagation();
  if (_kbExpandedGroups.has(groupName)) {
    _kbExpandedGroups.delete(groupName);
  } else {
    _kbExpandedGroups.add(groupName);
  }
  _kbRenderTagTree();
}

// 收集匹配标签（用于筛选）：支持分组名匹配所有成员
function _kbCollectMatchTags(filterTag) {
  var result = new Set();
  result.add(filterTag);
  // 检查是否是分组名
  for (var i = 0; i < _kbTagGroups.length; i++) {
    if (_kbTagGroups[i].group === filterTag) {
      for (var j = 0; j < _kbTagGroups[i].members.length; j++) {
        result.add(_kbTagGroups[i].members[j]);
      }
      break;
    }
  }
  return result;
}

// 完整的标签树渲染入口（异步获取分组数据后渲染）
function kbRenderTagTree(docs) {
  _kbLastDocs = docs || _kbLastDocs;
  kbFetchTagGroups().then(function() {
    _kbRenderTagTree();
  });
}

// --- 按标签筛选 ---
function kbFilterByTag(tagName, el) {
  _kbActiveTagFilter = tagName;

  // 更新侧栏选中状态（kb-tag, kb-group, kb-group-tag）
  var items = document.querySelectorAll('#kbSidebarList .kb-tag, #kbSidebarList .kb-group, #kbSidebarList .kb-group-tag');
  for (var i = 0; i < items.length; i++) {
    var itemTag = items[i].getAttribute('data-tag');
    var itemGroup = items[i].getAttribute('data-group');
    var isSel = itemTag === (tagName || '__all__') || itemGroup === tagName;
    items[i].classList.toggle('sel', isSel);
  }

  kbRefreshDocs();
}

// --- 按文件名搜索 ---
function kbFilterByName(query) {
  _kbNameFilter = query || '';
  kbRefreshDocs();
}

// --- 卡片点击（进入文档详情/操作） ---
function kbCardClick(docId) {
  // 切换 checkbox 选中状态
  if (typeof kbToggleSelect === 'function') kbToggleSelect(docId);
}

// --- AI 知识库概览 ---
// P6 打磨 #10：LLM 驱动的概览刷新
async function kbRefreshOverviewLLM() {
  var btn = document.getElementById('kbRefreshBtn');
  var sidebarHdr = document.querySelector('#kbSidebar .kb-sidebar-hdr');
  var sidebarOrig = sidebarHdr ? sidebarHdr.innerHTML : '';

  if (btn) { btn.disabled = true; btn.innerHTML = iconSvg('spin','11') + ' 整理中...'; }
  if (sidebarHdr) sidebarHdr.innerHTML = iconSvg('spin','12') + ' AI 智能筛选 — 重新整理中...';

  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/overview/refresh', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'
    });
    var data = await resp.json();
    if (data.ok) {
      _kbLastInsightData = {
        insight: data.insight || '',
        categories: data.categories || {},
        suggested_questions: data.suggested_questions || [],
        doc_count: data.doc_count || 0
      };
      _kbRenderInsightDashboard(_kbLastInsightData);
      try {
        localStorage.setItem('kb_ai_insight', data.insight || '');
        localStorage.setItem('kb_ai_cats', JSON.stringify(data.categories || {}));
        localStorage.setItem('kb_ai_questions', JSON.stringify(data.suggested_questions || []));
        localStorage.setItem('kb_ai_count', String(data.doc_count));
      } catch(e) {}
      if (data.merges_applied && data.merges_applied.length > 0) {
        try { if (typeof kbRefreshDocs === 'function') kbRefreshDocs(); } catch(e) {}
      }
    }
  } catch (e) { }
  finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="10" height="10" viewBox="0 0 14 14" fill="none"><path d="M2 7a5 5 0 0110 0M12 7a5 5 0 01-10 0" stroke="currentColor" stroke-width="1.3"/><path d="M2 3v4h4M12 11V7H8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg> 整理'; }
    if (sidebarOrig) { try { var _sh = document.querySelector('#kbSidebar .kb-sidebar-hdr'); if (_sh) _sh.innerHTML = sidebarOrig; } catch(e) {} }
  }
}
// 暴露到 window
window.kbRefreshOverviewLLM = kbRefreshOverviewLLM;

// P6 打磨：仅刷新 AI 洞察区域的统计数（不覆盖 LLM 生成的洞察文本）
function _kbRefreshOverviewStatsOnly() {
  var countEl = document.getElementById('kbOverviewDocCount');
  var updatedEl = document.getElementById('kbOverviewUpdated');
  var docs = _kbLastDocs.length > 0 ? _kbLastDocs : [];
  if (!docs.length) return;
  if (countEl) countEl.textContent = docs.length + ' 篇文档';
  if (updatedEl) {
    var now = new Date();
    updatedEl.textContent = now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0') + ' 更新';
  }
}


// P6: 环形图颜色表（10色，聚类≤10）
var _DONUT_COLORS = ['#7F77DD','#378ADD','#1E9EBF','#639922','#A3B727','#EF9F27','#E05561','#C7528D','#6460B8','#6E8FA8'];
var _donutActiveCategory = null;
var _kbLastInsightData = null;
var _kbLastDocsOrigOrder = null;

function _kbRenderInsightDashboard(data) {
  var bodyEl = document.getElementById('kbOverviewBody');
  var sourceEl = document.getElementById('kbOverviewSource');
  var countEl = document.getElementById('kbOverviewDocCount');
  var updatedEl = document.getElementById('kbOverviewUpdated');
  if (!bodyEl) return;

  var insight = data.insight || '';
  var questions = data.suggested_questions || [];
  var cats = data.categories || {};
  var docCount = data.doc_count || 0;

  if (!insight && docCount === 0) {
    bodyEl.innerHTML = '<div class="kb-dash-empty">上传文档后，AI 会自动聚类并生成洞察分析，帮你发现知识结构中的骨架与空白。</div>';
    return;
  }
  if (!insight) {
    bodyEl.innerHTML = '<div class="kb-dash-empty">正在分析知识库...<br><small>点击「整理」触发 AI 洞察</small></div>';
    return;
  }

  var catEntries = [];
  for (var ck in cats) catEntries.push({ name: ck, count: cats[ck] });
  catEntries.sort(function(a,b){ return b.count - a.count; });
  if (catEntries.length > 10) catEntries = catEntries.slice(0, 10);
  var totalDocs = catEntries.reduce(function(s,c){ return s + c.count; }, 0);
  if (totalDocs === 0) totalDocs = docCount;

  var donutSize = 78, donutR = 31, donutCx = 39, donutCy = 39, donutInner = 18;
  var donutSvg = '<svg class="kb-dash-donut-svg" viewBox="0 0 ' + donutSize + ' ' + donutSize + '" width="' + donutSize + '" height="' + donutSize + '">';
  var angle = -Math.PI / 2;
  for (var ci = 0; ci < catEntries.length; ci++) {
    var cc = catEntries[ci];
    var sliceAngle = (cc.count / totalDocs) * 2 * Math.PI;
    var sa = angle, ea = angle + sliceAngle;
    var x1 = donutCx + donutR * Math.cos(sa), y1 = donutCy + donutR * Math.sin(sa);
    var x2 = donutCx + donutR * Math.cos(ea), y2 = donutCy + donutR * Math.sin(ea);
    var large = (ea - sa) > Math.PI ? 1 : 0;
    var isActive = _donutActiveCategory === cc.name;
    donutSvg += '<path class="kb-donut-slice' + (isActive ? ' donut-active' : '') + '" data-cat="' + escAttr(cc.name) + '" d="M' + donutCx + ' ' + donutCy + ' L' + x1.toFixed(1) + ' ' + y1.toFixed(1) + ' A' + donutR + ' ' + donutR + ' 0 ' + large + ' 1 ' + x2.toFixed(1) + ' ' + y2.toFixed(1) + ' Z" fill="' + (_DONUT_COLORS[ci % _DONUT_COLORS.length]) + '" opacity=".88" onclick="_kbDonutSliceClick(this)" style="cursor:pointer"/>';
    angle = ea;
  }
  donutSvg += '<circle cx="' + donutCx + '" cy="' + donutCy + '" r="' + donutInner + '" fill="var(--bg-primary, #fff)"/>';
  donutSvg += '<text x="' + donutCx + '" y="' + (donutCy - 2) + '" text-anchor="middle" class="kb-dash-donut-center" font-size="15">' + totalDocs + '</text>';
  donutSvg += '<text x="' + donutCx + '" y="' + (donutCy + 9) + '" text-anchor="middle" class="kb-dash-donut-sub">篇</text>';
  donutSvg += '</svg>';

  var legendHtml = '<div class="kb-dash-donut-legend">';
  for (var li = 0; li < catEntries.length; li++) {
    legendHtml += '<div class="kb-dash-donut-legend-item"><span class="kb-dash-donut-dot" style="background:' + _DONUT_COLORS[li % _DONUT_COLORS.length] + '"></span>' + esc(catEntries[li].name) + ' <span class="kb-dash-donut-count">' + catEntries[li].count + '</span></div>';
  }
  legendHtml += '</div>';

  var asksHtml = '';
  if (questions.length > 0) {
    asksHtml = '<div class="kb-dash-divider"></div><div class="kb-dash-asks">';
    for (var qi = 0; qi < questions.length; qi++) {
      asksHtml += '<button class="kb-dash-ask" onclick="_kbDashAsk(\'' + escAttr(questions[qi]) + '\')"><span class="kb-dash-ask-rank">' + (qi + 1) + '</span>' + esc(questions[qi]) + '</button>';
    }
    asksHtml += '</div>';
  }

  bodyEl.innerHTML = '<div class="kb-dash-row">' +
    '<div class="kb-dash-donut">' + donutSvg + legendHtml + '</div>' +
    '<div class="kb-dash-text">' + insight + '</div>' +
    '</div>' +
    '<div class="kb-dash-stats">' +
      '<span class="kb-dash-stat">文档 <span class="kb-dash-stat-val">' + docCount + '</span> 篇</span>' +
      '<span class="kb-dash-stat">主题 <span class="kb-dash-stat-val">' + catEntries.length + '</span> 个</span>' +
    '</div>' +
    asksHtml;

  if (sourceEl) sourceEl.textContent = '本地 AI 整理';
  if (countEl) countEl.textContent = docCount + ' 篇';
  if (updatedEl) {
    var now = new Date();
    updatedEl.textContent = now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0');
  }
}

function _kbDonutSliceClick(el) {
  var catName = el.getAttribute('data-cat');
  if (_donutActiveCategory === catName) {
    _donutActiveCategory = null;
  } else {
    _donutActiveCategory = catName;
  }
  var cached = _kbLastInsightData;
  if (cached) _kbRenderInsightDashboard(cached);
  _kbSortDocsByCategory(_donutActiveCategory);
}
window._kbDonutSliceClick = _kbDonutSliceClick;

function _kbSortDocsByCategory(matchCat) {
  if (!matchCat) {
    if (_kbLastDocsOrigOrder) {
      _kbLastDocs = _kbLastDocsOrigOrder.slice();
      _kbLastDocsOrigOrder = null;
    }
  } else {
    if (!_kbLastDocsOrigOrder) _kbLastDocsOrigOrder = _kbLastDocs.slice();
    var matched = [], rest = [];
    for (var i = 0; i < _kbLastDocs.length; i++) {
      if ((_kbLastDocs[i].category || '') === matchCat) matched.push(_kbLastDocs[i]);
      else rest.push(_kbLastDocs[i]);
    }
    _kbLastDocs = matched.concat(rest);
  }
  _kbSkipFetch = true;
  kbRefreshDocs();
  _kbRenderCategoryTree(_kbLastDocs);
}

function _kbDashAsk(question) {
  try {
    switchTab('chat', document.querySelector('.tabs-nav button'));
    var inp = document.getElementById('chat-input');
    if (inp) {
      inp.value = question;
      var sendBtn = document.getElementById('chatSend');
      if (sendBtn) sendBtn.click();
    }
  } catch(e) { console.warn('[KB] 跳转 Chat 失败', e); }
}
window._kbDashAsk = _kbDashAsk;

async function kbRefreshAIOverview() {
  _kbLastGroupTrigger = 0;
  var bodyEl = document.getElementById('kbOverviewBody');
  if (!bodyEl) return;

  // P6: 始终先从服务端取最新洞察，localStorage 仅离线 fallback
  var cachedInsight = null, cachedCats = null, cachedQuestions = null, cachedCount = 0;
  try {
    var _sr = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/overview/refresh');
    var _sd = await _sr.json();
    if (_sd.insight && Object.keys(_sd.categories || {}).length > 0) {
      cachedInsight = _sd.insight;
      cachedCats = _sd.categories || {};
      cachedQuestions = _sd.suggested_questions || [];
      cachedCount = _sd.doc_count || 0;
      try {
        localStorage.setItem('kb_ai_insight', cachedInsight);
        localStorage.setItem('kb_ai_cats', JSON.stringify(cachedCats));
        localStorage.setItem('kb_ai_questions', JSON.stringify(cachedQuestions));
        localStorage.setItem('kb_ai_count', String(cachedCount));
      } catch(e) {}
    }
  } catch(e) {}
  // 服务端无数据 fallback
  if (!cachedInsight) {
    try {
      var _ci = localStorage.getItem('kb_ai_insight');
      if (_ci) cachedInsight = _ci;
      var _cc = localStorage.getItem('kb_ai_cats');
      if (_cc) cachedCats = JSON.parse(_cc);
      var _cq = localStorage.getItem('kb_ai_questions');
      if (_cq) cachedQuestions = JSON.parse(_cq);
      var _cn = localStorage.getItem('kb_ai_count');
      if (_cn) cachedCount = parseInt(_cn, 10);
    } catch(e) {}
  }

  if (cachedInsight) {
    _kbLastInsightData = { insight: cachedInsight, categories: cachedCats || {}, suggested_questions: cachedQuestions || [], doc_count: cachedCount || (_kbLastDocs.length || 0) };
    _kbRenderInsightDashboard(_kbLastInsightData);
  } else {
    bodyEl.innerHTML = '<div class="kb-dash-empty">点击上方「整理」按钮，AI 将自动聚类并生成洞察分析。</div>';
  }
}

// --- P6 B4: 处理队列管理 ---

/** 向队列添加条目 */
function _kbAddToQueue(docId, filename, conflictInfo) {
  // 去重
  for (var i = 0; i < _kbQueueItems.length; i++) {
    if (_kbQueueItems[i].docId === docId) return;
  }
  var item = {docId: docId, filename: filename || docId, phase: 'queued', pct: 0, error: false};
  if (conflictInfo) {
    item.conflict = true;
    item.conflict_info = conflictInfo;
  }
  _kbQueueItems.push(item);
  _kbRenderQueue();
}

/** 更新队列条目进度 */
function _kbUpdateQueue(docId, phase, pct) {
  for (var i = 0; i < _kbQueueItems.length; i++) {
    if (_kbQueueItems[i].docId === docId) {
      _kbQueueItems[i].phase = phase;
      _kbQueueItems[i].pct = pct;
      if (phase === 'error' || phase === 'timeout') _kbQueueItems[i].error = true;
      break;
    }
  }
  _kbRenderQueue();
}

/** 从队列移除已完成的条目 */
function _kbRemoveFromQueue(docId) {
  _kbQueueItems = _kbQueueItems.filter(function(item) { return item.docId !== docId; });
  _kbRenderQueue();
}

/** P6 修复：根据文档 tag_status 同步队列条目（捕获 LLM 阶段） */
function _kbSyncQueueWithDocs(docs) {
  var changed = false;
  for (var i = 0; i < docs.length; i++) {
    var d = docs[i];
    if (d.status !== 'ready') continue;
    for (var j = 0; j < _kbQueueItems.length; j++) {
      var item = _kbQueueItems[j];
      if (item.docId !== d.doc_id) continue;
      if (item.conflict) continue;  // skip conflict items

      if (d.tag_status === 'pending' && item.phase !== 'tag_pending') {
        item.phase = 'tag_pending';
        changed = true;
      } else if (d.tag_status === 'generating' && item.phase !== 'tag_generating') {
        item.phase = 'tag_generating';
        changed = true;
      } else if (d.tag_status === 'done' || d.tag_status === 'failed') {
        _kbQueueItems = _kbQueueItems.filter(function(it) { return it.docId !== d.doc_id; });
        changed = true;
      }
      break;
    }
  }
  if (changed) _kbRenderQueue();
}

/** 解决重复冲突（P6 审计修复 M1：replace 后给一个合法 phase，避免僵尸） */
function kbResolveConflict(docId, action) {
  var apiBase = (typeof API !== 'undefined') ? API : '';
  if (action === 'replace') {
    // 删除旧文档，保留新上传
    for (var i = 0; i < _kbQueueItems.length; i++) {
      if (_kbQueueItems[i].docId === docId && _kbQueueItems[i].conflict_info) {
        var existingDocId = _kbQueueItems[i].conflict_info.existing_doc_id;
        fetch(apiBase + '/api/kb/documents/' + encodeURIComponent(existingDocId), { method: 'DELETE' })
          .then(function() { kbRefreshDocs(); });
        // M1 修复：清除 conflict 标志后给个 queued phase，让它跟着 SSE 流转
        _kbQueueItems[i].conflict = false;
        _kbQueueItems[i].conflict_info = null;
        _kbQueueItems[i].phase = 'queued';
        _kbQueueItems[i].pct = 0;
        break;
      }
    }
  } else if (action === 'keep') {
    // 删除新上传，保留已有
    fetch(apiBase + '/api/kb/documents/' + encodeURIComponent(docId), { method: 'DELETE' })
      .then(function() { _kbRemoveFromQueue(docId); kbRefreshDocs(); });
    return;  // 已从队列移除，无需再渲染
  } else {
    // cancel — 删除新上传
    fetch(apiBase + '/api/kb/documents/' + encodeURIComponent(docId), { method: 'DELETE' })
      .then(function() { _kbRemoveFromQueue(docId); kbRefreshDocs(); });
    return;
  }
  _kbRenderQueue();
}

/** 渲染队列浮动底栏 */
function _kbRenderQueue() {
  var floatBar = document.getElementById('kbFloatBar');
  var floatText = document.getElementById('kbFloatText');
  var floatList = document.getElementById('kbFloatList');
  if (!floatBar) return;

  if (_kbQueueItems.length === 0) {
    floatBar.style.display = 'none';
    return;
  }

  floatBar.style.display = 'flex';
  if (floatText) floatText.textContent = '处理中 ' + _kbQueueItems.length + ' 项';

  var listHtml = '';
  for (var i = 0; i < _kbQueueItems.length; i++) {
    var item = _kbQueueItems[i];

    // Fix 4: conflict items get special rendering
    if (item.conflict && item.conflict_info) {
      listHtml += '<div class="kb-qitem kb-qconflict">';
      listHtml += '<span>' + esc(item.filename) + ' — 检测到重复</span>';
      listHtml += '<button class="btn btn-xs" onclick="kbResolveConflict(\'' + esc(item.docId) + '\',\'replace\')">替换</button>';
      listHtml += '<button class="btn btn-xs" onclick="kbResolveConflict(\'' + esc(item.docId) + '\',\'keep\')">保留</button>';
      listHtml += '<button class="btn btn-xs" onclick="kbResolveConflict(\'' + esc(item.docId) + '\',\'cancel\')">取消</button>';
      listHtml += '</div>';
      continue;
    }

    // Fix 2: 显示完整的处理阶段 + 实时百分比
    var phaseLabel;
    if (item.phase === 'chunking') {
      phaseLabel = '切分段落 (' + (item.pct || 0) + '%)';
    } else if (item.phase === 'embedding') {
      phaseLabel = '向量化 (' + (item.pct || 0) + '%)';
    } else if (item.phase === 'queued') {
      phaseLabel = '排队等待处理';
    } else if (item.phase === 'tag_pending') {
      phaseLabel = '排队等待 AI 摘要';
    } else if (item.phase === 'tag_generating') {
      phaseLabel = 'AI 正在生成摘要';
    } else {
      phaseLabel = '处理中';
    }

    listHtml += '<div class="kb-qitem">' + esc(item.filename) + ' <span class="qi-pct">' + phaseLabel + '</span></div>';
  }
  if (floatList) floatList.innerHTML = listHtml;
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
  var files = Array.from(e.dataTransfer.files);
  for (var i = 0; i < files.length; i++) {
    await kbUploadFile(files[i]);
  }
}

// P6 拖拽视觉反馈
function kbHandleDragOver(e) {
  e.preventDefault();
  var page = document.getElementById('kbFullInterface');
  if (page) page.classList.add('drag-over');
}
function kbHandleDragLeave(e) {
  // 只有真正离开 kb-page 才清除（子元素间移动不触发）
  var page = document.getElementById('kbFullInterface');
  if (!page) return;
  var related = e.relatedTarget;
  if (!related || !page.contains(related)) {
    page.classList.remove('drag-over');
  }
}
async function kbHandleDrop(e) {
  e.preventDefault();
  var page = document.getElementById('kbFullInterface');
  if (page) page.classList.remove('drag-over');
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
      if (data.has_images && data.image_count > 0) {
        if (typeof showToast === 'function') {
          showToast('文档包含 ' + data.image_count + ' 张图片，当前版本不支持图片内容提取', 'warning', 5000);
        }
      }
      if (data.duplicate_detected && data.duplicate_info) {
        showToast('检测到与「' + (data.duplicate_info.existing_filename || '已有文档') + '」重复，已标记', 'warning', 6000);
      }
      kbRefreshDocs();

      if (data.doc_id) {
        var conflictInfo = null;
        if (data.duplicate_detected && data.duplicate_info) {
          conflictInfo = data.duplicate_info;
        }
        _kbAddToQueue(data.doc_id, f.name, conflictInfo);
        // P6 打磨：冲突文档不建立 SSE（不处理），避免连接数爆仓
        if (!conflictInfo) {
          kbSubscribeProgress(data.doc_id, f.name);
        }
      }
    } else {
      showToast('上传失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('上传失败: ' + err.message, 'error');
  }
}

// --- 文档处理进度 SSE ---
var _kbActiveEventSources = 0;
var _kbMaxEventSources = 3;
var _kbPendingSubscriptions = [];

function kbSubscribeProgress(docId, filename) {
  // P6 打磨：限制并发 EventSource 数量
  if (_kbActiveEventSources >= _kbMaxEventSources) {
    _kbPendingSubscriptions.push({docId: docId, filename: filename});
    return;
  }

  var apiBase = (typeof API !== 'undefined') ? API : '';
  var url = apiBase + '/api/kb/progress/' + encodeURIComponent(docId);
  var es;
  try {
    es = new EventSource(url);
    _kbActiveEventSources++;
  } catch (e) {
    console.warn('[KB] SSE 不支持，回退轮询', e);
    return;
  }
  es.onmessage = function(ev) {
    try {
      var d = JSON.parse(ev.data);
      // Fix A: 两阶段进度映射 — chunking: 0-5%, embedding: 5-100%
      var phaseText;
      var pct;
      if (d.phase === 'chunking') {
        phaseText = '切片中...';
        pct = Math.round((d.progress || 0) * 100);  // 0-5%
      } else if (d.phase === 'embedding') {
        phaseText = '生成向量...';
        pct = Math.round((d.progress || 0) * 100);  // 5-100%
      } else {
        phaseText = {
          'subscribed': '准备中', 'chunking_done': '切块完成',
          'done': '完成', 'error': '失败', 'timeout': '超时', 'unknown': '等待中'
        }[d.phase] || d.phase;
        pct = Math.round((d.progress || 0) * 100);
      }

      var detail = '';
      if (d.chunk_total) detail = ' · ' + (d.chunk_done || 0) + '/' + d.chunk_total + ' 块';
      if (d.batch_total && d.batch_total > 1) detail += ' · 第 ' + (d.batch_idx || 0) + '/' + d.batch_total + ' 批';

      // P6 B4/B5: 更新队列面板
      _kbUpdateQueue(docId, d.phase, pct);

      if (typeof showToast === 'function') {
        if (d.phase === 'done') {
          showToast((filename || '') + ' 处理完成' + detail, 'success', 3000);
        } else if (d.phase === 'error') {
          showToast((filename || '') + ' 处理失败', 'error', 5000);
        }
      }
      if (d.phase === 'done' || d.phase === 'error' || d.phase === 'timeout') {
        es.close();
        _kbActiveEventSources--;
        _kbTryNextSubscription();  // P6 打磨：释放连接槽位，处理下一个订阅
        // P6 B5: 从队列移除已完成/失败/超时条目
        _kbRemoveFromQueue(docId);
        kbRefreshDocs();
        // 自动触发 AI 洞察已移至轮询停止时（确保含标签全部完成）
      }
    } catch (e) { console.warn('[KB] SSE 解析失败', e); }
  };
  es.onerror = function() {
    try { es.close(); } catch (e) {}
    _kbActiveEventSources--;
    _kbTryNextSubscription();
  };
  setTimeout(function() {
    try { es.close(); } catch (e) {}
    _kbActiveEventSources--;
    _kbTryNextSubscription();
  }, 60000);
}

// P6 打磨：处理排队的 SSE 订阅
function _kbTryNextSubscription() {
  if (_kbPendingSubscriptions.length === 0) return;
  if (_kbActiveEventSources >= _kbMaxEventSources) return;
  var next = _kbPendingSubscriptions.shift();
  kbSubscribeProgress(next.docId, next.filename);
}

// --- 文档操作 ---
async function kbDeleteDoc(docId) {
  if (!(await showDialog('确认删除', '确定删除此文档？删除后无法恢复。', {type: 'danger', confirm: true, confirmLabel: '删除', cancelLabel: '取消'}))) return;
  try {
    await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/documents/' + docId, { method: 'DELETE' });
    kbRefreshDocs();
    // P6: 删除后自动刷新洞察和标签归并
    setTimeout(function() { if (typeof kbRefreshOverviewLLM === 'function') kbRefreshOverviewLLM(); }, 500);
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

// Fix B: 重新生成摘要
async function kbRetrySummary(docId) {
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/documents/' + encodeURIComponent(docId) + '/retry-summary', { method: 'POST' });
    var data = await resp.json();
    if (data.ok) {
      showToast('已重新触发摘要生成');
      kbRefreshDocs();
    } else {
      showToast('重试失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) { showToast('重试失败: ' + err.message, 'error'); }
}

// --- 文库功能说明弹窗 ---
function showKbInfo() {
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
    '<li><b>智能问答</b>：在对话 Tab 选择「查知识库」action，AI 基于文档内容回答</li>',
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

// --- P6: 令牌管理（Token Management） ---

var _kbTokenCache = [];  // 缓存最近的令牌列表

/** 刷新令牌列表并渲染令牌管理面板 */
async function kbRefreshTokens() {
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/tokens');
    var data = await resp.json();
    _kbTokenCache = data.tokens || [];
    _kbRenderTokenPanel(_kbTokenCache);
  } catch (e) {
    silentLog('[KB] 刷新令牌列表失败:', e);
  }
}

/** 渲染令牌管理面板到侧栏 */
function _kbRenderTokenPanel(tokens) {
  var panel = document.getElementById('kbSidebarTokens');
  if (!panel) return;

  // 令牌锁图标 SVG
  var svgLock = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><rect x="3" y="6" width="8" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M5 6V4a2 2 0 014 0v2" stroke="currentColor" stroke-width="1.2"/></svg>';

  if (!tokens || !tokens.length) {
    panel.innerHTML = '<div class="kb-token-empty">暂无活跃令牌</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    var levelLabel = t.level === 'full' ? '完整访问' : '仅检索';
    var sessionInfo = t.session_id ? ' · 会话"' + esc(t.session_id) + '"' : '';
    var docLabel = t.doc_id || '未知文档';
    // 截断长 doc_id 用于显示
    if (docLabel.length > 22) docLabel = docLabel.substring(0, 20) + '...';

    html += '<div class="kb-token-item">';
    html += '<div class="kb-token-icon">' + svgLock + '</div>';
    html += '<div class="kb-token-info">';
    html += '<div class="kb-token-doc" title="' + esc(t.doc_id || '') + '">' + esc(docLabel) + '</div>';
    html += '<div class="kb-token-meta">' + levelLabel + sessionInfo + '</div>';
    html += '</div>';
    html += '<div class="kb-token-actions">';
    html += '<button class="kb-token-btn" onclick="event.stopPropagation();kbCopyToken(\'' + esc(t.token) + '\')" title="复制令牌"><svg width="11" height="11" viewBox="0 0 14 14" fill="none"><rect x="3.5" y="3.5" width="8" height="8" rx="1" stroke="currentColor" stroke-width="1.1"/><path d="M1.5 10.5V2a.5.5 0 01.5-.5h8.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg></button>';
    html += '<button class="kb-token-btn" onclick="event.stopPropagation();kbRevokeToken(\'' + esc(t.doc_id) + '\')" title="撤销">' + iconSvg('close', '11') + '</button>';
    html += '</div>';
    html += '</div>';
  }

  html += '<div class="kb-token-footer">';
  html += '<button class="kb-token-revoke-all" onclick="kbRevokeAllTokens()">撤销全部令牌</button>';
  html += '</div>';

  panel.innerHTML = html;
}

/** 为文档生成访问令牌 */
function kbGenerateToken(docId) {
  var level = prompt('令牌级别（full=完整访问 / search=仅检索）：', 'search');
  if (!level || (level !== 'full' && level !== 'search')) {
    if (level !== null) showToast('级别必须为 full 或 search', 'warning');
    return;
  }

  var sessionId = prompt('关联的会话名称（可选，留空跳过）：', '');
  if (sessionId === null) return;  // 用户取消

  var body = { level: level };
  if (sessionId && sessionId.trim()) body.session_id = sessionId.trim();

  fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/documents/' + encodeURIComponent(docId) + '/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function(resp) { return resp.json(); })
    .then(function(data) {
      if (data.token) {
        showToast('令牌已生成');
        kbRefreshTokens();
      } else {
        showToast('生成失败: ' + (data.error || '未知错误'), 'error');
      }
    })
    .catch(function(err) {
      showToast('生成失败: ' + err.message, 'error');
    });
}

/** 撤销文档的所有令牌 */
async function kbRevokeToken(docId) {
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/documents/' + encodeURIComponent(docId) + '/token', {
      method: 'DELETE'
    });
    var data = await resp.json();
    if (resp.ok && data.revoked) {
      showToast('已撤销 ' + (data.count || 0) + ' 个令牌');
      kbRefreshTokens();
    } else {
      showToast('撤销失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (e) {
    showToast('撤销失败: ' + e.message, 'error');
  }
}

/** 撤销所有令牌 */
async function kbRevokeAllTokens() {
  if (!_kbTokenCache || !_kbTokenCache.length) {
    showToast('没有可撤销的令牌', 'warning');
    return;
  }
  if (!(await showDialog('确认撤销', '确定撤销所有 ' + _kbTokenCache.length + ' 个令牌？', {type: 'danger', confirm: true, confirmLabel: '全部撤销', cancelLabel: '取消'}))) return;

  var errorCount = 0;
  var successCount = 0;
  // 按 doc_id 去重后批量撤销
  var docIds = [];
  for (var i = 0; i < _kbTokenCache.length; i++) {
    var dId = _kbTokenCache[i].doc_id;
    if (docIds.indexOf(dId) === -1) docIds.push(dId);
  }
  for (var j = 0; j < docIds.length; j++) {
    try {
      var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/documents/' + encodeURIComponent(docIds[j]) + '/token', {
        method: 'DELETE'
      });
      var data = await resp.json();
      if (resp.ok && data.revoked) successCount += (data.count || 0);
      else errorCount++;
    } catch (e) { errorCount++; }
  }
  if (errorCount === 0) {
    showToast('已撤销全部 ' + successCount + ' 个令牌');
  } else {
    showToast('撤销完成: ' + successCount + ' 成功, ' + errorCount + ' 失败', 'warning');
  }
  kbRefreshTokens();
}

/** 复制令牌到剪贴板 */
function kbCopyToken(tokenStr) {
  if (!tokenStr) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(tokenStr).then(function() {
      showToast('令牌已复制到剪贴板');
    }).catch(function() {
      _fallbackCopy(tokenStr);
    });
  } else {
    _fallbackCopy(tokenStr);
  }
}

/** 降级复制方案（textarea 方式） */
function _fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
    showToast('令牌已复制到剪贴板');
  } catch (e) {
    showToast('复制失败，请手动复制', 'error');
  }
  document.body.removeChild(ta);
}

// --- 暴露到全局 ---
window.kbRouteState = kbRouteState;

// P6: 视图切换（卡片/列表）
function kbSwitchView(mode, btn) {
  _kbViewMode = mode;
  // 更新按钮高亮
  var btns = document.querySelectorAll('.kb-view-btn');
  for (var i = 0; i < btns.length; i++) btns[i].classList.remove('sel');
  if (btn) btn.classList.add('sel');
  // 重新渲染
  kbRefreshDocs();
}
window.kbSwitchView = kbSwitchView;

window.kbInstallModule = kbInstallModule;
window.kbOnModuleFilePicked = kbOnModuleFilePicked;
window.kbOnModuleDrop = kbOnModuleDrop;
window.kbRefreshDocs = kbRefreshDocs;
window.kbOnFilePicked = kbOnFilePicked;
window.kbOnDrop = kbOnDrop;
window.kbUploadFile = kbUploadFile;
window.kbHandleDragOver = kbHandleDragOver;
window.kbHandleDragLeave = kbHandleDragLeave;
window.kbHandleDrop = kbHandleDrop;
window.kbDeleteDoc = kbDeleteDoc;
window.kbPauseDoc = kbPauseDoc;
window.kbResumeDoc = kbResumeDoc;
window.kbCancelDoc = kbCancelDoc;
window.kbRetrySummary = kbRetrySummary;
window.kbFilterByTag = kbFilterByTag;
window.kbFilterByName = kbFilterByName;
window.kbCardClick = kbCardClick;
window.kbRefreshAIOverview = kbRefreshAIOverview;
window.kbRenderTagTree = kbRenderTagTree;
window.kbToggleGroup = kbToggleGroup;
window.kbFetchTagGroups = kbFetchTagGroups;
window.kbTriggerGrouping = kbTriggerGrouping;
window.showKbInfo = showKbInfo;
window.kbRefreshTokens = kbRefreshTokens;
window.kbGenerateToken = kbGenerateToken;
window.kbRevokeToken = kbRevokeToken;
window.kbRevokeAllTokens = kbRevokeAllTokens;
window.kbCopyToken = kbCopyToken;
window.kbResolveConflict = kbResolveConflict;

// _kbBusyProcessing getter
try { Object.defineProperty(window, '_kbBusyProcessing', { get: function() { return _kbBusyProcessing; }, configurable: true }); } catch(e) { window._kbBusyProcessing = _kbBusyProcessing; }

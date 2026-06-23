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
var _kbSkipFetch = false;  // 排序置顶时跳过 API 拉取，直接用 _kbLastDocs
async function kbRefreshDocs() {
  try {
    var docs, stats;
    if (_kbSkipFetch) {
      docs = _kbLastDocs;
      stats = {};  // 排序模式下 stats 不重要
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
  var bodyEl = document.getElementById('kbOverviewBody');
  var sourceEl = document.getElementById('kbOverviewSource');
  var countEl = document.getElementById('kbOverviewDocCount');
  var updatedEl = document.getElementById('kbOverviewUpdated');
  var sidebarHdr = document.querySelector('#kbSidebar .kb-sidebar-hdr');  // P6: 侧栏标题动画
  var sidebarOrig = sidebarHdr ? sidebarHdr.innerHTML : '';

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = iconSvg('spin','11') + ' AI 正在整理...';
  }
  if (bodyEl) bodyEl.textContent = '正在分析文档结构并发现洞察...';
  if (sourceEl) sourceEl.textContent = '本地 AI 生成';
  // P6: 侧栏标题动画
  if (sidebarHdr) sidebarHdr.innerHTML = iconSvg('spin','12') + ' AI 智能筛选 — 重新整理中...';

  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/overview/refresh', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: '{}'
    });
    var data = await resp.json();

    if (data.ok) {
      if (bodyEl) bodyEl.textContent = data.insight || data.overview || '';
      if (countEl) countEl.textContent = data.doc_count + ' 篇文档';
      if (sourceEl) sourceEl.textContent = '本地 AI 整理';
      if (updatedEl) {
        var now = new Date();
        updatedEl.textContent = now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0') + ' 更新';
      }
      // 持久化洞察到 localStorage，防止页面刷新后丢失
      try {
        localStorage.setItem('kb_ai_insight', data.insight || '');
        localStorage.setItem('kb_ai_insight_ts', Date.now());
      } catch(e) {}
      // P6 打磨：标签归并后刷新侧栏分类和文档列表
      if (data.merges_applied && data.merges_applied.length > 0) {
        try { if (typeof kbRefreshDocs === 'function') kbRefreshDocs(); } catch(e) {}
      }
    } else {
      if (bodyEl) bodyEl.textContent = '整理失败，请重试。';
    }
  } catch (e) {
    if (bodyEl) bodyEl.textContent = '网络异常，请重试。';
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M2 7a5 5 0 0110 0M12 7a5 5 0 01-10 0" stroke="currentColor" stroke-width="1.3"/><path d="M2 3v4h4M12 11V7H8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg> 自动整理知识库';
    }
    // P6: 恢复侧栏标题
    if (sidebarOrig) {
      try {
        var _sh = document.querySelector('#kbSidebar .kb-sidebar-hdr');
        if (_sh) _sh.innerHTML = sidebarOrig;
      } catch(e) {}
    }
  }
}
// 暴露到 window
window.kbRefreshOverviewLLM = kbRefreshOverviewLLM;

// P6 打磨：仅刷新 AI 洞察区域的统计数（不覆盖 LLM 生成的洞察文本）
// P6 打磨：仅刷新 AI 洞察区域的统计数（不覆盖 LLM 生成的洞察文本或环形图）
function _kbRefreshOverviewStatsOnly() {
  var docs = _kbLastDocs.length > 0 ? _kbLastDocs : [];
  if (!docs.length) return;
  var countEl = document.getElementById('kbOverviewDocCount');
  var updatedEl = document.getElementById('kbOverviewUpdated');
  if (countEl) countEl.textContent = docs.length + ' 篇';
  if (updatedEl) {
    var now = new Date();
    updatedEl.textContent = now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0');
  }
}

// P6: 环形图颜色表（10色，聚类≤10）
var _DONUT_COLORS = ['#7F77DD','#378ADD','#1E9EBF','#639922','#A3B727','#EF9F27','#E05561','#C7528D','#6460B8','#6E8FA8'];
// P6: 当前选中的扇区（排序置顶用），null=全部
var _donutActiveCategory = null;

// P6 共享渲染：构建仪表盘 HTML 并注入 DOM
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

  // 聚类分布
  var catEntries = [];
  for (var ck in cats) catEntries.push({ name: ck, count: cats[ck] });
  catEntries.sort(function(a,b){ return b.count - a.count; });
  if (catEntries.length > 10) catEntries = catEntries.slice(0, 10);

  var totalDocs = catEntries.reduce(function(s,c){ return s + c.count; }, 0);
  if (totalDocs === 0) totalDocs = docCount;

  // ===== 构建环形图 SVG =====
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

  // 图例
  var legendHtml = '<div class="kb-dash-donut-legend">';
  for (var li = 0; li < catEntries.length; li++) {
    legendHtml += '<div class="kb-dash-donut-legend-item"><span class="kb-dash-donut-dot" style="background:' + _DONUT_COLORS[li % _DONUT_COLORS.length] + '"></span>' + esc(catEntries[li].name) + ' <span class="kb-dash-donut-count">' + catEntries[li].count + '</span></div>';
  }
  legendHtml += '</div>';

  // ===== 追问按钮 =====
  var asksHtml = '';
  if (questions.length > 0) {
    asksHtml = '<div class="kb-dash-divider"></div><div class="kb-dash-asks">';
    for (var qi = 0; qi < questions.length; qi++) {
      asksHtml += '<button class="kb-dash-ask" onclick="_kbDashAsk(\'' + escAttr(questions[qi]) + '\')"><span class="kb-dash-ask-rank">' + (qi + 1) + '</span>' + esc(questions[qi]) + '</button>';
    }
    asksHtml += '</div>';
  }

  // ===== 拼接 HTML =====
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

// P6: 环形扇区点击 → 排序置顶
function _kbDonutSliceClick(el) {
  var catName = el.getAttribute('data-cat');
  if (_donutActiveCategory === catName) {
    _donutActiveCategory = null;  // 取消置顶
  } else {
    _donutActiveCategory = catName;
  }
  // 重新渲染环形图（切换 donut-active）
  var cached = _kbLastInsightData;
  if (cached) _kbRenderInsightDashboard(cached);
  // 文档卡片排序
  _kbSortDocsByCategory(_donutActiveCategory);
}
// 暴露给 onclick
window._kbDonutSliceClick = _kbDonutSliceClick;

// P6: 按分类排序文档卡片（置顶匹配的，其余保持原序）
function _kbSortDocsByCategory(matchCat) {
  if (!matchCat) {
    // 恢复原序
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
  // 跳过 API 重拉，直接用排序后的 _kbLastDocs 渲染
  _kbSkipFetch = true;
  kbRefreshDocs();
  _kbRenderCategoryTree(_kbLastDocs);
}

// P6: 追问按钮 → 跳 Chat Tab
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

// 缓存最近一次洞察数据（用于环形图重渲染）
var _kbLastInsightData = null;
var _kbLastDocsOrigOrder = null;

async function kbRefreshAIOverview() {
  _kbLastGroupTrigger = 0;
  var bodyEl = document.getElementById('kbOverviewBody');
  if (!bodyEl) return;

  // 优先 localStorage，fallback 服务端
  var cachedInsight = null, cachedCats = null, cachedQuestions = null, cachedCount = 0;
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

  if (!cachedInsight) {
    try {
      var _sr = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/overview/refresh');
      var _sd = await _sr.json();
      if (_sd.insight) {
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
  }

  if (cachedInsight) {
    _kbLastInsightData = { insight: cachedInsight, categories: cachedCats || {}, suggested_questions: cachedQuestions || [], doc_count: cachedCount || (_kbLastDocs.length || 0) };
    _kbRenderInsightDashboard(_kbLastInsightData);
  } else {
    bodyEl.innerHTML = '<div class="kb-dash-empty">点击上方「整理」按钮，AI 将自动聚类并生成洞察分析。</div>';
  }
}

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
      // 持久化
      try {
        localStorage.setItem('kb_ai_insight', data.insight || '');
        localStorage.setItem('kb_ai_cats', JSON.stringify(data.categories || {}));
        localStorage.setItem('kb_ai_questions', JSON.stringify(data.suggested_questions || []));
        localStorage.setItem('kb_ai_count', String(data.doc_count));
      } catch(e) {}
      // 标签归并后刷新侧栏
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

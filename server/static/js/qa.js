// ===== qa.js — P6 知识库 Tab：文档档案管理（标签树 + 卡片网格 + AI概览） =====
// 依赖: api.js, errors.js, utils.js, 全局变量 (API)
// 被引用: chat.js (updateKbLockBar), kb-batch.js (kbOnDocsRendered)

var _kbPollTimer = null;
var _kbModuleStatus = null;
var _kbBusyProcessing = false;
var _kbModelsLoaded = false;
var _kbTagClusters = [];
var _kbLastDocs = [];

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
async function kbRefreshDocs() {
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/documents');
    var docs = await resp.json();
    _kbLastDocs = docs;
    var statsResp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/stats');
    var stats = await statsResp.json();

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

    // 更新侧栏底部统计
    var ft = document.getElementById('kbSidebarFt');
    if (ft) {
      var tagCount = _kbTagClusters.length || 0;
      ft.textContent = _readyCount + '篇 · ' + tagCount + '标签';
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

      // 应用标签筛选
      if (_kbActiveTagFilter) {
        var tagMatch = false;
        if (d.tags && d.tags.length > 0) {
          for (var ti = 0; ti < d.tags.length; ti++) {
            if (d.tags[ti] === _kbActiveTagFilter) { tagMatch = true; break; }
          }
        }
        if (!tagMatch) continue;
      }

      // 应用名称搜索筛选
      if (_kbNameFilter && d.filename.toLowerCase().indexOf(_kbNameFilter.toLowerCase()) === -1) continue;

      var sizeStr = d.file_size > 1048576 ? (d.file_size/1048576).toFixed(1)+'MB' : d.file_size > 1024 ? (d.file_size/1024).toFixed(1)+'KB' : d.file_size+'B';
      var chunkInfo = d.chunk_count ? d.chunk_count + '块' : '';
      var tokenInfo = d.total_chars ? '~' + (d.total_chars/1000).toFixed(1) + 'K' : '';

      // 状态图标
      var iconsHtml = '';
      if (d.is_private) iconsHtml += '<span class="ic-lock" title="私密文档">' + svgLock + '</span>';
      if (d.metadata && d.metadata.duplicate_of) iconsHtml += '<span class="ic-dup" title="检测到重复">' + svgDup + '</span>';
      if (d.metadata && d.metadata.has_images) iconsHtml += '<span class="ic-img" title="含图片">' + svgImg + '</span>';

      // 热力图圆点
      var hitCount = d.hit_count || 0;
      var hmDotClass = hitCount >= 10 ? 'hot' : (hitCount >= 1 ? 'warm' : 'cold');
      var hmDotHtml = '<span style="display:flex;align-items:center;gap:3px"><span class="hm-dot ' + hmDotClass + '"></span>' + hitCount + '</span>';

      // 内容预览
      var previewText = d.summary || '';
      if (!previewText && d.content_snippet) previewText = d.content_snippet;
      if (previewText && previewText.length > 120) previewText = previewText.substring(0, 120) + '...';
      if (!previewText) previewText = '(暂无预览)';

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
      html += '<div class="cbar">';
      html += '<span class="ctitle" title="' + esc(d.filename) + '">' + esc(d.filename) + '</span>';
      if (iconsHtml) html += '<div class="cicons">' + iconsHtml + '</div>';
      html += '</div>';
      html += '<div class="cpreview">' + esc(previewText) + '</div>';
      if (tagsHtml) html += '<div class="ctags">' + tagsHtml + '</div>';
      html += '<div class="cstats">';
      html += '<span>' + sizeStr + '</span>';
      if (chunkInfo) html += '<span>' + chunkInfo + '</span>';
      if (tokenInfo) html += '<span>' + tokenInfo + '</span>';
      html += hmDotHtml;
      html += '</div>';
      // P6: 私密文档的令牌按钮
      if (d.is_private) {
        html += '<div class="ctoken-act">';
        html += '<button class="ctoken-btn" onclick="event.stopPropagation();kbGenerateToken(\'' + esc(d.doc_id) + '\')" title="生成访问令牌"><svg width="10" height="10" viewBox="0 0 14 14" fill="none"><rect x="3" y="6" width="8" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M5 6V4a2 2 0 014 0v2" stroke="currentColor" stroke-width="1.2"/></svg> 令牌</button>';
        html += '</div>';
      }
      html += '<div class="cmtime">' + uploadTime + '</div>';
      html += '</div>';
    }

    if (gridEl) gridEl.innerHTML = html;

    // 通知 kb-batch.js
    if (typeof kbOnDocsRendered === 'function') kbOnDocsRendered(docs);

    // 轮询管理
    var hasProcessing = docs.some(function(d) { return ['processing', 'indexing', 'summarizing'].indexOf(d.status) >= 0; });
    var hasPendingTags = docs.some(function(d) { return ['pending','generating','failed'].indexOf(d.tag_status) >= 0 && d.status === 'ready'; });
    if ((hasProcessing || hasPendingTags) && !_kbPollTimer) {
      _kbPollTimer = setInterval(kbRefreshDocs, 3000);
    } else if (!hasProcessing && !hasPendingTags && _kbPollTimer) {
      clearInterval(_kbPollTimer);
      _kbPollTimer = null;
    }

    // P6: 刷新令牌面板
    kbRefreshTokens();
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

// --- P6: 标签树渲染（侧栏） ---
var _kbActiveTagFilter = null;
var _kbNameFilter = '';

function kbRenderTagTree(docs) {
  var listEl = document.getElementById('kbSidebarList');
  if (!listEl) return;

  // 收集所有标签及计数
  var tagCounts = {};
  var totalTagged = 0;
  for (var i = 0; i < docs.length; i++) {
    var d = docs[i];
    if (d.tag_status === 'done' && d.tags && d.tags.length > 0) {
      for (var j = 0; j < d.tags.length; j++) {
        var t = d.tags[j];
        tagCounts[t] = (tagCounts[t] || 0) + 1;
        totalTagged++;
      }
    }
  }

  // 按计数排序
  var tagEntries = [];
  for (var tagName in tagCounts) {
    tagEntries.push({name: tagName, count: tagCounts[tagName]});
  }
  tagEntries.sort(function(a, b) { return b.count - a.count; });

  _kbTagClusters = tagEntries;

  // 渲染
  var html = '<div class="kb-tag all' + (_kbActiveTagFilter === null ? ' sel' : '') + '" data-tag="__all__" onclick="kbFilterByTag(null,this)"><span class="dot"></span>全部文档<span class="cnt">' + docs.length + '</span></div>';

  for (var k = 0; k < tagEntries.length; k++) {
    var te = tagEntries[k];
    var isSel = _kbActiveTagFilter === te.name;
    html += '<div class="kb-tag' + (isSel ? ' sel' : '') + '" data-tag="' + esc(te.name) + '" onclick="kbFilterByTag(\'' + esc(te.name) + '\',this)"><span class="dot"></span>' + esc(te.name) + '<span class="cnt">' + te.count + '</span></div>';
  }

  listEl.innerHTML = html;

  // 更新侧栏底部
  var ft = document.getElementById('kbSidebarFt');
  if (ft) ft.textContent = docs.length + '篇 · ' + tagEntries.length + '标签';
}

// --- 按标签筛选 ---
function kbFilterByTag(tagName, el) {
  _kbActiveTagFilter = tagName;

  // 更新侧栏选中状态
  var items = document.querySelectorAll('#kbSidebarList .kb-tag');
  for (var i = 0; i < items.length; i++) {
    items[i].classList.toggle('sel', items[i].getAttribute('data-tag') === (tagName || '__all__'));
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
async function kbRefreshAIOverview() {
  var bodyEl = document.getElementById('kbOverviewBody');
  var sourceEl = document.getElementById('kbOverviewSource');
  var countEl = document.getElementById('kbOverviewDocCount');
  var updatedEl = document.getElementById('kbOverviewUpdated');

  if (!bodyEl) return;

  bodyEl.textContent = '正在分析知识库...';

  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/documents');
    var docs = await resp.json();

    if (!docs.length) {
      bodyEl.textContent = '知识库为空，请先上传文档。';
      if (countEl) countEl.textContent = '0 篇文档';
      if (sourceEl) sourceEl.textContent = '本地 AI 生成';
      if (updatedEl) updatedEl.textContent = '--';
      return;
    }

    // 按标签分组统计
    var tagGroups = {};
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (d.tag_status === 'done' && d.tags) {
        for (var j = 0; j < d.tags.length; j++) {
          tagGroups[d.tags[j]] = (tagGroups[d.tags[j]] || 0) + 1;
        }
      }
    }

    // 取 top 3 领域
    var topTags = [];
    for (var k in tagGroups) {
      topTags.push({name: k, count: tagGroups[k]});
    }
    topTags.sort(function(a, b) { return b.count - a.count; });
    topTags = topTags.slice(0, 3);

    if (topTags.length > 0) {
      var summaryText = '你的知识库主要覆盖三大领域：';
      for (var t = 0; t < topTags.length; t++) {
        if (t > 0) summaryText += '、';
        summaryText += '<b>' + esc(topTags[t].name) + '</b>（' + topTags[t].count + '篇）';
      }
      summaryText += '。';
      bodyEl.innerHTML = summaryText;
    } else {
      bodyEl.textContent = '已上传 ' + docs.length + ' 篇文档。AI 标签生成后可查看领域分析。';
    }

    if (countEl) countEl.textContent = docs.length + ' 篇文档';
    if (sourceEl) sourceEl.textContent = '本地 AI 生成';
    if (updatedEl) {
      var now = new Date();
      updatedEl.textContent = now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0') + ' 更新';
    }
  } catch (e) {
    bodyEl.textContent = '分析失败，请重试。';
    if (sourceEl) sourceEl.textContent = '本地 AI 生成';
  }
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
        kbSubscribeProgress(data.doc_id, f.name);
      }
    } else {
      showToast('上传失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('上传失败: ' + err.message, 'error');
  }
}

// --- 文档处理进度 SSE ---
function kbSubscribeProgress(docId, filename) {
  var apiBase = (typeof API !== 'undefined') ? API : '';
  var url = apiBase + '/api/kb/progress/' + encodeURIComponent(docId);
  var es;
  try {
    es = new EventSource(url);
  } catch (e) {
    console.warn('[KB] SSE 不支持，回退轮询', e);
    return;
  }
  es.onmessage = function(ev) {
    try {
      var d = JSON.parse(ev.data);
      var phaseText = {
        'subscribed': '准备中', 'chunking_done': '切块完成', 'embedding': '正在生成向量',
        'done': '完成', 'error': '失败', 'timeout': '超时', 'unknown': '等待中'
      }[d.phase] || d.phase;

      var pct = Math.round((d.progress || 0) * 100);
      var detail = '';
      if (d.chunk_total) detail = ' · ' + (d.chunk_done || 0) + '/' + d.chunk_total + ' 块';
      if (d.batch_total && d.batch_total > 1) detail += ' · 第 ' + (d.batch_idx || 0) + '/' + d.batch_total + ' 批';

      if (typeof showToast === 'function') {
        if (d.phase === 'done') {
          showToast('✓ ' + (filename || '') + ' 处理完成' + detail, 'success', 3000);
        } else if (d.phase === 'error') {
          showToast('✗ ' + (filename || '') + ' 处理失败', 'error', 5000);
        } else if (pct > 0 && pct < 100) {
          showToast('⏳ ' + (filename || '') + ' · ' + phaseText + ' · ' + pct + '%' + detail, 'info', 2000);
        }
      }
      if (d.phase === 'done' || d.phase === 'error' || d.phase === 'timeout') {
        es.close();
        kbRefreshDocs();
      }
    } catch (e) { console.warn('[KB] SSE 解析失败', e); }
  };
  es.onerror = function() { try { es.close(); } catch (e) {} };
  setTimeout(function() { try { es.close(); } catch (e) {} }, 60000);
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
window.kbInstallModule = kbInstallModule;
window.kbOnModuleFilePicked = kbOnModuleFilePicked;
window.kbOnModuleDrop = kbOnModuleDrop;
window.kbRefreshDocs = kbRefreshDocs;
window.kbOnFilePicked = kbOnFilePicked;
window.kbOnDrop = kbOnDrop;
window.kbUploadFile = kbUploadFile;
window.kbDeleteDoc = kbDeleteDoc;
window.kbPauseDoc = kbPauseDoc;
window.kbResumeDoc = kbResumeDoc;
window.kbCancelDoc = kbCancelDoc;
window.kbFilterByTag = kbFilterByTag;
window.kbFilterByName = kbFilterByName;
window.kbCardClick = kbCardClick;
window.kbRefreshAIOverview = kbRefreshAIOverview;
window.kbRenderTagTree = kbRenderTagTree;
window.showKbInfo = showKbInfo;
window.kbRefreshTokens = kbRefreshTokens;
window.kbGenerateToken = kbGenerateToken;
window.kbRevokeToken = kbRevokeToken;
window.kbRevokeAllTokens = kbRevokeAllTokens;
window.kbCopyToken = kbCopyToken;

// _kbBusyProcessing getter
try { Object.defineProperty(window, '_kbBusyProcessing', { get: function() { return _kbBusyProcessing; }, configurable: true }); } catch(e) { window._kbBusyProcessing = _kbBusyProcessing; }

// ===== qa.js — P6 知识库 Tab：文档档案管理（标签树 + 卡片网格 + AI概览） =====
// 依赖: api.js, errors.js, utils.js, 全局变量 (API)
// 被引用: chat.js (updateKbLockBar), kb-batch.js (kbOnDocsRendered)

var _kbPollTimer = null;
var _kbModuleStatus = null;
var _kbBusyProcessing = false;

// P6 审计修复 M5：切出 KB Tab 时清理轮询定时器 + 关闭所有 SSE 连接，防止泄漏
function _kbStopPolling() {
  if (_kbPollTimer) {
    clearInterval(_kbPollTimer);
    _kbPollTimer = null;
  }
  // M5: 关闭所有活跃 SSE 连接（切 Tab 后不需要继续接收进度，切回时会重新订阅）
  // 记录被关闭的 docId，供切回时恢复订阅
  _kbClosedDocIds = [];
  for (var _did in _kbEventSources) {
    try { _kbEventSources[_did].close(); } catch (e) {}
    _kbClosedDocIds.push(_did);
  }
  _kbEventSources = {};
  _kbActiveEventSources = 0;
  _kbPendingSubscriptions = [];  // 排队中的也清空，切回时按需重建
}
var _kbClosedDocIds = [];   // M5: 切 Tab 时被关闭的 SSE docId，切回时恢复
var _kbModelsLoaded = false;
var _kbTagClusters = [];
var _kbLastDocs = [];
var _kbViewMode = 'card';  // P6: 'card' | 'list'
var _kbRefreshSeq = 0;     // M4: 请求序号，丢弃过期响应避免竞态
var _kbFilterTimer = null; // M3: 搜索防抖计时器

// P6: KB 文档视图切换（卡片/列表）
function kbSwitchView(mode, btn) {
  _kbViewMode = mode;
  // 更新按钮选中态
  var toggle = document.getElementById('kbViewToggle');
  if (toggle) {
    toggle.querySelectorAll('.kb-view-btn').forEach(function(b) { b.classList.remove('sel'); });
    if (btn) btn.classList.add('sel');
  }
  // 重新渲染文档列表
  if (typeof kbRefreshDocs === 'function') kbRefreshDocs();
}
window.kbSwitchView = kbSwitchView;
var _kbQueueItems = [];  // P6 B4: 处理队列 [{{docId, filename, phase, pct, error}}]

// 标签分组（LLM 语义归并）
var _kbTagGroups = [];       // [{group, members, source}, ...]
var _kbGroupUngrouped = [];  // 未分组的标签列表
var _kbLastGroupTrigger = 0;  // 上次触发分组的时间戳 (ms)，用于冷却

// --- KB Tab 锁徽标 ---
// 知识库 Tab 始终展示；未安装 KB 模型时在 Tab 上显示 🔒 状态锁，
// 点击后由 kbRouteState 路由到 kbOnboarding 引导页（即锁定态界面）。
async function updateKbTabLock(status) {
  var lock = document.getElementById('kbTabLock');
  if (!lock) return;
  try {
    // P8-6：优先用统一状态里的 kb.installed（与锁卡/门禁同源），没有再单独拉
    if (!status && window._appState && window._appState.kb) {
      status = { installed: window._appState.kb.installed };
    }
    if (!status) {
      var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/module-status');
      status = await resp.json();
    }
    lock.style.display = (status && status.installed) ? 'none' : '';
  } catch (e) {
    lock.style.display = 'none';  // 状态未知时不显示锁，避免误导
  }
}
window.updateKbTabLock = updateKbTabLock;

// --- 二态状态路由 ---
// P8-8 首屏兜底守卫：网格为空但数据存在（首屏竞态/渲染异常被吞）时补一次渲染
function _kbEnsureGridRendered() {
  setTimeout(function() {
    var gridEl = document.getElementById('kbDocGrid');
    if (gridEl && !gridEl.children.length && _kbLastDocs && _kbLastDocs.length) {
      console.warn('[KB] 首屏网格为空但已有文档数据，补渲染');
      kbRefreshDocs();
    }
  }, 800);
}

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
    updateKbTabLock(status);

    if (!status.installed) {
      if (loading) loading.style.display = 'none';
      if (onboarding) onboarding.style.display = 'flex';
      return;
    }

    if (loading) loading.style.display = 'none';
    if (fullInterface) fullInterface.style.display = 'flex';
    await kbRefreshDocs();
    _kbResumeSubscriptions();  // M5: 恢复切 Tab 时关闭的 SSE 订阅
    kbRefreshAIOverview();  // P6: 页面加载时恢复洞察
    _kbEnsureGridRendered();  // P8-8: 首屏兜底
  } catch (e) {
    silentLog('[KB] 状态路由失败:', e);
    if (loading) loading.style.display = 'none';
    if (fullInterface) fullInterface.style.display = 'flex';
    await kbRefreshDocs();
    _kbResumeSubscriptions();  // M5: 异常兜底也恢复订阅
    kbRefreshAIOverview();  // P6: 异常兜底也恢复洞察
    _kbEnsureGridRendered();  // P8-8: 首屏兜底
  }
}

// M5: 切回 KB Tab 时，对仍在处理中的文档重新订阅 SSE（之前切 Tab 时被关闭）
function _kbResumeSubscriptions() {
  if (!_kbClosedDocIds || _kbClosedDocIds.length === 0) return;
  // 只恢复仍在处理中的文档（kbRefreshDocs 已更新 _kbLastDocs 状态）
  for (var i = 0; i < _kbClosedDocIds.length; i++) {
    var _did = _kbClosedDocIds[i];
    var _stillProcessing = false;
    for (var j = 0; j < _kbLastDocs.length; j++) {
      if (_kbLastDocs[j].doc_id === _did) {
        var _st = _kbLastDocs[j].status;
        if (_st === 'processing' || _st === 'indexing' || _st === 'pending') _stillProcessing = true;
        break;
      }
    }
    if (_stillProcessing) {
      // 从队列找文件名（订阅需要显示用）
      var _fn = '';
      for (var k = 0; k < _kbQueueItems.length; k++) {
        if (_kbQueueItems[k].docId === _did) { _fn = _kbQueueItems[k].filename || ''; break; }
      }
      kbSubscribeProgress(_did, _fn);
    }
  }
  _kbClosedDocIds = [];
}

// --- KB 模型遮罩 ---
async function _updateKbOverlay() {
  var overlay = document.getElementById('kbModelOverlay');
  var titleEl = document.getElementById('kbOverlayTitle');
  var descEl = document.getElementById('kbOverlayDesc');
  var btnEl = document.getElementById('kbOverlayBtn');
  var btn2El = document.getElementById('kbOverlayBtn2');

  if (!overlay || !_kbModuleStatus || !_kbModuleStatus.installed) {
    if (overlay) overlay.style.display = 'none';
    return;
  }

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
    if (descEl) descEl.textContent = missing.join('、') + ' 文件未找到，请重新安装知识库模块。';
    if (btnEl) { btnEl.textContent = '前往扩展管理'; btnEl.style.display = ''; }
    if (btn2El) btn2El.style.display = 'none';
  } else {
    var err = _kbModuleStatus.error || '';
    if (titleEl) titleEl.textContent = '模型加载失败';
    if (descEl) {
      var msg = '知识库模型未能成功加载，请重试。';
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
      var _seq = ++_kbRefreshSeq;  // M4: 记录本次请求序号
      var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/documents');
      docs = await resp.json();
      // M4: 若期间有更新的请求发出，丢弃本次过期响应（避免慢响应覆盖新数据）
      if (_seq !== _kbRefreshSeq) return;
      _kbLastDocs = docs;
      var statsResp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/stats');
      if (_seq !== _kbRefreshSeq) return;
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

    // 是否有文档在处理/打标中（stats 无 summarizing_documents 字段，改为基于文档状态统计）
    var _busy = 0;
    for (var _bi = 0; _bi < _kbLastDocs.length; _bi++) {
      var _st = _kbLastDocs[_bi].status, _ts = _kbLastDocs[_bi].tag_status;
      if (_st === 'processing' || _ts === 'pending' || _ts === 'generating') _busy++;
    }
    _kbBusyProcessing = _busy > 0;

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
    // 重建处理队列：只纳入真正"处理中"的文档 + 冲突文档。
    // 修 #18-c：ready + tag_pending/generating 的文档不再入队——它们已处理完，
    // 只是在等 AI 摘要，卡片自身会显示"AI 生成摘要中"提示（见下方 previewText 渲染），
    // 不该挤进浮动"处理中"队列（批量上传时会几十个一起涌入）。
    for (var _ri = 0; _ri < docs.length; _ri++) {
      var _rd = docs[_ri];
      if (_rd.status === 'processing' || _rd.status === 'indexing' || _rd.status === 'summarizing') {
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
    var ft = document.getElementById('kbGridSectionTip');
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
    var svgLock = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="3" y="6" width="8" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M5 6V4a2 2 0 014 0v2" stroke="currentColor" stroke-width="1.2"/></svg>';
    var svgInfo = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.2"/><path d="M7 6.5v3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="7" cy="4.2" r="0.7" fill="currentColor"/></svg>';
    var svgDup = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none"><rect x="3" y="1.5" width="8" height="11" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="1.5" y="3.5" width="8" height="9" rx="1" fill="var(--bg-secondary)" stroke="currentColor" stroke-width="1.2"/></svg>';
    var svgImg = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/><circle cx="5" cy="5.5" r="1.5" stroke="currentColor" stroke-width="0.8"/><path d="M3 10.5l2.5-2.5L8 10l2-2 2 2" stroke="currentColor" stroke-width="0.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var svgEmpty = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M3.5 1.5h5L11.5 4.5v8a.5.5 0 01-.5.5h-7.5a.5.5 0 01-.5-.5V2a.5.5 0 01.5-.5z" stroke="currentColor" stroke-width="1.1"/><path d="M8.5 1.5V4.5h3" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M4 10L10 4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';

    // P8-4: 分批渲染——先过滤出待渲染文档，再按 50 张/批渲染（大文库不卡）
    var _filteredDocs = [];
    for (var _fi2 = 0; _fi2 < docs.length; _fi2++) {
      var _fd = docs[_fi2];
      if (_kbActiveTagFilter) {
        if (_kbActiveTagFilter === '__uncategorized__') { if (_fd.category) continue; }
        else if (_fd.category !== _kbActiveTagFilter &&
                 !(_kbCategoryMergeMap[_kbActiveTagFilter] || []).some(function(_mc) { return _mc === _fd.category; })) {
          // P8-9 v6.1：二级子类筛选（按星图子类归属匹配）
          var _sm1 = (window._kbDocSubMap || {})[_fd.doc_id];
          if (!(_sm1 && _sm1.sub === _kbActiveTagFilter)) continue;
        }
      }
      if (_kbNameFilter && _fd.filename.toLowerCase().indexOf(_kbNameFilter.toLowerCase()) === -1) continue;
      _filteredDocs.push(_fd);
    }
    var _kbCardsHtmlFor = function(subset) {
    var html = '';
    for (var di = 0; di < subset.length; di++) {
      var d = subset[di];

      // P6: 按 category 筛选（一个文档只属于一个分类）
      if (_kbActiveTagFilter) {
        if (_kbActiveTagFilter === '__uncategorized__') {
          // 未分类：category 为空的文档
          if (d.category) continue;
        } else {
          // 精确匹配 category；P8-9 v6.1：子类名走 sub 映射匹配
          if (d.category !== _kbActiveTagFilter &&
              !(_kbCategoryMergeMap[_kbActiveTagFilter] || []).some(function(_mc) { return _mc === d.category; })) {
            var _sm2 = (window._kbDocSubMap || {})[d.doc_id];
            if (!(_sm2 && _sm2.sub === _kbActiveTagFilter)) continue;
          }
        }
      }

      // 应用名称搜索筛选
      if (_kbNameFilter && d.filename.toLowerCase().indexOf(_kbNameFilter.toLowerCase()) === -1) continue;

      var sizeStr = d.file_size > 1048576 ? (d.file_size/1048576).toFixed(1)+'MB' : d.file_size > 1024 ? (d.file_size/1024).toFixed(1)+'KB' : d.file_size+'B';
      var tokenInfo = d.total_chars ? '约 ' + (Math.ceil(d.total_chars/1.5)/1000).toFixed(1) + 'K 词元' : '';
      var hitCount = d.hit_count || 0;
      var hitStr = '被搜索 ' + hitCount + ' 次';

      // 状态图标 + 操作按钮（S9: 私密可点击切换；S3: 详情按钮）
      var iconsHtml = '';
      // S9: 私密锁改为可点击按钮，切换该文档私密状态
      var _privTitle = d.is_private
        ? '私密文档：云端 Agent 不可见，仅在本地检索中使用。点击设为公开'
        : '公开文档：云端 Agent 可访问用于问答。点击设为私密（仅本地可见）';
      iconsHtml += '<span class="ic-lock ic-btn' + (d.is_private ? ' active' : '') + '" title="' + _privTitle + '" onclick="event.stopPropagation();kbTogglePrivacy(\'' + escAttr(d.doc_id) + '\')">' + svgLock + '</span>';
      if (d.metadata && d.metadata.duplicate_of) iconsHtml += '<span class="ic-dup" title="检测到重复">' + svgDup + '</span>';
      if (d.metadata && d.metadata.has_images) iconsHtml += '<span class="ic-img" title="含图片">' + svgImg + '</span>';
      // P6 诊断：空文档标记（has_no_text 优先，旧数据 fallback 到 chunk_count==0）
      var _isEmptyDoc = (d.metadata && d.metadata.has_no_text) || (!d.chunk_count && d.status === 'ready');
      if (_isEmptyDoc) iconsHtml += '<span class="ic-empty" title="无文本内容（可能是扫描件/纯图），建议重新上传">' + svgEmpty + '</span>';
      // S3: 详情按钮（点击查看文档详情，不影响卡片选中）
      iconsHtml += '<span class="ic-btn ic-detail" title="查看详情" onclick="event.stopPropagation();kbShowDocDetail(\'' + escAttr(d.doc_id) + '\')">' + svgInfo + '</span>';

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
          var _phaseLabels = { chunking: '正在切分段落', chunking_done: '段落切分完成', embedding: '正在向量化', queued: '排队中', tag_pending: '等待AI摘要', tag_generating: '正在生成摘要' };
          previewText = (_phaseLabels[_qi.phase] || '处理中') + ' · ' + _qi.pct + '%';
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
          previewText = d.summary || '';
          if (previewText && previewText.length > 120) previewText = previewText.substring(0, 120) + '...';
          if (!previewText) previewText = '暂无摘要';
        } else if (d.tag_status === 'failed') {
          previewText = '摘要生成失败 · 点选后可重试';
          previewExtraClass = ' failed';
        } else {
          previewText = d.summary || '';
          if (previewText && previewText.length > 120) previewText = previewText.substring(0, 120) + '...';
          if (!previewText) previewText = '暂无摘要';
        }
      } else if (d.status === 'error') {
        previewText = '处理失败';
      } else {
        previewText = d.summary || '';
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

      html += '<div class="kb-card' + (_donutActiveCategory && d.category === _donutActiveCategory ? ' pinned' : '') + '" data-doc-id="' + esc(d.doc_id) + '" onclick="kbCardClick(\'' + escAttr(d.doc_id) + '\')">';
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
      // 4. 文件信息（上传时间移到详情弹窗，卡片不再显示）
      html += '<div class="cstats-bottom">';
      html += '<div class="cstats">';
      html += '<span>文件大小 ' + sizeStr + '</span>';
      if (tokenInfo) html += '<span>' + tokenInfo + '</span>';
      // P7-4b: 「被搜索 N 次」可点击查看审计日志（hitCount>0 时才可点）
      if (hitCount > 0) {
        html += '<span class="audit-link" title="点击查看访问记录" onclick="event.stopPropagation();kbShowAuditLog(\'' + escAttr(d.doc_id) + '\',\'' + escAttr(d.filename) + '\')">' + hitStr + '</span>';
      } else {
        html += '<span>' + hitStr + '</span>';
      }
      html += '</div>';
      html += '</div>';
      // P6: 私密文档标记（云端Agent不可见，本地正常访问）
      if (d.is_private) {
        html += '<span class="ctoken-btn" style="opacity:.6;cursor:default" title="私密文档：云端Agent不可见"><svg width="10" height="10" viewBox="0 0 14 14" fill="none"><rect x="3" y="6" width="8" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M5 6V4a2 2 0 014 0v2" stroke="currentColor" stroke-width="1.2"/></svg> 私密</span>';
      }
      // Fix B: 标签生成失败 + 文档已选中 → 显示重试按钮（复用 retry-tagging 端点）
      if (d.tag_status === 'failed' && typeof _kbSelectedDocs !== 'undefined' && _kbSelectedDocs && _kbSelectedDocs.has(d.doc_id)) {
        html += '<div class="ctoken-act">';
        html += '<button class="ctoken-btn" onclick="event.stopPropagation();kbRetrySummary(\'' + escAttr(d.doc_id) + '\')" title="重新生成标签">重新生成标签</button>';
        html += '</div>';
      }
      html += '</div>';
    }
      return html;
    };  // _kbCardsHtmlFor

    var gridEl = document.getElementById('kbDocGrid');
    if (gridEl) {
      // P8-8：网格渲染独立 try/catch——此前渲染异常被外层大 catch 吞掉，
      // 表现为"侧栏有分类、网格空白"且无任何可见错误，无法溯源
      try {
      // P6: 根据 _kbViewMode 切换 class
      gridEl.className = _kbViewMode === 'list' ? 'kb-doc-list' : 'kb-doc-grid';
      // P8-4: 首批 50 张 + IntersectionObserver 滚动加载下一批
      var KB_BATCH = 50;
      gridEl.innerHTML = _kbCardsHtmlFor(_filteredDocs.slice(0, KB_BATCH));
      if (_filteredDocs.length > KB_BATCH) {
        gridEl.insertAdjacentHTML('beforeend',
          '<div id="kbLoadMore" style="grid-column:1/-1;text-align:center;padding:14px;color:var(--text-muted);font-size:12px">下拉加载更多…</div>');
        var _rendered = KB_BATCH;
        var _kbLoadObserver = new IntersectionObserver(function(entries) {
          if (!entries[0].isIntersecting) return;
          var lm = document.getElementById('kbLoadMore');
          var next = _filteredDocs.slice(_rendered, _rendered + KB_BATCH);
          if (next.length && lm) {
            lm.insertAdjacentHTML('beforebegin', _kbCardsHtmlFor(next));
            _rendered += next.length;
          }
          if (_rendered >= _filteredDocs.length) {
            if (lm) lm.remove();
            _kbLoadObserver.disconnect();
          }
        }, {root: null, rootMargin: '300px'});
        var _sentinel = document.getElementById('kbLoadMore');
        if (_sentinel) _kbLoadObserver.observe(_sentinel);
      }
      } catch (renderErr) {
        // 渲染失败可见化：错误直接显示在网格区（可溯源、可点击重试）
        console.error('[KB] 网格渲染失败:', renderErr);
        gridEl.innerHTML = '<div style="grid-column:1/-1;padding:20px;text-align:center;font-size:13px;color:var(--error-color,#dc2626)">' +
          '文档列表渲染出错：' + esc((renderErr && renderErr.message) || String(renderErr)) +
          ' · <a href="#" onclick="kbRefreshDocs();return false" style="color:var(--accent-color);text-decoration:underline">点击重试</a></div>';
      }
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

    // P6: 私密文档清单（无私密则隐藏整个区块）
    kbRenderPrivateList(docs);

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

    // P6: kbRefreshAIOverview 只统计概览（标签数/文档数），不覆盖 AI 洞察文本
    // AI 洞察由 kbRefreshOverviewLLM 独立管理，避免轮询覆盖 LLM 生成内容
    _kbRefreshOverviewStatsOnly();
    // P6 修复：同步队列条目和文档 tag_status
    _kbSyncQueueWithDocs(docs);
    kbRefreshDocs._retried = false;  // P8-8: 成功后重置重试标记
  } catch (err) {
    _kbSkipFetch = false;
    silentLog('[KB] 刷新文档列表失败:', err);
    // P8-8: 失败自动重试一次（首屏竞态/瞬时错误可自愈）；
    // 仍失败则把错误显示在网格区（可见可溯源），不再静默
    if (!kbRefreshDocs._retried) {
      kbRefreshDocs._retried = true;
      setTimeout(function() { kbRefreshDocs(); }, 2000);
    } else {
      kbRefreshDocs._retried = false;
      var gridErrEl = document.getElementById('kbDocGrid');
      if (gridErrEl && !gridErrEl.children.length) {
        gridErrEl.innerHTML = '<div style="grid-column:1/-1;padding:20px;text-align:center;font-size:13px;color:var(--error-color,#dc2626)">' +
          '文档列表加载失败：' + esc((err && err.message) || String(err)) +
          ' · <a href="#" onclick="kbRefreshDocs();return false" style="color:var(--accent-color);text-decoration:underline">点击重试</a></div>';
      }
      if (!_kbPollTimer && typeof showToast === 'function') {
        showToast('刷新文档列表失败', 'error');
      }
    }
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
// P6: 私密文档清单（侧栏，无私密文档则隐藏整个区块）
function kbRenderPrivateList(docs) {
  var wrap = document.getElementById('kbSidebarPrivateWrap');
  if (!wrap) return;
  docs = docs || _kbLastDocs || [];
  var privateDocs = [];
  for (var i = 0; i < docs.length; i++) {
    if (docs[i].is_private) privateDocs.push(docs[i]);
  }
  // 无私密文档 → 隐藏整个区块
  if (!privateDocs.length) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  // 标题带计数
  var hdr = document.getElementById('kbSidebarPrivateHdr');
  if (hdr) hdr.textContent = '私密文档 (' + privateDocs.length + ')';
  // 渲染清单
  var container = document.getElementById('kbSidebarPrivate');
  if (!container) return;
  var html = '';
  for (var j = 0; j < privateDocs.length; j++) {
    var d = privateDocs[j];
    var name = d.filename || '未命名';
    var summary = (d.summary || '').slice(0, 40);
    html += '<div class="kb-token-item" title="' + esc(name) + '">';
    html += '<span class="kb-token-icon">' + '<svg width="11" height="11" viewBox="0 0 14 14" fill="none"><rect x="3" y="6" width="8" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M5 6V4a2 2 0 014 0v2" stroke="currentColor" stroke-width="1.2"/></svg>' + '</span>';
    html += '<span class="kb-token-info"><span class="kb-token-doc">' + esc(name) + '</span>';
    if (summary) html += '<span class="kb-token-meta">' + esc(summary) + '…</span>';
    html += '</span>';
    html += '</div>';
  }
  container.innerHTML = html;
}

// P8-9 v6.1: 主类下的子类列表（[{name, count}]，按数量倒序）
function _kbSubsOfCategory(catName) {
  var map = window._kbDocSubMap || {};
  var counter = {};
  for (var did in map) {
    var e = map[did];
    if (e.group === catName && e.sub && e.sub !== e.group) {
      counter[e.sub] = (counter[e.sub] || 0) + 1;
    }
  }
  var out = [];
  for (var name in counter) out.push({ name: name, count: counter[name] });
  out.sort(function(a, b) { return b.count - a.count; });
  return out;
}

// ===== P0 标签聚合（0.9.8 prerelease 实测驱动）：散 category 归并为大类 =====
// 后端 routers/kb.py _postmerge_groups 的 JS 同款（bigram 相似度 + 两阶段收敛），
// 侧栏渲染前对文档 category 做确定性归并：一级=大类、二级=原分类。
var _kbCategoryMergeMap = {};   // {大类名: [原category,...]}，过滤时 OR 匹配

function _kbBigramSim(a, b) {
  function bg(s) {
    s = (s || '').trim();
    if (s.length < 2) return s ? [s] : [];
    var r = [];
    for (var i = 0; i < s.length - 1; i++) r.push(s.substr(i, 2));
    return r;
  }
  var ba = bg(a), bb = bg(b);
  if (!ba.length || !bb.length) return 0;
  var inter = 0, seen = {};
  ba.forEach(function (x) { seen[x] = 1; });
  bb.forEach(function (x) { if (seen[x]) inter++; });
  ba.concat(bb).forEach(function (x) { seen[x] = 1; });
  return inter / Object.keys(seen).length;
}

function _kbMergeCategories(catNames, catCounts) {
  // 按文档数降序贪心：大类组长吸收相似成员（≥0.2）；再两阶段收敛（同后端）
  var sorted = catNames.slice().sort(function (a, b) { return (catCounts[b] || 0) - (catCounts[a] || 0); });
  var groups = [], assigned = {};
  for (var i = 0; i < sorted.length; i++) {
    if (assigned[sorted[i]]) continue;
    var g = { group: sorted[i], members: [sorted[i]] };
    assigned[sorted[i]] = 1;
    for (var j = i + 1; j < sorted.length; j++) {
      var cand = sorted[j];
      if (assigned[cand]) continue;
      if (_kbBigramSim(sorted[i], cand) >= 0.2) { g.members.push(cand); assigned[cand] = 1; }
    }
    groups.push(g);
  }
  function simTo(g, cand) {
    var best = 0;
    [cand.group].concat(cand.members).forEach(function (t) {
      best = Math.max(best, _kbBigramSim(g.group, t));
      g.members.forEach(function (m) { best = Math.max(best, _kbBigramSim(m, t)); });
    });
    return best;
  }
  function settle(minSim) {
    groups.sort(function (a, b) { return a.members.length - b.members.length; });
    for (var k = 0; k < groups.length; k++) {
      var g = groups[k];
      if (g.members.length > 1 && minSim < 0.15) return false;
      var pool = groups.filter(function (x) { return x !== g; });
      if (!pool.length) return false;
      var target = pool[0];
      pool.forEach(function (c) { if (simTo(g, c) > simTo(g, target)) target = c; });
      if (simTo(g, target) >= minSim) {
        target.members = target.members.concat(g.members);
      } else {
        var other = null;
        for (var oi = 0; oi < groups.length; oi++) if (groups[oi].group === '其他') { other = groups[oi]; break; }
        if (!other) { other = { group: '其他', members: [] }; groups.push(other); }
        other.members = other.members.concat(g.members);
      }
      groups.splice(groups.indexOf(g), 1);
      return true;
    }
    return false;
  }
  while (groups.some(function (g) { return g.members.length <= 1; }) && groups.length > 1) {
    if (!settle(0.15)) break;
  }
  while (groups.length > 6 && groups.length > 1) {
    if (!settle(0.3)) break;
  }
  return groups;
}

function _kbRenderCategoryTree(docs) {
  // P8-9 v6：渲染到横排 chips（替代左侧栏列表）
  var listEl = document.getElementById('kbFilterChips');
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

  // P0 标签聚合：散 category 归并成大类（一级=大类、二级=原分类），过滤走 OR
  var catCountMap = {};
  catNames.forEach(function(c) { catCountMap[c] = catGroups[c].length; });
  var mergedGroups = (catNames.length > 6) ? _kbMergeCategories(catNames, catCountMap) : null;
  _kbCategoryMergeMap = {};
  if (mergedGroups) {
    mergedGroups.forEach(function(g) { _kbCategoryMergeMap[g.group] = g.members; });
  }

  var totalDocs = docs.length;
  var html = '<div class="kb-tag all' + (_kbActiveTagFilter === null ? ' sel' : '') +
    '" data-tag="__all__" onclick="kbFilterByTag(null,this)"><span class="dot"></span>全部文档<span class="cnt">' +
    totalDocs + '</span></div>';

  // 渲染每个分类（归并后的大类，或 category 本身）
  var _renderList = [];
  if (mergedGroups) {
    // 大类按文档总数倒序；「其他」垫底
    mergedGroups.forEach(function(g) {
      var n = 0; g.members.forEach(function(m) { n += (catGroups[m] || []).length; });
      _renderList.push({ name: g.group, count: n, members: g.members });
    });
    _renderList.sort(function(a, b) {
      var ao = a.name === '其他', bo = b.name === '其他';
      if (ao !== bo) return ao ? 1 : -1;
      return b.count - a.count;
    });
  } else {
    catNames.forEach(function(c) { _renderList.push({ name: c, count: catGroups[c].length, members: null }); });
  }

  for (var ci = 0; ci < _renderList.length; ci++) {
    var catName = _renderList[ci].name;
    var count = _renderList[ci].count;
    var isSel = _kbActiveTagFilter === catName;
    var cls = 'kb-tag cat' + (isSel ? ' sel' : '');
    var escapedCat = catName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    var dotColor = _DONUT_COLORS[ci % _DONUT_COLORS.length];
    html += '<div class="' + cls + '" data-tag="' + esc(catName) + '" onclick="kbFilterByTag(\'' + escapedCat + '\',this)">' +
      '<span class="dot" style="background:' + dotColor + '"></span>' + esc(catName) +
      '<span class="cnt">' + count + '</span></div>';
    // 二级展开：归并成员（原分类）优先；未归并时回落星图子类（P8-9 v6.1）
    var _subsOf;
    if (_renderList[ci].members && _renderList[ci].members.length > 1) {
      _subsOf = _renderList[ci].members.map(function(m) { return { name: m, count: (catGroups[m] || []).length }; })
        .sort(function(a, b) { return b.count - a.count; });
    } else {
      _subsOf = _kbSubsOfCategory(catName);
    }
    var _subActive = _subsOf.some(function(s) { return s.name === _kbActiveTagFilter; });
    if (_subsOf.length > 1 && (isSel || _subActive)) {
      for (var sj = 0; sj < _subsOf.length; sj++) {
        var _sub = _subsOf[sj];
        var _subSel = _kbActiveTagFilter === _sub.name;
        var _subColor = _kbShadeColor(dotColor, sj === 0 ? 0.35 : -0.28);
        var _escapedSub = _sub.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        html += '<div class="kb-tag kb-sub-chip' + (_subSel ? ' sel' : '') + '" data-tag="' + esc(_sub.name) + '" onclick="kbFilterByTag(\'' + _escapedSub + '\',this)">' +
          '<span class="dot" style="background:' + _subColor + '"></span>' + esc(_sub.name) +
          '<span class="cnt">' + _sub.count + '</span></div>';
      }
    }
  }

  // 没有 category 的文档（待打标/打标失败）
  if (noCategoryCount > 0) {
    var isUnSel = _kbActiveTagFilter === '__uncategorized__';
    html += '<div class="kb-tag cat kb-tag-pending' + (isUnSel ? ' sel' : '') + '" data-tag="__uncategorized__" onclick="kbFilterByTag(\'__uncategorized__\',this)">' +
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
  var items = document.querySelectorAll('#kbFilterChips .kb-tag, #kbFilterChips .kb-group, #kbFilterChips .kb-group-tag');
  for (var i = 0; i < items.length; i++) {
    var itemTag = items[i].getAttribute('data-tag');
    var itemGroup = items[i].getAttribute('data-group');
    var isSel = itemTag === (tagName || '__all__') || itemGroup === tagName;
    items[i].classList.toggle('sel', isSel);
  }

  kbRefreshDocs();
}

// --- 按文件名搜索（M3: 300ms 防抖，避免连续按键触发大量请求） ---
function kbFilterByName(query) {
  _kbNameFilter = query || '';
  if (_kbFilterTimer) clearTimeout(_kbFilterTimer);
  _kbFilterTimer = setTimeout(function() { _kbFilterTimer = null; kbRefreshDocs(); }, 300);
}

// --- 卡片点击（进入文档详情/操作） ---
function kbCardClick(docId) {
  // 切换 checkbox 选中状态
  if (typeof kbToggleSelect === 'function') kbToggleSelect(docId);
}

// --- AI 知识库概览 ---
// P6 打磨 #10：LLM 驱动的概览刷新
// P8-8：支持 auto 模式（stale 自动触发）——不覆盖正文、失败静默
async function kbRefreshOverviewLLM(_isAuto) {
  if (_kbOverviewGenerating) return;  // 防并发
  _kbOverviewGenerating = true;
  var btn = document.getElementById('kbRefreshBtn');
  var bodyEl = document.getElementById('kbOverviewBody');
  var sidebarHdr = document.querySelector('#kbSidebar .kb-sidebar-hdr');
  var sidebarOrig = sidebarHdr ? sidebarHdr.innerHTML : '';
  var bodyPrev = bodyEl ? bodyEl.innerHTML : '';

  if (btn && btn.style.display !== 'none') { btn.disabled = true; btn.innerHTML = iconSvg('spin','11') + ' 生成中...'; }
  if (sidebarHdr) sidebarHdr.innerHTML = iconSvg('spin','12') + ' AI 智能筛选 — 重新生成中...';
  if (bodyEl && !_isAuto) bodyEl.innerHTML = '<div class="kb-dash-empty">AI 正在分析文档结构，生成洞察中…</div>';

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
        doc_count: data.doc_count || 0,
        graph: data.graph || null  // P8-9
      };
      _kbRenderInsightDashboard(_kbLastInsightData);
      // 生成完成后总是刷新文档列表和侧栏（分类可能已变更）
      try { if (typeof kbRefreshDocs === 'function') kbRefreshDocs(); } catch(e) {}
    } else if (bodyEl && !_isAuto) {
      bodyEl.innerHTML = bodyPrev;
    }
  } catch (e) {
    if (!_isAuto) showToast('AI 洞察生成失败，请重试', 'error');
    if (bodyEl && !_isAuto) bodyEl.innerHTML = bodyPrev;
  }
  finally {
    _kbOverviewGenerating = false;
    // 有洞察后按钮常驻为"重新生成"；无洞察保持隐藏
    _kbSetOverviewBtn(!!_kbLastInsightData, false);
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
    updatedEl.textContent = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ' 更新';
  }
}


// P6: 环形图颜色表（10色，聚类≤10）
var _DONUT_COLORS = ['#7F77DD','#4F8CC9','#3DA89E','#6BA845','#DA9A2E','#D95468','#8B5CF6','#3B82C4','#5C8A5A','#C97D60'];
var _donutActiveCategory = null;
var _kbLastInsightData = null;
var _kbLastDocsOrigOrder = null;

function _kbRenderInsightDashboard(data) {
  var bodyEl = document.getElementById('kbOverviewBody');
  var sourceEl = document.getElementById('kbOverviewSource');
  var countEl = document.getElementById('kbOverviewDocCount');
  var updatedEl = document.getElementById('kbOverviewUpdated');
  if (!bodyEl) { console.warn('[KB] kbOverviewBody not found'); return; }
  try {

  var insight = data.insight || '';
  var questions = data.suggested_questions || [];
  var graph = data.graph || null;
  var docCount = data.doc_count || 0;

  if (!insight && docCount === 0 && !(graph && graph.nodes && graph.nodes.length)) {
    bodyEl.innerHTML = '<div class="kb-dash-empty">上传文档后，AI 会自动聚类并生成洞察分析，帮你发现知识结构中的骨架与空白。</div>';
    return;
  }
  if (!insight && !(graph && graph.nodes && graph.nodes.length)) {
    bodyEl.innerHTML = '<div class="kb-dash-empty">AI 正在自动聚类并生成洞察分析…</div>';
    return;
  }

  var html = '';

  // ===== P8-9: 知识星图（力导向图谱；图例/统计收进图内浮层，v6）=====
  if (graph && graph.nodes && graph.nodes.length) {
    // 主类/子类结构：group 有多个 sub 时图例显示层级，子类用同色相浅/深两阶
    var groups = [];  // [{name, subs:[{name, count}], count, colorIdx}]
    var groupIdx = {};
    for (var gi = 0; gi < graph.nodes.length; gi++) {
      var gn = graph.nodes[gi];
      var gname = gn.group || gn.cat || '未分类';
      var sname = gn.sub || gname;
      if (!(gname in groupIdx)) {
        groupIdx[gname] = groups.length;
        groups.push({ name: gname, subs: [], subIdx: {}, count: 0 });
      }
      var G = groups[groupIdx[gname]];
      G.count++;
      if (!(sname in G.subIdx)) {
        G.subIdx[sname] = G.subs.length;
        G.subs.push({ name: sname, count: 0 });
      }
      G.subs[G.subIdx[sname]].count++;
    }
    // 按文档数倒序（与筛选 chips 顺序一致）
    groups.sort(function(a, b) { return b.count - a.count; });
    var legendHtml = '';
    for (var li = 0; li < groups.length; li++) {
      var G2 = groups[li];
      var baseColor = _DONUT_COLORS[li % _DONUT_COLORS.length];
      var hasSubs = G2.subs.length > 1;
      legendHtml += '<div class="kb-map-lg-item" data-cat="' + escAttr(G2.name) + '">' +
        '<span class="kb-map-lg-dot" style="background:' + baseColor + '"></span>' +
        esc(G2.name) + '<span class="kb-map-lg-n">' + G2.count + '</span></div>';
      for (var si = 0; si < G2.subs.length; si++) {
        var subColor = hasSubs ? _kbShadeColor(baseColor, si === 0 ? 0.35 : -0.28) : baseColor;
        for (var gk = 0; gk < graph.nodes.length; gk++) {
          var nd = graph.nodes[gk];
          if ((nd.group || nd.cat) === G2.name && (nd.sub || nd.cat) === G2.subs[si].name) {
            nd.color = subColor;
          }
        }
        if (hasSubs) {
          legendHtml += '<div class="kb-map-lg-item kb-map-lg-sub" data-cat="' + escAttr(G2.subs[si].name) + '" data-group="' + escAttr(G2.name) + '">' +
            '<span class="kb-map-lg-dot" style="background:' + subColor + '"></span>' +
            esc(G2.subs[si].name) + '<span class="kb-map-lg-n">' + G2.subs[si].count + '</span></div>';
        } else {
          for (var gk2 = 0; gk2 < graph.nodes.length; gk2++) {
            var nd2 = graph.nodes[gk2];
            if ((nd2.group || nd2.cat) === G2.name) nd2.color = baseColor;
          }
        }
      }
    }
    // 统计 chip（右下角图内信息条）
    var edgeCnt = graph.edges ? graph.edges.length : 0;
    var statsChip = docCount + ' 篇 · ' + groups.length + ' 主题' + (edgeCnt ? ' · ' + edgeCnt + ' 关联' : '');
    html += '<div class="kb-map-row">' +
      '<div class="kb-map-box" id="kbMapBox">' +
        '<svg viewBox="0 0 1020 580" id="kbMapSvg"><g id="kbMapViewport"></g></svg>' +
        '<div class="kb-map-hint">Ctrl+滚轮缩放 · 拖拽移动 · 双击复位</div>' +
        '<div class="kb-map-tip" id="kbMapTip"></div>' +
        '<div class="kb-map-legend-float"><div class="kb-map-legend-title">分类（点击高亮）</div>' + legendHtml + '</div>' +
        '<div class="kb-map-stats-chip">' + statsChip + '</div>' +
      '</div>' +
      '</div>';
  }





  // 推荐问题（保留——从"看"到"用"的引导链路）
  if (questions.length > 0) {
    html += '<div class="kb-dash-divider"></div><div class="kb-dash-asks">';
    for (var qi = 0; qi < questions.length; qi++) {
      html += '<button class="kb-dash-ask" title="' + escAttr(questions[qi]) + '" onclick="_kbDashAsk(\'' + escAttr(questions[qi]) + '\')"><span class="kb-dash-ask-rank">' + (qi + 1) + '</span>' + esc(questions[qi]) + '</button>';
    }
    html += '</div>';
  }

  bodyEl.innerHTML = html;

  // 初始化图谱（静态终态 + 交互）
  if (graph && graph.nodes && graph.nodes.length) {
    // doc_id → {group, sub} 映射（chips 二级筛选 / 子类过滤用）
    window._kbDocSubMap = {};
    graph.nodes.forEach(function(gn) {
      window._kbDocSubMap[gn.doc_id] = { group: gn.group || gn.cat, sub: gn.sub || gn.cat };
    });
    _kbInitDocMap(graph);
  }

  if (sourceEl) sourceEl.textContent = (data.engine_label || '离线 AI') + ' 生成';
  if (countEl) countEl.textContent = docCount + ' 篇';
  if (updatedEl) {
    var now = new Date();
    updatedEl.textContent = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  }
  } catch(e) { console.error('[KB] 仪表盘渲染失败:', e); }
}

// P8-9 v6: 颜色明度调整（amount>0 变浅，<0 变深）——子类同色系
function _kbShadeColor(hex, amount) {
  var m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  var n = parseInt(m[1], 16);
  var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  function adj(c) {
    return Math.round(amount > 0 ? c + (255 - c) * amount : c * (1 + amount));
  }
  var out = (adj(r) << 16) | (adj(g) << 8) | adj(b);
  return '#' + ('00000' + out.toString(16)).slice(-6);
}

// ===== P8-9: 文档地图渲染与交互（Fruchterman-Reingold 力布局 + Obsidian 式悬停高亮）=====
function _kbInitDocMap(graph) {
  var box = document.getElementById('kbMapBox');
  var svg = document.getElementById('kbMapSvg');
  var vp = document.getElementById('kbMapViewport');
  var tip = document.getElementById('kbMapTip');
  if (!box || !svg || !vp) return;

  // P8-9 v5：位置已在服务端预沉降（终态直出），前端只渲染 + 淡入，不再跑力模拟
  var NODES = graph.nodes, EDGES = graph.edges || [];
  var W = 1020, H = 580;
  var pos = NODES.map(function(n) { return { x: n.x || (W/2), y: n.y || (H/2) }; });

  var NS = 'http://www.w3.org/2000/svg';
  var edgeEls = EDGES.map(function(e) {
    var l = document.createElementNS(NS, 'line');
    l.setAttribute('stroke', '#B8C2CC');
    l.setAttribute('stroke-width', (0.6 + (e.w || 0.5) * 1.2).toFixed(2));
    l.setAttribute('stroke-opacity', '0.55');
    vp.appendChild(l);
    return l;
  });
  var nodeEls = NODES.map(function(n, i) {
    var r = Math.min(6 + (n.deg || 0) * 1.3, 15);
    // halo 辉光（选中时显示，藏在节点后）
    var halo = document.createElementNS(NS, 'circle');
    halo.setAttribute('r', r * 2.2);
    halo.setAttribute('class', 'kb-map-node-sel-halo');
    halo.style.display = 'none';
    vp.appendChild(halo);
    var c = document.createElementNS(NS, 'circle');
    c.setAttribute('r', r);
    c.setAttribute('data-r', r);
    c.setAttribute('fill', n.color || '#7F77DD');
    c.setAttribute('fill-opacity', '.85');
    c.setAttribute('stroke', '#fff');
    c.setAttribute('stroke-width', '1.5');
    c.style.cursor = 'pointer';
    c._halo = halo;
    vp.appendChild(c);
    return c;
  });
  // 静态渲染（终态坐标）+ 视口淡入
  edgeEls.forEach(function(l, i) {
    var e = EDGES[i];
    l.setAttribute('x1', pos[e.s].x); l.setAttribute('y1', pos[e.s].y);
    l.setAttribute('x2', pos[e.t].x); l.setAttribute('y2', pos[e.t].y);
  });
  nodeEls.forEach(function(c, i) {
    c.setAttribute('cx', pos[i].x); c.setAttribute('cy', pos[i].y);
    if (c._halo) { c._halo.setAttribute('cx', pos[i].x); c._halo.setAttribute('cy', pos[i].y); }
  });
  vp.style.opacity = '0';
  vp.style.transition = 'opacity .5s ease';
  setTimeout(function() { vp.style.opacity = '1'; }, 30);

  // 悬停高亮节点 + 邻居（Obsidian 行为）
  var neighbors = NODES.map(function() { return {}; });
  EDGES.forEach(function(e) { neighbors[e.s][e.t] = 1; neighbors[e.t][e.s] = 1; });
  nodeEls.forEach(function(c, i) {
    c.addEventListener('mouseenter', function() {
      var n = NODES[i];
      tip.textContent = n.name + ' · ' + (n.cat || '未分类') + ' · 关联 ' + (n.deg || 0) + ' 篇';
      tip.style.display = 'block';
      var r = c.getBoundingClientRect(), br = box.getBoundingClientRect();
      tip.style.left = (r.left - br.left + 14) + 'px';
      tip.style.top = (r.top - br.top - 10) + 'px';
      nodeEls.forEach(function(c2, j) { c2.style.opacity = (j === i || neighbors[i][j]) ? '1' : '.12'; });
      edgeEls.forEach(function(l, k) {
        var e = EDGES[k];
        l.style.strokeOpacity = (e.s === i || e.t === i) ? '0.9' : '0.06';
      });
    });
    c.addEventListener('mouseleave', function() {
      tip.style.display = 'none';
      nodeEls.forEach(function(c2) { c2.style.opacity = ''; });
      edgeEls.forEach(function(l) { l.style.strokeOpacity = ''; });
    });
    // 点选：浮条展示连线理由 + 列表关联重排 + 图上聚焦（选中+邻居高亮，其余淡出）
    c.addEventListener('click', function() {
      _kbMapFocus(i, nodeEls, edgeEls, EDGES, neighbors);
      _kbShowMapFloat(i, NODES, EDGES, neighbors);
      _kbSortDocsByRelated(i, NODES, neighbors);
    });
  });

  // 分类高亮
  box.querySelectorAll('.kb-map-lg-item').forEach(function(lg) {
    lg.addEventListener('click', function() {
      var cat = lg.getAttribute('data-cat');
      var isSub = !!lg.getAttribute('data-group');  // 子类条目按 sub 匹配
      var active = lg.classList.contains('active');
      box.querySelectorAll('.kb-map-lg-item').forEach(function(x) { x.classList.remove('active', 'dim'); });
      nodeEls.forEach(function(c) { c.style.opacity = ''; });
      if (!active) {
        lg.classList.add('active');
        box.querySelectorAll('.kb-map-lg-item').forEach(function(x) { if (x !== lg) x.classList.add('dim'); });
        nodeEls.forEach(function(c, i) {
          var key = isSub ? (NODES[i].sub || NODES[i].cat || '未分类')
                          : (NODES[i].group || NODES[i].cat || '未分类');
          if (key !== cat) c.style.opacity = '.12';
        });
      }
    });
  });

  // 缩放/平移（Ctrl+滚轮缩放，拖拽平移，双击复位——与报告图表同一手势约定）
  var scale = 1, tx = 0, ty = 0, MIN = 0.5, MAX = 6;
  function apply() { vp.setAttribute('transform', 'translate(' + tx + ',' + ty + ') scale(' + scale + ')'); }
  svg.addEventListener('wheel', function(e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    var d = e.deltaY < 0 ? 0.15 : -0.15;
    scale = Math.max(MIN, Math.min(MAX, scale + d));
    apply();
  }, { passive: false });
  var drag = false, sx, sy, ox, oy;
  svg.addEventListener('mousedown', function(e) {
    if (e.target.tagName === 'circle') return;
    drag = true; sx = e.clientX; sy = e.clientY; ox = tx; oy = ty; e.preventDefault();
  });
  // 背景点击（非拖拽）取消聚焦
  svg.addEventListener('mouseup', function(e) {
    if (e.target.tagName === 'circle') return;
    if (Math.abs(e.clientX - sx) < 4 && Math.abs(e.clientY - sy) < 4) _kbMapFocusClear(nodeEls, edgeEls);
  });
  document.addEventListener('mousemove', function(e) { if (!drag) return; tx = ox + (e.clientX - sx); ty = oy + (e.clientY - sy); apply(); });
  document.addEventListener('mouseup', function() { drag = false; });
  svg.addEventListener('dblclick', function() { scale = 1; tx = 0; ty = 0; apply(); });
}

// P8-9 v5: 点选聚焦——选中点+关联点高亮，其余淡出（与悬浮同效果但驻留）
var _kbMapSelected = null;
function _kbMapFocus(idx, nodeEls, edgeEls, EDGES, neighbors) {
  _kbMapSelected = idx;
  nodeEls.forEach(function(c, j) {
    var isSel = (j === idx), isNb = !!neighbors[idx][j];
    if (isSel) {
      // 选中：放大 1.4 倍 + halo 辉光 + 主题色描边
      c.classList.remove('kb-map-node-dim');
      c.style.opacity = '1';
      var baseR = parseFloat(c.getAttribute('data-r') || c.getAttribute('r'));
      c.setAttribute('r', baseR * 1.4);
      c.setAttribute('stroke', 'var(--accent-color)');
      c.setAttribute('stroke-width', '2.5');
      if (c._halo) c._halo.style.display = '';
    } else if (isNb) {
      // 关联：保持原色，描边加亮
      c.classList.remove('kb-map-node-dim');
      c.style.opacity = '1';
      c.setAttribute('stroke', '#fff');
      c.setAttribute('stroke-width', '2');
    } else {
      // 无关：淡出 + 去色（三档层级拉开）
      c.classList.add('kb-map-node-dim');
      c.setAttribute('stroke', '#fff');
      c.setAttribute('stroke-width', '1.5');
      if (c._halo) c._halo.style.display = 'none';
    }
  });
  edgeEls.forEach(function(l, k) {
    var e = EDGES[k];
    if (e.s === idx || e.t === idx) {
      l.style.strokeOpacity = '0.9';
      l.setAttribute('stroke', 'var(--accent-color)');
      l.setAttribute('stroke-width', '2.2');
    } else {
      l.style.strokeOpacity = '0.06';
    }
  });
}
function _kbMapFocusClear(nodeEls, edgeEls) {
  _kbMapSelected = null;
  nodeEls.forEach(function(c) {
    c.classList.remove('kb-map-node-dim');
    c.style.opacity = '';
    c.setAttribute('r', c.getAttribute('data-r') || c.getAttribute('r'));
    c.setAttribute('stroke', '#fff');
    c.setAttribute('stroke-width', '1.5');
    if (c._halo) c._halo.style.display = 'none';
  });
  edgeEls.forEach(function(l) {
    l.style.strokeOpacity = '';
    l.setAttribute('stroke', '#B8C2CC');
    l.setAttribute('stroke-width', (0.6 + 0.5 * 1.2).toFixed(2));
  });
  _kbHideMapFloat();
}

// ===== P8-9 v5: 点选浮条（连线理由 + AI 详解） =====
var _kbMapFloatSel = null;

function _kbShowMapFloat(idx, NODES, EDGES, neighbors) {
  var box = document.getElementById('kbMapBox');
  if (!box) return;
  _kbHideMapFloat();
  _kbMapFloatSel = idx;

  var n = NODES[idx];
  // 收集邻居（按相似度降序，全部列出）
  var nbs = [];
  EDGES.forEach(function(e) {
    if (e.s === idx) nbs.push({ w: e.w || 0, j: e.t, reasons: e.reasons || [] });
    else if (e.t === idx) nbs.push({ w: e.w || 0, j: e.s, reasons: e.reasons || [] });
  });
  nbs.sort(function(a, b) { return b.w - a.w; });

  // 有明确理由的逐条列出；仅相似度的归拢为一句（详情交给 AI 详解）
  var withReason = [], simOnly = [];
  nbs.forEach(function(nb) { (nb.reasons.length ? withReason : simOnly).push(nb); });

  var nbHtml = '';
  if (nbs.length) {
    nbHtml = '<div style="margin-top:6px;font-size:11.5px;color:var(--text-muted)">关联知识：</div>';
    withReason.forEach(function(nb) {
      var nn = NODES[nb.j];
      nbHtml += '<div class="mf-nb"><span class="mf-nb-name">' + esc(nn.name) + '</span>' +
        '<div class="mf-nb-reason">' + esc(nb.reasons.join(' · ')) + ' · 相似度 ' + nb.w.toFixed(2) + '</div></div>';
    });
    if (simOnly.length) {
      nbHtml += '<div class="mf-nb-reason" style="margin:4px 0 0 0">另有 ' + simOnly.length +
        ' 篇与本文高度相关，详情请点击「AI 详解」</div>';
    }
  } else {
    nbHtml = '<div style="margin-top:6px;color:var(--text-muted)">孤立点——和文库里其他文档都不太像</div>';
  }

  var floatEl = document.createElement('div');
  floatEl.className = 'kb-map-float';
  floatEl.id = 'kbMapFloat';
  floatEl.innerHTML =
    '<span class="mf-close" onclick="_kbHideMapFloat()">×</span>' +
    '<div class="mf-title">' + esc(n.name) + '</div>' +
    '<div class="mf-meta">' + esc(n.sub || n.cat || '未分类') + ' · 关联 ' + (n.deg || 0) + ' 篇</div>' +
    '<button class="mf-explain-btn" id="kbMapExplainBtn">✨ AI 详解</button>' +
    '<div class="mf-explain" id="kbMapExplain" style="display:none"></div>' +
    nbHtml;
  box.appendChild(floatEl);
  // 定位：贴在图例浮层下方，与图例同宽（左上区域纵向排列）
  var lg = box.querySelector('.kb-map-legend-float');
  if (lg) floatEl.style.top = (lg.offsetTop + lg.offsetHeight + 8) + 'px';

  document.getElementById('kbMapExplainBtn').addEventListener('click', function() {
    _kbFetchMapExplain(n.doc_id);
  });
}

function _kbHideMapFloat() {
  var f = document.getElementById('kbMapFloat');
  if (f) f.remove();
  _kbMapFloatSel = null;
}
window._kbHideMapFloat = _kbHideMapFloat;

// AI 详解（引擎遵循 kb_ai_mode 设置；结果服务端缓存）
async function _kbFetchMapExplain(docId) {
  var btn = document.getElementById('kbMapExplainBtn');
  var box = document.getElementById('kbMapExplain');
  if (!btn || !box) return;
  btn.disabled = true;
  btn.textContent = '生成中…';
  box.style.display = '';
  box.textContent = '';
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/map-explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc_id: docId })
    });
    var data = await resp.json();
    if (data.ok && data.explain) {
      box.textContent = data.explain;
      btn.style.display = 'none';  // 已生成（服务端缓存），按钮隐藏
    } else {
      box.textContent = data.error || '生成失败，请重试';
      btn.disabled = false;
      btn.textContent = '✨ AI 详解';
    }
  } catch (e) {
    box.textContent = '请求失败：' + e.message;
    btn.disabled = false;
    btn.textContent = '✨ AI 详解';
  }
}

// 点选后下方列表重排：选中 + 关联文档置顶，选中高亮
function _kbSortDocsByRelated(idx, NODES, neighbors) {
  var selId = NODES[idx].doc_id;
  var relIds = {};
  relIds[selId] = 2;  // 选中权重最高
  Object.keys(neighbors[idx]).forEach(function(j) { relIds[NODES[j].doc_id] = 1; });

  var matched = [], rest = [];
  for (var i = 0; i < _kbLastDocs.length; i++) {
    var w = relIds[_kbLastDocs[i].doc_id];
    if (w === 2) matched.unshift(_kbLastDocs[i]);      // 选中最前
    else if (w === 1) matched.push(_kbLastDocs[i]);    // 关联其次
    else rest.push(_kbLastDocs[i]);
  }
  _kbLastDocs = matched.concat(rest);
  _kbSkipFetch = true;
  kbRefreshDocs();
  // 高亮选中卡片（渲染后）
  setTimeout(function() {
    document.querySelectorAll('.kb-card.map-selected').forEach(function(c) { c.classList.remove('map-selected'); });
    var card = document.querySelector('.kb-card[data-doc-id="' + selId + '"]');
    if (card) card.classList.add('map-selected');
  }, 60);
}

function _kbScrollToDoc(docId) {
  var card = document.querySelector('.kb-card[data-doc-id="' + docId + '"]');
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.style.transition = 'box-shadow .3s';
  card.style.boxShadow = '0 0 0 2px var(--accent-color)';
  setTimeout(function() { card.style.boxShadow = ''; }, 1600);
}

// P8-9: 侧栏「AI 智能筛选」折叠状态保持（details 原生折叠 + localStorage 记忆）
(function _kbInitSidebarFilterToggle() {
  var wrap = document.getElementById('kbSidebarFilterWrap');
  if (!wrap) return;
  var KEY = 'kb_sidebar_filter_open';
  try {
    var saved = localStorage.getItem(KEY);
    if (saved === '0') wrap.removeAttribute('open');
    else wrap.setAttribute('open', '');
  } catch (e) {}
  wrap.addEventListener('toggle', function() {
    try { localStorage.setItem(KEY, wrap.open ? '1' : '0'); } catch (e) {}
  });
})();

// ⓘ 说明弹层（事件委托，免绑定时机问题）
document.addEventListener('click', function(e) {
  var btn = document.getElementById('kbMapInfoBtn');
  var pop = document.getElementById('kbMapInfoPop');
  if (!btn || !pop) return;
  if (btn.contains(e.target)) { pop.classList.toggle('show'); }
  else if (!pop.contains(e.target)) { pop.classList.remove('show'); }
});

function _kbDonutSliceClick(el) {
  var catName = el.getAttribute('data-cat');
  if (_donutActiveCategory === catName) {
    _donutActiveCategory = null;
  } else {
    _donutActiveCategory = catName;
  }
  var cached = _kbLastInsightData;
  if (cached) _kbRenderInsightDashboard(cached);
  // 同步侧栏选中状态
  _kbActiveTagFilter = _donutActiveCategory;
  _kbSortDocsByCategory(_donutActiveCategory);
}
window._kbDonutSliceClick = _kbDonutSliceClick;

function _kbDonutLegendClick(catName) {
  if (_donutActiveCategory === catName) {
    _donutActiveCategory = null;
  } else {
    _donutActiveCategory = catName;
  }
  var cached = _kbLastInsightData;
  if (cached) _kbRenderInsightDashboard(cached);
  // 同步侧栏选中状态
  _kbActiveTagFilter = _donutActiveCategory;
  _kbSortDocsByCategory(_donutActiveCategory);
}
window._kbDonutLegendClick = _kbDonutLegendClick;

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
  // 更新排序提示条
  var tipEl = document.getElementById('kbGridSectionTip');
  if (tipEl) {
    if (matchCat) {
      tipEl.innerHTML = '按「' + esc(matchCat) + '」排序置顶 · <a href="#" onclick="_kbSortDocsByCategory(null);return false">取消</a>';
      tipEl.classList.add('show');
    } else {
      tipEl.classList.remove('show');
    }
  }
  _kbSkipFetch = true;
  kbRefreshDocs();
  _kbRenderCategoryTree(_kbLastDocs);
}

function _kbDashAsk(question) {
  try {
    // 切到聊天 Tab
    var chatTab = document.querySelector('.tabs-nav button[onclick*="chat"]');
    if (chatTab) switchTab('chat', chatTab);
    // 离线模式自动切换到 KB action（追问是知识库相关问题）
    if (typeof currentActionMode !== 'undefined' && currentActionMode !== 'kb_qa') {
      var kbBtn = document.querySelector('#actionBar .action-btn[data-action="kb_qa"]');
      if (kbBtn && typeof setActionMode === 'function') {
        setActionMode('kb_qa', kbBtn);
      }
    }
    // 填入输入框
    var inp = document.getElementById('msgInput');
    if (inp) {
      inp.value = question;
      inp.focus();
      // 触发 autoResize + token 估算
      if (typeof autoResize === 'function') autoResize(inp);
      inp.dispatchEvent(new Event('input'));
    }
  } catch(e) { console.warn('[KB] 追问跳转失败', e); }
}
window._kbDashAsk = _kbDashAsk;

// AI 洞察按钮状态管理：洞察生成前隐藏（自动聚类未完成无手动入口）；
// 有洞察后显示"重新生成"；生成中显示"生成中..."
var _KB_OVERVIEW_BTN_ICON = '<svg width="10" height="10" viewBox="0 0 14 14" fill="none"><path d="M2 7a5 5 0 0110 0M12 7a5 5 0 01-10 0" stroke="currentColor" stroke-width="1.3"/><path d="M2 3v4h4M12 11V7H8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg> ';
var _kbOverviewGenerating = false;
var _kbOverviewLastAutoTry = 0;  // 自动重生成冷却（60s）

function _kbSetOverviewBtn(visible, generating) {
  var btn = document.getElementById('kbRefreshBtn');
  if (!btn) return;
  btn.style.display = visible ? '' : 'none';
  btn.disabled = !!generating;
  btn.innerHTML = _KB_OVERVIEW_BTN_ICON + (generating ? '生成中...' : '重新生成');
}

async function kbRefreshAIOverview() {
  _kbLastGroupTrigger = 0;
  var bodyEl = document.getElementById('kbOverviewBody');
  if (!bodyEl) return;

  // P6: 从服务端取洞察（数据持久化在 kb_insight.json，不依赖前端缓存）
  var _insight = null, _cats = null, _questions = null, _count = 0, _stale = false, _graph = null;
  try {
    var _sr = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/overview/refresh');
    var _sd = await _sr.json();
    if (_sd.insight) {
      _insight = _sd.insight;
      _cats = _sd.categories || {};
      _questions = _sd.suggested_questions || [];
      _count = _sd.doc_count || 0;
    }
    _graph = _sd.graph || null;  // P8-9: 图谱数据（漏传则地图永远不渲染）
    _stale = !!_sd.stale;
    if (!_count) _count = _sd.doc_count || 0;
  } catch(e) {}

  if (_insight) {
    _kbLastInsightData = { insight: _insight, categories: _cats, suggested_questions: _questions, doc_count: _count || (_kbLastDocs.length || 0), graph: _graph };
    try { _kbRenderInsightDashboard(_kbLastInsightData); } catch(e) { console.error('[KB] 仪表盘渲染失败:', e); }
    _kbSetOverviewBtn(true, false);  // 有洞察 → 显示"重新生成"
  } else {
    // 空状态：不引导手动点击——导入后自动聚类生成，用户无需操作
    _kbSetOverviewBtn(false, false);
    var _hasDocs = (_count > 0) || (_kbLastDocs && _kbLastDocs.length > 0);
    bodyEl.innerHTML = '<div class="kb-dash-empty">' +
      (_hasDocs ? '导入完成，AI 正在自动聚类并生成洞察分析…' : '导入文档后，AI 将自动聚类并生成洞察分析') +
      '</div>';
  }

  // P8-8: 洞察过期（文档增删/重打标后指纹变化）→ 自动重新生成，无需手动点按钮
  if (_stale && !_kbOverviewGenerating && typeof kbRefreshOverviewLLM === 'function') {
    var _nowTs = Date.now();
    if (_nowTs - _kbOverviewLastAutoTry > 60000) {
      _kbOverviewLastAutoTry = _nowTs;
      setTimeout(function() { kbRefreshOverviewLLM(true); }, 300);
    }
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
          .then(function() {
            // B1 修复：删除旧文档后，重新处理新文档（conflict 文档上传时未启动处理线程，
            // 不调用 reprocess 会永久卡在 conflict 状态，永不向量化/检索）
            fetch(apiBase + '/api/kb/documents/' + encodeURIComponent(docId) + '/reprocess', { method: 'POST' })
              .then(function() { kbRefreshDocs(); })
              .catch(function() { kbRefreshDocs(); });
          });
        _kbQueueItems[i].conflict = false;
        _kbQueueItems[i].conflict_info = null;
        _kbQueueItems[i].phase = 'processing';
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
      listHtml += '<button class="btn btn-xs" onclick="kbResolveConflict(\'' + escAttr(item.docId) + '\',\'replace\')">替换</button>';
      listHtml += '<button class="btn btn-xs" onclick="kbResolveConflict(\'' + escAttr(item.docId) + '\',\'keep\')">保留</button>';
      listHtml += '<button class="btn btn-xs" onclick="kbResolveConflict(\'' + escAttr(item.docId) + '\',\'cancel\')">取消</button>';
      listHtml += '</div>';
      continue;
    }

    // Fix 2: 显示完整的处理阶段 + 实时百分比
    var phaseLabel;
    if (item.phase === 'chunking') {
      phaseLabel = '正在切分段落 · ' + (item.pct || 0) + '%';
    } else if (item.phase === 'chunking_done') {
      phaseLabel = '段落切分完成 · ' + (item.pct || 0) + '%';
    } else if (item.phase === 'embedding') {
      phaseLabel = '正在向量化 · ' + (item.pct || 0) + '%';
    } else if (item.phase === 'queued') {
      phaseLabel = '排队等待处理';
    } else if (item.phase === 'tag_pending') {
      phaseLabel = '排队等待 AI 摘要';
    } else if (item.phase === 'tag_generating') {
      phaseLabel = 'AI 正在生成摘要';
    } else {
      phaseLabel = '处理中 · ' + (typeof item.pct === 'number' ? item.pct + '%' : '');
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
var _kbEventSources = {};    // M5: {docId: EventSource} 跟踪活跃连接，供切 Tab 时统一关闭

function kbSubscribeProgress(docId, filename) {
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
    _kbEventSources[docId] = es;  // M5: 记录实例，供切 Tab 关闭
  } catch (e) {
    console.warn('[KB] SSE 不支持，回退轮询', e);
    return;
  }

  var _closed = false;
  var _cleanup = function() {
    if (_closed) return;
    _closed = true;
    try { es.close(); } catch (e) {}
    _kbActiveEventSources--;
    delete _kbEventSources[docId];  // M5: 清理记录
    _kbTryNextSubscription();
  };

  es.onmessage = function(ev) {
    try {
      var d = JSON.parse(ev.data);
      var phaseText;
      var pct;
      if (d.phase === 'chunking') {
        phaseText = '切片中...';
        pct = Math.round((d.progress || 0) * 100);
      } else if (d.phase === 'embedding') {
        phaseText = '生成向量...';
        pct = Math.round((d.progress || 0) * 100);
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

      _kbUpdateQueue(docId, d.phase, pct);

      if (typeof showToast === 'function') {
        if (d.phase === 'done') {
          showToast((filename || '') + ' 处理完成' + detail, 'success', 3000);
        } else if (d.phase === 'error') {
          showToast((filename || '') + ' 处理失败', 'error', 5000);
        }
      }
      if (d.phase === 'done' || d.phase === 'error' || d.phase === 'timeout') {
        _cleanup();
        _kbRemoveFromQueue(docId);
        kbRefreshDocs();
      }
    } catch (e) { console.warn('[KB] SSE 解析失败', e); }
  };
  es.onerror = function() {
    _cleanup();
  };
  setTimeout(function() {
    _cleanup();
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
    // M6: docId 编码 + 检查返回，失败时给用户反馈
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/documents/' + encodeURIComponent(docId), { method: 'DELETE' });
    var data = await resp.json();
    if (data && data.error) {
      showToast('删除失败: ' + data.error, 'error');
      return;
    }
    kbRefreshDocs();
    // P6: 删除后自动刷新洞察和标签归并
    setTimeout(function() { if (typeof kbRefreshOverviewLLM === 'function') kbRefreshOverviewLLM(); }, 500);
  } catch (err) { showToast('删除失败: ' + err.message, 'error'); }
}

async function kbPauseDoc(docId) {
  try { await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/documents/' + docId + '/pause', { method: 'POST' }); kbRefreshDocs(); }
  catch (err) { showToast('操作失败: ' + err.message, 'error'); }
}

// S9: 切换单篇文档私密状态（调现有单篇 privacy 端点）
async function kbTogglePrivacy(docId) {
  var doc = null;
  for (var i = 0; i < _kbLastDocs.length; i++) { if (_kbLastDocs[i].doc_id === docId) { doc = _kbLastDocs[i]; break; } }
  var nextPrivate = doc ? !doc.is_private : true;
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/documents/' + encodeURIComponent(docId) + '/privacy', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({is_private: nextPrivate})
    });
    var data = await resp.json();
    if (data && data.error) { showToast('设置失败: ' + data.error, 'error'); return; }
    if (doc) doc.is_private = nextPrivate;  // 本地立即更新，避免等轮询
    showToast(nextPrivate ? '已设为私密（云端Agent不可见）' : '已设为公开');
    kbRefreshDocs();
  } catch (err) { showToast('设置失败: ' + err.message, 'error'); }
}

// S3: 文档详情弹窗（标题/状态/标签/分类/元数据/全文预览）
function kbShowDocDetail(docId) {
  var doc = null;
  for (var i = 0; i < _kbLastDocs.length; i++) { if (_kbLastDocs[i].doc_id === docId) { doc = _kbLastDocs[i]; break; } }
  if (!doc) return;
  var apiBase = (typeof API !== 'undefined') ? API : '';
  // 构建详情内容
  var statusMap = {ready: '就绪', processing: '处理中', conflict: '冲突', error: '失败', paused: '已暂停'};
  var tagStatusMap = {done: '已完成', pending: '待生成', generating: '生成中', failed: '失败'};
  var sizeStr = doc.file_size > 1048576 ? (doc.file_size/1048576).toFixed(1)+'MB' : doc.file_size > 1024 ? (doc.file_size/1024).toFixed(1)+'KB' : doc.file_size+'B';
  var _importedAt = doc.created_at || doc.imported_at;
  var timeStr = _importedAt ? new Date(_importedAt).toLocaleString('zh-CN') : '—';
  var tagsStr = (doc.tags && doc.tags.length) ? doc.tags.map(function(t){return '<span class="ctag">'+esc(t)+'</span>';}).join('') : '<span style="color:var(--text-muted)">暂无标签</span>';

  // overlay
  var overlay = document.createElement('div');
  overlay.className = 'kb-detail-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:500;display:flex;align-items:center;justify-content:center;animation:fadeIn .2s ease';
  var card = document.createElement('div');
  card.className = 'kb-detail-card';
  card.style.cssText = 'background:var(--bg-primary);border:0.5px solid var(--border-color);border-radius:12px;padding:20px 24px;max-width:560px;width:92%;max-height:80vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.18);animation:msgSlideIn .25s ease-out';
  var html = '<div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:14px">' +
    '<span style="font-size:15px;font-weight:600;color:var(--text-primary);flex:1;word-break:break-all">' + esc(doc.filename) + '</span>' +
    '<span onclick="this.closest(\'.kb-detail-overlay\').remove()" style="cursor:pointer;color:var(--text-muted);font-size:18px;line-height:1;padding:2px 6px" title="关闭">×</span></div>';
  // 元数据网格
  html += '<div style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:12px;margin-bottom:14px">';
  html += '<span style="color:var(--text-muted)">状态</span><span>' + esc(statusMap[doc.status]||doc.status) + ' · 标签' + esc(tagStatusMap[doc.tag_status]||doc.tag_status) + '</span>';
  html += '<span style="color:var(--text-muted)">分类</span><span>' + esc(doc.category || '未分类') + '</span>';
  html += '<span style="color:var(--text-muted)">文件大小</span><span>' + sizeStr + (doc.total_chars ? ' · 约'+Math.ceil(doc.total_chars/1.5).toLocaleString()+' 词元' : '') + '</span>';
  html += '<span style="color:var(--text-muted)">分块数</span><span>' + (doc.chunk_count||0) + ' 块 · 被搜索 ' + (doc.hit_count||0) + ' 次</span>';
  html += '<span style="color:var(--text-muted)">私密</span><span>' + (doc.is_private ? '是（云端Agent不可见）' : '否') + '</span>';
  html += '<span style="color:var(--text-muted)">上传时间</span><span>' + timeStr + '</span>';
  html += '</div>';
  // 标签
  html += '<div style="margin-bottom:10px"><div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">标签</div><div style="display:flex;flex-wrap:wrap;gap:4px">' + tagsStr + '</div></div>';
  // 摘要预览（用已有的 doc.summary，无需额外端点）
  html += '<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">内容预览</div>';
  html += '<div id="kbDetailPreview" style="font-size:12px;color:var(--text-secondary);line-height:1.7;background:var(--bg-secondary);border-radius:6px;padding:10px 12px;max-height:240px;overflow-y:auto">' + (doc.summary ? esc(doc.summary) : '<span style="color:var(--text-muted)">暂无预览</span>') + '</div>';
  card.innerHTML = html;
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
}

// P7-4b: 审计日志弹窗（点「被搜索 N 次」查看访问记录）
async function kbShowAuditLog(docId, filename) {
  var apiBase = (typeof API !== 'undefined') ? API : '';
  // 先弹窗（loading 态），再异步加载
  var overlay = document.createElement('div');
  overlay.className = 'kb-detail-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:500;display:flex;align-items:center;justify-content:center;animation:fadeIn .2s ease';
  var card = document.createElement('div');
  card.className = 'kb-detail-card';
  card.style.cssText = 'background:var(--bg-primary);border:0.5px solid var(--border-color);border-radius:12px;padding:20px 24px;max-width:560px;width:92%;max-height:80vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.18);animation:msgSlideIn .25s ease-out';
  var _closeBtn = '<span onclick="this.closest(\'.kb-detail-overlay\').remove()" style="cursor:pointer;color:var(--text-muted);font-size:18px;line-height:1;padding:2px 6px" title="关闭">×</span>';
  card.innerHTML = '<div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:14px">' +
    '<div style="flex:1"><div style="font-size:15px;font-weight:600;color:var(--text-primary);word-break:break-all">' + esc(filename || docId) + '</div>' +
    '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">访问记录</div></div>' + _closeBtn + '</div>' +
    '<div id="auditLogBody" style="font-size:12px;color:var(--text-muted)">加载中...</div>';
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

  try {
    var resp = await fetch(apiBase + '/api/kb/documents/' + encodeURIComponent(docId) + '/audit_log');
    var data = await resp.json();
    var body = card.querySelector('#auditLogBody');
    if (data.error) {
      body.innerHTML = '<span style="color:var(--error-color)">' + esc(data.error) + '</span>';
      return;
    }
    var logs = data.logs || [];
    if (!logs.length) {
      body.innerHTML = '<span style="color:var(--text-muted)">暂无访问记录</span>';
      return;
    }
    // actor 图标映射
    var actorIcon = { local: iconSvg('home', 12), cloud: iconSvg('cloud', 12), user: iconSvg('chat', 12) };
    var actorLabel = { local: '本地', cloud: '在线', user: '手动' };
    var typeLabel = { kb_search: '知识库检索', agent_read: '自动检索', manual_cite: '手动引用' };
    var html = '';
    for (var i = 0; i < logs.length; i++) {
      var l = logs[i];
      var _icon = actorIcon[l.actor] || '•';
      var _actorTxt = actorLabel[l.actor] || l.actor || '未知';
      var _typeTxt = typeLabel[l.access_type] || l.access_type || '';
      // 相关性评分可视化（5 圆点）
      var _scoreHtml = '';
      if (l.reranker_score != null) {
        var _filled = Math.round(l.reranker_score * 5);
        var _dots = '';
        for (var d = 0; d < 5; d++) { _dots += '<span style="color:' + (d < _filled ? 'var(--accent-color)' : 'var(--border-color)') + '">●</span>'; }
        _scoreHtml = '<span style="letter-spacing:1px">' + _dots + '</span> <span style="color:var(--text-muted)">' + l.reranker_score.toFixed(2) + '</span>';
      }
      html += '<div style="padding:10px 0;border-bottom:1px solid var(--border-color)">' +
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">' +
        '<span style="font-size:14px">' + _icon + '</span>' +
        '<span style="font-weight:500;color:var(--text-primary)">' + esc(_actorTxt) + '</span>' +
        '<span style="color:var(--text-muted);font-size:11px">' + esc(_typeTxt) + '</span>' +
        '<span style="flex:1"></span>' +
        '<span style="color:var(--text-muted);font-size:11px">' + esc(l.timestamp || '') + '</span>' +
        '</div>';
      if (l.query) {
        html += '<div style="color:var(--text-secondary);margin-bottom:3px">查询：<span style="color:var(--text-primary)">' + esc(l.query) + '</span></div>';
      }
      if (l.matched_text) {
        html += '<div style="color:var(--text-muted);font-size:11px;background:var(--bg-secondary);border-radius:4px;padding:6px 8px;margin-bottom:3px;line-height:1.5">' + esc(l.matched_text) + '</div>';
      }
      if (_scoreHtml) {
        html += '<div style="font-size:11px">相关性 ' + _scoreHtml + '</div>';
      }
      html += '</div>';
    }
    body.innerHTML = html;
    body.style.color = 'var(--text-secondary)';
  } catch (err) {
    var body2 = card.querySelector('#auditLogBody');
    if (body2) body2.innerHTML = '<span style="color:var(--error-color)">加载失败: ' + esc(err.message) + '</span>';
  }
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

// Fix B: 重新生成标签（retry-summary 端点已移除，复用健在的 retry-tagging）
async function kbRetrySummary(docId) {
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/retry-tagging/' + encodeURIComponent(docId), { method: 'POST' });
    var data = await resp.json();
    if (data.ok || resp.ok) {
      showToast('已重新触发标签生成');
      kbRefreshDocs();
    } else {
      showToast('重试失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) { showToast('重试失败: ' + err.message, 'error'); }
}

// --- 知识库功能说明弹窗 ---
function showKbInfo() {
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:500;display:flex;align-items:center;justify-content:center;animation:fadeIn .2s ease';
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
  var card = document.createElement('div');
  card.style.cssText = 'background:var(--bg-primary);border:0.5px solid var(--border-color);border-radius:12px;padding:24px;max-width:420px;width:90%;box-shadow:0 12px 40px rgba(0,0,0,.2);animation:msgSlideIn .25s ease-out';
  card.innerHTML = [
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">',
    '<svg width="22" height="22" viewBox="0 0 64 64" fill="none"><rect x="8" y="6" width="20" height="20" rx="3" stroke="#1e3a5f" stroke-width="2"/><rect x="36" y="34" width="20" height="20" rx="3" stroke="#c9976c" stroke-width="2"/><path d="M14 14h8M14 20h12" stroke="rgba(30,58,95,.25)" stroke-width="1" stroke-linecap="round"/><path d="M42 44l4 4 8-8" stroke="#c9976c" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    '<span style="font-size:15px;font-weight:600;color:var(--text-primary)">知识库功能介绍</span></div>',
    '<div style="line-height:1.7;font-size:.92em;color:var(--text-secondary)">',
    '<p style="margin:0 0 8px">知识库是你的<b>本地知识库助手</b>，核心功能：</p>',
    '<ul style="padding-left:18px;margin:8px 0">',
    '<li><b>文档上传</b>：支持 TXT / MD / CSV / DOCX / PDF 等格式</li>',
    '<li><b>语义检索</b>：基于 Embedding 模型理解语义，精准匹配</li>',
    '<li><b>智能问答</b>：在对话 Tab 选择「查知识库」action，AI 基于文档内容回答</li>',
    '</ul>',
    '<p style="margin:8px 0 0;color:var(--text-muted);font-size:.85em">' + iconSvg('info','12') + ' 知识库模型会在后台自动加载，无需手动操作。</p>',
    '</div>',
    '<div style="margin-top:16px;display:flex;justify-content:flex-end">',
    '<button style="padding:6px 20px;border:none;border-radius:6px;background:var(--accent-color);color:var(--text-on-accent,#fff);cursor:pointer;font-size:13px" onclick="this.closest(\'div\').parentNode.parentNode.remove()">知道了</button>',
    '</div>'
  ].join('');
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

window.kbResolveConflict = kbResolveConflict;

// ===== P6 检索健康度诊断（模态弹窗）=====
var _kbDiagModal = null;

function toggleKbDiagPopover() {
  // 已打开则关闭，否则打开
  if (_kbDiagModal) { _closeKbDiagModal(); return; }
  _openKbDiagModal();
}

function _openKbDiagModal() {
  if (_kbDiagModal) return;
  // overlay 半透明遮罩 + 居中
  var overlay = document.createElement('div');
  overlay.className = 'kb-diag-overlay';
  // 点遮罩空白处关闭
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) _closeKbDiagModal();
  });
  // 居中卡片
  var card = document.createElement('div');
  card.className = 'kb-diag-card';
  // 标题栏 + 关闭按钮
  var header = document.createElement('div');
  header.className = 'kb-diag-header';
  header.innerHTML = '<span class="kb-diag-title">检索健康度诊断</span>';
  var closeBtn = document.createElement('button');
  closeBtn.className = 'kb-diag-close';
  closeBtn.innerHTML = '&times;';
  closeBtn.title = '关闭';
  closeBtn.addEventListener('click', _closeKbDiagModal);
  header.appendChild(closeBtn);
  card.appendChild(header);
  // 内容区（id 保留，给 kbShowDiagnosis 填充）
  var body = document.createElement('div');
  body.id = 'kbDiagPopover';
  body.className = 'kb-diag-body';
  card.appendChild(body);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  _kbDiagModal = overlay;
  // Esc 关闭
  _kbDiagEscHandler = function(e) { if (e.key === 'Escape') _closeKbDiagModal(); };
  document.addEventListener('keydown', _kbDiagEscHandler);
  kbShowDiagnosis();   // 打开即刷新
}

var _kbDiagEscHandler = null;
function _closeKbDiagModal() {
  if (!_kbDiagModal) return;
  _kbDiagModal.remove();
  _kbDiagModal = null;
  if (_kbDiagEscHandler) {
    document.removeEventListener('keydown', _kbDiagEscHandler);
    _kbDiagEscHandler = null;
  }
}

async function kbShowDiagnosis() {
  var body = document.getElementById('kbDiagPopover');
  if (!body) return;
  body.innerHTML = '<div class="kb-diag-loading">诊断中...</div>';
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/kb/diagnosis');
    var d = await resp.json();
    body.innerHTML = _renderKbDiagnosis(d);
  } catch(e) {
    body.innerHTML = '<div class="kb-diag-error">诊断失败: ' + (e.message || '') + '</div>';
  }
}

function _renderKbDiagnosis(d) {
  // 健康度评分
  var score = d.health_score || 0;
  var scoreColor = score >= 80 ? 'var(--success-color,#16a34a)' : (score >= 50 ? 'var(--warning-color,#d97706)' : 'var(--error-color,#b91c1c)');
  var scoreLabel = score >= 80 ? '良好' : (score >= 50 ? '尚可' : '需关注');

  var html = '';
  // 健康度大字
  html += '<div class="kb-diag-score">';
  html += '<div class="kb-diag-score-num" style="color:' + scoreColor + '">' + score + '</div>';
  html += '<div><div class="kb-diag-score-label" style="color:' + scoreColor + '">' + scoreLabel + '</div>';
  html += '<div class="kb-diag-score-sub">健康度评分</div></div>';
  html += '</div>';

  // 核心指标
  html += '<div class="kb-diag-metrics">';
  html += _diagMetric('文档总数', d.doc_count);
  html += _diagMetric('内容片段', d.chunk_count);
  html += _diagMetric('向量维度', d.vector_dim || '--');
  html += _diagMetric('已就绪', d.ready_docs + '/' + d.doc_count);
  html += _diagMetric('已打标签', d.tagged_docs + '/' + d.doc_count);
  html += '</div>';

  // 问题列表
  if (d.issues && d.issues.length) {
    _kbDiagIssueCache = d.issues;   // 缓存供按钮 onclick 取 doc_ids
    html += '<div class="kb-diag-issues-title">诊断结果</div>';
    d.issues.forEach(function(issue, idx) {
      html += _renderKbDiagIssue(issue, idx);
    });
  }

  // 维护操作（危险操作区）
  html += '<div class="kb-diag-actions">';
  html += '<div class="kb-diag-actions-title">维护操作</div>';
  html += '<div class="kb-diag-action-row">';
  html += '<span class="kb-diag-action-msg">清除所有文档的检索命中计数</span>';
  html += '<button class="kb-diag-btn-danger" onclick="kbDiagResetHeatmap()">重置热力图</button>';
  html += '</div>';
  html += '</div>';
  return html;
}

function _renderKbDiagIssue(issue, idx) {
  var color = issue.level === 'error' ? 'var(--error-color)' :
              issue.level === 'ok' ? 'var(--success-color)' :
              'var(--text-muted)';   // info / 其它都灰
  // 图标：error/warn 用 !、ok 用 ✓、info 用 i（保留字符图标）
  var icon = issue.level === 'error' ? '!' : issue.level === 'ok' ? '✓' : 'i';
  var html = '<div class="kb-diag-issue">';
  html += '<div class="kb-diag-issue-row">';
  html += '<span class="kb-diag-issue-icon" style="color:' + color + '">' + icon + '</span>';
  html += '<span class="kb-diag-issue-msg">' + (issue.msg || '') + '</span>';
  html += '</div>';
  // 可操作 issue 渲染按钮
  if (issue.action && issue.doc_ids && issue.doc_ids.length) {
    if (issue.action === 'resume_all') {
      html += '<button class="kb-diag-btn" onclick="kbDiagResumeAll(' + idx + ')">全部继续</button>';
    } else if (issue.action === 'batch_retag') {
      html += '<button class="kb-diag-btn" onclick="kbDiagBatchRetag(' + idx + ')">一键打标签</button>';
    }
  }
  html += '</div>';
  return html;
}

// 动作：全部继续（逐个 resume 未就绪文档）
var _kbDiagIssueCache = [];
async function kbDiagResumeAll(issueIdx) {
  var issue = _kbDiagIssueCache[issueIdx];
  if (!issue || !issue.doc_ids || !issue.doc_ids.length) return;
  var btn = event && event.target;
  if (btn) { btn.disabled = true; btn.textContent = '继续处理中...'; }
  var ok = 0, fail = 0;
  var apiBase = typeof API !== 'undefined' ? API : '';
  for (var i = 0; i < issue.doc_ids.length; i++) {
    try {
      var r = await fetch(apiBase + '/api/kb/documents/' + encodeURIComponent(issue.doc_ids[i]) + '/resume', {method: 'POST'});
      if (r.ok) ok++; else fail++;
    } catch(e) { fail++; }
  }
  if (btn) btn.disabled = false;
  if (typeof showToast === 'function') {
    showToast(ok > 0 ? ('已恢复 ' + ok + ' 篇文档处理' + (fail ? '，' + fail + ' 篇失败' : '')) : '恢复失败，请重试', ok > 0 ? 'success' : 'error');
  }
  kbShowDiagnosis();   // 刷新诊断
}

// 动作：一键打标签
async function kbDiagBatchRetag(issueIdx) {
  var issue = _kbDiagIssueCache[issueIdx];
  if (!issue || !issue.doc_ids || !issue.doc_ids.length) return;
  var btn = event && event.target;
  if (btn) { btn.disabled = true; btn.textContent = '打标签中...'; }
  var apiBase = typeof API !== 'undefined' ? API : '';
  try {
    var r = await fetch(apiBase + '/api/kb/documents/batch_retag', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({doc_ids: issue.doc_ids}),
    });
    var data = await r.json();
    if (btn) btn.disabled = false;
    if (typeof showToast === 'function') {
      showToast(data.affected > 0 ? ('已提交 ' + data.affected + ' 篇文档打标签') : '提交失败', data.affected > 0 ? 'success' : 'error');
    }
  } catch(e) {
    if (btn) btn.disabled = false;
    if (typeof showToast === 'function') showToast('打标签请求失败', 'error');
  }
  kbShowDiagnosis();
}

// 动作：重置热力图（复用 kbResetHeatmap，成功后关闭诊断弹窗）
async function kbDiagResetHeatmap() {
  if (typeof showDialog !== 'function' || typeof kbResetHeatmap !== 'function') return;
  // 先二次确认（kbResetHeatmap 内部也有确认，这里跳过它的确认直接复用逻辑更清晰，
  // 但为避免改动 kbResetHeatmap，采用：调用它，它取消时不会发请求，无需处理）
  // 简化：直接调用 kbResetHeatmap，它自带确认+请求+toast+刷新热力图；
  // 重置后诊断数据本身不变，无需刷新诊断，只需关闭弹窗让用户看到热力图已重置。
  await kbResetHeatmap();
  _closeKbDiagModal();
}

// 重置知识库（清空所有导入数据，设置页危险操作）
async function kbResetKnowledgeBase() {
  if (typeof showDialog !== 'function') return;
  var confirmed = await showDialog(
    '重置知识库',
    '此操作将删除所有已导入的文档、文本片段和向量索引，且不可撤销。\n\n知识库功能本身不受影响，重置后可重新导入文档。',
    {type: 'danger', confirm: true, confirmLabel: '确认重置', cancelLabel: '取消'}
  );
  if (!confirmed) return;
  var apiBase = typeof API !== 'undefined' ? API : '';
  try {
    var resp = await fetch(apiBase + '/api/kb/reset', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({confirm: true}),
    });
    var data = await resp.json();
    if (data.ok) {
      if (typeof showToast === 'function') {
        showToast('已清空知识库（删除 ' + (data.deleted_docs || 0) + ' 篇文档）', 'success');
      }
      // 刷新文档列表 + 统计（kbRefreshDocs 同时刷新主页网格和设置页统计）
      // P6 #16: await + 延迟重试,确保后端删除完成后再拉统计,避免时序导致统计停留在旧值
      if (typeof kbRefreshDocs === 'function') {
        await kbRefreshDocs();
        setTimeout(function() { if (typeof kbRefreshDocs === 'function') kbRefreshDocs(); }, 600);
      }
    } else {
      if (typeof showToast === 'function') showToast('重置失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch(e) {
    if (typeof showToast === 'function') showToast('重置失败: ' + (e.message || ''), 'error');
  }
}

function _diagMetric(label, value) {
  return '<div class="kb-diag-metric">' +
    '<div class="kb-diag-metric-label">' + label + '</div>' +
    '<div class="kb-diag-metric-value">' + value + '</div></div>';
}
window.kbShowDiagnosis = kbShowDiagnosis;
window.toggleKbDiagPopover = toggleKbDiagPopover;
window.kbDiagResumeAll = kbDiagResumeAll;
window.kbDiagBatchRetag = kbDiagBatchRetag;
window.kbDiagResetHeatmap = kbDiagResetHeatmap;
window.kbResetKnowledgeBase = kbResetKnowledgeBase;
window.kbTogglePrivacy = kbTogglePrivacy;
window.kbShowDocDetail = kbShowDocDetail;

// P6: 诊断按钮事件绑定（点击切换浮层，不依赖 onclick HTML 属性）
document.addEventListener('DOMContentLoaded', function() {
  var _diagBtn = document.getElementById('kbDiagBtn');
  if (_diagBtn) _diagBtn.addEventListener('click', toggleKbDiagPopover);
});

// _kbBusyProcessing getter
try { Object.defineProperty(window, '_kbBusyProcessing', { get: function() { return _kbBusyProcessing; }, configurable: true }); } catch(e) { window._kbBusyProcessing = _kbBusyProcessing; }

// ===== kb-batch.js — P6 批量操作 + 热力图圆点 + 去重处理 =====
// 依赖: qa.js (kbRefreshDocs), utils.js (esc, showToast), errors.js (showDialog)
// 被引用: qa.js (kbRefreshDocs 渲染时调用 kbOnDocsRendered)

var _apiBase = (typeof API !== 'undefined' ? API : '');

// ===== 全局状态 =====
var _kbSelectedDocs = new Set();
var _kbHeatmapData = [];

// Patch5 修复：懒初始化 helper
function _ensureSelectedDocs() {
  if (_kbSelectedDocs && typeof _kbSelectedDocs.add === 'function') {
    return _kbSelectedDocs;
  }
  _kbSelectedDocs = new Set();
  return _kbSelectedDocs;
}

function _resetSelectedDocs() {
  _kbSelectedDocs = new Set();
  return _kbSelectedDocs;
}

// ============================================================
//  B1: 文档选中操作（checkbox 替代：卡片点击选中）
// ============================================================

function kbToggleSelect(docId) {
  var _sel = _ensureSelectedDocs();
  if (_sel.has(docId)) {
    _sel.delete(docId);
  } else {
    _sel.add(docId);
  }
  // 更新卡片选中视觉
  var cards = document.querySelectorAll('.kb-card[data-doc-id="' + docId + '"]');
  for (var i = 0; i < cards.length; i++) {
    cards[i].style.borderColor = _sel.has(docId) ? 'var(--accent-color)' : '';
    cards[i].style.background = _sel.has(docId) ? 'var(--color-background-info, #E6F1FB)' : '';
  }
  kbUpdateBatchToolbar();
}

// P8-4: 分批渲染下，批量操作基于数据而非 DOM（未渲染的卡片也要被选中）
function _kbVisibleDocIds() {
  var ids = [];
  var docs = (typeof _kbLastDocs !== 'undefined') ? _kbLastDocs : [];
  for (var i = 0; i < docs.length; i++) {
    var d = docs[i];
    if (typeof _kbActiveTagFilter !== 'undefined' && _kbActiveTagFilter) {
      if (_kbActiveTagFilter === '__uncategorized__') { if (d.category) continue; }
      else if (d.category !== _kbActiveTagFilter) continue;
    }
    if (typeof _kbNameFilter !== 'undefined' && _kbNameFilter &&
        d.filename.toLowerCase().indexOf(_kbNameFilter.toLowerCase()) === -1) continue;
    ids.push(d.doc_id);
  }
  return ids;
}

function _kbSyncSelectionVisual() {
  var _sel = _ensureSelectedDocs();
  var cards = document.querySelectorAll('.kb-card');
  for (var i = 0; i < cards.length; i++) {
    var docId = cards[i].getAttribute('data-doc-id');
    var sel = docId && _sel.has(docId);
    cards[i].style.borderColor = sel ? 'var(--accent-color)' : '';
    cards[i].style.background = sel ? 'var(--color-background-info, #E6F1FB)' : '';
  }
}

function kbSelectAll() {
  var _sel = _ensureSelectedDocs();
  var ids = _kbVisibleDocIds();
  for (var i = 0; i < ids.length; i++) _sel.add(ids[i]);
  _kbSyncSelectionVisual();
  kbUpdateBatchToolbar();
}

function kbSelectInvert() {
  var newSet = new Set();
  var ids = _kbVisibleDocIds();
  for (var i = 0; i < ids.length; i++) {
    if (!_ensureSelectedDocs().has(ids[i])) newSet.add(ids[i]);
  }
  _kbSelectedDocs = newSet;
  _kbSyncSelectionVisual();
  kbUpdateBatchToolbar();
}

function kbClearSelection() {
  _resetSelectedDocs();
  _kbSyncSelectionVisual();
  kbUpdateBatchToolbar();
}

function kbUpdateBatchToolbar() {
  var countEl = document.getElementById('kbBatchCount');
  var toolbar = document.getElementById('kbBatchToolbar');
  if (!toolbar) return;

  var count = _ensureSelectedDocs().size;
  if (countEl) countEl.textContent = count;

  toolbar.style.display = count > 0 ? 'flex' : 'none';

  var btns = toolbar.querySelectorAll('.kb-batch-btn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].disabled = count === 0;
  }
}

// ============================================================
//  B1: 批量操作
// ============================================================

async function kbBatchDelete() {
  var docIds = Array.from(_ensureSelectedDocs());
  if (docIds.length === 0) return;

  var confirmed = await showDialog('批量删除', '确定删除选中的 ' + docIds.length + ' 个文档？删除后无法恢复。', {type: 'danger', confirm: true, confirmLabel: '删除', cancelLabel: '取消'});
  if (!confirmed) return;

  try {
    var resp = await fetch(_apiBase + '/api/kb/documents/batch_delete', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({doc_ids: docIds})
    });
    var data = await resp.json();
    if (data.success) {
      var msg = '已删除 ' + data.deleted + ' 个文档';
      if (data.failed && data.failed.length > 0) msg += '，' + data.failed.length + ' 个失败';
      showToast(msg, data.failed && data.failed.length > 0 ? 'warning' : 'success');
      _resetSelectedDocs();
      kbUpdateBatchToolbar();
      await kbRefreshDocs();
      // P6 #16: 延迟再刷一次统计,确保后端删除完成(避免时序导致统计停留旧值)
      setTimeout(function() { if (typeof kbRefreshDocs === 'function') kbRefreshDocs(); }, 600);
      // P6: 批量删除后自动刷新洞察
      setTimeout(function() { if (typeof kbRefreshOverviewLLM === 'function') kbRefreshOverviewLLM(); }, 500);
    } else {
      showToast('批量删除失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('批量删除失败: ' + err.message, 'error');
  }
}

async function kbBatchRetag() {
  var docIds = Array.from(_ensureSelectedDocs());
  if (docIds.length === 0) return;

  var confirmed = await showDialog('批量重标', '确定对选中的 ' + docIds.length + ' 个文档重新生成 AI 标签？', {confirm: true, confirmLabel: '重标', cancelLabel: '取消'});
  if (!confirmed) return;

  try {
    var resp = await fetch(_apiBase + '/api/kb/documents/batch_retag', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({doc_ids: docIds})
    });
    var data = await resp.json();
    if (data.success) {
      showToast('已对 ' + data.affected + ' 个文档重新打标', 'success');
      _resetSelectedDocs();
      kbUpdateBatchToolbar();
      await kbRefreshDocs();
    } else {
      showToast('批量重标失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('批量重标失败: ' + err.message, 'error');
  }
}

async function kbBatchPrivacy(isPrivate) {
  var docIds = Array.from(_ensureSelectedDocs());
  if (docIds.length === 0) return;

  var label = isPrivate ? '设为私密' : '取消私密';
  var desc = isPrivate ? '设为私密后，在线模型将无法读取该文档内容。' : '取消私密后，文档将恢复对在线模型可见，所有已有令牌将被撤销。';
  var confirmed = await showDialog(label, desc, {confirm: true, confirmLabel: label, cancelLabel: '取消'});
  if (!confirmed) return;

  try {
    var resp = await fetch(_apiBase + '/api/kb/documents/batch_privacy', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({doc_ids: docIds, is_private: isPrivate})
    });
    var data = await resp.json();
    if (data.success) {
      showToast('已对 ' + data.affected + ' 个文档' + label, 'success');
      _resetSelectedDocs();
      kbUpdateBatchToolbar();
      await kbRefreshDocs();
    } else {
      showToast(label + '失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast(label + '失败: ' + err.message, 'error');
  }
}

// ============================================================
//  P6: 热力图 — 彩色圆点（冷灰/暖橙/热红）
// ============================================================

async function kbLoadHeatmap() {
  try {
    var resp = await fetch(_apiBase + '/api/kb/search_heatmap');
    var data = await resp.json();
    if (data.heatmap) {
      _kbHeatmapData = data.heatmap;
      kbRenderHeatmapInDocList();
    }
  } catch (err) {
    // 静默失败
  }
}

/**
 * P6: 在卡片网格中渲染热力图彩色圆点
 * cold (灰, #D3D1C7): hit=0
 * warm (琥珀, #BA7517): hit 1-9
 * hot (红, #D85A30): hit 10+
 */
function kbRenderHeatmapInDocList() {
  var heatmapMap = {};
  for (var i = 0; i < _kbHeatmapData.length; i++) {
    heatmapMap[_kbHeatmapData[i].doc_id] = _kbHeatmapData[i].hit_count;
  }

  var cards = document.querySelectorAll('.kb-card');
  for (var j = 0; j < cards.length; j++) {
    var card = cards[j];
    var docId = card.getAttribute('data-doc-id');
    var hits = heatmapMap[docId] || 0;
    var dot = card.querySelector('.hm-dot');
    if (dot) {
      dot.className = 'hm-dot ' + (hits >= 10 ? 'hot' : (hits >= 1 ? 'warm' : 'cold'));
      // 更新旁边的数字
      var statSpan = dot.parentNode;
      if (statSpan) {
        var textNodes = statSpan.childNodes;
        for (var k = 0; k < textNodes.length; k++) {
          if (textNodes[k].nodeType === 3) { // text node
            textNodes[k].textContent = hits;
            break;
          }
        }
      }
    }
  }
}

async function kbResetHeatmap() {
  var confirmed = await showDialog('重置热力图', '确定重置所有文档的检索命中计数？此操作不可撤销。', {type: 'danger', confirm: true, confirmLabel: '重置', cancelLabel: '取消'});
  if (!confirmed) return;

  try {
    var resp = await fetch(_apiBase + '/api/kb/search_heatmap/reset', {method: 'POST'});
    var data = await resp.json();
    if (data.ok) {
      showToast('已重置 ' + data.reset_count + ' 个文档的命中计数', 'success');
      kbLoadHeatmap();
    } else {
      showToast('重置失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('重置失败: ' + err.message, 'error');
  }
}

// ============================================================
//  Tag 聚类（P6: 侧栏标签树由 qa.js 的 kbRenderTagTree 渲染，
//  此处保留聚类算法供 kbRenderTagClusters 使用）
// ============================================================

function _levenshtein(a, b) {
  var m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  var prev = new Array(n + 1);
  var curr = new Array(n + 1);
  for (var j = 0; j <= n; j++) prev[j] = j;
  for (var i = 1; i <= m; i++) {
    curr[0] = i;
    for (var j = 1; j <= n; j++) {
      var cost = (a.charAt(i - 1) === b.charAt(j - 1)) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    var tmp = prev; prev = curr; curr = tmp;
  }
  return prev[n];
}

function _bigrams(s) {
  var result = [];
  for (var i = 0; i < s.length - 1; i++) result.push(s.substring(i, i + 2));
  return result;
}

function tagSimilarity(a, b) {
  a = (a || '').toLowerCase().trim();
  b = (b || '').toLowerCase().trim();
  if (a === b) return 1.0;
  if (!a || !b) return 0;
  if (a.length <= 6 || b.length <= 6) {
    var dist = _levenshtein(a, b);
    return 1 - dist / Math.max(a.length, b.length);
  }
  var ga = _bigrams(a), gb = _bigrams(b);
  var inter = 0, gbSet = {};
  for (var i = 0; i < gb.length; i++) gbSet[gb[i]] = true;
  for (var j = 0; j < ga.length; j++) { if (gbSet[ga[j]]) inter++; }
  var union = ga.length + gb.length - inter;
  return union > 0 ? inter / union : 0;
}

function _UnionFind(size) {
  this.parent = new Array(size);
  this.rank = new Array(size);
  for (var i = 0; i < size; i++) { this.parent[i] = i; this.rank[i] = 0; }
}
_UnionFind.prototype.find = function(x) {
  while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]]; x = this.parent[x]; }
  return x;
};
_UnionFind.prototype.union = function(x, y) {
  var rx = this.find(x), ry = this.find(y);
  if (rx === ry) return;
  if (this.rank[rx] < this.rank[ry]) { this.parent[rx] = ry; }
  else if (this.rank[rx] > this.rank[ry]) { this.parent[ry] = rx; }
  else { this.parent[ry] = rx; this.rank[rx]++; }
};

function clusterTags(tagList, threshold) {
  threshold = threshold || 0.7;
  if (!tagList || tagList.length === 0) return [];
  var tagFreq = {};
  for (var i = 0; i < tagList.length; i++) {
    var t = tagList[i]; if (!t) continue;
    tagFreq[t] = (tagFreq[t] || 0) + 1;
  }
  var uniqueTags = Object.keys(tagFreq);
  if (uniqueTags.length === 0) return [];
  var n = uniqueTags.length;
  var uf = new _UnionFind(n);
  for (var a = 0; a < n; a++) {
    for (var b = a + 1; b < n; b++) {
      if (uniqueTags[a][0] !== uniqueTags[b][0]) continue;
      var sim = tagSimilarity(uniqueTags[a], uniqueTags[b]);
      if (sim >= threshold) uf.union(a, b);
    }
  }
  var groups = {};
  for (var k = 0; k < n; k++) {
    var root = uf.find(k);
    if (!groups[root]) groups[root] = [];
    groups[root].push(uniqueTags[k]);
  }
  var result = [];
  for (var rootKey in groups) {
    var tags = groups[rootKey];
    var bestTag = tags[0], bestFreq = tagFreq[tags[0]] || 0;
    for (var g = 1; g < tags.length; g++) {
      if ((tagFreq[tags[g]] || 0) > bestFreq) { bestTag = tags[g]; bestFreq = tagFreq[tags[g]]; }
    }
    var totalCount = 0;
    for (var c = 0; c < tags.length; c++) totalCount += (tagFreq[tags[c]] || 0);
    result.push({ group_name: bestTag, tags: tags, count: totalCount });
  }
  result.sort(function(x, y) { return y.count - x.count; });
  return result;
}

/**
 * P6: kbRenderTagClusters — 兼容旧接口，标签树现由 qa.js 渲染
 */
function kbRenderTagClusters(docs) {
  // P6: 标签树已由 qa.js 的 kbRenderTagTree 在侧栏渲染
  // 此函数保留为兼容接口，不再渲染内联标签栏
}

// ============================================================
//  去重处理
// ============================================================

// ============================================================
//  初始化（文档列表刷新后调用）
// ============================================================

function kbOnDocsRendered(docs) {
  // 清理已删除文档的选中状态
  var currentDocIds = {};
  for (var i = 0; i < docs.length; i++) {
    currentDocIds[docs[i].doc_id] = true;
  }
  var toRemove = [];
  _ensureSelectedDocs().forEach(function(id) {
    if (!currentDocIds[id]) toRemove.push(id);
  });
  for (var j = 0; j < toRemove.length; j++) {
    _ensureSelectedDocs().delete(toRemove[j]);
  }

  // 恢复卡片选中视觉
  var _sel = _ensureSelectedDocs();
  var cards = document.querySelectorAll('.kb-card');
  for (var k = 0; k < cards.length; k++) {
    var card = cards[k];
    var dId = card.getAttribute('data-doc-id');
    var isSel = _sel.has(dId);
    card.style.borderColor = isSel ? 'var(--accent-color)' : '';
    card.style.background = isSel ? 'var(--color-background-info, #E6F1FB)' : '';
  }

  // 加载热力图数据
  kbLoadHeatmap();

  // 更新工具栏
  kbUpdateBatchToolbar();
}

// --- 暴露到全局 ---
window.kbToggleSelect = kbToggleSelect;
window.kbSelectAll = kbSelectAll;
window.kbSelectInvert = kbSelectInvert;
window.kbClearSelection = kbClearSelection;
window.kbBatchDelete = kbBatchDelete;
window.kbBatchRetag = kbBatchRetag;
window.kbBatchPrivacy = kbBatchPrivacy;
window.kbRenderTagClusters = kbRenderTagClusters;
window.kbLoadHeatmap = kbLoadHeatmap;
window.kbResetHeatmap = kbResetHeatmap;
window.kbRenderHeatmapInDocList = kbRenderHeatmapInDocList;
window.kbOnDocsRendered = kbOnDocsRendered;
window._kbSelectedDocs = _kbSelectedDocs;
window._kbHeatmapData = _kbHeatmapData;

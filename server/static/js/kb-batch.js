// ===== kb-batch.js — Patch5 B1/B3/B4: 批量操作 + Tag聚类 + 热力图 + 去重处理 =====
// 依赖: qa.js (kbRefreshDocs, _kbDocs), utils.js (esc, showToast), errors.js (showDialog)
// 被引用: qa.js (kbRefreshDocs 渲染时调用), index.html (<script src>)

var _apiBase = (typeof API !== 'undefined' ? API : '');

// ===== 全局状态 =====
// Patch5 修复：延迟初始化，确保即使脚本加载顺序有问题也不会崩溃
// _ensureSelectedDocs() 返回一个有效的 Set（懒初始化）
function _ensureSelectedDocs() {
  if (typeof _kbSelectedDocs !== 'undefined' && _kbSelectedDocs && typeof _ensureSelectedDocs().add === 'function') {
    return _kbSelectedDocs;
  }
  // 懒初始化：如果还是老 Set，就复用；否则重建
  if (!(typeof _kbSelectedDocs !== 'undefined' && _kbSelectedDocs instanceof Set)) {
    _kbSelectedDocs = new Set();
  }
  return _kbSelectedDocs;
}
var _kbSelectedDocs = new Set();     // 选中的文档 ID 集合
var _kbTagClusters = [];             // Tag 聚类结果缓存
var _kbHeatmapData = [];             // 热力图数据缓存
var _kbLastDocs = [];                // 上次获取的文档列表（供聚类和渲染使用）

// ============================================================
//  B1: 文档选中操作（checkbox 全选/反选/单选）
// ============================================================

/**
 * 切换单个文档选中状态
 * @param {string} docId - 文档 ID
 */
function kbToggleSelect(docId) {
  var _sel = _ensureSelectedDocs();
  if (_sel.has(docId)) {
    _sel.delete(docId);
  } else {
    _sel.add(docId);
  }
  kbUpdateBatchToolbar();
}

/**
 * 全选所有 ready 状态的文档
 */
function kbSelectAll() {
  var _sel = _ensureSelectedDocs();
  for (var i = 0; i < _kbLastDocs.length; i++) {
    var d = _kbLastDocs[i];
    if (d.status === 'ready' || d.status === 'error' || d.status === 'cancelled') {
      _sel.add(d.doc_id);
    }
  }
  // 更新所有 checkbox
  var checkboxes = document.querySelectorAll('.kb-doc-checkbox');
  for (var j = 0; j < checkboxes.length; j++) {
    checkboxes[j].checked = true;
  }
  kbUpdateBatchToolbar();
}

/**
 * 反选
 */
function kbSelectInvert() {
  var newSet = new Set();
  for (var i = 0; i < _kbLastDocs.length; i++) {
    var d = _kbLastDocs[i];
    if (d.status === 'ready' || d.status === 'error' || d.status === 'cancelled') {
      if (!_ensureSelectedDocs().has(d.doc_id)) {
        newSet.add(d.doc_id);
      }
    }
  }
  _kbSelectedDocs = newSet;
  // 更新所有 checkbox
  var checkboxes = document.querySelectorAll('.kb-doc-checkbox');
  for (var j = 0; j < checkboxes.length; j++) {
    var cb = checkboxes[j];
    cb.checked = _ensureSelectedDocs().has(cb.getAttribute('data-doc-id'));
  }
  kbUpdateBatchToolbar();
}

/**
 * 清空选中
 */
function kbClearSelection() {
  _ensureSelectedDocs().clear();
  var checkboxes = document.querySelectorAll('.kb-doc-checkbox');
  for (var j = 0; j < checkboxes.length; j++) {
    checkboxes[j].checked = false;
  }
  kbUpdateBatchToolbar();
}

/**
 * 更新批量操作工具栏状态（选中计数 + 按钮可用性）
 */
function kbUpdateBatchToolbar() {
  var countEl = document.getElementById('kbBatchCount');
  var toolbar = document.getElementById('kbBatchToolbar');
  if (!toolbar) return;

  var count = _ensureSelectedDocs().size;
  if (countEl) countEl.textContent = count;

  // 选中数 > 0 时显示工具栏
  toolbar.style.display = count > 0 ? 'flex' : 'none';

  // 更新按钮状态
  var btns = toolbar.querySelectorAll('.kb-batch-btn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].disabled = count === 0;
  }
}

// ============================================================
//  B1: 批量操作（删除/重标/设私密）
// ============================================================

/**
 * 批量删除文档
 */
async function kbBatchDelete() {
  var docIds = Array.from(_kbSelectedDocs);
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
      if (data.failed && data.failed.length > 0) {
        msg += '，' + data.failed.length + ' 个失败';
      }
      showToast(msg, data.failed && data.failed.length > 0 ? 'warning' : 'success');
      _ensureSelectedDocs().clear();
      kbRefreshDocs();
    } else {
      showToast('批量删除失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('批量删除失败: ' + err.message, 'error');
  }
}

/**
 * 批量重新打标
 */
async function kbBatchRetag() {
  var docIds = Array.from(_kbSelectedDocs);
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
      _ensureSelectedDocs().clear();
      kbRefreshDocs();
    } else {
      showToast('批量重标失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('批量重标失败: ' + err.message, 'error');
  }
}

/**
 * 批量设置私密标记
 * @param {boolean} isPrivate - true=设为私密, false=取消私密
 */
async function kbBatchPrivacy(isPrivate) {
  var docIds = Array.from(_kbSelectedDocs);
  if (docIds.length === 0) return;

  var label = isPrivate ? '设为私密' : '取消私密';
  var confirmed = await showDialog(label, '确定对选中的 ' + docIds.length + ' 个文档' + label + '？', {confirm: true, confirmLabel: label, cancelLabel: '取消'});
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
      _ensureSelectedDocs().clear();
      kbRefreshDocs();
    } else {
      showToast(label + '失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast(label + '失败: ' + err.message, 'error');
  }
}

// ============================================================
//  B1: Tag 聚类算法（编辑距离 + 2-gram Jaccard + Union-Find）
// ============================================================

/**
 * Levenshtein 编辑距离（迭代实现）
 */
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

/**
 * 生成 2-gram 集合
 */
function _bigrams(s) {
  var result = [];
  for (var i = 0; i < s.length - 1; i++) {
    result.push(s.substring(i, i + 2));
  }
  return result;
}

/**
 * 计算两个 tag 的相似度
 * - 短 tag（≤6字符）：Levenshtein 归一化
 * - 长 tag（>6字符）：2-gram Jaccard
 */
function tagSimilarity(a, b) {
  a = (a || '').toLowerCase().trim();
  b = (b || '').toLowerCase().trim();
  if (a === b) return 1.0;
  if (!a || !b) return 0;

  if (a.length <= 6 || b.length <= 6) {
    var dist = _levenshtein(a, b);
    return 1 - dist / Math.max(a.length, b.length);
  }

  // 2-gram Jaccard
  var ga = _bigrams(a);
  var gb = _bigrams(b);
  var inter = 0;
  var gbSet = {};
  for (var i = 0; i < gb.length; i++) gbSet[gb[i]] = true;
  for (var j = 0; j < ga.length; j++) {
    if (gbSet[ga[j]]) inter++;
  }
  var union = ga.length + gb.length - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Union-Find（并查集）
 */
function _UnionFind(size) {
  this.parent = new Array(size);
  this.rank = new Array(size);
  for (var i = 0; i < size; i++) {
    this.parent[i] = i;
    this.rank[i] = 0;
  }
}
_UnionFind.prototype.find = function(x) {
  while (this.parent[x] !== x) {
    this.parent[x] = this.parent[this.parent[x]]; // 路径压缩
    x = this.parent[x];
  }
  return x;
};
_UnionFind.prototype.union = function(x, y) {
  var rx = this.find(x), ry = this.find(y);
  if (rx === ry) return;
  if (this.rank[rx] < this.rank[ry]) { this.parent[rx] = ry; }
  else if (this.rank[rx] > this.rank[ry]) { this.parent[ry] = rx; }
  else { this.parent[ry] = rx; this.rank[rx]++; }
};

/**
 * Tag 聚类
 * @param {Array<string>} tagList - 所有 tag 的扁平化列表
 * @param {number} threshold - 相似度阈值（默认 0.7）
 * @returns {Array} 聚类结果 [{group_name, tags: [...], count}]
 */
function clusterTags(tagList, threshold) {
  threshold = threshold || 0.7;
  if (!tagList || tagList.length === 0) return [];

  // 统计每个 tag 的出现频率
  var tagFreq = {};
  for (var i = 0; i < tagList.length; i++) {
    var t = tagList[i];
    if (!t) continue;
    tagFreq[t] = (tagFreq[t] || 0) + 1;
  }

  var uniqueTags = Object.keys(tagFreq);
  if (uniqueTags.length === 0) return [];

  var n = uniqueTags.length;
  var uf = new _UnionFind(n);

  // 两两比较（含首字符预过滤优化）
  for (var a = 0; a < n; a++) {
    for (var b = a + 1; b < n; b++) {
      var ta = uniqueTags[a], tb = uniqueTags[b];
      // 首字符不同且都不为空时跳过（减少计算量）
      if (ta[0] !== tb[0]) continue;
      var sim = tagSimilarity(ta, tb);
      if (sim >= threshold) {
        uf.union(a, b);
      }
    }
  }

  // 分组
  var groups = {};
  for (var k = 0; k < n; k++) {
    var root = uf.find(k);
    if (!groups[root]) groups[root] = [];
    groups[root].push(uniqueTags[k]);
  }

  // 每组取频率最高的 tag 作为组名
  var result = [];
  for (var rootKey in groups) {
    var tags = groups[rootKey];
    // 找出组内频率最高的 tag
    var bestTag = tags[0];
    var bestFreq = tagFreq[tags[0]] || 0;
    for (var g = 1; g < tags.length; g++) {
      if ((tagFreq[tags[g]] || 0) > bestFreq) {
        bestTag = tags[g];
        bestFreq = tagFreq[tags[g]];
      }
    }
    // 合并后的总频率
    var totalCount = 0;
    for (var c = 0; c < tags.length; c++) {
      totalCount += (tagFreq[tags[c]] || 0);
    }
    result.push({
      group_name: bestTag,
      tags: tags,
      count: totalCount
    });
  }

  // 按频率降序
  result.sort(function(x, y) { return y.count - x.count; });
  return result;
}

/**
 * 渲染 Tag 聚类栏（在文档列表上方）
 */
function kbRenderTagClusters(docs) {
  var container = document.getElementById('kbTagClusters');
  if (!container) return;

  // 收集所有文档的所有 tag
  var allTags = [];
  for (var i = 0; i < docs.length; i++) {
    var d = docs[i];
    if (d.tag_status === 'done' && d.tags) {
      for (var j = 0; j < d.tags.length; j++) {
        allTags.push(d.tags[j]);
      }
    }
  }

  if (allTags.length === 0) {
    container.style.display = 'none';
    container.innerHTML = '';
    _kbTagClusters = [];
    return;
  }

  var clusters = clusterTags(allTags, 0.7);
  _kbTagClusters = clusters;

  // 渲染
  var html = '';
  for (var k = 0; k < clusters.length; k++) {
    var c = clusters[k];
    var mergedCount = c.tags.length;
    var label = esc(c.group_name);
    if (mergedCount > 1) {
      label += '<span class="kb-tag-merged-count">(' + mergedCount + ')</span>';
    }
    html += '<span class="kb-tag-cluster" onclick="kbFilterByTagCluster(' + k + ')" title="' + esc(c.tags.join(', ')) + '">' + label + '</span>';
  }
  container.innerHTML = html;
  container.style.display = clusters.length > 0 ? 'flex' : 'none';
}

/**
 * 按聚类组过滤文档
 */
var _kbActiveTagFilter = null;
function kbFilterByTagCluster(index) {
  if (index < 0 || index >= _kbTagClusters.length) return;
  var cluster = _kbTagClusters[index];

  // 再次点击取消过滤
  if (_kbActiveTagFilter === index) {
    _kbActiveTagFilter = null;
  } else {
    _kbActiveTagFilter = index;
  }

  // 高亮选中的 tag
  var items = document.querySelectorAll('.kb-tag-cluster');
  for (var i = 0; i < items.length; i++) {
    items[i].classList.remove('active');
  }
  if (_kbActiveTagFilter !== null) {
    if (items[_kbActiveTagFilter]) items[_kbActiveTagFilter].classList.add('active');
  }

  // 刷新列表（带过滤）
  kbRefreshDocs();
}

// ============================================================
//  B1: 检索热力图
// ============================================================

/**
 * 加载热力图数据并渲染到文档列表
 */
async function kbLoadHeatmap() {
  try {
    var resp = await fetch(_apiBase + '/api/kb/search_heatmap');
    var data = await resp.json();
    if (data.heatmap) {
      _kbHeatmapData = data.heatmap;
      // 更新文档列表中的热力图标记
      kbRenderHeatmapInDocList();
    }
  } catch (err) {
    // 静默失败
  }
}

/**
 * 在文档列表中渲染热力图标记
 */
function kbRenderHeatmapInDocList() {
  // 构建 doc_id → hit_count 映射
  var heatmapMap = {};
  for (var i = 0; i < _kbHeatmapData.length; i++) {
    heatmapMap[_kbHeatmapData[i].doc_id] = _kbHeatmapData[i].hit_count;
  }

  // 更新每个文档项的热力图标记
  var docItems = document.querySelectorAll('.kb-doc-item');
  for (var j = 0; j < docItems.length; j++) {
    var item = docItems[j];
    var docId = item.getAttribute('data-doc-id');
    var hits = heatmapMap[docId] || 0;
    var heatEl = item.querySelector('.kb-heatmap-mark');
    if (heatEl) {
      if (hits > 0) {
        var fireCount = hits >= 10 ? '🔥🔥' : hits >= 3 ? '🔥' : '·';
        heatEl.style.display = 'inline';
        heatEl.innerHTML = fireCount + ' <span style="font-size:.9em">' + hits + '</span>';
        heatEl.title = '被检索命中 ' + hits + ' 次';
      } else {
        heatEl.style.display = 'none';
      }
    }
  }
}

/**
 * 重置热力图
 */
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
//  B3: 私密文档 🔒 标记渲染
// ============================================================

/**
 * 渲染文档的 🔒 标记
 * @param {object} doc - 文档对象
 * @returns {string} HTML 字符串
 */
function kbRenderPrivacyIcon(doc) {
  if (doc.is_private) {
    return '<span class="kb-lock-icon" title="私密文档（需令牌访问）">🔒</span>';
  }
  return '';
}

// ============================================================
//  B4: 去重处理窗口
// ============================================================

/**
 * 加载并显示重复文档列表
 */
async function kbShowDuplicates() {
  try {
    var resp = await fetch(_apiBase + '/api/kb/duplicates');
    var data = await resp.json();
    if (!data.duplicates || data.duplicates.length === 0) {
      showToast('暂无待处理的重复文档', 'info');
      return;
    }
    kbRenderDuplicatesDialog(data.duplicates);
  } catch (err) {
    showToast('加载重复列表失败: ' + err.message, 'error');
  }
}

/**
 * 渲染重复处理弹窗
 */
function kbRenderDuplicatesDialog(duplicates) {
  var overlay = document.createElement('div');
  overlay.className = 'kb-dup-overlay';
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };

  var card = document.createElement('div');
  card.className = 'kb-dup-card';

  var html = '<div class="kb-dup-header">';
  html += '<span class="kb-dup-title">📄 重复文档处理</span>';
  html += '<button class="kb-dup-close" onclick="this.closest(\'.kb-dup-overlay\').remove()">✕</button>';
  html += '</div>';
  html += '<div class="kb-dup-desc">检测到 ' + duplicates.length + ' 个重复文档，请选择处理方式：</div>';
  html += '<div class="kb-dup-list">';

  for (var i = 0; i < duplicates.length; i++) {
    var dup = duplicates[i];
    var levelText = dup.duplicate_level === 'l1_filename_size' ? '文件名+大小完全相同' : '内容相似度 ' + (dup.duplicate_similarity * 100).toFixed(0) + '%';
    html += '<div class="kb-dup-item" data-doc-id="' + esc(dup.doc_id) + '">';
    html += '<div class="kb-dup-item-info">';
    html += '<div class="kb-dup-item-name">' + esc(dup.filename) + '</div>';
    html += '<div class="kb-dup-item-detail">与「' + esc(dup.existing_filename) + '」重复 · ' + levelText + '</div>';
    html += '</div>';
    html += '<div class="kb-dup-actions">';
    html += '<button onclick="kbResolveDuplicate(\'' + esc(dup.doc_id) + '\', \'keep_both\')" class="kb-dup-btn">保留两版</button>';
    html += '<button onclick="kbResolveDuplicate(\'' + esc(dup.doc_id) + '\', \'replace\')" class="kb-dup-btn">替换旧版</button>';
    html += '<button onclick="kbResolveDuplicate(\'' + esc(dup.doc_id) + '\', \'cancel\')" class="kb-dup-btn kb-dup-btn-danger">删除新版</button>';
    html += '</div>';
    html += '</div>';
  }

  html += '</div>';
  card.innerHTML = html;
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

/**
 * 解决单个重复冲突
 */
async function kbResolveDuplicate(docId, action) {
  try {
    var resp = await fetch(_apiBase + '/api/kb/duplicates/resolve', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({doc_id: docId, action: action})
    });
    var data = await resp.json();
    if (data.ok) {
      showToast(data.detail, 'success');
      // 从弹窗中移除已处理的项
      var item = document.querySelector('.kb-dup-item[data-doc-id="' + docId + '"]');
      if (item) item.remove();
      // 如果没有更多重复项，关闭弹窗
      var remaining = document.querySelectorAll('.kb-dup-item');
      if (remaining.length === 0) {
        var overlay = document.querySelector('.kb-dup-overlay');
        if (overlay) overlay.remove();
      }
      kbRefreshDocs();
    } else {
      showToast('操作失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('操作失败: ' + err.message, 'error');
  }
}

// ============================================================
//  初始化（文档列表刷新后调用）
// ============================================================

/**
 * 文档列表渲染后触发的批量操作相关更新
 * 由 qa.js 的 kbRefreshDocs 在 listEl.innerHTML = html 后调用
 */
function kbOnDocsRendered(docs) {
  _kbLastDocs = docs;

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

  // 恢复 checkbox 状态
  // Patch5 修复：_kbSelectedDocs 可能在 kb-batch.js 完全初始化前被调用
  var _sel = (typeof _kbSelectedDocs !== 'undefined' && _kbSelectedDocs && typeof _ensureSelectedDocs().has === 'function') ? _kbSelectedDocs : null;
  var checkboxes = document.querySelectorAll('.kb-doc-checkbox');
  for (var k = 0; k < checkboxes.length; k++) {
    var cb = checkboxes[k];
    cb.checked = _sel ? _sel.has(cb.getAttribute('data-doc-id')) : false;
  }

  // 渲染 Tag 聚类
  kbRenderTagClusters(docs);

  // 加载热力图数据（异步，不阻塞渲染）
  kbLoadHeatmap();

  // 更新工具栏
  kbUpdateBatchToolbar();
}

// 暴露到全局
window.kbToggleSelect = kbToggleSelect;
window.kbSelectAll = kbSelectAll;
window.kbSelectInvert = kbSelectInvert;
window.kbClearSelection = kbClearSelection;
window.kbBatchDelete = kbBatchDelete;
window.kbBatchRetag = kbBatchRetag;
window.kbBatchPrivacy = kbBatchPrivacy;
window.kbRenderTagClusters = kbRenderTagClusters;
window.kbFilterByTagCluster = kbFilterByTagCluster;
window.kbLoadHeatmap = kbLoadHeatmap;
window.kbResetHeatmap = kbResetHeatmap;
window.kbRenderPrivacyIcon = kbRenderPrivacyIcon;
window.kbShowDuplicates = kbShowDuplicates;
window.kbResolveDuplicate = kbResolveDuplicate;
window.kbOnDocsRendered = kbOnDocsRendered;
window._kbSelectedDocs = _kbSelectedDocs;
window._kbTagClusters = _kbTagClusters;
window._kbHeatmapData = _kbHeatmapData;

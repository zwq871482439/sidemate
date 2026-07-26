// ===== 模型下载页 =====
// 依赖: settings.js (esc, iconSvg, _apiBase, showToast)

var _dlSource = 'modelscope';  // 'modelscope' | 'huggingface'
var _dlCurrentTaskId = null;   // 当前下载任务 ID
var _dlEventSource = null;     // SSE 连接
var _quickStartQueue = null;   // 快速开始任务队列 [{type, model_id, label}, ...]
var _quickStartTotal = 0;      // 快速开始总任务数（用于显示 1/2, 2/2）

// 刷新模型下载目录
async function loadModelCatalog() {
  var llmBox = document.getElementById('dlLlmList');
  var kbBox = document.getElementById('dlKbCard');
  var srcSel = document.getElementById('dlSource');
  if (srcSel) srcSel.value = _dlSource;
  if (!llmBox || !kbBox) return;

  llmBox.innerHTML = '<span style="color:var(--text-muted)">加载中...</span>';
  kbBox.innerHTML = '<span style="color:var(--text-muted)">加载中...</span>';

  try {
    var base = (typeof _apiBase !== 'undefined' ? _apiBase : '');
    // 首次进入下载页时 _sysTotalMem 尚未初始化（它原本只在"关于"页设置），
    // 推荐档位会错误地按 16GB 兜底。这里并行拉取统一硬件扫描 /api/system/info。
    var catalogPromise = fetch(base + '/api/models/catalog');
    var sysinfoPromise = window._sysTotalMem ? null :
      fetch(base + '/api/system/info').then(function(r) { return r.json(); }).then(function(info) {
        if (info && info.total_mem_gb) window._sysTotalMem = info.total_mem_gb;
      }).catch(function() {});
    var resp = await catalogPromise;
    if (sysinfoPromise) await sysinfoPromise;
    var data = await resp.json();

    // ---- LLM 3 档卡片 ----
    var llmModels = data.llm || [];
    if (!llmModels.length) {
      llmBox.innerHTML = '<div style="color:var(--text-muted);font-size:13px">暂无可下载的模型</div>';
    } else {
      var html = '';
      for (var i = 0; i < llmModels.length; i++) {
        var m = llmModels[i];
        var sizeGB = (m.gguf_size_bytes / 1e9).toFixed(2);
        var ramTxt = m.min_ram_gb ? '建议 %dGB 内存'.replace('%d', m.min_ram_gb) : '';
        html += _renderLlmCard(m, sizeGB, ramTxt);
      }
      llmBox.innerHTML = html;
    }

    // ---- KB 组合卡片 ----
    var kb = data.kb || {};
    kbBox.innerHTML = _renderKbCard(kb);

    // 检查是否有正在进行的下载任务
    _checkRunningTask();

    // 渲染快速开始卡片
    _renderQuickStart(data);

    // 刷新 KB Tab 锁徽标（下载完成后 🔒 应消失）
    if (typeof updateKbTabLock === 'function') updateKbTabLock();
  } catch (e) {
    llmBox.innerHTML = '<div style="color:var(--error-color);font-size:13px">加载失败: ' + esc(e.message) + '</div>';
    kbBox.innerHTML = '';
  }
}

function _renderLlmCard(m, sizeGB, ramTxt) {
  var statusBadge = '';
  var actionBtns = '';
  if (m.installed) {
    statusBadge = '<span style="font-size:.72em;padding:1px 6px;background:var(--bg-secondary);color:var(--dot-ok);border-radius:3px">已安装</span>';
    actionBtns = '<button class="btn btn-ghost" style="font-size:.8em" onclick="downloadModel(\'llm\',\'' + esc(m.model_id) + '\')">重新下载</button>' +
      '<button class="btn btn-danger" style="font-size:.8em;margin-left:6px" onclick="deleteModel(\'' + esc(m.model_id) + '\',\'' + esc(m.display_name) + '\')">删除</button>';
  } else {
    actionBtns = '<button class="btn btn-primary" style="font-size:.85em" onclick="downloadModel(\'llm\',\'' + esc(m.model_id) + '\')">下载</button>';
  }
  return '<div class="dl-model-card" data-model-id="' + esc(m.model_id) + '" style="padding:12px 14px;border:0.5px solid var(--border-color);border-radius:8px;margin-bottom:8px;display:flex;align-items:center;gap:12px">' +
    '<div style="flex:1;min-width:0">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">' +
        '<span style="font-weight:600;font-size:14px;color:var(--text-primary)">' + esc(m.display_name) + '</span>' +
        statusBadge +
      '</div>' +
      '<div style="font-size:.78em;color:var(--text-muted)">' + sizeGB + 'GB' + (ramTxt ? ' · ' + ramTxt : '') + '</div>' +
    '</div>' +
    '<div class="dl-card-action" style="display:flex;align-items:center">' + actionBtns + '</div>' +
  '</div>';
}

function _renderKbCard(kb) {
  var components = kb.components || [];
  var compHtml = components.map(function(c) {
    return '<span style="font-size:.78em;color:var(--text-muted)">' + esc(c.name) + ' ' + (c.size_gb ? c.size_gb + 'GB' : '') + '</span>';
  }).join('<span style="color:var(--text-muted);margin:0 4px">+</span>');

  var totalSize = components.reduce(function(s, c) { return s + (c.size_gb || 0); }, 0);
  var statusBadge = '';
  var actionBtns = '';
  if (kb.installed) {
    statusBadge = '<span style="font-size:.72em;padding:1px 6px;background:var(--bg-secondary);color:var(--dot-ok);border-radius:3px">已安装</span>';
    actionBtns = '<button class="btn btn-ghost" style="font-size:.85em" onclick="downloadModel(\'kb\')">重新下载</button>' +
      '<button class="btn btn-danger" style="font-size:.8em;margin-left:6px" onclick="uninstallKb()">卸载</button>';
  } else {
    actionBtns = '<button class="btn btn-primary" style="font-size:.85em" onclick="downloadModel(\'kb\')">下载知识库模型</button>';
  }
  // 部分安装状态提示
  var partStatus = '';
  if (!kb.installed && (kb.embedding_ready || kb.reranker_ready)) {
    // 只装了一部分
    var parts = [];
    if (!kb.embedding_ready) parts.push('向量化模型');
    if (!kb.reranker_ready) parts.push('重排序模型');
    if (parts.length) partStatus = '<div style="font-size:.75em;color:var(--text-info);margin-top:4px">⚠️ ' + parts.join('、') + ' 缺失</div>';
  }

  return '<div style="padding:12px 14px;border:0.5px solid var(--border-color);border-radius:8px">' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">' +
      '<span style="font-weight:600;font-size:14px;color:var(--text-primary)">知识库检索模型</span>' +
      statusBadge +
    '</div>' +
    '<div style="font-size:.78em;color:var(--text-muted);margin-bottom:6px">' + compHtml + ' · 共 ' + totalSize.toFixed(1) + 'GB</div>' +
    '<div style="font-size:.75em;color:var(--text-muted);margin-bottom:8px;line-height:1.5">包含向量化模型（bge-m3，支持语义+关键词检索）和重排序模型（bge-reranker-v2-m3，精排搜索结果）</div>' +
    partStatus +
    '<div class="dl-card-action" style="display:flex;align-items:center">' + actionBtns + '</div>' +
  '</div>';
}

// 切换下载源
function onDlSourceChange(sel) {
  _dlSource = sel.value;
}

// 删除已安装的 LLM 模型
async function deleteModel(modelId, displayName) {
  if (!modelId) return;
  var label = displayName || modelId;
  if (typeof showDialog === 'function') {
    if (!(await showDialog('删除模型', '确定删除「' + label + '」？\n\n删除后模型文件将从磁盘移除，可在此页重新下载恢复。', {type: 'danger', confirm: true, confirmLabel: '删除', cancelLabel: '取消'}))) return;
  } else if (!confirm('确定删除「' + label + '」？删除后可重新下载恢复。')) {
    return;
  }
  try {
    var resp = await fetch((typeof _apiBase !== 'undefined' ? _apiBase : '') + '/api/model/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId })
    });
    var data = await resp.json();
    if (data.ok) {
      if (typeof showToast === 'function') showToast('已删除: ' + label, 'success');
      loadModelCatalog();  // 刷新下载页目录
      // 同步刷新常规页的模型下拉 + 资源面板
      if (typeof refreshStatus === 'function') refreshStatus();
      if (typeof refreshResourcePanel === 'function') refreshResourcePanel();
    } else {
      if (typeof showToast === 'function') showToast('删除失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('删除失败: ' + e.message, 'error');
  }
}

// 启动下载
async function downloadModel(type, modelId) {
  if (_dlCurrentTaskId) {
    if (typeof showToast === 'function') showToast('已有下载任务进行中，请等待完成', 'error');
    return;
  }
  var body = { type: type, source: _dlSource };
  if (type === 'llm' && modelId) body.model_id = modelId;

  try {
    var resp = await fetch((typeof _apiBase !== 'undefined' ? _apiBase : '') + '/api/models/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var data = await resp.json();
    if (data.busy) {
      _dlCurrentTaskId = data.task_id;
      _attachSSE(data.task_id);
      if (typeof showToast === 'function') showToast('已有下载任务进行中', 'info');
      return;
    }
    if (data.error) {
      if (typeof showToast === 'function') showToast(data.error, 'error');
      return;
    }
    _dlCurrentTaskId = data.task_id;
    _showDownloadBar(data.label || '下载中...');
    _attachSSE(data.task_id);
  } catch (e) {
    if (typeof showToast === 'function') showToast('启动下载失败: ' + e.message, 'error');
  }
}

// 检查是否有正在进行的任务（页面刷新后恢复进度条）
async function _checkRunningTask() {
  try {
    var resp = await fetch((typeof _apiBase !== 'undefined' ? _apiBase : '') + '/api/models/download/status');
    var data = await resp.json();
    if (data.running && data.task_id) {
      _dlCurrentTaskId = data.task_id;
      _showDownloadBar(data.label || '下载中...');
      // 立即显示已有进度（后端缓存的 downloaded/total）
      if (data.total_bytes > 0) {
        var fill = document.getElementById('dlProgressFill');
        var text = document.getElementById('dlProgressText');
        if (fill) fill.style.width = Math.min(99, Math.round(data.downloaded_bytes * 100 / data.total_bytes)) + '%';
        if (text) text.textContent = _fmtSize(data.downloaded_bytes) + ' / ' + _fmtSize(data.total_bytes);
      }
      // 重新连 SSE 继续接收后续进度
      _attachSSE(data.task_id);
    }
  } catch (e) {
    // 静默失败，不影响页面加载
  }
}

function _fmtSize(n) {
  n = n || 0;
  var units = ['B', 'KB', 'MB', 'GB'];
  for (var i = 0; i < units.length; i++) {
    if (n < 1024) return n.toFixed(1) + units[i];
    n /= 1024;
  }
  return n.toFixed(1) + 'TB';
}

function _showDownloadBar(label) {
  var bar = document.getElementById('dlProgressBar');
  var fill = document.getElementById('dlProgressFill');
  var text = document.getElementById('dlProgressText');
  var cancelBtn = document.getElementById('dlCancelBtn');
  if (bar) bar.style.display = '';
  if (fill) fill.style.width = '0%';
  if (text) text.textContent = '准备下载 ' + label + '...';
  if (cancelBtn) cancelBtn.style.display = '';
}

function _hideDownloadBar() {
  var bar = document.getElementById('dlProgressBar');
  var cancelBtn = document.getElementById('dlCancelBtn');
  if (bar) bar.style.display = 'none';
  if (cancelBtn) cancelBtn.style.display = 'none';
}

// SSE 监听下载进度
function _attachSSE(taskId) {
  if (_dlEventSource) { _dlEventSource.close(); _dlEventSource = null; }
  // 禁用所有下载按钮
  var btns = document.querySelectorAll('#stab-download .dl-card-action button');
  btns.forEach(function(b) { b.disabled = true; b.style.opacity = '0.5'; });

  _dlEventSource = new EventSource((typeof _apiBase !== 'undefined' ? _apiBase : '') + '/api/models/download/progress/' + taskId);

  _dlEventSource.onmessage = function(ev) {
    var d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    var fill = document.getElementById('dlProgressFill');
    var text = document.getElementById('dlProgressText');
    if (fill) fill.style.width = (d.pct || 0) + '%';
    if (text) text.textContent = d.msg || '';

    if (d.done && !d.installed && !d.cancelled && !d.error) {
      // 裸 done = 下载完成但安装收尾中，后端随后会补推 installed 事件。
      // 不能在这里关 SSE——否则 installed 事件丢失，快速开始队列断链（要按两次）。
      if (text) text.textContent = d.msg || '下载完成，正在安装...';
      return;
    }

    if (d.done) {
      _dlEventSource.close();
      _dlEventSource = null;
      _dlCurrentTaskId = null;
      // 恢复按钮
      btns.forEach(function(b) { b.disabled = false; b.style.opacity = '1'; });

      if (d.installed) {
        if (text) text.textContent = '安装完成';
        if (fill) fill.style.width = '100%';
        // 快速开始：检查队列是否还有任务
        if (_quickStartQueue && _quickStartQueue.length > 0) {
          if (typeof showToast === 'function') showToast('安装完成，继续下一个...', 'success');
          setTimeout(function() { _quickStartNext(); }, 1500);
        } else {
          if (_quickStartTotal > 0) {
            // 快速开始全部完成
            if (typeof showToast === 'function') showToast('全部安装完成！可以开始使用了', 'success');
            _quickStartTotal = 0;
          } else {
            if (typeof showToast === 'function') showToast('模型下载并安装完成', 'success');
          }
          setTimeout(function() {
            _hideDownloadBar();
            loadModelCatalog();
          }, 3000);
        }
      } else if (d.cancelled) {
        // 取消时清空快速开始队列，否则残留队列会在下次任意下载完成时误触发
        _quickStartQueue = null;
        _quickStartTotal = 0;
        if (typeof showToast === 'function') showToast('下载已取消', 'info');
        _hideDownloadBar();
      } else if (d.error) {
        // 失败同样清空队列（断链，由用户重新发起）
        _quickStartQueue = null;
        _quickStartTotal = 0;
        if (typeof showToast === 'function') showToast('下载失败: ' + d.error, 'error');
      }
      // 刷新目录（3 秒后自动隐藏进度条）
      setTimeout(function() {
        _hideDownloadBar();
        loadModelCatalog();
      }, 3000);
    }
  };

  _dlEventSource.onerror = function() {
    // SSE 断开：检查任务是否已完成（通过 status API），没完成则提示
    console.warn('[DL] SSE 连接断开');
    _dlEventSource.close();
    _dlEventSource = null;
    // 查后端任务状态：已完成则刷新目录，仍在跑则重连 SSE
    fetch((typeof _apiBase !== 'undefined' ? _apiBase : '') + '/api/models/download/status')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.running && d.task_id === taskId) {
          // 仍在跑，2 秒后重连
          setTimeout(function() { _attachSSE(taskId); }, 2000);
        } else {
          // 已结束（完成或取消），刷新目录
          _dlCurrentTaskId = null;
          btns.forEach(function(b) { b.disabled = false; b.style.opacity = '1'; });
          setTimeout(function() { _hideDownloadBar(); loadModelCatalog(); }, 1000);
        }
      })
      .catch(function() {
        _dlCurrentTaskId = null;
        btns.forEach(function(b) { b.disabled = false; b.style.opacity = '1'; });
      });
  };
}

// 取消下载
async function cancelDownload() {
  if (!_dlCurrentTaskId) return;
  try {
    await fetch((typeof _apiBase !== 'undefined' ? _apiBase : '') + '/api/models/download/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: _dlCurrentTaskId })
    });
  } catch (e) {
    if (typeof showToast === 'function') showToast('取消失败: ' + e.message, 'error');
  }
}

// 从本地 .sidemate 包安装（复用 /api/extensions/upload + install-progress SSE）
// 类型由后端自动判断（manifest.json 里的 type 字段）
function installFromLocal() {
  var input = document.getElementById('dlLocalInput');
  if (input) {
    input.value = '';
    input.click();
  }
}

async function onDlLocalPicked(event) {
  var file = event.target.files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.sidemate')) {
    if (typeof showToast === 'function') showToast('请选择 .sidemate 格式的扩展包', 'warning');
    return;
  }
  _showDownloadBar('安装 ' + file.name + '...');
  var formData = new FormData();
  formData.append('file', file);
  try {
    var resp = await fetch((typeof _apiBase !== 'undefined' ? _apiBase : '') + '/api/extensions/upload', {
      method: 'POST',
      body: formData
    });
    var data = await resp.json();
    if (data.error) {
      if (typeof showToast === 'function') showToast(data.error, 'error');
      _hideDownloadBar();
      return;
    }
    _attachInstallSSE(data.task_id);
  } catch (e) {
    if (typeof showToast === 'function') showToast('上传失败: ' + e.message, 'error');
    _hideDownloadBar();
  }
}

// SSE 监听 .sidemate 包安装进度（复用 /api/extensions/install-progress）
var _dlInstallES = null;
function _attachInstallSSE(taskId) {
  if (_dlInstallES) { _dlInstallES.close(); _dlInstallES = null; }
  _dlInstallES = new EventSource((typeof _apiBase !== 'undefined' ? _apiBase : '') + '/api/extensions/install-progress/' + taskId);
  _dlInstallES.onmessage = function(ev) {
    var d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    var fill = document.getElementById('dlProgressFill');
    var text = document.getElementById('dlProgressText');
    if (fill) fill.style.width = (d.pct || 0) + '%';
    if (text) text.textContent = d.msg || '';
    if (d.done || d.event === 'complete' || d.event === 'error') {
      _dlInstallES.close();
      _dlInstallES = null;
      if (d.event === 'error' || (d.msg && d.msg.indexOf('失败') >= 0)) {
        if (typeof showToast === 'function') showToast('安装失败: ' + (d.msg || '未知'), 'error');
      } else {
        if (typeof showToast === 'function') showToast('安装完成', 'success');
        if (typeof rescanModels === 'function') rescanModels();
      }
      setTimeout(function() { _hideDownloadBar(); loadModelCatalog(); }, 2000);
    }
  };
  _dlInstallES.onerror = function() {
    console.warn('[DL] install SSE 断开');
    _dlInstallES.close();
    _dlInstallES = null;
    // 安装 SSE 断开：刷新目录看是否已安装成功
    setTimeout(function() { _hideDownloadBar(); loadModelCatalog(); }, 1000);
  };
}

// 卸载知识库模型（复用 /api/extensions/uninstall）
async function uninstallKb() {
  if (typeof showDialog === 'function') {
    if (!(await showDialog('卸载知识库模型', '确定卸载知识库模型？\n\n卸载后 models/embedding 和 models/reranker 将被删除，可重新下载恢复。', {type: 'danger', confirm: true, confirmLabel: '卸载', cancelLabel: '取消'}))) return;
  } else if (!confirm('确定卸载知识库模型？可重新下载恢复。')) {
    return;
  }
  try {
    var resp = await fetch((typeof _apiBase !== 'undefined' ? _apiBase : '') + '/api/extensions/uninstall/knowledge/knowledge', { method: 'DELETE' });
    var data = await resp.json();
    if (data.ok || data.success) {
      if (typeof showToast === 'function') showToast('知识库模型已卸载', 'success');
      loadModelCatalog();
      if (typeof updateTabVisibility === 'function') updateTabVisibility();
    } else {
      if (typeof showToast === 'function') showToast('卸载失败: ' + (data.error || '未知'), 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('卸载失败: ' + e.message, 'error');
  }
}

// ===== 快速开始（一键下载 LLM + KB）=====

function _getRecommendedLlm(llmModels) {
  // 根据系统内存推荐 LLM 档位
  var ram = window._sysTotalMem || 16;
  var recommendedId;
  if (ram >= 32) recommendedId = 'qwen3.5-4b-q4';
  else if (ram >= 24) recommendedId = 'qwen3.5-2b-q4';
  else recommendedId = 'qwen3.5-0.8b-q4';

  // 确保推荐的模型在 catalog 中存在
  var found = null;
  for (var i = 0; i < llmModels.length; i++) {
    if (llmModels[i].model_id === recommendedId) { found = llmModels[i]; break; }
  }
  // 兜底：取最后一个（通常是最大的）
  if (!found && llmModels.length > 0) found = llmModels[llmModels.length - 1];
  return found;
}

function _renderQuickStart(data) {
  var card = document.getElementById('dlQuickStart');
  var content = document.getElementById('dlQuickStartContent');
  if (!card || !content) return;

  var llmModels = data.llm || [];
  var kb = data.kb || {};
  var llmInstalled = llmModels.some(function(m) { return m.installed; });
  var kbInstalled = !!kb.installed;

  // 全部已安装 → 显示已就绪状态
  if (llmInstalled && kbInstalled) {
    card.style.display = '';
    content.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<span style="color:var(--dot-ok, #16a34a);font-weight:600">全部模型已安装</span>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--text-muted);margin-top:4px">如需更换模型，可在下方自行下载或删除</div>';
    return;
  }

  // 有下载正在进行 → 隐藏快速开始（避免冲突）
  if (_dlCurrentTaskId) {
    card.style.display = 'none';
    return;
  }

  card.style.display = '';
  var recommended = _getRecommendedLlm(llmModels);
  var ram = window._sysTotalMem || 16;
  var ramNote = ram < 16 ? '（⚠️ 你的内存 ' + ram + 'GB 低于建议值，可能出现卡顿）' : '';

  var html = '';

  if (!llmInstalled && !kbInstalled) {
    // 都没装：一键下载推荐组合
    var totalSize = recommended ? (recommended.gguf_size_bytes / 1e9).toFixed(1) : '2.7';
    totalSize = parseFloat(totalSize) + 4.5; // LLM + KB
    var llmName = recommended ? recommended.display_name : '推荐模型';
    var llmSizeTxt = recommended ? ('（' + (recommended.gguf_size_bytes / 1e9).toFixed(1) + 'GB）') : '';
    html =
      '<div>检测到你的电脑有 <b>' + ram + 'GB</b> 内存' + ramNote + '</div>' +
      '<div style="margin-top:6px">推荐方案：<b>' + esc(llmName) + '</b>' + llmSizeTxt + ' + 知识库模型（4.5GB）</div>' +
      '<div style="font-size:12px;color:var(--text-muted);margin-top:2px">总下载量约 ' + totalSize.toFixed(1) + 'GB，预计 10-30 分钟</div>' +
      '<button class="btn btn-primary" style="margin-top:10px;font-size:14px;padding:8px 20px" onclick="quickStart()">⬇️ 一键下载推荐方案</button>' +
      '<div style="font-size:11px;color:var(--text-muted);margin-top:6px">或自行选择下方的对话模型和知识库模型</div>';
  } else if (!kbInstalled) {
    // 只缺 KB
    html =
      '<div>对话模型已安装，知识库模型尚未安装</div>' +
      '<div style="font-size:12px;color:var(--text-muted);margin-top:2px">知识库模型约 4.5GB，安装后可使用文档上传和检索功能</div>' +
      '<button class="btn btn-primary" style="margin-top:10px;font-size:14px;padding:8px 20px" onclick="quickStart()">⬇️ 下载知识库模型</button>';
  } else {
    // 只缺 LLM
    var llmName2 = recommended ? recommended.display_name : '推荐模型';
    var llmSize = recommended ? (recommended.gguf_size_bytes / 1e9).toFixed(1) : '';
    html =
      '<div>知识库已安装，对话模型尚未安装</div>' +
      '<div style="margin-top:6px">推荐：<b>' + esc(llmName2) + '</b>' + (llmSize ? '（' + llmSize + 'GB）' : '') + '</div>' +
      '<button class="btn btn-primary" style="margin-top:10px;font-size:14px;padding:8px 20px" onclick="quickStart()">⬇️ 下载推荐对话模型</button>';
  }

  content.innerHTML = html;
}

async function quickStart() {
  if (_dlCurrentTaskId) {
    if (typeof showToast === 'function') showToast('已有下载任务进行中', 'error');
    return;
  }

  // 获取当前安装状态（从 catalog 读，不靠缓存）
  var resp = await fetch((typeof _apiBase !== 'undefined' ? _apiBase : '') + '/api/models/catalog');
  var data = await resp.json();
  var llmModels = data.llm || [];
  var kb = data.kb || {};
  var llmInstalled = llmModels.some(function(m) { return m.installed; });
  var kbInstalled = !!kb.installed;

  // 构建下载队列
  var queue = [];
  if (!llmInstalled) {
    var recommended = _getRecommendedLlm(llmModels);
    if (recommended) {
      queue.push({ type: 'llm', model_id: recommended.model_id, label: '对话模型' });
    }
  }
  if (!kbInstalled) {
    queue.push({ type: 'kb', model_id: null, label: '知识库模型' });
  }

  if (queue.length === 0) {
    if (typeof showToast === 'function') showToast('所有模型已安装', 'info');
    return;
  }

  _quickStartQueue = queue;
  _quickStartTotal = queue.length;

  // 隐藏快速开始卡片（下载中）
  var card = document.getElementById('dlQuickStart');
  if (card) card.style.display = 'none';

  _quickStartNext();
}

function _quickStartNext() {
  if (!_quickStartQueue || _quickStartQueue.length === 0) {
    // 队列空 = 全部完成
    _quickStartQueue = null;
    if (typeof showToast === 'function') showToast('全部安装完成！可以开始使用了', 'success');
    setTimeout(function() {
      _hideDownloadBar();
      loadModelCatalog();
    }, 3000);
    return;
  }

  var task = _quickStartQueue.shift();
  var phase = _quickStartTotal - _quickStartQueue.length; // 当前是第几个
  var phaseLabel = _quickStartTotal > 1 ? ' (' + phase + '/' + _quickStartTotal + ')' : '';

  // 显示阶段进度
  var text = document.getElementById('dlProgressText');
  if (text) text.textContent = '正在下载 ' + task.label + phaseLabel + '...';

  // 调用现有下载逻辑
  downloadModel(task.type, task.model_id);
}

window.loadModelCatalog = loadModelCatalog;
window.downloadModel = downloadModel;
window.deleteModel = deleteModel;
window.installFromLocal = installFromLocal;
window.onDlLocalPicked = onDlLocalPicked;
window.uninstallKb = uninstallKb;
window.onDlSourceChange = onDlSourceChange;
window.cancelDownload = cancelDownload;
window.quickStart = quickStart;
window.runEnvCheck = runEnvCheck;

// ===== 运行环境检查 + 修复 =====

async function runEnvCheck() {
  var list = document.getElementById('envCheckList');
  if (!list) return;
  list.innerHTML = '<span style="color:var(--text-muted)">检查中...</span>';

  try {
    var resp = await fetch((typeof _apiBase !== 'undefined' ? _apiBase : '') + '/api/env/diagnose');
    var data = await resp.json();
    _renderEnvCheck(data);
  } catch(e) {
    list.innerHTML = '<span style="color:var(--error-color)">检查失败: ' + esc(e.message) + '</span>';
  }
}

function _renderEnvCheck(data) {
  var list = document.getElementById('envCheckList');
  if (!list) return;

  var html = '';
  var _okIcon = '<span style="color:var(--dot-ok,#16a34a)">&check;</span>';
  var _badIcon = '<span style="color:var(--error-color)">&times;</span>';
  var _warnIcon = '<span style="color:var(--warning-color,#d97706)">&excl;</span>';

  var _rowStyle = 'display:flex;align-items:center;gap:8px;padding:3px 0;font-size:13px';

  // Python
  if (data.python) {
    html += '<div style="' + _rowStyle + '">' + _okIcon + '<span>Python ' + esc(data.python.version || '') + '</span></div>';
  }

  // llama-server
  if (data.llama_server) {
    var lsIcon = data.llama_server.ok ? _okIcon : _badIcon;
    html += '<div style="' + _rowStyle + '">' + lsIcon + '<span>llama-server ' + (data.llama_server.ok ? '已就绪' : '未找到') + '</span></div>';
  }

  // 依赖
  var deps = data.deps || {};
  var categoryLabels = { base: '基础', cloud: '云端', kb: '知识库' };
  var missingPkgs = [];

  for (var cat of ['base', 'cloud', 'kb']) {
    var items = deps[cat] || [];
    for (var i = 0; i < items.length; i++) {
      var dep = items[i];
      var icon = dep.ok ? _okIcon : _badIcon;
      var badge = '<span style="font-size:10px;color:var(--text-muted);margin-left:4px">[' + (categoryLabels[cat] || cat) + ']</span>';
      var repairBtn = '';
      if (!dep.ok) {
        missingPkgs.push(dep.pip);
        repairBtn = ' <button class="btn btn-ghost" style="font-size:11px;padding:2px 8px;margin-left:6px" onclick="repairDeps([\'' + esc(dep.pip) + '\'])">修复</button>';
      }
      html += '<div style="' + _rowStyle + '">' + icon + '<span>' + esc(dep.pip) + badge + '</span>' + repairBtn + '</div>';
    }
  }

  // 可选依赖
  if (data.optional_missing && data.optional_missing.length > 0) {
    for (var j = 0; j < data.optional_missing.length; j++) {
      var opt = data.optional_missing[j];
      html += '<div style="' + _rowStyle + '">' + _warnIcon + '<span>' + esc(opt) + ' <span style="color:var(--text-muted);font-size:11px">(可选，缺失时功能降级)</span></span></div>';
    }
  }

  // 模型状态
  if (data.models) {
    html += '<div style="margin-top:8px;padding-top:6px;border-top:0.5px solid var(--border-color)"></div>';
    if (data.models.llm_loaded) {
      html += '<div style="' + _rowStyle + '">' + _okIcon + '<span>LLM 模型已加载 (' + esc(data.models.llm_name || '') + ')</span></div>';
    } else {
      html += '<div style="' + _rowStyle + '">' + _badIcon + '<span>LLM 模型未加载</span></div>';
    }
    if (data.models.kb_loaded !== undefined) {
      html += '<div style="' + _rowStyle + '">' + (data.models.kb_loaded ? _okIcon : _badIcon) + '<span>知识库模型 ' + (data.models.kb_loaded ? '已加载' : '未加载') + '</span></div>';
    }
  }

  // 一键修复（有缺失时）
  if (missingPkgs.length > 0) {
    var pkgList = missingPkgs.map(function(p) { return "'" + p + "'"; }).join(',');
    html += '<div style="margin-top:8px"><button class="btn btn-primary" style="font-size:13px" onclick="repairDeps([' + pkgList + '])">一键修复 ' + missingPkgs.length + ' 个缺失</button></div>';
  }

  list.innerHTML = html;
}

async function repairDeps(packages) {
  if (!packages || !packages.length) return;
  var progress = document.getElementById('envRepairProgress');
  if (progress) {
    progress.style.display = '';
    progress.innerHTML =
      '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px">正在安装依赖...</div>' +
      '<div style="background:var(--bg-secondary);border-radius:6px;overflow:hidden;height:8px"><div id="envRepairFill" style="height:100%;background:var(--accent-color,#4f46e5);border-radius:6px;transition:width .3s;width:0%"></div></div>' +
      '<div id="envRepairText" style="font-size:11px;color:var(--text-muted);margin-top:4px"></div>';
  }

  try {
    var resp = await fetch((typeof _apiBase !== 'undefined' ? _apiBase : '') + '/api/env/repair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packages: packages })
    });
    var data = await resp.json();

    if (data.error) {
      if (typeof showToast === 'function') showToast(data.error, 'error');
      if (progress) progress.innerHTML = '';
      return;
    }

    // 监听 SSE 进度
    var es = new EventSource((typeof _apiBase !== 'undefined' ? _apiBase : '') + '/api/env/repair/progress/' + data.task_id);
    es.onmessage = function(ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch(_) { return; }
      var fill = document.getElementById('envRepairFill');
      var text = document.getElementById('envRepairText');
      if (d.type === 'progress') {
        if (fill) fill.style.width = (d.percent || 0) + '%';
        if (text) text.textContent = d.stage || '安装中...';
      } else if (d.type === 'done') {
        es.close();
        var installed = d.installed || [];
        var failed = d.failed || [];
        if (fill) fill.style.width = '100%';
        if (failed.length > 0) {
          if (text) text.textContent = '';
          if (typeof showToast === 'function') showToast('已安装 ' + installed.length + ' 个，' + failed.length + ' 个失败: ' + failed.join(', '), 'warning');
        } else {
          if (text) text.textContent = '';
          if (typeof showToast === 'function') showToast('安装完成: ' + installed.join(', '), 'success');
        }
        setTimeout(function() { if (progress) progress.style.display = 'none'; runEnvCheck(); }, 1500);
      } else if (d.type === 'error') {
        es.close();
        if (progress) progress.innerHTML = '';
        if (typeof showToast === 'function') showToast('修复失败: ' + (d.error || '').slice(0, 100), 'error');
      }
    };
    es.onerror = function() { es.close(); if (progress) progress.innerHTML = ''; };
  } catch(e) {
    if (typeof showToast === 'function') showToast('修复请求失败: ' + e.message, 'error');
    if (progress) progress.innerHTML = '';
  }
}

window.repairDeps = repairDeps;

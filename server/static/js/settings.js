// ===== settings.js v2.5 — 设置 Tab：模型管理、资源面板、设备切换 =====
// 依赖: api.js, errors.js, utils.js, 全局变量 (API, __HTML_VERSION__, _maxPromptTokens)
// 被引用: chat.js (updateChatOverlay), qa.js (kbRouteState), minutes.js

// 全局：当前已加载的原始 model_id（用于按钮状态判断）
var _loadedModelId = null;

// API 基础路径（提取为模块变量，避免到处写 typeof 检测）
var _apiBase = (typeof API !== 'undefined' ? API : '');

// 版本校验（帮助排查缓存问题）
console.log('[settings.js] loaded v2.5, __HTML_VERSION__=' + (typeof __HTML_VERSION__ !== 'undefined' ? __HTML_VERSION__ : 'unknown'));

// ===== 资源占用面板 =====
async function refreshResourcePanel() {
  try {
    var resp = await fetch(_apiBase + '/api/resource-info');
    var data = await resp.json();
    if (!data || !data.system) return;

    var sys = data.system;
    var mod = data.modules || {};

    // 系统内存总览
    var total = sys.total_mb;
    var used = sys.used_mb;
    var avail = sys.available_mb;

    document.getElementById('resMemLabel').textContent = fmtMB(used) + ' / ' + fmtMB(total);

    // 可用内存
    var availEl = document.getElementById('resAvail');
    availEl.textContent = fmtMB(avail);
    availEl.style.color = avail < 1500 ? '#ef4444' : avail < 3000 ? '#f59e0b' : '#16a34a';

    // 资源占用明细（保留模块占用展示，移除内存预算）
    var resModules = document.getElementById('resModules');
    if (resModules && mod) {
      var parts = [];
      // 基础：始终存在
      var baseInfo = mod.base || {};
      parts.push('基础 ' + fmtMB(baseInfo.mb || 0));
      // LLM
      var llmInfo = mod.llm || {};
      if (llmInfo.installed) {
        parts.push(llmInfo.loaded ? ('LLM ' + fmtMB(llmInfo.mb)) : 'LLM 未加载');
      }
      // 文库（嵌入+重排合计）
      var embedderInfo = mod.embedder || {};
      var rerankerInfo = mod.reranker || {};
      if (embedderInfo.installed) {
        var kbTotal = (embedderInfo.mb || 0) + (rerankerInfo.mb || 0);
        var kbLoaded = embedderInfo.loaded || rerankerInfo.loaded;
        parts.push(kbLoaded ? ('文库 ' + fmtMB(kbTotal)) : '文库 未加载');
      }
      // 纪要
      var recorderInfo = mod.recorder || {};
      if (recorderInfo.installed) {
        parts.push(recorderInfo.loaded ? ('纪要 ' + fmtMB(recorderInfo.mb)) : '纪要 未加载');
      }
      resModules.style.display = parts.length ? 'flex' : 'none';
      resModules.textContent = parts.join('  |  ');
    }
  } catch(e) {
    silentLog('[settings.refreshResourcePanel]', e);
  }
}

// ===== 模型状态 =====
async function refreshStatus() {
  var statusTextEl = document.getElementById('statusText');
  try {
    // 并行请求 /api/models 和 /api/status（8s 超时防卡死）
    function fetchWithTimeout(url) {
      return new Promise(function(resolve, reject) {
        var ctrl = new AbortController();
        var timeout = setTimeout(function() { ctrl.abort(); reject(new Error('timeout')); }, 8000);
        fetch(url, {signal: ctrl.signal}).then(function(r) {
          clearTimeout(timeout);
          resolve(r.json());
        }).catch(function(e) {
          clearTimeout(timeout);
          reject(e);
        });
      });
    }
    var results = await Promise.all([
      fetchWithTimeout(_apiBase + '/api/models'),
      fetchWithTimeout(_apiBase + '/api/status')
    ]);
    var data = results[0];
    var info2 = results[1];

    // 缓存当前模型的 token 上限
    if (typeof _maxPromptTokens !== 'undefined') {
      _maxPromptTokens = (data.profile && data.profile.max_prompt_tokens) || 0;
    }
    var tag = document.getElementById('modelTag');
    var stag = document.getElementById('settingsModelTag');
    var device = data.device || '';

    var hasModels = data.available && data.available.length > 0;
    var hasLoaded = !!(data.current);  // 是否有实际预热加载的模型
    // Debug: 帮助排查模型显示问题
    console.log('[ModelManager] API response:', JSON.stringify({available: data.available, loaded: data.loaded, current: data.current}));
    var modelInfoRow = document.getElementById('modelInfoRow');
    var noModelHint = document.getElementById('noModelHint');

    // 模型管理区：信息行始终显示（按钮根据状态切换），无模型时显示提示+扫描按钮
    if (hasModels) {
      if (modelInfoRow) modelInfoRow.style.display = 'flex';
      if (noModelHint) noModelHint.style.display = 'none';

      // 显示第一个模型的名称和来源信息
      var firstModel = data.available[0];
      var displayName = (data.available_display && data.available_display[0]) || firstModel;
      var nameEl = document.getElementById('modelNameDisplay');
      if (nameEl) nameEl.textContent = displayName;

      // 来源标签：预热后显示大小，未预热只显示 Ollama
      var quantEl = document.getElementById('modelQuantTag');
      if (quantEl && hasLoaded && data.profile) {
        var sizeLabel = data.profile.model_size ? data.profile.model_size + 'B' : '';
        quantEl.textContent = sizeLabel ? sizeLabel + ' · Ollama' : 'Ollama';
      } else if (quantEl) {
        quantEl.textContent = 'Ollama';
      }
    } else {
      // 无模型时也显示信息行（按钮显示"扫描模型"），同时显示引导提示
      if (modelInfoRow) modelInfoRow.style.display = 'flex';
      if (noModelHint) noModelHint.style.display = '';
      var nameEl2 = document.getElementById('modelNameDisplay');
      if (nameEl2) nameEl2.textContent = '未安装模型';
      var tagEl2 = document.getElementById('modelQuantTag');
      if (tagEl2) tagEl2.textContent = '';
    }

    // 模型标签（显示短名，API 调用用原始 model_id）
    var currentDisplay = data.current_display || data.current;
    _loadedModelId = data.current || null;
    // 云端模式下显示云端模型名称
    if (typeof _currentMode !== 'undefined' && _currentMode === 'cloud') {
      currentDisplay = window._cloudModelName || '云端模型';
      tag.className = 'model-tag';
      tag.textContent = currentDisplay;
      stag.innerHTML = '<span class="model-tag">' + esc(currentDisplay) + '</span>';
    } else if (data.current) {
      tag.className = 'model-tag';
      tag.textContent = currentDisplay;
      stag.innerHTML = '<span class="model-tag">' + esc(currentDisplay) + '</span>';
      localStorage.setItem('_model_ever_loaded', '1');
    } else {
      tag.className = 'model-tag none';
      tag.textContent = '未加载';
      stag.innerHTML = '<span class="model-tag none">未加载</span>';
    }

    // 标签 1：模型来源
    var sourceTag = document.getElementById('sourceTag');
    if (sourceTag) {
      if (data.current) {
        sourceTag.textContent = '正在使用本地AI模型';
        sourceTag.className = 'tag online on';
        sourceTag.style.background = '';
        sourceTag.style.color = '';
      } else if (hasModels) {
        sourceTag.textContent = '模型已就绪，预热后使用';
        sourceTag.className = 'tag online off';
        sourceTag.style.background = '';
        sourceTag.style.color = '';
      } else {
        sourceTag.textContent = '本地模型未加载';
        sourceTag.className = 'tag online off';
        sourceTag.style.background = '';
        sourceTag.style.color = '';
      }
      sourceTag.style.display = '';
    }

    // 标签 4：隐私标签
    var privacyTag = document.getElementById('privacyTag');
    if (privacyTag) privacyTag.style.display = data.current ? '' : 'none';

    if (statusTextEl) statusTextEl.style.display = 'none';

    // 更新预热按钮状态
    updateWarmupBtn(data);

    // 同步更新其他面板
    if (typeof kbRouteState === 'function') kbRouteState();
    if (typeof updateChatOverlay === 'function') updateChatOverlay();
    refreshResourcePanel();
    if (typeof refreshActionBar === 'function') refreshActionBar();
    refreshTokenBudget(data);
    updateTabVisibility();
    // refreshStatus 完成后 _loadedModelId 已更新，重新刷新 modeTag 文案
    if (typeof initModeTag === 'function') initModeTag();
  } catch(e) {
    if (statusTextEl) statusTextEl.textContent = '刷新失败: ' + e.message;
  }
}

// ===== 设备选择器（Ollama 版：仅显示 Ollama，已移除 UI）=====
// deviceSelect 已从 HTML 移除，此函数保留为空以防其他模块调用

// ===== 预热按钮状态 =====
function updateWarmupBtn(modelsData) {
  var btn = document.getElementById('modelActionBtn');
  var delBtn = document.getElementById('modelDeleteBtn');
  console.log('[updateWarmupBtn] btn=', btn, 'hasModels=', modelsData.available && modelsData.available.length > 0, 'isLoaded=', !!modelsData.current, 'available=', modelsData.available);
  if (!btn) { console.log('[updateWarmupBtn] ⚠️ modelActionBtn not found!'); return; }
  if (!modelsData) return;

  var hasModels = modelsData.available && modelsData.available.length > 0;
  var isLoaded = !!modelsData.current;

  // 删除按钮：有模型时显示，无模型时隐藏
  if (delBtn) {
    delBtn.style.display = hasModels ? 'inline-block' : 'none';
    if (hasModels) {
      var modelName = modelsData.available[0] || '';
      delBtn.onclick = function() { handleDeleteModel(modelName); };
    }
  }

  if (!hasModels) {
    // S0: 未安装模型 → 扫描模型
    btn.textContent = '扫描模型';
    btn.onclick = function() { rescanModels(); };
    btn.style.background = '';
    btn.style.color = '';
    btn.style.borderColor = '';
    btn.disabled = false;
  } else if (isLoaded) {
    // S2: 已完成预热 → 卸载模型
    btn.textContent = '卸载模型';
    btn.onclick = function() { handleUnload(); };
    btn.style.background = 'transparent';
    btn.style.color = 'var(--error-color)';
    btn.style.borderColor = 'var(--error-color)';
    btn.disabled = false;
  } else {
    // S1: 已安装未预热 → 预热模型
    btn.textContent = '预热模型';
    btn.onclick = function() { handleWarmup(); };
    btn.style.background = '';
    btn.style.color = '';
    btn.style.borderColor = '';
    btn.disabled = false;
  }
}

// ===== 模型预热 =====
async function handleWarmup() {
  var btn = document.getElementById('modelActionBtn');
  if (btn) { btn.disabled = true; btn.textContent = '预热中...'; btn.style.background = ''; btn.style.color = ''; btn.style.borderColor = ''; }

  try {
    var resp = await fetch(_apiBase + '/api/warmup', {method: 'POST'});
    var data = await resp.json();
    if (!data.ok) {
      if (btn) { btn.disabled = false; btn.textContent = '预热模型'; }
      return;
    }
    if (data.already_warm) {
      if (btn) {
        btn.textContent = '已就绪';
        btn.style.background = 'var(--success-color, #16a34a)';
        btn.style.color = '#fff';
        btn.style.borderColor = 'var(--success-color, #16a34a)';
      }
      refreshStatus();
      return;
    }

    // 后台加载中 → 显示全局覆层 + 轮询状态
    if (typeof showModuleLoading === 'function') showModuleLoading('模型预热中', 'model', '首次加载约需 10-30 秒');
    var _poll = setInterval(async function() {
      try {
        var r = await fetch(_apiBase + '/api/models');
        var d = await r.json();
        if (d.current) {
          clearInterval(_poll);
          if (typeof hideModuleLoading === 'function') hideModuleLoading();
          if (btn) {
            btn.textContent = '已就绪';
            btn.style.background = 'var(--success-color, #16a34a)';
            btn.style.color = '#fff';
            btn.style.borderColor = 'var(--success-color, #16a34a)';
          }
          localStorage.setItem('_model_ever_loaded', '1');
          refreshStatus();
          setTimeout(function() { if (typeof refreshResourcePanel === 'function') refreshResourcePanel(); }, 2000);
        }
      } catch(_) {}
    }, 1500);
  } catch(e) {
    if (typeof hideModuleLoading === 'function') hideModuleLoading();
    if (btn) { btn.disabled = false; btn.textContent = '预热模型'; }
  }
}

// ===== 重新扫描模型 =====
async function rescanModels() {
  var statusText = document.getElementById('statusText');
  if (statusText) statusText.textContent = '扫描中...';
  try {
    var resp = await fetch(_apiBase + '/api/rescan', {method: 'POST'});
    var data = await resp.json();
    if (data.error) {
      showToast('扫描失败: ' + data.error, 'error');
      return;
    }
    var msg = '扫描完成：发现 ' + data.total + ' 个模型' +
      (data.added.length ? '\n新增: ' + data.added.join(', ') : '') +
      (data.removed.length ? '\n移除: ' + data.removed.join(', ') : '');
    showToast(msg, 'success');
    await refreshStatus();
  } catch(e) {
    showToast('扫描失败: ' + e.message, 'error');
    await refreshStatus();
  }
}

// ===== 模型卸载 =====
async function handleUnload() {
  if (!(await showDialog('卸载模型', '确定卸载当前模型？卸载后需要重新预热才能使用对话功能。', {type: 'danger', confirm: true, confirmLabel: '卸载', cancelLabel: '取消'}))) return;
  var btn = document.getElementById('modelActionBtn');
  if (btn) { btn.disabled = true; btn.textContent = '卸载中...'; }
  try {
    var resp = await fetch(_apiBase + '/api/model/unload', {method: 'POST'});
    var data = await resp.json();
    if (data.ok) {
      if (typeof showToast === 'function') showToast('模型已卸载，资源已释放', 'success');
      refreshStatus();
      refreshResourcePanel();
    } else {
      if (typeof showToast === 'function') showToast('卸载失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch(e) {
    if (typeof showToast === 'function') showToast('卸载失败: ' + e.message, 'error');
  }
  if (btn) { btn.disabled = false; btn.textContent = '卸载模型'; }
}

// ===== 删除已安装的 LLM 模型 =====
async function handleDeleteModel(modelName) {
  if (!modelName) return;
  if (!(await showDialog('删除模型', '确定删除模型「' + modelName + '」？\n\n删除后模型文件将从磁盘移除，需要重新导入 .sidemate 模型包才能恢复。', {type: 'danger', confirm: true, confirmLabel: '删除', cancelLabel: '取消'}))) return;
  var delBtn = document.getElementById('modelDeleteBtn');
  if (delBtn) { delBtn.disabled = true; delBtn.textContent = '删除中...'; }
  try {
    var resp = await fetch(_apiBase + '/api/model/delete', {
      method: 'DELETE',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({model: modelName})
    });
    var data = await resp.json();
    if (data.ok) {
      if (typeof showToast === 'function') showToast('模型已删除: ' + modelName, 'success');
      refreshStatus();
      refreshResourcePanel();
    } else {
      if (typeof showToast === 'function') showToast('删除失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch(e) {
    if (typeof showToast === 'function') showToast('删除失败: ' + e.message, 'error');
  }
  if (delBtn) { delBtn.disabled = false; delBtn.textContent = '删除模型'; }
}

// ===== 切换推理设备（Ollama 版：已移除 UI，保留空函数防报错）=====

// ===== Reranker 常驻开关（已废弃，KB 模型始终常驻）=====

// ===== OCR (removed - no OCR DOM elements in HTML) =====

// ===== Token 预算展示 =====
async function refreshTokenBudget(modelsData) {
  var el = document.getElementById('settingsTokenBudget');
  if (!el) return;
  try {
    // 云端模式：从字典自动获取
    if (typeof _currentMode !== 'undefined' && _currentMode === 'cloud') {
      var cloudResp = await fetch(_apiBase + '/api/cloud/config');
      var cloudData = await cloudResp.json();
      var maxInput = cloudData.context_window || 0;
      var maxOutput = cloudData.max_output_tokens || 0;
      el.textContent = maxInput > 0 ? maxInput.toLocaleString() + ' tokens' : '--';
      el.style.color = maxInput > 0 ? 'var(--text-primary)' : 'var(--text-muted)';
      el.style.fontSize = '12px';
      var outEl = document.getElementById('settingsTokenOutput');
      if (outEl) {
        outEl.textContent = maxOutput > 0 ? maxOutput.toLocaleString() + ' tokens' : '--';
        outEl.style.color = maxOutput > 0 ? 'var(--text-primary)' : 'var(--text-muted)';
        outEl.style.fontSize = '12px';
      }
      return;
    }
    // 本地模式：原有逻辑
    var resp = await fetch(_apiBase + '/api/token-budget');
    var budget = await resp.json();
    if (budget.error) {
      el.textContent = '--';
      el.style.color = 'var(--text-muted)';
      el.style.fontSize = '12px';
      var outEl2 = document.getElementById('settingsTokenOutput');
      if (outEl2) { outEl2.textContent = '--'; outEl2.style.color = 'var(--text-muted)'; outEl2.style.fontSize = '12px'; }
      return;
    }
    var maxTok = budget.max_prompt_tokens || 0;
    var outTok = budget.max_output_tokens || 0;
    el.textContent = maxTok > 0 ? maxTok.toLocaleString() + ' tokens' : '--';
    el.style.color = maxTok > 0 ? 'var(--text-primary)' : 'var(--text-muted)';
    el.style.fontSize = '12px';
    var outEl = document.getElementById('settingsTokenOutput');
    if (outEl) {
      outTok = outTok || (maxTok > 0 ? 4096 : 0);
      outEl.textContent = outTok > 0 ? outTok.toLocaleString() + ' tokens' : '--';
      outEl.style.color = outTok > 0 ? 'var(--text-primary)' : 'var(--text-muted)';
      outEl.style.fontSize = '12px';
    }
  } catch(e) {
    el.textContent = '--';
  }
}

// ===== 纪要引擎常驻内存 =====
async function saveRecorderResident(value) {
  try {
    await fetch(_apiBase + '/api/config', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({recorder_resident: value})
    });
  } catch(e) { console.error('[settings.saveRecorderResident]', e); }
}

async function loadRecorderResident() {
  try {
    var resp = await fetch(_apiBase + '/api/config');
    var result = await resp.json();
    var cfg = result.config || result;
    var chk = document.getElementById('recorderResidentChk');
    if (chk) chk.checked = !!cfg.recorder_resident;
  } catch(e) { console.error('[settings.loadRecorderResident]', e); }
}

// ===== 扩展中心 =====
async function refreshExtensions() {
  var listEl = document.getElementById('extList');
  if (!listEl) return;
  listEl.innerHTML = '<span style="color:var(--text-muted)">加载中...</span>';
  try {
    var resp = await fetch(_apiBase + '/api/extensions/list');
    if (!resp.ok) {
      listEl.innerHTML = '<span style="color:var(--text-muted)">扩展服务暂不可用</span>';
      return;
    }
    var data = await resp.json();
    var exts = data.extensions || [];
    if (exts.length === 0) {
      listEl.innerHTML = '<span style="color:var(--text-muted)">暂无已安装扩展。上传 .sidemate 官方包安装模型、文库、语音等扩展。</span>';
      return;
    }
    var html = '';
    exts.forEach(function(ext) {
      var typeIcons = {model:'\\u{1F9E0}', knowledge:'\\u{1F4DA}', recorder:'\\u{1F399}', whisper:'\\u{1F399}', action:'\\u{2699}'};
      var displayNames = {knowledge:'文库扩展', recorder:'纪要扩展'};
      html += '<div style="padding:8px 0;border-bottom:0.5px solid var(--border-color);display:flex;align-items:center;gap:8px">' +
        '<span style="font-size:13px"><strong>' + esc(displayNames[ext.name] || ext.name || '未知') + '</strong>' +
        ' <span style="font-size:.72em;padding:1px 6px;background:var(--bg-secondary);color:var(--accent-color);border-radius:3px">' + esc(ext.name || '?') + '</span>' +
        ' <span style="color:var(--text-muted);font-size:.85em">v' + esc(ext.version || '?') + '</span>' +
        (ext.model_name ? ' <span style="color:var(--text-muted);font-size:.85em">' + esc(ext.model_name) + '</span>' : '') +
        '</span>' +
        '<button style="margin-left:auto;font-size:.75em;padding:2px 8px;border:1px solid var(--error-color);color:var(--error-color);border-radius:4px;cursor:pointer;background:transparent" onclick="uninstallExtension(\'' + esc(ext.type) + '\',\'' + esc(ext.name) + '\')">卸载</button>' +
        '</div>';
    });
    listEl.innerHTML = html;
  } catch(e) {
    listEl.innerHTML = '<span style="color:var(--error-color)">加载失败: ' + esc(e.message || '未知') + '</span>';
    silentLog('[settings.refreshExtensions]', e);
  }
}

async function installExtension(file) {
  if (!file || !file.name.toLowerCase().endsWith('.sidemate')) {
    showToast('请选择 .sidemate 格式的官方扩展包', 'warning');
    return;
  }
  var btn = document.getElementById('extInstallBtn');
  var resultEl = document.getElementById('extInstallResult');
  var progressBar = document.getElementById('extProgressBar');
  var progressFill = document.getElementById('extProgressFill');
  var progressText = document.getElementById('extProgressText');
  if (btn) { btn.disabled = true; btn.textContent = '上传中...'; }
  if (resultEl) resultEl.textContent = '';
  // 显示进度条（上传阶段用 indeterminate 动画）
  if (progressBar) progressBar.style.display = 'block';
  if (progressFill) {
    progressFill.style.width = '30%';
    progressFill.style.animation = 'none';
    void progressFill.offsetWidth; // 强制 reflow
    progressFill.style.animation = 'indeterminateProgress 1.5s ease-in-out infinite';
  }
  if (progressText) progressText.textContent = '准备上传...';

  // 暂停心跳检测，避免安装期间误报"无法连接"
  if (typeof pauseHeartbeat === 'function') pauseHeartbeat();

  try {
    // 第一步：上传文件，获取 task_id
    var fd = new FormData();
    fd.append('file', file);
    var resp = await fetch(_apiBase + '/api/extensions/upload', {method: 'POST', body: fd});
    var data = await resp.json();

    if (data.error) {
      if (resultEl) {
        resultEl.innerHTML = iconSvg('cross') + ' ' + esc(data.error || '');
        resultEl.style.color = 'var(--error-color)';
      }
      return;
    }

    var taskId = data.task_id;
    if (!taskId) {
      if (resultEl) {
        resultEl.innerHTML = iconSvg('cross') + ' 服务器未返回任务ID';
        resultEl.style.color = 'var(--error-color)';
      }
      return;
    }

    if (progressText) progressText.textContent = '上传完成，等待安装...';

    // 第二步：通过 SSE 监听安装进度
    var es = new EventSource(_apiBase + '/api/extensions/install-progress/' + taskId);
    var done = false;

    es.onmessage = function(ev) {
      try {
        var d = JSON.parse(ev.data);
        if (d.type === 'progress') {
          var pct = d.percent || 0;
          if (progressFill) {
            progressFill.style.animation = 'none';
            progressFill.style.width = pct + '%';
          }
          if (progressText) progressText.textContent = (d.stage || '安装中...') + ' (' + pct + '%)';
          if (btn) btn.textContent = pct + '%';
        } else if (d.type === 'done') {
          done = true;
          es.close();
          var result = d.result || {};
          if (progressFill) {
            progressFill.style.animation = 'none';
            progressFill.style.width = '100%';
          }
          if (progressText) progressText.textContent = '安装完成！';
          if (btn) { btn.innerHTML = '安装完成 ' + iconSvg('check','14'); btn.style.background = 'var(--success-color)'; btn.style.color = '#fff'; btn.style.borderColor = 'var(--success-color)'; }
          if (resultEl) {
            resultEl.innerHTML = iconSvg('check') + ' ' + esc(result.name || '扩展') + ' 安装成功' + (result.auto_loaded ? '（已自动加载）' : '');
            resultEl.style.color = 'var(--success-color)';
          }
          refreshExtensions();
          updateTabVisibility();
          // 模型类安装后刷新模型管理区
          if (typeof refreshStatus === 'function') refreshStatus();
          if (result.type === 'llm' && typeof rescanModels === 'function') {
            rescanModels();
          }
          // 延迟隐藏进度条，恢复按钮
          setTimeout(function() {
            if (progressBar) progressBar.style.display = 'none';
            if (btn) { btn.textContent = '安装扩展'; btn.style.background = ''; btn.style.color = ''; btn.style.borderColor = ''; }
          }, 2000);
        } else if (d.type === 'error') {
          done = true;
          es.close();
          if (resultEl) {
            resultEl.innerHTML = iconSvg('cross') + ' ' + esc(d.message || '安装失败');
            resultEl.style.color = 'var(--error-color)';
          }
          if (progressBar) progressBar.style.display = 'none';
        }
      } catch(e) { console.error('[installExtension SSE parse]', e); }
    };

    es.onerror = function() {
      if (!done) {
        done = true;
        es.close();
        if (resultEl) {
          resultEl.innerHTML = iconSvg('cross') + ' 安装连接中断';
          resultEl.style.color = 'var(--error-color)';
        }
        if (progressBar) progressBar.style.display = 'none';
      }
    };

  } catch(e) {
    if (resultEl) {
      resultEl.innerHTML = iconSvg('cross') + ' 安装失败: ' + esc(e.message);
      resultEl.style.color = 'var(--error-color)';
    }
    if (progressBar) progressBar.style.display = 'none';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '安装扩展'; }
    // 恢复心跳检测
    if (typeof resumeHeartbeat === 'function') resumeHeartbeat();
  }
}

async function uninstallExtension(type, name) {
  if (!(await showDialog('卸载扩展', '确定卸载扩展 "' + name + '"？', {type: 'danger', confirm: true, confirmLabel: '卸载', cancelLabel: '取消'}))) return;
  try {
    var resp = await fetch(_apiBase + '/api/extensions/uninstall/' + encodeURIComponent(type) + '/' + encodeURIComponent(name), {method: 'DELETE'});
    var data = await resp.json();
    if (data.ok) {
      showToast('扩展已卸载', 'success');
      refreshExtensions();
      updateTabVisibility();
    } else {
      showToast(data.error || '卸载失败', 'error');
    }
  } catch(e) { showToast('卸载失败: ' + e.message, 'error'); }
}

function onExtFilePicked(event) {
  var file = event.target.files[0];
  if (file) installExtension(file);
}

// ===== Tab 动态显隐 =====
async function updateTabVisibility() {
  try {
    var resp = await fetch(_apiBase + '/api/extensions/list');
    var data = await resp.json();
    var exts = data.extensions || [];
    var hasKB = exts.some(function(e) { return e.type === 'knowledge'; });
    var hasRecorder = exts.some(function(e) { return e.type === 'recorder' || e.type === 'whisper'; });

    var qaBtn = document.querySelector('.tabs-nav button[onclick*="qa"]');
    var minutesBtn = document.querySelector('.tabs-nav button[onclick*="minutes"]');
    if (qaBtn) qaBtn.style.display = hasKB ? '' : 'none';
    if (minutesBtn) minutesBtn.style.display = hasRecorder ? '' : 'none';

    // 同步更新系统状态卡片中的文库/语音引擎状态
    var kbStatusEl = document.getElementById('settingsKBStatus');
    var whisperStatusEl = document.getElementById('settingsWhisperStatus');
    if (kbStatusEl) {
      if (hasKB) {
        kbStatusEl.textContent = '已安装';
        kbStatusEl.className = 'val';
        kbStatusEl.style.color = 'var(--success-color, #16a34a)';
      } else {
        kbStatusEl.textContent = '未安装';
        kbStatusEl.className = 'muted';
        kbStatusEl.style.color = '';
      }
    }
    if (whisperStatusEl) {
      if (hasRecorder) {
        whisperStatusEl.textContent = '已安装';
        whisperStatusEl.className = 'val';
        whisperStatusEl.style.color = 'var(--success-color, #16a34a)';
      } else {
        whisperStatusEl.textContent = '未安装';
        whisperStatusEl.className = 'muted';
        whisperStatusEl.style.color = '';
      }
    }

    // 自适应内存管理：按模块安装状态显示对应行
    // Patch3: 文库引擎常驻选项已移除（KB 模型始终常驻），只保留纪要引擎
    var recorderRow = document.getElementById('recorderResidentRow');
    var memoryEmpty = document.getElementById('memoryManageEmpty');
    if (recorderRow) recorderRow.style.display = hasRecorder ? '' : 'none';
    if (memoryEmpty) memoryEmpty.style.display = (!hasRecorder) ? '' : 'none';
  } catch(e) {
    silentLog('[settings.updateTabVisibility]', e);
    // 请求失败时不要卡在"检测中..."
    var kbStatusEl = document.getElementById('settingsKBStatus');
    var whisperStatusEl = document.getElementById('settingsWhisperStatus');
    if (kbStatusEl && kbStatusEl.textContent.indexOf('检测中') >= 0) {
      kbStatusEl.textContent = '查询失败';
      kbStatusEl.className = 'muted';
    }
    if (whisperStatusEl && whisperStatusEl.textContent.indexOf('检测中') >= 0) {
      whisperStatusEl.textContent = '查询失败';
      whisperStatusEl.className = 'muted';
    }
  }
}

// ===== 模型加载（已替换为 handleWarmup 预热机制）=====

// ===== Patch2 A3: 云端 AI 模式 =====
async function initModeTag() {
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/mode');
    var data = await resp.json();
    // 缓存云端模型名称（供 refreshStatus 使用，不依赖 DOM input）
    if (data.cloud_model) window._cloudModelName = data.cloud_model;
    updateModeTagUI(data.mode, data.cloud_configured, data.context_window, data.max_history_chars);
  } catch(e) { console.error('[initModeTag]', e); }
}

function updateModeTagUI(mode, cloudConfigured, ctxWindow, maxHistChars) {
  var tag = document.getElementById('modeTag');
  var sub = document.getElementById('modeSubTag');
  if (!tag) return;
  var ctxWin = ctxWindow || 16384;
  // 保留 dropdown DOM 不被 innerHTML 覆盖
  var dd = document.getElementById('modeDropdown');
  if (mode === 'local') {
    tag.className = 'tag-mode tag-local';
    // 检查模型预热状态（_loadedModelId 由 refreshStatus 设置）
    var hasLoaded = (typeof _loadedModelId !== 'undefined' && _loadedModelId);
    if (hasLoaded) {
      tag.innerHTML = '<svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3.5" fill="#4caf50"/></svg> 正在使用本地AI模型 ▾';
      sub.textContent = '数据不上网 模型跑本地';
    } else {
      tag.innerHTML = '<svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3.5" fill="#f59e0b"/></svg> 本地AI模型已就绪，预热后使用 ▾';
      sub.textContent = '前往设置页面预热模型';
    }
  } else {
    tag.className = 'tag-mode tag-cloud';
    tag.innerHTML = '<svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3.5" fill="#f44336"/></svg> 正在使用云端AI模型 ▾';
    sub.textContent = '核心数据本地存储';
  }
  // 把 dropdown 放回 tag 内部（innerHTML 清掉了它）
  if (dd && !tag.contains(dd)) {
    dd.style.display = 'none';
    tag.appendChild(dd);
  }
  // 重新绑定点击事件（innerHTML 会清掉 inline onclick）
  tag.onclick = function(e) {
    // 不处理 dropdown 内部的点击
    if (e.target.closest && e.target.closest('.mode-dropdown')) return;
    toggleModeDropdown();
  };
  window._currentMode = mode;
  window._cloudConfigured = cloudConfigured;
  window._contextWindow = ctxWin;
  // 更新圆环
  fetchContextUsage();
  // Patch3: 同步 KB 对比开关可见性
  if (typeof initKbCompareToggle === 'function') initKbCompareToggle();
}

function toggleModeDropdown() {
  var dd = document.getElementById('modeDropdown');
  if (!dd) return;
  var show = dd.style.display === 'none' || !dd.style.display;
  dd.style.display = show ? 'block' : 'none';
  if (show) {
    setTimeout(function() { document.addEventListener('click', function h(e) {
      if (!e.target.closest('.mode-dropdown') && !e.target.closest('.tag-mode')) {
        dd.style.display = 'none';
        document.removeEventListener('click', h);
      }
    }); }, 10);
  }
}

function selectMode(mode) {
  document.getElementById('modeDropdown').style.display = 'none';
  var isCloud = mode === 'cloud';
  var title = document.getElementById('modeConfirmTitle');
  var warning = document.getElementById('modeConfirmWarning');
  var meta = document.getElementById('modeConfirmMeta');
  var btn = document.getElementById('modeConfirmBtn');

  if (isCloud) {
    // 前置检查：如果云端未配置 API key，直接提示去设置
    if (typeof _cloudConfigured !== 'undefined' && !_cloudConfigured) {
      if (typeof showDialog === 'function') {
        showDialog('云端 AI 未配置', '请先在「设置 → 云端 AI 模型配置」中填写 API Key 和模型名称，然后再切换到云端模式。', {
          type: 'warning',
          confirm: true,
          confirmLabel: '前往设置',
          cancelLabel: '取消'
        }).then(function(confirmed) {
          if (confirmed) {
            switchTab('settings', document.querySelector('.tabs-nav button:last-child'));
            // 滚动到云端配置区
            setTimeout(function() {
              var el = document.getElementById('cloudConfigSection');
              if (el) el.scrollIntoView({behavior: 'smooth', block: 'center'});
            }, 300);
          }
        });
      }
      return;
    }
    title.textContent = '切换到云端 AI 模式';
    warning.innerHTML = '云端模式下对话内容将通过互联网发送至第三方 AI 服务。<br>引用的文库文档内容将随对话一起发送。<br>你可以在「设置 → 云端 AI 模型配置」中调整数据发送策略。';
    meta.innerHTML = '模型：<strong id="modeConfirmModel">加载中...</strong><br>数据发送：<strong id="modeConfirmPolicy">—</strong>';
    btn.className = 'btn-confirm danger';
    btn.textContent = '确认切换';
    // 异步获取云端配置信息
    fetch((typeof API !== 'undefined' ? API : '') + '/api/cloud/config').then(function(r) { return r.json(); }).then(function(d) {
      var m = document.getElementById('modeConfirmModel'); if (m) m.textContent = d.model || '—';
      var p = document.getElementById('modeConfirmPolicy'); if (p) {
        var policyMap = {full: '完整发送（默认）', current_only: '仅发送当前消息', slim_history: '精简历史 (' + (d.slim_history_rounds || 6) + '轮)'};
        p.textContent = policyMap[d.context_policy] || d.context_policy || '—';
      }
    }).catch(function() {});
  } else {
    title.textContent = '切换到本地 AI 模型';
    warning.textContent = '本地模式下所有数据均在本地处理，不会发送到互联网。';
    meta.innerHTML = '';
    btn.className = 'btn-confirm';
    btn.textContent = '确认切换';
  }
  window._pendingMode = mode;
  document.getElementById('modeConfirmModal').style.display = 'flex';
  // 键盘快捷键：Enter 确认，Escape 取消
  document.addEventListener('keydown', _modeSwitchKeyHandler);
}

function _modeSwitchKeyHandler(e) {
  if (document.getElementById('modeConfirmModal').style.display === 'none') return;
  if (e.key === 'Enter') { e.preventDefault(); document.removeEventListener('keydown', _modeSwitchKeyHandler); confirmModeSwitch(); }
  else if (e.key === 'Escape') { e.preventDefault(); document.removeEventListener('keydown', _modeSwitchKeyHandler); cancelModeSwitch(); }
}

function cancelModeSwitch() {
  document.getElementById('modeConfirmModal').style.display = 'none';
  document.removeEventListener('keydown', _modeSwitchKeyHandler);
  window._pendingMode = null;
}

async function confirmModeSwitch() {
  var mode = window._pendingMode;
  if (!mode) return;
  document.getElementById('modeConfirmModal').style.display = 'none';
  document.removeEventListener('keydown', _modeSwitchKeyHandler);
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/mode/switch', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({mode: mode})
    });
    var data = await resp.json();
    if (data.ok) {
      updateModeTagUI(data.mode, true, data.context_window, data.max_history_chars);
      showToast(mode === 'cloud' ? '已切换到云端 AI 模式' : '已切换到本地 AI 模式', 'success');
      // 刷新全局状态：模型标签、overlay、sourceTag、文库/纪要遮罩、上下文圆环
      refreshStatus();
      // Patch3: 刷新 KB 对比开关可见性
      if (typeof initKbCompareToggle === 'function') initKbCompareToggle();
    } else {
      showToast(data.error || '切换失败', 'error');
      if (data.error && data.error.indexOf('未配置') >= 0) {
        setTimeout(function() { switchTab('settings', document.querySelector('.tabs-nav button:last-child')); }, 1000);
      }
    }
  } catch(e) { showToast('切换失败', 'error'); }
}

// ===== Patch2 A3: 云端配置 =====
var _cloudConfigLoaded = false;

async function loadCloudConfig() {
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/cloud/config');
    var data = await resp.json();
    var urlEl = document.getElementById('cloudBaseUrl');
    var modelEl = document.getElementById('cloudModel');
    var keyEl = document.getElementById('cloudApiKey');
    // 只有 API 返回了有效值才填充，否则保留 placeholder 提示
    if (urlEl) urlEl.value = data.base_url || '';
    if (modelEl) modelEl.value = data.model || '';
    // 模型能力：从后端字典自动获取，不再手动配置
    var capsEl = document.getElementById('cloudCapsDisplay');
    if (capsEl && data.model) {
      var ctxW = data.context_window || 0;
      var maxOut = data.max_output_tokens || 0;
      if (ctxW > 0) {
        capsEl.innerHTML = '输入 <strong style="color:var(--text-primary)">' + ctxW.toLocaleString() + '</strong> · 输出 <strong style="color:var(--text-primary)">' + maxOut.toLocaleString() + '</strong> tokens';
        capsEl.style.color = 'var(--text-secondary)';
      } else {
        capsEl.textContent = '保存后自动识别';
      }
    }
    // API Key 已保存时显示脱敏占位
    if (keyEl) {
      if (data.api_key_set && data.api_key_preview) {
        keyEl.value = data.api_key_preview;
        keyEl.setAttribute('data-has-key', 'true');
      } else {
        // Patch4 v3.1 BUG#20：不清空 input（保留 placeholder），只标记 has-key=false
        // 否则用户切到设置 tab 但没填新 key 就保存，会误发空 key 覆盖已有配置
        keyEl.value = '';
        keyEl.removeAttribute('data-has-key');
      }
    }
    // context_policy
    if (data.context_policy) {
      var radio = document.querySelector('input[name="contextPolicy"][value="' + data.context_policy + '"]');
      if (radio) radio.checked = true;
    }
    if (data.slim_history_rounds) {
      var sl = document.getElementById('slimHistoryRounds');
      if (sl) sl.value = data.slim_history_rounds;
    }
    // kb_permission
    if (data.kb_permission) {
      var kbPerm = document.getElementById('kbPermissionSelect');
      if (kbPerm) kbPerm.value = data.kb_permission;
    }
    // 绑定模型名称变化事件（实时预览能力）
    if (modelEl && !modelEl._capsBound) {
      modelEl._capsBound = true;
      modelEl.addEventListener('blur', _previewCloudCaps);
      modelEl.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); _previewCloudCaps(); }
      });
    }
    _cloudConfigLoaded = true;
  } catch(e) {
    // 首次配置或后端异常时，允许用户直接写入（表单保持空白/placeholder）
    console.warn('[loadCloudConfig] 加载现有配置失败，允许直接保存:', e.message || e);
    _cloudConfigLoaded = true;
  }
}

// 实时预览云端模型能力（从字典查）
var _capsTimer = null;
function _previewCloudCaps() {
  clearTimeout(_capsTimer);
  _capsTimer = setTimeout(async function() {
    var modelEl = document.getElementById('cloudModel');
    var capsEl = document.getElementById('cloudCapsDisplay');
    if (!modelEl || !capsEl) return;
    var model = modelEl.value.trim();
    if (!model) { capsEl.textContent = '请输入模型名称'; return; }
    try {
      var resp = await fetch(_apiBase + '/api/cloud/model-capabilities?model=' + encodeURIComponent(model));
      var data = await resp.json();
      if (data.error) {
        capsEl.innerHTML = '<span style="color:var(--text-muted)">未知模型</span>';
        return;
      }
      capsEl.innerHTML = '输入 <strong style="color:var(--text-primary)">' + (data.context_window || 0).toLocaleString() + '</strong> · 输出 <strong style="color:var(--text-primary)">' + (data.max_output || 0).toLocaleString() + '</strong> tokens';
      capsEl.style.color = 'var(--text-secondary)';
    } catch(e) {
      capsEl.textContent = '查询失败';
    }
  }, 300);
}

function toggleApiKeyVisibility() {
  var el = document.getElementById('cloudApiKey');
  if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
}

async function testCloudConnection() {
  var result = document.getElementById('cloudTestResult');
  if (result) { result.textContent = '测试中…'; result.className = ''; }
  try {
    var ctrl = new AbortController();
    var timer = setTimeout(function() { ctrl.abort(); }, 20000);
    // 用表单当前值测试，不等保存
    var body = {
      base_url: (document.getElementById('cloudBaseUrl') || {}).value || '',
      model: (document.getElementById('cloudModel') || {}).value || '',
    };
    var keyEl = document.getElementById('cloudApiKey');
    if (keyEl && keyEl.value) {
      body.api_key = keyEl.value;
    }
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/cloud/test', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body), signal: ctrl.signal
    });
    clearTimeout(timer);
    var data = await resp.json();
    if (result) {
      result.textContent = data.ok ? '✓ 连接成功 — 延迟 ' + data.latency_ms + 'ms' : '✗ ' + (data.error || '连接失败');
      result.className = data.ok ? 'success' : 'error';
    }
  } catch(e) {
    if (result) {
      result.textContent = e.name === 'AbortError' ? '✗ 连接超时：服务器响应时间过长' : '✗ 连接失败: ' + e.message;
      result.className = 'error';
    }
  }
}

async function saveCloudConfig() {
  // 防止 loadCloudConfig 未完成时保存空值覆盖已有配置
  if (!_cloudConfigLoaded) { showToast('配置加载中，请稍后再试', 'warning'); return; }
  var policy = document.querySelector('input[name="contextPolicy"]:checked');
  var rounds = document.getElementById('slimHistoryRounds');
  var kbPermEl = document.getElementById('kbPermissionSelect');
  var body = {
    base_url: document.getElementById('cloudBaseUrl').value,
    model: document.getElementById('cloudModel').value,
    context_policy: policy ? policy.value : 'full',
    slim_history_rounds: parseInt(rounds ? rounds.value : 6) || 6,
    kb_permission: kbPermEl ? kbPermEl.value : 'full',
  };
  // 上下文窗口已移除（自动从字典获取）
  var keyEl = document.getElementById('cloudApiKey');
  // Patch4 v3.1 BUG#20：只有用户实际输入了新 key（不是空、不是脱敏占位）才发送
  // 不发 api_key 字段时，后端应保留已有 key（saveSettings 必须支持部分更新）
  if (keyEl && keyEl.value) {
    var hasExisting = keyEl.getAttribute('data-has-key') === 'true';
    var val = keyEl.value;
    // 脱敏格式: "sk-***...***abc" — 如果值包含 ***...*** 说明用户没改
    var isMaskedPlaceholder = val.indexOf('***...***') !== -1;
    // 空字符串或纯空白不发
    var isEmpty = !val || !val.trim();
    if (!isEmpty && (!hasExisting || !isMaskedPlaceholder)) {
      body.api_key = val.trim();
    }
  }
  // 如果 keyEl.value 为空但 has-key=true（用户主动清空）→ 不发 api_key
  // 后端保留原 key（避免误清空）
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/cloud/config', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    var data = await resp.json();
    if (data.ok) {
      showToast('云端配置已保存', 'success');
      if (typeof initModeTag === 'function') initModeTag();
      // 刷新上下文指示器
      if (typeof fetchContextUsage === 'function') fetchContextUsage();
      // 刷新模型能力显示
      if (data.context_window) {
        var capsEl = document.getElementById('cloudCapsDisplay');
        if (capsEl) {
          capsEl.innerHTML = '输入 <strong style="color:var(--text-primary)">' + data.context_window.toLocaleString() + '</strong> · 输出 <strong style="color:var(--text-primary)">' + (data.max_output_tokens || 0).toLocaleString() + '</strong> tokens';
          capsEl.style.color = 'var(--text-secondary)';
        }
      }
      // 刷新系统状态卡片
      refreshTokenBudget();
    } else {
      showToast(data.error || '保存失败', 'error');
    }
  } catch(e) { showToast('保存失败', 'error'); }
}

// ===== Patch2 A5: 搜索配置（已移除 — 本机直搜，零配置） =====


// ===== Patch2 C2: 备份与恢复 =====
async function exportBackup() {
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/backup/export', {method: 'POST'});
    if (!resp.ok) {
      var errData = await resp.json().catch(function() { return {}; });
      showToast(errData.error || '导出失败', 'error');
      return;
    }
    var blob = await resp.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'sidemate-backup.zip';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
    showToast('备份已导出', 'success');
  } catch(e) { showToast('导出失败', 'error'); }
}

async function importBackup() {
  var input = document.getElementById('backupFileInput');
  if (!input || !input.files.length) { showToast('请选择备份文件', 'error'); return; }
  var formData = new FormData();
  formData.append('file', input.files[0]);
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/backup/import', {
      method: 'POST', body: formData
    });
    var data = await resp.json();
    if (data.ok) {
      showToast('恢复成功：' + (data.restored ? data.restored.chats : '?') + ' 个对话已恢复', 'success');
      setTimeout(function() { location.reload(); }, 1500);
    } else {
      showToast(data.error || '恢复失败', 'error');
    }
  } catch(e) { showToast('恢复失败', 'error'); }
}

// ===== Patch5 B3: 权限管理 =====

/**
 * 加载工具级权限列表
 */
async function loadPermissionTools() {
  var container = document.getElementById('permissionToolsList');
  if (!container) return;

  try {
    var resp = await fetch(_apiBase + '/api/permissions/tools');
    var data = await resp.json();
    if (!data.tools || data.tools.length === 0) {
      container.innerHTML = '<span style="color:var(--text-muted)">暂无可配置的工具</span>';
      return;
    }

    var html = '';
    for (var i = 0; i < data.tools.length; i++) {
      var tool = data.tools[i];
      var checked = tool.enabled ? 'checked' : '';
      html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:0.5px solid var(--border-color)">';
      html += '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;flex:1">';
      html += '<input type="checkbox" data-tool-id="'+esc(tool.tool_id)+'" '+checked+' onchange="toggleToolPermission(\''+esc(tool.tool_id)+'\', this.checked)" style="width:15px;height:15px">';
      html += '<div>';
      html += '<div style="font-weight:500;color:var(--text-primary)">'+esc(tool.name)+'</div>';
      html += '<div style="font-size:.82em;color:var(--text-muted)">'+esc(tool.description)+'</div>';
      html += '</div>';
      html += '</label>';
      html += '</div>';
    }
    container.innerHTML = html;
  } catch(e) {
    container.innerHTML = '<span style="color:var(--error-color)">加载失败</span>';
  }
}

/**
 * 切换单个工具权限
 */
async function toggleToolPermission(toolId, enabled) {
  try {
    var resp = await fetch(_apiBase + '/api/permissions/tool/' + encodeURIComponent(toolId), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({enabled: enabled})
    });
    var data = await resp.json();
    if (data.ok) {
      showToast('已' + (enabled ? '启用' : '禁用') + '「' + toolId + '」', 'success');
    } else {
      showToast('设置失败: ' + (data.error || '未知错误'), 'error');
      // 回滚 checkbox
      loadPermissionTools();
    }
  } catch(e) {
    showToast('设置失败: ' + e.message, 'error');
    loadPermissionTools();
  }
}

/**
 * 应用权限预设
 */
async function applyPermissionPreset(presetId) {
  try {
    var resp = await fetch(_apiBase + '/api/permissions/preset/apply', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({preset_id: presetId})
    });
    var data = await resp.json();
    if (data.ok) {
      // 高亮选中的预设按钮
      var btns = document.querySelectorAll('.kb-preset-btn');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.remove('kb-preset-active');
        if (btns[i].getAttribute('data-preset') === presetId) {
          btns[i].classList.add('kb-preset-active');
        }
      }
      var presetNames = {trusted: '完全信任', cautious: '谨慎模式', offline: '纯离线'};
      showToast('已应用「' + (presetNames[presetId] || presetId) + '」预设', 'success');
      // 刷新工具列表（权限可能变了）
      loadPermissionTools();
    } else {
      showToast('应用预设失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch(e) {
    showToast('应用预设失败: ' + e.message, 'error');
  }
}

// 暴露到全局
window.initModeTag = initModeTag;
window.updateModeTagUI = updateModeTagUI;
window.toggleModeDropdown = toggleModeDropdown;
window.selectMode = selectMode;
window.cancelModeSwitch = cancelModeSwitch;
window.confirmModeSwitch = confirmModeSwitch;
window.loadCloudConfig = loadCloudConfig;
window.toggleApiKeyVisibility = toggleApiKeyVisibility;
window.testCloudConnection = testCloudConnection;
window.saveCloudConfig = saveCloudConfig;
// Patch5 B3: 权限管理
window.loadPermissionTools = loadPermissionTools;
window.applyPermissionPreset = applyPermissionPreset;
window.toggleToolPermission = toggleToolPermission;
// search config functions removed (zero-config)

window.exportBackup = exportBackup;
window.refreshResourcePanel = refreshResourcePanel;
window.refreshStatus = refreshStatus;
window.updateWarmupBtn = updateWarmupBtn;
window.handleWarmup = handleWarmup;
window.rescanModels = rescanModels;
window.handleUnload = handleUnload;
window.handleDeleteModel = handleDeleteModel;
window.saveRecorderResident = saveRecorderResident;
window.loadRecorderResident = loadRecorderResident;
window.refreshExtensions = refreshExtensions;
window.installExtension = installExtension;
window.uninstallExtension = uninstallExtension;
window.onExtFilePicked = onExtFilePicked;
window.updateTabVisibility = updateTabVisibility;

// ===== Action 管理 =====
async function refreshCapabilities() {
  var el = document.getElementById('capabilityList');
  if (!el) return;
  el.innerHTML = '<span style="color:var(--text-muted)">加载中...</span>';
  try {
    var resp = await fetch(_apiBase + '/api/action/list');
    if (!resp.ok) {
      el.innerHTML = '<span style="color:var(--text-muted)">Action 服务未就绪</span>';
      return;
    }
    var data = await resp.json();
    var actions = data.actions || [];
    if (actions.length > 0) {
      el.innerHTML = actions.map(function(a) {
        var id = a.id || '';
        var label = a.label || '';
        var title = a.title || id;
        var isBuiltin = a.builtin === true;
        // 优先使用后端 tag 字段（如"文库扩展"），否则按 builtin/扩展 分类
        var customTag = a.tag || '';
        var tag = customTag
          ? '<span style="font-size:.72em;padding:1px 6px;background:var(--bg-secondary);color:var(--success-color);border-radius:3px">' + esc(customTag) + '</span>'
          : (isBuiltin
            ? '<span style="font-size:.72em;padding:1px 6px;background:var(--bg-secondary);color:var(--accent-color);border-radius:3px;font-weight:600">内置</span>'
            : '<span style="font-size:.72em;padding:1px 6px;background:var(--bg-secondary);color:var(--success-color);border-radius:3px">扩展</span>');
        var actionBtn = isBuiltin ? '' :
          '<button style="margin-left:auto;font-size:.75em;padding:2px 8px;border:1px solid var(--error-color);color:var(--error-color);border-radius:4px;cursor:pointer;background:transparent" onclick="uninstallAction(\'' + esc(id) + '\')">卸载</button>';
        return '<div style="padding:8px 0;border-bottom:0.5px solid var(--border-color);display:flex;align-items:center;gap:8px">' +
          '<span style="font-size:14px;display:inline-flex;align-items:center;gap:4px">' + (a.icon_svg || '') + ' ' + esc(label) + '</span>' +
          '<div style="flex:1;min-width:0"><strong style="font-size:13px">' + esc(title) + '</strong> ' + tag +
          '</div>' + actionBtn + '</div>';
      }).join('');
    } else {
      el.innerHTML = '<span style="color:var(--text-muted)">暂无已注册 Action</span>';
    }
  } catch(e) {
    el.innerHTML = '<span style="color:var(--error-color)">加载失败: ' + esc(e.message || '未知错误') + '</span>';
  }
}

async function uninstallAction(actionId) {
  if (!(await showDialog('卸载Action', '确定要卸载 Action "' + actionId + '" 吗？', {type: 'danger', confirm: true, confirmLabel: '卸载', cancelLabel: '取消'}))) return;
  try {
    var resp = await fetch(_apiBase + '/api/action/' + encodeURIComponent(actionId), { method: 'DELETE' });
    var data = await resp.json();
    if (data.success) {
      if (typeof showToast === 'function') showToast('已卸载: ' + actionId, 'success');
      refreshCapabilities();
    } else {
      if (typeof showToast === 'function') showToast(data.error || '卸载失败', 'error');
    }
  } catch(e) {
    if (typeof showToast === 'function') showToast('卸载失败: ' + e.message, 'error');
  }
}

// ===== 缓存管理 =====
var _cacheAllFiles = [];
var _cachePage = 0;
var CACHE_PAGE_SIZE = 5;

function _fmtCacheSize(bytes) {
  return bytes > 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : bytes > 1024 ? (bytes / 1024).toFixed(0) + ' KB' : bytes + ' B';
}

async function refreshCacheFiles() {
  try {
    var resp = await fetch(_apiBase + '/api/cache/files?category=all');
    var data = await resp.json();
    _cacheAllFiles = data.files || [];
    _cachePage = 0;
    renderCachePage();
  } catch(e) {
    var el = document.getElementById('cacheFileList');
    if (el) el.innerHTML = '<span style="color:var(--error-color)">加载失败</span>';
  }
}

function renderCachePage() {
  var el = document.getElementById('cacheFileList');
  var summary = document.getElementById('cacheSummary');
  var pagination = document.getElementById('cachePagination');
  var totalSize = 0;
  _cacheAllFiles.forEach(function(f) { totalSize += f.size; });
  var sizeStr = _fmtCacheSize(totalSize);
  
  if (summary) {
    summary.style.display = '';
    summary.textContent = '共 ' + _cacheAllFiles.length + ' 个文件，总大小 ' + sizeStr;
  }

  var totalPages = Math.max(1, Math.ceil(_cacheAllFiles.length / CACHE_PAGE_SIZE));
  if (_cachePage >= totalPages) _cachePage = 0;
  var start = _cachePage * CACHE_PAGE_SIZE;
  var pageFiles = _cacheAllFiles.slice(start, start + CACHE_PAGE_SIZE);

  if (_cacheAllFiles.length === 0) {
    el.innerHTML = '<span style="color:var(--text-muted)">暂无缓存文件</span>';
    if (pagination) pagination.style.display = 'none';
    document.getElementById('cacheSelectAll').checked = false;
    if (summary) summary.style.display = 'none';
    return;
  }

  var catLabels = {uploads: '上传', recordings: '录音'};
  el.innerHTML = pageFiles.map(function(f, i) {
    var fsize = _fmtCacheSize(f.size);
    var date = new Date(f.modified * 1000).toLocaleDateString();
    var catLabel = catLabels[f.category] || f.category;
    return '<div class="deletable-item" style="display:flex;align-items:center;gap:6px">' +
      '<input type="checkbox" class="cache-check" data-name="' + esc(f.name) + '" data-cat="' + f.category + '" style="accent-color:var(--accent-color);flex-shrink:0">' +
      '<span class="text" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(f.name) + '</span>' +
      '<span style="font-size:.78em;color:var(--text-muted);white-space:nowrap">' + fsize + ' &middot; ' + date + '</span>' +
      '<span style="font-size:.72em;background:var(--bg-tertiary);padding:1px 6px;border-radius:3px;white-space:nowrap;color:var(--text-secondary)">' + catLabel + '</span>' +
      '<button class="del-btn" onclick="deleteCacheFile(\'' + esc(f.name) + '\',\'' + f.category + '\')" style="font-size:.75em;padding:2px 6px;border:1px solid var(--error-color);color:var(--error-color);border-radius:3px;cursor:pointer;background:transparent;white-space:nowrap">删除</button></div>';
  }).join('');

  document.getElementById('cacheSelectAll').checked = false;

  if (pagination) {
    if (totalPages > 1) {
      pagination.style.display = 'flex';
      var prevDisabled = _cachePage === 0 ? ' disabled' : '';
      var nextDisabled = _cachePage >= totalPages - 1 ? ' disabled' : '';
      pagination.innerHTML =
        '<button class="settings-btn" onclick="goCachePage(' + Math.max(0, _cachePage - 1) + ')" style="font-size:11px;padding:2px 8px"' + prevDisabled + '>上一页</button>' +
        '<span style="margin:0 8px">第 ' + (_cachePage + 1) + ' / ' + totalPages + ' 页</span>' +
        '<button class="settings-btn" onclick="goCachePage(' + (_cachePage + 1) + ')" style="font-size:11px;padding:2px 8px"' + nextDisabled + '>下一页</button>';
    } else {
      pagination.style.display = 'none';
    }
  }
}

function goCachePage(page) {
  _cachePage = page;
  renderCachePage();
}

function toggleCacheSelectAll() {
  var checked = document.getElementById('cacheSelectAll').checked;
  document.querySelectorAll('#cacheFileList .cache-check').forEach(function(cb) {
    cb.checked = checked;
  });
}

async function deleteCacheFile(filename, category) {
  try {
    await fetch(_apiBase + '/api/cache/files/' + encodeURIComponent(filename) + '?category=' + (category || 'uploads'), {method: 'DELETE'});
    refreshCacheFiles();
  } catch(e) { showToast('删除失败: ' + e.message, 'error'); }
}

async function batchDeleteCache() {
  var checks = document.querySelectorAll('#cacheFileList .cache-check:checked');
  if (checks.length === 0) { showToast('请至少选择一个文件', 'warning'); return; }
  if (!(await showDialog('批量删除', '确认删除选中的 ' + checks.length + ' 个文件？此操作不可恢复。', {type: 'danger', confirm: true, confirmLabel: '删除', cancelLabel: '取消'}))) return;
  for (var i = 0; i < checks.length; i++) {
    var cb = checks[i];
    try {
      await fetch(_apiBase + '/api/cache/files/' + encodeURIComponent(cb.dataset.name) + '?category=' + (cb.dataset.cat || 'uploads'), {method: 'DELETE'});
    } catch(e) {}
  }
  refreshCacheFiles();
  showToast('已删除 ' + checks.length + ' 个文件', 'success');
}

async function clearAllCache() {
  if (!(await showDialog('清空全部缓存', '确认清空所有缓存文件？此操作不可恢复。', {type: 'danger', confirm: true, confirmLabel: '清空', cancelLabel: '取消'}))) return;
  try {
    await fetch(_apiBase + '/api/cache/files?category=all', {method: 'DELETE'});
    refreshCacheFiles();
    showToast('已清空', 'success');
  } catch(e) { showToast('清空失败: ' + e.message, 'error'); }
}

// 暴露新函数到全局
window.refreshCapabilities = refreshCapabilities;
window.uninstallAction = uninstallAction;
window.refreshCacheFiles = refreshCacheFiles;
window.deleteCacheFile = deleteCacheFile;
window.clearAllCache = clearAllCache;
window.batchDeleteCache = batchDeleteCache;
window.toggleCacheSelectAll = toggleCacheSelectAll;
window.goCachePage = goCachePage;

// ===== 关于对话框信息加载 =====
async function refreshAboutInfo() {
  try {
    var resp = await fetch(_apiBase + '/api/system/info');
    var data = await resp.json();

    // 更新版本号
    var verEl = document.getElementById('versionDisplay');
    if (verEl) {
      verEl.textContent = data.version ? ('v' + data.version) : 'v0.9.4';
    }

    // 更新运行环境信息（设置页关于区域）
    var envEl = document.getElementById('systemEnvInfo');
    if (envEl) {
      var modeLabel = data.mode === 'cloud' ? '云端 AI' : '本地 AI';
      var ollamaLabel = data.ollama_status === 'running' ? '运行中' : '未运行';
      envEl.innerHTML =
        '<div>版本：<strong>v' + (data.version || '0.9.4') + '</strong>（构建日期 ' + (data.build_date || '-') + '）</div>' +
        '<div>Python：' + (data.python || '-') + '</div>' +
        '<div>Ollama：' + ollamaLabel + '（版本 ' + (data.ollama_version || '-') + '）</div>' +
        '<div>当前模式：' + modeLabel + '</div>' +
        '<div>GPU：' + (data.gpu_info || '无 GPU 信息') + '</div>';
    }
  } catch (e) {
    var envEl = document.getElementById('systemEnvInfo');
    if (envEl) envEl.innerHTML = '<div style="color:var(--text-muted)">环境信息加载失败</div>';
  }
}
window.refreshAboutInfo = refreshAboutInfo;

(function addKeyframes() {
  var style = document.createElement('style');
  style.textContent = '@keyframes indeterminateProgress{0%{margin-left:0;width:30%}50%{margin-left:70%;width:20%}100%{margin-left:0;width:30%}}@keyframes msgSlideIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}@keyframes tabFadeIn{from{opacity:0}to{opacity:1}}';
  document.head.appendChild(style);
})();

// ===== settings.js v2.6 — 设置 Tab：模型管理、资源面板、模式选择器 =====
// 依赖: api.js, errors.js, utils.js, 全局变量 (API, __HTML_VERSION__, _maxPromptTokens)
// 被引用: chat.js (updateChatOverlay), qa.js (kbRouteState)

// 全局：当前已加载的原始 model_id（用于按钮状态判断）
var _loadedModelId = null;

// API 基础路径（提取为模块变量，避免到处写 typeof 检测）
var _apiBase = (typeof API !== 'undefined' ? API : '');

// 版本校验（帮助排查缓存问题）
console.log('[settings.js] loaded v2.6, __HTML_VERSION__=' + (typeof __HTML_VERSION__ !== 'undefined' ? __HTML_VERSION__ : 'unknown'));

// ===== P6: 模式选择器 =====
var _placeholders = {
  local: '随便聊聊，AI 陪你聊天...',
  local_doc: '描述文档主题，AI 离线撰写...',
  local_kb: '基于知识库提问，完全本地回答...',
  cloud: '让云端 AI 帮你搜索、阅读、推理...',
  cloud_doc: '输入文档需求，AI 搜索资料并生成...',
  parallel: '本地+云端协作回答，核心数据不出机器...'
};

/**
 * P6: 初始化三段模式按钮选择器
 * 绑定 header 中 #chatMode 的三个按钮点击事件
 */
function initModeSelector() {
  var container = document.getElementById('chatMode');
  if (!container) return;

  // 绑定三段按钮点击
  var buttons = container.querySelectorAll('button[data-mode]');
  buttons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      var mode = btn.getAttribute('data-mode');
      selectMode(mode);
    });
  });

  // 从后端获取当前模式并设置初始状态
  fetch((typeof API !== 'undefined' ? API : '') + '/api/mode')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.cloud_model) window._cloudModelName = data.cloud_model;
      // 映射后端 mode 到前端 mode
      var frontMode = data.mode === 'local' ? 'offline' : (data.mode === 'cloud' ? 'online' : data.mode);
      window._currentMode = data.mode; // 保持后端值
      window._cloudConfigured = data.cloud_configured;
      window._contextWindow = data.context_window || 8192;
      // 更新按钮状态
      _updateModeButtons(frontMode);
      // 更新 placeholder
      _updatePlaceholder(frontMode);
      // 同步全局 token 上限
      if (typeof _maxPromptTokens !== 'undefined' && data.context_window) {
        _maxPromptTokens = data.context_window;
        if (typeof TokenEstimator !== 'undefined' && TokenEstimator.updateInputDisplay) {
          TokenEstimator.updateInputDisplay();
        }
      }
      // 更新上下文使用量
      if (typeof fetchContextUsage === 'function') fetchContextUsage();
      // 同步 KB 对比开关可见性
      if (typeof initKbCompareToggle === 'function') initKbCompareToggle();
    })
    .catch(function(e) { console.error('[initModeSelector]', e); });
}

/**
 * P6: 切换模式（三段按钮点击处理）
 * 1. 更新按钮高亮
 * 2. 更新输入框 placeholder
 * 3. 调用后端 /api/mode/switch
 * P6 审计修复：每次切换都弹确认，用户可选「下次不再提示」永久跳过
 */
function selectMode(mode) {
  // 检查"下次不再提示"标志（用户主动选择后才设置）
  var confirmKey = 'sidemate_mode_confirm_skip_' + mode;
  var skipConfirm = localStorage.getItem(confirmKey) === '1';

  var _doSwitch = function() {
    _executeModeSwitch(mode);
  };

  if (!skipConfirm && typeof showModeConfirmModal === 'function') {
    showModeConfirmModal(mode, function(confirmed, dontShowAgain) {
      if (confirmed) {
        if (dontShowAgain) {
          localStorage.setItem(confirmKey, '1');
        }
        _doSwitch();
      }
    });
  } else {
    _doSwitch();
  }
}

/**
 * P6 T04: 实际执行模式切换（确认后调用）
 */
function _executeModeSwitch(mode) {
  // P6 打磨 #1：模式切换前置条件检查
  if (mode === 'parallel') {
    // 并行模式：离线 LLM + 云端 API 缺一不可
    var _modelTag = document.getElementById('modelTag');
    var _noModel = _modelTag && _modelTag.classList.contains('none');
    var _noCloud = !(typeof _cloudConfigured !== 'undefined' && _cloudConfigured);
    if (_noModel && _noCloud) {
      showToast('并行模式需要加载本地 LLM 和配置云端 API，请先前往设置页完成配置', 'warning', 6000);
      return;
    } else if (_noModel) {
      showToast('并行模式需要本地 LLM，请先在设置页加载模型', 'warning');
      return;
    } else if (_noCloud) {
      showToast('并行模式需要云端 API，请先在设置页配置 API 密钥', 'warning');
      return;
    }
  } else if (mode === 'offline') {
    var _tag2 = document.getElementById('modelTag');
    if (_tag2 && _tag2.classList.contains('none')) {
      showToast('离线模式需要本地 LLM，请先在设置页加载模型', 'warning');
      return;
    }
  } else if (mode === 'online') {
    if (!(typeof _cloudConfigured !== 'undefined' && _cloudConfigured)) {
      showToast('在线模式需要云端 API，请先在设置页配置 API 密钥', 'warning');
      return;
    }
  }

  // 1. 更新按钮高亮
  _updateModeButtons(mode);

  // 2. 更新 placeholder
  _updatePlaceholder(mode);

  // P6: 显示骨架屏（actionBar + 模型tag 区域灰色块呼吸）
  var _skeletonBars = [];
  var _barEl = document.getElementById('actionBar');
  var _tagEl = document.getElementById('modelTag');
  if (_barEl) {
    _barEl.style.opacity = '0.3';
    _barEl.innerHTML = '<span class="skel-chip"></span><span class="skel-chip"></span><span class="skel-chip"></span>';
  }
  if (_tagEl) {
    _tagEl.textContent = '';
    _tagEl.classList.add('skel-tag');
  }

  // 3. 调用后端 API（映射前端 mode 到后端值）
  var backendMode = mode === 'offline' ? 'local' : (mode === 'online' ? 'cloud' : mode);
  fetch((typeof API !== 'undefined' ? API : '') + '/api/mode/switch', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({mode: backendMode})
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        window._currentMode = data.mode;
        if (typeof showToast === 'function') {
          var labels = { offline: '离线', online: '在线', parallel: '并行' };
          showToast('已切换到' + (labels[mode] || mode) + '模式', 'success');
        }
        // P6 打磨：模式切换后刷新上下文窗口（cloud 模式远大于 local 的 8K）
        fetch((typeof API !== 'undefined' ? API : '') + '/api/mode')
          .then(function(r) { return r.json(); })
          .then(function(md) {
            if (md.context_window && typeof _maxPromptTokens !== 'undefined') {
              _maxPromptTokens = md.context_window;
              if (typeof TokenEstimator !== 'undefined' && TokenEstimator.updateInputDisplay) {
                TokenEstimator.updateInputDisplay();
              }
            }
          });
        if (typeof refreshStatus === 'function') refreshStatus();
        if (typeof refreshActionBar === 'function') refreshActionBar();
        // P6: 移除骨架屏
        if (_barEl) _barEl.style.opacity = '';
        if (_tagEl) _tagEl.classList.remove('skel-tag');
        if (typeof initKbCompareToggle === 'function') initKbCompareToggle();
        if (typeof fetchContextUsage === 'function') fetchContextUsage();
        if (typeof updateChatOverlay === 'function') updateChatOverlay();
      } else {
        if (typeof showToast === 'function') showToast(data.error || '切换失败', 'error');
      }
    })
    .catch(function(e) {
      if (typeof showToast === 'function') showToast('切换失败: ' + e.message, 'error');
    });
}

/**
 * 更新三段按钮的 sel 状态
 */
function _updateModeButtons(mode) {
  var container = document.getElementById('chatMode');
  if (!container) return;
  container.querySelectorAll('button[data-mode]').forEach(function(btn) {
    btn.classList.toggle('sel', btn.getAttribute('data-mode') === mode);
  });
}

/**
 * 根据模式和当前 action 更新输入框 placeholder
 */
function _updatePlaceholder(mode) {
  var input = document.getElementById('msgInput');
  if (!input) return;
  var action = (typeof currentActionMode !== 'undefined') ? currentActionMode : 'chat';
  var key = mode;
  if (mode === 'offline') {
    key = action === 'doc' ? 'local_doc' : (action === 'kb' ? 'local_kb' : 'local');
  } else if (mode === 'online') {
    key = action === 'doc' ? 'cloud_doc' : 'cloud';
  }
  input.placeholder = _placeholders[key] || _placeholders.local;
}

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
      var baseInfo = mod.base || {};
      parts.push('基础 ' + fmtMB(baseInfo.mb || 0));
      var llmInfo = mod.llm || {};
      if (llmInfo.installed) {
        parts.push(llmInfo.loaded ? ('LLM ' + fmtMB(llmInfo.mb)) : 'LLM 未加载');
      }
      var embedderInfo = mod.embedder || {};
      var rerankerInfo = mod.reranker || {};
      if (embedderInfo.installed) {
        var kbTotal = (embedderInfo.mb || 0) + (rerankerInfo.mb || 0);
        var kbLoaded = embedderInfo.loaded || rerankerInfo.loaded;
        parts.push(kbLoaded ? ('知识库 ' + fmtMB(kbTotal)) : '知识库 未加载');
      }
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

    if (typeof _maxPromptTokens !== 'undefined') {
      // 本地模式用 Ollama 模型返回的 max_prompt_tokens；
      // 在线模式由 /api/mode 的 context_window 控制，不在这里覆盖
      if (!window._currentMode || window._currentMode === 'local') {
        _maxPromptTokens = (data.profile && data.profile.max_prompt_tokens) || 0;
      }
    }
    var tag = document.getElementById('modelTag');
    var stag = document.getElementById('settingsModelTag');
    var device = data.device || '';

    var hasModels = data.available && data.available.length > 0;
    var hasLoaded = !!(data.current);
    console.log('[ModelManager] API response:', JSON.stringify({available: data.available, loaded: data.loaded, current: data.current}));
    var modelInfoRow = document.getElementById('modelInfoRow');
    var noModelHint = document.getElementById('noModelHint');

    if (hasModels) {
      if (modelInfoRow) modelInfoRow.style.display = 'flex';
      if (noModelHint) noModelHint.style.display = 'none';

      var firstModel = data.available[0];
      var displayName = (data.available_display && data.available_display[0]) || firstModel;
      var nameEl = document.getElementById('modelNameDisplay');
      if (nameEl) nameEl.textContent = displayName;

      var quantEl = document.getElementById('modelQuantTag');
      if (quantEl && hasLoaded && data.profile) {
        var sizeLabel = data.profile.model_size ? data.profile.model_size + 'B' : '';
        quantEl.textContent = sizeLabel ? sizeLabel + ' · Ollama' : 'Ollama';
      } else if (quantEl) {
        quantEl.textContent = 'Ollama';
      }
    } else {
      if (modelInfoRow) modelInfoRow.style.display = 'flex';
      if (noModelHint) noModelHint.style.display = '';
      var nameEl2 = document.getElementById('modelNameDisplay');
      if (nameEl2) nameEl2.textContent = '未安装模型';
      var tagEl2 = document.getElementById('modelQuantTag');
      if (tagEl2) tagEl2.textContent = '';
    }

    var currentDisplay = data.current_display || data.current;
    _loadedModelId = data.current || null;
    if (typeof _currentMode !== 'undefined' && _currentMode === 'parallel') {
      // P6 打磨 #4：并行模式同时展示双模型
      var _local = currentDisplay || '离线 AI';
      var _cloud = window._cloudModelName || '云端 AI';
      tag.className = 'model-tag model-tag-inline';
      tag.textContent = '离线 ' + _local + ' · 云端 ' + _cloud;
      stag.innerHTML = '<span class="model-tag">离线 ' + esc(_local) + ' · 云端 ' + esc(_cloud) + '</span>';
    } else if (typeof _currentMode !== 'undefined' && _currentMode === 'cloud') {
      currentDisplay = window._cloudModelName || '云端模型';
      tag.className = 'model-tag model-tag-inline';
      tag.textContent = '在线 AI · ' + currentDisplay;
      stag.innerHTML = '<span class="model-tag">在线 AI · ' + esc(currentDisplay) + '</span>';
    } else if (data.current) {
      tag.className = 'model-tag model-tag-inline';
      tag.textContent = '离线 AI · ' + currentDisplay;
      stag.innerHTML = '<span class="model-tag">离线 AI · ' + esc(currentDisplay) + '</span>';
      localStorage.setItem('_model_ever_loaded', '1');
    } else {
      tag.className = 'model-tag model-tag-inline none';
      tag.textContent = '未加载';
      stag.innerHTML = '<span class="model-tag none">未加载</span>';
    }

    var sourceTag = document.getElementById('sourceTag');
    if (sourceTag) {
      if (data.current) {
        sourceTag.textContent = '正在使用本地AI模型';
        sourceTag.className = 'tag online on';
        sourceTag.style.background = '';
        sourceTag.style.color = '';
      } else if (hasModels) {
        sourceTag.textContent = '模型已就绪，加载后使用';
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

    var privacyTag = document.getElementById('privacyTag');
    if (privacyTag) privacyTag.style.display = data.current ? '' : 'none';

    if (statusTextEl) statusTextEl.style.display = 'none';

    updateWarmupBtn(data);

    if (typeof kbRouteState === 'function') kbRouteState();
    if (typeof updateChatOverlay === 'function') updateChatOverlay();
    refreshResourcePanel();
    if (typeof refreshActionBar === 'function') refreshActionBar();
    refreshTokenBudget(data);
    updateTabVisibility();
    var _msBtn = document.getElementById('msgStyleToggle');
    if (_msBtn && typeof MessageStyleManager !== 'undefined') {
      var _curMode = MessageStyleManager.getMode();
      _msBtn.textContent = (_curMode === 'list') ? '列表' : '气泡';
    }
    // P6: initModeTag 已移除，模式状态由 initModeSelector 管理
  } catch(e) {
    if (statusTextEl) statusTextEl.textContent = '刷新失败: ' + e.message;
  }
}

// ===== 预热按钮状态 =====
function updateWarmupBtn(modelsData) {
  var btn = document.getElementById('modelActionBtn');
  var delBtn = document.getElementById('modelDeleteBtn');
  console.log('[updateWarmupBtn] btn=', btn, 'hasModels=', modelsData.available && modelsData.available.length > 0, 'isLoaded=', !!modelsData.current, 'available=', modelsData.available);
  if (!btn) { console.log('[updateWarmupBtn] modelActionBtn not found'); return; }
  if (!modelsData) return;

  var hasModels = modelsData.available && modelsData.available.length > 0;
  var isLoaded = !!modelsData.current;

  if (delBtn) {
    delBtn.style.display = hasModels ? 'inline-block' : 'none';
    if (hasModels) {
      var modelName = modelsData.available[0] || '';
      delBtn.onclick = function() { handleDeleteModel(modelName); };
    }
  }

  if (!hasModels) {
    btn.textContent = '扫描模型';
    btn.onclick = function() { rescanModels(); };
    btn.style.background = '';
    btn.style.color = '';
    btn.style.borderColor = '';
    btn.disabled = false;
  } else if (isLoaded) {
    btn.textContent = '取消加载';
    btn.onclick = function() { handleUnload(); };
    btn.style.background = 'transparent';
    btn.style.color = 'var(--error-color)';
    btn.style.borderColor = 'var(--error-color)';
    btn.disabled = false;
  } else {
    btn.textContent = '加载模型';
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
  if (btn) { btn.disabled = true; btn.textContent = '加载中...'; btn.style.background = ''; btn.style.color = ''; btn.style.borderColor = ''; }

  try {
    var resp = await fetch(_apiBase + '/api/warmup', {method: 'POST'});
    var data = await resp.json();
    if (!data.ok) {
      if (btn) { btn.disabled = false; btn.textContent = '加载模型'; }
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

    if (typeof showModuleLoading === 'function') showModuleLoading('模型加载中', 'model', '首次加载约需 10-30 秒');
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
    if (btn) { btn.disabled = false; btn.textContent = '加载模型'; }
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
  if (!(await showDialog('取消加载', '确定取消加载当前模型？取消加载后需要重新加载才能使用对话功能。', {type: 'danger', confirm: true, confirmLabel: '确认', cancelLabel: '取消'}))) return;
  var btn = document.getElementById('modelActionBtn');
  if (btn) { btn.disabled = true; btn.textContent = '取消加载中...'; }
  try {
    var resp = await fetch(_apiBase + '/api/model/unload', {method: 'POST'});
    var data = await resp.json();
    if (data.ok) {
      if (typeof showToast === 'function') showToast('已取消加载，资源已释放', 'success');
      refreshStatus();
      refreshResourcePanel();
    } else {
      if (typeof showToast === 'function') showToast('取消加载失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch(e) {
    if (typeof showToast === 'function') showToast('取消加载失败: ' + e.message, 'error');
  }
  if (btn) { btn.disabled = false; btn.textContent = '取消加载'; }
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

// ===== Token 预算展示 =====
async function refreshTokenBudget(modelsData) {
  var el = document.getElementById('settingsTokenBudget');
  if (!el) return;
  try {
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

// ===== 启动时自动加载模型开关（auto_warmup_llm）=====
async function loadAutoWarmupSetting() {
  try {
    var resp = await fetch(_apiBase + '/api/config');
    var result = await resp.json();
    var cfg = result.config || result;
    var chk = document.getElementById('autoWarmupChk');
    if (chk) chk.checked = cfg.auto_warmup_llm !== false;
  } catch(e) { console.error('[settings.loadAutoWarmupSetting]', e); }
}

async function saveAutoWarmup(checked) {
  try {
    await fetch(_apiBase + '/api/config', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({auto_warmup_llm: checked})
    });
    if (typeof showToast === 'function') {
      showToast(checked ? '已开启自动加载' : '已关闭自动加载', 'success');
    }
  } catch(e) {
    console.error('[settings.saveAutoWarmup]', e);
    if (typeof showToast === 'function') showToast('保存失败', 'error');
  }
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
      listEl.innerHTML = '<span style="color:var(--text-muted)">暂无已安装扩展。上传 .sidemate 官方包安装模型、知识库、语音等扩展。</span>';
      return;
    }
    var html = '';
    exts.forEach(function(ext) {
      var typeIcons = {model:'\\u{1F9E0}', knowledge:'\\u{1F4DA}', recorder:'\\u{1F399}', whisper:'\\u{1F399}', action:'\\u{2699}'};
      var displayNames = {knowledge:'知识库扩展', recorder:'纪要扩展'};
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
  if (progressBar) progressBar.style.display = 'block';
  if (progressFill) {
    progressFill.style.width = '30%';
    progressFill.style.animation = 'none';
    void progressFill.offsetWidth;
    progressFill.style.animation = 'indeterminateProgress 1.5s ease-in-out infinite';
  }
  if (progressText) progressText.textContent = '准备上传...';

  if (typeof pauseHeartbeat === 'function') pauseHeartbeat();

  try {
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
          if (typeof refreshStatus === 'function') refreshStatus();
          if (result.type === 'llm' && typeof rescanModels === 'function') {
            rescanModels();
          }
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

    var kbRefItem = document.getElementById('kbRefMenuItem');
    if (kbRefItem) kbRefItem.style.display = hasKB ? '' : 'none';

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

    var recorderRow = document.getElementById('recorderResidentRow');
    var memoryEmpty = document.getElementById('memoryManageEmpty');
    if (recorderRow) recorderRow.style.display = hasRecorder ? '' : 'none';
    if (memoryEmpty) memoryEmpty.style.display = (!hasRecorder) ? '' : 'none';
  } catch(e) {
    silentLog('[settings.updateTabVisibility]', e);
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

// ===== 云端配置 =====
var _cloudConfigLoaded = false;

async function loadCloudConfig() {
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/cloud/config');
    var data = await resp.json();
    var urlEl = document.getElementById('cloudBaseUrl');
    var modelEl = document.getElementById('cloudModel');
    var keyEl = document.getElementById('cloudApiKey');
    if (urlEl) {
      if (data.base_url && data.base_url_set === true) {
        urlEl.value = data.base_url;
      } else {
        urlEl.value = '';
      }
    }
    if (modelEl) {
      if (data.model && data.model_set === true) {
        modelEl.value = data.model;
      } else {
        modelEl.value = '';
      }
    }
    var capsEl = document.getElementById('cloudCapsDisplay');
    if (capsEl) {
      if (data.model_set === true && data.model) {
        var ctxW = data.context_window || 0;
        var maxOut = data.max_output_tokens || 0;
        if (ctxW > 0) {
          capsEl.innerHTML = '输入 <strong style="color:var(--text-primary)">' + ctxW.toLocaleString() + '</strong> · 输出 <strong style="color:var(--text-primary)">' + maxOut.toLocaleString() + '</strong> tokens';
          capsEl.style.color = 'var(--text-secondary)';
        } else {
          capsEl.textContent = '输入模型名称后自动匹配';
        }
      } else {
        capsEl.textContent = '输入模型名称后自动匹配';
        capsEl.style.color = 'var(--text-muted)';
      }
    }
    if (keyEl) {
      if (data.api_key_set && data.api_key_preview) {
        keyEl.value = data.api_key_preview;
        keyEl.setAttribute('data-has-key', 'true');
      } else {
        keyEl.value = '';
        keyEl.removeAttribute('data-has-key');
      }
    }
    if (data.context_policy) {
      var radio = document.querySelector('input[name="contextPolicy"][value="' + data.context_policy + '"]');
      if (radio) radio.checked = true;
    }
    if (data.slim_history_rounds) {
      var sl = document.getElementById('slimHistoryRounds');
      if (sl) sl.value = data.slim_history_rounds;
    }
    if (data.kb_permission) {
      var kbPerm = document.getElementById('kbPermissionSelect');
      if (kbPerm) kbPerm.value = data.kb_permission;
    }
    if (modelEl && !modelEl._capsBound) {
      modelEl._capsBound = true;
      modelEl.addEventListener('blur', _previewCloudCaps);
      modelEl.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); _previewCloudCaps(); }
      });
    }
    _cloudConfigLoaded = true;
  } catch(e) {
    console.warn('[loadCloudConfig] 加载现有配置失败，允许直接保存:', e.message || e);
    _cloudConfigLoaded = true;
  }
}

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
      result.textContent = data.ok ? '连接成功 — 延迟 ' + data.latency_ms + 'ms' : (data.error || '连接失败');
      result.className = data.ok ? 'success' : 'error';
    }
  } catch(e) {
    if (result) {
      result.textContent = e.name === 'AbortError' ? '连接超时：服务器响应时间过长' : '连接失败: ' + e.message;
      result.className = 'error';
    }
  }
}

async function saveCloudConfig() {
  if (!_cloudConfigLoaded) { showToast('配置加载中，请稍后再试', 'warning'); return; }
  var policy = document.querySelector('input[name="contextPolicy"]:checked');
  var rounds = document.getElementById('slimHistoryRounds');
  var kbPermEl = document.getElementById('kbPermissionSelect');
  var body = {};
  var baseUrl = document.getElementById('cloudBaseUrl').value.trim();
  var modelName = document.getElementById('cloudModel').value.trim();
  if (baseUrl) body.base_url = baseUrl;
  if (modelName) body.model = modelName;
  body.context_policy = policy ? policy.value : 'full';
  body.slim_history_rounds = parseInt(rounds ? rounds.value : 6) || 6;
  body.kb_permission = kbPermEl ? kbPermEl.value : 'full';
  var keyEl = document.getElementById('cloudApiKey');
  if (keyEl && keyEl.value) {
    var hasExisting = keyEl.getAttribute('data-has-key') === 'true';
    var val = keyEl.value;
    var isMaskedPlaceholder = val.indexOf('***...***') !== -1;
    var isEmpty = !val || !val.trim();
    if (!isEmpty && (!hasExisting || !isMaskedPlaceholder)) {
      body.api_key = val.trim();
    }
  }
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/cloud/config', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    var data = await resp.json();
    if (data.ok) {
      showToast('云端配置已保存', 'success');
      if (typeof fetchContextUsage === 'function') fetchContextUsage();
      if (data.context_window) {
        var capsEl = document.getElementById('cloudCapsDisplay');
        if (capsEl) {
          capsEl.innerHTML = '输入 <strong style="color:var(--text-primary)">' + data.context_window.toLocaleString() + '</strong> · 输出 <strong style="color:var(--text-primary)">' + (data.max_output_tokens || 0).toLocaleString() + '</strong> tokens';
          capsEl.style.color = 'var(--text-secondary)';
        }
      }
      refreshTokenBudget();
    } else {
      showToast(data.error || '保存失败', 'error');
    }
  } catch(e) { showToast('保存失败', 'error'); }
}

// ===== 备份与恢复 =====
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
      html += '<div class="perm-item">';
      html += '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;flex:1">';
      html += '<input type="checkbox" data-tool-id="'+esc(tool.tool_id)+'" '+checked+' onchange="toggleToolPermission(\''+esc(tool.tool_id)+'\', this.checked)" style="width:15px;height:15px;flex-shrink:0">';
      html += '<div>';
      html += '<div class="perm-name">'+esc(tool.name)+'</div>';
      html += '<div class="perm-desc">'+esc(tool.description)+'</div>';
      html += '</div>';
      html += '</label>';
      html += '</div>';
    }
    container.innerHTML = html;
  } catch(e) {
    container.innerHTML = '<span style="color:var(--error-color)">加载失败</span>';
  }
}

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
      // 知识库检索开关同步 kb_permission（开=full，关=disabled）
      if (toolId === 'kb_search') {
        try {
          await fetch(_apiBase + '/api/cloud/config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({kb_permission: enabled ? 'full' : 'disabled'})
          });
        } catch(e2) {}
      }
    } else {
      showToast('设置失败: ' + (data.error || '未知错误'), 'error');
      loadPermissionTools();
    }
  } catch(e) {
    showToast('设置失败: ' + e.message, 'error');
    loadPermissionTools();
  }
}

async function applyPermissionPreset(presetId) {
  try {
    var resp = await fetch(_apiBase + '/api/permissions/preset/apply', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({preset_id: presetId})
    });
    var data = await resp.json();
    if (data.ok) {
      var btns = document.querySelectorAll('.kb-preset-btn');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.remove('kb-preset-active');
        if (btns[i].getAttribute('data-preset') === presetId) {
          btns[i].classList.add('kb-preset-active');
        }
      }
      var presetNames = {trusted: '完全信任', cautious: '谨慎模式', offline: '纯离线'};
      showToast('已应用「' + (presetNames[presetId] || presetId) + '」预设', 'success');
      loadPermissionTools();
    } else {
      showToast('应用预设失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch(e) {
    showToast('应用预设失败: ' + e.message, 'error');
  }
}

// ===== Action / 缓存 / 关于 =====
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

// ===== 关于对话框信息加载 =====
async function refreshAboutInfo() {
  try {
    var resp = await fetch(_apiBase + '/api/system/info');
    var data = await resp.json();
    var verEl = document.getElementById('versionDisplay');
    if (verEl) {
      verEl.textContent = data.version ? ('v' + data.version) : (window.APP_VERSION ? ('v' + window.APP_VERSION) : '');
    }
    var envEl = document.getElementById('systemEnvInfo');
    if (envEl) {
      envEl.innerHTML =
        '<div>版本：<strong>v' + (data.version || (window.APP_VERSION || '-')) + '</strong>（构建日期 ' + (data.build_date || '-') + '）</div>' +
        '<div>Python：' + (data.python || '-') + '</div>' +
        '<div>Ollama：' + (data.ollama_version || '-') + '</div>';
    }
  } catch (e) {
    var envEl = document.getElementById('systemEnvInfo');
    if (envEl) envEl.innerHTML = '<div style="color:var(--text-muted)">环境信息加载失败</div>';
  }
}

// ===== Patch5 C7 T03: 隐私声明 + 诊断报告 =====
function togglePrivacyDetail() {
  var el = document.getElementById('privacyContent');
  var btn = document.getElementById('privacyDetailBtn');
  if (!el) return;
  if (el.style.display === 'none' || !el.innerHTML) {
    var detail =
      '<div style="line-height:1.8;font-size:12px">' +
      '<div style="font-weight:600;color:var(--text-primary);margin-bottom:6px">完整隐私声明</div>' +
      '<div style="margin-bottom:4px"><b>本地存储</b>：对话记录、上传文档、知识库索引、用户设置均存储在本地磁盘，不上传到任何 Sidemate 服务器（本程序无自有服务器）。</div>' +
      '<div style="margin-bottom:4px"><b>云端 AI 通信</b>：使用在线/并行模式时，对话内容（含历史上下文）会发送到你配置的云端 API 提供商（如 DeepSeek）。通信直接在你和 API 提供商之间进行，不经过第三方中转。请参阅对应 API 提供商的隐私政策。</div>' +
      '<div style="margin-bottom:4px"><b>网页搜索</b>：Agent 启用联网搜索工具时，会向搜索引擎（如 Bing）发送查询关键词，搜索引擎返回结果由 Agent 阅读。</div>' +
      '<div style="margin-bottom:4px"><b>文件读取</b>：Agent 文件读写工具仅限沙盒目录（当前会话工作区），不会访问沙盒外的系统文件。</div>' +
      '<div style="margin-bottom:4px"><b>知识库权限</b>：知识库文档受三级令牌保护（完全访问/仅检索/禁用），私密文档需令牌才能访问。</div>' +
      '<div style="margin-bottom:4px"><b>开源组件</b>：所有第三方组件遵循原始开源许可证。</div>' +
      '<div style="margin-bottom:4px"><b>随时可清除</b>：删除安装目录即可彻底卸载，所有数据随之清除。</div>' +
      '</div>';
    el.innerHTML = detail;
    el.style.display = 'block';
    if (btn) btn.textContent = '收起隐私声明';
  } else {
    el.style.display = 'none';
    if (btn) btn.textContent = '查看完整隐私声明';
  }
}

async function exportDiagnostics() {
  var output = document.getElementById('diagOutput');
  if (output) {
    output.style.display = 'block';
    output.textContent = '正在收集诊断信息...';
  }
  try {
    var _apiBaseDiag = (typeof _apiBase !== 'undefined') ? _apiBase : '';
    var resp = await fetch(_apiBaseDiag + '/api/diagnostics/export');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var text = await resp.text();
    if (output) {
      output.textContent = text;
    }
    var blob = new Blob([text], {type: 'text/plain;charset=utf-8'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    var now = new Date();
    var ts = now.getFullYear() + '' + String(now.getMonth() + 1).padStart(2, '0') + '' + String(now.getDate()).padStart(2, '0') + '_' + String(now.getHours()).padStart(2, '0') + '' + String(now.getMinutes()).padStart(2, '0') + '' + String(now.getSeconds()).padStart(2, '0');
    a.download = 'sidemate_diagnostic_' + ts + '.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if (typeof showToast === 'function') showToast('诊断报告已导出', 'success');
  } catch(e) {
    if (output) {
      output.textContent = '导出失败: ' + e.message;
    }
    if (typeof showToast === 'function') showToast('诊断报告导出失败: ' + e.message, 'error');
  }
}

// ===== P6: 设置页 Tab 切换 =====
function switchSettingsTab(tabId, navEl) {
  // 更新导航选中状态
  var navItems = document.querySelectorAll('#settingsNav .settings-nav-item');
  for (var i = 0; i < navItems.length; i++) {
    navItems[i].classList.remove('sel');
  }
  if (navEl) navEl.classList.add('sel');

  // 切换内容面板
  var stabs = document.querySelectorAll('#settingsContent .settings-stab');
  for (var j = 0; j < stabs.length; j++) {
    stabs[j].style.display = 'none';
  }
  var target = document.getElementById('stab-' + tabId);
  if (target) target.style.display = 'block';

  // Tab 特定初始化
  if (tabId === 'knowledge') {
    // 加载知识库统计
    if (typeof kbRefreshDocs === 'function') kbRefreshDocs();
    if (typeof loadPermissionTools === 'function') loadPermissionTools();
  } else if (tabId === 'about') {
    refreshAboutDiagnostics();
  } else if (tabId === 'privacy') {
    refreshPrivacyInfo();
  } else if (tabId === 'cloud') {
    if (typeof loadCloudConfig === 'function') loadCloudConfig();
  }
}

// ===== P6: 关于 Tab — 运行状态 =====
async function refreshAboutDiagnostics() {
  try {
    var resp = await fetch(_apiBase + '/api/system/info');
    var data = await resp.json();

    var vEl = document.getElementById('versionDisplay');
    if (vEl) vEl.textContent = data.version ? ('v' + data.version) : (window.APP_VERSION ? ('v' + window.APP_VERSION) : '');

    // 环境信息
    var pyEl = document.getElementById('diagPython');
    if (pyEl) pyEl.textContent = data.python || '--';
    var osEl = document.getElementById('diagOs');
    if (osEl) osEl.textContent = data.os_info || '--';
    var gpuEl = document.getElementById('diagGpu');
    if (gpuEl) gpuEl.textContent = data.gpu_info || 'CPU';
    var totalMemEl = document.getElementById('diagTotalMem');
    if (totalMemEl) totalMemEl.textContent = data.total_mem_gb ? (data.total_mem_gb + ' GB') : '--';

    // 拉取资源信息（内存占用 + 组件状态 + 显存）
    var compEl = document.getElementById('diagComponents');
    var usedMemEl = document.getElementById('diagUsedMem');
    var vramEl = document.getElementById('diagVram');
    try {
      var resResp = await fetch(_apiBase + '/api/resource-info');
      var resData = await resResp.json();

      // 组件状态点
      if (compEl && resData.modules) {
        var comps = [
          {name:'本地 LLM', loaded: !!(resData.modules.llm && resData.modules.llm.loaded), detail: resData.modules.llm ? resData.modules.llm.name : ''},
          {name:'向量化引擎', loaded: !!(resData.modules.embedder && resData.modules.embedder.loaded), detail: ''},
          {name:'Reranker', loaded: !!(resData.modules.reranker && resData.modules.reranker.loaded), detail: ''},
        ];
        try {
          var cfgResp = await fetch(_apiBase + '/api/cloud/config');
          var cfgData = await cfgResp.json();
          comps.push({name:'云端 API', loaded: !!(cfgData.base_url && cfgData.model), detail: cfgData.model || ''});
        } catch(e2) {
          comps.push({name:'云端 API', loaded: false, detail: ''});
        }
        var html = '';
        for (var i = 0; i < comps.length; i++) {
          var c = comps[i];
          var dot = c.loaded ? 'comp-dot-ok' : 'comp-dot-off';
          var label = c.loaded ? '就绪' : '未加载';
          var detail = c.detail && c.loaded ? (' · ' + c.detail) : '';
          html += '<div class="comp-row"><span class="' + dot + '"></span><span class="comp-name">' + c.name + '</span><span class="comp-status">' + label + detail + '</span></div>';
        }
        compEl.innerHTML = html;
      }

      // 已用内存
      if (usedMemEl && resData.mem) {
        var usedMB = (resData.mem.process_mb || 0) + (resData.modules && resData.modules.llm ? (resData.modules.llm.mb || 0) : 0);
        usedMemEl.textContent = usedMB >= 1024 ? (usedMB/1024).toFixed(1) + ' GB' : usedMB + ' MB';
      }

      // 显存
      if (vramEl) {
        if (data.gpu_info && data.gpu_info.indexOf('Intel') !== -1) {
          vramEl.textContent = '共享系统内存（集成显卡）';
        } else if (data.gpu_info && data.gpu_info !== 'CPU') {
          vramEl.textContent = '独显（见显卡规格）';
        } else {
          vramEl.textContent = '无';
        }
      }
    } catch(e3) {
      if (compEl) compEl.innerHTML = '<span style="color:var(--text-muted);font-size:11px">加载失败</span>';
    }

  } catch (e) {
    var els = ['diagPython', 'diagOs', 'diagGpu', 'diagTotalMem', 'diagUsedMem', 'diagVram'];
    for (var i = 0; i < els.length; i++) {
      var el = document.getElementById(els[i]);
      if (el) el.textContent = '加载失败';
    }
  }
}

// ===== P6: 隐私 Tab — 数据存储信息 =====
async function refreshPrivacyInfo() {
  try {
    var resp = await fetch(_apiBase + '/api/system/info');
    var data = await resp.json();

    var dirEl = document.getElementById('privacyDataDir');
    if (dirEl && data.data_dir) dirEl.textContent = data.data_dir;

    var diskEl = document.getElementById('privacyDiskUsage');
    if (diskEl && data.data_size_mb != null) {
      var mb = data.data_size_mb;
      diskEl.textContent = mb >= 1024 ? (mb/1024).toFixed(1) + ' GB' : mb + ' MB';
    }
  } catch (e) {
    // 静默失败
  }
}

// ===== 暴露到全局 =====
// P6: 模式选择器
window.initModeSelector = initModeSelector;
window.selectMode = selectMode;
window._executeModeSwitch = _executeModeSwitch;
// P6: 设置页 Tab 切换
window.switchSettingsTab = switchSettingsTab;
window.refreshAboutDiagnostics = refreshAboutDiagnostics;
window.refreshPrivacyInfo = refreshPrivacyInfo;
// 模型管理
window.refreshResourcePanel = refreshResourcePanel;
window.refreshStatus = refreshStatus;
window.updateWarmupBtn = updateWarmupBtn;
window.handleWarmup = handleWarmup;
window.rescanModels = rescanModels;
window.handleUnload = handleUnload;
window.handleDeleteModel = handleDeleteModel;
// 配置
window.loadRecorderResident = loadRecorderResident;
window.saveRecorderResident = saveRecorderResident;
window.loadAutoWarmupSetting = loadAutoWarmupSetting;
window.saveAutoWarmup = saveAutoWarmup;
window.loadCloudConfig = loadCloudConfig;
window.toggleApiKeyVisibility = toggleApiKeyVisibility;
window.testCloudConnection = testCloudConnection;
window.saveCloudConfig = saveCloudConfig;
// 扩展
window.refreshExtensions = refreshExtensions;
window.installExtension = installExtension;
window.uninstallExtension = uninstallExtension;
window.onExtFilePicked = onExtFilePicked;
window.updateTabVisibility = updateTabVisibility;
// Action
window.refreshCapabilities = refreshCapabilities;
window.uninstallAction = uninstallAction;
// 缓存
window.refreshCacheFiles = refreshCacheFiles;
window.deleteCacheFile = deleteCacheFile;
window.clearAllCache = clearAllCache;
window.batchDeleteCache = batchDeleteCache;
window.toggleCacheSelectAll = toggleCacheSelectAll;
window.goCachePage = goCachePage;
// 备份
window.exportBackup = exportBackup;
// 权限
window.loadPermissionTools = loadPermissionTools;
window.applyPermissionPreset = applyPermissionPreset;
window.toggleToolPermission = toggleToolPermission;
// 关于
window.refreshAboutInfo = refreshAboutInfo;
window.togglePrivacyDetail = togglePrivacyDetail;
window.exportDiagnostics = exportDiagnostics;

(function addKeyframes() {
  var style = document.createElement('style');
  style.textContent = '@keyframes indeterminateProgress{0%{margin-left:0;width:30%}50%{margin-left:70%;width:20%}100%{margin-left:0;width:30%}}@keyframes msgSlideIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}@keyframes tabFadeIn{from{opacity:0}to{opacity:1}}';
  document.head.appendChild(style);
})();

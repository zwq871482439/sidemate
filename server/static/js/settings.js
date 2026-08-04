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
  cloud: '让在线 AI 帮你搜索、阅读、推理...',
  cloud_doc: '输入文档需求，AI 搜索资料并生成...',
  parallel: '离线+在线协作回答，核心数据不出机器...'
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
  // P8-6：前置条件读 AppState 派生视图（与锁卡/发送门禁同源），
  // 不再读 modelTag 的 none DOM 类；视图不可用时回落 DOM 检查
  var _av = (typeof window._appView !== 'undefined') ? window._appView : null;
  var _noModel, _noCloud;
  if (_av) {
    _noCloud = !(window._appState && window._appState.cloud && window._appState.cloud.configured);
    _noModel = !(window._appState && window._appState.local && window._appState.local.loaded);
  } else {
    var _tagEl0 = document.getElementById('modelTag');
    _noModel = _tagEl0 && _tagEl0.classList.contains('none');
    _noCloud = !(typeof _cloudConfigured !== 'undefined' && _cloudConfigured);
  }
  if (mode === 'parallel') {
    // 并行模式：离线 LLM + 云端 API 缺一不可
    if (_noModel && _noCloud) {
      showToast('并行模式需要离线模型和在线 API，请先前往设置页完成配置', 'warning', 6000);
      return;
    } else if (_noModel) {
      showToast('并行模式需要离线模型，请先在设置页加载模型', 'warning');
      return;
    } else if (_noCloud) {
      showToast('并行模式需要在线 API，请先在设置页配置 API 密钥', 'warning');
      return;
    }
  } else if (mode === 'offline') {
    if (_noModel) {
      showToast('离线模式需要先加载离线模型，请前往设置页', 'warning');
      return;
    }
  } else if (mode === 'online') {
    if (_noCloud) {
      showToast('在线模式需要配置 API 密钥，请前往设置页', 'warning');
      return;
    }
  }

  // 1. 更新按钮高亮
  _updateModeButtons(mode);

  // 2. 更新 placeholder
  _updatePlaceholder(mode);

  // P6: 显示骨架屏（actionBar + 模型tag 区域半透明 + 加载态）
  var _barEl = document.getElementById('actionBar');
  var _tagEl = document.getElementById('modelTag');
  var _inputEl = document.getElementById('msgInput');
  if (_barEl) {
    _barEl.style.opacity = '0.4';
    _barEl.style.pointerEvents = 'none';
  }
  if (_tagEl) {
    _tagEl.style.opacity = '0.4';
  }
  // 输入框鱼骨屏：切换期间显示 shimmer 占位，禁止输入
  if (_inputEl) {
    _inputEl.classList.add('input-skeleton-loading');
    _inputEl.disabled = true;
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
        // P6: 移除骨架屏（恢复透明度和交互）
        _restoreModeSwitchUI(_barEl, _tagEl, _inputEl);
        if (typeof initKbCompareToggle === 'function') initKbCompareToggle();
        if (typeof fetchContextUsage === 'function') fetchContextUsage();
        if (typeof updateChatOverlay === 'function') updateChatOverlay();
      } else {
        if (typeof showToast === 'function') showToast(data.error || '切换失败', 'error');
        _restoreModeSwitchUI(_barEl, _tagEl, _inputEl);
      }
    })
    .catch(function(e) {
      if (typeof showToast === 'function') showToast('切换失败: ' + e.message, 'error');
      _restoreModeSwitchUI(_barEl, _tagEl, _inputEl);
    });
}

// 统一恢复模式切换期间的 UI 状态（成功/失败/网络错误都调用，避免卡在加载态）
function _restoreModeSwitchUI(barEl, tagEl, inputEl) {
  if (barEl) { barEl.style.opacity = ''; barEl.style.pointerEvents = ''; }
  if (tagEl) { tagEl.style.opacity = ''; }
  if (inputEl) { inputEl.classList.remove('input-skeleton-loading'); inputEl.disabled = false; }
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
    // P8-6：刷新统一应用状态（失效旧缓存后重拉），后续 modelTag/锁卡/门禁同源派生
    if (typeof AppState !== 'undefined') AppState.invalidate();
    var results = await Promise.all([
      fetchWithTimeout(_apiBase + '/api/models'),
      fetchWithTimeout(_apiBase + '/api/status'),
      (typeof AppState !== 'undefined') ? AppState.refresh() : Promise.resolve(null)
    ]);
    var data = results[0];
    var info2 = results[1];
    var appView = results[2];

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

    // 0.9.7: 加载多模型选择下拉
    loadModelSelector();

    var currentDisplay = data.current_display || data.current;
    _loadedModelId = data.current || null;
    // P8-6：none 类（发送门禁/模式切换门禁锚点）与锁卡同源——由 AppState 派生的 engineReady 决定
    var _engineReady = appView ? appView.engineReady : null;
    var _noneCls = (_engineReady === false) ? ' none' : '';
    if (typeof _currentMode !== 'undefined' && _currentMode === 'parallel') {
      // P6 打磨 #4：并行模式同时展示双模型
      var _local = currentDisplay || '离线 AI';
      var _cloud = window._cloudModelName || '在线 AI';
      tag.className = 'model-tag model-tag-inline' + _noneCls;
      tag.textContent = '离线 ' + _local + ' · 在线 ' + _cloud;
      stag.innerHTML = '<span class="model-tag' + _noneCls + '">离线 ' + esc(_local) + ' · 云端 ' + esc(_cloud) + '</span>';
    } else if (typeof _currentMode !== 'undefined' && _currentMode === 'cloud') {
      currentDisplay = window._cloudModelName || '在线模型';
      tag.className = 'model-tag model-tag-inline' + _noneCls;
      tag.textContent = '在线 AI · ' + currentDisplay;
      stag.innerHTML = '<span class="model-tag' + _noneCls + '">在线 AI · ' + esc(currentDisplay) + '</span>';
    } else if (data.current) {
      tag.className = 'model-tag model-tag-inline';
      tag.textContent = '离线 AI · ' + currentDisplay;
      stag.innerHTML = '<span class="model-tag">离线 AI · ' + esc(currentDisplay) + '</span>';
    } else {
      tag.className = 'model-tag model-tag-inline none';
      tag.textContent = '未加载';
      stag.innerHTML = '<span class="model-tag none">未加载</span>';
    }

    var sourceTag = document.getElementById('sourceTag');
    if (sourceTag) {
      if (data.current) {
        sourceTag.textContent = '正在使用离线模型';
        sourceTag.className = 'tag online on';
        sourceTag.style.background = '';
        sourceTag.style.color = '';
      } else if (hasModels) {
        sourceTag.textContent = '模型已就绪，加载后使用';
        sourceTag.className = 'tag online off';
        sourceTag.style.background = '';
        sourceTag.style.color = '';
      } else {
        sourceTag.textContent = '离线模型未加载';
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
      // P6: 文案统一为 卡片/列表（绝不显示"气泡"），与 ui-enhance.js:applyMode 一致
      _msBtn.textContent = (_curMode === 'list') ? '卡片' : '列表';
    }
    // P6: initModeTag 已移除，模式状态由 initModeSelector 管理
  } catch(e) {
    if (statusTextEl) statusTextEl.textContent = '刷新失败: ' + e.message;
  }
}

// ===== 预热按钮状态（0.9.7 简化：有模型时隐藏，交给下拉+主按钮）=====
function updateWarmupBtn(modelsData) {
  var btn = document.getElementById('modelActionBtn');
  if (!modelsData) return;

  var hasModels = modelsData.available && modelsData.available.length > 0;

  // modelActionBtn：只在没模型时显示"扫描模型"，有模型时隐藏（下拉接管）
  // 注：模型删除/下载已移至「模型下载」设置子页
  if (btn) {
    if (!hasModels) {
      btn.style.display = 'inline-block';
      btn.textContent = '扫描模型';
      btn.onclick = function() { rescanModels(); };
      btn.className = 'btn btn-primary';
      btn.disabled = false;
    } else {
      btn.style.display = 'none';
    }
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
    await loadModelSelector();  // 0.9.7: 扫描后刷新下拉
  } catch(e) {
    showToast('扫描失败: ' + e.message, 'error');
    await refreshStatus();
  }
}

// 0.9.7: 加载模型选择下拉
var _currentLoadedModelId = '';  // 当前已加载的模型 ID（从后端来）
var _availableModelsCache = [];  // 缓存模型列表

async function loadModelSelector() {
  var sel = document.getElementById('modelSelector');
  var hint = document.getElementById('modelSwitchHint');
  if (!sel) return;

  try {
    var resp = await fetch(_apiBase + '/api/models/available');
    var data = await resp.json();
    var models = (data && data.models) || [];
    _availableModelsCache = models;

    // 找当前加载的模型
    _currentLoadedModelId = '';
    for (var i = 0; i < models.length; i++) {
      if (models[i].current) { _currentLoadedModelId = models[i].model_id; break; }
    }

    // 填充下拉
    var html = '';
    if (!_currentLoadedModelId) {
      html += '<option value="">-- 选择模型加载 --</option>';
    }
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      var ramTxt = m.min_ram_gb ? '建议 ' + m.min_ram_gb + 'GB 内存' : (m.estimated_ram_gb ? '~' + m.estimated_ram_gb + 'GB 内存' : '');
      var label = (m.display_name || m.model_id) + (ramTxt ? ' · ' + ramTxt : '');
      html += '<option value="' + esc(m.model_id) + '">' + esc(label) + '</option>';
    }
    sel.innerHTML = html;
    // 默认选中当前加载的
    sel.value = _currentLoadedModelId || '';

    updateModelButton();
  } catch (e) {
    if (hint) hint.textContent = '加载失败：' + e.message;
  }
}

// 更新主按钮状态（根据下拉选中值 vs 当前加载的模型）
function updateModelButton() {
  var sel = document.getElementById('modelSelector');
  var switchBtn = document.getElementById('modelSwitchBtn');
  var hint = document.getElementById('modelSwitchHint');
  if (!sel || !switchBtn) return;

  var selectedId = sel.value;
  var selectedName = '';
  for (var i = 0; i < _availableModelsCache.length; i++) {
    if (_availableModelsCache[i].model_id === selectedId) {
      selectedName = _availableModelsCache[i].display_name || selectedId;
      break;
    }
  }

  if (!selectedId) {
    // 没选任何模型
    switchBtn.disabled = true;
    switchBtn.textContent = '请选择';
    switchBtn.className = 'btn btn-ghost';
    if (hint) hint.textContent = '';
  } else if (selectedId === _currentLoadedModelId) {
    // 选中的就是当前已加载的 → 按钮变"卸载"
    switchBtn.disabled = false;
    switchBtn.textContent = '卸载';
    switchBtn.className = 'btn btn-ghost';
    switchBtn.style.color = 'var(--error-color)';
    switchBtn.style.borderColor = 'var(--error-color)';
    if (hint) hint.textContent = '当前已加载：' + selectedName;
  } else {
    // 选了别的模型 → 按钮变"切换"
    switchBtn.disabled = false;
    switchBtn.textContent = '切换';
    switchBtn.className = 'btn btn-primary';
    switchBtn.style.color = '';
    switchBtn.style.borderColor = '';
    if (hint) hint.textContent = '点击切换到 ' + selectedName;
  }
}

// 0.9.7: 主按钮点击（智能：切换 or 卸载）
async function switchModel() {
  var sel = document.getElementById('modelSelector');
  var switchBtn = document.getElementById('modelSwitchBtn');
  var hint = document.getElementById('modelSwitchHint');
  if (!sel || !sel.value) return;

  var targetId = sel.value;

  // 如果选中的是当前已加载的 → 卸载
  if (targetId === _currentLoadedModelId) {
    handleUnload();
    return;
  }

  // 否则 → 切换
  switchBtn.disabled = true;
  switchBtn.textContent = '切换中...';
  switchBtn.style.color = '';
  switchBtn.style.borderColor = '';
  if (hint) hint.textContent = '正在切换，请稍候...（可能需要 10-20 秒）';

  try {
    var resp = await fetch(_apiBase + '/api/models/switch', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({model_id: targetId})
    });
    var data = await resp.json();
    if (resp.status === 409 && data.busy) {
      if (hint) hint.textContent = '⚠ AI 正在生成中，请等当前对话完成后再切换';
      if (typeof showToast === 'function') showToast('AI 忙，请稍后再切换', 'warn');
    } else if (data.ok) {
      _currentLoadedModelId = targetId;
      if (hint) hint.textContent = '✓ 已切换';
      if (typeof showToast === 'function') showToast('模型已切换', 'success');
      // 刷新
      setTimeout(function() {
        refreshStatus();
        loadModelSelector();
        refreshResourcePanel();
      }, 500);
    } else {
      if (hint) hint.textContent = '✗ 切换失败：' + (data.error || '未知错误');
    }
  } catch (e) {
    if (hint) hint.textContent = '✗ 切换失败：' + e.message;
  } finally {
    switchBtn.disabled = false;
    updateModelButton();
  }
}

// 下拉选择变更
function onModelSelectorChange() {
  updateModelButton();
}

window.loadModelSelector = loadModelSelector;
window.switchModel = switchModel;
window.onModelSelectorChange = onModelSelectorChange;

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

// ===== Reranker 常驻 / 空闲卸载设置（reranker_resident / reranker_idle_timeout_sec）=====
async function loadRerankerResidentSetting() {
  try {
    var resp = await fetch(_apiBase + '/api/config');
    var result = await resp.json();
    var cfg = result.config || result;
    var chk = document.getElementById('rerankerResidentChk');
    var idleInput = document.getElementById('rerankerIdleInput');
    if (chk) chk.checked = cfg.reranker_resident === true;
    if (idleInput) {
      // 后端以秒存储，UI 以分钟展示
      var secs = cfg.reranker_idle_timeout_sec != null ? cfg.reranker_idle_timeout_sec : 300;
      idleInput.value = Math.max(1, Math.round(secs / 60));
    }
    _toggleRerankerIdleVisibility();
  } catch(e) { console.error('[settings.loadRerankerResidentSetting]', e); }
}

// 常驻开关切换时，控制"闲置 N 分钟后卸载"那一行的显隐
function _toggleRerankerIdleVisibility() {
  var chk = document.getElementById('rerankerResidentChk');
  var wrap = document.getElementById('rerankerIdleWrap');
  if (wrap && chk) wrap.style.display = chk.checked ? 'none' : 'flex';
}

async function saveRerankerResident(checked) {
  try {
    await fetch(_apiBase + '/api/config', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({reranker_resident: !!checked})
    });
    _toggleRerankerIdleVisibility();
    if (checked) {
      // 常驻 = 立即驻留：触发后台加载 Reranker（embedder 若已加载则跳过）
      // 否则用户勾了常驻，引擎却要等下次用知识库才加载，与"常驻"语义不符。
      if (typeof showToast === 'function') showToast('正在加载 Reranker 到内存...', 'info');
      try {
        var resp = await fetch(_apiBase + '/api/kb/load-models', {method: 'POST'});
        var data = await resp.json();
        if (data.ram_warning && typeof showToast === 'function') {
          showToast(data.ram_warning, 'warning');
        }
        // 加载是后台异步的，稍后刷新诊断面板反映新状态
        setTimeout(function() {
          if (typeof refreshStatus === 'function') refreshStatus();
          if (typeof refreshResourcePanel === 'function') refreshResourcePanel();
        }, 2500);
      } catch(le) {
        console.warn('[settings.saveRerankerResident.load]', le);
      }
    } else {
      if (typeof showToast === 'function') {
        showToast('Reranker 将在闲置后自动卸载', 'success');
      }
    }
  } catch(e) {
    console.error('[settings.saveRerankerResident]', e);
    if (typeof showToast === 'function') showToast('保存失败', 'error');
  }
}

// ===== KB 知识库引擎选择（kb_ai_mode）=====
async function loadKbAiMode() {
  try {
    var resp = await fetch(_apiBase + '/api/config');
    var result = await resp.json();
    var cfg = result.config || result;
    var mode = cfg.kb_ai_mode || 'local';
    var radio = document.querySelector('input[name="kbAiMode"][value="' + mode + '"]');
    if (radio) radio.checked = true;
    _updateKbAiModeHint(mode);
  } catch(e) { console.error('[settings.loadKbAiMode]', e); }
}

function _updateKbAiModeHint(mode) {
  var hint = document.getElementById('kbAiModeHint');
  if (!hint) return;
  if (mode === 'cloud') {
    hint.textContent = '文档打标、AI 洞察和标签分组将使用在线模型，质量更高，但需配置在线 API 且数据会发送到在线服务';
  } else {
    hint.textContent = '文档打标、AI 洞察和标签分组将使用离线模型，数据完全不出本机，隐私优先';
  }
}

async function saveKbAiMode(mode) {
  _updateKbAiModeHint(mode);
  try {
    await fetch(_apiBase + '/api/config', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({kb_ai_mode: mode})
    });
    if (typeof showToast === 'function') {
      showToast(mode === 'cloud' ? '已切换为在线模型' : '已切换为离线模型', 'success');
    }
  } catch(e) {
    console.error('[settings.saveKbAiMode]', e);
    if (typeof showToast === 'function') showToast('保存失败', 'error');
  }
}

async function saveRerankerIdle(minutes) {
  try {
    var mins = parseInt(minutes, 10);
    if (isNaN(mins) || mins < 1) mins = 1;
    if (mins > 1440) mins = 1440;   // 上限 24 小时
    // UI 分钟 → 后端秒
    await fetch(_apiBase + '/api/config', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({reranker_idle_timeout_sec: mins * 60})
    });
    var input = document.getElementById('rerankerIdleInput');
    if (input) input.value = mins;
    if (typeof showToast === 'function') showToast('已更新：闲置 ' + mins + ' 分钟后卸载', 'success');
  } catch(e) {
    console.error('[settings.saveRerankerIdle]', e);
    if (typeof showToast === 'function') showToast('保存失败', 'error');
  }
}

// ===== Tab 动态显隐 =====
async function updateTabVisibility() {
  try {
    var resp = await fetch(_apiBase + '/api/extensions/list');
    var data = await resp.json();
    var exts = data.extensions || [];
    var hasKB = exts.some(function(e) { return e.type === 'knowledge'; });

    // 知识库 Tab 常显（未安装时由 updateKbTabLock 显示 🔒 徽标 + 引导页），不再隐藏

    var kbRefItem = document.getElementById('kbRefMenuItem');
    if (kbRefItem) kbRefItem.style.display = hasKB ? '' : 'none';

    var kbStatusEl = document.getElementById('settingsKBStatus');
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
  } catch(e) {
    silentLog('[settings.updateTabVisibility]', e);
  }
}

// ===== 云端配置 =====
var _cloudConfigLoaded = false;

// P8-1: 接口格式联动 placeholder（格式下拉已表达格式信息，不再用 badge 说明行）
function onCloudFormatChange() {
  var fmt = (document.getElementById('cloudApiFormat') || {}).value || 'openai';
  var urlEl = document.getElementById('cloudBaseUrl');
  var keyEl = document.getElementById('cloudApiKey');
  var modelEl = document.getElementById('cloudModel');
  if (fmt === 'anthropic') {
    if (urlEl) urlEl.placeholder = 'https://api.anthropic.com';
    if (keyEl) keyEl.placeholder = 'sk-ant-...';
    if (modelEl) modelEl.placeholder = 'claude-sonnet-4-5';
  } else {
    if (urlEl) urlEl.placeholder = 'OpenAI 兼容格式，如 https://api.deepseek.com';
    if (keyEl) keyEl.placeholder = '请输入 API Key';
    if (modelEl) modelEl.placeholder = '如 deepseek-v4-flash';
  }
  _hideCloudModelList();
}
window.onCloudFormatChange = onCloudFormatChange;

// P8-3: 保存成功横幅（C 方案引导式迁移）——任何字段被编辑时隐藏
function dismissCloudSaveBanner() {
  var b = document.getElementById('cloudSaveBanner');
  if (b) b.style.display = 'none';
}
window.dismissCloudSaveBanner = dismissCloudSaveBanner;

function _showCloudSaveBanner(modelName) {
  var b = document.getElementById('cloudSaveBanner');
  var t = document.getElementById('cloudSaveBannerText');
  if (t) t.textContent = '✅ 已保存：' + (modelName || '云端配置');
  if (b) b.style.display = 'flex';
}

function _bindCloudFormOnce() {
  var form = document.querySelector('#stab-cloud form');
  if (form && !form._p83Bound) {
    form._p83Bound = true;
    form.addEventListener('input', dismissCloudSaveBanner);
  }
}

async function loadCloudConfig() {
  // P8-3: 配置未加载完时禁用保存按钮（防"点了没存上"）
  var saveBtn = document.getElementById('cloudSaveBtn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.title = '配置加载中，请稍候'; }
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/cloud/config');
    var data = await resp.json();
    var urlEl = document.getElementById('cloudBaseUrl');
    var modelEl = document.getElementById('cloudModel');
    var keyEl = document.getElementById('cloudApiKey');
    var fmtEl = document.getElementById('cloudApiFormat');
    if (fmtEl) {
      fmtEl.value = data.api_format || 'openai';
      onCloudFormatChange();
    }
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
    // P8-3: 输入上限——用户覆盖值优先，其次自动匹配预填，未匹配留空引导手填
    _setCtxField(data.context_window_user > 0 ? data.context_window_user : 0,
                 data.context_matched ? data.context_window : 0,
                 data.context_window_user > 0);
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
      modelEl.addEventListener('blur', _autofillCloudCtx);
      modelEl.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); _autofillCloudCtx(); }
      });
    }
    // 输入上限手动编辑 → 标注"用户覆盖"
    var ctxEl = document.getElementById('cloudContextWindow');
    if (ctxEl && !ctxEl._p83Bound) {
      ctxEl._p83Bound = true;
      ctxEl.addEventListener('input', function() {
        _setCtxHint('用户覆盖');
      });
    }
    _bindCloudFormOnce();
    _cloudConfigLoaded = true;
  } catch(e) {
    console.warn('[loadCloudConfig] 加载现有配置失败，允许直接保存:', e.message || e);
    _cloudConfigLoaded = true;
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.title = ''; }
  }
}

// P8-3: 输入上限字段状态（value + hint 同源设置）
// userVal>0 → 用户覆盖；autoVal>0 → 自动匹配预填；都 0 → 留空引导手填
function _setCtxField(userVal, autoVal, isUserOverride) {
  var ctxEl = document.getElementById('cloudContextWindow');
  if (!ctxEl) return;
  if (userVal > 0) {
    ctxEl.value = userVal;
    _setCtxHint(isUserOverride ? '用户覆盖' : '已自动匹配，可改');
  } else if (autoVal > 0) {
    ctxEl.value = autoVal;
    _setCtxHint('已自动匹配，可改');
  } else {
    ctxEl.value = '';
    _setCtxHint('未识别，请查服务商文档后手填');
  }
}

function _setCtxHint(text) {
  var hint = document.getElementById('cloudCtxHint');
  if (hint) hint.textContent = 'tokens · ' + text;
}

// P8-3: 模型名变更 → 自动匹配输入上限（内置表），未匹配则留空引导手填
function _autofillCloudCtx() {
  clearTimeout(window._capsTimer);
  window._capsTimer = setTimeout(async function() {
    var modelEl = document.getElementById('cloudModel');
    var ctxEl = document.getElementById('cloudContextWindow');
    if (!modelEl || !ctxEl) return;
    var model = modelEl.value.trim();
    if (!model) { _setCtxField(0, 0, false); return; }
    try {
      var resp = await fetch(_apiBase + '/api/cloud/model-capabilities?model=' + encodeURIComponent(model));
      var data = await resp.json();
      if (data.error || !data.matched) {
        _setCtxField(0, 0, false);  // 未命中内置表 → 留空引导手填
        return;
      }
      _setCtxField(0, data.context_window || 0, false);
    } catch(e) { /* 查询失败保持现状 */ }
  }, 300);
}

// P8-3: 拉取模型列表（失败/列表不全都可手填，输入框始终可编辑）
async function fetchCloudModels() {
  var listEl = document.getElementById('cloudModelList');
  var btn = document.getElementById('cloudFetchModelsBtn');
  var result = document.getElementById('cloudTestResult');
  if (!listEl) return;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 拉取中…'; }
  try {
    var body = {
      api_format: (document.getElementById('cloudApiFormat') || {}).value || 'openai',
      base_url: (document.getElementById('cloudBaseUrl') || {}).value || '',
    };
    var keyEl = document.getElementById('cloudApiKey');
    if (keyEl && keyEl.value && keyEl.value.indexOf('***...***') === -1) {
      body.api_key = keyEl.value;
    }
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/cloud/models', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    var data = await resp.json();
    if (!data.ok) {
      if (result) {
        result.innerHTML = '<div style="padding:10px 14px;border-radius:8px;background:rgba(220,38,38,0.06);border:1px solid rgba(220,38,38,0.3);color:var(--danger-color,#dc2626)">' +
          '拉取模型列表失败<code style="display:block;margin-top:6px;padding:6px 8px;border-radius:4px;background:rgba(220,38,38,0.08);font-size:.92em;white-space:pre-wrap">' + esc(data.error || '未知错误') + '</code></div>';
      }
      return;
    }
    _renderCloudModelList(data.models || []);
  } catch(e) {
    if (result) result.textContent = '拉取失败: ' + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬇ 拉取模型列表'; }
  }
}
window.fetchCloudModels = fetchCloudModels;

function _renderCloudModelList(models) {
  var listEl = document.getElementById('cloudModelList');
  var modelEl = document.getElementById('cloudModel');
  if (!listEl || !modelEl) return;
  var cur = modelEl.value.trim();
  var html = '';
  models.forEach(function(m) {
    var ctx = m.context_window ? _fmtCtx(m.context_window) + ' 上下文' : '上下文未知';
    var isCur = cur && m.id === cur;
    html += '<div data-mid="' + esc(m.id) + '" data-mctx="' + (m.context_window || '') + '" style="padding:7px 12px;font-size:.85em;cursor:pointer;display:flex;justify-content:space-between;gap:10px' + '">' +
      '<span style="' + (isCur ? 'color:var(--accent-color);font-weight:600' : '') + '">' + esc(m.id) + (isCur ? '（当前）' : '') + '</span>' +
      '<span style="color:var(--text-muted);font-size:.92em;flex-shrink:0">' + ctx + '</span></div>';
  });
  if (!models.length) {
    html += '<div style="padding:7px 12px;font-size:.85em;color:var(--text-muted)">服务商未返回任何模型</div>';
  }
  // 手动输入兜底（固定底部）
  html += '<div style="padding:7px 12px;font-size:.78em;color:var(--text-muted);border-top:1px dashed var(--border-color);font-style:italic">✎ 列表没有？直接在上面输入框手动填写</div>';
  listEl.innerHTML = html;
  listEl.style.display = '';
  // 绑定点击（悬停样式用事件实现，避免依赖额外 CSS）
  Array.prototype.forEach.call(listEl.children, function(row) {
    var mid = row.getAttribute('data-mid');
    if (!mid) return;
    row.addEventListener('mouseenter', function() { row.style.background = 'var(--bg-secondary)'; });
    row.addEventListener('mouseleave', function() { row.style.background = ''; });
    row.addEventListener('click', function() {
      modelEl.value = mid;
      _hideCloudModelList();
      var mctx = parseInt(row.getAttribute('data-mctx') || '0', 10);
      if (mctx > 0) {
        _setCtxField(0, mctx, false);  // 列表带上下文 → 直接预填
      } else {
        _autofillCloudCtx();  // 列表不带 → 查内置表，未命中留空引导手填
      }
    });
  });
}

function _hideCloudModelList() {
  var listEl = document.getElementById('cloudModelList');
  if (listEl) listEl.style.display = 'none';
}

function _fmtCtx(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(n % 1048576 ? 1 : 0) + 'M';
  if (n >= 1024) return Math.round(n / 1024) + 'K';
  return String(n);
}

// ===== 云端 AI 用量统计 =====
// range 与 granularity 联动：今日→小时粒度（24格时间轴），本周→天粒度（7格时间轴）
// 不允许交叉组合（如"本周+小时"无意义），故只暴露 range 一个切换维度。
var _cloudUsageRange = 7;       // 1=今日, 7=本周
function _cloudUsageGran() { return _cloudUsageRange === 1 ? 'hour' : 'day'; }

async function loadCloudUsage() {
  var panel = document.getElementById('cloudUsagePanel');
  if (!panel) return;
  try {
    var resp = await fetch(_apiBase + '/api/cloud/usage?range_days=' + _cloudUsageRange + '&granularity=' + _cloudUsageGran());
    var data = await resp.json();
    renderCloudUsage(panel, data);
  } catch (e) {
    panel.innerHTML = '<span style="color:var(--text-muted)">用量统计暂不可用</span>';
  }
}

function renderCloudUsage(panel, data) {
  if (!data) { panel.innerHTML = '<span style="color:var(--text-muted)">暂无数据</span>'; return; }
  var total = data.total_tokens || 0;
  var calls = data.total_calls || 0;
  var rangeLabel = _cloudUsageRange === 1 ? '今日' : '本周';
  var granLabel = _cloudUsageGran() === 'hour' ? '小时' : '天';

  // 切换按钮组（range 与粒度联动，只暴露 range：今日=按小时、本周=按天）
  var html = '<div style="display:flex;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:4px">';
  html += '<button class="btn btn-sm ' + (_cloudUsageRange === 1 ? 'btn-primary' : 'btn-ghost') + '" onclick="_cloudUsageSetRange(1)">今日（按小时）</button>';
  html += '<button class="btn btn-sm ' + (_cloudUsageRange === 7 ? 'btn-primary' : 'btn-ghost') + '" onclick="_cloudUsageSetRange(7)">本周（按天）</button>';
  html += '</div>';

  // 汇总数字（含输入/输出/推理细分，色块对齐柱状图配色）
  var _tIn = data.total_input || 0, _tOut = data.total_output || 0, _tRea = data.total_reasoning || 0;
  html += '<div style="font-size:13px;color:var(--text-secondary);margin-bottom:6px">';
  html += rangeLabel + '累计 <b style="color:var(--text-primary)">' + total.toLocaleString() + '</b> token · <b style="color:var(--text-primary)">' + calls + '</b> 次调用';
  if (!data.all_accurate) {
    html += ' <span style="font-size:11px;color:var(--warning-color,#d97706)">（部分调用未返回用量数据）</span>';
  }
  html += '</div>';
  // 输入/输出/推理总量（色块图例 + 数值）
  if (_tIn + _tOut + _tRea > 0) {
    html += '<div style="display:flex;gap:14px;font-size:11px;color:var(--text-muted);margin-bottom:10px;flex-wrap:wrap">';
    html += '<span style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#60A5FA"></span>输入 ' + _tIn.toLocaleString() + '</span>';
    html += '<span style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#34D399"></span>输出 ' + _tOut.toLocaleString() + '</span>';
    if (_tRea > 0) html += '<span style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#A78BFA"></span>推理 ' + _tRea.toLocaleString() + '</span>';
    html += '</div>';
  }

  // 柱状图（图例已在上方的输入/输出/推理汇总行，不重复）
  html += _renderUsageChart(data.by_bucket || [], granLabel);

  // 按模型
  if (data.by_model && data.by_model.length) {
    html += '<div style="margin-top:12px;font-size:12px;color:var(--text-muted);margin-bottom:4px">按模型</div>';
    var maxModel = Math.max.apply(null, data.by_model.map(function(m) { return m.tokens; }));
    for (var i = 0; i < data.by_model.length; i++) {
      var m = data.by_model[i];
      var pct = maxModel > 0 ? Math.round(m.tokens / maxModel * 100) : 0;
      var sharePct = total > 0 ? Math.round(m.tokens / total * 100) : 0;
      // 分段进度条：输入(灰)/输出(品牌色)/推理(紫)，与柱状图配色一致
      var _mIn = m.input || 0, _mOut = m.output || 0, _mRea = m.reasoning || 0;
      var _mSum = _mIn + _mOut + _mRea;
      var segHtml = '';
      if (_mSum > 0 && pct > 0) {
        // 各段宽度 = 该模型在条中的占比 × 该段的 token 占比
        var segW = pct;  // 整条宽度（%）
        var wIn = (_mIn / _mSum * segW).toFixed(1);
        var wOut = (_mOut / _mSum * segW).toFixed(1);
        var wRea = (segW - parseFloat(wIn) - parseFloat(wOut)).toFixed(1);
        // 分段进度条：外层 usage-model-bar 从 0 动画增长到目标宽度（CSS animation）
        // 子段用百分比（相对外层），这样外层增长时三段比例不变
        var pIn = (_mIn / _mSum * 100).toFixed(1);
        var pOut = (_mOut / _mSum * 100).toFixed(1);
        var pRea = (100 - parseFloat(pIn) - parseFloat(pOut)).toFixed(1);
        segHtml = '<div class="usage-model-bar" style="--target-w:' + segW + '%"><div style="height:100%;display:flex;width:100%;border-radius:3px;overflow:hidden">';
        if (parseFloat(pIn) > 0) segHtml += '<div style="height:100%;width:' + pIn + '%;background:#60A5FA"></div>';
        if (parseFloat(pOut) > 0) segHtml += '<div style="height:100%;width:' + pOut + '%;background:#34D399"></div>';
        if (parseFloat(pRea) > 0) segHtml += '<div style="height:100%;width:' + pRea + '%;background:#A78BFA"></div>';
        segHtml += '</div></div>';
      } else {
        // 兜底：无细分数据，整条浅绿（也带动画）
        segHtml = '<div class="usage-model-bar" style="--target-w:' + pct + '%"><div style="height:100%;width:100%;background:#34D399;border-radius:3px"></div></div>';
      }
      html += '<div style="display:flex;align-items:center;gap:6px;font-size:11px;margin-bottom:3px" title="' + esc(m.model) + ' · 共 ' + m.tokens.toLocaleString() + ' token (' + sharePct + '%)&#10;输入 ' + _mIn.toLocaleString() + ' · 输出 ' + _mOut.toLocaleString() + (_mRea > 0 ? ' · 推理 ' + _mRea.toLocaleString() : '') + ' token">';
      html += '<span style="width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0">' + esc(m.model) + '</span>';
      html += '<div style="flex:1;height:10px;background:var(--bg-secondary);border-radius:3px;overflow:hidden">' + segHtml + '</div>';
      html += '<span style="width:90px;text-align:right;flex-shrink:0;color:var(--text-muted)">' + m.tokens.toLocaleString() + ' (' + sharePct + '%)</span>';
      html += '</div>';
    }
  }

  // 记录表
  if (data.records && data.records.length) {
    html += '<details style="margin-top:12px"><summary style="cursor:pointer;font-size:12px;color:var(--text-muted)">最近调用 (' + data.records.length + ')</summary>';
    html += '<div class="usage-records" style="margin-top:8px;max-height:240px;overflow-y:auto;font-size:11px">';
    html += '<div style="display:grid;grid-template-columns:1fr 1.4fr 0.7fr 0.7fr 0.6fr;gap:4px;padding:4px 0;border-bottom:0.5px solid var(--border-color);color:var(--text-muted);font-weight:500"><span>时间</span><span>模型</span><span>输入</span><span>输出</span><span>耗时</span></div>';
    for (var j = 0; j < data.records.length; j++) {
      var r = data.records[j];
      var dt = new Date(r.ts * 1000);
      var timeStr = (dt.getMonth()+1) + '-' + dt.getDate() + ' ' + String(dt.getHours()).padStart(2,'0') + ':' + String(dt.getMinutes()).padStart(2,'0');
      var inStr = r.accurate ? (r.input != null ? r.input.toLocaleString() : '-') : '?';
      var outStr = r.accurate ? (r.output != null ? r.output.toLocaleString() : '-') : '?';
      var elapsedStr = r.elapsed_ms != null ? (r.elapsed_ms / 1000).toFixed(1) + 's' : '-';
      html += '<div style="display:grid;grid-template-columns:1fr 1.4fr 0.7fr 0.7fr 0.6fr;gap:4px;padding:3px 0;border-bottom:0.5px solid var(--border-color);color:var(--text-secondary)">';
      html += '<span>' + timeStr + '</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(r.model) + '</span>';
      html += '<span>' + inStr + '</span><span>' + outStr + '</span><span>' + elapsedStr + '</span>';
      html += '</div>';
    }
    html += '</div></details>';
  }

  panel.innerHTML = html;
}

// 生成完整时间轴桶序列（补齐空桶，让单点数据不再撑满整图、时间线完整）
// 与后端 strftime 格式对齐：hour → "YYYY-MM-DD HH:00"，day → "YYYY-MM-DD"
function _buildBucketAxis() {
  var axis = [];   // [{bucket, tokens, calls}]
  var now = new Date();
  if (_cloudUsageRange === 1) {
    // 今日：00:00 ~ 当前小时，逐小时
    var d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var curHour = now.getHours();
    for (var h = 0; h <= curHour; h++) {
      var d = new Date(d0.getTime() + h * 3600000);
      var mm = String(d.getMonth() + 1).padStart(2, '0');
      var dd = String(d.getDate()).padStart(2, '0');
      var hh = String(d.getHours()).padStart(2, '0');
      axis.push({bucket: d.getFullYear() + '-' + mm + '-' + dd + ' ' + hh + ':00', tokens: 0, calls: 0});
    }
  } else {
    // 本周：最近 7 天，逐天
    for (var i = 6; i >= 0; i--) {
      var d2 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      var mm2 = String(d2.getMonth() + 1).padStart(2, '0');
      var dd2 = String(d2.getDate()).padStart(2, '0');
      axis.push({bucket: d2.getFullYear() + '-' + mm2 + '-' + dd2, tokens: 0, calls: 0});
    }
  }
  return axis;
}

// SVG 柱状图（纯手画，无依赖）
function _renderUsageChart(buckets, granLabel) {
  // 用完整时间轴补齐空桶：避免数据稀疏时单根柱子撑满全宽（大横条 bug）
  var axis = _buildBucketAxis();
  var byKey = {};
  if (buckets && buckets.length) {
    for (var bi = 0; bi < buckets.length; bi++) byKey[buckets[bi].bucket] = buckets[bi];
  }
  var hasData = false;
  for (var ai = 0; ai < axis.length; ai++) {
    var hit = byKey[axis[ai].bucket];
    // 复制 tokens/calls + input/output/reasoning（分段柱需要，缺字段会导致不分段）
    if (hit) {
      axis[ai].tokens = hit.tokens || 0;
      axis[ai].calls = hit.calls || 0;
      axis[ai].input = hit.input || 0;
      axis[ai].output = hit.output || 0;
      axis[ai].reasoning = hit.reasoning || 0;
      if (hit.tokens) hasData = true;
    }
  }
  if (!hasData) {
    return '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px;background:var(--bg-secondary);border-radius:6px">' + (_cloudUsageRange === 1 ? '今日' : '本周') + '暂无调用记录</div>';
  }
  var maxTokens = Math.max.apply(null, axis.map(function(b) { return b.tokens; }));
  if (maxTokens === 0) maxTokens = 1;
  var W = 420, H = 100, padL = 8, padR = 4, padB = 16;
  var chartW = W - padL - padR;
  var barCount = axis.length;
  // 每格宽度固定（按桶数均分），柱子占格内的 70%，避免单点撑满
  var slot = chartW / barCount;
  var barW = Math.max(3, Math.min(22, Math.floor(slot * 0.7)));
  var gap = slot - barW;

  var svg = '<svg width="100%" viewBox="0 0 ' + W + ' ' + (H + padB) + '" style="display:block;max-width:100%">';
  for (var i = 0; i < axis.length; i++) {
    var b = axis[i];
    if (b.tokens <= 0) continue;
    var x = padL + i * slot + gap / 2;
    // 分段：输入(下,灰) / 输出(中,品牌色) / 推理(上,紫)
    // 按各自占比拆高度；三者都 0 时用 tokens 整根（兼容旧记录 input/output 缺失）
    var _in = b.input || 0, _out = b.output || 0, _rea = b.reasoning || 0;
    var _sum = _in + _out + _rea;
    var hIn, hOut, hRea;
    if (_sum > 0) {
      var hTotal = Math.max(1, Math.round((b.tokens / maxTokens) * H));
      hIn = Math.round((_in / _sum) * hTotal);
      hOut = Math.round((_out / _sum) * hTotal);
      hRea = hTotal - hIn - hOut;  // 余数给推理，避免四舍五入丢像素
    } else {
      // 旧记录只有 tokens 总数，无细分：整根按输出色
      hIn = 0; hOut = Math.max(1, Math.round((b.tokens / maxTokens) * H)); hRea = 0;
    }
    var yBase = H;  // 柱底（从下往上堆叠）
    // 小段最小可见高度：输出/推理只要有值，至少 2px，避免占比小看不见
    if (_sum > 0 && _out > 0 && hOut < 2 && hIn > 4) { hOut = 2; hIn -= 2; }
    if (_sum > 0 && _rea > 0 && hRea < 2 && hIn > 4) { hRea = 2; hIn -= 2; }
    var tipParts = [esc(b.bucket) + ' · 共 ' + b.tokens.toLocaleString() + ' token / ' + b.calls + ' 次'];
    if (_sum > 0) {
      tipParts.push('输入 ' + _in.toLocaleString() + ' · 输出 ' + _out.toLocaleString() + (_rea > 0 ? ' · 推理 ' + _rea.toLocaleString() : '') + ' token');
    }
    var tipText = tipParts.join('&#10;');
    // 用 <g> 包裹同一天的段，hover 整组高亮；浅绿/浅蓝/浅紫柔和配色
    svg += '<g class="usage-bar-group">';
    // 输入段（底部，浅蓝）
    if (hIn > 0) {
      svg += '<rect class="usage-seg usage-seg-in" x="' + x.toFixed(1) + '" y="' + (yBase - hIn) + '" width="' + barW + '" height="' + hIn + '" rx="1" fill="#60A5FA"><title>' + tipText + '</title></rect>';
      yBase -= hIn;
    }
    // 输出段（中部，浅绿）
    if (hOut > 0) {
      svg += '<rect class="usage-seg usage-seg-out" x="' + x.toFixed(1) + '" y="' + (yBase - hOut) + '" width="' + barW + '" height="' + hOut + '" fill="#34D399"><title>' + tipText + '</title></rect>';
      yBase -= hOut;
    }
    // 推理段（顶部，浅紫）
    if (hRea > 0) {
      svg += '<rect class="usage-seg usage-seg-rea" x="' + x.toFixed(1) + '" y="' + (yBase - hRea) + '" width="' + barW + '" height="' + hRea + '" rx="1" fill="#A78BFA"><title>' + tipText + '</title></rect>';
    }
    svg += '</g>';
  }
  // 基线
  svg += '<line x1="' + padL + '" y1="' + H + '" x2="' + (W - padR) + '" y2="' + H + '" stroke="var(--border-color)" stroke-width="0.5"/>';
  // 时间刻度：首/中/尾三个标签，避免拥挤
  var lblY = H + 12;
  function _short(s) { return s.slice(5); }  // 去掉年份
  function _hourShort(s) { return s.slice(11); }  // 只留 HH:00
  if (axis.length > 0) {
    var first = axis[0].bucket, last = axis[axis.length - 1].bucket;
    if (_cloudUsageRange === 1) {
      // 今日按小时：标首(00:00) 当前小时
      svg += '<text x="' + padL + '" y="' + lblY + '" font-size="9" fill="var(--text-muted)">' + esc(_hourShort(first)) + '</text>';
      svg += '<text x="' + (W - padR) + '" y="' + lblY + '" font-size="9" fill="var(--text-muted)" text-anchor="end">' + esc(_hourShort(last)) + '</text>';
    } else {
      // 本周按天：标首/尾日期
      svg += '<text x="' + padL + '" y="' + lblY + '" font-size="9" fill="var(--text-muted)">' + esc(_short(first)) + '</text>';
      svg += '<text x="' + (W - padR) + '" y="' + lblY + '" font-size="9" fill="var(--text-muted)" text-anchor="end">' + esc(_short(last)) + '</text>';
    }
  }
  svg += '</svg>';
  return '<div style="margin-bottom:4px">' + svg + '</div>';
}

function _cloudUsageSetRange(r) { _cloudUsageRange = r; loadCloudUsage(); }
window.loadCloudUsage = loadCloudUsage;
window._cloudUsageSetRange = _cloudUsageSetRange;

var _capsTimer = null;  // P8-3: 供 window._capsTimer 兼容（模型名防抖）
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
      api_format: (document.getElementById('cloudApiFormat') || {}).value || 'openai',
    };
    var keyEl = document.getElementById('cloudApiKey');
    if (keyEl && keyEl.value) {
      var _val = keyEl.value;
      // P6 #28 修复: 输入框若是脱敏占位符(sk-***...***xxx),不要当真key发给后端测试,
      // 否则后端拿脱敏假值请求云端必然401。只有用户输入了新值才带上。
      var _isMasked = _val.indexOf('***...***') !== -1;
      if (!_isMasked) {
        body.api_key = _val;
      }
    }
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/cloud/test', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body), signal: ctrl.signal
    });
    clearTimeout(timer);
    var data = await resp.json();
    if (result) {
      if (data.ok) {
        result.textContent = '连接成功 — 延迟 ' + data.latency_ms + 'ms';
        result.className = 'success';
      } else {
        // P8-3: 报错透传——服务商原文放进 code 块（如 DeepSeek 模型名大小写 400），
        // 用户能看到真实原因而不是一句"连接失败"
        result.innerHTML = '<div style="padding:10px 14px;border-radius:8px;background:rgba(220,38,38,0.06);border:1px solid rgba(220,38,38,0.3);color:var(--danger-color,#dc2626)">' +
          '测试失败<code style="display:block;margin-top:6px;padding:6px 8px;border-radius:4px;background:rgba(220,38,38,0.08);font-size:.92em;white-space:pre-wrap">' + esc(data.error || '连接失败') + '</code></div>';
        result.className = '';
      }
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
  var fmtEl = document.getElementById('cloudApiFormat');
  var body = {};
  var baseUrl = document.getElementById('cloudBaseUrl').value.trim();
  var modelName = document.getElementById('cloudModel').value.trim();
  if (baseUrl) body.base_url = baseUrl;
  if (modelName) body.model = modelName;
  if (fmtEl) body.api_format = fmtEl.value || 'openai';
  body.context_policy = policy ? policy.value : 'full';
  body.slim_history_rounds = parseInt(rounds ? rounds.value : 6) || 6;
  body.kb_permission = kbPermEl ? kbPermEl.value : 'full';
  // P8-3: 输入上限——留空回落保守默认 32K（并明确告知），只校验正整数
  var ctxEl = document.getElementById('cloudContextWindow');
  var ctxRaw = ctxEl ? ctxEl.value.trim() : '';
  if (!ctxRaw) {
    body.context_window = 32768;
    showToast('输入上限未填，将按保守默认 32K 处理（可回设置页修改）', 'warning', 5000);
  } else {
    var ctxNum = parseInt(ctxRaw, 10);
    if (!ctxNum || ctxNum <= 0) {
      showToast('输入上限必须为正整数', 'error');
      return;
    }
    body.context_window = ctxNum;
  }
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
      // P8-3: 持久保存成功横幅（C 方案引导式迁移），替代一闪而过的 toast
      _showCloudSaveBanner(modelName);
      // P8-6：从统一状态刷新（服务端权威），同步 _cloudConfigured/_cloudModelName 等遗留全局，
      // 并保证锁卡/门禁立刻拿到新值
      if (typeof AppState !== 'undefined') {
        AppState.invalidate();
        await AppState.refresh();
      }
      if (typeof updateChatOverlay === 'function') updateChatOverlay();
      if (typeof fetchContextUsage === 'function') fetchContextUsage();
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

    // 按 category 分组（保持后端返回顺序）
    var groups = {};
    var groupOrder = [];
    for (var i = 0; i < data.tools.length; i++) {
      var tool = data.tools[i];
      var cat = tool.category || '其它';
      if (!groups[cat]) { groups[cat] = []; groupOrder.push(cat); }
      groups[cat].push(tool);
    }

    var html = '';
    for (var g = 0; g < groupOrder.length; g++) {
      var catName = groupOrder[g];
      var tools = groups[catName];
      // 分组标题
      html += '<div class="perm-group-title">' + esc(catName) + '</div>';
      // 该组下的工具
      for (var j = 0; j < tools.length; j++) {
        var t = tools[j];
        var checked = t.enabled ? 'checked' : '';
        html += '<div class="perm-item">';
        html += '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;flex:1">';
        html += '<input type="checkbox" data-tool-id="'+esc(t.tool_id)+'" '+checked+' onchange="toggleToolPermission(\''+esc(t.tool_id)+'\', this.checked, \''+esc(t.name).replace(/'/g,"\\'")+'\')" style="width:15px;height:15px;flex-shrink:0">';
        html += '<div>';
        html += '<div class="perm-name">'+esc(t.name)+'</div>';
        html += '<div class="perm-desc">'+esc(t.description)+'</div>';
        html += '</div>';
        html += '</label>';
        html += '</div>';
      }
    }
    container.innerHTML = html;
  } catch(e) {
    container.innerHTML = '<span style="color:var(--error-color)">加载失败</span>';
  }
}

async function toggleToolPermission(toolId, enabled, toolName) {
  try {
    var resp = await fetch(_apiBase + '/api/permissions/tool/' + encodeURIComponent(toolId), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({enabled: enabled})
    });
    var data = await resp.json();
    if (data.ok) {
      showToast('已' + (enabled ? '启用' : '禁用') + '「' + (toolName || toolId) + '」', 'success');
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

// ===== 缓存 / 关于 =====
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
      '<div style="margin-bottom:4px"><b>在线 AI 通信</b>：使用在线/并行模式时，对话内容（含历史上下文）会发送到你配置的在线 API 提供商（如 DeepSeek）。通信直接在你和 API 提供商之间进行，不经过第三方中转。请参阅对应 API 提供商的隐私政策。</div>' +
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
    if (typeof refreshAuditLogStats === 'function') refreshAuditLogStats();
    if (typeof loadKbAiMode === 'function') loadKbAiMode();
  } else if (tabId === 'about') {
    refreshAboutDiagnostics();
  } else if (tabId === 'privacy') {
    refreshPrivacyInfo();
  } else if (tabId === 'cloud') {
    if (typeof loadCloudConfig === 'function') loadCloudConfig();
    if (typeof loadCloudUsage === 'function') loadCloudUsage();
  } else if (tabId === 'download') {
    if (typeof loadModelCatalog === 'function') loadModelCatalog();
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
    // 缓存内存大小供快速开始推荐使用
    if (data.total_mem_gb) window._sysTotalMem = data.total_mem_gb;

    // 拉取资源信息（内存占用 + 组件状态 + 显存）
    var compEl = document.getElementById('diagComponents');
    var vramEl = document.getElementById('diagVram');
    try {
      var resResp = await fetch(_apiBase + '/api/resource-info');
      var resData = await resResp.json();

      // 组件状态点
      if (compEl && resData.modules) {
        var comps = [
          {name:'离线模型', loaded: !!(resData.modules.llm && resData.modules.llm.loaded), detail: resData.modules.llm ? resData.modules.llm.name : ''},
          {name:'向量化引擎', loaded: !!(resData.modules.embedder && resData.modules.embedder.loaded), detail: ''},
          // P6 #23: Reranker 闲置时会自动卸载省内存(使用KB时重新加载),未加载时加说明避免误判为故障
          {name:'Reranker', loaded: !!(resData.modules.reranker && resData.modules.reranker.loaded), detail: '',
           unloadedHint: '闲置已卸载，使用知识库时自动加载'},
        ];
        try {
          var cfgResp = await fetch(_apiBase + '/api/cloud/config');
          var cfgData = await cfgResp.json();
          comps.push({name:'在线 API', loaded: !!(cfgData.base_url && cfgData.model), detail: cfgData.model || ''});
        } catch(e2) {
          comps.push({name:'在线 API', loaded: false, detail: ''});
        }
        var html = '';
        for (var i = 0; i < comps.length; i++) {
          var c = comps[i];
          var dot = c.loaded ? 'comp-dot-ok' : 'comp-dot-off';
          var label = c.loaded ? '就绪' : '未加载';
          var detail = c.detail && c.loaded ? (' · ' + c.detail) : '';
          // P6 #23: 未加载且有卸载说明时,显示提示而非干巴巴的"未加载"
          if (!c.loaded && c.unloadedHint) {
            detail = '（' + c.unloadedHint + '）';
          }
          html += '<div class="comp-row"><span class="' + dot + '"></span><span class="comp-name">' + c.name + '</span><span class="comp-status">' + label + detail + '</span></div>';
        }
        compEl.innerHTML = html;
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
    var els = ['diagPython', 'diagOs', 'diagGpu', 'diagTotalMem', 'diagVram'];
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
  // CORS strict 开关状态：cors_strict=false 时勾选（语义：允许第三方访问）
  try {
    var cfgResp = await fetch(_apiBase + '/api/config');
    var cfgData = await cfgResp.json();
    var corsStrict = cfgData.config && cfgData.config.cors_strict;
    var toggle = document.getElementById('corsStrictToggle');
    if (toggle) toggle.checked = !corsStrict;  // 勾选 = 关闭严格模式 = 允许第三方
  } catch (e) {
    // 静默失败
  }
}

// ===== CORS 调试开关：切换严格模式（需重启服务生效）=====
async function toggleCorsStrict(allowThirdParty) {
  // allowThirdParty=true 表示关闭严格模式（cors_strict=false）
  // 关闭严格模式 = 允许第三方页面访问本机 API，存在安全风险，需用户确认
  if (allowThirdParty) {
    var confirmed = false;
    if (typeof showDialog === 'function') {
      confirmed = await showDialog(
        '确认开启第三方访问？',
        '开启后，任何网页都可能访问 Sidemate 的本地 API，包括读取配置、调用模型、修改设置、删除数据。请仅在开发调试时开启，使用完成后建议立即关闭。',
        {type: 'danger', confirm: true, confirmLabel: '我已了解风险，继续开启', cancelLabel: '取消'}
      );
    } else {
      confirmed = confirm('开启后，任何网页都可能访问 Sidemate 的本地 API，包括读取配置、调用模型、修改设置、删除数据。请仅在开发调试时开启。是否继续？');
    }
    if (!confirmed) {
      // 用户取消，恢复 checkbox 到关闭状态
      var toggle = document.getElementById('corsStrictToggle');
      if (toggle) toggle.checked = false;
      return;
    }
  }
  try {
    var resp = await fetch(_apiBase + '/api/config', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({cors_strict: !allowThirdParty})
    });
    var data = await resp.json();
    if (data.status === 'ok') {
      if (typeof showToast === 'function') {
        showToast(allowThirdParty ? '已允许第三方访问，重启服务后生效' : '已恢复严格模式，重启服务后生效', 'success');
      }
    } else {
      if (typeof showToast === 'function') showToast('保存失败，请重试', 'error');
      // 回滚 checkbox
      var toggle = document.getElementById('corsStrictToggle');
      if (toggle) toggle.checked = !allowThirdParty;
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('网络错误，保存失败', 'error');
    // 回滚 checkbox
    var toggle = document.getElementById('corsStrictToggle');
    if (toggle) toggle.checked = !allowThirdParty;
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
window.toggleCorsStrict = toggleCorsStrict;
// 模型管理
window.refreshResourcePanel = refreshResourcePanel;
window.refreshStatus = refreshStatus;
window.updateWarmupBtn = updateWarmupBtn;
window.handleWarmup = handleWarmup;
window.rescanModels = rescanModels;
window.handleUnload = handleUnload;
// 配置
window.loadAutoWarmupSetting = loadAutoWarmupSetting;
window.saveAutoWarmup = saveAutoWarmup;

// ===== 推理设备切换（GPU/CPU）=====
async function loadDeviceSelector() {
  var sel = document.getElementById('deviceSelector');
  if (!sel) return;
  try {
    var resp = await fetch(_apiBase + '/api/devices');
    var data = await resp.json();
    if (data.current) sel.value = data.current;
  } catch(e) { console.error('[settings.loadDeviceSelector]', e); }
}

async function switchDevice(device) {
  if (!device) return;
  if (typeof showDialog === 'function') {
    if (!(await showDialog('切换推理设备', '确定切换到 ' + (device === 'gpu' ? 'GPU' : 'CPU') + '？\n\n切换后会自动重启模型加载。', {confirm: true, confirmLabel: '切换', cancelLabel: '取消'}))) {
      // 用户取消，恢复下拉值
      loadDeviceSelector();
      return;
    }
  }
  try {
    var resp = await fetch(_apiBase + '/api/device/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: device })
    });
    var data = await resp.json();
    if (data.error) {
      if (typeof showToast === 'function') showToast('切换失败: ' + data.error, 'error');
      loadDeviceSelector();
    } else {
      if (typeof showToast === 'function') showToast(data.message || '已切换', 'success');
      // 刷新状态
      if (typeof refreshStatus === 'function') refreshStatus();
    }
  } catch(e) {
    if (typeof showToast === 'function') showToast('切换失败: ' + e.message, 'error');
    loadDeviceSelector();
  }
}

window.loadDeviceSelector = loadDeviceSelector;
window.switchDevice = switchDevice;
window.loadRerankerResidentSetting = loadRerankerResidentSetting;
window.saveRerankerResident = saveRerankerResident;
window.saveRerankerIdle = saveRerankerIdle;
window.saveKbAiMode = saveKbAiMode;
window.loadKbAiMode = loadKbAiMode;
window.loadCloudConfig = loadCloudConfig;
window.toggleApiKeyVisibility = toggleApiKeyVisibility;
window.testCloudConnection = testCloudConnection;
window.saveCloudConfig = saveCloudConfig;
window.updateTabVisibility = updateTabVisibility;
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

// ===== P7-4b: 审计日志管理（设置页） =====
async function refreshAuditLogStats() {
  var apiBase = (typeof API !== 'undefined') ? API : '';
  try {
    var resp = await fetch(apiBase + '/api/kb/audit_log/stats');
    var data = await resp.json();
    var el1 = document.getElementById('auditStatEntries');
    var el2 = document.getElementById('auditStatFiles');
    var el3 = document.getElementById('auditStatSize');
    if (el1) el1.textContent = (data.total_entries || 0) + ' 条';
    if (el2) el2.textContent = (data.total_files || 0) + ' 篇';
    if (el3) el3.textContent = (data.total_size_kb || 0) + ' KB';
  } catch (err) {
    console.warn('[audit] 统计加载失败:', err);
  }
}

async function clearAllAuditLogs() {
  if (!confirm('确定清空所有文档的审计日志？此操作不可撤销。')) return;
  var apiBase = (typeof API !== 'undefined') ? API : '';
  try {
    var resp = await fetch(apiBase + '/api/kb/audit_log/clear_all', { method: 'POST' });
    var data = await resp.json();
    if (data.ok) {
      showToast('审计日志已清空', 'success');
      refreshAuditLogStats();
    } else {
      showToast('清空失败', 'error');
    }
  } catch (err) {
    showToast('清空失败: ' + err.message, 'error');
  }
}

window.refreshAuditLogStats = refreshAuditLogStats;
window.clearAllAuditLogs = clearAllAuditLogs;

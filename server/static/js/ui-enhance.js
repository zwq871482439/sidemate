// ===== ui-enhance.js — UI 增强模块 (Patch5 C7 T02) =====
// 挂载到 window: MessageStyleManager, CodeBlockEnhancer, toggleCodeCollapse, initUiEnhance

// ============================================================
//  MessageStyleManager — 消息样式切换（气泡/列表）
// ============================================================

var MessageStyleManager = {
  // localStorage key
  MODE_KEY: 'sidemate_msg_mode',

  /**
   * 获取当前模式
   * @returns {string} "bubble" | "list"
   */
  getMode: function() {
    try {
      var mode = localStorage.getItem(this.MODE_KEY);
      return mode === 'list' ? 'list' : 'bubble';
    } catch(e) {
      return 'bubble';
    }
  },

  /**
   * 设置模式
   * @param {string} mode - "bubble" | "list"
   */
  setMode: function(mode) {
    try {
      localStorage.setItem(this.MODE_KEY, mode === 'list' ? 'list' : 'bubble');
    } catch(e) {}
    this.applyMode();
  },

  /**
   * 切换模式
   */
  toggleMode: function() {
    var current = this.getMode();
    this.setMode(current === 'bubble' ? 'list' : 'bubble');
  },

  /**
   * 应用当前模式到 DOM（A2 论坛风列表 / E3 圆角气泡）
   */
  applyMode: function() {
    var msgs = document.getElementById('messages');
    if (!msgs) return;
    if (this.getMode() === 'list') {
      msgs.classList.add('msg-list-mode');
      msgs.classList.remove('msg-bubble-mode');
    } else {
      msgs.classList.remove('msg-list-mode');
      msgs.classList.add('msg-bubble-mode');
    }
    // 同步切换按钮的文案
    var btn = document.getElementById('msgStyleToggle');
    if (btn) {
      btn.textContent = (this.getMode() === 'list') ? '列表' : '气泡';
    }
  }
};

/**
 * 初始化消息样式切换按钮
 */
function initMsgStyleToggle() {
  var btn = document.getElementById('msgStyleToggle');
  if (!btn) return;
  btn.onclick = function() {
    MessageStyleManager.toggleMode();
  };
  // 初始应用一次
  MessageStyleManager.applyMode();
}

// ============================================================
//  CodeBlockEnhancer — 代码块增强（折叠 + 行号 + header）
// ============================================================

var CodeBlockEnhancer = {
  /**
   * 扫描 container 内的 .code-block，对没有 .code-header 的加 header
   * @param {HTMLElement} container - 容器元素
   */
  enhance: function(container) {
    if (!container) return;
    var blocks = container.querySelectorAll('.code-block');
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      // 跳过已有 header 的
      if (block.querySelector('.code-header')) continue;
      this._addHeader(block);
    }
  },

  /**
   * 给单个代码块添加 header（语言标签 + 行数 + 折叠按钮 + 复制按钮）
   * @param {HTMLElement} block - .code-block 元素
   */
  _addHeader: function(block) {
    var codeEl = block.querySelector('code');
    if (!codeEl) return;

    // 从 <code class="language-xxx"> 提取语言
    var lang = '';
    var cls = codeEl.className || '';
    var langMatch = cls.match(/language-([\w-]+)/);
    if (langMatch) {
      lang = langMatch[1];
    }
    var langLabel = lang || '代码';

    // 从代码内容 \n 计数提取行数
    var codeText = codeEl.textContent || '';
    var lineCount = codeText.split('\n').length;
    // 修正：如果最后一行为空（尾部换行），减 1
    if (codeText.endsWith('\n')) lineCount--;
    if (lineCount < 1) lineCount = 1;

    // 构建 header（P5 C7：icon 用 iconSvg()，不用 emoji）
    var collapseIcon = (typeof iconSvg === 'function') ? iconSvg('pause', 12) : '';
    var copyIcon = (typeof iconSvg === 'function') ? iconSvg('file', 12) : '';
    var header = document.createElement('div');
    header.className = 'code-header';
    header.innerHTML =
      '<span class="code-lang">' + _escText(langLabel) + '</span>' +
      '<span class="code-lines">' + lineCount + ' 行</span>' +
      '<span class="code-actions">' +
        '<button class="code-toggle" onclick="toggleCodeCollapse(this)" title="折叠/展开">' + collapseIcon + ' <span class="code-toggle-text">折叠</span></button>' +
        '<button class="code-copy-btn" onclick="copyCode(this)" title="复制代码">' + copyIcon + ' <span class="code-copy-text">复制</span></button>' +
      '</span>';

    // 插入到 <pre> 之前
    var pre = block.querySelector('pre');
    if (pre) {
      block.insertBefore(header, pre);
    } else {
      block.insertBefore(header, block.firstChild);
    }

    // 移除原有的浮动复制按钮（如果存在，已移到 header 里）
    var oldCopyBtns = block.querySelectorAll('.code-copy-btn');
    for (var oi = 0; oi < oldCopyBtns.length; oi++) {
      // 跳过 header 内的
      if (oldCopyBtns[oi].parentNode !== header) {
        if (oldCopyBtns[oi].parentNode) {
          oldCopyBtns[oi].parentNode.removeChild(oldCopyBtns[oi]);
        }
      }
    }
  }
};

/**
 * 折叠/展开代码块
 * @param {HTMLButtonElement} btn - 折叠按钮
 */
function toggleCodeCollapse(btn) {
  var block = btn.closest('.code-block');
  if (!block) return;
  var pre = block.querySelector('pre');
  if (!pre) return;
  var textEl = btn.querySelector('.code-toggle-text');
  if (pre.classList.contains('collapsed')) {
    pre.classList.remove('collapsed');
    if (textEl) textEl.textContent = '折叠';
    else btn.textContent = '折叠';
  } else {
    pre.classList.add('collapsed');
    if (textEl) textEl.textContent = '展开';
    else btn.textContent = '展开';
  }
}

/**
 * 转义文本（用于安全插入 HTML）
 * @param {string} s
 * @returns {string}
 */
function _escText(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 初始化 UI 增强（消息样式切换 + 应用已有模式）
 */
function initUiEnhance() {
  initMsgStyleToggle();
  // 应用已保存的消息模式
  MessageStyleManager.applyMode();
}

// ============================================================
//  P6 T04: 模式确认弹窗
// ============================================================

/**
 * 显示模式切换确认弹窗
 * @param {string} mode - "offline" | "online" | "parallel"
 * @param {function} callback - callback(confirmed: boolean)
 */
function showModeConfirmModal(mode, callback) {
  // 移除已有弹窗
  var existing = document.querySelector('.modal-back');
  if (existing) existing.remove();

  var configs = {
    offline: {
      title: '切换到离线模式',
      desc: '所有数据在你本机处理，无任何信息离开你的电脑。',
      features: [
        '本地 AI 模型直接回答',
        '支持知识库完全本地检索',
        '无需联网，断网可用',
      ],
      risk: '回答质量受限于本地模型能力',
    },
    online: {
      title: '切换到在线模式',
      desc: '云端大模型联网搜索回答，你的问题会发送至云端。',
      features: [
        '云端大模型，能力更强',
        '自动联网搜索补充信息',
        '支持智能文档生成',
      ],
      risk: '你的提问内容将离开本机',
    },
    parallel: {
      title: '切换到并行模式',
      desc: '本地检索知识库+云端通用知识补充，两方答案自动融合。',
      features: [
        '本地+云端同时回答',
        '知识库文档不出本机',
        'AI 自动融合两方答案',
      ],
      risk: '你的问题会同时发给云端，但知识库文档不出本机',
    }
  };

  var cfg = configs[mode] || configs.offline;

  var featHtml = cfg.features.map(function(f) {
    return '<div class="modal-feat"><span class="modal-feat-icon"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.3"/><path d="M4 7l2.5 2.5L10 5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span>' + f + '</span></div>';
  }).join('');

  var riskHtml = cfg.risk
    ? '<div class="modal-confirm-risk"><span><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1L1 12h12L7 1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M7 5v3M7 10v0.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></span><span>' + cfg.risk + '</span></div>'
    : '';

  // P6 审计修复：新增「下次不再提示」checkbox
  var dontShowHtml = '<label class="modal-dont-show" style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-muted);margin-top:8px;cursor:pointer">' +
    '<input type="checkbox" id="modalDontShow" style="margin:0"> 下次不再提示' +
    '</label>';

  var backdrop = document.createElement('div');
  backdrop.className = 'modal-back show';
  backdrop.innerHTML =
    '<div class="modal-confirm-card">' +
    '<h3 class="modal-confirm-h3">' + cfg.title + '</h3>' +
    '<div class="modal-confirm-desc">' + cfg.desc + '</div>' +
    '<div class="modal-confirm-features">' + featHtml + '</div>' +
    riskHtml +
    dontShowHtml +
    '<div class="modal-confirm-acts">' +
    '<button class="cancel-btn">取消</button>' +
    '<button class="confirm-btn">确认切换</button>' +
    '</div>' +
    '</div>';

  backdrop.addEventListener('click', function(e) {
    if (e.target === backdrop) {
      backdrop.remove();
      if (callback) callback(false);
    }
  });

  var cancelBtn = backdrop.querySelector('.cancel-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', function() {
      backdrop.remove();
      if (callback) callback(false);
    });
  }

  var confirmBtn = backdrop.querySelector('.confirm-btn');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', function() {
      // P6 审计修复：读取「下次不再提示」状态
      var dontShowCheckbox = backdrop.querySelector('#modalDontShow');
      var dontShowAgain = dontShowCheckbox ? !!dontShowCheckbox.checked : false;
      backdrop.remove();
      if (callback) callback(true, dontShowAgain);
    });
  }

  // 挂载到对话 Tab 容器内（相对定位）
  var chatTab = document.getElementById('tab-chat');
  if (chatTab) {
    chatTab.appendChild(backdrop);
  } else {
    document.body.appendChild(backdrop);
  }
}

// ============================================================
//  P6 T04: 并行模式齿轮开关
// ============================================================

/**
 * 创建并行模式齿轮按钮（由 chat-actions.js 的 refreshActionBar 调用）
 * @param {HTMLElement} bar - actionBar 容器
 */
function _renderGearMenu(bar) {
  // 移除已有齿轮菜单
  var existing = bar.querySelector('.gear-menu');
  if (existing) return existing;

  var menu = document.createElement('div');
  menu.className = 'gear-menu';

  var btn = document.createElement('button');
  btn.className = 'gear-btn';
  btn.title = '并行模式设置';
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="2" stroke="currentColor" stroke-width="1.2"/><path d="M7 1v2M7 11v2M1 7h2M11 7h2M2.5 2.5l1.5 1.5M10 10l1.5 1.5M2.5 11.5L4 10M10 4l1.5-1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  btn.onclick = function(e) {
    e.stopPropagation();
    var dd = menu.querySelector('.gear-dropdown');
    if (dd) {
      dd.style.display = dd.style.display === 'none' ? '' : 'none';
    }
  };
  menu.appendChild(btn);

  // 下拉菜单
  var dropdown = document.createElement('div');
  dropdown.className = 'gear-dropdown';
  dropdown.style.display = 'none';

  // 读取当前 toggle 状态
  _fetchParallelConfig(function(keywordGen) {
    var toggle = document.createElement('label');
    toggle.className = 'gear-toggle';
    toggle.innerHTML =
      '<span class="gear-toggle-label">允许云端模型生成关键词</span>' +
      '<span class="gear-toggle-switch">' +
      '<input type="checkbox"' + (keywordGen ? ' checked' : '') + '>' +
      '<span class="gear-toggle-slider"></span>' +
      '</span>';

    var checkbox = toggle.querySelector('input');
    if (checkbox) {
      checkbox.addEventListener('change', function() {
        _saveParallelConfig(this.checked);
      });
    }
    dropdown.appendChild(toggle);
  });

  menu.appendChild(dropdown);

  // P6 审计修复 M4：命名 close handler 以便移除，防止多次切换累积泄漏
  var _closeGearHandler = function(e) {
    if (!menu.contains(e.target)) {
      dropdown.style.display = 'none';
    }
  };
  menu._closeGearHandler = _closeGearHandler;  // 保存引用以便卸载
  document.addEventListener('click', _closeGearHandler);

  bar.appendChild(menu);
  return menu;
}

/**
 * 从 /api/parallel/config 读取并行模式配置
 */
function _fetchParallelConfig(callback) {
  fetch((typeof API !== 'undefined' ? API : '') + '/api/parallel/config')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (callback) callback(!!data.keyword_gen);
    })
    .catch(function() {
      if (callback) callback(false);
    });
}

/**
 * 保存并行模式配置到 /api/parallel/config
 */
function _saveParallelConfig(keywordGen) {
  fetch((typeof API !== 'undefined' ? API : '') + '/api/parallel/config', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({keyword_gen: !!keywordGen})
  }).catch(function(e) {
    console.error('[parallel.config]', e);
  });
}
window.MessageStyleManager = MessageStyleManager;
window.CodeBlockEnhancer = CodeBlockEnhancer;
window.toggleCodeCollapse = toggleCodeCollapse;
window.initUiEnhance = initUiEnhance;
window.initMsgStyleToggle = initMsgStyleToggle;
window.toggleMode = function() { MessageStyleManager.toggleMode(); };
window.showModeConfirmModal = showModeConfirmModal;
window._renderGearMenu = _renderGearMenu;
window._fetchParallelConfig = _fetchParallelConfig;
window._saveParallelConfig = _saveParallelConfig;

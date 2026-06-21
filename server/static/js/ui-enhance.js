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
   * 应用当前模式到 DOM（给 #messages 加或移除 class msg-list-mode）
   */
  applyMode: function() {
    var msgs = document.getElementById('messages');
    if (!msgs) return;
    if (this.getMode() === 'list') {
      msgs.classList.add('msg-list-mode');
    } else {
      msgs.classList.remove('msg-list-mode');
    }
    // Patch5 C7：同步切换按钮的文案
    var btn = document.getElementById('msgStyleToggle');
    if (btn) {
      var label = btn.querySelector('.ms-label');
      if (label) label.textContent = (this.getMode() === 'list') ? '列表' : '气泡';
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

// window 挂载
window.MessageStyleManager = MessageStyleManager;
window.CodeBlockEnhancer = CodeBlockEnhancer;
window.toggleCodeCollapse = toggleCodeCollapse;
window.initUiEnhance = initUiEnhance;
window.initMsgStyleToggle = initMsgStyleToggle;
window.toggleMode = function() { MessageStyleManager.toggleMode(); };

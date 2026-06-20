// ===== token-estimator.js — 统一 Token 估算模块 (Patch5 C7 T02) =====
// 挂载到 window.TokenEstimator，提供实时 Token 预估显示

/**
 * TokenEstimator: 统一 Token 估算模块
 *
 * 估算公式：中文字符 / 1.5 + 非中文字符 / 4.0（向上取整）
 * 合并三源：输入文本 + 引用文档 + 上传文件
 */
var TokenEstimator = {
  // 估算常量
  CHARS_PER_TOKEN_CN: 1.5,
  CHARS_PER_TOKEN_EN: 4.0,
  // 文件大小估算：约 200 token / KB
  FILE_TOKENS_PER_KB: 200,

  /**
   * 估算单段文本的 token 数
   * @param {string} text - 输入文本
   * @returns {number} 估算 token 数
   */
  estimateTokens: function(text) {
    if (!text) return 0;
    // 区分中英文字符
    var cnChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    var otherChars = text.length - cnChars;
    // 中文 ~1.5 字/token，英文 ~4 字/token
    return Math.ceil(cnChars / this.CHARS_PER_TOKEN_CN + otherChars / this.CHARS_PER_TOKEN_EN);
  },

  /**
   * 合并三源估算（输入文本 + 引用文档 + 上传文件）
   * @returns {number} 合并后的估算 token 数
   */
  estimateTotal: function() {
    // 1. 输入框文本
    var inputText = '';
    var inputEl = document.getElementById('msgInput');
    if (inputEl) inputText = inputEl.value;

    // 2. 引用文档（_refFilePath 指向文件名，无法前端读取）
    var refTokens = 0;
    if (typeof _refFilePath !== 'undefined' && _refFilePath) {
      // 引用文档按文件名长度粗估（实际内容无法前端读取）
      refTokens = this.estimateTokens(_refFilePath);
    }

    // 3. 上传文件（按文件大小估算）
    var fileTokens = 0;
    if (typeof pendingFile !== 'undefined' && pendingFile) {
      var sizeKB = (pendingFile.size || 0) / 1024;
      fileTokens = Math.ceil(sizeKB * this.FILE_TOKENS_PER_KB);
    }

    return this.estimateTokens(inputText) + refTokens + fileTokens;
  },

  /**
   * 格式化 token 数显示
   * @param {number} n - token 数
   * @returns {string} 格式化后的字符串（>1000 显示 1.2k）
   */
  formatCount: function(n) {
    if (n > 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  },

  /**
   * 更新输入框右下角的 token 显示
   * 读取 #msgInput，写入 #tokenDisplay
   * 超 _maxPromptTokens*0.8 变橙色 class token-warn
   * 超 100% 变红色 class token-over
   */
  updateInputDisplay: function() {
    var display = document.getElementById('tokenDisplay');
    if (!display) return;

    var total = this.estimateTotal();
    var maxTokens = (typeof _maxPromptTokens !== 'undefined') ? _maxPromptTokens : 0;

    // 构建显示文本
    var text = '';
    if (total > 0) {
      text = '≈ ' + this.formatCount(total).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' tokens';
      if (maxTokens > 0) {
        text += ' / ' + this.formatCount(maxTokens);
      }
    }
    display.textContent = text;

    // 状态着色
    display.classList.remove('token-warn', 'token-over');
    if (maxTokens > 0) {
      var ratio = total / maxTokens;
      if (ratio >= 1.0) {
        display.classList.add('token-over');
      } else if (ratio >= 0.8) {
        display.classList.add('token-warn');
      }
    }
  }
};

// 防重入标志
var _tokenEstInited = false;

/**
 * 初始化 Token 估算：给 #msgInput 绑定 input 事件
 * 防重入（全局 _tokenEstInited 标志）
 */
function initTokenEstimator() {
  if (_tokenEstInited) return;
  var inputEl = document.getElementById('msgInput');
  if (!inputEl) return;
  _tokenEstInited = true;
  inputEl.addEventListener('input', function() {
    TokenEstimator.updateInputDisplay();
  });
  // 初始更新一次
  TokenEstimator.updateInputDisplay();
}

// window 挂载
window.TokenEstimator = TokenEstimator;
window.initTokenEstimator = initTokenEstimator;

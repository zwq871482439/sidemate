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
   * Patch5 用户反馈：显示"预计使用 Xk tokens · 空间充足/尚可/不足"
   */
  updateInputDisplay: function() {
    var display = document.getElementById('tokenDisplay');
    if (!display) return;

    // 分开计算文本和文档
    var textTokens = this._estimateText();
    var docTokens = this._estimateDoc();
    var total = textTokens + docTokens;
    var maxTokens = (typeof _maxPromptTokens !== 'undefined') ? _maxPromptTokens : 16000;

    // Patch5: 统一用 K 单位
    var fmtK = function(n) { return n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n); };

    var text = '';
    if (total > 0 && maxTokens > 0) {
      var ratio = total / maxTokens;
      var statusText = ratio < 0.5 ? '空间充足' : (ratio < 0.8 ? '空间尚可' : '空间不足');

      if (docTokens > 0) {
        text = '预计文本 ' + fmtK(textTokens) + ' + 文档 ' + fmtK(docTokens) + ' = ' + fmtK(total) + ' / ' + fmtK(maxTokens) + ' · ' + statusText;
      } else {
        text = '预计文本 ' + fmtK(total) + ' / ' + fmtK(maxTokens) + ' · ' + statusText;
      }
    } else if (total > 0) {
      text = '预计 ' + fmtK(total) + ' tokens';
    }
    display.textContent = text;

    // 状态着色
    display.classList.remove('token-warn', 'token-over');
    if (maxTokens > 0) {
      var ratio = total / maxTokens;
      if (ratio >= 0.8) display.classList.add('token-over');
      else if (ratio >= 0.5) display.classList.add('token-warn');
    }
  },

  _estimateText: function() {
    var inputText = '';
    var inputEl = document.getElementById('msgInput');
    if (inputEl) inputText = inputEl.value;
    return this.estimateTokens(inputText);
  },

  _estimateDoc: function() {
    // KB 引用文档
    if (typeof pendingFile !== 'undefined' && pendingFile) {
      var sizeKB = (pendingFile.size || 0) / 1024;
      return Math.ceil(sizeKB * this.FILE_TOKENS_PER_KB);
    }
    return 0;
  },
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

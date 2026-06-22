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
   * 估算单段文本的 token 数（保留供内部使用）
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
   * 格式化 token 数显示
   * @param {number} n - token 数
   * @returns {string} 格式化后的字符串（>1000 显示 1.2k）
   */
  formatCount: function(n) {
    if (n > 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  },

  /**
   * P6: 更新统一 Token 条（替代旧 tokenDisplay）
   * 读取 #msgInput，写入 #tokenBar 内的多个字段
   * 显示格式：本轮 X | + 历史 X | = X / 16K · 状态 · 对话剩余容量 X 词元
   */
  updateInputDisplay: function() {
    var tokenBar = document.getElementById('tokenBar');
    if (!tokenBar) {
      // 兼容：如果 tokenBar 不存在，回退到旧 tokenDisplay
      this._updateLegacyDisplay();
      return;
    }

    // 分开计算文本和文档
    var textTokens = this._estimateText();
    var docTokens = this._estimateDoc();
    var curTotal = textTokens + docTokens;  // 本轮（输入+文档）
    var maxTokens = (typeof _maxPromptTokens !== 'undefined') ? _maxPromptTokens : 16000;

    // 历史 token（从全局变量读取，由 chat.js 维护）
    var histTokens = 0;
    if (typeof _historyTokenCount !== 'undefined') histTokens = _historyTokenCount || 0;

    var total = curTotal + histTokens;
    var fmtK = function(n) { return n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n); };

    // 更新各字段
    var curEl = document.getElementById('tokenCur');
    var histEl = document.getElementById('tokenHist');
    var totalEl = document.getElementById('tokenTotal');
    var limitEl = document.getElementById('tokenLimit');
    var statusEl = document.getElementById('tokenStatus');
    var remainEl = document.getElementById('tokenRemain');

    if (curEl) curEl.textContent = fmtK(curTotal);
    if (histEl) histEl.textContent = fmtK(histTokens);
    if (totalEl) totalEl.textContent = '= ' + fmtK(total);
    if (limitEl) limitEl.textContent = fmtK(maxTokens);

    // 状态
    var ratio = maxTokens > 0 ? total / maxTokens : 0;
    var statusText = ratio < 0.5 ? '空间充足' : (ratio < 0.8 ? '空间尚可' : '空间不足');
    if (statusEl) {
      statusEl.textContent = statusText;
      statusEl.classList.remove('status-ok', 'status-warn', 'status-over');
      if (ratio >= 0.8) statusEl.classList.add('status-over');
      else if (ratio >= 0.5) statusEl.classList.add('status-warn');
      else statusEl.classList.add('status-ok');
    }

    // 剩余容量
    var remain = Math.max(0, maxTokens - total);
    if (remainEl) remainEl.textContent = fmtK(remain) + ' 词元';
  },

  _updateLegacyDisplay: function() {
    var display = document.getElementById('tokenDisplay');
    if (!display) return;
    var textTokens = this._estimateText();
    var docTokens = this._estimateDoc();
    var total = textTokens + docTokens;
    var maxTokens = (typeof _maxPromptTokens !== 'undefined') ? _maxPromptTokens : 16000;
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
    // Patch5 G：优先用后端算好的真实 tokens
    // 1. 普通上传：chat-files.js 预上传后 pendingFile.tokens 由 /api/file_upload 返回
    // 2. KB 引用：window._kbSelectedFiles[].file_size 粗估
    if (typeof pendingFile !== 'undefined' && pendingFile) {
      if (typeof pendingFile.tokens === 'number' && pendingFile.tokens > 0) {
        return pendingFile.tokens;
      }
      // File 对象未走预上传（不在 chat 模式或被跳过）
      if (pendingFile instanceof File || (pendingFile.size && !pendingFile.path)) {
        var sizeKB = (pendingFile.size || 0) / 1024;
        return Math.ceil(sizeKB * this.FILE_TOKENS_PER_KB);
      }
    }
    if (typeof window !== 'undefined' && window._kbSelectedFiles && window._kbSelectedFiles.length > 0) {
      var totalTokensFromChars = 0;
      var totalTokensFromSize = 0;
      for (var i = 0; i < window._kbSelectedFiles.length; i++) {
        var d = window._kbSelectedFiles[i];
        if (d.total_chars > 0) {
          totalTokensFromChars += Math.ceil((d.total_chars || 0) / 1.5);
        } else {
          totalTokensFromSize += Math.ceil((d.file_size || d.size || 0) / 1024 * this.FILE_TOKENS_PER_KB);
        }
      }
      return totalTokensFromChars + totalTokensFromSize;
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

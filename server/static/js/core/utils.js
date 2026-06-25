// ===== utils.js — 工具函数集 =====
// 依赖: api.js (fetch 已被 monkey-patch)

/**
 * SVG 图标库（离线可用，替代 emoji）
 * @param {string} name - 图标名: check | cross | warn | close | trash | doc | books | idea | book | spin | play | pause | write | think | stop | file
 * @param {string} [size='14'] - 宽高像素
 * @returns {string} 内联 SVG HTML 片段
 */
function iconSvg(name, size) {
  if (!size) size = '14';
  var icons = {
    check: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.3"/><path d="M4 7l2.5 2.5L10 5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cross: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    warn: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><path d="M7 2L1 12h12L7 2z" stroke="currentColor" stroke-width="1.2"/><path d="M7 6v2M7 10h0" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    close: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-1px"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    trash: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><path d="M2.5 3.5h9M5 3.5V2a1 1 0 011-1h2a1 1 0 011 1v1.5M6 6v4M8 6v4M3 3.5l.8 8.5a1 1 0 001 .5h4.4a1 1 0 001-.5l.8-8.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    doc: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><path d="M3.5 1.5h4.5l4 4v7a1 1 0 01-1 1H3.5a1 1 0 01-1-1v-10a1 1 0 011-1z" stroke="currentColor" stroke-width="1.2"/><path d="M8 1.5v4h4" stroke="currentColor" stroke-width="1.2"/><path d="M5 7.5h4M5 9.5h4M5 11.5h2" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>',
    books: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><rect x="1.5" y="2" width="5" height="10" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="7.5" y="2" width="5" height="10" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M4 4.5h0M4 7.5h0M10 4.5h0M10 7.5h0" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    idea: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><path d="M5.5 12.5V11h3v1.5M5 9.2A4 4 0 019.5 4a4 4 0 010 6.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M7 1v1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    book: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><path d="M2 1.5h5l3 4v7a1 1 0 01-1 1H2a.5.5 0 01-.5-.5V2a.5.5 0 01.5-.5z" stroke="currentColor" stroke-width="1.2"/><path d="M7 1.5v4h4" stroke="currentColor" stroke-width="1.2"/></svg>',
    spin: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px;animation:spin .8s linear infinite"><circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.2" stroke-dasharray="9 5"/></svg>',
    play: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 4.5v5l4-2.5-4-2.5z" fill="currentColor" stroke="none"/></svg>',
    pause: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><rect x="3.5" y="3.5" width="2.5" height="7" rx=".5" fill="currentColor"/><rect x="8" y="3.5" width="2.5" height="7" rx=".5" fill="currentColor"/></svg>',
    search: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.3"/><path d="M9 9l3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    write: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><path d="M2 10.5V12.5h2l7-7-2-2-7 7zM11.3 3.7L10.3 2.7l.7-.7a.5.5 0 01.7 0l.6.6a.5.5 0 010 .7l-.7.7z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    think: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><ellipse cx="5" cy="6" rx="3.5" ry="2.5" stroke="currentColor" stroke-width="1.2"/><ellipse cx="9" cy="6" rx="3.5" ry="2.5" stroke="currentColor" stroke-width="1.2"/><path d="M1.5 7.5c0 1 1.5 2.5 3.5 2.5M12.5 7.5c0 1-1.5 2.5-3.5 2.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>',
    stop: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.3"/><rect x="4.5" y="4.5" width="5" height="5" rx="1" fill="currentColor" stroke="none"/></svg>',
    file: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><path d="M3 1.5h5l3.5 3.5v7.5a.5.5 0 01-.5.5H3a.5.5 0 01-.5-.5V2a.5.5 0 01.5-.5z" stroke="currentColor" stroke-width="1.2"/><path d="M8 1.5v3.5h3.5" stroke="currentColor" stroke-width="1.2"/></svg>',
    chat: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><path d="M1.5 2.5h11a1 1 0 011 1v6a1 1 0 01-1 1H5l-3 2.5V11h-.5a1 1 0 01-1-1v-6a1 1 0 011-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M4 6h6M4 8.5h4" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>',
    send: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><path d="M1.5 1.5l11 5.5-11 5.5V8l7-1-7-1V1.5z" fill="currentColor" stroke="currentColor" stroke-width="0.8" stroke-linejoin="round"/></svg>',
    cloud: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><path d="M4 10a3 3 0 010-6 4 4 0 017.5 1A2.5 2.5 0 0111 10H4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    brain: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><path d="M7 2a2 2 0 00-2 2v6a2 2 0 002 2 2 2 0 002-2V4a2 2 0 00-2-2z" stroke="currentColor" stroke-width="1.2"/><path d="M5 5H3.5A1.5 1.5 0 002 6.5 1.5 1.5 0 003.5 8H5M9 5h1.5A1.5 1.5 0 0112 6.5 1.5 1.5 0 0110.5 8H9" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>',
    home: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><path d="M2 6.5L7 2l5 4.5V12a.5.5 0 01-.5.5h-3v-3h-3v3h-3a.5.5 0 01-.5-.5V6.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    lock: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><rect x="3" y="6.5" width="8" height="5.5" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M5 6.5V4.5a2 2 0 014 0v2" stroke="currentColor" stroke-width="1.2"/><circle cx="7" cy="9.2" r="0.7" fill="currentColor"/></svg>',
    light: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><path d="M5.5 12.5V11h3v1.5M5 9.2A4 4 0 019.5 4a4 4 0 010 6.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M7 1v1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    books2: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><path d="M1.5 2h4.5l3 4v7a.5.5 0 01-.5.5H1.5a.5.5 0 01-.5-.5v-9A.5.5 0 011.5 2z" stroke="currentColor" stroke-width="1.2"/><path d="M6 2v4h3" stroke="currentColor" stroke-width="1.2"/></svg>',
    refresh: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><path d="M11.5 4.5A5 5 0 102 7.5M2 2v3.5h3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" transform="translate(0,0)"/><path d="M11.5 2v3.5H8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    gear: '<svg width="'+size+'" height="'+size+'" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><circle cx="7" cy="7" r="2" stroke="currentColor" stroke-width="1.2"/><path d="M7 1v2M7 11v2M1 7h2M11 7h2M2.5 2.5l1.5 1.5M10 10l1.5 1.5M2.5 11.5L4 10M10 4l1.5-1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
  };
  return icons[name] || '';
}
window.iconSvg = iconSvg;

/**
 * HTML 转义
 * @param {string} s - 原始字符串
 * @returns {string} 转义后的安全字符串
 */
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 属性值转义（用于 onclick 等内联事件属性）
 */
function escAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 格式化 MB 值
 * @param {number} mb - 兆字节数
 * @returns {string} 格式化后的字符串
 */
function fmtMB(mb) {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  if (mb > 0) return Math.round(mb) + ' MB';
  return '0 MB';
}

/**
 * 自动调整 textarea 高度
 * @param {HTMLTextAreaElement} el - textarea 元素
 */
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

/**
 * 格式化时间（秒 → mm:ss）
 * @param {number} seconds - 秒数
 * @returns {string} 格式化后的时间字符串
 */
function formatTime(seconds) {
  if (!seconds || isNaN(seconds) || !isFinite(seconds)) return '00:00';
  var m = Math.floor(seconds / 60);
  var s = Math.floor(seconds % 60);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

/**
 * 显示加载遮罩
 * @param {string} text - 加载提示文本
 * @param {boolean} showProgress - 是否显示进度条
 */
function showLoading(text, showProgress) {
  var loadingText = document.getElementById('loadingText');
  if (!loadingText) return;
  loadingText.textContent = text || '加载中...';
  var bar = document.getElementById('loadingProgress');
  if (!bar) return;
  if (showProgress) {
    bar.style.display = 'block';
    var fill = bar.querySelector('.fill');
    fill.style.animation = 'none';
    fill.style.width = '30%';
    fill.style.animation = 'indeterminateProgress 1.5s ease-in-out infinite';
  } else {
    bar.style.display = 'none';
  }
  document.getElementById('loadingOverlay').style.display = 'flex';
}

/**
 * 隐藏加载遮罩
 */
function hideLoading() {
  var overlay = document.getElementById('loadingOverlay');
  if (overlay) overlay.style.display = 'none';
  var bar = document.getElementById('loadingProgress');
  if (bar) bar.style.display = 'none';
}

/**
 * 显示模块加载覆层（切 tab 不丢失状态）
 * @param {string} title - 标题文字，如 "纪要引擎加载中"
 * @param {string} iconType - 图标类型: "model" | "whisper" | "kb"
 * @param {string} [hint] - 底部提示文字
 */
function showModuleLoading(title, iconType, hint) {
  var overlay = document.getElementById('moduleLoadingOverlay');
  var iconEl = document.getElementById('moduleLoadingIcon');
  var titleEl = document.getElementById('moduleLoadingTitle');
  var hintEl = document.getElementById('moduleLoadingHint');
  if (!overlay) return;

  var icons = {
    model: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.3"/><path d="M12 6v6l4 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    whisper: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 3a4 4 0 0 0-4 4v4a4 4 0 0 0 8 0V7a4 4 0 0 0-4-4z" stroke="currentColor" stroke-width="1.3"/><path d="M19 11v1a7 7 0 0 1-14 0v-1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="12" y1="19" x2="12" y2="21" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="8" y1="21" x2="16" y2="21" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    kb: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.3"/><rect x="14" y="2" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.3"/><rect x="2" y="14" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.3"/><rect x="14" y="14" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.3"/></svg>'
  };

  if (iconEl) iconEl.innerHTML = icons[iconType] || icons.model;
  if (titleEl) titleEl.textContent = title || '加载中';
  if (hintEl) hintEl.textContent = hint || '首次加载约需 10-30 秒';
  overlay.style.display = 'flex';
}

/**
 * 隐藏模块加载覆层
 */
function hideModuleLoading() {
  var overlay = document.getElementById('moduleLoadingOverlay');
  if (overlay) overlay.style.display = 'none';
}

// ===== LaTeX 渲染工具 =====

/**
 * 渲染单个 LaTeX 公式
 * @param {string} latex - LaTeX 源码
 * @param {boolean} displayMode - 是否为 display 模式
 * @returns {string} 渲染后的 HTML
 */
function _renderLatex(latex, displayMode) {
  if (typeof katex !== 'undefined') {
    try {
      return katex.renderToString(latex, {
        displayMode: displayMode,
        throwOnError: false,
        output: 'htmlAndMathml'
      });
    } catch(e) {}
  }
  return esc(latex);
}

/**
 * 提取并渲染 LaTeX 公式（用占位符保护）
 * @param {string} text - 原始文本
 * @returns {object} { text: 处理后文本, placeholders: 占位符数组 }
 */
function _extractAndRenderLatex(text) {
  var placeholders = [];
  // 先处理 $$...$$ (display mode)
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, function(m, latex) {
    placeholders.push('<div class="latex-display">' + _renderLatex(latex.trim(), true) + '</div>');
    return '\x01LX' + (placeholders.length - 1) + '\x01';
  });
  // 再处理 $...$ (inline)
  text = text.replace(/\$([^\$\n]+?)\$/g, function(m, latex) {
    placeholders.push('<span class="latex-inline">' + _renderLatex(latex.trim(), false) + '</span>');
    return '\x01LX' + (placeholders.length - 1) + '\x01';
  });
  return { text: text, placeholders: placeholders };
}

/**
 * 恢复 LaTeX 占位符为渲染后的 HTML
 * @param {string} text - 含占位符的文本
 * @param {Array} placeholders - 占位符数组
 * @returns {string} 最终 HTML
 */
function _restoreLatex(text, placeholders) {
  return text.replace(/\x01LX(\d+)\x01/g, function(m, idx) {
    return placeholders[parseInt(idx)] || m;
  });
}

/**
 * Markdown → HTML（使用 marked.js 增强渲染，流式安全）
 * 支持：表格、任务列表、脚注、图片、删除线、水平线、嵌套列表、代码高亮
 * @param {string} text - Markdown 源码
 * @returns {string} HTML
 */

// P6: Mermaid 初始化 + 异步渲染
if (typeof mermaid !== 'undefined') {
  mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose', fontFamily: 'inherit' });
}

function _renderMermaid(el) {
  if (!el || typeof mermaid === 'undefined') return;
  var containers = el.querySelectorAll('.mermaid-container:not([data-rendered])');
  containers.forEach(function(container) {
    var code = decodeURIComponent(container.getAttribute('data-mermaid') || '');
    if (!code) return;
    container.setAttribute('data-rendered', '1');
    try {
      var id = container.id || ('mermaid-' + Math.random().toString(36).slice(2, 10));
      mermaid.render(id, code).then(function(result) {
        container.innerHTML = result.svg;
      }).catch(function(err) {
        container.innerHTML = '<pre style="color:var(--error-color);font-size:11px">mermaid 渲染失败: ' + esc(String(err.message || err).slice(0, 100)) + '</pre>';
      });
    } catch(err) {
      container.innerHTML = '<pre style="font-size:11px">' + esc(code) + '</pre>';
    }
  });
}
window._renderMermaid = _renderMermaid;

// P6: HTML 预览——iframe 沙箱渲染
function _renderHtmlPreview(el) {
  if (!el) return;
  var containers = el.querySelectorAll('.html-preview-wrap:not([data-rendered])');
  containers.forEach(function(container) {
    var code = decodeURIComponent(container.getAttribute('data-html') || '');
    if (!code) return;
    container.setAttribute('data-rendered', '1');
    // 创建 iframe 沙箱
    var iframe = document.createElement('iframe');
    iframe.sandbox = 'allow-same-origin';
    iframe.style.cssText = 'width:100%;border:none;border-radius:6px;background:#fff';
    container.innerHTML = '';
    container.appendChild(iframe);
    // 自适应高度
    iframe.onload = function() {
      try {
        var h = iframe.contentWindow.document.body.scrollHeight;
        iframe.style.height = Math.min(h + 20, 600) + 'px';
      } catch(e) {
        iframe.style.height = '300px';
      }
    };
    // 写入 HTML（沙箱内无 JS 执行权限）
    var doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write('<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;padding:12px;color:#1F2937}*{box-sizing:border-box}</style></head><body>' + code + '</body></html>');
    doc.close();
  });
}
window._renderHtmlPreview = _renderHtmlPreview;

function md(text, sanitize) {
  if (!text) return '';
  // sanitize 默认 true（完整内容净化）；流式渲染时传 false 避免吃掉半截 HTML
  if (sanitize === undefined) sanitize = true;

  // Step 1: 提取 LaTeX 公式（用占位符保护，防止 marked 破坏 LaTeX 语法）
  var processed = _extractAndRenderLatex(text);
  var latexPlaceholders = processed.placeholders;
  text = processed.text;

  // Step 2: 配置 marked（如果可用）
  if (typeof marked === 'undefined') {
    return _mdFallback(text, latexPlaceholders);
  }

  // 自定义 renderer：代码块高亮 + 复制按钮
  var renderer = new marked.Renderer();
  renderer.code = function(obj) {
    // marked v15 传入对象 {text, lang, escaped}
    var code = (typeof obj === 'object' && obj.text !== undefined) ? obj.text : obj;
    var lang = (typeof obj === 'object' && obj.lang !== undefined) ? obj.lang : arguments[1];
    // P6: mermaid 代码块——渲染成 mermaid 容器（异步渲染由 _renderMermaid 处理）
    if (lang === 'mermaid') {
      var mermaidId = 'mermaid-' + Math.random().toString(36).slice(2, 10);
      var safeGraph = esc(code);
      // 存储到全局，供 _renderMermaid 异步渲染
      if (!window._mermaidQueue) window._mermaidQueue = {};
      window._mermaidQueue[mermaidId] = code;
      return '<div class="mermaid-container" id="' + mermaidId + '" data-mermaid="' + encodeURIComponent(code) + '"><div class="mermaid-loading">渲染图表中...</div></div>';
    }
    // P6: HTML 代码块——渲染成 iframe 沙箱预览（可折叠查看源码）
    if (lang === 'html') {
      var htmlId = 'html-preview-' + Math.random().toString(36).slice(2, 10);
      return '<div class="html-preview-wrap" id="' + htmlId + '" data-html="' + encodeURIComponent(code) + '"><div class="html-preview-loading">渲染中...</div></div>';
    }
    var cls = lang ? ' class="language-' + esc(lang) + '"' : '';
    // 先转义 HTML 特殊字符（防止 hljs 报 "unescaped HTML" 安全警告）
    var safeCode = esc(code);
    var highlighted = safeCode;
    if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
      try { highlighted = hljs.highlight(safeCode, {language: lang}).value; } catch(e) {}
    } else if (typeof hljs !== 'undefined') {
      try { highlighted = hljs.highlightAuto(safeCode).value; } catch(e) {}
    }
    // Patch5 C7: 纯净结构（header + 复制按钮由 CodeBlockEnhancer.enhance() 动态注入）
    return '<div class="code-block"><pre><code' + cls + '>' + highlighted + '</code></pre></div>';
  };

  // 自定义 heading：加 id 用于锚点
  renderer.heading = function(obj) {
    var hText = (typeof obj === 'object') ? obj.text : obj;
    var depth = (typeof obj === 'object') ? obj.depth : arguments[1];
    var slug = hText.replace(/<[^>]+>/g, '').replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    return '<h' + depth + ' id="' + escAttr(slug) + '">' + hText + '</h' + depth + '>';
  };

  // 任务列表：marked v15 的 listitem 接收 tokens
  // 但 marked 已经内置了 checkbox 渲染，我们只加 class 即可
  // 由于 listitem API 在 v15 中不稳定，使用后处理替代

  // 配置 marked
  var options = {
    renderer: renderer,
    gfm: true,
    breaks: true,
    pedantic: false
  };

  // Step 3: 流式安全处理（未闭合的代码块）
  var hasUnclosedCode = text.match(/```/g) && (text.match(/```/g).length % 2 !== 0);
  if (hasUnclosedCode) {
    text = text + '\n```';
  }

  // Step 4: 使用 marked 渲染
  var html;
  try {
    html = marked.parse(text, options);
  } catch(e) {
    return _mdFallback(processed.text, latexPlaceholders);
  }

  // Step 5: 后处理

  // 5a: 任务列表样式增强（marked 已渲染 checkbox，加 class）
  html = html.replace(/<li><input (checked="" )?disabled="" type="checkbox">/g, function(m, checked) {
    var chkAttr = checked ? ' checked' : '';
    return '<li class="task-item"><input type="checkbox" class="task-checkbox" disabled' + chkAttr + '><span class="task-text">';
  });
  // 关闭 task-text span（在 task-item 的 </li> 前）
  html = html.replace(/(<li class="task-item">[\s\S]*?<span class="task-text">)([\s\S]*?)(<\/li>)/g, function(m, open, content, close) {
    return open + content + '</span>' + close;
  });

  // 5b: 脚注处理（marked v15 不原生支持 footnotes）
  html = _renderFootnotesFallback(html, text);

  // 5c: 表格样式优化（marked 可能不加 thead/tbody 的额外 class）
  // 已经有 .md table CSS 覆盖

  // Step 6: 恢复 LaTeX 占位符
  html = _restoreLatex(html, latexPlaceholders);

  // Step 7: 清理
  html = html.replace(/<\/?p>\s*<\/?p>/g, '');
  html = html.replace(/<h[1-6]><\/h[1-6]>/g, '');

  // Step 6: DOMPurify 净化（仅非流式调用时，防 XSS）
  if (sanitize && typeof DOMPurify !== 'undefined') {
    html = DOMPurify.sanitize(html, {
      ADD_TAGS: ['details', 'summary', 'sup', 'style', 'foreignObject', 'span', 'path', 'rect', 'circle', 'line', 'text', 'g', 'svg', 'polyline', 'polygon', 'ellipse', 'defs', 'marker', 'use', 'tspan'],
      ADD_ATTR: ['target', 'class', 'id', 'onclick', 'data-mermaid', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'points', 'transform', 'viewBox', 'xmlns', 'xlink:href', 'href', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline', 'marker-end', 'marker-start', 'refX', 'refY', 'markerWidth', 'markerHeight', 'orient', 'overflow'],
      ALLOW_DATA_ATTR: true
    });
  }

  return html;
}

/**
 * 脚注后处理兜底（marked v15 不内置 footnotes）
 * marked 可能将 [^id] 原样保留，也可能将 [^id]: url 解析为链接引用
 * 情况1: HTML 中有 [^id] 文本 → 直接替换
 * 情况2: HTML 中有 <a href="...">^id</a> → 替换 <a> 标签
 */
function _renderFootnotesFallback(html, rawText) {
  if (html.indexOf('md-footnotes') !== -1) return html;

  // 从原始 markdown 中提取脚注定义
  var footnotes = [];
  var fnDefRegex = /^\[\^(\w+)\]:\s+(.+)$/gm;
  var m;
  while ((m = fnDefRegex.exec(rawText)) !== null) {
    footnotes.push({ id: m[1], text: m[2] });
  }

  if (footnotes.length === 0) return html;

  // 替换脚注引用为上标
  footnotes.forEach(function(fn) {
    // 情况1: marked 原样保留 [^id] 文本
    var literalRegex = new RegExp('\\[\\^' + escAttr(fn.id) + '\\]', 'g');
    if (literalRegex.test(html)) {
      html = html.replace(new RegExp('\\[\\^' + escAttr(fn.id) + '\\]', 'g'),
        '<sup class="fn-ref"><a href="#fn-' + escAttr(fn.id) + '">[' + esc(fn.id) + ']</a></sup>');
    } else {
      // 情况2: marked 将 [^id]: ... 解析为链接引用，渲染为 <a href="...">^id</a>
      html = html.replace(new RegExp('<a href="[^"]*">\\^' + escAttr(fn.id) + '<\\/a>', 'g'),
        '<sup class="fn-ref"><a href="#fn-' + escAttr(fn.id) + '">[' + esc(fn.id) + ']</a></sup>');
    }
  });

  // 移除脚注定义段落（marked 可能已消费掉，也可能渲染为 <p>[^id]: ...</p>）
  footnotes.forEach(function(fn) {
    html = html.replace(new RegExp('<p>\\[\\^' + escAttr(fn.id) + '\\]:\\s*[\\s\\S]*?<\\/p>', 'g'), '');
  });

  // 追加脚注列表
  var fnHtml = '<section class="md-footnotes"><hr><ol>';
  footnotes.forEach(function(fn) {
    fnHtml += '<li id="fn-' + escAttr(fn.id) + '">' + esc(fn.text) + ' <a href="#fnref-' + escAttr(fn.id) + '" class="fn-backref">&#8617;</a></li>';
  });
  fnHtml += '</ol></section>';

  return html + fnHtml;
}

/**
 * 基础 Markdown 回退渲染（marked 未加载时使用）
 * 保留原始正则逻辑作为降级方案
 */
function _mdFallback(text, latexPlaceholders) {
  // 代码块保护
  var codeBlocks = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, function(_, lang, code) {
    var cls = lang ? 'language-' + lang : '';
    var idx = codeBlocks.length;
    codeBlocks.push('<div class="code-block"><pre><code class="' + cls + '">' + esc(code.trimEnd()) + '</code></pre></div>');
    return '\x02CB' + idx + '\x02';
  });
  text = text.replace(/```(\w*)\n([\s\S]*)$/g, function(_, lang, code) {
    var cls = lang ? 'language-' + lang : '';
    var idx = codeBlocks.length;
    codeBlocks.push('<div class="code-block"><pre><code class="' + cls + '">' + esc(code.trimEnd()) + '</code></pre></div>');
    return '\x02CB' + idx + '\x02';
  });
  text = text.replace(/```(\w*)$/gm, function(_, lang) {
    var cls = lang ? 'language-' + lang : '';
    var idx = codeBlocks.length;
    codeBlocks.push('<div class="code-block"><pre><code class="' + cls + '">');
    return '\x02CB' + idx + '\x02';
  });
  // 行内代码（用 esc() 防止代码内容中的 HTML 注入）
  text = text.replace(/`([^`\n]+)`/g, function(_, code) { return '<code>' + esc(code) + '</code>'; });
  // 粗体/斜体（用 esc() 防止注入）
  text = text.replace(/\*\*(.+?)\*\*/g, function(_, t) { return '<strong>' + esc(t) + '</strong>'; });
  text = text.replace(/\*(.+?)\*/g, function(_, t) { return '<em>' + esc(t) + '</em>'; });
  // 标题（用 esc() 防止注入）
  text = text.replace(/^### (.+)$/gm, function(_, t) { return '<h3>' + esc(t) + '</h3>'; });
  text = text.replace(/^## (.+)$/gm, function(_, t) { return '<h2>' + esc(t) + '</h2>'; });
  text = text.replace(/^# (.+)$/gm, function(_, t) { return '<h1>' + esc(t) + '</h1>'; });
  // 有序列表
  text = text.replace(/^\d+\. (.+)$/gm, function(_, t) { return '<li>' + esc(t) + '</li>'; });
  // 无序列表
  text = text.replace(/^[-*] (.+)$/gm, function(_, t) { return '<li>' + esc(t) + '</li>'; });
  // 合并连续 <li> 为 <ul>
  text = text.replace(/((?:<li>[\s\S]*?<\/li>\s*)+)/g, function(m) {
    return '<ul>' + m.replace(/<\/li>\s+<li>/g, '</li><li>') + '</ul>';
  });
  // 引用
  text = text.replace(/^> (.+)$/gm, function(_, t) { return '<blockquote>' + esc(t) + '</blockquote>'; });
  // 链接（过滤 javascript: 协议，用 esc() 转义）
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(_, linkText, url) {
    var safeUrl = url.trim();
    if (/^javascript:/i.test(safeUrl)) safeUrl = '#blocked';
    return '<a href="' + esc(safeUrl) + '" target="_blank">' + esc(linkText) + '</a>';
  });
  // 段落分隔
  text = text.replace(/^[ \t]+$/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/\n\n+/g, '</p><p>');
  text = text.replace(/\n/g, '<br>');
  // 清理
  text = text.replace(/<p>\s*<\/p>/g, '');
  text = text.replace(/<br>\s*<br>/g, '<br>');
  text = text.replace(/<br>\s*(<strong>)/g, '$1');
  text = text.replace(/(<\/strong>)\s*<br>\s*(<li>|<ul>)/g, '$1$2');
  // 恢复代码块占位符
  text = text.replace(/\x02CB(\d+)\x02/g, function(_, idx) {
    return codeBlocks[parseInt(idx)] || '';
  });
  // 恢复 LaTeX 占位符
  text = _restoreLatex(text, latexPlaceholders);
  var result = '<p>' + text + '</p>';
  return result === '<p></p>' ? '' : result;
}

/**
 * 渲染文件卡片 HTML
 * @param {object} file - 文件对象 { icon, filename, path, size_human, download_url }
 * @returns {string} HTML
 */
function renderFileCard(file) {
  return '<div class="file-card">' +
    '<span class="file-card-icon">' + (file.icon || iconSvg('doc','16')) + '</span>' +
    '<div class="file-card-info">' +
      '<div class="file-card-name" title="' + esc(file.filename || file.path || '') + '">' + esc(file.filename || file.path || '文件') + '</div>' +
      '<div class="file-card-size">' + esc(file.size_human || '') + '</div>' +
    '</div>' +
    '<div class="file-card-actions">' +
      '<button onclick="saveFileAs(\'' + esc(file.download_url || '') + '\', \'' + esc(file.filename || '') + '\')">' + iconSvg('file','12') + ' 另存为</button>' +
      '<button onclick="downloadFile(\'' + esc(file.download_url || '') + '\', \'' + esc(file.filename || '') + '\')">' + iconSvg('file','12') + ' 下载</button>' +
    '</div>' +
  '</div>';
}

/**
 * 渲染多个文件卡片
 * @param {Array} files - 文件数组
 * @returns {string} HTML
 */
function renderFileCards(files) {
  if (!files || !files.length) return '';
  return '<div class="file-card-list">' + files.map(function(f) { return renderFileCard(f); }).join('') + '</div>';
}

/**
 * 下载文件（直接下载）
 * @param {string} url - 下载 URL
 * @param {string} filename - 文件名
 */
function downloadFile(url, filename) {
  if (!url) return;
  var a = document.createElement('a');
  a.href = (typeof API !== 'undefined' ? API : '') + url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * 格式化统计行（不用 md，避免 code 标签干扰）
 */
function formatStats(model, chars, thinkChars, time, speed) {
  var s = '<div class="stats">';
  s += '<span>' + esc(model) + '</span> ';
  s += '<span>' + chars + '字</span> ';
  if (thinkChars > 0) s += '<span>深思' + thinkChars + '字</span> ';
  s += '<span>' + Number(time).toFixed(1) + 's</span> ';
  s += '<span>' + Math.round(speed) + '字/s</span>';
  s += '</div>';
  return s;
}

/**
 * 复制代码块内容到剪贴板
 * @param {HTMLButtonElement} btn - 复制按钮元素
 */
function copyCode(btn) {
  var block = btn.closest('.code-block');
  if (!block) return;
  var code = block.querySelector('code');
  if (!code) return;
  var text = code.textContent || '';
  // P5 C7：保留按钮内部结构（icon + 文本）
  var textEl = btn.querySelector('.code-copy-text');
  var _setBtnText = function(t) {
    if (textEl) textEl.textContent = t;
    else btn.textContent = t;
  };
  var _restoreBtn = function(orig) {
    return function() { _setBtnText(orig); };
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    var orig1 = textEl ? textEl.textContent : btn.textContent;
    navigator.clipboard.writeText(text).then(function() {
      _setBtnText('已复制');
      setTimeout(_restoreBtn(orig1), 1500);
    }).catch(function() {
      fallbackCopy(text, btn);
    });
  } else {
    fallbackCopy(text, btn);
  }
}

function fallbackCopy(text, btn) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    var textEl = btn.querySelector('.code-copy-text');
    var orig = textEl ? textEl.textContent : btn.textContent;
    if (textEl) textEl.textContent = '已复制';
    else btn.textContent = '已复制';
    setTimeout(function() {
      if (textEl) textEl.textContent = orig;
      else btn.textContent = orig;
    }, 1500);
  } catch(e) {}
  document.body.removeChild(ta);
}

/**
 * 创建 Blob 并触发下载
 * @param {string} content - 文件内容
 * @param {string} filename - 文件名
 * @param {string} mimeType - MIME 类型
 */
function downloadBlob(content, filename, mimeType) {
  var blob = new Blob([content], { type: mimeType || 'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 3000);
}

// 暴露到全局
window.esc = esc;
window.escAttr = escAttr;
window.fmtMB = fmtMB;
window.autoResize = autoResize;
window.formatTime = formatTime;
window.showLoading = showLoading;
window.hideLoading = hideLoading;
window._renderLatex = _renderLatex;
window._extractAndRenderLatex = _extractAndRenderLatex;
window._restoreLatex = _restoreLatex;
window.md = md;
window.renderFileCard = renderFileCard;
window.renderFileCards = renderFileCards;
window.downloadFile = downloadFile;
window.formatStats = formatStats;
window.copyCode = copyCode;
window.downloadBlob = downloadBlob;

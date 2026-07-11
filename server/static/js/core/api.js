// ===== api.js — fetch 超时封装 + 全局 monkey-patch =====
// 所有 JS 文件通过传统 <script> 标签引入，共享全局作用域（window）

var _originalFetch = window.fetch;
var _DEFAULT_FETCH_TIMEOUT = 10000; // 10秒

/**
 * 带 timeout 的 fetch 封装
 * @param {string} url - 请求 URL
 * @param {object} options - fetch 选项
 * @param {number} timeout - 超时毫秒数，<=0 跳过
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(url, options, timeout) {
  if (options === undefined) options = {};
  if (timeout === undefined) timeout = _DEFAULT_FETCH_TIMEOUT;
  if (timeout <= 0) return _originalFetch(url, options); // SSE 流式跳过
  var controller = new AbortController();
  var id = setTimeout(function() { controller.abort(); }, timeout);
  // 如果已有 signal，需要链接
  var origSignal = options.signal;
  if (origSignal) {
    origSignal.addEventListener('abort', function() { controller.abort(); });
  }
  return _originalFetch(url, Object.assign({}, options, { signal: controller.signal }))
    .then(function(resp) { clearTimeout(id); return resp; })
    .catch(function(e) {
      clearTimeout(id);
      if (e.name === 'AbortError') {
        throw new Error('请求超时 (' + (timeout / 1000) + 's)');
      }
      throw e;
    });
}

// 暴露到全局
window._originalFetch = _originalFetch;
window._DEFAULT_FETCH_TIMEOUT = _DEFAULT_FETCH_TIMEOUT;
window.fetchWithTimeout = fetchWithTimeout;

// ===== API 路径辅助函数 =====
function apiUrl(path) { return (typeof API !== 'undefined' ? API : '') + path; }
window.apiUrl = apiUrl;

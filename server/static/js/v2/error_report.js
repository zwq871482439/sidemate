// 前端错误上报（sidemate-dev#22）：window.onerror / unhandledrejection → 服务端日志。
// 独立小脚本、不经 esbuild 打包（要在 bundle 加载前就位、也要能捕获 bundle 加载错误），
// 与 tour.js 同款加载方式（index.html <script> 直引）。
// 纪律：只报 错误信息/文件/行号/bundle 指纹，不采集任何用户内容；
// 限流：同一条错误（kind+message+file:line）60 秒内只报一次；上报失败静默。
(function () {
  'use strict';
  var SEEN = {};
  function _fingerprint() {
    try {
      var sc = document.querySelector('script[src*="bundle.js"]');
      var m = sc && (sc.src || '').match(/[?&]v=([a-f0-9]+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }
  function report(kind, message, file, line) {
    try {
      message = String(message || '').slice(0, 300);
      file = String(file || '').slice(0, 200);
      var key = kind + '|' + message + '|' + file + ':' + (line || 0);
      var now = Date.now();
      if (SEEN[key] && now - SEEN[key] < 60000) return;  // 同条错误 60s 一次
      SEEN[key] = now;
      fetch('/api/diagnostics/frontend-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: kind, message: message, file: file,
          line: line || 0, bundle: _fingerprint(),
        }),
      }).catch(function () { /* 静默 */ });
    } catch (e) { /* 上报自身绝不抛 */ }
  }
  window.__smReportError = function (msg) { report('manual', msg, '', 0); };
  window.addEventListener('error', function (e) {
    if (e && e.message) report('error', e.message, e.filename, e.lineno);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    var msg = r && (r.stack || r.message) ? (r.message || r.stack) : String(r);
    report('unhandledrejection', msg, '', 0);
  });
})();

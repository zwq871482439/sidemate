// app-state.js — P8-6: 统一应用状态（服务端唯一权威 + 前端单点派生）
//
// 设计：状态只在服务端算一次（GET /api/app-state），前端从这里派生所有视图。
// 锁卡（chatModelOverlay）、modelTag none 类、发送门禁、KB tab 🔒、欢迎弹窗
// 全部从 derive() 的返回值渲染，不再各自拼 localStorage / 全局变量 / DOM 类名。
//
// 用法：
//   await AppState.refresh()        拉取最新状态并派生（状态变更后调用）
//   await AppState.getView()        有缓存直接用，没有则 refresh
//   AppState.invalidate()           清缓存（下次 getView 强制刷新）
//   window._appView                 最近一次派生结果（同步读取用）

var AppState = (function () {
  var _state = null;   // 服务端原始状态
  var _view = null;    // 派生视图
  var _inflight = null; // 防并发重复拉取

  function refresh() {
    if (_inflight) return _inflight;
    _inflight = fetch((typeof API !== 'undefined' ? API : '') + '/api/app-state')
      .then(function (r) { return r.json(); })
      .then(function (s) {
        _state = s;
        window._appState = s;
        // 同步遗留全局变量（过渡期兼容，③ 阶段逐步清理读取方）
        window._currentMode = s.mode;
        window._cloudConfigured = !!(s.cloud && s.cloud.configured);
        if (s.cloud && s.cloud.model) window._cloudModelName = s.cloud.model;
        _view = derive(s);
        window._appView = _view;
        return _view;
      })
      .catch(function (e) {
        console.warn('[AppState] refresh 失败:', e);
        return _view; // 失败时返回旧视图（可能为 null）
      })
      .finally(function () { _inflight = null; });
    return _inflight;
  }

  function getView() {
    if (_view) return Promise.resolve(_view);
    return refresh();
  }

  function invalidate() {
    _state = null;
    _view = null;
    window._appView = null;
  }

  // 派生表（优先级序，对应 ROADMAP P8-6）：
  //   onboard 未完成 → welcome 接管（锁卡全部不显示）
  //   cloud/parallel 未配 Key → need_cloud_key（锁卡D）
  //   cloud 已配 → 就绪
  //   local/parallel 本地已加载 → 就绪
  //   local 无已装模型但已配云端 → offline_no_model_cloud_ready（锁卡B，引导切换）
  //   local/parallel 无任何已装模型 → no_engine（锁卡C，双选）
  //   local/parallel 已装未加载 → not_loaded（锁卡A）
  function derive(s) {
    var v = {
      welcome: !s.onboard_completed,
      lock: 'none',
      engineReady: false,
      canSend: false,
      kbLocked: !(s.kb && s.kb.installed),
      mode: s.mode || 'local',
    };
    if (v.welcome) return v;

    var mode = v.mode;
    var localInstalled = !!(s.local && s.local.installed);
    var localLoaded = !!(s.local && s.local.loaded);
    var cloudReady = !!(s.cloud && s.cloud.configured);

    if ((mode === 'cloud' || mode === 'parallel') && !cloudReady) {
      v.lock = 'need_cloud_key';
      return v;
    }
    if (mode === 'cloud') {
      v.engineReady = true;
      v.canSend = true;
      return v;
    }
    // local / parallel：还需本地引擎就绪
    if (localLoaded) {
      v.engineReady = true;
      v.canSend = true;
      return v;
    }
    if (!localInstalled) {
      v.lock = (mode === 'local' && cloudReady) ? 'offline_no_model_cloud_ready' : 'no_engine';
      return v;
    }
    v.lock = 'not_loaded';
    return v;
  }

  return {
    refresh: refresh,
    getView: getView,
    invalidate: invalidate,
    derive: derive, // 导出供单测
  };
})();
window.AppState = AppState;

/**
 * StreamRenderer — Chat/KB 共用的流式渲染节流器
 *
 * 全局常量：
 *   STREAM_RENDER_INTERVAL — 默认渲染间隔（ms），Chat/KB 两边共用
 *
 * 用法：
 *   var renderer = new StreamRenderer(containerEl, {
 *     renderFn: function(el) { el.innerHTML = md(fullText); }
 *   });
 *
 *   // 每收到 token 时调用 tick()，而非直接渲染
 *   fullText += token;
 *   renderer.tick();
 *
 *   // 流结束时强制刷新
 *   renderer.finalize();
 */

// 全局渲染间隔（ms）— 统一 Chat/KB 两边的节流频率
var STREAM_RENDER_INTERVAL = 100;

function StreamRenderer(containerEl, options) {
  if (!containerEl) throw new Error('StreamRenderer: containerEl is null');
  this.el = containerEl;
  this.interval = (options && options.interval) || STREAM_RENDER_INTERVAL;
  this.renderFn = options && options.renderFn;
  this.lastRender = 0;
  this.pending = false;
  this._timer = null;
  this._finalized = false;
}

/**
 * 标记有新内容待渲染，按节流间隔决定是否立即渲染
 */
StreamRenderer.prototype.tick = function() {
  this.pending = true;
  var now = Date.now();
  var elapsed = now - this.lastRender;
  if (elapsed >= this.interval) {
    this.flush();
  } else if (!this._timer) {
    // 安排定时器在剩余间隔后触发
    var self = this;
    this._timer = setTimeout(function() {
      self._timer = null;
      self.flush();
    }, this.interval - elapsed);
  }
};

/**
 * 立即执行渲染（清空 pending 标记）
 */
StreamRenderer.prototype.flush = function() {
  if (this._timer) {
    clearTimeout(this._timer);
    this._timer = null;
  }
  if (this.pending && this.renderFn) {
    try {
      this.renderFn(this.el);
    } catch (e) {
      console.error('[StreamRenderer] renderFn error:', e);
    }
  }
  this.lastRender = Date.now();
  this.pending = false;
};

/**
 * 流结束，最终渲染（无条件刷出所有 pending 内容）
 */
StreamRenderer.prototype.finalize = function() {
  this._finalized = true;
  this.flush();
};

// ===== skeleton.js — 骨架屏渲染模块 (Patch5 C7 T02) =====
// 挂载到 window.Skeleton，替代 spinner 提供更好的加载体验

/**
 * Skeleton: 骨架屏渲染模块
 *
 * show(container, type): 在 container 顶部插入骨架屏
 * hide(container): 移除骨架屏
 */
var Skeleton = {
  /**
   * 显示骨架屏
   * @param {HTMLElement} container - 容器元素
   * @param {string} type - 骨架屏类型: "chat" | "kb"
   */
  show: function(container, type) {
    if (!container) return;
    // 先移除已有的骨架屏（防重复）
    this.hide(container);

    var wrap = document.createElement('div');
    wrap.className = 'skeleton-wrap';
    wrap.id = 'skeletonActive';

    if (type === 'chat') {
      // 对话回复骨架屏：3 行长短不一的灰色块
      wrap.innerHTML =
        '<div class="skeleton-line w-80"></div>' +
        '<div class="skeleton-line w-95"></div>' +
        '<div class="skeleton-line w-60"></div>';
    } else if (type === 'kb') {
      // 知识库搜索骨架屏
      wrap.innerHTML =
        '<div class="skeleton-line w-95"></div>' +
        '<div class="skeleton-line w-60"></div>';
    } else {
      // 默认：3 行
      wrap.innerHTML =
        '<div class="skeleton-line w-80"></div>' +
        '<div class="skeleton-line w-95"></div>' +
        '<div class="skeleton-line w-60"></div>';
    }

    // 插入到 container 顶部（prepend）
    container.insertBefore(wrap, container.firstChild);
  },

  /**
   * 隐藏骨架屏
   * @param {HTMLElement} container - 容器元素（可选，直接按 id 移除）
   */
  hide: function(container) {
    var active = document.getElementById('skeletonActive');
    if (active) {
      if (active.parentNode) {
        active.parentNode.removeChild(active);
      }
    }
  }
};

// window 挂载
window.Skeleton = Skeleton;

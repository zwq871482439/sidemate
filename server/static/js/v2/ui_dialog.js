// 桌伴 0.10 新版 UI — 内嵌对话框（替代原生 alert/confirm/prompt）
// 原生弹窗与整体视觉割裂且阻塞主线程；这里按设计系统重绘，Promise 化。
// 用法：await uiConfirm('删除？') / uiAlert('完成') / const v = await uiPrompt('名称')
import './styles.css';

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _shell(opts) {
  const ov = document.createElement('div');
  ov.className = 'dlg-overlay';
  ov.innerHTML = `
    <div class="dlg ${opts.danger ? 'dlg-danger' : ''}" role="dialog" aria-modal="true">
      ${opts.icon ? `<div class="dlg-icon">${opts.icon}</div>` : ''}
      ${opts.title ? `<div class="dlg-title">${_esc(opts.title)}</div>` : ''}
      <div class="dlg-body">${opts.html || _esc(opts.message || '')}</div>
      <div class="dlg-actions"></div>
    </div>`;
  document.body.appendChild(ov);
  // 轻入动画
  requestAnimationFrame(() => ov.classList.add('dlg-in'));
  return ov;
}

function _close(ov) {
  ov.classList.remove('dlg-in');
  setTimeout(() => ov.remove(), 140);
}

function _btn(label, kind) {
  const b = document.createElement('button');
  b.className = 'dlg-btn ' + (kind || '');
  b.textContent = label;
  return b;
}

/** 提示框（原 alert）。返回 Promise，可不等。 */
export function uiAlert(message, opts = {}) {
  return new Promise(resolve => {
    const ov = _shell({ ...opts, message });
    const ok = _btn(opts.okLabel || '知道了', 'dlg-primary');
    ok.addEventListener('click', () => { _close(ov); resolve(true); });
    ov.querySelector('.dlg-actions').appendChild(ok);
    ok.focus();
    ov.addEventListener('keydown', e => { if (e.key === 'Escape') { _close(ov); resolve(true); } });
  });
}

/** 确认框（原 confirm）。resolve(true/false)。danger=true 时主按钮红色。 */
export function uiConfirm(message, opts = {}) {
  return new Promise(resolve => {
    const ov = _shell({ ...opts, message });
    const cancel = _btn(opts.cancelLabel || '取消');
    const ok = _btn(opts.okLabel || '确定', opts.danger ? 'dlg-danger-btn' : 'dlg-primary');
    cancel.addEventListener('click', () => { _close(ov); resolve(false); });
    ok.addEventListener('click', () => { _close(ov); resolve(true); });
    const acts = ov.querySelector('.dlg-actions');
    acts.appendChild(cancel); acts.appendChild(ok);
    ok.focus();
    ov.addEventListener('keydown', e => { if (e.key === 'Escape') { _close(ov); resolve(false); } });
  });
}

/** 输入框（原 prompt）。resolve(输入值|null)。多行可传 textarea:true。 */
export function uiPrompt(message, opts = {}) {
  return new Promise(resolve => {
    const ov = _shell({
      ...opts, message,
      html: `${_esc(message || '')}${opts.textarea
        ? `<textarea class="dlg-input" rows="4" placeholder="${_esc(opts.placeholder || '')}"></textarea>`
        : `<input class="dlg-input" type="text" placeholder="${_esc(opts.placeholder || '')}" value="${_esc(opts.value || '')}">`}`,
    });
    const input = ov.querySelector('.dlg-input');
    const cancel = _btn('取消');
    const ok = _btn(opts.okLabel || '确定', 'dlg-primary');
    cancel.addEventListener('click', () => { _close(ov); resolve(null); });
    ok.addEventListener('click', () => { _close(ov); resolve(input.value.trim() || (opts.allowEmpty ? input.value : null)); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !(opts.textarea && !e.ctrlKey)) { e.preventDefault(); ok.click(); }
      if (e.key === 'Escape') { _close(ov); resolve(null); }
    });
    const acts = ov.querySelector('.dlg-actions');
    acts.appendChild(cancel); acts.appendChild(ok);
    setTimeout(() => { input.focus(); if (!opts.textarea) input.select(); }, 30);
  });
}

// 内联 onclick 等非模块环境用（模板字符串里引用）
window.uiAlert = uiAlert;
window.uiConfirm = uiConfirm;
window.uiPrompt = uiPrompt;

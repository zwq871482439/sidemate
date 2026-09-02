// 桌伴 0.10.1 新版 UI — 右视窗（M1-D：预览/文件/轨迹 三 tab）
// 本增量实装：壳 + 「文件」tab（当前会话工作区文件列表 + 绑定工作目录只读展示，真后端）。
// 「预览」随 M1-E（SVG PPT/报告）、「轨迹」随 0.9.10 调用轨迹实装，先给诚实占位。
// Escape 收起；窄屏浮层态见 styles.css body.narrow。

import { api } from './api.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function createViewer(opts) {
  // opts: { getCurrentChat() -> {name, path} | null, onImportFile(name) }
  const el = document.createElement('div');
  el.id = 'viewer';
  let open = false;
  let tab = 'files';   // preview | files | trace
  let files = null;    // null=未加载
  let filesFor = '';   // 当前列表属于哪个会话
  let wd = null;       // 工作目录：{ files, workdir, source, group } | null=未加载 | false=未绑定

  async function loadFiles() {
    const cur = opts.getCurrentChat();
    if (!cur) { files = []; filesFor = ''; wd = false; return; }
    try {
      const r = await fetch('/api/chat/' + encodeURIComponent(cur.name) + '/workspace');
      const d = await r.json();
      files = d.files || [];
      filesFor = cur.name;
    } catch (e) { files = []; filesFor = cur.name; }
    // 工作目录（M1 只读版：绑定 + 展示）
    try {
      const w = await api.listWorkdirFiles(cur.name);
      wd = w.workdir ? w : false;
    } catch (e) { wd = false; }
  }

  function render() {
    el.className = open ? 'open' : '';
    if (!open) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="vw-head">
        <button class="vw-tab ${tab === 'preview' ? 'on' : ''}" data-t="preview">预览</button>
        <button class="vw-tab ${tab === 'files' ? 'on' : ''}" data-t="files">文件</button>
        <button class="vw-tab ${tab === 'trace' ? 'on' : ''}" data-t="trace">轨迹</button>
        <button class="vw-close" title="收起（Esc）">✕</button>
      </div>
      <div class="vw-body"></div>`;
    el.querySelectorAll('.vw-tab').forEach(b =>
      b.addEventListener('click', () => { tab = b.dataset.t; renderBody(); }));
    el.querySelector('.vw-close').addEventListener('click', () => setOpen(false));
    renderBody();
  }

  function renderBody() {
    const body = el.querySelector('.vw-body');
    if (!body) return;
    if (tab === 'files') {
      if (files === null) {
        body.innerHTML = '<div class="vw-empty">加载中…</div>';
        loadFiles().then(renderBody);
        return;
      }
      let html = '';
      if (!files.length) {
        html += '<div class="vw-empty">当前会话工作区还没有文件<br><small>AI 产出的文件（文档/表格/PPT）会出现在这里</small></div>';
      } else {
        html += `<div class="vw-files">
          <div class="vw-sec">工作区文件 · ${esc(filesFor)}</div>
          ${files.map(f => `
            <a class="vw-file" href="/api/chat/${encodeURIComponent(filesFor)}/workspace/download?path=${encodeURIComponent(f.name)}" title="下载 ${esc(f.name)}">
              <span class="fi">${_icon(f.name)}</span>
              <span class="ftx"><span class="fn">${esc(f.name)}</span><span class="fm">${_fmtSize(f.size)}</span></span>
            </a>`).join('')}
        </div>`;
      }
      // 项目工作目录（只读展示：名称/大小/修改时间 + 打开文件夹；文件可引用进输入区）
      if (wd && wd.workdir) {
        const srcLabel = wd.source === 'external' ? '（项目「' + esc(wd.group) + '」）' : '（默认目录）';
        html += `<div class="vw-files vw-dir">
          <div class="vw-sec vw-dir-head"><span class="vw-dir-title">工作目录${srcLabel}</span>
            <button class="vw-dir-open" title="在资源管理器中打开">打开文件夹</button></div>
          <div class="vw-dir-path" title="${esc(wd.workdir)}">${esc(wd.workdir)}</div>
          ${wd.files.length ? wd.files.map(f => `
            <div class="vw-file vw-file-ro" title="${f.is_dir ? '目录' : '文件'}">
              <span class="fi">${f.is_dir ? '📁' : _icon(f.name)}</span>
              <span class="ftx"><span class="fn">${esc(f.name)}</span><span class="fm">${f.is_dir ? '目录' : _fmtSize(f.size) + ' · ' + esc(f.mtime)}</span></span>
              ${f.is_dir ? '' : `<button class="vw-ref" data-name="${esc(f.name)}" title="引用到输入区（复制进会话，AI 可读）">引用</button>`}
            </div>`).join('') : '<div class="vw-empty"><small>目录是空的——把材料放进去，就能在这里引用给 AI</small></div>'}
        </div>`;
      }
      body.innerHTML = html;
      const openBtn = body.querySelector('.vw-dir-open');
      if (openBtn) openBtn.addEventListener('click', async () => {
        const cur = opts.getCurrentChat();
        if (cur) { try { await api.openWorkdir(cur.name); } catch (e) { /* 失败无感 */ } }
      });
      body.querySelectorAll('.vw-ref').forEach(b =>
        b.addEventListener('click', () => {
          if (opts.onImportFile) opts.onImportFile(b.dataset.name, b);
        }));
    } else if (tab === 'preview') {
      body.innerHTML = `<div class="vw-empty">预览视窗随 PPT/报告生成实装（M1-E）<br><small>到时候 AI 逐页设计的 SVG 会实时出现在这里</small></div>`;
    } else {
      body.innerHTML = `<div class="vw-empty">调用轨迹随 0.9.10 实装<br><small>模型↔工具交替的时间线会出现在这里</small></div>`;
    }
  }

  function _fmtSize(bytes) {
    if (!bytes) return '0KB';
    if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + 'MB';
    return Math.round(bytes / 1024) + 'KB';
  }

  function _icon(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return { docx: '📄', xlsx: '📊', pptx: '📽', pdf: '📕', md: '📝', txt: '📝', html: '🌐', json: '🧾', csv: '📊' }[ext] || '📎';
  }

  function setOpen(v) {
    open = v;
    if (v) { files = null; wd = null; }  // 每次展开重新拉
    render();
  }

  // 会话切换/目录绑定变化后刷新
  function onSessionChange() { files = null; wd = null; if (open) renderBody(); }

  return {
    el,
    setOpen,
    toggle: () => setOpen(!open),
    onSessionChange,
    get isOpen() { return open; },
  };
}

// 桌伴 0.10.1 新版 UI — 右视窗（M1-D：会话/预览/文件/轨迹 四 tab）
// 「会话」tab = 会话信息管理（PLAN 1.5 三次定稿）：项目/harness 信息卡 +
//   同项目会话（点击切换，离线人肉互查载体）+ 项目目录文件（引用/上传/在资源管理器中打开）。
// 「文件」tab = 当前会话工作区（AI 产物）文件列表。
// 「预览」随 M1-E（SVG PPT/报告）、「轨迹」随 0.9.10 调用轨迹实装，先给诚实占位。
// Escape 收起；窄屏浮层态见 styles.css body.narrow。

import { api } from './api.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function createViewer(opts) {
  // opts: { getCurrentChat() -> {name, path} | null,
  //         getSessions() -> [{name, msg_count, current, group}],
  //         getHarness() -> { modeLabel, modelTag },
  //         onImportFile(name, btn), onSwitchSession(chat) }
  const el = document.createElement('div');
  el.id = 'viewer';
  let open = false;
  let tab = 'session';   // session | preview | files | trace
  let files = null;    // null=未加载（工作区文件）
  let filesFor = '';   // 当前列表属于哪个会话
  let wd = null;       // 项目目录：{ files, workdir, source, group, locked, session_count } | null=未加载
  let uploading = false;

  async function loadFiles() {
    const cur = opts.getCurrentChat();
    if (!cur) { files = []; filesFor = ''; return; }
    try {
      const r = await fetch('/api/chat/' + encodeURIComponent(cur.name) + '/workspace');
      const d = await r.json();
      files = d.files || [];
      filesFor = cur.name;
    } catch (e) { files = []; filesFor = cur.name; }
  }

  async function loadWd() {
    const cur = opts.getCurrentChat();
    if (!cur) { wd = false; return; }
    try {
      const w = await api.listWorkdirFiles(cur.name);
      wd = w.workdir ? w : false;
    } catch (e) { wd = false; }
  }

  async function loadAll() {
    await Promise.all([loadFiles(), loadWd()]);
  }

  function render() {
    el.className = open ? 'open' : '';
    if (!open) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="vw-head">
        <button class="vw-tab ${tab === 'session' ? 'on' : ''}" data-t="session">会话</button>
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

  function _harnessCard() {
    const h = opts.getHarness ? opts.getHarness() : {};
    const cur = opts.getCurrentChat();
    if (!cur) return '<div class="vw-empty">还没有会话，先开始一段对话</div>';
    const srcLabel = wd && wd.source === 'external' ? '外部目录' : '默认目录';
    const lockLabel = wd
      ? (wd.locked ? `🔒 目录已锁定（${wd.session_count} 个会话）` : '开始对话后目录将锁定')
      : '';
    return `<div class="vw-card">
      <div class="vw-card-t">项目「${esc(wd && wd.group ? wd.group : (cur.group || '日常'))}」</div>
      <div class="vw-card-r"><span class="vw-k">模式</span>${esc(h.modelTag || h.modeLabel || '')}</div>
      <div class="vw-card-r"><span class="vw-k">会话</span>${esc(cur.name)} · ${cur.msg_count || 0} 条消息</div>
      ${wd && wd.workdir ? `<div class="vw-card-r"><span class="vw-k">目录</span>${srcLabel}</div>
      <div class="vw-card-r vw-path" title="${esc(wd.workdir)}">${esc(wd.workdir)}</div>
      <div class="vw-card-r vw-lock">${lockLabel}</div>` : ''}
    </div>`;
  }

  function _sessionList() {
    const sessions = (opts.getSessions ? opts.getSessions() : []);
    const group = wd && wd.group ? wd.group : null;
    const peers = group ? sessions.filter(s => (s.group || '日常') === group) : sessions;
    if (!peers.length) return '';
    return `<div class="vw-sec">同项目会话 · ${peers.length}</div>
      <div class="vw-peers">
      ${peers.map(c => `
        <div class="vw-peer ${c.current ? 'on' : ''}" data-name="${esc(c.name)}" title="${esc(c.name)}">
          <span class="pn">${esc(c.name)}</span><span class="pm">${c.msg_count || 0} 条</span>
        </div>`).join('')}
      </div>`;
  }

  function _wdFiles() {
    if (!wd || !wd.workdir) return '';
    const srcLabel = wd.source === 'external' ? '（项目「' + esc(wd.group) + '」）' : '（默认目录）';
    return `<div class="vw-sec vw-dir-head"><span class="vw-dir-title">项目目录${srcLabel}</span>
        <span class="vw-dir-acts">
          <button class="vw-dir-open" data-a="upload" title="上传材料到项目目录">上传</button>
          <button class="vw-dir-open" data-a="open" title="在资源管理器中打开">在资源管理器中打开</button>
        </span></div>
      ${wd.files.length ? wd.files.map(f => `
        <div class="vw-file vw-file-ro" title="${f.is_dir ? '目录' : '文件'}">
          <span class="fi">${f.is_dir ? '📁' : _icon(f.name)}</span>
          <span class="ftx"><span class="fn">${esc(f.name)}</span><span class="fm">${f.is_dir ? '目录' : _fmtSize(f.size) + ' · ' + esc(f.mtime)}</span></span>
          ${f.is_dir ? '' : `<button class="vw-ref" data-name="${esc(f.name)}" title="引用到输入区（复制进会话，AI 可读）">引用</button>`}
        </div>`).join('') : '<div class="vw-empty"><small>目录是空的——点「上传」把材料放进来，就能引用给 AI</small></div>'}`;
  }

  function renderBody() {
    const body = el.querySelector('.vw-body');
    if (!body) return;
    if (tab === 'session') {
      if (wd === null) {
        body.innerHTML = '<div class="vw-empty">加载中…</div>';
        loadWd().then(renderBody);
        return;
      }
      body.innerHTML = `<div class="vw-files">
        ${_harnessCard()}
        ${_sessionList()}
        ${_wdFiles()}
      </div>
      <input type="file" class="vw-up-input" style="display:none">`;
      // 同项目会话点击切换
      body.querySelectorAll('.vw-peer').forEach(p =>
        p.addEventListener('click', () => {
          const sessions = (opts.getSessions ? opts.getSessions() : []);
          const target = sessions.find(s => s.name === p.dataset.name);
          if (target && !target.current && opts.onSwitchSession) opts.onSwitchSession(target);
        }));
      const openBtn = body.querySelector('[data-a="open"]');
      if (openBtn) openBtn.addEventListener('click', async () => {
        const cur = opts.getCurrentChat();
        if (cur) { try { await api.openWorkdir(cur.name); } catch (e) { /* 失败无感 */ } }
      });
      const upBtn = body.querySelector('[data-a="upload"]');
      const upInput = body.querySelector('.vw-up-input');
      if (upBtn && upInput) {
        upBtn.addEventListener('click', () => upInput.click());
        upInput.addEventListener('change', async () => {
          const f = upInput.files && upInput.files[0];
          upInput.value = '';
          const cur = opts.getCurrentChat();
          if (!f || !cur || uploading) return;
          uploading = true;
          upBtn.textContent = '上传中…';
          try {
            const fd = new FormData();
            fd.append('file', f);
            const resp = await fetch('/api/chats/' + encodeURIComponent(cur.name) + '/workdir/upload', { method: 'POST', body: fd });
            const d = await resp.json();
            if (d.error) alert(d.error);
          } catch (e) {
            alert('上传失败');
          }
          uploading = false;
          upBtn.textContent = '上传';
          await loadWd();
          renderBody();
        });
      }
      body.querySelectorAll('.vw-ref').forEach(b =>
        b.addEventListener('click', () => {
          if (opts.onImportFile) opts.onImportFile(b.dataset.name, b);
        }));
    } else if (tab === 'files') {
      if (files === null) {
        body.innerHTML = '<div class="vw-empty">加载中…</div>';
        loadFiles().then(renderBody);
        return;
      }
      if (!files.length) {
        body.innerHTML = '<div class="vw-empty">当前会话工作区还没有文件<br><small>AI 产出的文件（文档/表格/PPT）会出现在这里</small></div>';
        return;
      }
      body.innerHTML = `<div class="vw-files">
        <div class="vw-sec">工作区文件 · ${esc(filesFor)}</div>
        ${files.map(f => `
          <a class="vw-file" href="/api/chat/${encodeURIComponent(filesFor)}/workspace/download?path=${encodeURIComponent(f.name)}" title="下载 ${esc(f.name)}">
            <span class="fi">${_icon(f.name)}</span>
            <span class="ftx"><span class="fn">${esc(f.name)}</span><span class="fm">${_fmtSize(f.size)}</span></span>
          </a>`).join('')}
      </div>`;
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

  function setOpen(v, tabName) {
    open = v;
    if (v) {
      if (tabName) tab = tabName;
      files = null;
      wd = null;  // 每次展开重新拉
    }
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

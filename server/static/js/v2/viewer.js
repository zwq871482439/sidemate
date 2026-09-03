// 桌伴 0.10.1 新版 UI — 右视窗（会话/预览/文件/轨迹 四 tab）
// 「会话」tab = 项目信息卡（项目即文件夹，PLAN 1.5 四次定稿）：
//   项目卡（显示名可改/目录/失效态/删除项目）+ 同项目会话（点击切换）+
//   项目目录（材料区 + .sidemate 产物区；引用直读/上传/在资源管理器中打开）。
// 旧版会话（meta 无 project_dir）显示只读存档卡。
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
  //         getSessions() -> [{name, msg_count, current, project_dir, legacy}],
  //         getHarness() -> { modeLabel, modelTag },
  //         onReferenceFile(name, btn), onSwitchSession(chat),
  //         onDeleteProject(project), onRenameProject(project) }
  const el = document.createElement('div');
  el.id = 'viewer';
  let open = false;
  let tab = 'session';   // session | preview | files | trace
  let files = null;    // null=未加载（工作区文件）
  let filesFor = '';   // 当前列表属于哪个会话
  let wd = null;       // 项目：{ files, artifacts, dir, display, is_default, status } | {legacy:true} | null=未加载
  let handoff = null;  // 项目交接 {content, updated_at, source_engine, source_chat} | null
  let handoffProj = null;
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
    // 跨项目查看（侧栏 📂 点了非当前会话的项目）：只读信息态，无引用/上传
    const vp = opts.getViewedProject && opts.getViewedProject();
    if (vp) {
      try {
        wd = await api.listProjectFiles(vp.dir);
        wd._cross = true;
      } catch (e) { wd = false; }
      return;
    }
    const cur = opts.getCurrentChat();
    if (!cur) { wd = false; return; }
    try {
      wd = await api.listWorkdirFiles(cur.name);
    } catch (e) { wd = false; }
    // 项目交接（PLAN ②++：会话信息 tab 交接区）
    try {
      const h = await api.getHandoff(cur.name);
      handoff = h && h.handoff ? h.handoff : null;
      if (wd && wd.dir) handoffProj = h.project || null;
    } catch (e) { handoff = null; }
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

  function _projectCard() {
    const h = opts.getHarness ? opts.getHarness() : {};
    const cur = opts.getCurrentChat();
    if (!cur && !(wd && wd._cross)) return '<div class="vw-empty">还没有会话，先开始一段对话</div>';
    if (wd && wd.legacy) {
      return `<div class="vw-card vw-card-legacy">
        <div class="vw-card-t">🗄 旧版本会话</div>
        <div class="vw-card-r">该会话来自旧版本，已转为只读存档：可以查看、导出（会话 ⋯ 菜单）、在「文件」tab 下载产物。</div>
        <div class="vw-card-r">要聊新内容，请用「新建任务」开一个新会话。</div>
      </div>`;
    }
    const missing = wd && wd.status === 'missing';
    const cross = wd && wd._cross;
    return `<div class="vw-card">
      <div class="vw-card-t">项目「${esc(wd && wd.display ? wd.display : '默认项目')}」
        ${wd && !wd.is_default && !cross ? '<button class="vw-mini" data-a="rename" title="改显示名（不改文件夹名）">改名</button>' : ''}</div>
      ${cross ? '' : `<div class="vw-card-r"><span class="vw-k">模式</span>${esc(h.modelTag || h.modeLabel || '')}</div>
      <div class="vw-card-r"><span class="vw-k">会话</span>${esc(cur.name)} · ${cur.msg_count || 0} 条消息</div>`}
      ${wd && wd.dir ? `<div class="vw-card-r"><span class="vw-k">目录</span>${wd.is_default ? '默认项目目录' : '项目文件夹'}</div>
      <div class="vw-card-r vw-path" title="${esc(wd.dir)}">${esc(wd.dir)}</div>` : ''}
      ${missing ? '<div class="vw-card-r vw-missing">⚠️ 目录丢失——文件夹在磁盘上被删除或移动，会话只读可看</div>' : ''}
      ${wd && !wd.is_default ? '<div class="vw-card-r"><button class="vw-mini danger" data-a="delproj" title="删除项目：会话记录级联删除，目录文件永不动">删除项目…</button></div>' : ''}
    </div>`;
  }

  function _handoffSection() {
    if (!wd || wd.legacy || !wd.dir) return '';
    if (!handoff) {
      return `<div class="vw-sec vw-dir-head"><span class="vw-dir-title">交接</span>
        <span class="vw-dir-acts"><button class="vw-dir-open" data-a="handoff" title="把当前进度写进项目交接文件">生成交接</button></span></div>
        <div class="vw-empty"><small>还没有交接文件——上下文将满时生成交接，新会话自动接续</small></div>`;
    }
    return `<div class="vw-sec vw-dir-head"><span class="vw-dir-title">交接 · 更新于 ${esc(handoff.updated_at || '')}</span>
        <span class="vw-dir-acts"><button class="vw-dir-open" data-a="handoff" title="重新生成项目交接">重新生成</button></span></div>
      <div class="vw-handoff">${esc(handoff.content || '')}</div>`;
  }

  function _sessionList() {    if (!wd || wd.legacy || !wd.dir) return '';
    const sessions = (opts.getSessions ? opts.getSessions() : []);
    const peers = sessions.filter(s => s.project_dir === wd.dir);
    if (!peers.length) return '';
    return `<div class="vw-sec">同项目会话 · ${peers.length}</div>
      <div class="vw-peers">
      ${peers.map(c => `
        <div class="vw-peer ${c.current ? 'on' : ''}" data-name="${esc(c.name)}" title="${esc(c.name)}">
          <span class="pn">${esc(c.name)}</span><span class="pm">${c.msg_count || 0} 条</span>
        </div>`).join('')}
      </div>`;
  }

  function _fileRow(f, prefix, canRef) {
    return `<div class="vw-file vw-file-ro" title="${f.is_dir ? '目录' : '文件'}">
      <span class="fi">${f.is_dir ? '📁' : _icon(f.name)}</span>
      <span class="ftx"><span class="fn">${esc(f.name)}</span><span class="fm">${f.is_dir ? '目录' : _fmtSize(f.size) + ' · ' + esc(f.mtime)}</span></span>
      ${f.is_dir || !canRef ? '' : `<button class="vw-ref" data-name="${esc(prefix + f.name)}" title="引用到输入区（直读，AI 可读原文件）">引用</button>`}
    </div>`;
  }

  function _wdFiles() {
    if (!wd || wd.legacy || !wd.dir) return '';
    const cross = !!wd._cross;  // 跨项目查看：只读，不出引用/上传
    const canWrite = wd.status === 'ok' && !cross;
    const canRef = !cross && wd.status === 'ok';
    const materials = wd.files || [];
    const artifacts = wd.artifacts || [];
    return `<div class="vw-sec vw-dir-head"><span class="vw-dir-title">项目目录${cross ? '（跨项目查看·只读）' : ''}</span>
        <span class="vw-dir-acts">
          ${canWrite ? '<button class="vw-dir-open" data-a="upload" title="上传材料到项目目录">上传</button>' : ''}
          <button class="vw-dir-open" data-a="open" title="在资源管理器中打开">在资源管理器中打开</button>
        </span></div>
      <div class="vw-sub">材料</div>
      ${materials.length ? materials.map(f => _fileRow(f, '', canRef)).join('')
        : '<div class="vw-empty"><small>还没有材料——点「上传」放进来，或往文件夹里直接丢文件</small></div>'}
      <div class="vw-sub">产物（.sidemate）</div>
      ${artifacts.length ? artifacts.map(f => _fileRow(f, '.sidemate/', canRef)).join('')
        : '<div class="vw-empty"><small>AI 产出的文件会出现在这里</small></div>'}`;
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
        ${_projectCard()}
        ${_sessionList()}
        ${_handoffSection()}
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
      const renameBtn = body.querySelector('[data-a="rename"]');
      if (renameBtn) renameBtn.addEventListener('click', () => {
        if (opts.onRenameProject && wd) opts.onRenameProject(wd);
      });
      const handoffBtn = body.querySelector('[data-a="handoff"]');
      if (handoffBtn) handoffBtn.addEventListener('click', () => {
        if (opts.onGenerateHandoff) opts.onGenerateHandoff(handoffBtn);
      });
      const delBtn = body.querySelector('[data-a="delproj"]');
      if (delBtn) delBtn.addEventListener('click', () => {
        if (opts.onDeleteProject && wd) opts.onDeleteProject(wd);
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
          if (opts.onReferenceFile) opts.onReferenceFile(b.dataset.name, b);
        }));
    } else if (tab === 'files') {
      if (files === null) {
        body.innerHTML = '<div class="vw-empty">加载中…</div>';
        loadFiles().then(renderBody);
        return;
      }
      if (!files.length) {
        body.innerHTML = '<div class="vw-empty">当前会话工作区还没有文件<br><small>旧版会话的产物会出现在这里</small></div>';
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
      handoff = null;
    }
    render();
  }

  // 会话切换/项目变化后刷新
  function onSessionChange() { files = null; wd = null; handoff = null; if (open) renderBody(); }

  return {
    el,
    setOpen,
    toggle: () => setOpen(!open),
    onSessionChange,
    get isOpen() { return open; },
  };
}

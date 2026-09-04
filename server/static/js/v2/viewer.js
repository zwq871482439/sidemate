// 桌伴 0.10.1 新版 UI — 右视窗（会话/预览/文件/轨迹 四 tab）
// 「会话」tab = 项目信息卡（项目即文件夹，PLAN 1.5 四次定稿）：
//   项目卡（显示名可改/目录/失效态/删除项目）+ 同项目会话（点击切换）+
//   项目目录（材料区 + .sidemate 产物区；引用直读/上传/在资源管理器中打开）。
// 旧版会话（meta 无 project_dir）显示只读存档卡。
// 「文件」tab = 当前会话工作区（AI 产物）文件列表。
// 「预览」随 M1-E（SVG PPT/报告）、「轨迹」随 0.9.10 调用轨迹实装，先给诚实占位。
// Escape 收起；窄屏浮层态见 styles.css body.narrow。

import { api } from './api.js';
import { icon, iconSvg } from './icons.js';

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
  let carrySids = [];  // M2 选带层：本会话勾选携带的前情会话 sid 列表
  let hs = null;       // M2-3 harness 状态：{exec_mode, goal, pending_plan, external_changes, can_undo}
  let uploading = false;
  let ppt = null;      // PPT decks 回放：{ decks:[{deck,title,pages:[{n,url}],pptx,pptx_url}] } | null=未加载
  let pptLive = {};    // 流式期间即时累积：deck -> { title, pages: {n: url} }
  const pptCache = {}; // url -> svg 文本（避免每页到达时全量重拉）

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
    // M2 选带层：本会话携带的前情会话清单
    try {
      const r = await fetch('/api/chats/' + encodeURIComponent(cur.name) + '/carry');
      const d = await r.json();
      carrySids = d.sids || [];
    } catch (e) { carrySids = []; }
    // M2-3：harness 状态（计划/执行模式、任务目标、待执行计划、外部变更）
    try {
      const r2 = await fetch('/api/chats/' + encodeURIComponent(cur.name) + '/harness-state');
      hs = await r2.json();
    } catch (e) { hs = null; }
  }

  // 选带层切换：勾选/取消某条同项目会话 → POST 全量清单
  async function _toggleCarry(sid, btn) {
    const cur = opts.getCurrentChat();
    if (!cur) return;
    const next = carrySids.includes(sid)
      ? carrySids.filter(s => s !== sid)
      : carrySids.concat([sid]).slice(0, 4);
    if (btn) btn.disabled = true;
    try {
      const r = await fetch('/api/chats/' + encodeURIComponent(cur.name) + '/carry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sids: next }),
      });
      const d = await r.json();
      if (d.ok) carrySids = d.sids || [];
    } catch (e) { /* 失败保持原状 */ }
    if (btn) btn.disabled = false;
    renderBody();
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
        <div class="vw-card-t">${icon('archive')} 旧版本会话</div>
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
      ${missing ? `<div class="vw-card-r vw-missing">${icon('alertTriangle')} 目录丢失——文件夹在磁盘上被删除或移动，会话只读可看</div>` : ''}
      ${wd && !wd.is_default ? '<div class="vw-card-r"><button class="vw-mini danger" data-a="delproj" title="删除项目：会话记录级联删除，目录文件永不动">删除项目…</button></div>' : ''}
    </div>`;
  }

  // M2-3 harness 卡：写入模式切换（计划/执行）+ 任务目标 + 待执行计划 + 撤销 + 外部变更
  function _harnessSection() {
    if (!hs || hs.legacy || !hs.dir) return '';
    const isExec = hs.exec_mode === 'execute';
    const pend = hs.pending_plan || [];
    const chg = hs.external_changes;
    return `<div class="vw-sec vw-dir-head"><span class="vw-dir-title">写入与计划</span>
        <span class="vw-dir-acts">
          <span class="vw-mode-seg" title="计划模式：AI 写项目文件前先给你确认清单；执行模式：确认后直接落盘">
            <button class="vw-seg ${!isExec ? 'on' : ''}" data-m="plan">计划</button><button class="vw-seg ${isExec ? 'on' : ''}" data-m="execute">执行</button>
          </span>
        </span></div>
      ${hs.goal ? `<div class="vw-goal" title="任务目标（AI 在任务开始时记录）">${icon('target')} ${esc(hs.goal)}</div>` : ''}
      ${pend.length ? `<div class="vw-pend"><div class="vw-pend-t">待执行计划 · ${pend.length}（确认后 AI 才会真正写入）</div>
        ${pend.slice(0, 6).map(p => `<div class="vw-pend-i">${p.overwrite ? '<span class="vw-ow">覆盖</span>' : ''}${esc(p.path)}</div>`).join('')}</div>` : ''}
      ${chg ? `<div class="vw-chg">${icon('alertTriangle')} 项目目录有外部改动：${[...(chg.changed || []), ...(chg.added || []), ...(chg.removed || [])].slice(0, 4).map(esc).join('、')}${chg.total > 4 ? ' 等 ' + chg.total + ' 项' : ''}（AI 已被告知）</div>` : ''}
      ${hs.can_undo ? `<div class="vw-card-r"><button class="vw-mini" data-a="undo" title="恢复最近一次 AI 写入前的状态（覆盖→还原旧版，新建→移除）">${icon('undo')} 撤销上次写入</button></div>` : ''}`;
  }

  function _handoffSection() {    if (!wd || wd.legacy || !wd.dir) return '';
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
    return `<div class="vw-sec">同项目会话 · ${peers.length}${carrySids.length ? `<span class="vw-carry-hint">（携带 ${carrySids.length} 条前情）</span>` : ''}</div>
      <div class="vw-peers">
      ${peers.map(c => `
        <div class="vw-peer ${c.current ? 'on' : ''}" data-name="${esc(c.name)}" title="${esc(c.name)}">
          <span class="pn">${esc(c.title || c.name)}</span><span class="pm">${c.msg_count || 0} 条</span>
          ${c.current ? '' : `<button class="vw-carry ${carrySids.includes(c.name) ? 'on' : ''}" data-sid="${esc(c.name)}" title="${carrySids.includes(c.name) ? '取消携带（不再注入此会话摘要）' : '携带前情（注入此会话摘要到本会话上下文，仅在线生效）'}">携</button>`}
        </div>`).join('')}
      </div>`;
  }

  function _fileRow(f, prefix, canRef) {
    return `<div class="vw-file vw-file-ro" title="${f.is_dir ? '目录' : '文件'}">
      <span class="fi">${f.is_dir ? iconSvg('folder') : _icon(f.name)}</span>
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
        ${_harnessSection()}
        ${_sessionList()}
        ${_handoffSection()}
        ${_wdFiles()}
      </div>
      <input type="file" class="vw-up-input" style="display:none">`;
      // harness 卡：计划/执行切换 + 撤销
      body.querySelectorAll('.vw-seg').forEach(b =>
        b.addEventListener('click', async () => {
          const cur = opts.getCurrentChat();
          if (!cur || b.classList.contains('on')) return;
          try {
            await fetch('/api/chats/' + encodeURIComponent(cur.name) + '/exec-mode', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mode: b.dataset.m }),
            });
            hs = null;
            await loadWd();
            renderBody();
          } catch (e) { /* 失败无感 */ }
        }));
      const undoBtn = body.querySelector('[data-a="undo"]');
      if (undoBtn) undoBtn.addEventListener('click', async () => {
        const cur = opts.getCurrentChat();
        if (!cur) return;
        undoBtn.disabled = true;
        try {
          const r = await fetch('/api/chats/' + encodeURIComponent(cur.name) + '/undo-write', { method: 'POST' });
          const d = await r.json();
          alert(d.message || d.error || '已处理');
        } catch (e) { alert('撤销失败'); }
        hs = null; files = null;
        await loadWd();
        renderBody();
      });
      // 同项目会话点击切换；「携」按钮切换选带（不触发切换）
      body.querySelectorAll('.vw-peer').forEach(p =>
        p.addEventListener('click', () => {
          const sessions = (opts.getSessions ? opts.getSessions() : []);
          const target = sessions.find(s => s.name === p.dataset.name);
          if (target && !target.current && opts.onSwitchSession) opts.onSwitchSession(target);
        }));
      body.querySelectorAll('.vw-carry').forEach(b =>
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          _toggleCarry(b.dataset.sid, b);
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
      _renderPreview(body);
    } else {
      body.innerHTML = `<div class="vw-empty">调用轨迹随 0.9.10 实装<br><small>模型↔工具交替的时间线会出现在这里</small></div>`;
    }
  }

  // ===== 预览 tab：PPT 逐页 SVG（M1-E）=====
  // 双通道：流式期间 ppt_page 事件即时累积（pptLive）；会话切换/刷新后
  // 从 /api/chat/{chat}/ppt/pages 回放（workspace 文件是真相源）。

  async function _loadPpt() {
    const cur = opts.getCurrentChat();
    if (!cur) { ppt = { decks: [] }; return; }
    try {
      const r = await fetch('/api/chat/' + encodeURIComponent(cur.name) + '/ppt/pages');
      const d = await r.json();
      ppt = { decks: (d && d.decks) || [] };
    } catch (e) { ppt = { decks: [] }; }
  }

  function _pptMergedDecks() {
    // 回放 decks 为底，流式累积覆盖/补充
    const map = {};
    ((ppt && ppt.decks) || []).forEach(d => {
      map[d.deck] = { deck: d.deck, title: d.title, pptx: d.pptx, pptx_url: d.pptx_url, pages: {} };
      d.pages.forEach(p => { map[d.deck].pages[p.n] = p.url; });
    });
    Object.keys(pptLive).forEach(deck => {
      if (!map[deck]) map[deck] = { deck, title: deck, pptx: null, pptx_url: null, pages: {} };
      Object.keys(pptLive[deck].pages).forEach(n => { map[deck].pages[n] = pptLive[deck].pages[n]; });
    });
    return Object.values(map);
  }

  function _renderPreview(body) {
    if (ppt === null) {
      body.innerHTML = '<div class="vw-empty">加载中…</div>';
      _loadPpt().then(() => { if (tab === 'preview') renderBody(); });
      return;
    }
    const decks = _pptMergedDecks();
    if (!decks.length) {
      body.innerHTML = `<div class="vw-empty">还没有可预览的产物<br><small>AI 制作 PPT 时，逐页设计会实时出现在这里</small></div>`;
      return;
    }
    body.innerHTML = decks.map(d => {
      const nums = Object.keys(d.pages).map(Number).sort((a, b) => a - b);
      return `<div class="vw-ppt-deck">
        <div class="vw-ppt-head">
          <span class="vw-ppt-title">${icon('presentation')} ${esc(d.title)}</span>
          <span class="vw-ppt-meta">${nums.length} 页${d.pptx_url ? ` · <a class="vw-ppt-dl" href="${d.pptx_url}" download>下载 PPTX</a>` : ''}</span>
        </div>
        ${nums.map(n => `<div class="vw-ppt-page">
          <div class="vw-ppt-num">P${String(n).padStart(2, '0')}</div>
          <div class="vw-ppt-svg" data-url="${esc(d.pages[n])}"><div class="vw-empty"><small>渲染中…</small></div></div>
        </div>`).join('')}
      </div>`;
    }).join('');
    // 逐页拉 SVG 内联渲染（no-store：修复重发的同页要拿新内容）
    body.querySelectorAll('.vw-ppt-svg[data-url]').forEach(box => {
      const url = box.dataset.url;
      const draw = t => {
        box.innerHTML = t;
        const svg = box.querySelector('svg');
        if (svg) { svg.setAttribute('width', '100%'); svg.removeAttribute('height'); svg.style.height = 'auto'; }
      };
      if (pptCache[url]) { draw(pptCache[url]); return; }
      fetch(url, { cache: 'no-store' }).then(r => r.text()).then(t => {
        pptCache[url] = t;
        if (box.isConnected) draw(t);
      }).catch(() => { box.innerHTML = '<div class="vw-empty"><small>加载失败</small></div>'; });
    });
  }

  // 流式 ppt_page 事件入口（index.js 转发）
  function onPptPage(d) {
    if (!d || !d.deck || !d.page || !d.url) return;
    if (!pptLive[d.deck]) pptLive[d.deck] = { pages: {} };
    pptLive[d.deck].pages[d.page] = d.url;
    delete pptCache[d.url];  // 同页修复重发时强制重拉
    if (!open) { setOpen(true, 'preview'); return; }  // 视窗关着：自动展开切预览（首页的「亮相」时刻）
    if (tab === 'preview') renderBody();
    // 视窗开着但在别的 tab：不抢，用户自己点「预览」
  }

  function _fmtSize(bytes) {    if (!bytes) return '0KB';
    if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + 'MB';
    return Math.round(bytes / 1024) + 'KB';
  }

  function _icon(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const key = { docx: 'fileText', xlsx: 'table', pptx: 'presentation', pdf: 'fileText', md: 'fileText', txt: 'fileText', html: 'globe', json: 'receipt', csv: 'table' }[ext] || 'file';
    return iconSvg(key);
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
  function onSessionChange() {
    files = null; wd = null; handoff = null;
    ppt = null; pptLive = {}; Object.keys(pptCache).forEach(k => delete pptCache[k]);
    if (open) renderBody();
  }

  return {
    el,
    setOpen,
    toggle: () => setOpen(!open),
    onSessionChange,
    onPptPage,
    get isOpen() { return open; },
  };
}

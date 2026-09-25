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
import { uiAlert, uiConfirm } from './ui_dialog.js';

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
  let pkb = null;      // M2-5 项目知识库：{enabled, files, chunks, size_bytes, hints}
  let uploading = false;
  let ppt = null;      // PPT decks 回放：{ decks:[{deck,title,pages:[{n,url}],pptx,pptx_url}] } | null=未加载
  let docxDocs = null;  // 0.10 M1-4：精排版 docx 回放 [{deck,title,sections,section_list}] | null=未加载
  let pptLive = {};    // 流式期间即时累积：deck -> { title, pages: {n: url} }
  let htmlLive = [];   // 流式期间 doc_complete 的 HTML 报告：[{url, name}]
  let previewFile = null;  // 0.10.2 B2：预览 = 文件的 drill-down。{name, url, size, live}
  let lastPreviewName = '';  // 最近预览过的文件名：返回文件 tab 后原行仍金条定位
  const htmlCache = {}; // url -> 文本（iframe srcdoc 用；换版重发生效靠 no-store 拉新）
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
    // 各段独立 8s 超时（R2-4 教训：串行 await 里一个请求被慢生成拖住，
    // 后面的段全饿死——项目知识库区块因此整段消失）
    const T = () => AbortSignal.timeout ? { signal: AbortSignal.timeout(8000) } : {};
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
      const r = await fetch('/api/chats/' + encodeURIComponent(cur.name) + '/carry', T());
      const d = await r.json();
      carrySids = d.sids || [];
    } catch (e) { carrySids = []; }
    // M2-3：harness 状态（计划/执行模式、任务目标、待执行计划、外部变更）
    try {
      const r2 = await fetch('/api/chats/' + encodeURIComponent(cur.name) + '/harness-state', T());
      hs = await r2.json();
    } catch (e) { hs = null; }
    // M2-5：项目知识库状态（仅当前项目、非跨项目查看时）
    try {
      if (wd && wd.dir && !wd.legacy) {
        const r3 = await fetch('/api/projects/kb/status?dir=' + encodeURIComponent(wd.dir), T());
        pkb = await r3.json();
      } else { pkb = null; }
    } catch (e) { pkb = null; }
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
  // 引用胶囊同步：把 carrySids 映射为 composer attach-tray 里的 chip
  function _syncCarryChips() {
    const tray = document.querySelector('.attach-tray');
    if (!tray) return;
    tray.querySelectorAll('.carry-chip').forEach(c => c.remove());
    const sessions = opts.getSessions ? opts.getSessions() : [];
    carrySids.forEach(sid => {
      const sess = sessions.find(x => x.name === sid);
      if (!sess) return;
      const chip = document.createElement('span');
      chip.className = 'attach-chip carry-chip';
      chip.title = '引用会话前情（发送时注入摘要）';
      chip.innerHTML = '<span class="ic"><svg fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg></span> 引用：' +
        esc((sess.title || sid).slice(0, 18)) + '<span class="x" title="取消引用" data-carry-sid="' + esc(sid) + '">×</span>';
      chip.querySelector('.x').addEventListener('click', () => {
        const b2 = document.querySelector('.vw-carry[data-sid="' + sid + '"]');
        _toggleCarry(sid, b2);
      });
      tray.appendChild(chip);
    });
    tray.style.display = tray.children.length ? '' : 'none';
  }


  function render() {
    el.className = open ? 'open' : '';
    if (!open) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="vw-head">
        <button class="vw-tab ${tab === 'session' ? 'on' : ''}" data-t="session">会话</button>
        <button class="vw-tab ${tab === 'files' ? 'on' : ''}" data-t="files">文件</button>
        <button class="vw-tab ${tab === 'preview' ? 'on' : ''}" data-t="preview">预览</button>
        <button class="vw-tab ${tab === 'trace' ? 'on' : ''}" data-t="trace">轨迹</button>
        <button class="vw-close" title="收起（Esc）"><svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      </div>
      <div class="vw-body"></div>`;
    el.querySelectorAll('.vw-tab').forEach(b =>
      b.addEventListener('click', () => {
        tab = b.dataset.t;
        // B1 修复：点击即同步刷新 head 高亮（此前只重渲染 body，高亮停在旧 tab）
        el.querySelectorAll('.vw-tab').forEach(x => x.classList.toggle('on', x === b));
        renderBody();
      }));
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

  // M2-5 项目知识库区块（议题2 定稿：手动开关/两路径入库/诊断检索框/极简）
  function _pkbSection() {
    if (!wd || wd.legacy || !wd.dir || wd._cross || !pkb) return '';
    const on = pkb.enabled;
    const files = pkb.files || [];
    const hints = pkb.hints || [];
    const indexedSet = {};
    files.forEach(f => { indexedSet[f.path] = f; });
    const materials = (wd.files || []).filter(f => !f.is_dir);
    const statusLine = on
      ? `${files.length} 个文件 · ${pkb.chunks || 0} 段 · ${(pkb.size_bytes / 1024).toFixed(0)}KB`
      : '未开启';
    return `<div class="vw-sec vw-dir-head"><span class="vw-dir-title">项目知识库</span>
        <span class="vw-dir-acts">
          <button class="vw-mini ${on ? 'on' : ''}" data-a="pkb-toggle">${on ? '已开启 · 点击关闭' : '开启'}</button>
        </span></div>
      <div class="vw-pkb-note">大体量参考材料（参考书/长报告）向量化后供 AI 检索，仅在线模式生效；不进全局知识库。${on ? '（' + statusLine + '）' : ''}</div>
      ${on ? `
      <div class="vw-pkb-box">
        <div class="vw-sub">入库材料（逐文件勾选，不自动扫目录）</div>
        ${materials.length ? materials.map(f => `<div class="vw-pkb-f">
            <label><input type="checkbox" data-pkb-add="${esc(f.name)}" ${indexedSet[f.name] ? 'checked disabled' : ''}> ${esc(f.name)} <span class="vw-pkb-sz">${_fmtSize(f.size)}</span>${indexedSet[f.name] ? (indexedSet[f.name].stale ? '<span class="vw-pkb-stale">内容已变，可重建</span>' : '<span class="vw-pkb-ok">已入库</span>') : ''}</label>
            ${indexedSet[f.name] ? `<button class="vw-mini" data-pkb-rebuild="${esc(f.name)}" title="源文件已更新时重建索引">${indexedSet[f.name].stale ? '重建' : '重索引'}</button><button class="vw-mini danger" data-pkb-del="${esc(f.name)}" title="从索引移除（材料本体不动）">移出</button>` : ''}
          </div>`).join('') : '<div class="vw-empty"><small>项目根目录还没有材料文件</small></div>'}
        <div class="vw-pkb-ext"><input class="vw-pkb-ext-in" placeholder="粘贴外部文件路径入库（复制源文件进项目根）…"><button class="vw-mini" data-a="pkb-add-ext">入库</button></div>
        <div class="vw-sub">诊断检索（手搜验证能不能搜出片段）</div>
        <div class="vw-pkb-q"><input class="vw-pkb-q-in" placeholder="输入检索词试试…"><button class="vw-mini" data-a="pkb-query">检索</button></div>
        <div class="vw-pkb-hits"></div>
      </div>` : ''}
      ${!on && hints.length ? `<div class="vw-pkb-hint">${icon('bulb')} 检测到大材料：${hints.map(h => esc(h.path) + '（' + _fmtSize(h.size) + '）').join('、')}——建议开启项目知识库入库，AI 直读会占大量上下文</div>` : ''}`;
  }

  function _bindPkb(body) {
    const cur = opts.getCurrentChat();
    if (!cur || !wd || !wd.dir) return;
    const dir = wd.dir;
    const tBtn = body.querySelector('[data-a="pkb-toggle"]');
    if (tBtn) tBtn.addEventListener('click', async () => {
      if (pkb && pkb.enabled) {
        if (!(await uiConfirm('关闭项目知识库？索引（约 ' + ((pkb.size_bytes / 1024).toFixed(0)) + 'KB）将被清除；材料文件不受影响。'))) return;
      }
      tBtn.disabled = true;
      try {
        const r = await fetch('/api/projects/kb/toggle', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir, on: !(pkb && pkb.enabled) }),
        });
        const d = await r.json();
        if (d.error) uiAlert(d.error);
        pkb = null; await loadWd(); renderBody();
      } catch (e) { uiAlert('操作失败'); tBtn.disabled = false; }
    });
    body.querySelectorAll('[data-pkb-add]').forEach(cb =>
      cb.addEventListener('change', async () => {
        if (!cb.checked) return;
        cb.disabled = true;
        try {
          const r = await fetch('/api/projects/kb/add', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir, path: cb.dataset.pkbAdd }),
          });
          const d = await r.json();
          if (d.error) { uiAlert(d.error); cb.checked = false; cb.disabled = false; return; }
          pkb = null; await loadWd(); renderBody();
        } catch (e) { uiAlert('入库失败'); cb.checked = false; cb.disabled = false; }
      }));
    body.querySelectorAll('[data-pkb-del]').forEach(b =>
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await fetch('/api/projects/kb/remove', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir, path: b.dataset.pkbDel }),
          });
          pkb = null; await loadWd(); renderBody();
        } catch (e) { b.disabled = false; }
      }));
    body.querySelectorAll('[data-pkb-rebuild]').forEach(b =>
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await fetch('/api/projects/kb/add', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir, path: b.dataset.pkbRebuild }),
          });
          pkb = null; await loadWd(); renderBody();
        } catch (e) { b.disabled = false; }
      }));
    const extBtn = body.querySelector('[data-a="pkb-add-ext"]');
    const extIn = body.querySelector('.vw-pkb-ext-in');
    if (extBtn && extIn) extBtn.addEventListener('click', async () => {
      const p = extIn.value.trim();
      if (!p) return;
      extBtn.disabled = true;
      try {
        const r = await fetch('/api/projects/kb/add-external', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir, src_path: p }),
        });
        const d = await r.json();
        if (d.error) { uiAlert(d.error); extBtn.disabled = false; return; }
        pkb = null; await loadWd(); renderBody();
      } catch (e) { uiAlert('入库失败'); extBtn.disabled = false; }
    });
    const qBtn = body.querySelector('[data-a="pkb-query"]');
    const qIn = body.querySelector('.vw-pkb-q-in');
    const hitsEl = body.querySelector('.vw-pkb-hits');
    if (qBtn && qIn && hitsEl) {
      const doQuery = async () => {
        const q = qIn.value.trim();
        if (!q) return;
        hitsEl.innerHTML = '<div class="vw-empty"><small>检索中…</small></div>';
        try {
          const r = await fetch('/api/projects/kb/query', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir, q }),
          });
          const d = await r.json();
          if (d.error) { hitsEl.innerHTML = '<div class="vw-empty"><small>' + esc(d.error) + '</small></div>'; return; }
          hitsEl.innerHTML = (d.hits && d.hits.length)
            ? d.hits.map(h => `<div class="vw-pkb-hit"><div class="vw-pkb-hit-t">${esc(h.path)} · 第${h.chunk_no + 1}段 · ${h.score}</div><div class="vw-pkb-hit-x">${esc(h.text.slice(0, 120))}…</div></div>`).join('')
            : '<div class="vw-empty"><small>没有命中——换个词试试</small></div>';
        } catch (e) { hitsEl.innerHTML = '<div class="vw-empty"><small>检索失败</small></div>'; }
      };
      qBtn.addEventListener('click', doQuery);
      qIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') doQuery(); });
    }
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
      ${(hs.todos && hs.todos.length) ? _todoHtml(hs.todos) : ''}
      ${pend.length ? `<div class="vw-pend"><div class="vw-pend-t">待执行计划 · ${pend.length}（确认后 AI 才会真正写入）</div>
        ${pend.slice(0, 6).map(p => `<div class="vw-pend-i">${p.overwrite ? '<span class="vw-ow">覆盖</span>' : ''}${esc(p.path)}</div>`).join('')}</div>` : ''}
      ${chg ? `<div class="vw-chg">${icon('alertTriangle')} 项目目录有外部改动：${[...(chg.changed || []), ...(chg.added || []), ...(chg.removed || [])].slice(0, 4).map(esc).join('、')}${chg.total > 4 ? ' 等 ' + chg.total + ' 项' : ''}（AI 已被告知）</div>` : ''}
      ${hs.can_undo ? `<div class="vw-card-r"><button class="vw-mini" data-a="undo" title="恢复最近一次 AI 写入前的状态（覆盖→还原旧版，新建→移除）">${icon('undo')} 撤销上次写入</button></div>` : ''}`;
  }

  // 0.10 M4-2：Todo 可视化（学 Claude Code——步骤进度实时可见）
  function _todoHtml(todos) {
    const done = todos.filter(t => t.done).length;
    const total = todos.length;
    const pct = total > 0 ? Math.round(done / total * 100) : 0;
    return `<div class="vw-todo">
      <div class="vw-todo-head">
        <span class="vw-todo-title">${icon('clipboardCheck')} 任务步骤</span>
        <span class="vw-todo-count">${done}/${total}</span>
      </div>
      <div class="vw-todo-bar"><div class="vw-todo-fill" style="width:${pct}%"></div></div>
      <div class="vw-todo-list">
        ${todos.map(t => `<div class="vw-todo-item ${t.done ? 'done' : ''}">
          <span class="vw-todo-dot">${t.done ? '✓' : '○'}</span>
          <span class="vw-todo-text">${esc(t.text)}</span>
        </div>`).join('')}
      </div>
    </div>`;
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
    // 隐私铁律（D-1 真修）：私密会话不进同项目清单/携候选（当前会话自身除外）
    const peers = sessions.filter(s => s.project_dir === wd.dir && (!s.private || s.current));
    if (!peers.length) return '';
    return `<div class="vw-sec">同项目会话 · ${peers.length}${carrySids.length ? `<span class="vw-carry-hint">（引用 ${carrySids.length} 条前情）</span>` : ''}</div>
      <div class="vw-peers">
      ${peers.map(c => `
        <div class="vw-peer ${c.current ? 'on' : ''}" data-name="${esc(c.name)}" title="${esc(c.name)}">
          <span class="pn">${esc(c.title || c.name)}</span><span class="pm">${c.msg_count || 0} 条</span>
          ${c.current ? '' : `<button class="vw-carry ${carrySids.includes(c.name) ? 'on' : ''}" data-sid="${esc(c.name)}" title="${carrySids.includes(c.name) ? '取消携带（不再注入此会话摘要）' : '携带前情（注入此会话摘要到本会话上下文，仅在线生效）'}">引用</button>`}
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
      : '<div class="vw-empty"><small>还没有产物</small></div>'}
      ${(wd.versions && wd.versions.length) ? `<div class="vw-sub" style="margin-top:8px">版本历史（写前备份）</div>
      ${wd.versions.map(v => `<div class="vw-file vw-file-ro" title="写前自动备份">
        <span class="fi">${iconSvg('clock')}</span>
        <span class="ftx"><span class="fn">${esc(v.name)}</span><span class="fm">${esc(v.mtime || '')}</span></span>
      </div>`).join('')}` : ''}
        : '<div class="vw-empty"><small>AI 产出的文件会出现在这里</small></div>'}`;
  }

  function renderBody() {
    const body = el.querySelector('.vw-body');
    if (!body) return;
    // 预览 drill-down 态：外层滚动容器切换为撑满面板宿主（去 padding/滚动，
    // 由 pv-pane 内的 pv-body 自行滚动）——原型 pv-pane 与 vw-head 平级
    body.classList.toggle('pv-host', tab === 'preview' && !!previewFile);
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
        ${_pkbSection()}
        ${_wdFiles()}
      </div>
      <input type="file" class="vw-up-input" style="display:none">`;
      _bindPkb(body);
      _syncCarryChips();
      _syncCarryChips();
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
          uiAlert(d.message || d.error || '已处理');
        } catch (e) { uiAlert('撤销失败'); }
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
            if (d.error) uiAlert(d.error);
          } catch (e) {
            uiAlert('上传失败');
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
        <div class="vw-cap">本会话产物 · ${files.length} 个</div>
        ${files.map(f => {
          const url = '/api/chat/' + encodeURIComponent(filesFor) + '/workspace/download?path=' + encodeURIComponent(f.name);
          const cur = (previewFile ? previewFile.name : lastPreviewName) === f.name;
          return `<div class="fl-row${cur ? ' cur' : ''}" data-pv-name="${esc(f.name)}" data-pv-url="${esc(url)}">
            <div class="fl-ic${/\.pptx$/i.test(f.name) ? ' gold' : ''}"><span class="ic">${_icon(f.name)}</span></div>
            <div class="fl-tx"><div class="fl-nm">${esc(f.name)}</div><div class="fl-mt">${_fmtSize(f.size)}</div></div>
            <button class="fl-eye" title="预览"><svg fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg></button>
            <a class="fl-dl" href="${esc(url)}" download="${esc(f.name)}" title="下载"><svg fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg></a>
          </div>`;
        }).join('')}
      </div>`;
      body.querySelectorAll('.fl-row .fl-eye').forEach(btn =>
        btn.addEventListener('click', () => {
          const r = btn.closest('.fl-row');
          openPreview({ name: r.dataset.pvName, url: r.dataset.pvUrl });
        }));
    } else if (tab === 'preview') {
      _renderPreview(body);
    } else {
      _renderTrace(body);
    }
  }

  // ===== 轨迹 tab（M2-6 转正）：从已持久化的 agent_timeline 渲染
  // 全会话模型↔工具时间线（BoardUI agent-log 树形引导线语言的 CSS 近似）。
  // 数据源零新增（卡片系统落盘的 timeline 即真相），完整 trace.jsonl
  // （请求/响应体级）记 0.10.2 候选池。
  let _traceFor = '';
  const _TRACE_PHASE = {
    retrieve: '检索与阅读', produce: '生成产物', other: '其他动作',
  };
  async function _renderTrace(body) {
    const cur = opts.getCurrentChat();
    if (!cur) { body.innerHTML = '<div class="vw-empty">还没有会话</div>'; return; }
    body.innerHTML = '<div class="vw-empty">加载中…</div>';
    let msgs = [];
    try {
      const r = await fetch('/api/chats/' + encodeURIComponent(cur.name) + '/messages');
      const d = await r.json();
      msgs = (d && d.messages) || (Array.isArray(d) ? d : []);
    } catch (e) { /* fallthrough */ }
    const rounds = [];
    msgs.forEach(m => {
      if (m.role !== 'assistant') return;
      const tl = m.agent_timeline || [];
      if (!tl.length) return;
      rounds.push({ ts: m.ts || '', engine: m.engine || '', items: tl });
    });
    if (!rounds.length) {
      body.innerHTML = '<div class="vw-empty">还没有调用轨迹<br><small>在线模式下 AI 调工具时，轨迹会记录在这里</small></div>';
      return;
    }
    // 总览 chips（与消息内 L1 胶囊同源：步骤/耗时/轮次）
    let totalSteps = 0, totalMs = 0;
    rounds.forEach(r2 => { totalSteps += r2.items.length; r2.items.forEach(it => { if (it.elapsed_ms) totalMs += it.elapsed_ms; }); });
    const secs = totalMs ? (totalMs / 1000).toFixed(1).replace(/\.0$/, '') + 's' : '—';
    // 每轮 → 阶段分组 + 连续同类折叠
    const roundHtml = rounds.map((r2, ri) => {
      const rows = [];
      r2.items.forEach(it => {
        const lbl = _traceLabel(it);
        const fail = /失败|受限|异常|不安全|不存在/.test(lbl);
        const prev = rows[rows.length - 1];
        if (!fail && prev && prev.label === lbl && !prev.fail) {
          prev.n += 1; prev.ms += it.elapsed_ms || 0; return;
        }
        rows.push({ label: lbl, fail, n: 1, ms: it.elapsed_ms || 0 });
      });
      let inner = '', curPhase = null;
      const sums = { retrieve: 0, produce: 0, other: 0 };
      rows.forEach(row => {
        const ph = _phaseByLabel(row.label);
        sums[ph] += row.ms;
        if (ph !== curPhase) {
          curPhase = ph;
          inner += '<div class="tr-phase"><span class="chev">▾</span>' + _TRACE_PHASE[ph] + '<span class="tt"></span></div>';
        }
        inner += '<div class="tr-step"><span class="dt ' + (row.fail ? 'fail' : 'ok') + '"></span>' +
          '<span class="nm">' + esc(row.label) + (row.n > 1 ? ' <span class="cnt">×' + row.n + '</span>' : '') + '</span>' +
          '<span class="ms">' + (row.ms ? (row.ms / 1000).toFixed(1) + 's' : '') + '</span></div>';
      });
      // 阶段小计回写
      inner = inner.replace(/(<div class="tr-phase"><span class="chev">▾<\/span>)(检索与阅读|生成产物|其他动作)/g, (all, head, title) => {
        const key = { '检索与阅读': 'retrieve', '生成产物': 'produce', '其他动作': 'other' }[title];
        return head + title + (sums[key] ? '<span class="tt">' + (sums[key] / 1000).toFixed(1) + 's</span>' : '');
      });
      const eng = r2.engine === 'cloud' ? '在线' : r2.engine === 'local' ? '离线' : r2.engine;
      return '<div class="tr-round-h">' + icon('chat') + ' 第 ' + (ri + 1) + ' 轮 <span class="tr-round-ts">' + esc(r2.ts) + (eng ? ' · ' + esc(eng) : '') + '</span></div>' +
        '<div class="tr-box">' + inner + '</div>';
    }).join('');
    body.innerHTML = '<div class="vw-trace2">' +
      '<div class="tr-sum">' +
      '<div class="tr-chip"><b>' + totalSteps + '</b><span>步骤</span></div>' +
      '<div class="tr-chip"><b>' + secs + '</b><span>总耗时</span></div>' +
      '<div class="tr-chip"><b>' + rounds.length + '</b><span>轮次</span></div>' +
      '</div>' + roundHtml +
      '<div class="tr-hint">与消息内摘要行同源 · 连续同类调用已折叠计数</div></div>';
  }
  function _phaseByLabel(label) {
    if (/搜索|阅读|检索|深读|读取|列出/.test(label)) return 'retrieve';
    if (/PPT|文档|写入|打包|计算|转换|表格|编排|生成|设计|编译/.test(label)) return 'produce';
    return 'other';
  }

  function _traceLabel(it) {
    const s = it.status || '';
    const det = it.query || it.name || it.url || '';
    // create_ppt 三动作区分（GUI 探索瑕疵①：此前五次调用全显「PPT 操作」）
    if (s === 'ppt_done') {
      const a = it.action || '';
      if (a === 'begin') return 'PPT 开题：' + (it.title || it.deck || '').slice(0, 24);
      if (a === 'page') return 'PPT 设计：第 ' + (it.page || '?') + ' 页';
      if (a === 'build') return 'PPT 编译导出：' + (it.pptx_name || 'pptx');
      return 'PPT 操作';
    }
    const map = {
      kb_done: '检索知识库', search_done: '联网搜索', fetch_done: '阅读网页',
      workspace_write_done: '写入文档', workspace_read_done: '读取文档',
      workspace_listed: '列出文件', ppt_done: 'PPT 操作', plan_done: '编排执行',
      readers_done: '并行深读', session_read_done: '读历史会话',
      project_write_done: '写项目文件', proj_kb_done: '项目知识库检索',
      deliver_pack_done: '打成果包', doc_status_done: '生成文档',
      completed: '生成文档', calculating_done: '计算', format_converting_done: '格式转换',
      table_operating_done: '表格操作', deep_read_done: '深度分析',
    };
    const base = map[s] || s.replace(/_/g, ' ');
    return det ? base + '：' + det : base;
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

  // 预览产物清单：HTML 报告（live 事件优先 + workspace 回放补充）
  function _htmlArtifacts() {
    const cur = opts.getCurrentChat();
    const out = htmlLive.slice();
    if (cur && Array.isArray(files)) {
      files.forEach(f => {
        if (!/\.html?$/i.test(f.name || '')) return;
        const url = '/api/chat/' + encodeURIComponent(cur.name) +
          '/workspace/download?path=' + encodeURIComponent(f.name);
        if (!out.some(h => h.url === url)) out.push({ url, name: f.name, size: f.size });
      });
    }
    return out;
  }

  async function _loadDocx() {
    const cur = opts.getCurrentChat();
    if (!cur) { docxDocs = []; return; }
    try {
      const r = await fetch('/api/chat/' + encodeURIComponent(cur.name) + '/docx/docs');
      const d = await r.json();
      docxDocs = d.docs || [];
    } catch (e) { docxDocs = []; }
  }

  // ===== 预览 = 文件的 drill-down（0.10.2 B2，原型 pv-crumb/pv-top/pv-body）=====
  // 进入口：聊天产物卡片 / 文件 tab 行 / 流式 ppt_page·doc_complete 自动亮相。
  function openPreview(f) {
    if (!f || !f.name) return;
    previewFile = f;
    lastPreviewName = f.name;
    if (!open) { setOpen(true, 'preview'); return; }
    tab = 'preview';
    el.querySelectorAll('.vw-tab').forEach(x => x.classList.toggle('on', x.dataset.t === 'preview'));
    renderBody();
  }

  async function _renderPreview(body) {
    if (files === null) {
      body.innerHTML = '<div class="vw-empty">加载中…</div>';
      loadFiles().then(() => { if (tab === 'preview') renderBody(); });
      return;
    }
    if (!previewFile) {
      const cur = opts.getCurrentChat();
      const pv = (files || []).filter(f => !f.is_dir);
      body.innerHTML = '<div class="vw-empty">从「文件」或聊天里的产物卡片选择要预览的内容' +
        (pv.length ? '' : '<br><small>本会话还没有产物</small>') + '</div>' +
        (pv.length ? '<div class="vw-files" style="margin-top:8px">' + pv.map(f => {
          const url = cur ? '/api/chat/' + encodeURIComponent(cur.name) + '/workspace/download?path=' + encodeURIComponent(f.name) : '';
          return '<div class="fl-row" data-pv-name="' + esc(f.name) + '" data-pv-url="' + esc(url) + '">' +
            '<div class="fl-ic"><span class="ic">' + _icon(f.name) + '</span></div>' +
            '<div class="fl-tx"><div class="fl-nm">' + esc(f.name) + '</div><div class="fl-mt">' + _fmtSize(f.size) + '</div></div>' +
            '<button class="fl-eye" title="预览"><svg fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/></svg></button></div>';
        }).join('') + '</div>' : '');
      body.querySelectorAll('.fl-row .fl-eye').forEach(btn =>
        btn.addEventListener('click', () => {
          const r = btn.closest('.fl-row');
          openPreview({ name: r.dataset.pvName, url: r.dataset.pvUrl });
        }));
      return;
    }
    const f = previewFile;
    const cur = opts.getCurrentChat();
    const dlUrl = f.url || (cur ? '/api/chat/' + encodeURIComponent(cur.name) + '/workspace/download?path=' + encodeURIComponent(f.name) : '#');
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    body.innerHTML =
      '<div class="pv-pane">' +
      '<div class="pv-crumb">' +
      '<button data-a="back-files" type="button"><svg fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>返回文件</button>' +
      '<span class="sep">/</span><span class="cur">' + esc(f.name) + '</span>' +
      '</div>' +
      '<div class="pv-top">' +
      '<div class="pv-title"><span class="ic">' + _icon(f.name) + '</span><span>' + esc(f.name) + '</span></div>' +
      '<button class="pv-open" data-a="open-dir" type="button" title="在资源管理器中打开项目目录"><svg fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>打开位置</button>' +
      '<a class="vw-dl" href="' + esc(dlUrl) + '" download="' + esc(f.name) + '"><svg fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>下载</a>' +
      '</div>' +
      '<div class="vw-body pv-body"></div>' +
      '</div>';
    body.querySelector('[data-a="back-files"]').addEventListener('click', () => {
      const backName = f.name;
      previewFile = null;
      tab = 'files';
      el.querySelectorAll('.vw-tab').forEach(x => x.classList.toggle('on', x.dataset.t === 'files'));
      renderBody();
      // 规格#12：返回文件 tab 并定位原行（滚入视口中央）
      setTimeout(() => {
        const row = el.querySelector('.fl-row.cur') ||
          [...el.querySelectorAll('.fl-row')].find(r => r.dataset.pvName === backName);
        if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 60);
    });
    const dirBtn = body.querySelector('[data-a="open-dir"]');
    if (dirBtn) dirBtn.addEventListener('click', async () => {
      if (cur) { try { await api.openWorkdir(cur.name); } catch (e) { /* 失败无感 */ } }
    });
    // 规格#1：正在预览的聊天产物卡片同步金边（.previewing）
    document.querySelectorAll('.art-card').forEach(c =>
      c.classList.toggle('previewing', c.dataset.pvName === f.name));
    const pvBody = body.querySelector('.pv-body');
    _renderPreviewBody(pvBody, f, ext, dlUrl, cur);
  }

  // 预览体注册表（按扩展名分发；原型 #11「按类型渲染」）
  async function _renderPreviewBody(pvBody, f, ext, dlUrl, cur) {
    // pptx：SVG 逐页（回放 decks + 流式累积，按产物名匹配 deck）
    if (ext === 'pptx') {
      if (ppt === null) await _loadPpt();
      const want = f.name.replace(/\.pptx$/i, '');
      const all = _pptMergedDecks();
      const decks = all.filter(d => {
        const base = (d.pptx || d.title || '').replace(/\.pptx$/i, '');
        return base && (want.includes(base) || base.includes(want));
      });
      const use = decks.length ? decks : all;
      if (!use.length) { pvBody.innerHTML = _pvFallback(); return; }
      pvBody.innerHTML = use.map(d => {
        const nums = Object.keys(d.pages).map(Number).sort((a, b) => a - b);
        return '<div class="vw-ppt-deck">' +
          '<div class="vw-ppt-head"><span class="vw-ppt-title">' + icon('presentation') + ' ' + esc(d.title) + '</span>' +
          '<span class="vw-ppt-meta">' + nums.length + ' 页</span></div>' +
          nums.map(n => '<div class="vw-ppt-page">' +
            '<div class="vw-ppt-num">P' + String(n).padStart(2, '0') + '</div>' +
            '<div class="vw-ppt-svg" data-url="' + esc(d.pages[n]) + '"><div class="vw-empty"><small>渲染中…</small></div></div>' +
            '</div>').join('') +
          '</div>';
      }).join('');
      _hydratePptSvgs(pvBody);
      return;
    }
    // html：sandbox iframe（JS 禁跑，经典版同款安全姿势）
    if (ext === 'html' || ext === 'htm') {
      pvBody.innerHTML = '<div class="vw-html-frame" data-url="' + esc(dlUrl) + '"><div class="vw-empty"><small>渲染中…</small></div></div>';
      _hydrateHtmlFrames(pvBody);
      return;
    }
    // docx：结构化章节回放（近似排版，注明以 Word 为准）
    if (ext === 'docx') {
      if (docxDocs === null) await _loadDocx();
      const want = f.name.replace(/\.docx$/i, '');
      const docs = (docxDocs || []).filter(d => {
        const base = (d.title || d.deck || '').replace(/\.docx$/i, '');
        return base && (want.includes(base) || base.includes(want));
      });
      const use = docs.length ? docs : (docxDocs || []);
      if (!use.length) {
        const mdName = f.name.replace(/\.docx$/i, '.md');
        const mdFile = (files || []).find(x => x.name === mdName);
        if (mdFile && cur) {
          const mdUrl = '/api/chat/' + encodeURIComponent(cur.name) + '/workspace/download?path=' + encodeURIComponent(mdName);
          try {
            const mdText = await fetch(mdUrl, { cache: 'no-store' }).then(r => r.text());
            if (typeof marked !== 'undefined') {
              const html = marked.parse(mdText, { breaks: true });
              pvBody.innerHTML = '<div class="pv-md">' + (typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html) + '</div><div class="pv-note">源码预览（.md）· 下载 .docx 以 Word 排版为准</div>';
            } else {
              pvBody.innerHTML = '<div class="pv-md"><pre>' + esc(mdText) + '</pre></div><div class="pv-note">源码预览（.md）· 下载 .docx 以 Word 排版为准</div>';
            }
            return;
          } catch (e) { }
        }
        pvBody.innerHTML = _pvFallback(); return;
      }
      pvBody.innerHTML = use.map(doc => '<div class="vw-ppt-deck vw-docx-deck">' +
        '<div class="vw-ppt-head"><span class="vw-ppt-title">' + icon('fileText') + ' ' + esc(doc.title) + '</span>' +
        '<span class="vw-ppt-meta">' + (doc.sections || 0) + ' 章</span></div>' +
        (doc.section_list || []).map(sec2 => '<details class="vw-docx-sec" open>' +
          '<summary>' + esc(sec2.section) + '<span class="vw-docx-n">' + (sec2.chars || 0) + ' 字</span></summary>' +
          '<div class="vw-docx-body">' + esc(sec2.content || '') + '</div>' +
          '</details>').join('') +
        '</div>').join('') + '<div class="pv-note">docx 预览为近似排版 · 下载后以 Word 打开为准</div>';
      return;
    }
    // svg：内联矢量
    if (ext === 'svg') {
      try {
        const t = await fetch(dlUrl, { cache: 'no-store' }).then(r => r.text());
        pvBody.innerHTML = '<div class="pv-center">' + t + '</div>';
        const svg = pvBody.querySelector('svg');
        if (svg) { svg.removeAttribute('width'); svg.removeAttribute('height'); svg.style.maxWidth = '100%'; svg.style.height = 'auto'; }
      } catch (e) { pvBody.innerHTML = _pvFallback(); }
      return;
    }
    // md/txt：marked 渲染 / 纯文本
    if (ext === 'md' || ext === 'txt') {
      try {
        const t = await fetch(dlUrl, { cache: 'no-store' }).then(r => r.text());
        if (ext === 'md' && typeof marked !== 'undefined') {
          const html = marked.parse(t, { breaks: true });
          pvBody.innerHTML = '<div class="pv-md">' + (typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html) + '</div>';
        } else {
          pvBody.innerHTML = '<div class="pv-md"><pre>' + esc(t) + '</pre></div>';
        }
      } catch (e) { pvBody.innerHTML = _pvFallback(); }
      return;
    }
    // 图片
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) {
      pvBody.innerHTML = '<div class="pv-center"><img src="' + esc(dlUrl) + '" alt="' + esc(f.name) + '"></div>';
      return;
    }
    pvBody.innerHTML = _pvFallback();
  }
  function _pvFallback() {
    return '<div class="vw-empty">该类型暂不支持预览<br><small>点右上「下载」用本地应用打开</small></div>';
  }

  // SVG 页与 HTML iframe 的水合（从旧 _renderPreview 抽出复用）
  function _hydratePptSvgs(scope) {
    scope.querySelectorAll('.vw-ppt-svg[data-url]').forEach(box => {
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
  function _hydrateHtmlFrames(scope) {
    scope.querySelectorAll('.vw-html-frame[data-url]').forEach(box => {
      const url = box.dataset.url;
      const draw = t => {
        box.innerHTML = '';
        const iframe = document.createElement('iframe');
        iframe.className = 'vw-html-iframe';
        iframe.setAttribute('sandbox', 'allow-same-origin');
        box.appendChild(iframe);
        const _fit = () => {
          try {
            const h = iframe.contentWindow.document.body.scrollHeight;
            iframe.style.height = Math.max(420, Math.min(h + 24, 2000)) + 'px';
          } catch (e) { iframe.style.height = '420px'; }
        };
        iframe.onload = () => { _fit(); setTimeout(_fit, 400); setTimeout(_fit, 1500); };
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        doc.open();
        doc.write('<!DOCTYPE html><html><head><meta charset="utf-8">' +
          '<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;margin:0;padding:16px;color:#1F2937}' +
          '*{box-sizing:border-box}</style></head><body>' + t + '</body></html>');
        doc.close();
      };
      if (htmlCache[url]) { draw(htmlCache[url]); return; }
      fetch(url, { cache: 'no-store' }).then(r => r.text()).then(t => {
        htmlCache[url] = t;
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
    // 亮相时刻：首页到达即进入该 deck 的 drill-down 预览（0.10.2 B2）
    if (d.page === 1 && !previewFile) {
      openPreview({ name: (d.pptx || d.title || d.deck || '演示') + (/\.pptx$/i.test(d.pptx || '') ? '' : '.pptx'), url: d.pptx_url || '' });
      return;
    }
    if (open && tab === 'preview') renderBody();
  }

  // 流式 doc_complete 事件入口（index.js 转发，限 .html/.ppt.html 产物）：
  // HTML 报告的「亮相」时刻，行为对齐 onPptPage
  function onDocComplete(d) {
    if (!d || !d.url) return;
    if (htmlLive.some(h => h.url === d.url)) return;
    delete htmlCache[d.url];
    htmlLive.unshift({ url: d.url, name: d.name || '报告.html' });
    // HTML 报告亮相：直接进该产物的 drill-down 预览（0.10.2 B2）
    openPreview({ name: d.name || '报告.html', url: d.url });
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
    files = null; wd = null; handoff = null; previewFile = null; lastPreviewName = '';
    document.querySelectorAll('.art-card.previewing').forEach(c => c.classList.remove('previewing'));
    ppt = null; pptLive = {}; Object.keys(pptCache).forEach(k => delete pptCache[k]);
    htmlLive = []; Object.keys(htmlCache).forEach(k => delete htmlCache[k]);
    if (open) renderBody();
  }

  return {
    el,
    setOpen,
    toggle: () => setOpen(!open),
    onSessionChange,
    onPptPage,
    onDocComplete,
    openPreview,
    get isOpen() { return open; },
  };
}

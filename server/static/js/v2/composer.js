// 桌伴 0.10.1 新版 UI — 输入区（M1-D-3：原型 v14 composer + 经典版行为照搬）
// 组成：上下文双条（token 占用指示器）+ 快捷 chips（action 按钮）+ 模型 tag
//       + 附件浮出栏（上传文档/KB 引用）+ 输入框 + 发送/停止。

import { api } from './api.js';
import { icon, iconSvg } from './icons.js';

// Token 估算（照搬经典版 token-estimator.js：中文 ~1.5 字/token，英文 ~4 字/token）
export function estimateTokens(text) {
  if (!text) return 0;
  const cn = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const other = text.length - cn;
  return Math.ceil(cn / 1.5 + other / 4.0);
}
const FILE_TOKENS_PER_KB = 200;  // 经典版同款：文件约 200 token/KB

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// state: { mode, actionMode, localActions, modelTag, contextWindow, historyTokens, chipTip }
// events: { onSend(payload), onStop(), onChipMode(mode), onAttachChange(att) }
export function renderComposer(state, events) {
  const wrap = document.createElement('div');
  wrap.className = 'composer';

  const maxTokens = state.contextWindow || 8192;
  const fmtK = (n) => (n / 1000).toFixed(1) + 'K';
  const fmtKU = (n) => (n / 1000).toFixed(1) + 'K词元';

  wrap.innerHTML = `
    <div class="token-bar">
      <div class="tb-main">
        <div class="tb-track">
          <div class="tb-fill tb-used" style="width:0%"></div>
          <div class="tb-fill tb-cur" style="width:0%"></div>
        </div>
        <div class="tb-labels">
          <span class="tb-lbl-left">
            <span class="tb-tag tb-tag-status status-ok" id="v2TokenStatus">空间充足</span>
            <span class="tb-tag tb-tag-used">已用 <span id="v2TokenHist">0.0K</span></span>
            <span class="tb-tag tb-tag-cur">本轮 <span id="v2TokenCur">0.0K</span></span>
          </span>
          <span class="tb-lbl-right">剩余 <span class="tb-remain" id="v2TokenRemain">0.0K词元</span>
            <span class="tb-limit">/ 总计 <span id="v2TokenLimit">${fmtKU(maxTokens)}</span></span></span>
        </div>
      </div>
    </div>
    <div class="workdir-strip"></div>
    <div class="quick-chips"></div>
    <div class="attach-tray" style="display:none"></div>
    <div class="composer-box">
      <div class="scene-tag-wrap" style="display:none"></div>
      <textarea placeholder="发消息给桌伴…（Enter 发送 / Shift+Enter 换行）" rows="1"></textarea>
      <div class="composer-bar">
        <div class="cb-pills">
          <button class="cb-pill" data-act="add" title="添加材料到对话">${iconSvg('plus')} 添加</button>
          <button class="cb-pill cb-xmode" data-act="execmode" style="display:none" title="计划模式：AI 写项目文件前先给你确认清单；执行模式：确认后直接落盘">计划</button>
        </div>
        <div class="cb-right">
          <button class="cb-send">发送</button>
          <button class="cb-send cb-stop" style="display:none">停止</button>
        </div>
      </div>
      <div class="cb-add-menu" style="display:none">
        <button data-act="upload">附加文档到聊天</button>
        <button data-act="kb">引用知识库文档</button>
        <button data-act="projfile">引用项目里的文件…</button>
      </div>
    </div>
    <input type="file" style="display:none">
  `;

  const textarea = wrap.querySelector('textarea');
  const sceneTagWrap = wrap.querySelector('.scene-tag-wrap');

  // 场景占位符 tag：点场景卡不打字进输入框，而是在输入框顶部落一个可移除的
  // 场景 tag（金色浅底），placeholder 换成该场景的引导句；用户一打字 placeholder 自然消失
  const SCENE_META = {
    chat:  { label: '聊天',       ph: '发消息给桌伴…（Enter 发送 / Shift+Enter 换行）' },
    doc:   { label: '文档生成',   ph: '描述要生成的文档…' },
    kb_qa: { label: '知识库问答', ph: '输入问题，将从知识库检索回答…' },
    kb:    { label: '知识库文档', ph: '输入问题，将从知识库检索回答…' },
    ppt:   { label: '写 PPT',     ph: '描述 PPT 的主题和内容，或丢材料进来…' },
    report:{ label: '可视化报告', ph: '描述报告主题或粘贴数据…' },
    poster:{ label: '设计海报',   ph: '描述海报/封面的主题与平台…' },
    gzh:   { label: '公众号文章', ph: '粘贴文章内容或描述主题…' },
    search:{ label: '联网搜索',   ph: '输入要联网搜索的主题…' },
    deep:  { label: '深度分析',   ph: '描述要深挖的课题…' },
  };
  function renderSceneTag() {
    const sc = state.scene && SCENE_META[state.scene] ? state.scene : (SCENE_META[state.actionMode] ? state.actionMode : '');
    const meta = sc ? SCENE_META[sc] : null;
    if (meta && sc !== 'chat') {
      sceneTagWrap.style.display = '';
      sceneTagWrap.innerHTML = `<span class="scene-tag">${esc(meta.label)}<span class="x" title="取消场景">×</span></span>`;
      sceneTagWrap.querySelector('.x').addEventListener('click', () => {
        events.onSceneClear && events.onSceneClear();
      });
      textarea.placeholder = meta.ph;
    } else {
      sceneTagWrap.style.display = 'none';
      sceneTagWrap.innerHTML = '';
      textarea.placeholder = SCENE_META.chat.ph;
    }
  }
  renderSceneTag();
  const sendBtn = wrap.querySelector('.cb-send');
  const stopBtn = wrap.querySelector('.cb-stop');
  const chipsEl = wrap.querySelector('.quick-chips');
  const trayEl = wrap.querySelector('.attach-tray');
  const fileInput = wrap.querySelector('input[type=file]');

  // 附件状态：{ kind: 'upload', name, path } | { kind: 'kb', names: [], ids: 'a,b' }
  let attach = null;

  function renderTray() {
    if (!attach) { trayEl.style.display = 'none'; trayEl.innerHTML = ''; return; }
    trayEl.style.display = 'flex';
    if (attach.kind === 'upload') {
      trayEl.innerHTML = `<span class="attach-chip">${icon('fileText')} ${esc(attach.name)}<span class="x" title="移除">×</span></span>`;
    } else {
      trayEl.innerHTML = `<span class="attach-chip">${icon('book')} KB：${esc(attach.names.join('、'))}<span class="x" title="移除">×</span></span>`;
    }
    trayEl.querySelector('.x').addEventListener('click', () => { attach = null; attachTokens = 0; renderTray(); updateTokenBar(); events.onAttachChange(null); });
  }

  // ---- 计划/执行 pill（M2-3 写权限双模式；仅在线+有项目的会话显示） ----
  const xmodeBtn = wrap.querySelector('.cb-xmode');
  let xmodeBusy = false;
  async function renderXmodePill() {
    const session = events.getSession && events.getSession();
    const wd = state.workdir;
    const show = !!(session && wd && !wd.legacy && wd.dir && state.mode === 'cloud');
    if (!show) { xmodeBtn.style.display = 'none'; return; }
    try {
      const r = await fetch('/api/chats/' + encodeURIComponent(session.name) + '/harness-state');
      const d = await r.json();
      const isExec = d.exec_mode === 'execute';
      xmodeBtn.style.display = '';
      xmodeBtn.textContent = isExec ? '执行' : '计划';
      xmodeBtn.classList.toggle('exec', isExec);
      xmodeBtn.title = isExec
        ? '执行模式：AI 写项目文件直接落盘（点我切回计划模式）'
        : '计划模式：AI 写项目文件前先给你确认清单（点我切到执行模式）';
    } catch (e) { xmodeBtn.style.display = 'none'; }
  }
  xmodeBtn.addEventListener('click', async () => {
    const session = events.getSession && events.getSession();
    if (!session || xmodeBusy) return;
    xmodeBusy = true;
    const next = xmodeBtn.classList.contains('exec') ? 'plan' : 'execute';
    try {
      await fetch('/api/chats/' + encodeURIComponent(session.name) + '/exec-mode', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      });
    } catch (e) { /* 失败无感 */ }
    xmodeBusy = false;
    renderXmodePill();
  });

  // ---- 项目 chip（项目即文件夹：对话中显示所属项目，点击打开信息卡；
  // 空状态（无消息）时隐藏——项目选择由空状态归属条承接，避免双入口重复） ----
  const wdStrip = wrap.querySelector('.workdir-strip');
  function renderWorkdirChip() {
    const hasSession = !!(events.getSession && events.getSession());
    const wd = state.workdir;
    if (!hasSession || !wd || !state.hasMessages) { wdStrip.style.display = 'none'; wdStrip.innerHTML = ''; return; }
    wdStrip.style.display = '';
    if (wd.legacy) {
      wdStrip.innerHTML = `<button class="wd-chip legacy" title="旧版本会话：只读存档，可查看/导出/下载产物">${icon('archive')} 旧版本会话</button>`;
      wdStrip.querySelector('.wd-chip').addEventListener('click', (e) => {
        events.onWorkdirClick && events.onWorkdirClick(e.target.closest('.wd-chip'));
      });
      return;
    }
    if (!wd.dir) { wdStrip.style.display = 'none'; wdStrip.innerHTML = ''; return; }
    const name = wd.display || '默认项目';
    wdStrip.innerHTML = `<button class="wd-chip" title="${esc(wd.dir)}（点击查看项目信息）">${icon('folder')} ${esc(name)}</button>`;
    wdStrip.querySelector('.wd-chip').addEventListener('click', (e) => {
      events.onWorkdirClick && events.onWorkdirClick(e.target.closest('.wd-chip'));
    });
  }
  renderWorkdirChip();
  renderXmodePill();

  // ---- 快捷 chips：按模式照搬经典版 ----
  function renderChips() {
    chipsEl.innerHTML = '';
    // 用户定稿：离线空状态（还没有消息）不出 action 按钮——第一轮聊天后才出现，
    // 用于聊天过程中切换管道；在线模式本来就没有 chips
    if (state.mode !== 'cloud' && !state.hasMessages) {
      chipsEl.style.display = 'none';
      return;
    }
    chipsEl.style.display = '';
    if (state.mode === 'cloud') {
      // 0.10.1 定稿：在线模式的提示词 chips 移除——空状态场景卡已覆盖入口，
      // 工具选择由后端 agent 自主判断（harness 层），输入区只留模型 tag。
    } else {
      // 离线/并行：action 模式按钮（本地 /api/action/list + 知识库问答）
      // 切换语义：点另一个=直接切换；点当前=取消回到 chat
      (state.localActions || []).forEach(a => {
        const b = document.createElement('button');
        b.className = 'qc-btn' + (state.actionMode === a.id ? ' on' : '');
        b.textContent = a.label || a.id;
        b.title = a.title || '';
        b.addEventListener('click', () => {
          const next = state.actionMode === a.id ? 'chat' : a.id;
          state.actionMode = next;
          events.onChipMode(next);
          renderChips();
        });
        chipsEl.appendChild(b);
      });
      const kb = document.createElement('button');
      kb.className = 'qc-btn' + (state.actionMode === 'kb_qa' ? ' on' : '');
      kb.textContent = '知识库问答';
      kb.title = '检索你的本地知识库，基于文档内容回答问题';
      kb.addEventListener('click', () => {
        const next = state.actionMode === 'kb_qa' ? 'chat' : 'kb_qa';
        state.actionMode = next;
        events.onChipMode(next);
        renderChips();
      });
      chipsEl.appendChild(kb);
    }
    if (!chipsEl.children.length) chipsEl.style.display = 'none';
  }
  renderChips();

  // ---- Token 聚合条（照搬经典版 updateInputDisplay 口径） ----
  let attachTokens = 0;
  function updateTokenBar() {
    const textTokens = estimateTokens(textarea.value);
    const curTotal = textTokens + attachTokens;
    const hist = state.historyTokens || 0;
    const total = curTotal + hist;
    const usedPct = maxTokens > 0 ? Math.min(100, (hist / maxTokens) * 100) : 0;
    const curPct = maxTokens > 0 ? Math.min(100 - usedPct, (curTotal / maxTokens) * 100) : 0;
    wrap.querySelector('.tb-used').style.width = usedPct + '%';
    wrap.querySelector('.tb-cur').style.width = curPct + '%';
    wrap.querySelector('#v2TokenCur').textContent = fmtK(curTotal);
    wrap.querySelector('#v2TokenHist').textContent = fmtK(hist);
    wrap.querySelector('#v2TokenLimit').textContent = fmtKU(maxTokens);
    const ratio = maxTokens > 0 ? total / maxTokens : 0;
    const statusEl = wrap.querySelector('#v2TokenStatus');
    statusEl.textContent = ratio < 0.5 ? '空间充足' : (ratio < 0.8 ? '空间紧张' : '空间不足');
    statusEl.classList.remove('status-ok', 'status-warn', 'status-over');
    statusEl.classList.add(ratio >= 0.8 ? 'status-over' : ratio >= 0.5 ? 'status-warn' : 'status-ok');
    const track = wrap.querySelector('.tb-track');
    track.classList.remove('tb-warn', 'tb-over');
    if (ratio >= 0.8) track.classList.add('tb-over');
    else if (ratio >= 0.5) track.classList.add('tb-warn');
    wrap.querySelector('#v2TokenRemain').textContent = fmtKU(Math.max(0, maxTokens - total));
  }
  updateTokenBar();

  // 旧版会话只读：禁用输入/发送/附件（PLAN 1.5：旧版会话只看/导出/下载产物）
  const isLegacy = !!(state.workdir && state.workdir.legacy);
  if (isLegacy) {
    textarea.disabled = true;
    textarea.placeholder = '旧版本会话已转为只读存档——可查看、导出或下载产物；要聊新内容请点「新建任务」';
    sendBtn.disabled = true;
    sendBtn.style.opacity = '.5';
    sendBtn.style.cursor = 'not-allowed';
    wrap.querySelectorAll('.cb-icon').forEach(b => { b.disabled = true; b.style.opacity = '.4'; b.style.cursor = 'not-allowed'; });
  }

  // ---- 发送/停止 ----
  let attachPending = false;  // 引用直读异步取 token 期间禁发送（大文件估算要几秒，
                              // 十五五实战：读取未完就发 = 文件没进上下文，AI 报"没收到"）
  function doSend() {
    if (isLegacy) return;
    if (attachPending) return;  // 附件读取中——chip 出现才放行
    const text = textarea.value.trim();
    if (!text && !attach) return;
    const payload = {
      text,
      actionMode: state.actionMode,
      filePath: attach ? (attach.kind === 'upload' ? attach.path : attach.ids) : null,
      fileTag: attach ? (attach.kind === 'upload'
        ? { name: attach.name, source: 'upload' }
        : { name: attach.names.join('、'), source: 'kb' }) : null,
    };
    textarea.value = '';
    state.chipTip = '';
    attach = null;
    attachTokens = 0;
    renderTray();
    renderChips();
    updateTokenBar();
    events.onSend(payload);
  }

  sendBtn.addEventListener('click', doSend);
  stopBtn.addEventListener('click', () => events.onStop());
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
  // 自适应高度 + token 聚合条联动
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
    updateTokenBar();
  });

  // ---- 「添加」浮条菜单（附件文档/知识库引用，OpenWebUI pill 范式） ----
  const addBtn = wrap.querySelector('[data-act="add"]');
  const addMenu = wrap.querySelector('.cb-add-menu');
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    addMenu.style.display = addMenu.style.display === 'none' ? 'flex' : 'none';
  });
  document.addEventListener('click', () => { addMenu.style.display = 'none'; });
  addMenu.addEventListener('click', () => { addMenu.style.display = 'none'; });

  // ---- 附件：上传文档 ----
  wrap.querySelector('[data-act="upload"]').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    const session = events.getSession && events.getSession();
    try {
      const fd = new FormData();
      fd.append('file', f);
      let url = '/api/file_upload';
      if (session && session.name) url += '?chat_id=' + encodeURIComponent(session.name);
      const resp = await fetch(url, { method: 'POST', body: fd });
      const data = await resp.json();
      if (data.path) {
        attach = { kind: 'upload', name: f.name, path: data.path };
        attachTokens = Math.round(f.size / 1024 * FILE_TOKENS_PER_KB);
        renderTray();
        updateTokenBar();
        events.onAttachChange(attach);
      }
    } catch (e) { console.warn('[v2] 上传失败', e); }
    fileInput.value = '';
  });

  // ---- 附件：KB 文档选择（简化模态，多选） ----
  wrap.querySelector('[data-act="kb"]').addEventListener('click', async () => {
    try {
      const resp = await fetch('/api/kb/documents');
      const data = await resp.json();
      const files = (Array.isArray(data) ? data : (data.files || [])).filter(f => f.status === 'ready');
      if (!files.length) { alert('知识库中没有文档，请先上传'); return; }
      _showKbPicker(files, (picked) => {
        attach = { kind: 'kb', names: picked.map(p => p.filename), ids: picked.map(p => p.id || p.doc_id).join(',') };
        attachTokens = Math.ceil(picked.reduce((sum, p) => sum + (p.total_chars || 0), 0) / 1.5);
        renderTray();
        updateTokenBar();
        events.onAttachChange(attach);
      });
    } catch (e) { console.warn('[v2] KB 列表失败', e); }
  });

  // ---- 附件：引用项目里的文件（跨项目，M2-6 用户级文件区消融） ----
  wrap.querySelector('[data-act="projfile"]').addEventListener('click', async () => {
    try {
      const r = await api.listProjects();
      const projs = (r.projects || []).filter(p => p.status !== 'missing');
      if (!projs.length) { alert('还没有项目'); return; }
      _showProjFilePicker(projs);
    } catch (e) { console.warn('[v2] 项目列表失败', e); }
  });

  // 项目文件选择模态：选项目 → 列出该项目根目录文件 → 点选引用（直读不复制）
  function _showProjFilePicker(projs) {
    const overlay = document.createElement('div');
    overlay.className = 'kb-pk-overlay';
    overlay.innerHTML = `
      <div class="kb-pk">
        <div class="kb-pk-title">引用项目里的文件（直读，AI 读原文件）</div>
        <div class="kb-pk-list">
          <select class="kb-pk-proj">${projs.map(p => `<option value="${esc(p.dir)}">${esc(p.display)}</option>`).join('')}</select>
          <div class="kb-pk-files"><div class="vw-empty"><small>加载中…</small></div></div>
        </div>
        <div class="kb-pk-acts"><button class="kb-pk-cancel">取消</button></div>
      </div>`;
    document.body.appendChild(overlay);
    const sel = overlay.querySelector('.kb-pk-proj');
    const box = overlay.querySelector('.kb-pk-files');
    async function loadFiles() {
      box.innerHTML = '<div class="vw-empty"><small>加载中…</small></div>';
      try {
        const d = await api.listProjectFiles(sel.value);
        const files = (d.files || []).filter(f => !f.is_dir);
        box.innerHTML = files.length
          ? files.map(f => `<button class="kb-pk-item kb-pk-file" data-name="${esc(f.name)}">${icon('fileText')} ${esc(f.name)} <span class="vw-pkb-sz">${f.size || ''}</span></button>`).join('')
          : '<div class="vw-empty"><small>这个项目根目录还没有文件</small></div>';
        box.querySelectorAll('.kb-pk-file').forEach(b => b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            const rr = await fetch('/api/projects/reference', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ dir: sel.value, name: b.dataset.name }),
            });
            const rd = await rr.json();
            if (rd && rd.path) {
              attach = { kind: 'upload', name: rd.filename, path: rd.path };
              attachTokens = rd.tokens || 0;
              renderTray();
              updateTokenBar();
              events.onAttachChange(attach);
              overlay.remove();
            } else {
              alert((rd && rd.error) || '引用失败');
              b.disabled = false;
            }
          } catch (e) { alert('引用失败'); b.disabled = false; }
        }));
      } catch (e) {
        box.innerHTML = '<div class="vw-empty"><small>读取失败</small></div>';
      }
    }
    sel.addEventListener('change', loadFiles);
    overlay.querySelector('.kb-pk-cancel').addEventListener('click', () => overlay.remove());
    loadFiles();
  }

  function _showKbPicker(files, onOk) {
    const overlay = document.createElement('div');
    overlay.className = 'kb-pk-overlay';
    overlay.innerHTML = `
      <div class="kb-pk">
        <div class="kb-pk-title">选择知识库文档（可多选）</div>
        <div class="kb-pk-list">
          ${files.map(f => `<label class="kb-pk-item"><input type="checkbox" value="${esc(f.id || f.doc_id || '')}" data-name="${esc(f.filename)}" data-chars="${f.total_chars || 0}"> ${esc(f.filename)}</label>`).join('')}
        </div>
        <div class="kb-pk-acts"><button class="kb-pk-cancel">取消</button><button class="kb-pk-ok">确定</button></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.kb-pk-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.kb-pk-ok').addEventListener('click', () => {
      const picked = [...overlay.querySelectorAll('input:checked')].map(i => ({ id: i.value, doc_id: i.value, filename: i.dataset.name, total_chars: +(i.dataset.chars || 0) }));
      overlay.remove();
      if (picked.length) onOk(picked);
    });
  }

  // 生成中切换发送/停止（旧版会话恒禁用，不被 setRunning 复活）
  function setRunning(running) {
    sendBtn.style.display = running ? 'none' : '';
    stopBtn.style.display = running ? '' : 'none';
    textarea.disabled = running || isLegacy;
  }

  // 外部注入附件（工作目录「引用」：import 返回与上传同构的 {path, filename, tokens}）
  function setAttach(att) {
    attach = att;
    attachTokens = att && att.tokens ? att.tokens : 0;
    attachPending = false;
    sendBtn.disabled = false;
    sendBtn.style.opacity = '';
    renderTray();
    updateTokenBar();
    events.onAttachChange(attach);
  }

  // 引用直读读取中的发送门禁（attach 还没就位时禁点发送）
  function setAttachPending(p) {
    attachPending = p;
    sendBtn.disabled = !!p;
    sendBtn.style.opacity = p ? '.5' : '';
    sendBtn.title = p ? '附件读取中…' : '';
  }

  return { el: wrap, setRunning, setAttach, setAttachPending, focus: () => textarea.focus() };
}

// 拉离线 action 列表（经典版 /api/action/list）
export async function loadLocalActions() {
  try {
    const r = await fetch('/api/action/list');
    const d = await r.json();
    return d.actions || [];
  } catch (e) { return []; }
}

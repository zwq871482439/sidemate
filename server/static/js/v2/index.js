// 桌伴 0.10.1 新版 UI 入口（M1-D 三栏骨架，按原型 v14）
// 本版范围：三栏骨架 + 左栏（真数据）+ 空状态场景卡 + 会话消息查看 + 对话发送/流式。
// KB/设置迁入在后续迭代（经典版 / 始终可用）。
import './styles.css';
import { api, MODE_LABEL, getModelTag } from './api.js';
import { renderSidebar, loadSessions } from './sidebar.js';
import { renderEmptyState } from './empty_state.js';
import { renderChatFlow, loadMessages } from './chat_view.js';
import { renderComposer, loadLocalActions, estimateTokens } from './composer.js';
import { createChatStream } from './stream_chat.js';
import { createKBView } from './kb.js';
import { createSettingsView } from './settings.js';
import { createViewer } from './viewer.js';
import { createCardArea } from './cards.js';

const state = {
  mode: 'cloud',      // 后端值：local/cloud/parallel
  tab: 'chat',
  sessions: [],
  filter: '',
  collapsed: false,
  userToggledSidebar: false,  // 用户手动折叠过 → 断点不再自动接管
  messages: null,     // 当前会话消息（null=未加载/空状态）
  actionMode: 'chat', // 离线 action / 在线恒 chat（chips 只预填引导词）
  localActions: [],   // 离线 action 列表
  contextWindow: 8192,
  modelTag: '',
  scene: '',          // 场景占位符 tag（空状态场景卡落 tag，不打字进输入框）
  kbTree: null,       // KB 模式下左栏文档范围树
  collapsedGroups: {},     // 项目分组折叠态
  projectWorkdirs: {},     // 项目 → {workdir, source, locked, session_count}
  projects: [],            // 已注册项目名（含无会话的空项目）
  workdir: null,           // 当前会话生效目录 {workdir, source, group, locked, session_count} | null
  parallelEnabled: false,  // 并行实验开关（设置 → 在线 AI）
  generating: false,
  switching: false,   // 模式切换骨架屏态
};

const app = document.getElementById('app');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 断点（原型 v14/PLAN 8.5）：≥1280 三栏；1100-1280 左栏默认折叠为悬浮条；
// <1100 不允许（应用最小窗口 1100px 硬约束）。右视窗窄屏浮层态见 styles.css body.narrow。
let _modeSeq = 0;  // 模式切换竞态守卫：只认最后一次点击的响应
let _modePending = null;  // 在途目标模式（连点时第二次点击不被陈旧 state 吞掉）

function applyBreakpoint() {
  const narrow = window.innerWidth < 1280;
  document.body.classList.toggle('narrow', narrow);
  if (state.userToggledSidebar) return;
  if (narrow !== state.collapsed) {
    state.collapsed = narrow;
    render();
  }
}

// 由 KB 文档构建左栏范围树（分类聚合 + graph 子类 + 私密 + 未分组 + 最近7天）
function buildKbTree(docs, overview) {
  const cats = {};
  const subMap = {};
  ((overview && overview.graph && overview.graph.nodes) || []).forEach(n => {
    if (n.doc_id && n.group) subMap[n.doc_id] = { group: n.group, sub: n.sub };
  });
  window._v2KbSubMap = subMap;  // kb.js 树筛选用（cat:组/子）
  let privates = 0, ungrouped = 0, recent = 0;
  docs.forEach(d => {
    const c = (d.category || '').trim();
    if (d.is_private) privates++;
    if (!c) ungrouped++; else cats[c] = (cats[c] || 0) + 1;
    const t = Date.parse(d.imported_at || '');
    if (t && Date.now() - t <= 7 * 86400e3) recent++;
  });
  const catArr = Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([name, count]) => {
    const subs = {};
    docs.forEach(d => {
      const m = subMap[d.doc_id];
      if (m && m.group === name && m.sub) subs[m.sub] = (subs[m.sub] || 0) + 1;
    });
    return { name, count, subs: Object.entries(subs).map(([n2, c2]) => ({ name: n2, count: c2 })) };
  });
  return { total: docs.length, recent, cats: catArr, privates, ungrouped,
    kbFilterSel: _kbView ? _kbView.getFilter() : '' };
}

// ===== 对话发送（M1-B 单写：流末拉后端快照重建） =====
const chatStream = createChatStream({
  getSession: () => state.sessions.find(c => c.current),
  onUserMsg: (msg) => {
    state.messages = (state.messages || []).concat([msg]);
    _cards = createCardArea();
    _doneData = null;
    renderChatArea();
  },
  onStreamTick: (st, phase) => { _streamState = st; renderStreamingBubble(st); },
  onCardEvent: (d) => { if (_cards) _cards.handleEvent(d); },
  onDoneData: (d) => { _doneData = d; },
  onDone: async () => {
    state.generating = false;
    _streamState = null;
    // card_data 视图态回写（唯一前端写通道，msg_id 定向；M1-B 边界）
    if (_cards && _doneData && _doneData.msg_id) {
      try {
        const cardData = _cards.finalize();
        if (cardData.length) {
          const cur = state.sessions.find(c => c.current);
          if (cur) {
            await fetch('/api/chats/' + encodeURIComponent(cur.name) + '/enrich', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ msg_id: _doneData.msg_id, card_data: cardData }),
            });
          }
        }
      } catch (e) { /* 视图态回写失败不影响消息正文 */ }
    }
    _cards = null;
    _doneData = null;
    state.sessions = await loadSessions();   // 先刷新列表（msg_count 已变）
    await loadCurrentMessages();             // 后端快照 = 真相
    render();
  },
});
let _streamState = null;
let _composer = null;
let _cards = null;      // 本轮明盒卡片区
let _doneData = null;   // done 事件数据（含 msg_id）
let _kbView = null;  // KB 视图单例（切走销毁，切回新建）
let _settingsView = null;  // 设置视图单例（无后台资源，常驻即可）

function render() {
  app.innerHTML = '';
  app.appendChild(renderSidebar(app, state, {
    onMode: async (m) => {
      if (m === state.mode && !_modePending) return;
      if (m === _modePending) return;  // 重复点击同一目标
      _modePending = m;
      const seq = ++_modeSeq;
      // 骨架屏过渡（经典版同款：切换期间聊天区鱼骨加载 + 输入区锁定）
      state.switching = true;
      render();
      const r = await api.switchMode(m);
      if (seq !== _modeSeq) return;  // 竞态守卫：旧响应丢弃
      _modePending = null;
      state.switching = false;
      if (r && r.ok) {
        state.mode = r.mode;
        // 上限随模型/模式动态变化；注意 /api/mode/switch 回的是真实窗口 1048576，
        // 而 /api/mode 回的是展示口径 1000000——与经典版一致，switch 后重拉 /api/mode
        try {
          const m2 = await api.getMode();
          if (m2 && m2.context_window) state.contextWindow = m2.context_window;
        } catch (e) { /* 保底用 switch 返回值 */ if (r.context_window) state.contextWindow = r.context_window; }
        state.modelTag = await getModelTag(state.mode);
        if (state.mode === 'local' && !state.localActions.length) {
          state.localActions = await loadLocalActions();
        }
        render();
      } else {
        render();  // 失败也要撤掉骨架屏
      }
    },
    onTab: (t) => {
      if (state.tab === 'kb' && _kbView) { _kbView.destroy(); _kbView = null; }
      state.tab = t;
      render();
    },
    onSelectSession: async (c) => {
      if (c.current && state.messages !== null) return;
      await api.switchChat(c.path);
      state.sessions = await loadSessions();
      state.tab = 'chat';
      await loadCurrentMessages();
      await loadWorkdir();
      if (_viewer) _viewer.onSessionChange();
      render();
    },
    onNewProject: async () => {
      const name = await v2Prompt('新建项目（开始对话前可换绑目录）', '');
      if (!name) return;
      try {
        await api.createProject(name);
      } catch (e) {
        alert('新建项目失败：' + (e && e.message ? e.message : '名称不可用'));
        return;
      }
      state.sessions = await loadSessions();
      await loadProjectWorkdirs();
      render();
    },
    onNewChatInGroup: async (g) => {
      await api.newChat(g);
      state.sessions = await loadSessions();
      state.tab = 'chat';
      state.messages = null;  // 新会话 → 空状态
      await loadProjectWorkdirs();  // 项目会话数/锁定态变化
      await loadWorkdir();
      render();
    },
    onToggleCollapse: () => {
      // 交叉淡化：当前态滑出 → 切换 → 新态滑入（position 突变不可过渡的掩盖）
      const sb = document.getElementById('sidebar');
      if (sb) {
        sb.classList.add('sb-anim', 'sb-out');
        setTimeout(() => {
          state.collapsed = !state.collapsed;
          state.userToggledSidebar = true;  // 手动操作后断点让位
          render();
          const sb2 = document.getElementById('sidebar');
          if (sb2) {
            sb2.classList.add('sb-anim', 'sb-out');
            requestAnimationFrame(() => requestAnimationFrame(() => sb2.classList.remove('sb-out')));
            setTimeout(() => sb2.classList.remove('sb-anim'), 260);
          }
        }, 180);
      } else {
        state.collapsed = !state.collapsed;
        state.userToggledSidebar = true;
        render();
      }
    },
    onFilter: (v) => { state.filter = v; render(); },
    onToggleGroup: (g) => {
      state.collapsedGroups[g] = !state.collapsedGroups[g];
      render();
    },
    onSessionMenu: (c, anchorEl) => showSessionMenu(c, anchorEl),
    onProjectDir: (g, anchorEl) => {
      const wd = state.projectWorkdirs[g] || {};
      showWorkdirMenu(anchorEl, { group: g, workdir: wd.workdir || null, source: wd.source || 'default', locked: !!wd.locked, session_count: wd.session_count || 0 });
    },
    onKbFilter: (kf) => {
      if (!_kbView) return;
      _kbView.setFilter(kf);
      state.kbTree = buildKbTree(_kbView.getDocs(), _kbView.getOverview());
      state.kbTree.kbFilterSel = kf;
      render();
    },
  }));

  const main = document.createElement('main');
  main.id = 'main';
  main.innerHTML = `
    <div class="topbar">
      <span class="tb-title">${state.tab === 'chat' ? '对话' : state.tab === 'kb' ? '知识库' : '设置'}</span>
      ${state.tab === 'chat' && state.modelTag ? `<span class="tb-model">${esc(state.modelTag)}</span>` : ''}
      ${state.tab === 'kb' ? '<span id="kb-topbar-slot" class="tb-slot"></span>' : ''}
      <span class="tb-spacer"></span>
      <button class="tb-viewer ${_viewer && _viewer.isOpen ? 'on' : ''}" id="tbViewerBtn" title="视窗（预览/文件/轨迹）">◧ 视窗</button>
      <a class="tb-link" href="/" title="回经典版界面">经典版 ↗</a>
    </div>
    <div id="main-scroll"></div>
  `;
  app.appendChild(main);

  if (state.tab === 'chat') {
    renderChatArea();
  } else if (state.tab === 'kb') {
    // KB 管理视图（KB-1 增量实装；星图在 KB-2）
    const scroll = main.querySelector('#main-scroll');
    if (!_kbView) {
      _kbView = createKBView({
        onGoClassic: () => { location.href = '/'; },
        onAskChat: (q) => {
          // 推荐追问：切聊天 tab 预填输入框
          state.tab = 'chat';
          render();
          const ta = document.querySelector('.composer textarea');
          if (ta) { ta.value = q; ta.focus(); }
        },
        onDocsChange: (docs) => {
          state.kbTree = buildKbTree(docs, _kbView ? _kbView.getOverview() : null);
          render();
        },
      });
      _kbView.mount();
    }
    scroll.appendChild(_kbView.el);
    _kbView.renderTopbar();  // KB 工具区在顶栏（星图覆盖内容区也可切回清单）
  } else {
    // 设置：壳 + 常规子页已迁入；其余子页在设置内占位逐页迁
    const scroll = main.querySelector('#main-scroll');
    if (!_settingsView) {
      _settingsView = createSettingsView({ onGoClassic: () => { location.href = '/'; } });
      _settingsView.mount();
    }
    scroll.appendChild(_settingsView.el);
  }

  // 右视窗（会话/预览/文件/轨迹）
  if (!_viewer) {
    _viewer = createViewer({
      getCurrentChat: () => state.sessions.find(c => c.current),
      getSessions: () => state.sessions,
      getHarness: () => ({ modeLabel: MODE_LABEL[state.mode] || state.mode, modelTag: state.modelTag }),
      onSwitchSession: async (c) => {
        await api.switchChat(c.path);
        state.sessions = await loadSessions();
        state.tab = 'chat';
        await loadCurrentMessages();
        await loadWorkdir();
        if (_viewer) _viewer.onSessionChange();
        render();
      },
      onImportFile: async (name, btn) => {
        const cur = state.sessions.find(c => c.current);
        if (!cur) return;
        if (btn) { btn.disabled = true; btn.textContent = '…'; }
        try {
          const r = await api.importWorkdirFile(cur.name, name);
          if (r && r.path) {
            // 与上传附件同构：进输入区附件栏，发送时走既有管道
            if (_composer) _composer.setAttach({ kind: 'upload', name: r.filename, path: r.path, tokens: r.tokens });
          } else {
            alert((r && r.error) || '引用失败');
          }
        } catch (e) {
          alert('引用失败：' + (e && e.message ? e.message : '未知错误'));
        }
        if (btn) { btn.disabled = false; btn.textContent = '引用'; }
      },
    });
  }
  app.appendChild(_viewer.el);
  const vb = document.getElementById('tbViewerBtn');
  if (vb) vb.addEventListener('click', () => { _viewer.toggle(); });
}

let _viewer = null;

// Escape 收起视窗（PLAN 定稿）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _viewer && _viewer.isOpen) _viewer.setOpen(false);
});

// 中栏对话区：消息流 + 输入区（生成中时含流式气泡）
function renderChatArea() {
  const scroll = document.getElementById('main-scroll');
  if (!scroll) return;
  if (state.switching) {
    // 鱼骨加载（模式切换中）：消息区骨架条，输入区锁定
    scroll.innerHTML = '<div class="skel-wrap">' +
      '<div class="skel-line" style="width:38%"></div>' +
      '<div class="skel-line" style="width:72%"></div>' +
      '<div class="skel-line" style="width:64%"></div>' +
      '<div class="skel-line" style="width:30%"></div></div>';
  } else if (state.messages && state.messages.length) {
    renderChatFlow(scroll, state.messages);
  } else {
    scroll.innerHTML = '';
    scroll.appendChild(renderEmptyState(state.mode, { onScene: onScene }));
  }
  if (state.generating && _streamState) renderStreamingBubble(_streamState);

  // 输入区（对话 tab 常驻）
  const main = document.getElementById('main');
  const old = main.querySelector('.composer');
  if (old) old.remove();
  // 历史 token 估算（经典版口径：中文 1.5 字/token，英文 4 字/token）
  const historyTokens = (state.messages || []).reduce((s, m) => s + estimateTokens(m.content || '') + estimateTokens(m.think || ''), 0);
  _composer = renderComposer({
    mode: state.mode,
    actionMode: state.actionMode,
    localActions: state.localActions,
    contextWindow: state.contextWindow,
    historyTokens,
    hasMessages: !!(state.messages && state.messages.length),
    scene: state.scene,
    chipTip: '',
    workdir: state.workdir,
  }, {
    onSend: onSend,
    onStop: () => chatStream.stop(),
    onSceneClear: () => { state.scene = ''; state.actionMode = 'chat'; renderChatArea(); },
    onChipMode: (m) => { state.actionMode = m; },
    onAttachChange: () => {},
    onWorkdirClick: (anchorEl) => {
      if (!state.workdir) return;
      showWorkdirMenu(anchorEl, { group: state.workdir.group, workdir: state.workdir.workdir, source: state.workdir.source, locked: !!state.workdir.locked, session_count: state.workdir.session_count || 0 });
    },
    getSession: () => state.sessions.find(c => c.current),
  });
  _composer.setRunning(state.generating || state.switching);
  main.appendChild(_composer.el);
}

// 流式气泡：生成中追加在消息区末尾（不污染 state.messages，流末快照重建）
function renderStreamingBubble(st) {
  const flow = document.querySelector('.chat-flow');
  if (!flow) return;
  let el = document.getElementById('v2-stream-msg');
  if (!el) {
    el = document.createElement('div');
    el.className = 'msg ai streaming';
    el.id = 'v2-stream-msg';
    el.innerHTML = `
      <div class="m-body">
        <div class="m-name">桌伴 · 生成中…</div>
        <div class="stream-status"></div>
        <div class="m-sources" style="display:none"></div>
        <div class="v2-card-slot"></div>
        <div class="m-bubble md"></div>
      </div>`;
    flow.appendChild(el);
  }
  const slot = el.querySelector('.v2-card-slot');
  if (slot && _cards && !_cards.isEmpty() && !slot.contains(_cards.el)) slot.appendChild(_cards.el);
  const bubble = el.querySelector('.m-bubble');
  const statusEl = el.querySelector('.stream-status');
  const srcEl = el.querySelector('.m-sources');
  statusEl.textContent = st.status || '';
  statusEl.style.display = st.status ? '' : 'none';
  if (st.sources && st.sources.length) {
    srcEl.style.display = 'flex';
    srcEl.innerHTML = st.sources.map(s =>
      `<span class="m-src">${esc(s.label || s.source_label || '')}</span>`).join('');
  }
  bubble.innerHTML = mdStream(st.text + (st.error ? '\n\n⚠️ ' + st.error : ''));
  const scroll = document.getElementById('main-scroll');
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

function mdStream(text) {
  if (!text) return '<span style="color:var(--d1-ink-3)">思考中…</span>';
  if (typeof marked !== 'undefined') {
    const html = marked.parse(text, { breaks: true });
    return typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html;
  }
  return esc(text).replace(/\n/g, '<br>');
}

async function onSend(payload) {
  if (state.generating) return;
  // 无会话则先建（零摩擦开始：空状态直达）
  if (!state.sessions.find(c => c.current)) {
    await api.newChat();
    state.sessions = await loadSessions();
    await loadWorkdir();
  }
  // 历史：经典版简化照搬——丢弃空/错误 assistant，长回答截断 1500 字
  const history = (state.messages || [])
    .filter(m => !(m.role === 'assistant' && (!m.content || !m.content.trim()
      || m.content.startsWith('[ERROR]') || m.content.includes('[TIMEOUT'))))
    .map(m => (m.role === 'assistant' && m.content && m.content.length > 1500)
      ? Object.assign({}, m, { content: m.content.slice(0, 1500) + '\n\n...（内容过长已截断）' })
      : m);
  state.scene = '';  // 发送后场景 tag 清空
  state.scene = '';  // 发送后场景 tag 清空
  state.generating = true;
  renderChatArea();
  _composer.setRunning(true);
  // action_mode 映射（经典版同款）：agent→chat，kb_qa→kb
  let actionMode = payload.actionMode || 'chat';
  if (actionMode === 'agent') actionMode = 'chat';
  if (actionMode === 'kb_qa') actionMode = 'kb';
  await chatStream.send({
    text: payload.text,
    actionMode,
    filePath: payload.filePath,
    fileTag: payload.fileTag,
    history,
  });
}

async function loadCurrentMessages() {
  const cur = state.sessions.find(c => c.current);
  if (!cur || !cur.msg_count) {
    state.messages = null;
    return;
  }
  try {
    state.messages = await loadMessages(cur.name);
  } catch (e) {
    state.messages = null;
  }
}

// ===== 工作目录（M1 只读版：项目 ↔ 目录 1:1，目录=项目属性） =====
async function loadWorkdir() {
  const cur = state.sessions.find(c => c.current);
  if (!cur) { state.workdir = null; return; }
  try {
    state.workdir = await api.getWorkdir(cur.name);
  } catch (e) { state.workdir = null; }
}

async function loadProjectWorkdirs() {
  try {
    const groups = [...new Set(state.sessions.map(c => c.group || '日常').concat(state.projects))];
    const d = await api.getProjectWorkdirs(groups);
    state.projects = d.projects || [];
    // 新注册的空项目首轮不在 groups 里，补一轮拿它的默认目录
    const missing = state.projects.filter(p => !(d.workdirs || {})[p]);
    if (missing.length) {
      const d2 = await api.getProjectWorkdirs([...new Set(groups.concat(missing))]);
      state.projectWorkdirs = d2.workdirs || {};
      state.projects = d2.projects || state.projects;
    } else {
      state.projectWorkdirs = d.workdirs || {};
    }
  } catch (e) { state.projectWorkdirs = {}; state.projects = []; }
}

// 换绑成功后的首次说明卡（PLAN 一次性提示，M1 只读口径）
function maybeShowWorkdirTip() {
  try { if (localStorage.getItem('v2WdTipSeen')) return; } catch (e) { /* 隐私模式 */ }
  const ov = document.createElement('div');
  ov.className = 'kb-pk-overlay';
  ov.innerHTML = `<div class="kb-pk" style="width:440px">
    <div class="kb-pk-title">工作目录已换绑</div>
    <div class="wd-tip">
      <p>· 当前为<strong>只读</strong>版本：界面只读取展示该目录，AI 与软件都不会写入、修改或删除其中的任何文件。</p>
      <p>· 与知识库<strong>完全独立</strong>：目录里的文件不会进知识库、不会被向量化。</p>
      <p>· 对话记录仍保存在软件内部，不会迁移到该目录。</p>
      <p>· 项目下<strong>所有会话共用</strong>这个目录；在视窗里点「引用」，文件就会作为材料进入当前对话。</p>
    </div>
    <div class="kb-pk-acts"><button class="kb-pk-ok">知道了</button></div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('.kb-pk-ok').addEventListener('click', () => {
    try { localStorage.setItem('v2WdTipSeen', '1'); } catch (e) { /* 忽略 */ }
    ov.remove();
  });
}

// 内联目录选择器（取代原生对话框：面包屑 + 快捷入口 + 子目录列表 + 粘贴路径）
function showDirPicker(onPick) {
  const ov = document.createElement('div');
  ov.className = 'kb-pk-overlay';
  ov.innerHTML = `<div class="kb-pk dir-pk">
    <div class="kb-pk-title">选择工作目录</div>
    <div class="dp-quick"></div>
    <div class="dp-crumb"></div>
    <input class="set-input dp-path" placeholder="也可以直接粘贴路径，回车跳转">
    <div class="dp-list"><div class="vw-empty">加载中…</div></div>
    <div class="kb-pk-acts">
      <button class="kb-pk-cancel">取消</button>
      <button class="kb-pk-ok dp-ok" disabled>选这个文件夹</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  let cur = null;  // 当前浏览路径（null=根「此电脑」）
  const listEl = ov.querySelector('.dp-list');
  const crumbEl = ov.querySelector('.dp-crumb');
  const quickEl = ov.querySelector('.dp-quick');
  const pathIn = ov.querySelector('.dp-path');
  const okBtn = ov.querySelector('.dp-ok');

  async function nav(path) {
    listEl.innerHTML = '<div class="vw-empty">加载中…</div>';
    let d;
    try {
      d = await api.browseDirs(path);
    } catch (e) {
      listEl.innerHTML = '<div class="vw-empty">目录不存在或不可读</div>';
      return;
    }
    cur = d.path;
    pathIn.value = cur || '';
    okBtn.disabled = !cur;
    // 面包屑：此电脑 › C: › deskware › …
    crumbEl.innerHTML = '';
    const rootB = document.createElement('button');
    rootB.className = 'dp-seg' + (cur ? '' : ' cur');
    rootB.textContent = '此电脑';
    rootB.addEventListener('click', () => nav(null));
    crumbEl.appendChild(rootB);
    if (cur) {
      const segs = cur.split(/[\\/]+/).filter(Boolean);
      let p = '';
      segs.forEach((s, i) => {
        p = i === 0 ? s + '\\' : p + s + '\\';
        crumbEl.appendChild(document.createTextNode(' › '));
        const b = document.createElement('button');
        b.className = 'dp-seg' + (i === segs.length - 1 ? ' cur' : '');
        b.textContent = s;
        const target = p;
        b.addEventListener('click', () => nav(target));
        crumbEl.appendChild(b);
      });
    }
    // 快捷入口
    quickEl.innerHTML = '';
    (d.quick || []).forEach(q => {
      const b = document.createElement('button');
      b.className = 'dp-q';
      b.textContent = q.name;
      b.addEventListener('click', () => nav(q.path));
      quickEl.appendChild(b);
    });
    // 子目录列表
    listEl.innerHTML = '';
    if (cur && d.parent) {
      const up = document.createElement('div');
      up.className = 'dp-item dp-up';
      up.textContent = '↩ ..（上一级）';
      up.addEventListener('click', () => nav(d.parent));
      listEl.appendChild(up);
    }
    if (!d.entries.length) {
      listEl.insertAdjacentHTML('beforeend', '<div class="vw-empty"><small>没有子目录</small></div>');
    } else {
      d.entries.forEach(e2 => {
        const it = document.createElement('div');
        it.className = 'dp-item';
        it.innerHTML = `<span class="fi">${cur ? '📁' : '💽'}</span> ${esc(e2.name)}`;
        it.addEventListener('click', () => nav(e2.path));
        listEl.appendChild(it);
      });
    }
  }
  pathIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const v = pathIn.value.trim(); if (v) nav(v); }
  });
  ov.querySelector('.kb-pk-cancel').addEventListener('click', () => ov.remove());
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
  okBtn.addEventListener('click', () => {
    if (!cur) return;
    const p = cur;
    ov.remove();
    onPick(p);
  });
  nav(null);
}

// 工作目录弹出菜单（sess-menu 同款 fixed 浮层；侧栏 📂 与输入区 chip 共用）
// info: { group, workdir, source: 'external'|'default' }
let _wdMenuEl = null;
function showWorkdirMenu(anchorEl, info) {
  if (_wdMenuEl) _wdMenuEl.remove();
  const menuEl = document.createElement('div');
  _wdMenuEl = menuEl;
  menuEl.className = 'sess-menu wd-menu';
  const srcLabel = info.source === 'external' ? '外部目录' : '默认目录';
  const locked = !!info.locked;
  menuEl.innerHTML =
    `<span class="sess-menu-sub-h">项目「${esc(info.group)}」工作目录（${srcLabel}）</span>` +
    (info.workdir ? `<div class="wd-path" title="${esc(info.workdir)}">${esc(info.workdir)}</div>` : '') +
    (locked
      ? `<div class="wd-lock-note">🔒 目录已锁定（${info.session_count || 0} 个会话）</div>`
      : `<button data-a="bind">更换目录…（开始对话后锁定）</button>`) +
    (!locked && info.source === 'external' ? `<button data-a="unbind" class="danger">改回默认目录</button>` : '') +
    `<button data-a="open">在资源管理器中打开</button><button data-a="view">在视窗查看</button>`;
  document.body.appendChild(menuEl);
  const r = anchorEl.getBoundingClientRect();
  menuEl.style.left = Math.min(r.left, window.innerWidth - 300) + 'px';
  menuEl.style.top = (r.bottom + 4) + 'px';
  // 锚点近屏幕底（composer chip）时向上翻，避免菜单伸出视口点不到
  const wdMh = menuEl.offsetHeight;
  if (r.bottom + 4 + wdMh > window.innerHeight) menuEl.style.top = Math.max(8, r.top - wdMh - 4) + 'px';
  // 身份守卫：旧菜单的 document 监听可能残留，只允许关闭“当前”菜单，
  // 否则开新菜单的同一次点击（冒泡到 document）会把新菜单瞬间删掉
  const close = (e) => {
    if (_wdMenuEl !== menuEl) { document.removeEventListener('click', close); return; }
    if (!menuEl.contains(e.target)) { menuEl.remove(); _wdMenuEl = null; document.removeEventListener('click', close); }
  };
  setTimeout(() => document.addEventListener('click', close), 0);

  const after = async () => {
    await loadProjectWorkdirs();
    await loadWorkdir();
    if (_viewer) _viewer.onSessionChange();
    render();
  };
  const bindBtn = menuEl.querySelector('[data-a="bind"]');
  if (bindBtn) bindBtn.addEventListener('click', () => {
    menuEl.remove(); if (_wdMenuEl === menuEl) _wdMenuEl = null;
    if (!confirm('项目「' + info.group + '」现在还没有会话，可以换绑目录。\n注意：开始对话后目录将锁定，不能再更换。继续？')) return;
    showDirPicker(async (path) => {
      try {
        await api.setProjectWorkdir(info.group, path);
      } catch (e) {
        alert('换绑失败：' + (e && e.message ? e.message : '目录不可用'));
        return;
      }
      await after();
      maybeShowWorkdirTip();
    });
  });
  const unbindBtn = menuEl.querySelector('[data-a="unbind"]');
  if (unbindBtn) unbindBtn.addEventListener('click', async () => {
    menuEl.remove(); if (_wdMenuEl === menuEl) _wdMenuEl = null;
    await api.setProjectWorkdir(info.group, null);
    await after();
  });
  const openBtn = menuEl.querySelector('[data-a="open"]');
  if (openBtn) openBtn.addEventListener('click', async () => {
    menuEl.remove(); if (_wdMenuEl === menuEl) _wdMenuEl = null;
    const cur = state.sessions.find(c => c.current);
    if (cur) { try { await api.openWorkdir(cur.name); } catch (e) { /* 失败无感 */ } }
  });
  const viewBtn = menuEl.querySelector('[data-a="view"]');
  if (viewBtn) viewBtn.addEventListener('click', () => {
    menuEl.remove(); if (_wdMenuEl === menuEl) _wdMenuEl = null;
    if (_viewer) _viewer.setOpen(true, 'session');
  });
}

function onScene(scene) {
  // 场景卡 = 场景占位符 tag（输入框顶部金色 chip + 场景化 placeholder）+ 视线引导
  // 用户定稿：不再把引导词打进去（可编辑文本会挡输入），tag 随发送清空
  if (state.mode === 'local') {
    const sceneMode = { doc: 'doc', kb: 'kb_qa', chat: 'chat' }[scene];
    if (sceneMode) state.actionMode = sceneMode;
  }
  state.scene = scene;
  // 保住用户已输入的文字（重建 composer 不清空）
  const taOld = document.querySelector('.composer textarea');
  const keep = taOld ? taOld.value : '';
  renderChatArea();
  const ta = document.querySelector('.composer textarea');
  if (ta) {
    ta.value = keep;
    ta.focus();
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
    const box = document.querySelector('.composer-box');
    if (box) {
      box.classList.add('attn');
      setTimeout(() => box.classList.remove('attn'), 700);
    }
  }
}

// ===== 会话 ⋯ 菜单（重命名/导出/删除；「移到项目」已按 PLAN 1.5 取消——
// 项目 ↔ 目录 1:1 后移动=换目录上下文，语义混乱，会话归属在创建时定） =====
let _menuEl = null;
function showSessionMenu(chat, anchorEl) {
  if (_menuEl) _menuEl.remove();
  const menuEl = document.createElement('div');
  _menuEl = menuEl;
  menuEl.className = 'sess-menu';
  menuEl.innerHTML = `
    <button data-a="rename">重命名</button>
    <button data-a="export">导出（.txt）</button>
    <button data-a="del" class="danger">删除会话</button>`;
  document.body.appendChild(menuEl);
  const r = anchorEl.getBoundingClientRect();
  menuEl.style.left = Math.min(r.right - 180, window.innerWidth - 200) + 'px';
  menuEl.style.top = (r.bottom + 4) + 'px';
  // 底部会话同样上翻，避免菜单伸出视口
  const sessMh = menuEl.offsetHeight;
  if (r.bottom + 4 + sessMh > window.innerHeight) menuEl.style.top = Math.max(8, r.top - sessMh - 4) + 'px';
  // 身份守卫：旧菜单残留的 document 监听不得关闭新菜单（同一次冒泡点击）
  const close = (e) => {
    if (_menuEl !== menuEl) { document.removeEventListener('click', close); return; }
    if (!menuEl.contains(e.target)) { menuEl.remove(); _menuEl = null; document.removeEventListener('click', close); }
  };
  setTimeout(() => document.addEventListener('click', close), 0);

  menuEl.querySelector('[data-a="rename"]').addEventListener('click', async () => {
    menuEl.remove(); if (_menuEl === menuEl) _menuEl = null;
    const nv = await v2Prompt('重命名会话', chat.name);
    if (!nv || nv === chat.name) return;
    await fetch('/api/chats/' + encodeURIComponent(chat.name) + '/rename', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_name: nv }),
    });
    state.sessions = await loadSessions();
    render();
  });
  menuEl.querySelector('[data-a="export"]').addEventListener('click', async () => {
    menuEl.remove(); if (_menuEl === menuEl) _menuEl = null;
    // 经典版同款：拉消息拼 txt 下载
    const resp = await fetch('/api/chats/' + encodeURIComponent(chat.name) + '/messages');
    const data = await resp.json();
    const lines = [];
    (data.messages || []).forEach(m => {
      lines.push((m.role === 'user' ? '你' : (m.model || 'AI')) + (m.ts ? ' (' + m.ts + ')' : ''));
      lines.push(''); lines.push(m.content || ''); lines.push('');
    });
    const blob = new Blob([lines.join(String.fromCharCode(10))], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = chat.name + '.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  menuEl.querySelector('[data-a="del"]').addEventListener('click', async () => {
    menuEl.remove(); if (_menuEl === menuEl) _menuEl = null;
    if (!confirm(`删除会话「${chat.name}」？此操作不可撤销。`)) return;
    await fetch('/api/chats/' + encodeURIComponent(chat.name), { method: 'DELETE' });
    state.sessions = await loadSessions();
    await loadCurrentMessages();
    render();
  });
}

// 轻量输入模态（webview 里原生 prompt 不可靠）
function v2Prompt(title, defVal) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'kb-pk-overlay';
    ov.innerHTML = `<div class="kb-pk" style="width:360px">
      <div class="kb-pk-title">${esc(title)}</div>
      <input class="set-input" id="v2pIn" style="width:100%" value="${esc(defVal || '')}">
      <div class="kb-pk-acts"><button class="kb-pk-cancel">取消</button><button class="kb-pk-ok">确定</button></div>
    </div>`;
    document.body.appendChild(ov);
    const inp = ov.querySelector('#v2pIn');
    inp.focus(); inp.select();
    ov.querySelector('.kb-pk-cancel').addEventListener('click', () => { ov.remove(); resolve(null); });
    ov.querySelector('.kb-pk-ok').addEventListener('click', () => { const v = inp.value.trim(); ov.remove(); resolve(v || null); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const v = inp.value.trim(); ov.remove(); resolve(v || null); }
      if (e.key === 'Escape') { ov.remove(); resolve(null); }
    });
  });
}

async function boot() {
  // 先渲骨架（消除首屏白窗），数据到位再补齐
  render();
  window.addEventListener('resize', applyBreakpoint);
  applyBreakpoint();
  try {
    const m = await api.getMode();
    if (m && m.mode) state.mode = m.mode;
    if (m && m.context_window) state.contextWindow = m.context_window;
    state.modelTag = await getModelTag(state.mode);
    // 并行实验开关（存量迁移：当前并行而开关未点亮 → 自动点亮由设置页负责，这里只读）
    try {
      const all = await fetch('/api/config').then(r => r.json());
      state.parallelEnabled = !!(all && all.config && all.config.parallel_enabled);
    } catch (e) { /* 无配置则关 */ }
  } catch (e) { /* 模式读取失败就用默认在线 */ }
  try {
    if (state.mode === 'local') state.localActions = await loadLocalActions();
    state.sessions = await loadSessions();
    await loadCurrentMessages();
    await loadProjectWorkdirs();
    await loadWorkdir();
  } catch (e) { /* 会话列表失败不阻断空状态 */ }
  render();
}

window.SidemateV2 = { version: '0.10.1-m1d3', mounted: true };
boot();

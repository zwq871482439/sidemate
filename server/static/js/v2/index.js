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

// ===== 对话发送（M1-B 单写：流末拉后端快照重建） =====
const chatStream = createChatStream({
  getSession: () => state.sessions.find(c => c.current),
  onUserMsg: (msg) => {
    state.messages = (state.messages || []).concat([msg]);
    renderChatArea();
  },
  onStreamTick: (st, phase) => { _streamState = st; renderStreamingBubble(st); },
  onDone: async () => {
    state.generating = false;
    _streamState = null;
    state.sessions = await loadSessions();   // 先刷新列表（msg_count 已变）
    await loadCurrentMessages();             // 后端快照 = 真相
    render();
  },
});
let _streamState = null;
let _composer = null;
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
      if (_viewer) _viewer.onSessionChange();
      render();
    },
    onNewChat: async () => {
      await api.newChat();
      state.sessions = await loadSessions();
      state.tab = 'chat';
      state.messages = null;  // 新会话 → 空状态
      render();
    },
    onToggleCollapse: () => {
      state.collapsed = !state.collapsed;
      state.userToggledSidebar = true;  // 手动操作后断点让位
      render();
    },
    onFilter: (v) => { state.filter = v; render(); },
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

  // 右视窗（预览/文件/轨迹）
  if (!_viewer) {
    _viewer = createViewer({ getCurrentChat: () => state.sessions.find(c => c.current) });
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
    chipTip: '',
  }, {
    onSend: onSend,
    onStop: () => chatStream.stop(),
    onChipMode: (m) => { state.actionMode = m; },
    onAttachChange: () => {},
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
        <div class="m-bubble md"></div>
      </div>`;
    flow.appendChild(el);
  }
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
  }
  // 历史：经典版简化照搬——丢弃空/错误 assistant，长回答截断 1500 字
  const history = (state.messages || [])
    .filter(m => !(m.role === 'assistant' && (!m.content || !m.content.trim()
      || m.content.startsWith('[ERROR]') || m.content.includes('[TIMEOUT'))))
    .map(m => (m.role === 'assistant' && m.content && m.content.length > 1500)
      ? Object.assign({}, m, { content: m.content.slice(0, 1500) + '\n\n...（内容过长已截断）' })
      : m);
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

function onScene(scene) {
  // 场景卡 = 预填引导 prompt + 视线引导 + 离线 action 模式联动
  // （点了「文档生成」chips 也要跟着亮——不能只预填不切管道）
  if (state.mode === 'local') {
    const sceneMode = { doc: 'doc', kb: 'kb_qa', chat: 'chat' }[scene];
    if (sceneMode) state.actionMode = sceneMode;
  }
  const SCENE_TIPS = {
    ppt: '请帮我做一份演示文稿 PPT：',
    doc: '请帮我写一份 Word 文档：',
    report: '请帮我做一份图文并茂的报告（带图表）：',
    poster: '请帮我设计一张海报/封面：',
    gzh: '请帮我写一篇公众号文章：',
    search: '请联网搜索下面这个主题：',
    deep: '请对以下内容做深度分析：',
    chat: '',
  };
  const tip = SCENE_TIPS[scene] || '';
  const textarea = document.querySelector('.composer textarea');
  if (textarea) {
    if (tip) textarea.value = tip;
    textarea.focus();
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
    textarea.dispatchEvent(new Event('input'));  // 本轮预判条同步
    const box = document.querySelector('.composer-box');
    if (box) {
      box.classList.add('attn');
      setTimeout(() => box.classList.remove('attn'), 700);
    }
  }
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
  } catch (e) { /* 模式读取失败就用默认在线 */ }
  try {
    if (state.mode === 'local') state.localActions = await loadLocalActions();
    state.sessions = await loadSessions();
    await loadCurrentMessages();
  } catch (e) { /* 会话列表失败不阻断空状态 */ }
  render();
}

window.SidemateV2 = { version: '0.10.1-m1d3', mounted: true };
boot();

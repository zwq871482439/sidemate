// 桌伴 0.10.1 新版 UI 入口（M1-D 三栏骨架，按原型 v14）
// 本版范围：三栏骨架 + 左栏（真数据）+ 空状态场景卡 + 会话消息查看（旧会话适配）。
// 流式发送/KB/设置的迁入在后续迭代（经典版 / 始终可用）。
import './styles.css';
import { api, MODE_LABEL } from './api.js';
import { renderSidebar, loadSessions } from './sidebar.js';
import { renderEmptyState } from './empty_state.js';
import { renderChatFlow, loadMessages } from './chat_view.js';

const state = {
  mode: 'cloud',      // 后端值：local/cloud/parallel
  tab: 'chat',
  sessions: [],
  filter: '',
  collapsed: false,
  userToggledSidebar: false,  // 用户手动折叠过 → 断点不再自动接管
  messages: null,     // 当前会话消息（null=未加载/空状态）
};

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

const app = document.getElementById('app');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function render() {
  app.innerHTML = '';
  app.appendChild(renderSidebar(app, state, {
    onMode: async (m) => {
      if (m === state.mode && !_modePending) return;
      if (m === _modePending) return;  // 重复点击同一目标
      _modePending = m;
      const seq = ++_modeSeq;
      const r = await api.switchMode(m);
      if (seq !== _modeSeq) return;  // 竞态守卫：旧响应丢弃
      _modePending = null;
      if (r && r.ok) { state.mode = r.mode; render(); }
    },
    onTab: (t) => { state.tab = t; render(); },
    onSelectSession: async (c) => {
      if (c.current && state.messages !== null) return;
      await api.switchChat(c.path);
      state.sessions = await loadSessions();
      state.tab = 'chat';
      await loadCurrentMessages();
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
      <span class="tb-spacer"></span>
      <a class="tb-link" href="/" title="回经典版界面">经典版 ↗</a>
    </div>
    <div id="main-scroll"></div>
  `;
  app.appendChild(main);

  const scroll = main.querySelector('#main-scroll');
  if (state.tab === 'chat') {
    if (state.messages && state.messages.length) {
      // 旧会话适配：完整消息流渲染
      renderChatFlow(scroll, state.messages);
    } else {
      scroll.appendChild(renderEmptyState(state.mode, { onScene: onScene }));
    }
  } else {
    // KB / 设置：迁移中占位，给经典版直达链接（功能陆续迁入，不在这里做半吊子）
    const wip = document.createElement('div');
    wip.className = 'wip-wrap';
    const label = state.tab === 'kb' ? '知识库' : '设置';
    wip.innerHTML = `
      <div class="w-ic">◌</div>
      <h2>${label} · 迁移中</h2>
      <p>新版界面的「${label}」正在按原型迁移，功能一件不少地搬。<br>
      现在请先在 <a href="/">经典版界面</a> 使用${label}，两边数据完全互通。</p>
    `;
    scroll.appendChild(wip);
  }

  // 右视窗壳（M1-D 后续：SVG PPT 预览 / 文件 / 轨迹 tab）
  const viewer = document.createElement('div');
  viewer.id = 'viewer';
  app.appendChild(viewer);
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
  // 对话发送迁入中：场景卡先给明确预期，不假装能用
  const scroll = document.getElementById('main-scroll');
  if (!scroll) return;
  const tip = document.createElement('div');
  tip.className = 'wip-wrap';
  tip.innerHTML = `
    <div class="w-ic">✦</div>
    <h2>对话发送迁移中</h2>
    <p>「${esc(scene)}」场景入口已就位，发送/流式正在按原型迁移。<br>
    此刻请移步 <a href="/">经典版界面</a> 开始，数据完全互通。</p>
  `;
  scroll.innerHTML = '';
  scroll.appendChild(tip);
}

async function boot() {
  // 先渲骨架（消除首屏白窗），数据到位再补齐
  render();
  window.addEventListener('resize', applyBreakpoint);
  applyBreakpoint();
  try {
    const m = await api.getMode();
    if (m && m.mode) state.mode = m.mode;
  } catch (e) { /* 模式读取失败就用默认在线 */ }
  try {
    state.sessions = await loadSessions();
    await loadCurrentMessages();
  } catch (e) { /* 会话列表失败不阻断空状态 */ }
  render();
}

window.SidemateV2 = { version: '0.10.1-m1d2', mounted: true };
boot();

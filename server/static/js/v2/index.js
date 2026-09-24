// 桌伴 0.10.1 新版 UI 入口（M1-D 三栏骨架，按原型 v14）
// 本版范围：三栏骨架 + 左栏（真数据）+ 空状态场景卡 + 会话消息查看 + 对话发送/流式。
// KB/设置迁入在后续迭代（经典版 / 始终可用）。
import './styles.css';
import { api, MODE_LABEL, getModelTag } from './api.js';
import { icon, iconSvg } from './icons.js';
import { renderSidebar, loadSessions } from './sidebar.js';
import { renderEmptyState } from './empty_state.js';
import { renderChatFlow, loadMessages, setCardMode } from './chat_view.js';
import { extractCards, hydrateCards, extractMermaid, hydrateMermaid, extractD2, hydrateD2 } from './cards_content.js';
import { renderComposer, loadLocalActions, estimateTokens } from './composer.js';
import { createChatStream } from './stream_chat.js';
import { createKBView } from './kb.js';
import { createSettingsView } from './settings.js';
import { createSkillsView } from './skills.js';
import { createViewer } from './viewer.js';
import { createCardArea } from './cards.js';
import { uiAlert, uiConfirm } from './ui_dialog.js';

const state = {
  mode: 'cloud',      // 后端值：local/cloud/parallel
  tab: 'chat',
  sessions: [],
  booted: false,      // 启动加载完成前侧栏/主区走鱼骨骨架（防假空态闪烁）
  switchingSess: false, // 切会话加载中：主区鱼骨（防旧会话内容残留闪烁）
  filter: '',
  collapsed: false,
  userToggledSidebar: false,  // 用户手动折叠过 → 断点不再自动接管
  messages: null,     // 当前会话消息（null=未加载/空状态）
  actionMode: 'chat', // 离线 action / 在线恒 chat（chips 只预填引导词）
  localActions: [],   // 离线 action 列表
  contextWindow: 8192,
  modelTag: '',
  scene: '',          // 场景占位符 tag（空状态场景卡落 tag，不打字进输入框）
  kbTree: null,       // （已退役：侧栏范围树移除，仅 buildKbTree 的 subMap 副作用在用）
  collapsedGroups: {},     // 项目分组折叠态（key=项目目录 / __legacy__）
  projects: [],            // 项目列表 [{dir, display, is_default, status}]（默认项目恒在）
  workdir: null,           // 当前会话所属项目 {legacy} | {dir, display, is_default, status}
  handoff: null,           // 项目交接 {content, updated_at, source_chat, source_engine}
  pendingProjectDir: null, // 无会话时用户在空状态选的项目（首个发送时落在该项目）
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
  };
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
  onPptPage: (d) => { if (_viewer) _viewer.onPptPage(d); },  // M1-E：PPT 逐页预览直转视窗
  onDocComplete: (d) => { if (_viewer) _viewer.onDocComplete(d); },  // HTML 报告完成 → 视窗预览
  onDocOutline: (outline) => {
    // 文档 Phase 1 完成：提纲确认栏（经典版同款交互，v2 DNA 样式）
    _showDocConfirmBar(outline);
  },
  onDoneData: (d) => { _doneData = d; },
  onDone: async () => {
    state.generating = false;
    _streamState = null;
    // A2（0.10.2）：先复位输入区运行态——后续任何 await 失败都不再留「停止」残影
    try { if (_composer) _composer.setRunning(false); } catch (e) {}
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
    try {
      state.sessions = await loadSessions();   // 先刷新列表（msg_count 已变）
      await loadCurrentMessages();             // 后端快照 = 真相
    } catch (e) { /* 快照拉取失败不阻断渲染（残影修复的另一半） */ }
    render();
    try { maybePromptHandoff(); } catch (e) {}  // 上下文 ≥80% 时弹交接建议
  },
});
let _streamState = null;
let _composer = null;
let _cards = null;      // 本轮明盒卡片区
let _doneData = null;   // done 事件数据（含 msg_id）
let _kbView = null;  // KB 视图单例
let _skillsView = null;  // 技能视图单例  // KB 视图单例（切走销毁，切回新建）
let _settingsView = null;  // 设置视图单例（无后台资源，常驻即可）

function render() {
  // 侧栏会话列表滚动位置保持：render 整体重建 DOM 会把 scrollTop 归零，
  // 切会话/切模式后列表跳回顶部，选靠下的会话要反复滚动
  const _prevSessScroll = (document.querySelector('.sb-sessions') || {}).scrollTop || 0;
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
      _viewedProject = null;  // 切会话清掉跨项目查看
      _handoffPrompted = false;  // 换会话重置 80% 交接提示
      state.scene = '';       // 场景 chip 是会话级状态，随会话切换清掉（防跨会话泄漏）
      state.actionMode = 'chat';
      state.switchingSess = true;  // 主区鱼骨（旧会话内容不再残留）
      renderChatArea();
      await api.switchChat(c.path);
      state.sessions = await loadSessions();
      state.tab = 'chat';
      await loadCurrentMessages();
      await loadWorkdir();
      state.switchingSess = false;
      if (_viewer) _viewer.onSessionChange();
      render();
    },
    onNewTask: async () => {
      // 新建任务：默认项目下建会话，空状态里可用项目选择器换项目（0 消息窗口）
      _viewedProject = null;
      state.pendingProjectDir = null;  // 会话已建，pending 移交 chip 选择器
      state.scene = '';
      state.actionMode = 'chat';
      await api.newChat();
      state.sessions = await loadSessions();
      state.tab = 'chat';
      state.messages = null;  // 新会话 → 空状态
      await loadWorkdir();
      render();
    },
    onNewChatInProject: async (dir) => {
      _viewedProject = null;
      state.scene = '';
      state.actionMode = 'chat';
      await api.newChat(dir);
      state.sessions = await loadSessions();
      state.tab = 'chat';
      state.messages = null;
      await loadWorkdir();
      render();
    },
    onProjectInfo: (p) => {
      // 📂 = 打开项目信息（右视窗会话 tab）；支持跨项目查看（只读）
      const cur = state.sessions.find(c => c.current);
      if (cur && cur.project_dir === p.dir) _viewedProject = null;
      else _viewedProject = p;
      if (_viewer) _viewer.setOpen(true, 'session');
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
    // onKbFilter 已随侧栏文档范围树移除（B2：筛选统一走主区 chips）
  }));

  // 恢复会话列表滚动位置；选中项若在恢复后不在视口内（如从视窗跳转），就近滚入
  const _sessList = app.querySelector('.sb-sessions');
  if (_sessList && _prevSessScroll) {
    _sessList.scrollTop = _prevSessScroll;
    const _sel = _sessList.querySelector('.sess-item.on');
    if (_sel) {
      const _top = _sel.offsetTop, _bottom = _top + _sel.offsetHeight;
      if (_bottom > _sessList.scrollTop + _sessList.clientHeight || _top < _sessList.scrollTop) {
        _sel.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  const main = document.createElement('main');
  main.id = 'main';
  main.innerHTML = `
    <div class="topbar">
      <span class="tb-title">${state.tab === 'chat' ? '对话' : state.tab === 'kb' ? '知识库' : state.tab === 'skills' ? '技能' : '设置'}</span>
      ${state.tab === 'chat' && state.modelTag ? `<span class="tb-model" id="tbModelTag" title="${state.mode === 'cloud' ? '' : '模型加载状态，点击管理（离线AI）'}">${state.mode !== 'cloud' ? _llmDotHtml() : ''}${esc(state.modelTag)}</span>` : ''}
      ${state.tab === 'kb' ? '<span id="kb-topbar-slot" class="tb-slot"></span>' : ''}
      <span class="tb-spacer"></span>
      <button class="tb-viewer ${_viewer && _viewer.isOpen ? 'on' : ''}" id="tbViewerBtn" title="视窗（会话/预览/文件/轨迹）">◧ 视窗</button>
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
        onGoClassic: () => { location.href = '/classic.html'; },
        onAskChat: (q) => {
          // 推荐追问：切聊天 tab 预填输入框
          state.tab = 'chat';
          render();
          const ta = document.querySelector('.composer textarea');
          if (ta) { ta.value = q; ta.focus(); }
        },
        onDocsChange: (docs) => {
          // buildKbTree 保留调用：其副作用 window._v2KbSubMap 供 chips 子分类筛选用
          buildKbTree(docs, _kbView ? _kbView.getOverview() : null);
          render();
        },
      });
      _kbView.mount();
    }
    scroll.appendChild(_kbView.el);
    _kbView.renderTopbar();  // KB 工具区在顶栏（星图覆盖内容区也可切回清单）
  } else if (state.tab === 'skills') {
    // 技能视图（M4 增补：系统 skill 开关 + 用户 SKILL.md + MCP 服务器管理）
    const scroll = main.querySelector('#main-scroll');
    if (!_skillsView) {
      _skillsView = createSkillsView({});
    }
    scroll.appendChild(_skillsView.el);
    _skillsView.reload();
  } else {
    // 设置：壳 + 常规子页已迁入；其余子页在设置内占位逐页迁
    const scroll = main.querySelector('#main-scroll');
    if (!_settingsView) {
      _settingsView = createSettingsView({ onGoClassic: () => { location.href = '/classic.html'; } });
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
      getViewedProject: () => _viewedProject,
      onSwitchSession: async (c) => {
        _viewedProject = null;
        state.scene = '';
        state.actionMode = 'chat';
        state.switchingSess = true;  // 主区鱼骨（旧会话内容不再残留）
        renderChatArea();
        await api.switchChat(c.path);
        state.sessions = await loadSessions();
        state.tab = 'chat';
        await loadCurrentMessages();
        await loadWorkdir();
        state.switchingSess = false;
        if (_viewer) _viewer.onSessionChange();
        render();
      },
      onReferenceFile: async (name, btn) => {
        const cur = state.sessions.find(c => c.current);
        if (!cur) return;
        if (btn) { btn.disabled = true; btn.textContent = '…'; }
        if (_composer) _composer.setAttachPending(true);  // 大文件 token 估算要几秒，读取中禁发送
        try {
          const r = await api.referenceWorkdirFile(cur.name, name);
          if (r && r.path) {
            // 直读不复制：附件栏指向项目目录里的原文件，发送走既有管道
            if (_composer) _composer.setAttach({ kind: 'upload', name: r.filename, path: r.path, tokens: r.tokens });
          } else {
            uiAlert((r && r.error) || '引用失败');
          }
        } catch (e) {
          uiAlert('引用失败：' + (e && e.message ? e.message : '未知错误'));
        }
        if (_composer) _composer.setAttachPending(false);
        if (btn) { btn.disabled = false; btn.textContent = '引用'; }
      },
      onDeleteProject: (proj) => deleteProject(proj),
      onRenameProject: (proj) => renameProject(proj),
      onGenerateHandoff: (btn) => generateHandoffFlow(btn, false),
    });
  }
  app.appendChild(_viewer.el);
  const vb = document.getElementById('tbViewerBtn');
  if (vb) vb.addEventListener('click', () => { _viewer.toggle(); });

  // 顶栏模型标签：离线/并行模式点击直达 设置→离线AI（模型控制中心）
  const mt = document.getElementById('tbModelTag');
  if (mt) mt.addEventListener('click', () => {
    if (state.mode === 'cloud') return;
    state.tab = 'settings';
    render();
    if (_settingsView && _settingsView.showSub) _settingsView.showSub('offline');
  });
  _refreshLLMDot();
}

// ===== 顶栏模型状态点（0.10 离线模型控制）：绿=已载 / 空心=未载 / 转圈=加载中 =====
let _llmLoaded = false;      // 有任一本地 LLM 在内存
let _llmDotCls = 'off';      // on | off | ld
function _llmDotHtml() {
  return '<span class="tb-mdot ' + _llmDotCls + '"></span>';
}
async function _refreshLLMDot() {
  try {
    const st = await fetch('/api/status').then(r => r.json());
    _llmLoaded = Object.keys(st).some(k => st[k] && st[k].type === 'llm' && st[k].loaded);
  } catch (e) { return; }
  _llmDotCls = window._v2LLMLoading ? 'ld' : (_llmLoaded ? 'on' : 'off');
  const d = document.querySelector('#tbModelTag .tb-mdot');
  if (d) d.className = 'tb-mdot ' + _llmDotCls;
}
setInterval(_refreshLLMDot, 20000);
window._v2RefreshLLMDot = _refreshLLMDot;  // 供设置页（使用/卸载后）即时刷新，20s 轮询只作兜底

let _viewer = null;

// Escape 收起视窗（PLAN 定稿）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _viewer && _viewer.isOpen) _viewer.setOpen(false);
});

// 中栏对话区：消息流 + 输入区（生成中时含流式气泡）
function renderChatArea() {
  const scroll = document.getElementById('main-scroll');
  if (!scroll) return;
  document.getElementById('v2DocBar')?.remove();  // 先清旧确认栏，待确认分支会重建
  if (state.switching || state.switchingSess || !state.booted) {
    // 鱼骨加载（模式切换 / 切会话 / 启动加载中）：消息区骨架条，输入区锁定
    scroll.innerHTML = '<div class="skel-wrap">' +
      '<div class="skel-line" style="width:38%"></div>' +
      '<div class="skel-line" style="width:72%"></div>' +
      '<div class="skel-line" style="width:64%"></div>' +
      '<div class="skel-line" style="width:30%"></div></div>';
  } else if (state.messages && state.messages.length) {
    setCardMode(state.mode !== 'local');  // 卡片系统仅在线参与
    renderChatFlow(scroll, state.messages, {
      getSession: () => state.sessions.find(c => c.current),
      onAskAnswer, getCardAnswer,
      onPreviewDoc: (url) => _previewDoc(url),  // 旧预览按钮兼容
      onPreviewFile: (url, name) => _previewFile(url, name),  // 产物卡片「预览」→ 视窗 drill-down
      onKbDetail: (filename) => _openKbDetail(filename),  // ref 卡「详情」→ KB 页文档详情（挂账清账）
    });
    // 提纲待确认恢复（快照重建/刷新共用入口）
    const pendingOutline = _lastOutlineMsg();
    if (pendingOutline) _showDocConfirmBar(pendingOutline.msg.content || '');
  } else if (state.workdir && state.workdir.legacy) {
    // 旧版 0 消息会话不出场景卡（点了也发不出去），给只读存档说明
    scroll.innerHTML = `<div class="legacy-empty">
      <div class="legacy-empty-ic">${iconSvg('archive')}</div>
      <div class="legacy-empty-t">旧版本会话 · 只读存档</div>
      <div class="legacy-empty-d">这条会话来自旧版本，没有对话内容。可以看、导出、下载产物；<br>要聊新内容，点左侧「新建任务」。</div>
    </div>`;
  } else {
    scroll.innerHTML = '';
    // 空状态带项目选择器：无会话时用 pendingProjectDir 的显示名，有 0 消息会话时用其项目名
    const projLabel = _pickerLabel();
    // 跨会话发现性（0.10.1 MiniMax 短板①）：新会话同项目有近期会话时，
    // 空状态给一行「可接续」提示（携按钮在视窗·会话 tab，此前用户发现不到）
    const _curProj = (state.workdir && state.workdir.dir) || null;
    const _peers = _curProj ? state.sessions.filter(c =>
      c.project_dir === _curProj && !c.current && !c.private && !c.legacy) : [];
    scroll.appendChild(renderEmptyState(state.mode, {
      onScene: onScene,
      projectLabel: projLabel,
      onPickProject: (anchor) => showProjectPicker(anchor),
      handoffMeta: state.handoff ? { source_chat: state.handoff.source_chat, updated_at: state.handoff.updated_at } : null,
      peersMeta: _peers.length ? { count: Math.min(_peers.length, 8) } : null,
    }));
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
    onWorkdirClick: () => {
      // chip（有消息的会话/旧版会话）→ 打开项目信息卡
      _viewedProject = null;
      if (_viewer) _viewer.setOpen(true, 'session');
      render();
    },
    onProjectPick: (anchorEl) => showProjectPicker(anchorEl),  // 0 消息会话：选择项目
    getSession: () => state.sessions.find(c => c.current),
  });
  _composer.setRunning(state.generating || state.switching);
  main.appendChild(_composer.el);
}

// ===== 项目交接（PLAN ②++：生成/一键移动/80% 建议） =====
let _handoffGenerating = false;

async function generateHandoffFlow(btn, thenMove) {
  const cur = state.sessions.find(c => c.current);
  if (!cur || _handoffGenerating) return null;
  _handoffGenerating = true;
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
  let r = null;
  try {
    r = await api.generateHandoff(cur.name, true);  // 手动触发：离线也允许
  } catch (e) { /* 走错误分支 */ }
  _handoffGenerating = false;
  if (btn) { btn.disabled = false; btn.textContent = '重新生成'; }
  if (!r || !r.ok) {
    uiAlert((r && r.error) || '交接生成失败');
    return null;
  }
  if (thenMove) {
    // 一键移动：同项目新建会话并切换（handoff.md 会注入新会话）
    const dir = state.workdir && state.workdir.dir;
    await api.newChat(dir || undefined);
    state.sessions = await loadSessions();
    state.tab = 'chat';
    state.messages = null;
    await loadWorkdir();
    render();
  } else if (_viewer) {
    _viewer.onSessionChange();  // 交接区刷新
    if (!_viewer.isOpen) _viewer.setOpen(true, 'session');
  }
  return r;
}

// 80% 建议：流末检查 token 占比，≥80% 弹交接建议（每会话只提示一次）
let _handoffPrompted = false;
function maybePromptHandoff() {
  if (_handoffPrompted || state.generating) return;
  const maxTokens = state.contextWindow || 8192;
  const hist = (state.messages || []).reduce((s, m) =>
    s + estimateTokens(m.content || '') + estimateTokens(m.think || ''), 0);
  if (maxTokens <= 0 || hist / maxTokens < 0.8) return;
  _handoffPrompted = true;
  const ov = document.createElement('div');
  ov.className = 'kb-pk-overlay';
  ov.innerHTML = `<div class="kb-pk" style="width:420px">
    <div class="kb-pk-title">上下文将满（已用 ${Math.round(hist / maxTokens * 100)}%）</div>
    <div class="wd-tip">
      <p>要把当前进度<strong>生成交接</strong>并开一个接续的新会话吗？交接会写入项目目录的
      handoff.md，新会话开局自动载入，不用从头解释。</p>
    </div>
    <div class="kb-pk-acts">
      <button class="kb-pk-cancel" data-a="no">不了</button>
      <button class="kb-pk-ok" data-a="yes">生成交接并开新会话</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-a="no"]').addEventListener('click', () => ov.remove());
  ov.querySelector('[data-a="yes"]').addEventListener('click', async () => {
    const okBtn = ov.querySelector('[data-a="yes"]');
    okBtn.disabled = true;
    okBtn.textContent = '生成中…';
    const r = await generateHandoffFlow(null, true);
    if (r) ov.remove();
    else { okBtn.disabled = false; okBtn.textContent = '生成交接并开新会话'; }
  });
}

// ===== 文档两阶段：提纲确认栏（Phase 1 提纲 → 用户确认/编辑 → Phase 2 正文） =====
let _outlineDismissed = null;  // 用户取消过的提纲消息 id（本地态，刷新恢复同经典版）

function _lastOutlineMsg() {
  const msgs = state.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.doc_phase === 'outline') {
      return _outlineDismissed === (m.id || i) ? null : { msg: m, key: m.id || i };
    }
    if (m.role === 'assistant' && m.doc_phase !== 'outline' && (m.content || '').trim()) return null;
    // 提纲之后已有正式回答 → 不再待确认
  }
  return null;
}

function _mdPreview(text) {
  if (typeof marked !== 'undefined') {
    const html = marked.parse(text || '', { breaks: true });
    return typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html;
  }
  return '<pre>' + esc(text || '') + '</pre>';
}

// 确认栏渲染（流式中途 doc_outline 事件 + 快照重建/刷新恢复共用）。
// 钉在消息区与输入区之间（非滚动区内部）——确认按钮恒可见，
// 不信 scrollTop（布局期滚动夹持会清掉滚动位置，已踩过）
function _showDocConfirmBar(outlineText) {
  const main = document.getElementById('main');
  if (!main) return;
  document.getElementById('v2DocBar')?.remove();
  const bar = document.createElement('div');
  bar.className = 'doc-confirm-bar';
  bar.id = 'v2DocBar';
  bar.innerHTML = `
    <details class="doc-outline-edit-wrap">
      <summary>${icon('fileText')} 文档提纲已生成 — 点击查看，可编辑章节</summary>
      <div class="doc-outline-toolbar">
        <button class="doc-outline-toggle-btn" data-t="edit">编辑</button>
        <button class="doc-outline-toggle-btn active" data-t="preview">预览</button>
      </div>
      <textarea class="doc-outline-editor" style="display:none"></textarea>
      <div class="doc-outline-preview md"></div>
    </details>
    <div class="doc-confirm-actions">
      <button class="doc-confirm-ok" data-a="ok">✓ 确认生成</button>
      <button class="doc-confirm-cancel" data-a="cancel">取消</button>
    </div>`;
  const editor = bar.querySelector('.doc-outline-editor');
  const preview = bar.querySelector('.doc-outline-preview');
  editor.value = outlineText || '';
  preview.innerHTML = _mdPreview(outlineText);
  bar.querySelectorAll('.doc-outline-toggle-btn').forEach(b =>
    b.addEventListener('click', () => {
      const toPreview = b.dataset.t === 'preview';
      bar.querySelectorAll('.doc-outline-toggle-btn').forEach(x => x.classList.toggle('active', x === b));
      editor.style.display = toPreview ? 'none' : 'block';
      preview.style.display = toPreview ? 'block' : 'none';
      if (toPreview) preview.innerHTML = _mdPreview(editor.value);
    }));
  bar.querySelector('[data-a="ok"]').addEventListener('click', () => {
    const outline = editor.value.trim();
    if (!outline) { uiAlert('提纲内容为空，无法生成'); return; }
    bar.remove();
    const pending = _lastOutlineMsg();
    if (pending) _outlineDismissed = pending.key;  // 确认后提纲消息仍在列表尾，Phase 2 期间不再出栏
    _docPhase2(outline);
  });
  bar.querySelector('[data-a="cancel"]').addEventListener('click', () => {
    bar.remove();
    const pending = _lastOutlineMsg();
    if (pending) _outlineDismissed = pending.key;  // 本地取消；刷新后恢复（经典版同款语义）
  });
  // 钉在 #main-scroll 与 composer 之间（无 composer 时追加在末尾）
  const composerEl = main.querySelector('.composer');
  if (composerEl) main.insertBefore(bar, composerEl);
  else main.appendChild(bar);
}

// Phase 2：带确认的提纲发 doc_continue（空消息，无 user 气泡）
async function _docPhase2(outline) {
  if (state.generating) return;
  const history = (state.messages || [])
    .filter(m => !(m.role === 'assistant' && (!m.content || !m.content.trim())))
    .map(m => (m.role === 'assistant' && m.content && m.content.length > 1500)
      ? Object.assign({}, m, { content: m.content.slice(0, 1500) + '\n\n...（内容过长已截断）' })
      : m);
  state.generating = true;
  renderChatArea();
  _composer.setRunning(true);
  await chatStream.send({
    text: '',
    docContinue: outline,
    actionMode: 'doc',
    history,
  });
}

// 流式气泡：生成中追加在消息区末尾（不污染 state.messages，流末快照重建）
// ref 卡「详情」→ 切 KB 页并按文件名打开文档详情弹窗（KB 详情跳转，挂账清账）
async function _openKbDetail(filename) {
  if (state.tab !== 'kb') { state.tab = 'kb'; render(); }
  // 等视图挂载（切 tab 异步渲染）
  for (let i = 0; i < 10 && !_kbView; i++) await new Promise(r => setTimeout(r, 120));
  if (!_kbView) return;
  const ok = _kbView.openDetailByName(filename);
  if (!ok) uiAlert('知识库里没找到《' + filename + '》——它可能来自联网或已被删除');
}

// 消息下载栏「预览」：打开视窗预览 tab 并滚到对应 HTML 报告（0.10.1 收尾）
function _previewDoc(url) {
  // 0.10.2 B2：预览改为文件 drill-down——从 URL 反解文件名
  if (!_viewer) return;
  let name = '报告.html';
  try { const q = new URL(url, location.origin).searchParams.get('path'); if (q) name = q.split(/[\/]/).pop(); } catch (e) {}
  _viewer.openPreview({ name, url });
}
function _previewFile(url, name) {
  if (!_viewer) return;
  _viewer.openPreview({ name: name || '产物', url: url || '' });
}

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
        <div class="v2-par-slot" style="display:none"></div>
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
  renderParallelCols(el.querySelector('.v2-par-slot'), st);
  bubble.innerHTML = mdStream(st.text + (st.error ? '\n\n⚠️ ' + st.error : ''));
  hydrateCards(bubble, { getSession: () => state.sessions.find(c => c.current), onAskAnswer, getCardAnswer });
  hydrateMermaid(bubble);
  hydrateD2(bubble);
  const scroll = document.getElementById('main-scroll');
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

// 并行双列流式（M1-D 迁移段）：local/cloud channel 实时渲染。
// merge 列开写（主气泡有文）后双列折叠为 details，与 chat_view.js 回放结构同构，
// 流末快照重建时 UI 无跳变。列内走 mdPlain：卡片协议只认 merge 主输出（M1-D-24 教训②）。
function renderParallelCols(slot, st) {
  if (!slot) return;
  if (!st.channels || !(st.channels.local.text || st.channels.cloud.text)) {
    slot.style.display = 'none';
    return;
  }
  const merging = !!st.text;
  const colLive = (label, c) =>
    `<div class="cb-par live"><div class="cb-par-head">${label}` +
    (c.phase === 'done' ? ' <span class="cb-par-done">✓ 完成</span>' : ' <span class="cb-par-dot"></span>') +
    `</div><div class="cb-par-body md">${c.text ? mdPlain(c.text) : '<span class="cb-par-wait">生成中…</span>'}</div></div>`;
  const colDone = (label, txt) => txt
    ? `<details class="cb-par"><summary>${label}</summary><div class="cb-par-body md">${mdPlain(txt)}</div></details>` : '';
  slot.style.display = '';
  slot.innerHTML = '<div class="cb-par-wrap">' + (merging
    ? colDone('离线列', st.channels.local.text) + colDone('在线列', st.channels.cloud.text)
    : colLive('离线列', st.channels.local) + colLive('在线列', st.channels.cloud)) + '</div>';
}

function mdPlain(text) {
  if (typeof marked !== 'undefined') {
    const html = marked.parse(text || '', { breaks: true });
    return typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html;
  }
  return esc(text || '').replace(/\n/g, '<br>');
}

function mdStream(text) {
  if (!text) return '<span style="color:var(--d1-ink-3)">思考中…</span>';
  if (typeof marked !== 'undefined') {
    setCardMode(state.mode !== 'local');
    let t = extractMermaid(text);
    t = extractD2(t);
    if (state.mode !== 'local') t = extractCards(t);
    const html = marked.parse(t, { breaks: true });
    return typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html;
  }
  return esc(text).replace(/\n/g, '<br>');
}

async function onSend(payload) {
  if (state.generating) return;
  // 旧版会话只读（后端 stream 同样拒绝，这里是前置提示）
  if (state.workdir && state.workdir.legacy) {
    uiAlert('这是旧版本会话，已转为只读存档。要聊新内容请点「新建任务」。');
    return;
  }
  // 无会话则先建（零摩擦开始：空状态直达；落在空状态选择器选定的项目）
  if (!state.sessions.find(c => c.current)) {
    await api.newChat(state.pendingProjectDir || undefined);
    state.pendingProjectDir = null;
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
    cardAnswer: payload.cardAnswer || null,
    history,
  });
}

// 问答卡回答（回合制：回答作为新 user 消息开新轮，带 cardAnswer 引用元数据；
// M2-3：计划确认卡点同意带 action='plan_execute'，后端直接切执行模式不经模型翻译）
function onAskAnswer(question, answer, action) {
  onSend({ text: answer, cardAnswer: { question, action: action || undefined } });
}

// 回放恢复已答态：找与问题匹配的 _card_answer 用户消息
function getCardAnswer(question) {
  const msgs = state.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'user' && m._card_answer && m._card_answer.question === question) {
      return m.content || '';
    }
  }
  return null;
}

// 0.10 M2-P2 刷新恢复：检测进行中生成并重附（DeepSeek 网页版同能力）
async function _maybeReattachGen(cur) {
  if (!cur || state.generating) return;  // 已在生成中不重附
  try {
    const r = await fetch('/api/chats/' + encodeURIComponent(cur.name) + '/gen-state');
    const d = await r.json();
    if (d.status !== 'generating') return;
    // 有进行中生成 → 设置状态 + 重附 SSE
    console.info('[V2] 检测到进行中生成，重附:', cur.name);
    state.generating = true;
    render();  // 触发流式气泡渲染
    // 用 EventSource 连 gen-live（GET SSE）
    const es = new EventSource('/api/chats/' + encodeURIComponent(cur.name) + '/gen-live');
    window._v2GenReattach = es;  // 全局引用防 GC
    es.onmessage = (ev) => {
      if (ev.data === '[DONE]') {
        es.close();
        window._v2GenReattach = null;
        state.generating = false;
        // 刷新消息（快照=真相）
        loadSessions().then(() => loadCurrentMessages().then(() => render()));
        return;
      }
      try {
        const d2 = JSON.parse(ev.data);
        _handleReattachEvent(d2);
      } catch (e) { /* 非 JSON 忽略 */ }
    };
    es.onerror = () => {
      es.close();
      window._v2GenReattach = null;
      // 可能生成已结束（服务端关流）
      state.generating = false;
      loadSessions().then(() => loadCurrentMessages().then(() => render()));
    };
  } catch (e) { /* gen-state 查询失败静默 */ }
}

// 重附事件处理：轻量版——只更新状态条+流式文本（卡片/复杂事件走快照）
function _handleReattachEvent(d) {
  if (d.type === 'token' || d.type === 'content') {
    if (!_streamState) _streamState = { text: '', think: '', status: '' };
    _streamState.text += d.content || '';
    renderStreamingBubble(_streamState);
  } else if (d.type === 'agent_think') {
    if (!_streamState) _streamState = { text: '', think: '', status: '' };
    _streamState.think += (d.content && d.content.content) || '';
    renderStreamingBubble(_streamState);
  } else if (d.type === 'agent_status') {
    if (!_streamState) _streamState = { text: '', think: '', status: '' };
    _streamState.status = _agentStatusLabel(d.status || '');
    renderStreamingBubble(_streamState);
  } else if (d.type === 'done') {
    // done 由 [DONE] 统一处理
  }
}

function _agentStatusLabel(s) {
  const map = { thinking: '思考中', kb_searching: '检索知识库', searching: '联网搜索',
                fetching: '阅读网页', writing: '写入文档', ppt_working: '制作 PPT',
                docx_working: '制作 Word' };
  return map[s] || s;
}

async function loadCurrentMessages() {
  const cur = state.sessions.find(c => c.current);
  // 0.10 M2-P2 刷新恢复：检测进行中生成 → 重附 SSE
  _maybeReattachGen(cur);
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

// ===== 项目（项目即文件夹，PLAN 1.5 四次定稿） =====
// 目录=项目本体：无换绑/无锁定/无移到项目。chip/📂 直达项目信息卡（右视窗会话 tab）。
let _viewedProject = null;  // 跨项目查看（📂 点别的项目）时的覆盖对象

async function loadWorkdir() {
  const cur = state.sessions.find(c => c.current);
  if (!cur) { state.workdir = null; state.handoff = null; return; }
  try {
    state.workdir = await api.getWorkdir(cur.name);
  } catch (e) { state.workdir = null; }
  // 项目交接（空状态来源行用）
  try {
    const h = await api.getHandoff(cur.name);
    state.handoff = (h && h.handoff) ? h.handoff : null;
  } catch (e) { state.handoff = null; }
}

async function loadProjects() {
  try {
    const d = await api.listProjects();
    state.projects = d.projects || [];
  } catch (e) { state.projects = []; }
}

// 首次项目动作后的说明卡（项目即文件夹口径）
function maybeShowWorkdirTip() {
  try { if (localStorage.getItem('v2WdTipSeen')) return; } catch (e) { /* 隐私模式 */ }
  const ov = document.createElement('div');
  ov.className = 'kb-pk-overlay';
  ov.innerHTML = `<div class="kb-pk" style="width:440px">
    <div class="kb-pk-title">项目就是这个文件夹</div>
    <div class="wd-tip">
      <p>· 项目 = 一个文件夹：材料放项目根目录，AI 产出的东西在 <strong>.sidemate</strong> 子目录。</p>
      <p>· 对话记录保存在软件内部（data/），不往项目文件夹里写。</p>
      <p>· 与知识库<strong>完全独立</strong>：项目里的文件不会进知识库、不会被向量化。</p>
      <p>· AI 写项目文件走<strong>计划模式</strong>（默认）：先给确认清单，点同意才落盘；输入框左下可切执行模式。误写可在视窗撤销。</p>
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
      return false;
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
        it.innerHTML = `<span class="fi">${iconSvg(cur ? 'folder' : 'hardDrive')}</span> ${esc(e2.name)}`;
        it.addEventListener('click', () => nav(e2.path));
        listEl.appendChild(it);
      });
    }
    return true;
  }
  pathIn.addEventListener('input', () => {
    // 粘贴路径未回车也放开 OK（R2-1 实测缺口：从未导航过时 cur=null，
    // 按钮死锁只能靠回车——点 OK 时会先按输入框值导航，见下方 handler）
    okBtn.disabled = !cur && !pathIn.value.trim();
  });
  pathIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const v = pathIn.value.trim(); if (v) nav(v); }
  });
  ov.querySelector('.kb-pk-cancel').addEventListener('click', () => ov.remove());
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
  okBtn.addEventListener('click', async () => {
    // 输入框里有已粘贴但未回车跳转的路径时，先按输入框导航——
    // 否则会把上一次浏览停留的目录（而非用户输入的路径）注册成项目（验收 B-3）
    const v = pathIn.value.trim();
    if (v && v !== (cur || '')) {
      const okNav = await nav(v);
      if (!okNav || !cur) return;
    }
    if (!cur) return;
    // 磁盘根目录不给选（后端也有一道闸）：项目名叫「C:\」会让后续
    // 删除确认等操作读起来像在动系统盘（验收 B-3 用户反馈）
    if (/^[a-zA-Z]:\\?$|^\\\\[^\\]+\\[^\\]+\\?$/.test(cur)) {
      listEl.insertAdjacentHTML('afterbegin',
        '<div class="vw-empty" style="color:var(--d1-warn-rust)">磁盘根目录不能作为项目——请进入里面的具体文件夹再选</div>');
      return;
    }
    const p = cur;
    ov.remove();
    onPick(p);
  });
  nav(null);
}

// 项目选择器（Kimi Work 式）：chip（0 消息会话）与空状态行（无会话）共用。
// 有 0 消息会话 → 改会话归属（setChatProject）；无会话 → 记 pendingProjectDir（首条消息落该项目）
let _pkMenuEl = null;
function _pickerLabel() {
  if (state.pendingProjectDir) {
    const p = (state.projects || []).find(x => x.dir === state.pendingProjectDir);
    if (p) return p.display;
  }
  if (state.workdir && !state.workdir.legacy && state.workdir.display) return state.workdir.display;
  return '默认项目';
}
function showProjectPicker(anchorEl) {
  if (_pkMenuEl) _pkMenuEl.remove();
  const cur = state.sessions.find(c => c.current);
  const canAssignSession = !!(cur && !cur.legacy && !cur.msg_count);
  const menuEl = document.createElement('div');
  _pkMenuEl = menuEl;
  menuEl.className = 'sess-menu wd-menu';
  const curDir = state.pendingProjectDir || (state.workdir && state.workdir.dir) || null;
  const others = (state.projects || []);
  menuEl.innerHTML =
    `<span class="sess-menu-sub-h">选择项目（发出第一条消息后定型）</span>` +
    others.map(p =>
      `<button data-dir="${esc(p.dir)}" class="${curDir === p.dir ? 'cur' : ''}" ${p.status === 'missing' ? 'disabled' : ''}>
        ${icon('folder')} ${esc(p.display)}${p.status === 'missing' ? '（目录丢失）' : ''}</button>`).join('') +
    `<div class="sess-menu-sub">
      <button data-a="new_blank">＋ 新建空白项目…</button>
      <button data-a="new_ext">${icon('folderOpen')} 使用现有文件夹…</button>
    </div>`;
  document.body.appendChild(menuEl);
  const r = anchorEl.getBoundingClientRect();
  menuEl.style.left = Math.min(r.left, window.innerWidth - 300) + 'px';
  menuEl.style.top = (r.bottom + 4) + 'px';
  const mh = menuEl.offsetHeight;
  if (r.bottom + 4 + mh > window.innerHeight) menuEl.style.top = Math.max(8, r.top - mh - 4) + 'px';
  const close = (e) => {
    if (_pkMenuEl !== menuEl) { document.removeEventListener('click', close); return; }
    if (!menuEl.contains(e.target)) { menuEl.remove(); _pkMenuEl = null; document.removeEventListener('click', close); }
  };
  setTimeout(() => document.addEventListener('click', close), 0);

  const assign = async (dir) => {
    if (canAssignSession) {
      try {
        await api.setChatProject(cur.name, dir);
      } catch (e) {
        uiAlert('设置项目失败：' + (e && e.message ? e.message : ''));
        return;
      }
      state.sessions = await loadSessions();  // 会话换了组，侧栏要重排
      await loadWorkdir();
      if (_viewer) _viewer.onSessionChange();
      render();
    } else {
      // 无会话（或会话已有内容/旧版）：记 pending，首条消息落在该项目
      state.pendingProjectDir = dir;
      render();
    }
  };
  menuEl.querySelectorAll('[data-dir]').forEach(b => b.addEventListener('click', async () => {
    if (b.disabled) return;
    menuEl.remove(); if (_pkMenuEl === menuEl) _pkMenuEl = null;
    await assign(b.dataset.dir);
  }));
  menuEl.querySelector('[data-a="new_blank"]').addEventListener('click', async () => {
    menuEl.remove(); if (_pkMenuEl === menuEl) _pkMenuEl = null;
    const name = await v2Prompt('新建空白项目（文件夹名即项目名）', '');
    if (!name) return;
    try {
      const r = await api.createProjectBlank(name);
      await loadProjects();
      await assign(r.project.dir);
      maybeShowWorkdirTip();
    } catch (e) {
      uiAlert('新建项目失败：' + (e && e.message ? e.message : '名称不可用'));
    }
  });
  menuEl.querySelector('[data-a="new_ext"]').addEventListener('click', () => {
    menuEl.remove(); if (_pkMenuEl === menuEl) _pkMenuEl = null;
    showDirPicker(async (path) => {
      try {
        let r;
        try {
          r = await api.createProjectExternal(path);
        } catch (e) {
          // 已注册的文件夹：直接切换过去（而不是报错——sprint 测试 T5c 实测缺口）
          if (((e && e.message) || '').includes('已经是项目')) {
            await loadProjects();
            await assign(path);
            maybeShowWorkdirTip();
            return;
          }
          throw e;
        }
        await loadProjects();
        await assign(r.project.dir);
        maybeShowWorkdirTip();
      } catch (e) {
        uiAlert('设置失败：' + (e && e.message ? e.message : '目录不可用'));
      }
    });
  });
}

// 删除项目（信息卡上的危险动作）：级联删会话记录，目录文件永不动
async function deleteProject(proj) {
  const peers = state.sessions.filter(c => c.project_dir === proj.dir);
  const fileCount = (proj.files || []).length + (proj.artifacts || []).length;
  if (!(await uiConfirm('删除项目「' + proj.display + '」？\n\n· 将删除 ' + peers.length +
    ' 个会话的记录（消息/卡片/轨迹）\n· 文件夹和里面的 ' + fileCount +
    ' 个文件（材料/产物/上传）原处保留：' + proj.dir + '\n\n需要对话原文可先在该会话 ⋯ 菜单导出 txt。此操作不可撤销。', { danger: true, okLabel: '删除' }))) return;
  try {
    await api.deleteProject(proj.dir);
  } catch (e) {
    uiAlert('删除失败：' + (e && e.message ? e.message : ''));
    return;
  }
  _viewedProject = null;
  state.sessions = await loadSessions();
  await loadProjects();
  await loadCurrentMessages();
  await loadWorkdir();
  if (_viewer) _viewer.onSessionChange();
  render();
}

// 改项目显示名（不改文件夹名）
async function renameProject(proj) {
  const nv = await v2Prompt('改项目显示名（文件夹名不变）', proj.display || '');
  if (!nv || nv === proj.display) return;
  try {
    await api.renameProject(proj.dir, nv);
  } catch (e) {
    uiAlert('改名失败：' + (e && e.message ? e.message : ''));
    return;
  }
  await loadProjects();
  await loadWorkdir();
  if (_viewer) _viewer.onSessionChange();
  render();
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
    <button data-a="handoff">生成交接（写进项目 handoff.md）</button>
    <button data-a="private">${chat.private ? '取消私密' : '标为私密'}</button>
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
    // 预填当前显示标题（自动命名后 title≠文件夹名——此前预填 chat.name
    // 把自动命名"泄露"回原始编号，用户实测：过桥米线重命名变成 2026-09-21_006）
    const curTitle = chat.title || chat.name;
    const nv = await v2Prompt('重命名会话', curTitle);
    if (!nv || nv === curTitle) return;
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
  menuEl.querySelector('[data-a="handoff"]').addEventListener('click', async () => {
    menuEl.remove(); if (_menuEl === menuEl) _menuEl = null;
    await generateHandoffFlow(null, false);
  });  const _privBtn = menuEl.querySelector('[data-a="private"]');
  if (_privBtn) _privBtn.addEventListener('click', async () => {
    menuEl.remove(); _menuEl = null;
    const on = !chat.private;
    // R3 C1：入口常显可发现；在线态点出设计说明而非静默隐藏
    if (on && state.mode !== 'local') {
      uiAlert('标私密仅适用于离线模式的会话——在线会话的内容本就在云端服务方，标记无意义。请先切到离线模式再操作。');
      return;
    }
    if (on && !(await uiConfirm('把这条会话标为私密？\n\n私密会话的内容不会出现在：其他会话的「同项目会话」清单、「携」前情注入、AI 的 read_session 读取。适合放敏感内容。'))) return;
    try {
      const r = await fetch('/api/chats/' + encodeURIComponent(chat.name) + '/private', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ private: on }),
      });
      const d = await r.json();
      if (!r.ok) { uiAlert(d.error || '设置失败'); return; }
      state.sessions = await loadSessions();
      if (_viewer) _viewer.onSessionChange();
      render();
    } catch (e) { uiAlert('设置失败：' + (e && e.message ? e.message : '')); }
  });

  menuEl.querySelector('[data-a="del"]').addEventListener('click', async () => {    menuEl.remove(); if (_menuEl === menuEl) _menuEl = null;
    const legacyNote = chat.legacy ? '，其工作区里的旧版产物也会一并删除（可先在右视窗「文件」tab 下载）' : '';
    if (!(await uiConfirm(`删除会话「${chat.name}」？会话记录将被删除${legacyNote}，此操作不可撤销。`))) return;
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
    // 并行化：sessions → (messages ∥ workdir) ∥ projects —— 原四段串行是启动慢的主因之一
    const _sessChain = (async () => {
      state.sessions = await loadSessions();
      await Promise.all([loadCurrentMessages(), loadWorkdir()]);
    })();
    await Promise.all([_sessChain, loadProjects()]);
  } catch (e) { /* 会话列表失败不阻断空状态 */ }
  state.booted = true;  // 骨架 → 真实内容（此后空态=真空态）
  render();
  // 刷新前的侧栏滚动位置还原（纯还原——用户可能只是在浏览列表，
  // 选中项滚入会把位置拽回选中项处，与保持原位诉求相反）
  try {
    const _sv = parseInt(sessionStorage.getItem('v2SbScroll') || '0', 10);
    if (_sv > 0) {
      const _el = document.querySelector('.sb-sessions');
      if (_el) _el.scrollTop = _sv;
    }
  } catch (e) { /* 隐私模式 sessionStorage 不可用 */ }
}

// 刷新后侧栏滚动位置恢复（0.10）：pagehide 时记住，boot 完成后还原
window.addEventListener('pagehide', () => {
  const el = document.querySelector('.sb-sessions');
  if (el) { try { sessionStorage.setItem('v2SbScroll', String(el.scrollTop)); } catch (e) {} }
});

window.SidemateV2 = { version: '0.10.1', mounted: true };
boot();

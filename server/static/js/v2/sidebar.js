// 桌伴 0.10.1 新版 UI — 左栏（M1-D 按原型 v14 还原）
// 顶行：logo + 模式切换（横排）+ 折叠钮；折叠 = 左上角 168px 悬浮条。
// 下段：新建会话 + 会话列表（真数据）。项目分组依赖 session 加 group 字段，后续迭代。

import { api, MODE_LABEL, MODE_ORDER } from './api.js';

const ICONS = {
  search: '<svg fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607z"/></svg>',
  chat: '<svg fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155"/></svg>',
  kb: '<svg fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0 6-2.292c1.052 0 2.062.18 3 .512v14.25"/></svg>',
  settings: '<svg fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 0 1 0 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 0-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217-.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1-.26 1.431l1.004-.827c.293-.24.437-.613.43-.992a6.932 6.932 0 0 1 0 .255c-.007.378.138.75.43.99l-1.004.828a1.125 1.125 0 0 1-.26 1.43l-1.297-2.247a1.125 1.125 0 0 1-1.369.49l-1.216.456c.356.133.751.072 1.076.124a.972.972 0 0 1 .22.128c.331.183.581.495.644.869l.214 1.28z"/><circle cx="12" cy="12" r="3"/></svg>',
  plus: '<svg fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M12 4.5v15m7.5-7.5h-15"/></svg>',
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// state: { mode, tab, sessions: [], filter, collapsed, kbTree: null|{total, recent, cats:[{name,count,subs}], privates, ungrouped, kbFilterSel} }
// events: onMode/onTab/onSelectSession/onNewChat/onToggleCollapse/onFilter
export function renderSidebar(root, state, events) {
  const sb = document.createElement('aside');
  sb.id = 'sidebar';
  if (state.collapsed) sb.classList.add('collapsed');

  // 并行按钮按 PLAN 降级：仅当前模式为并行时显示（实验性开关在设置页，后续迁入）
  const modes = MODE_ORDER.filter(m => m !== 'parallel' || state.mode === 'parallel' || state.parallelEnabled);

  sb.innerHTML = `
    <div class="sb-top">
      <div class="sb-logo"><img src="/static/img/logo.jpg" alt="桌伴"></div>
      <div class="mode-mini">
        ${modes.map(m => `
          <button data-mode="${m}" class="${m === 'parallel' ? 'experimental ' : ''}${state.mode === m ? 'on' : ''}">
            ${MODE_LABEL[m]}
          </button>`).join('')}
      </div>
      <button class="sb-collapse" title="折叠/展开">${state.collapsed ? '⟩' : '⟨'}</button>
    </div>
    <div class="sb-search"><span class="ic">${ICONS.search}</span><input placeholder="${state.tab === 'kb' ? '搜索文档…' : '搜索会话…'}" value="${esc(state.filter || '')}"></div>
    <nav class="sb-nav">
      <button class="sb-nav-item ${state.tab === 'chat' ? 'on' : ''}" data-tab="chat"><span class="ic">${ICONS.chat}</span><span class="sb-label">聊天</span></button>
      <button class="sb-nav-item ${state.tab === 'kb' ? 'on' : ''}" data-tab="kb"><span class="ic">${ICONS.kb}</span><span class="sb-label">知识库</span></button>
      <button class="sb-nav-item ${state.tab === 'settings' ? 'on' : ''}" data-tab="settings"><span class="ic">${ICONS.settings}</span><span class="sb-label">设置</span></button>
    </nav>
    <button class="sb-new"><span class="ic">${ICONS.plus}</span><span class="sb-label">新建会话</span></button>
    ${state.tab === 'kb' && state.kbTree
      ? '<div class="sb-sess-title sb-label">文档范围</div><div class="sb-sessions kb-tree"></div>'
      : '<div class="sb-sess-title sb-label">会话</div><div class="sb-sessions"></div>'}
    <button class="sb-back"><span>‹</span><span class="sb-label">回经典版界面</span></button>
  `;

  // 知识库模式：左栏下段换文档范围树（原型 v14）
  const listEl = sb.querySelector('.sb-sessions');
  if (state.tab === 'kb' && state.kbTree) {
    const t = state.kbTree;
    const sel = state.kbTree.kbFilterSel || '';
    const item = (id, label, cnt, icon, sub) => `
      <div class="kt-item ${sel === id ? 'on' : ''}" data-kf="${id}"${sub ? ' style="padding-left:26px"' : ''}>
        <span class="ki">${icon}</span>${esc(label)}<span class="cnt">${cnt}</span>
      </div>`;
    listEl.innerHTML =
      item('', '全部文档', t.total, '📚') +
      item('__recent7__', '最近上传', t.recent, '🕐') +
      t.cats.map(c => item('cat:' + c.name, c.name, c.count, '🏷') +
        (c.subs || []).map(sb2 => item('cat:' + c.name + '/' + sb2.name, sb2.name, sb2.count, '·', true)).join('')).join('') +
      item('__priv__', '私密文档', t.privates, '🔒') +
      item('__none__', '未分组', t.ungrouped, '📁');
    listEl.querySelectorAll('.kt-item').forEach(b =>
      b.addEventListener('click', () => events.onKbFilter(b.dataset.kf)));
    return _bindCommon(sb, state, events);
  }

  // 会话列表（搜索过滤）+ 项目分组（PLAN：可折叠分组，session group 字段）
  const filter = (state.filter || '').toLowerCase();
  const sessions = state.sessions.filter(c => !filter || (c.name || '').toLowerCase().includes(filter));
  if (!sessions.length) {
    listEl.innerHTML = `<div class="sess-empty">${filter ? '无匹配会话' : '还没有会话，点上方「新建会话」开始'}</div>`;
  } else {
    // 按项目分组（免迁移：无 group 的旧会话归「日常」）
    const groups = {};
    const order = [];
    for (const c of sessions) {
      const g = c.group || '日常';
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push(c);
    }
    // 「日常」排最前，其余按名称
    order.sort((a, b) => a === '日常' ? -1 : b === '日常' ? 1 : a.localeCompare(b, 'zh'));
    const collapsedGroups = state.collapsedGroups || {};
    const projDirs = state.projectWorkdirs || {};
    for (const g of order) {
      const grp = document.createElement('div');
      grp.className = 'proj-group' + (collapsedGroups[g] ? ' closed' : '');
      const dirPath = projDirs[g] || '';
      grp.innerHTML = `<div class="proj-head"><span class="arrow">▼</span><span>📁 ${esc(g)}</span><span class="cnt">${groups[g].length}</span>
        <button class="proj-dir ${dirPath ? 'on' : ''}" title="${dirPath ? '工作目录：' + esc(dirPath) + '（点击更换/解除）' : '为项目「' + esc(g) + '」绑定工作目录'}">📂</button></div>
        <div class="proj-sess"></div>`;
      grp.querySelector('.proj-head').addEventListener('click', () => events.onToggleGroup(g));
      grp.querySelector('.proj-dir').addEventListener('click', (e) => {
        e.stopPropagation();
        events.onProjectDir(g, e.target.closest('.proj-dir'));
      });
      const box = grp.querySelector('.proj-sess');
      for (const c of groups[g]) {
        const item = document.createElement('div');
        item.className = 'sess-item' + (c.current ? ' on' : '');
        item.innerHTML = `<div class="si-bar"><div class="st">${esc(c.name)}</div><button class="sess-more" title="导出/重命名/删除/移到项目">⋯</button></div><div class="sm">${c.msg_count || 0} 条消息</div>`;
        item.addEventListener('click', (e) => {
          if (e.target.closest('.sess-more')) return;
          events.onSelectSession(c);
        });
        item.querySelector('.sess-more').addEventListener('click', (e) => {
          e.stopPropagation();
          events.onSessionMenu(c, e.target.closest('.sess-more'));
        });
        box.appendChild(item);
      }
      listEl.appendChild(grp);
    }
  }

  return _bindCommon(sb, state, events);
}

function _bindCommon(sb, state, events) {
  sb.querySelector('.sb-collapse').addEventListener('click', () => events.onToggleCollapse());
  sb.querySelectorAll('.mode-mini button').forEach(b =>
    b.addEventListener('click', () => events.onMode(b.dataset.mode)));
  sb.querySelectorAll('.sb-nav-item').forEach(b =>
    b.addEventListener('click', () => events.onTab(b.dataset.tab)));
  sb.querySelector('.sb-new').addEventListener('click', () => events.onNewChat());
  sb.querySelector('.sb-back').addEventListener('click', () => { location.href = '/'; });
  const searchInput = sb.querySelector('.sb-search input');
  if (searchInput) searchInput.addEventListener('input', (e) => events.onFilter(e.target.value));

  return sb;
}

// 拉取会话列表（含 current 标记）
export async function loadSessions() {
  const data = await api.listChats();
  return data.chats || [];
}

import { icon, iconSvg } from './icons.js';
// 桌伴 0.10.1 新版 UI — 空状态页（M1-D 按原型 v14：在线 8 卡 / 离线 3 卡）
// 零摩擦开始：点卡片 = 预填引导 prompt + scene 轻标签（对话区迁入后接通发送）。

const ICON = (path) => `<span class="ic"><svg fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="${path}"/></svg></span>`;

const I = {
  chat: 'M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155',
  ppt: 'M3.75 3v11.25A2.25 2.25 0 0 0 6 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0 1 19.5 16.5h-2.25m-7.5 0h4.5m-4.5 0v3.375c0 .621-.504 1.125-1.125 1.125H9.75c-.621 0-1.125-.504-1.125-1.125V16.5m4.5 0v3.375c0 .621.504 1.125 1.125 1.125h.375c.621 0 1.125-.504 1.125-1.125V16.5',
  doc: 'M16.862 4.487l1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487zm0 0L19.5 7.125',
  report: 'M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 3.75v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125z',
  poster: 'M4.098 19.902a3.75 3.75 0 0 0 5.304 0l6.401-6.402M6.75 21A3.75 3.75 0 0 1 3 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M6.75 17.25h.008v.008H6.75v-.008z',
  gzh: 'M12 7.5h1.5m-1.5 3h1.5m-7.5 3h7.5m-7.5 3h7.5m3-9h3.375c.621 0 1.125.504 1.125 1.125V18a2.25 2.25 0 0 0 2.25 2.25M15.75 6.75V18a2.25 2.25 0 0 0 2.25 2.25M6 6.75h8.25A2.25 2.25 0 0 1 16.5 9v10.5H6A2.25 2.25 0 0 1 3.75 17.25V9A2.25 2.25 0 0 1 6 6.75z',
  search: 'M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607z',
  deep: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm3.75-12.75l-2.09 4.66-4.66 2.09 2.09-4.66 4.66-2.09 2.09 4.66-4.66 2.09-4.66 4.66-2.09z',
  kb: 'M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0 6-2.292c1.052 0 2.062.18 3 .512v14.25',
};

// 场景卡定义（原型 v14 定稿）
const ONLINE_SCENES = {
  hero: { scene: 'chat', icon: I.chat, title: '聊天', tag: '最常用',
    desc: '日常问答、头脑风暴、翻译润色 —— 也可以什么都不选，直接开聊' },
  sections: [
    { title: '创作交付', desc: 'AI 现场设计，右视窗实时预览', grid: 'five', cards: [
      { scene: 'ppt', icon: I.ppt, title: '写 PPT', desc: '丢材料进来，逐页设计预览，下载可编辑 PPTX' },
      { scene: 'doc', icon: I.doc, title: '写文档', desc: '报告、方案、长文，导出 docx' },
      { scene: 'report', icon: I.report, title: '可视化报告', desc: '图表 + 网页报告，数据一眼看懂' },
      { scene: 'poster', icon: I.poster, title: '设计海报', desc: '封面、海报、配图，多平台尺寸', gold: true },
      { scene: 'gzh', icon: I.gzh, title: '公众号文章', desc: '一键排版粘贴，样式不丢', gold: true, soon: '候选' },
    ]},
    { title: '研究深挖', desc: '联网与多轮工具循环', grid: 'two', cards: [
      { scene: 'search', icon: I.search, title: '联网搜索', desc: '搜索 → 阅读原文 → 回答，附来源' },
      { scene: 'deep', icon: I.deep, title: '深度分析', desc: '多轮工具循环，适合复杂课题' },
    ]},
  ],
};

const OFFLINE_CARDS = [
  { scene: 'chat', icon: I.chat, title: '聊天', desc: '本地模型日常问答，支持引用文档与知识库' },
  { scene: 'doc', icon: I.doc, title: '文档生成', desc: '基于内置模板生成规范文档（小模型模板级输出）' },
  { scene: 'kb', icon: I.kb, title: '知识库文档', desc: '上传资料本地检索问答，向量索引不出本机' },
];

// events: onScene(scene)；onPickProject(anchor) + projectLabel（项目选择器，PLAN 1.5 四次定稿）
export function renderEmptyState(mode, events) {
  const wrap = document.createElement('div');
  wrap.className = 'empty-wrap';
  const projRow = events.projectLabel ? `
      <div class="empty-own" title="选择任务所属的项目（发出第一条消息后定型）">
        <span class="eo-ic">${iconSvg('folderOpen')}</span>
        <span class="eo-name">${events.projectLabel}</span>
        <button class="eo-change">更换 ▾</button>
      </div>` : '';
  const handoffRow = events.handoffMeta ? `
      <div class="empty-handoff" title="项目交接已注入新会话">
        ${icon('fileText')} 已载入项目交接${events.handoffMeta.source_chat ? '（来自会话 ' + events.handoffMeta.source_chat + '）' : ''}${events.handoffMeta.updated_at ? ' · 更新于 ' + events.handoffMeta.updated_at : ''}
      </div>` : '';

  if (mode === 'local') {
    wrap.innerHTML = `
      <div class="empty-hero">
        <div class="mark"><img src="/static/img/logo.jpg" alt="桌伴"></div>
        <h1>离线模式 · 数据不出本机</h1>
        <p>本地模型运行，无需联网 —— 适合隐私敏感场景</p>
      </div>
      ${projRow}
      ${handoffRow}
      <div class="offline-grid">
        ${OFFLINE_CARDS.map(c => `
          <div class="offline-card" data-scene="${c.scene}">
            <div class="s-ic">${ICON(c.icon)}</div><h3>${c.title}</h3><p>${c.desc}</p>
          </div>`).join('')}
      </div>
      <div class="offline-note">需要更强的能力？切换到在线模式解锁 8 个场景</div>
    `;
  } else {
    const hero = ONLINE_SCENES.hero;
    wrap.innerHTML = `
      <div class="empty-hero">
        <div class="mark"><img src="/static/img/logo.jpg" alt="桌伴"></div>
        <h1>开始一段新对话</h1>
        <p>选择一个场景，或直接输入 —— 想做什么，随时切随</p>
      </div>
      ${projRow}
      ${handoffRow}
      <div class="hero-card" data-scene="${hero.scene}">
        <div class="h-ic">${ICON(hero.icon)}</div>
        <div class="h-tx"><h2>${hero.title} <span class="tag">${hero.tag}</span></h2><p>${hero.desc}</p></div>
        <span class="h-go">→</span>
      </div>
      ${ONLINE_SCENES.sections.map(sec => `
        <div class="sec-title"><span class="t">${sec.title}</span><span class="d">${sec.desc}</span></div>
        <div class="scene-grid ${sec.grid}">
          ${sec.cards.map(c => `
            <div class="scene-card ${c.gold ? 'gold' : ''}" data-scene="${c.scene}">
              <div class="s-ic">${ICON(c.icon)}</div><h3>${c.title}</h3><p>${c.desc}</p>
              ${c.soon ? `<span class="soon">${c.soon}</span>` : ''}
            </div>`).join('')}
        </div>`).join('')}
    `;
  }

  wrap.querySelectorAll('[data-scene]').forEach(el =>
    el.addEventListener('click', () => events.onScene(el.dataset.scene)));
  const eo = wrap.querySelector('.empty-own');
  if (eo && events.onPickProject) {
    eo.addEventListener('click', () => events.onPickProject(eo));
  }
  return wrap;
}

// 桌伴 0.10.1 新版 UI — 内容卡片系统（PLAN ②+：在线 LLM 的渲染协议）
// LLM 产数据（围栏块 JSON），前端确定性渲染——LLM 不碰展示代码。
// 首发：chart（折线/柱状/饼图，手写 SVG 零依赖）+ table（可排序）。
// 存产物：table→CSV / chart→SVG，写 <项目目录>/.sidemate/（用户显式动作）。

import { api } from './api.js';
import { iconSvg } from './icons.js';

const PALETTE = ['#0F2B46', '#E8B54D', '#4E7FA6', '#6BA36B', '#B0653A', '#7A5CA6'];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===== Mermaid 渲染（方案 A：迁回 v2，失败优雅降级为源码+错误提示） =====
// 与卡片系统无关——纯展示特性，离线/在线都渲染（对齐经典版行为）。
export function extractMermaid(text) {
  if (!text) return text;
  return text.replace(/```mermaid\s*\n([\s\S]*?)```/g, (m, body) => {
    return '\n\n<div class="mermaid-container" data-mermaid="'
      + encodeURIComponent(body.trim()) + '"><div class="mermaid-wait">图表渲染中…</div></div>\n\n';
  });
}

// ===== D2 渲染（0.10：d2lang 支持，d2 优先 mermaid 兜底的另一半） =====
// A/B 实测：deepseek 出 d2 合法率 90% vs mermaid 85%，双渲染器并存。
export function extractD2(text) {
  if (!text) return text;
  return text.replace(/```d2\s*\n([\s\S]*?)```/g, (m, body) => {
    return '\n\n<div class="d2-container" data-d2="'
      + encodeURIComponent(body.trim()) + '"><div class="mermaid-wait">D2 图表渲染中…（首次需加载渲染引擎，稍候）</div></div>\n\n';
  });
}

let _d2Mod = null, _d2Loading = null, _d2Inst = null;
function _loadD2() {
  if (_d2Mod) return Promise.resolve(_d2Mod);
  if (!_d2Loading) {
    _d2Loading = import('/static/vendor/d2.js').then(m => { _d2Mod = m; return m; });
  }
  return _d2Loading;
}

// ===== 0.11.1 A1：D2 → DNA-01 换装 pass =====
// 映射表与 core/d2_render.py 共用同一份 static/dna/d2_theme.json（单一真源防漂移），
// 聊天内联图（WASM 渲染）与 render_d2 落盘产物（exe 渲染）观感一致。
let _dnaTheme;   // undefined=未加载 / null=加载失败（pass 静默跳过，不劣于现状）
function _loadDnaTheme() {
  if (_dnaTheme !== undefined) return Promise.resolve(_dnaTheme);
  return fetch('/static/dna/d2_theme.json')
    .then(r => (r.ok ? r.json() : null))
    .then(t => { _dnaTheme = t || null; return _dnaTheme; })
    .catch(() => { _dnaTheme = null; return null; });
}
const _D2_FONT_CSS = /font-family:\s*"(d2-[^"]+-font-([a-z]+))"/g;
const _D2_FONT_ATTR = /font-family="(d2-[^"]+-font-([a-z]+))"/g;
function _applyDnaTheme(svg, theme) {
  if (!theme || typeof svg !== 'string' || !theme.colors) return svg;
  let out = svg;
  for (const src in theme.colors) {
    const dst = theme.colors[src];
    if (!dst || src === dst) continue;
    out = out.split(src).join(dst);
    out = out.split(src.toLowerCase()).join(dst);
  }
  const fonts = theme.fonts || {};
  // 内嵌 d2-xxx-font-* → 雅黑/Consolas（mono 变体走等宽栈）；原字体承载的
  // 粗斜体由 append_rules 补偿（与 d2_render.py 同一逻辑）
  const sub = (whole, _name, variant) => {
    const fam = (variant === 'mono' && fonts.mono) ? fonts.mono : fonts.sans;
    if (!fam) return whole;
    return whole.includes('=') && !whole.includes(':') ? 'font-family=' + fam : 'font-family:' + fam;
  };
  if (fonts.sans || fonts.mono) {
    out = out.replace(_D2_FONT_CSS, sub).replace(_D2_FONT_ATTR, sub);
  }
  if (theme.append_rules && out.includes('</svg>')) {
    out = out.replace('</svg>', '<style type="text/css">' + theme.append_rules + '</style></svg>');
  }
  return out;
}

// ===== 0.11.1 A2：内联图「存入工作区」工具条 =====
// d2/mermaid 容器 hover 出现；存入=序列化【当前已渲染的同一张 SVG】落盘
// （不重渲染不换引擎——聊天图=文件图，PLAN-0111 统一图片流核心动作）。
function _attachDiagBar(box, source, opts) {
  if (!box || box.querySelector('.diag-bar')) return;
  const bar = document.createElement('div');
  bar.className = 'diag-bar';
  bar.innerHTML =
    `<button class="db-copy" title="复制源码">${iconSvg('copy')}</button>` +
    `<button class="db-save">${iconSvg('download')}<span>存入工作区</span></button>`;
  box.appendChild(bar);
  const cp = bar.querySelector('.db-copy');
  cp.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(source || '');
      cp.classList.add('ok');
      setTimeout(() => cp.classList.remove('ok'), 900);
    } catch (e) { /* 剪贴板不可用（权限/非安全上下文）静默 */ }
  });
  const btn = bar.querySelector('.db-save');
  btn.addEventListener('click', async () => {
    const svgEl = box.querySelector('svg');
    const cur = opts && opts.getSession ? opts.getSession() : null;
    if (!svgEl) return;
    if (!cur) { btn.querySelector('span').textContent = '无会话'; return; }
    btn.disabled = true;
    btn.querySelector('span').textContent = '存入中…';
    // 文件名：图内 <title> → 首个 text → 兜底 图-N
    let base = '';
    try {
      const t = svgEl.querySelector('title');
      if (t && t.textContent) base = t.textContent.trim();
      if (!base) {
        const tx = svgEl.querySelector('text');
        if (tx && tx.textContent) base = tx.textContent.trim();
      }
    } catch (e) { /* 忽略 */ }
    base = (base || '图-' + (Date.now() % 100000)).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
    try {
      const r = await api.saveDiagram(cur.name, base, svgEl.outerHTML);
      const fname = (r && r.file) || (base + '.svg');
      box.classList.add('saved');
      bar.remove();
      const chip = document.createElement('div');
      chip.className = 'diag-saved';
      chip.innerHTML = `${iconSvg('check')}<span>已存入 · ${esc(fname)}</span>`;
      box.appendChild(chip);
      // 产物卡（复用 0.10.2 .art-card 组件结构；点击→右视窗预览）
      const url = '/api/chat/' + encodeURIComponent(cur.name)
        + '/workspace/download?path=' + encodeURIComponent(fname);
      const art = document.createElement('div');
      art.className = 'art-card just-in';
      const kb = r && r.size ? Math.max(1, Math.round(r.size / 1024)) + 'KB' : '';
      art.innerHTML = `<div class="art-ic"><span class="ic">${iconSvg('barChart')}</span></div>
        <div class="art-tx"><div class="art-name">${esc(fname)}</div>
        <div class="art-meta">图表${kb ? ' · ' + kb : ''} · 刚刚</div></div>
        <div class="art-acts"><a class="art-btn ghost" href="${esc(url)}" download="${esc(fname)}">
        <span class="ic">${iconSvg('file')}</span>下载</a></div>`;
      art.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        window.dispatchEvent(new CustomEvent('sm:preview-file', { detail: { url, name: fname } }));
      });
      (box.parentElement || box).appendChild(art);
      // 文件 tab 刷新（当前会话可见时立即更新）
      window.dispatchEvent(new CustomEvent('sm:files-updated', { detail: { chat: cur.name } }));
    } catch (e) {
      btn.disabled = false;
      btn.querySelector('span').textContent = (e && e.message) ? String(e.message).slice(0, 20) : '失败，重试';
    }
  });
}

export function hydrateD2(container, opts) {
  const boxes = Array.from(container.querySelectorAll('.d2-container:not([data-rendered])'));
  if (!boxes.length) return;
  boxes.forEach(b => b.setAttribute('data-rendered', '1'));  // 防重复触发
  _loadD2().then(async mod => {
    // 0.11.1 M1-2：D2 实例跨调用复用（WASM 初始化昂贵，逐次 new 是首图慢的主因之一）
    if (!_d2Inst) _d2Inst = new mod.D2();
    const inst = _d2Inst;
    const theme = await _loadDnaTheme();
    for (const box of boxes) {
      const code = decodeURIComponent(box.getAttribute('data-d2') || '');
      if (!code) continue;
      try {
        const result = await inst.compile(code);
        const svg = _applyDnaTheme(await inst.render(result.diagram, result.renderOptions), theme);
        box.innerHTML = svg;
        _attachDiagBar(box, code, opts);
      } catch (err) {
        box.innerHTML = `<div class="mermaid-err">${iconSvg('alertTriangle')} D2 图表语法有误，无法渲染（${esc(String(err && err.message || err).slice(0, 120))}）</div>
          <pre class="cc-raw">${esc(code)}</pre>`;
      }
    }
  }).catch(err => {
    // WASM 加载失败（罕见）：全部降级为源码展示
    boxes.forEach(box => {
      const code = decodeURIComponent(box.getAttribute('data-d2') || '');
      box.innerHTML = `<div class="mermaid-err">${iconSvg('alertTriangle')} D2 渲染器加载失败</div>
        <pre class="cc-raw">${esc(code)}</pre>`;
    });
  });
}

let _mermaidInited = false;
// DNA-01 深蓝金 mermaid 主题（0.10.1 用户实测反馈「内嵌 mermaid 太难看」）：
// theme:'base' + themeVariables 全面换皮成自家色板（纸面/深墨/金线/雅黑）。
const _MERMAID_DNA_VARS = {
  primaryColor: '#EEF3F8',        // 节点填充：纸面浅底
  primaryTextColor: '#22303C',    // 节点文字：深墨
  primaryBorderColor: '#0F2B46',  // 节点描边：主深蓝
  lineColor: '#5B6B7B',           // 连线：次级墨
  secondaryColor: '#F5DFA8',      // 次色：浅金
  tertiaryColor: '#F7F9FB',       // 分组底：纸面
  clusterBkg: '#F2F6FA',
  edgeLabelBackground: '#F7F9FB',
  nodeTextColor: '#22303C',
  titleColor: '#0F2B46',
  actorTextColor: '#22303C',
  actorLineColor: '#5B6B7B',
  signalTextColor: '#22303C',
  labelTextColor: '#22303C',
};
function _initMermaid() {
  if (_mermaidInited || typeof mermaid === 'undefined') return;
  _mermaidInited = true;
  // fontFamily 必须显式字体栈（继承字体会让 mermaid 测量框偏小，中文溢出——经典版同款修复）
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    themeVariables: _MERMAID_DNA_VARS,
    securityLevel: 'loose',
    suppressErrorRendering: true,  // 不渲染 mermaid 原生红色炸弹报错图（降级 UI 我们自己出）
    fontFamily: '"Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif',
    flowchart: { padding: 12, nodeSpacing: 60, rankSpacing: 60, useMaxWidth: false, htmlLabels: false },
  });
}

// mermaid 懒加载（0.10：3.3MB 不再急加载拖累首屏——首个图表块出现才注入）
let _mermaidLoading = null;
function _loadMermaid() {
  if (typeof mermaid !== 'undefined') return Promise.resolve();
  if (!_mermaidLoading) {
    _mermaidLoading = new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = '/static/vendor/mermaid.min.js';
      sc.onload = res; sc.onerror = () => rej(new Error('mermaid.min.js 加载失败'));
      document.head.appendChild(sc);
    });
  }
  return _mermaidLoading;
}

export function hydrateMermaid(container, opts) {
  const boxes = Array.from(container.querySelectorAll('.mermaid-container:not([data-rendered])'));
  if (!boxes.length) return;
  _loadMermaid().then(() => { _initMermaid(); _renderMermaidBoxes(boxes, opts); })
    .catch(() => {
      boxes.forEach(b => b.setAttribute('data-rendered', '1'));
    });
}

function _renderMermaidBoxes(boxes, opts) {
  const _cleanOrphans = () => {
    // mermaid 渲染期的临时容器（id 前缀 dmm-）失败时会挂着原生报错图残留在 body 末尾
    document.querySelectorAll('body > div[id^="dmm-"]').forEach(el => el.remove());
  };
  boxes.forEach(box => {
    const code = decodeURIComponent(box.getAttribute('data-mermaid') || '');
    if (!code) return;
    box.setAttribute('data-rendered', '1');
    const parent = box.parentElement;
    const next = box.nextSibling;
    mermaid.render('mm-' + Math.random().toString(36).slice(2, 10), code)
      .then(result => {
        box.setAttribute('data-rendered', '1');
        // mermaid 测量期会把容器挪到 body 末尾，settle 后无条件放回原位（经典版同款坑）
        if (!box.parentElement) {
          // R3 次要观察修复：流式重渲竞态下 parent/next 可能已脱离文档，
          // 旧代码 null.parentElement===null 会走进 parent.insertBefore 抛
          // 'Cannot read properties of null (reading appendChild)'
          if (parent && next && next.parentElement === parent) parent.insertBefore(box, next);
          else if (parent) parent.appendChild(box);
        }
        box.innerHTML = result.svg;
        _attachDiagBar(box, code, opts);
        _cleanOrphans();
      })
      .catch(err => {
        box.setAttribute('data-rendered', '1');
        if (!box.parentElement) {
          // R3 次要观察修复：流式重渲竞态下 parent/next 可能已脱离文档，
          // 旧代码 null.parentElement===null 会走进 parent.insertBefore 抛
          // 'Cannot read properties of null (reading appendChild)'
          if (parent && next && next.parentElement === parent) parent.insertBefore(box, next);
          else if (parent) parent.appendChild(box);
        }
        _cleanOrphans();
        // 优雅降级：错误提示 + 源码，不黑屏
        box.innerHTML = `<div class="mermaid-err">${iconSvg('alertTriangle')} 图表语法有误，无法渲染（${esc(String(err && err.message || err).slice(0, 120))}）</div>
          <pre class="cc-raw">${esc(code)}</pre>`;
      });
  });
}

// ===== 围栏块提取：```chart / ```table / ```ask + JSON → 占位槽 =====
// 离线不调用本函数（PLAN：卡片系统仅在线参与）
export function extractCards(text) {
  if (!text) return text;
  return text.replace(/```(chart|table|ask)\s*\n([\s\S]*?)```/g, (m, type, body) => {
    return '\n\n<div class="cc-slot" data-cc-type="' + type + '" data-cc="'
      + encodeURIComponent(body.trim()) + '"></div>\n\n';
  });
}

// ===== 卡片水合：渲染占位槽（解析失败优雅降级为源码+错误提示） =====
// opts: { getSession(), onAskAnswer(question, answer), getCardAnswer(question) }
export function hydrateCards(container, opts) {
  // #22 卡片级异常隔离：单卡渲染失败降级为错误卡（附折叠错误信息），
  // 其余卡片、消息流和输入区照常。此前 #21 那类渲染期 ReferenceError
  // 会沿 renderChatArea 一路冒泡，把整个输入区炸掉。
  container.querySelectorAll('.cc-slot:not([data-cc-done])').forEach(slot => {
    slot.setAttribute('data-cc-done', '1');
    const card = document.createElement('div');
    try {
      _hydrateOneCard(slot, card, opts);
    } catch (e) {
      card.className = 'cc-card cc-broken';
      card.innerHTML = `<div class="cc-err">${iconSvg('alertTriangle')} 此卡片渲染失败，不影响其余内容</div>
        <details class="cc-err-details"><summary>错误信息</summary>
        <pre class="cc-raw">${esc(String((e && e.message) || e))}</pre></details>`;
      try { console.error('[cards] 单卡渲染失败:', e); } catch (_) {}
      try { if (window.__smReportError) window.__smReportError('card-hydrate: ' + String((e && e.message) || e)); } catch (_) {}
    }
    slot.replaceWith(card);
  });
  // 引用卡槽（消息自带的来源数据，非围栏块）——同样按卡隔离
  container.querySelectorAll('.cc-ref-slot:not([data-cc-done])').forEach(slot => {
    slot.setAttribute('data-cc-done', '1');
    let sources = [];
    try { sources = JSON.parse(decodeURIComponent(slot.dataset.refs || '')); } catch (e) { /* 忽略 */ }
    if (!sources.length) { slot.remove(); return; }
    try {
      slot.replaceWith(_renderRefCard(sources, opts));
    } catch (e) {
      const card = document.createElement('div');
      card.className = 'cc-card cc-broken';
      card.innerHTML = `<div class="cc-err">${iconSvg('alertTriangle')} 来源卡渲染失败</div>`;
      slot.replaceWith(card);
    }
  });
  // 上标互链：点击 [n] 跳到 ref 卡对应条目
  container.querySelectorAll('sup.ref-n').forEach(sup => {
    sup.addEventListener('click', () => {
      const item = container.querySelector('.cc-ref-item[data-n="' + sup.dataset.n + '"]');
      if (!item) return;
      item.scrollIntoView({ block: 'center' });
      item.classList.add('flash');
      setTimeout(() => item.classList.remove('flash'), 900);
    });
  });
}

function _hydrateOneCard(slot, card, opts) {
  const type = slot.dataset.ccType;
  let spec = null;
  let err = '';
  try {
    spec = JSON.parse(decodeURIComponent(slot.dataset.cc || ''));
  } catch (e) {
    err = '卡片数据解析失败（JSON 格式错误）';
  }
  if (!err) {
    const vErr = _validate(type, spec);
    if (vErr) err = vErr;
  }
  card.className = 'cc-card cc-' + type;
  if (err) {
    card.innerHTML = `<div class="cc-err">${iconSvg('alertTriangle')} ${esc(err)}</div>
      <pre class="cc-raw">${esc(decodeURIComponent(slot.dataset.cc || ''))}</pre>`;
  } else if (type === 'ask') {
    _renderAsk(card, spec, opts);
  } else {
    const title = spec.title || (type === 'chart' ? '图表' : '表格');
    card.innerHTML = `<div class="cc-head">
      <span class="cc-badge">${iconSvg(type === 'chart' ? 'barChart' : 'table')}</span>
      <span class="cc-title">${esc(title)}</span>
      <button class="cc-save" title="存入项目产物（.sidemate）">存产物</button>
    </div>
    <div class="cc-body"></div>`;
    const body = card.querySelector('.cc-body');
    if (type === 'chart') body.appendChild(_renderChart(spec));
    else body.appendChild(_renderTable(spec));
    card.querySelector('.cc-save').addEventListener('click', (e) => {
      _saveArtifact(type, spec, card, e.target, opts);
    });
  }
}

function _validate(type, spec) {
  if (!spec || typeof spec !== 'object') return '卡片数据不是对象';
  if (type === 'chart') {
    if (!['line', 'bar', 'pie'].includes(spec.type)) return '不支持的图表类型: ' + (spec.type || '(空)');
    if (!Array.isArray(spec.labels) || !spec.labels.length) return 'labels 缺失或为空';
    if (!Array.isArray(spec.series) || !spec.series.length) return 'series 缺失或为空';
    if (!spec.series.every(s => Array.isArray(s.data))) return 'series.data 必须是数组';
  } else if (type === 'table') {
    if (!Array.isArray(spec.columns) || !spec.columns.length) return 'columns 缺失或为空';
    if (!Array.isArray(spec.rows)) return 'rows 必须是数组';
  } else if (type === 'ask') {
    if (!spec.question || typeof spec.question !== 'string') return 'question 缺失';
    if (spec.options && !Array.isArray(spec.options)) return 'options 必须是数组';
    if (spec.kind === 'skill_install' && !spec.skill) return 'skill_install 卡缺 skill 字段';
  }
  return '';
}

// ===== 问答卡（ask）：模型提问 → 用户单选/手敲 → 回答开新轮（回合制） =====
// 0.11 确认卡家族（照原型 ui-011.html ①）：kind 扩展
//   plan_confirm   计划确认（带 tools/perms/files 时渲染结构化三节，spec#9-13）
//   skill_install  安装技能确认（spec#14-16）
//   memory_save    记忆写入确认（spec#17-20）
//   distill        经验沉淀建议（spec#21-23）
const _CK = '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>';
const _CKC = '<span class="cf-ic y">' + _CK + '</span>';

function _cfBtn(txt, cls) {
  return `<button class="cf-btn ${cls || 'ghost'}">${esc(txt)}</button>`;
}

function _renderConfirmCard(card, spec, opts, kind) {
  // 已答态
  const answered = opts && opts.getCardAnswer ? opts.getCardAnswer(spec.question) : null;
  const acts = spec.options || [];
  // kind 推断与 _renderAsk 同款（kind 缺失时按「长期记忆」文案识别记忆卡）。
  // 此前这里直接引用 _renderAsk 作用域的 _kind2 → 运行期 ReferenceError（#21）。
  const kind2 = kind || ((spec.question || '').includes('长期记忆') ? 'memory_save' : '');
  let head = '', secs = '';
  if (kind === 'skill_install' && spec.skill) {
    const s = spec.skill;
    head = `<div class="cf-head"><span class="cf-cic gold">${iconSvg('puzzle')}</span>
      <div><div class="cf-t">安装技能确认</div>
      <div class="cf-s">来源：${esc(s.source || '本地')} · 全程不联网</div></div></div>`;
    secs = `<div class="cf-sec"><div class="cf-lb">技能信息</div>
      <div class="cf-line"><span class="cf-name">${esc(s.name)}</span></div>
      <div class="cf-line dim">${esc(s.description || '')}</div>
      <div class="cf-line dim">文件清单：${esc((s.files || []).join(' · ')) || '—'}</div></div>
      <div class="cf-sec"><div class="cf-lb">安全校验</div>
      ${(s.checks || []).map(c => `<div class="cf-vrow">${_CKC}<span>${esc(c)}</span></div>`).join('')}</div>`;
  } else if (kind2 === 'memory_save' || kind2 === 'memory_confirm') {
    head = `<div class="cf-head"><span class="cf-cic">${iconSvg('tag')}</span>
      <div><div class="cf-t">记忆写入确认</div>
      <div class="cf-s">写入后跨会话生效</div></div></div>`;
    secs = `<div class="cf-sec"><div class="mem-path">项目记忆 › <b>${esc(spec.section || '偏好')}</b></div>
      <div class="mem-diff"><span class="add">+ ${esc(spec.text || spec.question || '')}</span></div></div>`;
  } else if (kind === 'distill' && spec.skill) {
    const s = spec.skill;
    head = `<div class="cf-head"><span class="cf-cic gold">${iconSvg('bulb')}</span>
      <div><div class="cf-t">存为技能？</div>
      <div class="cf-s">任务完成得很顺，沉淀成技能下次直接复用（仅建议一次）</div></div></div>`;
    secs = `<div class="cf-sec"><div class="cf-lb">本次任务模式</div>
      <div class="cf-flow">${(spec.flow || []).map(f => `<span class="fs">${esc(f)}</span>`).join('<span class="fa">→</span>')}</div></div>
      <div class="cf-sec"><div class="cf-lb">将生成的技能</div>
      <div class="cf-preview"><span class="dn">${esc(s.name)}</span><span class="dt-tag">场景触发</span><br>${esc(s.description || '')}</div></div>`;
  } else if (kind === 'plan_confirm') {
    head = `<div class="cf-head"><span class="cf-cic">${iconSvg('clipboardCheck')}</span>
      <div><div class="cf-t">执行计划确认</div>
      <div class="cf-s">${esc(spec.subtitle || '模型已拟好计划')}</div></div></div>`;
    if (spec.tools || spec.perms || spec.files) {
      secs = (spec.tools && spec.tools.length ? `<div class="cf-sec"><div class="cf-lb">工具范围（本轮计划将使用）</div>
        ${spec.tools.map(t => `<span class="tchip${t.denied ? ' over' : ''}">${esc(t.name)}${t.limit ? ` <span class="xn">×${esc(t.limit)}</span>` : ''}${t.denied ? ' <span class="xn">未授权</span>' : ''}</span>`).join('')}</div>` : '')
      + (spec.perms && spec.perms.length ? `<div class="cf-sec"><div class="cf-lb">权限边界</div>
        ${spec.perms.map(p => `<div class="cf-vrow">${p.ok ? _CKC : '<span class="cf-ic n">✕</span>'}<span>${esc(p.label)}</span><span class="cf-bd">${esc(p.note || '')}</span></div>`).join('')}</div>` : '')
      + (spec.files && spec.files.length ? `<div class="cf-sec"><div class="cf-lb">文件影响</div>
        ${spec.files.map(f => `<div class="cf-vrow"><span class="cf-ic">${iconSvg('file')}</span><span>${esc(f.name)}</span><span class="fb ${f.mod ? 'mod' : 'new'}">${f.mod ? '覆盖' : '新建'}</span></div>`).join('')}</div>` : '')
      + `<div class="cf-sec"><div class="cf-lb">计划内容</div><div class="cf-line">${esc(spec.question).replace(/\n/g, '<br>')}</div></div>`;
    } else {
      secs = `<div class="cf-sec"><div class="cf-line">${esc(spec.question).replace(/\n/g, '<br>')}</div></div>`;
    }
  }
  card.innerHTML = `${head}${secs}
    <div class="cf-btns">
      <button class="cf-btn ghost" data-ans="${esc(acts[1] || '取消')}">${esc(acts[1] || '取消')}</button>
      <button class="cf-btn ${kind === 'plan_confirm' ? 'primary' : 'gold'}" data-ans="${esc(acts[0] || '确认')}">${esc(acts[0] || '确认')}</button>
    </div>`;
  if (answered) {
    card.innerHTML += `<div class="cf-answered">✓ 已处理：${esc(answered)}</div>`;
    card.querySelectorAll('.cf-btn').forEach(b => b.disabled = true);
    return;
  }
  const action = kind === 'plan_confirm' ? 'plan_execute' : (kind === 'skill_install' ? 'skill_install' : null);
  card.querySelectorAll('.cf-btn').forEach(b => {
    b.addEventListener('click', () => {
      if (opts && opts.onAskAnswer) opts.onAskAnswer(spec.question, b.dataset.ans, action);
      card.querySelectorAll('.cf-btn').forEach(x => x.disabled = true);
      b.style.borderColor = 'var(--d1-gold)';
    });
  });
}

function _renderAsk(card, spec, opts) {
  const kind = spec.kind || '';
  // 0.11 确认卡家族：结构化渲染（照原型 ui-011.html ①）
  // 0.11.1 修复：①模型产出过 kind="memory_confirm"（协议值 memory_save 的漂移）；
  // ②flash 档经常不带 kind——按 question 文案推断（含「长期记忆」→ 结构化记忆卡），
  // 否则降级为普通问答卡（功能可用但缺位置条/diff 预览）
  const _kind2 = kind || ((spec.question || '').includes('长期记忆') ? 'memory_save' : '')
  if (_kind2 === 'skill_install' || _kind2 === 'memory_save' || _kind2 === 'memory_confirm'
      || _kind2 === 'distill'
      || (_kind2 === 'plan_confirm' && (spec.tools || spec.perms || spec.files))) {
    _renderConfirmCard(card, spec, opts, kind);
    return;
  }
  const answered = opts && opts.getCardAnswer ? opts.getCardAnswer(spec.question) : null;
  const isPlan = kind === 'plan_confirm';  // M2-3：计划确认卡（点同意=系统直接切执行模式）
  card.innerHTML = `<div class="cc-head">
    <span class="cc-badge">${iconSvg(isPlan ? 'clipboardCheck' : 'help')}</span>
    <span class="cc-title">${isPlan ? '计划确认' : '需要确认'}</span>
  </div>
  <div class="cc-ask-q">${esc(spec.question)}</div>
  <div class="cc-ask-body"></div>`;
  const body = card.querySelector('.cc-ask-body');
  if (answered) {
    body.innerHTML = `<div class="cc-ask-done">✓ 已答：${esc(answered)}</div>`;
    return;
  }
  let picked = '';
  const optsRow = document.createElement('div');
  optsRow.className = 'cc-ask-opts';
  (spec.options || []).forEach((o, oi) => {
    const b = document.createElement('button');
    b.className = 'cc-ask-opt' + (isPlan && oi === 0 ? ' agree' : '');
    b.textContent = o;
    b.addEventListener('click', () => {
      picked = o;
      optsRow.querySelectorAll('.cc-ask-opt').forEach(x => x.classList.toggle('on', x === b));
      input.value = o;
      input.dispatchEvent(new Event('input'));
      // 计划确认卡：选项点击即提交（一步生效）——「同意，执行写入」点一次就该动，
      // 再要求点「确认」是反直觉二段式（用户实测点同意无后续）
      if (isPlan) submit();
    });
    optsRow.appendChild(b);
  });
  body.appendChild(optsRow);
  const row = document.createElement('div');
  row.className = 'cc-ask-row';
  const input = document.createElement('input');
  input.className = 'cc-ask-input';
  input.placeholder = (spec.options && spec.options.length) ? '选一个，或手敲补充…' : '输入你的回答…';
  const go = document.createElement('button');
  go.className = 'cc-ask-go';
  go.textContent = isPlan ? '确认' : '回答';
  const submit = () => {
    const answer = (input.value || picked).trim();
    if (!answer) { input.focus(); return; }
    body.innerHTML = `<div class="cc-ask-done">✓ 已答：${esc(answer)}</div>`;
    // 计划确认卡：点中首个选项（同意项）→ 回答带动作语义，后端直接切执行模式
    const action = (isPlan && answer === (spec.options || [])[0]) ? 'plan_execute' : null;
    if (opts && opts.onAskAnswer) opts.onAskAnswer(spec.question, answer, action);
  };
  go.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  row.appendChild(input);
  if (spec.allow_input !== false || !(spec.options || []).length) row.appendChild(go);
  body.appendChild(row);
}

// ===== 引用卡（ref）：唯一跨两界——同渲染组件，两数据来路（kb_sources/agent results） =====
function _renderRefCard(sources, opts) {
  const card = document.createElement('div');
  card.className = 'cc-card cc-ref';
  card.innerHTML = `<div class="cc-head"><span class="cc-badge">${iconSvg('search')}</span>
    <span class="cc-title">引用来源 · ${sources.length}</span></div>
    <div class="cc-ref-list"></div>`;
  const list = card.querySelector('.cc-ref-list');
  sources.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = 'cc-ref-item';
    item.dataset.n = String(i + 1);
    const kbBtn = (s.kind !== 'web' && opts && opts.onKbDetail)
      ? `<button class="cc-ref-detail" title="在知识库中查看文档详情">${iconSvg('info')} 详情</button>` : '';
    item.innerHTML = `<span class="cc-ref-n">[${i + 1}]</span>
      <span class="cc-ref-badge ${s.kind === 'web' ? 'web' : 'kb'}">${iconSvg(s.kind === 'web' ? 'globe' : 'book')}</span>
      <span class="cc-ref-t">${esc(s.title)}</span>
      ${kbBtn}
      <div class="cc-ref-x">${esc(s.excerpt || '')}</div>`;
    item.addEventListener('click', () => item.classList.toggle('open'));
    const dbtn = item.querySelector('.cc-ref-detail');
    if (dbtn) dbtn.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onKbDetail(s.title);
    });
    list.appendChild(item);
  });
  return card;
}


// ===== 存产物 =====
async function _saveArtifact(type, spec, card, btn, opts) {
  const cur = opts && opts.getSession ? opts.getSession() : null;
  if (!cur) { btn.textContent = '无会话'; return; }
  btn.disabled = true;
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  const safeTitle = (spec.title || type).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30);
  let filename, content;
  if (type === 'table') {
    filename = `${safeTitle}-${stamp}.csv`;
    content = '﻿' + _toCsv(spec);  // BOM 保 Excel 中文
  } else {
    filename = `${safeTitle}-${stamp}.svg`;
    const svg = card.querySelector('svg');
    content = svg ? svg.outerHTML : '';
  }
  try {
    const r = await api.saveArtifact(cur.name, filename, content);
    if (r && r.ok) {
      btn.textContent = '✓ 已存产物';
      btn.classList.add('done');
    } else {
      btn.textContent = (r && r.error) || '失败';
      btn.disabled = false;
    }
  } catch (e) {
    btn.textContent = '失败';
    btn.disabled = false;
  }
}

function _toCsv(spec) {
  const cell = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [spec.columns.map(cell).join(',')];
  spec.rows.forEach(r => lines.push((Array.isArray(r) ? r : [r]).map(cell).join(',')));
  return lines.join('\r\n');
}

// ===== 表格渲染（可排序） =====
function _renderTable(spec) {
  const tbl = document.createElement('table');
  tbl.className = 'cc-tbl';
  const state = { col: -1, dir: 1 };
  function paint() {
    const rows = spec.rows.slice();
    if (state.col >= 0) {
      const ci = state.col;
      rows.sort((a, b) => {
        const av = Array.isArray(a) ? a[ci] : a, bv = Array.isArray(b) ? b[ci] : b;
        const an = parseFloat(av), bn = parseFloat(bv);
        if (!isNaN(an) && !isNaN(bn)) return (an - bn) * state.dir;
        return String(av).localeCompare(String(bv), 'zh') * state.dir;
      });
    }
    tbl.innerHTML = `<thead><tr>${spec.columns.map((c, i) =>
      `<th data-i="${i}">${esc(c)}${state.col === i ? (state.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${(Array.isArray(r) ? r : [r]).map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody>`;
    tbl.querySelectorAll('th').forEach(th => th.addEventListener('click', () => {
      const i = +th.dataset.i;
      if (state.col === i) state.dir *= -1;
      else { state.col = i; state.dir = 1; }
      paint();
    }));
  }
  paint();
  return tbl;
}

// ===== 图表渲染（手写 SVG，DNA-01 配色） =====
const NS = 'http://www.w3.org/2000/svg';

function _el(tag, attrs, text) {
  const e = document.createElementNS(NS, tag);
  for (const k in (attrs || {})) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  return e;
}

function _niceBounds(vals) {
  let mn = Math.min(...vals), mx = Math.max(...vals);
  if (mn === mx) { mn = Math.min(0, mn); mx = mx || 1; }
  if (mn > 0) mn = 0;
  const pad = (mx - mn) * 0.1;
  return [mn - pad, mx + pad];
}

function _renderChart(spec) {
  const svg = _el('svg', { viewBox: '0 0 600 280', class: 'cc-svg', xmlns: NS });
  if (spec.type === 'pie') return _pie(svg, spec);
  return _axesChart(svg, spec);
}

function _axesChart(svg, spec) {
  const L = 48, R = 14, T = 30, B = 34, W = 600 - L - R, H = 280 - T - B;
  const allVals = spec.series.flatMap(s => s.data.map(Number).filter(v => !isNaN(v)));
  const [mn, mx] = _niceBounds(allVals.length ? allVals : [0, 1]);
  const n = spec.labels.length;
  const xAt = (i) => L + (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const yAt = (v) => T + H - ((v - mn) / (mx - mn)) * H;
  // 网格 + y 刻度
  for (let g = 0; g <= 4; g++) {
    const v = mn + ((mx - mn) * g) / 4;
    const y = yAt(v);
    svg.appendChild(_el('line', { x1: L, y1: y, x2: 600 - R, y2: y, stroke: '#E4E9F0', 'stroke-width': 1 }));
    svg.appendChild(_el('text', { x: L - 6, y: y + 3.5, 'text-anchor': 'end', class: 'cc-ax' }, _fmtNum(v)));
  }
  // x 标签（≥10 抽稀）
  const step = Math.max(1, Math.ceil(n / 9));
  spec.labels.forEach((lb, i) => {
    if (i % step && i !== n - 1) return;
    svg.appendChild(_el('text', { x: xAt(i), y: 280 - 10, 'text-anchor': 'middle', class: 'cc-ax' }, String(lb)));
  });
  spec.series.forEach((s, si) => {
    const color = PALETTE[si % PALETTE.length];
    const data = s.data.map(Number);
    if (spec.type === 'line') {
      const pts = spec.labels.map((_, i) => [xAt(i), yAt(isNaN(data[i]) ? 0 : data[i])]);
      svg.appendChild(_el('polyline', {
        points: pts.map(p => p.join(',')).join(' '),
        fill: 'none', stroke: color, 'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      }));
      pts.forEach(p => svg.appendChild(_el('circle', { cx: p[0], cy: p[1], r: 3, fill: color })));
    } else {
      const groups = spec.series.length;
      const slot = W / n;
      const bw = Math.min(26, (slot * 0.62) / groups);
      spec.labels.forEach((_, i) => {
        const cx = L + slot * (i + 0.5);
        const v = isNaN(data[i]) ? 0 : data[i];
        const x = cx - (bw * groups) / 2 + bw * si;
        const y = yAt(Math.max(v, mn));
        const y0 = yAt(Math.max(0, mn));
        svg.appendChild(_el('rect', {
          x, y: Math.min(y, y0), width: Math.max(1, bw - 2),
          height: Math.max(1, Math.abs(y0 - y)), fill: color, rx: 2,
        }));
      });
    }
  });
  svg.appendChild(_legend(spec));
  return svg;
}

function _pie(svg, spec) {
  const s = spec.series[0];
  const data = spec.labels.map((_, i) => Math.max(0, Number(s.data[i]) || 0));
  const total = data.reduce((a, b) => a + b, 0) || 1;
  const cx = 150, cy = 140, r = 96;
  let a0 = -Math.PI / 2;
  data.forEach((v, i) => {
    const frac = v / total;
    const a1 = a0 + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const p = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    const d = `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`;
    svg.appendChild(_el('path', { d, fill: PALETTE[i % PALETTE.length], stroke: '#fff', 'stroke-width': 1.5 }));
    if (frac >= 0.05) {
      const am = (a0 + a1) / 2;
      const [lx, ly] = [cx + r * 0.62 * Math.cos(am), cy + r * 0.62 * Math.sin(am)];
      svg.appendChild(_el('text', { x: lx, y: ly, 'text-anchor': 'middle', class: 'cc-piepct' }, Math.round(frac * 100) + '%'));
    }
    a0 = a1;
  });
  // 图例（右侧）
  spec.labels.forEach((lb, i) => {
    const y = 60 + i * 24;
    svg.appendChild(_el('rect', { x: 320, y: y - 9, width: 11, height: 11, rx: 2, fill: PALETTE[i % PALETTE.length] }));
    svg.appendChild(_el('text', { x: 338, y: y, class: 'cc-lg' }, `${lb}（${data[i]}）`));
  });
  return svg;
}

function _legend(spec) {
  const g = _el('g', {});
  spec.series.forEach((s, i) => {
    const y = 14 + i * 16;
    g.appendChild(_el('rect', { x: 600 - 14 - 130, y: y - 8, width: 10, height: 10, rx: 2, fill: PALETTE[i % PALETTE.length] }));
    g.appendChild(_el('text', { x: 600 - 14 - 114, y: y, class: 'cc-lg' }, s.name || ('系列' + (i + 1))));
  });
  return spec.series.length > 1 ? g : _el('g', {});
}

function _fmtNum(v) {
  const a = Math.abs(v);
  if (a >= 10000) return (v / 10000).toFixed(1) + 'w';
  if (a >= 1000) return (v / 1000).toFixed(1) + 'k';
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

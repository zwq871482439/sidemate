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

let _mermaidInited = false;
function _initMermaid() {
  if (_mermaidInited || typeof mermaid === 'undefined') return;
  _mermaidInited = true;
  // fontFamily 必须显式字体栈（继承字体会让 mermaid 测量框偏小，中文溢出——经典版同款修复）
  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'loose',
    suppressErrorRendering: true,  // 不渲染 mermaid 原生红色炸弹报错图（降级 UI 我们自己出）
    fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
    flowchart: { padding: 12, nodeSpacing: 60, rankSpacing: 60, useMaxWidth: false, htmlLabels: false },
  });
}

export function hydrateMermaid(container) {
  if (typeof mermaid === 'undefined') return;
  _initMermaid();
  const _cleanOrphans = () => {
    // mermaid 渲染期的临时容器（id 前缀 dmm-）失败时会挂着原生报错图残留在 body 末尾
    document.querySelectorAll('body > div[id^="dmm-"]').forEach(el => el.remove());
  };
  container.querySelectorAll('.mermaid-container:not([data-rendered])').forEach(box => {
    const code = decodeURIComponent(box.getAttribute('data-mermaid') || '');
    if (!code) return;
    const parent = box.parentElement;
    const next = box.nextSibling;
    mermaid.render('mm-' + Math.random().toString(36).slice(2, 10), code)
      .then(result => {
        box.setAttribute('data-rendered', '1');
        // mermaid 测量期会把容器挪到 body 末尾，settle 后无条件放回原位（经典版同款坑）
        if (!box.parentElement) {
          if (next && next.parentElement === parent) parent.insertBefore(box, next);
          else if (parent) parent.appendChild(box);
        }
        box.innerHTML = result.svg;
        _cleanOrphans();
      })
      .catch(err => {
        box.setAttribute('data-rendered', '1');
        if (!box.parentElement) {
          if (next && next.parentElement === parent) parent.insertBefore(box, next);
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
  container.querySelectorAll('.cc-slot:not([data-cc-done])').forEach(slot => {
    slot.setAttribute('data-cc-done', '1');
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
    const card = document.createElement('div');
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
    slot.replaceWith(card);
  });
  // 引用卡槽（消息自带的来源数据，非围栏块）
  container.querySelectorAll('.cc-ref-slot:not([data-cc-done])').forEach(slot => {
    slot.setAttribute('data-cc-done', '1');
    let sources = [];
    try { sources = JSON.parse(decodeURIComponent(slot.dataset.refs || '')); } catch (e) { /* 忽略 */ }
    if (!sources.length) { slot.remove(); return; }
    slot.replaceWith(_renderRefCard(sources));
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
  }
  return '';
}

// ===== 问答卡（ask）：模型提问 → 用户单选/手敲 → 回答开新轮（回合制） =====
function _renderAsk(card, spec, opts) {
  const answered = opts && opts.getCardAnswer ? opts.getCardAnswer(spec.question) : null;
  card.innerHTML = `<div class="cc-head">
    <span class="cc-badge">❓</span>
    <span class="cc-title">需要确认</span>
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
  (spec.options || []).forEach(o => {
    const b = document.createElement('button');
    b.className = 'cc-ask-opt';
    b.textContent = o;
    b.addEventListener('click', () => {
      picked = o;
      optsRow.querySelectorAll('.cc-ask-opt').forEach(x => x.classList.toggle('on', x === b));
      input.value = o;
      input.dispatchEvent(new Event('input'));
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
  go.textContent = '回答';
  const submit = () => {
    const answer = (input.value || picked).trim();
    if (!answer) { input.focus(); return; }
    body.innerHTML = `<div class="cc-ask-done">✓ 已答：${esc(answer)}</div>`;
    if (opts && opts.onAskAnswer) opts.onAskAnswer(spec.question, answer);
  };
  go.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  row.appendChild(input);
  if (spec.allow_input !== false || !(spec.options || []).length) row.appendChild(go);
  body.appendChild(row);
}

// ===== 引用卡（ref）：唯一跨两界——同渲染组件，两数据来路（kb_sources/agent results） =====
function _renderRefCard(sources) {
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
    item.innerHTML = `<span class="cc-ref-n">[${i + 1}]</span>
      <span class="cc-ref-badge ${s.kind === 'web' ? 'web' : 'kb'}">${iconSvg(s.kind === 'web' ? 'globe' : 'book')}</span>
      <span class="cc-ref-t">${esc(s.title)}</span>
      <div class="cc-ref-x">${esc(s.excerpt || '')}</div>`;
    item.addEventListener('click', () => item.classList.toggle('open'));
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

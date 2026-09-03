// 桌伴 0.10.1 新版 UI — 内容卡片系统（PLAN ②+：在线 LLM 的渲染协议）
// LLM 产数据（围栏块 JSON），前端确定性渲染——LLM 不碰展示代码。
// 首发：chart（折线/柱状/饼图，手写 SVG 零依赖）+ table（可排序）。
// 存产物：table→CSV / chart→SVG，写 <项目目录>/.sidemate/（用户显式动作）。

import { api } from './api.js';

const PALETTE = ['#0F2B46', '#E8B54D', '#4E7FA6', '#6BA36B', '#B0653A', '#7A5CA6'];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===== 围栏块提取：```chart / ```table + JSON → 占位槽 =====
// 离线不调用本函数（PLAN：卡片系统仅在线参与）
export function extractCards(text) {
  if (!text) return text;
  return text.replace(/```(chart|table)\s*\n([\s\S]*?)```/g, (m, type, body) => {
    return '\n\n<div class="cc-slot" data-cc-type="' + type + '" data-cc="'
      + encodeURIComponent(body.trim()) + '"></div>\n\n';
  });
}

// ===== 卡片水合：渲染占位槽（解析失败优雅降级为源码+错误提示） =====
export function hydrateCards(container, opts) {
  // opts: { getSession() }
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
      card.innerHTML = `<div class="cc-err">⚠️ ${esc(err)}</div>
        <pre class="cc-raw">${esc(decodeURIComponent(slot.dataset.cc || ''))}</pre>`;
    } else {
      const title = spec.title || (type === 'chart' ? '图表' : '表格');
      card.innerHTML = `<div class="cc-head">
        <span class="cc-badge">${type === 'chart' ? '📊' : '🗂'}</span>
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
}

function _validate(type, spec) {
  if (!spec || typeof spec !== 'object') return '卡片数据不是对象';
  if (type === 'chart') {
    if (!['line', 'bar', 'pie'].includes(spec.type)) return '不支持的图表类型: ' + (spec.type || '(空)');
    if (!Array.isArray(spec.labels) || !spec.labels.length) return 'labels 缺失或为空';
    if (!Array.isArray(spec.series) || !spec.series.length) return 'series 缺失或为空';
    if (!spec.series.every(s => Array.isArray(s.data))) return 'series.data 必须是数组';
  } else {
    if (!Array.isArray(spec.columns) || !spec.columns.length) return 'columns 缺失或为空';
    if (!Array.isArray(spec.rows)) return 'rows 必须是数组';
  }
  return '';
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

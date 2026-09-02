// 桌伴 0.10.1 新版 UI — 知识星图（M1-D KB-2 增量）
// 数据：overview/refresh 的 graph 字段（服务端已 FR 力布局沉降，终态坐标直出，
// 前端不做力布局）。graph = { settled, nodes:[{doc_id,name,cat,deg,x,y,group,sub}],
// edges:[{s,t,w,reasons[]}] }（s/t 为 nodes 下标）

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 分组配色（DNA-01 同色相深浅 + 金点睛；禁跨色相彩虹；相邻组色相距离拉开）
const GROUP_COLORS = ['#0F2B46', '#B07E1E', '#3A6A8F', '#16405F', '#5B6B7B', '#1B4F72', '#8C9BAB'];

export function createStarView(opts) {
  // opts: { graph, docs, onExplain(docId) -> Promise<text>, onSelectDoc(docId) }
  const graph = opts.graph;
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];

  // 分组着色：group 名 → 颜色
  const groups = [];
  nodes.forEach(n => { if (!groups.includes(n.group)) groups.push(n.group); });
  const groupColor = {};
  groups.forEach((g, i) => { groupColor[g] = GROUP_COLORS[i % GROUP_COLORS.length]; });

  // 邻居表
  const neighbors = {};
  edges.forEach(e => {
    (neighbors[e.s] = neighbors[e.s] || []).push(e.t);
    (neighbors[e.t] = neighbors[e.t] || []).push(e.s);
  });

  const el = document.createElement('div');
  el.className = 'kb-star';
  el.innerHTML = `
    <svg class="star-bg" viewBox="0 0 1020 580" preserveAspectRatio="xMidYMid meet">
      <g class="star-viewport">
        <g class="star-edges">
          ${edges.map(e => `<line data-s="${e.s}" data-t="${e.t}"
            x1="${nodes[e.s].x}" y1="${nodes[e.s].y}" x2="${nodes[e.t].x}" y2="${nodes[e.t].y}"
            stroke="#9FB3C8" stroke-width="${Math.max(0.6, (e.w || 0.35) * 2)}" opacity="0.5" />`).join('')}
        </g>
        <g class="star-nodes">
          ${nodes.map((n, i) => `
            <g class="snode" data-i="${i}" transform="translate(${n.x},${n.y})">
              <circle r="${Math.min(16, 6 + (n.deg || 1) * 1.4)}" fill="${groupColor[n.group]}" opacity="0.92" />
              <circle r="${Math.min(16, 6 + (n.deg || 1) * 1.4)}" fill="none" stroke="#fff" stroke-width="1.5" />
            </g>`).join('')}
        </g>
      </g>
    </svg>
    <div class="star-filter"></div>
    <div class="star-hint">Ctrl+滚轮缩放 · 拖拽移动 · 双击复位</div>
    <div class="star-float" id="starFloat">
      <div class="sf-head">
        <div class="sf-head-tx">知识星图<small>${nodes.length} 篇 · ${groups.length} 主题 · ${edges.length} 关联</small></div>
        <button class="sf-collapse" title="收起/展开">⟨</button>
      </div>
      <div class="sf-body"></div>
    </div>
    <div class="star-tip" id="starTip" style="display:none"></div>
  `;

  const svg = el.querySelector('.star-bg');
  const viewport = el.querySelector('.star-viewport');
  const tip = el.querySelector('#starTip');
  const floatPanel = el.querySelector('#starFloat');
  const floatBody = floatPanel.querySelector('.sf-body');

  // ---- 缩放/平移/复位（viewBox 方案） ----
  let vb = { x: 0, y: 0, w: 1020, h: 580 };
  function applyVb() { svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`); }
  svg.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.12 : 0.89;
    const nw = Math.min(1020 * 6, Math.max(1020 / 6, vb.w * factor));
    const nh = vb.h * (nw / vb.w);
    // 以指针为中心缩放
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
    vb.x = loc.x - (loc.x - vb.x) * (nw / vb.w);
    vb.y = loc.y - (loc.y - vb.y) * (nw / vb.w);
    vb.w = nw; vb.h = nh;
    applyVb();
  }, { passive: false });
  let drag = null;
  svg.addEventListener('mousedown', (e) => {
    drag = { x: e.clientX, y: e.clientY, vbx: vb.x, vby: vb.y };
  });
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragEnd);
  function onDragMove(e) {
    if (!drag) return;
    const scale = vb.w / svg.clientWidth;
    vb.x = drag.vbx - (e.clientX - drag.x) * scale;
    vb.y = drag.vby - (e.clientY - drag.y) * scale;
    applyVb();
  }
  function onDragEnd() { drag = null; }
  svg.addEventListener('dblclick', () => { vb = { x: 0, y: 0, w: 1020, h: 580 }; applyVb(); });

  // ---- 悬停高亮 + tip ----
  function hoverNode(i, evt) {
    const lit = new Set([i, ...(neighbors[i] || [])]);
    el.querySelectorAll('.snode').forEach(g => {
      const gi = +g.dataset.i;
      g.style.opacity = lit.has(gi) ? '1' : '0.14';
    });
    el.querySelectorAll('.star-edges line').forEach(l => {
      const on = +l.dataset.s === i || +l.dataset.t === i;
      l.style.opacity = on ? '0.9' : '0.08';
      l.style.stroke = on ? '#E8B54D' : '#9FB3C8';
    });
    const n = nodes[i];
    tip.style.display = '';
    tip.innerHTML = `<b>${esc(n.name)}</b><br><small>${esc(n.group)}${n.sub ? ' · ' + esc(n.sub) : ''} · 关联 ${(neighbors[i] || []).length}</small>`;
    const rect = el.getBoundingClientRect();
    tip.style.left = Math.min(rect.width - 240, evt.clientX - rect.left + 14) + 'px';
    tip.style.top = (evt.clientY - rect.top + 14) + 'px';
  }
  function hoverOut() {
    if (focused !== null) { applyFocus(focused); return; }  // 聚焦态不被 hover 清空
    el.querySelectorAll('.snode').forEach(g => { g.style.opacity = '1'; });
    el.querySelectorAll('.star-edges line').forEach(l => { l.style.opacity = '0.5'; l.style.stroke = '#9FB3C8'; });
    tip.style.display = 'none';
  }

  // ---- 点选聚焦 + 浮窗详情 ----
  let focused = null;
  function applyFocus(i) {
    const lit = new Set([i, ...(neighbors[i] || [])]);
    el.querySelectorAll('.snode').forEach(g => {
      const gi = +g.dataset.i;
      g.style.opacity = lit.has(gi) ? '1' : '0.14';
      g.classList.toggle('lit', lit.has(gi));
    });
    el.querySelectorAll('.star-edges line').forEach(l => {
      const on = +l.dataset.s === i || +l.dataset.t === i;
      l.style.opacity = on ? '0.9' : '0.08';
      l.style.stroke = on ? '#E8B54D' : '#9FB3C8';
    });
  }

  function showDetail(i) {
    focused = i;
    applyFocus(i);
    const n = nodes[i];
    const doc = (opts.docs || []).find(d => d.doc_id === n.doc_id) || {};
    const nbs = (neighbors[i] || []).map(j => {
      const e = edges.find(e => (e.s === i && e.t === j) || (e.t === i && e.s === j));
      return { n: nodes[j], reasons: e ? (e.reasons || []) : [] };
    });
    floatBody.innerHTML = `
      <div class="sf-node-props">
        <div class="np-name">${esc(n.name)}</div>
        <div class="np-row"><span class="np-k">分类</span><span class="np-v">${esc(n.group)}${n.sub ? ' · ' + esc(n.sub) : ''}</span></div>
        <div class="np-row"><span class="np-k">规模</span><span class="np-v">${doc.chunk_count || 0} 块 · ${doc.total_chars || 0} 字</span></div>
        <div class="np-row"><span class="np-k">关联</span><span class="np-v">${nbs.length} 条</span></div>
        ${doc.summary ? `<div class="np-row"><span class="np-k">摘要</span><span class="np-v">${esc(String(doc.summary).slice(0, 120))}</span></div>` : ''}
      </div>
      <div class="sf-rels">
        <div class="rt">关联文档</div>
        ${nbs.length ? nbs.map(nb => `
          <div class="sf-rel" data-name="${esc(nb.n.name)}">
            <span>· ${esc(nb.n.name)}</span>
            <span class="rl">${esc(nb.reasons[0] || '')}</span>
          </div>`).join('') : '<div class="rt">孤立节点（无关联）</div>'}
      </div>
      <button class="sf-ai">✦ AI 详解</button>
      <div class="sf-ai-text" style="display:none"></div>
    `;
    floatBody.querySelectorAll('.sf-rel').forEach(r => r.addEventListener('click', () => {
      const j = nodes.findIndex(x => x.name === r.dataset.name);
      if (j >= 0) showDetail(j);
    }));
    const aiBtn = floatBody.querySelector('.sf-ai');
    aiBtn.addEventListener('click', async () => {
      aiBtn.disabled = true; aiBtn.textContent = '生成中…';
      const box = floatBody.querySelector('.sf-ai-text');
      try {
        const text = await opts.onExplain(n.doc_id);
        box.style.display = '';
        box.textContent = text || '（无内容）';
        aiBtn.style.display = 'none';
      } catch (e) {
        aiBtn.disabled = false; aiBtn.textContent = '✦ AI 详解（重试）';
      }
    });
  }

  function clearFocus() {
    focused = null;
    hoverOut();
    renderList();
  }

  svg.querySelectorAll('.snode').forEach(g => {
    g.addEventListener('mouseenter', (e) => hoverNode(+g.dataset.i, e));
    g.addEventListener('mousemove', (e) => { if (tip.style.display !== 'none' && focused === null) hoverNode(+g.dataset.i, e); });
    g.addEventListener('mouseleave', hoverOut);
    g.addEventListener('click', (e) => { e.stopPropagation(); showDetail(+g.dataset.i); });
  });
  svg.addEventListener('click', () => { if (focused !== null) clearFocus(); });

  // ---- 浮窗：文档列表（默认态） ----
  function renderList() {
    const byGroup = {};
    nodes.forEach((n, i) => { (byGroup[n.group] = byGroup[n.group] || []).push({ n, i }); });
    floatBody.innerHTML = Object.entries(byGroup).map(([g, items]) => `
      <div class="rt" style="padding:6px 8px 4px;font-size:10.5px;color:var(--d1-ink-3)">
        <span class="dot2" style="background:${groupColor[g]}"></span>${esc(g)}（${items.length}）
      </div>
      ${items.map(({ n, i }) => `
        <div class="sf-item" data-i="${i}">
          <div class="fn2">${esc(n.name)}</div>
          <div class="fm2">${esc(n.sub || '')} · 关联 ${(neighbors[i] || []).length}</div>
        </div>`).join('')}
    `).join('');
    floatBody.querySelectorAll('.sf-item').forEach(item =>
      item.addEventListener('click', () => showDetail(+item.dataset.i)));
  }
  renderList();

  // ---- 图例（点主类高亮） ----
  const filterEl = el.querySelector('.star-filter');
  filterEl.innerHTML = groups.map(g =>
    `<button data-g="${esc(g)}">${esc(g)}</button>`).join('');
  filterEl.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    const g = b.dataset.g;
    const on = b.classList.toggle('on');
    filterEl.querySelectorAll('button').forEach(x => { if (x !== b) x.classList.remove('on'); });
    el.querySelectorAll('.snode').forEach(node => {
      const n = nodes[+node.dataset.i];
      node.style.opacity = (!on || n.group === g) ? '1' : '0.14';
    });
  }));

  // 浮窗收起/展开
  floatPanel.querySelector('.sf-collapse').addEventListener('click', () => {
    floatPanel.classList.toggle('collapsed');
  });

  function destroy() {
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
  }

  return { el, destroy };
}

// AI 详解（后端缓存，重试由调用方处理）
export async function fetchMapExplain(docId) {
  const r = await fetch('/api/kb/map-explain', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ doc_id: docId }),
  });
  const d = await r.json();
  if (!r.ok || !d.ok) throw new Error(d.error || 'HTTP ' + r.status);
  return d.explain || '';
}

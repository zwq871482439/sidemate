// 桌伴 0.10.1 新版 UI — 知识库管理视图（M1-D KB-1 增量）
// 功能覆盖（对照迁移清单 A 组）：三态路由/文档列表+统计/卡片渲染/分类筛选 chips/
// 文件名搜索/卡片列表切换/单文档删除·私密·详情/批量工具栏/上传（点击+拖拽+
// SSE 进度浮动底栏+冲突处理）/AI 洞察面板+推荐追问/私密区/热力图圆点。
// 星图（B 组）在 KB-2 增量。端点与经典版同一后端。

import { createStarView, fetchMapExplain } from './kb_star.js';
import { icon, iconSvg } from './icons.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const ACCEPT_EXTS = ['.txt', '.md', '.csv', '.docx', '.xlsx', '.pdf', '.epub', '.html', '.htm', '.srt', '.rtf'];

// 状态文案（经典版口径）
const STATUS_LABEL = {
  pending: '排队中', processing: '处理中', indexing: '索引中', ready: '已就绪',
  paused: '已暂停', cancelled: '已取消', error: '失败', conflict: '待处理冲突',
};

export function createKBView(events) {
  // events: { onGoClassic(), onAskChat(question)（推荐追问跳聊天） }
  const state = {
    moduleReady: null,   // null=loading, false=未安装/未就绪, true=可用
    docs: [],
    stats: null,
    overview: null,      // AI 洞察（insight/categories/suggested_questions/…）
    heatmap: {},         // doc_id → hit_count
    filterCat: '',       // 分类筛选（''=全部，'__none__'=未分类）
    search: '',
    view: 'card',        // card|list
    pane: 'list',        // list=清单（管理）| star=星图
    selected: new Set(),
    queue: [],           // 上传/处理队列条目
  };
  const el = document.createElement('div');
  el.className = 'kb-wrap';
  let _pollTimer = null;
  let _sse = {};  // doc_id → EventSource

  // ============ 数据加载 ============
  async function loadModuleStatus() {
    try {
      const r = await fetch('/api/kb/module-status');
      const d = await r.json();
      state.moduleReady = !!(d.installed && d.ready);
      state.moduleInfo = d;
    } catch (e) { state.moduleReady = false; }
  }
  async function loadDocs() {
    try {
      const [docsR, statsR, heatR] = await Promise.all([
        fetch('/api/kb/documents'), fetch('/api/kb/stats'), fetch('/api/kb/search_heatmap'),
      ]);
      state.docs = await docsR.json();
      state.stats = await statsR.json();
      const heat = await heatR.json();
      state.heatmap = {};
      (heat.heatmap || []).forEach(h => { state.heatmap[h.doc_id] = h.hit_count; });
      if (typeof events.onDocsChange === 'function') events.onDocsChange(state.docs);
    } catch (e) { /* 保持现状 */ }
  }
  // AI 洞察面板已按 0.10.1 定稿移除（0.9.7 用户反馈不知所云）；
  // 但 overview 数据仍加载——星图 graph 与 stale 重生成依赖它
  async function loadOverview(force) {
    try {
      const r = await fetch('/api/kb/overview/refresh');
      const d = await r.json();
      if (d && d.ok) {
        state.overview = d;
        if (d.stale && !force) {
          fetch('/api/kb/overview/refresh', { method: 'POST' })
            .then(r => r.json()).then(d2 => { if (d2 && d2.ok) state.overview = d2; })
            .catch(() => {});
        }
      }
    } catch (e) { /* 洞察失败不阻断管理视图 */ }
  }

  // ============ 渲染 ============
  function render() {
    if (state.moduleReady === null) {
      el.innerHTML = '<div class="kb-loading">知识库状态检测中…</div>';
      return;
    }
    if (state.moduleReady === false) {
      el.innerHTML = `
        <div class="kb-onboard">
          <h2>知识库未就绪</h2>
          <p>需要安装并加载知识库模块（检索模型）。<br>请到经典版「设置 → 模型下载 / 环境检查」完成安装。</p>
          <button class="btn-primary-v2" id="kbGoClassic">去经典版完成配置</button>
        </div>`;
      el.querySelector('#kbGoClassic').addEventListener('click', () => events.onGoClassic());
      return;
    }

    el.innerHTML = `
      <div class="kb-hero" id="kbHero">
        <div class="kb-hero-ic">${iconSvg('upload')}</div>
        <div class="kb-hero-tx"><b>上传文档到知识库</b>
        <span>PDF / Word / Excel / Markdown / TXT · 自动切分、向量化与打标<br>拖拽文件到此处，或点击选择（支持多选）</span></div>
      </div>
      <div class="kb-chips" id="kbChips"></div>
      <div class="kb-batch" id="kbBatch" style="display:none"></div>
      <div class="kb-private" id="kbPrivate"></div>
      <div class="kb-grid" id="kbGrid"></div>
      <div class="kb-foot" id="kbFoot"></div>
      <div class="kb-floatbar" id="kbFloat" style="display:none"></div>
      <input type="file" id="kbFile" multiple style="display:none" accept="${ACCEPT_EXTS.join(',')}">
    `;

    renderChips();
    renderPrivate();
    renderGrid();
    renderFoot();
    renderFloat();
    bindTop();

    // 星图 pane（全幅覆盖中栏内容区；顶栏在外层不受影响，随时可切回）
    if (state.pane === 'star') _mountStar(); else _unmountStar();
    const slot = document.getElementById('kb-topbar-slot');
    if (slot) renderTopbar(slot);
  }

  // ---- 星图挂载（数据：overview.graph 服务端沉降终态直出） ----
  let _star = null;
  function _mountStar() {
    const mainEl = document.getElementById('main');
    if (!mainEl) return;
    if (_star) return;  // 已挂载
    const graph = state.overview && state.overview.graph;
    if (!graph || !graph.settled || !(graph.nodes || []).length) {
      // 无图/未沉降：触发后端重生成后自动挂载
      const ph = document.createElement('div');
      ph.className = 'kb-star';
      ph.innerHTML = '<div class="kb-loading" style="padding-top:120px">星图生成中…（基于全部文档构建关联）</div>';
      mainEl.appendChild(ph);
      _star = { el: ph, destroy: () => ph.remove() };
      fetch('/api/kb/overview/refresh', { method: 'POST' })
        .then(r => r.json())
        .then(d => {
          if (d && d.ok) state.overview = d;
          if (_star && _star.el === ph) { _unmountStar(); _mountStar(); renderOverview(); }
        })
        .catch(() => { ph.innerHTML = '<div class="kb-loading" style="padding-top:120px">星图生成失败，请稍后重试</div>'; });
      return;
    }
    _star = createStarView({
      graph,
      docs: state.docs,
      onExplain: fetchMapExplain,
      onSelectDoc: () => {},
    });
    mainEl.appendChild(_star.el);
  }
  function _unmountStar() {
    if (!_star) return;
    _star.destroy();
    _star.el.remove();
    _star = null;
  }

  // 顶栏工具区渲染（用户定稿：清单/星图 → 卡片/列表（仅清单态）→ 上传 → 搜索 → 统计；
  // 全部进顶栏，星图全幅覆盖时也能切回清单）
  function renderTopbar(slot) {
    slot.innerHTML = `
      <div class="kb-view-toggle" title="清单/星图">
        <button data-p="list" class="${state.pane === 'list' ? 'on' : ''}">▤ 清单</button>
        <button data-p="star" class="${state.pane === 'star' ? 'on' : ''}">✦ 星图</button>
      </div>
      ${state.pane === 'list' ? `
      <div class="kb-view-toggle" title="卡片/列表">
        <button data-v="card" class="${state.view === 'card' ? 'on' : ''}" title="卡片视图">▦</button>
        <button data-v="list" class="${state.view === 'list' ? 'on' : ''}" title="列表视图">${iconSvg('list')}</button>
      </div>` : ''}
      <button class="kb-tool-btn" id="kbUploadBtn">${icon('upload')} 上传文档</button>
      <input class="kb-search" placeholder="搜索文件名…" value="${esc(state.search)}" style="max-width:180px">
      <span class="kb-stat">${state.docs.length} 篇</span>
    `;
    slot.querySelectorAll('button[data-p]').forEach(b =>
      b.addEventListener('click', () => { state.pane = b.dataset.p; render(); }));
    slot.querySelectorAll('button[data-v]').forEach(b =>
      b.addEventListener('click', () => { state.view = b.dataset.v; render(); }));
    slot.querySelector('#kbUploadBtn').addEventListener('click', () => el.querySelector('#kbFile').click());
    let deb = null;
    slot.querySelector('.kb-search').addEventListener('input', (e) => {
      clearTimeout(deb);
      deb = setTimeout(() => { state.search = e.target.value.trim().toLowerCase(); renderGrid(); }, 300);
    });
  }

  function bindTop() {
    el.querySelector('#kbFile').addEventListener('change', (e) => { uploadFiles([...e.target.files]); e.target.value = ''; });
    const hero = el.querySelector('#kbHero');
    if (hero) hero.addEventListener('click', () => el.querySelector('#kbFile').click());
    // 拖拽上传
    el.ondragover = (e) => { e.preventDefault(); el.classList.add('drag-over'); };
    el.ondragleave = () => el.classList.remove('drag-over');
    el.ondrop = (e) => {
      e.preventDefault(); el.classList.remove('drag-over');
      if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
    };
  }

  // ---- 分类筛选 chips（前端聚合 category，含「未分类」） ----
  function renderChips() {
    const cats = {};
    state.docs.forEach(d => {
      const c = (d.category || '').trim() || '__none__';
      cats[c] = (cats[c] || 0) + 1;
    });
    const chipsEl = el.querySelector('#kbChips');
    if (!chipsEl) return;
    const entries = Object.entries(cats).sort((a, b) => b[1] - a[1]);
    chipsEl.innerHTML = '';
    const mk = (val, label, cnt) => {
      const b = document.createElement('button');
      b.className = 'kb-chip' + (state.filterCat === val ? ' on' : '');
      b.textContent = label + (cnt != null ? ` ${cnt}` : '');
      b.addEventListener('click', () => { state.filterCat = val; renderChips(); renderGrid(); });
      chipsEl.appendChild(b);
    };
    mk('', '全部', state.docs.length);
    entries.forEach(([c, n]) => mk(c, c === '__none__' ? '未分类' : c, n));
  }

  // ---- 私密文档区 ----
  function renderPrivate() {
    const box = el.querySelector('#kbPrivate');
    if (!box) return;
    const privates = state.docs.filter(d => d.is_private);
    if (!privates.length) { box.style.display = 'none'; return; }
    box.style.display = '';
    box.innerHTML = `
      <details>
        <summary>${icon('lock')} 私密文档（${privates.length}）<span class="kb-pv-hint">不参与常规检索，需令牌授权</span></summary>
        <div class="kb-pv-list">${privates.map(d => `
          <div class="kb-pv-item" data-id="${esc(d.doc_id)}">
            <span class="kb-pv-name">${esc(d.filename)}</span>
            <button class="kb-pv-unlock" title="取消私密">取消私密</button>
          </div>`).join('')}
        </div>
      </details>`;
    box.querySelectorAll('.kb-pv-unlock').forEach(b =>
      b.addEventListener('click', async (e) => {
        const id = e.target.closest('.kb-pv-item').dataset.id;
        await fetch(`/api/kb/documents/${id}/privacy`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_private: false }),
        });
        await loadDocs(); render();
      }));
  }

  // ---- 文档卡片/列表 ----
  function filteredDocs() {
    const f = state.filterCat || '';
    return state.docs.filter(d => {
      if (f) {
        if (f === '__priv__') { if (!d.is_private) return false; }
        else if (f === '__recent7__') {
          const t = Date.parse(d.imported_at || '');
          if (!t || Date.now() - t > 7 * 86400e3) return false;
        }
        else if (f === '__none__') { if ((d.category || '').trim()) return false; }
        else if (f.startsWith('cat:')) {
          const want = f.slice(4);
          const sub = (window._v2KbSubMap || {})[d.doc_id];
          if (want.includes('/')) {
            const [g, sb2] = want.split('/');
            if (!sub || sub.group !== g || sub.sub !== sb2) return false;
          } else if ((d.category || '').trim() !== want) return false;
        }
      }
      if (state.search && !(d.filename || '').toLowerCase().includes(state.search)) return false;
      return true;
    });
  }

  function heatDot(docId) {
    const h = state.heatmap[docId] || 0;
    const cls = h >= 10 ? 'hot' : h >= 3 ? 'warm' : 'cold';
    return `<span class="hm-dot ${cls}" title="被搜索 ${h} 次"></span>`;
  }

  function renderGrid() {
    const grid = el.querySelector('#kbGrid');
    if (!grid) return;
    const docs = filteredDocs();
    if (!docs.length) {
      grid.innerHTML = `<div class="kb-empty">${state.docs.length ? '没有匹配的文档' : '还没有文档，点「上传文档」或直接把文件拖进来'}</div>`;
      return;
    }
    grid.className = 'kb-grid ' + (state.view === 'list' ? 'as-list' : '');
    grid.innerHTML = docs.map(d => {
      const sel = state.selected.has(d.doc_id);
      const tags = (d.tags || []).slice(0, 4).map(t => `<span class="kb-tag">${esc(t)}</span>`).join('');
      const stLabel = STATUS_LABEL[d.status] || d.status;
      const priv = d.is_private ? `<span class="kb-lock" title="私密文档">${iconSvg('lock')}</span>` : '';
      const dup = (d.metadata && d.metadata.duplicate_of) ? '<span class="kb-dup" title="与既有文档重复">' + iconSvg('alertTriangle') + ' 重复</span>' : '';
      const summary = d.summary
        ? esc(d.summary)
        : (d.tag_status === 'generating' ? 'AI 摘要生成中…' : (d.tag_status === 'failed' ? '摘要生成失败' : '暂无摘要'));
      return `
      <div class="kb-card ${sel ? 'sel' : ''} ${d.status !== 'ready' ? 'notready' : ''}" data-id="${esc(d.doc_id)}">
        <div class="kb-card-top">
          <input type="checkbox" class="kb-sel" ${sel ? 'checked' : ''} title="选择">
          <span class="kb-fn" title="${esc(d.filename)}">${priv}${esc(d.filename)}</span>
          ${heatDot(d.doc_id)}
        </div>
        <div class="kb-sum">${summary}</div>
        <div class="kb-tags">${tags}</div>
        <div class="kb-card-meta">
          <span>${stLabel} · ${d.chunk_count || 0} 块 · ${_fmtSize(d.file_size)}</span>
          <span class="kb-acts">
            <button data-act="detail" title="详情">详情</button>
            <button data-act="privacy" title="${d.is_private ? '取消私密' : '设为私密'}">${iconSvg(d.is_private ? 'lockOpen' : 'lock')}</button>
            <button data-act="del" title="删除">✕</button>
          </span>
        </div>
      </div>`;
    }).join('');

    grid.querySelectorAll('.kb-card').forEach(card => {
      const id = card.dataset.id;
      card.querySelector('.kb-sel').addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
        renderBatch(); renderGrid();
      });
      card.querySelector('[data-act="detail"]').addEventListener('click', (e) => { e.stopPropagation(); showDetail(id); });
      card.querySelector('[data-act="privacy"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        const doc = state.docs.find(x => x.doc_id === id);
        await fetch(`/api/kb/documents/${id}/privacy`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_private: !doc.is_private }),
        });
        await loadDocs(); render();
      });
      card.querySelector('[data-act="del"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        const doc = state.docs.find(x => x.doc_id === id);
        if (!confirm(`删除文档「${doc.filename}」？此操作不可撤销。`)) return;
        await fetch(`/api/kb/documents/${id}`, { method: 'DELETE' });
        state.selected.delete(id);
        await loadDocs(); render();
      });
    });
    renderBatch();
  }

  // ---- 批量工具栏 ----
  function renderBatch() {
    const bar = el.querySelector('#kbBatch');
    if (!bar) return;
    const n = state.selected.size;
    if (!n) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    bar.innerHTML = `
      <span>已选 ${n} 篇</span>
      <button data-b="del" class="danger">删除</button>
      <button data-b="retag">重标</button>
      <button data-b="priv">设私密</button>
      <button data-b="pub">取消私密</button>
      <button data-b="all">全选</button>
      <button data-b="inv">反选</button>
      <button data-b="clear">清除</button>
    `;
    bar.querySelector('[data-b="del"]').addEventListener('click', async () => {
      if (!confirm(`批量删除 ${n} 篇文档？此操作不可撤销。`)) return;
      await fetch('/api/kb/documents/batch_delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc_ids: [...state.selected] }),
      });
      state.selected.clear(); await loadDocs(); render();
    });
    bar.querySelector('[data-b="retag"]').addEventListener('click', async () => {
      await fetch('/api/kb/documents/batch_retag', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc_ids: [...state.selected] }),
      });
      state.selected.clear(); await loadDocs(); render();
    });
    const priv = async (v) => {
      await fetch('/api/kb/documents/batch_privacy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc_ids: [...state.selected], is_private: v }),
      });
      state.selected.clear(); await loadDocs(); render();
    };
    bar.querySelector('[data-b="priv"]').addEventListener('click', () => priv(true));
    bar.querySelector('[data-b="pub"]').addEventListener('click', () => priv(false));
    bar.querySelector('[data-b="all"]').addEventListener('click', () => {
      filteredDocs().forEach(d => state.selected.add(d.doc_id)); renderBatch(); renderGrid();
    });
    bar.querySelector('[data-b="inv"]').addEventListener('click', () => {
      const ids = new Set(filteredDocs().map(d => d.doc_id));
      state.selected = new Set([...state.selected].filter(id => !ids.has(id))
        .concat([...ids].filter(id => !state.selected.has(id))));
      renderBatch(); renderGrid();
    });
    bar.querySelector('[data-b="clear"]').addEventListener('click', () => {
      state.selected.clear(); renderBatch(); renderGrid();
    });
  }

  // ---- 详情弹窗 ----
  function showDetail(id) {
    const d = state.docs.find(x => x.doc_id === id);
    if (!d) return;
    const ov = document.createElement('div');
    ov.className = 'kb-pk-overlay';
    ov.innerHTML = `
      <div class="kb-pk" style="width:520px">
        <div class="kb-pk-title">${esc(d.filename)}</div>
        <div class="kb-detail-rows">
          <div><span>状态</span>${esc(STATUS_LABEL[d.status] || d.status)}${d.is_private ? ` · ${icon('lock')} 私密` : ''}</div>
          <div><span>分类</span>${esc(d.category || '未分类')}</div>
          <div><span>大小</span>${_fmtSize(d.file_size)} · ${d.total_chars || 0} 字 · ${d.chunk_count || 0} 块</div>
          <div><span>被搜索</span>${d.hit_count || 0} 次</div>
          <div><span>上传时间</span>${esc(String(d.imported_at || '').slice(0, 16))}</div>
          <div><span>标签</span>${(d.tags || []).join('、') || '无'}</div>
          <div><span>AI 摘要</span>${esc(d.summary || '暂无')}</div>
        </div>
        <div class="kb-pk-acts"><button class="kb-pk-ok">关闭</button></div>
      </div>`;
    document.body.appendChild(ov);
    ov.querySelector('.kb-pk-ok').addEventListener('click', () => ov.remove());
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
  }

  // ---- 底部统计 ----
  function renderFoot() {
    const foot = el.querySelector('#kbFoot');
    if (!foot) return;
    const s = state.stats || {};
    const ready = state.docs.filter(d => d.status === 'ready').length;
    const chars = state.docs.reduce((sum, d) => sum + (d.total_chars || 0), 0);
    foot.innerHTML = `<span>${state.docs.length} 篇 · ${ready} 就绪 · ${s.total_chunks || 0} 块 · 约 ${(chars / 1000).toFixed(0)}K 字</span>`;
    const statLine = el.querySelector('#kbStatLine');
    if (statLine) statLine.textContent = `${state.docs.length} 篇`;
  }

  // ---- 上传 + SSE 进度 + 浮动底栏 ----
  async function uploadFiles(files) {
    for (const f of files) {
      const ext = '.' + (f.name.split('.').pop() || '').toLowerCase();
      if (!ACCEPT_EXTS.includes(ext)) {
        _queueAdd({ filename: f.name, phase: 'error', note: '不支持的格式（支持 ' + ACCEPT_EXTS.join(' ') + '）' });
        continue;
      }
      const item = _queueAdd({ filename: f.name, phase: 'uploading', progress: 0 });
      try {
        const fd = new FormData();
        fd.append('file', f);
        const resp = await fetch('/api/kb/upload', { method: 'POST', body: fd });
        const data = await resp.json();
        if (!resp.ok || !data.ok) {
          item.phase = 'error';
          item.note = data.error || data.message || ('HTTP ' + resp.status);
          renderFloat();
          continue;
        }
        if (data.status === 'conflict') {
          item.phase = 'conflict';
          item.doc_id = data.doc_id;
          item.note = '与「' + (data.duplicate_info ? data.duplicate_info.existing_filename : '') + '」重复';
          renderFloat();
          continue;
        }
        item.doc_id = data.doc_id;
        item.phase = 'processing';
        renderFloat();
        _subscribeProgress(item);
      } catch (e) {
        item.phase = 'error'; item.note = e.message; renderFloat();
      }
    }
    loadDocs().then(render);
  }

  function _queueAdd(item) {
    state.queue.push(item);
    renderFloat();
    return item;
  }

  function _subscribeProgress(item) {
    if (!item.doc_id) return;
    if (_sse[item.doc_id]) return;
    const es = new EventSource('/api/kb/progress/' + encodeURIComponent(item.doc_id));
    _sse[item.doc_id] = es;
    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        item.progress = d.progress || 0;
        item.phase = d.phase === 'done' ? 'done' : d.phase === 'error' ? 'error' : 'processing';
        if (d.phase === 'done' || d.phase === 'error' || d.phase === 'timeout') {
          es.close(); delete _sse[item.doc_id];
          loadDocs().then(render);
          loadOverview();
        }
        renderFloat();
      } catch (e) { /* 忽略 */ }
    };
    es.onerror = () => { es.close(); delete _sse[item.doc_id]; };
    // 60s 兜底断开（经典版同款）
    setTimeout(() => { if (_sse[item.doc_id]) { _sse[item.doc_id].close(); delete _sse[item.doc_id]; } }, 60000);
  }

  function renderFloat() {
    const bar = el.querySelector('#kbFloat');
    if (!bar) return;
    const active = state.queue.filter(q => q.phase !== 'done' && q.phase !== 'dismissed');
    if (!active.length) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    bar.innerHTML = active.map((q, i) => `
      <div class="kb-fq ${q.phase}">
        <span class="kb-fq-name">${esc(q.filename)}</span>
        <span class="kb-fq-note">${q.phase === 'processing' ? (Math.round((q.progress || 0) * 100) + '%') : esc(q.note || STATUS_LABEL[q.phase] || q.phase)}</span>
        ${q.phase === 'conflict' ? `
          <button data-cq="replace" data-i="${i}">替换旧文档</button>
          <button data-cq="keep" data-i="${i}">保留两者</button>` : ''}
        ${q.phase === 'error' || q.phase === 'done' ? `<button data-cq="x" data-i="${i}">✕</button>` : ''}
      </div>`).join('');
    bar.querySelectorAll('[data-cq]').forEach(b => b.addEventListener('click', async () => {
      const q = active[+b.dataset.i];
      const act = b.dataset.cq;
      if (act === 'x') { q.phase = 'dismissed'; renderFloat(); return; }
      if (act === 'replace' && q.doc_id) {
        // 经典版口径：replace = 删旧 + reprocess 新文档
        const doc = state.docs.find(x => x.doc_id === q.doc_id);
        const dupOf = doc && doc.metadata && doc.metadata.duplicate_of;
        if (dupOf) await fetch('/api/kb/documents/' + dupOf, { method: 'DELETE' });
        await fetch(`/api/kb/documents/${q.doc_id}/reprocess`, { method: 'POST' });
        q.phase = 'processing'; renderFloat();
        _subscribeProgress(q);
      }
      if (act === 'keep' && q.doc_id) {
        // 保留两者 = 新文档 reprocess 入库
        await fetch(`/api/kb/documents/${q.doc_id}/reprocess`, { method: 'POST' });
        q.phase = 'processing'; renderFloat();
        _subscribeProgress(q);
      }
    }));
  }

  function _fmtSize(bytes) {
    if (!bytes) return '0KB';
    if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + 'MB';
    return Math.round(bytes / 1024) + 'KB';
  }

  // ============ 生命周期 ============
  async function mount() {
    render();  // loading 态
    await loadModuleStatus();
    render();
    if (!state.moduleReady) return;
    await loadDocs();
    render();
    loadOverview();  // 星图数据预热（面板已移除，无需补渲染）
    // 有处理中/打标中文档时 3s 轮询（经典版同款节奏）
    _pollTimer = setInterval(() => {
      if (state.docs.some(d => ['pending', 'processing', 'indexing'].includes(d.status)
          || d.tag_status === 'pending' || d.tag_status === 'generating')) {
        loadDocs().then(render);
      }
    }, 3000);
  }
  function destroy() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    Object.values(_sse).forEach(es => es.close());
    _sse = {};
    _unmountStar();
  }

  return { el, mount, destroy,
    getDocs: () => state.docs,
    getOverview: () => state.overview,
    setFilter: (kf) => { state.filterCat = kf || ''; renderChips(); renderGrid(); },
    getFilter: () => state.filterCat,
    renderTopbar: () => {
      const slot = document.getElementById('kb-topbar-slot');
      if (slot && state.moduleReady) renderTopbar(slot);
    } };
}

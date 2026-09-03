// 桌伴 0.10.1 新版 UI — 明盒卡片（M1-D 卡片回放增量）
// 覆盖经典版 CardRenderer 核心：扁平步骤（agent_timeline）+ 推理轮次
// （agent_think + agent_status 工具）+ doc_loaded/summary/hint。
// 序列化格式与 card_data 完全兼容（与经典版 enrich 同一结构），历史回放共用。

import { icon } from './icons.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 状态 → 中文标签（照搬经典版 _agentStatusLabel）
export function agentStatusLabel(status, d) {
  d = d || {};
  if (status === 'thinking') return '思考中';
  if (status === 'searching') return '搜索：' + (d.query || '');
  if (status === 'fetching') return '阅读：' + (d.url || '');
  if (status === 'kb_searching') return '检索知识库：' + (d.query || '');
  if (status === 'workspace_writing') return '写入文档：' + (d.path || d.name || '');
  if (status === 'workspace_listing') return '列出工作区文件';
  if (status === 'workspace_reading') return '读取文档：' + (d.path || d.name || '');
  if (status === 'deep_reading') return '深度分析：' + (d.query || d.name || '');
  if (status === 'workspace_deleting') return '删除文档：' + (d.path || d.name || '');
  if (status === 'workspace_appending') return '追加内容：' + (d.path || d.name || '');
  if (status === 'workspace_editing') return '编辑文档：' + (d.path || d.name || '');
  if (status === 'doc_status') return '标记文档完成：' + (d.name || d.filename || '');
  if (status === 'docs_listing') return '列出文档列表';
  if (status === 'time_querying') return '获取当前时间';
  if (status === 'calculating') return '计算：' + (d.expression || '');
  if (status === 'format_converting') return '转换格式：' + (d.source || '') + ' → ' + (d.target || '');
  if (status === 'table_operating') return (d.action === 'write' ? '生成表格：' : '读取表格：') + (d.filename || '');
  if (status === 'error') {
    const reason = d.reason || d.message || '';
    if (reason.indexOf('文件不存在') >= 0) return '文件不存在：' + (d.filename || '');
    if (reason.indexOf('path_violation') >= 0) return '路径不安全，已拒绝';
    return reason ? '操作受限：' + reason : '操作异常';
  }
  if (status === 'tool_limit_reached') return d.message || '工具调用已达上限，基于已获取信息继续回答';
  if (status === 'tool_limited') return '工具调用已达上限，转入回答';
  if (status === 'ppt_working') {
    if (d.action === 'begin') return 'PPT 开题：' + (d.title || '');
    if (d.action === 'page') return '设计第 ' + (d.page || '?') + ' 页…';
    if (d.action === 'build') return '编译 PPTX…';
    return '制作 PPT';
  }
  if (status === 'plan_running') return '编排执行 ' + (d.count || '?') + ' 个工具（' + (d.detail || '') + '）…';
  if (status === 'plan') return '编排完成：' + (d.ok_count || 0) + '/' + (d.count || 0) + ' 步成功（' + (d.detail || '') + '）';
  if (status === 'readers_spawning') return '并行深读 ' + (d.count || '?') + ' 篇：' + (d.query || '');
  if (status === 'readers') return '深读完成：' + (d.ok_count || 0) + '/' + (d.count || 0) + ' 篇';
  if (status === 'ppt') {  // ppt_done 经 _done 后缀剥离到这里
    if (d.action === 'begin') return 'PPT 开题：' + (d.title || '');
    if (d.action === 'page') return '第 ' + (d.page || '?') + ' 页设计完成';
    if (d.action === 'build') return 'PPT 已生成：' + (d.pptx_name || '');
    return 'PPT 完成';
  }
  if (status.indexOf('_done') > 0) return agentStatusLabel(status.replace('_done', ''), d);
  return String(status).replace(/_/g, ' ');
}

// ============ 流式卡片容器 ============
export function createCardArea() {
  const el = document.createElement('div');
  el.className = 'cb-area';

  let steps = {};        // 扁平步骤（agent_timeline：step id → item）
  let units = [];        // 推理轮次（在线 agent）
  let curUnit = null;
  let docLoaded = [];
  let summaryData = null;
  let hintText = '';

  function _unitEl(u) { return el.querySelector(`[data-unit="${u.round}"]`); }

  function _newUnit() {
    // 闭合当前轮（有内容才闭合）
    if (curUnit && (curUnit.tools.length || curUnit.think)) {
      const u = curUnit;
      const uEl = _unitEl(u);
      if (uEl) {
        uEl.classList.add('closed');
        uEl.querySelector('.cb-reason-head .cb-elapsed').textContent = '';
      }
    }
    curUnit = { round: units.length + 1, think: '', tools: [], t0: Date.now() };
    units.push(curUnit);
    const div = document.createElement('details');
    div.className = 'cb-reason';
    div.setAttribute('open', '');
    div.dataset.unit = curUnit.round;
    div.innerHTML = `
      <summary class="cb-reason-head"><span class="cb-chev">▸</span> 推理第 ${curUnit.round} 轮
        <span class="cb-elapsed"></span></summary>
      <div class="cb-reason-body"><div class="cb-think" style="display:none"></div><div class="cb-tools"></div></div>`;
    el.appendChild(div);
  }

  function handleEvent(d) {
    if (d.type === 'agent_timeline') {
      // 扁平步骤（local/parallel 的 Step 协议：start/done）
      const id = d.step;
      if (!id) return;
      if (d.phase === 'start') {
        if (!steps[id]) {
          steps[id] = { id, label: d.label || id, status: 'running', t0: Date.now() };
          const div = document.createElement('div');
          div.className = 'cb-step';
          div.dataset.step = id;
          div.innerHTML = `<span class="cb-dot run"></span><span class="cb-label">${esc(steps[id].label)}</span><span class="cb-detail"></span><span class="cb-elapsed"></span>`;
          el.appendChild(div);
        }
      } else if (d.phase === 'done' && steps[id]) {
        steps[id].status = 'done';
        steps[id].elapsed_ms = d.elapsed_ms != null ? d.elapsed_ms : Date.now() - steps[id].t0;
        steps[id].count = d.count;
        const div = el.querySelector(`[data-step="${id}"]`);
        if (div) {
          div.querySelector('.cb-dot').className = 'cb-dot ok';
          const det = [];
          if (d.count != null) det.push(d.count + ' 条');
          if (steps[id].elapsed_ms != null) det.push((steps[id].elapsed_ms / 1000).toFixed(1) + 's');
          div.querySelector('.cb-detail').textContent = det.join(' · ');
        }
      }
      return;
    }
    if (d.type === 'agent_status') {
      const status = d.status || '';
      if (status === 'thinking') { _newUnit(); return; }
      if (status === 'user_stopped' || status === 'budget_exceeded') return;
      if (!curUnit) _newUnit();
      const label = agentStatusLabel(status, d);
      const detail = d.query || d.url || d.path || d.filename || d.expression || d.message || '';
      const isDone = status.endsWith('_done');
      if (isDone) {
        // 匹配最近的 running 工具
        const t = [...curUnit.tools].reverse().find(t => t.status === 'running');
        if (t) {
          t.status = 'done';
          const tEl = el.querySelector(`[data-tool="${t._tid}"]`);
          if (tEl) { tEl.querySelector('.cb-dot').className = 'cb-dot ok'; }
        }
      } else {
        const t = { status: 'running', label, detail, _tid: 't' + Math.random().toString(36).slice(2, 8) };
        curUnit.tools.push(t);
        const toolsEl = _unitEl(curUnit) && _unitEl(curUnit).querySelector('.cb-tools');
        if (toolsEl) {
          const div = document.createElement('div');
          div.className = 'cb-step';
          div.dataset.tool = t._tid;
          div.innerHTML = `<span class="cb-dot run"></span><span class="cb-label">${esc(label)}</span>`;
          toolsEl.appendChild(div);
        }
      }
      return;
    }
    if (d.type === 'agent_think') {
      const token = (d.content && d.content.content) || '';
      if (!token) return;
      if (!curUnit) _newUnit();
      curUnit.think += token;
      const uEl = _unitEl(curUnit);
      if (uEl) {
        const tEl = uEl.querySelector('.cb-think');
        tEl.style.display = '';
        tEl.textContent = curUnit.think;
      }
      return;
    }
    if (d.type === 'doc_loaded') {
      docLoaded.push({ name: d.name || d.filename || '', tokens: d.tokens || d.token_count || 0 });
      return;
    }
    if (d.type === 'agent_summary') {
      summaryData = { searches: d.searches || 0, fetches: d.fetches || 0, kb_hits: d.kb_hits || 0, docs: d.docs || 0 };
      return;
    }
    if (d.type === 'fetch_hint') { hintText = d.message || d.hint || ''; }
  }

  // 序列化为 card_data（与经典版 finalize 同构）
  function finalize() {
    const cardData = [];
    for (const id in steps) {
      const s = steps[id];
      cardData.push({ id, label: s.label, status: s.status === 'running' ? 'done' : s.status,
        elapsed_ms: s.elapsed_ms || null, count: s.count || null, channel: s.channel || null });
    }
    units.forEach((u, i) => {
      if (!u.tools.length && !u.think) return;
      cardData.push({
        id: '_reason_' + (i + 1), type: 'reason_unit', round: i + 1,
        elapsed_s: u.t0 ? Math.round((Date.now() - u.t0) / 100) / 10 : 0,
        think: u.think || '',
        tools: u.tools.map(t => ({ status: t.status === 'running' ? 'done' : t.status, label: t.label, detail: t.detail || '' })),
      });
    });
    if (docLoaded.length) cardData.push({ id: '_doc_loaded', type: 'doc_loaded', items: docLoaded });
    if (summaryData) cardData.push({ id: '_summary', type: 'summary', data: summaryData });
    if (hintText) cardData.push({ id: '_hint', type: 'hint', text: hintText });
    return cardData;
  }

  function reset() { el.innerHTML = ''; steps = {}; units = []; curUnit = null; docLoaded = []; summaryData = null; hintText = ''; }
  function isEmpty() { return !Object.keys(steps).length && !units.length && !docLoaded.length && !summaryData && !hintText; }

  return { el, handleEvent, finalize, reset, isEmpty };
}

// ============ 历史回放（读 card_data，与流式固化后同构） ============
export function renderCardHistory(m) {
  if (!m || !m.card_data || !m.card_data.length) return '';
  let html = '<div class="cb-area card-history">';
  for (const s of m.card_data) {
    if (s.type === 'reason_unit') {
      html += `<details class="cb-reason">
        <summary class="cb-reason-head"><span class="cb-chev">▸</span> 推理第 ${s.round} 轮
          ${s.elapsed_s ? `<span class="cb-elapsed">${s.elapsed_s}s</span>` : ''}</summary>
        <div class="cb-reason-body">
          ${s.think ? `<div class="cb-think">${esc(s.think)}</div>` : ''}
          <div class="cb-tools">${(s.tools || []).map(t =>
            `<div class="cb-step"><span class="cb-dot ${t.status === 'done' ? 'ok' : t.status === 'error' ? 'err' : 'wait'}"></span><span class="cb-label">${esc(t.label)}</span></div>`).join('')}</div>
        </div></details>`;
    } else if (s.type === 'doc_loaded') {
      html += `<div class="cb-doc">${icon('fileText')} 已加载文档 ${(s.items || []).map(i => esc(i.name || '')).join('、')}</div>`;
    } else if (s.type === 'summary') {
      const d2 = s.data || {};
      const parts = [];
      if (d2.searches) parts.push('搜索 ' + d2.searches + ' 次');
      if (d2.fetches) parts.push('阅读 ' + d2.fetches + ' 篇');
      if (d2.kb_hits) parts.push('知识库命中 ' + d2.kb_hits);
      if (d2.docs) parts.push('文档 ' + d2.docs);
      if (parts.length) html += `<div class="cb-sum">${icon('barChart')} ${parts.join(' · ')}</div>`;
    } else if (s.type === 'hint') {
      html += `<div class="cb-hint">${icon('bulb')} ${esc(s.text || '')}</div>`;
    } else {
      // 扁平步骤
      const det = [];
      if (s.count != null) det.push(s.count + ' 条');
      if (s.elapsed_ms != null) det.push((s.elapsed_ms / 1000).toFixed(1) + 's');
      html += `<div class="cb-step"><span class="cb-dot ${s.status === 'done' ? 'ok' : s.status === 'error' ? 'err' : 'wait'}"></span>
        <span class="cb-label">${esc(s.label || s.id || '')}</span>
        <span class="cb-detail">${det.join(' · ')}</span></div>`;
    }
  }
  return html + '</div>';
}

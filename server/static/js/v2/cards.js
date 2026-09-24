// 桌伴 0.10.2 新版 UI — 明盒卡片（思考可视化三层：L1 胶囊 / L2 台账 / L3 思考轮）
// 设计依据 docs/DESIGN-VIEWER-0102.md + prototypes/artifact-card-0102.html：
// 推理与动作分离（think 轮=推理折叠；agent_timeline 步骤=动作台账），
// 台账按阶段分组、连续同类折叠计数、耗时必标注；默认最省（胶囊），点击展开。
// 序列化格式与 card_data 完全兼容（与经典版 enrich 同一结构），历史回放共用。

import { icon, iconSvg } from './icons.js';

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
  if (status === 'session_reading') return '读取历史会话：' + (d.name || '');
  if (status === 'session_read') return '已读历史会话：' + (d.name || '');
  if (status === 'project_writing') return '写入项目文件：' + (d.path || '');
  if (status === 'project_write') return (d.planned ? '计划登记：' : '已写入：') + (d.name || '') + (d.overwrite ? '（覆盖，已备份）' : '');
  if (status === 'exec_mode_switching') return '切换写入模式…';
  if (status === 'exec_mode_switch') return '已切到' + (d.action === 'execute' ? '执行模式' : '计划模式');
  if (status === 'goal_setting') return '记录任务目标…';
  if (status === 'goal_set') return '任务目标：' + (d.query || '');
  if (status === 'plan_discarding') return '清空待执行计划…';
  if (status === 'plan_discard') return '已清空 ' + (d.count || 0) + ' 条待执行计划';
  if (status === 'proj_kb_searching') return '检索项目知识库：' + (d.query || '');
  if (status === 'proj_kb') return '项目知识库命中 ' + (d.count || 0) + ' 段';
  if (status === 'deliver_packing') return '打包成果包…';
  if (status === 'deliver_pack') return '成果包已生成：' + (d.name || '') + '（' + (d.count || 0) + ' 个文件）';
  if (status === 'ppt') {  // ppt_done 经 _done 后缀剥离到这里
    if (d.action === 'begin') return 'PPT 开题：' + (d.title || '');
    if (d.action === 'page') return '第 ' + (d.page || '?') + ' 页设计完成';
    if (d.action === 'build') return 'PPT 已生成：' + (d.pptx_name || '');
    return 'PPT 完成';
  }
  if (status.indexOf('_done') > 0) return agentStatusLabel(status.replace('_done', ''), d);
  return String(status).replace(/_/g, ' ');
}

// ---- 阶段归类（L2 台账分组）----
const _PHASE_TITLES = { retrieve: '检索与阅读', produce: '生成产物', other: '其他动作' };
function _phaseOf(label) {
  if (/搜索|阅读|检索|深读|读取|列出|时间/.test(label)) return 'retrieve';
  if (/PPT|文档|写入|打包|计算|转换|表格|编排|项目|生成|设计|编译/.test(label)) return 'produce';
  return 'other';
}
function _isFail(label) { return /失败|受限|异常|不安全|不存在/.test(label); }

// 胶囊（L1）文案聚合
function _pillText(cnt, runningLabel) {
  const parts = [];
  if (cnt.searches) parts.push('搜索 ' + cnt.searches + ' 次');
  if (cnt.fetches) parts.push('阅读 ' + cnt.fetches + ' 篇');
  if (cnt.kb) parts.push('知识库命中 ' + cnt.kb);
  if (!parts.length && cnt.steps) parts.push(cnt.steps + ' 个步骤');
  if (cnt.rounds) parts.push(cnt.rounds + ' 轮思考');
  if (!parts.length) parts.push(runningLabel || '思考中');
  return parts.join(' · ');
}

// ============ 流式卡片容器（L1 胶囊 + L2 台账 + L3 思考轮） ============
export function createCardArea() {
  const el = document.createElement('div');
  el.className = 'cb-area think-wrap';

  let steps = {};        // 扁平步骤（agent_timeline：step id → item）
  let units = [];        // 推理轮次（在线 agent）
  let curUnit = null;
  let docLoaded = [];
  let summaryData = null;
  let hintText = '';

  // L1/L2 骨架
  let pill, ledger, _curPhase = null, _phaseEl = null, _phaseSum = { retrieve: 0, produce: 0, other: 0 };
  let _t0 = null, _cnt = { searches: 0, fetches: 0, kb: 0, steps: 0, rounds: 0 };

  function _skeleton() {
    _curPhase = null; _phaseEl = null; _phaseSum = { retrieve: 0, produce: 0, other: 0 };
    el.innerHTML =
      '<button class="think-sum open" type="button">' +
      '<span class="ts-dot run"></span><span class="ts-tx">准备中…</span>' +
      '<span class="ts-ms"></span>' +
      '<span class="ic ts-chev"><svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg></span>' +
      '</button>' +
      '<div class="think-ledger open"></div>';
    pill = el.querySelector('.think-sum');
    ledger = el.querySelector('.think-ledger');
    pill.addEventListener('click', () => {
      pill.classList.toggle('open');
      ledger.classList.toggle('open');
    });
  }
  _skeleton();

  function _setPill(running, label) {
    if (!pill) return;
    pill.querySelector('.ts-dot').className = 'ts-dot' + (running ? ' run' : '');
    pill.querySelector('.ts-tx').textContent = running ? (label || '进行中') + '…' : _pillText(_cnt);
    const secs = _t0 ? Math.round((Date.now() - _t0) / 100) / 10 : 0;
    pill.querySelector('.ts-ms').textContent = secs ? secs + 's' : '';
  }

  function _newPhaseHeader(phase) {
    const div = document.createElement('div');
    div.className = 'tr-phase';
    div.innerHTML = '<span class="chev">▾</span>' + _PHASE_TITLES[phase] + '<span class="tt"></span>';
    ledger.appendChild(div);
    return div;
  }

  // 步骤行落在台账（含阶段分组与连续同类折叠）
  function _appendStepRow(dotClass, label, count, elapsedMs) {
    const phase = _phaseOf(label);
    if (phase !== _curPhase) { _curPhase = phase; _phaseEl = _newPhaseHeader(phase); }
    // 连续同类折叠：与上一行同标签则合并计数
    const prev = ledger.querySelector('.tr-step:last-child');
    if (prev && prev.dataset.label === label && prev.classList.contains('folds')) {
      const n = (parseInt(prev.dataset.n || '1', 10) || 1) + (count || 1);
      prev.dataset.n = String(n);
      prev.querySelector('.nm').innerHTML = esc(label) + ' <span class="cnt">×' + n + '</span>';
      if (elapsedMs != null) {
        prev.dataset.ms = String((parseFloat(prev.dataset.ms || '0') || 0) + elapsedMs);
        prev.querySelector('.ms').textContent = (parseFloat(prev.dataset.ms) / 1000).toFixed(1) + 's';
      }
      _phaseSum[phase] += elapsedMs || 0;
      return prev;
    }
    const div = document.createElement('div');
    div.className = 'tr-step folds';
    div.dataset.label = label;
    div.dataset.n = String(count || 1);
    if (elapsedMs != null) div.dataset.ms = String(elapsedMs);
    div.innerHTML =
      '<span class="dt ' + dotClass + '"></span>' +
      '<span class="nm">' + esc(label) + (count && count > 1 ? ' <span class="cnt">×' + count + '</span>' : '') + '</span>' +
      '<span class="ms">' + (elapsedMs != null ? (elapsedMs / 1000).toFixed(1) + 's' : '') + '</span>';
    ledger.appendChild(div);
    _phaseSum[phase] += elapsedMs || 0;
    return div;
  }
  function _refreshPhaseSums() {
    if (!_phaseEl || !_phaseEl.classList.contains('tr-phase')) return;
    // 各阶段小计写回组头（找当前阶段的组头）
    const heads = ledger.querySelectorAll('.tr-phase');
    const idx = ['retrieve', 'produce', 'other'];
    heads.forEach((h, i) => {
      const key = idx[i] || 'other';
      if (_phaseSum[key]) h.querySelector('.tt').textContent = (_phaseSum[key] / 1000).toFixed(1) + 's';
    });
  }

  function _unitEl(u) { return ledger.querySelector(`[data-unit="${u.round}"]`); }

  function _newUnit() {
    // 闭合当前轮（有内容才闭合）
    if (curUnit && (curUnit.tools.length || curUnit.think)) {
      const u = curUnit;
      const uEl = _unitEl(u);
      if (uEl) {
        uEl.classList.add('closed');
        uEl.removeAttribute('open');
        uEl.querySelector('.cb-reason-head .cb-elapsed').textContent = '';
      }
    }
    curUnit = { round: units.length + 1, think: '', tools: [], t0: Date.now() };
    units.push(curUnit);
    _cnt.rounds = units.length;
    const div = document.createElement('details');
    div.className = 'cb-reason';
    div.setAttribute('open', '');
    div.dataset.unit = curUnit.round;
    div.innerHTML = `
      <summary class="cb-reason-head"><span class="cb-chev">▸</span> 思考 ${['①','②','③','④','⑤','⑥','⑦','⑧'][curUnit.round - 1] || curUnit.round}
        <span class="cb-elapsed"></span></summary>
      <div class="cb-reason-body"><div class="cb-think" style="display:none"></div><div class="cb-tools"></div></div>`;
    ledger.appendChild(div);
    _curPhase = null;  // 思考轮插在台账尾部，打断阶段连续性（下一步骤重新起组头）
    _phaseEl = null;
  }

  function handleEvent(d) {
    if (!_t0) _t0 = Date.now();
    if (d.type === 'agent_timeline') {
      // 扁平步骤（local/parallel 的 Step 协议：start/done）
      const id = d.step;
      if (!id) return;
      if (d.phase === 'start') {
        if (!steps[id]) {
          steps[id] = { id, label: d.label || id, status: 'running', t0: Date.now() };
          _cnt.steps++;
          steps[id]._row = _appendStepRow('run', steps[id].label, null, null);
          _setPill(true, steps[id].label);
        }
      } else if (d.phase === 'done' && steps[id]) {
        steps[id].status = 'done';
        steps[id].elapsed_ms = d.elapsed_ms != null ? d.elapsed_ms : Date.now() - steps[id].t0;
        steps[id].count = d.count;
        const row = steps[id]._row || ledger.querySelector(`[data-step="${id}"]`);
        if (row) {
          row.querySelector('.dt').className = 'dt ok';
          if (d.count != null && d.count > 1) {
            row.dataset.n = String(d.count);
            row.querySelector('.nm').innerHTML = esc(steps[id].label) + ' <span class="cnt">×' + d.count + '</span>';
          }
          if (steps[id].elapsed_ms != null) {
            row.dataset.ms = String(steps[id].elapsed_ms);
            row.querySelector('.ms').textContent = (steps[id].elapsed_ms / 1000).toFixed(1) + 's';
          }
        }
        _refreshPhaseSums();
        _setPill(true, steps[id].label);
      }
      return;
    }
    if (d.type === 'agent_status') {
      const status = d.status || '';
      if (status === 'thinking') { _newUnit(); _setPill(true, '思考中'); return; }
      if (status === 'user_stopped' || status === 'budget_exceeded') return;
      if (!curUnit) _newUnit();
      const label = agentStatusLabel(status, d);
      const detail = d.query || d.url || d.path || d.filename || d.expression || d.message || '';
      const isDone = status.endsWith('_done');
      if (isDone) {
        // 计数聚合（L1 文案来源）
        if (status === 'search_done') _cnt.searches++;
        if (status === 'fetch_done') _cnt.fetches++;
        if (status === 'kb_done' || status === 'proj_kb') _cnt.kb++;
        // 匹配最近的 running 工具行（先在当前思考轮内找，找不到查台账尾部）
        const t = [...curUnit.tools].reverse().find(t => t.status === 'running');
        if (t) {
          t.status = 'done';
          if (t._row) t._row.querySelector('.dt').className = 'dt ok';
        } else if (detail && !_isFail(label)) {
          _appendStepRow(_isFail(label) ? 'fail' : 'ok', label, d.count || null, d.elapsed_ms != null ? d.elapsed_ms : null);
        }
      } else {
        const t = { status: 'running', label, detail, _tid: 't' + Math.random().toString(36).slice(2, 8) };
        curUnit.tools.push(t);
        const toolsEl = _unitEl(curUnit) && _unitEl(curUnit).querySelector('.cb-tools');
        if (toolsEl) {
          const div = document.createElement('div');
          div.className = 'tr-step';
          div.dataset.tool = t._tid;
          div.innerHTML = `<span class="dt run"></span><span class="nm">${esc(label)}</span><span class="ms"></span>`;
          toolsEl.appendChild(div);
          t._row = div;
        } else {
          t._row = _appendStepRow('run', label, null, null);
        }
      }
      _setPill(true, label);
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
    // L1 胶囊收口：结束态文案 + 台账自动折叠
    if (summaryData) {
      _cnt.searches = summaryData.searches || _cnt.searches;
      _cnt.fetches = summaryData.fetches || _cnt.fetches;
      _cnt.kb = summaryData.kb_hits || _cnt.kb;
    }
    _setPill(false);
    if (pill) pill.classList.remove('open');
    if (ledger) ledger.classList.remove('open');
    return cardData;
  }

  function reset() { _skeleton(); steps = {}; units = []; curUnit = null; docLoaded = []; summaryData = null; hintText = ''; _t0 = null; _cnt = { searches: 0, fetches: 0, kb: 0, steps: 0, rounds: 0 }; }
  function isEmpty() { return !Object.keys(steps).length && !units.length && !docLoaded.length && !summaryData && !hintText; }

  return { el, handleEvent, finalize, reset, isEmpty };
}

// ============ 历史回放（读 card_data，与流式固化后同构；默认折叠台账） ============
export function renderCardHistory(m) {
  if (!m) return '';
  // 0.10.2 兼容：老消息无 card_data，只有 agent_timeline/agent_summary 落库字段——现场合成
  if ((!m.card_data || !m.card_data.length) && Array.isArray(m.agent_timeline) && m.agent_timeline.length) {
    m = Object.assign({}, m, {
      card_data: m.agent_timeline.map((it, i) => ({
        id: 'tl' + i,
        label: agentStatusLabel(String(it.status || '').replace(/_done$/, ''), it),
        status: it.status || '',
        elapsed_ms: it.elapsed_ms != null ? it.elapsed_ms : null,
        count: it.count != null ? it.count : null,
      })),
    });
    if (m.agent_summary) m.card_data.push({ id: '_summary', type: 'summary', data: m.agent_summary });
  }
  if (!m.card_data || !m.card_data.length) return '';
  const cnt = { searches: 0, fetches: 0, kb: 0, steps: 0, rounds: 0 };
  let totalMs = 0;
  let inner = '';
  const phaseSums = { retrieve: 0, produce: 0, other: 0 };
  const flatSteps = [];
  const reasonUnits = [];
  const tails = [];
  for (const s of m.card_data) {
    if (s.type === 'reason_unit') reasonUnits.push(s);
    else if (s.type) tails.push(s);
    else flatSteps.push(s);
  }
  // 扁平步骤 → 阶段分组行（连续同类折叠）：先折叠成数据，再一次成串
  const rows = [];
  for (const st of flatSteps) {
    const label = st.label || st.id || '';
    cnt.steps++;
    if (st.elapsed_ms) totalMs += st.elapsed_ms;
    if (st.status === 'search_done') cnt.searches++;
    if (st.status === 'fetch_done') cnt.fetches++;
    if (st.status === 'kb_done' || st.status === 'proj_kb') cnt.kb++;
    const fail = st.status === 'error' || _isFail(label);
    const prev = rows[rows.length - 1];
    if (!fail && prev && prev.label === label && !prev.fail) {
      prev.n += (st.count && st.count > 1 ? st.count : 1);
      prev.ms += st.elapsed_ms || 0;
      continue;
    }
    rows.push({ label, fail, n: (st.count && st.count > 1 ? st.count : 1), ms: st.elapsed_ms || 0 });
  }
  let curPhase = null;
  for (const r of rows) {
    const phase = _phaseOf(r.label);
    phaseSums[phase] += r.ms;
    if (phase !== curPhase) {
      curPhase = phase;
      inner += `<div class="tr-phase"><span class="chev">▾</span>${_PHASE_TITLES[phase]}<span class="tt"></span></div>`;
    }
    inner += `<div class="tr-step"><span class="dt ${r.fail ? 'fail' : 'ok'}"></span><span class="nm">${esc(r.label)}${r.n > 1 ? ' <span class="cnt">×' + r.n + '</span>' : ''}</span><span class="ms">${r.ms ? (r.ms / 1000).toFixed(1) + 's' : ''}</span></div>`;
  }
  // 阶段小计回写组头
  inner = inner.replace(/(<div class="tr-phase"><span class="chev">▾<\/span>)(检索与阅读|生成产物|其他动作)/g, (all, head, title) => {
    const key = { '检索与阅读': 'retrieve', '生成产物': 'produce', '其他动作': 'other' }[title];
    const sum = phaseSums[key] ? (phaseSums[key] / 1000).toFixed(1) + 's' : '';
    return head + title + (sum ? '<span class="tt">' + sum + '</span>' : '');
  });

  // 思考轮（L3）：紧跟其后
  reasonUnits.forEach((u) => {
    cnt.rounds++;
    if (u.elapsed_s) totalMs += u.elapsed_s * 1000;
    inner += `<details class="cb-reason">
      <summary class="cb-reason-head"><span class="cb-chev">▸</span> 思考 ${['①','②','③','④','⑤','⑥','⑦','⑧'][u.round - 1] || u.round}
        ${u.elapsed_s ? `<span class="cb-elapsed">${u.elapsed_s}s</span>` : ''}</summary>
      <div class="cb-reason-body">
        ${u.think ? `<div class="cb-think">${esc(u.think)}</div>` : ''}
        <div class="cb-tools">${(u.tools || []).map(t =>
          `<div class="tr-step"><span class="dt ${t.status === 'done' ? 'ok' : _isFail(t.label) ? 'fail' : 'wait'}"></span><span class="nm">${esc(t.label)}</span><span class="ms"></span></div>`).join('')}</div>
      </div></details>`;
  });
  for (const s of tails) {
    if (s.type === 'doc_loaded') {
      inner += `<div class="cb-doc">${icon('fileText')} 已加载文档 ${(s.items || []).map(i => esc(i.name || '')).join('、')}</div>`;
    } else if (s.type === 'summary') {
      const d2 = s.data || {};
      if (d2.searches) cnt.searches = d2.searches;
      if (d2.fetches) cnt.fetches = d2.fetches;
      if (d2.kb_hits) cnt.kb = d2.kb_hits;
    } else if (s.type === 'hint') {
      inner += `<div class="cb-hint">${icon('bulb')} ${esc(s.text || '')}</div>`;
    }
  }
  const pillTx = _pillText(cnt);
  const secs = totalMs ? (totalMs / 1000).toFixed(1).replace(/\.0$/, '') + 's' : '';
  return `<div class="cb-area think-wrap">
    <button class="think-sum" type="button"><span class="ts-dot"></span><span class="ts-tx">${esc(pillTx)}</span><span class="ts-ms">${secs}</span><span class="ic ts-chev"><svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg></span></button>
    <div class="think-ledger">${inner}</div>
  </div>`;
}

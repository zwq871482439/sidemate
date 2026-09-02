// 桌伴 0.10.1 新版 UI — 设置（M1-D 设置迁入增量 1）
// 壳：左竖导航 + 右内容区（PLAN 结构）。常规子页全真功能（界面版本/模型与设备/
// 数据维护/备份恢复）；其余子页占位 + 经典版直达，逐页迁入。
// 深色模式：DNA-01 深色主题在 M1 后段实装，新版暂只浅色（行内说明，不做半吊子）。

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const SUBPAGES = [
  { id: 'general', label: '常规' },
  { id: 'cloud', label: '在线 AI' },
  { id: 'kb', label: '知识库' },
  { id: 'privacy', label: '隐私安全' },
  { id: 'download', label: '模型下载' },
  { id: 'env', label: '环境检查' },
  { id: 'about', label: '关于' },
];

export function createSettingsView(events) {
  // events: { onGoClassic() }
  const el = document.createElement('div');
  el.className = 'set-wrap';
  let cur = 'general';

  async function render() {
    el.innerHTML = `
      <div class="set-layout">
        <div class="set-nav">
          ${SUBPAGES.map(p => `<button data-p="${p.id}" class="${cur === p.id ? 'on' : ''}">${p.label}</button>`).join('')}
        </div>
        <div class="set-body" id="setBody"></div>
      </div>`;
    el.querySelectorAll('.set-nav button').forEach(b =>
      b.addEventListener('click', () => { cur = b.dataset.p; render(); }));
    const body = el.querySelector('#setBody');
    if (cur === 'general') await renderGeneral(body);
    else if (cur === 'cloud') await renderCloud(body);
    else if (cur === 'kb') await renderKbSettings(body);
    else if (cur === 'privacy') await renderPrivacy(body);
    else if (cur === 'about') await renderAbout(body);
    else renderWip(body, SUBPAGES.find(p => p.id === cur).label);
  }

  function renderWip(body, label) {
    body.innerHTML = `
      <div class="wip-wrap" style="margin:40px auto">
        <div class="w-ic">◌</div>
        <h2>${label} · 迁移中</h2>
        <p>此子页正在迁入新版。现在请先在 <a href="/">经典版界面</a> 使用，两边数据完全互通。</p>
      </div>`;
  }

  // ============ 常规子页 ============
  async function renderGeneral(body) {
    body.innerHTML = '<div class="kb-loading" style="padding:30px">加载中…</div>';
    const [mode, status, budget, devices] = await Promise.all([
      fetch('/api/mode').then(r => r.json()).catch(() => ({})),
      fetch('/api/status').then(r => r.json()).catch(() => ({})),
      fetch('/api/token-budget').then(r => r.json()).catch(() => ({})),
      fetch('/api/devices').then(r => r.json()).catch(() => ({})),
    ]);
    const loadedModel = Object.keys(status).find(k => status[k] && status[k].type === 'llm' && status[k].loaded);
    const modelDesc = loadedModel ? `${status[loadedModel].description || loadedModel}（${loadedModel}）` : '未加载';
    const devList = (devices.devices || []).map(d => typeof d === 'string'
      ? { id: d, label: d === 'gpu' ? 'GPU（Vulkan）— 有独显时推荐，速度快' : 'CPU — 兼容性好，速度慢' }
      : d);
    const curDev = devices.current || '';

    body.innerHTML = `
      <div class="set-group">
        <h2>外观与状态</h2>
        <div class="sub">界面版本、当前模型与推理设备</div>
        <div class="set-row"><div class="stx"><b>界面版本</b><p>0.10.1 新版三栏界面（预览中），与经典版数据完全互通，随时可切回</p></div>
          <button class="kb-tool-btn" id="setGoClassic">回经典版</button></div>
        <div class="set-row"><div class="stx"><b>深色模式</b><p>新版深色主题在后续版本实装（DNA-01 深色档）；需要深色请用经典版</p></div>
          <span style="font-size:11.5px;color:var(--d1-ink-3)">暂不可用</span></div>
        <div class="set-row"><div class="stx"><b>当前模型</b><p id="setModel">${esc(modelDesc)}</p></div></div>
        <div class="set-row"><div class="stx"><b>上下文窗口</b><p>最大输入 ${(mode.context_window || 0) / 1000 | 0}K tokens · 最大输出 ${(budget.max_output_tokens || 0) / 1000 | 0}K tokens</p></div></div>
        <div class="set-row"><div class="stx"><b>推理设备</b><p>切换后自动重启模型加载。知识库模型不受影响（固定 CPU 运行）</p></div>
          <select class="set-input" id="setDevice" style="width:auto">
            ${devList.map(d => `<option value="${esc(d.id)}" ${d.id === curDev ? 'selected' : ''}>${esc(d.label || d.id)}</option>`).join('')}
          </select></div>
      </div>
      <div class="set-group">
        <h2>数据维护</h2>
        <div class="sub">查看和清理上传的文件缓存、录音文件等</div>
        <div class="set-row"><div class="stx"><b>缓存文件</b><p id="cacheInfo">点击刷新查看缓存文件</p></div>
          <span style="display:flex;gap:6px">
            <button class="kb-tool-btn" id="cacheRefresh">刷新</button>
            <button class="kb-tool-btn" id="cacheClear">清空全部</button>
          </span></div>
        <div id="cacheList"></div>
      </div>
      <div class="set-group">
        <h2>备份与恢复</h2>
        <div class="sub">导出所有对话、设置和知识库元数据到 ZIP 文件</div>
        <div class="set-row"><div class="stx"><b>导出备份</b><p id="backupHint">含对话记录、设置、知识库元数据</p></div>
          <button class="kb-tool-btn" id="backupExport">导出备份</button></div>
        <div class="set-row"><div class="stx"><b>恢复</b><p>从 ZIP 备份恢复（覆盖现有数据，谨慎操作）</p></div>
          <span style="display:flex;gap:6px;align-items:center">
            <input type="file" id="backupFile" accept=".zip" style="font-size:11.5px;max-width:180px">
            <button class="kb-tool-btn" id="backupImport">恢复</button>
          </span></div>
      </div>`;

    body.querySelector('#setGoClassic').addEventListener('click', () => events.onGoClassic());

    // 推理设备切换
    body.querySelector('#setDevice').addEventListener('change', async (e) => {
      e.target.disabled = true;
      await fetch('/api/device/switch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: e.target.value }),
      }).catch(() => {});
      e.target.disabled = false;
    });

    // 缓存文件
    async function refreshCache() {
      const list = body.querySelector('#cacheList');
      const info = body.querySelector('#cacheInfo');
      const r = await fetch('/api/cache/files').then(r => r.json()).catch(() => null);
      if (!r) { info.textContent = '读取失败'; return; }
      const files = r.files || [];
      info.textContent = files.length ? `${files.length} 个文件` : '缓存为空';
      list.innerHTML = files.length ? files.map(f => `
        <div class="set-row" style="padding:8px 0"><div class="stx"><b style="font-weight:400;font-size:12px">${esc(f.name || f.filename || '')}</b>
          <p>${f.size_kb || Math.round((f.size || 0) / 1024) + 'KB'}${f.modified ? ' · ' + esc(String(f.modified).slice(0, 16)) : ''}</p></div>
          <button class="kb-tool-btn cache-del" data-n="${esc(f.name || f.filename || '')}">删除</button></div>`).join('') : '';
      list.querySelectorAll('.cache-del').forEach(b => b.addEventListener('click', async () => {
        await fetch('/api/cache/files/' + encodeURIComponent(b.dataset.n), { method: 'DELETE' }).catch(() => {});
        refreshCache();
      }));
    }
    body.querySelector('#cacheRefresh').addEventListener('click', refreshCache);
    body.querySelector('#cacheClear').addEventListener('click', async () => {
      if (!confirm('清空全部缓存文件？')) return;
      await fetch('/api/cache/files', { method: 'DELETE' }).catch(() => {});
      refreshCache();
    });

    // 备份/恢复
    body.querySelector('#backupExport').addEventListener('click', async (e) => {
      const btn = e.target; btn.disabled = true; btn.textContent = '导出中…';
      try {
        const r = await fetch('/api/backup/export', { method: 'POST' });
        const d = await r.json();
        if (d && (d.url || d.path || d.download_url)) {
          const u = d.url || d.download_url || d.path;
          const a = document.createElement('a');
          a.href = u; a.download = '';
          document.body.appendChild(a); a.click(); a.remove();
          body.querySelector('#backupHint').textContent = '已导出';
        } else {
          body.querySelector('#backupHint').textContent = d.ok === false ? ('失败：' + (d.error || '')) : '已导出';
        }
      } catch (err) {
        body.querySelector('#backupHint').textContent = '导出失败：' + err.message;
      }
      btn.disabled = false; btn.textContent = '导出备份';
    });
    body.querySelector('#backupImport').addEventListener('click', async () => {
      const fi = body.querySelector('#backupFile');
      if (!fi.files || !fi.files[0]) { alert('请先选择备份 ZIP 文件'); return; }
      if (!confirm('恢复备份会覆盖现有数据，确定继续？')) return;
      const fd = new FormData();
      fd.append('file', fi.files[0]);
      const r = await fetch('/api/backup/import', { method: 'POST', body: fd }).then(r => r.json()).catch(() => null);
      alert(r && r.ok !== false ? '恢复完成，建议重启应用' : ('恢复失败：' + ((r && r.error) || '未知错误')));
    });
  }

  // ============ 在线 AI 子页 ============
  async function renderCloud(body) {
    body.innerHTML = '<div class="kb-loading" style="padding:30px">加载中…</div>';
    const [cfg, all] = await Promise.all([
      fetch('/api/cloud/config').then(r => r.json()).catch(() => ({})),
      fetch('/api/config').then(r => r.json()).catch(() => ({})),
    ]);
    const gcfg = (all && all.config) || {};
    const parallelOn = !!gcfg.parallel_enabled;
    const curMode = (gcfg.ai_mode || 'local');
    const rounds = gcfg.agent_max_rounds || '';

    body.innerHTML = `
      <div class="set-group">
        <h2>在线 AI 配置</h2>
        <div class="sub">云端 API 服务配置（支持 OpenAI / Anthropic 及兼容服务）</div>
        <div class="set-row"><div class="stx"><b>API 地址</b><p>兼容 OpenAI 协议的接口地址</p></div>
          <input class="set-input" style="width:260px" id="cfBase" value="${esc(cfg.base_url || '')}" placeholder="https://api.openai.com/v1"></div>
        <div class="set-row"><div class="stx"><b>API Key</b><p>${cfg.api_key_set ? '已配置 ' + esc(cfg.api_key_preview || '') + '（留空保持不变）' : '未配置'}</p></div>
          <input class="set-input" style="width:260px" id="cfKey" type="password" placeholder="sk-..." autocomplete="new-password"></div>
        <div class="set-row"><div class="stx"><b>模型</b><p>当前：${esc(cfg.model || '')}${cfg.context_matched ? '' : '（非内置已知模型，能力用默认档）'}</p></div>
          <input class="set-input" style="width:200px" id="cfModel" value="${esc(cfg.model || '')}"></div>
        <div class="set-row"><div class="stx"><b>协议格式</b></div>
          <select class="set-input" id="cfFmt" style="width:120px">
            <option value="openai" ${cfg.api_format !== 'anthropic' ? 'selected' : ''}>OpenAI</option>
            <option value="anthropic" ${cfg.api_format === 'anthropic' ? 'selected' : ''}>Anthropic</option>
          </select></div>
        <div class="set-row"><div class="stx"><b>代理模式</b><p>system=跟随系统代理，direct=直连</p></div>
          <select class="set-input" id="cfProxy" style="width:120px">
            <option value="system" ${cfg.proxy_mode !== 'direct' ? 'selected' : ''}>跟随系统</option>
            <option value="direct" ${cfg.proxy_mode === 'direct' ? 'selected' : ''}>直连</option>
          </select></div>
        <div class="set-row"><div class="stx"><b>输入上限（tokens）</b><p>0 = 按模型自动匹配（当前生效 ${Math.round((cfg.context_window || 0) / 1000)}K）</p></div>
          <input class="set-input" id="cfCtx" type="number" min="0" max="2097152" value="${cfg.context_window_user || 0}"></div>
        <div class="set-row"><div class="stx"><b>上下文策略</b><p>full=完整历史 / current_only=仅当前轮 / slim_history=保留最近 N 轮</p></div>
          <select class="set-input" id="cfPolicy" style="width:150px">
            <option value="full" ${cfg.context_policy === 'full' ? 'selected' : ''}>完整历史</option>
            <option value="current_only" ${cfg.context_policy === 'current_only' ? 'selected' : ''}>仅当前轮</option>
            <option value="slim_history" ${cfg.context_policy === 'slim_history' ? 'selected' : ''}>保留最近 N 轮</option>
          </select></div>
        <div class="set-row"><div class="stx"><b>精简历史轮数</b><p>context_policy=保留最近 N 轮时生效（1-50）</p></div>
          <input class="set-input" id="cfSlim" type="number" min="1" max="50" value="${cfg.slim_history_rounds || 6}"></div>
        <div class="set-row"><div class="stx"><b>知识库权限</b><p>云端 AI 访问知识库的范围</p></div>
          <select class="set-input" id="cfKbPerm" style="width:150px">
            <option value="full" ${cfg.kb_permission === 'full' ? 'selected' : ''}>完整（可读全文）</option>
            <option value="search-only" ${cfg.kb_permission === 'search-only' ? 'selected' : ''}>仅检索命中</option>
            <option value="disabled" ${cfg.kb_permission === 'disabled' ? 'selected' : ''}>禁用</option>
          </select></div>
        <div class="set-row" style="border-top:1px solid var(--d1-paper-2)">
          <div class="stx"></div>
          <span style="display:flex;gap:8px">
            <button class="kb-tool-btn" id="cfTest">测试连接</button>
            <button class="btn-primary-v2" id="cfSave">保存配置</button>
          </span></div>
        <div class="set-note" id="cfNote" style="display:none"></div>
      </div>
      <div class="set-group">
        <h2>能力配置</h2>
        <div class="sub">在线模式的能力开关与预算</div>
        <div class="set-row"><div class="stx"><b>并行模式 <span class="exp-tag" style="font-size:9.5px;color:var(--d1-gold-2);border:1px solid rgba(232,181,77,.4);border-radius:6px;padding:1px 6px">实验性</span></b>
          <p>同时用本地+在线引擎对知识库开展问答（本地生成关键词/摘要，云端撰写正文）。开启后左栏出现第三档「并行」</p></div>
          <button class="switch ${parallelOn ? 'on' : ''}" id="cfParallel"></button></div>
        <div class="set-row"><div class="stx"><b>Agent 轮次预算</b><p>在线 Agent 单次任务的最大工具调用轮次（8~100，留空=默认 26；Claude 类强模型建议 40+）</p></div>
          <input class="set-input" id="cfRounds" type="number" min="8" max="100" placeholder="26" value="${rounds}"></div>
        <div class="set-row"><div class="stx"><b>知识对比（实验）</b><p>KB 问答时本地与云端结果对比展示</p></div>
          <button class="switch ${cfg.kb_compare_enabled ? 'on' : ''}" id="cfCompare"></button></div>
      </div>`;

    const note = (msg, ok) => {
      const n = body.querySelector('#cfNote');
      n.style.display = '';
      n.style.color = ok ? 'var(--pal-green-2)' : 'var(--pal-danger)';
      n.textContent = msg;
    };

    // 保存
    body.querySelector('#cfSave').addEventListener('click', async () => {
      const payload = {
        base_url: body.querySelector('#cfBase').value.trim(),
        model: body.querySelector('#cfModel').value.trim(),
        api_format: body.querySelector('#cfFmt').value,
        proxy_mode: body.querySelector('#cfProxy').value,
        context_window: parseInt(body.querySelector('#cfCtx').value || '0', 10),
        context_policy: body.querySelector('#cfPolicy').value,
        slim_history_rounds: parseInt(body.querySelector('#cfSlim').value || '6', 10),
        kb_permission: body.querySelector('#cfKbPerm').value,
      };
      const key = body.querySelector('#cfKey').value.trim();
      if (key) payload.api_key = key;
      const r = await fetch('/api/cloud/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(r => r.json()).catch(() => null);
      note(r && r.ok ? '已保存，云端引擎已用新配置重建' : ('保存失败：' + ((r && r.error) || '未知错误')), !!(r && r.ok));
    });

    // 测试连接
    body.querySelector('#cfTest').addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = '测试中…';
      const r = await fetch('/api/cloud/test', { method: 'POST' }).then(r => r.json()).catch(() => null);
      note(r && r.ok ? '连接成功：' + (r.message || r.model || 'OK') : ('连接失败：' + ((r && (r.error || r.message)) || '未知错误')), !!(r && r.ok));
      e.target.disabled = false; e.target.textContent = '测试连接';
    });

    // 并行实验开关（存量迁移 + 关闭回退，PLAN 五点七-3）
    body.querySelector('#cfParallel').addEventListener('click', async (e) => {
      const on = !e.target.classList.contains('on');
      await fetch('/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parallel_enabled: on }),
      });
      e.target.classList.toggle('on', on);
      // 关闭回退：当前在并行 → 回落在线
      if (!on && curMode === 'parallel') {
        await fetch('/api/mode/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'cloud' }) });
      }
      note(on ? '并行模式已开启，左栏出现第三档' : '并行模式已关闭' + (curMode === 'parallel' ? '，已回落在线模式' : ''), true);
    });

    // 存量迁移：当前模式=并行且开关未点亮 → 自动点亮（升级用户模式不消失）
    if (curMode === 'parallel' && !parallelOn) {
      fetch('/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parallel_enabled: true }),
      }).then(() => { body.querySelector('#cfParallel').classList.add('on'); });
    }

    // 轮次预算（失焦保存；留空=删 key 回落默认）
    body.querySelector('#cfRounds').addEventListener('change', async (e) => {
      const v = e.target.value.trim();
      const payload = {};
      if (v === '') payload.agent_max_rounds = 0;  // 0/非法 → 后端回落默认 26
      else payload.agent_max_rounds = Math.min(100, Math.max(8, parseInt(v, 10) || 0));
      await fetch('/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      note('轮次预算已保存', true);
    });

    // 知识对比开关
    body.querySelector('#cfCompare').addEventListener('click', async (e) => {
      const on = !e.target.classList.contains('on');
      await fetch('/api/cloud/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kb_compare_enabled: on }),
      });
      e.target.classList.toggle('on', on);
    });
  }

  // ============ 知识库子页 ============
  async function renderKbSettings(body) {
    body.innerHTML = '<div class="kb-loading" style="padding:30px">加载中…</div>';
    const [stats, docs, audit, all] = await Promise.all([
      fetch('/api/kb/stats').then(r => r.json()).catch(() => ({})),
      fetch('/api/kb/documents').then(r => r.json()).catch(() => []),
      fetch('/api/kb/audit_log/stats').then(r => r.json()).catch(() => ({})),
      fetch('/api/config').then(r => r.json()).catch(() => ({})),
    ]);
    const cfg = (all && all.config) || {};
    const ready = docs.filter(d => d.status === 'ready').length;
    const processing = docs.filter(d => ['pending', 'processing', 'indexing'].includes(d.status)).length;
    const errored = docs.filter(d => ['error', 'conflict'].includes(d.status)).length;
    const idleMin = Math.max(1, Math.round((cfg.reranker_idle_timeout_sec != null ? cfg.reranker_idle_timeout_sec : 300) / 60));

    body.innerHTML = `
      <div class="set-group">
        <h2>文档统计</h2>
        <div class="set-row"><div class="stx"><b>文档总数</b></div><span>${docs.length}</span></div>
        <div class="set-row"><div class="stx"><b>就绪文档</b></div><span style="color:var(--pal-green-2)">${ready}</span></div>
        <div class="set-row"><div class="stx"><b>处理中文档</b></div><span style="color:var(--pal-amber-dark)">${processing}</span></div>
        <div class="set-row"><div class="stx"><b>失败文档</b></div><span style="color:var(--pal-danger)">${errored}</span></div>
        <div class="set-row"><div class="stx"><b>文本块数</b></div><span>${stats.total_chunks || 0}</span></div>
        <div class="set-row"><div class="stx"></div><button class="kb-tool-btn" id="kbSetRefresh">刷新统计</button></div>
      </div>
      <div class="set-group">
        <h2>知识库引擎</h2>
        <div class="sub">选择知识库自身功能（文档打标、标签分组）使用的 AI 引擎。不影响对话——对话由左栏离线/在线/并行模式控制。</div>
        <div class="set-row"><div class="stx">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;margin-bottom:8px">
            <input type="radio" name="v2KbAiMode" value="local" ${cfg.kb_ai_mode !== 'cloud' ? 'checked' : ''}> 离线模型（隐私优先）</label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
            <input type="radio" name="v2KbAiMode" value="cloud" ${cfg.kb_ai_mode === 'cloud' ? 'checked' : ''}> 在线模型（质量优先，需配置在线 API）</label>
        </div></div>
      </div>
      <div class="set-group">
        <h2>搜索引擎常驻</h2>
        <div class="sub">控制知识库重排序引擎（Reranker）的内存占用策略</div>
        <div class="set-row"><div class="stx"><b>重排序引擎常驻内存</b><p>常驻=响应更快但占用内存</p></div>
          <button class="switch ${cfg.reranker_resident === true ? 'on' : ''}" id="kbRrResident"></button></div>
        <div class="set-row" id="kbRrIdleRow" style="display:${cfg.reranker_resident === true ? 'none' : 'flex'}"><div class="stx"><b>闲置自动卸载</b><p>闲置 N 分钟后自动卸载（节省内存，下次使用时重新加载）</p></div>
          <span style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--d1-ink-2)">
            <input class="set-input" id="kbRrIdle" type="number" min="1" max="1440" value="${idleMin}" style="width:64px"> 分钟
          </span></div>
      </div>
      <div class="set-group">
        <h2>审计日志管理</h2>
        <div class="sub">每次检索知识库时会记录访问明细（时间/访问者/查询词/命中片段），每篇文档最多保留 200 条。</div>
        <div class="set-row"><div class="stx"><b>日志条数</b></div><span>${audit.total_entries || 0}</span></div>
        <div class="set-row"><div class="stx"><b>涉及文档</b></div><span>${audit.total_files || 0}</span></div>
        <div class="set-row"><div class="stx"><b>磁盘占用</b></div><span>${((audit.total_size_kb || 0) / 1024).toFixed(1)} MB</span></div>
        <div class="set-row"><div class="stx"></div>
          <button class="kb-tool-btn" id="kbAuditClear" style="color:var(--pal-danger)">清空全部审计日志</button></div>
      </div>
      <div class="set-group" style="border-color:var(--pal-danger-border)">
        <h2 style="color:var(--pal-danger)">重置知识库</h2>
        <div class="sub">清空所有已导入的文档、文本片段和向量索引。此操作不可撤销，重置后需重新导入文档。仅清除导入的数据，知识库功能本身不受影响。</div>
        <button class="kb-tool-btn" id="kbReset" style="color:var(--pal-danger)">重置知识库</button>
      </div>`;

    const saveCfg = (obj) => fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

    body.querySelector('#kbSetRefresh').addEventListener('click', () => renderKbSettings(body));
    body.querySelectorAll('input[name="v2KbAiMode"]').forEach(r => r.addEventListener('change', async (e) => {
      await saveCfg({ kb_ai_mode: e.target.value });
    }));
    body.querySelector('#kbRrResident').addEventListener('click', async (e) => {
      const on = !e.target.classList.contains('on');
      await saveCfg({ reranker_resident: on });
      e.target.classList.toggle('on', on);
      body.querySelector('#kbRrIdleRow').style.display = on ? 'none' : 'flex';
      if (on) fetch('/api/kb/load-models', { method: 'POST' }).catch(() => {});  // 常驻=立即驻留
    });
    body.querySelector('#kbRrIdle').addEventListener('change', async (e) => {
      const min = Math.max(1, Math.min(1440, parseInt(e.target.value || '5', 10)));
      await saveCfg({ reranker_idle_timeout_sec: min * 60 });
    });
    body.querySelector('#kbAuditClear').addEventListener('click', async () => {
      if (!confirm('清空全部审计日志？')) return;
      await fetch('/api/kb/audit_log/clear_all', { method: 'POST' });
      renderKbSettings(body);
    });
    body.querySelector('#kbReset').addEventListener('click', async () => {
      if (!confirm('重置知识库将删除全部文档与向量索引，不可撤销。确定继续？')) return;
      const r = await fetch('/api/kb/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) }).then(r => r.json()).catch(() => null);
      alert(r && r.ok ? `已重置（删除 ${r.deleted_docs || 0} 篇文档）` : '重置失败：' + ((r && r.error) || '未知错误'));
      renderKbSettings(body);
    });
  }

  // ============ 隐私安全子页 ============
  async function renderPrivacy(body) {
    body.innerHTML = '<div class="kb-loading" style="padding:30px">加载中…</div>';
    const [info, all] = await Promise.all([
      fetch('/api/system/info').then(r => r.json()).catch(() => ({})),
      fetch('/api/config').then(r => r.json()).catch(() => ({})),
    ]);
    const cfg = (all && all.config) || {};
    const mb = info.data_size_mb;
    const corsStrict = cfg.cors_strict;

    body.innerHTML = `
      <div class="set-group">
        <h2>数据存储位置</h2>
        <div class="set-row"><div class="stx"><b>存储位置</b></div><span style="font-size:11px;word-break:break-all">${esc(info.data_dir || '--')}</span></div>
        <div class="set-row"><div class="stx"><b>数据占用</b></div><span>${mb != null ? (mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB') : '--'}</span></div>
        <div class="set-note">对话、文档、模型、设置等所有数据均存储在本地。在线模式下，对话内容会发送到你配置的在线 API（详见下方隐私声明）</div>
      </div>
      <div class="set-group">
        <h2>隐私声明</h2>
        <div class="sub" style="line-height:1.8">
          桌伴是本地优先的应用：离线模式下所有数据不出本机；在线模式仅在你主动使用时，
          将对话内容与所引用的文档发送到你自行配置的在线 API 服务商。知识库向量索引
          全部在本地构建与存储。诊断报告仅包含系统环境与配置状态，不含对话内容。
        </div>
      </div>
      <div class="set-group">
        <h2>第三方访问</h2>
        <div class="sub">默认严格模式：只有本机页面可以访问应用接口</div>
        <div class="set-row"><div class="stx"><b>允许局域网访问</b><p>关闭严格模式后，同一局域网内其他设备可访问本应用（谨慎开启）</p></div>
          <button class="switch ${corsStrict === false ? 'on' : ''}" id="pvCors"></button></div>
        <div class="set-row"><div class="stx"><b>导出诊断报告</b><p>系统环境与配置状态（不含对话内容），排查问题时使用</p></div>
          <button class="kb-tool-btn" id="pvDiag">导出诊断报告</button></div>
      </div>`;

    body.querySelector('#pvCors').addEventListener('click', async (e) => {
      const allowLan = !e.target.classList.contains('on');
      if (allowLan && !confirm('允许局域网访问后，同一网络内的其他设备可以访问本应用。确定开启？')) return;
      // 语义：勾选=允许第三方=cors_strict=false
      await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cors_strict: !allowLan }) });
      e.target.classList.toggle('on', allowLan);
    });
    body.querySelector('#pvDiag').addEventListener('click', async () => {
      const text = await fetch('/api/diagnostics/export').then(r => r.text()).catch(() => '导出失败');
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      const now = new Date();
      const ts = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0') + '_' + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
      a.href = URL.createObjectURL(blob);
      a.download = 'sidemate_diagnostic_' + ts + '.txt';
      document.body.appendChild(a); a.click(); a.remove();
    });
  }

  // ============ 关于子页 ============
  async function renderAbout(body) {
    body.innerHTML = '<div class="kb-loading" style="padding:30px">加载中…</div>';
    const [status, res] = await Promise.all([
      fetch('/api/status').then(r => r.json()).catch(() => ({})),
      fetch('/api/resource-info').then(r => r.json()).catch(() => ({})),
    ]);
    const mem = res.memory || res;
    body.innerHTML = `
      <div class="set-group">
        <h2>程序版本</h2>
        <div class="set-row"><div class="stx"><b>桌伴 Sidemate</b></div><span style="color:var(--d1-accent-3);font-weight:600">${esc(status.version || '--')}</span></div>
        <div class="set-row"><div class="stx"><b>新手指引</b><p>重新查看首次使用的引导</p></div>
          <button class="kb-tool-btn" id="abTour">重新查看新手指引</button></div>
      </div>
      <div class="set-group">
        <h2>运行状态</h2>
        <div class="set-row"><div class="stx"><b>总内存</b></div><span>${mem.total_gb || mem.total_mem_gb || '--'} GB</span></div>
        <div class="set-row"><div class="stx"><b>可用内存</b></div><span>${mem.available_gb || mem.avail_gb || '--'} GB</span></div>
        <div class="set-row"><div class="stx"><b>Python</b></div><span>${esc(res.python || res.python_version || '--')}</span></div>
        <div class="set-row"><div class="stx"><b>操作系统</b></div><span style="font-size:12px">${esc(res.os || '--')}</span></div>
        <div class="set-row"><div class="stx"></div><button class="kb-tool-btn" id="abDiag">导出诊断报告</button></div>
      </div>
      <div class="set-group">
        <h2>产品描述</h2>
        <div class="sub" style="line-height:1.8">
          桌伴 Sidemate 是一款本地优先的 AI 桌面应用：离线模型/在线 API 双模，
          本地知识库，数据不出本机。
        </div>
      </div>`;

    body.querySelector('#abTour').addEventListener('click', () => {
      // 新手引导在经典版呈现（welcome-tour.js），清标记后回经典版即可重看
      localStorage.removeItem('sidemate_welcomed');
      localStorage.removeItem('sidemate_toured');
      location.href = '/';
    });
    body.querySelector('#abDiag').addEventListener('click', () => {
      // 与隐私安全子页同一逻辑
      fetch('/api/diagnostics/export').then(r => r.text()).then(text => {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'sidemate_diagnostic.txt';
        document.body.appendChild(a); a.click(); a.remove();
      }).catch(() => {});
    });
  }

  return { el, mount: render, destroy: () => {} };
}

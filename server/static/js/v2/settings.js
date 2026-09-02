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

  return { el, mount: render, destroy: () => {} };
}

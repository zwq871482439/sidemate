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

  return { el, mount: render, destroy: () => {} };
}

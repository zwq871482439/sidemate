// 桌伴 0.11 技能选项卡 — 场景与社区技能（行式 + 触发徽章 + 自动触发开关 + 挂载日志）
// + 系统技能（协议+权限）+ MCP 服务器。样式照原型 docs/prototypes/ui-011.html ③。
import { api } from './api.js';
import { icon, iconSvg } from './icons.js';
import { uiAlert, uiConfirm, uiPrompt } from './ui_dialog.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 技能名 → 图标（icons.js 描边款；未命中用 puzzle）
const SKILL_ICON = {
  ppt: 'presentation', doc: 'fileText', report: 'barChart', search: 'search',
  deep: 'target', poster: 'grid', gzh: 'chat',
};
// trigger → 徽章（原型 spec#31：场景=金字金边｜自动=accent-3 灰边｜场景+自动=绿）
const TRIG_META = {
  scene: { cls: 'scene', label: '场景' },
  auto: { cls: 'auto', label: '自动' },
  both: { cls: 'both', label: '场景+自动' },
};

// 技能选项卡视图（创建一次，切 tab 时复用）
export function createSkillsView(opts) {
  const el = document.createElement('div');
  el.className = 'skills-view';

  let systemSkills = [];
  let userSkills = [];
  let mcpServers = [];
  let toolPerms = [];
  let autoEnabled = true;
  let mountLogs = [];

  async function load() {
    el.innerHTML = '<div class="kb-loading">加载中…</div>';
    const [skillsR, mcpR, permsR, logR] = await Promise.all([
      fetch('/api/skills/list').then(r => r.json()).catch(() => ({skills:[]})),
      fetch('/api/mcp/servers').then(r => r.json()).catch(() => ({servers:[]})),
      fetch('/api/permissions/tools').then(r => r.json()).catch(() => ({tools:[]})),
      fetch('/api/skills/mountlog?limit=20').then(r => r.json()).catch(() => ({logs:[]})),
    ]);
    systemSkills = (skillsR.system_skills || []);
    userSkills = (skillsR.user_skills || []);
    autoEnabled = skillsR.auto_trigger_enabled !== false;
    mcpServers = (mcpR.servers || []);
    toolPerms = (permsR.tools || []);
    mountLogs = (logR.logs || []);
    render();
  }

  function render() {
    const sysCount = systemSkills.filter(s => s.enabled !== false).length;
    const usrCount = userSkills.length;
    const mcpConnected = mcpServers.filter(s => s.status === 'connected').length;
    const mcpTools = mcpServers.reduce((a, s) => a + (s.tools || 0), 0);

    el.innerHTML = `
      <div class="sk-header">
        <h2>技能</h2>
        <div class="sk-sub">AI 的能力扩展——系统技能 + 社区 SKILL.md + MCP 外部工具</div>
        <div class="sk-stats">
          <div class="sk-stat"><div class="num">${sysCount}</div><div class="lbl">系统技能</div></div>
          <div class="sk-stat"><div class="num">${usrCount}</div><div class="lbl">用户技能</div></div>
          <div class="sk-stat"><div class="num">${mcpConnected}</div><div class="lbl">MCP 连接</div></div>
          <div class="sk-stat"><div class="num">${mcpTools}</div><div class="lbl">外部工具</div></div>
        </div>
      </div>

      <div class="sk-section">
        <div class="sk-sec-title sk-auto-head">
          ${iconSvg('puzzle')} 场景与社区技能 <span class="sk-cnt">${userSkills.length} 个 · 预装与 data/skills/ 社区格式</span>
          <span class="sw-lb">自动触发</span>
          <button class="switch gold ${autoEnabled ? 'on' : ''}" id="skAutoSw"
                  title="${autoEnabled ? '聊天时按意图自动挂载匹配技能，点击关闭' : '自动触发已关闭，技能仅场景卡可用，点击开启'}"></button>
        </div>
        <div class="sk-note">场景卡点选即挂载；标「自动」的技能聊天命中意图时由 AI 自行挂载（简表可见，正文按需取）</div>
        <div class="sk-rows">
          ${userSkills.map(s => {
            const trig = TRIG_META[s.trigger] || TRIG_META.both;
            const ic = SKILL_ICON[s.name] || 'puzzle';
            const lm = s.last_mounted ? '上次：' + s.last_mounted.slice(5) : '尚未挂载';
            const off = s.enabled === false;
            return `
            <div class="sk-row${off ? ' off' : ''}" data-skill="${esc(s.id)}" title="点击查看技能正文">
              <span class="sic">${iconSvg(ic)}</span>
              <div class="stx">
                <div class="n">${esc(s.name)}${s.preset ? '<span class="sk-preset-tag" title="预装技能：随安装包分发，升级自动补齐；不可删除">预装</span>' : ''}</div>
                <div class="d">${esc(s.description || '')}</div>
              </div>
              <span class="trig ${trig.cls}">${trig.label}</span>
              <span class="sk-mount">${esc(lm)}</span>
              <button class="switch gold${off ? '' : ' on'}" data-sk-toggle="${esc(s.id)}" title="${off ? '已禁用：不参与自动触发（场景卡仍可显式挂载）' : '已启用：允许自动触发'}"></button>
              ${s.preset ? '' : `<button class="sk-del" data-skill="${esc(s.id)}" title="删除">✕</button>`}
            </div>`;
          }).join('') || '<div class="sk-empty">还没有技能——将 SKILL.md 放入 data/skills/ 目录，或让 AI 安装社区技能</div>'}
        </div>
        <div class="sk-add" onclick="uiAlert('将 SKILL.md 文件复制到 data/skills/ 目录即可。\\n\\n格式示例：\\n---\\nname: 我的技能\\ndescription: 描述（自动触发匹配用）\\ntrigger: both\\n---\\n\\n技能内容（注入 AI 的指导文本）')">
          ${iconSvg('plus')} 添加技能（放入 SKILL.md 文件）
        </div>
      </div>

      <div class="sk-section">
        <div class="sk-sec-title">${icon('clock')} 挂载日志 <span class="sk-cnt">最近 ${mountLogs.length} 条 · 命中/跳过</span></div>
        <div class="mount-log">
          ${mountLogs.map(l => `
            <div class="ml-row">
              <span class="t">${esc((l.ts || '').slice(5, 16))}</span>
              <span class="k">${esc(l.skill)}</span>${l.hit ? '命中' : '未命中'}${l.detail ? '「' + esc(l.detail) + '」' : ''}
              <span class="${l.hit ? 'hit' : 'miss'}">${l.hit ? '已挂载' : '跳过'}</span>
            </div>`).join('') || '<div class="ml-row"><span class="miss" style="margin:0">暂无挂载记录——发一条命中技能意图的消息试试</span></div>'}
        </div>
      </div>

      <div class="sk-section">
        <div class="sk-sec-title">${icon('settings')} 系统技能 <span class="sk-cnt">${systemSkills.length} 个</span></div>
        <div class="sk-note">内置能力，可禁用不可删除。禁用后 AI 将无法使用对应功能。</div>
        <div class="sk-grid">
          ${systemSkills.map(s => `
            <div class="sk-card ${s.enabled === false ? 'disabled' : ''}" title="${s.enabled === false ? '默认关闭：按需手动开启' : ''}">
              <div class="sk-card-head">
                <span class="sk-name">${esc(s.name)}</span>
                ${s.config_key
                  ? `<button class="switch ${s.enabled !== false ? 'on' : ''}" data-skill="${esc(s.id)}" data-type="${s.source === 'protocol' ? 'protocol' : 'system'}" title="${s.enabled !== false ? '点击禁用' : '点击启用'}"></button>`
                  : '<span style="font-size:10.5px;color:var(--d1-ink-3)">常开</span>'}
              </div>
              <div class="sk-desc">${esc(s.description || '')}</div>
              <div class="sk-meta">
                <span class="sk-tag sys">${s.source === 'protocol' ? '协议' : '内置'}</span>
                ${s.pipeline_types ? `<span>挂载: ${esc(s.pipeline_types.join(' · '))}</span>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="sk-section">
        <div class="sk-sec-title">${icon('globe')} MCP 外部工具 <span class="sk-cnt">${mcpServers.length} 个</span></div>
        <div class="sk-note">连接外部工具生态（仅在线模式）；本地走 stdio，远程走 Streamable HTTP/SSE（Bearer/API-Key 认证）</div>
        <div class="mcp-grp">${iconSvg('hardDrive')} 本地 <span class="mcp-n">stdio</span></div>
        ${mcpServers.filter(s => !s.remote).map(s => `
          <div class="mcp-row">
            <span class="mcp-ic">${iconSvg('hardDrive')}</span>
            <div class="mcp-tx"><div class="n">${esc(s.name)}</div>
              <div class="u">${esc(((s.command || '') + ' ' + (s.args || []).join(' ')).trim())}</div></div>
            <span class="mcp-cnt">${s.tools || 0} 个工具</span>
            <span class="mcp-auth ${s.status === 'connected' ? 'ok' : 'off'}">${s.status === 'connected' ? '已连接' : (s.error ? '失败' : '未连接')}</span>
            <button class="sk-mcp-btn" data-mcp-action="remove" data-mcp="${esc(s.name)}">移除</button>
          </div>`).join('') || '<div class="sk-empty">暂无本地 MCP 服务器</div>'}
        <div class="mcp-grp">${iconSvg('globe')} 远程 <span class="mcp-n">streamable http / sse</span></div>
        ${mcpServers.filter(s => s.remote).map(s => `
          <div class="mcp-row remote">
            <span class="mcp-ic">${iconSvg('globe')}</span>
            <div class="mcp-tx"><div class="n">${esc(s.name)}</div><div class="u">${esc(s.url || '')}</div></div>
            <span class="mcp-cnt">${s.tools || 0} 个工具</span>
            <span class="mcp-auth ${s.status === 'connected' ? 'ok' : 'off'}">${s.status === 'connected' ? 'Bearer · 已连接' : (s.headers_set ? '认证失败' : '未配置密钥')}</span>
            <button class="sk-mcp-btn" data-mcp-action="remove" data-mcp="${esc(s.name)}">移除</button>
          </div>`).join('') || '<div class="sk-empty">暂无远程 MCP（示例 GitHub：https://api.githubcopilot.com/mcp/ + Bearer Token）</div>'}
        <div class="sk-add" id="skAddMcp">
          ${iconSvg('plus')} 添加 MCP 服务器（本地 stdio / 远程 HTTP）
        </div>
      </div>
    `;

    _bind(el);
  }

  function _bind(root) {
    // 自动触发总开关（0.11 A2：关=简表不注入+mount_skill 工具撤下）
    const autoSw = root.querySelector('#skAutoSw');
    if (autoSw) {
      autoSw.addEventListener('click', async () => {
        const on = !autoSw.classList.contains('on');
        autoSw.disabled = true;
        await fetch('/api/skills/toggle', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'auto', enabled: on }),
        }).catch(() => {});
        autoSw.disabled = false;
        autoSw.classList.toggle('on', on);
        autoSw.title = on ? '聊天时按意图自动挂载匹配技能，点击关闭' : '自动触发已关闭，技能仅场景卡可用，点击开启';
      });
    }

    // 系统 skill 开关
    root.querySelectorAll('.sk-card .switch[data-skill]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.skill;
        const on = !btn.classList.contains('on');
        btn.disabled = true;
        await fetch('/api/skills/toggle', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, type: 'system', enabled: on }),
        }).catch(() => {});
        btn.disabled = false;
        btn.classList.toggle('on', on);
        btn.closest('.sk-card').classList.toggle('disabled', !on);
      });
    });

    // 0.11.1：用户技能行级开关（禁用=退出自动触发通道）
    root.querySelectorAll('[data-sk-toggle]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        btn.style.pointerEvents = 'none';
        const enabled = !btn.classList.contains('on');
        await fetch('/api/skills/toggle', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: btn.dataset.skToggle, enabled }),
        }).catch(() => {});
        load(); // 重新加载
      });
    });

    // 用户 skill 删除（预装技能无删除按钮 + 后端双保险）
    root.querySelectorAll('.sk-del[data-skill]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!(await uiConfirm('删除此技能？'))) return;
        const r = await fetch('/api/skills/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: btn.dataset.skill }),
        }).then(x => x.json()).catch(() => null);
        if (r && r.error) uiAlert(r.error);
        load(); // 重新加载
      });
    });

    // MCP 移除（#58-6：原「断开」实际是删除配置——改名为「移除」并加确认）
    root.querySelectorAll('[data-mcp-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.mcp;
        const ok = await uiConfirm('移除 MCP 服务器「' + name + '」？\n这会删除它的配置（不是断开重连）。');
        if (!ok) return;
        await fetch('/api/mcp/servers/' + encodeURIComponent(name), { method: 'DELETE' }).catch(() => {});
        load();
      });
    });

    // 添加 MCP（0.11 B2：本地 stdio / 远程 HTTP 两路）
    const addMcp = root.querySelector('#skAddMcp');
    if (addMcp) {
      addMcp.addEventListener('click', async () => {
        const name = await uiPrompt('MCP 服务器名称（如 filesystem / github）：');
        if (!name) return;
        const kind = await uiPrompt('类型：输入 1 = 本地（stdio 启动命令），输入 2 = 远程（HTTP URL + Bearer Token）：');
        if (!kind) return;
        let body;
        if (String(kind).trim() === '2') {
          const url = await uiPrompt('远程 URL（如 https://api.githubcopilot.com/mcp/）：');
          if (!url) return;
          const token = await uiPrompt('Bearer Token（留空则改用 X-Api-Key 时直接输入完整头，如 key=value）：');
          const headers = {};
          if (token) {
            if (token.includes('=')) { const i = token.indexOf('='); headers[token.slice(0, i)] = token.slice(i + 1); }
            else headers['Authorization'] = 'Bearer ' + token;
          }
          body = { name, type: 'http', url, headers };
        } else {
          const cmd = await uiPrompt('启动命令（如 npx -y @anthropic/mcp-server-filesystem /path）：');
          if (!cmd) return;
          const parts = cmd.split(' ');
          body = { name, command: parts[0], args: parts.slice(1) };
        }
        fetch('/api/mcp/servers', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(() => fetch('/api/mcp/connect', { method: 'POST' }))
          .then(() => load())
          .catch(() => uiAlert('添加或连接失败'));
      });
    }
  }

  load();
  return { el, reload: load };
}

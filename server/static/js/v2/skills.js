// 桌伴 0.10 新版 UI — 技能选项卡（M4 增补：skill 管理+MCP 服务器+权限替代）
// 侧栏第三 tab：系统 skill（协议+权限）+ 管线 skill + 用户 SKILL.md + MCP
import { api } from './api.js';
import { icon, iconSvg } from './icons.js';
import { uiAlert, uiConfirm, uiPrompt } from './ui_dialog.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 技能选项卡视图（创建一次，切 tab 时复用）
export function createSkillsView(opts) {
  const el = document.createElement('div');
  el.className = 'skills-view';

  let systemSkills = [];
  let userSkills = [];
  let mcpServers = [];
  let toolPerms = [];

  async function load() {
    el.innerHTML = '<div class="kb-loading">加载中…</div>';
    const [skillsR, mcpR, permsR] = await Promise.all([
      fetch('/api/skills/list').then(r => r.json()).catch(() => ({skills:[]})),
      fetch('/api/mcp/servers').then(r => r.json()).catch(() => ({servers:[]})),
      fetch('/api/permissions/tools').then(r => r.json()).catch(() => ({tools:[]})),
    ]);
    systemSkills = (skillsR.system_skills || []);
    userSkills = (skillsR.user_skills || []);
    mcpServers = (mcpR.servers || []);
    toolPerms = (permsR.tools || []);
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
        <div class="sk-sec-title">${icon('settings')} 系统技能 <span class="sk-cnt">${systemSkills.length} 个</span></div>
        <div class="sk-note">内置能力，可禁用不可删除。禁用后 AI 将无法使用对应功能。</div>
        <div class="sk-grid">
          ${systemSkills.map(s => `
            <div class="sk-card ${s.enabled === false ? 'disabled' : ''}">
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
        <div class="sk-sec-title">${icon('fileText')} 用户技能 <span class="sk-cnt">${userSkills.length} 个</span></div>
        <div class="sk-note">SKILL.md 文件放入 data/skills/ 目录即生效（兼容 Claude Code / 社区格式）</div>
        <div class="sk-grid">
          ${userSkills.map(s => `
            <div class="sk-card">
              <div class="sk-card-head">
                <span class="sk-name">${esc(s.name)}</span>
                <button class="sk-del" data-skill="${esc(s.id)}" title="删除">✕</button>
              </div>
              <div class="sk-desc">${esc(s.description || '')}</div>
              <div class="sk-meta">
                <span class="sk-tag user">SKILL.md</span>
                ${s.pipeline_types && s.pipeline_types.length ? `<span>挂载: ${esc(s.pipeline_types.join(' · '))}</span>` : ''}
              </div>
            </div>
          `).join('') || '<div class="sk-empty">还没有用户技能——将 SKILL.md 文件放入 data/skills/ 目录</div>'}
        </div>
        <div class="sk-add" onclick="uiAlert('将 SKILL.md 文件复制到 data/skills/ 目录即可。\\n\\n格式示例：\\n---\\nname: 我的技能\\ndescription: 描述\\npipeline_types: [docx]\\n---\\n\\n技能内容（注入 AI 的指导文本）')">
          ${iconSvg('plus')} 添加技能（放入 SKILL.md 文件）
        </div>
      </div>

      <div class="sk-section">
        <div class="sk-sec-title">${icon('globe')} MCP 工具服务器 <span class="sk-cnt">${mcpServers.length} 个</span></div>
        <div class="sk-note">连接外部工具生态（文件系统/GitHub/数据库等），仅在线模式</div>
        ${mcpServers.map(s => `
          <div class="sk-mcp-row">
            <span class="sk-mcp-dot ${s.status}"></span>
            <div class="sk-mcp-info">
              <div class="sk-mcp-name">${esc(s.name)}</div>
              <div class="sk-mcp-tools">${s.tools || 0} 个工具${s.tool_names && s.tool_names.length ? '：' + esc(s.tool_names.slice(0, 5).join(' · ')) : ''}</div>
            </div>
            <button class="sk-mcp-btn" data-mcp-action="disconnect" data-mcp="${esc(s.name)}">断开</button>
          </div>
        `).join('') || '<div class="sk-empty">还没有配置 MCP 服务器</div>'}
        <div class="sk-add" id="skAddMcp">
          ${iconSvg('plus')} 添加 MCP 服务器
        </div>
      </div>
    `;

    _bind(el);
  }

  function _bind(root) {
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

    // 用户 skill 删除
    root.querySelectorAll('.sk-del[data-skill]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!(await uiConfirm('删除此技能？'))) return;
        await fetch('/api/skills/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: btn.dataset.skill }),
        }).catch(() => {});
        load(); // 重新加载
      });
    });

    // MCP 断开
    root.querySelectorAll('[data-mcp-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await fetch('/api/mcp/servers/' + encodeURIComponent(btn.dataset.mcp), { method: 'DELETE' }).catch(() => {});
        load();
      });
    });

    // 添加 MCP
    const addMcp = root.querySelector('#skAddMcp');
    if (addMcp) {
      addMcp.addEventListener('click', async () => {
        const name = await uiPrompt('MCP 服务器名称（如 filesystem）：');
        if (!name) return;
        const cmd = await uiPrompt('启动命令（如 npx -y @anthropic/mcp-server-filesystem /path）：');
        if (!cmd) return;
        const parts = cmd.split(' ');
        fetch('/api/mcp/servers', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, command: parts[0], args: parts.slice(1) }),
        }).then(() => fetch('/api/mcp/connect', { method: 'POST' }))
          .then(() => load())
          .catch(() => uiAlert('添加或连接失败'));
      });
    }
  }

  load();
  return { el, reload: load };
}

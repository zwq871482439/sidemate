// 桌伴 0.10.1 新版 UI — 后端 API 封装（M1-D）
// 只读/显式动作的薄封装，全部走既有 REST 端点（与经典版同一后端）。

async function _json(resp) {
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return resp.json();
}

export const api = {
  // 当前模式：{ mode: 'local'|'cloud'|'parallel', cloud_configured, context_window, ... }
  async getMode() {
    return _json(await fetch('/api/mode'));
  },
  // 切换模式（后端值 local/cloud/parallel）
  async switchMode(mode) {
    return _json(await fetch('/api/mode/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    }));
  },
  // 会话列表：{ chats: [{name, label, msg_count, current, path}], current }
  async listChats() {
    return _json(await fetch('/api/chats'));
  },
  async newChat(projectDir) {
    return _json(await fetch('/api/chats/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(projectDir ? { project_dir: projectDir } : {}),
    }));
  },
  async switchChat(path) {
    return _json(await fetch('/api/chats/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }));
  },
  // ---- 项目（项目即文件夹，PLAN 1.5 四次定稿） ----
  // 内联文件浏览器（目录选择器）：path 空=根视图（快捷入口+盘符），否则列子目录
  async browseDirs(path) {
    return _json(await fetch('/api/system/browse' + (path ? '?path=' + encodeURIComponent(path) : '')));
  },
  // 项目列表：{ projects: [{dir, display, is_default, status}] }（默认项目恒在首位）
  async listProjects() {
    return _json(await fetch('/api/projects/list'));
  },
  async createProjectBlank(name) {
    return _json(await fetch('/api/projects/new_blank', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }));
  },
  async createProjectExternal(path) {
    return _json(await fetch('/api/projects/new_external', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }));
  },
  async renameProject(dir, display) {
    return _json(await fetch('/api/projects/rename', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir, display }),
    }));
  },
  async deleteProject(dir) {
    return _json(await fetch('/api/projects', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir }),
    }));
  },
  // 会话归项目（仅 0 消息会话）
  async setChatProject(chatName, dir) {
    return _json(await fetch('/api/chats/' + encodeURIComponent(chatName) + '/project', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir }),
    }));
  },
  // 列指定项目目录（跨项目查看用，只读）：{ files, artifacts, dir, display, status, is_default }
  async listProjectFiles(dir) {
    return _json(await fetch('/api/projects/files?dir=' + encodeURIComponent(dir)));
  },
  // 解析会话所属项目：{ legacy } | { dir, display, is_default, status }
  async getWorkdir(chatName) {
    return _json(await fetch('/api/chats/' + encodeURIComponent(chatName) + '/workdir'));
  },
  // 列项目目录：{ files: 顶层材料, artifacts: .sidemate 产物, dir, display, status, legacy? }
  async listWorkdirFiles(chatName) {
    return _json(await fetch('/api/chats/' + encodeURIComponent(chatName) + '/workdir/files'));
  },
  // 引用目录文件（直读不复制）：{ path（原路径）, filename, size, tokens }
  async referenceWorkdirFile(chatName, name) {
    return _json(await fetch('/api/chats/' + encodeURIComponent(chatName) + '/workdir/reference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }));
  },
  async openWorkdir(chatName) {
    return _json(await fetch('/api/chats/' + encodeURIComponent(chatName) + '/workdir/open', { method: 'POST' }));
  },
  // 存产物到 <项目目录>/.sidemate/（卡片「存产物」动作；用户显式动作）
  async saveArtifact(chatName, filename, content) {
    return _json(await fetch('/api/chats/' + encodeURIComponent(chatName) + '/workdir/artifact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, content }),
    }));
  },
  // ---- 项目交接 handoff.md（PLAN ②++） ----
  async getHandoff(chatName) {
    return _json(await fetch('/api/chats/' + encodeURIComponent(chatName) + '/handoff'));
  },
  // manual=true 时离线模式也允许（用户显式动作）
  async generateHandoff(chatName, manual) {
    return _json(await fetch('/api/chats/' + encodeURIComponent(chatName) + '/handoff/generate' + (manual ? '?manual=1' : ''), {
      method: 'POST',
    }));
  },
};

// 模式映射：后端值 ↔ 新版 UI 显示
export const MODE_LABEL = { local: '离线', cloud: '在线', parallel: '并行' };
export const MODE_ORDER = ['local', 'cloud', 'parallel'];

// 顶栏模型 tag：「离线 · qwen3.5-2b-q4」/「在线 · deepseek-v4-flash」（具体型号）
export async function getModelTag(mode) {
  try {
    if (mode === 'cloud') {
      const m = await api.getMode();
      return '在线 · ' + (m.cloud_model || '云端模型');
    }
    const s = await _json(await fetch('/api/status'));
    for (const k of Object.keys(s)) {
      const info = s[k];
      if (info && typeof info === 'object' && info.type === 'llm' && info.loaded) {
        return (mode === 'parallel' ? '并行 · ' : '离线 · ') + k;
      }
    }
    return mode === 'parallel' ? '并行 · 未加载' : '离线 · 未加载';
  } catch (e) {
    return '';
  }
}

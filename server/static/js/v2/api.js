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
  async newChat() {
    return _json(await fetch('/api/chats/new', { method: 'POST' }));
  },
  async switchChat(path) {
    return _json(await fetch('/api/chats/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }));
  },
  // ---- 工作目录（M1 只读版） ----
  // 弹系统原生目录对话框（阻塞至用户选完）：{ ok, path } | { cancelled }
  async pickDirectory() {
    return _json(await fetch('/api/system/pick-directory', { method: 'POST' }));
  },
  // 解析会话生效目录：{ workdir, source: 'session'|'group'|null, group }
  async getWorkdir(chatName) {
    return _json(await fetch('/api/chats/' + encodeURIComponent(chatName) + '/workdir'));
  },
  // 会话级绑定/解除（path=null 解除）
  async setChatWorkdir(chatName, path) {
    return _json(await fetch('/api/chats/' + encodeURIComponent(chatName) + '/workdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }));
  },
  // 项目级绑定/解除（path=null 解除）
  async setProjectWorkdir(group, path) {
    return _json(await fetch('/api/projects/' + encodeURIComponent(group) + '/workdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }));
  },
  // 全部项目 → 目录映射（侧栏图标态）
  async getProjectWorkdirs() {
    return _json(await fetch('/api/projects/workdirs'));
  },
  // 只读列目录：{ files: [{name,is_dir,size,mtime}], workdir, source, group }
  async listWorkdirFiles(chatName) {
    return _json(await fetch('/api/chats/' + encodeURIComponent(chatName) + '/workdir/files'));
  },
  async openWorkdir(chatName) {
    return _json(await fetch('/api/chats/' + encodeURIComponent(chatName) + '/workdir/open', { method: 'POST' }));
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

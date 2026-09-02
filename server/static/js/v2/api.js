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
  // ---- 工作目录（M1 只读版；项目 ↔ 目录 1:1，目录=项目属性） ----
  // 内联文件浏览器（目录选择器）：path 空=根视图（快捷入口+盘符），否则列子目录
  async browseDirs(path) {
    return _json(await fetch('/api/system/browse' + (path ? '?path=' + encodeURIComponent(path) : '')));
  },
  // 解析会话生效目录（= 所属项目目录）：{ workdir, source: 'external'|'default', group }
  async getWorkdir(chatName) {
    return _json(await fetch('/api/chats/' + encodeURIComponent(chatName) + '/workdir'));
  },
  // 项目外部换绑/解除（path=null 解除，回落默认目录）
  async setProjectWorkdir(group, path) {
    return _json(await fetch('/api/projects/' + encodeURIComponent(group) + '/workdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }));
  },
  // 各项目生效目录（含默认目录）：{ workdirs: { 组名: {workdir, source} } }
  async getProjectWorkdirs(groups) {
    const q = groups && groups.length ? '?groups=' + groups.map(encodeURIComponent).join(',') : '';
    return _json(await fetch('/api/projects/workdirs' + q));
  },
  // 只读列目录：{ files: [{name,is_dir,size,mtime}], workdir, source, group }
  async listWorkdirFiles(chatName) {
    return _json(await fetch('/api/chats/' + encodeURIComponent(chatName) + '/workdir/files'));
  },
  // 引用目录文件进会话（复制到 workspace，返回与上传同构的 {path, filename, size, tokens}）
  async importWorkdirFile(chatName, name) {
    return _json(await fetch('/api/chats/' + encodeURIComponent(chatName) + '/workdir/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }));
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

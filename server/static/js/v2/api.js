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
};

// 模式映射：后端值 ↔ 新版 UI 显示
export const MODE_LABEL = { local: '离线', cloud: '在线', parallel: '并行' };
export const MODE_ORDER = ['local', 'cloud', 'parallel'];

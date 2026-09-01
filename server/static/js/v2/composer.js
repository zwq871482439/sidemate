// 桌伴 0.10.1 新版 UI — 输入区（M1-D-3：原型 v14 composer + 经典版行为照搬）
// 组成：上下文双条（token 占用指示器）+ 快捷 chips（action 按钮）+ 模型 tag
//       + 附件浮出栏（上传文档/KB 引用）+ 输入框 + 发送/停止。

import { api } from './api.js';

// 经典版 chat-actions.js 的在线快捷提示词（原样照搬）
const CLOUD_PROMPTS = [
  { label: '联网搜索', tip: '请联网搜索下面这个主题：' },
  { label: '写文档', tip: '请帮我写一份 Word 文档：' },
  { label: '可视化报告', tip: '请帮我做一份图文并茂的报告（带图表）：' },
  { label: '写PPT', tip: '请帮我做一份演示文稿 PPT：' },
  { label: '深度分析', tip: '请对以下内容做深度分析：' },
];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// state: { mode, actionMode, modelTag, contextWindow, historyChars, chipTip }
// events: { onSend(payload), onStop(), onChipMode(mode), onAttachChange(att) }
export function renderComposer(state, events) {
  const wrap = document.createElement('div');
  wrap.className = 'composer';

  const usedK = (state.historyChars / 1.5 / 1000).toFixed(1);
  const totalK = Math.round((state.contextWindow || 8192) / 1000);
  const usedPct = Math.min(100, (state.historyChars / 1.5) / (state.contextWindow || 8192) * 100);

  wrap.innerHTML = `
    <div class="ctx-meter">
      <div class="ctx-row"><span class="lb">已用历史</span>
        <div class="ctx-bar"><i class="used" style="width:${usedPct}%"></i></div>
        <span>${usedK}k / ${totalK}k</span></div>
    </div>
    <div class="quick-chips"></div>
    <div class="attach-tray" style="display:none"></div>
    <div class="composer-box">
      <textarea placeholder="发消息给桌伴…（Enter 发送 / Shift+Enter 换行）" rows="1"></textarea>
      <div class="composer-bar">
        <button class="cb-icon" data-act="upload" title="附加文档到聊天">📎</button>
        <button class="cb-icon" data-act="kb" title="附加知识库文档到聊天">📚</button>
        <button class="cb-send">发送</button>
        <button class="cb-send cb-stop" style="display:none">停止</button>
      </div>
    </div>
    <input type="file" style="display:none">
  `;

  const textarea = wrap.querySelector('textarea');
  const sendBtn = wrap.querySelector('.cb-send');
  const stopBtn = wrap.querySelector('.cb-stop');
  const chipsEl = wrap.querySelector('.quick-chips');
  const trayEl = wrap.querySelector('.attach-tray');
  const fileInput = wrap.querySelector('input[type=file]');

  // 附件状态：{ kind: 'upload', name, path } | { kind: 'kb', names: [], ids: 'a,b' }
  let attach = null;

  function renderTray() {
    if (!attach) { trayEl.style.display = 'none'; trayEl.innerHTML = ''; return; }
    trayEl.style.display = 'flex';
    if (attach.kind === 'upload') {
      trayEl.innerHTML = `<span class="attach-chip">📄 ${esc(attach.name)}<span class="x" title="移除">×</span></span>`;
    } else {
      trayEl.innerHTML = `<span class="attach-chip">📚 KB：${esc(attach.names.join('、'))}<span class="x" title="移除">×</span></span>`;
    }
    trayEl.querySelector('.x').addEventListener('click', () => { attach = null; renderTray(); events.onAttachChange(null); });
  }

  // ---- 快捷 chips：按模式照搬经典版 ----
  function renderChips() {
    chipsEl.innerHTML = '';
    if (state.mode === 'cloud') {
      // 在线：提示词预填（action_mode 恒 chat，按钮只填引导词）
      for (const p of CLOUD_PROMPTS) {
        const b = document.createElement('button');
        b.className = 'qc-btn' + (state.chipTip === p.tip ? ' on' : '');
        b.textContent = p.label;
        b.title = p.tip;
        b.addEventListener('click', () => {
          // togglePromptChip 行为：再点取消，否则填入引导词
          if (state.chipTip === p.tip) {
            state.chipTip = '';
            textarea.value = textarea.value.replace(p.tip, '');
          } else {
            state.chipTip = p.tip;
            if (!textarea.value.startsWith(p.tip)) textarea.value = p.tip + textarea.value;
            textarea.focus();
          }
          renderChips();
        });
        chipsEl.appendChild(b);
      }
    } else {
      // 离线/并行：action 模式按钮（本地 /api/action/list + 知识库问答）
      (state.localActions || []).forEach(a => {
        const b = document.createElement('button');
        b.className = 'qc-btn' + (state.actionMode === a.id ? ' on' : '');
        b.textContent = a.label || a.id;
        b.title = a.title || '';
        b.addEventListener('click', () => { state.actionMode = a.id; events.onChipMode(a.id); renderChips(); });
        chipsEl.appendChild(b);
      });
      const kb = document.createElement('button');
      kb.className = 'qc-btn' + (state.actionMode === 'kb_qa' ? ' on' : '');
      kb.textContent = '知识库问答';
      kb.title = '检索你的本地知识库，基于文档内容回答问题';
      kb.addEventListener('click', () => { state.actionMode = 'kb_qa'; events.onChipMode('kb_qa'); renderChips(); });
      chipsEl.appendChild(kb);
    }
    // 模型 tag（右端）
    if (state.modelTag) {
      const tag = document.createElement('span');
      tag.className = 'qc-model';
      tag.textContent = state.modelTag;
      chipsEl.appendChild(tag);
    }
  }
  renderChips();

  // ---- 发送/停止 ----
  function doSend() {
    const text = textarea.value.trim();
    if (!text && !attach) return;
    const payload = {
      text,
      actionMode: state.actionMode,
      filePath: attach ? (attach.kind === 'upload' ? attach.path : attach.ids) : null,
      fileTag: attach ? (attach.kind === 'upload'
        ? { name: attach.name, source: 'upload' }
        : { name: attach.names.join('、'), source: 'kb' }) : null,
    };
    textarea.value = '';
    state.chipTip = '';
    attach = null;
    renderTray();
    renderChips();
    events.onSend(payload);
  }

  sendBtn.addEventListener('click', doSend);
  stopBtn.addEventListener('click', () => events.onStop());
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
  // 自适应高度
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
  });

  // ---- 附件：上传文档 ----
  wrap.querySelector('[data-act="upload"]').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    const session = events.getSession && events.getSession();
    try {
      const fd = new FormData();
      fd.append('file', f);
      let url = '/api/file_upload';
      if (session && session.name) url += '?chat_id=' + encodeURIComponent(session.name);
      const resp = await fetch(url, { method: 'POST', body: fd });
      const data = await resp.json();
      if (data.path) {
        attach = { kind: 'upload', name: f.name, path: data.path };
        renderTray();
        events.onAttachChange(attach);
      }
    } catch (e) { console.warn('[v2] 上传失败', e); }
    fileInput.value = '';
  });

  // ---- 附件：KB 文档选择（简化模态，多选） ----
  wrap.querySelector('[data-act="kb"]').addEventListener('click', async () => {
    try {
      const resp = await fetch('/api/kb/documents');
      const data = await resp.json();
      const files = (Array.isArray(data) ? data : (data.files || [])).filter(f => f.status === 'ready');
      if (!files.length) { alert('知识库中没有文档，请先上传'); return; }
      _showKbPicker(files, (picked) => {
        attach = { kind: 'kb', names: picked.map(p => p.filename), ids: picked.map(p => p.id || p.doc_id).join(',') };
        renderTray();
        events.onAttachChange(attach);
      });
    } catch (e) { console.warn('[v2] KB 列表失败', e); }
  });

  function _showKbPicker(files, onOk) {
    const overlay = document.createElement('div');
    overlay.className = 'kb-pk-overlay';
    overlay.innerHTML = `
      <div class="kb-pk">
        <div class="kb-pk-title">选择知识库文档（可多选）</div>
        <div class="kb-pk-list">
          ${files.map(f => `<label class="kb-pk-item"><input type="checkbox" value="${esc(f.id || f.doc_id || '')}" data-name="${esc(f.filename)}"> ${esc(f.filename)}</label>`).join('')}
        </div>
        <div class="kb-pk-acts"><button class="kb-pk-cancel">取消</button><button class="kb-pk-ok">确定</button></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.kb-pk-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.kb-pk-ok').addEventListener('click', () => {
      const picked = [...overlay.querySelectorAll('input:checked')].map(i => ({ id: i.value, doc_id: i.value, filename: i.dataset.name }));
      overlay.remove();
      if (picked.length) onOk(picked);
    });
  }

  // 生成中切换发送/停止
  function setRunning(running) {
    sendBtn.style.display = running ? 'none' : '';
    stopBtn.style.display = running ? '' : 'none';
    textarea.disabled = running;
  }

  return { el: wrap, setRunning, focus: () => textarea.focus() };
}

// 拉离线 action 列表（经典版 /api/action/list）
export async function loadLocalActions() {
  try {
    const r = await fetch('/api/action/list');
    const d = await r.json();
    return d.actions || [];
  } catch (e) { return []; }
}

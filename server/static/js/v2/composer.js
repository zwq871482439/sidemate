// 桌伴 0.10.1 新版 UI — 输入区（M1-D-3：原型 v14 composer + 经典版行为照搬）
// 组成：上下文双条（token 占用指示器）+ 快捷 chips（action 按钮）+ 模型 tag
//       + 附件浮出栏（上传文档/KB 引用）+ 输入框 + 发送/停止。

import { api } from './api.js';

// Token 估算（照搬经典版 token-estimator.js：中文 ~1.5 字/token，英文 ~4 字/token）
export function estimateTokens(text) {
  if (!text) return 0;
  const cn = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const other = text.length - cn;
  return Math.ceil(cn / 1.5 + other / 4.0);
}
const FILE_TOKENS_PER_KB = 200;  // 经典版同款：文件约 200 token/KB

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// state: { mode, actionMode, localActions, modelTag, contextWindow, historyTokens, chipTip }
// events: { onSend(payload), onStop(), onChipMode(mode), onAttachChange(att) }
export function renderComposer(state, events) {
  const wrap = document.createElement('div');
  wrap.className = 'composer';

  const maxTokens = state.contextWindow || 8192;
  const fmtK = (n) => (n / 1000).toFixed(1) + 'K';
  const fmtKU = (n) => (n / 1000).toFixed(1) + 'K词元';

  wrap.innerHTML = `
    <div class="token-bar">
      <div class="tb-main">
        <div class="tb-track">
          <div class="tb-fill tb-used" style="width:0%"></div>
          <div class="tb-fill tb-cur" style="width:0%"></div>
        </div>
        <div class="tb-labels">
          <span class="tb-lbl-left">
            <span class="tb-tag tb-tag-status status-ok" id="v2TokenStatus">空间充足</span>
            <span class="tb-tag tb-tag-used">已用 <span id="v2TokenHist">0.0K</span></span>
            <span class="tb-tag tb-tag-cur">本轮 <span id="v2TokenCur">0.0K</span></span>
          </span>
          <span class="tb-lbl-right">剩余 <span class="tb-remain" id="v2TokenRemain">0.0K词元</span>
            <span class="tb-limit">/ 总计 <span id="v2TokenLimit">${fmtKU(maxTokens)}</span></span></span>
        </div>
      </div>
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
    trayEl.querySelector('.x').addEventListener('click', () => { attach = null; attachTokens = 0; renderTray(); updateTokenBar(); events.onAttachChange(null); });
  }

  // ---- 快捷 chips：按模式照搬经典版 ----
  function renderChips() {
    chipsEl.innerHTML = '';
    if (state.mode === 'cloud') {
      // 0.10.1 定稿：在线模式的提示词 chips 移除——空状态场景卡已覆盖入口，
      // 工具选择由后端 agent 自主判断（harness 层），输入区只留模型 tag。
    } else {
      // 离线/并行：action 模式按钮（本地 /api/action/list + 知识库问答）
      // 切换语义：点另一个=直接切换；点当前=取消回到 chat
      (state.localActions || []).forEach(a => {
        const b = document.createElement('button');
        b.className = 'qc-btn' + (state.actionMode === a.id ? ' on' : '');
        b.textContent = a.label || a.id;
        b.title = a.title || '';
        b.addEventListener('click', () => {
          const next = state.actionMode === a.id ? 'chat' : a.id;
          state.actionMode = next;
          events.onChipMode(next);
          renderChips();
        });
        chipsEl.appendChild(b);
      });
      const kb = document.createElement('button');
      kb.className = 'qc-btn' + (state.actionMode === 'kb_qa' ? ' on' : '');
      kb.textContent = '知识库问答';
      kb.title = '检索你的本地知识库，基于文档内容回答问题';
      kb.addEventListener('click', () => {
        const next = state.actionMode === 'kb_qa' ? 'chat' : 'kb_qa';
        state.actionMode = next;
        events.onChipMode(next);
        renderChips();
      });
      chipsEl.appendChild(kb);
    }
  }
  renderChips();

  // ---- Token 聚合条（照搬经典版 updateInputDisplay 口径） ----
  let attachTokens = 0;
  function updateTokenBar() {
    const textTokens = estimateTokens(textarea.value);
    const curTotal = textTokens + attachTokens;
    const hist = state.historyTokens || 0;
    const total = curTotal + hist;
    const usedPct = maxTokens > 0 ? Math.min(100, (hist / maxTokens) * 100) : 0;
    const curPct = maxTokens > 0 ? Math.min(100 - usedPct, (curTotal / maxTokens) * 100) : 0;
    wrap.querySelector('.tb-used').style.width = usedPct + '%';
    wrap.querySelector('.tb-cur').style.width = curPct + '%';
    wrap.querySelector('#v2TokenCur').textContent = fmtK(curTotal);
    wrap.querySelector('#v2TokenHist').textContent = fmtK(hist);
    wrap.querySelector('#v2TokenLimit').textContent = fmtKU(maxTokens);
    const ratio = maxTokens > 0 ? total / maxTokens : 0;
    const statusEl = wrap.querySelector('#v2TokenStatus');
    statusEl.textContent = ratio < 0.5 ? '空间充足' : (ratio < 0.8 ? '空间紧张' : '空间不足');
    statusEl.classList.remove('status-ok', 'status-warn', 'status-over');
    statusEl.classList.add(ratio >= 0.8 ? 'status-over' : ratio >= 0.5 ? 'status-warn' : 'status-ok');
    const track = wrap.querySelector('.tb-track');
    track.classList.remove('tb-warn', 'tb-over');
    if (ratio >= 0.8) track.classList.add('tb-over');
    else if (ratio >= 0.5) track.classList.add('tb-warn');
    wrap.querySelector('#v2TokenRemain').textContent = fmtKU(Math.max(0, maxTokens - total));
  }
  updateTokenBar();

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
    attachTokens = 0;
    renderTray();
    renderChips();
    updateTokenBar();
    events.onSend(payload);
  }

  sendBtn.addEventListener('click', doSend);
  stopBtn.addEventListener('click', () => events.onStop());
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
  // 自适应高度 + token 聚合条联动
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
    updateTokenBar();
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
        attachTokens = Math.round(f.size / 1024 * FILE_TOKENS_PER_KB);
        renderTray();
        updateTokenBar();
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
        attachTokens = Math.ceil(picked.reduce((sum, p) => sum + (p.total_chars || 0), 0) / 1.5);
        renderTray();
        updateTokenBar();
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
          ${files.map(f => `<label class="kb-pk-item"><input type="checkbox" value="${esc(f.id || f.doc_id || '')}" data-name="${esc(f.filename)}" data-chars="${f.total_chars || 0}"> ${esc(f.filename)}</label>`).join('')}
        </div>
        <div class="kb-pk-acts"><button class="kb-pk-cancel">取消</button><button class="kb-pk-ok">确定</button></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.kb-pk-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.kb-pk-ok').addEventListener('click', () => {
      const picked = [...overlay.querySelectorAll('input:checked')].map(i => ({ id: i.value, doc_id: i.value, filename: i.dataset.name, total_chars: +(i.dataset.chars || 0) }));
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

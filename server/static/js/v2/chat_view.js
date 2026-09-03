// 桌伴 0.10.1 新版 UI — 对话流查看（M1-D：旧会话适配）
// 本版范围：历史消息只读渲染（markdown 走 vendor marked + DOMPurify）。
// 流式发送/卡片回放（CardRenderer）随对话区迁入增量补上。

import { api } from './api.js';
import { renderCardHistory } from './cards.js';
import { extractCards, hydrateCards } from './cards_content.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 卡片系统仅在线参与（PLAN ②+）：离线模式围栏块按普通代码显示
let _cardMode = false;
export function setCardMode(on) { _cardMode = !!on; }

function md(text) {
  if (!text) return '';
  if (typeof marked !== 'undefined') {
    const html = marked.parse(_cardMode ? extractCards(text) : text, { breaks: true });
    if (typeof DOMPurify !== 'undefined') return DOMPurify.sanitize(html);
    return html;
  }
  // vendor 未加载的兜底：转义 + 换行
  return esc(text).replace(/\n/g, '<br>');
}

function _statsLine(m) {
  // 与经典版 footer 对齐：引擎前缀直读 engine 字段（0.10.1 起后端落盘），旧消息回退启发式
  if (!m.model || m.time == null) return '';
  const shortModel = String(m.model).replace(/:.*$/, '');
  const prefix = m.engine
    ? (m.engine === 'local' ? '离线 AI' : '在线 AI')
    : (m.action_mode === 'agent' ? '在线 AI' : '离线 AI');
  const parts = [prefix + ' · ' + shortModel];
  if (m.chars) parts.push(m.chars + '字');
  if (m.think_chars > 0) parts.push('深思' + m.think_chars + '字');
  if (m.time != null) parts.push(Number(m.time).toFixed(1) + 's');
  if (m.speed) parts.push(Math.round(m.speed) + '字/s');
  return parts.join(' · ');
}

const ABORT_LABEL = {
  user_stop: '已手动终止',
  timeout: '响应超时，连接中断',
  network_error: '连接错误，响应中断',
};

function _renderMsg(m) {
  const isUser = m.role === 'user';
  // 0.10.1 定稿：无头像框（用户评审：用处不大还影响视线）；气泡左右分布（我右/AI 左）
  const name = isUser ? ('我' + (m.ts ? ' · ' + m.ts : '')) : ('桌伴' + (m.ts ? ' · ' + m.ts : ''));

  let bubbleInner = '';
  // 附件/引用标记
  if (m._file_tag && m._file_tag.name) {
    bubbleInner += `<span class="fref">📎 ${esc(m._file_tag.name)}</span><br>`;
  }
  bubbleInner += `<div class="${isUser ? '' : 'md-body'}">${isUser ? esc(m.content || '').replace(/\n/g, '<br>') : md(m.content)}</div>`;

  // 思考折叠
  let thinkHtml = '';
  if (m.think && String(m.think).trim()) {
    thinkHtml = `<details class="m-think"><summary>思考过程（${(m.think_chars || String(m.think).length)}字）</summary><div class="m-think-body">${esc(m.think)}</div></details>`;
  }
  // 明盒卡片回放（card_data，与流式固化同构）
  const cardsHtml = renderCardHistory(m);
  // 并行双列回放（local/cloud 原文折叠卡）
  let parHtml = '';
  if (m.parallel_texts && (m.parallel_texts.local || m.parallel_texts.cloud)) {
    const col = (label, txt) => txt ? `<details class="cb-par"><summary>${label}</summary><div class="cb-par-body md">${md(txt)}</div></details>` : '';
    parHtml = '<div class="cb-par-wrap">' + col('离线列', m.parallel_texts.local) + col('在线列', m.parallel_texts.cloud) + '</div>';
  }
  // 中断标记
  const abortedHtml = m._aborted
    ? `<div class="m-aborted">■ ${ABORT_LABEL[m._abort_reason] || '已终止'}</div>` : '';
  // 下载栏（doc_url / artifacts）
  let docBar = '';
  const arts = (m.artifacts && m.artifacts.length) ? m.artifacts
    : (m.doc_url ? [{ url: m.doc_url, filename: m.doc_filename || 'document.docx' }] : []);
  if (arts.length) {
    docBar = '<div class="m-doc-bar">' + arts.map(a => {
      const url = a.url || a.doc_url || '';
      const fn = a.filename || a.doc_filename || 'document.docx';
      return `<a href="${esc(url)}" download="${esc(fn)}" target="_blank">下载 ${esc(fn)}</a>`;
    }).join('') + '</div>';
  }
  const stats = _statsLine(m);
  const statsHtml = stats ? `<div class="m-stats">${esc(stats)}</div>` : '';

  return `<div class="msg ${isUser ? 'user' : 'ai'}">
    <div class="m-body">
      <div class="m-name">${esc(name)}</div>
      ${thinkHtml}
      ${cardsHtml}${parHtml}
      <div class="m-bubble ${isUser ? '' : 'md'}">${bubbleInner}</div>
      ${abortedHtml}${docBar}${statsHtml}
    </div>
  </div>`;
}

// 渲染一个会话的完整消息流；parallel/compare 的卡片回放（card_data）随对话区迁入补齐，
// 本版至少保证正文/引用/统计/下载栏完整可见。
// opts: { getSession() }（卡片「存产物」用）
export function renderChatFlow(container, messages, opts) {
  const flow = document.createElement('div');
  flow.className = 'chat-flow';
  flow.innerHTML = messages.map(_renderMsg).join('');
  container.innerHTML = '';
  container.appendChild(flow);
  if (_cardMode) hydrateCards(flow, opts || {});
  // 滚到底部（最新消息）。同步设置在布局完成前会被滚动夹持清零
  // （后台标签 rAF 又不触发），setTimeout 是唯一能扛住的路径
  setTimeout(() => { container.scrollTop = container.scrollHeight; }, 50);
}

export async function loadMessages(chatName) {
  const r = await fetch('/api/chats/' + encodeURIComponent(chatName) + '/messages');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  return d.messages || [];
}

export { api };

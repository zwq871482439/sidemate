// 桌伴 0.10.1 新版 UI — 对话发送 + SSE 流式（M1-D-3）
// 设计来源：原型 v14 composer + 经典版行为照搬。
// 单写原则（M1-B）：流结束后从后端拉快照重建消息区，前端不做持久化真相。

import { api } from './api.js';
import { renderChatFlow, loadMessages } from './chat_view.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mdInline(text) {
  if (typeof marked !== 'undefined') {
    const html = marked.parse(text || '', { breaks: true });
    return typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html;
  }
  return esc(text || '').replace(/\n/g, '<br>');
}

// ===== 流式会话控制器 =====
export function createChatStream(hooks) {
  // hooks: { onUserMsg(msg), onStreamTick(state), onDone(), onError(msg), getSession(), refreshSessions() }
  let aborter = null;

  async function send(payload) {
    // payload: { text, actionMode, filePath, fileTag, history, docContinue }
    const session = hooks.getSession();
    if (!session) return;

    // 用户消息即刻上屏（M1-B：后端 stream 入口开局落盘，前端只负责即时显示）
    // doc Phase2（doc_continue）不上屏 user 气泡（避免「请基于提纲生成」假消息）
    if (!payload.docContinue) {
      hooks.onUserMsg({
        role: 'user', content: payload.text, ts: _now(),
        _file_tag: payload.fileTag || undefined,
      });
    }

    const body = {
      message: payload.docContinue ? '' : payload.text,
      history: payload.history,
      chat_file: session.path,
      action_mode: payload.actionMode || 'chat',
      file_path: payload.filePath || null,
      user_ts: _now(),
      _file_tag: payload.fileTag || null,
    };
    if (payload.docContinue) body.doc_continue = payload.docContinue;
    if (payload.cardAnswer) body._card_answer = payload.cardAnswer;  // 问答卡回答引用

    aborter = new AbortController();
    const st = {
      text: '', think: '', sources: null, docUrl: '', docName: '',
      status: '', taskType: '', error: '',
      channels: null,  // 并行模式双列：{ local:{text,phase}, cloud:{text,phase} }（首个 channel 事件时惰性创建）
    };
    hooks.onStreamTick(st, 'start');

    try {
      const resp = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: aborter.signal,
      });
      if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = raw.replace(/^data:\s*/, '').trim();
          if (!line || line === '[DONE]') continue;
          let d;
          try { d = JSON.parse(line); } catch (e) { continue; }
          _handleEvent(d, st, hooks);
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') {
        // 用户停止：后端 finally 兜底落盘（M1-B），这里正常收尾
      } else {
        st.error = e.message || '连接错误';
        hooks.onStreamTick(st, 'error');
      }
    }

    aborter = null;
    hooks.onDone();  // 由调用方拉后端快照重建
  }

  function stop() {
    if (aborter) {
      fetch('/api/stop', { method: 'POST' }).catch(() => {});
      aborter.abort();
    }
  }

  return { send, stop, get running() { return !!aborter; } };
}

function _now() { return new Date().toTimeString().slice(0, 8); }

// SSE 事件子集（经典版 56 种里的核心集；卡片类事件转发给 hooks.onCardEvent）
function _handleEvent(d, st, hooks) {
  // PPT 逐页预览事件（M1-E）：直接转视窗，不进卡片区
  if (d.type === 'ppt_page') {
    if (hooks.onPptPage) hooks.onPptPage(d);
    return;
  }
  // 明盒卡片事件（agent_timeline/agent_status/doc_loaded/agent_summary/fetch_hint）
  if (hooks.onCardEvent && ['agent_timeline', 'agent_status', 'doc_loaded', 'agent_summary', 'fetch_hint'].includes(d.type)) {
    hooks.onCardEvent(d);
  }
  switch (d.type) {
    case 'token':
      st.text += d.content || '';
      hooks.onStreamTick(st, 'token');
      break;
    case 'think_token':
      st.think += d.content || '';
      hooks.onStreamTick(st, 'think');
      break;
    case 'agent_think':
      st.think += (d.content && d.content.content) || '';
      if (hooks.onCardEvent) hooks.onCardEvent(d);
      hooks.onStreamTick(st, 'think');
      break;
    case 'stream':
      // 并行/对比模式的 channel 正文：local/cloud 累加进双列，merge/无 channel 进主气泡
      if (d.channel === 'local' || d.channel === 'cloud') {
        if (!st.channels) st.channels = { local: { text: '', phase: '' }, cloud: { text: '', phase: '' } };
        st.channels[d.channel].text += d.content || '';
      } else {
        st.text += d.content || '';
      }
      hooks.onStreamTick(st, 'token');
      break;
    case 'phase':
      // 并行模式列阶段（channel=local/cloud，phase=done 等）
      if (st.channels && d.channel && st.channels[d.channel]) {
        st.channels[d.channel].phase = d.phase || '';
        hooks.onStreamTick(st, 'token');
      }
      break;
    case 'kb_sources':
    case 'sources':
      st.sources = d.sources || null;
      hooks.onStreamTick(st, 'token');
      break;
    case 'doc_outline':
      // 文档 Phase 1 完成：提纲出炉，弹确认栏（经典版同款，v2 由 index 渲染）
      st.outlineText = d.outline || st.text;
      if (hooks.onDocOutline) hooks.onDocOutline(st.outlineText);
      hooks.onStreamTick(st, 'token');
      break;
    case 'doc_ready':
    case 'doc_complete':
      st.docUrl = d.url || d.doc_url || '';
      st.docName = d.filename || d.doc_filename || 'document.docx';
      hooks.onStreamTick(st, 'token');
      break;
    case 'compress':
      st.status = d.msg || '较早的对话已省略';
      hooks.onStreamTick(st, 'token');
      break;
    case 'truncate':
      if (d.content) st.text = d.content;
      hooks.onStreamTick(st, 'token');
      break;
    case 'task_type':
      st.taskType = d.task_type || d.content || '';
      break;
    case 'error':
      st.error = d.content || '生成出错';
      hooks.onStreamTick(st, 'error');
      break;
    case 'done':
      if (hooks.onDoneData) hooks.onDoneData(d);
      break;
    default:
      break;  // 卡片/时间线类事件（agent_timeline 等）随对话区卡片化增量再接
  }
}

// ===== chat.js — 对话核心：消息发送、SSE 流式、渲染（需先加载子模块） =====

var _lastScrollBottom = false;  // 跟踪是否在底部（用于自动滚动）
var _cloudThinkText = '';       // 云端推理模型的思考内容（全局，跨函数共享）
var _cloudThinking = false;     // 是否正在云端推理中
var _agentTimelineEl = null;    // Agent 工具时间线容器 DOM（全局，跨函数共享）
var _agentTimelineData = [];    // Agent 时间线数据收集（用于持久化到消息对象）
var _agentCurrentStepEl = null; // Patch4 v3：当前进行中的步骤 DOM（新步骤开始时它变 done，治闪烁）
var _thinkingTimerInterval = null; // Patch5 C7 B3：思考态计时器
// P6 T04: _skeletonActive 已移除（去骨架屏）
var _agentCurrentStepStartTs = 0; // 当前步骤开始时间戳（用于计算 elapsed）

// ===== 统一渲染器：消息体 HTML 生成 =====
// 流式阶段和最终渲染共用，保证视觉一致
// think 数据保留在消息对象中（给模型作上下文），但不再展示给用户
function _renderMsgBody(content, options) {
  options = options || {};
  // 正文（统一走 md()）— 默认 sanitize=true，流式期间传 {sanitize: false}
  var doSanitize = (options.sanitize !== false);
  return md(content || '', doSanitize);
}

// ===== 消息辅助元素生成 =====
function _buildCopyBtn() {
  return '<button class="msg-copy-btn" onclick="copyMsgContent(this)" title="复制">'
    + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>'
    + '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>'
    + '</svg></button>';
}

function _buildFileTag(m) {
  if (!m._file_tag || m.role !== 'user') return '';
  var ft = m._file_tag;
  var ftIcon = ft.source === 'kb'
    ? '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" style="vertical-align:-1px;margin-right:2px"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="9" y="9" width="5.5" height="5.5" rx="1" stroke="currentColor" stroke-width="1.2"/></svg>'
    : '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" style="vertical-align:-1px;margin-right:2px"><path d="M8 2v8M5 6.5L8 4l3 2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><rect x="2" y="11.5" width="12" height="2" rx="1" stroke="currentColor" stroke-width="1.2"/></svg>';
  return '<div class="msg-file-tag">' + ftIcon + esc(ft.name) + '</div>';
}

function _buildDocDownload(m) {
  if (!m.doc_url || m.role === 'user') return '';
  return '<div class="doc-download-bar"><a href="' + esc(m.doc_url) + '" download="' + esc(m.doc_filename || 'document.docx') + '" class="doc-download-btn" target="_blank"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" style="vertical-align:-1px;margin-right:4px"><path d="M8 2v8M5 6.5L8 4l3 2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><rect x="2" y="11.5" width="12" height="2" rx="1" stroke="currentColor" stroke-width="1.2"/></svg>下载 ' + esc(m.doc_filename || 'document.docx') + '</a></div>';
}

function _buildKbSources(m) {
  if (!m.kb_sources || !m.kb_sources.length || m.role === 'user') return '';
  var html = '<div class="kb-sources-bar"><div class="kb-sources-title">' + iconSvg('books','14') + ' 参考来源</div>';
  m.kb_sources.forEach(function(s, i) {
    html += '<div class="kb-source-item">'
      + '<span class="kb-source-num">' + (i + 1) + '</span>'
      + '<span class="kb-source-label">' + esc(s.label || '来源' + (i+1)) + '</span>'
      + (s.snippet ? '<div class="kb-source-snippet">' + esc(s.snippet) + '</div>' : '')
      + '</div>';
  });
  return html + '</div>';
}

function _buildStats(m) {
  if (!m.model || m.time == null) return '';
  var base = formatStats(m.model, m.chars || 0, m.think_chars || 0, m.time, m.speed || 0);
  // 如果有真实 token 统计，追加显示
  if (m.token_stats) {
    var ts = m.token_stats;
    var parts = [];
    if (ts.input_tokens) parts.push('输入 ' + ts.input_tokens.toLocaleString());
    if (ts.output_tokens) parts.push('输出 ' + ts.output_tokens.toLocaleString());
    if (ts.reasoning_tokens) parts.push('推理 ' + ts.reasoning_tokens.toLocaleString());
    if (parts.length) {
      base = base.replace('</div>', '') + ' <span class="token-stats">' + parts.join(' ') + '</span></div>';
    }
  }
  return base;
}

// ===== P6 T04: AgentTimeline SSE 事件处理 =====
var _agentTimelineStepLabels = {
  retrieve: '检索知识库',
  local_gen: '本地生成答案',
  cloud_gen: '云端补充',
  merge: '自动融合优化'
};

function _handleAgentTimelineSSE(d) {
  var streamEl = document.getElementById('stream-msg');
  if (!streamEl) return;

  var container = document.getElementById('agent-timeline');
  if (!container) {
    // 创建 AgentTimeline 容器，放在 stream-msg 最上方
    container = document.createElement('div');
    container.id = 'agent-timeline';
    container.className = 'agent-timeline-container';
    // 插入到 stream-msg 的第一个子节点位置（或 append）
    if (streamEl.firstChild) {
      streamEl.insertBefore(container, streamEl.firstChild);
    } else {
      streamEl.appendChild(container);
    }
    _agentTimelineEl = container;
  }

  var step = d.step;
  var phase = d.phase;  // "start" | "done"
  var label = _agentTimelineStepLabels[step] || (d.label || step);

  if (phase === 'start') {
    // 创建新步骤节点 — P6 审计修复：用 SVG 圆环替代实心圆，让 spin 动画有视觉反馈
    var stepEl = document.createElement('div');
    stepEl.className = 'agent-tl-step';
    stepEl.setAttribute('data-step', step);
    stepEl.innerHTML =
      '<span class="agent-tl-icon spin"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5" opacity="0.3"/><path d="M7 2a5 5 0 015 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>' +
      '<span class="agent-tl-label">' + _esc(label) + '</span>' +
      '<span class="agent-tl-time"></span>';
    container.appendChild(stepEl);
    _agentCurrentStepEl = stepEl;
    // 记录开始时间
    _agentCurrentStepStartTs = Date.now();
  } else if (phase === 'done') {
    // 找到对应步骤节点并标记完成
    var stepEl2 = container.querySelector('[data-step="' + step + '"]');
    if (stepEl2) {
      var iconEl = stepEl2.querySelector('.agent-tl-icon');
      var timeEl = stepEl2.querySelector('.agent-tl-time');
      if (iconEl) {
        iconEl.classList.remove('spin');
        iconEl.classList.add('done');
      }
      if (timeEl) {
        var elapsed = d.elapsed_ms != null ? d.elapsed_ms : (Date.now() - _agentCurrentStepStartTs);
        if (elapsed >= 1000) {
          timeEl.textContent = (elapsed / 1000).toFixed(1) + 's';
        } else {
          timeEl.textContent = elapsed + 'ms';
        }
      }
      stepEl2.classList.add('done');
    }
    // 收集到时间线数据（用于持久化）
    _agentTimelineData.push({
      step: step,
      elapsed_ms: d.elapsed_ms || (Date.now() - _agentCurrentStepStartTs),
      count: d.count
    });
  }
}

// P6 打磨：并行模式流式内容渲染到对应 timeline 步骤
var _parallelChannelRendered = {};  // 记录每个 channel 的 rendered 行数（带行号）

function _renderParallelChannelContent(channel, fullContent, newChunk) {
  var container = document.getElementById('agent-timeline');
  if (!container) return;

  var stepId = channel === 'local' ? 'local_gen' : (channel === 'cloud' ? 'cloud_gen' : 'merge');
  var stepEl = container.querySelector('[data-step="' + stepId + '"]');
  if (!stepEl) return;

  // 获取或创建内容区域
  var contentEl = stepEl.querySelector('.agent-tl-content');
  if (!contentEl) {
    contentEl = document.createElement('div');
    contentEl.className = 'agent-tl-content';
    contentEl.style.cssText = 'margin-top:4px;padding:6px 8px;background:var(--bg-tertiary,var(--bg-secondary));border-radius:4px;font-size:11px;line-height:1.5;max-height:200px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;color:var(--text-secondary)';
    var labelEl = stepEl.querySelector('.agent-tl-label');
    if (labelEl) {
      labelEl.parentNode.insertBefore(contentEl, labelEl.nextSibling);
    } else {
      stepEl.appendChild(contentEl);
    }
  }

  // 流式追加：用 requestAnimationFrame 控制刷新率
  if (!contentEl.__lastUpdate || Date.now() - contentEl.__lastUpdate > 60) {
    contentEl.textContent = fullContent;
    contentEl.__lastUpdate = Date.now();
    // 自动滚底
    contentEl.scrollTop = contentEl.scrollHeight;
  }

  // 如果这个 step 还在 spin 状态（进行中），保持同步
  var iconEl = stepEl.querySelector('.agent-tl-icon');
  if (iconEl && iconEl.classList.contains('spin')) {
    // 仍在进行中，保留 spin 动画
  }
}

// P6 打磨：并行模式检索结果展示
function _renderParallelSources(channel, items) {
  var container = document.getElementById('agent-timeline');
  if (!container) return;

  var stepEl = container.querySelector('[data-step="retrieve"]');
  if (!stepEl) return;

  var contentEl = stepEl.querySelector('.agent-tl-content');
  if (!contentEl) {
    contentEl = document.createElement('div');
    contentEl.className = 'agent-tl-content';
    contentEl.style.cssText = 'margin-top:4px;padding:6px 8px;background:var(--bg-tertiary,var(--bg-secondary));border-radius:4px;font-size:11px;line-height:1.5;max-height:160px;overflow-y:auto;color:var(--text-secondary)';
    var labelEl = stepEl.querySelector('.agent-tl-label');
    if (labelEl) {
      labelEl.parentNode.insertBefore(contentEl, labelEl.nextSibling);
    } else {
      stepEl.appendChild(contentEl);
    }
  }

  var html = '';
  if (items && items.length > 0) {
    html += '检索到 ' + items.length + ' 篇文档：';
    for (var i = 0; i < Math.min(items.length, 5); i++) {
      var item = items[i];
      var name = (typeof item === 'string') ? item : (item.filename || item.title || item.name || '');
      var score = (typeof item === 'object') ? (item.score || item.relevance || '') : '';
      html += '\n  · ' + _esc(name || '文档 #' + (i+1));
      if (score) html += ' (相关度: ' + (typeof score === 'number' ? score.toFixed(2) : score) + ')';
    }
  }
  contentEl.textContent = html || '未检索到相关文档';
}

// 清理并行模式状态
function _resetParallelState() {
  window._parallelChannelTexts = {};
  _parallelChannelRendered = {};
}
window._resetParallelState = _resetParallelState;

function _buildAgentTimelineHtml(timelineData) {
  if (!timelineData || !timelineData.length) return '';
  var html = '<div class="agent-timeline">';
  timelineData.forEach(function(item) {
    // P6: parallel 模式 timeline（item.step 格式）
    if (item.step) {
      var elapsedTxt = '';
      if (item.elapsed_ms != null) {
        elapsedTxt = item.elapsed_ms >= 1000 ? (item.elapsed_ms / 1000).toFixed(1) + 's' : item.elapsed_ms + 'ms';
      }
      var countTxt = (item.count != null) ? '（' + item.count + ' 篇）' : '';
      var label = '';
      var icon = 'check';
      switch (item.step) {
        case 'retrieve':  label = '本地知识库检索' + countTxt; icon = 'books'; break;
        case 'local_gen': label = '本地 AI 生成回答'; icon = 'brain'; break;
        case 'cloud_gen': label = '云端 AI 补充'; icon = 'cloud'; break;
        case 'merge':     label = '自动融合优化'; icon = 'refresh'; break;
        default: return;
      }
      html += '<div class="agent-step agent-step-parallel">' +
        '<span class="agent-icon agent-done">' + iconSvg(icon, '14') + '</span>' +
        '<span class="agent-label">' + label + '</span>' +
        '<span class="agent-time">' + elapsedTxt + '</span>' +
        '</div>';
      return;
    }
    // summary 特殊处理
    if (item.status === '_summary') {
      var d = item.data || {};
      var parts = [];
      if (d.searches) parts.push('搜索了 ' + d.searches + ' 次');
      if (d.fetches) parts.push('抓取了 ' + d.fetches + ' 个网页');
      if (d.kb_hits) parts.push('检索了 ' + d.kb_hits + ' 篇文档');
      if (d.docs) parts.push('生成了 ' + d.docs + ' 个文档操作');
      if (d.elapsed) parts.push('用时 ' + d.elapsed + ' 秒');
      if (parts.length) {
        html += '<div class="agent-timeline-summary"><span class="agent-tl-summary-icon">' + iconSvg('doc','14') + '</span> ' + parts.join(' \xB7 ') + '</div>';
      }
      return;
    }
    // 普通状态步骤
    var stepHtml = '';
    switch (item.status) {
      case 'thinking':
        stepHtml = '<span class="agent-icon agent-done">' + iconSvg('check','14') + '</span> <span class="agent-label">思考完成</span>';
        break;
      case 'searching':
        stepHtml = '<span class="agent-icon agent-done">' + iconSvg('books','14') + '</span> <span class="agent-label">正在搜索「' + _esc(item.query || '') + '」</span>';
        break;
      case 'search_done':
        stepHtml = '<span class="agent-icon agent-done">' + iconSvg('check','14') + '</span> <span class="agent-label">找到 ' + (item.count || 0) + ' 个网页</span>';
        break;
      case 'fetching':
        stepHtml = '<span class="agent-icon agent-done">' + iconSvg('idea','14') + '</span> <span class="agent-label">正在阅读 ' + _esc(item.url || '') + '</span>';
        break;
      case 'fetch_done':
        stepHtml = '<span class="agent-icon agent-done">' + iconSvg('check','14') + '</span> <span class="agent-label">获取 ' + (item.length || 0) + ' 字内容</span>';
        break;
      case 'kb_searching':
        stepHtml = '<span class="agent-icon agent-done">' + iconSvg('books','14') + '</span> <span class="agent-label">检索知识库「' + _esc(item.query || '') + '」</span>';
        break;
      case 'kb_done':
        stepHtml = '<span class="agent-icon agent-done">' + iconSvg('check','14') + '</span> <span class="agent-label">找到 ' + (item.count || 0) + ' 篇相关文档</span>';
        break;
      // Patch4 v3：workspace / docs 工具（历史回放，统一 done 样式）
      case 'workspace_writing':
      case 'workspace_write_done':
        stepHtml = '<span class="agent-icon agent-done">' + iconSvg('write','14') + '</span> <span class="agent-label">写入 ' + _esc(item.name || item.path || '') + '</span>';
        break;
      case 'workspace_reading':
      case 'workspace_read_done':
        stepHtml = '<span class="agent-icon agent-done">' + iconSvg('doc','14') + '</span> <span class="agent-label">读取 ' + _esc(item.name || item.path || '') + '</span>';
        break;
      case 'workspace_listing':
      case 'workspace_listed':
        stepHtml = '<span class="agent-icon agent-done">' + iconSvg('doc','14') + '</span> <span class="agent-label">列出工作区文件（' + (item.count || 0) + '）</span>';
        break;
      case 'workspace_deleting':
      case 'workspace_deleted':
        stepHtml = '<span class="agent-icon agent-done">' + iconSvg('trash','14') + '</span> <span class="agent-label">删除 ' + _esc(item.name || item.path || '') + '</span>';
        break;
      // Patch4 v3.1 BUG#3 修复：append/edit workspace 状态映射
      case 'workspace_appending':
      case 'workspace_appended':
        stepHtml = '<span class="agent-icon agent-done">' + iconSvg('write','14') + '</span> <span class="agent-label">追加 ' + _esc(item.name || item.path || '') + '</span>';
        break;
      case 'workspace_editing':
      case 'workspace_edited':
        stepHtml = '<span class="agent-icon agent-done">' + iconSvg('write','14') + '</span> <span class="agent-label">编辑 ' + _esc(item.name || item.path || '') + '</span>';
        break;
      case 'docs_listing':
      case 'docs_listed':
        stepHtml = '<span class="agent-icon agent-done">' + iconSvg('doc','14') + '</span> <span class="agent-label">列出文档（' + (item.count || 0) + '）</span>';
        break;
      case 'doc_status_updating':
      case 'doc_status_done':
        stepHtml = '<span class="agent-icon agent-done">' + iconSvg('check','14') + '</span> <span class="agent-label">生成 ' + _esc(item.docx_path || item.filename || '') + '</span>';
        break;
      case 'budget_exceeded':
        stepHtml = '<span class="agent-icon agent-warn">' + iconSvg('warn','14') + '</span> <span class="agent-label">信息已收集完毕，正在撰写回复...</span>';
        break;
      case 'tool_limited':
        stepHtml = '<span class="agent-icon agent-warn">' + iconSvg('warn','14') + '</span> <span class="agent-label">部分工具已达上限</span>';
        break;
      case 'error':
        // Patch4 v3.1 BUG#17：按工具类型差异化文案
        var _errMsg = '工具执行失败';
        var _toolName = (item.tool || '').toLowerCase();
        if (_toolName.indexOf('search_web') === 0) _errMsg = '外部搜索暂时不可用，已用模型自身知识回答';
        else if (_toolName.indexOf('fetch_url') === 0) _errMsg = '网页暂时无法访问，已跳过';
        else if (_toolName.indexOf('search_kb') === 0) _errMsg = '知识库检索异常，使用模型自身知识';
        stepHtml = '<span class="agent-icon agent-error">' + iconSvg('cross','14') + '</span> <span class="agent-label">' + _errMsg + '</span>';
        break;
      default:
        return;  // 未知状态跳过
    }
    html += '<div class="agent-step agent-step-' + (item.status || 'default') + '">' + stepHtml + '</div>';
  });
  html += '</div>';
  return html;
}

// ===== 最终渲染（消息列表）=====
function _renderSingleMsg(m, idx) {
  var ts = m.ts ? '<div class="ts">' + esc(m.ts) + '</div>' : '';
  // think 数据保留在 m.think 中（模型上下文），但不再渲染展示
  var bodyHtml = _renderMsgBody(m.content || '');
  // Patch5 C7：如果页面上已有活跃的 AgentTimeline（流式时建的），
  // 不重复渲染 m.agent_timeline（否则鱼骨出现两份）
  var _hasLiveTimeline = (_agentTimelineEl && _agentTimelineEl.parentNode);
  var timelineHtml = _hasLiveTimeline ? '' : _buildAgentTimelineHtml(m.agent_timeline);
  var html = '<div class="msg-copy-wrap">'
    + timelineHtml + ts + bodyHtml;
  // Patch4 v3.1 BUG#13+17：如果消息有 doc_url，追加独立下载栏（刷新页面也能看到）
  if (m.doc_url) {
    var _dlUrl = m.doc_url;
    if (_dlUrl.indexOf('http') !== 0) _dlUrl = (typeof API !== 'undefined' ? API : '') + _dlUrl;
    html += '<div class="doc-download-bar" data-doc-complete="1"><a href="' + esc(_dlUrl) + '" download="' + esc(m.doc_filename || 'document.docx') + '" class="doc-download-btn" target="_blank">' + iconSvg('doc','14') + ' 下载 ' + esc(m.doc_filename || 'document.docx') + '</a></div>';
  }
  html += _buildFileTag(m) + _buildStats(m) + _buildKbSources(m) + _buildCopyBtn();
  html += '</div>';
  return html;
}

function renderMsg(m) {
  var cls = m.role === 'user' ? 'user' : 'ai';
  var variantCls = m.superseded ? ' superseded' : (m.variant_of != null ? ' variant-new' : '');
  return '<div class="msg ' + cls + variantCls + '" data-hash="' + esc(m.msg_hash || '') + '">' + _renderSingleMsg(m, 0) + '</div>';
}

function renderMessages() {
  var el = document.getElementById('messages');
  if (!currentMessages.length) {
    var tag = document.getElementById('modelTag');
    var loaded = tag && !tag.classList.contains('none');
    if (loaded) {
      // Patch4 v3.1 文案优化：根据模式动态显示引导
      // Patch5 C7：用 iconSvg 替代 emoji，去掉多余 💡
      var _isCloud = (typeof _currentMode !== 'undefined' && _currentMode === 'cloud');
      var _hint = _isCloud
        ? '输入问题、上传文件，或直接说「帮我写一份关于XX的文档」'
        : '输入问题或上传文件开始使用';
      el.innerHTML = '<div class="empty-state">' +
        '<div style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:36px 14px">' +
          '<div style="opacity:.4">' + iconSvg('chat','32') + '</div>' +
          '<div style="font-weight:500;color:var(--text-primary);font-size:1em">开始你的第一次对话</div>' +
          '<div style="font-size:.92em;color:var(--text-secondary);margin-top:6px;font-weight:400">' + _hint + '</div>' +
          '<div style="font-size:.78em;color:var(--text-muted);margin-top:10px;display:flex;gap:12px;justify-content:center;align-items:center">' +
            '<span>' + iconSvg('file','11') + ' 可上传 PDF/Word/TXT</span>' +
            '<span>·</span>' +
            '<span>' + iconSvg('book','11') + ' 支持引用文库文档</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    } else {
      // 首次/非首次无模型：留空，由 #chatModelOverlay 接管
      el.innerHTML = '';
    }
    return;
  }
  // 增量追加（跳过仅含 .empty-state 的情况，走全量渲染）
  var existingNodes = el.children;
  var existingCount = existingNodes.length;
  var hasOnlyEmptyState = existingCount === 1 && existingNodes[0].classList.contains('empty-state');
  if (!hasOnlyEmptyState && existingCount > 0 && currentMessages.length > existingCount) {
    for (var ni = existingCount; ni < currentMessages.length; ni++) {
      var m2 = currentMessages[ni];
      var div = document.createElement('div');
      div.className = 'msg ' + (m2.role === 'user' ? 'user' : 'ai') + ' new-msg' + (m2.superseded ? ' superseded' : '') + (m2.variant_of != null ? ' variant-new' : '');
      div.setAttribute('data-idx', ni);
      div.innerHTML = _renderSingleMsg(m2, ni);
      el.appendChild(div);
    }
    applyCodeHighlight(el);
    if (typeof CodeBlockEnhancer !== 'undefined') CodeBlockEnhancer.enhance(el);
    if (_lastScrollBottom) { el.scrollTop = el.scrollHeight; }
    return;
  }
  el.innerHTML = currentMessages.map(function(m) { return renderMsg(m); }).join('');
  applyCodeHighlight(el);
  if (typeof CodeBlockEnhancer !== 'undefined') CodeBlockEnhancer.enhance(el);
}

// ===== 流式渲染（性能优化：50ms 节流）=====
var _streamRenderPending = false;

function appendStreamingMsg(content, think, thinkLen, stats, isThinking) {
  var msgEl2 = document.getElementById('messages');
  var userScrolledUp = msgEl2 ? (msgEl2.scrollHeight - msgEl2.scrollTop - msgEl2.clientHeight > 120) : false;
  _lastScrollBottom = !userScrolledUp;

  var el = document.getElementById('messages');
  var empty = el.querySelector('.empty-state');
  if (empty) empty.remove();

  var streamEl = document.getElementById('stream-msg');
  if (!streamEl) {
    streamEl = document.createElement('div');
    streamEl.id = 'stream-msg';
    streamEl.className = 'msg ai';
    el.appendChild(streamEl);
  }

  // 保留已有的 Agent 时间线（不覆盖）
  var preservedTimeline = null;
  if (_agentTimelineEl && _agentTimelineEl.parentNode === streamEl) {
    preservedTimeline = _agentTimelineEl;
  }

  // Patch4 v3.1：保留进度面板 DOM（避免被 innerHTML 覆盖）
  // 加固：即使面板已不在 streamEl 里（被前一次重写清掉），只要 tracker 还活着就重新插回
  var preservedDocPanel = null;
  if (typeof _docProgressTracker !== 'undefined' && _docProgressTracker && _docProgressTracker.panelEl) {
    preservedDocPanel = _docProgressTracker.panelEl;  // 不限 parentNode，强制保留
  }

  // Patch4 v3.1 BUG#13：保留独立的下载栏（doc_complete 时追加的）
  var preservedDocDlBar = null;
  var _existingDlBar = streamEl.querySelector('.doc-download-bar[data-doc-complete="1"]');
  if (_existingDlBar) {
    preservedDocDlBar = _existingDlBar;
  }

  var html = '';
  if (isThinking) {
    // P6 T04: 骨架屏已移除，只需检查非云端模式
    var _isCloudMode = (typeof _currentMode !== 'undefined' && _currentMode === 'cloud');
    if (!_isCloudMode) {
      // 本地模式 + 骨架屏已隐藏：动画点 + "思考中" + 计时
      html += '<div class="thinking-indicator"><span class="thinking-dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span> 思考中 <span class="thinking-timer" data-start="' + Date.now() + '">0.0s</span></div>';
      // 启动计时器
      if (_thinkingTimerInterval) clearInterval(_thinkingTimerInterval);
      _thinkingTimerInterval = setInterval(function() {
        var timers = document.querySelectorAll('.thinking-timer');
        if (!timers.length) {
          clearInterval(_thinkingTimerInterval);
          _thinkingTimerInterval = null;
          return;
        }
        timers.forEach(function(t) {
          var start = parseInt(t.getAttribute('data-start') || '0', 10);
          if (start) t.textContent = ((Date.now() - start) / 1000).toFixed(1) + 's';
        });
      }, 100);
    }
    if (content) {
      html += '<div style="color:var(--text-muted);font-style:italic;font-size:.85em">' + md(content, false) + '</div>';
    }
  } else {
    html += _renderMsgBody(content, {sanitize: false});
  }
  if (stats) html += stats;

  // 流式完成后添加复制按钮
  if (stats) {
    html = '<div class="msg-copy-wrap">' + html + _buildCopyBtn() + '</div>';
  }

  streamEl.innerHTML = html;

  // 恢复 Agent 时间线（在正文之前）
  if (preservedTimeline && _agentTimelineEl) {
    streamEl.insertBefore(_agentTimelineEl, streamEl.firstChild);
  }

  // Patch4 v3.1 BUG#13+17：恢复进度面板（强制重新插入，确保 done 后不消失）
  // 每次重写 innerHTML 后都重新插回，不要只依赖 preserved 判断
  if (typeof _docProgressTracker !== 'undefined' && _docProgressTracker && _docProgressTracker.panelEl) {
    // 如果面板不在 streamEl 里（被 innerHTML 清掉了），重新插回
    if (_docProgressTracker.panelEl.parentNode !== streamEl) {
      streamEl.insertBefore(_docProgressTracker.panelEl, streamEl.firstChild);
    }
  }

  // Patch4 v3.1 BUG#13：恢复独立下载栏（追加到末尾，正文之后）
  if (preservedDocDlBar) {
    streamEl.appendChild(preservedDocDlBar);
  }
  // Patch4 v3.1 BUG#13 加固：如果下载栏没保留住但 _docDownloadInfo 还在，重建一个
  if (!preservedDocDlBar && window._docDownloadInfo && window._docDownloadInfo.url) {
    var _rebuildDlBar = document.createElement('div');
    _rebuildDlBar.className = 'doc-download-bar';
    _rebuildDlBar.setAttribute('data-doc-complete', '1');
    var _rebuildUrl = window._docDownloadInfo.url;
    if (_rebuildUrl.indexOf('http') !== 0) {
      _rebuildUrl = (typeof API !== 'undefined' ? API : '') + _rebuildUrl;
    }
    _rebuildDlBar.innerHTML = '<a href="' + esc(_rebuildUrl) + '" download="' + esc(window._docDownloadInfo.filename || 'document.docx') + '" class="doc-download-btn" target="_blank">' + iconSvg('doc','14') + ' 下载 ' + esc(window._docDownloadInfo.filename || 'document.docx') + '</a>';
    streamEl.appendChild(_rebuildDlBar);
  }

  if (!userScrolledUp) {
    el.scrollTop = el.scrollHeight;
  }
}

// 渲染云端推理模型的流式思考内容（实时 <details open>）
// text: 思考内容, mainText: 正文内容（可选，用于思考+正文并行显示）
function _renderCloudThink(text, mainText) {
  var streamEl = document.getElementById('stream-msg');
  if (!streamEl) return;
  text = text || '';
  mainText = mainText || '';
  var len = text.length;
  var html = '';

  // 保留已有的 Agent 时间线
  var preservedTimeline = null;
  if (_agentTimelineEl && _agentTimelineEl.parentNode === streamEl) {
    preservedTimeline = _agentTimelineEl;
  }

  // Patch4 v3.1：保留进度面板 DOM（加固，不限 parentNode）
  var preservedDocPanel = null;
  if (typeof _docProgressTracker !== 'undefined' && _docProgressTracker && _docProgressTracker.panelEl) {
    preservedDocPanel = _docProgressTracker.panelEl;
  }

  // Patch4 v3.1 BUG#10 根治：完全不再用 thinking-indicator（"正在思考"）
  // AgentTimeline 已负责"思考中..."状态展示，这里只显示 think-details（思考内容详情，可折叠）
  // 字数>=20 才显示 think-details，字数少时什么都不显示（避免空 details）
  if (len >= 20) {
    html += '<details open class="think-details"><summary>' + iconSvg('think','14') + ' 思考内容 (' + len + '字)</summary><div class="think-content">' + md(text, false) + '</div></details>';
  }
  // len < 20 时不显示任何思考 UI（AgentTimeline 的"思考中..."已经够了）
  if (mainText) html += _renderMsgBody(mainText, {sanitize: false});
  streamEl.innerHTML = html;

  // 恢复 Agent 时间线
  if (preservedTimeline && _agentTimelineEl) {
    streamEl.insertBefore(_agentTimelineEl, streamEl.firstChild);
  }
  // Patch4：恢复进度面板
  if (preservedDocPanel) {
    streamEl.insertBefore(preservedDocPanel, streamEl.firstChild);
  }

  // 自动滚底
  var msgEl = document.getElementById('messages');
  if (msgEl && _lastScrollBottom) {
    msgEl.scrollTop = msgEl.scrollHeight;
  }
}

function onInputKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  if (e.key === 'Tab') { e.preventDefault(); }
}

// ===== Patch2 A7: 上下文使用量（per-session） =====
async function fetchContextUsage() {
  try {
    var url = (typeof API !== 'undefined' ? API : '') + '/api/context/usage';
    // 传递当前会话文件给后端，确保 per-session 正确计算
    if (typeof currentChatFile !== 'undefined' && currentChatFile) {
      url += '?chat_file=' + encodeURIComponent(currentChatFile);
    }
    var resp = await fetch(url);
    var data = await resp.json();
    updateContextRing(data.percentage || 0, data.level || 'normal', data.used_tokens || 0, data.total_tokens || 0);
  } catch(e) { /* 后端未实现时静默忽略 */ }
}
function updateContextRing(percentage, level, used, total) {
  // P6: 同步历史 token 到统一 Token 条
  if (typeof _historyTokenCount === 'undefined') window._historyTokenCount = 0;
  window._historyTokenCount = used || 0;
  if (typeof TokenEstimator !== 'undefined' && TokenEstimator.updateInputDisplay) {
    TokenEstimator.updateInputDisplay();
  }
  // 旧 contextRing DOM 已删除，不再更新
}

// ===== 发送消息 =====
async function sendMessage() {
  var input = document.getElementById('msgInput');
  var text = input.value.trim();
  if (!text && (typeof pendingFile !== 'undefined') && !pendingFile) return;
  if (typeof generating !== 'undefined' && generating) return;

  var modelTag = document.getElementById('modelTag');
  var isLocalMode = typeof _currentMode === 'undefined' || _currentMode !== 'cloud';
  if (isLocalMode && modelTag && modelTag.classList.contains('none')) {
    showToast('请先在「设置」页面加载模型，再开始对话', 'warning');
    return;
  }

  // Patch5 G：文档 token 预检 — 超过当前模型上下文窗口 95% 直接拒绝发送
  if (typeof TokenEstimator !== 'undefined') {
    var _docTok = TokenEstimator._estimateDoc();
    var _maxTok = (typeof _maxPromptTokens !== 'undefined') ? _maxPromptTokens : 16000;
    // 预留至少 2000 token 给 system + history + 输出
    var _threshold = Math.max(2000, _maxTok - 2000);
    if (_docTok > _threshold) {
      var _overBy = _docTok - _threshold;
      showToast('文档过大（约 ' + (_docTok/1000).toFixed(1) + 'K tokens，超过可用空间 ' + (_overBy/1000).toFixed(1) + 'K）。请换更小的文档，或切换到云端模式', 'error', 6000);
      console.warn('[sendMessage] 文档 token 超阈值: doc=%d threshold=%d max=%d', _docTok, _threshold, _maxTok);
      return;
    }
  }

  // Patch5 修复：空状态发消息时自动新建 session
  if (typeof currentChatFile === 'undefined' || !currentChatFile) {
    if (typeof newChat === 'function') {
      try {
        await newChat();
      } catch (e) {
        console.warn('[sendMessage] 自动新建会话失败:', e.message);
        showToast('创建会话失败，请手动点击「新对话」', 'error');
        return;
      }
    }
    // newChat 完成后再次检查
    if (typeof currentChatFile === 'undefined' || !currentChatFile) {
      showToast('会话未就绪，请手动点击「新对话」', 'warning');
      return;
    }
  }

  // 提前捕获文件名和来源（在 clear 之前）
  var uploadedFilePath = null;
  var _sentFileName = (typeof _pendingFileName !== 'undefined') ? _pendingFileName : '';
  var _sentFileSource = (typeof _pendingFileSource !== 'undefined') ? _pendingFileSource : '';

  var ts = new Date().toTimeString().slice(0,8);
  var userMsg = {role:'user', content: text, ts: ts};
  // 附件文件标签（立即可见）
  if (_sentFileName) {
    userMsg._file_tag = {name: _sentFileName, source: _sentFileSource || 'upload'};
  }
  currentMessages.push(userMsg);
  _lastMsgCount = currentMessages.length;

  // 立即锁住 session poll，防止竞态覆盖用户消息
  generating = true;

  renderMessages();
  input.value = '';
  input.style.height = 'auto';

  var msgEl3 = document.getElementById('messages');
  if (msgEl3) { msgEl3.scrollTop = msgEl3.scrollHeight; }

  // 文件上传处理
  // 三种 pendingFile 形态：
  //   1) File 对象（刚选择，未上传）→ 立即上传到 workspace/，取返回的 path
  //   2) {path, source:'upload'}（chat-files.js 已预上传）→ 直接用 path
  //   3) {path, source:'kb'}（KB 引用，path 是 doc_id）→ 直接用 path
  if ((typeof pendingFile !== 'undefined') && pendingFile && userMsg) {
    var _alreadyHasPath = (typeof pendingFile.path === 'string') && pendingFile.path;
    if (_alreadyHasPath) {
      // 形态 2/3：已经上传过（upload）或不需要上传（kb）→ 直接用 path
      uploadedFilePath = pendingFile.path;
      var _refLabel = pendingFile.source === 'kb'
        ? ('[用户引用了文库文档: ' + (pendingFile.name || '') + '，请读取并参考]')
        : ('[用户上传了文件: ' + (pendingFile.name || '') + '，请读取并参考]');
      userMsg.content += '\n\n' + _refLabel;
      pendingFile = null;
    } else {
      // 形态 1：真实 File 对象，需要上传
      try {
        var fd2 = new FormData();
        fd2.append('file', pendingFile);
        var _uploadChatId = '';
        if (typeof currentChatFile !== 'undefined' && currentChatFile) {
          _uploadChatId = currentChatFile.split(/[\\/]/).pop().replace('.json','');
        }
        var _uploadUrl = (typeof API !== 'undefined' ? API : '') + '/api/file_upload';
        if (_uploadChatId) _uploadUrl += '?chat_id=' + encodeURIComponent(_uploadChatId);
        var fileResp = await fetch(_uploadUrl, {method: 'POST', body: fd2});
        var fileData = await fileResp.json();
        if (fileData.path) {
          userMsg.content += '\n\n[用户上传了文件: ' + (pendingFile.name || '') + '，请读取并参考]';
          uploadedFilePath = fileData.path;
        }
      } catch(e) { console.error('[chat.sendMessage.fileUpload]', e); }
      pendingFile = null;
    }
  }
  // 在 clearFileRef 之前保存引用路径
  var _savedRefPath = (typeof _refFilePath !== 'undefined') ? _refFilePath : null;
  // 保存到全局供 confirmDocOutline 使用（doc_action Phase 1→Phase 2 引用传递）
  window._savedRefPathForDoc = _savedRefPath;
  // KB 引用也捕获文件名
  if (_savedRefPath && !_sentFileName) {
    _sentFileSource = 'kb';
  }
  if (typeof clearFileRef === 'function') clearFileRef();
  if (typeof hideFileIndicator === 'function') hideFileIndicator();
  if (typeof pauseHeartbeat === 'function') pauseHeartbeat();
  document.getElementById('sendBtn').style.display = 'none';
  document.getElementById('stopBtn').style.display = '';
  input.disabled = true;
  // P6 审计修复：DOM 元素可能已被移除（sessionSelect 等在 P6 重构中删除）
  var _ss = document.getElementById('sessionSelect');
  if (_ss) _ss.disabled = true;
  var _nc = document.getElementById('newChatBtn');
  if (_nc) _nc.disabled = true;
  var _dc = document.getElementById('delChatBtn');
  if (_dc) _dc.disabled = true;

  _agentTimelineEl = null;  // 重置 Agent 时间线容器
  _agentTimelineData = [];  // 重置时间线数据收集
  _agentCurrentStepEl = null;  // Patch4 v3：重置当前步骤
  _agentCurrentStepStartTs = 0;
  _resetParallelState();  // P6 打磨：重置并行模式流式状态

  appendStreamingMsg('', '', 0, null, true);
  var msgEl = document.getElementById('messages');
  msgEl.scrollTop = msgEl.scrollHeight;

  abortCtrl = new AbortController();
  // Patch4 修复 5：重置文档进度面板
  if (typeof _resetDocProgress === 'function') _resetDocProgress();
  var thinkingPhase = false;
  var currentTaskType = 'text';  // Patch5 C7：默认设为 text，避免首帧因空字符串误进 thinkingPhase
  var localMaxPromptTokens = (typeof _maxPromptTokens !== 'undefined') ? _maxPromptTokens : 0;

  // P6 修复：fullText 必须在 SSE 循环之前声明（并行模式无 token 事件，直接走 stream 事件）
  var fullText = '';
  var thinkText = '';
  var thinkLen = 0;
  var _hadError = false;

  var lastRender = 0;
  var RENDER_INTERVAL = (typeof STREAM_RENDER_INTERVAL !== 'undefined') ? STREAM_RENDER_INTERVAL : 100;

  try {
    var history = currentMessages.slice(0, -1);
    history = history.filter(function(m) {
      if (m.role === 'assistant' && m.content) {
        if (m.content.startsWith('[ERROR]') || m.content.includes('[TIMEOUT')) return false;
      }
      return true;
    });

    // Patch5 C7: 清除上下文 — 只取最后一个 context_cutoff 标记之后的消息
    var _cutoffIdx = -1;
    for (var ci = 0; ci < history.length; ci++) {
      if (history[ci] && history[ci].context_cutoff) _cutoffIdx = ci;
    }
    if (_cutoffIdx >= 0) {
      history = history.slice(_cutoffIdx + 1);
      console.log('[CHAT] context_cutoff at idx %d, history trimmed to %d msgs', _cutoffIdx, history.length);
    }

    var endpoint = '/api/chat/stream';

    // Token 粗估
    if (localMaxPromptTokens > 0) {
      var SYSTEM_TOKEN_RESERVE = 300;
      var CHARS_PER_TOKEN = 1.5;
      var historyChars = history.reduce(function(sum, m) { return sum + (m.content || '').length; }, 0);
      var userChars = text.length;
      var estimatedTokens = SYSTEM_TOKEN_RESERVE + Math.ceil((historyChars + userChars) / CHARS_PER_TOKEN);
      if (estimatedTokens > localMaxPromptTokens * 0.9) {
        var budget = Math.floor((localMaxPromptTokens - SYSTEM_TOKEN_RESERVE) * CHARS_PER_TOKEN * 0.85);
        var keptChars = userChars;
        var trimmedHistory = [];
        for (var hi = history.length - 1; hi >= 0; hi--) {
          var c = (history[hi].content || '').length;
          if (keptChars + c > budget) break;
          trimmedHistory.unshift(history[hi]);
          keptChars += c;
        }
        if (trimmedHistory.length < history.length) {
          console.warn('[Token预检] 历史过长，自动裁剪 %d → %d 条', history.length, trimmedHistory.length);
          history.length = 0;
          for (var ti = 0; ti < trimmedHistory.length; ti++) history.push(trimmedHistory[ti]);
        }
      }
    }

    // 先把用户消息落盘
    if (currentChatFile && userMsg) {
      var chatFileName = currentChatFile.split(/[\\/]/).pop().replace('.json','');
      try {
        await fetch((typeof API !== 'undefined' ? API : '') + '/api/chats/' + encodeURIComponent(chatFileName) + '/append', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ role: 'user', content: userMsg.content, ts: userMsg.ts, _file_tag: userMsg._file_tag || null })
        });
      } catch(e) { console.warn('用户消息存盘失败:', e.message); }
    }

    // 构建 body，检查是否有 doc_continue（Phase 2）
    // 在线模式 agent 映射到 chat（后端 action_mode）
    var _actionModeForBackend = currentActionMode || 'chat';
    if (_actionModeForBackend === 'agent') _actionModeForBackend = 'chat';
    var reqBody = {
      message: text,
      history: history,
      chat_file: currentChatFile,
      action_mode: _actionModeForBackend,
      // Patch5 G：file_path 只认真实路径（上传返回的）或 KB doc_id，
      // 不再 fallback 到 _savedRefPath（文件名，会导致后端 os.path.exists 失败）
      file_path: uploadedFilePath || window._docPhase2FilePath || null,
    };
    if (window._docContinueOutline) {
      reqBody.doc_continue = window._docContinueOutline;
      window._docContinueOutline = null;
      // Phase 2 发完后清理引用路径
      window._docPhase2FilePath = null;
    }

    console.log('[CHAT] SSE request sent, mode=%s, endpoint=%s', (typeof _currentMode !== 'undefined' ? _currentMode : 'local'), endpoint);
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + endpoint, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(reqBody),
      signal: abortCtrl.signal
    });

    console.log('[CHAT] SSE response: status=%d, ok=%s, content-type=%s', resp.status, resp.ok, resp.headers.get('content-type'));

    if (!resp.ok) {
      var errMsg = '服务器错误 (' + resp.status + ')';
      try { var _errBody = await resp.text(); if (_errBody) errMsg += ': ' + _errBody.substring(0, 200); } catch(_e) {}
      throw new Error(errMsg);
    }

    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    var READ_TIMEOUT = 60000;

    function detectThinkRepetition(t) {
      if (t.length < 100) return false;
      var tail = t.slice(-200);
      var counts = {};
      for (var i = 0; i <= tail.length - 8; i++) {
        var sub = tail.slice(i, i + 8);
        counts[sub] = (counts[sub] || 0) + 1;
      }
      var max = 0;
      for (var k in counts) { if (counts[k] > max) max = counts[k]; }
      return max >= 8;
    }

    while (true) {
      var readResult;
      try {
        readResult = await Promise.race([
          reader.read(),
          new Promise(function(_, reject) {
            setTimeout(function() { reject(new Error('请求超时')); }, READ_TIMEOUT);
          })
        ]);
      } catch(e) {
        if (e.message === '请求超时') {
          throw new Error('服务器无响应，已等待 ' + (READ_TIMEOUT / 1000) + ' 秒。请检查服务是否正常运行');
        }
        throw e;
      }
      if (readResult.done) break;
      buffer += decoder.decode(readResult.value, {stream:true});
      var lines = buffer.split('\n');
      buffer = lines.pop();

      var now = Date.now();
      var _sseDebugCount = 0;
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        if (!line.startsWith('data: ') || line === 'data: [DONE]') {
          if (line === 'data: [DONE]') console.log('[CHAT] SSE stream done, total tokens=%d, thinkLen=%d', fullText.length, thinkText.length);
          continue;
        }
        var payload = line.slice(6);
        try {
          var d = JSON.parse(payload);
          _sseDebugCount++;
          if (_sseDebugCount <= 3) console.log('[CHAT] SSE event #%d: type=%s', _sseDebugCount, d.type);
          if (d.type === 'task_type') {
            currentTaskType = d.task_type || '';
          } else if (d.type === 'queue') {
            var queuePos = d.position || 0;
            var queueMsg = d.message || (iconSvg('spin','14') + ' 请求排队中，位置 #' + queuePos);
            appendStreamingMsg(queueMsg, '', 0, null, false);
            lastRender = now;
          } else if (d.type === 'pipeline_start') {
            appendStreamingMsg(iconSvg('write','14') + ' Pipeline 启动 (' + (d.total_steps || '?') + ' 步)', '', 0, null, false);
            lastRender = now;
          } else if (d.type === 'pipeline_step') {
            var stepName = d.step_id || d.step_name || '';
            var status = d.status || '';
            if (status === 'running') appendStreamingMsg(iconSvg('spin','14') + ' ' + stepName + '...', '', 0, null, false);
            else if (status === 'done') appendStreamingMsg(iconSvg('check','14') + ' ' + stepName + ' 完成', '', 0, null, false);
            else if (status === 'failed') appendStreamingMsg(iconSvg('cross','14') + ' ' + stepName + ' 失败', '', 0, null, false);
            lastRender = now;
          } else if (d.type === 'pipeline_progress') {
          // P6 打磨：并行模式 stream 事件（带 channel 字段：local/cloud/merge）
          } else if (d.type === 'stream') {
            var ch = d.channel || 'merge';
            if (!window._parallelChannelTexts) window._parallelChannelTexts = {};
            if (!window._parallelChannelTexts[ch]) window._parallelChannelTexts[ch] = '';
            window._parallelChannelTexts[ch] += d.content || '';
            // 流式渲染到对应 timeline 步骤的内容区
            _renderParallelChannelContent(ch, window._parallelChannelTexts[ch], d.content || '');
            // 同步更新 fullText（最终 DONE 需要用到）
            if (ch === 'merge') fullText = window._parallelChannelTexts[ch];
          } else if (d.type === 'sources') {
            // P6 打磨：检索结果展示
            var srcCh = d.channel || 'local';
            var srcItems = d.items || [];
            _renderParallelSources(srcCh, srcItems);
          } else if (d.type === 'token') {
            fullText += d.content;
            // P6 修复：思考态指示器由 appendStreamingMsg(isThinking=true) 统一管理
            // 只在退出思考态时（truncated/done/agent_start）才删除，避免每个 token 都闪
            if (fullText.length > 0 && _thinkingTimerInterval && !thinkingPhase) {
              clearInterval(_thinkingTimerInterval);
              _thinkingTimerInterval = null;
              var _ti = document.querySelector('.thinking-indicator');
              if (_ti) _ti.remove();
            }
            var noThinkTypes = ['text', 'code', 'agent'];
            if (!thinkingPhase && !thinkText && !noThinkTypes.includes(currentTaskType)) {
              thinkingPhase = true;
            }
            if (now - lastRender > RENDER_INTERVAL) {
              if (thinkingPhase) {
                if (detectThinkRepetition(fullText)) {
                  var abbr = fullText.slice(0, 80) + '\n\n--- [思考内容出现重复，已省略 ' + (fullText.length - 130) + ' 字] ---\n\n' + fullText.slice(-50);
                  appendStreamingMsg(abbr, '', 0, null, true);
                } else {
                  appendStreamingMsg(fullText, '', 0, null, true);
                }
              } else {
                appendStreamingMsg(fullText, thinkText, thinkLen);
              }
              lastRender = now;
            }
          } else if (d.type === 'think_start') {
            // 云端推理模型开始思考（流式）
            thinkingPhase = false;
            _cloudThinking = true;
            _cloudThinkText = '';
            appendStreamingMsg('', '', 0, null, false);
            _renderCloudThink('', '');
          } else if (d.type === 'think_token') {
            // 云端推理 token（流式推送）
            _cloudThinkText += (d.content || '');
            if (now - lastRender > RENDER_INTERVAL) {
              _renderCloudThink(_cloudThinkText, fullText);
              lastRender = now;
            }
          } else if (d.type === 'think_end') {
            // 云端推理结束，折叠
            thinkText = _cloudThinkText || '';
            thinkLen = d.think_len || thinkText.length;
            _cloudThinking = false;
            appendStreamingMsg('', thinkText, thinkLen);
            lastRender = now;
          } else if (d.type === 'fold') {
            thinkText = fullText;
            thinkLen = d.think_len;
            fullText = '';
            thinkingPhase = false;
            appendStreamingMsg('', thinkText, thinkLen);
            lastRender = now;
          } else if (d.type === 'done') {
            // Patch5 C7: done 事件不再操作骨架屏（P6已移除）
            doneData = d;
            // 如果前面已经显示了 error 卡片，不再覆盖渲染
            if (_hadError) {
              thinkingPhase = false;
              _cloudThinking = false;
              // 直接进入结束流程
            } else {
              // 空回复兜底：如果有 think 但正文为空，显示友好提示
              if (!fullText.trim() && thinkText.trim()) {
                fullText = iconSvg('idea','14') + ' 模型思考完成，但未输出正文内容。请尝试重新提问或切换模式。';
              } else if (!fullText.trim() && !thinkText.trim()) {
                fullText = iconSvg('warn','14') + ' 模型未返回任何内容，请重试。';
              }
              finalStats = formatStats(d.model, d.chars, d.think_chars || 0, d.time, d.speed);
              thinkingPhase = false;
              _cloudThinking = false;
              // Patch4 v3.1 BUG#10：done 事件最终渲染时，清空 thinkText 避免 appendStreamingMsg
              // 又把 think-details 重新塞回去（导致完成后仍显示"思考中"）
              var _finalThink = '';
              var _finalThinkLen = 0;
              // doc_outline 模式：不覆盖 stream-msg（保留确认按钮）
              if (!window._docOutlinePending) {
                appendStreamingMsg(fullText, _finalThink, _finalThinkLen, finalStats);
              }
            }
          } else if (d.type === 'model_reload') {
            var streamEl3 = document.getElementById('stream-msg');
            if (streamEl3) {
              var reloadDiv = document.createElement('div');
              reloadDiv.style.cssText = 'margin:8px 0;padding:8px 12px;background:var(--bg-primary);border:1px solid var(--warning-color);border-radius:8px;font-size:.85em;color:var(--warning-color);display:flex;align-items:center;gap:8px';
              reloadDiv.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;flex-shrink:0"></div> 模型状态异常，正在自动恢复（重新加载 ' + esc(d.model || '') + '）...';
              streamEl3.appendChild(reloadDiv);
              streamEl3.scrollTop = streamEl3.scrollHeight;
            }
          } else if (d.type === 'truncate') {
            fullText = d.content || '';
            thinkingPhase = false;
            appendStreamingMsg(fullText, thinkText, thinkLen);
          } else if (d.type === 'error') {
            // P6 T04: error 事件不再操作骨架屏
            thinkingPhase = false;
            // 结构化错误渲染：带类型图标 + 详情展开
            var errorType = d.error_type || 'unknown';
            var errorIcon = iconSvg('cross','14');
            var errorColor = 'var(--error-color)';
            // 网络类错误
            if (errorType.indexOf('network') === 0 || errorType === 'network_dns' || errorType === 'network_timeout') {
              errorIcon = iconSvg('idea','14'); // 🌐
              errorColor = 'var(--warning-color)';
            }
            // 认证类错误
            else if (errorType.indexOf('auth') === 0) {
              errorIcon = iconSvg('idea','14'); // 🔑
              errorColor = 'var(--warning-color)';
            }
            // 限流
            else if (errorType === 'rate_limit') {
              errorIcon = iconSvg('spin','14'); // 🔄
              errorColor = 'var(--info-color)';
            }
            // 服务端错误
            else if (errorType === 'server_error') {
              errorIcon = iconSvg('warn','14'); // ⚠️
              errorColor = 'var(--warning-color)';
            }
            var errorMsg = esc(d.content || '未知错误');
            var errorHtml = '<div class="cloud-error-card" style="margin:8px 0;padding:12px 16px;'
              + 'background:var(--bg-secondary);border:1px solid ' + errorColor + ';border-radius:8px;'
              + 'color:' + errorColor + ';font-size:14px;line-height:1.6;">'
              + '<div style="font-weight:600;margin-bottom:4px">' + errorIcon + ' ' + errorMsg + '</div>';
            if (d.detail) {
              errorHtml += '<details style="margin-top:4px;font-size:12px;color:var(--text-secondary)">'
                + '<summary style="cursor:pointer">技术详情</summary>'
                + '<pre style="margin-top:4px;padding:6px;background:var(--bg-primary);border-radius:4px;'
                + 'overflow-x:auto;white-space:pre-wrap;word-break:break-all;">' + esc(d.detail) + '</pre>'
                + '</details>';
            }
            errorHtml += '</div>';
            // 直接 append 到流式消息区域（绕过 md() 避免 HTML 被转义）
            _hadError = true;  // 标记已收到错误
            var streamErr = document.getElementById('stream-msg');
            if (!streamErr) {
              streamErr = document.createElement('div');
              streamErr.id = 'stream-msg';
              streamErr.className = 'msg ai';
              var messagesEl = document.getElementById('messages');
              var emptyEl = messagesEl ? messagesEl.querySelector('.empty-state') : null;
              if (emptyEl) emptyEl.remove();
              if (messagesEl) messagesEl.appendChild(streamErr);
            }
            streamErr.innerHTML = errorHtml;
          } else if (d.type === 'compress') {
            // 在线压缩进度
            if (typeof _showCompressProgress === 'function' && d.phase) {
              _showCompressProgress(d.phase, d.progress, d.msg, d.before, d.after);
            } else {
              // fallback: 简单文字通知
              var streamEl3b = document.getElementById('stream-msg');
              if (streamEl3b) {
                var compDiv = document.createElement('div');
                compDiv.className = 'compress-notice';
                compDiv.innerHTML = iconSvg('doc','14') + ' ' + esc(d.msg || '正在压缩旧对话...');
                streamEl3b.appendChild(compDiv);
                setTimeout(function() { if (compDiv.parentNode) compDiv.remove(); }, 3000);
              }
            }
          } else if (d.type === 'filter') {
            if (d.warnings && d.warnings.length > 0) {
              var hallucinationKw = ['语言混淆', '模板套用', '内容空洞', '指令偏离', '未遵从指令', '疑似幻觉'];
              var hasHallucination = d.warnings.some(function(w) { return hallucinationKw.some(function(k) { return w.includes(k); }); });
              var bg = hasHallucination ? 'var(--bg-secondary)' : 'var(--bg-primary)';
              var border = hasHallucination ? 'var(--error-color)' : 'var(--warning-color)';
              var color = hasHallucination ? 'var(--error-color)' : 'var(--warning-color)';
              var icon = hasHallucination ? iconSvg('books','14') : iconSvg('warn','14');
              var warnHtml = '<div style="margin-top:8px;padding:6px 10px;background:' + bg + ';border:1px solid ' + border + ';border-radius:4px;font-size:12px;color:' + color + ';">' + icon + ' ' +
                d.warnings.map(function(w) { return esc(w); }).join('<br>');
              if (d.corrections && d.corrections.length > 0) {
                warnHtml += '<br><span style="color:var(--info-color);font-weight:500">' + iconSvg('idea','14') + ' 纠正建议：</span><br>' +
                  d.corrections.map(function(c) { return esc(c); }).join('<br>');
              }
              warnHtml += '</div>';
              var streamEl2 = document.getElementById('stream-msg');
              if (streamEl2) {
                var warnDiv = document.createElement('div');
                warnDiv.innerHTML = warnHtml;
                streamEl2.appendChild(warnDiv);
              }
            }
          // P6 T04: AgentTimeline SSE 事件处理
          } else if (d.type === 'agent_timeline') {
            _handleAgentTimelineSSE(d);
          // Patch2 A5: Research Action SSE 事件
          } else if (d.type === 'search') {
            _appendResearchCard('search', d.query, d.results_count);
          } else if (d.type === 'fetch') {
            _appendResearchFetch(d.url, d.title);
          // Patch2 A9: 上下文警告
          } else if (d.type === 'context_warning') {
            _showContextWarning(d.percentage, d.level);
          } else if (d.type === 'context_force_new') {
            currentChatFile = d.new_chat_file;
            currentMessages = [];
            loadChatList();
            showToast('对话空间不足，已自动新建会话', 'warning');
          } else if (d.type === 'agent_start') {
            thinkingPhase = false;
            var agentStreamEl = document.getElementById('stream-msg');
            if (agentStreamEl) {
              var agentDiv = document.createElement('div');
              agentDiv.className = 'agent-panel';
              agentDiv.id = 'agent-panel-' + Date.now();
              agentDiv.innerHTML = '<div class="agent-header">' + iconSvg('idea','14') + ' Agent 模式</div><div class="agent-steps"></div>';
              agentStreamEl.appendChild(agentDiv);
            }
          } else if (d.type === 'agent_think') {
            var agentSteps = document.querySelector('.agent-steps:last-of-type');
            if (agentSteps) {
              var thinkDiv = agentSteps.querySelector('.agent-thinking');
              if (!thinkDiv) {
                thinkDiv = document.createElement('div');
                thinkDiv.className = 'agent-thinking';
                agentSteps.appendChild(thinkDiv);
              }
              thinkDiv.textContent += d.content || '';
              if (thinkDiv.textContent.length > 3000) thinkDiv.textContent = thinkDiv.textContent.slice(-2000);
            }
          } else if (d.type === 'agent_action') {
            thinkingPhase = false;
            var agentSteps2 = document.querySelector('.agent-steps:last-of-type');
            if (agentSteps2) {
              var oldThink = agentSteps2.querySelector('.agent-thinking');
              if (oldThink) oldThink.remove();
              var actionDiv = document.createElement('div');
              actionDiv.className = 'agent-step';
              var iterNum = d.iteration || '?';
              actionDiv.innerHTML = '<span class="agent-step-num">' + iterNum + '</span> ' + iconSvg('write','14') + ' 调用: <b>' + esc(d.tool || '') + '</b> <span class="agent-params">' + esc(JSON.stringify(d.params || {}).substring(0, 120)) + '</span>';
              agentSteps2.appendChild(actionDiv);
            }
          } else if (d.type === 'agent_result') {
            var agentSteps3 = document.querySelector('.agent-steps:last-of-type');
            if (agentSteps3) {
              var resultDiv = document.createElement('div');
              resultDiv.className = 'agent-result ' + (d.ok ? 'agent-ok' : 'agent-fail');
              var resultText = d.ok
                ? (typeof d.result === 'object' ? JSON.stringify(d.result, null, 2).substring(0, 500) : String(d.result || '').substring(0, 200))
                : esc(String(d.error || (d.result ? d.result.error : '') || '失败').substring(0, 200));
              var resultIcon = d.ok ? iconSvg('check','14') : iconSvg('cross','14');
              resultDiv.innerHTML = resultIcon + ' <span class="agent-result-tool">' + esc(d.tool || '') + '</span> <span class="agent-result-text">' + resultText + '</span>' + (d.time ? ' <span class="agent-time">(' + d.time + 's)</span>' : '');
              agentSteps3.appendChild(resultDiv);
            }
          } else if (d.type === 'agent_done') {
            var agentSteps4 = document.querySelector('.agent-steps:last-of-type');
            if (agentSteps4) {
              var doneDiv = document.createElement('div');
              doneDiv.className = 'agent-done';
              doneDiv.innerHTML = iconSvg('check','14') + ' Agent 完成 (' + (d.iterations || 0) + ' 步, ' + (d.elapsed || '?') + 's)';
              agentSteps4.appendChild(doneDiv);
              if (d.files && d.files.length > 0) {
                var fileDiv = document.createElement('div');
                fileDiv.innerHTML = renderFileCards(d.files);
                agentSteps4.appendChild(fileDiv);
              }
            }
          // ===== Cloud Agent 新事件（agent_status / agent_summary / agent_think）=====
          } else if (d.type === 'agent_status') {
            _handleAgentStatus(d);
            // Patch4 v3：write_workspace 写入 .md 文件 → 进度面板显示"写作中"
            if (d.status === 'workspace_write_done' && typeof _handleDocProgressEvent === 'function') {
              var _wwName = d.name || d.path || '';
              if (_wwName && _wwName.toLowerCase().endsWith('.md')) {
                // 字数从后端 done status 传来
                _handleDocProgressEvent('write_workspace_md', {filename: _wwName, words: d.words || d.size || 0});
              }
            }
          } else if (d.type === 'agent_summary') {
            _handleAgentSummary(d);
          } else if (d.type === 'agent_think') {
            // 新版 agent_think 事件（data = {content: string}）
            // 复用现有 think 机制
            if (d.content) {
              _cloudThinkText += d.content;
              if (now - lastRender > RENDER_INTERVAL) {
                _renderCloudThink(_cloudThinkText, fullText);
                lastRender = now;
              }
            }
          } else if (d.type === 'chunk_start') {
            var agentSteps5 = document.querySelector('.agent-steps:last-of-type');
            if (agentSteps5) {
              var chunkDiv = document.createElement('div');
              chunkDiv.className = 'chunk-panel';
              chunkDiv.id = 'chunk-panel';
              chunkDiv.innerHTML = '<div class="chunk-header">' + iconSvg('books','14') + ' 长文本分段处理</div>' +
                '<div class="chunk-info">' + (d.total_chars || 0) + '字 \u2192 ' + (d.total_chunks || 0) + '段 (策略: ' + (d.strategy || 'auto') + ')</div>' +
                '<div class="chunk-progress-bar"><div class="chunk-progress-fill" id="chunk-progress-fill" style="width:0%"></div></div>' +
                '<div class="chunk-progress-text" id="chunk-progress-text">准备中...</div>' +
                '<div class="chunk-quotes" id="chunk-quotes" style="display:none"></div>';
              agentSteps5.appendChild(chunkDiv);
            }
          } else if (d.type === 'chunk_progress') {
            var fill = document.getElementById('chunk-progress-fill');
            var cText = document.getElementById('chunk-progress-text');
            if (fill && cText) {
              var pctC = Math.round(((d.current || 0) / (d.total || 1)) * 100);
              fill.style.width = pctC + '%';
              cText.textContent = '正在处理第 ' + d.current + '/' + d.total + ' 段' + (d.section_title ? ' - ' + d.section_title : '');
            }
          } else if (d.type === 'chunk_result') {
            var cText2 = document.getElementById('chunk-progress-text');
            if (cText2 && d.extracted_info) {
              cText2.textContent = '段 ' + (d.chunk_index + 1) + ' 置信度: ' + (d.confidence || 0).toFixed(2);
            }
          } else if (d.type === 'chunk_merge') {
            var cText3 = document.getElementById('chunk-progress-text');
            if (cText3) cText3.innerHTML = iconSvg('spin','14') + ' 记忆压缩中...';
          } else if (d.type === 'chunk_done') {
            var fill2 = document.getElementById('chunk-progress-fill');
            var cText4 = document.getElementById('chunk-progress-text');
            if (fill2) fill2.style.width = '100%';
            if (cText4) cText4.innerHTML = iconSvg('check','14') + ' 完成: ' + (d.chunks_processed || 0) + '/' + (d.total_chunks || 0) + '段, 置信度 ' + (d.final_confidence || 0) + ', 耗时 ' + (d.elapsed_seconds || 0) + 's';
          // Action Router /xx 提示
          } else if (d.type === 'slash_hint') {
            showToast(d.message || '', 'info');
          // 文件上传结果
          } else if (d.type === 'file_upload_result') {
            if (d.status === 'error') showToast(d.message, 'error');
            else if (d.status === 'too_long') showToast(d.message, 'warning');
            else showToast(d.message, 'success');
          // Action 进度
          } else if (d.type === 'action_status') {
            showToast(d.message || '', 'info');
          // Action 确认
          } else if (d.type === 'action_confirm') {
            showToast(d.message || '', 'info');
          } else if (d.type === 'action_confirmed') {
            showToast(d.message || '开始生成...', 'success');
          } else if (d.type === 'action_cancelled') {
            showToast('已取消', 'info');
          } else if (d.type === 'action_error') {
            showToast(d.message || '操作出错', 'error');
          // KB 引用来源（内嵌到消息区域）
          } else if (d.type === 'kb_sources') {
            var sources = d.sources || [];
            if (sources.length > 0) {
              // 保存来源信息，用于 renderMessages 后恢复
              window._kbSources = sources;
              var streamEl = document.getElementById('stream-msg');
              if (streamEl) {
                var srcBar = document.createElement('div');
                srcBar.className = 'kb-sources-bar';
                srcBar.id = 'kbSourcesBar';
                var srcHtml = '<div class="kb-sources-title">' + iconSvg('books','14') + ' 参考来源</div>';
                sources.forEach(function(s, i) {
                  srcHtml += '<div class="kb-source-item">' +
                    '<span class="kb-source-num">' + (i + 1) + '</span>' +
                    '<span class="kb-source-label">' + esc(s.label || '来源' + (i+1)) + '</span>' +
                    (s.snippet ? '<div class="kb-source-snippet">' + esc(s.snippet) + '</div>' : '') +
                    '</div>';
                });
                srcBar.innerHTML = srcHtml;
                streamEl.insertBefore(srcBar, streamEl.firstChild);
              }
            showToast('已检索到 ' + sources.length + ' 条相关文档', 'success');
            }
          } else if (d.type === 'kb_no_reference') {
            showToast('未找到相关文库内容', 'info');
          // 文档提纲确认（Phase 1 完成后）
          } else if (d.type === 'doc_outline') {
            // 标记：doc_outline 模式，done 后不要覆盖确认按钮
            window._docOutlinePending = true;
            // 保存提纲到全局变量
            window._docOutlineText = d.outline || fullText;
            var streamEl = document.getElementById('stream-msg');
            if (streamEl) {
              var confirmBar = document.createElement('div');
              confirmBar.className = 'doc-confirm-bar';
              confirmBar.id = 'docConfirmBar';
              confirmBar.innerHTML = '<span class="doc-confirm-text">' + iconSvg('doc','14') + ' 文档提纲已生成，请确认后生成完整文档</span>' +
                '<div class="doc-confirm-actions">' +
                '<button class="doc-confirm-ok" onclick="confirmDocOutline()">' + iconSvg('check','14') + ' 确认生成</button>' +
                '<button class="doc-confirm-cancel" onclick="cancelDocOutline()">取消</button>' +
                '</div>';
              streamEl.appendChild(confirmBar);
            }
          // 文档下载
          } else if (d.type === 'doc_ready') {
            var _apiBase = (typeof API !== 'undefined' ? API : '');
            var downloadUrl = _apiBase + d.url;
            // 保存下载信息到变量，用于 renderMessages 后恢复
            window._docDownloadInfo = { url: downloadUrl, filename: d.filename || 'document.docx' };
            // 在当前流式消息末尾追加下载按钮
            var streamEl = document.getElementById('stream-msg');
            if (streamEl) {
              var docBar = document.createElement('div');
              docBar.className = 'doc-download-bar';
              docBar.innerHTML = '<a href="' + esc(downloadUrl) + '" download="' + esc(d.filename || 'document.docx') + '" class="doc-download-btn" target="_blank">' + iconSvg('doc','14') + ' 下载 ' + esc(d.filename || 'document.docx') + '</a>';
              streamEl.appendChild(docBar);
            }
            showToast('文档撰写完成', 'success');
          // ===== Patch4 v3: 文档完成事件（doc_started / section_done 已废弃）=====
          } else if (d.type === 'doc_complete') {
            // set_doc_status completed 完成 → 进度面板标记完成 + 下载按钮
            // 新数据结构（来自 cloud_pipeline）: {filename, doc_url, md_filename, total_time, ts}
            // Patch4 v3.1 BUG#13：同时保存到 window._docDownloadInfo 供持久化
            if (d.doc_url) {
              window._docDownloadInfo = {
                url: d.doc_url,
                filename: d.filename || 'document.docx',
              };
            }
            if (typeof _handleDocProgressEvent === 'function') {
              _handleDocProgressEvent('doc_complete', d);
            }
            // Patch4 v3.1 BUG#13：额外保险——在 streamEl 末尾追加一个独立的下载栏
            // （进度面板可能在 done 事件重渲染时被覆盖，独立下载栏更稳）
            var _streamElDl = document.getElementById('stream-msg');
            if (_streamElDl && d.doc_url) {
              var _docDlBar = document.createElement('div');
              _docDlBar.className = 'doc-download-bar';
              _docDlBar.setAttribute('data-doc-complete', '1');
              _docDlBar.innerHTML = '<a href="' + esc((typeof API !== 'undefined' ? API : '') + d.doc_url) + '" download="' + esc(d.filename || 'document.docx') + '" class="doc-download-btn" target="_blank">' + iconSvg('doc','14') + ' 下载 ' + esc(d.filename || 'document.docx') + '</a>';
              _streamElDl.appendChild(_docDlBar);
            }
            showToast('文档撰写完成', 'success');
          }
        } catch(e) { console.error('[chat.sendMessage.parseSSE]', e); }
      }
    }
    if (!doneData) {
      thinkingPhase = false;
      appendStreamingMsg(fullText, thinkText, thinkLen);
    }
  } catch(e) {
    if (e.name === 'AbortError') {
      _abortReason = 'user_stop';
      // UI：在气泡中显示终止提示（追加在已有内容后面）
      appendStreamingMsg('<span style="color:var(--text-muted);font-style:italic">' + iconSvg('stop','14') + ' 用户已手动终止响应</span>', '', 0);
    } else {
      _abortReason = 'network_error';
      appendStreamingMsg(iconSvg('cross','14') + ' 连接错误: ' + esc(e.message), '', 0);
    }
    _hadError = true;  // 阻止 finally 重新 renderMessages 覆盖错误/终止提示
  } finally {
    // P6 T04: 骨架屏已移除，不再调用 Skeleton.hide
    // doc_outline 模式：保留 stream-msg 元素和确认按钮，不重新渲染
    var _isDocOutlineMode = !!window._docOutlinePending;
    if (_isDocOutlineMode) {
      // 不 remove id、不 renderMessages（否则确认按钮被覆盖）
      // 只保存提纲文本到消息列表（不触发 UI 重渲染）
      if (fullText.trim()) {
        currentMessages.push({
          role: 'assistant',
          content: fullText,
          ts: new Date().toTimeString().slice(0,8),
          action_mode: 'doc',
          doc_phase: 'outline',
        });
      }
      _lastMsgCount = currentMessages.length;
    } else {
      var streamEl4 = document.getElementById('stream-msg');
      if (streamEl4) streamEl4.removeAttribute('id');

      // 计算要持久化的内容：正常输出 / 中止时已有内容 / 错误消息
      var _persistContent = fullText.trim();
      if (_hadError && _abortReason === 'user_stop' && _persistContent) {
        // 用户手动中止，已有输出：保留原内容，加标记（不修改 fullText 本身）
      } else if (_hadError && _abortReason === 'user_stop' && !_persistContent) {
        // 用户手动中止，无输出：记录一条中止提示
        _persistContent = '[用户已手动终止响应]';
      } else if (_hadError && _abortReason === 'network_error') {
        // 网络错误：保留已输出内容（如果有）
        _persistContent = _persistContent || '[连接错误，响应中断]';
      }

      if (_persistContent) {
        var msgHash = '';
        try {
          var srcH = _persistContent.substring(0, 200);
          var hH = 0;
          for (var si2 = 0; si2 < srcH.length; si2++) { hH = ((hH << 5) - hH + srcH.charCodeAt(si2)) | 0; }
          msgHash = 'h_' + Math.abs(hH).toString(36).padStart(8, '0');
        } catch(e3) { msgHash = ''; }

        var newMsg = {
          role: 'assistant',
          content: _persistContent,
          ts: new Date().toTimeString().slice(0,8),
          think: thinkText || '',
          model: doneData ? doneData.model : '',
          chars: doneData ? doneData.chars : 0,
          think_chars: doneData ? (doneData.think_chars || 0) : 0,
          time: doneData ? doneData.time : 0,
          speed: doneData ? doneData.speed : 0,
          task_type: currentTaskType || '',
          msg_hash: msgHash,
          action_mode: currentActionMode || 'chat',
        };
        // 异常终止标记
        if (_hadError) {
          newMsg._aborted = true;
          newMsg._abort_reason = _abortReason;
        }
        // 如果有文档下载信息，保存到消息里
        if (window._docDownloadInfo) {
          newMsg.doc_url = window._docDownloadInfo.url;
          newMsg.doc_filename = window._docDownloadInfo.filename;
          window._docDownloadInfo = null;
        }
        // 如果有 KB 来源信息，保存到消息里
        if (window._kbSources && window._kbSources.length > 0) {
          newMsg.kb_sources = window._kbSources;
          window._kbSources = null;
        }
        // 如果有 Agent 时间线数据，保存到消息里（最终渲染时恢复）
        if (_agentTimelineData.length > 0) {
          newMsg.agent_timeline = _agentTimelineData.slice();  // 复制一份
          _agentTimelineData = [];
        }
        // 保存真实 token 统计（从云端 API usage 返回）
        if (doneData && doneData.token_stats) {
          newMsg.token_stats = doneData.token_stats;
        }

        currentMessages.push(newMsg);

        // 持久化到后端
        if (currentChatFile) {
          try {
            var _chatName = currentChatFile.split(/[\\/]/).pop().replace('.json','');
            if (_hadError) {
              // 异常终止：后端可能没存 assistant 消息，用 append 追加
              await fetch((typeof API !== 'undefined' ? API : '') + '/api/chats/' + encodeURIComponent(_chatName) + '/append', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(newMsg)
              });
            } else {
              // 正常完成：enrich 更新最后一条 assistant 消息的补充字段
              var _enrichFields = {};
              if (newMsg.agent_timeline) _enrichFields.agent_timeline = newMsg.agent_timeline;
              if (newMsg.token_stats) _enrichFields.token_stats = newMsg.token_stats;
              if (newMsg.kb_sources) _enrichFields.kb_sources = newMsg.kb_sources;
              if (newMsg.doc_url) _enrichFields.doc_url = newMsg.doc_url;
              if (newMsg.doc_filename) _enrichFields.doc_filename = newMsg.doc_filename;
              if (Object.keys(_enrichFields).length > 0) {
                await fetch((typeof API !== 'undefined' ? API : '') + '/api/chats/' + encodeURIComponent(_chatName) + '/enrich', {
                  method: 'POST',
                  headers: {'Content-Type': 'application/json'},
                  body: JSON.stringify(_enrichFields)
                });
              }
            }
          } catch(e) { console.warn('[chat.persist] 回写失败:', e.message); }
        }
      }
    } // end else (non-doc-outline mode)

    _lastMsgCount = currentMessages.length;

    generating = false;
    if (typeof resumeHeartbeat === 'function') resumeHeartbeat();
    uploadedFilePath = null;
    if (!_isDocOutlineMode) {
      // error/abort 时保留错误卡片（不 renderMessages），只恢复 UI 按钮 + 刷新列表
      if (_hadError) {
        var streamErrFix = document.getElementById('stream-msg');
        if (streamErrFix) streamErrFix.removeAttribute('id');  // 固化错误卡片
        _restoreChatUI();
        input.focus();
        loadChatList();
        fetchContextUsage();
      } else {
        renderMessages();
        _restoreChatUI();
        input.focus();
        setTimeout(function() { if (!generating) _restoreChatUI(); }, 100);
        loadChatList();
        fetchContextUsage();  // Patch2 A7: 更新上下文圆环
      }
    } else {
      _restoreChatUI();
      input.focus();
    }
  }
}

function stopGeneration() {
  if (typeof abortCtrl !== 'undefined' && abortCtrl) abortCtrl.abort();
  fetch((typeof API !== 'undefined' ? API : '') + '/api/stop', {method:'POST'}).catch(function() {});
}

async function stopGenerationAndWait() {
  if (typeof abortCtrl !== 'undefined' && abortCtrl) abortCtrl.abort();
  try {
    await fetch((typeof API !== 'undefined' ? API : '') + '/api/stop', {method:'POST'});
  } catch(e) { console.error('[chat.stopGenerationAndWait]', e); }
}

// ===== Patch2 A5: Research 状态卡片 =====
function _appendResearchCard(type, query, count) {
  var streamEl = document.getElementById('stream-msg');
  if (!streamEl) return;
  var old = streamEl.querySelector('.research-card');
  if (old && type === 'search') { old.remove(); }
  var card = document.createElement('div');
  card.className = 'research-card';
  card.innerHTML = '<div class="research-card-search">' + iconSvg('books','14') + ' 搜索了「<b>' + esc(query) + '</b>」<span class="count">— ' + count + ' 条结果</span></div>';
  streamEl.insertBefore(card, streamEl.firstChild);
}
function _appendResearchFetch(url, title) {
  var streamEl = document.getElementById('stream-msg');
  if (!streamEl) return;
  var card = streamEl.querySelector('.research-card');
  if (!card) {
    card = document.createElement('div');
    card.className = 'research-card';
    streamEl.insertBefore(card, streamEl.firstChild);
  }
  var fetchDiv = card.querySelector('.research-card-fetch');
  if (!fetchDiv) {
    fetchDiv = document.createElement('div');
    fetchDiv.className = 'research-card-fetch';
    card.appendChild(fetchDiv);
  }
  var item = document.createElement('div');
  item.className = 'research-fetch-item';
  item.innerHTML = '<span class="status ok"></span> ' + esc(title || url);
  fetchDiv.appendChild(item);
}

// ===== Patch2 A9/A11: 上下文管理与压缩 =====
function _showContextWarning(percentage, level) {
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'contextWarnModal';
  overlay.innerHTML = '<div class="modal-card">' +
    '<h3>' + iconSvg('warn','14') + ' 对话接近上限</h3>' +
    '<div class="modal-warning">当前上下文使用 <strong>' + Math.round(percentage) + '%</strong>，继续聊天响应会变慢。</div>' +
    '<div class="modal-actions">' +
    '<button class="btn-cancel" onclick="document.getElementById(\'contextWarnModal\').remove()">继续（可能较慢）</button>' +
    '<button class="btn-confirm" style="background:var(--warning-color);color:#fff" onclick="newChat();document.getElementById(\'contextWarnModal\').remove()">新建会话</button>' +
    '</div></div>';
  document.body.appendChild(overlay);
}
function _showCompressProgress(phase, progress, msg, before, after) {
  var streamEl = document.getElementById('stream-msg');
  if (!streamEl) return;
  var comp = streamEl.querySelector('.compress-progress');
  if (phase === 'done') {
    if (comp) comp.remove();
    if (before && after) showToast('压缩完成: ' + before + ' → ' + after, 'success');
    return;
  }
  if (!comp) {
    comp = document.createElement('div');
    comp.className = 'compress-progress';
    streamEl.appendChild(comp);
  }
  var pct = progress || 0;
  comp.innerHTML = '<div class="compress-text">' + esc(msg || '压缩中…') + '</div>' +
    '<div class="bar"><div class="bar-fill" style="width:' + pct + '%"></div></div>';
}

// 暴露到全局（仅 chat.js 核心函数）
window._renderSingleMsg = _renderSingleMsg;
window.renderMsg = renderMsg;
window.renderMessages = renderMessages;
window.appendStreamingMsg = appendStreamingMsg;
window.onInputKey = onInputKey;
window.sendMessage = sendMessage;
window.stopGeneration = stopGeneration;
window.stopGenerationAndWait = stopGenerationAndWait;
window.confirmDocOutline = confirmDocOutline;
window.cancelDocOutline = cancelDocOutline;
window.fetchContextUsage = fetchContextUsage;
window.updateContextRing = updateContextRing;
window.scrollToBottom = scrollToBottom;
window.checkScrollBtn = checkScrollBtn;
window.clearFileRef = clearFileRef;
window.saveFileAs = saveFileAs;
window.pickKbFile = pickKbFile;
window.exportChat = exportChat;
window.copyMsgContent = copyMsgContent;

// ===== Patch5 C7: 清除上下文 =====
/**
 * 清除上下文：重置模型对当前对话的记忆，消息保留但不再被参考
 */
async function clearContext() {
  if (typeof generating !== 'undefined' && generating) {
    if (typeof showToast === 'function') showToast('请等待当前回复完成', 'warning');
    return;
  }
  // 确认弹窗
  var confirmed = true;
  if (typeof showDialog === 'function') {
    confirmed = await showDialog('清除上下文',
      '将重置模型对当前对话的记忆。消息会保留，但模型不再参考之前的内容。',
      {confirm: true, confirmLabel: '清除', cancelLabel: '取消'});
  }
  if (!confirmed) return;

  // Patch5 C7：调用新接口 /api/chats/clear_context（给最后一条消息打 context_cutoff）
  if (typeof currentChatFile !== 'undefined' && currentChatFile) {
    try {
      var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/chats/clear_context', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({chat_file: currentChatFile, msg_idx: -1})
      });
      var data = await resp.json();
      if (data.ok) {
        // 同步内存：给 currentMessages 最后一条打标
        if (typeof currentMessages !== 'undefined' && currentMessages.length > 0) {
          // 清除旧的 context_cutoff 标记
          for (var i = 0; i < currentMessages.length; i++) {
            if (currentMessages[i] && typeof currentMessages[i] === 'object') {
              currentMessages[i].context_cutoff = (i === currentMessages.length - 1);
            }
          }
          if (typeof _lastMsgCount !== 'undefined') _lastMsgCount = currentMessages.length;
        }
        if (typeof showToast === 'function') {
          showToast('上下文已清除（保留 ' + (data.total_messages || 0) + ' 条消息，模型从下一轮重新开始）', 'success', 4000);
        }
      } else {
        if (typeof showToast === 'function') showToast(data.error || '清除失败', 'error');
      }
    } catch(e) {
      console.warn('[chat.clearContext] 调用失败:', e.message);
      if (typeof showToast === 'function') showToast('清除失败: ' + e.message, 'error');
    }
  } else {
    if (typeof showToast === 'function') showToast('当前没有会话，无需清除', 'info');
  }
}
window.clearContext = clearContext;

// ===== Patch5 C7: 初始化 Token 估算 + UI 增强 =====
// 在页面加载后初始化
window.addEventListener('load', function() {
  if (typeof initTokenEstimator === 'function') initTokenEstimator();
  if (typeof initUiEnhance === 'function') initUiEnhance();
});

// ===== Cloud Agent 工具时间线（累积式，每步保留）=====
function _handleAgentStatus(data) {
  // 持久化：收集时间线数据（用于最终渲染恢复）
  _agentTimelineData.push(data);

  // 创建时间线容器（只创建一次）
  if (!_agentTimelineEl || !_agentTimelineEl.parentNode) {
    _agentTimelineEl = document.createElement("div");
    _agentTimelineEl.className = "agent-timeline";
    var streamEl = document.getElementById("stream-msg");
    if (streamEl) streamEl.insertBefore(_agentTimelineEl, streamEl.firstChild);
  }

  // Patch4 v3：每个状态有 phase（start/done）。
  //   - 新步骤进来时（无论 start 还是 done），前一个 current 步骤自动变 done（治闪烁）
  //   - 同一轮内连续 thinking 合并（不重复 push）
  var nowTs = Date.now();
  var isStart = _agentStatusIsStart(data.status);
  var isThinking = (data.status === 'thinking');

  // 思考合并：如果上一步已是 thinking 且本次也是 thinking，不重复 push
  if (isThinking && _agentCurrentStepEl && _agentCurrentStepEl.getAttribute('data-kind') === 'thinking') {
    return; // 已在思考中，不重复
  }

  // 新步骤进来前，把前一个 current 标记为 done（治闪烁的关键）
  if (_agentCurrentStepEl) {
    _finalizeCurrentStep(nowTs);
  }

  // 创建新步骤节点
  var step = document.createElement("div");
  step.className = "agent-step agent-step-" + (data.status || "default");
  if (isStart) {
    step.className += " agent-step-current";
    step.setAttribute('data-kind', isThinking ? 'thinking' : (data.status || ''));
  }
  var html = _agentStepHtml(data);
  step.innerHTML = html;
  _agentTimelineEl.appendChild(step);

  // 记录当前步骤（用于下次切换时 finalize）
  if (isStart) {
    _agentCurrentStepEl = step;
    _agentCurrentStepStartTs = nowTs;
  } else {
    // done 类步骤本身就是终态，不作为 current
    _agentCurrentStepEl = null;
    _agentCurrentStepStartTs = 0;
  }

  // 滚底
  var msgEl = document.getElementById('messages');
  if (msgEl && _lastScrollBottom) msgEl.scrollTop = msgEl.scrollHeight;
}

// Patch4 v3：判断 status 是否是 start 类（开启新步骤）
function _agentStatusIsStart(status) {
  if (!status) return true;
  var starts = ['thinking', 'searching', 'fetching', 'kb_searching',
                'workspace_listing', 'workspace_reading', 'workspace_writing', 'workspace_deleting',
                'workspace_appending', 'workspace_editing',
                'docs_listing', 'doc_status_updating'];
  if (starts.indexOf(status) >= 0) return true;
  // 其余（*_done / *_appended / *_edited / budget_exceeded / tool_limited / error / completed）视为 done 类
  return false;
}

// Patch4 v3：把当前 current 步骤转为 done（追加耗时）
function _finalizeCurrentStep(nowTs) {
  if (!_agentCurrentStepEl) return;
  _agentCurrentStepEl.classList.remove('agent-step-current');
  _agentCurrentStepEl.classList.add('agent-step-done');
  var elapsedMs = _agentCurrentStepStartTs ? (nowTs - _agentCurrentStepStartTs) : 0;
  if (elapsedMs > 0) {
    var elapsedSec = (elapsedMs / 1000).toFixed(1);
    var labelEl = _agentCurrentStepEl.querySelector('.agent-label');
    if (labelEl && labelEl.getAttribute('data-has-time') !== '1') {
      labelEl.setAttribute('data-has-time', '1');
      // 追加耗时到文案末尾
      labelEl.textContent = labelEl.textContent + ' (' + elapsedSec + 's)';
    }
  }
}

// Patch4 v3：生成单个步骤的 HTML（按 §6 工具→图标映射，无 emoji）
function _agentStepHtml(data) {
  switch (data.status) {
    case 'thinking':
      // Patch5 C7 B3：动画点 + 计时（替代 spinner + 文案）
      return '<span class="agent-icon"><span class="thinking-dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span></span> <span class="agent-label">思考中</span>';
    case 'searching':
      return '<span class="agent-icon agent-spin">' + iconSvg('books','14') + '</span> <span class="agent-label">正在搜索「' + _esc(data.query || '') + '」</span>';
    case 'search_done':
      return '<span class="agent-icon agent-done">' + iconSvg('check','14') + '</span> <span class="agent-label">搜索完成 — ' + (data.count || 0) + ' 条结果</span>';
    case 'fetching':
      return '<span class="agent-icon agent-spin">' + iconSvg('idea','14') + '</span> <span class="agent-label">正在阅读 ' + _esc(data.url || '') + '</span>';
    case 'fetch_done':
      return '<span class="agent-icon agent-done">' + iconSvg('check','14') + '</span> <span class="agent-label">获取 ' + (data.length || 0) + ' 字内容</span>';
    case 'kb_searching':
      return '<span class="agent-icon agent-spin">' + iconSvg('books','14') + '</span> <span class="agent-label">检索知识库「' + _esc(data.query || '') + '」</span>';
    case 'kb_done':
      return '<span class="agent-icon agent-done">' + iconSvg('check','14') + '</span> <span class="agent-label">找到 ' + (data.count || 0) + ' 篇相关文档</span>';
    // Patch4 v3：workspace 工具
    case 'workspace_writing':
      return '<span class="agent-icon agent-spin">' + iconSvg('write','14') + '</span> <span class="agent-label">正在写入 ' + _esc(data.path || data.name || '') + '</span>';
    case 'workspace_write_done':
      return '<span class="agent-icon agent-done">' + iconSvg('check','14') + '</span> <span class="agent-label">已写入 ' + _esc(data.name || '') + '</span>';
    case 'workspace_reading':
      return '<span class="agent-icon agent-spin">' + iconSvg('doc','14') + '</span> <span class="agent-label">正在读取 ' + _esc(data.path || '') + '</span>';
    case 'workspace_read_done':
      return '<span class="agent-icon agent-done">' + iconSvg('check','14') + '</span> <span class="agent-label">已读取 ' + _esc(data.name || '') + '</span>';
    case 'workspace_listing':
      return '<span class="agent-icon agent-spin">' + iconSvg('doc','14') + '</span> <span class="agent-label">正在列出工作区文件</span>';
    case 'workspace_listed':
      return '<span class="agent-icon agent-done">' + iconSvg('check','14') + '</span> <span class="agent-label">工作区有 ' + (data.count || 0) + ' 个文件</span>';
    case 'workspace_deleting':
      return '<span class="agent-icon agent-spin">' + iconSvg('trash','14') + '</span> <span class="agent-label">正在删除 ' + _esc(data.path || '') + '</span>';
    case 'workspace_deleted':
      return '<span class="agent-icon agent-done">' + iconSvg('check','14') + '</span> <span class="agent-label">已删除 ' + _esc(data.name || '') + '</span>';
    // Patch4 v3.1 BUG#3 修复：append/edit workspace 实时状态
    case 'workspace_appending':
      return '<span class="agent-icon agent-spin">' + iconSvg('write','14') + '</span> <span class="agent-label">正在追加 ' + _esc(data.path || data.name || '') + '</span>';
    case 'workspace_appended':
      return '<span class="agent-icon agent-done">' + iconSvg('check','14') + '</span> <span class="agent-label">已追加 ' + _esc(data.name || '') + ' (+' + (data.appended || 0) + ' 字节)</span>';
    case 'workspace_editing':
      return '<span class="agent-icon agent-spin">' + iconSvg('write','14') + '</span> <span class="agent-label">正在编辑 ' + _esc(data.path || data.name || '') + '</span>';
    case 'workspace_edited':
      return '<span class="agent-icon agent-done">' + iconSvg('check','14') + '</span> <span class="agent-label">已编辑 ' + _esc(data.name || '') + ' (' + (data.replaced || 0) + ' 处替换)</span>';
    // Patch4 v3：list_docs / set_doc_status
    case 'docs_listing':
      return '<span class="agent-icon agent-spin">' + iconSvg('doc','14') + '</span> <span class="agent-label">正在列出文档</span>';
    case 'docs_listed':
      return '<span class="agent-icon agent-done">' + iconSvg('check','14') + '</span> <span class="agent-label">工作区有 ' + (data.count || 0) + ' 个文档</span>';
    case 'doc_status_updating':
      return '<span class="agent-icon agent-spin">' + iconSvg('check','14') + '</span> <span class="agent-label">正在标记 ' + _esc(data.filename || '') + ' 完成...</span>';
    case 'doc_status_done':
      return '<span class="agent-icon agent-done">' + iconSvg('check','14') + '</span> <span class="agent-label">已生成 ' + _esc(data.docx_path || data.filename || '') + '</span>';
    case 'budget_exceeded':
      return '<span class="agent-icon agent-warn">' + iconSvg('warn','14') + '</span> <span class="agent-label">工具调用已达上限，正在整理回答...</span>';
    case 'tool_limited':
      return '<span class="agent-icon agent-warn">' + iconSvg('warn','14') + '</span> <span class="agent-label">部分工具已达上限</span>';
    case 'error':
      return '<span class="agent-icon agent-error">' + iconSvg('cross','14') + '</span> <span class="agent-label">工具执行失败' + (data.tool ? ' (' + _esc(data.tool) + ')' : '') + '</span>';
    default:
      return '<span class="agent-icon agent-spin">' + iconSvg('spin','14') + '</span> <span class="agent-label">处理中...</span>';
  }
}

function _handleAgentSummary(data) {
  // 持久化：收集 summary 数据
  _agentTimelineData.push({status: '_summary', data: data});

  var parts = [];
  if (data.searches) parts.push('搜索了 ' + data.searches + ' 次');
  if (data.fetches) parts.push('抓取了 ' + data.fetches + ' 个网页');
  if (data.kb_hits) parts.push('检索了 ' + data.kb_hits + ' 篇文档');
  if (data.docs) parts.push('生成了 ' + data.docs + ' 个文档操作');
  if (data.elapsed) parts.push('用时 ' + data.elapsed + ' 秒');
  if (!parts.length) return;

  // 在时间线末尾追加总结标签（不替换）
  var summary = document.createElement("div");
  summary.className = "agent-timeline-summary";
  summary.innerHTML = '<span class="agent-tl-summary-icon">' + iconSvg('doc','14') + '</span> ' + parts.join(' \xB7 ');

  if (_agentTimelineEl && _agentTimelineEl.parentNode) {
    _agentTimelineEl.appendChild(summary);
  } else {
    var streamEl = document.getElementById("stream-msg");
    if (streamEl) {
      var wrap = document.createElement("div");
      wrap.className = "agent-timeline";
      wrap.appendChild(summary);
      streamEl.insertBefore(wrap, streamEl.firstChild);
    }
  }
  // 不清空 _agentTimelineEl，让下次新的 agent 会话自动创建新容器
  _agentTimelineEl = null;
}

function _esc(str) {
  var d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}

// 确认文档提纲 → 发起新请求生成完整文档
function confirmDocOutline() {
  var bar = document.getElementById('docConfirmBar');
  if (bar) bar.remove();
  // 清除 outline pending 标记，恢复正常渲染流程
  window._docOutlinePending = false;
  // 把 stream-msg 的 id 移除，让 sendMessage 创建新的
  var oldStream = document.getElementById('stream-msg');
  if (oldStream) oldStream.removeAttribute('id');
  var outline = window._docOutlineText || '';
  window._docOutlineText = null;
  if (!outline) {
    showToast('提纲内容为空，无法生成', 'error');
    return;
  }
  // 保存 Phase 1 的 KB 引用路径，供 Phase 2 使用（Phase 1 发完后 _refFilePath 已被 clearFileRef 清空）
  if (typeof _savedRefPathForDoc !== 'undefined' && _savedRefPathForDoc) {
    window._docPhase2FilePath = _savedRefPathForDoc;
  }
  // 保存 doc_continue 参数
  window._docContinueOutline = outline;
  // 直接调用 sendMessage（不修改输入框，sendMessage 会读取 _docContinueOutline）
  var input = document.getElementById('msgInput');
  if (input) {
    input.value = '请基于已确认的提纲，生成完整文档';
  }
  sendMessage();
}

// 取消文档生成
function cancelDocOutline() {
  var bar = document.getElementById('docConfirmBar');
  if (bar) bar.remove();
  window._docOutlineText = null;
  window._docOutlinePending = false;
  // 恢复正常渲染
  var oldStream = document.getElementById('stream-msg');
  if (oldStream) oldStream.removeAttribute('id');
  renderMessages();
  showToast('已取消文档撰写', 'info');
}

window.confirmDocOutline = confirmDocOutline;
window.cancelDocOutline = cancelDocOutline;

// ===== Patch4 v3: DocProgressTracker — 文档进度面板（基于文件 + 字数） =====
// 不再有"章节"概念，只有"文件 + 字数 + 状态（drafting/completed）"。
// 触发源：
//   - agent_status(workspace_write_done) + 文件名以 .md 结尾 → addWriteWorkspace
//   - doc_complete → markCompleted（进度面板变绿 + 下载按钮）
var _docProgressTracker = null;  // 全局单例（每次 sendMessage 重置）

function _resetDocProgress() {
  _docProgressTracker = null;
  var oldPanel = document.getElementById('doc-progress-panel');
  if (oldPanel) oldPanel.remove();
}

function _getDocProgressTracker(streamEl) {
  if (!_docProgressTracker) {
    _docProgressTracker = new DocProgressTracker(streamEl);
  } else if (streamEl && !_docProgressTracker.panelEl.parentNode) {
    // 重建挂载（如 streamEl 已被重新创建）
    streamEl.insertBefore(_docProgressTracker.panelEl, streamEl.firstChild);
  }
  return _docProgressTracker;
}

function DocProgressTracker(streamEl) {
  this.active = false;
  this.startTime = null;
  this.totalTime = null;
  // files: [{filename, status: 'drafting'|'completed', words, lastWriteTs}]
  this.files = [];
  this._timerInterval = null;

  // 创建 DOM
  this.panelEl = document.createElement('div');
  this.panelEl.className = 'doc-progress-panel';
  this.panelEl.id = 'doc-progress-panel';
  this.panelEl.innerHTML =
    '<div class="doc-progress-header">' +
      '<span class="doc-progress-title"></span>' +
      '<span class="doc-progress-timer"></span>' +
    '</div>' +
    '<div class="doc-progress-files"></div>' +
    '<div class="doc-progress-download"></div>';

  if (streamEl) {
    streamEl.insertBefore(this.panelEl, streamEl.firstChild);
  }
}

DocProgressTracker.prototype._activate = function() {
  if (this.active) return;
  this.active = true;
  this.startTime = Date.now();
  this.panelEl.classList.add('active');
  this.panelEl.querySelector('.doc-progress-title').innerHTML =
    iconSvg('doc', '14') + ' 文档生成中';
  // 启动计时器
  var self = this;
  this._timerInterval = setInterval(function() {
    // 所有文件都 completed 时停止更新
    var allDone = self.files.length > 0 && self.files.every(function(f) { return f.status === 'completed'; });
    if (allDone) return;
    var elapsed = Math.floor((Date.now() - self.startTime) / 1000);
    var mm = Math.floor(elapsed / 60);
    var ss = elapsed % 60;
    var timerEl = self.panelEl.querySelector('.doc-progress-timer');
    if (timerEl) timerEl.textContent = mm + '\'' + (ss < 10 ? '0' : '') + ss + '\"';
  }, 1000);
};

// write_workspace 写了 .md 文件 → 记录/累加字数（drafting 状态）
DocProgressTracker.prototype.addWriteWorkspace = function(filename, words) {
  this._activate();
  // 找已有条目
  var entry = null;
  for (var i = 0; i < this.files.length; i++) {
    if (this.files[i].filename === filename) { entry = this.files[i]; break; }
  }
  if (!entry) {
    entry = {
      filename: filename,
      status: 'drafting',
      words: 0,
      lastWriteTs: Date.now(),
    };
    this.files.push(entry);
  }
  // 累加字数（同一文件多次 write_workspace 覆盖更新；words 为本次增量）
  if (words && words > 0) entry.words += words;
  entry.lastWriteTs = Date.now();
  this._renderFiles();
};

// set_doc_status completed → 标记某文件完成
DocProgressTracker.prototype.markCompleted = function(filename, docxPath, docUrl) {
  this._activate();
  var entry = null;
  for (var i = 0; i < this.files.length; i++) {
    if (this.files[i].filename === filename) { entry = this.files[i]; break; }
  }
  if (!entry) {
    // 模型可能直接 set_doc_status 而没经过 addWriteWorkspace（如续写场景）
    entry = {filename: filename, status: 'drafting', words: 0, lastWriteTs: Date.now()};
    this.files.push(entry);
  }
  entry.status = 'completed';
  this._renderFiles();

  // 下载按钮（每个完成的文件一个）
  this._renderDownloads(docUrl, docxPath);
};

DocProgressTracker.prototype._renderFiles = function() {
  var box = this.panelEl.querySelector('.doc-progress-files');
  if (!box) return;
  var html = '';
  for (var i = 0; i < this.files.length; i++) {
    var f = this.files[i];
    var icon = '';
    var cls = '';
    if (f.status === 'completed') {
      icon = '<span class="doc-file-icon done">' + iconSvg('check', '14') + '</span>';
      cls = 'completed';
    } else {
      icon = '<span class="doc-file-icon drafting">' + iconSvg('write', '14') + '</span>';
      cls = 'drafting';
    }
    var wordsStr = f.words > 0 ? ('<span class="doc-file-words">' + f.words + ' 字</span>') : '';
    html += '<div class="doc-progress-file ' + cls + '">' +
      icon + '<span class="doc-file-name">' + _esc(f.filename) + '</span>' +
      '<span class="doc-file-status">' + (f.status === 'completed' ? '已完成' : '写作中') + '</span>' +
      wordsStr +
      '</div>';
  }
  box.innerHTML = html;
};

DocProgressTracker.prototype._renderDownloads = function(docUrl, docxPath) {
  var dlBox = this.panelEl.querySelector('.doc-progress-download');
  if (!dlBox) return;
  var apiBase = (typeof API !== 'undefined' ? API : '');
  // docUrl 来自后端（/api/chat/{chat_id}/doc/{key}/download）
  var fullUrl = docUrl ? (docUrl.indexOf('http') === 0 ? docUrl : (apiBase + docUrl)) : '';
  if (!fullUrl) return;
  var fname = docxPath || 'document.docx';
  // 已完成文件数（用于下载按钮文案）
  var doneCount = 0;
  for (var i = 0; i < this.files.length; i++) {
    if (this.files[i].status === 'completed') doneCount++;
  }
  // 标记面板整体已完成（全部完成时）
  if (doneCount === this.files.length && this.files.length > 0) {
    this.panelEl.classList.add('completed');
    if (this._timerInterval) { clearInterval(this._timerInterval); this._timerInterval = null; }
    var timerEl = this.panelEl.querySelector('.doc-progress-timer');
    if (timerEl && this.totalTime != null) {
      var t = Math.floor(this.totalTime);
      var mm2 = Math.floor(t / 60), ss2 = t % 60;
      timerEl.textContent = mm2 + '\'' + (ss2 < 10 ? '0' : '') + ss2 + '\"';
    }
  }
  dlBox.innerHTML = '<a href="' + _esc(fullUrl) + '" download="' + _esc(fname) + '" target="_blank">' +
    iconSvg('doc', '14') + ' 下载 ' + _esc(fname) + '</a>';
};

// 全局调度入口（从 SSE 事件分发处调用）
function _handleDocProgressEvent(eventType, data) {
  var streamEl = document.getElementById('stream-msg');
  if (!streamEl) return;
  var tracker = _getDocProgressTracker(streamEl);
  if (!tracker) return;
  data = data || {};
  if (eventType === 'write_workspace_md') {
    // agent_status workspace_write_done 写了 .md 文件
    tracker.addWriteWorkspace(data.filename || '', data.words || 0);
  } else if (eventType === 'doc_complete') {
    // set_doc_status completed 完成
    // 新数据结构: {filename(docx), doc_url, md_filename, total_time, ts}
    tracker.totalTime = data.total_time || null;
    var mdName = data.md_filename || '';
    var docxFname = data.filename || 'document.docx';
    tracker.markCompleted(mdName, docxFname, data.doc_url || '');
  }
}
window._handleDocProgressEvent = _handleDocProgressEvent;
window._resetDocProgress = _resetDocProgress;

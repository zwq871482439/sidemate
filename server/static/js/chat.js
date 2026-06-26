// ===== chat.js — 对话核心：消息发送、SSE 流式、渲染（需先加载子模块） =====

var _lastScrollBottom = false;  // 跟踪是否在底部（用于自动滚动）
var _cloudThinkText = '';       // 云端推理模型的思考内容（全局，跨函数共享）
var _cloudThinking = false;     // 是否正在云端推理中
var _thinkingTimerInterval = null; // Patch5 C7 B3：思考态计时器
var _hasMorphedToAnswering = false; // P6：思考→回答过渡标记

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
    var label = s.label || ('来源' + (i+1));
    var snippet = s.snippet || '';
    var score = s.reranker_score || s.score || 0;
    // 相关度分数条（可视化，0-100%）
    var scorePct = Math.min(100, Math.round(score * 100));
    var scoreBar = score > 0 ? '<div class="kb-source-score" title="相关度 ' + scorePct + '%"><div class="kb-source-score-fill" style="width:' + scorePct + '%"></div></div>' : '';
    html += '<div class="kb-source-item" data-src-idx="' + i + '">'
      + '<span class="kb-source-num">' + (i + 1) + '</span>'
      + '<div class="kb-source-content">'
      + '<div class="kb-source-head"><span class="kb-source-label">' + esc(label) + '</span>' + scoreBar + '</div>'
      + (snippet ? '<div class="kb-source-snippet">' + esc(snippet) + '</div>' : '')
      + '</div>'
      + '</div>';
  });
  return html + '</div>';
}

// 绑定引用上标点击事件：点击高亮对应参考来源（在工具链卡片内）
function _bindCitationClicks(el) {
  if (!el) el = document.getElementById('messages');
  if (!el) return;
  var refs = el.querySelectorAll('.cite-ref');
  refs.forEach(function(ref) {
    ref.addEventListener('click', function(e) {
      e.stopPropagation();
      var idx = this.getAttribute('data-cite');
      var msg = this.closest('.msg');
      if (!msg) return;
      // 优先找工具链卡片里的来源项（.cb-src），fallback 到旧 .kb-source-item
      var srcItem = msg.querySelectorAll('.cb-src')[idx]
                 || msg.querySelector('.kb-source-item[data-src-idx="' + idx + '"]');
      if (srcItem) {
        // 移除其他高亮
        msg.querySelectorAll('.cite-highlight').forEach(function(s) {
          s.classList.remove('cite-highlight');
        });
        // 高亮当前项
        srcItem.classList.add('cite-highlight');
        srcItem.scrollIntoView({behavior:'smooth', block:'nearest'});
        // 2秒后自动取消高亮
        setTimeout(function() { srcItem.classList.remove('cite-highlight'); }, 2000);
      }
    });
  });
}

// 把正文里的 [1] [2] 渲染成可交互的引用上标（链接到参考来源）
function _renderCitationSuperscripts(html, kbSources) {
  if (!kbSources || !kbSources.length) return html;
  // 匹配 [1] [2] 等引用标注（不匹配代码块内的）
  // 用占位符保护 <code> 和 <pre> 内容
  var codeBlocks = [];
  html = html.replace(/<(code|pre)[^>]*>[\s\S]*?<\/\1>/gi, function(m) {
    codeBlocks.push(m);
    return '\x00CB' + (codeBlocks.length - 1) + '\x00';
  });
  // 替换 [n] 为上标
  html = html.replace(/\[(\d+)\]/g, function(match, num) {
    var idx = parseInt(num, 10) - 1;
    if (idx >= 0 && idx < kbSources.length) {
      return '<sup class="cite-ref" data-cite="' + idx + '">' + num + '</sup>';
    }
    return match;
  });
  // 还原代码块
  for (var i = 0; i < codeBlocks.length; i++) {
    html = html.replace('\x00CB' + i + '\x00', codeBlocks[i]);
  }
  return html;
}

function _buildStats(m) {
  if (!m.model || m.time == null) return '';
  // 模型短名（去掉 :latest / :tag 后缀）+ 离线/在线前缀
  var _shortModel = (m.model || '').replace(/:.*$/, '');
  var _prefix = (m.action_mode === 'agent') ? '在线 AI' : '离线 AI';
  var modelTag = '<span class="action-tag">' + _prefix + ' · ' + esc(_shortModel) + '</span>';
  // 核心数字（summary 里显示）
  var _timeStr = Number(m.time).toFixed(1) + 's';
  var _speedStr = Math.round(m.speed || 0) + '字/s';
  var _charsStr = (m.chars || 0) + '字';
  var _thinkStr = (m.think_chars && m.think_chars > 0) ? ' · 深思' + m.think_chars + '字' : '';
  var _summaryMeta = _charsStr + _thinkStr + ' · ' + _timeStr + ' · ' + _speedStr;
  // 词元统计（展开后横向显示）
  var ts = m.token_stats || {};
  var inputTok = ts.input_tokens || 0;
  var outputTok = ts.output_tokens || 0;
  var reasonTok = ts.reasoning_tokens || 0;
  if (!outputTok && m.chars) {
    outputTok = Math.round(m.chars / 1.5);
  }
  // 合并为单个 details：summary = 模型tag + 核心数字；展开 = 词元详情横向排列
  var hasToken = (inputTok || outputTok || reasonTok);
  var approx = m.token_stats ? '' : '约 ';
  var detailRows = '';
  if (inputTok) detailRows += '<span class="tk"><span class="tk-k">输入</span><span class="tk-v">' + approx + inputTok.toLocaleString() + ' 词元</span></span>';
  if (outputTok) detailRows += '<span class="tk"><span class="tk-k">输出</span><span class="tk-v">' + approx + outputTok.toLocaleString() + ' 词元</span></span>';
  if (reasonTok) detailRows += '<span class="tk"><span class="tk-k">推理</span><span class="tk-v">' + approx + reasonTok.toLocaleString() + ' 词元</span></span>';
  if (!hasToken) {
    // 无词元数据：不展开，直接显示一行
    return '<div class="stats">' + modelTag + '<span class="stats-meta">' + _summaryMeta + '</span></div>';
  }
  return '<details class="stats-detail stats-fold">' +
    '<summary>' + modelTag + '<span class="stats-meta">' + _summaryMeta + '</span></summary>' +
    '<div class="stats-detail-body">' + detailRows + '</div>' +
    '</details>';
}

// ===== P6 打磨：Phase 阶段卡片系统（并行模式用）=====

// P6 打磨：并行模式流式内容渲染到对应 timeline 步骤
var _parallelChannelRendered = {};  // 记录每个 channel 的 rendered 行数（带行号）

// ===== 最终渲染（消息列表）=====
function _renderSingleMsg(m, idx) {
  var ts = m.ts ? '<div class="ts">' + esc(m.ts) + '</div>' : '';
  // P6: action mode 标签（聊天/文档/知识库问答），放在时间旁边
  var actionTag = '';
  if (m.action_mode) {
    var labels = { chat: '聊天', doc: '文档', kb_qa: '知识库', agent: '智能对话' };
    var label = labels[m.action_mode] || m.action_mode;
    actionTag = '<span class="action-tag">' + esc(label) + '</span>';
  }
  // think 数据保留在 m.think 中（模型上下文），但不再渲染展示
  var bodyHtml = _renderMsgBody(m.content || '');
  // P6 修复: 统一终止提示样式。识别 _aborted 标记，剔除旧 content 里残留的
  // "> ⏹ 用户已手动终止响应" blockquote（兼容历史数据），改用统一的 SVG 图标提示
  if (m._aborted) {
    var _abortTmp = document.createElement('div');
    _abortTmp.innerHTML = bodyHtml;
    var _oldBq = _abortTmp.querySelectorAll('blockquote');
    _oldBq.forEach(function(bq) {
      if (bq.textContent.indexOf('用户已手动终止响应') >= 0) bq.remove();
    });
    bodyHtml = _abortTmp.innerHTML;
  }
  // 引用标注 [1][2] 渲染成上标（仅 KB 消息）
  if (m.kb_sources && m.kb_sources.length) {
    bodyHtml = _renderCitationSuperscripts(bodyHtml, m.kb_sources);
  }
  // 阶段3 Step2b：CardRenderer 历史回放（读 card_data）
  var timelineHtml = '';
  if (m.card_data) {
    timelineHtml = CardRenderer.renderHistory(m);
  }
  // 结构与流式 finalizeDOM 后同构：card-area(步骤) → stream-content(正文) → msg-footer(统计/复制)
  // actionTag 统一放最前面；KB 参考来源已在工具链卡片里展示，正文区不再重复
  var bodyExtras = actionTag + ts + bodyHtml;
  // Patch4 v3.1 BUG#13+17：如果消息有 doc_url，追加独立下载栏（刷新页面也能看到）
  var docBarHtml = '';
  if (m.doc_url) {
    var _dlUrl = m.doc_url;
    if (_dlUrl.indexOf('http') !== 0) _dlUrl = (typeof API !== 'undefined' ? API : '') + _dlUrl;
    docBarHtml = '<div class="doc-download-bar" data-doc-complete="1"><a href="' + esc(_dlUrl) + '" download="' + esc(m.doc_filename || 'document.docx') + '" class="doc-download-btn" target="_blank">' + iconSvg('doc','14') + ' 下载 ' + esc(m.doc_filename || 'document.docx') + '</a></div>';
  }
  var footerHtml = _buildStats(m);
  // P6 修复: 终止提示统一渲染（与流式 catch 块的 _abortNotice 同款 SVG 样式）
  var _abortedHtml = m._aborted
    ? '<div class="msg-aborted">' + iconSvg('stop','14') + ' 用户已手动终止响应</div>'
    : '';
  if (footerHtml) {
    // 有统计：正文区 + 独立 footer（与流式 done 路径一致）
    return timelineHtml
      + '<div class="stream-content">' + bodyExtras + _buildFileTag(m) + _abortedHtml + '</div>'
      + docBarHtml
      + '<div class="msg-footer msg-copy-wrap">' + footerHtml + _buildCopyBtn() + '</div>';
  }
  // 无统计（用户消息/纯文本）：正文区 + 复制按钮包裹
  return '<div class="msg-copy-wrap">'
    + timelineHtml
    + '<div class="stream-content">' + bodyExtras + _buildFileTag(m) + _abortedHtml + '</div>'
    + docBarHtml
    + _buildCopyBtn()
    + '</div>';
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
            '<span>' + iconSvg('book','11') + ' 支持引用知识库文档</span>' +
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
    if (typeof _renderMermaid === 'function') _renderMermaid(el);
    if (typeof _renderHtmlPreview === 'function') _renderHtmlPreview(el);
    if (typeof CodeBlockEnhancer !== 'undefined') CodeBlockEnhancer.enhance(el);
    _bindCitationClicks(el);
    if (_lastScrollBottom) { el.scrollTop = el.scrollHeight; }
    return;
  }
  el.innerHTML = currentMessages.map(function(m) { return renderMsg(m); }).join('');
  applyCodeHighlight(el);
  if (typeof CodeBlockEnhancer !== 'undefined') CodeBlockEnhancer.enhance(el);

  // 绑定引用上标点击：高亮对应参考来源
  _bindCitationClicks(el);

  // 恢复未完成的文档提纲（页面刷新后重建确认栏）
  if (currentMessages.length > 0) {
    var _lastMsg = currentMessages[currentMessages.length - 1];
    if (_lastMsg.role === 'assistant' && _lastMsg.action_mode === 'doc' && _lastMsg.doc_phase === 'outline' && _lastMsg.content) {
      if (!document.getElementById('docConfirmBar')) {
        var _bar = _createDocConfirmBar(_lastMsg.content);
        el.appendChild(_bar);
        window._docOutlineText = _lastMsg.content;
        window._docOutlinePending = true;
      }
    }
  }
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

  // P6 打磨：使用 #stream-content 子元素做打字机区域，不再 innerHTML 全量替换
  // 这样 #agent-timeline / doc panels / download bars 作为同级子元素绝不会被销毁
  var contentEl = streamEl.querySelector('#stream-content');
  if (!contentEl) {
    contentEl = document.createElement('div');
    contentEl.id = 'stream-content';
    contentEl.className = 'stream-content';
    streamEl.appendChild(contentEl);
  }

  // done 终态：stats 作为独立 footer 追加到 stream-msg（不重写 #stream-content，消除完成闪烁）
  // 这样正文 DOM 原封不动，只新增一条统计/复制栏，视觉上无重排。
  if (stats) {
    // 空回复兜底：若正文区尚未渲染（空回复/友好提示场景），先补渲染正文
    var _curBody = contentEl.querySelector('p, div:not(.thinking-indicator)');
    if (!_curBody && content) {
      contentEl.innerHTML = _renderMsgBody(content, {sanitize: false});
    }
    // 先清掉旧的 footer（重复 done / error 兜底时安全）
    var _oldFooter = streamEl.querySelector('.msg-footer');
    if (_oldFooter) _oldFooter.remove();
    var _footer = document.createElement('div');
    _footer.className = 'msg-footer msg-copy-wrap';
    _footer.innerHTML = stats + _buildCopyBtn();
    streamEl.appendChild(_footer);
    if (!userScrolledUp) el.scrollTop = el.scrollHeight;
    return;
  }

  var html = '';
  if (isThinking) {
    var _isGenerating = (isThinking === 'generating');
    // P6 T04: 骨架屏已移除，只需检查非云端模式
    var _isCloudMode = (typeof _currentMode !== 'undefined' && _currentMode === 'cloud');
    if (!_isCloudMode) {
      // 思考中 → 回答中 无缝过渡：同一个 indicator，只改文案
      var _indicatorLabel = _isGenerating ? '回答中' : '思考中';
      html += '<div class="thinking-indicator"><span class="thinking-dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span> ' + _indicatorLabel + ' <span class="thinking-timer" data-start="' + Date.now() + '">0.0s</span></div>';
      // 启动计时器（只在初次思考时启动，回答中阶段不重启以保证计时连续）
      if (!_isGenerating) {
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
    }
    if (content) {
      if (_isGenerating) {
        // 回答中：正文正常渲染
        html += _renderMsgBody(content, {sanitize: false});
      } else {
        // 思考中：思考内容用斜体灰色展示
        html += '<div style="color:var(--text-muted);font-style:italic;font-size:.85em">' + md(content, false) + '</div>';
      }
    }
  } else {
    html += _renderMsgBody(content, {sanitize: false});
  }
  // P6 打磨：生成阶段提前显示 action tag + 时间戳
  if (_isGenerating && !stats) {
    var _labels = { chat: '聊天', doc: '文档', kb_qa: '知识库' };
    var _action_label = _labels[currentActionMode] || '聊天';
    html += '<div class="ts" style="margin-top:4px"><span class="action-tag">' + esc(_action_label) + '</span> ' + new Date().toTimeString().slice(0,8) + '</div>';
  }
  // 注：stats 分支已在上方提前 return（追加为独立 footer，不重写正文）

  // 只更新 #stream-content，不碰时间线/面板/下载栏
  // 修复：计时器 start 值跨渲染保持连续（思考中/回答中均需保存恢复，否则每个 token 重置）
  // 关键：恢复时不仅要写回 data-start，还要立即重算 textContent，否则重建后的 "0.0s" 会停留到下一个 interval tick
  var _prevTimerStart = 0;
  if (isThinking) {
    var _prevTimer = contentEl.querySelector('.thinking-timer');
    if (_prevTimer) _prevTimerStart = parseInt(_prevTimer.getAttribute('data-start') || '0', 10);
  }
  contentEl.innerHTML = html;
  if (_prevTimerStart && isThinking) {
    var _newTimer = contentEl.querySelector('.thinking-timer');
    if (_newTimer) {
      _newTimer.setAttribute('data-start', _prevTimerStart);
      _newTimer.textContent = ((Date.now() - _prevTimerStart) / 1000).toFixed(1) + 's';
    }
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

  // P6 打磨：使用 #stream-content 子元素，不破坏时间线
  var contentEl = streamEl.querySelector('#stream-content');
  if (!contentEl) {
    contentEl = document.createElement('div');
    contentEl.id = 'stream-content';
    contentEl.className = 'stream-content';
    streamEl.appendChild(contentEl);
  }

  // AgentTimeline 已负责"思考中..."状态展示，这里只显示 think-details（思考内容详情，可折叠）
  if (len >= 20) {
    html += '<details open class="think-details"><summary>' + iconSvg('think','14') + ' 思考内容 (' + len + '字)</summary><div class="think-content">' + md(text, false) + '</div></details>';
  }
  if (mainText) html += _renderMsgBody(mainText, {sanitize: false});
  contentEl.innerHTML = html;

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

// P6: 并行模式状态重置（sendMessage 调用）
function _resetParallelState() {
  window._parallelChannelTexts = {};
  _parallelChannelRendered = {};
}
window._resetParallelState = _resetParallelState;

// ===== 发送消息 =====
async function sendMessage() {
  var input = document.getElementById('msgInput');
  var text = input.value.trim();
  // 文档 Phase2 确认时消息为空（由 doc_continue 驱动），允许通过
  if (!text && !(window._docContinueOutline) && (typeof pendingFile !== 'undefined') && !pendingFile) return;
  if (typeof generating !== 'undefined' && generating) return;
  if (_stopping) { showToast('正在停止当前响应，请稍候...', 'warning'); return; }

  var modelTag = document.getElementById('modelTag');
  var isLocalMode = typeof _currentMode === 'undefined' || _currentMode !== 'cloud';
  if (isLocalMode && modelTag && modelTag.classList.contains('none')) {
    showToast('请先在「设置」页面加载模型，再开始对话', 'warning');
    return;
  }

  // Patch5 G：文档 token 预检 — 超过当前模型上下文窗口 95% 直接拒绝发送
  if (typeof TokenEstimator !== 'undefined') {
    var _docTok = TokenEstimator._estimateDoc();
    var _maxTok = (typeof _maxPromptTokens !== 'undefined') ? _maxPromptTokens : 8192;
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
  // 文档 Phase2（doc_continue）不显示 user 消息气泡（避免空的"请基于提纲生成"假消息）
  if (!(window._docContinueOutline) && text) {
    currentMessages.push(userMsg);
  }
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
        ? ('[用户引用了知识库文档: ' + (pendingFile.name || '') + '，请读取并参考]')
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

  _resetParallelState();  // P6 打磨：重置并行模式流式状态
  _hasMorphedToAnswering = false;  // P6 打磨：重置思考→回答过渡
  window._parallelLastStatus = {};  // P6 打磨：重置云端状态去重

  appendStreamingMsg('', '', 0, null, true);
  // 阶段3 Step2b：CardRenderer 重置 + 挂载到 #stream-msg
  CardRenderer.reset();
  var _streamMsgEl = document.getElementById('stream-msg');
  if (_streamMsgEl) CardRenderer.mount(_streamMsgEl);
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
    // 前后端协议映射：前端 action_id → 后端 action_mode
    var _actionModeForBackend = currentActionMode || 'chat';
    if (_actionModeForBackend === 'agent') _actionModeForBackend = 'chat';
    if (_actionModeForBackend === 'kb_qa') _actionModeForBackend = 'kb';  // P6: 知识库问答映射
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
          } else if (d.type === 'pipeline_progress' || d.type === 'step' || d.type === 'step_done' ||
                     d.type === 'phase' || d.type === 'status') {
            // 阶段3 Step2b：切换到 CardRenderer（旧 _handleParallelSSE 保留备用，Step2c 删除）
            CardRenderer.handleEvent(d);
          // 并行模式 stream 事件（带 channel 字段：local/cloud/merge）
          } else if (d.type === 'stream') {
            var ch = d.channel || 'merge';
            if (!window._parallelChannelTexts) window._parallelChannelTexts = {};
            if (!window._parallelChannelTexts[ch]) window._parallelChannelTexts[ch] = '';
            window._parallelChannelTexts[ch] += d.content || '';
            // 阶段3 Step2b：CardRenderer 渲染双列流式（替代 _renderParallelChannelContent）
            CardRenderer.handleStream(d);
            // 同步更新 fullText（最终 DONE 需要用到）—— 必须保留
            if (ch === 'merge') fullText = window._parallelChannelTexts[ch];
          } else if (d.type === 'sources') {
            // 阶段3 Step2b：检索结果 → CardRenderer（替代 _renderParallelSources）
            CardRenderer.handleEvent(d);
          } else if (d.type === 'mode_hint') {
            // 模块1修复：并行模式 mode_hint 不再静默丢弃（fallback 分支的提示文案）
            CardRenderer.handleEvent(d);
          } else if (d.type === 'token') {
            fullText += d.content;
            // P6 打磨：思考→回答无缝过渡，只改文案不变DOM结构
            if (fullText.length > 0 && _thinkingTimerInterval && !thinkingPhase && !_hasMorphedToAnswering) {
              _hasMorphedToAnswering = true;
              var _ti = document.querySelector('.thinking-indicator');
              if (_ti) {
                _ti.innerHTML = _ti.innerHTML.replace('思考中', '回答中');
              }
            }
            // P6 打磨：thinkingPhase 不再基于 task_type 自动进入
            // 只由 think_start/fold 显式事件触发，避免正文被误渲染为思考内容
            // (task_type=qa/reasoning/math 等导致本地模型 token 全成了斜体灰字)
            if (now - lastRender > RENDER_INTERVAL) {
              if (thinkingPhase) {
                if (detectThinkRepetition(fullText)) {
                  var abbr = fullText.slice(0, 80) + '\n\n--- [思考内容出现重复，已省略 ' + (fullText.length - 130) + ' 字] ---\n\n' + fullText.slice(-50);
                  appendStreamingMsg(abbr, '', 0, null, true);
                } else {
                  appendStreamingMsg(fullText, '', 0, null, true);
                }
              } else {
                // P6 打磨：生成阶段保持"回答中"指示器
                appendStreamingMsg(fullText, thinkText, thinkLen, null, 'generating');
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
              finalStats = _buildStats({
                model: d.model, chars: d.chars, think_chars: d.think_chars || 0,
                time: d.time, speed: d.speed, token_stats: d.token_stats,
                action_mode: currentActionMode || 'chat'
              });
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
              // 过滤掉纯格式类警告（未闭合粗体/括号等）：对用户无实际价值，反而刺眼。
              // 只保留真正影响阅读/内容的语义类警告（重复截断、幻觉等）。
              var _fmtKw = ['未闭合的 Markdown', '未闭合代码块', '未闭合的括号', '多余的括号', '个未闭合', '个多余的'];
              var _meaningful = d.warnings.filter(function(w) {
                return !_fmtKw.some(function(k) { return w.indexOf(k) !== -1; });
              });
              d.warnings = _meaningful;  // 全过滤完则为空数组，下方 if 自然跳过
            }
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
          // 阶段3 Step2b：AgentTimeline/KB事件 → CardRenderer（旧 _handle* 保留备用）
          } else if (d.type === 'agent_timeline') {
            CardRenderer.handleEvent(d);
          } else if (d.type === 'kb_reformulate') {
            CardRenderer.handleEvent(d);
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
          // ===== Cloud Agent 事件 → CardRenderer（保留 doc progress 副作用）=====
          } else if (d.type === 'agent_status') {
            // 阶段3 Step2b：CardRenderer 处理工具调用展示
            CardRenderer.handleEvent(d);
            // Patch4 v3：write_workspace 写入 .md 文件 → 进度面板显示"写作中"（副作用，必须保留）
            if (d.status === 'workspace_write_done' && typeof _handleDocProgressEvent === 'function') {
              var _wwName = d.name || d.path || '';
              if (_wwName && _wwName.toLowerCase().endsWith('.md')) {
                _handleDocProgressEvent('write_workspace_md', {filename: _wwName, words: d.words || d.size || 0});
              }
            }
          } else if (d.type === 'agent_summary') {
            CardRenderer.handleEvent(d);
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
          // KB 引用来源 — P6 打磨：注入到搜索步骤的 .agent-tl-content，不再单独渲染 kb-sources-bar
          } else if (d.type === 'kb_sources') {
            // 阶段3 Step2b：CardRenderer 渲染检索来源（替代 _injectStepContent）
            window._kbSources = d.sources || [];  // 持久化用，必须保留
            CardRenderer.handleEvent(d);
          } else if (d.type === 'doc_loaded') {
            // 模块5a：文档注入明盒（显示"已加载文档 XX（约N词元）"）
            CardRenderer.handleEvent(d);
          } else if (d.type === 'kb_no_reference') {
            showToast('未找到相关知识库内容', 'info');
          // 文档提纲确认（Phase 1 完成后）
          } else if (d.type === 'doc_outline') {
            // 标记：doc_outline 模式，done 后不要覆盖确认按钮
            window._docOutlinePending = true;
            // 保存提纲到全局变量
            window._docOutlineText = d.outline || fullText;
            var streamEl = document.getElementById('stream-msg');
            if (streamEl) {
              var confirmBar = _createDocConfirmBar(window._docOutlineText);
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
    var _isAbort = e.name === 'AbortError' || (abortCtrl && abortCtrl.signal && abortCtrl.signal.aborted);
    if (_isAbort) {
      _abortReason = 'user_stop';
      // P6: 追加终止提示到 stream-msg（不覆盖已有正文内容）
      try {
        var _abortStreamEl = document.getElementById('stream-msg');
        if (_abortStreamEl) {
          var _abortNotice = document.createElement('div');
          _abortNotice.className = 'msg-aborted';
          _abortNotice.innerHTML = iconSvg('stop','14') + ' 用户已手动终止响应';
          _abortStreamEl.appendChild(_abortNotice);
        }
      } catch(_e2) { console.warn('[chat.abort] UI更新失败:', _e2); }
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
      // C方案：id 清理交给 finalizeDOM（在 finally 末尾调），这里先保留引用
      // 彻底清掉旧引用
  
      // 计算要持久化的内容：正常输出 / 中止时已有内容 / 错误消息
      var _persistContent = fullText.trim();
      if (_hadError && _abortReason === 'user_stop' && _persistContent) {
        // 用户手动中止，已有输出：保留原正文（终止提示由 _aborted 标记驱动渲染，
        // 不再拼进 content，避免 emoji/blockquote 与流式 SVG 样式不一致）
      } else if (_hadError && _abortReason === 'user_stop' && !_persistContent) {
        // 用户手动中止，无输出：记录一条中止提示（_aborted 也会渲染 SVG 提示）
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
        // 阶段3 Step2b：CardRenderer 序列化卡片数据（替代 agent_timeline 持久化）
        CardRenderer.finalize(newMsg);
        // 旧 agent_timeline 兼容（Step2c 删除）
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
              if (newMsg.card_data) _enrichFields.card_data = newMsg.card_data;
              if (newMsg.parallel_texts) _enrichFields.parallel_texts = newMsg.parallel_texts;
              if (newMsg.token_stats) _enrichFields.token_stats = newMsg.token_stats;
              if (newMsg.kb_sources) _enrichFields.kb_sources = newMsg.kb_sources;
              if (newMsg.doc_url) _enrichFields.doc_url = newMsg.doc_url;
              if (newMsg.doc_filename) _enrichFields.doc_filename = newMsg.doc_filename;
              if (newMsg.action_mode) _enrichFields.action_mode = newMsg.action_mode;
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
      // error/abort 时保留错误卡片（不重建），只恢复 UI 按钮 + 刷新列表
      if (_hadError) {
        var streamErrFix = document.getElementById('stream-msg');
        if (streamErrFix) {
          // P6 修复终止bug: 终止时同样走 finalizeDOM，清掉 thinking-indicator 计时器
          // （否则计时器 interval 永驻狂飙，且 indicator 残留 + 双卡片）
          CardRenderer.finalizeDOM(streamErrFix);
        }
        _restoreChatUI();
        input.focus();
        // P6: 延迟再恢复一次（防 SSE 异步回调覆盖按钮状态）
        setTimeout(function() { if (!generating) _restoreChatUI(); }, 100);
        loadChatList();
        fetchContextUsage();
      } else {
        // C方案：原地固化流式气泡（替代 renderMessages 全量重建，消除闪烁）
        // 用户正在看的过程信息（步骤/产出）不会消失，只清理过程态痕迹（计时器/光标/动画）
        // KB 消息：流式正文补渲染引用上标 [1]→¹（流式时未做上标转换）
        var _streamContent = streamEl4.querySelector('#stream-content');
        var _savedKbSources = (newMsg.kb_sources || (window._kbSources && window._kbSources.length ? window._kbSources : null));
        if (_streamContent && _savedKbSources && _savedKbSources.length) {
          _streamContent.innerHTML = _renderCitationSuperscripts(_streamContent.innerHTML, _savedKbSources);
        }
        CardRenderer.finalizeDOM(streamEl4);
        _bindCitationClicks(streamEl4);  // 流式完成后绑定引用上标点击
        // P6 结构统一：固化后补 data-hash（和 renderMsg 输出一致）
        if (newMsg.msg_hash) {
          streamEl4.setAttribute('data-hash', newMsg.msg_hash);
        }
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

var _stopping = false;  // P6: 正在停止中标志（防止停止后立即重发导致竞态）

function stopGeneration() {
  if (_stopping) return;  // 防重复点击
  _stopping = true;
  if (typeof abortCtrl !== 'undefined' && abortCtrl) abortCtrl.abort();
  fetch((typeof API !== 'undefined' ? API : '') + '/api/stop', {method:'POST'}).catch(function() {});
  // P6: 延迟恢复 UI（给旧请求的 catch/finally 一点时间执行，避免竞态）
  setTimeout(function() {
    generating = false;
    _stopping = false;
    if (typeof _restoreChatUI === 'function') _restoreChatUI();
  }, 300);
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

// ===== 以下旧三套展示系统函数已删除（Step2c），由 CardRenderer 替代 =====
// 删除的函数：_handleAgentStatus / _agentStatusIsStart / _finalizeCurrentStep /
//             _agentStepHtml / _handleAgentSummary（旧 Cloud Agent 系统）

function _esc(str) {
  var d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}

// 创建文档提纲确认栏（共享于 SSE 事件 + 页面刷新恢复）
function _createDocConfirmBar(outlineText) {
  var bar = document.createElement('div');
  bar.className = 'doc-confirm-bar';
  bar.id = 'docConfirmBar';
  bar.innerHTML =
    '<details class="doc-outline-edit-wrap"><summary>' + iconSvg('doc','14') + ' 文档提纲已生成 — 点击查看，可编辑章节后确认</summary>' +
    '<div class="doc-outline-hint">编辑下方 Markdown 提纲后点击「确认生成」，按钮旁可切换预览</div>' +
    '<div class="doc-outline-toolbar"><button class="doc-outline-toggle-btn active" id="docOutlineEditBtn" onclick="toggleOutlinePreview(false)">编辑</button><button class="doc-outline-toggle-btn" id="docOutlinePreviewBtn" onclick="toggleOutlinePreview(true)">预览</button></div>' +
    '<textarea class="doc-outline-editor" id="docOutlineEditor">' + esc(outlineText || '') + '</textarea>' +
    '<div class="doc-outline-preview" id="docOutlinePreview"></div>' +
    '</details>' +
    '<div class="doc-confirm-actions">' +
    '<button class="doc-confirm-ok" onclick="confirmDocOutline()">' + iconSvg('check','14') + ' 确认生成</button>' +
    '<button class="doc-confirm-cancel" onclick="cancelDocOutline()">取消</button>' +
    '</div>';
  return bar;
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
  // 读取编辑后的提纲（用户可能修改了）
  var editor = document.getElementById('docOutlineEditor');
  var outline = editor ? editor.value : (window._docOutlineText || '');
  window._docOutlineText = null;
  if (!outline.trim()) {
    showToast('提纲内容为空，无法生成', 'error');
    return;
  }
  // 保存 Phase 1 的 KB 引用路径，供 Phase 2 使用（Phase 1 发完后 _refFilePath 已被 clearFileRef 清空）
  if (typeof _savedRefPathForDoc !== 'undefined' && _savedRefPathForDoc) {
    window._docPhase2FilePath = _savedRefPathForDoc;
  }
  // 保存 doc_continue 参数
  window._docContinueOutline = outline;
  // 直接调用 sendMessage，用空消息（不在聊天里显示"请基于提纲生成"这种假话）
  var input = document.getElementById('msgInput');
  if (input) {
    input.value = '';  // 空消息，Phase2 由 doc_continue 驱动
  }
  sendMessage();
}

// 取消文档生成
function cancelDocOutline() {
  var bar = document.getElementById('docConfirmBar');
  if (bar) bar.remove();
  window._docOutlineText = null;
  window._docOutlinePending = false;
  // 移除提纲消息，避免下次 renderMessages 重建确认栏
  for (var _ci = currentMessages.length - 1; _ci >= 0; _ci--) {
    if (currentMessages[_ci].action_mode === 'doc' && currentMessages[_ci].doc_phase === 'outline') {
      currentMessages.splice(_ci, 1); break;
    }
  }
  // 恢复正常渲染
  var oldStream = document.getElementById('stream-msg');
  if (oldStream) oldStream.removeAttribute('id');
  renderMessages();
  showToast('已取消文档撰写', 'info');
}

// 提纲编辑/预览切换
function toggleOutlinePreview(showPreview) {
  var textarea = document.getElementById('docOutlineEditor');
  var preview = document.getElementById('docOutlinePreview');
  var editBtn = document.getElementById('docOutlineEditBtn');
  var previewBtn = document.getElementById('docOutlinePreviewBtn');
  if (!textarea || !preview) return;

  if (showPreview) {
    // 用当前 textarea 内容渲染 Markdown 预览
    if (typeof md === 'function') {
      preview.innerHTML = md(textarea.value || '');
    } else {
      preview.innerHTML = '<pre>' + esc(textarea.value || '') + '</pre>';
    }
    textarea.style.display = 'none';
    preview.style.display = 'block';
    if (editBtn) editBtn.classList.remove('active');
    if (previewBtn) previewBtn.classList.add('active');
  } else {
    textarea.style.display = '';
    preview.style.display = 'none';
    if (editBtn) editBtn.classList.add('active');
    if (previewBtn) previewBtn.classList.remove('active');
  }
}

window.confirmDocOutline = confirmDocOutline;
window.cancelDocOutline = cancelDocOutline;
window.toggleOutlinePreview = toggleOutlinePreview;

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


// ============================================================
// CardRenderer — 卡片式明盒渲染器（阶段3 Step2a 新增，新旧并存）
// 对齐原型 docs/prototypes/clearbox-096.html 的 DOM 结构和 CSS class。
// Step2a 只定义不启用；Step2b 切换 SSE 分发到此；Step2c 删除旧三套系统。
// ============================================================

var CardRenderer = (function() {
  // ---- 内部状态 ----
  var _container = null;      // #card-area 容器 DOM（挂载在 #stream-msg 内）
  var _steps = {};            // {stepId: {el, label, status, outputEl, startTime, channel}}
  var _parallelCols = {};     // {local: {el, streamEl}, cloud: {el, streamEl}}（并行双列）
  var _parallelTexts = {};    // {local: '累积文本', cloud: '累积文本'}（流式累加，供 fullText 用）
  var _phase = 'working';     // 'working' | 'answering' | 'done'
  var _modeLabel = '';        // 模式标签（离线聊天/离线知识库/在线Agent/并行模式）
  var _data = [];             // 序列化数据（供 finalize 持久化）
  // 模块3：推理单元（在线Agent每轮打包折叠）
  var _reasonUnits = [];      // [{round, thinkText, tools:[{label,status,elapsed_ms}], startTime, el}]
  var _currentUnit = null;    // 当前进行中的推理单元
  // P6: 流式过程数据存储（供 finalize 序列化，确保刷新后重建一致）
  var _docLoadedItems = [];   // [{name, doc_id, tokens}]
  var _summaryData = null;    // {searches, fetches, kb_hits, docs}
  var _hintText = '';         // mode_hint 文本

  // 步骤标签映射（对齐原型的 label）
  var STEP_LABELS = {
    reformulate: '分析问题',
    search: '检索知识库',
    retrieve: '本地知识库检索',
    local_gen: '本地生成',
    cloud_gen: '云端生成',
    merge: '自动融合优化',
    understanding: '理解问题',
    thinking: '思考中',
    generating: '生成回答'
  };

  // 步骤图标映射
  var STEP_ICONS = {
    reformulate: 'search', search: 'book', retrieve: 'book',
    local_gen: 'write', cloud_gen: 'cloud', merge: 'check',
    understanding: 'brain', thinking: 'think', generating: 'write'
  };

  // ---- DOM 辅助 ----
  function _dotClass(status) {
    if (status === 'done') return 'ok';
    if (status === 'running') return 'run';
    if (status === 'error') return 'err';
    return 'wait';
  }

  function _esc(s) {
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ---- 公开 API ----

  function reset() {
    _container = null;
    _steps = {};
    _parallelCols = {};
    _parallelTexts = {};
    _phase = 'working';
    _modeLabel = '';
    _data = [];
    _reasonUnits = [];
    _currentUnit = null;
    _docLoadedItems = [];   // P6: 清理
    _summaryData = null;
    _hintText = '';
  }

  function setModeLabel(label) {
    _modeLabel = label;
  }

  // 在 #stream-msg 内创建卡片容器（挂载在 #stream-content 之前）
  function mount(streamMsgEl) {
    if (!streamMsgEl) return;
    var existing = streamMsgEl.querySelector('#card-area');
    if (existing) { _container = existing; return; }
    _container = document.createElement('div');
    _container.id = 'card-area';
    _container.className = 'card-area';
    // 插到 stream-msg 最前面（#stream-content 之前）
    var streamContent = streamMsgEl.querySelector('#stream-content');
    if (streamContent) {
      streamMsgEl.insertBefore(_container, streamContent);
    } else {
      streamMsgEl.insertBefore(_container, streamMsgEl.firstChild);
    }
  }

  // 统一事件入口（替代 7 个 _handle* 函数）
  // 归一化模型: {step, phase:'start'|'done', label, channel?, elapsed_ms?, count?, detail?}
  function handleEvent(d) {
    if (!d) return;
    var t = d.type;

    // agent_timeline 事件（local/parallel 的步骤进度）
    if (t === 'agent_timeline') {
      var stepId = d.step;
      var phase = d.phase;  // 'start' | 'done'
      var label = d.label || STEP_LABELS[stepId] || stepId;
      if (phase === 'start') {
        _createStep(stepId, label);
      } else if (phase === 'done') {
        _completeStep(stepId, d.elapsed_ms, d.count);
      }
      return;
    }

    // kb_reformulate 事件（reformulate 的产出内容）
    if (t === 'kb_reformulate') {
      _setTransformOutput('reformulate', d.original, d.reformulated, d.changed, d.elapsed);
      return;
    }

    // kb_sources 事件（检索来源）
    if (t === 'kb_sources') {
      _setSourcesOutput('search', d.sources);
      return;
    }

    // 并行模式事件（phase/step/step_done/status/sources 带 channel）
    if (t === 'phase' || t === 'step' || t === 'step_done' || t === 'status') {
      _handleParallelEvent(t, d);
      return;
    }
    if (t === 'sources' && d.channel) {
      // 并行模式的检索来源（channel=local）
      _setSourcesOutput('retrieve', d.sources);
      _handleParallelEvent('sources', d);
      return;
    }

    // agent_status 事件（在线 Agent 工具调用）
    if (t === 'agent_status') {
      _handleAgentStatus(d);
      return;
    }

    // agent_think 事件（推理内容，模块3a后端透传）
    if (t === 'agent_think') {
      _handleAgentThink(d);
      return;
    }

    // doc_loaded 事件（文档注入明盒，模块5a）
    if (t === 'doc_loaded') {
      _addDocLoaded(d);
      return;
    }

    // mode_hint 事件（并行 fallback 分支的提示文案）
    if (t === 'mode_hint') {
      _addHint(d.message || '');
      return;
    }

    // agent_summary 事件
    if (t === 'agent_summary') {
      _addSummary(d);
      return;
    }
  }

  // 并行双列流式正文（替代 _renderParallelChannelContent）
  // 保留 fullText 累加逻辑（调用方需要 fullText 做 done 渲染）
  function handleStream(d) {
    if (!d || !d.channel) return '';
    var ch = d.channel;  // local/cloud/merge
    if (!_parallelTexts[ch]) _parallelTexts[ch] = '';
    _parallelTexts[ch] += (d.content || '');

    // 阶段1时渲染到双列的流式区
    if (ch === 'local' || ch === 'cloud') {
      _ensureParallelCol(ch);
      var col = _parallelCols[ch];
      if (col && col.streamEl) {
        col.streamEl.textContent = _parallelTexts[ch];
        if (typeof scrollToBottom === 'function' && _lastScrollBottom) scrollToBottom();
      }
      // 首个 token 标记对应步骤开始
      var stepId = ch === 'local' ? 'local_gen' : 'cloud_gen';
      if (_steps[stepId] && _steps[stepId].status === 'pending') {
        _steps[stepId].status = 'running';
        _steps[stepId].startTime = Date.now();
        _updateStepDot(stepId, 'running');
      }
    }
    return _parallelTexts[ch];
  }

  // done 时序列化卡片数据到 newMsg（替代 agent_timeline 持久化）
  function finalize(newMsg) {
    if (!newMsg) return;
    var cardData = [];
    // 1. 扁平步骤（离线 KB 的 reformulate/search 等）
    for (var id in _steps) {
      var s = _steps[id];
      var item = {
        id: id,
        label: s.label,
        status: s.status,
        elapsed_ms: s.elapsed_ms || null,
        count: s.count || null,
        channel: s.channel || null
      };
      // 序列化产出内容（transform/sources），供 renderHistory 重建
      if (s.outputData) item.output = s.outputData;
      cardData.push(item);
    }
    // 2. 在线 Agent 推理轮次（每轮含工具步骤），序列化供刷新后重建
    if (_reasonUnits && _reasonUnits.length > 0) {
      for (var ri = 0; ri < _reasonUnits.length; ri++) {
        var unit = _reasonUnits[ri];
        if (!unit.tools || unit.tools.length === 0) continue;  // 跳过空轮次
        // 计算耗时
        var unitElapsed = 0;
        if (unit.startTime) {
          unitElapsed = Math.round((Date.now() - unit.startTime) / 1000 * 10) / 10;
        }
        var reasonItem = {
          id: '_reason_' + (ri + 1),
          type: 'reason_unit',
          round: ri + 1,
          elapsed_s: unitElapsed,
          think: unit.thinkText || '',  // P6: 序列化思考内容
          tools: unit.tools.map(function(t) {
            return {status: t.status, label: t.label, detail: t.detail || ''};  // P6: 序列化 detail
          })
        };
        cardData.push(reasonItem);
      }
    }
    if (cardData.length > 0) {
      newMsg.card_data = cardData;
    }
    // 并行模式保留双列原文（供三栏对比）
    if (_parallelTexts.local || _parallelTexts.cloud) {
      newMsg.parallel_texts = {
        local: _parallelTexts.local || '',
        cloud: _parallelTexts.cloud || '',
        merge: _parallelTexts.merge || ''
      };
    }
    // P6: 序列化 doc_loaded / summary / hint（确保刷新后重建一致）
    if (_docLoadedItems.length > 0) {
      cardData.push({id: '_doc_loaded', type: 'doc_loaded', items: _docLoadedItems});
    }
    if (_summaryData) {
      cardData.push({id: '_summary', type: 'summary', data: _summaryData});
    }
    if (_hintText) {
      cardData.push({id: '_hint', type: 'hint', text: _hintText});
    }
    _data = cardData;
  }

  // 原地固化当前流式气泡的 DOM（C方案：不重建，原地清理过程态痕迹）
  // 调用时机：finally 块正常完成时，替代 renderMessages() 全量重建。
  // 保证固化后的 DOM 和 renderHistory 从 card_data 重建的 DOM 同构。
  function finalizeDOM(streamMsgEl) {
    if (!streamMsgEl) return;
    // 1. 停止思考态计时器
    if (_thinkingTimerInterval) {
      clearInterval(_thinkingTimerInterval);
      _thinkingTimerInterval = null;
    }
    // 2. 去掉 thinking-indicator（流式过程态，静态消息不需要）
    var indicator = streamMsgEl.querySelector('.thinking-indicator');
    if (indicator) indicator.remove();
    // P6 结构统一：把流式时追加在正文后面的 ts/action-tag 移到正文前面（和 _renderSingleMsg 一致）
    var streamContentFix = streamMsgEl.querySelector('#stream-content');
    if (streamContentFix) {
      var _tsDiv = streamContentFix.querySelector('.ts');
      if (_tsDiv && streamContentFix.firstChild !== _tsDiv) {
        streamContentFix.insertBefore(_tsDiv, streamContentFix.firstChild);
      }
    }
    // 3. 去掉打字光标（streaming class）
    var streamContent = streamMsgEl.querySelector('#stream-content');
    if (streamContent) streamContent.classList.remove('streaming');
    // 4. 卡片区域：圆点全固化为 done（防残留 running 动画）
    var cardArea = streamMsgEl.querySelector('#card-area');
    if (cardArea) {
      var runDots = cardArea.querySelectorAll('.cb-dot.run');
      runDots.forEach(function(d) { d.className = 'cb-dot ok'; });
      var runSteps = cardArea.querySelectorAll('.cb-step[data-status="running"]');
      runSteps.forEach(function(s) { s.setAttribute('data-status', 'done'); });
      // 模块3b：关闭最后一个推理单元（折叠 + 算耗时）
      if (_currentUnit && _currentUnit.el) {
        // P6: 最后一个单元如果没有工具调用，也删除（空轮次不渲染）
        if (!_currentUnit.tools || _currentUnit.tools.length === 0) {
          _currentUnit.el.remove();
          _reasonUnits.pop();
        } else {
          _currentUnit.el.classList.remove('current');
          _currentUnit.el.removeAttribute('open');
          if (_currentUnit.startTime) {
            var elapsed = Math.round((Date.now() - _currentUnit.startTime) / 1000 * 10) / 10;
            var timeSpan = _currentUnit.el.querySelector('.cb-reason-time');
            if (timeSpan) timeSpan.textContent = elapsed + 's';
          }
        }
      }
    }
    // 5. 去掉 #card-area 和 #stream-content 的 id（防下一轮串扰）
    if (cardArea) cardArea.removeAttribute('id');
    if (streamContent) streamContent.removeAttribute('id');
    // 6. 去掉 stream-msg 的 id（固化）
    streamMsgEl.removeAttribute('id');
    // 注：不清理旧 #agent-timeline（Step2c 删除旧系统后自然消失）
    var oldTl = streamMsgEl.querySelector('#agent-timeline');
    if (oldTl) oldTl.removeAttribute('id');
  }

  function renderHistory(m) {
    if (!m || !m.card_data || !m.card_data.length) return '';
    var html = '<div class="card-area card-history">';
    // 渲染步骤（并行模式的原文嵌入对应步骤下方）
    for (var i = 0; i < m.card_data.length; i++) {
      var s = m.card_data[i];
      // P6: 推理轮次（在线 Agent）—重建 .cb-reason 结构（含思考内容+工具详情）
      if (s.type === 'reason_unit') {
        html += '<details class="cb-reason">';
        html += '<summary><span class="cb-reason-round">推理第 ' + s.round + ' 轮</span>';
        html += '<span class="cb-reason-time">' + (s.elapsed_s || 0) + 's</span></summary>';
        html += '<div class="cb-reason-body">';
        // P6: 重建思考内容
        if (s.think) {
          html += '<div class="cb-output"><div class="cb-thinking">' + _esc(s.think.slice(0, 500)) + (s.think.length > 500 ? '...' : '') + '</div></div>';
        }
        if (s.tools && s.tools.length) {
          for (var ti = 0; ti < s.tools.length; ti++) {
            var t = s.tools[ti];
            html += '<div class="cb-step' + (t.detail ? ' cb-step-expandable' : '') + '" data-status="done">' +
              '<span class="cb-dot ok"></span>' +
              '<div class="cb-step-row"><span class="cb-label">' + _esc(t.label || t.status) + '</span></div>';
            // P6: 重建工具详情
            if (t.detail) {
              html += '<div class="cb-step-detail" style="display:block">' + _esc(t.detail) + '</div>';
            }
            html += '</div>';
          }
        }
        html += '</div></details>';
        continue;
      }
      // P6: doc_loaded（已加载文档提示）
      if (s.type === 'doc_loaded' && s.items) {
        for (var di = 0; di < s.items.length; di++) {
          var item = s.items[di];
          var tokensTxt = item.tokens >= 1000 ? (item.tokens/1000).toFixed(1)+'K' : item.tokens;
          var label = item.count > 1 ? '已加载 ' + item.count + ' 篇文档' : '已加载文档';
          html += '<div class="cb-step" data-status="done">' +
            '<span class="cb-dot ok"></span>' +
            '<div class="cb-step-row">' +
              '<span class="cb-label">' + label + '</span>' +
              '<span class="cb-count">' + _esc(item.filename) + '</span>' +
              '<span class="cb-time">约 ' + tokensTxt + ' 词元</span>' +
            '</div></div>';
        }
        continue;
      }
      // P6: summary（统计条）
      if (s.type === 'summary' && s.data) {
        var parts = [];
        if (s.data.searches > 0) parts.push('搜索 ' + s.data.searches + ' 次');
        if (s.data.fetches > 0) parts.push('阅读 ' + s.data.fetches + ' 篇');
        if (s.data.kb_hits > 0) parts.push('检索知识库 ' + s.data.kb_hits + ' 次');
        if (s.data.docs > 0) parts.push('生成文档 ' + s.data.docs + ' 篇');
        var sumText = parts.length > 0 ? '共 ' + parts.join(' · ') : '直接回答（未使用工具）';
        html += '<div class="cb-summary"><span class="cb-summary-text">' + sumText + '</span></div>';
        continue;
      }
      // P6: hint（提示文案）
      if (s.type === 'hint' && s.text) {
        html += '<div class="cb-hint">' + _esc(s.text) + '</div>';
        continue;
      }
      // 普通扁平步骤（离线 KB 等）
      var dotCls = _dotClass(s.status);
      var elapsedTxt = s.elapsed_ms != null ? _formatElapsed(s.elapsed_ms) : '';
      var countTxt = s.count != null ? '(' + s.count + '篇)' : '';
      html += '<div class="cb-step" data-status="' + s.status + '">' +
                '<span class="cb-dot ' + dotCls + '"></span>' +
                '<div class="cb-step-row">' +
                  '<span class="cb-label">' + _esc(s.label) + '</span>' +
                  (countTxt ? '<span class="cb-count">' + countTxt + '</span>' : '') +
                  (elapsedTxt ? '<span class="cb-time">' + elapsedTxt + '</span>' : '') +
                '</div>';
      // 重建产出区（transform/sources）
      if (s.output) {
        html += _renderOutputHtml(s.output);
      }
      // P6: 并行模式——本地/云端步骤嵌入对应原文卡片
      if (m.parallel_texts) {
        if (s.id === 'local_gen' && m.parallel_texts.local) {
          html += '<div class="cb-par-card local" style="margin-top:6px">' +
            '<div class="cb-par-card-body">' + _esc(m.parallel_texts.local) + '</div></div>';
        } else if (s.id === 'cloud_gen' && m.parallel_texts.cloud) {
          html += '<div class="cb-par-card cloud" style="margin-top:6px">' +
            '<div class="cb-par-card-body">' + _esc(m.parallel_texts.cloud) + '</div></div>';
        }
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function getState() {
    return { phase: _phase, modeLabel: _modeLabel, steps: _steps, parallelTexts: _parallelTexts };
  }

  // ---- 内部实现 ----

  function _createStep(stepId, label) {
    if (_steps[stepId]) return;  // 已存在
    if (!_container) return;
    var step = {
      el: null, label: label, status: 'running',
      outputEl: null, startTime: Date.now(), elapsed_ms: null, count: null
    };
    var div = document.createElement('div');
    div.className = 'cb-step';
    div.setAttribute('data-status', 'running');
    div.setAttribute('data-id', stepId);
    div.innerHTML = '<span class="cb-dot run"></span>' +
      '<div class="cb-step-row"><span class="cb-label">' + _esc(label) + '</span></div>';
    _container.appendChild(div);
    step.el = div;
    _steps[stepId] = step;
    if (typeof scrollToBottom === 'function' && _lastScrollBottom) scrollToBottom();
  }

  function _updateStepDot(stepId, status) {
    var s = _steps[stepId];
    if (!s || !s.el) return;
    s.status = status;
    s.el.setAttribute('data-status', status);
    var dot = s.el.querySelector('.cb-dot');
    if (dot) {
      dot.className = 'cb-dot ' + _dotClass(status);
    }
  }

  function _completeStep(stepId, elapsed_ms, count) {
    var s = _steps[stepId];
    if (!s) return;
    _updateStepDot(stepId, 'done');
    if (elapsed_ms != null) {
      s.elapsed_ms = elapsed_ms;
      var timeEl = s.el.querySelector('.cb-time');
      var elapsedTxt = _formatElapsed(elapsed_ms);
      if (timeEl) {
        timeEl.textContent = elapsedTxt;
      } else {
        var row = s.el.querySelector('.cb-step-row');
        if (row) row.insertAdjacentHTML('beforeend', '<span class="cb-time">' + elapsedTxt + '</span>');
      }
    }
    if (count != null) {
      s.count = count;
      var row2 = s.el.querySelector('.cb-step-row');
      if (row2 && !row2.querySelector('.cb-count')) {
        var labelEl = row2.querySelector('.cb-label');
        if (labelEl) labelEl.insertAdjacentHTML('afterend', '<span class="cb-count">(' + count + '篇)</span>');
      }
    }
    if (typeof scrollToBottom === 'function' && _lastScrollBottom) scrollToBottom();
  }

  function _formatElapsed(ms) {
    if (ms == null) return '';
    if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
    return ms + 'ms';
  }

  // 把 output 数据转成 HTML（流式和历史回放共用，保证 DOM 同构）
  function _renderOutputHtml(output) {
    if (!output || !output.type) return '';
    if (output.type === 'transform') {
      var hl = output.changed ? ' hl' : '';
      return '<div class="cb-output"><div class="cb-transform">' +
        '<div class="cb-tf-row"><span class="cb-tf-key">原问题</span><span class="cb-tf-val">' + _esc(output.original) + '</span></div>' +
        '<div class="cb-tf-row"><span class="cb-tf-key">改写为</span><span class="cb-tf-val' + hl + '">' + _esc(output.result) + '</span></div>' +
      '</div></div>';
    }
    if (output.type === 'sources' && output.sources && output.sources.length) {
      var items = '';
      for (var i = 0; i < output.sources.length; i++) {
        var src = output.sources[i];
        items += '<div class="cb-src"><div class="cb-src-head">' +
          '<span class="cb-src-num">' + (i + 1) + '</span>' +
          '<span class="cb-src-label">' + _esc(src.label || src.source_label || '?') + '</span>' +
          '</div>' +
          '<div class="cb-src-snippet">' + _esc((src.snippet || src.text_snippet || '').slice(0, 100)) + '</div>' +
        '</div>';
      }
      return '<div class="cb-output"><div class="cb-sources">' + items + '</div></div>';
    }
    return '';
  }

  // transform 产出（reformulate 改写对比）
  function _setTransformOutput(stepId, original, result, changed, elapsed) {
    var s = _steps[stepId];
    if (!s || !s.el) return;
    // 存储产出数据（供 finalize 序列化 + renderHistory 重建）
    s.outputData = {type: 'transform', original: original, result: result, changed: changed};
    var out = s.el.querySelector('.cb-output');
    if (!out) {
      out = document.createElement('div');
      out.className = 'cb-output';
      s.el.appendChild(out);
    }
    var hlCls = changed ? ' hl' : '';
    out.innerHTML = '<div class="cb-transform">' +
      '<div class="cb-tf-row"><span class="cb-tf-key">原问题</span><span class="cb-tf-val">' + _esc(original) + '</span></div>' +
      '<div class="cb-tf-row"><span class="cb-tf-key">改写为</span><span class="cb-tf-val' + hlCls + '">' + _esc(result) + '</span></div>' +
    '</div>';
  }

  // sources 产出（检索来源列表）
  function _setSourcesOutput(stepId, sources) {
    var s = _steps[stepId];
    if (!s || !s.el || !sources || !sources.length) return;
    // 存储产出数据
    s.outputData = {type: 'sources', sources: sources};
    var out = s.el.querySelector('.cb-output');
    if (!out) {
      out = document.createElement('div');
      out.className = 'cb-output';
      s.el.appendChild(out);
    }
    var items = '';
    for (var i = 0; i < sources.length; i++) {
      var src = sources[i];
      items += '<div class="cb-src"><div class="cb-src-head">' +
        '<span class="cb-src-num">' + (i + 1) + '</span>' +
        '<span class="cb-src-label">' + _esc(src.label || src.source_label || '?') + '</span>' +
        '</div>' +
        '<div class="cb-src-snippet">' + _esc((src.snippet || src.text_snippet || '').slice(0, 100)) + '</div>' +
      '</div>';
    }
    out.innerHTML = '<div class="cb-sources">' + items + '</div>';
    if (typeof scrollToBottom === 'function' && _lastScrollBottom) scrollToBottom();
  }

  // 模块2a：双列折叠成摘要条（阶段1→阶段2过渡，方案Z）
  function _collapseParallelCols() {
    var parWrap = _container.querySelector('.cb-par');
    if (!parWrap) return;
    var localText = _parallelTexts.local || '';
    var cloudText = _parallelTexts.cloud || '';

    // P6: 把原文嵌入对应步骤下方（和 renderHistory 一致），而非独立摘要条
    if (localText) {
      var localStep = _container.querySelector('.cb-step[data-id="local_gen"]');
      if (localStep) {
        var card = document.createElement('div');
        card.className = 'cb-par-card local';
        card.style.cssText = 'margin-top:6px';
        card.innerHTML = '<div class="cb-par-card-body">' + _esc(localText) + '</div>';
        localStep.appendChild(card);
      }
    }
    if (cloudText) {
      var cloudStep = _container.querySelector('.cb-step[data-id="cloud_gen"]');
      if (cloudStep) {
        var card2 = document.createElement('div');
        card2.className = 'cb-par-card cloud';
        card2.style.cssText = 'margin-top:6px';
        card2.innerHTML = '<div class="cb-par-card-body">' + _esc(cloudText) + '</div>';
        cloudStep.appendChild(card2);
      }
    }
    // 移除并行列容器（原文已嵌入步骤）
    parWrap.remove();
    // 清理并行列引用（已折叠）
    _parallelCols = {};
    if (typeof scrollToBottom === 'function' && _lastScrollBottom) scrollToBottom();
  }

  // 并行事件处理
  function _handleParallelEvent(evtType, d) {
    if (!_container) return;
    var channel = d.channel;  // local/cloud/merge
    if (evtType === 'phase') {
      // phase started/done：创建/完成阶段
      if (d.phase === 'started' && !_parallelCols[channel]) {
        _ensureParallelCol(channel);
      }
      // 模块2a：merge phase started 时，阶段1结束，把双列折叠成摘要条（方案Z）
      if (channel === 'merge' && d.phase === 'started') {
        _collapseParallelCols();
      }
    } else if (evtType === 'step' || evtType === 'step_done') {
      // 并行子步骤（searching/generating 等）
      var col = _parallelCols[channel];
      if (col && col.el) {
        var _stepName = d.step || '';
        // P6 修复：step 事件只创建一次（去重），step_done 只更新已有步骤
        if (evtType === 'step') {
          // 检查是否已有同名步骤（避免 generating 重复创建）
          var _existing = col.el.querySelector('.cb-step[data-step-name="' + _stepName + '"]');
          if (!_existing) {
            var stepDiv = document.createElement('div');
            stepDiv.className = 'cb-step';
            stepDiv.setAttribute('data-status', 'running');
            stepDiv.setAttribute('data-step-name', _stepName);
            stepDiv.innerHTML = '<span class="cb-dot run"></span>' +
              '<div class="cb-step-row"><span class="cb-label">' + _esc(_stepName) + '</span></div>';
            col.el.appendChild(stepDiv);
          }
        } else if (evtType === 'step_done') {
          // 找到对应步骤标记完成
          var _doneStep = col.el.querySelector('.cb-step[data-step-name="' + _stepName + '"]');
          if (_doneStep) {
            _doneStep.setAttribute('data-status', 'done');
            var _dot = _doneStep.querySelector('.cb-dot');
            if (_dot) _dot.className = 'cb-dot ok';
          }
        }
      }
    } else if (evtType === 'status') {
      // 云端列状态（understanding/thinking/generating）
      var col2 = _parallelCols[channel];
      if (col2 && col2.el) {
        var stDiv = document.createElement('div');
        stDiv.className = 'cb-step';
        stDiv.setAttribute('data-status', 'done');
        stDiv.innerHTML = '<span class="cb-dot ok"></span>' +
          '<div class="cb-step-row"><span class="cb-label">' + _esc(d.status || '') + '</span></div>';
        col2.el.appendChild(stDiv);
      }
    }
    if (typeof scrollToBottom === 'function' && _lastScrollBottom) scrollToBottom();
  }

  // 确保并行列容器存在
  function _ensureParallelCol(channel) {
    if (_parallelCols[channel]) return _parallelCols[channel];
    if (!_container) return null;
    // 找或创建并行容器
    var parWrap = _container.querySelector('.cb-par');
    if (!parWrap) {
      parWrap = document.createElement('div');
      parWrap.className = 'cb-par';
      _container.appendChild(parWrap);
    }
    var col = document.createElement('div');
    col.className = 'cb-par-col';
    col.id = 'cb-par-' + channel;
    var title = channel === 'local' ? '本地（知识库）' : (channel === 'cloud' ? '云端（通用知识）' : '融合');
    var titleIcon = channel === 'local' ? 'book' : (channel === 'cloud' ? 'cloud' : 'check');
    col.innerHTML = '<div class="cb-par-col-title">' + (typeof iconSvg === 'function' ? iconSvg(titleIcon, '12') : '') + ' ' + title + '</div>' +
      '<div class="cb-par-stream-area"></div>';
    parWrap.appendChild(col);
    var streamEl = col.querySelector('.cb-par-stream-area');
    if (streamEl) {
      streamEl.className = streamEl.className + ' cb-par-stream';
    } else {
      streamEl = document.createElement('div');
      streamEl.className = 'cb-par-stream';
      col.appendChild(streamEl);
    }
    _parallelCols[channel] = { el: col, streamEl: streamEl };
    return _parallelCols[channel];
  }

  // 在线 Agent 状态（工具调用）
  function _handleAgentStatus(d) {
    if (!_container) return;
    var status = d.status || '';
    var isDone = (d.phase === 'done') || status.indexOf('_done') >= 0 ||
                 status === 'completed' || status === 'budget_exceeded' || status === 'tool_limited';
    var label = _agentStatusLabel(status, d);

    // 模块3b：推理单元分组——thinking 开始新单元，工具事件归入当前单元
    if (status === 'thinking' && !isDone) {
      // 开新推理单元
      _startReasonUnit();
      return;
    }

    // 非思考事件：归入当前推理单元
    if (_currentUnit && _currentUnit.body) {
      if (!isDone) {
        // start 类工具：在单元内创建步骤
        var stepDiv = document.createElement('div');
        stepDiv.className = 'cb-step';
        stepDiv.setAttribute('data-status', 'running');
        stepDiv.setAttribute('data-tool', status);
        stepDiv.innerHTML = '<span class="cb-dot run"></span>' +
          '<div class="cb-step-row"><span class="cb-label">' + label + '</span></div>';
        _currentUnit.body.appendChild(stepDiv);
        _currentUnit.tools.push({status: status, el: stepDiv, label: label});
      } else {
        // done 类工具：找到单元内对应的 start 步骤标记完成
        var baseStatus = status.replace('_done', '').replace('completed', '');
        for (var i = _currentUnit.tools.length - 1; i >= 0; i--) {
          var tool = _currentUnit.tools[i];
          if (tool.status === baseStatus || tool.status === baseStatus + 'ing') {
            if (tool.el) {
              tool.el.setAttribute('data-status', 'done');
              var dot = tool.el.querySelector('.cb-dot');
              if (dot) dot.className = 'cb-dot ok';
              var elapsedTxt = d.elapsed_ms != null ? _formatElapsed(d.elapsed_ms) : '';
              var countTxt = d.count != null ? ' (' + d.count + ')' : '';
              if (elapsedTxt || countTxt) {
                var row = tool.el.querySelector('.cb-step-row');
                if (row) row.insertAdjacentHTML('beforeend',
                  (countTxt ? '<span class="cb-count">' + countTxt + '</span>' : '') +
                  (elapsedTxt ? '<span class="cb-time">' + elapsedTxt + '</span>' : ''));
              }
              // P6: 如果有详情(detail)，添加可展开内容 + 存储到 tool 对象供 finalize
              if (d.detail) {
                tool.detail = d.detail;  // 存储供序列化
                tool.el.classList.add('cb-step-expandable');
                var detailDiv = document.createElement('div');
                detailDiv.className = 'cb-step-detail';
                detailDiv.style.display = 'none';
                detailDiv.textContent = d.detail;
                tool.el.appendChild(detailDiv);
                // 点击切换展开
                tool.el.style.cursor = 'pointer';
                tool.el.addEventListener('click', function(e) {
                  var det = this.querySelector('.cb-step-detail');
                  if (det) {
                    det.style.display = det.style.display === 'none' ? 'block' : 'none';
                    this.classList.toggle('cb-step-expanded');
                  }
                });
              }
            }
            break;
          }
        }
      }
    } else {
      // 没有当前单元（非Agent模式或首事件非thinking），fallback 到扁平步骤
      if (!isDone) {
        var stepId = 'agent_' + status;
        if (!_steps[stepId]) _createStep(stepId, label);
      }
    }
    if (typeof scrollToBottom === 'function' && _lastScrollBottom) scrollToBottom();
  }

  // 模块3b：开新推理单元
  function _startReasonUnit() {
    // 关闭前一个单元（折叠）
    if (_currentUnit && _currentUnit.el) {
      // P6: 空轮次不渲染——如果上一轮没有工具调用，删除它
      if (!_currentUnit.tools || _currentUnit.tools.length === 0) {
        _currentUnit.el.remove();
        _reasonUnits.pop();
      } else {
        _currentUnit.el.classList.remove('current');
        _currentUnit.el.removeAttribute('open');
        // 算耗时
        if (_currentUnit.startTime) {
          var elapsed = Math.round((Date.now() - _currentUnit.startTime) / 1000 * 10) / 10;
          var timeSpan = _currentUnit.el.querySelector('.cb-reason-time');
          if (timeSpan) timeSpan.textContent = elapsed + 's';
        }
      }
    }
    // 创建新单元
    var round = _reasonUnits.length + 1;
    var det = document.createElement('details');
    det.className = 'cb-reason current';
    det.open = true;
    det.innerHTML = '<summary><span class="cb-reason-round">推理第 ' + round + ' 轮</span>' +
      '<span class="cb-reason-time"></span></summary>';
    _container.appendChild(det);
    var body = document.createElement('div');
    body.className = 'cb-reason-body';
    det.appendChild(body);
    _currentUnit = {
      round: round,
      thinkText: '',
      tools: [],
      startTime: Date.now(),
      el: det,
      body: body
    };
    _reasonUnits.push(_currentUnit);
    if (typeof scrollToBottom === 'function' && _lastScrollBottom) scrollToBottom();
  }

  // 模块3b：处理 think 内容（填入当前推理单元）
  function _handleAgentThink(d) {
    if (!_currentUnit || !_currentUnit.body) return;
    var token = d.content || '';
    _currentUnit.thinkText += token;
    // 渲染思考内容到单元 body 顶部
    var thinkEl = _currentUnit.body.querySelector('.cb-thinking');
    if (!thinkEl) {
      thinkEl = document.createElement('div');
      thinkEl.className = 'cb-output';
      thinkEl.innerHTML = '<div class="cb-thinking"></div>';
      _currentUnit.body.insertBefore(thinkEl, _currentUnit.body.firstChild);
    }
    var inner = thinkEl.querySelector('.cb-thinking');
    if (inner) inner.textContent = _currentUnit.thinkText;
  }

  function _agentStatusLabel(status, d) {
    if (status === 'thinking') return '思考中';
    if (status === 'searching') return '搜索：' + _esc(d.query || '');
    if (status === 'fetching') return '阅读：' + _esc(d.url || '');
    if (status === 'kb_searching') return '检索知识库：' + _esc(d.query || '');
    if (status === 'workspace_writing') return '写入文档：' + _esc(d.name || '');
    // P6 补全：英文 status 中文化
    if (status === 'workspace_listing') return '列出工作区文件';
    if (status === 'workspace_reading') return '读取文档：' + _esc(d.name || '');
    if (status === 'deep_reading') return '深度分析：' + _esc(d.query || d.name || '');
    if (status === 'workspace_deleting') return '删除文档：' + _esc(d.name || '');
    if (status === 'workspace_appending') return '追加内容：' + _esc(d.name || '');
    if (status === 'workspace_editing') return '编辑文档：' + _esc(d.name || '');
    if (status === 'doc_status') return '标记文档完成：' + _esc(d.name || d.filename || '');
    if (status === 'docs_listing') return '列出文档列表';
    if (status === 'error') {
      // error 显示原因而非裸 "error"
      var reason = d.reason || d.message || '';
      return reason ? '操作受限：' + _esc(reason) : '操作异常';
    }
    if (status === 'tool_limited') return '工具调用已达上限，转入回答';
    // _done 后缀的状态：提取前缀映射
    if (status.indexOf('_done') > 0) {
      var prefix = status.replace('_done', '');
      return _agentStatusLabel(prefix, d);
    }
    // 未知 status：友好显示而非裸英文
    return _esc(status.replace(/_/g, ' '));
  }

  function _addSummary(d) {
    if (!_container) return;
    // P6: 存储数据供 finalize 序列化
    _summaryData = {searches: d.searches||0, fetches: d.fetches||0, kb_hits: d.kb_hits||0, docs: d.docs||0};
    var sumDiv = document.createElement('div');
    sumDiv.className = 'cb-summary';
    // P6 统计修正：纳入知识库检索和文档生成
    var parts = [];
    var searches = d.searches || 0;
    var fetches = d.fetches || 0;
    var kbHits = d.kb_hits || 0;
    var docs = d.docs || 0;
    if (searches > 0) parts.push('搜索 ' + searches + ' 次');
    if (fetches > 0) parts.push('阅读 ' + fetches + ' 篇');
    if (kbHits > 0) parts.push('检索知识库 ' + kbHits + ' 次');
    if (docs > 0) parts.push('生成文档 ' + docs + ' 篇');
    var text = parts.length > 0 ? '共 ' + parts.join(' · ') : '直接回答（未使用工具）';
    sumDiv.innerHTML = '<span class="cb-summary-text">' + text + '</span>';
    _container.appendChild(sumDiv);
  }

  // 提示文案（并行 fallback 分支的 mode_hint）
  function _addHint(message) {
    if (!_container || !message) return;
    _hintText = message;  // P6: 存储供 finalize 序列化
    var hintDiv = document.createElement('div');
    hintDiv.className = 'cb-hint';
    hintDiv.textContent = message;
    _container.appendChild(hintDiv);
    if (typeof scrollToBottom === 'function' && _lastScrollBottom) scrollToBottom();
  }

  // 文档注入明盒（模块5a：显示"已加载文档 XX（约N词元）"）
  function _addDocLoaded(d) {
    if (!_container) return;
    var filename = d.filename || '文档';
    var tokens = d.tokens || 0;
    var count = d.count || 1;
    // P6: 存储供 finalize 序列化
    _docLoadedItems.push({filename: filename, tokens: tokens, count: count});
    var tokensTxt = tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'K' : tokens;
    var label = count > 1 ? '已加载 ' + count + ' 篇文档' : '已加载文档';
    var div = document.createElement('div');
    div.className = 'cb-step';
    div.setAttribute('data-status', 'done');
    div.innerHTML = '<span class="cb-dot ok"></span>' +
      '<div class="cb-step-row">' +
        '<span class="cb-label">' + label + '</span>' +
        '<span class="cb-count">' + _esc(filename) + '</span>' +
        '<span class="cb-time">约 ' + tokensTxt + ' 词元</span>' +
      '</div>';
    _container.appendChild(div);
    if (typeof scrollToBottom === 'function' && _lastScrollBottom) scrollToBottom();
  }

  // 历史回放：并行三栏对比（本地/云端/融合，卡片堆叠，点击展开全文）
  function _renderParallelSummary(texts) {
    // P6: 双卡片布局——本地/云端各自独立卡片，体现"两条线"
    // 融合结果已在正文区显示，摘要区不再重复
    var html = '<div class="cb-par-dual">';
    // 本地卡片
    if (texts.local) {
      html += '<div class="cb-par-card local">' +
        '<div class="cb-par-card-head"><span class="cb-par-dot local"></span>本地AI生成回答</div>' +
        '<div class="cb-par-card-body">' + _esc(texts.local) + '</div>' +
      '</div>';
    }
    // 云端卡片
    if (texts.cloud) {
      html += '<div class="cb-par-card cloud">' +
        '<div class="cb-par-card-head"><span class="cb-par-dot cloud"></span>云端AI生成回答</div>' +
        '<div class="cb-par-card-body">' + _esc(texts.cloud) + '</div>' +
      '</div>';
    }
    html += '</div>';
    return html;
  }

  // ---- 导出公开 API ----
  return {
    reset: reset,
    setModeLabel: setModeLabel,
    mount: mount,
    handleEvent: handleEvent,
    handleStream: handleStream,
    finalize: finalize,
    finalizeDOM: finalizeDOM,
    renderHistory: renderHistory,
    getState: getState
  };
})();

// 暴露到 window（供 SSE 分发切换用，Step2b 启用）
window.CardRenderer = CardRenderer;

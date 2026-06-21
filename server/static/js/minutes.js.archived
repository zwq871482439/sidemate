// ===== minutes.js — 纪要 Tab：录音、转写、纠错、播放、音频导入 =====
// 依赖: api.js, errors.js, utils.js, 全局变量 (API)
// 被引用: chat.js, settings.js

var _recMediaRecorder = null;
var _recSessionId = null;
var _recTimerInterval = null;
var _recStartTime = null;
var _recPaused = false;
var _recPausedDuration = 0;
var _pauseStartTime = null;
var _currentTranscriptSessionId = null;
var _minutesPollTimer = null;
var _recAudioCtx = null;
var _recGainNode = null;
var _recCompressor = null;
var _recAnalyser = null;
var _recAnimFrame = null;
var _vadBuffer = [];
var _vadSilenceStart = 0;
var _vadIsSpeaking = false;
var _vadProcessing = false;
var VAD_SILENCE_MS = 450;
var VAD_THRESHOLD = 0.02;
var _playerAudioEl = null;
var _playerSessionId = null;
var _currentSegments = [];

// 轮询转写进度
function _pollMinutesProgress() {
  if (_minutesPollTimer) clearInterval(_minutesPollTimer);
  var pollCount = 0;
  // 首次立即刷新，不等 2s
  (async function runPoll() {
    try {
      var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/sessions');
      var data = await resp.json();
      var sessions = data.sessions || [];
      var active = sessions.some(function(s) { return s.status === 'transcribing' || s.status === 'refining' || s.status === 'queued'; });
      loadMinutesHistory('minutesHistory');
      pollCount++;
      if (!active && pollCount >= 3) {
        clearInterval(_minutesPollTimer);
        _minutesPollTimer = null;
        loadMinutesStorage();
      } else if (!active) {
        // 前 3 轮即使没有活跃 session 也继续轮询，等后端完成入库
      }
    } catch(e) {}
  })();
  _minutesPollTimer = setInterval(async function() {
    try {
      var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/sessions');
      var data = await resp.json();
      var sessions = data.sessions || [];
      var active = sessions.some(function(s) { return s.status === 'transcribing' || s.status === 'refining' || s.status === 'queued'; });
      loadMinutesHistory('minutesHistory');
      pollCount++;
      if (!active && pollCount >= 3) {
        clearInterval(_minutesPollTimer);
        _minutesPollTimer = null;
        loadMinutesStorage();
      }
    } catch(e) {}
  }, 2000);
}

// --- 二态路由（安装统一走设置页） ---
async function minutesRouteState() {
  var idleEl = document.getElementById('minutesIdle');
  var readyEl = document.getElementById('minutesReady');
  var loadingEl = document.getElementById('minutesLoading');

  if (idleEl) idleEl.style.display = 'none';
  if (readyEl) readyEl.style.display = 'none';
  if (loadingEl) loadingEl.style.display = 'flex';

  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/whisper/status');
    var ws = await resp.json();
    if (loadingEl) loadingEl.style.display = 'none';

    if (!ws.ready) {
      // S0: 引擎未加载 → 提示加载，重置进度条
      if (idleEl) idleEl.style.display = 'flex';
      var loadArea = document.getElementById('whisperLoadArea');
      var progress = document.getElementById('whisperLoadProgress');
      if (loadArea) loadArea.style.display = '';
      if (progress) progress.style.display = 'none';
    } else {
      // S1: 已加载 → 完整功能
      if (readyEl) readyEl.style.display = 'block';
      loadMinutesHistory('minutesHistory');
      loadMinutesStorage();
      checkRecordingLock();
    }
  } catch(e) {
    if (loadingEl) loadingEl.style.display = 'none';
    if (idleEl) idleEl.style.display = 'flex';
  }
}

// --- 卸载纪要模块 ---
async function uninstallRecorderExt() {
  if (!(await showDialog('卸载纪要模块', '确定卸载纪要模块？这将删除语音引擎并释放磁盘空间。', {type: 'danger', confirm: true, confirmLabel: '卸载', cancelLabel: '取消'}))) return;
  try {
    await fetch((typeof API !== 'undefined' ? API : '') + '/api/extensions/uninstall/recorder/recorder', {method: 'DELETE'});
    if (typeof showToast === 'function') showToast('纪要模块已卸载', 'success');
    if (typeof updateTabVisibility === 'function') updateTabVisibility();
  } catch(e) {
    if (typeof showToast === 'function') showToast('卸载失败: ' + e.message, 'error');
  }
}

// --- 扩展包安装 ---
async function installWhisper(file) {
  if (!file || !file.name.toLowerCase().endsWith('.zip')) {
    if (typeof showToast === 'function') showToast('请选择 .zip 格式的安装包', 'warning');
    return;
  }

  var dropZone = document.getElementById('whisperLoadArea');
  var progressDiv = document.getElementById('whisperLoadProgress');
  var bar = document.getElementById('whisperLoadBar');
  var statusEl = document.getElementById('whisperLoadStatus');

  if (!dropZone || !progressDiv || !bar || !statusEl) {
    if (typeof showToast === 'function') showToast('界面元素未就绪，请刷新页面重试', 'error');
    return;
  }
  dropZone.style.display = 'none';
  progressDiv.style.display = 'block';
  bar.style.width = '20%';
  statusEl.textContent = '正在上传扩展包...';

  try {
    var formData = new FormData();
    formData.append('file', file);

    bar.style.width = '40%';
    statusEl.textContent = '正在解压并安装...';

    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/extensions/upload', {method:'POST', body: formData});
    var data = await resp.json();

    if (data.ok) {
      bar.style.width = '100%';
      statusEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:-3px"><circle cx="7" cy="7" r="6" stroke="#16a34a" stroke-width="1.3"/><path d="M4 7l2.5 2.5L10 5.5" stroke="#16a34a" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg> ' + (data.model_name || 'Whisper') + ' 安装成功！';
      setTimeout(function() { minutesRouteState(); }, 1500);
    } else {
      bar.style.width = '0%';
      statusEl.style.color = 'var(--error-color)';
      statusEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:-3px"><circle cx="7" cy="7" r="6" stroke="#ef4444" stroke-width="1.3"/><path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="#ef4444" stroke-width="1.2" stroke-linecap="round"/></svg> ' + (data.error || '安装失败');
      setTimeout(function() {
        dropZone.style.display = 'block';
        progressDiv.style.display = 'none';
        statusEl.style.color = 'var(--accent-color)';
      }, 3000);
    }
  } catch(e) {
    bar.style.width = '0%';
    statusEl.style.color = 'var(--error-color)';
    statusEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:-3px"><circle cx="7" cy="7" r="6" stroke="#ef4444" stroke-width="1.3"/><path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="#ef4444" stroke-width="1.2" stroke-linecap="round"/></svg> 安装失败: ' + e.message;
    setTimeout(function() {
      dropZone.style.display = 'block';
      progressDiv.style.display = 'none';
      statusEl.style.color = 'var(--accent-color)';
    }, 3000);
  }
}

function whisperOnFilePicked(event) {
  var file = event.target.files[0];
  if (file) installWhisper(file);
}

function whisperOnDrop(event) {
  event.preventDefault();
  var file = event.dataTransfer.files[0];
  if (file) installWhisper(file);
}

// --- Whisper 释放/重载内存 ---
function handleWhisperUnload() { unloadWhisper(); }

async function unloadWhisper() {
  if (!(await showDialog('释放语音引擎', '释放后可节省内存资源。\n释放后需要重新加载才能使用纪要转写功能。', {type: 'warning', confirm: true, confirmLabel: '释放', cancelLabel: '取消'}))) return;
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/whisper/unload', {method:'POST'});
    var data = await resp.json();
    if (data.ok) {
      if (typeof showToast === 'function') showToast('语音引擎已释放，节省约 ' + (data.freed_mb || 0) + 'MB 内存', 'success');
    }
    minutesRouteState();
    if (typeof refreshResourcePanel === 'function') refreshResourcePanel();
  } catch(e) { if (typeof showToast === 'function') showToast('释放失败: ' + e.message, 'error'); }
}

async function reloadWhisper() {
  // 显示全局覆层
  if (typeof showModuleLoading === 'function') showModuleLoading('纪要引擎加载中', 'whisper', '首次加载约需 10-30 秒');

  // 隐藏按钮区旧 UI（兼容：如果 DOM 存在就隐藏）
  var loadArea = document.getElementById('whisperLoadArea');
  var progress = document.getElementById('whisperLoadProgress');
  if (loadArea) loadArea.style.display = 'none';
  if (progress) progress.style.display = 'none';

  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/whisper/load', {method:'POST'});
    var data = await resp.json();
    if (!data.ok && !data.loading) {
      if (typeof hideModuleLoading === 'function') hideModuleLoading();
      if (loadArea) loadArea.style.display = '';
      if (typeof showToast === 'function') showToast('加载失败: ' + (data.error || '未知错误'), 'error');
      return;
    }

    // 后台加载中 → 轮询状态
    var _poll = setInterval(async function() {
      try {
        var r = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/whisper/status');
        var d = await r.json();
        if (d.ready) {
          clearInterval(_poll);
          if (typeof hideModuleLoading === 'function') hideModuleLoading();
          if (typeof showToast === 'function') showToast('纪要引擎加载成功', 'success');
          setTimeout(function() { minutesRouteState(); }, 300);
          if (typeof refreshResourcePanel === 'function') refreshResourcePanel();
        }
      } catch(_) {}
    }, 1500);
  } catch(e) {
    if (typeof hideModuleLoading === 'function') hideModuleLoading();
    if (loadArea) loadArea.style.display = '';
    if (typeof showToast === 'function') showToast('加载失败: ' + e.message, 'error');
  }
}

async function uninstallWhisper() {
  if (!(await showDialog('卸载扩展', '确定卸载 Whisper 扩展？卸载后需重新安装才能使用纪要功能。', {type: 'danger', confirm: true, confirmLabel: '卸载', cancelLabel: '取消'}))) return;
  try {
    await fetch((typeof API !== 'undefined' ? API : '') + '/api/extensions/uninstall/whisper/whisper-transcriber', {method:'DELETE'});
    minutesRouteState();
    if (typeof updateTabVisibility === 'function') updateTabVisibility();
  } catch(e) { if (typeof showToast === 'function') showToast('卸载失败: ' + e.message, 'error'); }
}

// --- 录音 ---
async function startRecording() {
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/start', {method:'POST'});
    var data = await resp.json();
    if (data.error) { if (typeof showToast === 'function') showToast(data.error, 'error'); return; }
    _recSessionId = data.session_id;

    var stream = await navigator.mediaDevices.getUserMedia({audio: true});

    _recAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    var source = _recAudioCtx.createMediaStreamSource(stream);

    _recGainNode = _recAudioCtx.createGain();
    var savedGain = parseFloat(localStorage.getItem('_recGain') || '1');
    _recGainNode.gain.value = savedGain;
    document.getElementById('gainSlider').value = savedGain;
    document.getElementById('gainValue').textContent = savedGain.toFixed(1) + 'x';

    _recAnalyser = _recAudioCtx.createAnalyser();
    _recAnalyser.fftSize = 256;
    _recAnalyser.smoothingTimeConstant = 0.3;

    source.connect(_recGainNode);
    _recGainNode.connect(_recAnalyser);

    // 动态压缩器 — 仅用于录音链路，平滑音量起伏
    _recCompressor = _recAudioCtx.createDynamicsCompressor();
    _recCompressor.threshold.value = -30;      // 高于此值开始压缩 (dBFS)
    _recCompressor.knee.value = 20;            // 平滑过渡
    _recCompressor.ratio.value = 4;            // 4:1 压缩比
    _recCompressor.attack.value = 0.005;       // 5ms 快起
    _recCompressor.release.value = 0.2;        // 200ms 自然释放

    var gainDest = _recAudioCtx.createMediaStreamDestination();
    _recGainNode.connect(_recCompressor);
    _recCompressor.connect(gainDest);

    _recMediaRecorder = new MediaRecorder(gainDest.stream, {mimeType: 'audio/webm;codecs=opus'});
    _recPaused = false;
    _recPausedDuration = 0;
    _recStartTime = Date.now();

    _recMediaRecorder.ondataavailable = async function(e) {
      if (e.data.size > 0 && _recSessionId) {
        await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/chunk?session_id=' + _recSessionId, {method:'POST', body: e.data});
      }
    };

    var scriptNode = _recAudioCtx.createScriptProcessor(4096, 1, 1);
    scriptNode.onaudioprocess = function(e) {
      if (_recPaused) return;
      var pcm = e.inputBuffer.getChannelData(0);
      _vadBuffer.push(new Float32Array(pcm));
    };
    _recGainNode.connect(scriptNode);
    scriptNode.connect(_recAudioCtx.destination);

    _recMediaRecorder.start(10000);
    document.getElementById('recordingArea').style.display = 'block';
    document.getElementById('startRecBtn').disabled = true;
    // 重置实时转写气泡
    var container = document.getElementById('realtimeContainer');
    var emptyEl = document.getElementById('realtimeEmpty');
    if (container) {
      while (container.children.length > 0) {
        if (container.children[0] === emptyEl) { emptyEl.style.display = ''; break; }
        container.removeChild(container.children[0]);
      }
    }

    _recTimerInterval = setInterval(updateRecTimer, 1000);

    _startVolumeMonitor();
    _startVADMonitor();
  } catch(e) { if (typeof showToast === 'function') showToast('录音启动失败: ' + e.message, 'error'); }
}

function updateGain(val) {
  if (_recGainNode) _recGainNode.gain.value = parseFloat(val);
  document.getElementById('gainValue').textContent = parseFloat(val).toFixed(1) + 'x';
  localStorage.setItem('_recGain', val);
}

function _startVolumeMonitor() {
  var bar = document.getElementById('volumeBar');
  var dbLabel = document.getElementById('volumeDb');
  if (!_recAnalyser || !bar) return;
  var dataArray = new Float32Array(_recAnalyser.fftSize);

  var smoothPct = 0;
  var smoothDb = -60;
  var EMA_ALPHA = 0.15;

  var lastDisplayUpdate = 0;

  function tick() {
    if (!_recAnalyser) return;
    _recAnalyser.getFloatTimeDomainData(dataArray);
    var sum = 0;
    for (var i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
    var rms = Math.sqrt(sum / dataArray.length);

    var rawPct;
    if (rms < 0.0001) {
      rawPct = 0;
    } else {
      var db = 20 * Math.log10(Math.max(rms, 1e-10));
      var normalized = (db + 60) / 40;
      rawPct = Math.max(0, Math.min(100, normalized * 100));
    }

    smoothPct = smoothPct * (1 - EMA_ALPHA) + rawPct * EMA_ALPHA;
    bar.style.width = Math.round(smoothPct) + '%';

    if (smoothPct < 35) bar.style.background = 'var(--success-color)';
    else if (smoothPct < 70) bar.style.background = 'var(--warning-color)';
    else bar.style.background = 'var(--error-color)';

    var now = Date.now();
    if (now - lastDisplayUpdate > 200) {
      var db2 = rms > 0.0001 ? (20 * Math.log10(rms)).toFixed(0) : '-60';
      smoothDb = rms > 0.0001 ? parseFloat(db2) : -60;
      dbLabel.textContent = smoothDb + ' dB';
      lastDisplayUpdate = now;
    }

    _recAnimFrame = requestAnimationFrame(tick);
  }
  tick();
}

function _startVADMonitor() {
  if (!_recAnalyser) return;
  var dataArray = new Float32Array(_recAnalyser.fftSize);
  _vadSilenceStart = Date.now();
  _vadIsSpeaking = false;
  _vadBuffer = [];
  var _segmentCount = 0;

  function vadTick() {
    if (!_recAnalyser) return;
    _recAnalyser.getFloatTimeDomainData(dataArray);
    var sum = 0;
    for (var i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
    var rms = Math.sqrt(sum / dataArray.length);

    var now = Date.now();
    if (rms > VAD_THRESHOLD) {
      if (!_vadIsSpeaking) {
        _vadIsSpeaking = true;
        _segmentCount++;
      }
      _vadSilenceStart = now;
    } else if (_vadIsSpeaking && (now - _vadSilenceStart > VAD_SILENCE_MS)) {
      _vadIsSpeaking = false;
      _sendLiveSegment(_segmentCount);
    }
    if (_recAnalyser) requestAnimationFrame(vadTick);
  }
  vadTick();
}

async function _sendLiveSegment(segmentNum) {
  if (!_recSessionId || _vadBuffer.length === 0 || _vadProcessing) return;
  _vadProcessing = true;

  try {
    var pcmChunks = _vadBuffer.splice(0);
    if (pcmChunks.length === 0) return;

    var totalLen = 0;
    for (var ci = 0; ci < pcmChunks.length; ci++) totalLen += pcmChunks[ci].length;
    var merged = new Float32Array(totalLen);
    var offset = 0;
    for (var ci2 = 0; ci2 < pcmChunks.length; ci2++) {
      merged.set(pcmChunks[ci2], offset);
      offset += pcmChunks[ci2].length;
    }

    var srcRate = _recAudioCtx ? _recAudioCtx.sampleRate : 16000;
    var pcmForWhisper = merged;
    var targetRate = 16000;
    if (srcRate !== 16000) {
      var ratio = srcRate / 16000;
      var newLen = Math.round(merged.length / ratio);
      var resampled = new Float32Array(newLen);
      for (var i = 0; i < newLen; i++) {
        var srcIdx = i * ratio;
        var lo = Math.floor(srcIdx);
        var hi = Math.min(lo + 1, merged.length - 1);
        var frac = srcIdx - lo;
        resampled[i] = merged[lo] * (1 - frac) + merged[hi] * frac;
      }
      pcmForWhisper = resampled;
    }

    var wavBuffer = _encodeWAV(pcmForWhisper, targetRate);
    var blob = new Blob([wavBuffer], {type: 'audio/wav'});

    if (blob.size < 2000) return;

    var container = document.getElementById('realtimeContainer');
    var emptyEl = document.getElementById('realtimeEmpty');

    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/live-transcribe?session_id=' + _recSessionId, {
      method: 'POST',
      body: blob
    });
    var data = await resp.json();
    if (data.text && container) {
      // 隐藏空状态提示
      if (emptyEl) emptyEl.style.display = 'none';

      // 每个段创建气泡卡片
      var bubble = document.createElement('div');
      bubble.className = 'realtime-bubble';
      bubble.innerHTML = '<span class="realtime-bubble-num">' + segmentNum + '</span>' + escapeHtml(data.text);
      container.appendChild(bubble);
      container.scrollTop = container.scrollHeight;

      // 最多保留 20 段
      while (container.children.length > 20) {
        container.removeChild(container.firstChild);
      }
    }
  } catch(e) {
    console.warn('实时转写失败:', e.message);
  } finally {
    _vadProcessing = false;
  }
}

function _encodeWAV(samples, sampleRate) {
  var numChannels = 1;
  var bitsPerSample = 16;
  var byteRate = sampleRate * numChannels * bitsPerSample / 8;
  var blockAlign = numChannels * bitsPerSample / 8;
  var dataLength = samples.length * blockAlign;
  var bufferLength = 44 + dataLength;
  var buffer = new ArrayBuffer(bufferLength);
  var view = new DataView(buffer);

  _writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  _writeString(view, 8, 'WAVE');
  _writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  _writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  var pos = 44;
  for (var i = 0; i < samples.length; i++) {
    var s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(pos, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    pos += 2;
  }

  return buffer;
}

function _writeString(view, offset, str) {
  for (var i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function updateRecTimer() {
  if (!_recStartTime) return;
  if (_recPaused) return;
  var elapsed = Math.floor((Date.now() - _recStartTime - _recPausedDuration) / 1000);
  var m = String(Math.floor(elapsed / 60)).padStart(2, '0');
  var s = String(elapsed % 60).padStart(2, '0');
  document.getElementById('recTimer').textContent = m + ':' + s;
}

function pauseRecording() {
  if (!_recMediaRecorder) return;
  if (_recPaused) {
    _recMediaRecorder.resume();
    _recPaused = false;
    _recPausedDuration += Date.now() - _pauseStartTime;
    document.getElementById('pauseRecBtn').innerHTML = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><rect x="3" y="3" width="3" height="8" rx=".5" stroke="currentColor" stroke-width="1.2"/><rect x="8" y="3" width="3" height="8" rx=".5" stroke="currentColor" stroke-width="1.2"/></svg> 暂停';
  } else {
    _recMediaRecorder.pause();
    _recPaused = true;
    _pauseStartTime = Date.now();
    document.getElementById('pauseRecBtn').innerHTML = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><polygon points="4,2 12,7 4,12" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg> 继续';
  }
}

async function stopRecording() {
  if (!_recMediaRecorder || !_recSessionId) return;

  clearInterval(_recTimerInterval);

  if (_recAnimFrame) { cancelAnimationFrame(_recAnimFrame); _recAnimFrame = null; }
  if (_recAnalyser) { _recAnalyser = null; }
  if (_recGainNode) { _recGainNode = null; }
  if (_recCompressor) { _recCompressor = null; }

  var sessionId = _recSessionId;
  var waitForLastChunk = new Promise(function(resolve) {
    var timer = setTimeout(function() { resolve(); }, 3000);
    _recMediaRecorder.onstop = function() { clearTimeout(timer); resolve(); };
    try {
      _recMediaRecorder.stop();
    } catch(e) { clearTimeout(timer); resolve(); }
    try {
      _recMediaRecorder.stream.getTracks().forEach(function(t) { t.stop(); });
    } catch(e) {}
  });

  await waitForLastChunk;

  var audioCtxToClose = _recAudioCtx;
  _recAudioCtx = null;

  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/finish', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({session_id: sessionId})
    });
    var data = await resp.json();
    document.getElementById('recordingArea').style.display = 'none';
    document.getElementById('startRecBtn').disabled = false;
    _recSessionId = null;
    _recMediaRecorder = null;

    if (audioCtxToClose) { audioCtxToClose.close().catch(function(){}); }

    var bar = document.getElementById('volumeBar');
    if (bar) { bar.style.width = '0%'; bar.style.background = 'var(--success-color)'; }
    var dbLabel = document.getElementById('volumeDb');
    if (dbLabel) dbLabel.textContent = '-60 dB';

    // 延迟刷新列表，等后端完成 session 保存
    setTimeout(function() { loadMinutesHistory('minutesHistory'); }, 1000);
    // 立即首次刷新 + 延迟兜底
    loadMinutesHistory('minutesHistory');

    if (data.ok && !data.error) {
      _pollMinutesProgress();
    }
  } catch(e) { if (typeof showToast === 'function') showToast('结束录音失败: ' + e.message, 'error'); }
}

// --- 导入音频 ---
async function importAudio(event) {
  var file = event.target.files[0];
  if (!file) return;
  var fd = new FormData();
  fd.append('file', file);
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/import', {method:'POST', body: fd});
    var data = await resp.json();
    if (data.error) { if (typeof showToast === 'function') showToast(data.error, 'error'); return; }
    loadMinutesHistory('minutesHistory');
  } catch(e) { if (typeof showToast === 'function') showToast('导入失败: ' + e.message, 'error'); }
  event.target.value = '';
}

// --- 历史录音列表 ---
async function loadMinutesHistory(containerId) {
  var el = document.getElementById(containerId);
  if (!el) return;
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/sessions');
    var data = await resp.json();
    var sessions = data.sessions || [];
    if (!sessions.length) { el.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:16px">暂无录音记录</div>'; return; }

    // 增量渲染：更新状态和名称，检测按钮是否需要重建
    var existingChildren = el.children;
    if (existingChildren.length > 0 && existingChildren.length === sessions.length) {
      var needsFullRefresh = false;
      for (var si = 0; si < sessions.length; si++) {
        var s = sessions[si];
        var child = existingChildren[si];
        if (!child) { needsFullRefresh = true; continue; }
        // 更新名称
        var nameEl = child.querySelector('.rec-name');
        if (nameEl) {
          var newName = formatRecName(s);
          if (nameEl.textContent !== newName) nameEl.textContent = newName;
        }
        // 更新状态
        var oldStatus = child.getAttribute('data-status');
        if (oldStatus !== s.status) {
          // 状态变化可能导致按钮行需要重建（如 transcribing→done 时出现查看/纠错按钮）
          child.setAttribute('data-status', s.status);
          if ((oldStatus === 'transcribing' && s.status === 'done') ||
              (oldStatus === 'refining' && s.status === 'done') ||
              (oldStatus === 'queued' && s.status === 'done')) {
            needsFullRefresh = true;
          }
        }
        var statusEl = child.querySelector('.rec-status');
        if (statusEl) {
          var newStatus = s.status === 'done' ? '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:-3px"><circle cx="7" cy="7" r="6" stroke="#16a34a" stroke-width="1.3"/><path d="M4 7l2.5 2.5L10 5.5" stroke="#16a34a" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>' :
            s.status === 'transcribing' ? '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:-3px;animation:spin 2s linear infinite"><circle cx="7" cy="7" r="6" stroke="#60a5fa" stroke-width="1.3" stroke-dasharray="9 6"/></svg> 转写中 ' + Math.round(s.progress * 100) + '%' :
            s.status === 'refining' ? '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:-3px;animation:spin 2s linear infinite"><circle cx="7" cy="7" r="6" stroke="#60a5fa" stroke-width="1.3" stroke-dasharray="9 6"/></svg> 纠错中 ' + Math.round(s.progress * 100) + '%' :
            s.status === 'queued' ? '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:-3px"><circle cx="7" cy="7" r="6" stroke="#f59e0b" stroke-width="1.3"/><path d="M7 4v3l2 2" stroke="#f59e0b" stroke-width="1.2" stroke-linecap="round"/></svg> 排队中' :
            s.status === 'error' ? '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:-3px"><circle cx="7" cy="7" r="6" stroke="#ef4444" stroke-width="1.3"/><path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="#ef4444" stroke-width="1.2" stroke-linecap="round"/></svg> 失败' : s.status;
          if (statusEl.innerHTML !== newStatus) statusEl.innerHTML = newStatus;
        }
      }
      if (!needsFullRefresh) return;
    }

    // 名称格式化（模块级函数，用于外部调用）
    function formatRecName(s) {
      var key = 'rec_name_' + s.session_id;
      var custom = localStorage.getItem(key);
      if (custom) return custom;
      if (s.started_at) {
        return s.started_at.slice(0, 10) + ' ' + s.started_at.slice(11, 16);
      }
      return s.source === 'import' ? (s.import_filename || '导入') : '录音';
    }

    // SVG 图标定义
    var icoCheck = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><circle cx="7" cy="7" r="6" stroke="#16a34a" stroke-width="1.3"/><path d="M4 7l2.5 2.5L10 5.5" stroke="#16a34a" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var icoSpin = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px;animation:spin 2s linear infinite"><circle cx="7" cy="7" r="6" stroke="#60a5fa" stroke-width="1.3" stroke-dasharray="9 6"/></svg>';
    var icoClock = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><circle cx="7" cy="7" r="6" stroke="#f59e0b" stroke-width="1.3"/><path d="M7 4v3l2 2" stroke="#f59e0b" stroke-width="1.2" stroke-linecap="round"/></svg>';
    var icoX = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><circle cx="7" cy="7" r="6" stroke="#ef4444" stroke-width="1.3"/><path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="#ef4444" stroke-width="1.2" stroke-linecap="round"/></svg>';
    var icoFile = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><rect x="2" y="1.5" width="10" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><rect x="5" y="5" width="4" height="3" rx=".5" stroke="currentColor" stroke-width="1"/></svg>';
    var icoMic = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><rect x="5" y="1" width="4" height="7" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="M2.5 5.5a4.5 4.5 0 0 0 9 0M7 8.5V12M5 12h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
    var icoStar = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><path d="M7 1l1.8 3.6 4 .6-2.9 2.8.7 4L7 10.2 3.4 12l.7-4L1.2 5.2l4-.6L7 1z" stroke="#f59e0b" stroke-width="1.1"/></svg>';
    var icoTrash = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><path d="M2.5 4h9M5 4V2.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V4M6 7v3M8 7v3M3 4l1 9a1 1 0 0 0 1 .5h4a1 1 0 0 0 1-.5l1-9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    el.innerHTML = sessions.map(function(s) {
      var recName = formatRecName(s);
      var date = s.started_at ? s.started_at.slice(5, 16).replace('T', ' ') : '';
      var dur = '';
      if (s.duration_seconds > 0) {
        var dm = Math.floor(s.duration_seconds / 60);
        var ds = Math.floor(s.duration_seconds % 60);
        dur = dm > 0 ? dm + '分' + ds + '秒' : ds + '秒';
      }
      var statusLabel = s.status === 'done' ? icoCheck :
        s.status === 'transcribing' ? icoSpin + ' 转写中 ' + Math.round(s.progress * 100) + '%' :
        s.status === 'refining' ? icoSpin + ' 纠错中 ' + Math.round(s.progress * 100) + '%' :
        s.status === 'queued' ? icoClock + ' 排队中' :
        s.status === 'error' ? icoX + ' 失败' : s.status;
      var sourceIcon = s.source === 'import' ? icoFile : icoMic;
      var hasTranscript = !!s.transcript;
      var hasSummary = !!s.summary;
      var hasAudio = !!s.audio_path;
      var needsRefine = s.status === 'done' && hasTranscript && !s.refined;
      var isRefining = s.status === 'refining';

      return '<div style="border:1px solid var(--border-color);border-radius:8px;padding:10px;margin-bottom:8px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
          '<div style="flex:1;min-width:0">' +
            '<span class="rec-name" style="font-weight:600;cursor:pointer;font-size:.95em" onclick="startRenameRec(\'' + s.session_id + '\',this)" title="点击改名">' + esc(recName) + '</span>' +
            ' <span style="color:var(--text-muted);font-size:.78em">' + date + (dur ? ' · ' + dur : '') + '</span>' +
          '</div>' +
          '<div class="rec-status" style="font-size:.85em;flex-shrink:0;margin-left:8px">' + statusLabel + '</div>' +
        '</div>' +
        (s.status === 'error' ?
          '<div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap">' +
            '<button class="secondary" onclick="retrySession(\'' + s.session_id + '\')" style="font-size:.78em">' + icoSpin + ' 重试</button>' +
            '<button class="secondary" onclick="deleteSession(\'' + s.session_id + '\')" style="font-size:.78em;color:var(--error-color)">' + icoTrash + ' 删除</button>' +
          '</div>' :
        (hasTranscript ?
          '<div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap">' +
            '<button class="secondary" onclick="viewTranscript(\'' + s.session_id + '\')" style="font-size:.78em"><svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.2"/><path d="M7 3.5v7M3.5 7h7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> 查看</button>' +
            (needsRefine ?
              '<button class="secondary" onclick="refineSession(\'' + s.session_id + '\')" style="font-size:.78em;color:var(--accent-color)" id="refineBtn_' + s.session_id + '">' + icoStar + ' 纠错</button>' :
            (isRefining ?
              '<span style="font-size:.78em;color:var(--accent-color)">' + icoSpin + ' 纠错中...</span>' :
            '')) +
            '<button class="secondary" onclick="deleteSession(\'' + s.session_id + '\')" style="font-size:.78em;color:var(--error-color)">' + icoTrash + '</button>' +
          '</div>' :
          '<div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap">' +
            '<button class="secondary" onclick="deleteSession(\'' + s.session_id + '\')" style="font-size:.78em;color:var(--error-color)">' + icoTrash + ' 删除</button>' +
          '</div>')) +
      '</div>';
    }).join('');
  } catch(e) { el.innerHTML = '<div style="color:var(--error-color)">加载失败</div>'; }
}

async function loadMinutesStorage(targetId) {
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/storage');
    var data = await resp.json();
    var elId = targetId || 'minutesStorageLabel';
    var el = document.getElementById(elId);
    if (el) el.textContent = '已用 ' + data.total_sessions + '/' + data.max_sessions + '  |  占用 ' + data.total_mb + 'MB';
  } catch(e) {}
}

// --- 查看转写稿 ---
async function viewTranscript(sessionId) {
  _currentTranscriptSessionId = sessionId;
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/' + sessionId + '/status');
    var session = await resp.json();

    var roughResp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/' + sessionId + '/rough');
    var roughData = await roughResp.json();

    var segResp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/' + sessionId + '/segments');
    var segData = segResp.ok ? await segResp.json() : {segments: []};
    var segments = segData.segments || [];

    var transcriptEl = document.getElementById('transcriptContent');
    var segmentsEl = document.getElementById('transcriptSegments');

    if (segments.length > 0) {
      _currentSegments = segments;
      // 同时更新 transcriptContent（合并等操作需要）
      transcriptEl.textContent = session.transcript || '';
      var html = '';
      segments.forEach(function(seg, idx) {
        var m = Math.floor(seg.start / 60);
        var s = Math.floor(seg.start % 60);
        var ts = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
        html += '<div class="seg-line" style="padding:2px 4px;display:flex;gap:8px;transition:background .2s">';
        html += '<span style="color:var(--accent-color);cursor:pointer;font-weight:600;white-space:nowrap;flex-shrink:0" onclick="jumpToTime(' + seg.start + ')" title="跳转到 ' + ts + '">[' + ts + ']</span>';
        html += '<span style="min-width:0;overflow-wrap:break-word">' + escapeHtml(seg.text) + '</span>';
        html += '</div>';
      });
      segmentsEl.innerHTML = html;
      segmentsEl.style.display = 'block';
      transcriptEl.style.display = 'none';
      initPlayerForSession(sessionId);
    } else {
      _currentSegments = [];
      segmentsEl.style.display = 'none';
      transcriptEl.style.display = 'block';
      transcriptEl.textContent = session.transcript || '（无转写内容）';
      document.getElementById('audioPlayerSection').style.display = 'none';
    }

    document.getElementById('transcriptViewMode').style.display = 'block';
    document.getElementById('transcriptEditMode').style.display = 'none';
    document.getElementById('transcriptActions').style.display = 'flex';

    if (session.summary) {
      document.getElementById('summaryContent').innerHTML = formatSummary(session.summary);
      document.getElementById('summarySection').style.display = 'block';
    } else {
      document.getElementById('summarySection').style.display = 'none';
    }

    // 纠错对比按钮：已纠错且 rough 可用时显示
    var compareBtn = document.getElementById('refineCompareBtn');
    var compareView = document.getElementById('refineCompareView');
    if (compareBtn) {
      compareBtn.style.display = (session.refined && roughData.rough_draft) ? '' : 'none';
    }
    if (compareView) compareView.style.display = 'none';
    document.getElementById('transcriptTitle').textContent = '查看转录原文';
    document.getElementById('transcriptMsg').textContent = '';

    var modal = document.getElementById('transcriptModal');
    modal.style.display = 'flex';
  } catch(e) { if (typeof showToast === 'function') showToast('加载失败: ' + e.message, 'error'); }
}

function escapeHtml(text) {
  var d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// 简单 Markdown 风格渲染纪要文本
function formatSummary(text) {
  var safe = escapeHtml(text);
  // 加粗标题行（以 **、##、或中文冒号结尾的短行）
  safe = safe.replace(/^(.{2,30}[：:])$/gm, '<strong>$1</strong>');
  // 加粗 **text**
  safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // 无序列表 - / • 
  safe = safe.replace(/^(\s*[-•])\s+(.+)$/gm, '<span style="display:block;padding-left:12px;margin:2px 0">$1 $2</span>');
  // 编号列表
  safe = safe.replace(/^(\s*\d+[.、])\s+(.+)$/gm, '<span style="display:block;padding-left:12px;margin:2px 0">$1 $2</span>');
  return safe;
}

function closeTranscriptModal() {
  document.getElementById('transcriptModal').style.display = 'none';
  _currentTranscriptSessionId = null;
  if (_playerAudioEl) { _playerAudioEl.pause(); _playerAudioEl = null; }
  _playerSessionId = null;
  _currentSegments = [];
}

// Escape 键关闭 transcript modal
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    var modal = document.getElementById('transcriptModal');
    if (modal && modal.style.display === 'flex') {
      closeTranscriptModal();
    }
  }
});

// 字符级 diff：合并到一行，共同部分只写一次，差异标红删除线+绿增补
function charDiff(orig, refined) {
  if (orig === refined) return escapeHtml(orig);
  var minLen = Math.min(orig.length, refined.length);
  var pref = 0;
  while (pref < minLen && orig[pref] === refined[pref]) pref++;
  var suff = 0;
  while (suff < minLen - pref && orig[orig.length - 1 - suff] === refined[refined.length - 1 - suff]) suff++;
  var r = escapeHtml(orig.substring(0, pref));
  if (pref < orig.length - suff) r += '<span class="diff-rem">' + escapeHtml(orig.substring(pref, orig.length - suff)) + '</span>';
  if (pref < refined.length - suff) r += '<span class="diff-add">' + escapeHtml(refined.substring(pref, refined.length - suff)) + '</span>';
  r += escapeHtml(refined.substring(refined.length - suff));  // 用润色版的后缀
  return r;
}

// 单区字符级 diff
var _diffLinesData = [];

function renderDiffLines(origText, refinedText) {
  var origLines = origText.split('\n');
  var refinedLines = refinedText.split('\n');
  var maxLen = Math.max(origLines.length, refinedLines.length);
  var html = '';
  _diffLinesData = [];
  for (var i = 0; i < maxLen; i++) {
    var ol = origLines[i] || '';
    var rl = refinedLines[i] || '';
    if (ol === rl) {
      html += '<div class="diff-same">' + escapeHtml(ol) + '</div>';
      _diffLinesData.push({orig: ol, refined: rl, accepted: true, same: true});
    } else {
      var lid = 'diff-line-' + i;
      html += '<div class="diff-changed" id="' + lid + '">' + charDiff(ol, rl) + ' <button onclick="acceptDiffLine(' + i + ')" style="font-size:.72em;padding:2px 7px;border:1px solid #16a34a;border-radius:3px;background:transparent;color:#16a34a;cursor:pointer;white-space:nowrap;margin-left:6px">接受</button></div>';
      _diffLinesData.push({orig: ol, refined: rl, accepted: false, same: false, lid: lid});
    }
  }
  return html;
}

function acceptDiffLine(idx) {
  if (idx < 0 || idx >= _diffLinesData.length) return;
  var d = _diffLinesData[idx];
  if (d.same || d.accepted) return;
  d.accepted = true;
  var el = document.getElementById(d.lid);
  if (el) {
    el.className = 'diff-same';
    el.innerHTML = escapeHtml(d.refined) + ' <span style="font-size:.72em;color:var(--text-muted)">已接受</span>';
  }
  mergeAcceptedDiff();
}

function acceptAllRefine() {
  for (var i = 0; i < _diffLinesData.length; i++) {
    if (!_diffLinesData[i].same && !_diffLinesData[i].accepted) {
      _diffLinesData[i].accepted = true;
      var el = document.getElementById(_diffLinesData[i].lid);
      if (el) {
        el.className = 'diff-same';
        el.innerHTML = escapeHtml(_diffLinesData[i].refined) + ' <span style="font-size:.72em;color:var(--text-muted)">已接受</span>';
      }
    }
  }
  mergeAcceptedDiff();
}

function mergeAcceptedDiff() {
  var merged = [];
  for (var i = 0; i < _diffLinesData.length; i++) {
    merged.push(_diffLinesData[i].accepted ? _diffLinesData[i].refined : _diffLinesData[i].orig);
  }
  var newText = merged.join('\n');
  document.getElementById('transcriptContent').textContent = newText;
  var segmentsEl = document.getElementById('transcriptSegments');
  if (segmentsEl) segmentsEl.textContent = newText;
  var sid = _currentTranscriptSessionId;
  if (sid) {
    fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/' + sid + '/transcript', {
      method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({text: newText})
    }).then(function() {
      document.getElementById('transcriptMsg').innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><circle cx="7" cy="7" r="6" stroke="#16a34a" stroke-width="1.3"/><path d="M4 7l2.5 2.5L10 5.5" stroke="#16a34a" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg> 已保存到服务器 ' + (new Date().toLocaleTimeString());
    }).catch(function() {
      document.getElementById('transcriptMsg').innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><circle cx="7" cy="7" r="6" stroke="#ef4444" stroke-width="1.3"/><path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="#ef4444" stroke-width="1.2" stroke-linecap="round"/></svg> 保存失败，请重试';
    });
  }
}

function toggleRefineCompare() {
  var compareView = document.getElementById('refineCompareView');
  var btn = document.getElementById('refineCompareBtn');
  var transcriptEl = document.getElementById('transcriptContent');
  var segmentsEl = document.getElementById('transcriptSegments');

  if (compareView.style.display === 'none') {
    // 同时获取原始稿和纠错稿（segments 模式下 transcriptContent 可能隐藏为空）
    var roughUrl = (typeof API !== 'undefined' ? API : '') + '/api/recorder/' + _currentTranscriptSessionId + '/rough';
    var statusUrl = (typeof API !== 'undefined' ? API : '') + '/api/recorder/' + _currentTranscriptSessionId + '/status';
    Promise.all([
      fetch(roughUrl).then(function(r) { return r.json(); }),
      fetch(statusUrl).then(function(r) { return r.json(); })
    ]).then(function(results) {
      var roughText = results[0].rough_draft || '';
      var refinedText = results[1].transcript || (transcriptEl ? transcriptEl.textContent : '') || roughText;
      var diffHtml = renderDiffLines(roughText, refinedText);
      var diffBox = document.getElementById('refineCompareSingle');
      if (diffBox) diffBox.innerHTML = diffHtml || '<span style="color:var(--text-muted)">（无内容）</span>';
    });
    compareView.style.display = 'block';
    transcriptEl.style.display = 'none';
    var acceptAllBtn = document.getElementById('refineAcceptAllBtn');
    if (acceptAllBtn) acceptAllBtn.style.display = '';
    if (btn) btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> 关闭对比';
  } else {
    compareView.style.display = 'none';
    var acceptAllBtn = document.getElementById('refineAcceptAllBtn');
    if (acceptAllBtn) acceptAllBtn.style.display = 'none';
    if (btn) btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><rect x="1.5" y="3" width="5" height="8" rx=".5" stroke="currentColor" stroke-width="1.2"/><rect x="7.5" y="3" width="5" height="8" rx=".5" stroke="currentColor" stroke-width="1.2"/><path d="M4 5v2M10 5v2" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg> 对比原文';
  }
}

function editTranscript() {
  var segmentsEl = document.getElementById('transcriptSegments');
  var transcriptEl = document.getElementById('transcriptContent');
  var content = '';
  if (segmentsEl.style.display !== 'none' && segmentsEl.innerHTML) {
    var lines = segmentsEl.querySelectorAll('.seg-line');
    var parts = [];
    lines.forEach(function(line) {
      var spans = line.querySelectorAll('span');
      if (spans.length >= 2) {
        parts.push(spans[0].textContent + ' ' + spans[1].textContent);
      }
    });
    content = parts.join('\n');
  } else {
    content = transcriptEl.textContent;
  }
  document.getElementById('transcriptEditArea').value = content;
  document.getElementById('transcriptViewMode').style.display = 'none';
  document.getElementById('transcriptEditMode').style.display = 'block';
}

function cancelEditTranscript() {
  document.getElementById('transcriptViewMode').style.display = 'block';
  document.getElementById('transcriptEditMode').style.display = 'none';
}

async function saveTranscript() {
  if (!_currentTranscriptSessionId) {
    if (typeof showToast === 'function') showToast('未找到当前转写稿会话，请先打开一篇转写稿', 'warning');
    return;
  }
  var text = document.getElementById('transcriptEditArea').value;
  if (!text.trim()) {
    if (typeof showToast === 'function') showToast('内容为空，无法保存', 'warning');
    return;
  }
  var saveBtn = document.querySelector('#transcriptEditMode button.primary');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中…'; }
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/' + _currentTranscriptSessionId + '/transcript', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({text: text})
    });
    var data = await resp.json();
    if (data.ok) {
      document.getElementById('transcriptContent').textContent = text;
      // 编辑后强制展示整理文本而非旧 segments
      var segEl = document.getElementById('transcriptSegments');
      var tcEl = document.getElementById('transcriptContent');
      segEl.style.display = 'none';
      tcEl.style.display = 'block';
      _currentSegments = [];
      cancelEditTranscript();
      document.getElementById('transcriptMsg').innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><circle cx="7" cy="7" r="6" stroke="#16a34a" stroke-width="1.3"/><path d="M4 7l2.5 2.5L10 5.5" stroke="#16a34a" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg> 已保存';
      if (typeof showToast === 'function') showToast('转写稿已保存', 'success');
    } else { if (typeof showToast === 'function') showToast(data.error || '保存失败', 'error'); }
  } catch(e) { if (typeof showToast === 'function') showToast('保存失败: ' + e.message, 'error'); }
  if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px"><rect x="1.5" y="1.5" width="11" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><rect x="4.5" y="4.5" width="5" height="5" rx=".5" stroke="currentColor" stroke-width="1"/><path d="M9 2v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg> 保存修改'; }
}

async function saveAndImportKB() {
  await saveTranscript();
  await doImportKB(_currentTranscriptSessionId);
}

// ===== 纪要另存为 / 导出 =====
function saveMinutesAs(format) {
  if (!_currentTranscriptSessionId) {
    showToast('请先打开一个转写稿', 'warning');
    return;
  }
  var transcriptEl = document.getElementById('transcriptContent');
  var segmentsEl = document.getElementById('transcriptSegments');
  var summaryEl = document.getElementById('summaryContent');
  var content = '';
  if (segmentsEl.style.display !== 'none') {
    var lines = segmentsEl.querySelectorAll('.seg-line');
    var parts = [];
    lines.forEach(function(line) {
      var spans = line.querySelectorAll('span');
      if (spans.length >= 2) parts.push(spans[0].textContent + ' ' + spans[1].textContent);
    });
    content = parts.join('\n');
  } else {
    content = transcriptEl.textContent || '';
  }
  var summary = summaryEl.style.display !== 'none' ? (summaryEl.textContent || '') : '';
  var filename = 'minutes_' + _currentTranscriptSessionId.slice(0,8) + '_' + new Date().toISOString().slice(0,10);

  if (format === 'txt') {
    var lines = [];
    lines.push('会议纪要');
    lines.push('导出时间: ' + new Date().toLocaleString());
    lines.push('');
    if (summary) { lines.push('【纪要摘要】'); lines.push(summary); lines.push(''); }
    lines.push('【转写原文】');
    lines.push(content);
    var blob = new Blob([lines.join('\n')], {type: 'text/plain;charset=utf-8'});
    downloadBlob(blob, filename + '.txt');
  } else if (format === 'md') {
    var lines = [];
    lines.push('# 会议纪要');
    lines.push('');
    lines.push('- 导出时间: ' + new Date().toLocaleString());
    lines.push('');
    if (summary) {
      lines.push('## 摘要');
      lines.push('');
      lines.push(summary);
      lines.push('');
    }
    lines.push('## 转写原文');
    lines.push('');
    lines.push('```');
    lines.push(content);
    lines.push('```');
    var blob = new Blob([lines.join('\n')], {type: 'text/markdown;charset=utf-8'});
    downloadBlob(blob, filename + '.md');
  } else if (format === 'docx') {
    // 简化 docx: 用 HTML 表格包装后通过 Word 打开
    var html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">';
    html += '<head><meta charset="utf-8"><title>会议纪要</title></head><body>';
    html += '<h1>会议纪要</h1>';
    html += '<p>导出时间: ' + new Date().toLocaleString() + '</p>';
    if (summary) { html += '<h2>摘要</h2><p>' + escapeHtml(summary).replace(/\n/g, '<br>') + '</p>'; }
    html += '<h2>转写原文</h2><p>' + escapeHtml(content).replace(/\n/g, '<br>') + '</p>';
    html += '</body></html>';
    var blob = new Blob(['\ufeff', html], {type: 'application/msword'});
    downloadBlob(blob, filename + '.doc');
  }
}

function exportMinutes() {
  saveMinutesAs('md');
}

async function summarizeSession() {
  if (!_currentTranscriptSessionId) return;
  if (_summarizing) { showToast('正在生成纪要，请稍候', 'info'); return; }
  _summarizing = true;
  var msgEl = document.getElementById('transcriptMsg');
  var summaryBtn = document.querySelector('[onclick*="summarizeSession"]');
  if (summaryBtn) { summaryBtn.disabled = true; summaryBtn.style.opacity = '0.6'; }
  // 显示进度动画
  msgEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:-3px;animation:spin 1.5s linear infinite"><circle cx="7" cy="7" r="6" stroke="var(--accent-color)" stroke-width="1.3" stroke-dasharray="9 6"/></svg> 正在生成纪要，请耐心等待...';
  try {
    var modelResp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/models');
    var modelData = await modelResp.json();
    var llmLoaded = !!modelData.current;
    // 云端模式下不需要本地模型
    var isCloudMode = typeof _currentMode !== 'undefined' && _currentMode === 'cloud';
    if (!llmLoaded && !isCloudMode) {
      msgEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:-3px"><path d="M7 2L1 12h12L7 2z" stroke="#f59e0b" stroke-width="1.3"/><path d="M7 6v2M7 10h0" stroke="#f59e0b" stroke-width="1.3" stroke-linecap="round"/></svg> 请先在「设置」页面加载 AI 模型，才能生成纪要';
      _summarizing = false;
      if (summaryBtn) { summaryBtn.disabled = false; summaryBtn.style.opacity = '1'; }
      return;
    }

    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/' + _currentTranscriptSessionId + '/summarize', {method:'POST'});
    var data = await resp.json();
    if (data.ok) {
      document.getElementById('summaryContent').innerHTML = formatSummary(data.summary);
      document.getElementById('summarySection').style.display = 'block';
      msgEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:-3px"><circle cx="7" cy="7" r="6" stroke="#16a34a" stroke-width="1.3"/><path d="M4 7l2.5 2.5L10 5.5" stroke="#16a34a" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg> 纪要已生成';
    } else { msgEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:-3px"><path d="M7 2L1 12h12L7 2z" stroke="#f59e0b" stroke-width="1.3"/><path d="M7 6v2M7 10h0" stroke="#f59e0b" stroke-width="1.3" stroke-linecap="round"/></svg> ' + (data.error || '生成失败'); }
  } catch(e) { msgEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:-3px"><path d="M7 2L1 12h12L7 2z" stroke="#f59e0b" stroke-width="1.3"/><path d="M7 6v2M7 10h0" stroke="#f59e0b" stroke-width="1.3" stroke-linecap="round"/></svg> 生成失败: ' + e.message; }
  _summarizing = false;
  if (summaryBtn) { summaryBtn.disabled = false; summaryBtn.style.opacity = '1'; }
}

var _summarizing = false;

var _refinePollTimers = {};  // 每个 session 的纠错完成轮询

async function refineSession(sessionId) {
  try {
    var modelResp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/models');
    var modelData = await modelResp.json();
    var llmLoaded = !!modelData.current;
    // 云端模式下不需要本地模型
    var isCloudMode = typeof _currentMode !== 'undefined' && _currentMode === 'cloud';

    if (!llmLoaded && !isCloudMode) {
      if (typeof showToast === 'function') showToast('请先在设置中加载 AI 模型，才能使用纠错润色功能', 'warning');
      return;
    }

    // 立即触发后端纠错
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/' + sessionId + '/refine', {method:'POST'});
    var data = await resp.json();
    if (data.error) {
      if (typeof showToast === 'function') showToast(data.error, 'error');
      loadMinutesHistory('minutesHistory');
      return;
    }

    if (typeof showToast === 'function') showToast('AI纠错已启动，请稍候...', 'info');
    loadMinutesHistory('minutesHistory');  // 立即刷新显示"纠错中"
    _pollMinutesProgress();

    // 单独轮询此 session 的完成状态
    if (_refinePollTimers[sessionId]) clearInterval(_refinePollTimers[sessionId]);
    _refinePollTimers[sessionId] = setInterval(async function() {
      try {
        var sResp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/' + sessionId + '/status');
        var session = await sResp.json();
        if (session.status !== 'refining') {
          clearInterval(_refinePollTimers[sessionId]);
          delete _refinePollTimers[sessionId];
          loadMinutesHistory('minutesHistory');
          if (session.refined) {
            if (typeof showToast === 'function') showToast('AI纠错润色完成', 'success');
          } else if (session.error_msg) {
            if (typeof showToast === 'function') showToast('纠错失败: ' + session.error_msg, 'error');
          }
        }
      } catch(e) {}
    }, 2000);

  } catch(e) { if (typeof showToast === 'function') showToast('纠错失败: ' + e.message, 'error'); loadMinutesHistory('minutesHistory'); }
}

async function retrySession(sessionId) {
  if (!(await showDialog('重新转写', '确定要重新转写此录音？', {type: 'warning', confirm: true, confirmLabel: '重新转写', cancelLabel: '取消'}))) return;
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/' + sessionId + '/resume', {method:'POST'});
    var data = await resp.json();
    if (data.error) { if (typeof showToast === 'function') showToast('重试失败: ' + data.error, 'error'); return; }
    loadMinutesHistory('minutesHistory');
    _pollMinutesProgress();
  } catch(e) { if (typeof showToast === 'function') showToast('重试失败: ' + e.message, 'error'); }
}

async function deleteSession(sessionId) {
  if (!(await showDialog('确认删除', '确定删除此录音？删除后不可恢复。', {type: 'danger', confirm: true, confirmLabel: '删除', cancelLabel: '取消'}))) return;
  try {
    await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/' + sessionId, {method:'DELETE'});
    loadMinutesHistory('minutesHistory');
    loadMinutesStorage();
  } catch(e) { if (typeof showToast === 'function') showToast('删除失败: ' + e.message, 'error'); }
}

async function doImportKB(sessionId) {
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/' + sessionId + '/import_kb', {method:'POST'});
    var data = await resp.json();
    if (data.ok) {
      if (typeof showToast === 'function') showToast('已导入文库', 'success');
      loadMinutesHistory('minutesHistory');
    } else { if (typeof showToast === 'function') showToast(data.error || '入库失败', 'error'); }
  } catch(e) { if (typeof showToast === 'function') showToast('入库失败: ' + e.message, 'error'); }
}

// --- 播放器控制 ---
function initPlayerForSession(sessionId) {
  _playerSessionId = sessionId;
  var section = document.getElementById('audioPlayerSection');
  section.style.display = 'block';

  if (_playerAudioEl) { _playerAudioEl.pause(); _playerAudioEl = null; }

  var audio = new Audio((typeof API !== 'undefined' ? API : '') + '/api/recorder/' + sessionId + '/audio');
  _playerAudioEl = audio;
  var playBtn = document.getElementById('playerPlayBtn');
  var progress = document.getElementById('playerProgress');
  var currentTimeEl = document.getElementById('playerCurrentTime');
  var durationEl = document.getElementById('playerDuration');

  audio.addEventListener('loadedmetadata', function() {
    // WebM 录制可能缺少 duration 元数据，用 segments 最后时间作为备选
    var dur = audio.duration;
    if (!isFinite(dur) && _currentSegments.length > 0) {
      dur = _currentSegments[_currentSegments.length - 1].end + 2;
    }
    if (isFinite(dur) && dur > 0) {
      durationEl.textContent = formatTime(dur);
      progress.max = dur;
    } else {
      durationEl.textContent = '00:00';
      progress.max = 100;
    }
  });

  audio.addEventListener('timeupdate', function() {
    if (!audio.duration || !isFinite(audio.duration)) return;
    if (typeof playerSeeking !== 'undefined' && playerSeeking) return;
    progress.value = audio.currentTime;
    currentTimeEl.textContent = formatTime(audio.currentTime);
    highlightCurrentSegment(audio.currentTime);
  });

  audio.addEventListener('ended', function() {
    playBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><polygon points="4,1 12,7 4,13" fill="#fff"/></svg>';
  });

  playBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><polygon points="4,1 12,7 4,13" fill="#fff"/></svg>';
  progress.value = 0;
  currentTimeEl.textContent = '00:00';
  // 用 segments 预填 progress.max（WebM 可能缺 duration 元数据）
  if (_currentSegments.length > 0) {
    var lastEnd = _currentSegments[_currentSegments.length - 1].end;
    progress.max = lastEnd + 2;
    durationEl.textContent = formatTime(lastEnd);
  } else {
    durationEl.textContent = '00:00';
  }
}

function togglePlayerPlay() {
  if (!_playerAudioEl) return;
  var playBtn = document.getElementById('playerPlayBtn');
  if (_playerAudioEl.paused) {
    _playerAudioEl.play().catch(function(e) {});
    playBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="3" y="2" width="3" height="10" rx=".5" fill="#fff"/><rect x="8" y="2" width="3" height="10" rx=".5" fill="#fff"/></svg>';
  } else {
    _playerAudioEl.pause();
    playBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><polygon points="4,1 12,7 4,13" fill="#fff"/></svg>';
  }
}

function seekPlayer(value) {
  if (!_playerAudioEl) return;
  _playerAudioEl.currentTime = parseFloat(value);
}

function jumpToTime(seconds) {
  if (!_playerAudioEl || _playerSessionId !== _currentTranscriptSessionId) {
    initPlayerForSession(_currentTranscriptSessionId);
    // 等待音频元数据加载完再跳转
    var checkReady = function() {
      if (_playerAudioEl && _playerAudioEl.readyState >= 1) {
        doSeek();
      } else {
        setTimeout(checkReady, 100);
      }
    };
    setTimeout(checkReady, 200);
    return;
  }
  doSeek();
  function doSeek() {
    if (!_playerAudioEl) return;
    _playerAudioEl.currentTime = seconds;
    if (_playerAudioEl.paused) {
      _playerAudioEl.play().catch(function(e) {});
      document.getElementById('playerPlayBtn').innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="3" y="2" width="3" height="10" rx=".5" fill="#fff"/><rect x="8" y="2" width="3" height="10" rx=".5" fill="#fff"/></svg>';
    }
  }
}

function highlightCurrentSegment(currentTime) {
  var container = document.getElementById('transcriptSegments');
  if (!container || !_currentSegments.length) return;
  var spans = container.querySelectorAll('.seg-line');
  var activeIdx = -1;
  for (var i = _currentSegments.length - 1; i >= 0; i--) {
    if (currentTime >= _currentSegments[i].start) {
      activeIdx = i;
      break;
    }
  }
  spans.forEach(function(span, idx) {
    if (idx === activeIdx) {
      span.style.background = 'var(--accent-color)';
      span.style.borderRadius = '4px';
    } else {
      span.style.background = '';
      span.style.borderRadius = '';
    }
  });
}

// --- 对话Tab锁定检测 ---
async function checkRecordingLock() {
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/recorder/locked');
    var data = await resp.json();
    if (data.locked) {
      var input = document.getElementById('msgInput');
      if (input) { input.disabled = true; input.placeholder = '正在转写音频，对话暂不可用...'; }
      setTimeout(checkRecordingLock, 3000);
    } else {
      var input2 = document.getElementById('msgInput');
      if (input2) { input2.disabled = false; input2.placeholder = '说点什么...'; }
    }
  } catch(e) {}
}

// 暴露到全局
window.minutesRouteState = minutesRouteState;
window.startRecording = startRecording;
window.stopRecording = stopRecording;
window.pauseRecording = pauseRecording;
window.loadMinutesHistory = loadMinutesHistory;
window.loadMinutesStorage = loadMinutesStorage;
window.summarizeSession = summarizeSession;
window.refineSession = refineSession;
window.retrySession = retrySession;
window.deleteSession = deleteSession;
window.importAudio = importAudio;
window.checkRecordingLock = checkRecordingLock;
window.installWhisper = installWhisper;
// loadWhisper removed (Patch10: 二态路由，安装即自动加载)
window.unloadWhisper = unloadWhisper;
window.handleWhisperUnload = handleWhisperUnload;
window.uninstallWhisper = uninstallWhisper;
window.uninstallRecorderExt = uninstallRecorderExt;
window.whisperOnFilePicked = whisperOnFilePicked;
window.whisperOnDrop = whisperOnDrop;
window._pollMinutesProgress = _pollMinutesProgress;

// ===== 录音改名 =====
function formatRecName(s) {
  var key = 'rec_name_' + s.session_id;
  var custom = localStorage.getItem(key);
  if (custom) return custom;
  if (s.started_at) {
    return s.started_at.slice(0, 10) + ' ' + s.started_at.slice(11, 16);
  }
  return s.source === 'import' ? (s.import_filename || '导入') : '录音';
}

function startRenameRec(sessionId, el) {
  var oldName = el.textContent;
  var input = document.createElement('input');
  input.type = 'text';
  input.value = oldName;
  input.style.cssText = 'font-weight:600;font-size:.95em;border:1px solid var(--accent-color);border-radius:4px;padding:2px 6px;width:180px;background:var(--bg-primary);color:var(--text-primary)';
  el.replaceWith(input);
  input.focus();
  input.select();
  function finish() {
    var newName = input.value.trim() || oldName;
    localStorage.setItem('rec_name_' + sessionId, newName);
    input.replaceWith(el);
    el.textContent = newName;
  }
  input.addEventListener('blur', finish);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { input.blur(); }
    if (e.key === 'Escape') { input.value = oldName; input.blur(); }
  });
}
window.formatRecName = formatRecName;
window.startRenameRec = startRenameRec;
window.updateGain = updateGain;
window._startVolumeMonitor = _startVolumeMonitor;
window._startVADMonitor = _startVADMonitor;
window._sendLiveSegment = _sendLiveSegment;
window._encodeWAV = _encodeWAV;
window._writeString = _writeString;
window.updateRecTimer = updateRecTimer;
window.viewTranscript = viewTranscript;
window.closeTranscriptModal = closeTranscriptModal;
window.toggleRefineCompare = toggleRefineCompare;
window.acceptDiffLine = acceptDiffLine;
window.acceptAllRefine = acceptAllRefine;
window.editTranscript = editTranscript;
window.cancelEditTranscript = cancelEditTranscript;
window.saveTranscript = saveTranscript;
window.saveAndImportKB = saveAndImportKB;
window.doImportKB = doImportKB;
window.initPlayerForSession = initPlayerForSession;
window.togglePlayerPlay = togglePlayerPlay;
window.seekPlayer = seekPlayer;
window.jumpToTime = jumpToTime;
window.highlightCurrentSegment = highlightCurrentSegment;
window.escapeHtml = escapeHtml;
window.saveMinutesAs = saveMinutesAs;
window.exportMinutes = exportMinutes;
window.reloadWhisper = reloadWhisper;

// 兼容旧 HTML onclick 引用
window.importToKB = function() {
  if (_currentTranscriptSessionId) doImportKB(_currentTranscriptSessionId);
};

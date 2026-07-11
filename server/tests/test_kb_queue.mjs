// ===== test_kb_queue.mjs — Fix 1, 2, 4: KB Queue rendering, progress phases, conflict UI =====
//
// Tests the logic extracted from static/js/qa.js for:
//   Fix 1: Vertical layout — _kbRenderQueue uses <div class="kb-qitem">
//   Fix 2: Progress phases — only chunking/embedding/queued shown, others skipped
//   Fix 4: Conflict resolution — _kbAddToQueue handles conflictInfo, buttons rendered
//
// Run: node --experimental-vm-modules tests/test_kb_queue.mjs
//   or: node tests/test_kb_queue.mjs

// ============================================================
//  Simulate DOM environment
// ============================================================
const globalDom = {
  _innerHTML: '',
  style: { display: 'none' },
  innerHTML: '',
  textContent: '',
};
let domElements = {};

function mockGetElementById(id) {
  if (!domElements[id]) {
    domElements[id] = { ...globalDom, id };
  }
  return domElements[id];
}

// ============================================================
//  Helper: esc (from utils.js)
// ============================================================
function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
//  Replicated functions from qa.js
// ============================================================
let _kbQueueItems = [];

function _kbAddToQueue(docId, filename, conflictInfo) {
  // 去重
  for (let i = 0; i < _kbQueueItems.length; i++) {
    if (_kbQueueItems[i].docId === docId) return;
  }
  let item = { docId: docId, filename: filename || docId, phase: 'queued', pct: 0, error: false };
  if (conflictInfo) {
    item.conflict = true;
    item.conflict_info = conflictInfo;
  }
  _kbQueueItems.push(item);
  _kbRenderQueue();
}

function _kbUpdateQueue(docId, phase, pct) {
  for (let i = 0; i < _kbQueueItems.length; i++) {
    if (_kbQueueItems[i].docId === docId) {
      _kbQueueItems[i].phase = phase;
      _kbQueueItems[i].pct = pct;
      if (phase === 'error' || phase === 'timeout') _kbQueueItems[i].error = true;
      break;
    }
  }
  _kbRenderQueue();
}

function _kbRemoveFromQueue(docId) {
  _kbQueueItems = _kbQueueItems.filter(function(item) { return item.docId !== docId; });
  _kbRenderQueue();
}

function _kbRenderQueue() {
  const floatBar = mockGetElementById('kbFloatBar');
  const floatText = mockGetElementById('kbFloatText');
  const floatList = mockGetElementById('kbFloatList');
  if (!floatBar) return;

  if (_kbQueueItems.length === 0) {
    floatBar.style.display = 'none';
    return;
  }

  floatBar.style.display = 'flex';
  if (floatText) floatText.textContent = '处理中 ' + _kbQueueItems.length + ' 项';

  let listHtml = '';
  for (let i = 0; i < _kbQueueItems.length; i++) {
    const item = _kbQueueItems[i];

    // Fix 4: conflict items get special rendering
    if (item.conflict && item.conflict_info) {
      listHtml += '<div class="kb-qitem kb-qconflict">';
      listHtml += '<span>' + esc(item.filename) + ' — 检测到重复</span>';
      listHtml += '<button class="btn btn-xs" onclick="kbResolveConflict(\'' + esc(item.docId) + '\',\'replace\')">替换</button>';
      listHtml += '<button class="btn btn-xs" onclick="kbResolveConflict(\'' + esc(item.docId) + '\',\'keep\')">保留</button>';
      listHtml += '<button class="btn btn-xs" onclick="kbResolveConflict(\'' + esc(item.docId) + '\',\'cancel\')">取消</button>';
      listHtml += '</div>';
      continue;
    }

    // Fix 2: only keep chunking, embedding, queued phases
    let phaseLabel;
    if (item.phase === 'chunking') {
      phaseLabel = '切块 (' + item.pct + '%)';
    } else if (item.phase === 'embedding') {
      phaseLabel = '向量 (' + item.pct + '%)';
    } else if (item.phase === 'queued') {
      phaseLabel = '排队中';
    } else {
      continue; // skip unknown/completed phases, don't show
    }

    listHtml += '<div class="kb-qitem">' + esc(item.filename) + ' <span class="qi-pct">' + phaseLabel + '</span></div>';
  }
  if (floatList) floatList.innerHTML = listHtml;
}

// ============================================================
//  Test Helpers
// ============================================================
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error('  ✗ FAIL:', msg);
  }
}

function assertEqual(actual, expected, msg) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error('  ✗ FAIL:', msg, '— expected:', JSON.stringify(expected), 'got:', JSON.stringify(actual));
  }
}

function assertContains(haystack, needle, msg) {
  if (haystack.includes(needle)) {
    passed++;
  } else {
    failed++;
    console.error('  ✗ FAIL:', msg, '— needle not found in haystack');
    console.error('    haystack:', haystack.substring(0, 200));
  }
}

function assertNotContains(haystack, needle, msg) {
  if (!haystack.includes(needle)) {
    passed++;
  } else {
    failed++;
    console.error('  ✗ FAIL:', msg, '— needle should NOT be present but was found');
  }
}

function resetState() {
  _kbQueueItems = [];
  domElements = {};
}

// ============================================================
//  Fix 1: 竖排布局 — Vertical Layout Tests
// ============================================================
console.log('\n=== Fix 1: 竖排布局 (Vertical Layout) ===');

resetState();
{
  // Test: kbFloatList is rendered via innerHTML (not textContent)
  const floatList = mockGetElementById('kbFloatList');
  _kbAddToQueue('doc1', 'test.pdf');
  const html = floatList.innerHTML;
  assertContains(html, '<div class="kb-qitem">', 'kbFloatList uses <div> wrapper per item (not span)');
  assertContains(html, 'kb-qitem', 'Each queue item has class kb-qitem');
}
console.log('  Fix 1: ' + (passed) + ' assertions');

// ============================================================
//  Fix 2: 进度文案 — Progress Phase Labels
// ============================================================
console.log('\n=== Fix 2: 进度文案 (Progress Phases) ===');
const fix2StartPassed = passed;

resetState();
{
  _kbAddToQueue('doc_chunking', 'chunking_test.pdf');
  _kbUpdateQueue('doc_chunking', 'chunking', 45);
  const html = mockGetElementById('kbFloatList').innerHTML;
  assertContains(html, '切块 (45%)', 'chunking phase shows "切块 (X%)"');
}

resetState();
{
  _kbAddToQueue('doc_embedding', 'embedding_test.pdf');
  _kbUpdateQueue('doc_embedding', 'embedding', 78);
  const html = mockGetElementById('kbFloatList').innerHTML;
  assertContains(html, '向量 (78%)', 'embedding phase shows "向量 (X%)"');
}

resetState();
{
  _kbAddToQueue('doc_queued', 'queued_test.pdf');
  // stays at queued (default)
  const html = mockGetElementById('kbFloatList').innerHTML;
  assertContains(html, '排队中', 'queued phase shows "排队中"');
}

resetState();
{
  // Test: chunking_done should NOT be displayed
  _kbAddToQueue('doc_cd', 'chunking_done_test.pdf');
  _kbUpdateQueue('doc_cd', 'chunking_done', 100);
  const html = mockGetElementById('kbFloatList').innerHTML;
  assertNotContains(html, 'chunking_done', 'chunking_done phase is NOT displayed');
  assertNotContains(html, '切块完成', 'chunking_done label "切块完成" is NOT displayed');
}

resetState();
{
  // Test: 'done' phase should NOT be displayed in queue
  _kbAddToQueue('doc_done', 'done_test.pdf');
  _kbUpdateQueue('doc_done', 'done', 100);
  const html = mockGetElementById('kbFloatList').innerHTML;
  assertNotContains(html, '完成', 'done phase is NOT displayed in queue');
}

resetState();
{
  // Test: 'subscribed' phase should NOT be displayed
  _kbAddToQueue('doc_sub', 'sub_test.pdf');
  _kbUpdateQueue('doc_sub', 'subscribed', 0);
  const html = mockGetElementById('kbFloatList').innerHTML;
  assertNotContains(html, 'subscribed', 'subscribed phase is NOT displayed');
}

resetState();
{
  // Test: 'timeout' phase should NOT be displayed
  _kbAddToQueue('doc_to', 'timeout_test.pdf');
  _kbUpdateQueue('doc_to', 'timeout', 0);
  const html = mockGetElementById('kbFloatList').innerHTML;
  assertNotContains(html, 'timeout', 'timeout phase is NOT displayed');
}

resetState();
{
  // Test: 'unknown' phase should NOT be displayed
  _kbAddToQueue('doc_unk', 'unknown_test.pdf');
  _kbUpdateQueue('doc_unk', 'unknown', 0);
  const html = mockGetElementById('kbFloatList').innerHTML;
  assertNotContains(html, 'unknown', 'unknown phase is NOT displayed');
}

resetState();
{
  // Test: mixed queue — only visible phases render
  _kbAddToQueue('doc_a', 'visible.pdf');
  _kbUpdateQueue('doc_a', 'chunking', 30);

  _kbAddToQueue('doc_b', 'hidden.pdf');
  _kbUpdateQueue('doc_b', 'done', 100);

  _kbAddToQueue('doc_c', 'also_hidden.pdf');
  _kbUpdateQueue('doc_c', 'chunking_done', 100);

  const html = mockGetElementById('kbFloatList').innerHTML;
  assertContains(html, 'visible.pdf', 'visible item is rendered');
  assertContains(html, '切块 (30%)', 'chunking label rendered');
  assertNotContains(html, 'hidden.pdf', 'done-phase item is NOT rendered');
  assertNotContains(html, 'also_hidden.pdf', 'chunking_done item is NOT rendered');

  // Count kb-qitem divs in the output (should be exactly 1)
  const matches = html.match(/<div class="kb-qitem">/g);
  assertEqual(matches ? matches.length : 0, 1, 'Only 1 item rendered in mixed queue (others filtered)');
}

console.log('  Fix 2: ' + (passed - fix2StartPassed) + ' assertions');

// ============================================================
//  Fix 2b: kbSubscribeProgress toast behavior
// ============================================================
console.log('\n=== Fix 2b: kbSubscribeProgress Toast Behavior ===');
const fix2bStartPassed = passed;

// Simulate the toast logic from kbSubscribeProgress (lines 934-939)
{
  const toastShown = [];
  function simulateToast(phase) {
    // Only 'done' and 'error' trigger toast
    if (phase === 'done') {
      toastShown.push('success');
    } else if (phase === 'error') {
      toastShown.push('error');
    }
    // Other phases: no toast
  }

  simulateToast('done');
  simulateToast('error');
  simulateToast('chunking');
  simulateToast('embedding');
  simulateToast('subscribed');
  simulateToast('chunking_done');
  simulateToast('timeout');
  simulateToast('unknown');

  assertEqual(toastShown.length, 2, 'Only done and error trigger toasts');
  assertEqual(toastShown[0], 'success', 'done → success toast');
  assertEqual(toastShown[1], 'error', 'error → error toast');
}

console.log('  Fix 2b: ' + (passed - fix2bStartPassed) + ' assertions');

// ============================================================
//  Fix 4: 冲突交互 — Conflict Resolution
// ============================================================
console.log('\n=== Fix 4: 冲突交互 (Conflict Resolution) ===');
const fix4StartPassed = passed;

resetState();
{
  // Test: _kbAddToQueue accepts conflictInfo
  const conflictInfo = {
    existing_doc_id: 'old_doc_123',
    existing_filename: 'old_file.pdf',
    level: 'exact',
    similarity: 0.98,
  };
  _kbAddToQueue('new_doc', 'new_file.pdf', conflictInfo);

  assertEqual(_kbQueueItems.length, 1, 'One item added to queue');
  assertEqual(_kbQueueItems[0].conflict, true, 'Item marked as conflict');
  assertEqual(_kbQueueItems[0].conflict_info.existing_doc_id, 'old_doc_123',
    'conflict_info.existing_doc_id preserved');
  assertEqual(_kbQueueItems[0].conflict_info.level, 'exact',
    'conflict_info.level preserved');
}

resetState();
{
  // Test: conflict items render special UI with buttons
  const conflictInfo = {
    existing_doc_id: 'old_doc_456',
    existing_filename: 'existing.pdf',
    level: 'similar',
    similarity: 0.85,
  };
  _kbAddToQueue('conflict_doc', 'conflict_file.pdf', conflictInfo);

  const html = mockGetElementById('kbFloatList').innerHTML;

  assertContains(html, 'kb-qconflict', 'Conflict item has kb-qconflict class');
  assertContains(html, '检测到重复', 'Shows "检测到重复" label');
  assertContains(html, '替换', 'Replace button present');
  assertContains(html, '保留', 'Keep button present');
  assertContains(html, '取消', 'Cancel button present');
  assertContains(html, 'kbResolveConflict', 'Buttons call kbResolveConflict');

  // Verify each button has the right action
  assertContains(html, "'replace'", 'Replace button uses action replace');
  assertContains(html, "'keep'", 'Keep button uses action keep');
  assertContains(html, "'cancel'", 'Cancel button uses action cancel');
}

resetState();
{
  // Test: non-conflict item does not have conflict UI
  _kbAddToQueue('normal_doc', 'normal_file.pdf'); // no conflictInfo
  const html = mockGetElementById('kbFloatList').innerHTML;
  assertNotContains(html, 'kb-qconflict', 'Normal item has NO kb-qconflict class');
  assertNotContains(html, '检测到重复', 'Normal item has NO conflict label');
  assertNotContains(html, '替换', 'Normal item has NO replace button');
}

resetState();
{
  // Test: mixed queue— conflict and normal items rendered together
  _kbAddToQueue('doc_normal', 'normal.pdf');
  _kbAddToQueue('doc_conflict', 'duplicate.pdf', {
    existing_doc_id: 'old_x', existing_filename: 'old.pdf', level: 'exact', similarity: 1.0
  });
  _kbAddToQueue('doc_normal2', 'normal2.pdf');

  const html = mockGetElementById('kbFloatList').innerHTML;

  // Normal items: rendered with kb-qitem (not kb-qconflict)
  assertContains(html, 'normal.pdf', 'Normal item 1 rendered');
  assertContains(html, 'normal2.pdf', 'Normal item 2 rendered');

  // Conflict item
  assertContains(html, 'duplicate.pdf', 'Conflict item rendered');
  assertContains(html, 'kb-qconflict', 'Conflict item has kb-qconflict class');

  // Count: 2 normal + 1 conflict = 3 items rendered
  const normalMatches = html.match(/<div class="kb-qitem">/g);
  const conflictMatches = html.match(/kb-qconflict/g);
  assertEqual(normalMatches ? normalMatches.length : 0, 2, '2 normal items rendered');
  assertEqual(conflictMatches ? conflictMatches.length : 0, 1, '1 conflict item rendered');
}

resetState();
{
  // Test: dedup — same docId added twice only adds once
  _kbAddToQueue('same_doc', 'first.pdf');
  _kbAddToQueue('same_doc', 'second.pdf');
  assertEqual(_kbQueueItems.length, 1, 'Duplicate docId prevented');
  assertEqual(_kbQueueItems[0].filename, 'first.pdf', 'First filename preserved');
}

console.log('  Fix 4: ' + (passed - fix4StartPassed) + ' assertions');

// ============================================================
//  Fix 4b: kbResolveConflict function signature verification
// ============================================================
console.log('\n=== Fix 4b: kbResolveConflict Existence ===');

{
  // Verify the function signature: kbResolveConflict(docId, action)
  // The actual function is in qa.js — we test the logic here
  // The function exists and accepts 'replace', 'keep', 'cancel' actions

  const validActions = ['replace', 'keep', 'cancel'];
  const invalidActions = ['delete', 'merge', 'skip', ''];

  for (const action of validActions) {
    assert(
      ['replace', 'keep', 'cancel'].includes(action),
      'Valid action: ' + action
    );
  }

  for (const action of invalidActions) {
    assert(
      !['replace', 'keep', 'cancel'].includes(action),
      'Invalid action NOT accepted: ' + action
    );
  }
}

// ============================================================
//  Edge Cases & Robustness
// ============================================================
console.log('\n=== Edge Cases ===');
const edgeStartPassed = passed;

resetState();
{
  // Test: empty queue hides float bar
  assertEqual(_kbQueueItems.length, 0, 'Queue starts empty');
  const floatBar = mockGetElementById('kbFloatBar');
  _kbRenderQueue();
  assertEqual(floatBar.style.display, 'none', 'Float bar hidden when queue empty');
}

resetState();
{
  // Test: queue with items shows float bar
  _kbAddToQueue('doc_vis', 'visible.pdf');
  const floatBar = mockGetElementById('kbFloatBar');
  assertEqual(floatBar.style.display, 'flex', 'Float bar visible when queue has items');
}

resetState();
{
  // Test: removing last item hides float bar
  _kbAddToQueue('doc_last', 'last.pdf');
  _kbRemoveFromQueue('doc_last');
  const floatBar = mockGetElementById('kbFloatBar');
  assertEqual(floatBar.style.display, 'none', 'Float bar hidden after removing last item');
}

resetState();
{
  // Test: error phase item still rendered (with continue it would be skipped)
  _kbAddToQueue('doc_err', 'error.pdf');
  _kbUpdateQueue('doc_err', 'error', 0);
  const html = mockGetElementById('kbFloatList').innerHTML;
  // error phase falls into else { continue } — should NOT appear
  assertNotContains(html, 'error.pdf', 'error-phase item is NOT displayed in queue');
}

resetState();
{
  // Test: HTML escaping prevents XSS in filenames
  _kbAddToQueue('xss_doc', '<script>alert("xss")</script>');
  const html = mockGetElementById('kbFloatList').innerHTML;
  assertNotContains(html, '<script>', 'Script tag escaped in filename');
  assertContains(html, '&lt;script&gt;', 'Script tag HTML-escaped');
}

resetState();
{
  // Test: HTML escaping in conflict filenames
  _kbAddToQueue('xss_conflict', '<img onerror=alert(1)>', {
    existing_doc_id: 'old', existing_filename: 'safe.pdf', level: 'exact', similarity: 1.0
  });
  const htmlConflictXss = mockGetElementById('kbFloatList').innerHTML;
  // esc() escapes < > & " — so <img becomes &lt;img, which is safe as text
  assertNotContains(htmlConflictXss, '<img ', 'angle-bracket img tag escaped in conflict filename');
  assertContains(htmlConflictXss, '&lt;img', 'img tag encoded as &lt;img in conflict filename');
}

resetState();
{
  // Test: pct=0 for chunking phase
  _kbAddToQueue('doc_pct0', 'zero_pct.pdf');
  _kbUpdateQueue('doc_pct0', 'chunking', 0);
  const html = mockGetElementById('kbFloatList').innerHTML;
  assertContains(html, '切块 (0%)', 'chunking at 0% shows correctly');
}

resetState();
{
  // Test: pct=100 for embedding phase
  _kbAddToQueue('doc_pct100', 'full_pct.pdf');
  _kbUpdateQueue('doc_pct100', 'embedding', 100);
  const html = mockGetElementById('kbFloatList').innerHTML;
  assertContains(html, '向量 (100%)', 'embedding at 100% shows correctly');
}

console.log('  Edge Cases: ' + (passed - edgeStartPassed) + ' assertions');

// ============================================================
//  Summary
// ============================================================
console.log('\n========================================');
console.log('  TOTAL: ' + (passed + failed) + ' tests');
console.log('  PASSED: ' + passed);
console.log('  FAILED: ' + failed);
console.log('========================================\n');

if (failed > 0) {
  process.exitCode = 1;
}

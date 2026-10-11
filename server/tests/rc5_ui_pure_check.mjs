import { isToolCompletion, sessionLabel, showSceneTag } from '../static/js/v2/pure.js';

const done = ['skill_mounted', 'memory_saved', 'memory_recalled', 'skill_installed',
  'skill_ref_loaded', 'docs_listed', 'workspace_listed', 'workspace_deleted',
  'workspace_appended', 'todos_updated', 'search_done', 'docx_done', 'error'];
const running = ['searching', 'docx_working', 'thinking', 'skill_mounting', 'workspace_writing'];

for (const s of done) {
  if (!isToolCompletion(s)) {
    console.error('expected completion:', s);
    process.exit(1);
  }
}
for (const s of running) {
  if (isToolCompletion(s)) {
    console.error('expected running:', s);
    process.exit(1);
  }
}

const folder = '2026-10-02_002';
if (sessionLabel({ title: '过桥米线', name: folder }) !== '过桥米线') process.exit(1);
if (sessionLabel({ title: folder, name: folder }) !== '新会话') process.exit(1);
if (sessionLabel({ name: folder }) !== '新会话') process.exit(1);

if (showSceneTag('kb', true)) process.exit(1);
if (!showSceneTag('kb', false)) process.exit(1);
if (!showSceneTag('ppt', true)) process.exit(1);
if (showSceneTag('chat', false)) process.exit(1);

console.log('rc5 ui pure ok');

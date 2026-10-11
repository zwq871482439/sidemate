// 纯函数（无 DOM）。过程区完成态、会话显示名、场景标签是否与知识库附件重复。

export function isToolCompletion(status) {
  if (!status) return false;
  if (status === 'error' || status === 'proj_kb') return true;
  if (status.endsWith('_done')) return true;
  if (status.endsWith('ing')) return false;
  return /ed$/.test(status);
}

export function sessionLabel(chat) {
  if (!chat) return '新会话';
  const title = String(chat.title || '').trim();
  const name = String(chat.name || '').trim();
  if (title && title !== name) return title;
  return '新会话';
}

export function showSceneTag(scene, hasKbAttach) {
  if (!scene || scene === 'chat') return false;
  if (hasKbAttach && (scene === 'kb' || scene === 'kb_qa')) return false;
  return true;
}

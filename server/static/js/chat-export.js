// ===== chat-export.js — 导出/文件操作 =====
// 依赖: api.js, utils.js, 全局变量 currentChatFile, currentMessages

async function exportChat() {
  if (!currentChatFile) { showToast('没有可导出的对话', 'error'); return; }
  var name = currentChatFile.split(/[\\/]/).pop().replace('.json','');
  try {
    var resp = await fetch((typeof API !== 'undefined' ? API : '') + '/api/chats/' + encodeURIComponent(name) + '/messages');
    var data = await resp.json();
    var msgs = data.messages || [];
    var lines = [];
    msgs.forEach(function(m) {
      var role = m.role === 'user' ? '你' : (m.model || 'AI');
      lines.push(role + (m.ts ? ' (' + m.ts + ')' : ''));
      lines.push('');
      lines.push(m.content || '');
      lines.push('');
    });
    var text = lines.join('\n');
    var blob = new Blob([text], {type: 'text/plain;charset=utf-8'});
    saveFileAs(URL.createObjectURL(blob), name + '.txt');
    showToast('对话已导出');
  } catch(e) {
    showToast('导出失败: ' + e.message, 'error');
  }
}

function saveFileAs(url, filename) {
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}

window.exportChat = exportChat;
window.exportChatTxt = exportChat;
window.saveFileAs = saveFileAs;

// 桌伴 0.10 新版 UI 首次引导（M5-2 转正版 tour）
// 简版：localStorage 标记 + 3 步浮层引导（不阻塞使用）
(function() {
  'use strict';
  var KEY = 'v2_tour_done';
  try { if (localStorage.getItem(KEY)) return; } catch (e) { return; }

  function show() {
    var steps = [
      { title: '欢迎使用桌伴 0.10', text: '全新三栏界面：左侧项目与会话，中间对话，右侧视窗（产物预览/文件/调用轨迹）。', icon: '🎯' },
      { title: '项目即文件夹', text: '一个文件夹 = 一个项目。材料放根目录，AI 产物在 .sidemate/ 子目录。写文件先出确认卡。', icon: '📁' },
      { title: '强大的产物能力', text: 'AI 可直接生成可编辑的 PPT（.pptx）、精排版 Word（.docx）、HTML 报告——右侧视窗实时预览。', icon: '📊' },
    ];
    var idx = 0;
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,43,70,.55);z-index:9999;display:flex;align-items:center;justify-content:center';
    var card = document.createElement('div');
    card.style.cssText = 'background:#fff;border-radius:16px;padding:32px;width:400px;max-width:90vw;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.2)';
    ov.appendChild(card);
    document.body.appendChild(ov);
    function render() {
      var s = steps[idx];
      card.innerHTML = '<div style="font-size:40px;margin-bottom:12px">' + s.icon + '</div>' +
        '<h3 style="margin:0 0 8px;font-size:18px;color:#1a1a1a">' + s.title + '</h3>' +
        '<p style="margin:0 0 20px;font-size:14px;color:#555;line-height:1.6">' + s.text + '</p>' +
        '<div style="display:flex;gap:4px;justify-content:center;margin-bottom:16px">' +
        steps.map(function(_, i) { return '<span style="width:8px;height:8px;border-radius:50%;background:' + (i <= idx ? '#2563EB' : '#ddd') + ';display:inline-block;margin:0 2px"></span>'; }).join('') + '</div>' +
        '<button id="v2tourNext" style="background:#2563EB;color:#fff;border:none;border-radius:8px;padding:10px 28px;font-size:14px;cursor:pointer">' +
        (idx === steps.length - 1 ? '开始使用' : '下一步') + '</button>';
      card.querySelector('#v2tourNext').onclick = function() {
        idx++;
        if (idx >= steps.length) {
          try { localStorage.setItem(KEY, '1'); } catch (e) {}
          ov.remove();
        } else render();
      };
    }
    render();
    ov.onclick = function(e) { if (e.target === ov) { try { localStorage.setItem(KEY, '1'); } catch (e) {} ov.remove(); } };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
  else show();
})();

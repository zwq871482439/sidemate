// 桌伴新版 UI 首次引导（0.11.1 重做：DNA-01 配色 + 动态版本号 + 跳过按钮 + 描边图标替代 emoji）
// 简版：localStorage 标记 + 3 步浮层引导；点背景或「跳过」随时退出，不强制走完。
(function () {
  'use strict';
  var KEY = 'v2_tour_done';
  try { if (localStorage.getItem(KEY)) return; } catch (e) { return; }

  // 描边图标（与 icons.js 同源风格：24 viewBox / currentColor / 1.6 宽）
  var IC = {
    chat: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    ppt: '<path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="M12 14v7"/><path d="m8 21 4-4 4 4"/>',
  };
  function svg(path, color) {
    return '<svg fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" style="width:44px;height:44px;display:block;margin:0 auto 14px">' + path + '</svg>';
  }
  // 版本号：先从标题取（服务端模板注入），取不到由 show() 内异步补
  function ver() {
    try {
      var m = (document.title || '').match(/v[0-9.]+/);
      return m ? m[0] : '';
    } catch (e) { return ''; }
  }

  function show() {
    var steps = [
      { title: '欢迎使用桌伴 ' + (ver() || '新版'), icon: IC.chat,
        text: '三栏界面：左侧项目与会话，中间对话，右侧视窗（产物预览 / 文件 / 调用轨迹）。' },
      { title: '项目即文件夹', icon: IC.folder,
        text: '一个文件夹 = 一个项目。材料放根目录，AI 产物在 .sidemate/ 子目录。写文件先出确认卡。' },
      { title: '强大的产物能力', icon: IC.ppt,
        text: 'AI 可直接生成可编辑的 PPT（.pptx）、精排版 Word（.docx）、HTML 报告——右侧视窗实时预览。' },
    ];
    var idx = 0;
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,43,70,.55);z-index:9999;display:flex;align-items:center;justify-content:center';
    var card = document.createElement('div');
    // DNA-01：纸面底 / 深蓝标题 / 金色主按钮
    card.style.cssText = 'background:#F7F9FB;border:1px solid #E2E9F0;border-radius:14px;padding:30px 32px;width:400px;max-width:90vw;text-align:center;box-shadow:0 8px 32px rgba(15,43,70,.24)';
    ov.appendChild(card);
    document.body.appendChild(ov);

    function close() {
      try { localStorage.setItem(KEY, '1'); } catch (e) {}
      ov.remove();
    }
    function render() {
      var s = steps[idx];
      card.innerHTML =
        svg(s.icon, '#B07E1E') +
        '<h3 style="margin:0 0 8px;font-size:18px;color:#0F2B46;font-family:inherit">' + s.title + '</h3>' +
        '<p style="margin:0 0 18px;font-size:13.5px;color:#5B6B7B;line-height:1.65;font-family:inherit">' + s.text + '</p>' +
        '<div style="display:flex;gap:5px;justify-content:center;margin-bottom:16px">' +
          steps.map(function (_, i) {
            return '<span style="width:7px;height:7px;border-radius:50%;background:' + (i <= idx ? '#B07E1E' : '#E2E9F0') + ';display:inline-block"></span>';
          }).join('') + '</div>' +
        '<div style="display:flex;gap:10px;justify-content:center;align-items:center">' +
          '<button data-a="skip" style="background:none;border:1px solid #E2E9F0;color:#5B6B7B;border-radius:8px;padding:9px 20px;font-size:13px;cursor:pointer;font-family:inherit">跳过</button>' +
          '<button data-a="next" style="background:#E8B54D;color:#131B24;border:none;border-radius:8px;padding:9px 30px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">' +
            (idx === steps.length - 1 ? '开始使用' : '下一步') + '</button>' +
        '</div>';
      card.querySelector('[data-a="next"]').onclick = function () {
        idx++;
        if (idx >= steps.length) close(); else render();
      };
      card.querySelector('[data-a="skip"]').onclick = close;
    }
    render();
    // 首步标题异步补真版本号（tour 跑在 boot 版本注入之前；steps 是本函数局部变量）
    if (!ver()) {
      fetch('/api/system/info').then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.version_display && idx === 0 && document.body.contains(card)) {
          steps[0].title = '欢迎使用桌伴 ' + d.version_display;
          render();
        }
      }).catch(function () {});
    }
    ov.onclick = function (e) { if (e.target === ov) close(); };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
  else show();
})();

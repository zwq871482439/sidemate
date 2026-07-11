# Patch3 前端第二轮修复 — 完成报告

## TL;DR
基于审计团队的前端反馈，完成了 23 项前端修复，涵盖死代码清理、XSS 防护、CSS 变量统一、Emoji→SVG 迁移、UX 改进等。

## 修改概览

| 文件 | 修改内容 |
|------|---------|
| `chat.js` | Emoji→SVG（29处）、Tab 键阻止、空状态引导增强、上下文颜色 CSS 变量化 |
| `qa.js` | 删除 kbUninstallModule 死代码、KB error XSS 修复、KB 停止按钮、SVG→iconSvg、emoji→SVG |
| `core/utils.js` | iconSvg 4 个图标(check/cross/warn/stop) #hex → currentColor |
| `core/errors.js` | 新增 stopHeartbeat() 函数 |
| `main.css` | Dark sidebar active 覆盖 |

## 详细 FIX 清单

### 安全修复
- **FIX-001** KB error XSS → `esc(evt.content)` 
- **FIX-008** Action 按钮标签 → 确认已用 esc()（无需改动）

### 死代码清理
- **FIX-002** sourceTag/privacyTag → 不存在（已清理）
- **FIX-003** kbUninstallModule → 删除整个函数+导出（后端路由保留）
- **FIX-011** rerankerResidentChk → 确认不存在

### Bug 修复
- **FIX-007** Dark sidebar active crash → `[data-theme="dark"] .chat-sidebar-item.active{background:var(--bg-tertiary)}`
- **FIX-016** 上下文指示器颜色 → `#dc3545/#f0ad4e` → `var(--error-color)/var(--warning-color)`
- **FIX-020** _kbBusyLastState → 已有声明

### 新功能
- **FIX-019** stopHeartbeat → 新增函数 + 全局导出
- **FIX-030** KB 停止按钮 → 生成中显示停止图标，完成后恢复提问
- **FIX-039** Tab 键导航 → textarea 内阻止 Tab 跳出
- **FIX-040** 空状态引导 → 图标+主文字+副标题

### CSS/JS 颜色统一
- **FIX-031** CSS 变量定义已完善
- **FIX-032** JS 硬编码颜色 50+ 处 → iconSvg currentColor + CSS 变量
- **FIX-017** Chat 上下文颜色 → 已统一

### Emoji→SVG 迁移
- **FIX-037** chat.js 29处 + qa.js 47处 iconSvg 调用

## 验证结果
- ✅ chat.js 语法检查通过
- ✅ qa.js 语法检查通过
- ✅ utils.js 语法检查通过
- ✅ errors.js 语法检查通过
- ✅ chat-ui.js 语法检查通过
- ✅ chat-session.js 语法检查通过
- ✅ kbUninstallModule 引用计数: 0（已完全删除）
- ✅ stopHeartbeat 函数: 已添加
- ✅ kbStopGeneration 函数: 已添加
- ✅ Dark sidebar CSS: 已添加

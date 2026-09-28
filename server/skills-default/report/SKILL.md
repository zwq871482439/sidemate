---
name: report
description: 生成可视化网页报告。当用户要求图文报告、数据报告、带图表的分析、做个网页版报告时使用。
trigger: scene
pipeline_types: [report]
priority: 10
---

# 可视化报告

用户要一份带图表的网页报告（自包含 HTML，浏览器打开即看）。

## 工作流
1. **取数**：用户提供的数据（粘贴/表格/文件）先读全；需要联网补充的先搜索再写
2. **写文件**：write_workspace 写 .html 文件（如"渠道复盘报告.html"）：
   - **只写 body 内容**（系统自动包装 html/head/样式），必须用 HTML 标签，禁 Markdown 语法
   - 用内置组件：`<div class="lead">` 导读块、`<span class="highlight-num">` 大数字、
     `<div class="callout">` 提示框、`<div class="grid-2">` 双栏、`<div class="stats">` 指标行
3. **图表**：HTML 内用 ```mermaid``` 围栏，按内容选型：
   趋势→xychart-beta 折线；对比→xychart-beta 柱状；占比→pie；流程→flowchart；时序→sequenceDiagram
   （xychart/pie 的数值必须是纯数字）
4. **完成**：set_doc_status("文件名.html", "completed") 生成自包含报告

## 报告设计（2 秒可读原则）
- 开头 lead 块：一段话 + 1 个关键数字，让读者立刻知道结论
- 每节：小标题 + 一句结论句，图表和文字互相印证（图说的就是文字的论点）
- 数据多时优先图表，数据少时用 stats 指标行，不要为了图表而图表
- 结论给判断（"增长主要来自 B 渠道"），不停留在罗列（"各渠道数据如下"）

## 纪律
- 图表数据与正文数字必须一致；来源在文末统一列出
- 单文件控制在 60KB 内，超长拆分主题

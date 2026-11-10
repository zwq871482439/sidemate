---
name: sidemate-word
description: 用桌伴随包脚本读取 DOCX 范本样式、把 Markdown 编成排版好的 Word，以及读取 DOCX/PDF/XLSX 材料；需要写 Word 或提取材料文字和表格时使用。
whenToUse: 用户要看 Word 范本、依据范本写 Word、把 Markdown 交成 DOCX，或读取 DOCX、PDF、XLSX 的文字与表格时。
---

# 写 Word

不要每次现写 `python-docx` 排版程序。先调用 `load_workspace_dependencies`，用结果给出的随包 Python 运行本技能 `scripts/` 里的脚本；不要安装依赖，也不要寻找系统 Python。输入使用工作区里的原件副本，所有产物只写工作区。脚本的标准输出均为 UTF-8 JSON；失败时 JSON 带 `error` 且进程退出码非零。

下文用 `<python>` 代表 `load_workspace_dependencies` 返回的 Python 路径，用 `<skill>` 代表本技能目录。路径含空格时加引号。

## 1. 看范本

```text
<python> <skill>/scripts/inspect_template.py 范本.docx
```

只读范本，不改文件。输出的 `styles.body` 是正文字体、字号、行距、段距和首行缩进；`styles.headings` 按 `1`、`2`、`3` 等层级给标题样式。`sections` 是带 `level` 的实际大纲，`content_hint` 只用于判断结构，不是要照抄的正文。行距的 `unit` 为 `multiple`（倍数）或 `pt`（磅），段距与字号单位均为磅。

## 2. 出 Word

先把完整 UTF-8 Markdown 正文写到工作区，再运行：

```text
<python> <skill>/scripts/compile_docx.py 正文.md 成品.docx
```

可选参数：

- `--template 范本.docx`：保留范本的页面设置和样式，清掉示例正文后排入新内容。有范本时可先看范本，但不必把上一个命令的 JSON 再传进来。
- `--title 文档标题`：指定页眉与封面标题；缺省取正文首个一级标题，再没有就取输出文件名。
- `--cover`：增加标题和日期封面；默认不加封面。

支持 `#`、`##`、`###` 三级标题，普通正文首行缩进，页脚自动页码，Markdown 表格、无序/有序列表、引用、粗体和斜体。输出 JSON 的 `path` 是成品绝对路径，`chars` 和 `size` 可用于核对。输出必须是当前工作区内的 `.docx`，脚本会拒绝写到工作区外。

正文里的出处标记 `〔S01·p1〕` 必须逐字保留，不改编号、页码或括号。表格一行的出处标记放在该行最后一格，例如 `| 项目 | 结论〔S01·p1〕 |`；脚本会原样带进 DOCX，桌伴事后另行核对。

## 3. 读材料

```text
<python> <skill>/scripts/read_material.py 材料.docx
<python> <skill>/scripts/read_material.py 材料.pdf
<python> <skill>/scripts/read_material.py 表格.xlsx --max-rows 200
```

输出 JSON 同时含纯文本 `text` 和 `markdown`：DOCX 保留标题、列表及正文中的表格顺序；PDF 按页提取文字并给 `pages`；XLSX 逐工作表生成 Markdown 表并给 `sheets` 维度。`--max-rows` 限制每个工作表的读取行数，默认 200；`truncated: true` 表示还有行未读。不要根据这些文本自行确信出处页码，页码引用仍由桌伴核对。

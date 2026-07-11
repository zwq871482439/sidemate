# Session 交接文档

> 项目：本地 AI 助手 (`C:\tmp\_local-ai`)
> 更新日期：2026-05-23 00:20
> 当前版本：Patch 10.5（贝叶斯 Agent 增强）

---

## 当前状态

Patch 10 + Patch10.5 全部完成。22 个文件修改，所有语法检查通过。

### 模块版本

| 模块 | 版本 | 文件 |
|------|------|------|
| server | Patch 10 | `server.py` |
| models | v1.7 | `models.py` |
| agent | v2.1 | `agent.py` |
| prompts | v3.2 | `prompts.py` |
| task_classifier | v9.1 | `task_classifier.py` |
| config | v2.1 | `config.py` |
| chunking_orchestrator | v1.1 | `chunking_orchestrator.py` |
| knowledge_base | v1.0 | `knowledge_base.py` |
| recorder | v1.0 | `recorder.py` |

---

## Patch 10 完成内容（5 个批次）

### T01: Bug 修复 + 基础设施
- chunking_orchestrator.py — 移除 `stream=True` 未支持参数
- models.py — `stop_requested` property（线程安全）+ `load()` 进度回调 + `max_tokens` 默认值
- routers/chat.py — 改用 `mgr.stop_requested = False`
- config.py — TTL 缓存加锁

### T02: 前端基础体验
- static/css/main.css — 21 个 CSS 变量 + dark 主题 + 代码块/进度条样式
- index.html — 深色模式开关 + highlight.js 引入 + 主题初始化
- static/js/core/utils.js — `md()` 输出 `language-{lang}` + `copyCode()` + `downloadBlob()`
- static/js/core/errors.js — `ERROR_MAP` + `showErrorByCode()`
- static/vendor/highlight.* — 代码高亮库（3 个文件）

### T03: 设置重构 + 扩展中心 + KB 简化
- routers/settings.py — 泛化扩展上传（model/knowledge/whisper）+ SSE 进度 + 通用卸载
- routers/kb.py — 二态状态机（installed/ready）+ 安装后自动加载
- routers/recorder.py — 二态适配
- static/js/settings.js — 扩展中心 UI + 进度 SSE + Tab 显隐
- static/js/qa.js — 二态路由（移除 activation）
- static/js/minutes.js — 二态路由（移除 inactive）
- index.html — 扩展中心 DOM + Tab 动态显隐

### T04: Agent 改进 + 取消 web-search
- prompts.py — 强化 5 条工具调用规则 + one-shot 示例 + 移除 web_search/web_reader
- agent.py — 早期终止 `_is_final_answer()` + 硬上限 20 + 重试计数器 + `_strip_think_and_extract()`
- server.py — VERSION_PATCH 9→10
- task_classifier.py — web_reader → kb_search/file_ops

### T05: 体验优化集成
- static/js/chat.js — `exportChat()` + `applyCodeHighlight()` 调用
- static/js/minutes.js — `saveMinutesAs()`
- static/js/settings.js — 模型加载进度 SSE 订阅
- index.html — 进度条 DOM + 文件选择器 + 另存按钮

---

## Patch10.5 完成内容（贝叶斯增强）

### 贝叶斯工具先验
- task_classifier.py — `AGENT_TOOL_PRIORS` + `AGENT_EXPECTED_STEPS` + `get_agent_tool_prior()`
- agent.py — 工具按先验概率排序 + 高置信度提示注入

### 贝叶斯迭代终止
- agent.py — `_is_final_answer_bayesian()`（先验×似然）替代硬规则
- 先验：基于预期步数（file_ops=1, doc_writer=2, code_runner=1, kb_search=2）
- 似然：文本特征（结果词 + 无请求词）
- 阈值：后验概率 > 0.45

### Agentic 提示强化
- prompts.py — "办公助手"→"自主办公 Agent" + 自主决策描述

### 文件恢复
- settings.json / feedback.json / notebook.json / training.json / setup.bat / start.bat 恢复根目录

---

## 功能清单与文件对应

### 核心后端

| 功能 | 文件 | 说明 |
|------|------|------|
| FastAPI 主服务 | `server.py` | 路由注册、静态文件、中间件、版本号 |
| 模型管理 | `models.py` | ModelManager：加载/推理/设备检测/停止控制 |
| 配置中心 | `config.py` | 全局配置 + TTL 缓存 + settings.json 合并 |
| 任务分类 | `task_classifier.py` | 贝叶斯分类 + 场景先验 + Agent 子意图 + 话题漂移 |
| Agent 循环 | `agent.py` | 工具调用循环 + 贝叶斯终止 + 沙盒执行 |
| 提示工程 | `prompts.py` | 系统提示词 + 思考控制 + 条件规则池 |
| 长文本编排 | `chunking_orchestrator.py` | MapReduce + MemAgent 混合编排 |
| 知识库 | `knowledge_base.py` | KB 管理 + 向量检索 |
| 语音纪要 | `recorder.py` | 录音/转写/纪要生成 |

### API 路由

| 功能 | 文件 | 端点 |
|------|------|------|
| 对话 API | `routers/chat.py` | /api/chat, /api/stop, /api/upload, /api/feedback |
| 知识库 API | `routers/kb.py` | /api/kb/*（二态状态机） |
| 设置 API | `routers/settings.py` | /api/extensions/*, /api/load-progress（SSE） |
| 纪要 API | `routers/recorder.py` | /api/recorder/*（二态适配） |
| 记忆 API | `routers/notebook.py` | /api/notebook/* |
| 技能 API | `routers/skill.py` | /api/skills/* |
| 依赖注入 | `routers/deps.py` | get_mgr, get_kb |

### 前端

| 功能 | 文件 | 说明 |
|------|------|------|
| 主页面 | `index.html` | Tab 导航 + 深色开关 + 扩展中心 DOM |
| 样式 | `static/css/main.css` | CSS 变量 + dark 主题 + 代码块/进度条 |
| 对话 Tab | `static/js/chat.js` | 消息渲染 + 导出 + 代码高亮调用 |
| 问答 Tab | `static/js/qa.js` | KB 二态路由 |
| 纪要 Tab | `static/js/minutes.js` | 录音 + 另存 + 二态路由 |
| 设置 Tab | `static/js/settings.js` | 扩展中心 + 进度 SSE + Tab 显隐 |
| 记忆 Tab | `static/js/memory.js` | 记忆管理 |
| 技能 Tab | `static/js/skills.js` | 技能列表/执行 |
| 工具函数 | `static/js/core/utils.js` | md() + copyCode() + downloadBlob() |
| 错误处理 | `static/js/core/errors.js` | ERROR_MAP + showErrorByCode() |
| API 封装 | `static/js/core/api.js` | SSE 连接管理 |

### 技能模块

| 技能 | 目录 | 功能 |
|------|------|------|
| 文件操作 | `skills/builtin/file-ops/` | 读/写/列目录 |
| 代码运行 | `skills/builtin/code-runner/` | Python 代码执行 |
| Word 生成 | `skills/builtin/word-writer/` | docx 生成 |
| Word 读取 | `skills/builtin/word-reader/` | docx 读取 |
| Excel 读取 | `skills/builtin/xlsx-reader/` | xlsx 读取 |
| 长文本阅读 | `skills/builtin/long-reader/` | 分段阅读 |
| 知识库搜索 | `skills/builtin/kb-search/` | 向量检索 |

### 第三方库

| 库 | 文件 | 用途 |
|----|------|------|
| highlight.js | `static/vendor/highlight.min.js` | 代码语法高亮 |
| highlight.css | `static/vendor/highlight.min.css` | 浅色主题 |
| highlight-dark.css | `static/vendor/highlight-dark.min.css` | 深色主题 |
| KaTeX | `static/vendor/katex.min.js/css` | 数学公式渲染 |

---

## 文件结构

```
C:\tmp\_local-ai\
├── server.py              # FastAPI 主服务 (Patch 10)
├── models.py              # 模型管理 (v1.7)
├── agent.py               # Agent 循环 (v2.1) + 贝叶斯
├── prompts.py             # 提示工程 (v3.2)
├── task_classifier.py     # 任务分类 (v9.1) + 贝叶斯先验
├── config.py              # 配置中心 (v2.1)
├── chunking_orchestrator.py # 长文本编排 (v1.1)
├── knowledge_base.py      # 知识库 (v1.0)
├── recorder.py            # 语音纪要 (v1.0)
├── requirements.txt       # 依赖
├── README.md              # 项目说明
├── setup.bat              # 依赖修复
├── start.bat              # 启动脚本
├── pack_vendor.py         # 离线打包
├── settings.json          # 用户配置
├── feedback.json          # 用户反馈
├── notebook.json          # 记忆数据
├── training.json          # 训练记录
├── routers/               # API 路由
│   ├── chat.py
│   ├── kb.py
│   ├── settings.py
│   ├── recorder.py
│   ├── notebook.py
│   ├── skill.py
│   └── deps.py
├── static/                # 前端资源
│   ├── css/main.css
│   ├── js/
│   │   ├── chat.js
│   │   ├── qa.js
│   │   ├── minutes.js
│   │   ├── settings.js
│   │   ├── memory.js
│   │   ├── skills.js
│   │   └── core/
│   │       ├── utils.js
│   │       ├── errors.js
│   │       └── api.js
│   └── vendor/
│       ├── highlight.min.js
│       ├── highlight.min.css
│       ├── highlight-dark.min.css
│       ├── katex.min.js
│       └── katex.min.css
├── skills/                # 技能模块
│   ├── registry.json
│   └── builtin/
│       ├── file-ops/
│       ├── code-runner/
│       ├── word-writer/
│       ├── word-reader/
│       ├── xlsx-reader/
│       ├── long-reader/
│       └── kb-search/
├── pipelines/             # Pipeline 定义
├── data/                  # 数据目录（运行时创建）
├── chats/                 # 对话记录（运行时创建）
├── extensions/            # 已安装扩展（运行时创建）
├── models/                # 模型文件（运行时创建）
├── workspace/             # 文件沙盒（运行时创建）
└── export/                # 扩展包 ZIP（运行时创建）
```

---

## 关键设计决策

### 贝叶斯 Agent（Patch10.5 新增）

```
工具选择:
  get_agent_hint() -> sub_intent + tool_prior
  agent.py -> 按 prior 降序排列工具描述
  -> 高置信度(>=50%)注入提示

迭代终止:
  P(终止|text,step,intent) = P(终止|step,intent) × P(text|终止)
  prior: 预期步数(file_ops=1, doc_writer=2)
  likelihood: 结果词 + 无请求词
  threshold: posterior > 0.45
```

### 扩展中心（Patch10 T03）

```
统一入口: /api/extensions/upload
ZIP 结构: manifest.json {name, version, type}
type 路由: model -> models/ | knowledge -> data/kb/module/ | whisper -> extensions/whisper/
安装后: KB 自动 load_models()，Tab 动态显隐
```

### KB 二态状态机（Patch10 T03）

```
状态: {installed: bool, ready: bool}
ready = installed && embedder loaded
安装后自动加载，无需手动激活
```

---

## 待做事项

| 优先级 | 任务 | 状态 |
|--------|------|------|
| P0 | Patch10 全量功能测试 | 待测试 |
| P1 | 贝叶斯先验参数调优（基于实际运行数据） | 待收集数据 |
| P2 | 打包发版（v0.9） | 准备中 |

---

## 给下一个 AI 的提示

1. Patch 10 + 10.5 全部完成，22 个文件修改
2. 版本号: server=Patch10, agent=v2.1, prompts=v3.2, classifier=v9.1
3. 核心改进: 深色模式/扩展中心/KB二态/Agent贝叶斯/代码高亮
4. 贝叶斯框架在 task_classifier.py，Agent 接入在 agent.py
5. 扩展模块 ZIP 放在 export/，通过前端扩展中心上传安装
6. 运行时文件（settings.json 等）必须在根目录
7. 启动: `python server.py` -> http://localhost:8000

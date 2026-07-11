# Session Handoff — 本地AI项目 Patch10 发版包

> 生成时间：2026-05-23 01:50  
> 项目路径：`C:\tmp\_local_ai_patch10\`（发版纯净版）  
> 开发路径：`C:\tmp\_local-ai\`（开发环境，勿直接改）

---

## 一、发版包当前状态

| 指标 | 数值 |
|------|------|
| 总大小 | ~430MB（代码 1.6MB + vendor 离线包 428MB） |
| 顶层 py | 12 个 |
| Routers | 5 个（chat / kb / recorder / settings / skill） |
| 前端 JS | 5 个模块 + core/ |
| Pipeline | engine + 3 模板（write_doc / analyze_doc / write_code） |
| 运行时目录 | `data/`（chats / logs / tmp_upload / files / kb / recordings） |

## 二、本 Session 完成的工作

### 2.1 删除的模块（6个 + 反馈系统）

| 删除项 | 影响范围 |
|--------|---------|
| `cloud_provider.py` | server.py 初始化、settings.py 版本列表 |
| `pet_notebook.py` | server.py 初始化、deps.py 依赖注入 |
| `training.py` | server.py 初始化、settings.py 约120行训练API、deps.py |
| `mcp_server.py` | 无引用，独立文件 |
| `benchmark.py` | 无引用，独立文件 |
| 反馈系统（👍👎） | chat.py FeedbackManager类~130行 + 4个API端点、chat.js ~100行、utils.js 按钮注入、main.css 样式 |
| `routers/notebook.py` | server.py 路由注册、__init__.py、deps.py |
| `static/js/memory.js` | index.html script标签 + 记忆Tab HTML |

### 2.2 运行时目录合并

- **旧结构**（根目录散落）：`chats/` `logs/` `tmp_upload/` `files/` `workspace/`
- **新结构**（统一 `data/`）：
  ```
  data/
  ├── chats/      # 对话历史
  ├── logs/       # 日志
  ├── tmp_upload/ # 临时上传
  ├── files/      # 用户文件
  ├── kb/         # 知识库
  └── recordings/ # 录音
  ```

### 2.3 路径管理集中化（config.py）

```python
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT_DIR, "data")
CHAT_DIR = os.path.join(DATA_DIR, "chats")
LOG_DIR = os.path.join(DATA_DIR, "logs")
UPLOAD_DIR = os.path.join(DATA_DIR, "tmp_upload")
FILES_DIR = os.path.join(DATA_DIR, "files")
WORKSPACE_DIR = ROOT_DIR  # backward compat
def ensure_dirs(): ...
```

所有路径常量从 config.py 导入，server.py / routers/chat.py / routers/settings.py / routers/kb.py 已改完。

### 2.4 vendor/ 目录（离线依赖包）

- `vendor/` — 97 个 whl/tar.gz，用于 `pip install --no-index --find-links=vendor/`，**必须保留**
- `static/vendor/` — 前端资源（KaTeX + Highlight.js），与顶层 vendor 无关

## 三、当前目录结构

```
_local_ai_patch10/
├── agent.py                    # Agent 快速路径
├── chunker.py                  # 文本分块
├── chunking_orchestrator.py    # 分块编排
├── config.py                   # 路径常量 + ensure_dirs()
├── context_compressor.py       # 上下文压缩
├── doc_reader.py               # 文档读取
├── doc_writer.py               # 文档写入
├── index.html                  # 前端入口
├── knowledge_base.py           # 知识库核心
├── models.py                   # 模型管理 + OV推理
├── prompts.py                  # Prompt 模板
├── recorder.py                 # 录音处理
├── requirements.txt            # 依赖声明
├── response_filter.py          # 响应过滤
├── server.py                   # FastAPI 入口
├── setup.bat                   # 安装脚本（含环境检测）
├── skill_fileops.py            # 文件操作技能
├── skill_loader.py             # 技能加载器
├── start.bat                   # 启动脚本
├── task_classifier.py          # 任务分类
├── README.md
├── changelogs/                 # 版本更新日志
├── data/                       # 运行时数据（空目录结构）
├── pipeline/                   # Pipeline 引擎
│   ├── __init__.py
│   ├── context.py
│   ├── engine.py
│   ├── steps.py
│   └── templates.py
├── pipelines/                  # Pipeline JSON 模板
│   ├── analyze_doc.json
│   ├── write_code.json
│   ├── write_doc.json
│   └── pipelines/
├── routers/                    # API 路由
│   ├── __init__.py             # 注册 5 个路由
│   ├── chat.py                 # 对话 + SSE 流式
│   ├── deps.py                 # 依赖注入
│   ├── kb.py                   # 知识库
│   ├── recorder.py             # 录音
│   ├── settings.py             # 设置 + 模型管理
│   └── skill.py                # 技能路由
├── skills/                     # 技能目录
│   ├── builtin/
│   ├── custom/
│   ├── skills/
│   └── registry.json
├── static/
│   ├── css/main.css
│   ├── js/
│   │   ├── chat.js
│   │   ├── qa.js
│   │   ├── minutes.js
│   │   ├── settings.js
│   │   ├── skills.js
│   │   └── core/
│   │       ├── api.js
│   │       ├── errors.js
│   │       └── utils.js
│   └── vendor/                 # KaTeX + Highlight.js
└── vendor/                     # 97个离线 whl（428MB）
```

## 四、技术要点速查

### 前端
- `index.html` ~893行（纯HTML+全局变量+init）
- CSS → `static/css/main.css`
- JS → `static/js/` 传统 `<script>` 引入，不用 ES Module
- KaTeX 已本地化至 `static/vendor/`
- fetchWithTimeout 全局 10s，SSE 流式用 `_noTimeout:true` 跳过
- `*{margin:0;padding:0}` reset 消除 `<p>` 默认间距，`.msg p` 需显式 margin

### 后端
- FastAPI + OpenVINO GenAI + Qwen3
- GenerateQueue: HIGH(对话60s) / LOW(摘要/纠错/压缩)，HIGH 可抢占 LOW
- MemoryManager v2: `modules_used_mb` 属性求和，预算默认 8GB 可调 12GB
- Reranker 懒加载: `_ensure_reranker()` + 5min空闲超时
- OV Embedding 截断: `_OV_MAX_CHARS=480`
- KB chunk: max_chars=500, overlap=100
- 依赖版本：openvino-genai 2026.1.0, optimum-intel 1.27.0

### 已移除（勿再引用）
- cloud_provider / pet_notebook / training / mcp_server / benchmark
- feedback 系统（👍👎） / notebook router / memory.js / 记忆 Tab
- 云端模式相关前端和路由

## 五、已知问题 / 待办

- Pipeline 引擎代码存在但**未实战验证**，可能有 bug
- `routers/__pycache__/` 残留，打包时应排除或清理
- `pipelines/pipelines/` 有嵌套空目录，待确认是否需要
- Tab 布局：对话 | 问答 | 纪要 | 技能 | 设置（5个 Tab，记忆已删）

## 六、用户偏好（新 Session 必读）

- 临时文件放 `C:\tmp\`，原始文件未经确认不得动
- 稳定性优先，P0 语气紧迫
- 纯内网环境，离线部署
- 偏好直接行动，不喜欢废话，不确定时才问
- 不要：实时语音、多模板、摘要异步化、联网skill、蒸馏、云端模式

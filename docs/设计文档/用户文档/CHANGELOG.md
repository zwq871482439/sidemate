# 变更日志

> 本文档记录 v0.9 版本的所有变更。完整详情请参阅仓库根目录 [CHANGELOG.md](../../../CHANGELOG.md)。

---

## v0.9.7（2026-06-24）— Indigo + ClearBox

### 🆕 新功能

| 功能 | 说明 |
|------|------|
| **AI 洞察仪表盘** | 环形图 + 分类图例 + 追问按钮，侧栏色点/图例/扇区三重联动 |
| **KB v2 Indigo 设计** | 渐变顶条 + 结构化 badge + 过渡标头 + pinned 卡片 |
| **CardRenderer** | 卡片式明盒渲染器，左色条 + AgentTimeline + 折叠摘要 |
| **提纲编辑器** | 系统字体 + 预览切换 + 刷新恢复 |

### 🔧 架构重构

| 变更 | 说明 |
|------|------|
| 新增 `core/step_model.py` | 统一步骤流数据模型 |
| local_pipeline 重构 | KB 块散乱 yield → Step 对象 |
| memory_local 摘要化 | 并行模式接入 session 压缩 |
| 输出预留动态化 | 释放一半窗口给历史 |

### 🐛 关键修复

| Bug | 修复 |
|-----|------|
| 温度失效 | 策略路由温度链路修复 |
| 截断同步 | truncate 事件同步前端正文 |
| 上下文计数器重构 | 精确注入量 + 双重排除 |
| 并行 drain 丢事件 | 合并修复 |

> 完整日志见 [CHANGELOG.md](../../../CHANGELOG.md)


## v0.9 Patch 3（2026-06）

### 🆕 新功能

| 功能 | 说明 |
|------|------|
| **对比模式** | 文库 Tab 中本地 AI + 云端 AI 同时回答，自动融合分析 |
| **双线程实时流式** | 对比模式使用 Queue 替代 result_holder，token 级实时 SSE 推送 |
| **LLM 调度器** | P0/P2 优先级调度，Chat/文库/纪要共享 GPU 排队 |
| **文档打标系统** | 一次 LLM 调用生成 tags(3-5) + summary(100字)，异步 P2 执行 |
| **标签注入** | 全量标签注入 System Prompt，替代 list_kb_docs |
| **Reformulation** | 有历史时自动做问题重写/追问补全，~100 tokens 成本 |
| **自适应记忆** | 按 token 预算(~3000)自动裁剪，支持 2-3 轮追问 |
| **双线记忆** | memory_local=融合结果, memory_cloud=云端回答（隐私隔离） |
| **上下文指示器** | Chat 环形组件，80% 变红提示新建 |
| **KB 独立会话** | 文库 Tab 拥有独立对话上下文，与 Chat 互不干扰 |
| **KB 对比开关** | 文库 Tab 可切换纯本地/对比模式 |

### 🔧 改进

| 改进 | 说明 |
|------|------|
| **Prompt 清理** | 删除 11 个死 prompt，优化 3 个活跃 prompt |
| **融合提示词** | 自然回答风格（非对比表），表格优先，去除幽灵引用 |
| **设置页重构** | 关于区域三分区（版本/描述/团队），移除系统信息 |
| **首次引导提示** | 添加云端 AI 配置提示（第三步） |
| **StreamRenderer** | 共享渲染器，Chat/KB 统一节流间隔 |

### 🐛 Bug 修复

| Bug | 修复 |
|-----|------|
| 云端配置覆盖 | HTML value→placeholder + _cloudConfigLoaded 防护 |
| SSE [DONE] 缺失 | 4 个错误出口补齐，防止前端 UI 锁死 |
| KB 气泡列表溢出 | CSS list-style-position 修正 |
| requirements.txt 版本漂移 | 11 个包对齐实际安装版本 |

### 🏗️ 架构

| 变更 | 说明 |
|------|------|
| 新增 `core/llm_scheduler.py` | LLM 请求优先级调度器 |
| 新增 `core/tagging_scheduler.py` | 文档打标异步调度 |
| 新增 `core/reformulate.py` | 问题重写模块 |
| 新增 `pipelines/compare_pipeline.py` | 对比融合管道 |
| 新增 `/api/kb/session/context` | KB 会话独立上下文 API |

---

## v0.9 Patch 2（2026-05）

### 🆕 新功能

| 功能 | 说明 |
|------|------|
| **CloudEngine** | 云端 AI 引擎，82 模型（2026-06），三级模糊匹配 |
| **AgentLoop** | FC 工具协议循环（search_web/fetch_url/search_kb/write_section） |
| **SearchEngine** | 本机直搜 Bing（httpx） |
| **CloudPipeline** | 独立管道，错误反馈 + done 事件保证 |
| **template_parser.py** | docx 标题层级 → 模板 JSON → Agent prompt |
| **友好错误反馈** | 11 种错误分类 → 中文提示 + 错误卡片 UI |

### 🆕 新增 API

| API | 说明 |
|-----|------|
| `/api/mode` | 获取当前 AI 模式 |
| `/api/mode/switch` | 切换离线/在线模式 |
| `/api/cloud/*` | 云端模型列表、配置管理 |
| `/api/search/*` | 网页搜索 |
| `/api/context/usage` | 上下文使用量 |
| `/api/backup/*` | 数据备份 |
| `/api/chats/{name}/rename` | 会话重命名 |

---

## v0.9 Patch 1（2026-05）

### 🆕 新功能（基础版）

| 功能 | 说明 |
|------|------|
| **本地 Chat** | 基于 Ollama + Qwen 的本地对话 |
| **知识库** | 文档上传 → 分块 → 向量化 → 语义检索 → AI 问答 |
| **录音纪要** | 语音录制 → Whisper 转写 → AI 摘要 |
| **文档生成** | 对话中一键生成 .docx 文档 |
| **深色模式** | CSS 变量驱动的主题切换 |
| **会话管理** | 多会话、导出、删除 |
| **Go Launcher** | Sidemate.exe 管理 ollama+FastAPI+浏览器生命周期 |
| **扩展包系统** | .sidemate 格式的可安装扩展包 |
| **离线部署** | 嵌入式 Python 3.14 + 全量依赖预装 |

### 🏗️ 架构基础

| 组件 | 说明 |
|------|------|
| FastAPI 后端 | 9 包 28 模块 + 5 Router |
| config.py | 集中配置管理 |
| Ollama 嵌入式 | Vulkan 加速，自动 fallback 到 CPU |
| ISS 打包 | Inno Setup 安装程序 |

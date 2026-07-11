# 变更日志

> 本文档记录 v0.9 版本的所有变更。完整详情请参阅仓库根目录 [CHANGELOG.md](../../../CHANGELOG.md)。

---

## v0.9.7 — llama.cpp 底座 + 模型下载页 + 开源

> 本次发布完成 AI 底座从 Ollama 到 **llama.cpp** 的迁移，统一模型下载入口，知识库问答引擎可选化，并宣布核心代码以 Apache-2.0 开源。

### 🆕 新功能

| 功能 | 说明 |
|------|------|
| **llama.cpp 底座** | 用 `llama-server.exe`（端口 11434）替换 Ollama；由 Go launcher 统一拉起并看门狗守护，崩溃自动重启（上限 3 次/小时） |
| **模型下载页** | 设置页新增「模型下载」：在线下载（ModelScope / HuggingFace 双源、可切换、断点续传）+ 从本地安装 `.sidemate` 包（SHA256 校验） |
| **Qwen3.5 三档 LLM** | 0.8B（~0.5GB）/ 2B（~1.3GB）/ 4B（~2.7GB）三档可选，适配 8GB~16GB+ 内存机器 |
| **KB 模型组合** | bge-m3（embedding，1024 维）+ bge-reranker-v2-m3（rerank），共 ~4.5GB |
| **KB 问答引擎可选** | `kb_ai_mode` 支持 `local`（默认，本地 Qwen）/ `cloud`（云端模型答 KB 题，仅发检索段落） |
| **动态 num_ctx** | llama-server 上下文窗口按对话长度动态调整，兼顾长上下文与显存占用 |

### 🔧 改进

| 改进 | 说明 |
|------|------|
| **嵌入式 Python 3.14** | 随程序内置，用户无需另装 Python |
| **Vulkan 加速** | llama-server 优先使用 Vulkan GPU 加速，自动 fallback 到 CPU |
| **看门狗守护** | Go launcher 监控 Python 后端（8976）与 llama-server（11434），崩溃自动重启 |

### 🗑️ 移除 / 清理 / 归档

| 项目 | 说明 |
|------|------|
| **Ollama 底座移除** | 不再依赖 ollama.exe，相关 MANAGED-EXTERNAL 状态机一并移除 |
| **recorder / Whisper 归档** | 录音纪要功能归档到 `归档/` 目录，不再出现在主界面，文档不再提及 |
| **扩展卡片清理** | 旧扩展包管理卡片清理，统一收敛到「设置 → 模型下载」与「知识库」 |

### 🔓 开源

- **核心代码以 Apache-2.0 协议开源**，托管于 GitHub 仓库
- **1.0.0 正式版发布后公开**仓库源码
- 模型文件遵循各自原作者许可（Qwen / bge 系列）

### 📚 文档更新

| 文档 | 说明 |
|------|------|
| 安装部署指南 | 重写为 llama.cpp 底座 + 模型下载页流程 |
| 常见问题 FAQ | 重写，覆盖模型下载 / 换源 / 三模式 / KB 引擎 / 报告 |
| 故障排查 | 重写，覆盖 llama-server 端口 / 模型加载 / Vulkan / 看门狗 |
| 隐私与安全说明 | 重写，覆盖三模式数据流向 / kb_ai_mode 边界 / 开源 |

---

## v0.9.6 — Indigo + ClearBox

> ✅ **本条目随 0.9.6 首发重发**（功能已在 0.9.6 完整发版）。
>
> **本次发布** 在 P6 基础上做「**视觉精修 + 透明度升级 + 用户引导**」三大方向。

### 🆕 新功能

| 功能 | 说明 |
|------|------|
| **新手指引系统（Onboarding）** | 两阶段设计：阶段1欢迎弹窗（按 AI/KB/云端状态智能分支）+ 阶段2交互式 TourGuide（5 步聚光引导） |
| **AI 洞察仪表盘 v2** | 环形图 SVG（单分类双弧画全圆）+ 分类图例 + 追问按钮 + 侧栏色点/图例/扇区三重联动 |
| **KB v2 Indigo 设计语言** | 渐变顶条 + 结构化 badge + 过渡标头 + pinned 卡片 + 双工具栏 sticky（浮层效果） |
| **CardRenderer 卡片式明盒** | 左色条（蓝=用户/紫=AI）+ 折叠统计 + AgentTimeline + KB 来源卡片 |
| **提纲编辑器** | 系统 UI 字体 + 编辑/预览切换（min-height 220px / 240px）+ 页面刷新后自动恢复 |
| **Onboarding 入口** | 设置页「关于」分组新增「重新查看新手指引」按钮（`resetOnboarding()`） |
| **AI 智能筛选占位** | 未生成聚类的文档统一归入「正在等待智能筛选」分类（虚线空心圆点） |
| **自定义滚动条** | Chat 区 `#D1D5DB`（indigo-300）/ KB 区 `#CFCDF0`（indigo-200）/ 浮动工具栏 Indigo 发光 |

### 🔧 架构重构

| 变更 | 说明 |
|------|------|
| **`core/step_model.py` 步骤流数据模型** | 用 `@dataclass Step` 替代 6+ 散落计时变量；统一 SSE 事件格式 |
| **`local_pipeline.py` 重构** | KB 块散乱 `yield` → Step 对象流；前端 AgentTimeline 可逐阶段展开 |
| **`memory_local` 摘要化** | 并行模式接入 session 压缩；local 与 cloud 记忆独立维护 |
| **输出预留动态化** | 前端消息区释放一半窗口给历史消息 |
| **LLM 洞察两轮化** | 第一轮合并 tag → 第二轮独立生成问题；不再用空 category 喂数据 |
| **批量私密对话框文案优化** | 「设为私密后，云端模型将无法读取该文档内容」等清晰提示 |

### 🐛 关键修复

| Bug | 修复 |
|-----|------|
| 温度失效 | 策略路由温度链路修复；模板 override 不再被默认覆盖 |
| 截断不同步 | `truncate` 事件同步前端正文；避免「内容被剪但 UI 没显示」 |
| 上下文计数器不准确 | 精确注入量 + 双重排除（已注入文档不再二次计入） |
| 并行 drain 丢事件 | 本地与云端事件流不再相互吞 |
| 页面刷新后提纲断 | 抽取共享函数 `_createDocConfirmBar()`；`renderMessages()` 末尾检测 `doc_phase:'outline'` 重建编辑器 |
| Onboarding 切 Tab 失效 | 用 `_tourFindTabBtn()` 替代失效的 `[data-tab]` 选择器（兼容 `onclick="switchTab(...)"` 形式） |
| Onboarding spotlight 位置偏差 | 用 box-shadow 扩散替代 `path(evenodd, ...)` 无效语法 |
| Onboarding 目标元素超出视口 | KB Tab 等可滚动 Tab 中先 `scrollIntoView({block:'center'})` 再定位 |
| Onboarding 箭头位置偏差 | 相对卡片左边偏移 clamp 到 [8, cardW-8] |
| Onboarding 卡片掉出页面 | 屏幕边缘小视口下卡片 clamp 到 [8, viewW-8] / [8, viewH-8] |
| Onboarding resetOnboarding 切 Tab 失败 | 兜底方案采用轮询等待 `#chatMode` offsetWidth > 0 |
| Insights 瞎编 | 第一轮 merge 吃到空 data 时 fallback 到 `doc.tags` |
| 追问空泛 | 嵌在 insight prompt 里 → 独立 LLM 调用 |
| 环形图单分类不闭合 | 100% 扇形 SVG 退化 → 双弧画全圆 |
| 批量私密对话撤销所有令牌 | 取消私密时主动撤销该文档所有未过期令牌（fail-safe） |
| search 令牌读不到私密 | 修复 `filter_private_docs` 缩小令牌作用域（search 不能读私密全文） |

### 🔒 安全加固（v0.9.6 已实现，本版本起完整集成）

> 17 项安全与质量修复，详情见 v0.9.6 CHANGELOG "2026-06-27 安全加固补充" 一节。

主要项：
- 路径穿越闭合（`deep_read` / `_chat_root` / backup）
- calculator AST 纯递归求值器（替代 eval）
- SSRF 防护（`fetch_url` 接入 `confirm_external_read` 钩子）
- XSS 收敛（DOMPurify 移除 `onclick`/`style` 死配置）
- 扩展包 SHA256 校验（删除 HMAC 摆设层）
- Ollama MANAGED-EXTERNAL 状态机
- CORS 严格默认 + 隐私安全 tab 开关
- 73 项安全单测

### 🗑️ 移除 / 清理

- **Inter Font @font-face 死代码**（28 行未生效注释）
- **faster-whisper 第三方许可声明**（已不再依赖）
- **LICENSE 升级到 v1.1**：邮箱更新为 `sidemate@deskware.cn`，版权方改为「Sidemate Team」

### 📚 新增文档

| 文档 | 路径 |
|------|------|
| 新手指引使用手册 | `docs/设计文档/用户文档/v0.9.6-新手指引使用手册.md` |
| 知识库权限与令牌说明 | `docs/设计文档/用户文档/v0.9.6-知识库权限与令牌.md` |
| AI 洞察仪表盘使用指南 | `docs/设计文档/用户文档/v0.9.6-AI洞察仪表盘使用指南.md` |
| 三模式切换使用指南 | `docs/设计文档/用户文档/v0.9.6-三模式切换使用指南.md`（覆盖旧 `并行模式使用指南.md`） |
| Action 模式使用手册 | `docs/设计文档/用户文档/v0.9.6-Action模式使用手册.md` |
| 设置页使用手册 | `docs/设计文档/用户文档/v0.9.6-设置页使用手册.md` |
| Onboarding 前端设计 | `docs/设计文档/架构与设计/v0.9.6-Onboarding前端设计.md` |
| AI 洞察仪表盘设计 | `docs/设计文档/架构与设计/v0.9.6-AI洞察仪表盘设计.md` |
| ClearBox 明盒设计 | `docs/设计文档/架构与设计/v0.9.6-ClearBox明盒设计.md` |
| step_model 设计 | `docs/设计文档/架构与设计/v0.9.6-step_model设计.md` |

### 📦 v0.9.6-final 终版补丁（main 分支累积）

> 0.9.6 tag 后的累积补丁，作为 v0.9.6 终版（tag = `v0.9.6-final`）发布。

#### 🆕 新功能（main 分支累积）

| 功能 | 说明 |
|------|------|
| **HTML 可视化报告** | 自包含 HTML 单文件（内联 marked.js + mermaid.js），浏览器打开即可看完整图文排版 + 可缩放拖拽图表 |
| **PPT 演示文稿** | 自包含 HTML 单文件（内联 reveal.js），方向键翻页 / F 全屏 / `?print-pdf` 导出 PDF |
| **mermaid 渲染失败自动修复** | `fix-mermaid` 流式接口 + 修复提示条；前端双位置提示 |
| **上下文管理优化** | 工具调用上限分层：search_web 3 次 / search_kb 5 次 / fetch_url 5 次；进度条 + 章节指示器 |
| **actionBar 加报告按钮** | AI 回答下方一键「生成可视化报告 / 生成 PPT」 |

#### 🔧 改进（main 分支累积）

| 改进 | 说明 |
|------|------|
| **marked 替换 regex 解析** | HTML 报告改用 marked.js v15 解析 LLM 内容；之前正则方案会把已有 HTML 标签错乱 |
| **mermaid 缩放交互** | 滚轮缩放（0.3x~3x）/ 鼠标拖拽 / 双击复位 / 工具栏按钮 |
| **mermaid 下载回退到 SVG** | PNG 下载有黑底+白边问题，统一回退到 SVG（XMLSerializer 序列化） |
| **HTML 报告 CSS 升级** | 暖灰背景 + 衬线标题 + 卡片/网格/统计/标签/进度条/时间线等组件库 |
| **PPT 字体修复** | reveal.js base font-size 42px → 用 `rem` 锁定 16px 避免 `em` 放大溢出 |
| **滚动条改 #BFDBFE** | 与用户消息背景同色系，更协调 |
| **引导词更白话** | 设置页引导文案重写，减少技术黑话 |

#### 🐛 关键修复（main 分支累积）

| Bug | 修复 |
|-----|------|
| HTML 报告 markdown 未渲染 | marked 集成 + `<script type="application/json">` 装 JSON + `</` 转义防 script 提前终止 |
| HTML 报告 `IndexError: no such group` | mermaid 围栏 regex 加 `()` 捕获组 |
| HTML 报告 mermaid 渲染失败 | 友好错误框（含源码），不自动修正（让 LLM 意识到语法错） |
| PPT 字体过大溢出页面 | reveal.js 用 `rem` 替代 `em` + `:root { font-size: 16px }` 锁定 |
| 上下文爆炸 400 | 历史 token 预算 12 万，从最新往回加，超预算停止 |
| AI 反复读同一文件触发 20 轮 | cheap 工具（read_workspace 等本地操作）不计 MAX_ROUNDS |
| AI 达 20 轮静默退出 | 强制收尾：注入「必须直接回答」指令 + 追加一轮纯对话 + 兜底文案 |
| 错误一律显示「操作异常」 | 后端 `_make_done_status` 透传 reason，前端按 reason 分类显示（文件不存在/路径不安全/操作受限） |
| PPT 下载文件名 `xxx.ppt.html` 难懂 | 显示成 `xxxPPT.html`（download 属性保留原文件名） |
| chat.js 缓存导致修复不生效 | 版本号 2.73 → 2.74 强制刷前端 |

#### 📚 新增文档（v0.9.6-final）

| 文档 | 路径 |
|------|------|
| 可视化报告使用指南 | `docs/设计文档/用户文档/v0.9.6-可视化报告使用指南.md` |
| PPT 演示文稿使用指南 | `docs/设计文档/用户文档/v0.9.6-PPT演示文稿使用指南.md` |
| 上下文管理与工具调用 | `docs/设计文档/用户文档/v0.9.6-上下文管理与工具调用.md` |
| HTML 报告与 PPT 架构 | `docs/设计文档/架构与设计/v0.9.6-架构-HTML报告与PPT.md` |
| Agent 循环设计 | `docs/设计文档/架构与设计/v0.9.6-Agent循环设计.md` |
| 常见问题 FAQ 更新（HTML 报告 / mermaid / 20 轮） | `docs/设计文档/用户文档/常见问题-FAQ.md` |
| 故障排查更新（图表渲染失败 / 上下文爆炸） | `docs/设计文档/用户文档/故障排查.md` |
| 用户手册更新（链接新文档） | `docs/设计文档/用户文档/用户手册.md` |

#### 🔄 测试（v0.9.6-final）

| 测试 | 路径 | 覆盖 |
|------|------|------|
| 24 项回归测试（d8fad96 之后） | `tests/test_regression_d8fad96.mjs` | HTML 报告 / PPT / mermaid / 工具硬限制 |
| 10 项边界测试（HTML 报告生成 + 浏览器渲染） | `tests/_self_test.mjs` + `tests/_gen_selftest.py` | 空内容 / 多 mermaid / `</script>` 字面 / 表格 / 代码块 / 50KB 长内容 / LLM class |

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

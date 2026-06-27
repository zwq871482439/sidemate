# 变更日志

> 本文档记录 v0.9 版本的所有变更。完整详情请参阅仓库根目录 [CHANGELOG.md](../../../CHANGELOG.md)。

---

## v0.9.7（计划中）— Indigo + ClearBox

> ⚠️ **本条目为待发版** —— v0.9.7 功能已在 main 分支实现，但**尚未发版**（当前 `config.py` 仍为 0.9.6）。功能列表仅供参考。
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
| 新手指引使用手册 | `docs/设计文档/用户文档/v0.9.7-新手指引使用手册.md` |
| 知识库权限与令牌说明 | `docs/设计文档/用户文档/v0.9.7-知识库权限与令牌.md` |
| AI 洞察仪表盘使用指南 | `docs/设计文档/用户文档/v0.9.7-AI洞察仪表盘使用指南.md` |
| 三模式切换使用指南 | `docs/设计文档/用户文档/v0.9.7-三模式切换使用指南.md`（覆盖旧 `并行模式使用指南.md`） |
| Action 模式使用手册 | `docs/设计文档/用户文档/v0.9.7-Action模式使用手册.md` |
| 设置页使用手册 | `docs/设计文档/用户文档/v0.9.7-设置页使用手册.md` |
| Onboarding 前端设计 | `docs/设计文档/架构与设计/v0.9.7-Onboarding前端设计.md` |
| AI 洞察仪表盘设计 | `docs/设计文档/架构与设计/v0.9.7-AI洞察仪表盘设计.md` |
| ClearBox 明盒设计 | `docs/设计文档/架构与设计/v0.9.7-ClearBox明盒设计.md` |
| step_model 设计 | `docs/设计文档/架构与设计/v0.9.7-step_model设计.md` |

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

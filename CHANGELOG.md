# 更新日志 — 桌伴 Sidemate

> 所有版本改动记录。遵循 [keepachangelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范。日期格式：YYYY-MM-DD

> 详细条目见 [docs/设计文档/用户文档/CHANGELOG.md](docs/设计文档/用户文档/CHANGELOG.md)

---

## [0.9.6] - 2026-06-28 — 0.9.6 首发重发（含 v0.9.6 之后 218 个 commit 的累积变更）

> ⚠️ **这是 0.9.6 首发版本**（Sidemate 历史上 0.9.6 的首次正式发版）。
>
> 此前 0.9.6 tag（2026-06-21）切出后未实际发版，本次重发累积 main 分支 218 commit 的全部变更。

> **0.9.6 原始 tag 在 2026-06-21 切出后未实际发版**（v0.9.6 → HEAD 之间累积 218 个 commit，main 分支一直跑的不是 0.9.6 tag 后的版本）。本次以 v0.9.6 tag 为起点，将 218 个 commit 的全部变更纳入 0.9.6 正式发版。

---

## [0.9.7] - 2026-07-12 — llama.cpp 底座 + 模型下载页 + 开源

> **v0.9.7 正式发版**。详细发布说明见 [docs/设计文档/用户文档/CHANGELOG.md](docs/设计文档/用户文档/CHANGELOG.md)
>
> 核心变更：llama.cpp 替换 Ollama 底座 / 模型下载页（LLM 三档 + KB 组合）/ KB 问答引擎可选 / 动态 num_ctx / Apache-2.0 开源 / 文档全面更新 / recorder 归档

> **下版本代号**：v0.9.7（Patch 7）。规划见 [docs/ROADMAP.md](docs/ROADMAP.md)「Patch 7」一节。
>
> **本节按"做到哪"实时更新**（最后更新 2026-07-09）。

### 已完成

- [x] **P7-4d 核心代码切 Apache-2.0**（2026-07-09）
  - `LICENSE` 文件从 EULA v1.2 重写为 Apache-2.0 全文 + Sidemate 补充说明（商标/数据合规/第三方依赖）
  - `README.md` 同步："LICENSE ← Apache-2.0 开源协议"
  - 之前的 EULA 表述是历史误差（应为开源），本次一并修正
  - 商业补充协议推迟到 0.9.8 启动时再写
  - GitHub 仓库地址等 1.0.0 正式发布时启用

- [x] **P7-4 底座替换（Ollama → llama.cpp）技术验证**（2026-07-09，`feature/p7-4-llama-cpp-spike` 分支）
  - 7 项验证全部通过：llama-server 启动 / OpenAI 兼容流式 / 多模型切换 / num_ctx 启动参数可控 / think 模式 / 工具调用 / 多轮上下文
  - 详细报告：`docs/验证报告.md`（4 个分支提交 7 项验证数据）
  - **未做**：主仓实际合并 / 替换 stream_engine.py（v0.9.7 主分支实施时做）

- [x] **发布页搭建**（2026-07-09）
  - 海外站 desk.deskware.cn + 国内站 deskware.cn 双站
  - 主页（Hero / 特性 / 对比表 / 4 类人 / 隐私 / 路线 / FAQ / 社区 / 订阅）
  - Wiki 11 页（产品介绍 / 模式详解 / 4 类人场景 / 其他 8 页骨架）
  - ⚠️ 之前主页有"录音/转写""开发者"等虚假宣传项，已全部清理

### 进行中

- [ ] **P7-1 动态 num_ctx**（Ollama 用 API 参数传，llama.cpp 用启动参数——等 P7-4 实施后按新底座机制做）
- [ ] **P7-2 / P7-3 ModelScope 下载模型**（Qwen3.5 / BGE / Reranker）
- [ ] **P7-4 主仓实际合并**（验证已通过，等正式实施）
- [ ] **品牌视觉精修**（Logo / 图标 / 字体 / 配色）
- [ ] **KB 全文预览（S3）+ 虚拟滚动**（分页方案 A）

### 已知问题（0.9.6 遗留，不阻塞 0.9.7）

- 并行模式答非所问
- 文档提纲确认栏时序竞态
- 云端模型"多嘴"吐槽用户

---

> **下版本代号**：v0.9.7（Patch 7：动态 num_ctx / ModelScope 下载 / llama.cpp 底座 / 视觉精修 / KB 全文预览 S3）。规划见 [docs/ROADMAP.md](docs/ROADMAP.md)「Patch 7」一节。
>
> **0.9.6 已知问题**（不阻塞本次发版，留待 0.9.7 修复）：并行模式答非所问 / 文档提纲确认栏时序竞态 / 云端模型"多嘴"吐槽用户。详见 [ROADMAP.md P7-4c](docs/ROADMAP.md)。

### 0.9.6 首发版新增（main 分支 0.9.6 tag → HEAD，218 commit 累积）

#### Added（新功能）

**新手指引（Onboarding）完整系统**
- 阶段1 欢迎弹窗：按 AI / KB / 云端配置状态智能分支（`showWelcome()` → `/api/onboard/status`）
- 阶段2 交互式 TourGuide：5 步聚光引导（自动 Tab 切换 + scrollIntoView 居中 + 目标元素圆角继承 + 箭头方向自适应 + box-shadow 扩散 spotlight）
- 设置页「关于」分组「重新查看新手指引」入口（`resetOnboarding()` → `location.reload()`）

**并行模式（双轨独立）**
- Chat Tab 第三档「并行」：本地 KB 检索 + 云端多轮对话双线并行；SSE 三通道输出（`local` / `cloud` / `merge`）
- 融合阶段：本地模型实时综合两路信息流式输出；本地与云端记忆独立维护（`memory_local` ≤200 字摘要 / `memory_cloud` 完整历史）
- 齿轮开关：允许云端模型生成检索关键词（`parallel_options.allow_cloud_keywords`）
- 阶段1 双列折叠 + 阶段2-3 合并流式；并行原文嵌入对应步骤下方

**AI 洞察仪表盘 v2（KB 顶部）**
- 环形图 SVG（单分类双弧画全圆 + 渐变）
- 分类图例 + 追问按钮 + 侧栏色点/图例/扇区三重联动
- 侧栏「AI 智能筛选」旋转动画 + 「正在等待智能筛选」虚线空心色点占位
- 归并 prompt 两轮化（先聚类归并 → 再基于聚类写洞察）；追问独立 LLM 调用
- 服务端持久化（移除前端 localStorage 缓存）

**文档生成（doc_action）升级**
- 提纲编辑器：系统 UI 字体 + 预览切换（min-height 220px / 240px）
- 标题层级可视化（基于 Markdown # 解析）
- 刷新后自动恢复提纲编辑栏（`renderMessages()` 末尾检测 `doc_phase:'outline'` 重建编辑器）
- Cancel 提纲死循环防护（cancel 时从 `currentMessages` 移除）

**云端 AI 用量统计**
- 真实 token 计数 + 7 天小时维度
- 柱状图分段显示（输入 / 输出 / 推理）+ 按模型进度条同样分段
- 汇总行新增输入/输出/推理总量维度
- 工具权限列表新增「允许内网访问」开关

**Agent 工具链**
- 新增 4 个工具（诊断 / 产物 / 权限体验优化）
- HTML 预览（iframe 沙箱）+ 可视化决策引导 prompt
- 工具限流提示明确为「本轮」（防模型编造「本日已达上限」）
- Mermaid 渲染 + 表格补全样式（边框 / padding / 斑马纹）

**流式渲染统一**
- CardRenderer 卡片式明盒渲染器（左色条 + AgentTimeline + KB 来源卡片 + 文档注入卡片）
- finalize 序列化 5 类缺失元素（thinking / 工具调用 / KB 引用 / 引用上标 / 推理轮次）
- renderHistory 重建（修复刷新后 Agent 搜索结果/阅读摘要显示成 HTML 源码）
- 列表模式重写（flexbox + 头像 absolute，修复内容挤压）

**模式切换体验**
- 鱼骨屏（多条细 shimmer 线错落流动）+ 阶段卡片持久化
- 切换骨架屏（actionBar + 模型 tag 灰色块呼吸动画）
- 模式切换时输入框鱼骨屏效果

**其他**
- KB v2 Indigo 全页面设计重构（渐变顶条 + 结构化 badge + 过渡标头 + pinned 卡片）
- 双工具栏 sticky（`.kb-toolbar` top:0 + `.kb-batch-toolbar` top:0 + margin-bottom:-36px 浮层效果）
- 推理详情默认折叠 + 全局滚动条样式统一
- 模式动态 placeholder（六组文案，按当前模式和 action 自动切换）
- 文库搜索结果显示来源（检索到几条、是哪些文档）
- KB 参考来源优化：引用上标交互 + 相关度分数条
- KB 检索健康度诊断面板（轻量版）
- 检索健康度诊断面板（轻量版）
- 引用上标点击跳工具链卡片
- 提纲编辑器升级（系统字体 + 预览切换）
- 段卡片持久化 + phase:started 事件补全
- 全文 KB 检索精度提升 + reformulate 精简
- 输出预留动态化（释放一半窗口给历史）
- 列表模式适配新卡片设计
- 结构化推理轮次（在线 Agent 每轮打包折叠）+ agent_think 透传

#### Changed（改进）

**架构重构（步骤流数据模型）**
- 新建 `core/step_model.py`：`@dataclass Step` 替代 6+ 散落计时变量
- `local_pipeline` 重构：KB 块散乱 `yield` → Step 对象流（`kb_retrieve` / `local_gen` / `merge`）
- `parallel_pipeline` Step 化：6 计时变量 → 4 个 Step 对象
- parallel drain 合并（修复丢事件 bug）+ `transform` 的 elapsed 透传
- 段 1 阶段C：memory_local 摘要化 + 并行模式接入 session 压缩

**Onboarding 重构**
- 引导文案重写（7 步精简为 5 步）
- startTour 改为轮询等待 `#chatMode` 可见后再开始（不再依赖固定延迟）
- Tab 切换追踪上个 Tab 避免重复 + 延迟 300ms + btn 有效性检查
- 空值防护 + load 事件替代 DOMContentLoaded + iconSvg 检查

**视觉精修**
- 品牌色统一 #1E3A5F：Tab 激活 / 输入聚焦 / 发送按钮
- SVG 图标体系：全部图标使用 SVG（锁/火/重复/图片/发送），零 emoji
- 用量柱状图分段配色：浅蓝/浅绿/浅紫柔和色
- 全局自定义滚动条：聊天区 `#D1D5DB` / KB 区 `#CFCDF0` / 浮动工具栏 Indigo 发光
- 品牌信息更新：反馈邮箱改 `sidemate@deskware.cn` + 版权方改「Sidemate Team」

**性能 / 质量**
- 并行模式统计改为词元维度
- 启用 aiofiles：文件上传流式写入（避免大文件全量读入内存）
- 优化停止逻辑防竞态（`_stopping` 标志 + 延迟 300ms 恢复 UI）
- KB 整理后自动刷新侧栏 + 未分类改「正在等待智能筛选」
- KB 洞察持久化 + 标签归并优化 + 侧栏自动刷新
- KB 卡片实时显示处理进度 + 刷新后重建处理队列
- KB chunking 进度细化（2% → 10% → 20% → 30%，避免一步跳到 30% 显得假）
- KB 删除/批量删除后自动触发洞察刷新
- 上下文窗口 fallback 修复（parallel mode 缺 local 时回退 8.2K）
- 文档 file_path 退化为文件名修复（`_refFilePath` 混合 doc_id/file.name 语义）
- 流式折叠和刷新后渲染统一（原文都嵌入对应步骤下方）

**死代码清理**
- `StallDetector` 类（46 行零调用）删除
- `search_engine` tag-strip 收敛（F14 ponytail 审计）
- 旧 Cloud Agent 系统 5 个死函数删除（Step2c）
- 旧 AgentTimeline 系统（-652 行）删除
- 取消 `cancel_doc_action` 死函数（B9）
- 恢复误删的 `showLicenseFile` 函数

#### Fixed（修复）

**P0 紧急修复**
- 删 `VERSION` 常量导致的 `ImportError`（FastAPI 全线 500）
- session 切换时消息堆积（009 消息堆到 007 下面）
- 文档生成崩溃 + 无下载按钮（#5-b / #5-d）+ KB 批量上传缺陷（#18-b / #18-c）

**新手指引（Onboarding）12 项 bug 修复**
- 引导覆层无高亮 / 不变暗
- KB 引导卡片掉出页面（clamp 到 [8, viewW-8] / [8, viewH-8]）
- 无法切换 tab + 覆层错位（用 `_tourFindTabBtn()` 替代失效的 `[data-tab]` 选择器）
- 移除 `offsetParent` 检查 + revert 三个有问题的 commit
- showWelcome 兜底 + load 事件延迟 500ms
- `resetOnboarding` 改为 `location.reload()` + 内置强制切 Tab
- `startTour` 改为轮询 + `Tab` 切换追踪
- spotlight 改用 box-shadow 扩散（替代 `path(evenodd, ...)` 无效语法）
- 高亮框精确定位（继承目标圆角 + 圆整坐标 + 箭头方向自适应）
- 空值防护 + load 事件替代 DOMContentLoaded
- 知识库步骤引导覆层无高亮/不变暗
- 模式切换鱼骨屏卡住：不覆盖 innerHTML 改为半透明+禁交互

**P6 终止响应 bug 系列修复**
- 终止后已有内容刷新丢失（`_persistContent` 追加终止标记）
- 终止后 UI 不恢复（`stopGeneration` 立即恢复 + catch 块加 try 保护）
- 手动终止覆盖已有正文（`appendStreamingMsg` → DOM 追加）
- 手动终止后消息未持久化
- 信号 aborted 竞态 + 隐式全局变量（计时不漏清/标记不丢）
- 计时器狂飙 + 双卡片 + 终止文案不统一
- 服务端终止保存：补 `_aborted` / `action_mode` / `speed` 字段

**KB 修复（24 项）**
- 切换 KB Tab 卡在「正在检测知识库状态」
- M5 SSE 连接泄漏 + M8 合并去重路径（删死代码路径 B）
- 资深审计 5 个严重/高危 bug 全量修复
- 实测过程信息丢失 + 计时器重置
- kb-summary 卡片宽度塌陷
- 暗色主题 + 注入防护 + 时间格式 + 错误提示
- AI 洞察持久化 + 标签归并优化 + 侧栏自动刷新
- 洞察卡片背景改为 `#fff`（避免和页面底色融为一体）
- AI 洞察数据源改服务端优先（localStorage 仅离线 fallback）
- localStorage 有 insight 但缺 cats 时 fallback 服务端
- qa.js 替换导致队列/上传/删除函数全部丢失
- 整体 C 方案：正常完成时原地固化，消除 renderMessages 重建闪烁
- 在线模式 agent_status 用后端 phase 字段判断完成态
- enrich 白名单补 card_data 和 parallel_texts（持久化丢失根因）
- 单分类环形图全圆修复 + 分类为空时改用 tags 归并
- 追问独立生成（嵌在 insight prompt 里 → 独立 LLM 调用）
- 追问按钮换行 + 双工具栏 sticky
- 批量私密文案优化
- kbRefreshAIOverview 从未被调用（页面加载时无洞察恢复）
- 自动整理改到轮询停止时触发（确保含标签全完成）
- 刷新后重建冲突文档的队列条目
- bump qa.js 缓存版本号 v2.70

**Ollama / 网络修复**
- 本地 ollama httpx 调用补 `trust_env=False`
- httpx 调用绕过系统代理（修复启用代理后扫不到模型/启动失败）

**渲染 / 上下文修复**
- 温度失效：策略路由温度链路断裂（code/math/creative 等策略真正调温）
- 截断同步：filter 截断后发 truncate 事件同步前端正文
- 上下文窗口 parallel fallback
- thinkingPhase 基于 task_type 的自动进入逻辑移除

**Agent / KB / Doc 修复**
- 推理轮次空状态丢失 + 多余空轮次显示
- 工具限流提示明确为「本轮」
- 刷新后 Agent 搜索结果/阅读摘要显示成 HTML 源码
- 文库搜索结果显示来源
- 文档提纲确认栏刷新后丢失
- doc 模式 KB 搜索失效 + KB 卡片图标/详情 + 跳转按钮定位 + 上传时间
- KB 文档引用多选 + FormData 静默失败
- KB 删除文档崩溃（`AttributeError`）+ KB 导入 Errno 22 / Errno 2
- 上传文件 API 路由与前端调用路径不对齐
- 引用文库按钮在文库未安装时仍然显示

**用量 / UI 修复**
- 用量柱状图不分段（axis 补齐 input/output/reasoning 字段）
- 用量按模型进度条的增长动画
- 设置 tab 滚动条恢复灰色（仅对话区用绿色）
- 引用上标流式完成后不可点击
- 死代码清理误删（`_resetParallelState` + 版本号 → 2.35）
- 诊断按钮无反应（qa.js 无 esc 函数导致 ReferenceError）
- 修复 chat.js 中气泡按钮：DOMContentLoaded 双保险 + 强制 applyMode + 版本号 2.36

**测试修复**
- 修复 sendBtn/模式按钮点击失败（用 dispatchEvent 绕过覆盖层）
- 测试启动时关闭新手欢迎覆层（定位 sendBtn 遮挡真因）
- 修复 _chat_root 校验过严导致回归测试失败
- 修复测试 14 failed → 0 failed（60 passed）

#### Security（安全加固 — 17 项）

> 本次 0.9.6 首发版 17 项安全与质量修复源自全栈代码 review（commit `45b1315` + `ba926df` + `36d2fe8` + `92b0bbe`）。详细说明见 v0.9.6 内嵌的「2026-06-27 安全加固补充」一节（下方）。

- 路径安全：`deep_read` / `_chat_root` 闭合路径穿越缺口；backup 排除覆盖 Windows 盘符 / UNC / null byte
- 代码注入：calculator 工具的 `eval` 替换为纯 AST 递归求值器（保留白名单前置守卫）
- SSRF 防护：`fetch_url` 接入 `confirm_external_read` 钩子（公网放行 / 私网按权限预设 / 云元数据端点硬拒绝，防 DNS rebinding + 逐跳校验）
- XSS 收敛：DOMPurify 移除 `onclick` / `style` 死配置 + 流式渲染净化
- 扩展包校验重做：删除 HMAC 摆设层（默认密钥源码公开，增益为零）→ SHA256 完整性校验（`_meta.json` 严格全覆盖，无则宽松兼容）；修复"无 checksum 文件跳过校验"漏洞
- 进程所有权：ollama 新增 MANAGED / EXTERNAL 状态，根治 watchdog 撞外部实例的状态混乱
- CORS 调试开关：默认严格模式，隐私安全 tab 加「允许第三方访问」开关
- 附件上传白名单收紧
- 质量：删除 shutdown 重复执行块 / 死代码；新增 **73 项安全单测**（`server/tests/test_security_pure.py`）
- ponytail 审计 F1-F9 零风险修复（净删死代码 / 合一 / 用 stdlib）
- 6 个 P0/P1 修复（KB 多项 bug + 体验/安全加固 + 修复 F5/G1/D4/E1 暗色主题+注入防护）

#### Removed（移除 / 清理）

- 纪要模块归档：`minutes.js` 归档为 `.archived`，index.html 移除对应 Tab
- 旧模式切换：tag-mode dropdown + modeConfirmModal 旧体系
- KB Tab 对话功能（`qa.js` 千行削减）：删除 `kbAsk` / `kbCompareMode` / `askCompare` / `kbStopGeneration` / `kbNewChat` 等全部对话功能
- `_compress_cloud_history` 函数（旧云端压缩）
- `token-estimator.estimateTotal` 方法
- 上下文清除按钮 DOM 残留
- 段 1 阶段C 前置清理（`StallDetector` / 旧 Cloud Agent / 旧 AgentTimeline）
- 纪要模块的 v0.9.5 旧 `recorder_pkg` 业务代码

#### Test（测试）

- 新增 Playwright UI 端到端测试脚本（`tests/test_ui_e2e.mjs` 1200+ 行，14 个场景）
- 重构测试 3 为模式矩阵：离线 / 在线 / 并行 × 各 Action
- 新增 4 个核心场景测试：停止 / KB 全流程 / 文档完整 / 历史渲染
- 增加响应质量断言（不只验证「有响应」，还验证「响应达标」）
- 修复模式切换时序 + 响应记录输出 + 矩阵修正
- 会话隔离 + 联网搜索 + 错误降级（覆盖度 70% → **88%**）
- 文档整理：docs 目录散落 23 → 6 个活跃文件 + 建归档索引（commit `80dd3a8`）
- 73 项安全单测（`server/tests/test_security_pure.py`）
- 完整手工测试清单（覆盖全部功能模块）
- deps_check 单元测试（覆盖 F10 可选依赖机制，+11 用例）
- 修复测试：14 failed → 0 failed（60 passed）

#### Docs（文档）

- 全线文档补全：架构更新 4 篇 + 新增文档 5 篇 + 故障排查 + 开发指南 + 空文件清理
- docs 目录整理：迁移 22 个 patch 4-6 时期过程文档 → 归档 + 建归档 README 索引
- 0.9.6 已知问题记入 P7 计划（P7-4c）
- 0.9.7 规划新增：KB 全文预览（S3）+ 虚拟滚动（分页 A）
- 功能配套文档（设置页 / 三模式 / Action / 新手引导 / 知识库权限 / AI 洞察仪表盘等 10 篇）已随 0.9.6 发布（原误标 v0.9.7，现已归位 0.9.6）

### 0.9.6 内嵌的「2026-06-27 安全加固补充」（同 release）

> 基于全栈代码 review 完成 17 项安全与质量修复。详见上方「Security」一节。

---

## [0.9.6] - 2026-06-21 — P6「前端统一化 + 三模式」

本次发布聚焦于**前端全面重构、模式系统统一化（离线/在线/并行）、知识库去对话化、ClearBox 明盒透明度**，并完成 P5 遗留的技术债清理。

> **2026-06-27 安全加固补充**：基于全栈代码 review 完成 17 项安全与质量修复。
> - **路径安全**：`deep_read`/`_chat_root` 闭合路径穿越缺口；backup 排除覆盖 Windows 盘符/UNC/null byte
> - **代码注入**：calculator 工具的 `eval` 替换为纯 AST 递归求值器（保留白名单前置守卫）
> - **SSRF 防护**：`fetch_url` 接入 `confirm_external_read` 钩子，公网放行/私网按权限预设/云元数据端点硬拒绝，防 DNS rebinding
> - **XSS 收敛**：DOMPurify 移除 `onclick`/`style` 死配置
> - **扩展包校验重做**：删除 HMAC 摆设层（默认密钥源码公开，增益为零），改为 SHA256 完整性校验（有 `_meta.json` 严格全覆盖，无则宽松兼容）；修复"无 checksum 文件跳过校验"漏洞
> - **进程所有权**：ollama 新增 MANAGED/EXTERNAL 状态，根治 watchdog 撞外部实例的状态混乱
> - **CORS 调试开关**：默认严格模式，隐私安全 tab 加「允许第三方访问」开关
> - **质量**：删除 shutdown 重复执行块/死代码；新增 73 项安全单测

> **P6 原始 release notes 归档**：原 2026-06-21 P6「前端统一化 + 三模式」段的 Added/Changed/Fixed/Removed 条目已整合到上方「0.9.6 首发重发」各小节，此处不再重复。

---

## [0.9.5] - 2026-06-21 — P5「稳定与整洁」

本次发布聚焦于**知识库链路健壮性、启动体验、上下文空间治理**三大方向，并完成一轮深度代码瘦身（移除误报率极高的 drift 检测与已被 bge-m3 sparse 取代的 BM25 索引）。

### Added（新功能）

- **启动界面动画**：Splash 窗口新增 4 段进度条 + 5 小节循环跳动动画，启动阶段可视化反馈更清晰
- **文档上传预检机制**：上传即计算真实 token 数，若超出当前上下文剩余空间则直接拒发（不再静默截断），从源头避免「文档发上去了一半」的脏数据
- **文档 Token 预检 UI**：引用文库文档时，指示器实时显示「文档 X.X K / Y.Y K · 空间充足 / 空间不足」，用户在发送前即可判断
- **KB 上传 SSE 实时进度推送**：文档导入过程分「分块完成 → 嵌入进度 → 完成」三阶段实时上报，长文档不再黑盒等待
- **summarize_history 工具**：新增 Function Calling 工具，云端 Agent 可自主决定何时压缩历史，替代原先硬编码的 >80% 触发逻辑
- **KB 文档引用多选**：文库文档引用支持逗号分隔多个 `doc_id`，一次对话可同时引用多篇文档
- **骨架屏**：AI 回复等待期间显示骨架屏动画，替代空白 spinner，等待体验更流畅
- **清除上下文**：新增「清除上下文」功能，保留消息历史但重置模型对前文的记忆，无需新建会话即可切换话题
- **消息样式切换**：对话支持气泡模式与列表模式切换，列表模式适合长文阅读
- **代码块折叠增强**：代码块新增语言标签、行数统计、一键折叠/展开，复制按钮集成到 header

### Changed（改进）

- **启动进度上报统一**：所有进度上报移入 `_lifespan` 生命周期，消除原先顶层 `_report_startup`(30%) 与 `_lifespan`(70%) 互相覆盖导致的进度倒退
- **文件上传强制 chat_id**：上传接口强制要求 `chat_id`，关闭 `cache/uploads` fallback 路径，避免孤儿文件堆积
- **云端 chat 模式注入 KB 文档**：云端对话模式注入知识库文档全文内容，与本地模式行为一致，修复「云端模式引用文档但模型看不到」的问题
- **云端上下文压缩策略**：上下文占用 >80% 时改为让模型自主调用 `summarize_history` 工具，替代原先硬编码的 `_compress_cloud_history` 强制压缩
- **Token 上限跟随模式切换**：本地模式 16K、云端模式按模型字典自动取值，切换模式时上下文圆环上限即时更新
- **batch_queue worker 收敛**：默认 worker 数从 2 改为 1，避免本地嵌入模型并发推理导致内存爆炸
- **紧凑布局**：Splash 窗口尺寸收敛为 440×320，`stageFontSize` 调整为 14px，视觉更紧凑
- **扩展包纯模型化**：扩展安装包不再捆绑 Python 依赖（wheels/），仅包含模型文件，安装更快

### Fixed（修复）

- **KB 删除文档崩溃**：修复删除文档时调用已被移除的 `_build_bm25_index` 导致 `AttributeError` 崩溃
- **KB 导入 Errno 22**：修复 `tempfile.mkstemp` 与 `np.savez_compressed` 在 Windows 上的文件句柄冲突（`Errno 22 Invalid argument`）
- **KB 导入 Errno 2**：修复 `kb` 目录不存在时 `_save_meta` 反复失败、向量不断堆积在内存导致 `Errno 2 No such file or directory`
- **KB 文档引用 FormData 静默失败**：修复云端 chat 模式下文档引用静默失效——`pendingFile` 是 `{path, source}` 对象，`FormData.append` 拒绝非标量值导致引用内容未发出
- **文档 file_path 退化为文件名**：修复 `_refFilePath` 混合 `doc_id` / `file.name` 语义，导致文档路径退化为纯文件名
- **启动进度倒退**：修复进度条从 70% 跳回 30% 的视觉倒退（双上报源冲突）
- **Token 计数器文档估算恒为 0**：修复 `pendingFile.size` 在 KB 引用场景缺失，导致文档 token 估算永远为 0
- 修复 launcher 启动时偶发的 cmd 黑框弹窗
- 修复 `countSitePackages` 在依赖较多时拖慢启动速度的问题
- 修复上传文件 API 路由与前端调用路径不对齐的问题
- 修复引用文库按钮在文库未安装时仍然显示的问题

### Removed（移除）

- **drift 话题漂移检测**：误报率 90%+，移除全部检测与干预逻辑
- **BM25 索引全部代码**：已被 bge-m3 sparse 通道取代，移除 `_build_bm25_index` 及相关构建/查询路径
- **BM25 三字段**：移除知识库元数据中的 `_bm25` / `_bm25_tokens` / `_bm25_chunk_ids` 三个字段
- **KB 依赖检查瘦身**：`_check_kb_dependencies` 移除对 `rank_bm25` / `jieba` 的存在性检查
- **`_compress_cloud_history` 函数**：无调用方，随 summarize_history 工具上线一并移除

### 已在 P6 完成（原 P5 计划内容）

- ~~drift_hint 全链路参数~~（P6 已彻底删除，~30 文件）
- ~~`_refFilePath` 混合语义~~（P6 已清理搬迁）
- ~~13 个未使用的 Python 包~~（P6 已标记清理）
- ~~系统诊断面板完整版~~（P6 设置页关于 Tab 已实现）
- ~~KB Tag 智能归并 + 分组显示~~（P6 知识库 Tab 已实现）
- ~~并行模式~~（P6 Chat Tab 第三档已上线）

### 计划在 P7 / P8 完成的功能

- 品牌视觉精修（Logo 全套变体 / 字体内嵌 / 安装包视觉）（P7）
- 桌伴云商业化（P8）

---

## [0.9.4] - 2026-04-15 — P4「双轨框架」

奠定「轨道 A 本地能力 + 轨道 B 私密融合」双轨架构，完成云端引擎接入与 Agent 工具协议。

### Added（新功能）

- **双轨框架**：确立轨道 A（纯本地能力）与轨道 B（私密融合）双轨并行架构
- **文库 Tab 独立对话窗口**：知识库拥有独立对话入口，与主聊天隔离
- **文档自动打标**：`TaggingScheduler` 异步打标，P2 优先级不阻塞主对话
- **LLMScheduler 优先级调度**：P0（chat / doc / KB）抢占 P2（打标），关键路径零延迟
- **ComparePipeline 双线对比模式**：本地 + 云端实时流式双线对比，横向比较模型输出
- **CloudEngine 云端 AI 引擎**：接入 82 种主流大模型（GPT-4o、Claude 3.5、Gemini、DeepSeek 等），三级模糊匹配模型名
- **AgentLoop FC 工具协议**：支持 Function Calling 多轮工具调用（`search_web` / `fetch_url` / `search_kb`），Agent 可自主规划多步任务
- **template_parser**：docx 标题层级 → 模板 JSON → Agent prompt，文档生成格式更精准
- **友好错误反馈**：11 种错误分类（网络 / 认证 / 限流 / 服务端等）+ 中文友好提示 + 错误卡片 UI
- **Session Workspace**：每个 chat 下独立 `workspace/` 子目录，文件隔离
- **文档状态化**：`set_doc_status` 工具 + `doc_complete` 派生事件，文档生成全流程可追踪
- **UI 状态机驱动**：`DocProgressTracker` + 4 个 SSE 事件驱动文档进度 UI
- **SearchEngine Bing 直搜**：内置 Bing 网页搜索，对话中可直接联网

### Changed（改进）

- **SSE 管道架构**：重构流式响应为 `local_pipeline` / `cloud_pipeline` 双管线，职责清晰可扩展
- **双线记忆**：本地与云端模式各自维护独立会话缓存，切换模式时记忆无缝衔接
- **上下文指示器**：对话区新增上下文圆环，实时展示当前会话记忆占用百分比

### Fixed（修复）

- 修复本地模型搜索成瘾（反复调用检索工具）的问题
- 修复长文档生成偶发丢失段落的问题，引入 chunk 分段处理与续写机制
- 修复流式回复续写内容不可见的问题（SSE buffer 刷新策略修正）
- 修复文档撰写进度条不显示的问题

---

*更早版本的改动记录已归档。如有疑问，请联系 support@sidemate.app*

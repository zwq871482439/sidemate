# 更新日志 — 桌伴 Sidemate

> 所有版本改动记录。遵循 [keepachangelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范。日期格式：YYYY-MM-DD

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
- **bge-m3 混合检索**：知识库检索升级为 dense + sparse 双通道，中文文档检索准确率显著提升
- **令牌授权系统**：文库文档支持 `full` / `search` / `none` 三级权限控制，精细管理文档能否发送至云端 API
- **SQLite 批量队列**：LLM 调用引入持久化排队机制，高并发场景下请求不丢失，支持取消排队任务
- **Go 看门狗 + GPU 分流**：新增 Go 编译的 watchdog 进程守护，GPU 自动分流优化显存占用
- **品牌图标全套**：应用图标、Splash 启动画面、favicon 全面统一为深蓝 + 橙黄品牌色系
- **诊断面板**：设置页新增系统诊断报告导出功能，一键收集环境信息便于问题排查
- **隐私声明**：新增完整的隐私声明文档（`docs/PRIVACY.md`），明确数据存储位置与外部通信场景

### Changed（改进）

- **启动进度上报统一**：所有进度上报移入 `_lifespan` 生命周期，消除原先顶层 `_report_startup`(30%) 与 `_lifespan`(70%) 互相覆盖导致的进度倒退
- **文件上传强制 chat_id**：上传接口强制要求 `chat_id`，关闭 `cache/uploads` fallback 路径，避免孤儿文件堆积
- **云端 chat 模式注入 KB 文档**：云端对话模式注入知识库文档全文内容，与本地模式行为一致，修复「云端模式引用文档但模型看不到」的问题
- **云端上下文压缩策略**：上下文占用 >80% 时改为让模型自主调用 `summarize_history` 工具，替代原先硬编码的 `_compress_cloud_history` 强制压缩
- **Token 上限跟随模式切换**：本地模式 16K、云端模式按模型字典自动取值，切换模式时上下文圆环上限即时更新
- **batch_queue worker 收敛**：默认 worker 数从 2 改为 1，避免本地嵌入模型并发推理导致内存爆炸
- **紧凑布局**：Splash 窗口尺寸收敛为 440×320，`stageFontSize` 调整为 14px，视觉更紧凑
- **版本号单一来源**：全局版本号统一从 `config.py` 读取，消除多处硬编码不一致
- **setup.iss 轻量化**：Inno Setup 安装包体积优化，移除冗余依赖打包
- **扩展包纯模型化**：扩展安装包不再捆绑 Python 依赖，仅包含模型文件，安装更快

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

### Deprecated（标记废弃，计划 P6 移除）

- **drift_hint 全链路参数**：函数签名中保留参数占位但不传非空值，调用方无需改动，P6 将彻底删除
- **`_refFilePath` 混合语义**：当前兼容保留，P6 将拆分为独立的 `doc_id` 引用与 `file_path` 本地路径
- **13 个未使用的 Python 包**：`jieba` / `rank_bm25` / `av` / `onnxruntime` / `mdurl` / `click` 等将在 P6 从 `requirements.txt` 清理

### 已知问题

- Inter 字体 woff2 文件尚未包含在安装包中，当前 UI 使用系统默认字体（计划 v0.9.6 补充）
- 部分 GPU 型号上 watchdog 分流策略可能不够精准，遇到此问题可导出诊断报告反馈

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

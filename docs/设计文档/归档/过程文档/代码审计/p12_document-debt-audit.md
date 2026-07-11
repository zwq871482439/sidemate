# 桌伴 Sidemate Patch 12 — 文档债务审计报告

> 审计日期: 2026-05-29
> 代码路径: `C:\tmp\_local_ai_patch12\`
> 文档路径: `C:\tmp\桌伴-设计文档\`
> 代码规模: ~17,500 行 Python + ~6,000 行前端 (HTML/JS/CSS)
> 文档规模: ~100 个 .md 文件（含 ~60 个 old_ 归档文件）

---

## 一、文档缺口清单

按优先级排列。P0 = 阻塞开发协作，P1 = 显著影响效率，P2 = 有则更好，P3 = 锦上添花。

| 优先级 | 文档名称 | 文档描述 | 涉及模块 | 建议存放目录 |
|--------|---------|----------|---------|-------------|
| **P0** | `p12_FRONTEND_ARCHITECTURE.md` | 前端架构总览：Tab 结构、JS 模块依赖关系（chat→api/errors/utils）、全局变量、SSE 事件处理流程、UI 状态机 | `index.html`, `static/js/*` | 架构设计/ |
| **P0** | `p12_CONFIG_REFERENCE.md` | config.py 全量配置项参考：每个 key 的类型、默认值、作用、影响范围；settings.json 字段说明 | `config.py`, `settings.json` | API与接口/ |
| **P0** | `p12_PROMPT_ENGINEERING.md` | Prompt 系统设计文档：9 种策略配置(STRATEGY_CONFIG)、KB prompt、think_mode 控制、场景 prompt 的设计意图和调参指南 | `prompts.py`, `core/prompt_builder.py` | 架构设计/ |
| **P1** | `p12_INTELLIGENCE_DESIGN.md` | 智能模块设计：任务分类器(task_classifier)决策树、Action 路由机制、响应过滤器(1032行)的重复检测+前缀累积清理算法、停滞检测器阈值 | `intelligence/*` | 架构设计/ |
| **P1** | `p12_SESSION_MANAGEMENT.md` | 会话管理设计：聊天文件 CRUD、上下文缓存策略(压缩触发条件)、自动续写检测机制、chat JSON v2 格式详解 | `session/*` | 架构设计/ |
| **P1** | `p12_KNOWLEDGE_PIPELINE.md` | 知识库完整管线：文件提取→分块(chunker+orchestrator)→嵌入(embedding_engine)→精排(reranker_engine)→内存预算管理(memory_manager)；检索流程、向量存储格式 | `knowledge/*`, `knowledge_base.py` | 架构设计/ |
| **P1** | `p12_STREAM_ENGINE.md` | 流式生成引擎设计：token 流处理、think 标签解析(6种状态分支)、SSE 事件类型映射、GenerateQueue 排队机制、CancellationToken 取消传播 | `core/stream_engine.py`, `core/generate_queue.py`, `core/think_processor.py` | 架构设计/ |
| **P1** | `p12_RECORDER_DESIGN.md` | 录音纪要系统设计：录音会话管理、Whisper 转写流程、纪要生成、VAD 静音检测、音频播放、前端轮询机制（1147行的大模块无文档） | `recorder_pkg/recorder_manager.py`, `static/js/minutes.js` | 架构设计/ |
| **P1** | `p12_SIDEMATE_PACKAGE_SPEC.md` | .sidemate 扩展包规范：包结构、HMAC 签名校验流程、安装/卸载管线、安全策略 | `validators/sidemate_validator.py`, `routers/settings.py` | API与接口/ |
| **P2** | `p12_DEPLOYMENT_GUIDE.md` | 部署指南：setup.bat 流程、preflight.py 检查项、模型文件放置、离线环境要求、start.bat 启动参数 | `setup.bat`, `start.bat`, `preflight.py` | 规划与记录/ |
| **P2** | `p12_FILE_PROCESSING.md` | 文件处理模块：三级文件提取策略(file_extractor)、Word/PDF/Excel 读取(doc_reader)、文档写入(doc_writer)支持格式 | `files/*` | 架构设计/ |
| **P2** | `p12_SKILL_FILEOPS_SPEC.md` | 文件操作技能规范：读写分离安全策略、沙盒机制、路径校验、大小限制、外部读确认机制 | `skill_fileops.py` | API与接口/ |
| **P2** | `p12_FRONTEND_API_BINDING.md` | 前端↔后端 API 绑定表：每个 JS 模块调用的 API 端点、请求参数、SSE 事件→UI 更新映射 | `static/js/core/api.js`, 所有 JS | API与接口/ |
| **P2** | `p12_MODEL_MANAGER.md` | 模型管理器设计：NPU/GPU/CPU 三模式切换、模型加载/卸载生命周期、内存预算检查、配置热更新 | `core/model_manager.py` | 架构设计/ |
| **P3** | `p12_CONTEXT_COMPRESSOR.md` | 上下文压缩器设计：离线压缩算法、压缩触发条件、摘要生成策略 | `common/context_compressor.py` | 架构设计/ |
| **P3** | `p12_PACKAGER_SPEC.md` | 打包工具说明：packager.py 的用途和使用方式 | `packager.py` | 规划与记录/ |
| **P3** | `p12_TEST_STRATEGY.md` | 测试策略文档：test_smoke.py 覆盖的端点、如何运行、已知问题 | `test_smoke.py` | 规划与记录/ |
| **P3** | `p12_CODING_CONVENTIONS.md` | 代码规范：命名约定（模块/函数/变量）、import 规则（何时用动态导入）、日志规范 | 全局 | 架构设计/ |

---

## 二、过时文档清单

| 文档 | 问题 | 严重程度 | 建议 |
|------|------|---------|------|
| `架构设计/p10_README.md` | Patch 10 的 README，已被 p12_README.md 取代，但仍在目录中，容易误读 | 中 | 移入 `old_` 前缀或归档子目录 |
| `架构设计/p10_arch-redesign-proposal.md` | Patch 10 的架构重设计提案，拆分方案已实施完毕 | 低 | 归档 |
| `架构设计/old_ARCHITECTURE.md` | 旧架构文档，与当前 9 包结构完全不匹配 | 中 | 已有 old_ 前缀，确认即可 |
| `架构设计/old_FRONTEND_ARCHITECTURE.md` | 旧前端架构，与当前 index.html+7JS+1CSS 结构可能差距大 | 高 | 需验证内容是否还有参考价值 |
| `架构设计/old_FRONTEND_PRD.md` | 旧前端 PRD，可能已大幅偏离实际功能 | 高 | 需验证 |
| `API与接口/p12_API_CONTRACT.md` | 虽是 p12 文档，但需验证 72 个端点是否与代码完全一致（审计发现 test_smoke 引用了已删除端点） | 中 | 需要交叉验证 |
| `迁移与审计/p12_MIGRATION_CHECKLIST.md` | 记录了迁移状态，但根目录旧文件仍未清理，状态描述可能给人"已完成"的误导 | 中 | 更新为当前实际状态 |
| `迁移与审计/p12-code-audit-report.md` | 审计发现的问题，但修复计划(p12-fix-plan.md)状态是"待执行" | 低 | 跟踪修复进度 |
| `迁移与审计/p12-think-pipeline-redesign.md` | 状态标记为"✅ 已全部实施"，需确认代码是否确实匹配 | 低 | 可信，但需最终确认 |
| `科普与分析/old_*.md` (5个) | 历史评测文档，技术结论可能已过时（模型版本、benchmarks 更新） | 低 | 归档即可 |
| `规划与记录/changelogs_old/` (20+个) | Patch 12 不应有 v0.1~v0.8 的 old changelogs | 低 | 仅保留参考 |

---

## 三、现有 p12 文档质量评估

### 评分标准
- 覆盖度: 文档对实际代码的覆盖比例
- 准确性: 文档描述与代码实现的一致性
- 时效性: 是否反映最新代码状态

| 文档 | 覆盖度 | 准确性 | 时效性 | 评价 |
|------|--------|--------|--------|------|
| `p12_README.md` | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | **优秀**。9包28模块列表与代码完全吻合，行数精确，目录结构正确。唯一缺失：`skill_fileops.py`(402行)和`recorder_pkg/recorder_manager.py`的前端交互未展开 |
| `p12_IMPORT_MAP.md` | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | **良好**。跨包依赖映射准确，但只覆盖了 routers/ 的详细 import，其余包的跨包依赖未展开（如 core/model_manager.py 导入 knowledge_base） |
| `p12_DEPENDENCY_RULES.md` | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | **良好**。包间依赖矩阵清晰，规则描述准确。缺少对根目录残留文件的依赖说明 |
| `p12_DATA_ARCHITECTURE.md` | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | **优秀**。数据目录结构、JSON 格式、KB 元信息格式与代码完全一致 |
| `p12_API_CONTRACT.md` | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | **良好**。72个端点总览完整，SSE 事件类型详尽。但需与代码交叉验证（test_smoke 发现了已删除端点） |
| `p12_MIGRATION_CHECKLIST.md` | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | **良好**。迁移对应关系准确，但实际根目录旧文件仍未删除，"已完成"状态有误导 |
| `p12-code-audit-report.md` | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | **优秀**。P0/P1/P2 问题定位精确到行号，修复建议可执行 |
| `p12-think-pipeline-redesign.md` | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | **优秀**。管线全链路追踪到具体行号，Phase 1+2 标记已实施 |

### 总结

p12 核心文档（5个）质量**显著高于**项目平均水平。架构类文档覆盖了后端 Python 代码约 70% 的设计意图，但存在系统性盲区：

1. **前端代码 0% 覆盖** — 6,049 行前端代码无任何对应文档
2. **根目录独立文件覆盖不足** — `skill_fileops.py`(402行)、`prompts.py`(376行)、`packager.py`(122行)无独立文档
3. **模块内部算法文档缺失** — `response_filter.py`(1032行)、`recorder_manager.py`(1147行) 等大模块的内部设计未展开

---

## 四、前端文档缺口分析

### 前端代码规模

| 文件 | 行数 | 功能概述 |
|------|------|---------|
| `index.html` | 747 | 单页应用骨架：Tab 导航(对话/文库/纪要/设置)、模态框、UI 组件 |
| `static/js/chat.js` | 1,288 | **最大 JS 文件**：消息发送、SSE 流式解析、Session 管理、Pipeline 控制 |
| `static/js/minutes.js` | 1,124 | 录音纪要 Tab：录音、Whisper 转写轮询、纠错、VAD 静音检测、音频播放 |
| `static/js/settings.js` | 966 | 设置 Tab：模型切换、设备选择、扩展管理、配置面板 |
| `static/js/qa.js` | 717 | 文库 QA Tab：知识库对话、来源展示 |
| `static/js/core/api.js` | 43 | API 请求封装（fetch 封装） |
| `static/js/core/errors.js` | 343 | 错误处理框架 |
| `static/js/core/utils.js` | 323 | 工具函数（Markdown 渲染、代码高亮、KaTeX 公式） |
| `static/js/skills.js` | 2 | 占位文件（几乎为空） |
| `static/css/main.css` | 496 | 全部样式 |
| **总计** | **6,049** | |

### 缺失的前端文档

| 文档名称 | 描述 | 优先级 |
|---------|------|--------|
| 前端架构总览 | Tab 切换机制、JS 模块加载顺序、全局变量命名空间、chat.js↔settings.js↔minutes.js 的交叉调用 | P0 |
| SSE 事件流文档 | 14 种 SSE 事件类型到 UI 更新的完整映射（token→渲染、think→折叠、done→统计等） | P0 |
| 前端状态管理 | 全局变量清单（generating、currentChatFile 等）、状态锁机制、按钮禁用/恢复逻辑 | P1 |
| Markdown 渲染管线 | utils.js 中的 Markdown→HTML 渲染流程、代码高亮集成、KaTeX 公式处理、XSS 防护 | P2 |
| 录音模块设计 | VAD 静音检测参数(800ms/0.015阈值)、WebRTC 录音流程、转写进度轮询机制 | P1 |
| 前端错误处理 | errors.js 的错误分类、Toast 通知机制、离线检测与重连逻辑 | P2 |

---

## 五、优先建议 Top 5

### 1. 补写 `p12_FRONTEND_ARCHITECTURE.md`（P0，最高优先级）

**理由**: 6,049 行前端代码零文档覆盖。chat.js(1288行)和 minutes.js(1124行) 是除 recorder_manager.py 外最复杂的模块，且缺乏模块间依赖图。任何前端改动都需要反复读代码理解全局。

**应包含**:
- JS 模块依赖 DAG（chat→api/errors/utils, minutes→api/errors/utils, settings→chat）
- Tab 切换机制与状态互斥
- SSE 14 种事件→UI 更新映射表
- 全局变量清单与所有权

### 2. 补写 `p12_PROMPT_ENGINEERING.md`（P0）

**理由**: `prompts.py` 是项目调优的核心——9 种策略配置(STRATEGY_CONFIG)直接决定 LLM 行为，但当前只有代码注释解释每种策略。没有设计文档意味着：
- 调参缺乏决策依据
- 新人无法理解策略间差异
- think_mode 与策略的配合机制不透明

**应包含**: 每种策略的适用场景、think_mode 控制逻辑、Prompt 版本变更记录解读、调参指南

### 3. 补写 `p12_CONFIG_REFERENCE.md`（P0）

**理由**: `config.py` 是唯一真相源(246行)，定义了所有可调参数，但缺少文档。用户和开发者需要翻代码才能知道有哪些参数可以调整。审计还发现了 HMAC 硬编码安全问题，配置文档可以显式标注安全相关参数。

**应包含**: 每个 DEFAULTS key 的类型/默认值/作用/影响模块、settings.json 完整字段说明、环境变量清单

### 4. 补写 `p12_RECORDER_DESIGN.md`（P1）

**理由**: `recorder_manager.py`(1147行) 是全项目第二大 Python 文件，配合 `minutes.js`(1124行) 构成完整的录音纪要系统。这两个文件加起来 2,271 行，涉及 Whisper 转写、VAD 检测、音频录制/播放、会话管理等复杂流程，但完全没有设计文档。

### 5. 更新 `p12_MIGRATION_CHECKLIST.md` 反映真实状态（P1）

**理由**: 当前文档给读者的印象是"迁移已完成"，但根目录仍有 15 个旧文件（与包内文件完全重复）未清理。应更新文档标注实际状态，并关联 `p12-fix-plan.md` 的执行进度。这是"文档过时导致误导"的典型案例。

---

## 附录：文档债务量化总结

| 维度 | 数值 |
|------|------|
| Python 代码总行数 | ~17,500 行 |
| 前端代码总行数 | ~6,049 行 |
| 代码总规模 | ~23,549 行 |
| 现有 p12 活跃文档数 | 8 个 |
| 缺失文档数（本报告识别） | 18 个 |
| P0 级缺失文档 | 3 个 |
| P1 级缺失文档 | 5 个 |
| 可能过时的文档 | 11 个 |
| 前端文档覆盖率 | 0% |
| 后端文档覆盖率 | ~70%（模块级）/ ~30%（算法级） |

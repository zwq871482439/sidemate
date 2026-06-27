# 产品路线图（Roadmap）

> 合并自：`P7-PLAN.md` + `PATCH7-BRAINSTORM.md` + `PATCH8-BRAINSTORM.md` + `ROADMAP-FEATURES.md`（2026-06-26 整理）
> 本文是跨版本规划的唯一入口，按版本组织。源文件已归档至 git 历史。

---

## Patch 7（0.9.7）

P7 两大主线：**底层能力升级** + **品牌视觉精修**。

### 主线一：底层能力升级

#### P7-1: 动态 num_ctx（启动时自动推荐）

不再硬编码上下文窗口，启动时检测硬件自动推荐最优值。

| 硬件 | num_ctx |
|------|---------|
| 独立 GPU ≥ 8GB | 32K |
| 独立 GPU ≥ 4GB | 16K |
| CPU / 集成显卡 | 8K |
| 内存 < 8GB | 4K |

实现：Go Launcher 启动时检测 GPU VRAM + 可用 RAM → 写入 Ollama Modelfile → `ollama create` → 启动；设置页加滑块（显示推荐值，可调）。

#### P7-2: ModelScope 下载 Qwen3.5 系列模型

从 ModelScope 下载 Qwen3.5-1.5B/4B/7B/14B GGUF，自动安装到 Ollama，支持多模型切换。
设置页「模型管理」新增"下载模型"入口 + 进度 + 自动 `ollama create` + 下拉切换。

#### P7-3: ModelScope 下载 BGE + Reranker

从 ModelScope 下载嵌入模型和重排序模型，支持多类型切换。
- BGE: bge-m3 / bge-large-zh-v1.5 / bge-small-zh-v1.5
- Reranker: bge-reranker-v2-m3 / bge-reranker-large
- 一键下载 + 自动配置 + 下拉切换

#### P7-4: Ollama 底座 → llama.cpp 底座

用 llama.cpp 替代 Ollama，减少中间层开销，直接控制推理参数。
动机：性能（去掉 HTTP 中转）+ 可控性（num_ctx/threads/gpu_layers）+ 部署（单一进程）。
范围：Go Launcher 嵌入 llama.cpp CGO 绑定；支持 GGUF 直接加载；保留 Ollama 向后兼容。

#### P7-4b: 文档审计日志（KB Document Access Audit Log）

> 来源：P6 打磨阶段用户提出（2026-06-26）

**目标**：每个 KB 文档记录完整的访问历史，点开「被搜索 N 次」可查看明细（时间/访问者/查询词/命中片段），不再只是一个干巴巴的数字。

**审计日志字段**（每条记录）：

| 字段 | 说明 | 示例 |
|------|------|------|
| `timestamp` | 访问时间 | 2026-06-26 09:47:23 |
| `access_type` | 访问方式 | `kb_search` / `manual_cite` / `agent_read` |
| `actor` | 访问者 | `local` / `cloud` / `user` |
| `query` | 触发查询 | "静养神 专注力训练 日常习惯" |
| `matched_text` | 命中片段 | "一、静身 久坐不如小坐..." |
| `reranker_score` | 相关性评分 | 0.8409 |

**用户原始诉求**（原话）：
> "给每个文档搞个审计日志，xx日期xx时间，被本地/在线模型访问了 xxx段落 or 手动引用这样的一个详细记录"

**实现拆解**：
1. 后端数据层：`search.py:544`（当前 `doc.hit_count += 1` 处）扩展为同时写日志；存储方案 A（每文档 audit_log.json）/ B（统一 kb_audit.jsonl）二选一
2. 后端接口：`GET /api/kb/documents/{doc_id}/audit_log`（+ 可选导出）
3. 前端：KB 卡片「被搜索 N 次」绑点击 → 时间线面板（访问者图标：🖥本地/☁在线/✋手动）
4. 存储治理：每文档保留最近 N 条（如 200）或 N 天（如 90），FIFO 裁剪；设置页加「清空审计日志」

**范围边界**：不做跨文档统计报表（P8）、不做历史全文搜索。
**关联**：热力图圆点（冷热概览）保留，审计日志是「点进去看详情」，互补不替代。

### P7 技术债：代码整洁项（F11 / F12）

> 来源：P6 审计（AUDIT-ponytail.md D1/D2），逐行对比后判定 P6 不改（发版前不承担回归风险），移入 P7。
> 共同特征：纯代码整洁，无功能/性能收益，需写测试覆盖行为差异才能安全合并。

**F11: 合并 cache_cleanup + log_cleanup**
- 现状：`core/cache_cleanup.py` 与 `core/log_cleanup.py` 各实现一份 walk-mtime-remove
- 3 个行为差异：遍历方式（walk 递归 vs listdir 平铺）、默认天数（7 vs 30）、日志粒度（汇总 vs 逐条）
- ⚠️ 风险：log 目录若意外有子目录，递归删可能误删
- 方案：抽 `_cleanup_old_files(path, max_age_days, recursive, log_each)`，前置条件：写测试覆盖递归/平铺/子目录不误删

**F12: 合并两份 atomic_write_json**
- 现状：`session_migrator.py:152` 的 `_atomic_write_json` 与 `doc_session.py:318` 的 `_save_completed` 各一份
- 差异：fsync 异常处理（抛 vs 容错）、目录创建（无 vs makedirs）
- 方案：抽到 `common/utils.py` 的 `atomic_write_json(path, data, makedirs, fsync_safe)`

### 主线二：品牌视觉精修

> 纯视觉/品牌层精修，不涉及功能改动。把"够用但粗糙"的素材升级到"专业级"。

#### P7-5: Logo 精修
- 矢量重做（现有 logo.svg 是 AI 草稿）
- 五种变体：横版/竖版/单色/反白/图标-only
- 使用规范文档（间距/最小尺寸/不可用场景）

#### P7-6: 图标系统
- favicon 全套：16/32/48/180/192/512
- 应用图标：.ico（Windows）
- 内部图标统一风格（lucide/heroicons 选一套）

#### P7-7: Splash 启动画面精修
- 背景图（设计师插画/几何图形）+ Logo 进入动画 + 进度条精修 + 字体替换

#### P7-8: 字体系统

| 用途 | 候选 |
|------|------|
| 中文 | 思源黑体 / 阿里巴巴普惠体 / 系统微软雅黑 |
| 英文/数字 | Inter / SF Pro / Roboto |
| 等宽代码 | JetBrains Mono / Fira Code |

策略：标题用系统字体，代码块用 Web Font（JetBrains Mono woff2 ~50KB）。

#### P7-9: 配色系统规范化
- 主色调校准（当前蓝色 #185FA5 偏冷，可考虑更暖）
- 暗色模式精修（当前反色对比度不够）
- 状态色统一（success/warning/error/info）

#### P7-10: 安装包视觉
- ISS 安装界面自定义 banner + 安装/卸载向导图标替换

#### P7-11: 官网/营销物料（可选，配合商业化）
- 官网首页 + 下载页 + 文档站 + 社交媒体 banner

### P7 功能待办（新增）

#### 私密文档授权系统（令牌管理 UI 化）

**背景**：P5/P6 已实现后端令牌授权系统（`core/access_token.py` + `routers/kb.py` 令牌端点），但前端无触发入口，处于休眠状态。0.9.6 已将侧栏「令牌管理」区块改造为「私密文档清单」（含义 X：展示有哪些私密文档）。

**0.9.7 目标**：补全含义 Y（令牌/授权清单）——"谁被授权访问我的私密文档"。

| 项 | 说明 |
|----|------|
| 私密文档分享入口 | 文档卡片/侧栏新增「生成访问令牌」按钮，调用 `POST /api/kb/documents/{id}/access-token` |
| 授权状态展示 | 私密文档清单中，每篇文档标注「已授权 N 个会话」 |
| 令牌撤销 UI | 私密文档清单展开后，可逐个/批量撤销授权（调用现有 `revoke` 端点） |
| 分享链接/口令 | （待定）生成可分享的访问口令，还是仅限本地会话授权 |

**关联代码**：`core/access_token.py`、`routers/kb.py:1595+`、`KBDocument.is_private`

#### KB 文档详情全文预览（S3 深度版）

> 来源：0.9.6 KB 审查遗留（2026-06-27，会话决策：0.9.6 仅做摘要预览，全文放 0.9.7）

**现状**（0.9.6）：文档详情弹窗只显示 `doc.summary`（前 200 字摘要），用户想看全文需自行找原文。后端其实存了完整文本（`kb._load_text(doc_id)` 从 `kb_texts/` 加载），但无暴露端点。

**0.9.7 目标**：详情弹窗支持查看完整内容。
- 后端：新增 `GET /api/kb/documents/{doc_id}/preview`，返回 `_load_text` 全文
- 前端：详情弹窗异步加载全文，加"展开全文/收起"或限高滚动区，避免超长文本撑爆弹窗
- 性能：全文可能很大（数十万字），返回时考虑截断或分段加载

**关联代码**：`knowledge/ops.py:_load_text`、`routers/kb.py`、`qa.js:kbShowDocDetail`

#### KB 文档列表虚拟滚动（分页方案 A）

> 来源：0.9.6 KB 审查遗留（2026-06-27，会话决策：当前文档量小优先级低，放 0.9.7）

**现状**（0.9.6）：`list_documents()` 全量返回，前端一次性渲染所有卡片。`max_documents=200` 硬上限兜底。0.9.6 优先做了方案 C（轮询增量更新，已合入），未触及虚拟滚动。

**问题**：文档 >100 时，前端渲染几百个 DOM 卡片会卡顿（尤其每次轮询）。

**0.9.7 目标**：虚拟滚动——只渲染可视区域的卡片，DOM 数恒定。
- 引入虚拟列表逻辑（IntersectionObserver 或手写虚拟滚动）
- 处理难点：搜索筛选、分类筛选、选中状态、轮询增量更新与虚拟滚动的交互
- 备选：后端分页（方案 B，`/documents` 加 offset/limit + 滚动加载），若虚拟滚动复杂度过高则改用 B

**前置条件**：先确认实际文档量是否真触发瓶颈（观察 0.9.6 用户使用）。若多数用户 <50 篇，此项可继续后移。

**关联代码**：`qa.js:kbRefreshDocs`、`kb.py:list_documents`

### P7 视觉实施路径

| 路径 | 成本 | 时长 | 风险 |
|------|------|------|------|
| A: 专业设计师 | ¥3-8K | 2-3周 | 沟通成本高 |
| B: AI生成+自修 | ~¥0 | 3-5天 | 版权问题（AI Logo 不能注册商标）|
| C: 开源设计系统 | ~¥0 | 1-2天 | 缺个性、撞脸 |

**推荐**：B 起步（先有再好），P8 升级到 A。

### P7 待决策

- [ ] 视觉路径 A/B/C？
- [ ] Logo 抽象图形 vs 吉祥物？
- [ ] 主色调保持蓝 vs 换暖色？
- [ ] 是否请设计师？预算？
- [ ] 是否做官网？

---

## Patch 8（桌伴云）

> 来源：从 PATCH6 挪入（2026-06-21 决策：桌面云需要企业主体/微信支付/域名等前置条件，离当前太远，挪到 P8）

### 商业化路线

路线 1 + 4 叠加：Source-Available（个人免费）+ 卖服务（桌伴云）。
桌面端代码可见但受 EULA 保护；收入来自云端 API 代理（差价）+ 企业部署定制 + 技术支持。

### 桌伴云核心功能

**最小可行（P8a）**：

| 功能 | 方案 |
|------|------|
| 多模型 API 网关 | One API / New API（开源，Docker 部署）|
| 用户注册/登录 | One API 内置（邮箱/GitHub OAuth）|
| 计费系统 | One API 内置（按 token 计费、余额、充值码）|
| 多模型调度 | OpenAI/Claude/DeepSeek/通义/智谱 等 20+ |
| Sidemate 客户端对接 | CloudEngine 增加"桌伴云"模式（免填 Key）|

**完整体验（P8b）**：

| 功能 | 说明 |
|------|------|
| 品牌官网 | 产品介绍 + 下载 + 文档 + 定价页 |
| 微信扫码注册 | 需微信开放平台企业资质 |
| 微信支付充值 | 需微信支付商户号 |
| DeepSeek V4 Pro | One API 原生支持 DeepSeek 渠道 |
| 用量看板 | 用户查看自己的 token 消耗统计 |

### 开源方案调研

- **One API**（github.com/songquanpeng/one-api）：最成熟，Go + React，20+ 模型
- **New API**（github.com/CalciumIon/new-api）：One API 增强版，UI 更好，Midjourney 支持

两者都内置：用户管理、API Key 分发、按 token 计费、充值码、模型负载均衡。

### 客户端改动预估

- `cloud_engine.py`：增加"桌伴云"Provider，endpoint 指向自建网关
- `settings.js`：设置页增加"桌伴云"Tab（注册/登录/余额查看）
- `config.py`：增加 `CLOUD_SIDEMATE_ENDPOINT` 配置
- 免填 Key 模式：登录成功后自动写入 API Key 到 settings

### 商业模型粗算

| 项目 | 参考 |
|------|------|
| DeepSeek V4 Pro 成本 | ~¥2/百万 input token |
| 售价（加价 50%-150%）| ~¥3-5/百万 token |
| 单次长文生成 | 用户付 ¥0.02-0.05 |
| 个人用户月均 | ¥10-30 |
| 企业用户月均 | ¥100-500 |

### P8 前置条件 & 风险

| 项目 | 说明 |
|------|------|
| 企业主体 | 微信支付/登录需要企业资质（个体工商户也行）|
| 服务器成本 | One API + 模型代理，轻量云即可（¥50-100/月起步）|
| 合规 | 模型输出内容审核（国内必须）|
| 竞争 | ChatGPT 官方 App / Kimi / 通义等都有免费额度 |

### P8 待确认

- [ ] 是否注册个体工商户？
- [ ] 先上充值码（无微信支付）还是一步到位？
- [ ] 定价策略：按 token 还是按月套餐？
- [ ] 是否需要官网？还是直接在 Sidemate 客户端内完成注册充值？

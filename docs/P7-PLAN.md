# P7 规划

> 两大主线：底层能力升级 + 品牌视觉精修

---

## 主线一：底层能力升级

### P7-1: 动态 num_ctx（启动时自动推荐）

**目标**：不再硬编码上下文窗口，启动时检测硬件自动推荐最优值。

**推荐表**：
| 硬件 | num_ctx | 
|------|---------|
| 独立 GPU ≥ 8GB | 32K |
| 独立 GPU ≥ 4GB | 16K |
| CPU / 集成显卡 | 8K |
| 内存 < 8GB | 4K |

**实现**：
- Go Launcher 启动时检测 GPU VRAM + 可用 RAM
- 写入 Ollama Modelfile → ollama create → 启动
- 设置页加滑块（显示推荐值，可调，改后提示重新加载模型）

---

## P7-2: ModelScope 下载 Qwen3.5 系列模型

**目标**：从 ModelScope 下载 Qwen3.5-1.5B/4B/7B/14B GGUF，自动安装到 Ollama，支持多模型切换。

**范围**：
- 设置页「模型管理」新增"下载模型"入口
- 列出可用模型清单（含大小、推荐配置）
- 显示下载进度 + 预估时间
- 下载完成后自动 `ollama create`
- 下拉切换已下载的模型

---

## P7-3: ModelScope 下载 BGE + Reranker

**目标**：从 ModelScope 下载嵌入模型和重排序模型，支持多类型切换。

**范围**：
- BGE: bge-m3 / bge-large-zh-v1.5 / bge-small-zh-v1.5
- Reranker: bge-reranker-v2-m3 / bge-reranker-large
- 设置页显示已安装/未安装状态
- 一键下载 + 自动配置
- 下拉切换

---

## P7-4: Ollama 底座 → llama.cpp 底座

**目标**：用 llama.cpp 替代 Ollama，减少中间层开销，直接控制推理参数。

**动机**：
- 性能：去掉 HTTP 中转，降低延迟
- 可控性：直接设置 num_ctx、threads、gpu_layers
- 部署：单一进程，无需额外 Docker/service

**范围**：
- Go Launcher 嵌入 llama.cpp CGO 绑定
- 支持 GGUF 模型直接加载
- 保留 Ollama 作为可选项（向后兼容）
- 推理参数通过 settings.json 配置

---

## P7-4b: 文档审计日志（KB Document Access Audit Log）

> **来源**：P6 打磨阶段用户提出（2026-06-26）
> **动机**：当前 KB 卡片只显示「被搜索 N 次」的累加计数（`hit_count` 整数），无法回溯「什么时候、被谁、查了什么」。用户希望给每个文档建一份详细的访问审计日志。

**目标**：每个 KB 文档记录完整的访问历史，点开「被搜索 N 次」可查看明细，而不是只看到一个干巴巴的数字。

**审计日志字段**（每条记录）：

| 字段 | 说明 | 示例 |
|------|------|------|
| `timestamp` | 访问时间 | 2026-06-26 09:47:23 |
| `access_type` | 访问方式 | `kb_search`（KB检索命中）/ `manual_cite`（手动引用）/ `agent_read`（Agent工具读取） |
| `actor` | 访问者 | `local`（本地模型）/ `cloud`（在线模型）/ `user`（手动） |
| `query` | 触发访问的查询/问题 | "静养神 专注力训练 日常习惯" |
| `matched_text` | 命中的段落/片段 | "一、静身 久坐不如小坐..." |
| `reranker_score` | 相关性评分（检索命中时） | 0.8409 |

**用户原始诉求**（原话保留）：
> "给每个文档搞个审计日志，xx日期xx时间，被本地/在线模型访问了 xxx段落 or 手动引用这样的一个详细记录"

**实现拆解**：

1. **后端数据层**（`knowledge/ops.py` + 新建日志存储）
   - 新建搜索日志结构：每次检索命中时，写入一条审计记录（不只 +1）
   - 存储方案（二选一，P7 实施时定）：
     - A. 每文档一个 `audit_log.json`（简单，但文件多）
     - B. 统一 `kb_audit.jsonl`（追加写入，按 doc_id 索引）
   - 命中点：`search.py:544`（当前 `doc.hit_count += 1` 处）扩展为同时写日志
   - 手动引用点：用户在对话里手动 @ 文档时也记录 `access_type=manual_cite`

2. **后端接口**
   - `GET /api/kb/documents/{doc_id}/audit_log` → 返回该文档的访问历史列表（分页）
   - 可选：`GET /api/kb/documents/{doc_id}/audit_log/export` → 导出（CSV/JSON）

3. **前端交互**
   - KB 卡片「被搜索 N 次」文字绑点击 → 弹出审计日志面板
   - 面板内容：时间线列表（时间 + 访问者图标 + 查询词 + 命中片段预览）
   - 访问者图标区分：本地（🖥）/在线（☁）/手动（✋）

4. **存储治理**
   - 日志上限：每文档保留最近 N 条（如 200 条）或 N 天（如 90 天）
   - 超限自动裁剪最旧记录（FIFO）
   - 设置页加「清空审计日志」入口

**范围边界**（P7 不做）：
- 不做跨文档的访问统计报表（那是 P8 数据分析的事）
- 不做访问历史的全文搜索（只按文档查自己的日志）

**关联现状**：
- 热力图圆点（P6 P1-04）保留，作为「冷热程度」的快速概览
- 审计日志是「点进去看明细」，与热力图是「概览 vs 详情」关系，互补不替代

---

## P7 技术债：代码整洁项（F11 / F12）

> **来源**：P6 打磨阶段审计（AUDIT-ponytail.md D1/D2），逐行对比后判定 P6 不改（发版前不承担回归风险），移入 P7。
> **共同特征**：纯代码整洁，无功能/性能收益，需写测试覆盖行为差异才能安全合并。

### F11: 合并 cache_cleanup + log_cleanup

**现状**：`core/cache_cleanup.py` 与 `core/log_cleanup.py` 各实现一份 walk-mtime-remove，核心逻辑重复。

**逐行对比的 3 个行为差异**（合并必须处理）：

| 维度 | cache_cleanup | log_cleanup |
|------|--------------|-------------|
| 遍历方式 | `os.walk()` 递归子目录 | `os.listdir()` 只扫平铺 |
| 默认天数 | 7 天 | 30 天 |
| 日志粒度 | 只汇总一条 | 每删一个记一条 + 汇总 |
| 错误处理 | `except OSError: pass`（静默） | `except OSError: log.warning`（记录） |

**调用方**：`server.py:584-605`，启动时各调一次。
**风险点**：⚠️ 递归 vs 平铺——cache 目录有子目录（递归合理），但 log 目录若意外有子目录，递归删可能误删。改不好会误删用户数据。
**合并方案**：抽 `_cleanup_old_files(path, max_age_days, recursive=True, log_each=False)`，两个原函数退化为薄包装。
**前置条件**：合并前必须写测试覆盖 ① 递归 ② 平铺 ③ 子目录不被误删 三种场景。

### F12: 合并两份 atomic_write_json

**现状**：`core/session_migrator.py:152` 的 `_atomic_write_json` 与 `core/doc_session.py:318` 的 `_save_completed` 各实现一份 tmp-write + `os.replace`。

**逐行对比**（高度相似但有细节差异）：

| 维度 | session_migrator._atomic_write_json | doc_session._save_completed |
|------|-------------------------------------|----------------------------|
| 写法 | dump + flush + fsync + replace | 完全一样 |
| fsync 异常 | 无 try 保护（失败即抛） | `try/except OSError: pass`（容错） |
| 目录创建 | 无（假设目录已存在） | 有 `os.makedirs(exist_ok=True)` |

**调用方**：session_migrator 仅被 `chat_store.py:56` 一次性迁移调用（极低频）；`_save_completed` 被 agent_loop/doc_session 调用，有 `tests/test_regression_v31.py:76` 存在性检查。
**合并方案**：抽到 `common/utils.py` 的 `atomic_write_json(path, data, makedirs=True, fsync_safe=True)`，采用 doc_session 版的健壮性（makedirs + fsync 容错）作为公共实现。
**前置条件**：合并后 session_migrator 会意外获得 makedirs + fsync 容错行为（通常是增强），需验证其调用场景不冲突。



## 主线二：品牌视觉精修（来自 PATCH7-BRAINSTORM）

> 纯视觉/品牌层精修，不涉及功能改动。把"够用但粗糙"的素材升级到"专业级"。

### P7-5: Logo 精修
- Logo 矢量重做（现有 logo.svg 是 AI 草稿）
- 五种变体：横版/竖版/单色/反白/图标-only
- 使用规范文档（间距/最小尺寸/不可用场景）

### P7-6: 图标系统
- favicon 全套：16/32/48/180/192/512 多尺寸
- 应用图标：.ico（Windows）
- 内部图标统一风格（lucide/heroicons 选一套）

### P7-7: Splash 启动画面精修
- 背景图（设计师插画或几何图形）
- Logo 进入动画（淡入+缩放）
- 进度条样式精修（圆角/渐变/光泽）
- 字体替换

### P7-8: 字体系统
| 用途 | 候选 |
|------|------|
| 中文 | 思源黑体 / 阿里巴巴普惠体 / 系统微软雅黑 |
| 英文/数字 | Inter / SF Pro / Roboto |
| 等宽代码 | JetBrains Mono / Fira Code |

### P7-9: 配色系统规范化
- 主色调校准（当前蓝色 #185FA5）
- 暗色模式精修（对比度不够）
- 状态色统一（success/warning/error/info）

### P7-10: 安装包视觉
- ISS 安装界面自定义 banner
- 安装/卸载向导图标替换

### P7-11: 官网/营销物料（可选，配合 P6 商业化）
- 官网首页 + 下载页
- 文档站
- 社交媒体 banner

---

## 实施路径（视觉部分）

| 路径 | 成本 | 时长 | 风险 |
|------|------|------|------|
| A: 专业设计师 | ¥3-8K | 2-3周 | 沟通成本高 |
| B: AI生成+自修 | ~¥0 | 3-5天 | 版权问题 |
| C: 开源设计系统 | ~¥0 | 1-2天 | 缺个性 |

**推荐**：B 起步（先有再好），P8 升级到 A。

---

## 待决策
- [ ] 视觉路径 A/B/C？
- [ ] Logo 抽象图形 vs 吉祥物？
- [ ] 主色调保持蓝 vs 换暖色？
- [ ] 是否请设计师？预算？
- [ ] 是否做官网？

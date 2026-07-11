# Sidemate Patch3 全量修复方案

**日期**: 2026-06-09
**目标**: 一次性修复两份审计报告中的全部 49 个问题（P0×6 + P1×23 + P2×20）
**原则**: 安全优先 > 功能修复 > 代码清理 > 架构优化

---

## 修复分组（按执行顺序）

### 第一批：安全修复（P0 全部 + 相关 P1）— 6 个问题

| # | 问题ID | 文件 | 改动 | 风险 |
|---|--------|------|------|------|
| 1 | P0-SEC-01 | `config.py:33` | HMAC 默认密钥改为安装时自动生成 → `data/hmac_key` 文件，不存在则随机生成 | **低** — 向后兼容：旧密钥会 fallback |
| 2 | P0-01 | `utils.js:369` | `_mdFallback()` 行内代码改 callback + `esc()` | **极低** — 仅降级路径 |
| 3 | P0-02 | `utils.js:388` | `_mdFallback()` 链接改 callback + 过滤 `javascript:` 协议 | **极低** — 仅降级路径 |
| 4 | P1-SEC-02 | `validators/sidemate_validator.py:21` | `ALLOWED_EXTENSIONS` 移除 `.py` | **需确认** — 如果扩展包有 `.py` 配置文件会 break |
| 5 | P1-SEC-03 | `routers/chat.py` | `_safe_filename()` 改用 `pathlib.PurePath(name).name` | **极低** |
| 6 | P1-10 | `utils.js:246-251` | `md()` 添加 DOMPurify 后处理（需引入 dompurify.js） | **中** — 需新增依赖 |

**⚠️ 需要你确认**：
- P1-SEC-02：`.py` 在扩展包里是否有合法用途？如果确定没有，直接删
- P1-10：DOMPurify 需要引入一个 ~20KB 的 JS 文件。是否接受？或者因为本地 AI 可信，先不做？

---

### 第二批：依赖修复（P0 + P1）— 7 个问题

| # | 问题ID | 改动 | 风险 |
|---|--------|------|------|
| 7 | P0-DEP-01 | `requirements.txt` 添加 `faiss-cpu==1.9.0` | **低** — numpy 兼容需验证 |
| 8 | P0-DEP-02 | `requirements.txt` 添加 `openai>=1.0.0` | **低** |
| 9 | P1-CON-01 | 删除 `requirements.txt` 中 `requests==2.33.1`（已确认无代码引用） | **极低** — grep 确认无 import |
| 10 | P1-CON-02 | 删除 `requirements.txt` 中 `PyPDF2==3.0.1`（已确认无代码引用） | **极低** — grep 确认无 import |
| 11 | P1-DEP-03 | `search_engine.py` 缺少 `curl_cffi` 时改 warning 级日志 | **极低** |
| 12 | P2-DEP-04 | `requirements.txt` 锁定 `readability-lxml>=0.4.0` | **极低** |
| 13 | P2-CON-03 | 暂不处理 — 等 faiss-cpu 实际加入后测试 numpy 兼容性 | — |

---

### 第三批：死代码清理 — 6 个问题

| # | 问题ID | 改动 | 风险 |
|---|--------|------|------|
| 14 | P1-DEAD-01 | 删除 `actions/research_action.py`（已确认仍被 `_base.py` 和 `local_pipeline.py` 引用） | **⚠️ 需同步改引用** |
| 15 | P1-DEAD-02a | 删除 `prompts.py` 中 `THINK_CONTROL`（全空值，无引用） | **极低** |
| 16 | P1-DEAD-02b | 删除 `prompts.py` 中 `STRATEGY_CONFIG`（V1，无代码引用，只有 `STRATEGY_CONFIG_V2` 被引用） | **极低** |
| 17 | P2-08 | 删除 `skills.js` + `index.html` 中 `<script>` 标签 | **极低** |
| 18 | P2-09 | 删除 `chat-ui.js` 中空函数 `updateKbLockBar()` | **需确认 qa.js 是否调用** |
| 19 | P2-10 | 合并 `downloadFile()` / `saveFileAs()` 为一个 | **低** |

**⚠️ 需要你确认**：
- P1-DEAD-01：`research_action.py` 还被 `_base.py:291` 和 `local_pipeline.py:228` 引用。删除前需要同步删掉这两个调用点。这两个调用点本身是旧管线的残留代码，删除是否安全？

---

### 第四批：前端修复（P1 CSS/UX）— 11 个问题

| # | 问题ID | 改动 | 风险 |
|---|--------|------|------|
| 20 | P1-01 | `main.css` 8 处硬编码颜色 → CSS 变量 | **极低** |
| 21 | P1-02 | JS 50+ 处硬编码颜色 → 通过 CSS class 控制 | **中** — 工作量大，可能遗漏 |
| 22 | P1-03 | `showLoading()` 加 null 保护 | **极低** |
| 23 | P1-04 | `hideLoading()` 加 null 保护 | **极低** |
| 24 | P1-05 | `.msg.user` 改 `var(--msg-user-bg)` | **极低** |
| 25 | P1-06 | `.msg .ts` 改 `var(--text-muted)` | **极低** |
| 26 | P1-08 | `_heartbeatTimer` 添加 `visibilitychange` 暂停 | **极低** |
| 27 | P1-09 | `_sessionPollTimer` 添加 `stopSessionPoll()` | **低** |
| 28 | P1-11 | `_renderFootnotesFallback` 中 `fn.text` 加 `esc()` | **极低** |
| 29 | P2-05 | `.tag-local` / `.tag-cloud` 加暗色主题覆盖 | **极低** |
| 30 | P2-06 | 上下文指示器颜色改 CSS 变量 | **极低** |

---

### 第五批：后端代码质量 — 10 个问题

| # | 问题ID | 改动 | 风险 |
|---|--------|------|------|
| 31 | P1-EMPTY-01 | 50+ 处 `except Exception: pass` → 加 `logger.debug()` | **低** — 纯加日志 |
| 32 | P1-WRN-01 | 定位 `pkg_resources` 使用处，替换为 `importlib.metadata` | **中** — 需测试 |
| 33 | P1-TECH-02 | `model_manager.py` 魔法数字 → config 常量 | **极低** |
| 34 | P2-DEAD-03 | `llm_scheduler.py` + `generate_queue.py` 提取基类 | **中** — 重构风险 |
| 35 | P2-DEAD-04 | `think_processor.py` 合并到 `response_filter.py` | **低** |
| 36 | P2-EMPTY-02 | `config.py` 关键配置项加类型检查 | **极低** |
| 37 | P2-EMPTY-03 | 部分端点加 Pydantic 验证 | **中** — 需逐个端点评估 |
| 38 | P2-TECH-06 | `stall_detector.py` 清理 TODO | **极低** |
| 39 | P2-TECH-07 | `doc_action.py` `_kb_context_cache` 加 TTL | **低** |
| 40 | P2-SEC-04 | API Key 存储改用 Fernet 加密 | **中** — 需新增 cryptography 依赖 |

---

### 第六批：架构拆分（仅规划，不动手）— 2 个问题

| # | 问题ID | 说明 |
|---|--------|------|
| 41 | P0-TECH-01 | `routers/kb.py`（52KB）拆分方案 — **仅写规划文档，不在本次执行** |
| 42 | P1-TECH-03 | `knowledge_base.py`（69KB）拆分方案 — **仅写规划文档，不在本次执行** |

**理由**：52KB 和 69KB 的文件拆分是大型重构，风险高、测试量大。本次只写拆分规划文档，下次单独一轮做。

---

### 第七批：杂项 P2 — 5 个问题

| # | 问题ID | 改动 | 风险 |
|---|--------|------|------|
| 43 | P2-01 | `--accent-light` 与 `--primary-50` 重复 → 加注释说明 | **极低** |
| 44 | P2-02 | `--text-muted` / `--msg-ai-bg` 引用 gray 变量 | **极低** |
| 45 | P2-07 | 删除 Toast `.warning` 重复 CSS 规则（删旧保留新） | **极低** |
| 46 | P2-04 | `stream-msg` DOM 查询缓存到局部变量 | **极低** |
| 47 | P2-11 | `_renderFootnotesFallback` 中 `fn.id` 加 `escAttr()` | **极低** |

---

## 不做的事（明确排除）

| 问题ID | 原因 |
|--------|------|
| P1-TECH-04 | `MODEL_CAPABILITIES` 80+ 模型外部化 — 工作量巨大，且当前可维护 |
| P2-TECH-05 | 同 P2-DEAD-03，合并处理 |
| P2-WRN-02 | HMAC 密钥警告已在 P0-SEC-01 中一并解决 |

---

## 需要你确认的 4 个问题

1. **P1-SEC-02**：`.py` 从扩展包白名单中移除 — 是否有扩展包包含 `.py` 配置脚本？
2. **P1-10**：DOMPurify 引入 ~20KB JS — 是否接受？或者因为本地 AI 可信先跳过？
3. **P1-DEAD-01**：`research_action.py` 删除 — 需同步删 `_base.py:249-296` 和 `local_pipeline.py:226-238` 中的调用，确认安全？
4. **P0-SEC-01 HMAC 方案**：
   - **方案 A**（推荐）：首次启动生成随机密钥 → 存 `data/hmac_key` → 后续启动读取
   - **方案 B**：保留默认密钥，但签名验证改为可选（`settings.json` 可开关）
   - **方案 C**：维持现状，只加强文档说明

---

## 执行计划

| 阶段 | 内容 | 预计文件数 | 可并行 |
|------|------|-----------|--------|
| 1 | 安全修复（P0×3 + P1×3） | ~8 | 是 |
| 2 | 依赖修复 | ~3 | 是 |
| 3 | 死代码清理 | ~6 | 是 |
| 4 | 前端 CSS/UX | ~10 | 是 |
| 5 | 后端代码质量 | ~15 | 否（逐个文件） |
| 6 | 架构拆分规划文档 | 2（仅文档） | 是 |
| 7 | 杂项 P2 | ~6 | 是 |

**预估总改动量**：~40 个文件，~200 处修改点

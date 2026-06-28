# 归档目录索引

> 整理日期：2026-06-28 | 共 **362 个 .md 文件**（其中过程文档 92 个，v0.8-旧版 270 个）
>
> ⚠️ **本目录为历史归档**，不反映当前发版状态。如需查阅当前文档，请回到上级 [设计文档/README.md](../README.md)。

---

## 目录结构

```
归档/
├── 过程文档/                    # 92 个 .md（v0.9 时期的过程讨论、审计、测试、修复）
│   ├── 设计讨论/                # 设计阶段的讨论记录（p12/p2/p3）
│   ├── 代码审计/                # 早期代码审计报告
│   ├── 修复方案/                # 修复方案文档
│   ├── 测试报告/                # 早期测试报告
│   ├── p12测试与修复/           # Patch 12 测试与修复
│   ├── p3-文档/                 # Patch 3 文档
│   ├── p4-p6-历史过程文档/      # 2026-06-28 从 docs/ 根目录迁入
│   ├── 测试截图-旧/             # 旧版测试截图
│   ├── 测试截图-round4/         # 第 4 轮测试截图
│   ├── 测试截图-round5/         # 第 5 轮测试截图
│   └── 截图-旧版/               # 旧版截图
│
└── v0.8-旧版/                   # 270 个 .md（v0.8 及更早的历史文档）
    ├── 根项目/                  # 根目录时期的设计文档
    ├── 旧目录-规划与记录/       # 旧版规划记录
    ├── 旧目录-架构设计/         # 旧版架构设计
    ├── 旧目录-迁移与审计/       # 旧版迁移与审计
    ├── p1-文档/                 # Patch 1 文档
    ├── p2-文档/                 # Patch 2 文档
    ├── p10_PLAN_v0.9.md
    ├── p12-迁移与审计/
    ├── p12-部署指南-旧版.md
    ├── p12-架构文档/
    ├── p12文档/
    ├── changelogs/              # 旧版 changelog
    └── v0.8_*.md
```

---

## 过程文档 / p4-p6-历史过程文档（20 个，2026-06-28 迁入）

> 这一批是从 `docs/` 根目录整理时迁入的 Patch 4-6 时期的过程文档。
> 当前发版（v0.9.6）相关内容见 `设计文档/` 目录下；这些文档**仅作历史参考**。

### 架构设计（4 个）

| 文件 | 说明 |
|------|------|
| `ARCH-P6.md` | P6 系统架构设计 + 任务分解 |
| `ARCH-STARTUP-REFACTOR.md` | 启动重构架构 |
| `PATCH4-ARCHITECTURE.md` | Patch 4 技术实施方案 |
| `PATCH4-WORKSPACE-UNIFY.md` | Patch 4 工作区统一 |

### PRD / 规划（4 个）

| 文件 | 说明 |
|------|------|
| `PRD-P6.md` | P6 增量 PRD |
| `PRD-STARTUP-REFACTOR.md` | 启动重构 PRD |
| `PATCH4-PLAN.md` | Patch 4 规划文档 |
| `PATCH5-PLAN.md` | Patch 5 规划文档 |

### Brainstorm / 设计（3 个）

| 文件 | 说明 |
|------|------|
| `PATCH4-DOCAGENT-FIX.md` | Patch 4 文档 Agent 修复 |
| `PATCH6-BRAINSTORM.md` | Patch 6 头脑风暴 |
| `P6-POLISH.md` | P6 打磨方案 |

### 审计 / 修复（4 个）

| 文件 | 说明 |
|------|------|
| `AUDIT-ponytail.md` | ponytail 审计报告 |
| `FIXES-ponytail.md` | ponytail 修复方案 |
| `REVIEW-ponytail-P6.md` | P6 复审报告 |
| `CODE-REVIEW-2026-06-28.md` | 2026-06-28 代码审查 |
| `d1_restructure_plan.md` | D1 重构计划 |
| `patch5_qa_audit_report.md` | Patch 5 QA 审计报告 |

### 测试（2 个）

| 文件 | 说明 |
|------|------|
| `PATCH4-TEST-MANUAL.md` | Patch 4 测试手册 |
| `PATCH4-TEST-REPORT.md` | Patch 4 冒烟测试报告 |
| `TEST-CHECKLIST-P6.md` | P6 测试清单 |

---

## 过程文档 / 设计讨论

> v0.9 时期（p12/p2/p3）的设计讨论文档。

- `THINK_PIPELINE.md` — 思考流管道设计
- `think-pipeline-redesign.md` — 思考流重构
- `sidemate-settings-design-tokens.md` — 设计令牌讨论
- `sidemate-agent-prd.md` — Agent PRD
- `SESSION_MANAGEMENT.md` — 会话管理设计
- `RECORDER_DESIGN.md` — 录音设计
- `PATCH2-prompt-architecture-v2.md` — Patch 2 Prompt 架构
- `p12_前端同步后台事项.md` — 前后端同步事项
- `overview_v0.5.md` — v0.5 总览
- `KNOWLEDGE_PIPELINE.md` — 知识管道设计
- `frontend-task-brief.md` — 前端任务简报
- `frontend-ui-audit-2026-06-09.md` — 前端 UI 审计
- `PATCH2-FRONTEND-API-REQUIREMENTS.md` — Patch 2 前端 API 需求
- `PATCH2-BACKEND-PLAN.md` — Patch 2 后端方案
- `PATCH2-ARCHITECTURE.md` — Patch 2 架构
- `PATCH2-ARCHITECTURE-完整版.md` — Patch 2 架构完整版
- `p12_DEPLOYMENT_GUIDE.md` — P12 部署指南
- `review-ux-experience.md` — UX 复审
- `review-functionality.md` — 功能复审
- `review-element-consistency.md` — 元素一致性复审
- `overview-v1.md` — v1 总览

## 过程文档 / 代码审计

- `patch12-code-audit-report.md` — Patch 12 代码审计
- `code-audit-2026-06-09.md` — 2026-06-09 代码审计
- `frontend-ui-audit-2026-06-09.md` — 前端 UI 审计
- `review-ux-experience.md` — UX 复审
- `review-functionality.md` — 功能复审
- `review-element-consistency.md` — 元素一致性复审

## 过程文档 / 修复方案

- `patch12-migration-report.md` — Patch 12 迁移报告
- `patch12-fix-plan.md` — Patch 12 修复方案
- `p12_修复方案-第三轮测试.md` — 第三轮测试修复
- `fix-plan-all-issues.md` — 全问题修复方案
- `fix-plan-unified-patch3.md` — Patch 3 统一修复

## 过程文档 / 测试报告

- `v0.9-base-QA_REPORT.md` — v0.9 base QA 报告
- `test-report-compare.md` — 对比测试报告
- `round8_debug_report.md` — 第 8 轮调试报告
- `PATCH3-TEST-REPORT.md` — Patch 3 测试报告
- `RELEASE-TEST-CHECKLIST.md` — 发版测试清单
- `qa-test-report.md` — QA 测试报告
- `qa-test-plan.md` — QA 测试方案
- `p12_第四轮自动测试报告.md` — 第 4 轮自动测试
- `p12_第五轮自动测试报告.md` — 第 5 轮自动测试
- `p12_第二轮slow测试.md` — 第 2 轮 slow 测试
- `p12_第三轮自动测试报告.md` — 第 3 轮自动测试
- `chat-test.mjs` / `chat-test.cjs` — Chat 测试脚本

## 过程文档 / p12测试与修复

- 同名子目录，对 p12 时期测试与修复的归档
- 含 `round9_test_report.md` 等

## 过程文档 / p3-文档

- `prompt-architecture-v2.md`
- `PATCH3-ARCHITECTURE.md`

---

## v0.8-旧版（270 个文件）

> v0.8 及更早版本的所有历史文档，按子目录归档。**仅作历史回溯**。
>
> 包括：根项目设计文档、旧版规划记录（p10/p12 时期）、旧版架构设计、旧版迁移与审计报告、Patch 1-2 文档、p12 部署/迁移/架构/changelogs 文档等。
>
> **总入口**：直接查阅 `v0.8-旧版/` 根目录的 .md 文件（按字母 / 数字前缀排序）。

---

## 检索建议

- **查当前发版文档** → `设计文档/` 根目录 + 子目录（用户文档 / 架构与设计 / 规划与方案 / 科普与分析）
- **查 v0.9.6 期间讨论/审计/测试** → `归档/过程文档/`
- **查 v0.8 及更早历史** → `归档/v0.8-旧版/`
- **查 0.9.6 首发重发新增功能** → `设计文档/用户文档/v0.9.7-*.md` + `设计文档/架构与设计/v0.9.7-*.md`（功能已随 0.9.6 发版）

---

## 整理记录

- **2026-06-28**：从 `docs/` 根目录整理出 20 个 Patch 4-6 时期的过程文档，统一迁入 `过程文档/p4-p6-历史过程文档/`
- **2026-06-28**：删除孤儿截图 `111.png`（无引用）
- **2026-06-28**：建立本索引文件

# _local-ai_old_archived — 已归档的旧模块

归档日期：2026-05-25
归档原因：Patch11 PIPE 重设计后，以下模块成为死代码，前端无调用、LLM 无注入。

## 归档内容

| 文件/目录 | 原位置 | 说明 |
|-----------|--------|------|
| `skill_loader.py` | 项目根目录 | Skill 加载器，扫描 skills/builtin/ 注册 7 个内置工具 |
| `skills/builtin/` | skills/builtin/ | 7 个内置 Skill（code-runner, file-ops, word-reader, word-writer, kb-search, xlsx-reader, long-reader） |
| `permissions.py` | routers/settings.py 内联 | PermissionManager 权限管理器（3 模式：闲聊/助手/工作台） |
| `audit_log.py` | routers/settings.py 内联 | AuditLogger 审计日志管理器（JSONL 格式记录操作） |

## 为什么是死代码

- **Skill**：`skill_loader` 被 chat.py 导入但从未调用；prompts.py 没有注入 skill 描述给 LLM；前端没有调 `/api/skill/*`
- **权限**：前端没有调 `/api/permission/*` 任何端点；chat.py 导入了但从未调用
- **审计**：只有 skill 的 execute_skill() 会记录审计日志，但 skill 本身就是死代码；前端没有调 `/api/audit/*`

## 将来恢复

如果需要 tool-calling 或权限管理功能，从这里取出代码即可。PermissionManager 和 AuditLogger 是独立模块，不依赖 Skill 体系。

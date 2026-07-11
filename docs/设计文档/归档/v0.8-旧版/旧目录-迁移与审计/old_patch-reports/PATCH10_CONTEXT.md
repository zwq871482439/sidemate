# Patch10 开发上下文

**生成时间**: 2026-05-22
**用途**: 供架构师、工程师、QA 快速了解项目现状和 Patch10 需求

---

## 一、项目现状速览

### 技术栈
- 后端: FastAPI + OpenVINO GenAI + Qwen3 (0.6B/1.7B/4B/8B/14B)
- 前端: 纯 HTML/JS/CSS (无框架)
- 设备: Intel NPU/GPU/CPU 三后端切换
- 部署: 完全本地离线

### 当前版本: Patch9
**关键变更**:
- Router 拆分: server.py 从 ~60KB 精简到 ~11KB
- Pipeline DAG 引擎: 拓扑排序、暂停/恢复/取消/人工审批
- GenerateQueue 优先级队列替代 _gen_lock
- config.py TTL 缓存（5秒）
- 前端拆分: index.html + static/css/main.css + static/js/chat.js

### 核心文件清单
```
server.py                 # 主服务 (~11KB)
models.py                 # ModelManager + GenerateQueue (~114KB)
config.py                 # 配置管理 + TTL缓存 (~10KB)
agent.py                  # Agent Loop v2.0 (~882行)
response_filter.py        # 响应过滤
chunking_orchestrator.py  # 长文本编排
knowledge_base.py         # 知识库 (~1000+行)
recorder.py               # 录音纪要 (~1000+行)

routers/
  deps.py                 # 依赖注入
  chat.py                 # 对话/会话/QA/OCR/反馈/Pipeline (~75KB)
  kb.py                   # 知识库管理
  settings.py             # 模型/配置/资源/训练/权限/审计/扩展
  recorder.py             # 录音纪要 Router
  notebook.py             # 小册子/记忆
  skill.py                # 技能管理

pipeline/
  engine.py               # DAG 执行引擎
  context.py              # 运行时上下文
  steps.py                # 原子步骤 (llm/code/tool)
  templates.py            # 模板加载

static/
  css/main.css            # 样式 (~270行)
  js/chat.js              # 对话逻辑 (~35KB)
  js/settings.js          # 设置逻辑
  js/qa.js                # 问答逻辑
  js/minutes.js           # 纪要逻辑
  js/memory.js            # 记忆逻辑
  js/skills.js            # 技能逻辑
  js/core/                # api.js, errors.js, utils.js

index.html                # 主页面 (~52KB)
```

---

## 二、Patch9 已知 Bug（必须在 Patch10 修复）

| 等级 | 问题 | 位置 | 状态 |
|------|------|------|------|
| P0 | `_stop_generation` 竞态条件 | models.py + chat.py | 部分缓解 |
| P0 | `stream=True` 参数错误 | chunking_orchestrator.py:264 | 未修复 |
| P1 | Pipeline 审批无超时 | pipeline/engine.py | 未修复 |
| P1 | `_save_meta` 每消息都写 | chat.py | 待优化 |
| P2 | config 缓存无锁 | config.py | 待优化 |

**详细报告**: `CODE_REVIEW_REPORT_PATCH9.md`

---

## 三、Patch10 需求（来自用户）

### P0 - 必做
1. **修复 P0 Bug** (stream=True、stop 竞态)
2. **代码块高亮 + 复制按钮** (前端)
3. **深色模式** (设置开关 + CSS 变量)
4. **模型加载进度条** (后端 SSE 推送 + 前端进度)
5. **设置 Tab 重构** (删除训练/参数模板/云端/审计，保留资源调度)
6. **统一扩展安装接口** (设置 Tab 上传 ZIP 自动安装，控制 Tab 显隐)
7. **知识库状态机简化** (去掉三级状态，安装完直接用)
8. **取消 web-search Skill** (删除联网搜索代码)

### P1 - 尽快做
9. **Agent 智能化改进** (8B 模型 prompt 优化、工具选择策略)
10. **录音另存功能** (.txt/.md/.docx)
11. **对话文件选择从 KB 获取** (不再独立上传)
12. **导出功能** (对话/纪要 → Markdown)
13. **错误提示优化** (更友好的中文提示)

### P2 - 评估后决定
14. **PPT 读写** (技术方案评估)
15. **Excel 写入** (技术方案评估)

### 明确不做
- ❌ 图片理解 (本地带不动)
- ❌ 联网搜索 (数据不出机)
- ❌ 语音输出 TTS (用户没要求)
- ❌ 对话历史搜索 (用户说没必要)

---

## 四、关键设计决策（用户已确认）

1. **乐高式模块**: 主程序 + 8B + KB + 纪要 拆开，通过扩展包安装
2. **Tab 动态显隐**: 没安装的模块对应 Tab 隐藏
3. **对话文件从 KB 选**: 最大化小模型对文件的理解能力
4. **数据不出机**: 删除所有云端/联网功能

---

## 五、参考文档

- `CODE_REVIEW_REPORT_PATCH9.md` - 代码审计报告
- `FUNCTION_GAP_ANALYSIS_PATCH9.md` - 功能差距分析
- `v0.8_CAPABILITY_GAP_ANALYSIS.md` - v0.8 能力差距（历史）
- `ROADMAP.md` - 产品路线图

# 本地AI平台 - 开发日志

> 记录每个版本的开发过程、踩过的坑、技术决策。
> 给未来的开发者（或未来的自己）参考。

---

## v0.1 基础框架 (2026-04-29)

### 目标
搭建最小可用原型：FastAPI + Gradio 聊天界面 + MCP Server

### 技术选型

| 组件 | 选择 | 理由 |
|------|------|------|
| Web 框架 | FastAPI | 轻量、自带 API 文档、异步支持 |
| 前端界面 | Gradio 6.13 | Python 原生聊天 UI，开发快 |
| AI 推理 | OpenVINO GenAI | Intel NPU 加速，INT4 量化 |
| OCR | RapidOCR-openvino | CPU 运行，~1s/页，准确度高 |
| MCP | mcp.server.fastmcp | 标准协议，stdio 传输 |

### 踩坑记录

1. **SyntaxWarning: `\_` 无效转义**
   - 原因：docstring 中 `C:\tmp\_local-ai` 的 `\_` 被视为转义
   - 修复：改为 `C:\\tmp\\_local-ai`

2. **NameError: `gr` not defined**
   - 原因：`import gradio as gr` 在函数内部，`gr.mount_gradio_app()` 在外部调用
   - 修复：把 import 移到文件顶部

3. **Gradio 6.13 Chatbot 不接受 `type="messages"`**
   - 原因：Gradio 6.x 默认就是 messages 格式
   - 修复：移除 `type="messages"` 参数

4. **Gradio 6.13 要求 chat_fn 返回 messages 格式**
   - 原因：必须返回 `[{"role": "user", "content": ...}, {"role": "assistant", "content": ...}]`
   - 修复：返回完整的 messages 列表，不能只返回字符串

5. **Windows GBK 不支持 emoji**
   - 原因：MCP 子进程用 GBK 编码，无法输出 emoji
   - 修复：所有 print 改用纯 ASCII 文本

### 关键文件

```
C:\tmp\_local-ai\
├── models.py        # 模型管理器（单例，线程安全）
├── server.py        # FastAPI + Gradio 主服务
├── mcp_server.py    # MCP Server（stdio）
├── install.py       # 一键安装依赖
└── README.md        # 项目文档
```

---

## v0.2 流式输出 + 互斥加载 (2026-04-29)

### 目标
流式打字机效果 + LLM 互斥加载 + MCP 共享实例

### 技术变更

1. **流式输出 (`chat_stream()`)**
   - 原理：OpenVINO GenAI 的 `streamer` 回调 + `queue.Queue` + 独立线程
   - 模型生成每个 token → 放入队列 → Gradio generator 逐个 yield
   - 思维链过滤：缓冲 token，检测 `<think...>` 标签，过滤后再输出
   - 降级策略：如果 `streamer` 参数不支持，回退到非流式一次性输出

2. **LLM 互斥加载**
   - 原因：NPU 显存有限，1.5B + 8B 同时加载会爆
   - 实现：`load()` 方法加载新 LLM 前自动卸载其他 LLM
   - OCR 不受影响（走 CPU）

3. **MCP → HTTP API**
   - 原来：MCP Server 自己加载模型（和网页不共享）
   - 改为：MCP Server 通过 HTTP 调用 `localhost:8976` 的 API
   - 好处：网页和 MCP 共享同一个模型实例，加载一次两个都能用

### 踩坑记录

1. **思维链泄露**
   - DeepSeek R1 模型会输出推理过程（有时有 `<think` 标签，有时没有）
   - `_strip_think()` 用正则过滤，流式模式用缓冲区检测
   - 问题：1.5B 小模型有时不用标准标签，直接把推理混在回复里 → v0.3 继续修

### 架构图

```
用户浏览器 ──→ server.py (FastAPI+Gradio, :8976)
                    │
                    ├── ModelManager (单例)
                    │     ├── LLM (NPU, 互斥)
                    │     └── OCR (CPU, 常驻)
                    │
小虾(云端) ──→ mcp_server.py ──→ HTTP API ──→ server.py
```

---

## v0.3 UI 优化 + 思维链分离 (2026-04-30)

### 目标
思维链分离 + 模型联动 + tag 统计 + 设置页

### 任务清单
- [x] 思维链分离（思考折叠 + 回复正文）
- [x] 统计信息 tag 化 `model` `X字` `Xs` `X字/s`
- [x] 模型选择联动（只显示已加载的）
- [x] 设置选项卡（模型管理 + 环境信息，替代旧状态 Tab）

### 技术变更

1. **chat_stream() 结构化输出**
   - 原来直接 yield 字符串，改为 yield `(phase, content)` 元组
   - phase: "think" = 思维链内容（完整一次性），"text" = 正式回复（逐 token）
   - 思维链检测逻辑不变，但输出分阶段
   - 新增 `get_loaded_llms()` 方法

2. **chat_fn 思维链分离**
   - think 阶段显示 `*[thinking...]*`
   - think 结束后用 `<details><summary>` 折叠展示
   - response 阶段流式输出在折叠下方
   - 最终追加统计标签：`` `model` `X字` `Xs` `X字/s` ``

3. **模型选择联动**
   - Dropdown 动态读取 `get_loaded_llms()`
   - 加载/卸载模型时自动刷新 Dropdown choices
   - 未选择模型时提示"请先在设置页加载模型"
   - 使用 `gr.update(choices=..., value=...)` 更新

4. **设置选项卡**
   - 替代旧的"状态"Tab
   - 模型管理区：加载/卸载按钮 + 状态文本
   - 环境信息区：版本/端口/日志/推理框架
   - 加载/卸载操作联动更新对话 Tab 的模型下拉框

### 踩坑记录

1. **无标签思维链泄露（v0.3 首轮测试发现）**
   - 问题：DeepSeek 1.5B 经常不使用 `<think...>` 标签，直接把英文推理过程混在正文输出
   - 现象：用户看到几百字的英文推理 "Okay, so the user just said..." 后面才有一句正式回复
   - 根因：chat_stream() 的 think 检测只看 `<think` 标签，无标签时 buffer > 60 字符就直接当正文输出
   - 修复：新增启发式检测 `_looks_like_thinking()` + `_split_think_response()`
     - 18 条正则模式匹配推理语言（"Okay, so..."、"I should..."、"Let me..."、"The user..." 等）
     - 流式缓冲阶段：如果 buffer 像推理，继续缓冲等分割线；如果不像推理，直接输出
     - 最终兜底：生成结束时如果 buffer 全是推理内容，整体当 think 处理
   - 局限：启发式不是 100% 准确，可能误判某些英文正文为推理；但对 1.5B 模型的典型输出模式足够有效

2. **对话历史污染（v0.3 二轮测试发现）**
   - 问题：上一轮回复的统计标签（`deepseek-1.5b` `15字` `5.8s`）被当成历史传给模型
   - 现象：模型开始重复统计标签、引用上轮回复内容、甚至把标签当问题来回答
   - 根因：chat_fn 直接把 Gradio history 传给 chat_stream()，没清理元数据
   - 修复：新增 `_clean_history_for_model()` 函数，传历史前先移除统计标签和 `<details>` 折叠块

3. **启发式检测模式不足（v0.3 二轮测试发现）**
   - 问题：扩展测试发现更多漏检模式
   - 新增覆盖："Alright, the..." / "I know that..." / "Keeping it..." / "It seems..." 等英文模式
   - 新增中文推理模式："用户说/问/发" / "首先" / "接下来" / "综合来看" / "所以" / "我觉得" 等
   - 模式从 18 条扩展到 48 条，11 个测试用例全部通过

### 关键文件

```
C:\tmp\_local-ai\
|-- models.py        # v0.3: chat_stream yield 元组, get_loaded_llms()
|-- server.py        # v0.3: 思维链分离, tag统计, 联动, 设置Tab
|-- mcp_server.py    # 未改动（MCP 用 api_chat 走非流式）
```

### 开发笔记
（开发过程中持续更新）

---

## 设计决策：双层记忆架构 (2026-04-30)

### 背景
小模型上下文有限（1.5B ~32K, 8B ~64K），聊一天就爆；没有持久记忆，每次重启都是陌生人。

### 方案
双层记忆 = 小册子（永久） + 滑动窗口（短期） + 压缩机制（旧对话提炼为知识）

### 小册子设计
- 身份卡 ~200 token / 用户画像 ~300 / 关键事实 ~500 / 技能清单 ~200 / 近期摘要 ~500
- 总计 ~1700 token 作为 system prompt 注入
- 存储：JSON 文件，在工作空间目录

### 压缩策略
- 在线：云端教师摘要（高质量）
- 离线：本地自摘要（1.5B 可能丢细节）
- 触发：token > 上下文长度的 60%
- 流程：超阈值 -> 压缩旧对话 -> 提取关键信息写入小册子 -> 替换为摘要

### 版本衔接
- v0.4：滑动窗口（硬截断保底）
- v0.4.5：小册子系统（pet_notebook.py）
- v0.5：云端压缩
- v0.6：小册子 <-> 面板联动
- v0.7：离线自压缩

---

## 技术栈速查

| 依赖 | 版本 | 用途 |
|------|------|------|
| Python | 3.14 | 运行时 |
| FastAPI | latest | Web 框架 |
| Gradio | 6.13 | 聊天 UI |
| openvino-genai | latest | NPU 推理 |
| rapidocr-openvino | latest | OCR |
| mcp | latest | MCP 协议 |
| uvicorn | latest | ASGI 服务器 |

## 开发约定

- 临时文件放 `C:\tmp\`
- 日志输出到 `C:\tmp\_local-ai\server.log`
- 模型目录 `C:\tmp\_models\`
- 不用 emoji（Windows GBK 兼容）
- 不用 ASCII 框图（会错位），用 Mermaid
- 修改文件前先 Read
- 脚本必须显示进度
- **版本变更记录**：`changelogs/v0.x.x.md`（v0.5.2 起）

---

## v0.5.4 响应过滤器 + Prompt 优化 (2026-04-30)

### 目标
降低小模型幻觉和截断问题，提升输出完整性

### 技术变更

1. **`response_filter.py`（新模块）**
   - 纯文本后处理分析器，不依赖特定模型
   - 4 个检测器：代码幻觉/未闭合结构/思考外泄/重复段落
   - 集成到 SSE 管道：生成结束后运行，有警告发 `filter` 事件
   - 前端渲染黄色 ⚠️ 标签

2. **System Prompt 优化**
   - 旧：1 句笼统指令
   - 新：4 条硬规则（不复述/ASCII变量名/修bug直接给代码/简洁优先）
   - 通用性：规则基于行为约束，与模型大小无关

3. **截断检测增强**
   - 新增 3 条检测规则：空代码块、尾部空块、自言自语结尾
   - 解决 v0.5.2 遗漏的"偶数个 ``` 但内容为空"问题

### 设计决策

- **过滤器不修改原文**：只标注，不自动修复。原因：小模型输出可能上下文敏感，自动修复可能引入更多问题
- **规则而非启发式**：system prompt 用硬规则而非"建议"格式，小模型对明确的指令服从度更高
- **空代码块检测**：qwen3-8B 的典型截断模式——模型说"应该是：\n```\n```"就停了，``` 是偶数个但代码块为空

---

## v0.5.3 标签优化 + 6项修复 (2026-04-30)

### 目标
修复模型管理 UI 和前端体验问题

### 踩坑记录

1. **`sel` 变量重复声明**
   - 在 `refreshStatus()` 中添加 try-catch 后，`const sel` 出现了两次
   - 修复：重写整个函数，确保单次声明

2. **两个 DOMContentLoaded 监听器**
   - 新增滚动检测的监听器和 OCR 拖拽的监听器分开了
   - 修复：合并为一个

3. **Session 删除链 _014→_018**
   - 后端 `api_chats_delete` 调用了 `_new_chat_file()`
   - 修复：去掉自动新建，只重置 `_current_chat_file[0] = None`

---

## v0.5.2 自动续写 (2026-04-30)

### 目标
解决模型输出截断问题

### 踩坑记录

1. **截断检测遗漏**
   - 最初只检测 ``` 奇数（未闭合），但模型可能输出偶数个 ``` 却内容不完整
   - v0.5.4 才真正解决（空代码块检测）

2. **续写衔接**
   - 直接追加"继续"会导致上下文断裂
   - 修复：先闭合代码块 → 加分隔 → 构建续写历史（原始历史+用户消息+已有回复+"继续"）

---

*最后更新: 2026-05-16 by 小虾（Session 009: 5 轮真实对话测试方案设计 + 脚本编写）*

---

## v0.6 实际开发 (2026-05-15)

### 完成概览

从 v0.6 规划到落地，一天内完成 8 个大任务 + 5 轮 bug 修复（33 个 bug），回归测试 59/59 全通过。

### 8 个核心任务

| # | 任务 | 关键文件 | 状态 |
|---|------|---------|------|
| 1 | Session 互锁 | `index.html` | done |
| 2 | 智能任务分类器 | `task_classifier.py` | done (v1→v3) |
| 3 | 话题漂移检测 | `task_classifier.py` | done |
| 4 | 模型 ZIP 导入 | `server.py` + `index.html` | done |
| 5 | 环境适配 + 设备切换 | `env_check.py` + `models.py` + `index.html` | done |
| 6 | 云端模型接入 | `cloud_provider.py` + `index.html` | done |
| 7 | 云端蒸馏 | `distill.py` | done |
| 8 | UI 打磨 | `index.html` | done |

### 架构演进

```
用户浏览器 ──→ server.py (FastAPI, :8976)
                    │
                    ├── ModelManager (单例, 线程安全)
                    │     ├── LLM (NPU, 互斥加载)
                    │     └── OCR (CPU, 常驻)
                    │
                    ├── task_classifier.py  ← 新增：加权关键词评分 + 漂移检测
                    ├── cloud_provider.py   ← 新增：OpenAI 兼容云端客户端
                    ├── response_filter.py  ← 新增：响应质量后处理
                    ├── context_compressor.py ← 新增：上下文压缩
                    ├── distill.py          ← 新增：云端蒸馏
                    ├── pet_notebook.py     ← 新增：小册子
                    └── env_check.py        ← 新增：环境检测
```

### 5 轮 Bug 修复摘要

| 轮次 | 数量 | 典型问题 |
|------|------|---------|
| 第1轮 | 9 个 | Session 锁定未释放、停止按钮无响应、const 重复声明、智谱 API 路径 404 |
| 第2轮 | 7 个 | 在线/离线切换无确认、云端消息标签重复、蒸馏按钮说明不清 |
| 第3轮 | 5 个 | 分类器"写一个"被归为 code、"为什么"误触 reasoning、system prompt 缺中文约束 |
| 第4轮 | 5 个 | think 标签泄漏、分类器 v2 全面重写、上下文隔离 |
| 第5轮 | 1 个 | 启动时 API Key 误判 |

### 分类器迭代

| 版本 | 准确率 | 测试用例 | 关键改进 |
|------|--------|---------|---------|
| v1 | ~80% | 14 | 基础加权关键词 |
| v2 | ~84% | 64 | 移除泛词，新增覆盖 |
| v3 | 100% | 156 | 强信号正则优先锁定，CODE>MATH>TEXT 顺序 |

### 设计决策

- **不走微服务**：本地单用户应用，模块化单进程足够，每个 .py 自己管版本
- **过滤器只标注不修改**：小模型输出上下文敏感，自动修复可能引入更多问题（v0.6.1 改为也做清理）
- **分类器纯函数**：无类、无外部依赖、微秒级延迟

---

## v0.6.1 模块化版本管理 + 核心模块 v1.0 重写 (2026-05-15)

### 目标
1. 版本号从"server 集中管理"改为"版本跟着模块走"
2. response_filter.py 从 v0.1 升级到 v1.0（实际可用）
3. context_compressor.py 从 v0.1 升级到 v1.0（实际可用）

### 版本管理重构

**Before**: `server.py` 硬编码 `CLASSIFIER_VERSION`，其他模块版本靠手动同步

**After**: 每个模块自己定义 `__version__`，`/api/info` 动态收集

```python
# server.py /api/info 端点
@app.get("/api/info")
def api_info():
    modules = {}
    for mod_name in ("task_classifier", "response_filter", "cloud_provider",
                     "context_compressor", "pet_notebook", "models"):
        try:
            mod = __import__(mod_name)
            modules[mod_name] = getattr(mod, "__version__", "?")
        except ImportError:
            pass
    return {"version": f"{VERSION}.{VERSION_PATCH}", "modules": modules}
```

| 模块 | 版本 | 说明 |
|------|------|------|
| server | v0.6 patch 1 | 主服务，管理全局版本 |
| task_classifier | v3 | 分类器（3 次迭代） |
| response_filter | v1.0 | 响应过滤器（从 v0.1 完全重写） |
| context_compressor | v1.0 | 上下文压缩器（从 v0.1 完全重写） |
| cloud_provider | v0.2 | 云端客户端 |
| pet_notebook | v1.0 | 小册子 |
| models | v1.0 | 模型管理器 |

### response_filter.py v1.0 重写

**v0.1 → v1.0，从"只标注不修改"进化到"标注 + 清理"**

#### 修复的 Bug

| Bug | 根因 | 修复 |
|-----|------|------|
| 代码幻觉检测遍历中 remove | 经典 ConcurrentModification bug | 预计算 comment_lines set + string_ranges |
| 前缀清理正则 `[一下二下的]?` | 字符类匹配单个字符而非"一下" | 改为 `(一下\|下\|一番)?` |
| 句子级删除太贪婪 | `^(好的\|...).*?[。！？]` 删掉了含有效内容的第一句 | 多轮词组级清理策略 |
| 残留标点 | 删完"没问题，我来解释一下"后留下"。" | 最终 cleanup pass 清理开头标点 |

#### 新增功能

1. **不完整输出检测** — 空回复 / 截断（末尾是"的"/"了"/"着"） / 缺少结尾标点
2. **N-gram 语义重复** — 3-gram Jaccard >0.6 视为重复段落
3. **思考外泄分级** — 强信号（阈值低）+ 弱信号（阈值高），代码块内容排除
4. **多轮前缀清理** — 客套词 → 分析前缀 → 残留标点，三轮迭代
5. **未闭合 Markdown 粗体检测** — `**xxx` 缺配对

### context_compressor.py v1.0 重写

**v0.1 → v1.0，从"粗暴截断"进化到"智能压缩"**

#### 关键改进

| 改进 | Before | After |
|------|--------|-------|
| 代码压缩 | 不区分注释和字符串内 # | 安全区分：保留 docstring / 装饰器 / TODO / FIXME / def / class / return |
| 文本压缩 | 中文关键词 | +英文关键词 + 废话句过滤 |
| 压缩顺序 | `insert(0)` O(n^2) | `append` + `reverse` O(n) |
| 极端压缩 | 无 | `_make_one_line_summary()` |
| 代码块判断 | >50% 算代码 | >40% 算代码（更灵敏） |
| 日志 | 无压缩率 | 显示压缩比百分比 |
| 受保护轮次 | 无 | 最近 2 轮完整保留 |

### 前端更新

- 环境信息表：动态渲染所有模块版本（中文名映射）
- 模块中文名：分类器/响应过滤器/云端客户端/压缩器/小册子/模型管理

### 踩坑记录

1. **EBUSY 文件锁定** — context_compressor.py 编辑时被短暂锁定，换不同字符串匹配后成功
2. **正则字符类 vs 分组** — `[一下二下的]?` 匹配的是 "一"、"下"、"二"、"的" 中的单个字符，不是 "一下"。教训：要匹配固定词组用 `(一下|下)` 分组
3. **句子级删除的陷阱** — `^(好的|没问题).*?[。！？]` 看起来只删一句，但如果内容句紧跟在后面，`.*?[。！？]` 的非贪婪匹配可能只删到第一个句号而丢失"好的"后面的实际内容。改用词组级删除更安全

---

## v0.6 规划阶段 (2026-05-01)

### 前置分析

#### Session 质量分析（chats/2026-05-01_002.json）

对一次 4 轮翻译写作对话做了质量分析，发现：

1. **思考冗余**（最严重）
   - 第 1 轮：1348 字符思考 vs 299 字符正文（思考占比 82%）
   - 第 2 轮：824 字符思考 vs 986 字符正文
   - 思考内容大量自我确认循环，对输出无实质帮助
   - 速度影响：有思考 18-21 chars/s，无思考 34 chars/s（差距近一倍）

2. **第 4 轮指令理解偏差**
   - 用户说"转成 todo"，模型理解为"写信步骤"而非"提取行动项"
   - 小模型对歧义指令的上下文理解能力有限

3. **v0.5.6 空思考标签修复验证通过**
   - 第 3 轮 `think_chars: 0`，无幻觉内容，三重 bug 未复现

#### Benchmark #9 新增

在 `benchmark.py` 中新增"多轮翻译写作"测试用例（4 轮），评分维度：
- 翻译质量（关键词覆盖）
- 信函格式（Subject/称呼/签名）
- 回信互文性
- **行动项提取 vs 写信步骤**（专测第 4 轮的理解偏差问题）

### 任务分类器设计

#### 技术调研

| 方案 | 延迟 | 准确率 | 复杂度 | 结论 |
|------|------|--------|--------|------|
| 加权关键词评分 | 0ms | ~80% | 低 | **采用** — 覆盖日常办公场景足够 |
| LLM 分类 | 2-3s | ~95% | 中 | 不采用 — 多一次调用，违背提速初衷 |
| BERT 微分类器 (vLLM Semantic Router) | <50ms CPU | ~90% | 高 | 过度设计 — 需要额外模型、依赖链 |
| Embedding 相似度 | ~100ms | ~85% | 中 | 过度设计 — 需要向量库 |

#### Qwen3 思考控制

确认 Qwen3 原生支持 `/no_think` 和 `/think` 指令：
- system prompt 或消息末尾追加 `/no_think` → 完全关闭思考
- 实测效果：翻译类 19 chars/s → 34 chars/s（+78%）
- 无需模型参数变更，纯 prompt 级控制

#### 分类策略

| 任务类型 | 思考控制 | temperature | 适用场景 |
|----------|----------|-------------|----------|
| reasoning | 不限制（full think） | 0.6 | 数学/逻辑/分析/因果推理 |
| code | "思考控制在30字内" | 0.5 | 编程/debug/重构/脚本生成 |
| text（默认 fallback 为 code） | `/no_think` | 0.4 | 翻译/摘要/改写/列表/格式化 |

**上下文继承**：最近 assistant 回复含 `` ``` `` 时，后续消息自动继承 code 分类。

#### 实现计划

- 新增 `task_classifier.py`（纯函数，无类、无依赖）
- `models.py` 的 `_build_prompt()` 集成：分类 → 注入对应指令 → 微调 temperature
- `server.py` SSE 透传 `task_type` 事件
- `index.html` 状态栏展示当前任务类型标签

### 文件变更

| 文件 | 变更 |
|------|------|
| `benchmark.py` | +Test #9 多轮翻译写作测试（4轮 + 专用评分函数） |
| `v0.6-plan.md` | +任务 7 智能任务分类器（含算法设计 + Qwen3 思考控制方案） |
| `ROADMAP.md` | v0.6 任务表 +任务分类器 + Session 互锁 |
| `DEVLOG.md` | +v0.6 规划阶段记录 |

---

## v0.6.2 Bug 修复（2026-05-15）

> Session 008 暴露了 9 个问题，从 🔴 Pipe 腐化到 🟢 标签显示错误，全量修复。

### 问题清单与修复

| # | 严重度 | 问题 | 根因 | 修复 |
|---|--------|------|------|------|
| 1 | 🔴 | Pipe 腐化导致连续空回复 | `LLMPipeline.generate()` 瞬间返回不调用 streamer | 0-token 检测 + 自动卸载重载 + 重试 |
| 2 | 🔴 | Think 标签未闭合，318字推理泄漏为正文 | `<think...>` 无闭合标签，内容直接输出 | `_looks_like_reasoning()` 启发式 + fold |
| 3 | 🟡 | Think 占满 max_tokens，无正文 | reasoning 消耗全部 token，body 为空 | body 缺失续写：追加 `/no_think` 再生成 |
| 4 | 🟡 | 空回复无任何用户提示 | SSE 瞬间结束，前端无消息 | yield `{"type": "error"}` SSE 事件 |
| 5 | 🟡 | Cloud 响应极慢 | 智谱 coding 端点行为不同 | → **v0.4 重构，见下方** |
| 6 | 🟢 | Cloud 标签显示 "cloud" 而非模型名 | 硬编码 fallback | 使用 `config["model"]` 实际值 |
| 7 | 🟢 | 推理耗尽 max_tokens → 截断 | 无检测机制 | 正文缺失检测 + 自动续写 |
| 8 | 🟢 | Cloud 跳过分类器 | cloud 路径无 classify_task | 添加分类器调用 |
| 9 | 🟢 | Prompt 不对齐 | models.py 和 cloud_provider 规则不同 | 5 条规则统一 |

### Pipe 空输出检测机制

```
正常流程：pipe.generate() → streamer callback 逐 token → queue → yield
腐化流程：pipe.generate() → 瞬间返回 → queue 无 token → 空回复

修复：
  1. 检测：full_output 为空且无 stall 且无 error → pipe 可能腐化
  2. 自动重载：unload → sleep(0.5) → load → 重建 prompt → continue 重试
  3. 重试耗尽：yield [ERROR] 让用户刷新/重启
```

### Dangling Think 标签处理

```
输入：<think\n嗯，用户之前让我帮忙...（318字推理内容，无闭合标签）
错误行为：推理内容直接输出为正文
正确行为：
  1. 检测到未闭合 think 标签 + _looks_like_reasoning() 判定为推理
  2. yield ("fold", reasoning_content) 折叠
  3. total_chars = 0 触发正文缺失续写
```

### Cloud Provider v0.3 → v0.4 设计反思

**v0.3 的错误思路**：检测到 `/coding` 就自动改成通用端点。问题是用户可能就是想用 coding 端点——它可能有不同的计费模型、不同的功能集，代码不能替用户做这个决定。

**v0.4 的正确思路**：
- 用户配的 Base URL **神圣不可侵犯**，只补全 `/chat/completions` 路径
- `/coding`、`/paas`、`/xxxx` 这些路径段 100% 原样使用
- 请求失败 → 错误消息引导用户检查配置，不猜测不 fallback
- 错误消息明确标注当前 URL，方便用户排查

### 文件变更

| 文件 | 变更 |
|------|------|
| `models.py` | +Pipe 空输出检测+自动重载、+`_looks_like_reasoning()` dangling think fold |
| `server.py` | VERSION_PATCH→2、空回复 error 事件、错误不保存历史、正文缺失续写、cloud 分类器+模型名 |
| `cloud_provider.py` | v0.4：去掉 fallback/coding 修正，用户 URL 100% 原样使用，错误引导用户检查 |
| `test_v062_multi_turn.py` | 37 个测试用例覆盖全部修复点，100% 通过 |

### 测试

```
37/37 通过
覆盖：URL 补全（6）+ 推理检测（5）+ 模型名（1）+ Think 标签（3）
     + 版本号（5）+ 多轮对话（5）+ Pipe 防御（4）+ 空回复（4）
     + Cloud 分类器（2）+ Prompt 对齐（2）
```

---

## v0.6.2 真实测试准备 (2026-05-16)

### 目标
设计并编写 5 轮真实对话测试方案，验证 Pipe 空输出恢复、Think fold、续写等机制在真实 NPU 推理环境下能否跑通。

### 测试方案设计

5 轮渐进式测试，每轮验证不同机制：

| Round | 场景 | 验证重点 | 期望分类 |
|-------|------|---------|---------|
| 1 | 简单问答 | 基本对话 + 无 ERROR | text |
| 2 | 数学推理 | Think fold + 思考内容 | reasoning |
| 3 | 代码生成 | 代码块闭合 + 自动续写 | code |
| 4 | 上下文引用 | 多轮历史传递 | code（继承） |
| 5 | 长输出 | Pipe 稳定性 + 输出完整性 | text |

### 每轮检查项

1. 模型产生响应（非空）
2. 无 ERROR 事件（Pipe 腐化/超时等）
3. 有 done 事件（正常结束）
4. 任务分类正确（text/code/reasoning）
5. 响应长度满足最低要求
6. Think fold 事件（reasoning 类型）
7. 代码块闭合（code 类型）
8. 响应时间合理
9. Pipe 自动恢复检测（异常触发时的恢复提示）

### 文件变更

| 文件 | 变更 |
|------|------|
| `test_live_5rounds.py` | 新增：5 轮真实对话自动化测试脚本 |
| `SESSION_HANDOFF.md` | 更新：Session 009 状态 + 测试方案 |
| `DEVLOG.md` | 追加：v0.6.2 真实测试准备记录 |

### 使用方法

```bash
# 1. 启动服务
python server.py

# 2. 在浏览器设置页加载模型（或在另一个终端）
curl -X POST http://127.0.0.1:8976/api/load/qwen3-8b

# 3. 运行测试
python test_live_5rounds.py
python test_live_5rounds.py --model qwen3-8b
```

### 踩坑记录

1. **测试脚本设计**：最初考虑直接调用 models.py，但这样绕过了 server.py 的 SSE 管道（续写、filter、session 保存等）。改为通过 HTTP API 调用，覆盖完整链路。
2. **历史传递**：测试脚本维护一个 history 列表，每轮追加 user+assistant 消息。这模拟了真实的多轮对话场景。
3. **SSE 解析**：需要正确处理 `data: [DONE]` 结束标记和 JSON 解析异常。

---

## v0.8 patch 规划阶段 (2026-05-17)

### 背景

v0.8 全部功能已完成（Skill 框架+权限+审计+训练+角色面板+反馈+离线压缩，54项集成测试全通过）。

在第三方视角分析过程中，输出了两个文档：
- `v0.8_PATCH_ISSUES.md` — v0.8 patch 问题清单（22项，含优先级排序）
- `v0.8_CAPABILITY_GAP_ANALYSIS.md` — 功能实用性缺口分析（6个办公场景逐个过）

### 关键发现

1. **PDF 是最大功能缺口** — 办公最常见格式，代码里只有图标没有实现
2. **Excel 读取已实现但架构不一致** — server.py 内嵌 `_read_excel()`，不是 Skill，无权限/审计
3. **录音纪要有完整方案** — MediaRecorder + 分块缓冲 + Whisper，准实时全程本地
4. **web-search 已有实现** — `skills/builtin/web-search/` + `web-reader/`，误以为缺口
5. **版本号不一致** — `task_classifier.py` 写 v7，`SESSION_HANDOFF.md` 写 v5

### 核心规划决策

#### 记忆 Tab 独立（P1）

**现状问题**：
- `tab-knowledge`（知识库）前端混合展示 facts（列表）+ glossary（字典）
- 两套存储底层分离，但用户感知是同一类数据
- Tab 名称"知识库"与 v1.1 的"知识库 RAG"混淆

**改进方案**：
- Tab 改名：**"记忆"**
- 存储合并：`facts` + `glossary` → 统一 `memory` 列表，每条 `{type, content, source, date}`
- 前端支持：查看列表 / 新增 / 编辑 / 删除，可按来源筛选
- 与即时纠正打通：选中 AI 回复文字 → 纠正内容直接写入记忆

#### Prompt 双引擎

机器端已有：task_classifier.py (v7) + response_filter.py (7个检测器) + 幻觉检测
用户端新增三种方式（推荐度排序）：

| 方式 | 推荐度 | 说明 |
|------|--------|------|
| 即时纠正（存记忆） | ★★★★★ | 选中文字 → "这里不对" → 存入统一记忆 |
| 记忆 Tab 手动管理 | ★★★★☆ | 长期积累，可手动增删改查 |
| Prompt 模板编辑器 | ★★★★☆ | 设置 Tab 内各场景 system prompt 可编辑 |
| 反馈 → Prompt 学习 | ★★★☆☆ | 点踩时弹出原因选项，数据导出分析 |

#### 已删除的功能（不纳入 v0.8）

- PPT 读取（8B 理解能力存疑）
- LoRA 微调（效果不明显，投入产出比低）
- 知识库 RAG（v1.1 再做）
- 剪贴板气泡 / 全局快捷键 / AI 主动询问 / 朗读回复（用户明确不要）
- 多文件对比（用户明确放弃）
- 流式转录"技术突破"（不存在，用分块缓冲即可）

### 文件变更

| 文件 | 变更 |
|------|------|
| `v0.8_PATCH_ISSUES.md` | 新建：22项 patch 问题清单 + 优先级排序表 |
| `v0.8_CAPABILITY_GAP_ANALYSIS.md` | 新建：6个办公场景分析 + Prompt双引擎设计 + 功能矩阵 |
| `ROADMAP.md` | 更新：小册子设计表（个人记忆合并）+ 三层记忆架构图 + 个人记忆设计章节 |
| `DEVLOG.md` | 追加：v0.8 patch 规划阶段日志 |

---

## v0.8 patch 文档补充 (2026-05-17)

### 本次更新

1. **ROADMAP.md** 新增"系统整体架构图"（零点五节）
   - 完整 mermaid 架构图：前端4Tab → 后端API → 核心模块 → Skill系统 → 三层记忆 → 数据层 → 教师通道
   - 所有模块间依赖关系清晰展示

2. **README.md** v0.8 全面重写
   - 从 v0.1 时代的简单说明 → 完整产品文档
   - 包含：快速开始、核心功能、系统架构、API速查、文件结构、版本历史

### 文件变更

| 文件 | 变更 |
|------|------|
| `ROADMAP.md` | 新增零点五"系统整体架构图" mermaid 大图，v22→v23 |
| `README.md` | 全面重写，v0.1→v0.8，完整产品文档 |
| `DEVLOG.md` | 追加本次更新记录 |

---

---

## v0.6.9-hotfix: 消息发送 P0 修复 (2026-05-19)

### 问题现象
消息从 UI 发出后消失，后端 `server.log` 无任何记录，模型零响应。

### 根因分析（三层）

**根因 1（前端）**: `index.html` 第 2021 行引用 `_refFilePath`，但该变量从未声明（无 `let`/`const`/`var`）。JS 严格模式下抛 `ReferenceError: _refFilePath is not defined`，`sendMessage` 在 `try` 块之前崩溃，导致：
- `append` 请求 ❌ 未发送
- `chat/stream` 请求 ❌ 未发送
- 后端日志 ❌ 零记录
- 前端 UI ✅ 已渲染（因为 UI 更新在 `try` 之前）

**根因 2（后端格式不兼容）**: `_new_chat_file()` 创建纯数组 `[]`，但 `api_chats_append()` 调用 `.setdefault()`（dict 方法），导致 `AttributeError` → HTTP 500。旧 v1 格式 chat JSON 文件同理。

**根因 3（Agent 误判）**: `_plan_iterations()` 中 `if scene_config.get("max_iterations"):` 把 `0` 当 falsy，`chat` 场景（`max_iterations=0`）错误进入 Agent 5 轮循环。

### 修复内容

| 文件 | 修复 | 影响 |
|------|------|------|
| `index.html` | `let _refFilePath = null;` + `function clearFileRef()` | **P0 根因修复**：消除 `ReferenceError`，消息正常发送 |
| `index.html` | `<link rel="icon" href="data:image/svg+xml,...🤖">` | 消除 `/favicon.ico` 404 |
| `server.py` | `_new_chat_file()` 写 `{"version": 2, "messages": []}` | 新会话格式 v2，兼容 append |
| `server.py` | `api_chats_append()` v1→v2 兼容 + 全程日志 | append 不再 500，日志可追踪 |
| `server.py` | `api_chat_stream()` 解析异常捕获 + 入口日志 | 请求失败不再零日志 |
| `agent.py` | `max_iterations is not None` | chat 场景不再误进 Agent 循环 |

### 验证结果

- curl `append` API：修复前 500，修复后返回 `{"ok":true,"msg_count":...}`
- curl `chat/stream`：正常返回 SSE 流
- 端到端：消息发送 → 后端日志记录 → 模型响应 → 前端渲染，全流程通过

---

*最后更新: 2026-05-19 v26 by slow & 小虾（v0.6.9-hotfix：消息发送 P0 修复 — 根因是 `_refFilePath` 未声明导致 JS 崩溃，网络请求未发出）*


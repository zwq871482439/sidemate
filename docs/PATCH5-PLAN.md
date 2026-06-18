# Patch 5 规划文档

> 版本：v0.9 Patch 5 | 日期：2026-06-11 | 状态：📋 规划中 | 更新：2026-06-13

## 一、总览

Patch 5 以**产品化提升**为主线，专注从"能用"到"好卖"的差距。P4 已完成基础产品化（ISS 品牌、EULA、关于对话框），P5 聚焦品牌视觉、更新机制、用户沟通和专业性信号。

**前置依赖**：P4 全部完成。

---

## 二、五批次

### Batch 1：品牌视觉

**目标**：建立完整的品牌视觉体系。

| 任务 | 说明 | 复杂度 |
|------|------|--------|
| 应用图标全套 | favicon 16/32/48/256 + SVG，覆盖任务栏/标题栏/桌面快捷方式/ISS | 中 |
| 桌面快捷方式图标 | ISS `[Icons]` 配置多尺寸 ico | 低 |
| SVG Logo 优化 | 现有 logo 适配暗色/亮色背景 | 低 |
| 品牌 CSS Token | 设计系统文档中已定义的品牌色，统一应用到所有 UI 元素 | 低 |
| 启动画面（Splash） | ISS 安装后的首次启动 loading 画面品牌化（可选，看 Go Launcher 支持情况） | 中 |

**产出物**：
- `static/img/favicon.ico`（多尺寸）
- `static/img/logo.svg`（亮/暗适配）
- `static/img/logo-16.png` / `logo-32.png` / `logo-48.png` / `logo-256.png`
- ISS 图标配置更新

### Batch 2：版本更新检查（slow：不做！！！）

**目标**：让用户知道有没有新版本，引导手动更新。

```
启动流程：
Go Launcher 启动 → FastAPI 就绪 → 前端 init() →
  后台异步 GET https://sidemate.app/api/latest-version
  → 对比当前版本
  → 有新版：设置页图标亮红点 + Toast 提示"有新版本 v0.10 可用"
  → 无新版：静默
```

| 任务 | 说明 |
|------|------|
| 远端版本 JSON | `{"latest":"0.10","url":"https://sidemate.app/download","notes":"- 新功能1\n- 修复xxx"}` |
| 前端检查逻辑 | 启动时异步 check，结果缓存在 localStorage（每天查一次） |
| 版本对比 | semver 简单对比（major.minor.patch） |
| UI 展示 | 设置页版本号旁显示"有更新"标记 + 点击查看 changelog |
| 离线容错 | 无网络时静默跳过，不影响正常使用 |
| 降级方案 | 如果暂时没有域名/服务器，先写好逻辑用本地 JSON mock |

**注意**：不做自动更新/自动下载，只做提示。用户自行去下载新版本 ISS。

### Batch 3：用户沟通 & 空状态优化

**目标**：改善用户引导和反馈体验。

| 任务 | 说明 |
|------|------|
| 空状态优化 — Chat | 首次进入 Chat 的欢迎消息优化（"开始你的第一次对话"） |
| 空状态优化 — KB | KB Tab 无文档时的友好引导（"上传你的第一份文档"） |
| 反馈渠道 | 设置页"反馈与支持"入口（邮箱 `mailto:` 或 GitHub issue 链接） |
| 错误反馈增强 | 错误卡片增加"复制错误信息"按钮 + "反馈此问题"链接 |
| CHANGELOG 展示 | 设置页新增"更新日志"Tab，展示最近 5 个版本的变更内容（从 CHANGELOG.md 读取） |

### Batch 4：专业性信号

**目标**：通过合规性和透明度建立信任。

| 任务 | 说明 |
|------|------|
| 隐私声明展示 | 设置页新增"隐私与安全"Tab，展示核心隐私要点（离线优先、数据不上传等） |
| 系统诊断信息 | 设置页展示运行环境：Python 版本、Ollama 版本、模型状态、GPU 信息、磁盘占用 |
| THIRD-PARTY 许可查看 | 关于对话框中增加"第三方许可"Tab，展示 THIRD-PARTY-NOTICES 内容 |
| 数据目录展示 | 设置页展示数据存储位置 + "打开文件夹"按钮 + 磁盘占用统计 |

**slow补充：还有个硬件平台兼容性问题，是目前只兼容win11+Intel ultra系列处理器，是否考虑多平台？**

### Batch 5：技术债务清理（Prompt & 配置体系）

**目标**：消除 Patch2-Patch4 迭代积累的技术债务，统一配置体系，减少混淆和硬编码。

> 来源：Patch4 Prompt 全量盘点发现的问题 + 同类排查 + P4 灰度测试暴露。

#### 5.1 V1/V2 双套策略配置合并

**现状**：`prompts.py` 里存在两套策略配置，职责重叠，维护成本高：

| 配置 | 位置 | 使用方 | 内容 |
|------|------|--------|------|
| `STRATEGY_CONFIG` (V1) | prompts.py:107 | `task_classifier.py` | `system_enhancement` + `temperature_offset` + `think_mode` |
| `STRATEGY_CONFIG_V2` | prompts.py:62 | `stream_engine.py` + `prompt_builder.py` | `system_enhancement` + `temperature_offset` + `think_mode` |

V1 负责策略路由判断（判断 code/math/greeting 等），V2 负责实际采样参数。两套配置的 `temperature_offset`/`think_mode` 容易不一致。

**方案**：合并为单一 `STRATEGY_CONFIG`，统一字段：
```python
STRATEGY_CONFIG = {
    "greeting": {
        "enhancement": "...",      # 合并 V1/V2 的 enhancement
        "temperature_offset": 0.1,
        "think_mode": "off",
    },
    ...
}
```
- 改 `task_classifier.py`、`stream_engine.py`、`prompt_builder.py` 三个调用方
- 删除 `STRATEGY_CONFIG_V2` 和 `STRATEGY_ENHANCEMENTS`

#### 5.2 全库硬编码值排查与统一

P4 已修复 `num_predict=4096` 等硬编码，P5 需系统排查同类问题：

| 排查范围 | 检查项 | 方法 |
|----------|--------|------|
| Token 限额 | `max_tokens`、`num_predict`、`max_output` 等数值 | grep 全库，确认都引用 config.py 常量 |
| 上下文窗口 | `context_window`、`max_history`、`max_input` 等 | 同上 |
| 超时时间 | `timeout=30`、`timeout=60` 等 | 确认是否应引用 config.py |
| 文件大小限制 | `10MB`、`max_file_size` 等 | 统一到 config.py |
| 分段参数 | `chunk_size`、`overlap` 等 | 确认 config.py 统一管理 |

#### 5.3 死代码 & 遗留代码清理

| 项目 | 位置 | 处理 |
|------|------|------|
| `get_module_info()` | prompts.py:276 | P4 已确认零调用，P5 删除 |
| `IDENTITY_PROMPT` | prompts.py | 检查是否仅 `get_module_info` 引用，若是则一起删 |
| V1 CHANGELOG 条目 | prompts.py:26-32 | 保留历史但标注 DEPRECATED |
| 其他零引用函数/变量 | 全库 | 用 grep + IDE 交叉确认 |

#### 5.4 Prompt 体系文档化

| 产出 | 说明 |
|------|------|
| Prompt 清单表 | 整理 P4 盘点的 22 个 prompt 为文档，标注消费对象、调用链路 |
| Prompt 变更规范 | 新增 prompt 时的命名约定、放置规则（统一 prompts.py）、消费方注释规范 |

#### 5.5 Prompt 回答质量优化（通用性）

**背景**：当前三栏（本地KB/云端AI/融合）prompt 各自为政，缺乏统一的"回答深度预期"，导致不同领域问题回答质量不均——中医概念输出百科长文，编程问题可能一句话打发。

**核心策略：问题复杂度分级 + 去重融合 + 结构化自适应**

##### 5.5.1 问题复杂度分级（P0，全局生效）

在 `task_classifier` 现有策略路由基础上扩展 `question_depth` 维度，传给三栏 prompt：

| 等级 | 触发条件 | 期望输出 | max_tokens | 结构化要求 |
|------|---------|---------|------------|-----------|
| `shallow` | 简单事实型："是什么""多远""怎么读" | ~200 字 | 300 | 自然段落，不列表不表格 |
| `medium` | 中等解释型："过程""区别""原因" | ~500 字 | 800 | 可列表，不表格 |
| `deep` | 复杂分析型："比较""评价"、多维度对比 | 不限 | 2000 | 鼓励表格（≥3 维度时） |

实现要点：
- 复用 `task_classifier.py` 的 LLM 分类（追加一个字段输出 `depth`），不额外增加推理调用
- 三栏各自 prompt 从 StreamContext 读取 `question_depth`，动态调整输出约束

##### 5.5.2 融合去重而非求全（P0）

> 注：本节已提前到 Patch4 文档Agent修复中实现（见 `PATCH4-DOCAGENT-FIX.md` 修复 6）。P5 不再重复。

##### 5.5.3 表格触发条件（P1）

| Prompt | 当前 | 改为 |
|--------|------|------|
| `CLOUD_KB_SYSTEM_PROMPT` | "如果涉及对比、分类，优先用表格" | "当涉及多维度对比（≥3 个维度）时，优先用表格" |
| 融合层 | 无约束，强塞表格 | "如果对比维度超过 3 个，用表格；否则用自然段落" |

##### 5.5.4 改动清单

| 文件 | 改动 |
|------|------|
| `prompts.py` | `CLOUD_KB_SYSTEM_PROMPT` 表格触发条件；`SYSTEM_PROMPT_V2` 深度信号注入 |
| `intelligence/task_classifier.py` | 扩展输出字段 + `question_depth` |
| `core/prompt_builder.py` | 从 StreamContext 读取 depth，动态注入 token/length 约束 |
| `pipelines/compare_pipeline.py` | 传递 depth 信号给融合阶段 |
| `core/cloud_engine.py` | `_build_messages` 接受 depth 信号 |

#### 5.6 网络抓取 TLS 指纹伪装（来自 P4 灰度测试）

**来源**：P4 灰度测试日志 `D:/新建文件夹 (4)/data/logs/server.log` 反复出现：
```
[WARNING] [SEARCH] curl_cffi 不可用，搜索将使用 httpx（无 TLS 指纹伪装，部分网站可能拦截）
[WARNING] [SEARCH] httpx 返回 403 — zhihu.com
[WARNING] [SEARCH] httpx 返回 403 — collinsdictionary.com
```

**问题**：`fetch_url` 用 httpx 直请求，知乎/词典站等识别出不是真浏览器，返回 403。导致 Agent 无法读取搜索结果正文，只能靠模型自身知识写文档。

**方案**：
- 升级 `curl_cffi` 依赖（模拟 Chrome TLS 指纹）
- `core/search_engine.py` 的 `fetch()` 优先用 curl_cffi，降级用 httpx
- 更新 `deps_check.py` + `build_full.py`

| 文件 | 改动 |
|------|------|
| `core/search_engine.py` | fetch() 改用 curl_cffi |
| `server/requirements.txt` | 加 curl_cffi |
| `core/deps_check.py` | 加 curl_cffi 检查 |
| `build_full.py` | 加 curl_cffi 到打包清单 |

#### 5.7 Splash 启动画面 logo.ico 加载失败（来自 P4 灰度测试）

**来源**：P4 灰度测试 launcher.log 反复出现：
```
[Splash] logo.ico 加载失败
[Tray] 使用 logo.ico 图标: ...\server\static\img\logo.ico（托盘正常）
```

**问题**：Splash 用的路径 `appDir\logo.ico`（根目录），打包后未正确包含；托盘用的 `server\static\img\logo.ico` 正常。

**方案**：
- 统一 Splash 和 Tray 的图标路径（都用 `server\static\img\logo.ico`）
- 或在 setup.iss 确保根目录 `logo.ico` 被打包
- 配合 Batch 1 品牌视觉一起做（多尺寸 favicon）

#### 5.8 云端模式 drift 检测重构（来自 P4 灰度测试）

**来源**：P4 灰度测试 `server.log` 反复出现 drift 误判：
```
[DRIFT] result={'drift': True, 'overlap': 0.0} — 用户重发同一句"给我总结一份关于兵棋推演方面的文档"
[DRIFT] result={'drift': True, 'overlap': 0.0} — "写完了吗"
[DRIFT] result={'drift': True, 'overlap': 0.0} — "继续"
```

**根因**：drift 检测（词重叠率统计）是给本地小模型（4B，16K 窗口）设计的，强加给云端大模型（128K+ 窗口）是架构错配。大模型记得清清楚楚，根本不需要这种统计判断。

**问题表现**：
- "继续"/"写完了吗" 被误判为新话题
- drift=True 触发"建议新建对话"，但代码没阻断 → 又开新一轮 doc 任务从零重写

**方案**：云端模式砍掉 drift 检测，改成上下文压缩 + 模型自主决策：
1. 云端模式不做 drift 检测（大模型自己知道话题变没变）
2. 上下文超 75% 时触发压缩（已有逻辑），压缩指令交给大模型决定
3. 本地模式保留 drift 检测（小模型真的需要）

| 文件 | 改动 |
|------|------|
| `session/context_cache.py` | drift 检测增加 ai_mode 判断，云端模式跳过 |
| `pipelines/cloud_pipeline.py` | 云端模式不读 drift 结果，直接走 agent loop |
| `routers/chat.py` | `_compress_cloud_history` 压缩指令交给大模型（prompt 化） |

**关联**：P4 文档Agent修复的"会话上下文注入"已能缓解此问题（模型看到 ongoing 文档自己判断）。本节是彻底根治。

#### 5.9 docx 转换器专业化（来自 P4 workspace 统一改造）

**来源**：P4 末尾讨论"workspace 统一设计"时发现，当前 `pipelines/doc_action.py:generate_docx()` 用自实现的 `_parse_markdown_to_sections()` 解析 Markdown，是个玩具实现：

- 只处理 `#` 和 `##`，不处理 `###`、`####`
- 不处理 `**粗体**`、`*斜体*`、`~~删除线~~` 内联格式
- 不处理列表（有序/无序/嵌套）
- 不处理代码块（```）
- 不处理表格、引用块、链接

导致模型写的复杂 Markdown（含 `### 4.1`、列表项、表格）被当作纯文本塞进 docx。

**问题表现**：用户看到的 docx 里直接出现 `### 4.1 异步优先` 这种 Markdown 源码，列表项没有 bullet 样式。

**方案**：引入专业 Markdown→DOCX 转换器替换自实现解析器：

| 候选库 | GitHub | 特点 | 评估 |
|--------|--------|------|------|
| **cnkang/markdown2docx** | https://github.com/cnkang/markdown2docx | 2025 年活跃维护，支持 H1-H6 + 内联格式 + 列表 + 表格 + 代码块 + 引用块 + 模板 | ⭐ 首选 |
| mddocx (PyPI) | https://pypi.org/project/mddocx/ | 命令行工具 + 批量转换 | 备选 |
| Pandoc | https://pandoc.org/ | 最强但需独立二进制（~100MB） | ❌ 离线打包负担重 |

**实施步骤**：

1. 评估 `markdown2docx` 依赖树（确认离线可打包）
2. 加入 `requirements.txt` + `deps_check.py`
3. 改 `pipelines/doc_action.py:generate_docx()` 用新库替换 `_parse_markdown_to_sections()`
4. 字体/字号/段距通过模板统一配置
5. ISS 打包加进去（`build_full.py` 依赖清单更新）

| 文件 | 改动 |
|------|------|
| `server/requirements.txt` | 加 markdown2docx |
| `server/core/deps_check.py` | 加 markdown2docx 检查 |
| `server/pipelines/doc_action.py` | `generate_docx()` 用新库替换 |
| `build_full.py` | 加 markdown2docx 到打包清单 |

**关联**：P4 workspace 统一改造后，模型用 `write_workspace` 写完整 Markdown，docx 质量完全依赖转换器。本节提供"最后一公里"保障。

#### 5.10 KB 引用令牌机制（来自 P4 通用工具讨论）

**来源**：P4 v3.1 讨论通用工具时，发现 `read_kb_doc`（模型主动读任意 KB 文档）会破坏"用户主动授权"的隐私铁律。

**核心矛盾**：
- 用户不想让模型直接看到 KB 全部文档（隐私）
- 但模型有时需要 KB 文档全文（不只片段）才能写好文档
- `search_kb` 只给片段，模型想看全文得反复换关键词搜

**方案：引用令牌（token-based authorization）**

```
KB 文档不能直接读，必须用户"发牌"。

用户在 UI 上点 KB 文档的"引用"按钮 → 系统把这篇文档标记为"本会话已授权"
模型只能调 read_kb_doc 读已授权的文档全文
未授权的文档返回"用户未授权此文档"
```

**工作流**：

| 步骤 | 谁 | 干啥 |
|------|-----|------|
| 1 | 用户 | 在输入框打字时，点 KB 文档的"引用"按钮 |
| 2 | 系统 | 把这篇文档加到 chat 的 `.kb_refs.json` 令牌列表 |
| 3 | 系统 | 注入 system prompt：「用户已授权以下 KB 文档全文：[文档名]」 |
| 4 | 模型 | 可以调 `read_kb_doc("已授权文档名")` 读全文 |
| 5 | 模型 | 调 `read_kb_doc("未授权文档名")` → 拒绝 |

**只对在线模式生效**：本地模式 KB 全文天然可见（本机推理无隐私边界）。

| 文件 | 改动 |
|------|------|
| `routers/chat.py` | 引用 API：用户点引用时把 doc_id 写入 chat 的 .kb_refs.json |
| `session/chat_store.py` | 加 kb_refs 管理（add/list/clear） |
| `core/agent_tools.py` | 新增 `read_kb_doc(doc_name)` 工具，执行时校验令牌 |
| `core/agent_loop.py` | read_kb_doc 执行分支 |
| `static/js/chat.js` | KB 引用按钮 UI 状态（已引用/未引用） |
| `static/css/main.css` | 引用按钮样式 |

**关联**：符合 P4 v3 隐私铁律——KB 全文必须用户主动授权，模型不能越界。

---

## 三、不做的事

| 项目 | 原因 |
|------|------|
| 自动更新/在线升级 | 安全风险高，离线场景不适用，留到 v1.1+ |
| 多语言 i18n | 当前用户群中文为主，v1.0 后考虑 |
| 在线账号系统 | 离线优先产品，不需要 |

---

## 四、预估工作量

| 批次 | 工作量 | 说明 |
|------|--------|------|
| Batch 1 | 2-3 天 | 图标设计 + 多格式输出 + ISS 适配 |
| Batch 2 | 0 天 | slow 标记不做 |
| Batch 3 | 2-3 天 | 空状态 + 反馈 + CHANGELOG |
| Batch 4 | 1-2 天 | 隐私/诊断/许可展示 |
| Batch 5 | 2-3 天 | 策略合并 + 硬编码排查 + 死代码清理 + 文档 + Prompt 回答质量优化 |
| **合计** | **7-12 天** | |

---

## 五、依赖

| 依赖项 | 说明 |
|--------|------|
| P4 完成 | 代码重构 + 首次引导 + 关于对话框基础 |
| 品牌素材 | 应用图标需要设计（可 AI 生成初版） |
| 远端服务器 | 版本检查需要一个可访问的 JSON 端点（可用 GitHub Pages 托管） |

---

## 六、P4 vs P5 产品化分工

| 产品化项 | P4（顺带做） | P5（专项做） |
|----------|:---:|:---:|
| ISS EULA 页 | ✅ | |
| ISS 品牌图 | ✅ | |
| LICENSE 打包 | ✅ | |
| 关于对话框 | ✅ | |
| 版本号展示优化 | ✅ | |
| 首次引导品牌感 | ✅ | |
| 应用图标全套 | | ✅ |
| 桌面快捷方式图标 | | ✅ |
| 启动画面品牌化 | | ✅ |
| 版本更新检查 | | ✅ |
| 空状态优化 | | ✅ |
| 反馈渠道 | | ✅ |
| CHANGELOG 展示 | | ✅ |
| 隐私声明 Tab | | ✅ |
| 系统诊断信息 | | ✅ |
| THIRD-PARTY 许可 Tab | | ✅ |
| 数据目录展示 | | ✅ |
| 技术债务清理 | | ✅ |

---

## Patch5 补充计划（2026-06-18 新增）

### 5.X 前端 UI 架构优化（来自 Patch4 v3.1 文案审查）

#### 5.X.1 进度面板完成后自然消失（不再持久化）

**现状**：`_docProgressTracker` 在 done 事件后被 `renderMessages` 全量重写冲掉，"完成"绿色面板闪现后消失。

**决策**：**不修了**。响应结束后用户已经看到稳定的"下载文档"按钮（来自 `_renderSingleMsg` 持久化的 `doc_url`），进度面板的历史使命已经完成，自然消失反而符合用户预期。

**依赖**：无（当前状态已经够用）

#### 5.X.2 工具链（AgentTimeline）独立刷新

**现状问题**：
- `appendStreamingMsg` 重写 `streamEl.innerHTML`，工具链作为子元素跟着被冲
- `renderMessages` 全量重写 `#messages`，工具链再次被冲
- token 流密集时（如 70 秒写文档），`agent_status` 事件可能被挤丢

**目标架构**：
```
#messages
├─ .msg (user)         ← append-only，不重写
├─ .msg (ai)           ← append-only
│  ├─ .agent-timeline  ← 永久驻留（仅 renderMessages 时创建一次）
│  ├─ .msg-body        ← token 流只更新这里
│  └─ .doc-download-bar
└─ #stream-msg         ← 临时流式容器，完成后迁移到上面的 .msg
```

**关键改动**：
- `appendStreamingMsg` 只更新 `.msg-body` 子元素，不动 `.agent-timeline`
- `_handleAgentStatus` 直接操作 `.agent-timeline` DOM（append 新 step）
- done 事件触发：固化 `#stream-msg` 为正式 `.msg` 节点，工具链保留
- 持久化的 `agent_timeline` 字段在 `renderMessages` 时一次性渲染（已有）

**复杂度**：高（重构 chat.js 流式渲染核心）
**建议**：跟 P5 整体前端重构一起做，不要单独 patch

### 5.X.3 多选 KB 文档 Token 估算显示

**需求**：用户多选文库文档时，实时显示 token 占用，让用户知道"这些文档够不够喂给模型"。

**等级**：
- < 20% 总上下文 → 低（绿色）
- 10% 以内 → 极低
- ~ 50% → 中（黄色）
- ~ 70% → 高（橙色）
- > 80% → 极高（红色）

**实现**：
- KB 选择器模态弹窗底部实时显示："已选 N 篇 · 约 12K tokens · 占用低（18%）"
- token 估算用 `total_chars / 1.5`（中文）或 `total_chars / 4`（英文）的粗略公式
- 切换在线/本地模式时，提示当前上下文窗口（如云端 1M vs 本地 16K）


---

## Patch5 补充：文件类型扩展（2026-06-19 新增）

### 5.Y.4 新增文件格式解析器

**目标**：让文库真正成为"本地知识库"，支持用户把各种文字内容扔进来。

**当前支持**：txt/md/csv/json/docx/xlsx/pdf/pptx（+代码文件 .py/.js/.html/.css/.xml/.yaml 等）

**新增格式（按优先级）**：

| 格式 | 扩展名 | 依赖包 | 用途 | 优先级 |
|------|--------|--------|------|--------|
| 电子书 | `.epub` | `ebooklib` | 电子书导入（最大需求）| P0 |
| 网页存档 | `.html` `.htm` | `beautifulsoup4` (已有) | 网页保存/导出 | P0 |
| 字幕 | `.srt` `.vtt` | 无（纯文本解析）| 视频/录音字幕 | P1 |
| 富文本 | `.rtf` | `striprtf` | 老 Word 文档 | P1 |
| LaTeX | `.tex` | 无（正则去标记）| 学术论文 | P2 |
| 邮件 | `.eml` | `email` (标准库) | 邮件存档 | P2 |
| Jupyter | `.ipynb` | `nbformat` | 代码笔记本 | P2 |
| Org-mode | `.org` | 无（简单解析）| Emacs 笔记 | P3 |
| reStructuredText | `.rst` | 无（简单解析）| Python 文档 | P3 |

**实施计划**：
1. P0（epub + html）：新增 `ebooklib` 依赖，html 用已有 `beautifulsoup4`
2. P1（srt + rtf）：srt 纯文本解析无需依赖，rtf 加 `striprtf`
3. P2-P3：按用户反馈优先级再决定

**实施位置**：`server/files/file_extractor.py` 的 `extract_text()` 函数

**依赖管理**：新增包加入 `python/requirements.txt` 和 ISS 打包清单

---

## Patch5 补充：权限系统升级（2026-06-19 新增）

### 5.Y.5 知识库权限 + 工具权限管理

**现状**：只有单一的 `kb_permission`（full/limited/none）控制 KB 访问。

**目标**：升级为细粒度的双层权限系统：

#### 第一层：知识库权限（现有 kb_permission 升级）

| 等级 | 行为 |
|------|------|
| 完全访问 | 模型可主动检索 KB，用户可引用 KB 文档 |
| 仅引用 | 模型不能主动检索，只有用户引用时才注入 |
| 关闭 | KB 完全不可见 |

#### 第二层：工具权限（新增）

控制 Agent 模式下模型能调用哪些工具：

| 工具 | 默认 | 可配置 |
|------|------|--------|
| `search_web` | 允许 | ✅ 可关闭（纯离线场景）|
| `fetch_url` | 允许 | ✅ 可关闭 |
| `search_kb` | 跟随 KB 权限 | ✅ |
| `write_workspace` | 允许 | ✅ 可关闭（只读模式）|
| `set_doc_status` | 允许 | ✅ |
| `read/delete/edit_workspace` | 允许 | ✅ |

#### UI 设计

设置页新增"权限管理"卡片：
- 知识库权限（3 档单选）
- 工具开关（每个工具一个 toggle）
- 预设模式：完全信任 / 谨慎模式 / 纯离线

**复杂度**：中等（需要后端 action_mode 解析 + 前端 toggle UI + 权限持久化）

---

## Patch5 补充：目录重构 + 技术债清理（2026-06-19 新增）

### 5.Y.6 目录重构

**原则**：`server/` 只放源码，`data/` 只放用户数据，配置文件放根目录。

#### 改动清单

| 当前位置 | 目标位置 | 说明 |
|---------|---------|------|
| `server/extensions/*.json` | `data/extensions/*.json` | 注册信息跟数据一起，装完自动写 |
| `server/extensions/registry.py` | `server/core/extension_manager.py` | 代码合并进 core |
| `server/files/file_extractor.py` | `server/knowledge/file_extractor.py` 或 `server/parsers/` | 跟 KB 强耦合，合并消除独立 files/ 目录 |
| `server/requirements.txt` | `C:\Sidemate\requirements.txt` | 移到根目录，跟 setup.iss 等配置放一起 |
| `server/data/` | `data/` | 提升到根目录，跟 server 平级 |

#### 重构后结构

```
C:\Sidemate\
├── server/                    ← 纯源码
│   ├── core/                  ← 核心逻辑（含 extension_manager）
│   ├── knowledge/             ← 知识库（含 file_extractor）
│   ├── pipelines/
│   ├── routers/
│   └── ...
├── data/                      ← 用户数据
│   ├── chats/
│   ├── kb/
│   ├── extensions/            ← 注册信息
│   └── logs/
├── models/                    ← 模型文件
├── requirements.txt           ← 依赖清单（开发用）
├── setup.iss                  ← 打包配置
└── Sidemate.exe
```

**复杂度**：中（大量 import 路径要改）
**风险**：中（路径变更可能引入隐藏 bug）
**建议**：P5 中期做，配合全面回归测试

### 5.Y.7 requirements.txt 清理

**现状**：`server/requirements.txt` 在打包后无用（嵌入式 Python + checksum 校验）
**处理**：
- 打包时不包含 requirements.txt（ISS 排除）
- 开发环境保留在项目根目录
- deps_check.py 的 manifest 是权威来源

### 5.Y.8 BM25 + 向量双路检索优化

**现状**：BM25 + bge-m3 向量 + Reranker 三路融合已实现
**优化方向**：
- bge-m3 自带 sparse 检索能力，未来可替代独立 BM25（减少 jieba 依赖）
- 当前 RRF 融合权重固定，可考虑按查询类型动态调整
- Reranker 精排质量验证（对比 v2-m3 vs 旧 base 的 NDCG）

**复杂度**：低（优化项，非必须）

### 5.Y.9 检索引擎统一为 bge-m3 dense+sparse（移除 BM25）

**用户决策**：既然用了 bge-m3，BM25 应该退役，embedder 挂了应该自恢复而不是降级。

**改动**：
- 移除 `_search_bm25` + jieba 依赖（减少 30MB 打包体积）
- 改用 `BGEM3FlagModel.encode(return_dense=True, return_sparse=True)`
- dense + sparse 内部加权融合（替代 RRF）
- 代码量减少约 200 行

**收益**：
- 去掉 jieba 分词（质量一般）
- bge-m3 sparse 基于 token 权重，比 BM25 关键词匹配更智能
- dense + sparse 同源，协同更好

### 5.Y.10 KB 引擎健康监控 + 自动恢复（不降级）

**用户决策**：embedder 挂了应该想办法恢复，不是静默降级到垃圾检索。

**改动**：
- 启动时 embedder 加载失败 → 触发 `restoreFromSnapshot()`（复用 Go Launcher 的依赖恢复机制）
- 运行时 embedder 异常 → 自动重试 3 次（间隔 1s）
- 仍失败 → 前端显示"知识库引擎离线"明确状态（不再静默降级到 BM25）
- 日志记录故障详情供诊断

**设计原则**：硬件/软件可能坏，但应用要能自救（跟 Go Launcher 环境自恢复同一套思路）

### 5.Y.11 KB 文档去重检测（导入时）

**触发场景**：用户上传与已有文档高度相似的内容（重传、轻微修改版本、复制粘贴）。

**检测机制**（双层级）：

| 层级 | 检测方式 | 阈值 | 触发动作 |
|------|---------|------|---------|
| L1 基础 | filename + file_size 完全相同 | 100% | 直接提示"文档已存在，是否覆盖？" |
| L2 内容 | 内容字符级相似度（difflib.SequenceMatcher）| **≥ 95%** | 提示"检测到高度相似文档（XX%），如何处理？" |

**L2 用户选项**：
- **保留两版**：正常导入，标记为"重复版本"
- **替换旧版**：删除旧文档 + 导入新版（保留新内容）
- **取消导入**：不导入

**实现位置**：
- `knowledge/ops.py` 的 `import_document()` 入口加检测
- `routers/kb.py` 的 upload 接口返回 `{"duplicate_detected": true, "similarity": 0.97, "existing_doc": "xxx.docx"}`
- 前端弹确认对话框

**注意**：
- L2 检测只对前 N 字符（如前 2000 字）做相似度，避免大文档全量比对卡顿
- 现有重复文档（如刮五指 2 份）不强制清理，由用户在前端手动删除

**复杂度**：低（difflib 是标准库，无需新依赖）

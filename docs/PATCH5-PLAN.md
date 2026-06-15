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

> 来源：Patch4 Prompt 全量盘点发现的问题 + 同类排查。

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

`MERGE_FUSION_PROMPT` 从"综合所有信息"改为"择优去重"：

```
本地和云端分别给出了回答。请生成一个精简融合版：
1. 核心事实以本地为准（有出处[1][2]）
2. 云端用于补充本地未覆盖的视角（如果有）
3. 两边都覆盖的内容只保留一份，优先本地
4. 如果两边信息本质相同，不要强行拼接
```

##### 5.5.3 表格触发条件（P1）

| Prompt | 当前 | 改为 |
|--------|------|------|
| `CLOUD_KB_SYSTEM_PROMPT` | "如果涉及对比、分类，优先用表格" | "当涉及多维度对比（≥3 个维度）时，优先用表格" |
| 融合层 | 无约束，强塞表格 | "如果对比维度超过 3 个，用表格；否则用自然段落" |

##### 5.5.4 改动清单

| 文件 | 改动 |
|------|------|
| `prompts.py` | `CLOUD_KB_SYSTEM_PROMPT` 表格触发条件；`MERGE_FUSION_PROMPT` 去重逻辑；`SYSTEM_PROMPT_V2` 深度信号注入 |
| `intelligence/task_classifier.py` | 扩展输出字段 + `question_depth` |
| `core/prompt_builder.py` | 从 StreamContext 读取 depth，动态注入 token/length 约束 |
| `pipelines/compare_pipeline.py` | 传递 depth 信号给融合阶段 |
| `core/cloud_engine.py` | `_build_messages` 接受 depth 信号 |

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

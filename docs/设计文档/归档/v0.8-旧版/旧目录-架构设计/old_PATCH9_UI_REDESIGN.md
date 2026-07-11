# PATCH 9 — 前端 UI 全面改版设计

> **设计文档** | 版本 1.0 | 2025-07-15

---

## 目录

- [A. 现状审计（逐 Tab 梳理）](#a-现状审计逐-tab-梳理)
- [B. 统一设计系统](#b-统一设计系统)
- [C. 各 Tab 重新设计](#c-各-tab-重新设计)
- [D. 后端 API 规范化](#d-后端-api-规范化)
- [E. 实施路线图](#e-实施路线图)

---

## A. 现状审计（逐 Tab 梳理）

### A1. 对话 Tab (`tab-chat`)

#### 功能列表
- 多会话对话管理（新建/切换/删除）
- SSE 流式对话（本地/云端双模式）
- 场景模式切换（聊天/写材料/写代码）
- 任务分类自动识别 + 手动切换（深思/工具/快速）
- 图片 OCR + 文件上传
- 思考过程折叠展示
- 话题漂移检测 + Session 膨胀提醒
- Agent 模式面板（工具调用步骤展示）
- 长文本分段处理面板
- 消息反馈（赞/踩 + 原因选择）
- 知识蒸馏（云端回答提炼到本地小册子）
- 分类切换对比（保留原回复，重新生成新版本）
- 对话上下文压缩提示
- 模型未加载遮罩
- KB 处理中锁定对话

#### UI 元素清单
| 元素 | 样式方式 | 备注 |
|------|----------|------|
| 工具栏 (.toolbar) | class | 模型标签 + 会话选择器 |
| 消息气泡 (.msg) | class | .user / .ai，内联 max-width:90% |
| 思考过程 (details) | class | 折叠展示 |
| 流式消息 (#stream-msg) | 动态创建 | 临时ID，finally时去除 |
| 任务分类标签 (.task-chip) | class | 按类型着色，可点击弹出 popover |
| 发送/停止按钮 | class (.btn-send/.btn-stop) | 互斥显示 |
| 图片/文件上传按钮 | class (.btn-img) | 触发隐藏 input |
| 场景选择器 (select) | 内联style | 3选项下拉 |
| 输入框 (textarea) | 内联style | 自动高度 |
| 跳到底部按钮 (#scrollBottomBtn) | class | 固定位置，有滚动时显示 |
| 漂移提示条 (.drift-bar) | class | 黄色背景，滑入动画 |
| Agent面板 (.agent-panel) | class | 紫色渐变头部 |
| 文件卡片 (.file-card) | class | 带图标+文件名+操作按钮 |
| 反馈按钮 (.fb-btn) | class | 赞/踩 |
| 模型未加载遮罩 (.chat-model-overlay) | class | 全覆盖对话区 |
| KB锁定遮罩 (#kbLockOverlay) | 内联+class | 黄色风格 |

#### 交互流程
```
用户输入 → sendMessage()
  → 检查模型状态/KB锁定
  → 文件/图片上传（如有）
  → 用户消息落盘 /api/chats/{name}/append
  → fetch SSE endpoint (/api/chat/stream 或 /api/chat/cloud/stream)
  → 流式解析事件: task_type → queue → token → fold → done → error
  → 节流渲染 appendStreamingMsg() (80ms间隔)
  → finally: 固化消息、恢复UI、刷新session列表
```

#### API 端点清单
| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/chat/stream` | POST | 本地模型SSE流 |
| `/api/chat/cloud/stream` | POST | 云端模型SSE流 |
| `/api/chats` | GET | 会话列表 |
| `/api/chats/new` | POST | 新建会话 |
| `/api/chats/switch` | POST | 切换会话 |
| `/api/chats/{name}` | DELETE | 删除会话 |
| `/api/chats/{name}/messages` | GET | 获取消息 |
| `/api/chats/{name}/append` | POST | 追加消息 |
| `/api/ocr_upload` | POST | OCR图片识别 |
| `/api/file_upload` | POST | 文件上传 |
| `/api/stop` | POST | 停止生成 |
| `/api/feedback` | POST | 反馈 |
| `/api/distill` | POST | 知识蒸馏 |

#### 问题清单
1. **样式与问答Tab完全不统一**：对话用class，问答用内联style
2. **消息渲染重复**：`renderMsg()` vs `kbAddMsg()`，两者做类似的事但代码完全独立
3. **场景选择器位置突兀**：放在输入区工具栏，不够显眼
4. **Agent面板样式与对话气泡割裂**：agent-panel 是紫色渐变，但对话是白底灰框
5. **流式渲染的"正在思考"动画**只在对话Tab有，问答Tab用另一套
6. **文件卡片系统**只在对话Tab有，其他Tab文件上传无卡片化展示

---

### A2. 问答 Tab (`tab-qa`)

#### 功能列表
- 三级状态机（未安装 → 已安装未激活 → 已激活）
- 知识库模块安装（拖拽ZIP）
- 知识库模型激活/卸载（含内存预估）
- 知识库模块卸载
- 文档上传（拖拽/点击多选）
- 文档处理进度轮询（processing/indexing/summarizing）
- 文档操作（暂停/继续/取消/删除/重试摘要）
- 左侧面板折叠/展开
- 知识库问答（SSE流式）
- 来源卡片展示（可展开）
- 问答会话管理（新聊天）
- 模型未加载遮罩

#### UI 元素清单
| 元素 | 样式方式 | 问题 |
|------|----------|------|
| Loading动画 (#kbLoading) | 内联style | 自定义flex布局 |
| 安装引导页 (#kbOnboarding) | 内联style | 大量style属性 |
| 激活确认页 (#kbActivation) | 内联style | 内存信息用grid |
| 顶部资源栏 (#kbResourceBar) | 内联style | 独立于设置Tab的资源面板 |
| 左侧文档面板 (.kb-left-panel) | class | 独立折叠逻辑 |
| 上传区域 (#kbDropZone) | 内联style | 与对话Tab上传逻辑不同 |
| 文档列表项 | 纯内联style | 无class复用 |
| 问答消息 (#kbMessages) | 纯内联style | 与对话消息完全不同的渲染 |
| 问答输入框 (#kbInput) | 内联style | 无自动高度 |
| 来源卡片 (.kb-source-card) | class | 唯一用class的组件 |
| 模型遮罩 (.kb-model-overlay) | class | 与对话Tab遮罩样式不同 |

#### 交互流程
```
switchTab('qa') → kbRouteState()
  → fetch /api/kb/module-status
  → 未安装: 显示安装引导（拖拽ZIP → /api/kb/install-module）
  → 已安装未激活: 显示激活页（一键加载 → /api/kb/load-models）
  → 已激活: kbRefreshDocs()
    → fetch /api/kb/documents + /api/kb/stats
    → 渲染文档列表 + 资源栏
    → 有处理中文档 → setInterval轮询3秒

用户提问 → kbAsk()
  → fetch /api/kb/ask (SSE)
  → 解析事件: status → token → sources → error
  → 用kbAddMsg()渲染（内联style，不用md()）
```

#### API 端点清单
| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/kb/module-status` | GET | 三级状态检测 |
| `/api/kb/install-module` | POST | 安装KB模块 |
| `/api/kb/load-models` | POST | 激活KB模型 |
| `/api/kb/unload-models` | POST | 卸载KB模型 |
| `/api/kb/uninstall-module` | POST | 卸载KB模块 |
| `/api/kb/documents` | GET | 文档列表 |
| `/api/kb/upload` | POST | 文档上传 |
| `/api/kb/documents/{id}` | DELETE | 删除文档 |
| `/api/kb/documents/{id}/pause` | POST | 暂停处理 |
| `/api/kb/documents/{id}/resume` | POST | 继续处理 |
| `/api/kb/documents/{id}/cancel` | POST | 取消处理 |
| `/api/kb/documents/{id}/retry_summary` | POST | 重试摘要 |
| `/api/kb/ask` | POST | 知识库问答 |
| `/api/kb/new_session` | POST | 新建问答会话 |
| `/api/kb/stats` | GET | 知识库统计 |
| `/api/kb/memory-info` | GET | 内存信息 |

#### 问题清单
1. **几乎全部用内联style**：文档列表、问答消息、状态栏等核心组件没有class
2. **消息渲染不使用md()**：直接innerHTML，丢失Markdown格式支持
3. **"正在思考"动画与对话Tab不同**：用`⏳ 思考中`文字而非脉动圆点
4. **来源卡片已有class但问答消息没有**：导致风格不一致
5. **资源栏重复**：问答Tab有自己的资源栏，设置Tab也有，数据源不同
6. **输入框无自动高度**：单行input vs 对话Tab的textarea
7. **进度条样式不统一**：文档处理进度条 vs 设置Tab导入模型进度条

---

### A3. 纪要 Tab (`tab-minutes`)

#### 功能列表
- 三阶段状态机（未安装 → 已安装未加载 → 就绪）
- Whisper 扩展包安装
- 录音（含增益控制、音量可视化、VAD实时转写）
- 暂停/继续录音
- 音频文件导入
- 转写稿查看/编辑
- 段落级时间戳 + 音频播放器
- 粗稿/精稿对比
- AI纠错润色
- AI纪要生成
- 导入知识库
- 历史录音管理
- 扩展管理（卸载）
- 对话Tab锁定检测

#### UI 元素清单
| 元素 | 样式方式 | 问题 |
|------|----------|------|
| 安装引导 (#minutesInstall) | 内联style | 与KB安装引导类似但代码独立 |
| 激活页 (#minutesInactive) | .panel class | 混用 |
| 就绪页 (#minutesReady) | .panel class | 较统一 |
| 录音区 (#recordingArea) | 内联style | 复杂的Audio管道 |
| 音量可视化条 (#volumeBar) | 内联style | 独立实现 |
| 增益滑块 | 内联style | 无统一slider组件 |
| 实时转写预览 (#realtimeText) | 内联style | 简单div |
| 历史录音列表 | 内联style | 无class |
| 转写稿弹窗 (#transcriptModal) | 内联style | 全屏遮罩+白卡 |
| 音频播放器 | 内联style | 自定义进度条 |
| 处理队列 | 内联style | 简单列表 |

#### API 端点清单
| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/recorder/whisper/status` | GET | Whisper状态 |
| `/api/recorder/whisper/load` | POST | 加载Whisper |
| `/api/recorder/whisper/unload` | POST | 卸载Whisper |
| `/api/recorder/start` | POST | 开始录音 |
| `/api/recorder/chunk` | POST | 上传音频块 |
| `/api/recorder/finish` | POST | 结束录音 |
| `/api/recorder/import` | POST | 导入音频 |
| `/api/recorder/sessions` | GET | 会话列表 |
| `/api/recorder/{id}/status` | GET | 会话状态 |
| `/api/recorder/{id}/transcript` | GET/PUT | 转写稿 |
| `/api/recorder/{id}/rough` | GET | 粗稿 |
| `/api/recorder/{id}/segments` | GET | 时间段 |
| `/api/recorder/{id}/audio` | GET | 音频 |
| `/api/recorder/{id}/summarize` | POST | 生成纪要 |
| `/api/recorder/{id}/import_kb` | POST | 入库 |
| `/api/recorder/{id}/refine` | POST | AI纠错 |
| `/api/recorder/{id}/resume` | POST | 重试 |
| `/api/recorder/{id}` | DELETE | 删除 |
| `/api/recorder/storage` | GET | 存储统计 |
| `/api/recorder/live-transcribe` | POST | 实时转写 |
| `/api/recorder/locked` | GET | 锁定检测 |
| `/api/extensions/upload` | POST | 扩展安装 |
| `/api/extensions/{name}` | DELETE | 扩展卸载 |

#### 问题清单
1. **录音区UI过于简陋**：音量条、增益滑块都是原生input，没有美化
2. **弹窗用内联style实现**：转写稿弹窗、音频播放器都是手写，没有统一Modal组件
3. **历史录音列表全内联style**：每个session卡片都是一长串HTML拼接
4. **安装引导页与KB Tab代码重复**：ZIP拖拽上传+进度条几乎相同
5. **进度反馈不足**：录音中只有简单的计时器和实时文本，缺少波形可视化
6. **操作按钮样式与对话Tab不统一**：用`.secondary` class但字号/颜色各异

---

### A4. 记忆 Tab (`tab-knowledge`)

#### 功能列表
- AI 身份卡展示
- 用户档案编辑（用户名/城市/职业/偏好）
- 记忆条目列表（支持来源过滤）
- 添加记忆（事实/术语）
- 批量导入记忆
- 小册子预览
- 删除记忆

#### UI 元素清单
| 元素 | 样式方式 | 问题 |
|------|----------|------|
| AI身份卡 | 内联style | 圆形头像+信息卡，独特设计 |
| 用户信息表格 (.panel table) | .panel class | 利用通用样式 |
| 偏好输入 (textarea) | .panel class | 统一 |
| 记忆列表 (#memoryList) | 纯内联style | 与deletable-item class部分复用 |
| 记忆类型标签 | 纯内联style | 各色标签 |
| 批量导入 (details) | .panel + details | 较统一 |
| 小册子预览按钮 | 内联style | 独立样式 |

#### API 端点清单
| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/notebook/profile` | GET/POST | 用户档案 |
| `/api/notebook/identity_card` | GET | 身份卡 |
| `/api/notebook/memory` | GET/POST | 记忆列表/添加 |
| `/api/notebook/memory/{index}` | DELETE | 删除记忆 |
| `/api/notebook/memory/import` | POST | 批量导入 |
| `/api/notebook/preview` | GET | 小册子预览 |
| `/api/notebook/facts` | GET/POST/DELETE | 事实管理 |
| `/api/notebook/glossary` | GET/POST/DELETE | 术语管理 |
| `/api/notebook/milestones` | GET | 成长日志 |

#### 问题清单
1. **记忆列表用纯内联style**：颜色标签、删除按钮都是硬编码style
2. **AI身份卡独特但与其他Tab无风格联系**
3. **事实/术语添加区用内联style**：`.panel` class只覆盖外层
4. **小册子预览用`alert`风格弹窗**：手写DOM overlay，与转写稿弹窗不同
5. **缺少loading状态**：记忆列表加载无loading动画
6. **成功反馈用`.result`文字**：无Toast通知

---

### A5. 技能 Tab (`tab-skills`)

#### 功能列表
- 场景-技能映射配置（聊天/写材料/写代码）
- 已安装技能列表
- 技能ZIP导入/删除
- 审计日志查询/清空

#### UI 元素清单
| 元素 | 样式方式 | 问题 |
|------|----------|------|
| 场景卡片 | 内联style | 各场景有不同背景色 |
| 技能checkbox标签 | 内联style | 简陋 |
| 技能列表 | .deletable-item class | 较统一 |
| 导入区 (.row) | .panel class | 统一 |
| 审计日志列表 | 纯内联style | 无class |

#### API 端点清单
| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/scene_skills` | GET/POST | 场景技能配置 |
| `/api/skill/list` | GET | 技能列表 |
| `/api/skill/import` | POST | 导入技能 |
| `/api/skill/{name}` | DELETE | 删除技能 |
| `/api/audit/query` | GET | 审计日志查询 |
| `/api/audit/clear` | DELETE | 清空日志 |

#### 问题清单
1. **场景卡片颜色硬编码**：f8f9fa/fef3c7/eff6ff 与设计系统无关联
2. **技能checkbox标签简陋**：无分组、无说明、小字体
3. **审计日志全内联style**：时间戳/操作/结果都在一个div里
4. **缺少技能详情展示**：只有名称和描述，无配置参数展示
5. **导入结果用内联变色文字**：无统一反馈组件

---

### A6. 设置 Tab (`tab-settings`)

#### 功能列表
- 资源调度中心（系统内存总览 + 内存预算）— Patch 8B 重构
- 模型管理（选择/加载/卸载/导入）
- 算力设备切换
- Reranker 常驻开关
- 云端 API 配置
- 环境信息
- 训练记录管理
- 参数模板

#### UI 元素清单
| 元素 | 样式方式 | 问题 |
|------|----------|------|
| 资源调度中心 | 内联style + 少量class | Patch 8B 刚重构 |
| 内存总览条 | 内联style | 进度条组件 |
| 预算条 | 内联style | 独立进度条 |
| 预算滑块 (input range) | 内联style | 原生 |
| 模型选择器 (.row) | .panel class | 统一 |
| 状态文本 (pre) | .panel class | 简陋 |
| 设备选择器 | .panel class | 统一 |
| 导入模型进度条 | 内联style | 与KB进度条不同 |
| 云端配置表单 | .panel class | 统一 |
| 环境表 (.panel table) | .panel class | 统一 |
| 训练记录表 (.panel table) | .panel class | 统一 |
| 高级设置 (details) | details tag | 折叠 |

#### API 端点清单
| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/models` | GET | 模型列表/状态 |
| `/api/load/{name}` | POST | 加载模型 |
| `/api/unload/{name}` | POST | 卸载模型 |
| `/api/models/import` | POST | 导入模型(SSE) |
| `/api/devices` | GET | 设备列表 |
| `/api/device/switch` | POST | 切换设备 |
| `/api/resource-info` | GET | 资源信息 |
| `/api/budget` | POST | 预算设置 |
| `/api/config` | GET/POST | 配置管理 |
| `/api/cloud/config` | GET/POST/DELETE | 云端配置 |
| `/api/cloud/test` | POST | 测试云端连接 |
| `/api/env/check` | GET | 环境信息 |
| `/api/rescan` | POST | 重新扫描模型 |
| `/api/info` | GET | 版本信息 |
| `/api/training/records` | GET | 训练记录 |
| `/api/training/record` | POST | 添加记录 |
| `/api/training/record/{id}` | DELETE | 删除记录 |
| `/api/training/stats` | GET | 训练统计 |
| `/api/training/templates` | GET | 参数模板 |
| `/api/training/template` | POST | 保存模板 |
| `/api/training/template/{model}` | DELETE | 删除模板 |
| `/api/training/export` | GET | 导出 |
| `/api/training/import` | POST | 导入 |

#### 问题清单
1. **设置Tab是最近重构的，相对最统一**，但仍大量使用内联style
2. **进度条不统一**：导入模型进度条与KB进度条样式不同
3. **训练记录用`prompt()`输入**：极差的用户体验
4. **云端配置反馈用内联文字**：无Toast
5. **高级设置嵌套`<details>`**：层级过深

---

### A7. 全局问题汇总

#### 样式不一致统计

| 组件类型 | 变体数 | 说明 |
|----------|--------|------|
| 按钮 | 6+ | .btn-send/.btn-stop/.btn-img/.panel button/内联/.task-chip/.fb-btn |
| 进度条 | 4 | 导入模型/KB安装/文档处理/内存条 |
| 消息气泡 | 3 | 对话(.msg)/问答(内联)/Agent(.agent-panel) |
| Loading | 4 | 全局遮罩/KB spinner/思考动画/文字提示 |
| 空状态 | 3 | .empty-state/内联div/纯文字 |
| 弹窗 | 3 | 反馈原因/小册子预览/转写稿 |
| 上传区域 | 3 | 对话(隐藏input)/问答(拖拽区)/纪要(拖拽区) |
| 表格 | 2 | .panel table/环境信息表 |

#### 代码重复统计

| 功能 | 重复次数 | 位置 |
|------|----------|------|
| 拖拽上传 + 进度条 | 3 | KB安装/Whisper安装/文档上传 |
| SSE流解析 | 2 | 对话Tab/问答Tab |
| 消息渲染 | 2 | renderMsg()/kbAddMsg() |
| 状态路由(三阶段) | 2 | kbRouteState()/minutesRouteState() |
| 资源面板 | 2 | 问答Tab资源栏/设置Tab调度中心 |
| 确认删除 | 5+ | 各Tab散落 |

#### 后端API问题汇总
- **128个端点**，命名风格混合
- `/api/ocr_upload` vs `/api/kb/upload` — 同是上传，命名不同
- `/api/recorder/{id}/refine` vs `/api/notebook/memory/{index}` — 路径层级不同
- `/api/scene_skills` vs `/api/skill/list` — 技能相关端点散落
- 响应格式不统一：有的用 `{ok, data}`，有的用 `{error, ...}`，有的直接返回数据

---

## B. 统一设计系统

### B1. 色彩方案

基于现有的 indigo (#4f46e5) 主色调，建立完整的语义色彩系统：

```css
:root {
  /* 主色调 — Indigo */
  --color-primary: #4f46e5;
  --color-primary-hover: #4338ca;
  --color-primary-light: #eef2ff;
  --color-primary-muted: #6366f1;

  /* 语义色 */
  --color-success: #16a34a;
  --color-success-bg: #f0fdf4;
  --color-warning: #f59e0b;
  --color-warning-bg: #fef3c7;
  --color-danger: #ef4444;
  --color-danger-bg: #fef2f2;
  --color-info: #3b82f6;
  --color-info-bg: #eff6ff;

  /* 中性色 */
  --color-bg: #ffffff;
  --color-bg-soft: #f8f9fa;
  --color-bg-muted: #f0f0f0;
  --color-border: #e5e7eb;
  --color-border-strong: #d1d5db;
  --color-text: #1f2937;
  --color-text-secondary: #6b7280;
  --color-text-muted: #9ca3af;
  --color-text-placeholder: #bfbfbf;

  /* 场景色 — 延续现有 */
  --color-scene-chat: #f8f9fa;
  --color-scene-doc: #fef3c7;
  --color-scene-code: #eff6ff;

  /* 组件色 */
  --color-user-bubble: #eef2ff;
  --color-ai-bubble: #f8f9fa;
  --color-overlay: rgba(250, 250, 250, 0.94);
  --color-modal-backdrop: rgba(0, 0, 0, 0.5);
}
```

### B2. 组件库（CSS Class 规范）

#### 按钮
```css
/* 基础按钮 */
.btn { padding: 6px 14px; border-radius: 6px; font-size: .85em; cursor: pointer;
       border: 1px solid transparent; transition: all .15s; white-space: nowrap; }
.btn:disabled { opacity: .5; cursor: not-allowed; }

/* 变体 */
.btn-primary { background: var(--color-primary); color: #fff; }
.btn-primary:hover:not(:disabled) { background: var(--color-primary-hover); }
.btn-danger { background: var(--color-danger); color: #fff; }
.btn-danger:hover:not(:disabled) { background: #dc2626; }
.btn-secondary { background: #fff; color: var(--color-text); border-color: var(--color-border); }
.btn-secondary:hover:not(:disabled) { background: var(--color-bg-soft); }
.btn-ghost { background: none; border: none; color: var(--color-text-secondary); }
.btn-ghost:hover { color: var(--color-text); background: var(--color-bg-muted); }

/* 图标按钮 */
.btn-icon { width: 36px; height: 36px; padding: 0; display: inline-flex;
            align-items: center; justify-content: center; border-radius: 8px;
            background: var(--color-bg-muted); border: none; cursor: pointer; }
.btn-icon:hover { background: var(--color-border); }

/* 尺寸 */
.btn-sm { padding: 3px 10px; font-size: .78em; }
.btn-lg { padding: 10px 24px; font-size: 1em; }
```

#### 卡片
```css
.card { background: var(--color-bg); border: 1px solid var(--color-border);
        border-radius: 8px; padding: 12px; }
.card-hover:hover { border-color: var(--color-border-strong); background: var(--color-bg-soft); }
.card-compact { padding: 8px 10px; }

/* 状态卡片 */
.card-success { border-color: #86efac; background: var(--color-success-bg); }
.card-warning { border-color: #fcd34d; background: var(--color-warning-bg); }
.card-danger  { border-color: #fca5a5; background: var(--color-danger-bg); }
.card-info    { border-color: #93c5fd; background: var(--color-info-bg); }
```

#### 模态框
```css
.modal-backdrop { position: fixed; inset: 0; background: var(--color-modal-backdrop);
                  z-index: 200; display: flex; align-items: center; justify-content: center; }
.modal { background: var(--color-bg); border-radius: 12px; padding: 20px;
         max-width: 700px; width: 90%; max-height: 80vh; overflow-y: auto;
         box-shadow: 0 8px 30px rgba(0,0,0,.15); position: relative; }
.modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.modal-title { font-size: 1.1em; font-weight: 600; }
.modal-close { background: none; border: none; font-size: 1.3em; cursor: pointer; color: var(--color-text-secondary); }
.modal-footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
```

#### Toast 通知
```css
/* 用JS动态创建的轻量通知 */
.toast-container { position: fixed; top: 16px; right: 16px; z-index: 300;
                   display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
.toast { padding: 10px 16px; border-radius: 8px; font-size: .85em;
         box-shadow: 0 4px 12px rgba(0,0,0,.12); animation: toastIn .3s ease;
         pointer-events: auto; max-width: 360px; display: flex; align-items: center; gap: 8px; }
.toast-success { background: var(--color-success-bg); color: #166534; border: 1px solid #86efac; }
.toast-error   { background: var(--color-danger-bg); color: #991b1b; border: 1px solid #fca5a5; }
.toast-info    { background: var(--color-info-bg); color: #1e40af; border: 1px solid #93c5fd; }
.toast-warning { background: var(--color-warning-bg); color: #92400e; border: 1px solid #fcd34d; }
@keyframes toastIn { from { opacity: 0; transform: translateY(-12px); } to { opacity: 1; transform: translateY(0); } }
```

#### 进度条
```css
.progress { height: 8px; background: var(--color-border); border-radius: 4px; overflow: hidden; }
.progress-fill { height: 100%; border-radius: 4px; transition: width .3s ease; }
.progress-fill-primary { background: linear-gradient(90deg, var(--color-primary), var(--color-primary-muted)); }
.progress-fill-success { background: linear-gradient(90deg, #16a34a, #22c55e); }
.progress-fill-danger  { background: linear-gradient(90deg, #ef4444, #f87171); }

/* 带标签 */
.progress-labeled { display: flex; align-items: center; gap: 8px; }
.progress-labeled .progress { flex: 1; }
.progress-labeled .progress-text { font-size: .78em; color: var(--color-text-secondary); min-width: 48px; text-align: right; }
```

#### 输入框
```css
.input { padding: 8px 12px; border: 1px solid var(--color-border); border-radius: 6px;
         font-size: .9em; font-family: inherit; transition: border-color .15s; }
.input:focus { outline: none; border-color: var(--color-primary); }
.input:disabled { opacity: .5; background: var(--color-bg-muted); cursor: not-allowed; }
.input-error { border-color: var(--color-danger); }
.input-error:focus { border-color: #dc2626; }

/* 下拉选择器 */
.select { .input; appearance: none; background-image: url("data:image/svg+xml,..."); /* 下拉箭头 */ }

/* 文本域 */
.textarea { .input; resize: vertical; min-height: 38px; max-height: 120px; }
.textarea-auto { height: auto; }
```

#### Tabs（统一现有标签页）
```css
.tabs-nav { display: flex; gap: 0; border-bottom: 2px solid var(--color-border); flex-shrink: 0; }
.tabs-nav button { padding: 8px 16px; border: none; background: none; cursor: pointer;
                   font-size: .9em; color: var(--color-text-secondary);
                   border-bottom: 2px solid transparent; margin-bottom: -2px; transition: all .15s; }
.tabs-nav button:hover { color: var(--color-text); }
.tabs-nav button.active { color: var(--color-primary); border-bottom-color: var(--color-primary); font-weight: 600; }

.tab-content { flex: 1; overflow: hidden; display: none; flex-direction: column; min-height: 0; }
.tab-content.active { display: flex; }
```

#### Badge
```css
.badge { display: inline-block; padding: 1px 8px; border-radius: 10px;
         font-size: .75em; font-weight: 500; }
.badge-primary { background: var(--color-primary-light); color: var(--color-primary); }
.badge-success { background: var(--color-success-bg); color: #166534; }
.badge-warning { background: var(--color-warning-bg); color: #92400e; }
.badge-danger  { background: var(--color-danger-bg); color: #991b1b; }
.badge-muted   { background: var(--color-bg-muted); color: var(--color-text-secondary); }
```

#### 上传区域
```css
.upload-zone { border: 2px dashed var(--color-border); border-radius: 8px;
               padding: 24px; text-align: center; cursor: pointer;
               transition: border-color .2s; color: var(--color-text-muted); }
.upload-zone:hover { border-color: var(--color-primary); color: var(--color-primary); }
.upload-zone.dragover { border-color: var(--color-primary); background: var(--color-primary-light); }
```

#### 空状态
```css
.empty-state { display: flex; flex-direction: column; align-items: center;
               justify-content: center; flex: 1; color: var(--color-text-muted);
               font-size: .9em; gap: 8px; }
.empty-state-icon { font-size: 2em; }
.empty-state-text { text-align: center; line-height: 1.6; }
```

#### 可删除条目
```css
.list-item { display: flex; align-items: center; gap: 8px; padding: 6px 0;
             font-size: .85em; border-bottom: 1px solid var(--color-bg-muted); }
.list-item:last-child { border-bottom: none; }
.list-item-text { flex: 1; }
.list-item-del { color: var(--color-danger); cursor: pointer; font-size: .9em;
                 padding: 2px 6px; border: none; background: none; border-radius: 3px; }
.list-item-del:hover { background: var(--color-danger-bg); }
```

### B3. 排版规范

```css
:root {
  --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  --fs-xs: .72em;    /* 辅助文字 */
  --fs-sm: .78em;    /* 次要文字 */
  --fs-base: .85em;  /* 正文 */
  --fs-md: .9em;     /* 主文本 */
  --fs-lg: 1em;      /* 标题3 */
  --fs-xl: 1.1em;    /* 标题2 */
  --fs-2xl: 1.3em;   /* 标题1 */

  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 12px;
  --spacing-lg: 16px;
  --spacing-xl: 24px;

  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-xl: 12px;
  --radius-full: 50%;
}
```

### B4. 动画/过渡

```css
:root {
  --duration-fast: .15s;
  --duration-normal: .3s;
  --duration-slow: .5s;
  --ease-default: ease;
  --ease-in-out: cubic-bezier(.4, 0, .2, 1);
}

/* 统一动画集 */
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideDown { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes slideUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 0%, 80%, 100% { opacity: .3; transform: scale(.8); } 40% { opacity: 1; transform: scale(1); } }

/* 思考中脉动 — 全Tab统一 */
.thinking-dots span { display: inline-block; width: 6px; height: 6px; border-radius: 50%;
                      background: var(--color-text-muted); animation: pulse 1.4s infinite; }
.thinking-dots span:nth-child(2) { animation-delay: .2s; }
.thinking-dots span:nth-child(3) { animation-delay: .4s; }

/* Spinner — 全Tab统一 */
.spinner { width: 32px; height: 32px; border: 3px solid var(--color-border);
           border-top-color: var(--color-primary); border-radius: 50%;
           animation: spin .8s linear infinite; }
.spinner-sm { width: 16px; height: 16px; border-width: 2px; }
```

### B5. 响应式规则

```css
/* 断点 */
/* < 640px: 手机（本项目不太可能，但保持基本可用） */
/* 640px - 1024px: 平板/小窗口 */
/* > 1024px: 桌面（默认） */

@media (max-width: 768px) {
  .tabs-nav button { padding: 6px 10px; font-size: .82em; }
  .kb-left-panel { width: 100%; border-right: none; border-bottom: 1px solid var(--color-border); }
  .panel { padding: 8px; }
  .modal { max-width: 95%; padding: 16px; }
}
```

### B6. 公共 JS 函数（提取复用）

```javascript
// ===== Toast 通知 =====
function showToast(message, type = 'info', duration = 3000) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, duration);
}

// ===== Modal 弹窗 =====
function showModal(title, contentHtml, footerHtml = '') {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal">
    <div class="modal-header"><div class="modal-title">${title}</div><button class="modal-close" onclick="this.closest('.modal-backdrop').remove()">✕</button></div>
    <div class="modal-body">${contentHtml}</div>
    ${footerHtml ? '<div class="modal-footer">' + footerHtml + '</div>' : ''}
  </div>`;
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };
  document.body.appendChild(backdrop);
  return backdrop;
}

// ===== 确认对话框（替代 confirm()）=====
function showConfirm(message) {
  return new Promise((resolve) => {
    const backdrop = showModal('确认操作', `<p style="font-size:.9em;color:var(--color-text-secondary)">${message}</p>`,
      `<button class="btn btn-secondary" onclick="this.closest('.modal-backdrop').remove(); resolve(false)">取消</button>
       <button class="btn btn-danger" id="_confirmOk">确定</button>`);
    backdrop.querySelector('#_confirmOk').onclick = () => { backdrop.remove(); resolve(true); };
  });
}

// ===== 统一消息气泡渲染 =====
function renderMessage(role, content, options = {}) {
  // role: 'user' | 'ai' | 'system'
  // options: { thinking, thinkLen, stats, sourceCards, variantTag }
  const div = document.createElement('div');
  div.className = 'msg msg-' + role;
  // ... 统一渲染逻辑
  return div;
}

// ===== 统一拖拽上传 =====
function setupDropZone(zoneEl, options) {
  // options: { accept, onFile, multiple }
  zoneEl.addEventListener('dragover', (e) => { e.preventDefault(); zoneEl.classList.add('dragover'); });
  zoneEl.addEventListener('dragleave', () => zoneEl.classList.remove('dragover'));
  zoneEl.addEventListener('drop', (e) => {
    e.preventDefault(); zoneEl.classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files).filter(f => !options.accept || f.name.match(options.accept));
    if (options.multiple) files.forEach(f => options.onFile(f));
    else if (files[0]) options.onFile(files[0]);
  });
}

// ===== 统一 SSE 流读取器 =====
async function readSSE(response, handlers) {
  // handlers: { onToken, onDone, onError, onStatus, onProgress, ... }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      try {
        const evt = JSON.parse(line.slice(6));
        if (handlers['on' + evt.type.charAt(0).toUpperCase() + evt.type.slice(1)]) {
          handlers['on' + evt.type.charAt(0).toUpperCase() + evt.type.slice(1)](evt);
        }
      } catch (e) {}
    }
  }
}

// ===== 统一进度条更新 =====
function updateProgress(container, progress, label) {
  // container 包含 .progress 和 .progress-text
  const fill = container.querySelector('.progress-fill');
  const text = container.querySelector('.progress-text');
  if (fill) fill.style.width = Math.round(progress * 100) + '%';
  if (text) text.textContent = label || Math.round(progress * 100) + '%';
}

// ===== 统一空状态渲染 =====
function renderEmpty(icon, text) {
  return `<div class="empty-state"><span class="empty-state-icon">${icon}</span><span class="empty-state-text">${text}</span></div>`;
}
```

---

## C. 各 Tab 重新设计

### C1. 对话 Tab

#### 新布局
```
┌─────────────────────────────────────────────────────┐
│  工具栏: [模型标签] [场景选择] ---- [会话选择▾] [+新建] [🗑] │
├─────────────────────────────────────────────────────┤
│                                                      │
│  ┌─────────────────────────────────────────┐         │
│  │ 用户消息 (右对齐, 浅蓝背景)              │         │
│  └─────────────────────────────────────────┘         │
│  ┌─────────────────────────────────────────┐         │
│  │ 🤖 AI 回复 (左对齐, 白底灰框)            │         │
│  │ [思考过程 ▼] (折叠)                       │         │
│  │ 正文内容...                               │         │
│  │ [来源卡片...]                             │         │
│  │ [📊 统计: 模型 142字 3.2s 44字/s]         │         │
│  │ [👍 👎] [📥 蒸馏]                         │         │
│  └─────────────────────────────────────────┘         │
│                                                      │
│  [漂移提示条] (条件显示)                               │
│                                                      │
├─────────────────────────────────────────────────────┤
│  [📷] [📎] [场景▾ 聊天] [________输入框________] [发送] │
└─────────────────────────────────────────────────────┘
```

#### 统一交互规范
| 状态 | 表现 |
|------|------|
| Loading | `renderThinkingIndicator()` — 统一脉动圆点 + "正在思考" |
| 错误 | `showToast(errMsg, 'error')` + 气泡内显示错误 |
| 空状态 | `.empty-state` — 图标 + "开始对话吧" |
| 成功 | 气泡正常渲染 + 统计行 |
| 模型未加载 | `.chat-model-overlay` — 遮罩 + 前往设置链接 |
| KB锁定 | `.kb-lock-overlay` — 黄色遮罩 |

#### 需要新增/修改的后端 API
无需新增。对话Tab的API相对完善。

#### 代码复用方案
- `renderMessage()` 统一函数替代 `renderMsg()` + `kbAddMsg()`
- `appendStreamingMsg()` 保持不变（对话Tab独有逻辑）
- Agent面板、Chunk面板保持对话Tab独有

---

### C2. 问答 Tab

#### 新布局
```
┌─────────────────────────────────────────────────────┐
│  ┌─────────────────────────────────────────────────┐│
│  │  📚 知识库问答                                    ││
│  │  [模式: 语义检索] [资源占用: 645MB] [退出知识库]   ││
│  └─────────────────────────────────────────────────┘│
├──────────────┬──────────────────────────────────────┤
│ 📂 文档管理   │ 💬 问答区                             │
│              │                                       │
│ [📤 上传区]   │  ┌─ 用户问题 ──────────────┐         │
│              │  │ (右对齐)                  │         │
│ 📄 doc1 ✅   │  └──────────────────────────┘         │
│    2.1KB 5块 │  ┌─ AI回答 ────────────────┐         │
│ 📄 doc2 📝   │  │ (左对齐, Markdown渲染)    │         │
│    摘要中...  │  │                           │         │
│              │  │ [📖 参考资料 ▼]            │         │
│ [◀ 折叠]     │  │ [1] 来源标题 ⬤ 高度相关   │         │
│              │  │     引文片段...             │         │
│              │  └──────────────────────────┘         │
│              │                                       │
│              │ [_______输入框_______] [提问]          │
├──────────────┴──────────────────────────────────────┤
│  三阶段状态路由（安装引导/激活确认/就绪）                │
└─────────────────────────────────────────────────────┘
```

#### 统一交互规范
| 状态 | 表现 |
|------|------|
| Loading | `.spinner` + "正在检测知识库状态…" |
| 安装引导 | `.upload-zone` + 统一进度条 |
| 激活确认 | `.card` 内存信息 + `.btn-primary` 激活按钮 |
| 问答Loading | `renderThinkingIndicator()` — 与对话Tab统一 |
| 文档处理 | `.progress` 进度条 + `.badge` 状态标签 |
| 空状态 | `.empty-state` — 📚 + "先上传文档到知识库" |
| 错误 | `showToast(errMsg, 'error')` |

#### 需要新增/修改的后端 API
无需新增。问答API已较完善。

#### 代码复用方案
- **消息渲染**: 用统一 `renderMessage()` 替代 `kbAddMsg()`
- **Markdown**: 问答消息使用 `md()` 函数
- **安装引导**: 用 `setupDropZone()` + `updateProgress()` 统一
- **三阶段路由**: 提取 `createStateRouter(states)` 工厂函数

---

### C3. 纪要 Tab

#### 新布局
```
┌─────────────────────────────────────────────────────┐
│  ┌─────────────────────────────────────────────────┐│
│  │  🎙️ 语音转写  [✅ 就绪] [占用 ~850MB] [释放引擎]  ││
│  └─────────────────────────────────────────────────┘│
│                                                      │
│  [⏺ 开始录音]  [📁 上传音频]                          │
│                                                      │
│  ┌─ 录音进行中 ────────────────────────────────────┐ │
│  │ 🎙️ 录音中 02:35    [⏸ 暂停] [⏹ 停止]            │ │
│  │ 🔊 ████████░░░░  -32dB                           │ │
│  │ 🎙 增强 [1.0x ═══●═══ 3.0x]                     │ │
│  │ ┌─ 实时转写 ──────────────────────────────┐     │ │
│  │ │ 正在转写的内容将实时显示在这里...          │     │ │
│  │ └──────────────────────────────────────────┘     │ │
│  └─────────────────────────────────────────────────┘ │
│                                                      │
│  历史记录                                             │
│  ┌─ 🎙 录音 2025-07-15 · 5分30秒 ──── ✅ 已完成 ──┐ │
│  │ [▶ 播放] [查看] [✅ 已纠错] [📥 入库] [🗑]         │ │
│  └─────────────────────────────────────────────────┘ │
│                                                      │
│  三阶段状态路由（安装引导/激活/就绪）                    │
└─────────────────────────────────────────────────────┘
```

#### 统一交互规范
| 状态 | 表现 |
|------|------|
| Loading | `.spinner` + "正在检测语音引擎状态…" |
| 安装引导 | `.upload-zone` + 统一进度条（与KB安装共享组件） |
| 录音中 | 黄色 `.card.card-warning` 区域 |
| 处理中 | `.badge.badge-info` + 进度百分比 |
| 空状态 | `.empty-state` — 🎙️ + "暂无录音记录" |
| 错误 | `showToast(errMsg, 'error')` |
| 成功 | `showToast(msg, 'success')` 替代 alert |

#### 需要新增/修改的后端 API
无需新增。

#### 代码复用方案
- **安装引导**: 与KB Tab共享 `setupDropZone()` + `updateProgress()`
- **转写稿弹窗**: 用 `showModal()` 替代内联 #transcriptModal
- **历史列表**: 用 `.card` + `.list-item` 统一样式
- **三阶段路由**: 与KB Tab共享工厂函数

---

### C4. 记忆 Tab

#### 新布局
```
┌─────────────────────────────────────────────────────┐
│  ┌─ AI 身份卡 ──────────────────────────────────────┐│
│  │ [AI头像] 小助手                                   ││
│  │ 本地办公AI助手                                     ││
│  │ 性格: ... | 技能: 3个 | 事实: 15条 | 术语: 8个     ││
│  │                              [📋 小册子预览]       ││
│  └──────────────────────────────────────────────────┘│
│                                                      │
│  我的档案                                             │
│  ┌──────────────────────────────────────────────────┐│
│  │ 用户名  [________]  城市  [________]              ││
│  │ 职业    [________]                               ││
│  │ 偏好    [_____________textarea______________]     ││
│  │                              [💾 保存]            ││
│  └──────────────────────────────────────────────────┘│
│                                                      │
│  记忆条目 [来源▾ 全部] [🔄 刷新]                       │
│  ┌─ 📌 事实 ──── 对话提取 ──── [删除] ──────────────┐│
│  │ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx           ││
│  └──────────────────────────────────────────────────┘│
│  ┌─ 📖 术语 ──── 手动添加 ──── [删除] ──────────────┐│
│  │ API = 应用程序编程接口                              ││
│  └──────────────────────────────────────────────────┘│
│                                                      │
│  ┌─ 添加记忆 ──────────────────────────────────────┐│
│  │ 类型: [📌 事实 ▾]                                 ││
│  │ [____________________输入_________________] [添加] ││
│  └──────────────────────────────────────────────────┘│
│                                                      │
│  [▶ 批量导入] (折叠)                                  │
└─────────────────────────────────────────────────────┘
```

#### 统一交互规范
| 状态 | 表现 |
|------|------|
| Loading | `.spinner` + "加载中…" |
| 空状态 | `.empty-state` — 📝 + "暂无记忆条目" |
| 添加成功 | `showToast('已添加', 'success')` 替代 `.result` |
| 删除确认 | `showConfirm('确定删除？')` 替代 `confirm()` |
| 保存成功 | `showToast('已保存', 'success')` |
| 预览弹窗 | `showModal()` 替代手写DOM |

#### 需要新增/修改的后端 API
无需新增。

#### 代码复用方案
- **记忆列表**: 用 `.list-item` class 统一
- **类型标签**: 用 `.badge` class
- **档案表单**: 保持 `.panel table` 但优化输入框样式

---

### C5. 技能 Tab

#### 新布局
```
┌─────────────────────────────────────────────────────┐
│  场景与技能                                           │
│  ┌─ 💬 聊天 ────────────────────────────────────────┐│
│  │ 纯聊天问答，不调用工具。                             ││
│  └──────────────────────────────────────────────────┘│
│  ┌─ 📝 写材料 ─────────────────────────────────────┐│
│  │ 自动检索知识库并生成文档。                           ││
│  │ ☑ 搜索 🔒 ☑ 文档操作                              ││
│  └──────────────────────────────────────────────────┘│
│  ┌─ 💻 写代码 ─────────────────────────────────────┐│
│  │ 运行代码并操作文件。                                ││
│  │ ☑ 代码运行 🔒 ☑ 文件操作                          ││
│  └──────────────────────────────────────────────────┘│
│                                                      │
│  已安装技能                                           │
│  ┌─ 搜索 ─ [内置] ─ 全网搜索工具 ──────────── [删除]─┐│
│  └──────────────────────────────────────────────────┘│
│                                                      │
│  导入技能 [选择ZIP文件] [导入]                          │
│                                                      │
│  审计日志 [▾ 全部] [🔄 刷新] [🗑 清空]                 │
│  2025-07-15 14:30  搜索  执行  ✅                     │
│  2025-07-15 14:25  搜索  执行  ✅                     │
└─────────────────────────────────────────────────────┘
```

#### 统一交互规范
| 状态 | 表现 |
|------|------|
| Loading | `.spinner` |
| 空技能 | `.empty-state` — 🔧 + "暂无已安装技能" |
| 导入成功 | `showToast('导入成功: ' + name, 'success')` |
| 导入失败 | `showToast(errMsg, 'error')` |
| 删除确认 | `showConfirm()` |
| 空审计 | `.empty-state` — "暂无审计记录" |

#### 需要新增/修改的后端 API
无需新增。

#### 代码复用方案
- **场景卡片**: 用 `.card` + 场景色CSS变量
- **技能列表**: 用 `.list-item` class
- **审计日志**: 用 `.list-item` class
- **导入**: 用统一文件上传样式

---

### C6. 设置 Tab

#### 新布局
保持 Patch 8B 三区块布局不变，仅统一组件样式：

```
┌─────────────────────────────────────────────────────┐
│  📊 资源调度中心                                      │
│  [系统内存总览条]                                      │
│  [内存预算条] [预算滑块]                                │
├─────────────────────────────────────────────────────┤
│  🧠 模型管理                                          │
│  [模型选择 ▾] [加载/卸载]                              │
│  [状态文本]                                            │
│  [算力设备选择 ▾] [切换]                               │
│  [Reranker 常驻开关]                                  │
│  [导入模型区]                                          │
├─────────────────────────────────────────────────────┤
│  ▶ ⚙️ 高级设置                                        │
│    云端API | 环境信息 | 训练记录                        │
└─────────────────────────────────────────────────────┘
```

#### 统一交互规范
| 状态 | 表现 |
|------|------|
| 模型加载中 | `showLoading()` — 全局遮罩 |
| 加载成功 | `showToast('模型已加载', 'success')` |
| 加载失败 | `showToast(errMsg, 'error')` + hideLoading |
| 导入进度 | `.progress` 统一进度条 |
| 设备切换 | `showConfirm()` 确认 |
| 云端测试 | `.btn` loading状态 + 结果文字 |
| 训练记录添加 | `showModal()` 替代 `prompt()` |

#### 需要新增/修改的后端 API
无需新增。

#### 代码复用方案
- **进度条**: `.progress` class 统一
- **确认弹窗**: `showConfirm()` 替代 `confirm()`
- **输入弹窗**: `showModal()` 替代 `prompt()`
- **反馈**: `showToast()` 替代 `.result` 和 alert

---

## D. 后端 API 规范化

### D1. 命名规范

**原则**: 不做大规模重命名（风险太高），仅标注问题和建议

#### 命名不一致清单

| 当前命名 | 问题 | 建议统一 | 优先级 |
|----------|------|----------|--------|
| `/api/ocr_upload` | 动词式 | `/api/ocr/upload` | P2 |
| `/api/ocr_batch` | 动词式 | `/api/ocr/batch` | P2 |
| `/api/qa/upload` | 旧问答上传 | 已被 `/api/kb/upload` 替代 | P1 废弃 |
| `/api/qa/ask` | 旧问答 | 已被 `/api/kb/ask` 替代 | P1 废弃 |
| `/api/notebook/knowledge` | 旧记忆 | 已被 `/api/notebook/memory` 替代 | P1 废弃 |
| `/api/rescan` | 动词 | `/api/models/rescan` | P2 |
| `/api/stop` | 无名词 | `/api/generation/stop` | P2 |
| `/api/file_upload` | 动词式 | `/api/files/upload` | P2 |
| `/api/recorder/live-transcribe` | query参数混用 | `/api/recorder/{id}/live-transcribe` | P2 |
| `/api/scene_skills` | 下划线 | `/api/skills/scene-config` | P3 |

#### 废弃端点（可删除）
```
/api/qa/upload       — 已由 /api/kb/upload 替代
/api/qa/ask          — 已由 /api/kb/ask 替代
/api/notebook/knowledge — 已由 /api/notebook/memory 替代
```

### D2. 响应格式统一

**目标格式**:
```json
{
  "ok": true,
  "data": { ... },
  "error": null
}
```

或错误时：
```json
{
  "ok": false,
  "data": null,
  "error": "错误描述"
}
```

**现状不一致**:
- 有些端点返回 `{ok: bool, ...fields}`
- 有些直接返回数据对象
- 错误有的用 `{error: "..."}`, 有的用 HTTP status code
- SSE 流用 `{type: "error", content: "..."}`

**建议**: 不做即时统一（改动量大），在 Patch 9.3 逐步替换。前端统一使用辅助函数：

```javascript
async function apiFetch(url, options = {}) {
  const resp = await fetch(url, options);
  const data = await resp.json();
  if (!resp.ok || data.error) {
    throw new Error(data.error || '请求失败 (' + resp.status + ')');
  }
  return data;
}
```

### D3. SSE 事件格式统一

**现状**: SSE事件格式已在对话Tab和问答Tab中基本统一（都是 `data: {type, content, ...}`）

**建议统一事件类型**:
```typescript
// 通用事件
{ type: "status", content: "检索中..." }          // 状态提示
{ type: "token", content: "文本片段" }             // 流式token
{ type: "done", model, chars, time, speed, ... }  // 完成
{ type: "error", content: "错误信息" }             // 错误
{ type: "progress", step, progress }               // 进度

// 对话专用
{ type: "task_type", task_type: "reasoning" }
{ type: "fold", think_len: 123 }
{ type: "filter", warnings: [], corrections: [] }
{ type: "topic_drift", ... }
{ type: "agent_start" | "agent_action" | "agent_result" | "agent_done" }
{ type: "chunk_start" | "chunk_progress" | "chunk_done" }
{ type: "truncate", content }
{ type: "compress", msg }
{ type: "model_reload", model }

// 问答专用
{ type: "sources", content: [...] }
```

### D4. 需要新增/修改/废弃的端点列表

| 操作 | 端点 | 说明 |
|------|------|------|
| 废弃 | `/api/qa/upload` | 前端已不使用 |
| 废弃 | `/api/qa/ask` | 前端已不使用 |
| 废弃 | `/api/notebook/knowledge` | 前端已不使用 |
| 可选重命名 | `/api/ocr_upload` → `/api/ocr/upload` | 加过渡期 |

---

## E. 实施路线图

### E1. 分期策略

```
Patch 9.1 — 统一设计系统 + 视觉统一（最高优先级）
Patch 9.2 — 代码复用重构 + 交互统一
Patch 9.3 — 后端API规范化（最低优先级）
```

### E2. Patch 9.1: 统一设计系统 + 视觉统一

**目标**: 用户可感知的视觉体验提升

#### 任务列表

| 任务ID | 任务名 | 文件 | 依赖 | 优先级 | 工作量 |
|--------|--------|------|------|--------|--------|
| 9.1-1 | 建立CSS变量 + 设计系统 | index.html (style区) | 无 | P0 | 2h |
| 9.1-2 | 统一按钮样式（替换所有内联按钮） | index.html | 9.1-1 | P0 | 3h |
| 9.1-3 | 统一进度条组件 | index.html | 9.1-1 | P0 | 1h |
| 9.1-4 | 统一上传区域样式 | index.html | 9.1-1 | P1 | 1h |
| 9.1-5 | 统一问答Tab消息样式 | index.html | 9.1-2 | P0 | 2h |
| 9.1-6 | 统一纪要Tab历史列表样式 | index.html | 9.1-2 | P1 | 1h |
| 9.1-7 | 统一记忆Tab列表样式 | index.html | 9.1-2 | P1 | 1h |
| 9.1-8 | 统一技能Tab场景卡片 + 审计日志 | index.html | 9.1-2 | P1 | 1h |
| 9.1-9 | 统一Loading动画 + 思考动画 | index.html | 9.1-1 | P0 | 1h |
| 9.1-10 | 添加Toast通知组件 + 替换关键alert | index.html | 9.1-1 | P0 | 2h |

**预估总工时**: 15h
**风险**: 按钮样式替换可能影响现有功能（需仔细测试）

### E3. Patch 9.2: 代码复用重构 + 交互统一

**目标**: 减少代码重复，统一交互逻辑

#### 任务列表

| 任务ID | 任务名 | 文件 | 依赖 | 优先级 | 工作量 |
|--------|--------|------|------|--------|--------|
| 9.2-1 | 提取公共JS函数（Toast/Modal/Confirm/DropZone/SSE/Progress） | index.html (script区) | 9.1-10 | P0 | 3h |
| 9.2-2 | 统一消息渲染函数 renderMessage() | index.html | 9.2-1, 9.1-5 | P0 | 2h |
| 9.2-3 | 问答Tab使用md()渲染 + 统一消息 | index.html | 9.2-2 | P0 | 1h |
| 9.2-4 | 提取三阶段状态路由工厂函数 | index.html | 9.2-1 | P1 | 2h |
| 9.2-5 | 统一所有confirm()为showConfirm() | index.html | 9.2-1 | P0 | 1h |
| 9.2-6 | 设置Tab训练记录用Modal替代prompt() | index.html | 9.2-1 | P1 | 1h |
| 9.2-7 | 统一所有`.result`反馈为showToast() | index.html | 9.2-1 | P1 | 1h |
| 9.2-8 | 提取统一空状态组件 | index.html | 9.2-1 | P1 | 0.5h |
| 9.2-9 | 统一错误处理：所有Tab静默失败改为showToast | index.html | 9.2-1 | P1 | 1h |

**预估总工时**: 12.5h
**风险**: renderMessage() 替换可能破坏对话Tab流式渲染

### E4. Patch 9.3: 后端API规范化（可选）

**目标**: API命名和响应格式统一

#### 任务列表

| 任务ID | 任务名 | 文件 | 依赖 | 优先级 | 工作量 |
|--------|--------|------|------|--------|--------|
| 9.3-1 | 删除废弃端点 (qa/upload, qa/ask, notebook/knowledge) | server.py | 无 | P2 | 0.5h |
| 9.3-2 | 添加 apiFetch() 前端统一请求函数 | index.html | 9.2-1 | P2 | 1h |
| 9.3-3 | 统一后端响应格式为 {ok, data, error} | server.py | 9.3-2 | P2 | 6h |
| 9.3-4 | 重命名不一致端点（加过渡期路由） | server.py | 9.3-3 | P3 | 3h |

**预估总工时**: 10.5h
**风险**: 响应格式统一影响面最大，需逐步推进

### E5. 风险和注意事项

1. **单文件约束**: 所有改动集中在一个5634行文件中，需要精确定位修改位置
2. **向后兼容**: 后端API改动必须保留旧路由（过渡期）
3. **测试策略**: 每完成一个任务，需要手动测试所有6个Tab的功能完整性
4. **CSS变量兼容性**: 内网环境可能使用旧版浏览器，CSS Variables 支持需确认
5. **内存限制**: 16GB 环境，前端JS不应引入大型框架或库
6. **顺序执行**: Patch 9.1 → 9.2 → 9.3 必须按序执行，9.2依赖9.1的CSS组件
7. **优先级**: 视觉统一(9.1) > 代码重构(9.2) > API规范化(9.3)，符合用户感知优先原则
8. **不变量**: 对话Tab的SSE流式渲染逻辑是核心功能，不可在重构中破坏

### E6. 总工时估算

| 阶段 | 工时 | 说明 |
|------|------|------|
| Patch 9.1 | 15h | 设计系统 + 视觉统一 |
| Patch 9.2 | 12.5h | 代码复用 + 交互统一 |
| Patch 9.3 | 10.5h | API规范化（可选） |
| **总计** | **38h** | 约 5 个工作日 |

# Patch 4 规划文档

> 版本：v0.9 Patch 4 | 日期：2026-06-10 | 状态：✅ 定稿

## 一、总览

Patch 4 以**代码重构 + 数据管理 + 依赖安全 + 首次引导**为主线，不新增核心功能，专注提升可维护性、健壮性和用户体验。

---

## 二、五大批次

### Batch 1：代码重构（P0+P1）

**目标**：消除结构性问题，降低维护成本。

| 任务 | 改动 | 文件数 | 风险 |
|------|------|--------|------|
| knowledge_base.py → knowledge/ | 1726行移入子包，修正所有 import | ~10 | 低（纯搬迁） |
| settings.py 拆分 | 1914行 → 3个路由文件（general/model/cloud） | ~6 | 低（FastAPI router 合并） |
| common/ 四合一 | 4文件200行 → common/utils.py | ~8 | 极低 |
| actions/ 收编 | doc_action.py → pipelines/ | ~3 | 极低 |
| validators/ 收编 | sidemate_validator.py → common/ | ~3 | 极低 |
| session/ 去反依赖 | chat_store.py 不再 import routers.deps | ~3 | 低 |

**原则**：纯搬迁 + import 修正，不改任何业务逻辑。

### Batch 2：数据聚合

**目标**：运行时数据统一分层，消除碎片。

```
重构前                          重构后
data/                          data/
├── chats/                     ├── chats/          ← 用户数据
├── kb/                        ├── kb/             ← 用户数据
├── kbsession/                 ├── kbsession/      ← 用户数据
├── recordings/                ├── recordings/     ← 用户数据
├── docs/                      ├── cache/
├── tmp_upload/                │   ├── docs/       ← 可清理
├── files/                     │   ├── uploads/    ← 可清理
├── logs/                      │   └── tmp/        ← 可清理
└── startup_progress.json      └── logs/           ← 定期清理
```

| 任务 | 说明 |
|------|------|
| cache 统一 | docs/tmp_upload/uploads/files → data/cache/{docs,uploads,tmp} |
| KB 向量泄漏修复 | `_save_vectors()` 原子写入 bug + 启动清理 .tmp.npz |
| 录音块自动清理 | 转写完成后删 chunks/ |
| 启动清理策略 | 扫描 data/cache/ 清理 >7 天文件 |
| ISS 卸载策略 | 用户数据保留，cache/logs 随卸载删除 |

### Batch 3：依赖安全网

**目标**：checksum 级依赖校验 + 压缩备份。

```
安装后流程：
ISS 安装 → 首次启动 → deps_check.py：
  1. 扫描 site-packages/，生成 deps_manifest.json（包名+版本+SHA256）
  2. wheels/ → zipfile 压缩为 backup/deps_snapshot.zip（~120MB）
  3. 删除原始 wheels/ 目录（省 270MB）

日常自检：
启动时 → 抽检 manifest → 发现损坏 → 从 deps_snapshot.zip 解压修复
```

| 任务 | 说明 |
|------|------|
| deps_manifest.json | 首次启动生成，记录每个包精确版本+hash |
| SHA256 校验 | 启动时快速抽检（不校全部，抽 20%核心包） |
| 压缩备份 | wheels/ → backup/deps_snapshot.zip（zipfile 内置库，零依赖） |
| 自动清理 | 压缩完成后删 wheels/ |
| 自修复流程 | 损坏 → 解压覆盖 → 重启 |

### Batch 4：收尾 + 扩展注册

**目标**：ISS 脚本适配 + LLM 包纳入扩展注册。

| 任务 | 说明 |
|------|------|
| ISS 脚本更新 | 适配新目录结构（cache/、backup/、无 wheels/） |
| LLM 扩展注册 | registry.py VALID_IDS 加 "llm"，安装时写 llm.json |
| 依赖声明 | KB 包 manifest.json 加 `"requires": ["llm"]` |
| 安装引导 | 安装 KB 包时检测 LLM 是否已装，未装则提示 |
| 冒烟测试 | 全新安装 + 覆盖安装 + 卸载清理 |

### Batch 5：首次使用引导 + 多状态审查

**目标**：根据用户安装状态，展示分层的首次使用引导 + 验证 6 种状态组合下程序行为正确。

#### 5.1 旧 overlay 处理

**保留** `updateChatOverlay()` 的 lock 卡片（"模型加载中"）。

保留原因：Ollama 配置了 keep_alive 24h，用户不关机超过 24h 后模型需重新加载，lock 卡片会再次出现。

welcome 卡片改为纯加载动画（不再做首次引导），首次教育由 Batch 5 的新 onboarding 接管。

#### 5.2 触发机制

```js
// localStorage 标记，一次性
if (!localStorage.getItem('sidemate_onboarded')) {
  showOnboarding();
}
// 用户完成引导后：
localStorage.setItem('sidemate_onboarded', '1');
```

#### 5.3 后端接口

新增 `GET /api/onboard/status`（Batch 4 LLM 注册的配套产物）：

```json
{
  "llm_installed": true,
  "cloud_configured": false,
  "kb_installed": true,
  "recorder_installed": false,
  "model_loaded": true
}
```

#### 5.4 引导路由设计

**核心思路**：按"能力层级"分路由，不按安装组合全排列。云端信息在 Route 2/3 内叠加显示。

##### Route 1：无任何 AI 引擎（llm=false AND cloud=false）

> **"Sidemate 需要一个 AI 引擎才能工作"**
>
> 两种方式任选其一（或都配）：
> - 🏠 **本地 AI**：安装 LLM 模型包，数据不出本机，无需联网
> - ☁️ **云端 AI**：填入 API Key 即可使用，无需本地模型
>
> [安装本地模型] [配置云端 AI]

##### Route 2：有 AI 引擎（本地 OR 云端），无 KB

> **"AI 已就绪！"**
>
> - 💬 **Chat 对话**：和 AI 自由聊天，支持上传文件
> - 🔒 **隐私**：所有数据存放在本机
>
> 💡 安装文库扩展包可解锁更多能力
>
> [开始使用]

**叠加层（有云端时显示）**：
> - ☁️ **在线模式**：切换到云端模型使用，搜索本地知识库辅助回答
> - 🔒 在线模式下本地数据不会上传，但你的问题会发送给云端服务

##### Route 3：有 AI 引擎 + KB（本地 LLM 必须有，因为 KB 依赖本地 LLM）

> **"全功能就绪！"**
>
> - 💬 **Chat 对话**：和 AI 自由聊天，支持上传文件
> - 📚 **文库 Tab**：上传文档，AI 基于你的文档回答
> - 🔄 **对比模式**：本地 + 云端同时回答，综合分析
>
> 🔒 **隐私设计**
> - 所有数据存放在本机，不上传
> - 在线模式 Chat 会搜索本地知识库辅助回答
> - 文库 Tab 不会将本地数据发送给云端
> - 对比模式中云端只看到你的问题和自己的历史

**叠加层（无云端时隐藏对比模式说明）**：对比模式段落仅在有云端时显示。

#### 5.5 判断逻辑伪代码

```js
async function showOnboarding() {
  const status = await fetch('/api/onboard/status').then(r => r.json());
  const hasAI = status.llm_installed || status.cloud_configured;
  const hasKB = status.kb_installed;
  const hasCloud = status.cloud_configured;

  if (!hasAI) {
    renderRoute1();  // "请先配置一个 AI 引擎"
  } else if (!hasKB) {
    renderRoute2({ hasCloud });  // "AI 已就绪" + 云端叠加
  } else {
    renderRoute3({ hasCloud });  // "全功能就绪" + 隐私详细说明
  }
}
```

#### 5.6 UI 形态

全屏半透明遮罩 + 居中卡片，风格与现有 welcome/lock overlay 一致。内容分两块：
1. **功能介绍**（根据路由 + 叠加条件动态渲染）
2. **隐私说明**（Route 2 基础版，Route 3 完整版，Route 1 无）

#### 5.7 纪要 Tab

**不在引导中出现**。纪要模块仍在测试阶段，不向用户提及。

#### 5.8 多状态代码审查

首次引导暴露了一个关键问题：**6 种安装状态组合下，程序逻辑是否都正确？**

| # | 本地 LLM | 云端 API | KB | 预期行为 | 审查重点 |
|---|---------|---------|-----|---------|---------|
| S1 | ❌ | ❌ | ❌ | Chat 锁屏/引导 | updateChatOverlay() 是否正确处理 |
| S2 | ❌ | ✅ | ❌ | 仅在线 Chat | 切换在线模式后 Chat 是否正常工作 |
| S3 | ✅ | ❌ | ❌ | 仅离线 Chat | 标准路径，应无问题 |
| S4 | ✅ | ✅ | ❌ | 离线+在线 Chat | 模式切换是否干净 |
| S5 | ✅ | ❌ | ✅ | Chat + 文库（无对比） | 对比按钮是否隐藏/禁用 |
| S6 | ✅ | ✅ | ✅ | 全功能 | 标准路径 |

**审查范围**：
- 前端：模式切换、Tab 显隐、对比按钮显隐、SSE 管道选择
- 后端：`create_pipeline()` 路由、CloudEngine 初始化、KB 权限控制
- 边界：云端配置了但 key 无效、本地 LLM 装了但加载失败、KB 装了但无文档

**审查时机**：Batch 1 代码重构完成后、Batch 5 引导实现前。

**Bug 修复策略**：审查发现的问题直接在 P4 中修复。P3 不再维护（灰度测试为 S6 全功能版本，不会触发其他状态）。仅当发现 P0 级阻塞用户使用的问题时才考虑 P3 hotfix。

---

## 三、不做的事

| 项目 | 原因 |
|------|------|
| JS 拆分重构 | 传统 `<script>` 模式下拆分收益不大 |
| LLM+KB 合并为一个大包 | 4.4GB 太大，下载中断风险高，保持分离更灵活 |
| 纪要模块引导 | 模块仍在测试，不对外 |

---

## 四、预估工作量

| 批次 | 工作量 | 说明 |
|------|--------|------|
| Batch 1 | 1-2 天 | 纯搬迁，机械操作 |
| Batch 2 | 1-2 天 | 数据迁移 + 清理逻辑 |
| Batch 3 | 1 天 | deps_check 增强 |
| Batch 4 | 1 天 | ISS + 扩展注册 + 测试 |
| Batch 5 | 1 天 | 引导 UI + 多状态审查 |
| **合计** | **5-7 天** | |

---

## 五、安全性确认

- `settings.json`（含云端 API Key）**不进 ISS 安装包**
- extensions/*.json 已在 ISS 中 Excludes
- API Key 以 base64 编码存储在 settings.json，运行时自动生成
- 首次引导中的隐私说明与实际代码行为一致（P4 审查验证）

---

## 六、P3 版本策略

- P3 为**过时版本**，不再主动维护
- 灰度测试为 S6（本地+云端+KB 全功能）版本，多状态问题不会被触发
- 审查发现的 bug 直接在 P4 中修复
- **例外**：仅 P0 级影响用户正常使用的问题才考虑 P3 hotfix

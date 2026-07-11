# PATCH 8B — 设置 Tab 重布局 + 内存预算修正 + 会话锁修正

> **架构设计文档** | 版本 1.0 | 2025-07-14

---

## 目录

- [A. 设置 Tab 新布局设计](#a-设置-tab-新布局设计)
- [B. 内存预算逻辑修正](#b-内存预算逻辑修正)
- [C. 会话锁修正](#c-会话锁修正)
- [D. 任务分解](#d-任务分解)

---

## A. 设置 Tab 新布局设计

### A1. 现状问题分析

| 问题 | 根因 |
|------|------|
| 系统资源面板 + 内存预算面板数据混乱 | 两个面板分从 `/api/kb/memory-info` 和 `/api/kb/stats` 取数据，含义不同 |
| "知识库 1.2 GB" vs embedder 645MB | 系统资源面板显示的是 `kb_models_mb`（embedder+reranker 之和），预算面板的 modules 只显示 KB 内部注册值 |
| 内存管理和模型管理混在一起 | HTML 把模型加载/算力设备/内存管理/API配置/导入模型塞进一个 `<div class="panel">` |
| 显示 "8.6 GB / 7.8 GB" | `used_mb` 是进程总 RSS（含 LLM 6GB+），而 `budget_mb` 默认只有 8G |

### A2. 新布局结构（三区块）

```
┌─────────────────────────────────────────────────────────┐
│  📊 资源调度中心                                          │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  系统内存总览（统一面板）                               │ │
│  │  ┌─ 总内存条：已用 8.2 / 16 GB (51%) ──────────────────┐│ │
│  │  │  ▓▓▓▓ LLM 6.2GB ▓▓ KB 0.6GB ▓ 系统基础 1.4GB ▓░░░░││ │
│  │  └────────────────────────────────────────────────────┘│ │
│  │  ● 模型 6.2 GB  ● 知识库 0.6 GB  ● 系统可用 7.8 GB     │ │
│  │                                                        │ │
│  │  ── 内存预算 ────────────────────────────────────────── │ │
│  │  预算 10.0 GB（建议范围 8~12 GB）    已用 2.4 GB (24%)  │ │
│  │  ┌─ 预算条：LLM 6.2GB ▓ Embedder 0.6GB ▓ Reranker 0GB░░┐│ │
│  │  └─────────────────────────────────────────────────────┘│ │
│  │  模块明细：LLM 6.2GB | Embedder 645MB | Reranker --    │ │
│  │  [预算滑块：8G ═════════●══════ 12G]                   │ │
│  └──────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  🧠 模型管理                                              │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  模型选择 + 加载/卸载按钮                               │ │
│  │  算力设备选择                                          │ │
│  │  Reranker 常驻开关                                    │ │
│  │  导入模型                                             │ │
│  └──────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  ⚙️ 高级设置（<details> 折叠）                             │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  云端 API 配置                                        │ │
│  │  环境信息                                             │ │
│  │  训练记录                                             │ │
│  └──────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### A3. HTML 结构概要

```html
<!-- 设置 Tab -->
<div id="tab-settings" class="tab-content">

  <!-- 区块 1: 资源调度中心 -->
  <div class="panel" style="flex:0 0 auto">
    <h3>📊 资源调度中心</h3>
    
    <!-- 系统内存总览条 -->
    <div style="display:flex;align-items:center;gap:8px;font-size:.82em;margin-bottom:4px">
      <span id="resMemLabel">-- / --</span>
      <div style="flex:1;background:#e5e7eb;border-radius:4px;height:8px;overflow:hidden;display:flex">
        <div id="resBarLLM" style="background:#6366f1;height:100%;transition:width .4s;width:0"></div>
        <div id="resBarKB" style="background:#f59e0b;height:100%;transition:width .4s;width:0"></div>
        <div id="resBarBase" style="background:#94a3b8;height:100%;transition:width .4s;width:0"></div>
      </div>
      <span id="resPercent">--</span>
    </div>
    <!-- 模块占用行 -->
    <div style="display:flex;flex-wrap:wrap;gap:4px 12px;font-size:.8em;color:#555">
      <span style="color:#6366f1">● 模型 <b id="resLLM">未加载</b></span>
      <span style="color:#f59e0b">● 知识库 <b id="resKB">未加载</b></span>
      <span style="color:#16a34a">● 系统可用内存 <b id="resAvail">--</b></span>
    </div>
    
    <!-- 分隔线 -->
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid #e5e7eb">
      <!-- 预算行：标签 + 值 -->
      <div style="display:flex;align-items:center;gap:8px;font-size:.8em;margin-bottom:3px">
        <span style="color:#555;font-weight:500">内存预算</span>
        <span id="budgetLabel">-- / --</span>
        <div style="flex:1;background:#e5e7eb;border-radius:4px;height:6px;overflow:hidden">
          <div id="budgetBar" style="height:100%;border-radius:4px;transition:width .4s,background .4s;width:0"></div>
        </div>
        <span id="budgetPercent">--</span>
      </div>
      <!-- 预算模块明细 -->
      <div id="budgetModules" style="display:flex;flex-wrap:wrap;gap:4px 10px;font-size:.72em;color:#888"></div>
      <!-- 预算滑块（新增） -->
      <div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:.78em">
        <span style="color:#999">8G</span>
        <input type="range" id="budgetSlider" min="8" max="12" step="0.5" value="10" 
               style="flex:1" onchange="onBudgetSliderChange(this.value)">
        <span style="color:#999">12G</span>
        <span id="budgetSliderValue" style="font-weight:600;min-width:48px">10.0 GB</span>
      </div>
    </div>
  </div>

  <!-- 区块 2: 模型管理 -->
  <div class="panel">
    <h3>🧠 模型管理</h3>
    <!-- 模型选择 + 加载 -->
    ...
    <!-- 算力设备 -->
    <hr>
    ...
    <!-- Reranker 常驻开关 -->
    <hr>
    ...
    <!-- 导入模型 -->
    <hr>
    ...
  </div>

  <!-- 区块 3: 高级设置（折叠） -->
  <details>
    <summary>⚙️ 高级设置</summary>
    <!-- 云端 API -->
    <!-- 环境信息 -->
    <!-- 训练记录 -->
  </details>
</div>
```

### A4. 统一数据源方案

**核心变更：合并两个 API 为一个**

当前：
- 系统资源面板 → `GET /api/kb/memory-info` → `_get_memory_info()`
- 预算面板 → `GET /api/kb/stats` → `kb.get_stats()` → `memory_report`

**新方案：扩展 `_get_memory_info()` 返回预算数据**

新增/修改 API 端点：

```
GET /api/resource-info    （新端点，合并原 /api/kb/memory-info 的系统内存 + 预算数据）
```

返回数据结构：

```json
{
  "system": {
    "total_mb": 16384,
    "used_mb": 8200,
    "available_mb": 8184,
    "process_mb": 8200
  },
  "modules": {
    "llm": { "name": "qwen3-8b-int4-ov", "mb": 6200, "loaded": true },
    "embedder": { "name": "bge-base-zh-v1.5", "mb": 645, "loaded": true },
    "reranker": { "name": "bge-reranker-base", "mb": 0, "loaded": false },
    "base": { "mb": 1355 }
  },
  "budget": {
    "limit_mb": 10240,
    "modules_used_mb": 6845,
    "available_mb": 3395,
    "usage_ratio": 0.67,
    "recommended_min_mb": 8192,
    "recommended_max_mb": 12288,
    "suggested_mb": 10240
  }
}
```

关键区别：
- `budget.modules_used_mb` = **只计入可卸载模块** (LLM + embedder + reranker)，不含进程基础
- `budget.limit_mb` = 用户设定的预算上限（可调 8~12G）
- `budget.available_mb` = `limit_mb - modules_used_mb`
- 推荐值基于系统实际可用内存动态计算

前端 `refreshResourcePanel()` 改为只调一个 API，一次渲染两个区域。

---

## B. 内存预算逻辑修正

### B1. 根本问题

```
当前 MemoryManager:
  budget_mb = 8000 (固定)
  used_mb = psutil.Process().memory_info().rss  ← 进程总 RSS，含 Python 基础 + LLM + KB + ...
  available_mb = max(0, budget_mb - used_mb)    ← LLM 占 6G 后，只剩 2G，但 budget 本身就小于 RSS
  
  can_allocate(1000):
    current = measure()  ← 8793 MB (进程总 RSS)
    return (8793 + 1000) <= 8000 * 0.9  ← 永远 False！
```

**问题总结**：
1. `budget_mb` 的含义混乱 — 它不是"进程内存上限"，而是"模型占用预算"
2. `measure()` 返回进程总 RSS（含 Python 基础 ~500MB），不应计入"模型占用"
3. `can_allocate()` 比较的是 RSS vs budget，语义不对
4. 预算 8G 太小 — LLM 6G + embedder 0.6G + reranker 0.6G = 7.2G，已经接近 8G

### B2. 修正方案

#### MemoryManager 修正设计

```python
class MemoryManager:
    """内存预算管理器 v2 — 基于"可卸载模块"追踪，不依赖进程总 RSS

    核心变更：
    - budget_mb = 用户设定的模型内存预算上限
    - used_mb = 所有已注册模块的占用之和（非进程 RSS）
    - can_allocate = 检查 (已注册模块总和 + 新请求) 是否超预算
    - 提供 recommended_budget() 基于系统可用内存动态建议
    """
    
    def __init__(self, budget_mb: int = 8000):
        self.budget_mb = budget_mb
        self.modules: Dict[str, dict] = {}  # {name: {"mb": int, "category": str}}
        # category: "llm" | "kb" | "other"
    
    def measure(self) -> int:
        """psutil 进程总 RSS（仅供参考，不参与预算计算）"""
        ...
    
    def register(self, module_name: str, mb: int, category: str = "kb"):
        """注册模块占用，带分类标签"""
        self.modules[module_name] = {"mb": mb, "category": category}
    
    def unregister(self, module_name: str):
        """注销模块"""
        self.modules.pop(module_name, None)
    
    @property
    def modules_used_mb(self) -> int:
        """已注册模块的总占用（不含进程基础）"""
        return sum(m["mb"] for m in self.modules.values())
    
    def can_allocate(self, estimated_mb: int) -> bool:
        """检查是否有足够预算
        
        逻辑：(已注册模块总和 + 新请求) <= 预算 × 90%
        不再依赖进程 RSS！
        """
        return (self.modules_used_mb + estimated_mb) <= self.budget_mb * 0.9
    
    def get_report(self) -> dict:
        """返回预算报告 v2"""
        used = self.modules_used_mb
        available = max(0, self.budget_mb - used)
        ratio = round(used / self.budget_mb, 2) if self.budget_mb > 0 else 0
        return {
            "budget_mb": self.budget_mb,
            "modules_used_mb": used,
            "available_mb": available,
            "usage_ratio": ratio,
            "modules": {name: info["mb"] for name, info in self.modules.items()},
            "module_categories": {name: info["category"] for name, info in self.modules.items()},
        }
    
    @staticmethod
    def recommended_budget() -> dict:
        """基于系统可用内存，建议预算范围"""
        try:
            import psutil
            total = psutil.virtual_memory().total // (1024 * 1024)
            avail = psutil.virtual_memory().available // (1024 * 1024)
        except Exception:
            return {"min_mb": 8192, "max_mb": 12288, "suggested_mb": 10240}
        
        # 建议策略：
        # - 系统总内存 >= 32G → 建议 12G
        # - 系统总内存 >= 16G → 建议 10G  
        # - 系统总内存 >= 8G  → 建议 8G
        if total >= 32768:
            suggested = 12288
        elif total >= 16384:
            suggested = 10240
        else:
            suggested = 8192
        
        return {
            "min_mb": 8192,
            "max_mb": min(16384, int(total * 0.8)),  # 不超过系统总内存的 80%
            "suggested_mb": suggested,
        }
    
    def set_budget(self, new_mb: int) -> bool:
        """更新预算上限（用户通过滑块调整）"""
        rec = self.recommended_budget()
        new_mb = max(rec["min_mb"], min(rec["max_mb"], new_mb))
        self.budget_mb = new_mb
        # 持久化到 config
        from config import set_value
        set_value("memory_budget_mb", new_mb)
        return True
```

#### LLM 模块注册（models.py 修改点）

```python
# 在 ModelManager 加载 LLM 成功后：
kb.memory_manager.register("llm", llm_mem_mb, category="llm")

# 在卸载 LLM 时：
kb.memory_manager.unregister("llm")
```

当前 LLM 注册缺失！只有 embedder 和 reranker 被 register 了。这是 "modules_used_mb" 不含 LLM 的原因之一。

### B3. server.py `_check_memory_budget` 修正

```python
def _check_memory_budget(estimated_mb: int = 0) -> Optional[dict]:
    """内存预算检查 v2"""
    try:
        report = kb.memory_manager.get_report()
        if not kb.memory_manager.can_allocate(estimated_mb):
            return {
                "error": "内存预算不足：剩余 %dMB，本次需要约 %dMB（预算 %dMB，已用 %dMB）"
                         % (report["available_mb"], estimated_mb,
                            report["budget_mb"], report["modules_used_mb"]),
                "budget_mb": report["budget_mb"],
                "modules_used_mb": report["modules_used_mb"],
                "available_mb": report["available_mb"],
                "usage_ratio": report["usage_ratio"],
            }
    except Exception as e:
        log.warning("[SERVER] 内存预算检查异常（放行）: %s", str(e))
    return None
```

### B4. server.py 新 API 端点

```python
@app.get("/api/resource-info")
def api_resource_info():
    """统一的资源信息端点（供设置页资源面板使用）"""
    import psutil
    
    mem = psutil.virtual_memory()
    process = psutil.Process(os.getpid())
    process_mb = process.memory_info().rss / 1024 / 1024
    
    # 模块信息
    llm_loaded = mgr.get_loaded_llms()
    llm_name = llm_loaded[0] if llm_loaded else None
    llm_mb = mgr.get_llm_mem_mb(llm_name) if llm_name else 0
    
    kb_active = kb._embedder_loaded and kb.embedder.mode == "bge-ov"
    kb_models_mb = kb._embedder_mem_mb + kb._reranker_mem_mb if kb_active else 0
    
    kb_reranker_loaded = kb.reranker.available
    reranker_mb = kb._reranker_mem_mb if kb_reranker_loaded else 0
    embedder_mb = kb._embedder_mem_mb if kb_active else 0
    base_mb = max(0, process_mb - llm_mb - kb_models_mb)
    
    # 预算报告（v2：不含进程基础）
    budget_report = kb.memory_manager.get_report()
    recommended = MemoryManager.recommended_budget()
    
    return {
        "system": {
            "total_mb": round(mem.total / 1024 / 1024),
            "used_mb": round(mem.used / 1024 / 1024),
            "available_mb": round(mem.available / 1024 / 1024),
            "process_mb": round(process_mb),
        },
        "modules": {
            "llm": {"name": llm_name, "mb": llm_mb, "loaded": llm_name is not None},
            "embedder": {"name": "bge-base-zh-v1.5", "mb": embedder_mb, "loaded": kb_active},
            "reranker": {"name": "bge-reranker-base", "mb": reranker_mb, "loaded": kb_reranker_loaded},
            "base": {"mb": round(base_mb)},
        },
        "budget": {
            "limit_mb": budget_report["budget_mb"],
            "modules_used_mb": budget_report["modules_used_mb"],
            "available_mb": budget_report["available_mb"],
            "usage_ratio": budget_report["usage_ratio"],
            **recommended,
        }
    }

@app.post("/api/budget")
def api_set_budget(request: dict):
    """设置内存预算"""
    new_mb = request.get("budget_mb")
    if not new_mb or not isinstance(new_mb, (int, float)):
        return {"error": "无效的预算值"}
    ok = kb.memory_manager.set_budget(int(new_mb))
    return {"ok": ok, "budget_mb": kb.memory_manager.budget_mb}
```

### B5. 前端单位换算修正

当前问题：`fmt()` 函数 `if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB'`，整数 MB 不保留小数。

修正：
```javascript
function fmtMB(mb) {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  if (mb > 0) return mb + ' MB';
  return '--';
}
```

预算条显示修正：
```javascript
// 旧：budgetLabel.textContent = fmt(report.used_mb) + ' / ' + fmt(report.budget_mb);
// 新：
budgetLabel.textContent = fmtMB(budget.modules_used_mb) + ' / ' + fmtMB(budget.limit_mb);
```

---

## C. 会话锁修正

### C1. 现状分析

| 锁类型 | 影响范围 | 问题 |
|--------|----------|------|
| `generating` flag | 禁用 sendBtn/stopBtn/input/sessionSelect/newChatBtn/delChatBtn | ✅ 合理，只锁对话区 |
| `_kbBusyProcessing` | 显示 `kbLockOverlay`（`position:fixed; z-index:100`）| ❌ **全页覆盖，阻挡 Tab 切换** |
| Whisper D22 锁 | 禁用 msgInput + placeholder 提示 | ✅ 只锁输入框 |

**根因**：`kbLockOverlay` 使用 `position:fixed` 覆盖整个页面，包括 Tab 导航栏。

### C2. 修正方案

#### 修正 1: kbLockOverlay 改为覆盖对话区内部

**变更文件**: `index.html`

**变更内容**：

1. 将 `kbLockOverlay` 从 `position:fixed` 改为 `position:absolute`，放在 `tab-chat` 内部

当前 HTML 结构 (行 314-319):
```html
<!-- KB处理中锁定聊天 - 全页覆盖 -->
<div id="kbLockOverlay" class="kb-lock-overlay" style="display:none">
```

修正后：
```html
<!-- KB处理中锁定聊天 - 仅覆盖对话区（不锁 Tab 导航） -->
<div id="kbLockOverlay" class="kb-lock-overlay" style="display:none;position:absolute;z-index:10">
```

CSS 变更 (行 246):
```css
/* 旧 */
.kb-lock-overlay{position:fixed;inset:0;...;z-index:100;...}
/* 新：改为 absolute，只覆盖父容器 */
.kb-lock-overlay{position:absolute;top:48px;left:0;right:0;bottom:0;...;z-index:10;...}
```

这样 `kbLockOverlay` 只覆盖 `tab-chat` 的内容区域（和 `chatModelOverlay` 一样），不会阻挡 Tab 导航。

#### 修正 2: switchTab 确保不受锁影响

当前 `switchTab()` 函数本身**不检查** `generating` 或 `_kbBusyProcessing`，Tab 按钮也无 `disabled` 逻辑。所以 Tab 切换本身已经不被锁。问题只来自 overlay 的 CSS 遮挡。

修正 1 解决后，Tab 切换将正常工作。

### C3. 需要改的 HTML 元素清单

| 元素 | 文件 | 行号 | 变更 |
|------|------|------|------|
| `.kb-lock-overlay` CSS | index.html | ~246 | `position:fixed` → `position:absolute;top:48px;...;z-index:10` |
| `kbLockOverlay` HTML | index.html | ~315 | 添加 `position:absolute;z-index:10` inline style |

---

## D. 任务分解

### 任务优先级排序

| 优先级 | 任务 | 理由 |
|--------|------|------|
| P0 | 内存预算逻辑修正 | 当前预算检查永远失败，KB 加载不可用 |
| P0 | 会话锁修正 | 影响用户体验，改动小 |
| P1 | 统一资源 API | 数据源合并，消除双面板数据混乱 |
| P1 | 设置 Tab 新布局 | HTML 结构重组 |
| P2 | 预算滑块 UI | 需要 API + 前端配合，依赖前序任务 |

---

### T01: 项目基础设施 + 后端核心修正
**优先级**: P0  
**涉及文件**: 
- `knowledge_base.py` — MemoryManager 类重写
- `config.py` — 新增 memory_budget_mb 范围常量
- `server.py` — `_check_memory_budget` 修正 + `/api/resource-info` + `/api/budget` 端点
- `models.py` — LLM 加载/卸载时 register/unregister memory_manager

**改动内容**:
1. `MemoryManager` 类重写：`modules_used_mb` 属性替代 `measure()` 作为预算依据；新增 `recommended_budget()` 静态方法；新增 `set_budget()` 方法
2. `MemoryManager.register()` 增加 `category` 参数
3. `ModelManager` 加载 LLM 成功后调用 `kb.memory_manager.register("llm", mb, "llm")`
4. `ModelManager` 卸载 LLM 时调用 `kb.memory_manager.unregister("llm")`
5. `_check_memory_budget()` 使用 `modules_used_mb` 替代 `measure()`
6. 新增 `GET /api/resource-info` 统一端点
7. 新增 `POST /api/budget` 端点
8. `config.py` DEFAULTS 增加 `memory_budget_min_mb: 8192`, `memory_budget_max_mb: 12288`

**依赖**: 无

---

### T02: 设置 Tab HTML 重布局 + 会话锁修正
**优先级**: P0/P1  
**涉及文件**: 
- `index.html` — 设置 Tab HTML 结构重组 + CSS 修正 + kbLockOverlay 修正

**改动内容**:
1. 设置 Tab HTML 重组为三个区块：资源调度中心 / 模型管理 / 高级设置
2. 将模型加载、算力设备、Reranker 常驻、导入模型归入"模型管理"区块
3. 将云端 API、环境信息、训练记录归入"高级设置"折叠区
4. 修正 `.kb-lock-overlay` CSS：`position:fixed` → `position:absolute`，限制在对话区内
5. 修正 `kbLockOverlay` HTML inline style
6. 添加预算滑块 HTML 元素
7. 调整各区域间距和分割线

**依赖**: T01（需要新 API 端点才能正确渲染）

---

### T03: 前端资源面板 JS 重写
**优先级**: P1  
**涉及文件**: 
- `index.html` — `refreshResourcePanel()` 函数重写 + 预算滑块交互逻辑

**改动内容**:
1. `refreshResourcePanel()` 改为调用 `/api/resource-info`（单一数据源）
2. 统一 `fmtMB()` 单位换算函数（保留 1 位小数）
3. 系统内存总览条渲染：使用 `system.total/used/available` + `modules` 分解
4. 预算条渲染：使用 `budget.modules_used_mb` 而非进程 RSS
5. 预算滑块交互：`onBudgetSliderChange()` → `POST /api/budget`
6. 预算推荐值初始化：从 API 获取 `suggested_mb` 设置滑块默认值
7. 删除旧的 `/api/kb/stats` 中 `memory_report` 的前端消费逻辑

**依赖**: T01（新 API）+ T02（新 HTML 结构）

---

### T04: KB 摘要 + 边缘场景修复
**优先级**: P2  
**涉及文件**:
- `knowledge_base.py` — `_generate_doc_summary()` 稳定性改进
- `server.py` — 移除旧的 `/api/kb/memory-info` 或标记为 deprecated

**改动内容**:
1. 摘要生成增加超时保护（当前重试间隔过长）
2. `/api/kb/memory-info` 标记为 deprecated，内部重定向到 `/api/resource-info`
3. 边缘测试：LLM 未加载时预算显示、全部模型卸载后预算回零

**依赖**: T01

---

### 任务依赖图

```
T01 (后端核心修正) ──── T02 (HTML重布局) ──── T03 (前端JS重写)
        │                                          
        └──────────────── T04 (边缘修复)
```

---

## 共享知识

### API 响应格式
- 所有 API 返回 JSON，错误用 `{"error": "..."}` 格式
- 成功用 `{"ok": true, ...}` 或直接返回数据对象

### 内存数据语义
- `system.total_mb` / `system.used_mb` / `system.available_mb` — **系统物理内存**（psutil.virtual_memory）
- `system.process_mb` — **进程 RSS**（仅供参考，不参与预算计算）
- `modules.*.mb` — 各模块的**实测或估算占用**
- `budget.modules_used_mb` — 所有已注册模块占用之和（**预算计算基础**）
- `budget.limit_mb` — 用户设定的预算上限
- `budget.available_mb` = `limit_mb - modules_used_mb`

### 预算策略
- 默认 8G，可调 8~12G
- 建议值基于系统物理内存动态计算
- 安全余量：`can_allocate` 检查 `(modules_used + estimated) <= budget * 0.9`
- LLM 必须注册到 MemoryManager（当前缺失！）

### 前端单位换算
- 统一使用 `fmtMB(mb)` 函数
- `>= 1024 MB` → 显示为 `X.X GB`
- `< 1024 MB` → 显示为 `XXX MB`
- `0` → 显示为 `--`

---

## UNCLEAR / 假设

1. **LLM 内存占用获取方式**: 假设 `mgr.get_llm_mem_mb()` 已存在且返回实测值（需要验证 models.py 中是否有此方法）
2. **kbLockOverlay 是否是用户反馈的"Tab 锁"**: 用户说"对话生成时无法切换 Tab"，但 `generating` flag 不阻止 Tab 切换。可能用户指的是 KB 摘要处理时的全页锁。已按此假设设计。
3. **MemoryManager 单例**: 当前通过 `kb.memory_manager` 引用，models.py 需要 import `kb` 来注册 LLM。假设 models.py 可以安全 import knowledge_base（需检查循环依赖）。
4. **旧 API 兼容**: `/api/kb/memory-info` 和 `/api/kb/stats` 仍在其他地方使用（如激活页），不能直接删除，只能标记 deprecated。

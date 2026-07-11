# Patch2 后端任务方案

> 基于 `v0.9.2-patch2-prd.md` 后端任务，按实施顺序排列
> 工作目录：`C:\tmp\_Sidemate_0.9_patch2\`

---

## 总览

| 序号 | 任务 | PRD编号 | 优先级 | 复杂度 | 依赖 |
|------|------|---------|--------|--------|------|
| 1 | num_ctx 修复 | A1 | 架构 | ⭐ | 无 |
| 2 | 云端 AI 模式 | A2 | P0 | ⭐⭐⭐ | 无 |
| 3 | Research Action | A4 | P0 | ⭐⭐⭐ | A2 |
| 4 | 会话重命名 | B1 | P0 | ⭐ | 无 |
| 5 | 数据备份/恢复 | C1 | P0 | ⭐⭐ | 无 |
| 6 | 日志清理 | E1 | P0 | ⭐ | 无 |
| 7 | 上下文圆环 | A6 | 架构 | ⭐⭐ | A2 |
| 8 | 离线上下文强制新建 | A8 | 架构 | ⭐⭐ | A1 |
| 9 | 在线云端自动压缩 | A10 | 架构 | ⭐⭐ | A2 |
| 10 | Ollama 崩溃自动重启 | F1 | P1 | ⭐ | 无 |
| 11 | 设置持久化优化 | H1 | P1 | ⭐ | 无 |
| 12 | 启动画面(Go) | J1 | P0 | ⭐⭐⭐ | 无 |

---

## 第一波：无依赖，可立即开工

### 1. A1 — num_ctx 修复 ⭐

**文件**：`core/stream_engine.py`、`core/model_manager.py`

**现状**：
- `stream_engine.py` 构建 Ollama payload 时只传了 `num_predict`，没传 `num_ctx`
- Ollama 默认 KV cache 只有 2048-4096 tokens，导致长对话被截断
- `model_manager.py` 的 `_CHARS_PER_TOKEN = 1.5` + `_MAX_PROMPT_CHARS = 28000` 但 context_window 写的 32000（假值）

**方案**：

```python
# stream_engine.py — payload 构建（~行 130-150 区域）
# 原来：
"options": {"num_predict": max_tokens}
# 改为：
"options": {"num_predict": max_tokens, "num_ctx": 16000}

# model_manager.py — profile 参数
# 4B profile 调整：
#   max_history_chars: 5000 → 12000
#   context_window: 32000 → 16000
# 新增 _get_default_num_ctx() 方法返回 16000
```

**风险**：低。纯参数调整，Ollama 的 `num_ctx` 是 KV cache 上限，设大不影响性能（只是占更多内存，4B 模型 ~3GB 绰绰有余）。

---

### 2. B1 — 会话重命名 ⭐

**文件**：`session/chat_store.py`（新增函数）、`routers/chat.py`（新增端点）

**方案**：

```python
# session/chat_store.py 新增：
def rename_chat(old_name: str, new_name: str) -> dict:
    """重命名会话文件"""
    # 1. old_name → 找到对应 .json 文件
    # 2. new_name → 生成安全的文件名（safe_chat_name）
    # 3. os.rename(old_path, new_path)
    # 4. 返回 {"ok": True, "new_file": "xxx.json"}

# routers/chat.py 新增端点：
@router.post("/api/chats/{chat_name}/rename")
async def rename_chat_endpoint(chat_name: str, body: RenameRequest):
    ...
```

**风险**：低。纯文件操作，参考现有 `new_chat_file()` 和 `save_chat()` 的模式。

---

### 3. E1 — 日志清理 ⭐

**文件**：新增 `core/log_cleanup.py`、修改 `server.py`

**方案**：

```python
# core/log_cleanup.py
def cleanup_old_logs(log_dir: str, max_age_days: int = 30):
    """清理超过 max_age_days 天的日志"""
    import os, time
    cutoff = time.time() - max_age_days * 86400
    removed = 0
    for f in os.listdir(log_dir):
        fp = os.path.join(log_dir, f)
        if os.path.isfile(fp) and os.path.getmtime(fp) < cutoff:
            os.remove(fp)
            removed += 1
    return removed

# server.py — 在启动逻辑中注册：
# 启动时执行一次 + 启动后台线程每 24h 执行一次
```

**风险**：极低。只删 `data/logs/` 下的旧文件，不影响任何运行逻辑。

---

### 4. C1 — 数据备份/恢复 ⭐⭐

**文件**：新增 `routers/backup.py`、修改 `server.py`（注册 router）

**方案**：

```python
# routers/backup.py
import zipfile, io, json, shutil

@router.post("/api/backup/export")
async def export_backup():
    """导出 ZIP：chats/ + settings.json + kb_meta/ + backup_meta.json"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        # 1. chats/ 目录下所有 .json
        # 2. settings.json
        # 3. data/kb/documents.json（如果存在）
        # 4. backup_meta.json
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/zip", ...)

@router.post("/api/backup/import")
async def import_backup(file: UploadFile):
    """从 ZIP 恢复"""
    # 1. 验证 ZIP 格式
    # 2. 恢复 chats
    # 3. 恢复 settings（合并，不覆盖已有 key）
    # 4. 恢复 kb_meta
    # 返回 {"ok": True, "restored": {...}}
```

**风险**：中。需要注意：
- 恢复时不要直接覆盖正在使用的 settings（需要 merge）
- ZIP 解压需要防路径穿越（`../`）
- 恢复后可能需要刷新前端（清 cache）

---

### 5. F1 — Ollama 崩溃自动重启 ⭐

**文件**：`core/ollama_manager.py`

**方案**：

在现有的 watchdog 线程中，检测到 Ollama 进程退出时：
1. 记录日志
2. 自动调用 `start_ollama()` 重启
3. 前端通过 `/api/health` 心跳自然感知（已有机制）

**风险**：低。现有 watchdog 已有进程检测逻辑，只需加重启调用。

---

### 6. H1 — 设置持久化优化 ⭐

**文件**：`config.py`

**现状**：`get()` 每次都读磁盘（TTL 5 秒缓存），`save_config()` 写磁盘后清 cache。

**方案**：

```python
# config.py 优化：
# - 启动时 load_config() 存到 _config_cache（内存字典）
# - get() 直接读内存
# - save_config() 写磁盘 + 更新内存
# - 删除 TTL 机制（不需要了，内存即真相）
```

**风险**：低。纯优化，接口不变。注意多线程安全（已有 `_cache_lock`）。

---

## 第二波：依赖 A2（云端 AI 模式）

### 7. A2 — 云端 AI 模式 ⭐⭐⭐（核心任务）

**新增文件**：`core/cloud_engine.py`
**修改文件**：`core/model_manager.py`、`routers/settings.py`、`config.py`、`core/deps_check.py`

**架构设计**：

```
ModelManager.chat_stream()  ← 上层唯一入口，不变
        │
        ├─ if ai_mode == "local":
        │      └─ StreamEngine.run()  ← 现有逻辑，不动
        │
        └─ if ai_mode == "cloud":
               └─ CloudEngine.run()  ← 新增
```

**关键实现**：

```python
# core/cloud_engine.py（~200 行）
class CloudEngine:
    """云端 AI 引擎：OpenAI SDK → 兼容 API"""
    
    def __init__(self, model_manager):
        self._mm = model_manager
    
    def run(self, message, history=None, context_cache=None,
            max_tokens=None, context_policy="full",
            slim_history_rounds=6, **kwargs):
        """流式生成，yield (phase, content) 元组
        与 StreamEngine.run() 输出格式完全一致
        """
        # 1. 从 settings 读云端配置
        # 2. 根据 context_policy 裁剪 history
        # 3. 构建 messages 数组
        # 4. openai.OpenAI().chat.completions.create(stream=True)
        # 5. yield ("text", chunk) 逐 token
        # 6. yield ("task_type", ("text", 0.99))
```

**config.py 新增字段**：

```python
DEFAULTS 新增：
    "ai_mode": "local",              # "local" | "cloud"
    "cloud_base_url": "https://api.openai.com/v1",
    "cloud_api_key": "",             # base64 编码存储
    "cloud_model": "gpt-4o-mini",
    "cloud_context_policy": "full",  # "full" | "current_only" | "slim_history"
    "cloud_slim_history_rounds": 6,
```

**settings.py 新增端点**：
- `GET /api/mode` — 当前模式 + 上下文参数
- `POST /api/mode/switch` — 切换模式（含连接测试）
- `GET /api/cloud/config` — 云端配置（API Key 脱敏）
- `POST /api/cloud/config` — 保存云端配置
- `POST /api/cloud/test` — 测试云端连接

**model_manager.py 修改**：
- `chat_stream()` 内部加模式路由（5 行 if/else）
- `_get_profile()` 根据 ai_mode 返回不同上下文参数
- 新增 `_get_cloud_context_window()` 方法

**deps_check.py 修改**：
- 新增 `openai` 包检查

**关键约束**：
- CloudEngine 输出格式必须与 StreamEngine 完全一致（phase/content 元组）
- 上层所有 20+ 个调用点（chat.py、kb.py、recorder.py 等）**零修改**
- API Key 用 base64 编码存 settings.json（简单混淆，不是加密）
- 新增依赖：`openai>=1.30`

---

### 8. A6 — 上下文圆环（后端）⭐⭐

**文件**：`routers/chat.py` 或 `routers/settings.py`

**新增端点**：`GET /api/context/usage`

```python
@router.get("/api/context/usage")
async def context_usage():
    """当前会话上下文使用量"""
    # 1. 读取当前会话的消息历史
    # 2. 估算 token 数（字符数 / 1.5）
    # 3. 根据 ai_mode 获取 total_tokens
    #    - local: 16000
    #    - cloud: 从 cloud_model 映射表读取
    # 4. 计算 percentage 和 level
    return {
        "used_tokens": used,
        "total_tokens": total,
        "percentage": pct,
        "level": level  # normal / warning / critical
    }
```

**模型上下文映射表**（cloud_engine.py 内部）：

```python
MODEL_CAPABILITIES = {
    "gpt-4o-mini": {"context_window": 128000, "max_output": 16384},
    "gpt-4o": {"context_window": 128000, "max_output": 16384},
    "gpt-4-turbo": {"context_window": 128000, "max_output": 4096},
    "gpt-3.5-turbo": {"context_window": 16385, "max_output": 4096},
    "deepseek-chat": {"context_window": 65536, "max_output": 8192},
    # 默认 fallback
    "_default": {"context_window": 32768, "max_output": 4096},
}
```

---

### 9. A8 — 离线上下文强制新建 ⭐⭐

**文件**：`routers/chat.py` 的 `/api/chat/stream`

**方案**：在流式对话前检测上下文使用量：

```python
# chat.py — stream 端点内部（构建历史之前）
used_pct = _estimate_context_usage(history_raw, model_choice)
if used_pct > 85:
    yield 'event: context_warning\ndata: {"percentage": %d, "level": "critical"}\n\n' % used_pct
if used_pct > 95:
    # 自动新建会话
    new_file = new_chat_file()
    # 把当前消息移到新会话
    yield 'event: context_force_new\ndata: {"percentage": %d, "new_chat_file": "%s"}\n\n' % (used_pct, new_file)
    # 切换到新会话继续对话
```

**注意**：这个只在 `ai_mode == "local"` 时生效（本地模型上下文有限），云端模式有 A10 自动压缩。

---

### 10. A10 — 在线云端自动压缩 ⭐⭐

**文件**：`routers/chat.py` 的 `/api/chat/stream`、`core/cloud_engine.py`

**方案**：在线模式发送前检测历史 > 75% → 调云端模型压缩历史：

```python
# chat.py — stream 端点内部（云端模式分支）
if ai_mode == "cloud" and used_pct > 75:
    yield 'event: compress\ndata: {"phase": "preparing", "msg": "正在准备对话历史..."}\n\n'
    # 调用 CloudEngine 的 compress_history() 方法
    compressed = await cloud_engine.compress_history(history, ...)
    yield 'event: compress\ndata: {"phase": "done", "before": "%dK", "after": "%dK"}\n\n'
    history = compressed
```

**CloudEngine.compress_history()**：用云端模型本身做历史压缩（发一个特殊的 "请压缩以下对话历史" 请求）。

---

## 第三波：依赖 A4（Research Action）

### 11. A4 — Research Action ⭐⭐⭐

**新增文件**：`actions/research_action.py`、`core/search_engine.py`
**修改文件**：`routers/chat.py`、`routers/settings.py`、`config.py`

**架构设计**：

```
chat.py stream 端点
    │
    ├─ action_mode == "chat" → 现有逻辑
    ├─ action_mode == "doc"  → 现有 doc_action
    └─ action_mode == "research" → research_action（新增）
            │
            ├─ ResearchAction.run()
            │       │
            │       ├─ CloudEngine.run() → 流式生成
            │       ├─ 解析 <SEARCH:关键词> 标记
            │       ├─ 调用 SearchEngine.search()
            │       ├─ 解析 <FETCH:URL> 标记
            │       ├─ 调用 SearchEngine.fetch()
            │       └─ 循环（最多 10 轮搜索 + 10 次抓取）
            │
            └─ SearchEngine
                    ├─ search(query) → Bing Search API
                    └─ fetch(url) → httpx + readability-lxml 提取正文
```

**半自动循环核心逻辑**（`research_action.py`）：

```python
class ResearchAction:
    def run(self, message, history, ...):
        """半自动研究循环"""
        context = message
        search_count = 0
        fetch_count = 0
        
        for round in range(10):  # 最多 10 轮
            # 1. 调 CloudEngine 流式生成
            response = ""
            for phase, content in cloud_engine.run(context, ...):
                if phase == "text":
                    response += content
                    yield ("text", content)
            
            # 2. 解析特殊标记
            searches = re.findall(r'<SEARCH:(.+?)>', response)
            fetches = re.findall(r'<FETCH:(.+?)>', response)
            
            if not searches and not fetches:
                break  # 模型不再搜索，输出最终回答
            
            # 3. 执行搜索
            for query in searches:
                if search_count >= 10: break
                results = search_engine.search(query)
                search_count += 1
                yield ("search", {"query": query, "results_count": len(results)})
                context += "\n[搜索结果: %s]\n%s" % (query, results)
            
            # 4. 执行抓取
            for url in fetches:
                if fetch_count >= 10: break
                content = search_engine.fetch(url)
                fetch_count += 1
                yield ("fetch", {"url": url, "title": content.get("title", "")})
                context += "\n[网页内容: %s]\n%s" % (url, content.get("text", ""))
        
        yield ("done", {"stats": {"search_count": search_count, "fetch_count": fetch_count}})
```

**config.py 新增字段**：

```python
"search_source": "bing",
"search_api_key": "",  # base64 编码
```

**settings.py 新增端点**：
- `GET /api/search/config`
- `POST /api/search/config`
- `POST /api/search/test`

**新增依赖**：`readability-lxml>=0.8`、`lxml>=5.0`

**注意**：Research 仅在云端模式下可用（需要强大的模型来控制搜索循环）。

---

## 第四波：Go Launcher（独立）

### 12. J1 — 启动画面 ⭐⭐⭐

**文件**：`main.go`（项目根目录，非 server/ 下）

**方案**：Go 原生 Win32 无边框窗口

```go
// 核心函数：
//   - createSplashWindow() → RegisterClassEx + CreateWindowEx
//   - updateSplashText(stage string) → InvalidateRect + WM_PAINT
//   - closeSplash() → DestroyWindow
//   - splashWndProc(hwnd, msg, wParam, lParam) → 处理 WM_PAINT

// 窗口样式：
//   - WS_POPUP | WS_VISIBLE（无边框，置顶）
//   - 480 x 280，居中
//   - 纯色背景 + 文字 + 进度条估算
//   - 不可手动关闭

// 流程：
//   main() → LockOSThread（已有）→ createSplashWindow()
//   → goroutine 执行后台启动（ollama → model → fastapi → browser）
//   → 主 goroutine 跑消息循环
//   → 后台完成 → PostMessage(WM_CLOSE) → 消息循环退出
```

**风险**：中。Win32 API 直接调用不用 CGO，但需要处理 DPI 缩放和字体渲染。参考现有 `LockOSThread()` 用法。

---

## 实施建议

### 推荐顺序（按实际风险和依赖）

```
第一批（立即可做，互不依赖）：
  A1(num_ctx) → E1(日志) → B1(重命名) → F1(Ollama重启) → H1(配置优化)

第二批（核心任务）：
  A2(云端AI) ← 这是最核心的，其他多个任务依赖它

第三批（依赖 A2）：
  A6(圆环) + A8(强制新建) + C1(备份恢复)
  
第四批（依赖 A2 + 搜索引擎）：
  A4(Research Action)

第五批（独立，可任何时候）：
  A10(在线压缩) → J1(启动画面)
```

### 关于 A2 的详细设计要点

1. **零侵入**：`ModelManager.chat_stream()` 内部只加一个 if/else 路由，StreamEngine 代码不改
2. **输出格式统一**：CloudEngine 必须也 yield `("task_type", ...)` + `("text", ...)` + `("fold", ...)` 元组
3. **context_policy 在 CloudEngine 内部处理**：裁剪逻辑不泄漏到 chat.py
4. **API Key 安全**：base64 编码存 settings.json，GET 请求脱敏返回 `sk-***...***abc`
5. **模式切换**：`POST /api/mode/switch` 会先测试连接，失败不允许切

### 关于 deps_check.py

新增依赖（openai、readability-lxml、lxml）需要在 `deps_check.py` 中注册健康检查。但由于 Patch1 已经是全量打包架构（依赖预装），这些包会在构建时就装好，`deps_check.py` 只做运行时验证。

---

## 文件变更清单

### 新增文件（5 个）
| 文件 | 任务 |
|------|------|
| `core/cloud_engine.py` | A2 云端引擎 |
| `core/search_engine.py` | A4 搜索引擎 |
| `actions/research_action.py` | A4 研究 Action |
| `routers/backup.py` | C1 备份恢复 |
| `core/log_cleanup.py` | E1 日志清理 |

### 修改文件（8 个）
| 文件 | 任务 | 改动量 |
|------|------|--------|
| `core/stream_engine.py` | A1 | ~5 行 |
| `core/model_manager.py` | A1, A2, A6 | ~60 行 |
| `routers/chat.py` | A4, A8, A10 | ~100 行 |
| `routers/settings.py` | A2, A4 | ~150 行 |
| `config.py` | A2, A4 | ~15 行 |
| `session/chat_store.py` | B1 | ~20 行 |
| `core/ollama_manager.py` | F1 | ~15 行 |
| `server.py` | C1, E1 | ~15 行 |

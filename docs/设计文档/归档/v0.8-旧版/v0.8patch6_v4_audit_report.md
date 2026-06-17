# v0.8patch6 V4 代码审计报告

> 审计日期：2026-05-20
> 审计范围：server.py (3864行) + knowledge_base.py (1710行) + recorder.py (1213行) + agent.py (930行) + models.py (1986行) + index.html (5548行) + skill_loader.py + response_filter.py + config.py + chunking_orchestrator.py + task_classifier.py
> 审计方式：只读审查，不修改代码
> 版本状态：patch6功能已实现完毕

---

## 一、P0 级别问题（严重，需立即修复）

### P0-1: models.py think标签结束标记检测逻辑错误

**位置**：models.py ~line 1508-1510

**代码**：
```python
for marker in _THINK_END_MARKERS:
    idx = full_output.find(marker)
if idx >= 0:
    think_end_found = True
```

**问题**：`idx`在for循环中被最后一个marker（`"</thought>"`）的find结果覆盖。前面的marker（如`"</think"`、`"】"`、`"</thinking>"`）即使找到了，也因为`idx`被覆盖而丢失。

**影响**：如果模型输出`</thinking>`（倒数第二个marker）而非`</thought>`，think标签检测失败，思考内容泄漏到正文。

**修复**：
```python
think_end_found = False
idx = -1
for marker in _THINK_END_MARKERS:
    idx = full_output.find(marker)
    if idx >= 0:
        think_end_found = True
        break
```

---

### P0-2: knowledge_base.py ask() 使用 % 字符串格式化导致崩溃

**位置**：knowledge_base.py ~line 1624-1632

**代码**：
```python
kb_prompt = (
    "严格根据【参考资料】回答问题。要求：\n"
    "..."
    "【参考资料】\n%s\n\n"
    "问：%s\n答：" % (context, question)
)
```

**问题**：Python 的 `%` 格式化在遇到未配对格式说明符时会抛出 `ValueError`。如果用户问题或文档内容中包含 `%d`、`%s`、`%f` 等序列（如"完成度 100%"），整个知识库问答功能崩溃。

**复现**：用户问"100% 怎么表示" → `question` 中包含 `%` → `ValueError: unsupported format character`。

**修复**：使用 `.format()` 或 f-string：
```python
kb_prompt = f"...【参考资料】\n{context}\n\n问：{question}\n答："
```

---

### P0-3: agent.py long_reader 路径遍历漏洞

**位置**：agent.py ~line 714-726

**代码**：
```python
file_path = params.get("file_path", "")
if not os.path.isabs(file_path):
    file_path = os.path.join(self.workspace_dir, file_path)
if not os.path.exists(file_path):
    return {"error": "long_reader: 文件不存在: %s" % file_path}
```

**问题**：`file_path` 是模型通过工具调用传入的参数。如果传入相对路径 `../../secret.txt`，`os.path.join` 会生成 workspace 外的路径，导致读取任意文件。

**影响**：Agent 模式下，如果模型被用户输入欺骗（如"读取 ../../../etc/passwd 的内容"），可能读取系统敏感文件。

**修复**：
```python
if not os.path.isabs(file_path):
    file_path = os.path.join(self.workspace_dir, file_path)
file_path = os.path.realpath(file_path)
workspace_real = os.path.realpath(self.workspace_dir)
if not file_path.startswith(workspace_real + os.sep):
    return {"error": "long_reader: 文件路径越界"}
```

---

### P0-4: server.py 扩展包 ZIP 解压安全检查不一致

**位置**：server.py ~line 3676-3680

**代码**：
```python
for member in zf.namelist():
    member_path = os.path.join(tmp_dir, "extracted", member)
    if not os.path.realpath(member_path).startswith(os.path.realpath(tmp_dir)):
        return JSONResponse({"error": "ZIP包含不安全路径"}, status_code=400)
zf.extractall(os.path.join(tmp_dir, "extracted"))
```

**问题**：检查的是 `member_path` 是否以 `tmp_dir` 开头。但 `member_path` 被构造为 `tmp_dir/extracted/member`，即使 `member` 是 `../evil.py`，`member_path` 经过 `realpath` 后变成 `tmp_dir/evil.py`，仍然以 `tmp_dir` 开头，检查通过。然后 `extractall` 将文件写到 `tmp_dir/evil.py`（在 `extracted` 目录之外）。

**与 KB 安装检查对比**：KB 安装（line 2695-2698）使用 `os.path.join(tmp_dir, "extract", member)` 并检查是否以 `os.path.join(tmp_dir, "extract")` 开头，更严格。

**修复**：统一使用已有的 `_safe_extract_path()` 函数。

---

## 二、P1 级别问题（中等，建议尽快修复）

### P1-1: _safe_filename() 不过滤 `.` 和 `..`

**位置**：server.py ~line 223-229

**代码**：
```python
def _safe_filename(filename: str) -> str:
    filename = os.path.basename(filename)
    filename = re.sub(r'[^\w\-.]', '_', filename)
    return filename
```

**问题**：`os.path.basename("..")` = `".."`，正则保留了 `.`，所以 `".."` 作为文件名返回。后续 `os.path.join(upload_dir, "..")` 会指向 upload_dir 的父目录。

**修复**：
```python
def _safe_filename(filename: str) -> str:
    filename = os.path.basename(filename)
    filename = re.sub(r'[^\w\-.]', '_', filename)
    if filename in (".", "..", ""):
        filename = "unnamed"
    return filename
```

---

### P1-2: knowledge_base.py 锁嵌套顺序脆弱

**位置**：knowledge_base.py ~line 903 + ~line 934

**代码**：
```python
with self._summary_lock:
    # ... 摘要生成 ...
    with self._processing_lock:
        # 更新向量索引
```

**问题**：当前代码路径中，锁的获取顺序是 processing → summary → processing（在 summary 内），不会死锁。但如果未来有代码先获取 processing_lock 再在内部获取 summary_lock（如删除文档时同时需要摘要状态），就会引入死锁。

**修复**：定义全局锁获取顺序（如 processing_lock 总是在 summary_lock 之前），并在代码注释中明确约定。

---

### P1-3: models.py _THINK_TAG_MARKERS 异常标记

**位置**：models.py ~line 277-284

**代码**：
```python
_THINK_TAG_MARKERS = [
    ("<think",     "</think"),   # 标准
    ("<think",     "】"),   # Qwen3-8B: </think>
    ...
]
```

**问题**：第二项的结束标记是 `"】"`（中文右方括号），但注释说 "Qwen3-8B: </think"。这个标记过于宽泛——任何包含 `"】"` 的文本都会被误判为 think 结束。

**影响**：如果模型正文中恰好有 `"】"`（如引用中文句子），`_detect_think_tags()` 会错误地认为 think 标签已结束。

**修复**：确认 Qwen3 的实际 think 结束标记。如果确实是 `</think>`，应修正为 `"</think"`。

---

### P1-4: recorder.py 滑动窗口纠错拼接破坏段落结构

**位置**：recorder.py ~line 925

**代码**：
```python
refined = "\n".join(refined_parts)
```

**问题**：用换行符拼接各批纠错结果。如果原文是连续段落（无换行分隔），拼接后会在批次边界处人为插入换行，破坏段落连贯性。

**修复**：记录原始文本的分隔符信息，拼接时保持原始分隔。

---

### P1-5: 多处文件解析无超时控制

**位置**：
- server.py ~line 2913: `pdfplumber.open(io.BytesIO(content_bytes))`
- server.py ~line 2896: `openpyxl.load_workbook(io.BytesIO(content_bytes))`

**问题**：恶意构造的 PDF/Excel 文件可能导致解析器无限循环或极长时间运行，服务被卡死。

**修复**：在文件解析外层添加超时控制（如 `signal.alarm` 或线程超时）。

---

### P1-6: server.py 多处 request.json() 裸解析

**位置**：
- server.py ~line 805: `body = await request.json()`
- server.py ~line 1187: `body = await request.json()`
- server.py ~line 2052: `body = await request.json()`
- server.py ~line 2091: `body = await request.json()`
- 等多处

**问题**：`await request.json()` 在请求体格式错误时会抛出 `JSONDecodeError`，直接返回 500 错误。虽然 chat/stream 端点已修复，但其他端点仍有此问题。

**修复**：统一添加 try/except 包装。

---

## 三、P2 级别问题（低优先级，建议排期修复）

### P2-1: response_filter.py 正则表达式灾难性回溯风险

**位置**：response_filter.py ~line 60 等多处

**问题**：如 `re.findall(r'```[\w]*\n(.*?)```', text, re.DOTALL)` 等模式，在特定输入（如大量反引号）下可能导致灾难性回溯，CPU 长时间占用。

**修复**：添加正则超时限制（Python 3.11+ 支持 `timeout` 参数），或限制输入文本长度。

---

### P2-2: knowledge_base.py 向量检索 O(N) 复杂度

**位置**：knowledge_base.py ~line 1129

**代码**：
```python
scores = np.dot(self.vectors, query_vec.T).flatten()
```

**问题**：全量点积计算，chunk 数增长后性能线性下降。当前上限 1000 chunk 够用，但无索引加速准备。

**修复**：预留 `faiss-cpu` 集成接口，chunk 数 > 2000 时自动启用。

---

### P2-3: recorder.py prev_tail 截断可能截断在词中间

**位置**：recorder.py ~line 910

**代码**：
```python
prev_tail = refined[-OVERLAP_CHARS:] if len(refined) >= OVERLAP_CHARS else refined
```

**问题**：直接截取最后 200 字符，可能截断在一个词的中间（如 `"今天我们讨论了第"` 截成 `"我们讨论了第"`）。

**修复**：在字符边界处向前后各扩展若干字符，寻找标点或空格作为截断点。

---

### P2-4: agent.py 工具调用提示词注入风险

**位置**：agent.py ~line 342-343

**代码**：
```python
"[TOOL_CALL:web_search|{\"query\": \"" + user_message.replace('"', '\\"')[:100] + "\", \"max_results\": 5}]"
```

**问题**：只转义了双引号，如果 `user_message` 包含反斜杠或其他特殊字符，可能导致 JSON 格式错误。

**修复**：使用 `json.dumps()` 序列化参数，而非字符串拼接。

---

### P2-5: server.py OCR 批量接口无路径校验

**位置**：server.py ~line 2077-2079

**代码**：
```python
@app.post("/api/ocr_batch")
def api_ocr_batch(image_dir: str = Query(...), pattern: str = Query("*.png")):
    return mgr.ocr_batch(image_dir, pattern)
```

**问题**：`image_dir` 直接传入，无校验是否在工作目录内。虽然这是内部接口，但存在路径遍历风险。

**修复**：添加路径校验，限制在 workspace 目录内。

---

## 四、已确认修复的历史问题

| 历史P0问题 | 修复状态 | 验证位置 |
|-----------|---------|---------|
| `_gen_lock` 死锁 | ✅ 已修复 | models.py ~line 556-561 强制释放逻辑 |
| `_refFilePath` 未声明 | ✅ 已修复 | index.html 全局声明 + clearFileRef |
| v1/v2 chat格式不兼容 | ✅ 已修复 | server.py v1→v2 兼容迁移 |
| `max_iterations` falsy | ✅ 已修复 | agent.py line 276 `is not None` |
| 设备切换与生成冲突 | ✅ 已修复 | models.py ~line 594 检查 _gen_lock |
| 纠错上下文断裂 | ✅ 已修复 | recorder.py 滑动窗口 + 短文稿一次性纠错 |

---

## 五、修复优先级建议

| 优先级 | 问题 | 工作量 | 原因 |
|--------|------|--------|------|
| **立即** | P0-1 think标签检测bug | 5分钟 | 影响推理内容展示，单字符改bug |
| **立即** | P0-2 ask() %格式化崩溃 | 5分钟 | 知识库问答功能可被用户输入搞崩 |
| **本周** | P0-3 long_reader路径遍历 | 30分钟 | 安全风险，加路径校验即可 |
| **本周** | P0-4 ZIP解压安全检查 | 30分钟 | 统一使用 _safe_extract_path |
| **下周** | P1-1 _safe_filename过滤 | 10分钟 | 边缘安全 case |
| **下周** | P1-3 _THINK_TAG_MARKERS异常 | 10分钟 | 确认Qwen3实际标记 |
| **排期** | P1-5 文件解析超时 | 2小时 | 需要多线程/信号超时方案 |
| **排期** | P2 级问题 | — | 低优先级，功能正常 |

---

*审计完成。共发现 4个P0 + 6个P1 + 5个P2 问题，其中2个P0为单字符/单行修复。*

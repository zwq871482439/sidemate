# 术语统一 — 后端团队修改清单

> 背景：前端UX审查后统一术语，"知识库"→"文库"，"语音转写"→"纪要"，"主模型/LLM"→"AI模型"

---

## 必须修改

### 1. `action_registry.py` 第13行

```python
# 当前
"kb": {"label": "📚", "title": "检索知识库", "placeholder": "输入问题，自动检索知识库…", "tag": "知识库扩展"},

# 改为
"kb": {"label": "📚", "title": "检索文库", "placeholder": "输入问题，自动检索文库…", "tag": "文库扩展"},
```

**影响**：
- 对话Tab Action按钮栏的标题和placeholder（3处）
- 设置→Action管理的扩展tag标签

---

### 2. `static/js/settings.js` 第284行

```javascript
// 当前
knowledge_base: '知识库（文档管理 + 语义检索 + 问答）',

// 改为
knowledge_base: '文库（文档管理 + 语义检索 + 问答）',
```

**影响**：设置→模块组件版本表格中的行标签

---

### 3. `static/js/settings.js` 第512行

```javascript
// 当前
暂无已安装扩展。上传 .sidemate 官方包安装模型、知识库、语音等扩展。

// 改为
暂无已安装扩展。上传 .sidemate 官方包安装模型、文库、纪要等扩展。
```

**影响**：设置→扩展管理空状态说明文案

---

### 4. `static/js/settings.js` 第517行

```javascript
// 当前
var typeLabels = {model:'模型', knowledge:'知识库', whisper:'语音', action:'Action'};

// 改为
var typeLabels = {model:'模型', knowledge:'文库', whisper:'纪要', action:'Action'};
```

**影响**：设置→扩展管理列表中每个扩展的类型标签（tag显示）

---

### 5. `index.html` 第136行

```html
<!-- 当前 -->
文库问答和文档摘要需要 AI 模型支持<br>请先加载主模型<br><br>

<!-- 改为 -->
文库问答和文档摘要需要 AI 模型支持<br>请先加载AI模型<br><br>
```

**影响**：文库Tab模型未加载遮罩的提示文案

---

### 6. `index.html` 第505行

```html
<!-- 当前 -->
开启后语音转写更快，持续占用约 300-800MB 内存

<!-- 改为 -->
开启后纪要转写更快，持续占用约 300-800MB 内存
```

**影响**：设置→自适应内存管理→纪要引擎常驻内存的说明

---

### 7. `static/js/chat.js` 第199行

```javascript
// 当前
解锁文库问答和语音转写能力。

// 改为
解锁文库问答和纪要转写能力。
```

**影响**：对话Tab首次引导页第三步的说明文案

---

### 8. `static/js/minutes.js` 第208行

```javascript
// 当前
'确定卸载 Whisper 扩展？卸载后需重新安装才能使用语音转写功能。'

// 改为
'确定卸载 Whisper 扩展？卸载后需重新安装才能使用纪要功能。'
```

**影响**：卸载Whisper扩展的确认弹窗文案

---

### 9. `static/js/minutes.js` 第922行

```javascript
// 当前
alert('✅ 已导入知识库');

// 改为
alert('✅ 已导入文库');
```

**影响**：纪要转写稿导入文库后的提示弹窗

---

### 10. `static/js/core/errors.js` 第24行

```javascript
// 当前
KB_NOT_READY: { message: '知识库未就绪', action: '请先安装知识库模块' },

// 改为
KB_NOT_READY: { message: '文库未就绪', action: '请先安装文库模块' },
```

**影响**：文库功能报错时的Toast通知文案

---

## 不改（注释和变量名，不影响用户体验）

| 文件 | 行 | 内容 | 原因 |
|------|-----|------|------|
| `chat.js` | 457 | `// KB 模式：检查知识库模型是否已加载` | 代码注释 |
| `settings.js` | 223 | `// 模块安装状态（知识库/语音）` | 代码注释 |
| `settings.js` | 682 | `// 同步更新系统状态卡片中的知识库/语音引擎状态` | 代码注释 |
| `settings.js` | 867 | `// 优先使用后端 tag 字段（如"知识库扩展"）` | 代码注释 |
| `qa.js` | 663 | `// 卸载知识库模块` | 代码注释 |
| `index.html` | 89 | `<!-- 问答 Tab（知识库版 Patch 7）-->` | HTML注释 |

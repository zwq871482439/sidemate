# OCR 归档 — Patch11 拆除

归档时间: 2026-05-26

## 归档原因
- Patch11 已取消图片上传功能（前端上传按钮已删）
- OCR 端点无前端调用，属于死代码
- rapidocr 依赖增加包体积但未使用

## 归档内容

### 后端
- `models.py`: OCR 模型配置（rapidocr）、`ocr()` 方法、`ocr_batch()` 方法、stats 中 OCR 字段
- `routers/chat.py`: 3 个 OCR 端点（`/api/ocr`, `/api/ocr_upload`, `/api/ocr_batch`）、`_do_ocr_file()` 辅助函数、sendMessage 中 OCR 处理逻辑
- `requirements.txt`: `rapidocr-onnxruntime`、`rapidocr-openvino`

### 前端
- `index.html`: `imgPreview` DOM 元素、`pendingImageFile` 全局变量
- `chat.js`: `pendingImageFile` 逻辑、OCR 上传代码、图片预览代码
- `main.css`: `.ocr-wrap` 相关样式

## 如需恢复
1. 恢复 requirements.txt 中的 rapidocr 依赖
2. 恢复 models.py 中的 OCR 配置和方法
3. 恢复 chat.py 中的 OCR 端点和处理逻辑
4. 恢复前端图片上传 UI 和 OCR 调用代码

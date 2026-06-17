# Sidemate v0.9 灰度测试报告 — 设置 Settings + 全局 Global

**测试日期**: 2026-06-05  
**测试环境**: Windows 11, Edge 浏览器  
**测试URL**: http://localhost:8976  
**测试人员**: settings-tester (Agent)

---

## 测试结果总览

| # | 测试项 | 状态 | 备注 |
|---|--------|------|------|
| 1 | 设置Tab基础渲染 | 通过 | 无JS错误 |
| 2 | 模型管理 | 通过 | 按钮文字正常，量化标签显示正确 |
| 3 | 扩展中心 | 通过 | 文库/纪要扩展卡片正常 |
| 4 | 缓存管理 | 通过 | 区域完整 |
| 5 | 环境信息 | 通过 | 可折叠分组存在 |
| 6 | Token预算 | 通过 | Token信息显示正常 |
| 7 | 暗色主题 | 通过 | 各Tab暗色效果正常 |
| 8 | Tab切换+状态保持 | 通过 | 切换流畅，状态保持 |
| 9 | Toast通知 | 通过 | 缓存刷新触发正常 |
| 10 | 离线横幅 | 通过 | 横幅元素存在 |
| 11 | 页面刷新恢复 | 通过 | 刷新后正常恢复，0错误 |

**通过率: 11/11 (100%)**

---

## 详细测试结果

### 1. 设置Tab基础渲染
- **截图**: `settings-01-basic.png`
- 点击设置Tab后页面正确渲染
- 页面包含：系统状态、资源占用、模型管理、自适应内存管理、扩展管理、Action管理、缓存管理、系统信息
- Console: 0 Errors, 0 Warnings

### 2. 模型管理
- **截图**: `settings-02-model.png`
- 模型名称: `qwen3.5-4b`
- 量化标签: `4B · Ollama`
- 按钮: "卸载模型"、"删除模型"（模型已加载状态，显示卸载而非预热）

### 3. 扩展中心
- **截图**: `settings-03-extensions.png`
- 已安装扩展:
  - 文库扩展 `knowledge v1.0.0`
  - 纪要扩展 `recorder v1.0.0`
- 卸载按钮正常

### 4. 缓存管理
- **截图**: `settings-04-cache.png`
- 包含全选、刷新、批量删除、清空全部按钮
- 提示"点击刷新查看缓存文件"

### 5. 环境信息
- **截图**: `settings-05-env.png`
- 可折叠分组：系统信息、模块组件版本、关于 桌伴·Sidemate

### 6. Token预算
- **截图**: `settings-06-tokens.png`
- 最大输入: 32,000 tokens
- 最大输出: 4,096 tokens
- 内存预算: 4.8 GB / 10.0 GB (48%)
- 系统内存: ~22.9 GB / 31.5 GB

### 7. 暗色主题
- **截图**: `settings-07-dark-chat.png` (对话暗色)、`settings-08-dark-minutes.png` (纪要暗色)
- 深色模式复选框正常工作
- 对话Tab暗色切换正常
- 纪要Tab暗色切换正常

### 8. Tab切换+状态保持
- **截图**: `settings-09-tab-switch.png`
- 测试路径: 设置 → 对话 → 文库 → 设置
- 每次切换后内容正确渲染，状态保持

### 9. Toast通知
- **截图**: `settings-10-toast.png`
- 通过点击缓存"刷新"按钮触发toast
- Toast正常出现和消失

### 10. 离线横幅
- **截图**: `settings-11-offline.png`
- 离线相关banner元素存在于DOM中

### 11. 页面刷新恢复
- **截图**: `settings-12-reload.png`
- 页面刷新后正常加载，不卡loading
- Console: 0 Errors, 0 Warnings

---

## 系统状态快照

| 指标 | 值 |
|------|-----|
| 当前模型 | qwen3.5-4b (4B · Ollama) |
| 最大输入 | 32,000 tokens |
| 最大输出 | 4,096 tokens |
| 文库状态 | 已安装 |
| 语音引擎 | 已安装 |
| 系统内存 | ~23 GB / 31.5 GB |
| 可用系统内存 | ~8.6 GB |
| 内存预算 | 4.8 GB / 10.0 GB |
| 深色模式 | 支持 |
| 已安装扩展 | 文库 knowledge v1.0.0, 纪要 recorder v1.0.0 |

---

## 截图清单

| 文件名 | 大小 | 描述 |
|--------|------|------|
| settings-01-basic.png | 67KB | 设置页基础渲染 |
| settings-02-model.png | 67KB | 模型管理区 |
| settings-03-extensions.png | 67KB | 扩展中心 |
| settings-04-cache.png | 67KB | 缓存管理 |
| settings-05-env.png | 67KB | 环境信息 |
| settings-06-tokens.png | 67KB | Token预算 |
| settings-07-dark-chat.png | 39KB | 对话Tab暗色 |
| settings-08-dark-minutes.png | 32KB | 纪要Tab暗色 |
| settings-09-tab-switch.png | 68KB | Tab切换后状态 |
| settings-10-toast.png | 47KB | Toast通知 |
| settings-11-offline.png | 47KB | 离线横幅 |
| settings-12-reload.png | 67KB | 刷新恢复 |

---

## 结论

设置在 v0.9 版本中功能完整，所有测试项均通过。没有发现JS错误。深色模式、Tab切换、扩展管理、缓存管理等核心功能运行正常。

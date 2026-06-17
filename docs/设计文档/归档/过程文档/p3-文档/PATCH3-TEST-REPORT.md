# Patch3 测试报告

**生成时间**: 2026-06-09 22:30

## 自动化 API 测试结果

**测试环境**: Sidemate v0.9.0 (Ollama 未运行，云端 API 正常)

### 核心对比模式 (Patch3) — ✅ 全部通过

| 测试项 | 结果 | 详情 |
|--------|------|------|
| Round 1 对比管道 | ✅ 35 events, 4 channels | local+cloud+merge+progress, HasDone=True |
| Round 2 (含 Reformulation) | ✅ 66 events, 4 channels | 追问补全 + 双路并行正常 |
| Round 3 (多轮) | ✅ 68 events, 4 channels | 多轮对话无退化 |
| SSE 事件分布 | ✅ | 无 error 事件 |
| Phase 完成序列 | ✅ | local:done → cloud:done → merge:started → merge:done |
| 本地列步骤 | ✅ | searching → organizing → generating (三步完整) |
| 云端列状态 | ✅ | understanding → thinking → generating |
| 来源数据 (Sources) | ✅ | 3 个来源 |
| 融合输出 | ✅ | 综合分析正常输出 |

### 其他测试项

| 测试项 | 结果 | 原因 |
|--------|------|------|
| 心跳检测 | ⚠️ 404 | 路由路径需确认 |
| 模式切换 | ✅ local/cloud 均通过 | |
| 新建会话 | ✅ | |
| Chat 流式对话 | ⚠️ Ollama 未运行 | 测试环境无本地模型 |
| 停止生成 | ⚠️ Ollama 未运行 | 同上 |
| KB 文档列表 | ⚠️ 404 | 路由路径需确认 |
| KB 本地提问 | ✅ | |
| 云端配置 | ✅ | |
| 云端模型列表 | ⚠️ 接口问题 | |
| 上下文指示器 | ✅ | |

## 静态代码检查（自动化） ✅

### 语法检查
| 文件 | 状态 |
|------|------|
| server/pipelines/compare_pipeline.py | ✅ |
| server/core/tagging_scheduler.py | ✅ |
| server/core/cloud_engine.py | ✅ |
| server/static/js/qa.js | ✅ |
| server/static/js/chat.js | ✅ |
| server/routers/chat.py | ✅ |

### Patch3 核心改动验证
| 检查项 | 状态 |
|--------|------|
| `compare_pipeline.py` 无 `mgr._mm` 引用 | ✅ 已清除 |
| `tagging_scheduler.py` 不走 `chat_stream` 始终本地引擎 | ✅ |
| `cloud_engine.run()` 支持 `_skip_queue` | ✅ |
| 对比模式 `_run_cloud_column` 传 `_skip_queue=True` | ✅ |
| Reformulation 本地引擎强制 | ✅ |
| 前端步骤映射支持 `reformulating` | ✅ |

## 测试脚本

`C:\tmp\_Sidemate_0.9_patch3\test_patch3.py` — 15 项自动化测试（启动 Sidemate.exe 后执行）

```bash
cd C:\tmp\_Sidemate_0.9_patch3
python\python.exe test_patch3.py
```

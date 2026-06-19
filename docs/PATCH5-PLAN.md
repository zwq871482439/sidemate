# Patch 5 规划文档

> 版本：v0.9 Patch 5 | 状态：📋 规划中 | 更新：2026-06-19（v2 大重构）
> 前置依赖：P4 全部完成 + 灰度验证通过

---

## 一、总览

**P5 首要目标：功能跑通 + 功能稳定**（用户决策 2026-06-19）

不是堆功能，而是把现有功能跑稳。P4 暴露的核心问题：
- 100 文件批量导入 → FastAPI 假死
- 前端误报断联（单线程卡死事件循环）
- 扩展包机制老旧（含 wheels，跟嵌入式 Python 重复）
- Defender 误报（全量包 6GB 触发 ML 深扫）

**核心目标重排**（按重要性）：
1. 🥇 **稳定性**：线程池 + 任务队列 + Go 看门狗（解决假死）
2. 🥈 **功能闭环**：批量导入 + 批量操作 + 进度推送（让功能真正可用）
3. 🥉 **检索统一**：bge-m3 dense+sparse（去 BM25/jieba）
4. **分发优化**：小包 + 纯模型扩展包（绕过 Defender）
5. **产品化**：品牌视觉 + 专业信号

---

## 二、四批次实施计划（v2 重构）

### 📦 批次 A：稳定性基建（最高优先，P5 第一目标）

> 目标：解决 P4 灰度暴露的稳定性问题，让功能跑通不假死

| 任务 | 说明 | 复杂度 | 解决的问题 |
|------|------|--------|-----------|
| **A1 线程池改造** | FastAPI 阻塞操作丢 ThreadPoolExecutor，主事件循环永不阻塞 | 中 | 100 文件假死 + 假断联 |
| **A2 任务队列 + 进度推送** | `/api/kb/upload_batch` + batch_id + 前端轮询状态 | 高 | 批量导入不可控 |
| **A3 Go 看门狗提级** | Go Launcher 监测 python/ollama 进程，挂了自动重启 | 中 | Python 自己挂没人救 |
| **A4 检索引擎统一** | bge-m3 dense+sparse，移除 BM25/jieba（~200 行代码）| 中 | 检索质量 + 代码简化 |
| **A5 依赖硬链接恢复** | 双副本 + mklink /H，校验失败直接切目录 | 中 | 全量 zip 覆盖慢且傻 |

**A1 线程池改造详情**：
```python
# 当前问题：同步阻塞卡死事件循环
@router.post("/api/kb/upload")
async def api_kb_upload(file):
    text = extract_text(file)  # ⚠️ 阻塞！

# 修复：丢到专用线程池
_kb_executor = ThreadPoolExecutor(max_workers=2)
async def api_kb_upload(file):
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(_kb_executor, _process_upload, file)
```

**A2 任务队列详情**：
- 后端：`POST /api/kb/upload_batch` 返回 batch_id + 文件列表
- 后端：逐个处理，进度写入 `data/kb_queue/{batch_id}.json`
- 前端：轮询 `GET /api/kb/batch/{id}/status` 显示进度（3/100）
- 前端：支持批量取消 + 失败重试
- 前端：折叠/展开计数器统一（BUG#32 已修，确保不再回退）

**A3 Go 看门狗详情**：
- 监测间隔：30s（不是 5s，避免误判）
- 健康检查：`GET http://127.0.0.1:8976/api/status` 15s 超时
- 失败处理：连续 3 次失败才重启（避免偶发卡顿误重启）
- 最大重启：3 次/小时（避免死循环）
- 不监测浏览器（系统行为）

**A4 检索统一详情**：
- 移除 `_search_bm25` + jieba 依赖（减少 30MB 打包体积）
- 改用 `BGEM3FlagModel.encode(return_dense=True, return_sparse=True)`
- dense + sparse 内部加权融合（替代 RRF）
- 代码量减少约 200 行

**A5 硬链接恢复详情**：
- 安装时 `mklink /H` 创建 site-packages 硬链接副本（不占额外空间）
- 校验失败时直接切到 backup 目录（零解压时间）
- 替代当前 `backup/site_packages.zip` 全量覆盖方案

**工作量估计**：12-15 天
- A1 线程池：2-3 天
- A2 任务队列：3-4 天（前后端配合）
- A3 Go 看门狗：2-3 天
- A4 检索统一：2-3 天
- A5 硬链接：1-2 天

---

### 📦 批次 B：功能闭环

> 目标：让批量导入、文件类型、权限、去重等功能真正可用

| 任务 | 说明 | 复杂度 | 依赖 |
|------|------|--------|------|
| **B1 批量操作 UI + Tag 聚类** | checkbox 全选/反选 + 批量删除/重新打标 + tag 前端自动聚类（模糊匹配归一化）+ **检索热力图**（命中次数 + 重置按钮） | 中-高 | A2 队列就绪 |
| **B2 文件类型扩展 + 导入流程重构** | epub/html/srt 解析 + 扩展包仅模型（依赖跟 Python）| 中 | A1 线程池 |
| **B3 权限系统** | KB 权限（3档）+ 工具开关 | 中 | 无 |
| **B4 去重检测** | L1(filename+size) + L2(内容≥95%) + **批量冲突处理** | 中 | A2 队列 |
| **B5 内存预算移除** | 全删 memory_budget 配置 + memory_manager 卸载逻辑 + UI 滑块；保留 RES 日志供诊断 | 低 | 无 |

**B1 Tag 聚类详情**：
- 前端模糊匹配归一化（相似度 > 70% 的 tag 归一组）
- 取频率最高的 tag 作为组名
- 显示：`中医(13)  健康(10)  心理(7)  运动(5)  养生(9)  其他(15)`
- 点击 tag 筛选（不是折叠分组）

**B1 检索热力图详情**：
- 后端：每次 search_kb 命中 chunk 时 `chunk.hit_count += 1`，定期持久化到 kb_meta.json
- 前端：文档列表项显示 `🔥 23 次命中`
- 前端：热力图视图切换（🔥🔥🔥 红 ≥20 / 🔥🔥 橙 10-19 / 🔥 黄 5-9 / · 灰 <5）
- 前端：重置统计按钮（清零所有 hit_count）

**B5 内存预算移除详情**：
- 删除配置项：`memory_budget_mb` / `memory_budget_min_mb` / `memory_budget_max_mb`
- 删除 memory_manager.py 的自动卸载逻辑
- 删除设置页内存预算滑块
- 保留 `[RES]` 日志（C5 系统诊断展示）
- 实际占用：~5.5GB（LLM 4.3GB + KB 0.6GB + Python 0.5GB）

**B2 扩展包改造（关键）**：
```
旧扩展包（10GB，含 wheels）:
├── manifest.json
├── models/          ← 保留
└── wheels/          ← 移除（依赖预装到 python/site-packages）

新扩展包（~6.5GB，纯模型）:
├── manifest.json
└── models/          ← 只放模型
```

**B2 文件类型优先级**：
| 格式 | 扩展名 | 依赖包 | 优先级 |
|------|--------|--------|--------|
| 电子书 | .epub | ebooklib | P0 |
| 网页存档 | .html/.htm | beautifulsoup4（已有）| P0 |
| 字幕 | .srt/.vtt | 无 | P1 |
| 富文本 | .rtf | striprtf | P1 |
| LaTeX | .tex | 无 | P2 |
| 邮件 | .eml | email（标准库）| P2 |

**B4 去重检测（含批量冲突）**：
- L1：filename + file_size 完全相同 → 直接提示覆盖
- L2：内容前 2000 字相似度 ≥ 95%（difflib）→ 提示三选一
- **批量模式**：100 个文件批量导入时，先全量扫描冲突，一次性展示"10 个重复，3 个高度相似"，用户统一处理（全保留/全替换/逐个确认）

**工作量估计**：6-8 天

---

### 📦 批次 C：分发 + 产品化

> 目标：解决 Defender 误报 + 品牌视觉 + 专业信号

| 任务 | 说明 | 复杂度 |
|------|------|--------|
| **C1 小包 + 纯模型扩展包分发** | setup.iss 轻量版 + sidemate-knowledge-bge-m3.sidemate + sidemate-llm-qwen.sidemate | 中 |
| **C2 GPU 检测 + CUDA 集成** | Go Launcher 三档分流（CUDA/Vulkan/CPU）+ 从 Ollama 抄 CUDA DLL | 中 |
| **C3 品牌视觉全套** | favicon + SVG Logo（已有 logo.svg）+ 桌面图标 + 启动画面 | 中 |
| **C4 空状态 + 反馈 + CHANGELOG** | Chat/KB 空状态 + 反馈渠道 + 错误复制 + 更新日志 | 低 |
| **C5 隐私 + 诊断 + 许可** | 隐私声明 + 系统诊断（Python/Ollama/GPU/磁盘）+ THIRD-PARTY | 低-中 |
| ~~C6 代码签名~~ | ⏸️ 暂缓（用户决策 2026-06-19，先不买 EV 证书）|

**C1 分发策略**：
```
1. Sidemate_Setup_v0.9.5.exe         ← ~1.6GB（主程序+Python+Ollama+Lib）
   ↓ Defender 不报警（< 2GB 不触发 ML 深扫）

2. sidemate-knowledge-bge-m3.sidemate  ← ~6GB（bge-m3 + reranker）
   ↓ 应用内导入，Defender 不扫描

3. sidemate-llm-qwen3.5-4b.sidemate   ← ~3GB（LLM 模型）
   ↓ 同上
```

**C2 GPU 兼容性矩阵**：
| 档位 | GPU 类型 | 后端 | 性能 |
|------|---------|------|------|
| 🟢 CUDA | NVIDIA | CUDA | 最快（3-5x）|
| 🟡 Vulkan | Intel iGPU / AMD | Vulkan | 中等 |
| 🔴 CPU | 无 Vulkan 1.2+ | CPU | 最慢（P6 决策是否禁用）|

**最低硬件**：Win11 22H2+ / Vulkan 1.2+ / 16GB+

**工作量估计**：7-9 天

---

### 📦 批次 D：收尾

| 任务 | 说明 | 复杂度 |
|------|------|--------|
| **D1 目录重构** | extensions→data/，files→knowledge/，data 提升到根 | 中 |
| **D2 requirements.txt 清理** | 打包不包含，只留开发环境 | 低 |
| **D3 全面回归测试** | 所有功能端到端 + 100 文件压力测试 | 中 |
| **D4 ISS 打包** | setup.iss（normal 压缩）+ 扩展包 | 低 |
| **D5 灰度发布** | 小范围用户测试 | — |

**为什么 D1 目录重构放最后**：
- 大量 import 路径改，风险中
- 跟其他任务冲突面最大
- 放最后做，配合全面回归测试验证

**工作量估计**：4-5 天

---

## 三、总工作量估计

| 批次 | 工作量 | 累计 | 重点 |
|------|--------|------|------|
| **A 稳定性基建** | 12-15 天 | 12-15 天 | 🥇 最高优先 |
| **B 功能闭环** | 6-8 天 | 18-23 天 | 🥈 |
| **C 分发+产品化** | 7-9 天 | 25-32 天 | 🥉 |
| **D 收尾** | 4-5 天 | 29-37 天 | |

**总计：29-37 天**（约 6-7 周）

---

## 四、任务依赖关系图

```
A1 线程池 ──→ A2 任务队列 ──→ B1 批量操作 UI
                              ──→ B4 去重检测（批量冲突）

A4 检索统一（独立，可并行）

A3 Go 看门狗（独立，可并行）

A5 硬链接恢复（独立）

B2 扩展包改造 ──→ C1 小包+扩展分发

C2 GPU 检测（独立）

D1 目录重构（最后做，风险隔离）
```

**可并行的任务**：
- A1 完成后，A2 / A3 / A4 / A5 可并行
- B1 / B3 互相独立
- C3 / C4 / C5 互相独立

---

## 五、已废弃 / 不做

| 任务 | 原因 |
|------|------|
| ❌ 版本更新检查 | 用户决策不做 |
| ❌ 进度面板持久化 | 有稳定下载按钮后不需要 |
| ❌ BM25 + 向量双路优化 | 被 A4 检索统一取代 |
| ❌ Python 级看门狗 | 被 A3 Go 看门狗取代 |

---

## 六、P4 遗留 BUG（已修，待验证）

| BUG | 状态 | 说明 |
|-----|------|------|
| BUG#27 多选 KB 只注入第一篇 | ✅ commit f80ed34 | 拆分逗号逐个查 |
| BUG#28 工具超限仍调用 | ✅ commit f80ed34 | 执行前二次检查 |
| BUG#29 向量索引缺失不重建 | ✅ commit 73dfd45 | 补充判断逻辑 |
| BUG#30 启动时重建卡死 | ✅ commit 79247b1 | 懒加载模式 |
| BUG#31 API Key 第二轮失效 | ✅ commit（本轮） | 空 key 不清空 |
| BUG#32 KB 计数器不一致 | ✅ commit（本轮） | 统一变量 |
| BUG#33 加密 PDF 崩溃 | ✅ commit 071c39a | is_encrypted 检测 |

---

## 七、待决策项

- [ ] C3 品牌视觉：AI 生成（logo.svg 已有）vs 设计师
- [ ] C6 代码签名：是否现在买 EV 证书（$400/年）
- [ ] B3 权限系统：预设模式 vs 完全自定义
- [ ] A2 任务队列：用 Python queue + 文件状态 vs Redis（嵌入式场景应该用前者）

---

## 八、关键架构决策记录

| 决策 | 内容 | 日期 |
|------|------|------|
| **P5 首要目标** | 功能跑通 + 功能稳定（不是堆功能）| 2026-06-19 |
| **线程池改造** | FastAPI 阻塞操作丢 ThreadPoolExecutor | 2026-06-19 |
| **看门狗提级** | Go Launcher 监测 + 重启，替代 Python 级 | 2026-06-19 |
| **检索引擎** | bge-m3 dense+sparse 统一，移除 BM25/jieba | 2026-06-19 |
| **扩展包** | 仅模型，依赖跟嵌入式 Python | 2026-06-19 |
| **分发策略** | 小包 + 纯模型扩展包（绕过 Defender）| 2026-06-19 |
| **依赖恢复** | 双副本 + mklink 硬链接（替代全量 zip）| 2026-06-19 |
| **目录结构** | server/ 纯源码，data/ 纯数据（D1 最后做）| 2026-06-19 |
| **权限模型** | KB 权限 + 工具开关双层 | 2026-06-19 |
| **去重阈值** | 内容相似度 ≥ 95% 触发 + 批量冲突处理 | 2026-06-19 |
| **GPU 兼容** | 三档分流（CUDA/Vulkan/CPU），Vulkan 1.2 底线 | 2026-06-19 |
| **CUDA 来源** | 方案 B（从 Ollama 官方包提取）| 2026-06-19 |
| **OS 支持** | 官方只推荐 Win11 | 2026-06-19 |
| **CPU fallback** | P5 暂保留，P6 决策是否禁用 | 2026-06-19 |
| **ISS 压缩** | ultra64 → normal（20x 速度）| 2026-06-19 |

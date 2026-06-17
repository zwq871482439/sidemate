# 桌伴 Sidemate — 本地 LLM 推理参数与模型选型深度分析

> **日期**: 2026-05-29
> **项目**: 桌伴 · Sidemate (Patch 12)
> **目标**: 在两台笔记本（Intel Ultra 7 155H + AMD AI 9 HX 370）上找到最优模型参数搭配

---

## 目录

1. [LLM 推理核心概念科普](#1-llm-推理核心概念科普) 🖼️
2. [推理量化详解](#2-推理量化详解) 🖼️
3. [KV 缓存量化详解](#3-kv-缓存量化详解) 🖼️
4. [注意力机制详解](#4-注意力机制详解) 🖼️
5. [位置编码详解](#5-位置编码详解)
6. [桌伴当前模型参数配置](#6-桌伴当前模型参数配置)
7. [两台电脑硬件对比](#7-两台电脑硬件对比) 🖼️
8. [VRAM 计算器原理与使用](#8-vram-计算器原理与使用)
9. [模型选型推荐方案](#9-模型选型推荐方案) 🖼️
10. [总结与行动建议](#10-总结与行动建议)
11. [LLM 训练全流程科普](#11-llm-训练全流程科普) 🖼️
12. [教师模型与学生模型（知识蒸馏）](#12-教师模型与学生模型知识蒸馏) 🖼️
13. [全量微调 vs LoRA vs QLoRA 详解](#13-全量微调-vs-lora-vs-qlora-详解) 🖼️
14. [Qwen3.5 升级可行性分析](#14-qwen35-升级可行性分析) 🖼️

> 🖼️ 标记表示该章节包含可视化图表

---

## 1. LLM 推理核心概念科普

### 1.1 总览：LLM 就是「读完万卷书的学生在考试」

一个 LLM（大语言模型）的训练过程，就像让一个学生读了万亿字的书籍，然后在考试时根据前面的题目内容来"预测"下一个应该写的字。

| 考试元素 | 对应 LLM 概念 | 说明 |
|---------|-------------|------|
| 学生的记忆/经验 | **权重 (Weights)** | 训练得到的数字矩阵，模型的所有知识都存在这里 |
| 读题时的"重点关注" | **注意力 (Attention)** | 模型自动判断输入中哪些词最相关，把注意力集中上去 |
| 知道"第几题"的能力 | **位置编码 (RoPE)** | 让模型知道每个 token 在文本中的位置关系 |
| 做题过程中的草稿纸 | **KV Cache** | 推理时缓存中间结果，避免重复计算 |
| 答题风格（保守/发散）| **采样参数** | temperature、top_p 等控制输出行为的参数 |

### 1.2 核心参数分类

LLM 的参数分为**两大类**：

1. **模型架构参数**：训练时决定，不能改（如层数、头数、隐藏维度）
2. **推理采样参数**：部署时可调（如 temperature、top_p）

架构参数决定了"这个模型有多聪明"，推理参数决定了"这个模型怎么表达"。

#### 📊 图表 1-1：LLM 推理直觉类比

> **TL;DR**：大模型就像一个读了万亿字的学生参加「接话考试」——权重是他的记忆，推理时一个字一个字往外蹦，采样参数就是他的考试策略。

<details>
<summary>🖼️ 点击展开图表</summary>

<svg viewBox="0 0 680 380" width="100%" role="img">
  <title>大模型推理的直觉类比</title>
  <desc>用一个学生考试的类比解释大模型推理过程</desc>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>
  <style>
    .th { font: 500 14px/1.4 sans-serif; fill: #2C2C2A; }
    .ts { font: 400 12px/1.5 sans-serif; fill: #5F5E5A; }
    .tv { font: 500 13px/1.4 sans-serif; fill: #185FA5; }
    .an { font: 400 11px/1.4 sans-serif; fill: #993556; }
  </style>
  <text class="th" x="340" y="30" text-anchor="middle">大模型 = 读完万亿字的学生在「接话考试」</text>
  <rect x="40" y="55" width="180" height="145" rx="12" fill="#E1F5EE" stroke="#5DCAA5" stroke-width="0.5"/>
  <text class="th" x="130" y="80" text-anchor="middle">训练 (上学读书)</text>
  <text class="ts" x="55" y="102">读了几万亿字的文本</text>
  <text class="ts" x="55" y="120">学会了语言的「规律」</text>
  <text class="ts" x="55" y="138">这些规律 = <tspan class="tv">权重</tspan></text>
  <text class="ts" x="55" y="156">写入大脑 = 模型文件</text>
  <text class="an" x="55" y="180">咱们的 ~5GB 文件就是这些</text>
  <line x1="225" y1="128" x2="250" y2="128" stroke="#5DCAA5" stroke-width="1.5" marker-end="url(#arrow)"/>
  <rect x="255" y="55" width="180" height="145" rx="12" fill="#E6F1FB" stroke="#85B7EB" stroke-width="0.5"/>
  <text class="th" x="345" y="80" text-anchor="middle">推理 (参加考试)</text>
  <text class="ts" x="270" y="102">你问一句话</text>
  <text class="ts" x="270" y="120">模型凭记忆预测下一个字</text>
  <text class="ts" x="270" y="138">再根据前文预测下一个</text>
  <text class="ts" x="270" y="156">一个字一个字往外蹦</text>
  <text class="an" x="270" y="180">就是你在桌伴看到的流式输出</text>
  <line x1="440" y1="128" x2="465" y2="128" stroke="#85B7EB" stroke-width="1.5" marker-end="url(#arrow)"/>
  <rect x="470" y="55" width="180" height="145" rx="12" fill="#FAECE7" stroke="#F0997B" stroke-width="0.5"/>
  <text class="th" x="560" y="80" text-anchor="middle">采样参数 (考试策略)</text>
  <text class="ts" x="485" y="102">temperature = 答题保守程度</text>
  <text class="ts" x="485" y="120">top_p = 考虑几个候选答案</text>
  <text class="ts" x="485" y="138">repetition = 允不允许重复</text>
  <text class="ts" x="485" y="156">max_tokens = 最多写多少字</text>
  <text class="an" x="485" y="180">这些咱们代码里可以随时调</text>
  <rect x="40" y="225" width="600" height="130" rx="12" fill="#F1EFE8" stroke="#B4B2A9" stroke-width="0.5"/>
  <text class="th" x="340" y="252" text-anchor="middle">架构参数 = 这个学生的「大脑物理结构」</text>
  <text class="ts" x="60" y="278">hidden_size 4096 = 脑容量大小（一次能想多宽）</text>
  <text class="ts" x="60" y="298">num_layers 36 = 脑子有几层（想得有多深）</text>
  <text class="ts" x="60" y="318">attention_heads 32 = 同时关注几个方面（注意力广度）</text>
  <text class="ts" x="60" y="338">vocab_size 151936 = 认识多少个字（词汇量）</text>
  <text class="an" x="60" y="350">这些是训练时就定死的，改不了，只能选不同模型</text>
</svg>

</details>

#### 📊 图表 1-2：Qwen3-8B 架构参数图

> **TL;DR**：Qwen3-8B 的核心架构：36层深度、4096宽度、32个注意力头、8个KV头（GQA省75%内存），INT4量化后仅5GB。

<details>
<summary>🖼️ 点击展开图表</summary>

<svg viewBox="0 0 680 320" width="100%" role="img">
  <title>Qwen3-8B 模型架构关键参数</title>
  <desc>展示 Qwen3-8B 模型的核心架构参数</desc>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>
  <style>
    .t { font: 400 13px/1.6 sans-serif; fill: #2C2C2A; }
    .th { font: 500 14px/1.4 sans-serif; fill: #2C2C2A; }
    .ts { font: 400 12px/1.4 sans-serif; fill: #5F5E5A; }
    .tv { font: 500 13px/1.4 sans-serif; fill: #185FA5; }
  </style>

  <rect x="40" y="20" width="600" height="280" rx="16" fill="#E6F1FB" stroke="#85B7EB" stroke-width="0.5"/>
  <text class="th" x="340" y="50" text-anchor="middle">Qwen3-8B 架构参数全景</text>

  <rect x="60" y="70" width="170" height="100" rx="8" fill="#fff" stroke="#B5D4F4" stroke-width="0.5"/>
  <text class="th" x="145" y="92" text-anchor="middle">注意力层</text>
  <text class="t" x="75" y="112">num_attention_heads: <tspan class="tv">32</tspan></text>
  <text class="t" x="75" y="130">num_key_value_heads: <tspan class="tv">8</tspan></text>
  <text class="t" x="75" y="148">head_dim: <tspan class="tv">128</tspan></text>

  <rect x="255" y="70" width="170" height="100" rx="8" fill="#fff" stroke="#B5D4F4" stroke-width="0.5"/>
  <text class="th" x="340" y="92" text-anchor="middle">网络结构</text>
  <text class="t" x="270" y="112">hidden_size: <tspan class="tv">4096</tspan></text>
  <text class="t" x="270" y="130">intermediate_size: <tspan class="tv">12288</tspan></text>
  <text class="t" x="270" y="148">num_hidden_layers: <tspan class="tv">36</tspan></text>

  <rect x="450" y="70" width="170" height="100" rx="8" fill="#fff" stroke="#B5D4F4" stroke-width="0.5"/>
  <text class="th" x="535" y="92" text-anchor="middle">位置/词表</text>
  <text class="t" x="465" y="112">rope_theta: <tspan class="tv">1,000,000</tspan></text>
  <text class="t" x="465" y="130">max_position: <tspan class="tv">40,960</tspan></text>
  <text class="t" x="465" y="148">vocab_size: <tspan class="tv">151,936</tspan></text>

  <rect x="60" y="190" width="260" height="90" rx="8" fill="#fff" stroke="#B5D4F4" stroke-width="0.5"/>
  <text class="th" x="190" y="212" text-anchor="middle">GQA 分组 (32Q → 8KV)</text>
  <text class="ts" x="75" y="232">每 4 个 Query Head 共享 1 个 KV Head</text>
  <text class="ts" x="75" y="250">KV Cache = 8 heads × 128 dim × 2 (K+V)</text>
  <text class="ts" x="75" y="266">比 MHA 节省 <tspan fill="#0F6E56" font-weight="500">75%</tspan> KV 显存</text>

  <rect x="350" y="190" width="270" height="90" rx="8" fill="#fff" stroke="#B5D4F4" stroke-width="0.5"/>
  <text class="th" x="485" y="212" text-anchor="middle">量化 (INT4)</text>
  <text class="ts" x="365" y="232">原始 FP16: ~16 GB 权重</text>
  <text class="ts" x="365" y="250">INT4 量化后: ~5 GB (压缩 <tspan fill="#0F6E56" font-weight="500">3.2x</tspan>)</text>
  <text class="ts" x="365" y="266">激活函数: SiLU · Norm: RMSNorm</text>
</svg>

</details>

---

## 2. 推理量化详解

#### 📊 图表 2-1：推理参数 vs 内存影响对比

> **TL;DR**：INT4量化把权重从32GB压到5GB（省85%），GQA注意力把KV Cache从4.5GB降到1.1GB（省75%）。这两个是桌伴能在32GB笔记本上跑起来的关键。

<svg viewBox="0 0 680 400" width="100%" xmlns="http://www.w3.org/2000/svg">
  <title>推理参数与内存影响对比</title>
  <style>
    text { font-family: system-ui, sans-serif; }
    .th { font-size: 14px; font-weight: 600; fill: #1a1a1a; }
    .ts { font-size: 11px; fill: #666; }
    .tv { font-size: 12px; font-weight: 500; fill: #1a1a1a; }
    .label { font-size: 11px; fill: #333; }
  </style>
  
  <!-- Title -->
  <text class="th" x="340" y="24" text-anchor="middle">不同参数对内存和速度的影响对比</text>
  
  <!-- Legend -->
  <rect x="160" y="36" width="10" height="10" rx="2" fill="#378ADD"/>
  <text class="ts" x="175" y="46">权重内存</text>
  <rect x="280" y="36" width="10" height="10" rx="2" fill="#D85A30"/>
  <text class="ts" x="295" y="46">KV Cache</text>
  <rect x="400" y="36" width="10" height="10" rx="2" fill="#639922"/>
  <text class="ts" x="415" y="46">推理速度</text>

  <!-- X axis -->
  <line x1="150" y1="60" x2="150" y2="370" stroke="#ccc" stroke-width="0.5"/>
  <line x1="150" y1="370" x2="660" y2="370" stroke="#ccc" stroke-width="0.5"/>
  <text class="ts" x="400" y="392" text-anchor="middle">内存占用 (GB)</text>

  <!-- Grid lines -->
  <line x1="150" y1="370" x2="660" y2="370" stroke="#e5e5e5" stroke-width="0.5"/>
  <line x1="150" y1="300" x2="660" y2="300" stroke="#e5e5e5" stroke-width="0.5" stroke-dasharray="3,3"/>
  <line x1="150" y1="230" x2="660" y2="230" stroke="#e5e5e5" stroke-width="0.5" stroke-dasharray="3,3"/>
  <line x1="150" y1="160" x2="660" y2="160" stroke="#e5e5e5" stroke-width="0.5" stroke-dasharray="3,3"/>
  <line x1="150" y1="90" x2="660" y2="90" stroke="#e5e5e5" stroke-width="0.5" stroke-dasharray="3,3"/>
  <text class="ts" x="145" y="374" text-anchor="end">0</text>
  <text class="ts" x="145" y="304" text-anchor="end">8</text>
  <text class="ts" x="145" y="234" text-anchor="end">16</text>
  <text class="ts" x="145" y="164" text-anchor="end">24</text>
  <text class="ts" x="145" y="94" text-anchor="end">32</text>

  <!-- Bars (x scale: 150=0GB, 660=32GB, so 1GB = (660-150)/32 = 15.94px) -->
  <!-- FP32 权重 32GB -->
  <text class="label" x="145" y="84" text-anchor="end">FP32 权重</text>
  <rect x="150" y="72" width="510" height="22" rx="3" fill="#378ADD"/>
  <text class="tv" x="665" y="88">32 GB</text>

  <!-- FP16 权重 16GB -->
  <text class="label" x="145" y="114" text-anchor="end">FP16 权重</text>
  <rect x="150" y="102" width="255" height="22" rx="3" fill="#378ADD"/>
  <text class="tv" x="410" y="118">16 GB</text>

  <!-- INT8 权重 8GB -->
  <text class="label" x="145" y="144" text-anchor="end">INT8 权重</text>
  <rect x="150" y="132" width="128" height="22" rx="3" fill="#378ADD"/>
  <text class="tv" x="283" y="148">8 GB</text>

  <!-- INT4 权重 5GB -->
  <text class="label" x="145" y="174" text-anchor="end">INT4 权重</text>
  <rect x="150" y="162" width="80" height="22" rx="3" fill="#378ADD"/>
  <text class="tv" x="235" y="178">5 GB</text>

  <!-- MHA KV 4.5GB -->
  <text class="label" x="145" y="210" text-anchor="end">MHA KV Cache</text>
  <rect x="150" y="198" width="72" height="22" rx="3" fill="#D85A30"/>
  <text class="tv" x="227" y="214">4.5 GB</text>

  <!-- GQA KV 1.1GB -->
  <text class="label" x="145" y="240" text-anchor="end">GQA KV Cache</text>
  <rect x="150" y="228" width="18" height="22" rx="3" fill="#D85A30"/>
  <text class="tv" x="173" y="244">1.1 GB</text>

  <!-- MLA KV 0.3GB -->
  <text class="label" x="145" y="270" text-anchor="end">MLA KV Cache</text>
  <rect x="150" y="258" width="5" height="22" rx="2" fill="#D85A30"/>
  <text class="tv" x="160" y="274">0.3 GB</text>

  <!-- 长上下文 32K 2.2GB -->
  <text class="label" x="145" y="306" text-anchor="end">长上下文 32K</text>
  <rect x="150" y="294" width="35" height="22" rx="3" fill="#639922"/>
  <text class="tv" x="190" y="310">2.2 GB</text>

  <!-- 短上下文 4K 0.28GB -->
  <text class="label" x="145" y="336" text-anchor="end">短上下文 4K</text>
  <rect x="150" y="324" width="4" height="22" rx="2" fill="#639922"/>
  <text class="tv" x="159" y="340">0.28 GB</text>
</svg>

### 2.1 什么是量化？

**量化**就是把模型权重从高精度格式压缩为更低位宽格式。类比：原始模型像高精度照片（清晰但文件大），量化模型像压缩照片（细节略损但更轻更快）。

| 量化格式 | 每参数占位 | 7B模型体积 | 质量损失 | 推理速度 |
|---------|----------|-----------|---------|---------|
| **FP16** | 2.0 字节 | ~14 GB | 无损（基线） | 基线 |
| **Q8_0** | 1.06 字节 | ~7.4 GB | 几乎无损 (~1%) | ~1.2x |
| **Q5_K_M** | 0.69 字节 | ~4.8 GB | 轻微损失 (~2%) | ~1.6x |
| **Q4_K_M** | 0.56 字节 | ~3.9 GB | 可接受 (~3%) | ~2.0x |
| **Q3_K_M** | 0.38 字节 | ~2.7 GB | 明显损失 (~5%) | ~2.5x |
| **Q2_K** | 0.25 字节 | ~1.8 GB | 较大损失 (~10%) | ~3.0x |

> **关键规律**：位宽减半，体积约减半，推理速度约提升 2 倍（因为内存带宽瓶颈缓解了）。

### 2.2 量化命名规则

以 `Q4_K_M` 为例：
- `Q4` = 4-bit 量化（每个权重用 4 位存储）
- `K` = K-quants 方法（改进的量化算法）
- `M` = Medium（中等精度，平衡文件大小和质量）

后缀说明：
| 后缀 | 含义 | 建议 |
|------|------|------|
| `K_S` | Small（更激进压缩） | 通常不推荐 |
| **`K_M`** | **Medium（平衡方案）** | **几乎所有场景的最佳选择** |
| `K_L` | Large（较少压缩） | VRAM 充裕时使用 |

### 2.3 不同任务对量化的敏感度

| 任务类型 | 敏感度 | 推荐量化 | 原因 |
|---------|--------|---------|------|
| 编程/代码 | 最高 | Q5_K_M+ | 一个 token 错误可能导致功能崩溃 |
| 推理/数学 | 高 | Q5_K_M+ | 长链推理中微小误差会级联放大 |
| 创意写作 | 中等 | Q4_K_M 可用 | 词汇选择可能受损 |
| **日常对话** | **低** | **Q4_K_M 足够** | **自然语言冗余性高** |
| 摘要/提取 | 低 | Q4_K_M 甚至 Q3 | 依赖模式识别 |

> **黄金法则**：用更小的模型跑更高质量量化，胜过用更大的模型跑低质量量化。**7B@Q4_K_M 通常优于 14B@Q2_K**，且运行更快。

### 2.4 OpenVINO 的量化（桌伴使用的方案）

桌伴用的是 **OpenVINO INT4** 量化，与 GGUF 的 Q4_K_M 类似但不完全相同：

- OpenVINO INT4 使用 **对称量化** + **权重压缩**
- 桌伴当前 Qwen3-8B-INT4 模型约 **5.8 GB**
- 这是 OpenVINO 优化的专有格式（`.xml` + `.bin` 文件），不是 GGUF

---

## 3. KV 缓存量化详解

### 3.1 什么是 KV Cache？

KV Cache 是推理过程中**动态增长的内存**。每生成一个新 token，模型都要把当前层的 Key 和 Value 向量缓存起来，供后续 token 引用。

```
KV Cache 大小 = 层数 × KV头数 × head_dim × 2(K+V) × seq_len × 精度字节数
```

以 Qwen3-8B 为例（36 层、8 KV头、128 维、4K 上下文）：
- **FP16**: 36 × 8 × 128 × 2 × 4096 × 2 = **~0.56 GB**
- **FP8**: 36 × 8 × 128 × 2 × 4096 × 1 = **~0.28 GB**
- **INT4**: 36 × 8 × 128 × 2 × 4096 × 0.5 = **~0.14 GB**

### 3.2 KV 量化选项

| KV 量化 | 精度 | 内存占比(4K) | 说明 |
|---------|------|-------------|------|
| FP16 | 半精度 | 最大（基线） | 默认，质量最好 |
| FP8 | 8位浮点 | 减少 50% | 几乎无损，推荐 |
| INT4 | 4位整数 | 减少 75% | 有损但对长上下文很有价值 |

### 3.3 为什么 KV 量化重要？

上下文越长，KV Cache 越大。在 32K 上下文时，KV Cache 可能占到 **4-5 GB**。对于 32GB 内存的笔记本，这部分很关键。

> **建议**：桌伴的日常对话场景（上下文通常 <4K），KV Cache 约 0.5-1 GB，不构成瓶颈。如果未来支持长文档（>16K），应考虑 KV FP8 量化。

---

## 4. 注意力机制详解

#### 📊 图表 4-1：注意力机制 MHA vs GQA

> **TL;DR**：MHA 是"每人自带笔记本"（32份笔记），GQA 是"4人共用1本"（只需8份）。Qwen3 用的 GQA 直接省掉 75% KV 内存，是桌伴跑得动的原因之一。

<details>
<summary>🖼️ 点击展开图表</summary>

<svg viewBox="0 0 680 340" width="100%" role="img">
  <title>注意力机制：MHA vs GQA 对比</title>
  <desc>用教室座位类比解释 MHA 和 GQA 的区别</desc>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>
  <style>
    .th { font: 500 14px/1.4 sans-serif; fill: #2C2C2A; }
    .ts { font: 400 12px/1.5 sans-serif; fill: #5F5E5A; }
    .tv { font: 500 13px/1.4 sans-serif; fill: #185FA5; }
    .t  { font: 400 13px/1.6 sans-serif; fill: #2C2C2A; }
  </style>

  <text class="th" x="340" y="30" text-anchor="middle">MHA vs GQA：从「每人一份笔记」到「4人共用一份」</text>

  <rect x="40" y="50" width="290" height="130" rx="12" fill="#FCEBEB" stroke="#F09595" stroke-width="0.5"/>
  <text class="th" x="185" y="74" text-anchor="middle">MHA（老式）— 每人自带笔记本</text>
  <text class="ts" x="55" y="96">32 个学生 × 每人带 1 本笔记 = 32 本</text>
  <text class="ts" x="55" y="114">每个人独立听课、独立记笔记</text>
  <text class="ts" x="55" y="132">笔记占空间大，但信息最完整</text>
  <text class="ts" x="55" y="150">代表：GPT-3, LLaMA 1/2</text>
  <text class="tv" x="55" y="170">KV Cache: 100% (最大)</text>

  <rect x="350" y="50" width="290" height="130" rx="12" fill="#E1F5EE" stroke="#5DCAA5" stroke-width="0.5"/>
  <text class="th" x="495" y="74" text-anchor="middle">GQA（咱们用的）— 4人共用 1 本</text>
  <text class="ts" x="365" y="96">32 个学生 ÷ 4 人一组 = 只需 8 本</text>
  <text class="ts" x="365" y="114">组内共享笔记，但各自独立思考</text>
  <text class="ts" x="365" y="132">笔记省 75% 空间，效果差不多</text>
  <text class="ts" x="365" y="150">代表：Qwen3, LLaMA 3, Mistral</text>
  <text class="tv" x="365" y="170">KV Cache: 25% (省 75%)</text>

  <rect x="40" y="200" width="600" height="120" rx="12" fill="#F1EFE8" stroke="#B4B2A9" stroke-width="0.5"/>
  <text class="th" x="340" y="226" text-anchor="middle">KV Cache = 听课时记的「临时笔记」</text>
  <text class="t" x="60" y="250">每预测一个新字，都要回头看之前所有字的笔记</text>
  <text class="t" x="60" y="270">对话越长 → 笔记越多 → 占内存越大</text>
  <text class="t" x="60" y="290">GQA 的好处：笔记量直接砍到 1/4</text>
  <text class="t" x="60" y="310">这就是为什么咱们 8B 模型在 NPU 上跑得动的原因之一</text>
</svg>

</details>

### 4.1 注意力是 Transformer 的核心

一句话里有 20 个字，模型在预测第 21 个字时，并不是平等地看前 20 个字——它会**自动判断哪些字跟当前预测最相关**，然后把注意力集中在那几个字上。

就像你读"小猫坐在___"，预测下一个字时你会特别关注"小猫"和"坐在"而不是"的"、"了"。

### 4.2 三种注意力结构

| 类型 | Q 头数 | KV 头数 | KV Cache | 代表模型 |
|------|--------|---------|----------|---------|
| MHA (Multi-Head) | 32 | 32 | 最大(100%) | GPT-3, 早期 LLaMA |
| **GQA (Grouped Query)** | **32** | **8** | **25%** | **Qwen3, LLaMA3** |
| MLA (Multi-head Latent) | 32 | 压缩向量 | ~7% | DeepSeek-V3 |

Qwen3-8B 使用 **GQA**：每 4 个 Q 头共享 1 个 KV 头，节省了 75% 的 KV Cache 内存，同时几乎不影响质量。

### 4.3 MoE（混合专家）

Qwen3 还有 MoE 版本（如 30B-A3B），特点是：
- 总参数多（30B），但每个 token 只激活一部分专家（3B）
- **所有专家都必须加载到内存**，所以 VRAM 需求跟 30B 一样大
- 优势是**生成速度更快**（计算量少），不是省内存

> **对桌伴的启示**：MoE 不适合 32GB 内存，因为需要加载全部专家。Dense 模型（如 8B）更合适。

---

## 5. 位置编码详解

#### 📊 图表 5-1：位置编码与 KV Cache 详解

> **TL;DR**：RoPE 用旋转角度告诉模型"每个字排第几个"，KV Cache 是推理时的草稿纸（越写越多所以长对话会变慢）。桌伴你看到的"一个字一个字蹦"就是每次循环的结果。

<details>
<summary>🖼️ 点击展开图表</summary>

<svg viewBox="0 0 680 380" width="100%" role="img">
  <title>位置编码 RoPE 与 KV Cache 详解</title>
  <desc>用排队和草稿纸类比解释位置编码和 KV Cache</desc>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>
  <style>
    .th { font: 500 14px/1.4 sans-serif; fill: #2C2C2A; }
    .ts { font: 400 12px/1.5 sans-serif; fill: #5F5E5A; }
    .tv { font: 500 13px/1.4 sans-serif; fill: #185FA5; }
    .t  { font: 400 13px/1.6 sans-serif; fill: #2C2C2A; }
    .an { font: 400 11px/1.4 sans-serif; fill: #993556; }
  </style>

  <rect x="40" y="20" width="290" height="165" rx="12" fill="#EEEDFE" stroke="#AFA9EC" stroke-width="0.5"/>
  <text class="th" x="185" y="46" text-anchor="middle">RoPE 位置编码</text>
  <text class="ts" x="55" y="68">= 告诉模型「每个字排第几个」</text>
  <text class="ts" x="55" y="88">想象一排人站队：</text>
  <text class="ts" x="55" y="108">"我爱你中国" → 第1、第2、第3、第4</text>
  <text class="ts" x="55" y="128">RoPE 用「旋转角度」来编码位置</text>
  <text class="ts" x="55" y="148">rope_theta=1,000,000 → 角度分得很细</text>
  <text class="tv" x="55" y="170">最大能排 40,960 个字</text>

  <rect x="350" y="20" width="290" height="165" rx="12" fill="#EAF3DE" stroke="#97C459" stroke-width="0.5"/>
  <text class="th" x="495" y="46" text-anchor="middle">KV Cache = 草稿纸</text>
  <text class="ts" x="365" y="68">模型每算一个字，都要回头看前面</text>
  <text class="ts" x="365" y="88">所有字的 Key 和 Value 存下来</text>
  <text class="ts" x="365" y="108">就不用每次重新算了（省计算）</text>
  <text class="ts" x="365" y="128">但草稿纸会越积越多（占内存）</text>
  <text class="ts" x="365" y="148">对话 10 轮 → 草稿纸比权重还大</text>
  <text class="an" x="365" y="170">这就是为什么长对话会越来越慢</text>

  <rect x="40" y="205" width="600" height="155" rx="12" fill="#F1EFE8" stroke="#B4B2A9" stroke-width="0.5"/>
  <text class="th" x="340" y="232" text-anchor="middle">完整推理过程（一个字的诞生）</text>

  <text class="t" x="60" y="258">① 把你的问题拆成一个个 token（字/词）</text>
  <text class="t" x="60" y="278">② 每个token 查词表 → 变成数字 → 加上位置编码</text>
  <text class="t" x="60" y="298">③ 送入 36 层 Transformer 层，每层做注意力计算</text>
  <text class="t" x="60" y="318">④ 最后一层输出一个概率表（词表 151936 个字的概率）</text>
  <text class="t" x="60" y="338">⑤ 根据 temperature + top_p 采样 → 选出一个字 → 循环</text>
  <text class="an" x="60" y="354">桌伴里你看到的「一个字一个字蹦」就是每次循环的结果</text>
</svg>

</details>

### 5.1 RoPE（旋转位置编码）

Qwen3-8B 使用 **RoPE** (Rotary Position Embedding)，参数 `rope_theta = 1,000,000`。

**通俗理解**：RoPE 让模型知道每个 token 在第几个位置。theta 越大，模型能分辨的相对位置越远。theta=1M 意味着 Qwen3 理论上能处理很长的文本而不"乱位"。

### 5.2 上下文长度

`max_position_embeddings = 40,960` 是训练时的最大长度。虽然 RoPE 支持更长的外推，但超过训练长度的外推质量会下降。

> **对桌伴的启示**：桌伴设置 `max_history_chars` 根据模型大小动态调整（8B 默认 8000 字符 ≈ 4000 tokens），远在模型能力范围内。

---

## 6. 桌伴当前模型参数配置

### 6.1 当前硬件：Intel Core Ultra 7 155H

- **CPU**: 16核22线程 (6P+8E+2LPE)，最高 4.8GHz
- **GPU**: Intel Arc 8 Xe 核显，18 TOPS
- **NPU**: Intel AI Boost，11 TOPS
- **内存**: 32GB LPDDR5X-7467，带宽 ~120 GB/s
- **AI 框架**: OpenVINO

### 6.2 当前模型：Qwen3-8B-INT4

| 参数 | 值 | 说明 |
|------|-----|------|
| 模型文件 | `qwen3-8b-openvino-int4` | OpenVINO INT4 量化 |
| 权重精度 | INT4 | 约 5.8 GB |
| 推理设备 | NPU / GPU / CPU 自动选择 | 实测 GPU 最快 |
| hidden_size | 4096 | 模型内部表示宽度 |
| num_hidden_layers | 36 | 深度思考的层数 |
| num_attention_heads | 32 | 并行注意力角度 |
| num_key_value_heads | 8 | GQA，省 75% KV 内存 |
| intermediate_size | 12288 | FFN 中间层宽度 |
| vocab_size | 151936 | 词汇表大小 |
| max_position_embeddings | 40960 | 最大上下文长度 |
| rope_theta | 1,000,000 | 位置编码精度 |

### 6.3 推理采样参数 Profile

桌伴根据模型大小动态调整采样参数（`_MODEL_PROFILES`）：

| 模型大小 | temperature | top_p | repetition_penalty | max_history_chars | default_max_tokens |
|---------|-------------|-------|-------------------|------------------|-------------------|
| 0.5B | 0.5 | 0.85 | 1.3 | 2500 | 1024 |
| 1.5B | 0.55 | 0.88 | 1.25 | 3500 | 1536 |
| 4B | 0.6 | 0.9 | 1.2 | 5000 | 2048 |
| **8B** | **0.6** | **0.9** | **1.3** | **8000** | **5120** |
| 14B+ | 0.7 | 0.92 | 1.1 | 12000 | 8192 |

#### 📊 图表 6-1：桌伴实际推理参数配置

> **TL;DR**：桌伴的 8B 模型 Profile：temperature=0.6（适当创造），top_p=0.9（窄采样保质量），max_tokens=5120（最多输出~3000字）。模型越小参数越保守，越大越自由。

<details>
<summary>🖼️ 点击展开图表</summary>

<svg viewBox="0 0 680 420" width="100%" role="img">
  <title>桌伴 Sidemate 实际推理参数配置</title>
  <desc>展示模型在不同参数规模下的推理参数 Profile</desc>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>
  <style>
    .t { font: 400 13px/1.6 sans-serif; fill: #2C2C2A; }
    .th { font: 500 14px/1.4 sans-serif; fill: #2C2C2A; }
    .ts { font: 400 12px/1.4 sans-serif; fill: #5F5E5A; }
    .tv { font: 500 13px/1.4 sans-serif; fill: #0F6E56; }
  </style>

  <text class="th" x="340" y="30" text-anchor="middle">桌伴 Sidemate 推理参数 Profile（按模型规模自适应）</text>

  <rect x="40" y="50" width="290" height="160" rx="12" fill="#E1F5EE" stroke="#5DCAA5" stroke-width="0.5"/>
  <text class="th" x="185" y="74" text-anchor="middle">当前使用: Qwen3-8B Profile</text>
  <text class="t" x="60" y="98">temperature: <tspan class="tv">0.6</tspan> <tspan class="ts">(创造力)</tspan></text>
  <text class="t" x="60" y="118">top_p: <tspan class="tv">0.9</tspan> <tspan class="ts">(采样范围)</tspan></text>
  <text class="t" x="60" y="138">repetition_penalty: <tspan class="tv">1.3</tspan> <tspan class="ts">(重复惩罚)</tspan></text>
  <text class="t" x="60" y="158">default_max_tokens: <tspan class="tv">5120</tspan> <tspan class="ts">(最大输出)</tspan></text>
  <text class="t" x="60" y="178">max_history_chars: <tspan class="tv">6000</tspan> <tspan class="ts">(上下文窗口)</tspan></text>
  <text class="t" x="60" y="198">think_mode max: <tspan class="tv">8192</tspan> <tspan class="ts">(思考模式)</tspan></text>

  <rect x="350" y="50" width="290" height="160" rx="12" fill="#FAECE7" stroke="#F0997B" stroke-width="0.5"/>
  <text class="th" x="495" y="74" text-anchor="middle">generation_config.json (模型默认)</text>
  <text class="t" x="370" y="98">temperature: <tspan class="tv">0.6</tspan></text>
  <text class="t" x="370" y="118">top_p: <tspan class="tv">0.95</tspan></text>
  <text class="t" x="370" y="138">top_k: <tspan class="tv">20</tspan></text>
  <text class="t" x="370" y="158">do_sample: <tspan class="tv">true</tspan></text>
  <text class="ts" x="370" y="178">注: 我们代码里没传 top_k，</text>
  <text class="ts" x="370" y="196">OpenVINO 默认行为由引擎决定</text>

  <rect x="40" y="230" width="600" height="170" rx="12" fill="#F1EFE8" stroke="#B4B2A9" stroke-width="0.5"/>
  <text class="th" x="340" y="256" text-anchor="middle">不同模型规模的 Profile 对比</text>

  <text class="ts" x="60" y="280">模型规模</text>
  <text class="ts" x="200" y="280">temp</text>
  <text class="ts" x="260" y="280">top_p</text>
  <text class="ts" x="320" y="280">rep_pen</text>
  <text class="ts" x="400" y="280">max_tokens</text>
  <text class="ts" x="490" y="280">history</text>
  <text class="ts" x="560" y="280">rounds</text>

  <line x1="55" y1="288" x2="630" y2="288" stroke="#B4B2A9" stroke-width="0.5"/>

  <text class="t" x="60" y="308">0.5B</text>
  <text class="t" x="200" y="308">0.50</text>
  <text class="t" x="260" y="308">0.85</text>
  <text class="t" x="320" y="308">1.30</text>
  <text class="t" x="400" y="308">1024</text>
  <text class="t" x="490" y="308">2500</text>
  <text class="t" x="560" y="308">4</text>

  <text class="t" x="60" y="332">1.5B</text>
  <text class="t" x="200" y="332">0.55</text>
  <text class="t" x="260" y="332">0.88</text>
  <text class="t" x="320" y="332">1.25</text>
  <text class="t" x="400" y="332">1536</text>
  <text class="t" x="490" y="332">3500</text>
  <text class="t" x="560" y="332">5</text>

  <text class="t" x="60" y="356">4B</text>
  <text class="t" x="200" y="356">0.60</text>
  <text class="t" x="260" y="356">0.90</text>
  <text class="t" x="320" y="356">1.20</text>
  <text class="t" x="400" y="356">2048</text>
  <text class="t" x="490" y="356">5000</text>
  <text class="t" x="560" y="356">6</text>

  <rect x="55" y="365" width="570" height="20" rx="4" fill="#E1F5EE" stroke="none"/>
  <text style="font: 500 13px/1.4 sans-serif; fill: #0F6E56;" x="60" y="380">8B (当前)</text>
  <text style="font: 500 13px/1.4 sans-serif; fill: #0F6E56;" x="200" y="380">0.60</text>
  <text style="font: 500 13px/1.4 sans-serif; fill: #0F6E56;" x="260" y="380">0.90</text>
  <text style="font: 500 13px/1.4 sans-serif; fill: #0F6E56;" x="320" y="380">1.30</text>
  <text style="font: 500 13px/1.4 sans-serif; fill: #0F6E56;" x="400" y="380">5120</text>
  <text style="font: 500 13px/1.4 sans-serif; fill: #0F6E56;" x="490" y="380">6000</text>
  <text style="font: 500 13px/1.4 sans-serif; fill: #0F6E56;" x="560" y="380">6</text>
</svg>

</details>

### 6.4 实测推理速度

在 Ultra 7 155H 上运行 Qwen3-8B INT4：

| 设备 | 速度 |
|------|------|
| GPU (Arc 核显) | **~13.1 tok/s**（最快） |
| NPU (AI Boost) | ~8.8 tok/s |
| CPU | ~7.8 tok/s |

---

## 7. 两台电脑硬件对比

#### 📊 图表 7-1：两台电脑硬件对比

> **TL;DR**：Intel 本 NPU 11 TOPS 但 GPU 推理快（13 tok/s），AMD 本 NPU 50 TOPS 是 Intel 的 4.5 倍且内存可扩展到 256GB。两台各有所长。

<details>
<summary>🖼️ 点击展开图表</summary>

<svg viewBox="0 0 680 520" width="100%">
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </marker>
</defs>
<style>
  .t { font: 400 13px system-ui, sans-serif; fill: #1a1a1a; }
  .ts { font: 400 12px system-ui, sans-serif; fill: #666; }
  .th { font: 500 14px system-ui, sans-serif; fill: #1a1a1a; }
  .tv { font: 500 22px system-ui, sans-serif; }
</style>

<!-- Intel Card -->
<rect x="30" y="30" width="295" height="470" rx="12" fill="#ffffff" stroke="#ddd" stroke-width="0.5"/>
<rect x="30" y="30" width="295" height="48" rx="12" fill="#E6F1FB"/>
<rect x="30" y="60" width="295" height="18" fill="#E6F1FB"/>
<text class="th" x="178" y="58" text-anchor="middle">Intel Core Ultra 7 155H</text>
<text class="ts" x="178" y="85" text-anchor="middle">Meteor Lake · 28W TDP · 32GB LPDDR5X</text>

<text class="t" x="50" y="115" font-weight="500">CPU: 16核22线程 · 4.8GHz</text>
<text class="t" x="50" y="145" font-weight="500">GPU: Arc 8 Xe · 2.25GHz</text>
<text class="ts" x="60" y="163">18 TOPS (Int8)</text>

<text class="t" x="50" y="190" font-weight="500">NPU: Intel AI Boost</text>
<text class="ts" x="60" y="208">11 TOPS (Int8) · OpenVINO</text>

<text class="t" x="50" y="238" font-weight="500">内存: LPDDR5X-7467</text>
<text class="ts" x="60" y="256">带宽 ~120 GB/s · 最大96GB</text>

<rect x="45" y="275" width="265" height="95" rx="8" fill="#EEEDFE" stroke="#ddd" stroke-width="0.5"/>
<text class="th" x="178" y="296" text-anchor="middle" fill="#534AB7">LLM 推理实测</text>
<text class="ts" x="60" y="318">Qwen3-8B INT4 @ NPU: ~8.8 tok/s</text>
<text class="ts" x="60" y="336">Qwen3-8B INT4 @ GPU: ~13.1 tok/s</text>
<text class="ts" x="60" y="354">Qwen3-8B INT4 @ CPU: ~7.8 tok/s</text>

<rect x="45" y="385" width="265" height="100" rx="8" fill="#FAECE7" stroke="#ddd" stroke-width="0.5"/>
<text class="th" x="178" y="406" text-anchor="middle" fill="#993C1D">瓶颈分析</text>
<text class="ts" x="60" y="428">NPU 11 TOPS 算力有限</text>
<text class="ts" x="60" y="446">GPU 8 Xe 核显是最佳推理器</text>
<text class="ts" x="60" y="464">32GB 内存跑 8B INT4 够用</text>

<!-- AMD Card -->
<rect x="355" y="30" width="295" height="470" rx="12" fill="#ffffff" stroke="#ddd" stroke-width="0.5"/>
<rect x="355" y="30" width="295" height="48" rx="12" fill="#E1F5EE"/>
<rect x="355" y="60" width="295" height="18" fill="#E1F5EE"/>
<text class="th" x="503" y="58" text-anchor="middle">AMD Ryzen AI 9 HX 370</text>
<text class="ts" x="503" y="85" text-anchor="middle">Strix Point · 28W TDP · 32-96GB</text>

<text class="t" x="375" y="115" font-weight="500">CPU: 12核24线程 · 5.1GHz</text>
<text class="t" x="375" y="145" font-weight="500">GPU: Radeon 890M · 16CU</text>
<text class="ts" x="385" y="163">RDNA 3.5 · 2.9GHz</text>

<text class="t" x="375" y="190" font-weight="500">NPU: XDNA 2</text>
<text class="ts" x="385" y="208">50 TOPS (Int8) · FastFlowLM</text>

<text class="t" x="375" y="238" font-weight="500">内存: LPDDR5X-8000</text>
<text class="ts" x="385" y="256">带宽 ~128 GB/s · 最大256GB</text>

<rect x="370" y="275" width="265" height="95" rx="8" fill="#EEEDFE" stroke="#ddd" stroke-width="0.5"/>
<text class="th" x="503" y="296" text-anchor="middle" fill="#534AB7">LLM 推理实测 (NPU)</text>
<text class="ts" x="385" y="318">Qwen3-0.6B INT4: ~66.5 tok/s</text>
<text class="ts" x="385" y="336">Qwen3-4B INT4: ~19.6 tok/s</text>
<text class="ts" x="385" y="354">Qwen3-8B INT4: ~11.9 tok/s</text>

<rect x="370" y="385" width="265" height="100" rx="8" fill="#E1F5EE" stroke="#ddd" stroke-width="0.5"/>
<text class="th" x="503" y="406" text-anchor="middle" fill="#0F6E56">优势分析</text>
<text class="ts" x="385" y="428">NPU 50 TOPS 是 Intel 的 4.5x</text>
<text class="ts" x="385" y="446">可扩展至 96GB 跑 14B+</text>
<text class="ts" x="385" y="464">FastFlowLM 生态成熟</text>

</svg>

</details>

### 7.1 规格

| 指标 | Intel Ultra 7 155H | AMD AI 9 HX 370 |
|------|-------------------|-----------------|
| **代号** | Meteor Lake | Strix Point |
| **CPU** | 16核22线程, 4.8GHz | 12核24线程, 5.1GHz |
| **GPU** | Arc 8 Xe, 2.25GHz | Radeon 890M 16CU, 2.9GHz |
| **GPU TOPS** | 18 | 未公布（预计 >20） |
| **NPU** | Intel AI Boost, **11 TOPS** | XDNA 2, **50 TOPS** |
| **总 AI TOPS** | 33 | 80 |
| **内存** | LPDDR5X-7467, 32GB(固定) | LPDDR5X-8000, 32-256GB(可扩展) |
| **内存带宽** | ~120 GB/s | ~128 GB/s |
| **TDP** | 28W (max 115W) | 28W (15-54W cTDP) |
| **AI 框架** | OpenVINO（成熟） | FastFlowLM / ROCm / Vulkan |
| **NPU 生态** | OpenVINO GenAI | FastFlowLM（1.4k stars） |

### 7.2 关键差异

1. **NPU 算力差距 4.5 倍**：AMD 50 TOPS vs Intel 11 TOPS
2. **内存可扩展性**：AMD 支持最大 256GB，Intel 固定 32GB（取决于笔记本主板）
3. **软件生态**：Intel OpenVINO 更成熟稳定；AMD FastFlowLM 发展迅速但较新
4. **GPU 推理**：Intel Arc 核显对 OpenVINO 优化好；AMD Radeon 可用 Vulkan/ROCm

---

## 8. VRAM 计算器原理与使用

### 8.1 工具简介

**apxml.com VRAM Calculator** 是一个在线计算器，可以：
- 选择模型（如 Qwen3-8B）
- 选择推理量化（FP16/Q8/Q4/Q2 等）
- 选择 KV 缓存量化（FP16/FP8/INT4）
- 配置上下文长度、批量大小
- 估算 VRAM 用量、生成速度、TTFT

### 8.2 计算原理

VRAM 总需求 = 模型权重 + KV Cache + 激活值 + 框架开销

```
权重内存 = 参数量 × 每参数字节数
KV Cache = 层数 × KV头数 × head_dim × 2 × seq_len × 精度字节数
激活值 ≈ 权重的 5-10%
框架开销 ≈ 0.5-1 GB
```

### 8.3 使用建议

1. 先选模型和量化，看总 VRAM 是否能装下
2. 调整上下文长度，看 KV Cache 增长
3. 关注生成速度和 TTFT 估算
4. 预留 1-2 GB 安全余量

> **注意**：这个计算器主要针对 NVIDIA GPU 和 Apple Silicon。对于 Intel/AMD 核显，因为使用共享内存（UMA），计算方式略有不同——所有内存都来自系统 RAM。

---

## 9. 模型选型推荐方案

#### 📊 图表 9-1：32GB 内存模型选择矩阵

> **TL;DR**：32GB 内存预算分配——系统占8GB，模型可用约24GB。Intel 本最佳方案是 8B INT4@GPU，AMD 本最佳方案是 4B INT4@NPU（最快）或 8B INT4@NPU（平衡）。

<details>
<summary>🖼️ 点击展开图表</summary>

<svg viewBox="0 0 680 440" width="100%">
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </marker>
</defs>
<style>
  .t { font: 400 13px system-ui, sans-serif; fill: #1a1a1a; }
  .ts { font: 400 11px system-ui, sans-serif; fill: #666; }
  .th { font: 500 14px system-ui, sans-serif; fill: #1a1a1a; }
</style>

<!-- Title -->
<text class="th" x="340" y="28" text-anchor="middle">32GB 内存预算分配（系统+应用占 ~8GB，可用于模型 ~24GB）</text>

<!-- Budget bar -->
<rect x="40" y="42" width="600" height="24" rx="4" fill="#f5f5f5"/>
<rect x="40" y="42" width="150" height="24" rx="4" fill="#F5C4B3"/>
<rect x="190" y="42" width="0" height="24" fill="transparent"/>
<text class="ts" x="115" y="58" text-anchor="middle" fill="#712B13">OS+应用 8GB</text>

<!-- Model cards -->
<!-- Qwen3-0.6B -->
<rect x="40" y="85" width="145" height="145" rx="8" fill="#ffffff" stroke="#ddd" stroke-width="0.5"/>
<text class="th" x="112" y="105" text-anchor="middle">Qwen3-0.6B</text>
<text class="ts" x="52" y="125">INT4: ~0.5 GB</text>
<text class="ts" x="52" y="142">INT8: ~0.9 GB</text>
<text class="ts" x="52" y="159">FP16: ~1.5 GB</text>
<rect x="50" y="172" width="125" height="20" rx="4" fill="#E1F5EE"/>
<text class="ts" x="112" y="186" text-anchor="middle" fill="#0F6E56">内存占用: 极低</text>
<text class="ts" x="52" y="218">速度: 40-67 tok/s</text>

<!-- Qwen3-1.7B -->
<rect x="195" y="85" width="145" height="145" rx="8" fill="#ffffff" stroke="#ddd" stroke-width="0.5"/>
<text class="th" x="268" y="105" text-anchor="middle">Qwen3-1.7B</text>
<text class="ts" x="207" y="125">INT4: ~1.3 GB</text>
<text class="ts" x="207" y="142">INT8: ~2.5 GB</text>
<text class="ts" x="207" y="159">FP16: ~4.5 GB</text>
<rect x="205" y="172" width="125" height="20" rx="4" fill="#E1F5EE"/>
<text class="ts" x="268" y="186" text-anchor="middle" fill="#0F6E56">内存占用: 低</text>
<text class="ts" x="207" y="218">速度: 24-40 tok/s</text>

<!-- Qwen3-4B -->
<rect x="350" y="85" width="145" height="145" rx="8" fill="#ffffff" stroke="#534AB7" stroke-width="2"/>
<text class="th" x="423" y="105" text-anchor="middle" fill="#534AB7">Qwen3-4B</text>
<text class="ts" x="362" y="125">INT4: ~3.2 GB</text>
<text class="ts" x="362" y="142">INT8: ~5.8 GB</text>
<text class="ts" x="362" y="159">FP16: ~10 GB</text>
<rect x="360" y="172" width="125" height="20" rx="4" fill="#EEEDFE"/>
<text class="ts" x="423" y="186" text-anchor="middle" fill="#534AB7">AMD 最佳甜点</text>
<text class="ts" x="362" y="218">速度: 11-20 tok/s</text>

<!-- Qwen3-8B -->
<rect x="505" y="85" width="145" height="145" rx="8" fill="#ffffff" stroke="#D85A30" stroke-width="2"/>
<text class="th" x="578" y="105" text-anchor="middle" fill="#D85A30">Qwen3-8B</text>
<text class="ts" x="517" y="125">INT4: ~5.8 GB</text>
<text class="ts" x="517" y="142">INT8: ~10.5 GB</text>
<text class="ts" x="517" y="159">FP16: ~18 GB</text>
<rect x="515" y="172" width="125" height="20" rx="4" fill="#FAECE7"/>
<text class="ts" x="578" y="186" text-anchor="middle" fill="#993C1D">Intel 当前使用</text>
<text class="ts" x="517" y="218">速度: 8-13 tok/s</text>

<!-- Recommendation section -->
<rect x="40" y="250" width="295" height="170" rx="8" fill="#E6F1FB" stroke="#ddd" stroke-width="0.5"/>
<text class="th" x="188" y="275" text-anchor="middle" fill="#0C447C">Ultra 7 155H (32GB) 推荐</text>
<text class="ts" x="55" y="298">当前: Qwen3-8B INT4 @ GPU (13 tok/s)</text>
<text class="ts" x="55" y="318">升级: Qwen3-4B INT4 @ NPU (更省电)</text>
<text class="ts" x="55" y="338">备选: Qwen3-8B INT4 + KV FP8</text>
<text class="ts" x="55" y="358">最佳体验: Qwen3-8B INT4 @ Arc GPU</text>
<rect x="55" y="370" width="265" height="20" rx="4" fill="#378ADD"/>
<text class="ts" x="188" y="384" text-anchor="middle" fill="white" font-weight="500">结论: 保持 8B INT4，用 GPU 推理最快</text>

<rect x="345" y="250" width="295" height="170" rx="8" fill="#E1F5EE" stroke="#ddd" stroke-width="0.5"/>
<text class="th" x="493" y="275" text-anchor="middle" fill="#085041">AI 9 HX 370 (32-96GB) 推荐</text>
<text class="ts" x="360" y="298">NPU: Qwen3-4B INT4 @ 20 tok/s</text>
<text class="ts" x="360" y="318">NPU: Qwen3-8B INT4 @ 12 tok/s</text>
<text class="ts" x="360" y="338">96GB: Qwen3-14B INT4 @ NPU</text>
<text class="ts" x="360" y="358">GPU: Qwen3-8B INT4 (ROCm/Vulkan)</text>
<rect x="360" y="370" width="265" height="20" rx="4" fill="#1D9E75"/>
<text class="ts" x="493" y="384" text-anchor="middle" fill="white" font-weight="500">结论: NPU 4B 最快，8B 平衡，可扩展至 14B</text>

</svg>

</details>

### 9.1 Intel Ultra 7 155H (32GB) 推荐方案

#### 方案 A：当前最优（推荐保持不变）

| 配置 | 值 |
|------|-----|
| 模型 | **Qwen3-8B** |
| 推理量化 | **INT4**（~5.8 GB） |
| KV 量化 | FP16（默认） |
| 推理设备 | **GPU (Arc 核显)** |
| 预期速度 | **~13 tok/s** |
| TTFT | <1s |
| 总内存占用 | ~7-8 GB |

**理由**：
- 8B 模型质量足够应对办公助手场景
- INT4 量化是质量/速度的最佳平衡
- GPU 推理比 NPU 快 50%
- 32GB 内存绰绰有余，还剩 ~24GB 给系统和 KB

#### 方案 B：省电模式

| 配置 | 值 |
|------|-----|
| 模型 | **Qwen3-4B** |
| 推理量化 | INT4（~3.2 GB） |
| 推理设备 | NPU |
| 预期速度 | ~8-10 tok/s |
| 功耗 | 最低 |

**适用场景**：移动办公、电池续航优先

#### 方案 C：质量优先（不推荐）

| 配置 | 值 |
|------|-----|
| 模型 | Qwen3-8B |
| 推理量化 | INT8（~10.5 GB） |
| 预期速度 | ~6-8 tok/s |

**不推荐原因**：速度下降 30-40%，质量提升不明显，不值得

### 9.2 AMD AI 9 HX 370 (32-96GB) 推荐方案

#### 方案 A：速度优先（推荐，32GB 即可）

| 配置 | 值 |
|------|-----|
| 模型 | **Qwen3-4B** |
| 推理量化 | **INT4**（~3.2 GB） |
| 推理设备 | **NPU (XDNA 2)** |
| 预期速度 | **~20 tok/s** |
| Prefill 速度 | ~615 tok/s |
| TTFT | <0.5s |
| 总内存占用 | ~4-5 GB |
| 功耗 | 极低 |

**理由**：
- NPU 50 TOPS 专门优化推理
- 4B 模型质量对于办公助手足够
- 20 tok/s 阅读体验非常流畅
- 几乎不影响其他任务

#### 方案 B：质量优先（推荐，32GB 即可）

| 配置 | 值 |
|------|-----|
| 模型 | **Qwen3-8B** |
| 推理量化 | **INT4**（~5.8 GB） |
| 推理设备 | **NPU (XDNA 2)** |
| 预期速度 | **~12 tok/s** |
| Prefill 速度 | ~457 tok/s |
| TTFT | <1s |
| 总内存占用 | ~7-8 GB |

**理由**：
- 8B 模型质量更好
- 12 tok/s 仍然流畅
- NPU 推理不影响 CPU/GPU 做其他事

#### 方案 C：大模型（需要升级到 64-96GB 内存）

| 配置 | 值 |
|------|-----|
| 模型 | **Qwen3-14B** |
| 推理量化 | INT4（~9.7 GB） |
| 推理设备 | GPU (Vulkan) 或 NPU |
| 预期速度 | ~6-8 tok/s |
| 总内存占用 | ~12-14 GB |

**前提**：需要 64GB+ 内存。AMD 平台支持扩展，这是相比 Intel 的最大优势。

#### 方案 D：MoE 方案（需要 64GB+ 内存）

| 配置 | 值 |
|------|-----|
| 模型 | **Qwen3-30B-A3B** (MoE) |
| 推理量化 | INT4（~18 GB） |
| 推理设备 | GPU (Vulkan) |
| 预期速度 | ~5-7 tok/s |
| 总内存占用 | ~20-22 GB |

**注意**：MoE 需要加载全部 30B 参数，但对每个 token 只激活 3B，所以速度比 30B Dense 快得多。

### 9.3 关键速度指标解释

| 指标 | 含义 | 用户体验 |
|------|------|---------|
| **Decoding Speed** (tok/s) | 生成速度，每秒产出多少 token | >10 tok/s 流畅阅读；>20 非常快 |
| **Prefill Speed** (tok/s) | 预填充速度，处理输入有多快 | 影响长文档的首次响应时间 |
| **TTFT** (ms) | 首个令牌时间 | <1s 即时响应；>3s 用户感知延迟 |

> **注意**：对于桌伴这种交互式对话场景，**Decoding Speed 是最关键的指标**，因为用户最关心的是"回复快不快"。

### 9.4 FastFlowLM NPU 推理速度实测（AMD AI 9 HX 370 同级）

以下数据来自 FastFlowLM 官方 Benchmark（测试平台：AMD Ryzen AI 7 350, 32GB）：

| 模型 | 1K 上下文 | 4K 上下文 | 16K 上下文 | 32K 上下文 |
|------|----------|----------|-----------|-----------|
| Qwen3-0.6B | 66.5 tok/s | 44.5 tok/s | 19.6 tok/s | 14.1 tok/s |
| Qwen3-1.7B | 40.2 tok/s | 30.8 tok/s | 16.4 tok/s | 12.5 tok/s |
| Qwen3-4B | 19.6 tok/s | 16.3 tok/s | 10.6 tok/s | 8.5 tok/s |
| Qwen3-8B | 11.9 tok/s | 11.1 tok/s | 8.7 tok/s | 7.2 tok/s |

**关键发现**：
- 8B 模型的速度衰减最平缓（1K→32K 只降 40%），因为计算密集而非内存密集
- 0.6B 模型衰减最大（1K→32K 降 79%），因为内存带宽成为瓶颈
- 4K 上下文是桌伴的典型使用场景，8B 模型在此场景下约 **11 tok/s**

---

## 10. 总结与行动建议

### 10.1 一句话总结

| 平台 | 最优配置 | 预期速度 | 用户体验 |
|------|---------|---------|---------|
| **Ultra 7 155H (32GB)** | Qwen3-8B INT4 @ Arc GPU | ~13 tok/s | 流畅 |
| **AI 9 HX 370 (32GB)** | Qwen3-4B INT4 @ NPU | ~20 tok/s | 非常流畅 |
| **AI 9 HX 370 (64GB+)** | Qwen3-8B INT4 @ NPU | ~12 tok/s | 流畅+高质量 |
| **AI 9 HX 370 (96GB)** | Qwen3-14B INT4 @ GPU | ~7 tok/s | 高质量 |

### 10.2 行动建议

1. **Ultra 7 155H**：保持当前配置（Qwen3-8B INT4），已是最优
2. **AI 9 HX 370**：
   - 如果 32GB：用 Qwen3-4B INT4 @ NPU（最快体验）
   - 如果升级到 64GB：用 Qwen3-8B INT4 @ NPU（质量+速度平衡）
   - 框架选择：**FastFlowLM**（NPU 专用，17MB，20 秒安装）
3. **两台电脑协同**：
   - 日常办公：AMD 本（NPU 后台推理，不影响工作）
   - 高质量需求：Intel 本（GPU 推理，速度和质量兼顾）

### 10.3 量化选择决策树

```
显存/内存占用 < 60%  →  Q6_K 或 Q8_0（质量优先）
显存/内存占用 60-80% →  Q5_K_M（最佳甜点）
显存/内存占用 80-95% →  Q4_K_M（主流选择）
显存/内存占用 > 95%  →  换更小模型或 Q3_K_M
完全装不下          →  CPU 卸载（慢）或换小模型
```

---

## 附录 A：Qwen3 全系列模型参数

| 模型 | 参数量 | 类型 | 层数 | hidden_size | 注意力头 | KV头 | 最大上下文 |
|------|--------|------|------|-------------|---------|------|-----------|
| Qwen3-0.6B | 0.6B | Dense | 28 | 1024 | 16 | 8 | 40K |
| Qwen3-1.7B | 1.7B | Dense | 28 | 2048 | 16 | 8 | 40K |
| Qwen3-4B | 4B | Dense | 36 | 2560 | 20 | 4 | 40K |
| Qwen3-8B | 8B | Dense | 36 | 4096 | 32 | 8 | 40K |
| Qwen3-14B | 14B | Dense | 40 | 5120 | 40 | 8 | 40K |
| Qwen3-32B | 32B | Dense | 64 | 5120 | 40 | 8 | 40K |
| Qwen3-30B-A3B | 30B | MoE | 48 | 2048 | 32 | 4 | 40K |
| Qwen3-235B-A22B | 235B | MoE | 94 | 4096 | 64 | 8 | 40K |

## 附录 B：术语表

| 术语 | 英文 | 一句话解释 |
|------|------|-----------|
| 权重 | Weights | 模型的"记忆"，训练得到的数字矩阵 |
| 量化 | Quantization | 压缩权重精度以节省内存（FP16→INT4） |
| KV Cache | Key-Value Cache | 推理时的"草稿纸"，缓存中间结果 |
| 注意力 | Attention | 模型判断输入中哪些词最重要的机制 |
| GQA | Grouped Query Attention | 多个注意力头共享 KV 头，省内存 |
| MoE | Mixture of Experts | 多个专家子网络，每个 token 只激活部分 |
| RoPE | Rotary Position Embedding | 旋转位置编码，让模型知道词序 |
| TTFT | Time To First Token | 首个令牌延迟，用户等待时间 |
| tok/s | Tokens per Second | 每秒生成 token 数，推理速度指标 |
| Prefill | Prefill | 处理输入 prompt 的阶段 |
| Decoding | Decoding | 逐 token 生成的阶段 |
| TOPS | Tera Operations Per Second | 每秒万亿次操作，AI 算力单位 |
| UMA | Unified Memory Architecture | 统一内存架构（核显共享系统内存） |

---

---

## 11. LLM 训练全流程科普

> 从"一张白纸"到"能用的 AI 助手"，模型经历了什么？

#### 📊 图表 11-1：LLM 训练五阶段

> **TL;DR**：训练一个 AI 就像培养一个学生：预训练=读万卷书，指令微调=学会沟通，SFT=专业实习，对齐训练=学会做人，蒸馏=老教师带新教师。

<details>
<summary>🖼️ 点击展开图表</summary>

<svg viewBox="0 0 680 520" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#667eea"/><stop offset="100%" stop-color="#764ba2"/></linearGradient>
    <linearGradient id="g2" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#f093fb"/><stop offset="100%" stop-color="#f5576c"/></linearGradient>
    <linearGradient id="g3" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#4facfe"/><stop offset="100%" stop-color="#00f2fe"/></linearGradient>
    <linearGradient id="g4" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#43e97b"/><stop offset="100%" stop-color="#38f9d7"/></linearGradient>
    <linearGradient id="g5" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#fa709a"/><stop offset="100%" stop-color="#fee140"/></linearGradient>
    <filter id="sh"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-opacity="0.15"/></filter>
  </defs>
  <rect width="680" height="520" fill="#f8f9fc" rx="12"/>
  
  <!-- Title -->
  <text x="340" y="35" text-anchor="middle" font-size="18" font-weight="bold" fill="#1a1a2e">LLM 训练五阶段：从"白纸"到"AI 助手"</text>
  <text x="340" y="55" text-anchor="middle" font-size="11" fill="#888">每个阶段都在教模型新技能 🎓</text>

  <!-- Stage 1: Pre-training -->
  <rect x="30" y="75" width="200" height="130" rx="10" fill="white" filter="url(#sh)"/>
  <rect x="30" y="75" width="200" height="30" rx="10" fill="url(#g1)"/>
  <rect x="30" y="95" width="200" height="10" fill="url(#g1)"/>
  <text x="130" y="96" text-anchor="middle" font-size="12" font-weight="bold" fill="white">📚 预训练 Pre-training</text>
  <text x="45" y="125" font-size="10" fill="#555">📖 让模型读万亿字的书</text>
  <text x="45" y="142" font-size="10" fill="#555">🎯 学会"预测下一个词"</text>
  <text x="45" y="159" font-size="10" fill="#555">⏱ 数月 × 数千张 GPU</text>
  <text x="45" y="176" font-size="10" fill="#555">📦 产出：基础模型</text>
  <text x="45" y="193" font-size="9" fill="#e74c3c">⚠ 但不会对话、不安全</text>

  <!-- Stage 2: Instruction Tuning -->
  <rect x="240" y="75" width="200" height="130" rx="10" fill="white" filter="url(#sh)"/>
  <rect x="240" y="75" width="200" height="30" rx="10" fill="url(#g2)"/>
  <rect x="240" y="95" width="200" height="10" fill="url(#g2)"/>
  <text x="340" y="96" text-anchor="middle" font-size="12" font-weight="bold" fill="white">🗣 指令微调 Instruction Tuning</text>
  <text x="255" y="125" font-size="10" fill="#555">🎯 学会听懂人类指令</text>
  <text x="255" y="142" font-size="10" fill="#555">💡 "翻译成法语"→ 回答不再续写</text>
  <text x="255" y="159" font-size="10" fill="#555">📊 数万条指令-回答对</text>
  <text x="255" y="176" font-size="10" fill="#555">📦 产出：会对话的模型</text>
  <text x="255" y="193" font-size="9" fill="#e67e22">⚠ 但回答不够安全/偏好</text>

  <!-- Stage 3: SFT -->
  <rect x="450" y="75" width="200" height="130" rx="10" fill="white" filter="url(#sh)"/>
  <rect x="450" y="75" width="200" height="30" rx="10" fill="url(#g3)"/>
  <rect x="450" y="95" width="200" height="10" fill="url(#g3)"/>
  <text x="550" y="96" text-anchor="middle" font-size="12" font-weight="bold" fill="white">🔧 监督微调 SFT</text>
  <text x="465" y="125" font-size="10" fill="#555">🎯 学会干具体活儿</text>
  <text x="465" y="142" font-size="10" fill="#555">💡 法律/医疗/代码等专业任务</text>
  <text x="465" y="159" font-size="10" fill="#555">📊 数千条标注数据</text>
  <text x="465" y="176" font-size="10" fill="#555">🛠 方法：全量微调/LoRA/QLoRA</text>
  <text x="465" y="193" font-size="9" fill="#27ae60">✅ 这是你自己能做的阶段！</text>

  <!-- Arrow 1→2 -->
  <path d="M230,140 L240,140" stroke="#667eea" stroke-width="2" marker-end="url(#arrow1)"/>
  <!-- Arrow 2→3 -->
  <path d="M440,140 L450,140" stroke="#f5576c" stroke-width="2"/>

  <!-- Stage 4: RLHF/DPO -->
  <rect x="130" y="230" width="200" height="130" rx="10" fill="white" filter="url(#sh)"/>
  <rect x="130" y="230" width="200" height="30" rx="10" fill="url(#g4)"/>
  <rect x="130" y="250" width="200" height="10" fill="url(#g4)"/>
  <text x="230" y="251" text-anchor="middle" font-size="12" font-weight="bold" fill="white">⚖ 对齐训练 RLHF / DPO</text>
  <text x="145" y="280" font-size="10" fill="#555">🎯 学会"做人"——安全+偏好</text>
  <text x="145" y="297" font-size="10" fill="#555">RLHF: 人类排序 → 奖励模型 → RL</text>
  <text x="145" y="314" font-size="10" fill="#555">DPO: 直接用偏好对训练（更简单）</text>
  <text x="145" y="331" font-size="10" fill="#555">📊 数万条人类偏好数据</text>
  <text x="145" y="348" font-size="9" fill="#27ae60">✅ 当前主流：DPO（开源社区）</text>

  <!-- Stage 5: Distillation -->
  <rect x="350" y="230" width="200" height="130" rx="10" fill="white" filter="url(#sh)"/>
  <rect x="350" y="230" width="200" height="30" rx="10" fill="url(#g5)"/>
  <rect x="350" y="250" width="200" height="10" fill="url(#g5)"/>
  <text x="450" y="251" text-anchor="middle" font-size="12" font-weight="bold" fill="white">🧪 蒸馏 Distillation</text>
  <text x="365" y="280" font-size="10" fill="#555">🎯 大模型教小模型</text>
  <text x="365" y="297" font-size="10" fill="#555">教师(GPT-4) → 学生(Qwen3-8B)</text>
  <text x="365" y="314" font-size="10" fill="#555">📦 压缩10-100倍，保留95%准确率</text>
  <text x="365" y="331" font-size="10" fill="#555">🔑 关键：学推理过程，不只是答案</text>
  <text x="365" y="348" font-size="9" fill="#27ae60">✅ 可选阶段，适合部署到小设备</text>

  <!-- Arrows down -->
  <path d="M340,205 L340,215 L230,215 L230,230" stroke="#4facfe" stroke-width="2" fill="none"/>
  <path d="M340,205 L340,215 L450,215 L450,230" stroke="#4facfe" stroke-width="2" fill="none"/>

  <!-- Bottom: Training analogy -->
  <rect x="30" y="385" width="620" height="120" rx="10" fill="#eef2ff" stroke="#c7d2fe" stroke-width="1"/>
  <text x="340" y="410" text-anchor="middle" font-size="13" font-weight="bold" fill="#4338ca">🎓 类比：训练一个 AI 就像培养一个学生</text>
  
  <text x="55" y="435" font-size="10" fill="#555">📚 <tspan font-weight="bold">预训练</tspan> = 读万卷书（什么都学）</text>
  <text x="55" y="455" font-size="10" fill="#555">🗣 <tspan font-weight="bold">指令微调</tspan> = 学会沟通（听懂问题）</text>
  <text x="55" y="475" font-size="10" fill="#555">🔧 <tspan font-weight="bold">SFT</tspan> = 专业实习（学会干活）</text>
  <text x="55" y="495" font-size="10" fill="#555">⚖ <tspan font-weight="bold">对齐训练</tspan> = 社会规范（学会做人）</text>
  
  <text x="390" y="435" font-size="10" fill="#555">🧪 <tspan font-weight="bold">蒸馏</tspan> = 老教师带新教师（传授经验）</text>
  <text x="390" y="455" font-size="10" fill="#555">🔑 <tspan font-weight="bold">LoRA</tspan> = 贴便签（不涂改原书）</text>
  <text x="390" y="475" font-size="10" fill="#555">🔑 <tspan font-weight="bold">QLoRA</tspan> = 袖珍版+便签（双重压缩）</text>
  <text x="390" y="495" font-size="10" fill="#555">🔑 <tspan font-weight="bold">全量微调</tspan> = 全部擦掉重写（最彻底）</text>
</svg>

</details>

### 11.1 训练五阶段总览

```
预训练(Pre-training) → 指令微调(Instruction Tuning) → 监督微调(SFT) → 对齐训练(RLHF/DPO) → 蒸馏(Distillation, 可选)
   ↓                        ↓                           ↓                  ↓                        ↓
 基础模型              会听指令了                   会干具体活了         安全+偏好对齐           压缩到小设备
 "读万卷书"            "学会沟通"                   "学会干活"           "学会做人"              "传授给徒弟"
```

### 11.2 第一阶段：预训练 (Pre-training)

**类比**：让一个学生读了万亿字的书（网页、书籍、代码、论文……），什么都知道一点，但不会对话。

**技术原理**：
- 核心机制是 **下一个词预测 (Next Token Prediction)**
- 给模型一段文字的前半段，让它预测下一个字
- 预测对了就奖励（降低 loss），错了就修正
- 重复数十亿次，模型逐渐"理解"语言的规律

**示例**：
```
输入：The sky is → 模型学习预测 "blue"
输入：1+1= → 模型学习预测 "2"
输入：def hello(): → 模型学习预测 "print"
```

**产出**：基础模型 (Base Model)

**基础模型的局限**：
- ❌ 不会遵循指令（你让它翻译，它可能续写文章）
- ❌ 不擅长对话（回答冗长混乱）
- ❌ 不安全（可能输出有害内容）

**类比总结**：预训练 = 一个读了一辈子书但不会社交的学者。什么都懂，但不会跟人聊天。

> ** Glossary **：
> - **Loss（损失）**：衡量模型预测与正确答案差距的指标，越小越好
> - **权重更新**：训练过程中调整模型参数，让预测更准确
> - **Token**：模型处理文本的最小单位，一个中文字≈1-2个 token，一个英文单词≈1-3个 token

### 11.3 第二阶段：指令微调 (Instruction Tuning)

**类比**：教这个"书呆子学者"怎么跟人交流——别人问问题，你要回答，而不是接着写文章。

**原理**：用"指令→回答"格式的数据集训练模型。

| 训练前（基础模型） | 训练后（指令微调） |
|------------------|------------------|
| 输入："翻译成法语" | 输入："翻译成法语" |
| 输出："翻译成法语是一个常见的 NLP 任务……"（续写） | 输出："Bonjour."（正确翻译） |

**数据格式**：
```
指令："请总结以下文章"
输入：[一篇文章]
输出：[高质量摘要]
```

**指令微调 vs SFT**：指令微调是 SFT 的**一种特定类型**，专注于"听懂人类指令"和"对话行为"。SFT 范围更广，还包括法律分析、医疗分类等专业任务适配。

### 11.4 第三阶段：监督微调 (SFT, Supervised Fine-Tuning)

**类比**：给学者安排实习——在真实工作场景中，有人教你怎么做。

**原理**：在有标注的数据上训练模型，格式为 `输入 → 正确输出`。模型学习模仿"标准答案"。

**不同微调方法对比**：

| 方法 | 全称 | 原理 | 显存需求(7B) | 效果 |
|------|------|------|-------------|------|
| **全量微调** | Full Fine-Tuning | 更新模型的**全部参数** | ~60 GB | 最佳 |
| **LoRA** | Low-Rank Adaptation | 只更新**低秩矩阵**（0.1-1%参数） | ~16 GB | 优秀 |
| **QLoRA** | Quantized LoRA | 先量化到 4-bit 再加 LoRA | ~6 GB | 优秀 |

> **LoRA 的核心思想**：微调时权重的变化可以用两个小矩阵相乘来近似（ΔW = A × B），其中 A 和 B 远小于原始权重矩阵。好比你想微调一幅画——不用重新画，只贴几张小贴纸就行。

**LoRA 关键参数**：

| 参数 | 推荐值 | 含义 |
|------|--------|------|
| `lora_r` | 8-64 | 低秩矩阵的秩，越大适配能力越强但越占内存 |
| `lora_alpha` | 2 × r | 学习率缩放因子，通常设为 r 的 2 倍 |
| `learning_rate` | 2e-4 | 学习率，太大容易震荡，太小训练太慢 |

**数据量需求**：

| 任务复杂度 | 需要数据量 | 举例 |
|-----------|-----------|------|
| 简单风格迁移 | 100-500 条 | 让模型用特定语气说话 |
| 中等任务 | 1000-5000 条 | 特定格式输出 |
| 复杂领域知识 | 5000-10000 条 | 法律、医疗等专业场景 |

### 11.5 第四阶段：对齐训练 (RLHF / DPO)

**类比**：学者实习结束后，开始接受"人类评价"——不仅要求答案正确，还要求"人类喜欢"。

#### RLHF (Reinforcement Learning from Human Feedback)

**流程**：
```
1. 人类对同一个问题的多个回答进行排序（好 > 差）
2. 训练一个"奖励模型"学习人类的偏好
3. 用强化学习让 LLM 优化自己的输出，争取更高奖励
```

**问题**：RL 本身不稳定，容易"奖励作弊"（模型找到漏洞刷高分但输出垃圾）。

#### DPO (Direct Preference Optimization)

**更简单的替代方案**：
```
直接在"偏好对"上训练：首选回答 > 被拒回答
不需要奖励模型，不需要强化学习，一步到位
```

| 对比 | RLHF | DPO |
|------|------|-----|
| 复杂度 | 高（两步训练） | 低（一步训练） |
| 稳定性 | 不稳定 | 稳定 |
| 灵活性 | 高级优化更强 | 高级场景稍弱 |
| **当前趋势** | 大厂用 | **开源社区主流** |

### 11.6 第五阶段：知识蒸馏 (Distillation, 可选)

详见[下一节](#12-教师模型与学生模型知识蒸馏)。

---

## 12. 教师模型与学生模型（知识蒸馏）

### 12.1 核心概念

> **一句话**：用"算力换智力"——让大模型（教师）出题+写答案，小模型（学生）从答案中学习。

| 角色 | 规模 | 成本 | 速度 | 用途 |
|------|------|------|------|------|
| **教师模型** (Teacher) | 庞大 (100B+) | 高（API 贵） | 慢 | 生成高质量推理过程 |
| **学生模型** (Student) | 紧凑 (<10B) | 低（可本地跑） | 快 | 实际部署使用 |

**典型案例**：
- 教师：GPT-4o / DeepSeek-R1（云端，API 调用）
- 学生：Qwen3-8B（本地，桌伴部署）

### 12.2 为什么需要蒸馏？

**能力涌现** (Emergent Abilities)：当模型规模达到某个阈值后，会突然展现出小模型完全不具备的复杂推理能力。但大模型太贵太慢，无法部署到本地。

蒸馏的核心价值：把大模型的"推理过程"显性化，让小模型通过学习这些过程来"模仿高智商的语言模式"。

**类比**：

| 学习方式 | 类比 | 效果 |
|---------|------|------|
| 传统训练 | 只有习题集和最终答案(A/B/C/D) | 死记硬背，改个数字就不行 |
| 知识蒸馏 | 找奥数金牌教练给出**详细解题步骤** | 真正学会推理方法 |

### 12.3 软标签 vs 硬标签

这是理解蒸馏的关键概念。

**硬标签**（传统训练）：
```
"我很饿" → 正确答案: "I am hungry" (100%)，其他: 0%
```
只告诉模型哪个对，不说为什么。

**软标签**（蒸馏训练）：
```
"我很饿" → 教师的高温输出:
  "I am hungry"  → 60%
  "I'm hungry"   → 25%
  "I'm starving" → 10%
  "I feel hungry"→ 5%
```
不仅告诉学生哪个对，还告诉"为什么其他选项也有道理"，以及"它们之间的语义距离"。

### 12.4 温度参数在蒸馏中的作用

| 场景 | 温度 | 效果 |
|------|------|------|
| **普通推理** | 0.6-1.0 | 模型输出比较确定 |
| **蒸馏训练** | **3.0-5.0** | 高温迫使教师输出更丰富的概率分布 |

高温就像让教师把"所有可能的想法都展示出来"，而不是只给一个最终答案。

### 12.5 蒸馏的三个 Level

| Level | 名称 | 学习内容 | 效果 | 推荐 |
|-------|------|----------|------|------|
| Level 1 | 结果蒸馏 | 只学 `<Answer>` | 复杂问题依然学不会 | ❌ |
| **Level 2** | **思维链蒸馏** | **学 `<思考过程 + Answer>`** | **显著提升推理能力** | **✅ 主流** |
| Level 3 | 过程奖励蒸馏 | 每步打分 + 强化学习 | 最强方案 | 🏆 进阶 |

### 12.6 蒸馏三步实操

**第一步：教师授课**
```
原始题目 → 教师模型 → 详细推理过程 + 答案
关键：Prompt 必须强制教师输出过程（用 <think/> 标签包裹）
```

**第二步：作业批改**
```
- 规则过滤：剔除过短、格式错误、拒答的样本
- 一致性校验：同一题让教师回答5次，保留多数一致的
- 教师自评：让教师给自己的推理过程打分，只保留高分
```
> **宁缺毋滥**：如果教师推理错了，学生就会学会"一本正经地胡说八道"。

**第三步：学生特训**
```
清洗后的高质量数据 → SFT 或 LoRA 微调学生模型
```

### 12.7 对桌伴的启示

桌伴当前用的是 Qwen3-8B 的官方预训练+对齐版本。如果未来需要让桌伴在特定领域（如网络安全方案编写）表现更好，可以考虑：

1. 用 GPT-4o 作为教师，生成高质量的方案写作推理过程
2. 用这些数据微调 Qwen3-8B（LoRA 方式，只需 6GB 显存）
3. 微调后的模型在特定任务上可以接近 GPT-4o 的水平

---

## 13. 全量微调 vs LoRA vs QLoRA 详解

#### 📊 图表 13-1：全量微调 vs LoRA vs QLoRA

> **TL;DR**：全量微调需68GB（跑不动），LoRA需18GB（勉强），QLoRA只需7GB——桌伴的笔记本就能做！QLoRA = 4bit量化 + LoRA便签，效果损失不到5%。

<details>
<summary>🖼️ 点击展开图表</summary>

<svg viewBox="0 0 680 420" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="full" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#e74c3c"/><stop offset="100%" stop-color="#c0392b"/></linearGradient>
    <linearGradient id="lora" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f39c12"/><stop offset="100%" stop-color="#e67e22"/></linearGradient>
    <linearGradient id="qlora" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#27ae60"/><stop offset="100%" stop-color="#2ecc71"/></linearGradient>
    <filter id="sh"><feDropShadow dx="0" dy="1" stdDeviation="3" flood-opacity="0.12"/></filter>
  </defs>
  <rect width="680" height="420" fill="#f8f9fc" rx="12"/>
  
  <text x="340" y="30" text-anchor="middle" font-size="16" font-weight="bold" fill="#1a1a2e">全量微调 vs LoRA vs QLoRA 显存对比（8B 模型）</text>
  <text x="340" y="48" text-anchor="middle" font-size="11" fill="#888">QLoRA 让你在笔记本上就能微调大模型！</text>

  <!-- Bar chart -->
  <!-- Y axis -->
  <line x1="80" y1="65" x2="80" y2="310" stroke="#ddd" stroke-width="1"/>
  <text x="40" y="188" text-anchor="middle" font-size="10" fill="#888" transform="rotate(-90,40,188)">显存 (GB)</text>
  
  <!-- Grid lines -->
  <line x1="80" y1="310" x2="640" y2="310" stroke="#eee" stroke-width="1"/>
  <line x1="80" y1="268" x2="640" y2="268" stroke="#f0f0f0" stroke-width="1" stroke-dasharray="4"/>
  <line x1="80" y1="226" x2="640" y2="226" stroke="#f0f0f0" stroke-width="1" stroke-dasharray="4"/>
  <line x1="80" y1="184" x2="640" y2="184" stroke="#f0f0f0" stroke-width="1" stroke-dasharray="4"/>
  <line x1="80" y1="142" x2="640" y2="142" stroke="#f0f0f0" stroke-width="1" stroke-dasharray="4"/>
  <line x1="80" y1="100" x2="640" y2="100" stroke="#f0f0f0" stroke-width="1" stroke-dasharray="4"/>
  
  <!-- Y labels -->
  <text x="72" y="314" text-anchor="end" font-size="10" fill="#888">0</text>
  <text x="72" y="272" text-anchor="end" font-size="10" fill="#888">10</text>
  <text x="72" y="230" text-anchor="end" font-size="10" fill="#888">20</text>
  <text x="72" y="188" text-anchor="end" font-size="10" fill="#888">40</text>
  <text x="72" y="146" text-anchor="end" font-size="10" fill="#888">50</text>
  <text x="72" y="104" text-anchor="end" font-size="10" fill="#888">70</text>

  <!-- Full Fine-tuning bar: 68 GB -->
  <rect x="140" y="100" width="100" height="210" rx="5" fill="url(#full)" filter="url(#sh)"/>
  <text x="190" y="90" text-anchor="middle" font-size="14" font-weight="bold" fill="#e74c3c">68 GB</text>
  <text x="190" y="330" text-anchor="middle" font-size="12" font-weight="bold" fill="#333">全量微调</text>
  <text x="190" y="345" text-anchor="middle" font-size="9" fill="#e74c3c">❌ 笔记本跑不动</text>

  <!-- LoRA bar: 18 GB -->
  <rect x="310" y="235" width="100" height="75" rx="5" fill="url(#lora)" filter="url(#sh)"/>
  <text x="360" y="225" text-anchor="middle" font-size="14" font-weight="bold" fill="#e67e22">18 GB</text>
  <text x="360" y="330" text-anchor="middle" font-size="12" font-weight="bold" fill="#333">LoRA</text>
  <text x="360" y="345" text-anchor="middle" font-size="9" fill="#e67e22">⚠ 32GB 勉强可以</text>

  <!-- QLoRA bar: 7 GB -->
  <rect x="480" y="281" width="100" height="29" rx="5" fill="url(#qlora)" filter="url(#sh)"/>
  <text x="530" y="275" text-anchor="middle" font-size="14" font-weight="bold" fill="#27ae60">7 GB</text>
  <text x="530" y="330" text-anchor="middle" font-size="12" font-weight="bold" fill="#333">QLoRA</text>
  <text x="530" y="345" text-anchor="middle" font-size="9" fill="#27ae60">✅ 笔记本轻松跑！</text>

  <!-- Reduction arrows -->
  <path d="M250,200 C280,200 280,250 300,250" stroke="#e67e22" stroke-width="1.5" fill="none" stroke-dasharray="3"/>
  <text x="290" y="218" font-size="9" fill="#e67e22" transform="rotate(-40,290,218)">↓73%</text>
  
  <path d="M420,270 C440,270 440,285 460,285" stroke="#27ae60" stroke-width="1.5" fill="none" stroke-dasharray="3"/>
  <text x="445" y="268" font-size="9" fill="#27ae60" transform="rotate(-15,445,268)">↓61%</text>

  <!-- Bottom info box -->
  <rect x="30" y="365" width="620" height="45" rx="8" fill="#e8f5e9" stroke="#a5d6a7"/>
  <text x="340" y="383" text-anchor="middle" font-size="10" fill="#2e7d32">💡 QLoRA = 4-bit量化 + LoRA贴便签 → 显存从68GB降到7GB，效果损失 &lt;5%</text>
  <text x="340" y="400" text-anchor="middle" font-size="10" fill="#2e7d32">🔧 桌伴的 Ultra 7 155H 有 32GB 内存 → 用 QLoRA 微调 8B 模型完全可行！</text>
</svg>

</details>

### 13.1 三种方法核心原理

#### 全量微调 (Full Fine-Tuning)

**原理**：更新模型的所有参数。

**类比**：把一本书全部擦掉重写。效果最好，但代价巨大。

| 维度 | 数据 |
|------|------|
| 可训练参数 | 100% |
| 7B 模型显存 | **~60 GB** |
| 效果 | 最佳 |
| 风险 | 容易过拟合（学了新知识忘了旧知识） |
| 存储 | 每个任务需要一份完整模型 |

#### LoRA (Low-Rank Adaptation)

**原理**：冻结原始权重，只训练两个低秩矩阵 A 和 B。`新权重 = 原始权重 + A × B`

**类比**：不在原书上涂改，而是在书页上贴便签。便签比书小得多，但足够记录需要修改的内容。

```
原始权重 W: (4096 × 4096) = 16M 参数（冻结不动）
LoRA 矩阵 A: (4096 × 16) = 65K 参数（训练）
LoRA 矩阵 B: (16 × 4096) = 65K 参数（训练）
→ 只训练 130K 参数 vs 原始 16M，节省 99%+
```

| 维度 | 数据 |
|------|------|
| 可训练参数 | 0.1-1% |
| 7B 模型显存 | **~16 GB** |
| 效果 | 优秀（接近全量微调的 95%+） |
| 存储 | 每个 LoRA 适配器只有几 MB |
| 推理延迟 | 可合并到原模型，零额外延迟 |

#### QLoRA (Quantized LoRA)

**原理**：先把模型量化到 4-bit，然后在量化模型上添加 LoRA。

**类比**：先把书缩印成袖珍版（量化），再贴便签（LoRA）。双重压缩。

| 维度 | 数据 |
|------|------|
| 可训练参数 | 0.1-1% |
| 7B 模型显存 | **~6 GB** |
| 效果 | 优秀 |
| 关键技术 | NF4 数据类型 + 双重量化 + 分页优化器 |

### 13.2 显存需求对比（关键数字）

| 方法 | 7B 模型 | 8B 模型 | 效果 |
|------|--------|--------|------|
| 全量微调 FP16 | ~60 GB | ~68 GB | 最佳 |
| LoRA FP16 | ~16 GB | ~18 GB | 优秀 |
| **QLoRA 4-bit** | **~6 GB** | **~7 GB** | **优秀** |

> **关键结论**：QLoRA 让 7-8B 模型的微调只需要 6-7 GB 显存——在 Ultra 7 155H 的核显上就能做！

### 13.3 桌伴场景下的微调可行性

| 维度 | 评估 |
|------|------|
| 硬件 | ✅ 32GB 内存，QLoRA 只需 ~7GB |
| 数据 | ⚠️ 需要准备 500-5000 条高质量问答对 |
| 时间 | ⚠️ 8B 模型 LoRA 训练约 2-6 小时（取决于数据量） |
| 工具 | ✅ LLaMA Factory / Unsloth（开源，有 GUI） |
| 收益 | 🎯 在特定领域（如方案编写）质量可显著提升 |

### 13.4 微调 vs RAG vs 提示工程

| 维度 | 提示工程 | RAG（检索增强） | 微调 |
|------|---------|---------------|------|
| **实现成本** | 低 | 中 | 高 |
| **知识更新** | 即时 | 即时 | 需重新训练 |
| **私有数据** | 有泄露风险 | 安全 | 安全 |
| **定制深度** | 浅 | 中 | 深 |
| **桌伴当前** | ✅ 已用 | ✅ 已用（KB文库） | ❌ 未用（可探索） |

---

## 14. Qwen3.5 升级可行性分析

> 桌伴当前用 Qwen3-8B，Qwen3.5 已经发布。要不要升级？

#### 📊 图表 14-1：Qwen3→Qwen3.5 升级评估

> **TL;DR**：升级好处很多（智能+20%、上下文6x、Agent+56%），但 OpenVINO 不支持 GDN 算子是硬伤。建议等 3-6 个月 Intel 官方适配后再切换。

<details>
<summary>🖼️ 点击展开图表</summary>

<svg viewBox="0 0 680 480" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="sh"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-opacity="0.12"/></filter>
  </defs>
  <rect width="680" height="480" fill="#f8f9fc" rx="12"/>
  
  <text x="340" y="30" text-anchor="middle" font-size="16" font-weight="bold" fill="#1a1a2e">Qwen3 → Qwen3.5 升级可行性评估</text>
  <text x="340" y="48" text-anchor="middle" font-size="11" fill="#888">Ultra 7 155H + 32GB 内存 | 当前：Qwen3-8B INT4 @ OpenVINO</text>

  <!-- Left: What's better -->
  <rect x="20" y="65" width="320" height="200" rx="10" fill="white" filter="url(#sh)"/>
  <rect x="20" y="65" width="320" height="28" rx="10" fill="#27ae60"/>
  <rect x="20" y="83" width="320" height="10" fill="#27ae60"/>
  <text x="180" y="84" text-anchor="middle" font-size="12" font-weight="bold" fill="white">✅ 升级的好处</text>
  
  <text x="35" y="110" font-size="10" fill="#555">🧠 <tspan font-weight="bold">智能+15-20%</tspan>：9B 击败上代 120B 模型</text>
  <text x="35" y="130" font-size="10" fill="#555">📐 <tspan font-weight="bold">上下文 6×</tspan>：40K → 256K（百万字文档）</text>
  <text x="35" y="150" font-size="10" fill="#555">💾 <tspan font-weight="bold">KV Cache 更省</tspan>：GDN 让长对话内存恒定</text>
  <text x="35" y="170" font-size="10" fill="#555">🤖 <tspan font-weight="bold">Agent+56%</tspan>：工具调用、函数调用大提升</text>
  <text x="35" y="190" font-size="10" fill="#555">🌍 <tspan font-weight="bold">201种语言</tspan>：词表扩大 67%</text>
  <text x="35" y="210" font-size="10" fill="#555">📦 <tspan font-weight="bold">体积相近</tspan>：9B INT4 ≈ 5.5GB（vs 8B 的 5.8GB）</text>
  <text x="35" y="230" font-size="10" fill="#555">⚡ <tspan font-weight="bold">GDN 线性注意力</tspan>：256K 上下文 19× 更快</text>
  <text x="35" y="250" font-size="10" fill="#555">🎥 <tspan font-weight="bold">原生多模态</tspan>：Early Fusion，不再外挂</text>

  <!-- Right: What's blocking -->
  <rect x="360" y="65" width="300" height="200" rx="10" fill="white" filter="url(#sh)"/>
  <rect x="360" y="65" width="300" height="28" rx="10" fill="#e74c3c"/>
  <rect x="360" y="83" width="300" height="10" fill="#e74c3c"/>
  <text x="510" y="84" text-anchor="middle" font-size="12" font-weight="bold" fill="white">🚧 升级的障碍</text>
  
  <text x="375" y="110" font-size="10" fill="#555">🔴 <tspan font-weight="bold">OpenVINO 不支持 GDN</tspan></text>
  <text x="390" y="128" font-size="9" fill="#888">GDN 是全新算子，需要框架专门适配</text>
  <text x="375" y="148" font-size="10" fill="#555">🟡 <tspan font-weight="bold">Intel 官方适配未公布</tspan></text>
  <text x="390" y="166" font-size="9" fill="#888">Qwen3 是 Day0 适配，Qwen3.5 暂无公告</text>
  <text x="375" y="186" font-size="10" fill="#555">🟡 <tspan font-weight="bold">框架切换成本高</tspan></text>
  <text x="390" y="204" font-size="9" fill="#888">切 llama.cpp 需改造桌伴推理引擎</text>
  <text x="375" y="224" font-size="10" fill="#555">🟡 <tspan font-weight="bold">Patch 12 刚完成</tspan></text>
  <text x="390" y="242" font-size="9" fill="#888">需要先稳定运行，不宜大改</text>
  <text x="375" y="256" font-size="9" fill="#888">MoE 版本（35B-A3B）也需验证兼容性</text>

  <!-- Bottom: Upgrade Path -->
  <rect x="20" y="280" width="640" height="185" rx="10" fill="white" filter="url(#sh)"/>
  <rect x="20" y="280" width="640" height="28" rx="10" fill="#4338ca"/>
  <rect x="20" y="298" width="640" height="10" fill="#4338ca"/>
  <text x="340" y="299" text-anchor="middle" font-size="12" font-weight="bold" fill="white">🗺 推荐升级路径</text>

  <!-- Timeline -->
  <line x1="50" y1="345" x2="630" y2="345" stroke="#ddd" stroke-width="3"/>
  
  <!-- Now -->
  <circle cx="80" cy="345" r="12" fill="#27ae60"/>
  <text x="80" y="349" text-anchor="middle" font-size="9" font-weight="bold" fill="white">现在</text>
  <text x="80" y="330" text-anchor="middle" font-size="9" font-weight="bold" fill="#27ae60">P0 稳定</text>
  <text x="80" y="370" text-anchor="middle" font-size="8" fill="#555">Qwen3-8B INT4</text>
  <text x="80" y="382" text-anchor="middle" font-size="8" fill="#555">OpenVINO @ GPU</text>
  <text x="80" y="394" text-anchor="middle" font-size="8" fill="#27ae60">~13 tok/s ✅</text>
  
  <!-- +1-2 months -->
  <circle cx="250" cy="345" r="12" fill="#f39c12"/>
  <text x="250" y="349" text-anchor="middle" font-size="9" font-weight="bold" fill="white">1-2月</text>
  <text x="250" y="330" text-anchor="middle" font-size="9" font-weight="bold" fill="#f39c12">P2 测试</text>
  <text x="250" y="370" text-anchor="middle" font-size="8" fill="#555">Qwen3.5-9B GGUF</text>
  <text x="250" y="382" text-anchor="middle" font-size="8" fill="#555">llama.cpp 测试</text>
  <text x="250" y="394" text-anchor="middle" font-size="8" fill="#f39c12">可行性验证</text>
  
  <!-- +3-6 months -->
  <circle cx="420" cy="345" r="12" fill="#4facfe"/>
  <text x="420" y="349" text-anchor="middle" font-size="9" font-weight="bold" fill="white">3-6月</text>
  <text x="420" y="330" text-anchor="middle" font-size="9" font-weight="bold" fill="#4facfe">P3 升级</text>
  <text x="420" y="370" text-anchor="middle" font-size="8" fill="#555">Qwen3.5-9B INT4</text>
  <text x="420" y="382" text-anchor="middle" font-size="8" fill="#555">等 OpenVINO 适配</text>
  <text x="420" y="394" text-anchor="middle" font-size="8" fill="#4facfe">~12-15 tok/s</text>
  
  <!-- +6-12 months -->
  <circle cx="580" cy="345" r="12" fill="#764ba2"/>
  <text x="580" y="349" text-anchor="middle" font-size="9" font-weight="bold" fill="white">6-12月</text>
  <text x="580" y="330" text-anchor="middle" font-size="9" font-weight="bold" fill="#764ba2">未来</text>
  <text x="580" y="370" text-anchor="middle" font-size="8" fill="#555">桌伴 v0.9/v1.0</text>
  <text x="580" y="382" text-anchor="middle" font-size="8" fill="#555">Qwen3.5 或更新</text>
  <text x="580" y="394" text-anchor="middle" font-size="8" fill="#764ba2">多模态+Agent</text>

  <!-- Bottom verdict -->
  <rect x="40" y="415" width="600" height="40" rx="8" fill="#e8f5e9" stroke="#a5d6a7"/>
  <text x="340" y="432" text-anchor="middle" font-size="11" font-weight="bold" fill="#2e7d32">结论：不建议立即升级，等 OpenVINO 官方适配 Qwen3.5 后再切换</text>
  <text x="340" y="448" text-anchor="middle" font-size="9" fill="#555">当前 Qwen3-8B 对办公助手够用，优先确保 Patch 12 稳定运行</text>
</svg>

</details>

### 14.1 Qwen3.5 核心升级概览

| 维度 | Qwen3 (2025) | Qwen3.5 (2026) |
|------|-------------|----------------|
| **注意力机制** | 标准 GQA | **Gated Delta Networks (GDN)** 替代 75% 层 |
| **上下文长度** | 40K → 256K | **256K → 1M tokens** |
| **词表大小** | 151K | **250K (+67%)** |
| **多模态** | 外挂视觉编码器 | **Early Fusion 原生多模态** |
| **KV Cache** | 标准 GQA (25%) | **极端 GQA 16:1 (6.25%)** |
| **Agent 能力** | 基础工具调用 | **原生智能体架构** |
| **语言支持** | 主要语言 | **201 种文本 / 113 种语音** |

### 14.2 Gated Delta Networks (GDN) 详解

> **Glossary**：GDN 是 NeurIPS 2025 最佳论文提出的新型注意力机制，属于**线性注意力**的变体。

**传统注意力 vs GDN**：

| 维度 | 传统 Softmax Attention | Gated Delta Networks |
|------|----------------------|---------------------|
| 计算复杂度 | O(n²)（平方增长） | **O(n)（线性增长）** |
| KV Cache | 随上下文线性增长 | **恒定大小** |
| 长文本性能 | 逐渐退化 | **无性能衰减** |
| 实测吞吐(256K) | 基线 | **19× 更快** |

**Qwen3.5 的混合排列**：
- 75% 的层使用 GDN（高效处理长文本）
- 25% 的层保留标准注意力（保证关键位置的全局理解）
- 排列方式：4 层 GDN : 1 层标准注意力（4:1 交替）

**对桌伴的影响**：
- ✅ 长上下文处理能力大幅提升（256K→1M，约百万字）
- ✅ KV Cache 大小恒定，长对话不爆内存
- ⚠️ GDN 是全新的架构组件，推理框架需要专门适配

### 14.3 Qwen3.5 全系列模型规格

| 模型 | 总参数 | 激活参数 | 架构 | INT4 体积 | 32GB 可跑？ |
|------|--------|----------|------|----------|------------|
| Qwen3.5-0.8B | 0.8B | 0.8B | Dense | ~0.5 GB | ✅ 轻松 |
| Qwen3.5-2B | 2B | 2B | Dense | ~1.2 GB | ✅ 轻松 |
| **Qwen3.5-4B** | **4B** | **4B** | **Dense** | **~2.5 GB** | **✅ 推荐** |
| **Qwen3.5-9B** | **9B** | **9B** | **Dense** | **~5.5 GB** | **✅ 最佳甜点** |
| Qwen3.5-14B | 14B | 14B | Dense | ~8 GB | ⚠️ 勉强 |
| Qwen3.5-27B | 27B | 27B | Dense | ~15 GB | ❌ 太大 |
| **Qwen3.5-35B-A3B** | 35B | **3B** | MoE+GDN | ~20 GB | ⚠️ 能跑但紧 |
| Qwen3.5-122B-A10B | 122B | 10B | MoE+GDN | ~70 GB | ❌ |
| Qwen3.5-397B-A17B | 397B | 17B | MoE | ~230 GB | ❌ |

**桌伴关注点**：Qwen3.5-9B 是 8B 的升级版，INT4 约 5.5 GB，内存预算完全没问题。

### 14.4 Qwen3.5 性能提升数据

| 对比维度 | Qwen3-8B | Qwen3.5-9B | 提升 |
|---------|----------|------------|------|
| 通用推理 | 基线 | +15-20% | 显著 |
| Agent/工具调用 | 基线 | **+56%** (BFCL-V4) | 巨大 |
| 指令跟随 | 基线 | +10% | 明显 |
| 函数调用 | 基线 | +55% | 巨大 |
| 上下文窗口 | 40K | **256K-1M** | **6-25×** |
| KV Cache 效率 | 标准 | 恒定(GDN) | 19× 吞吐 |

> **关键结论**：Qwen3.5-9B 在推理基准上击败上一代 120B 模型（GPQA: 81.7 vs 71.5），相当于用 1/13 的参数量达到了更高的智能水平。

### 14.5 ⚠️ OpenVINO 兼容性评估

**这是最关键的问题**——桌伴用 OpenVINO 跑模型，Qwen3.5 的 GDN 架构能不能用？

| 评估维度 | 现状 | 风险等级 |
|---------|------|---------|
| GDN 算子支持 | ❌ OpenVINO 未明确支持 GDN | 🔴 **高** |
| MoE 算子支持 | ⚠️ OpenVINO 对 MoE 支持有限 | 🟡 中 |
| Dense 模型（9B/4B） | ⚠️ 需要验证 GDN 层的兼容性 | 🟡 中 |
| Intel 官方适配 | ⚠️ Intel 曾 Day0 适配 Qwen3，但 Qwen3.5 暂无公告 | 🟡 中 |

**兼容性路径分析**：

```
方案 A：等待 OpenVINO 官方适配
├── 可能时间：3-6 个月（Intel 通常在模型发布后数月适配）
├── 成功率：高（Intel 与阿里有合作关系）
└── 优点：最稳妥，性能优化最好

方案 B：使用 llama.cpp (GGUF 格式)
├── 可行性：✅ 已有 Unsloth 的 GGUF 量化版本
├── 推理速度：CPU/GPU 混合推理，可能比 OpenVINO 慢
├── 集成难度：中（需要改造桌伴的推理引擎）
└── 优点：立即可用

方案 C：只用 Qwen3.5 的 Dense 层（跳过 GDN）
├── 可行性：⚠️ 不确定（GDN 是核心架构组件）
├── 效果：可能大幅降低模型质量
└── 不推荐

方案 D：混合方案
├── Qwen3.5-9B GGUF @ llama.cpp 用于文本生成
├── 保持 OpenVINO + Qwen3-8B 用于 KB 嵌入/重排序
└── 两套推理引擎并存
```

### 14.6 Qwen3.5-9B 在 Ultra 7 155H 上的预估性能

基于 Qwen3-8B 的实测数据和 Qwen3.5 的架构变化：

| 指标 | Qwen3-8B INT4 (当前) | Qwen3.5-9B INT4 (预估) | 变化 |
|------|---------------------|----------------------|------|
| 权重大小 | 5.8 GB | ~5.5 GB（GDN 层更轻量） | 持平 |
| KV Cache (4K) | ~0.56 GB | ~0.35 GB（16:1 GQA） | **↓38%** |
| 总内存占用 | ~7-8 GB | ~6-7 GB | 持平或更好 |
| Decoding 速度 | ~13 tok/s | ~12-15 tok/s | 持平或更快 |
| TTFT | <1s | <1s | 持平 |
| 上下文上限 | 40K | **256K** | **6×** |
| 智能水平 | 基线 | **+15-20%** | **显著提升** |

> **关键洞察**：得益于 GDN 和更极端的 GQA，Qwen3.5-9B 的**实际内存占用可能比 Qwen3-8B 还小**，同时智能水平显著提升。

### 14.7 升级建议

| 优先级 | 行动 | 时间线 |
|--------|------|--------|
| **P0** | 保持 Qwen3-8B 不动，桌伴 Patch 12 先稳定运行 | 现在 |
| **P1** | 跟踪 OpenVINO 对 Qwen3.5 的适配进度 | 持续关注 |
| **P2** | 测试 Qwen3.5-9B GGUF + llama.cpp 的集成可行性 | 1-2 个月内 |
| **P3** | 等 OpenVINO 正式支持后升级到 Qwen3.5-9B | 3-6 个月 |

**不建议立即升级的原因**：
1. GDN 是全新架构，OpenVINO 尚未支持
2. 桌伴 Patch 12 刚完成重构，需要先稳定
3. Qwen3-8B 的质量对办公助手已经够用
4. 升级需要改造推理引擎（从 OpenVINO 切换或增加 llama.cpp 后端）

**建议的升级路径**：
```
当前：OpenVINO + Qwen3-8B INT4
  ↓ (3-6个月后)
中期：OpenVINO + Qwen3.5-9B INT4（等待官方适配）
  ↓ (如果 OpenVINO 迟迟不支持)
备选：llama.cpp + Qwen3.5-9B GGUF（框架切换）
```

---

## 附录 C：Qwen3.5 全系列模型参数

| 模型 | 总参数 | 激活参数 | 架构 | 上下文 | INT4 体积 | 发布日期 |
|------|--------|----------|------|--------|----------|---------|
| Qwen3.5-0.8B | 0.8B | 0.8B | Dense+GDN | 256K→1M | ~0.5 GB | 2026-03-02 |
| Qwen3.5-2B | 2B | 2B | Dense+GDN | 256K→1M | ~1.2 GB | 2026-03-02 |
| Qwen3.5-4B | 4B | 4B | Dense+GDN | 256K→1M | ~2.5 GB | 2026-03-02 |
| Qwen3.5-9B | 9B | 9B | Dense+GDN | 256K→1M | ~5.5 GB | 2026-03-02 |
| Qwen3.5-14B | 14B | 14B | Dense+GDN | 256K→1M | ~8 GB | 2026-03-02 |
| Qwen3.5-27B | 27B | 27B | Dense+GDN | 256K→1M | ~15 GB | 2026-02-24 |
| Qwen3.5-35B-A3B | 35B | 3B | MoE+GDN | 256K→1M | ~20 GB | 2026-02-24 |
| Qwen3.5-122B-A10B | 122B | 10B | MoE+GDN | 256K→1M | ~70 GB | 2026-02-24 |
| Qwen3.5-397B-A17B | 397B | 17B | MoE | 256K→1M | ~230 GB | 2026-02-16 |

---

## 附录 D：新增术语表

| 术语 | 英文 | 一句话解释 |
|------|------|-----------|
| 预训练 | Pre-training | 让模型读万亿字文本，学会预测下一个词 |
| 指令微调 | Instruction Tuning | 教模型听懂人类指令，不再是"续写机器" |
| 监督微调 | SFT | 在标注数据上训练，让模型学会特定任务 |
| 全量微调 | Full Fine-Tuning | 更新模型所有参数，效果最好但最贵 |
| LoRA | Low-Rank Adaptation | 只训练两个小矩阵（0.1%参数），效果接近全量 |
| QLoRA | Quantized LoRA | 先量化再 LoRA，消费级硬件就能微调 |
| RLHF | Reinforcement Learning from Human Feedback | 根据人类偏好用强化学习训练 |
| DPO | Direct Preference Optimization | RLHF 的简化版，无需强化学习，一步到位 |
| 知识蒸馏 | Knowledge Distillation | 大模型教小模型，用"算力换智力" |
| 教师模型 | Teacher Model | 庞大但聪明的模型，负责生成高质量推理过程 |
| 学生模型 | Student Model | 紧凑但高效的模型，从教师的输出中学习 |
| 软标签 | Soft Labels | 教师输出的完整概率分布（不只是最终答案） |
| 硬标签 | Hard Labels | 传统训练的 one-hot 标签（只有对/错） |
| 能力涌现 | Emergent Abilities | 模型规模达到阈值后突然展现的新能力 |
| CoT | Chain of Thought | 思维链——模型一步步推理的过程 |
| LoRA秩 | lora_r | LoRA 低秩矩阵的大小，越大适配能力越强 |
| GDN | Gated Delta Networks | 门控增量网络，Qwen3.5 的新型线性注意力 |
| Early Fusion | 早期融合 | 图文音频统一编码，从预训练第一天就融合 |
| 过拟合 | Overfitting | 模型死记硬背训练数据，在新数据上表现变差 |

---

*文档更新时间：2026-05-29*
*新增章节：LLM 训练全流程科普、知识蒸馏、全量微调对比、Qwen3.5 升级可行性分析*
*数据来源：Qwen3.5 官方技术报告、阿里云开发者社区、Unsloth 文档、OpenVINO 官方、llama.cpp 社区*

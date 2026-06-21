# -*- coding: utf-8 -*-
"""
prompts.py - Prompt Engineering 模块 v4.1
==========================================
所有系统提示词集中管理，独立于主程序。

模块结构：
  - __version__: 模块版本号，前端可见
  - CHANGELOG: 版本变更记录
  - QA prompt: 纯对话/问答模式
  - Scene prompts: 5 个场景各自的 prompt
  - Think control: 思考模式控制指令（已清空）
  - Strategy config: 9 种策略配置（替代 TASK_PROMPT_ENHANCEMENTS）
  - KB prompt: 文库模式专用提示
  - Notebook injection: 记忆/知识注入模板

设计原则：
  - 针对 8B 小模型优化
  - 规则 <= 5 条，每条 <= 20 字
  - 动词开头，无废话
  - 修改 prompt 只需改此文件，不改主程序
"""
__version__ = "v5.1"

# ===== 版本变更记录 =====
CHANGELOG = [
    ("v5.1", "2026-06-02", "V5.1精简：身份+规则+格式合成一段(~100字)、场景增强精简为一句话、KB prompt 7→5条规则"),
    ("v5.0", "2026-06-01", "V2 Prompt架构：三层分层(身份+规则+场景增强)、4条精简规则、/no_think替代think参数、策略级采样参数"),
    ("v4.1", "2026-05-27", "策略think控制：STRATEGY_CONFIG新增think_mode字段(off/free)，配合Ollama实现分策略思考控制"),
    ("v4.0", "2026-07-11", "策略路由重构：新增STRATEGY_CONFIG(9种策略)+KB_SYSTEM_PROMPT，清空THINK_CONTROL，删除TASK_PROMPT_ENHANCEMENTS/get_task_enhancements"),
    ("v3.2", "2026-05-22", "移除web_search/web_reader，强化工具调用规则+one-shot示例，P10 Agent改进"),
]

# ===== 模块元信息（供前端展示）=====
MODULE_INFO = {
    "name": "Prompt Engine",
    "version": __version__,
    "description": "系统提示词管理模块",
    "changelog": CHANGELOG,
}

# ===== V5.1 精简 Prompt（身份+规则合一 + 场景一句话）=====

# 通用 system prompt（身份+规则+格式，~100字，所有场景共享）
SYSTEM_PROMPT_V2 = (
    "你是桌伴(Sidemate)，本地AI办公助手。中文直接回答。\n"
    "规则：\n"
    "1. 不寒暄，不重复问题，答完就停\n"
    "2. 不确定就说不确定，不编造\n"
    "3. 禁止续写用户消息，给出独立完整回答\n"
    "4. 超过3句必须编号分点，重点用**加粗**"
)

# 向后兼容别名（prompt_builder 引用）
IDENTITY_PROMPT = SYSTEM_PROMPT_V2
RULES_PROMPT = ""  # V5.1 已合并到 IDENTITY_PROMPT

# 场景增强（只一句话，不重复规则，不超20字）
STRATEGY_ENHANCEMENTS = {
    "greeting":   "1-2句简短回应即可。",
    "qa":         "先给结论，再补充细节。",
    "math":       "分步列算式，最后写【答案】。",
    "logic":      "列条件→推理→结论。",
    "code":       "先说思路再写代码，加注释。",
    "analysis":   "**结论**→编号分点分析→一句话总结。",
    "creative":   "结构清晰，内容丰富。",
    "summarize":  "**要点**：1. 2. 3. → 一句话概括。",
    "default":    "先结论，再分点说明。",
}

# V2 策略参数配置（扩展字段：top_p_offset, repeat_penalty_offset, min_length）
STRATEGY_CONFIG_V2 = {
    # V2.1: 所有策略 think_mode 统一为 "off"（4B 模型 thinking 能力不足，易循环）
    # 换 8B+ 模型后可恢复 math/logic/code/analysis 的 think_mode="free"
    "greeting":   {"temperature_offset": +0.1, "top_p_offset": 0.0,  "repeat_penalty_offset": +0.05, "think_mode": "off",  "min_length": 5},
    "qa":         {"temperature_offset": 0.0,  "top_p_offset": 0.0,  "repeat_penalty_offset": 0.0,   "think_mode": "off",  "min_length": 10},
    "math":       {"temperature_offset": -0.3, "top_p_offset": -0.05, "repeat_penalty_offset": 0.0,  "think_mode": "off",  "min_length": 20},
    "logic":      {"temperature_offset": -0.3, "top_p_offset": -0.05, "repeat_penalty_offset": 0.0,  "think_mode": "off",  "min_length": 20},
    "code":       {"temperature_offset": -0.2, "top_p_offset": -0.05, "repeat_penalty_offset": 0.0,  "think_mode": "off",  "min_length": 15},
    "analysis":   {"temperature_offset": -0.1, "top_p_offset": 0.0,  "repeat_penalty_offset": 0.0,   "think_mode": "off",  "min_length": 20},
    "creative":   {"temperature_offset": +0.3, "top_p_offset": +0.05, "repeat_penalty_offset": 0.0,  "think_mode": "off",  "min_length": 30},
    "summarize":  {"temperature_offset": -0.1, "top_p_offset": 0.0,  "repeat_penalty_offset": 0.0,   "think_mode": "off",  "min_length": 10},
    "default":    {"temperature_offset": 0.0,  "top_p_offset": 0.0,  "repeat_penalty_offset": 0.0,   "think_mode": "off",  "min_length": 10},
}

# 短输入保护（≤4 字时叠加）
SHORT_INPUT_PROTECTION = {
    "repeat_penalty": 1.25,
    "temperature": 0.3,
}
SHORT_INPUT_THRESHOLD = 4  # 字符数

# KB 模式独立 prompt 模板（V5.1 精简，5条规则）
KB_SYSTEM_PROMPT_TEMPLATE = (
    "你是桌伴知识库助手。严格基于【参考资料】回答，不编造。\n"
    "规则：\n"
    "1. 引用资料时标注[来源]\n"
    "2. 资料没有就说没找到\n"
    "3. 禁止续写用户消息，给出独立完整回答\n"
    "4. 超过3句必须编号分点，重点**加粗**\n\n"
    "【参考资料】\n{context}"
)


# ===== [DEPRECATED] V1 策略配置（task_classifier 仍引用，待简化）=====
STRATEGY_CONFIG = {
    "greeting": {
        "system_enhancement": "简短友好回复，1-2句话。",
        "temperature_offset": +0.1,
        "think_instruction": "",
        "think_mode": "off",     # 打招呼不需要思考
    },
    "qa": {
        "system_enhancement": "直接准确回答，不需要展开。如果不确定，请说明。",
        "temperature_offset": 0.0,
        "think_instruction": "",
        "think_mode": "off",     # 简单问答不需要思考
    },
    "math": {
        "system_enhancement": "分步计算，展示过程。可用 LaTeX 书写公式。",
        "temperature_offset": -0.3,
        "think_instruction": "",
        "think_mode": "free",    # 数学需要推理
    },
    "logic": {
        "system_enhancement": "列出条件和推理步骤，逐步推导结论。",
        "temperature_offset": -0.3,
        "think_instruction": "",
        "think_mode": "free",    # 逻辑需要推理
    },
    "code": {
        "system_enhancement": "先分析需求，再写代码，最后解释。代码用英文变量名，解释用中文。",
        "temperature_offset": -0.2,
        "think_instruction": "",
        "think_mode": "free",    # 代码需要推理
    },
    "analysis": {
        "system_enhancement": "多角度分析，给出过程和结论。结构清晰。",
        "temperature_offset": -0.1,
        "think_instruction": "",
        "think_mode": "free",    # 分析需要推理
    },
    "creative": {
        "system_enhancement": "结构清晰，有文采，内容丰富。发挥创意。",
        "temperature_offset": +0.3,
        "think_instruction": "",
        "think_mode": "off",     # 创意写作不需要深度推理
    },
    "summarize": {
        "system_enhancement": "提炼要点，简洁准确，保留关键信息。",
        "temperature_offset": -0.1,
        "think_instruction": "",
        "think_mode": "off",     # 摘要不需要推理
    },
    "default": {
        "system_enhancement": "",
        "temperature_offset": 0.0,
        "think_instruction": "",
        "think_mode": "off",     # 默认不思考
    },
}

KB_USER_PROMPT_TEMPLATE = (
    "根据【参考资料】回答问题。要求：\n"
    "1. 先给结论，再引用资料说明依据，在具体事实后标注来源编号，如「该技术的准确率为95.2% [1]」\n"
    "2. 完整复述原文的数字、时间和专有名词，不要省略\n"
    "3. 【最重要】严格基于参考资料作答，未提及的明确说「未提及」——不编造、不猜测、不引入外部知识。每个事实必须有原文对应\n"
    "4. 追问时结合上文，不重复已回答内容\n\n"
    "【参考资料】\n{context}\n\n"
    "问：{question}\n答："
)

# ===== 文档生成 Prompt =====
DOC_OUTLINE_PROMPT = (
    "请根据用户要求，生成一份文档的提纲（大纲）。\n\n"
    "格式要求：\n"
    "1. 使用 Markdown 格式\n"
    "2. 第一行是 # 一级标题（文档标题）\n"
    "3. 用 ## 二级标题列出主要章节（至少3个）\n"
    "4. 每个章节下用 1-2 句简短描述说明该章节要写什么\n"
    "5. 全中文输出\n\n"
    "用户要求：{user_request}\n\n"
    "请直接输出提纲（从 # 标题开始），不要输出正文内容："
)

DOC_FULL_PROMPT = (
    "请根据用户已确认的提纲，生成完整的文档正文。\n\n"
    "格式要求：\n"
    "1. 使用 Markdown 格式\n"
    "2. 第一行是 # 一级标题（文档标题）\n"
    "3. 用 ## 二级标题划分主要章节\n"
    "4. 每个章节下有 2-3 段充实正文\n"
    "5. 适当使用编号列表和**加粗**强调\n"
    "6. 全中文输出，内容充实、专业\n\n"
    "用户原始要求：{user_request}\n\n"
    "已确认的提纲：\n{outline}\n\n"
    "请严格按照提纲结构，直接输出完整文档（从 # 标题开始）："
)

DOC_SYSTEM_ENHANCEMENT = (
    "请根据用户要求生成一份结构化的文档。\n\n"
    "格式要求：\n"
    "1. 使用 Markdown 格式\n"
    "2. 第一行是 # 一级标题（文档标题）\n"
    "3. 用 ## 二级标题划分主要章节（至少3个）\n"
    "4. 每个章节下有 2-3 段正文内容\n"
    "5. 适当使用编号列表和**加粗**强调\n"
    "6. 全中文输出，内容充实\n\n"
    "用户要求：{user_request}\n\n"
    "请直接输出文档内容（从 # 标题开始）："
)

# ===== 文档打标 Prompt（Patch 3）=====
TAGGING_PROMPT = """请为以下文档生成3-5个标签关键词和一段100字以内的摘要。

【重要】只输出下面两行，其他任何内容都不要输出（不要思考过程、不要分析、不要额外说明）：

标签：标签1, 标签2, 标签3
摘要：100字以内的文档摘要

文档标题：{title}
文档内容：
{content}"""

# ===== Reformulation Prompt（Patch 3）=====
REFORMULATE_PROMPT = """根据对话历史，将用户的消息改写为一个完整的独立搜索查询。

规则：
- 如果是追问或指代（"那个"、"它"、"还有呢"、"这些都是谁"），补全为完整问题，补全时必须保留对话主题
- 如果已经是完整的新问题，原样返回，不要修改
- 改写时必须保留原问题中的所有专有名词和关键词
- 如果用户的问题与对话历史主题无关（新话题），不要强行关联历史，原样返回
- 输出只有一句话，不要解释，不要加引号

对话历史：
{history_summary}

用户消息：{query}

独立查询："""


# ===== 信息融合 Prompt（Patch 3 轨道B：私密融合；Patch4 修复 6 重写为高密度去重版）=====
MERGE_FUSION_PROMPT = """你的任务是产出一份高知识密度的回答。

原则：
1. 核心事实以【本地知识库】为准（用户私有文档更权威）
2. 【云端AI】的内容只用于补充本地没有的事实或提供更广视角
3. 禁止简单拼接两个来源——必须去重择优
4. 追求信息密度：每句话都要有价值，删掉重复表述和过渡废话
5. 目标长度：不超过 max(本地, 云端) × 1.2 倍

用户的问题可以从原始提问推断，下面是两个来源的信息：

【来源一：本地知识库（用户私有文档）】
{local_answer}

【来源二：云端AI（通用知识）】
{cloud_answer}

请综合以上信息，给出完整回答："""

# ===== 云端 KB 列专用 System Prompt（大模型，强调推理+结构化）=====
# 用于对比模式云端列，让大模型发挥其推理能力，而非被小模型约束限制
CLOUD_KB_SYSTEM_PROMPT = (
    "你是一个专业的知识分析助手。请基于你的知识储备，对用户的问题给出深入、准确的回答。\n"
    "要求：\n"
    "1. 优先提供有深度的分析，而非表面信息\n"
    "2. 适当使用结构化格式（表格/列表）增强可读性\n"
    "3. 如果涉及对比、分类，优先用表格\n"
    "4. 保持专业但易懂的语言风格"
)

# ===== 并行模式 Prompt（P6）=====

PARALLEL_SYSTEM_PROMPT = (
    "你正在并行处理模式中生成回答。\n"
    "你的回答将和云端AI的回答进行融合。\n"
    "严格基于知识库内容回答，不编造。\n"
    "如果知识库没有相关内容，明确说明'未找到'。"
)

def get_module_info():
    """返回模块信息（供 API 调用）"""
    return {
        "name": MODULE_INFO["name"],
        "version": __version__,
        "description": MODULE_INFO["description"],
        "changelog": CHANGELOG[:3],  # 最近 3 条
        "scenes": {
            "chat": {"prompt_preview": IDENTITY_PROMPT[:60] + "...", "think_control": "V2: /no_think"},
            "kb": {"prompt_preview": KB_SYSTEM_PROMPT_TEMPLATE[:60] + "..."},
        },
    }


# ===== 长文本分段处理提示词 =====

# --- Map 阶段：逐段提取 ---

CHUNK_EXTRACT_PROMPT = """你正在分段处理一篇长文本。当前是第 {chunk_index}/{total_chunks} 段。

[累积记忆]
{memory_text}

[上段末尾（上下文）]
{overlap_prefix}

[当前段内容]
{chunk_text}

[下段开头（预览）]
{overlap_suffix}

请用以下格式输出：
【提取信息】这段的关键事实、数据、观点（原文用词，不要改写）
【推理】与之前段的关联和新发现
【部分回答】基于已读内容的初步回答
【置信度】0.0-1.0
【待查问题】需要后续段确认的问题（如有）"""

CHUNK_QA_PROMPT = """你正在分段阅读一篇长文本，目的是回答用户的问题。
当前是第 {chunk_index}/{total_chunks} 段。

用户问题：{question}

[累积记忆]
{memory_text}

[上段末尾（上下文）]
{overlap_prefix}

[当前段内容]
{chunk_text}

[下段开头（预览）]
{overlap_suffix}

严格规则：
1. 只根据原文内容回答，不得推断或编造
2. 找到答案时必须引用原文片段
3. 没找到就说"本段未涉及此问题"

请用以下格式输出：
【引用原文】与问题直接相关的原文片段（逐字引用，加引号）
【本段结论】基于原文的回答或"本段未涉及此问题"
【置信度】0.0-1.0（1.0=原文明确提及，0.5=间接相关，0=无关）
【待查问题】需要后续段确认的信息"""

CHUNK_SUMMARIZE_PROMPT = """你正在分段阅读一篇长文本，目的是生成全文摘要。
当前是第 {chunk_index}/{total_chunks} 段。

[累积记忆]
{memory_text}

[当前段内容]
{chunk_text}

请用以下格式输出：
【段摘要】这段的主要内容和论点（50-100字）
【核心观点】最重要的1-2个观点
【与全文的关系】这段在全文中的位置和作用
【置信度】0.0-1.0"""

# --- Collapse 阶段：记忆压缩 ---

CHUNK_COLLAPSE_PROMPT = """以下是在分段处理长文本过程中累积的信息，需要压缩以腾出空间。

[当前累积信息]
{memory_text}

请将以上信息压缩为更简洁的形式，保留：
1. 所有关键事实和数据（原样保留，不可编造）
2. 重要的实体和关系
3. 未解答的问题
4. 当前的部分回答

压缩后的内容不超过 {max_chars} 字。
直接输出压缩后的文本，不需要格式标记。"""

# --- Reduce 阶段：最终聚合 ---

CHUNK_FINAL_REDUCE_PROMPT = """你已完成对一篇长文本的所有分段阅读。现在需要生成最终回答。

用户问题：{question}

[分段处理累积信息]
{memory_text}

原文总字数：{total_chars}
分段数：{total_chunks}

{mode_instruction}

规则：
1. 回答必须基于分段处理中提取的信息，不可编造
2. 关键信息需要标注【引用】原文出处（如"根据第3段..."）
3. 如果原文没有涉及用户问题的内容，明确告知"原文未提及"
4. 用中文输出，结构清晰"""

CHUNK_FINAL_REDUCE_MODES = {
    "extract": "请将所有分段提取的信息整理为结构化的知识摘要。",
    "qa": "请根据分段阅读中找到的原文内容，完整回答用户的问题。如果某部分原文未涉及，明确标注。",
    "summarize": "请基于所有分段的摘要，生成一篇连贯的全文摘要（300-500字），覆盖主要内容和观点。",
    "analyze": "请基于所有分段的分析，生成深度分析报告：主要论点、逻辑关系、潜在问题、结论。",
}


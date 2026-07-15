# -*- coding: utf-8 -*-
"""
knowledge/ask.py — 文库问答 Mixin
==================================
包含 ask() 方法，基于检索结果调用 LLM 回答问题。
从 knowledge_base.py 拆分而来。
"""
import logging
from typing import Dict, List

log = logging.getLogger(__name__)


class _KBAskMixin:
    """文库问答：基于检索结果的 LLM 问答"""

    def ask(self, question: str, model_manager=None, kb_history: List[Dict] = None) -> Dict:
        """基于文库回答问题

        Args:
            question: 用户问题
            model_manager: ModelManager 实例（用于调用 LLM）
            kb_history: 当前 KB 会话的对话历史 [{"role":"user","content":"..."}, ...]
                        仅用于会话内上下文连续性，不注入全局记忆
        Returns:
            {"answer": "...", "sources": [...], "context_used": N}
        """
        if not self.chunk_order:
            return {"answer": "文库为空，请先导入文档。", "sources": [], "context_used": 0}

        # 检索相关 chunk（context 预算自适应计算）
        max_chars = 5000  # 默认值
        if model_manager:
            try:
                budget = model_manager.calc_kb_context_budget()
                max_chars = budget["safe_chars"]
            except Exception:
                pass
        context, sources = self.get_context(question, max_chars=max_chars,
                                             actor="local", access_type="kb_search")

        if not context:
            return {"answer": "文库中未找到与问题相关的内容。", "sources": [], "context_used": 0}

        # 引据式 prompt（统一来源 prompts.KB_USER_PROMPT_TEMPLATE）
        kb_prompt = None
        try:
            from prompts import KB_USER_PROMPT_TEMPLATE
            kb_prompt = KB_USER_PROMPT_TEMPLATE.format(context=context, question=question)
        except (ImportError, KeyError):
            kb_prompt = (
                "根据【参考资料】回答问题。要求：\n"
                "1. 先回答结论，再引用资料说明依据，标注来源编号如「7:00-22:00 [1]」\n"
                "2. 完整复述原文的数字、时间和专有名词，不要省略\n"
                "3. 【最重要】参考资料中未提及的内容，必须明确说「参考资料中未提及」，绝对不要编造、猜测或引入外部知识\n"
                "4. 每个事实声明都必须有参考资料中的原文对应，没有原文支撑的内容不要输出\n\n"
                f"【参考资料】\n{context}\n\n"
                f"问：{question}\n答："
            )

        # 会话历史：最多保留最近 2 轮（4 条），保证 prompt 不超限
        chat_history = []
        if kb_history:
            recent = kb_history[-4:]
            chat_history = list(recent)

        # 调用 LLM
        answer = ""
        if model_manager:
            try:
                response_chunks = []
                for chunk_type, chunk_text in model_manager.chat_stream(
                    message=kb_prompt,
                    history=chat_history,     # 会话内上下文（KB 专用，非全局记忆）
                    context_cache=None,       # 不注入压缩摘要
                    override_task_type="text", # 文本类型，跳过分类器
                ):
                    if chunk_type in ("text", "raw"):
                        response_chunks.append(chunk_text)
                
                answer = "".join(response_chunks).strip()
                if not answer:
                    answer = "模型未生成回答。"
            except Exception as e:
                log.error("[KB] ask() LLM 调用失败: %s", str(e))
                answer = "生成回答失败: %s" % str(e)
        else:
            # 无模型时，直接返回检索到的原文片段
            answer = "（模型未加载，以下为检索到的相关内容）\n\n" + context[:2000]

        return {
            "answer": answer,
            "sources": [{"source_label": s["source_label"], "score": s["score"]} for s in sources],
            "context_used": len(sources),
        }

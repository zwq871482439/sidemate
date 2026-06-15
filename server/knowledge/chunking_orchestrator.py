# -*- coding: utf-8 -*-
"""
chunking_orchestrator.py — 长文本多轮处理编排器
================================================
编排逐段 LLM 调用，管理滚动记忆，汇总最终结果。

架构：MapReduce + MemAgent 混合
  - Map：每段独立提取结构化知识
  - 滚动记忆（AggregationMemory）：跨段传递信息
  - Collapse：记忆超限时 LLM 压缩
  - Reduce：最终聚合输出

4 种模式：
  - extract：通用知识提取
  - qa：回答具体问题（反幻觉，原文引用）
  - summarize：全文摘要
  - analyze：深度分析
"""
__version__ = "v1.0"

import re
import json
import time
import logging
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Generator, Callable

log = logging.getLogger(__name__)


@dataclass
class ChunkResult:
    """单段处理结果"""
    chunk_index: int
    extracted_info: str         # 关键事实/数据/观点
    reasoning: str              # 与前段的关联
    partial_answer: str         # 基于已读内容的初步回答
    confidence: float           # 0.0-1.0
    needs_context: List[str]    # 需要后续段确认的问题
    source_quotes: List[str]    # 原文引用片段（QA 模式专用）
    raw_output: str             # 模型原始输出（调试用）


@dataclass
class AggregationMemory:
    """滚动记忆：跨段传递信息"""
    facts: List[str] = field(default_factory=list)              # 累积关键事实
    entities: Dict[str, str] = field(default_factory=dict)       # 实体 → 描述
    open_questions: List[str] = field(default_factory=list)      # 未解答问题
    summary_so_far: str = ""                                      # 压缩摘要
    partial_answer: str = ""                                      # 当前部分回答
    source_quotes: List[str] = field(default_factory=list)        # 所有原文引用
    total_chunks_processed: int = 0

    def to_prompt_text(self, max_chars: int = 800) -> str:
        """序列化为可注入 prompt 的文本"""
        parts = []

        if self.summary_so_far:
            parts.append("[摘要] " + self.summary_so_far)

        if self.facts:
            fact_text = "；".join(self.facts[-15:])  # 最近15条
            parts.append("[关键事实] " + fact_text)

        if self.partial_answer:
            parts.append("[当前回答] " + self.partial_answer[:300])

        if self.open_questions:
            q_text = "；".join(self.open_questions[-5:])
            parts.append("[待查问题] " + q_text)

        if self.source_quotes:
            quote_text = "\n".join(["「%s」" % q for q in self.source_quotes[-5:]])
            parts.append("[已收集引用]\n" + quote_text)

        text = "\n".join(parts)

        # 超长截断
        if len(text) > max_chars:
            text = text[:max_chars - 20] + "\n...(已截断)"

        return text if text else "（尚无累积信息）"

    def char_count(self) -> int:
        """估算当前记忆字符数"""
        total = len(self.summary_so_far)
        total += sum(len(f) for f in self.facts)
        total += sum(len(v) for v in self.entities.values())
        total += sum(len(q) for q in self.open_questions)
        total += len(self.partial_answer)
        return total


class ChunkingOrchestrator:
    """长文本分段处理编排器"""

    # 结构化输出解析正则
    _SECTION_RE = re.compile(r'【([^】]+)】\s*([^\n]*(?:\n(?!【)[^\n]*)*)', re.MULTILINE)

    def __init__(self, model_manager, model_name: str,
                 mode: str = "extract",
                 max_chunk_context_chars: int = 2500,
                 memory_max_chars: int = 800,
                 device: str = None):
        """
        Args:
            model_manager: ModelManager 实例（调用 chat_stream）
            model_name: 使用的模型名称
            mode: 处理模式 extract|qa|summarize|analyze
            max_chunk_context_chars: 每段最大字符数
            memory_max_chars: 滚动记忆上限
            device: 当前设备（保留参数，兼容调用方）
        """
        self.model_manager = model_manager
        self.model_name = model_name
        self.mode = mode
        self.memory_max_chars = memory_max_chars
        self.device = device or "CPU"
        self.max_chunk_chars = max_chunk_context_chars

    def process(self, chunk_plan, user_question: str = "",
                yield_callback: Optional[Callable] = None,
                stop_check: Optional[Callable] = None) -> dict:
        """逐段处理主循环

        Args:
            chunk_plan: ChunkPlan 分段计划
            user_question: 用户问题（qa 模式必须）
            yield_callback: SSE 进度回调 (event_type, data_dict)
            stop_check: 停止检查函数，返回 True 时中断

        Returns:
            {"final_answer": str, "chunks_processed": int, "confidence": float,
             "elapsed_seconds": float, "source_quotes": list}
        """
        start_time = time.time()
        memory = AggregationMemory()
        results = []

        total = chunk_plan.total_chunks
        strategy = chunk_plan.strategy

        # 发送开始事件
        self._emit(yield_callback, "chunk_start", {
            "total_chunks": total, "strategy": strategy,
            "mode": self.mode, "total_chars": chunk_plan.total_chars,
        })

        for chunk in chunk_plan.chunks:
            # 检查停止信号
            if stop_check and stop_check():
                log.info("[ORCHESTRATOR] 收到停止信号，中断处理")
                break

            # 发送进度事件
            self._emit(yield_callback, "chunk_progress", {
                "current": chunk.index + 1, "total": total,
                "section_title": chunk.section_title, "status": "processing",
            })

            # 记忆超限 → 压缩
            if memory.char_count() > self.memory_max_chars:
                self._emit(yield_callback, "chunk_merge", {
                    "reason": "memory_overflow",
                    "memory_chars": memory.char_count(),
                })
                memory = self._collapse_memory(memory)

            # 处理单段
            try:
                result = self._process_chunk(chunk, memory, user_question, total)
                results.append(result)

                # 更新记忆
                self._update_memory(memory, result, chunk)

                # 发送结果事件
                self._emit(yield_callback, "chunk_result", {
                    "chunk_index": chunk.index,
                    "extracted_info": result.extracted_info[:200],
                    "confidence": result.confidence,
                })

                memory.total_chunks_processed += 1

            except Exception as e:
                log.warning("[ORCHESTRATOR] 第 %d 段处理失败: %s" % (chunk.index, str(e)[:100]))
                memory.facts.append("[第%d段处理失败]" % (chunk.index + 1))

        # 最终聚合（Reduce）
        final_answer = self._reduce(memory, user_question, total, chunk_plan.total_chars)

        elapsed = time.time() - start_time

        # 计算综合置信度
        if results:
            avg_confidence = sum(r.confidence for r in results) / len(results)
        else:
            avg_confidence = 0.0

        # 发送完成事件
        self._emit(yield_callback, "chunk_done", {
            "total_chunks": total,
            "chunks_processed": memory.total_chunks_processed,
            "final_confidence": round(avg_confidence, 2),
            "elapsed_seconds": round(elapsed, 1),
        })

        return {
            "final_answer": final_answer,
            "chunks_processed": memory.total_chunks_processed,
            "confidence": round(avg_confidence, 2),
            "elapsed_seconds": round(elapsed, 1),
            "source_quotes": memory.source_quotes,
        }

    def _process_chunk(self, chunk, memory: AggregationMemory,
                       user_question: str, total: int) -> ChunkResult:
        """处理单个片段：构建 prompt → LLM 调用 → 解析输出"""
        # 选择 prompt 模板
        if self.mode == "qa":
            prompt_template = self._get_prompt("CHUNK_QA_PROMPT")
        elif self.mode == "summarize":
            prompt_template = self._get_prompt("CHUNK_SUMMARIZE_PROMPT")
        else:
            prompt_template = self._get_prompt("CHUNK_EXTRACT_PROMPT")

        # 构建 prompt
        prompt_text = prompt_template.format(
            chunk_index=chunk.index + 1,
            total_chunks=total,
            memory_text=memory.to_prompt_text(self.memory_max_chars),
            overlap_prefix=chunk.overlap_prefix[:300] if chunk.overlap_prefix else "（无）",
            chunk_text=chunk.text,
            overlap_suffix=chunk.overlap_suffix[:200] if chunk.overlap_suffix else "（无）",
            question=user_question,
        )

        # 调用 LLM（非流式，直接拿完整输出）
        raw_output = self._call_llm(prompt_text)

        # 解析结构化输出
        return self._parse_chunk_output(chunk.index, raw_output)

    def _call_llm(self, prompt: str) -> str:
        """调用 model_manager 的 chat_stream 收集完整输出"""
        output_parts = []
        try:
            for phase, content in self.model_manager.chat_stream(
                prompt, self.model_name,
                max_tokens=None,  # 使用 profile 默认
                history=None,
            ):
                if phase == "text":
                    output_parts.append(content)
                elif phase == "error":
                    log.warning("[ORCHESTRATOR] LLM 错误: %s" % content[:100])
                    break
        except Exception as e:
            log.warning("[ORCHESTRATOR] LLM 调用异常: %s" % str(e)[:100])

        return "".join(output_parts)

    def _parse_chunk_output(self, chunk_index: int, raw_output: str) -> ChunkResult:
        """解析模型的结构化输出"""
        sections = {}
        for m in self._SECTION_RE.finditer(raw_output):
            key = m.group(1).strip()
            value = m.group(2).strip()
            sections[key] = value

        # 提取置信度
        confidence = 0.5
        conf_text = sections.get("置信度", "0.5")
        try:
            confidence = float(re.search(r'[0-9.]+', conf_text).group())
            confidence = max(0.0, min(1.0, confidence))
        except (AttributeError, ValueError):
            pass

        # 提取待查问题
        needs_context = []
        questions_text = sections.get("待查问题", "")
        if questions_text and "无" not in questions_text:
            needs_context = [q.strip() for q in re.split(r'[；;\n]', questions_text) if q.strip()][:5]

        # 提取原文引用（QA 模式）
        source_quotes = []
        quotes_text = sections.get("引用原文", "")
        if quotes_text and "未涉及" not in quotes_text:
            # 提取引号内的内容
            quoted = re.findall(r'[""「」『』""]([^""「」『』""]+)[""「」『』""]', quotes_text)
            if quoted:
                source_quotes = quoted[:3]
            else:
                source_quotes = [quotes_text[:200]]  # 无引号时整体作为引用

        return ChunkResult(
            chunk_index=chunk_index,
            extracted_info=sections.get("提取信息", sections.get("段摘要", sections.get("本段结论", "")))[:500],
            reasoning=sections.get("推理", sections.get("与全文的关系", ""))[:300],
            partial_answer=sections.get("部分回答", sections.get("核心观点", ""))[:500],
            confidence=confidence,
            needs_context=needs_context,
            source_quotes=source_quotes,
            raw_output=raw_output,
        )

    def _update_memory(self, memory: AggregationMemory, result: ChunkResult, chunk):
        """根据处理结果更新滚动记忆"""
        # 累积事实
        if result.extracted_info:
            memory.facts.append("[段%d] %s" % (chunk.index + 1, result.extracted_info[:200]))

        # 限制事实数量
        if len(memory.facts) > 20:
            memory.facts = memory.facts[-15:]

        # 更新部分回答
        if result.partial_answer:
            memory.partial_answer = result.partial_answer

        # 累积引用
        if result.source_quotes:
            memory.source_quotes.extend(result.source_quotes)
            if len(memory.source_quotes) > 15:
                memory.source_quotes = memory.source_quotes[-10:]

        # 更新待查问题
        if result.needs_context:
            memory.open_questions.extend(result.needs_context)
            memory.open_questions = list(set(memory.open_questions))[-10:]  # 去重 + 限制

    def _collapse_memory(self, memory: AggregationMemory) -> AggregationMemory:
        """记忆压缩（Collapse）：用 LLM 压缩滚动记忆"""
        collapse_prompt_template = self._get_prompt("CHUNK_COLLAPSE_PROMPT")

        prompt_text = collapse_prompt_template.format(
            memory_text=memory.to_prompt_text(2000),
            max_chars=self.memory_max_chars,
        )

        compressed_text = self._call_llm(prompt_text)

        # 构建新的压缩后记忆
        new_memory = AggregationMemory(
            summary_so_far=compressed_text.strip()[:self.memory_max_chars],
            partial_answer=memory.partial_answer[:300],
            source_quotes=memory.source_quotes[-10:],  # 保留最近引用
            total_chunks_processed=memory.total_chunks_processed,
        )

        log.info("[ORCHESTRATOR] 记忆压缩: %d字 → %d字" % (
            memory.char_count(), new_memory.char_count()))

        return new_memory

    def _reduce(self, memory: AggregationMemory, user_question: str,
                total_chunks: int, total_chars: int) -> str:
        """最终聚合（Reduce）"""
        reduce_template = self._get_prompt("CHUNK_FINAL_REDUCE_PROMPT")

        # 获取模式指令
        mode_instruction = "请整理分段处理中提取的所有信息。"
        try:
            from prompts import CHUNK_FINAL_REDUCE_MODES
            mode_instruction = CHUNK_FINAL_REDUCE_MODES.get(self.mode, mode_instruction)
        except ImportError:
            pass

        prompt_text = reduce_template.format(
            question=user_question or "（通用提取）",
            memory_text=memory.to_prompt_text(2000),
            total_chars=total_chars,
            total_chunks=total_chunks,
            mode_instruction=mode_instruction,
        )

        result = self._call_llm(prompt_text)
        return result.strip()

    def _get_prompt(self, name: str) -> str:
        """从 prompts.py 获取提示词模板"""
        try:
            import prompts
            return getattr(prompts, name)
        except (ImportError, AttributeError):
            # 内置兜底
            _fallbacks = {
                "CHUNK_EXTRACT_PROMPT": "阅读以下文本，提取关键信息：\n{chunk_text}\n\n提取信息：",
                "CHUNK_QA_PROMPT": "阅读以下文本回答问题：{question}\n\n{chunk_text}\n\n回答：",
                "CHUNK_SUMMARIZE_PROMPT": "总结以下文本：\n{chunk_text}\n\n摘要：",
                "CHUNK_COLLAPSE_PROMPT": "压缩以下信息（不超过{max_chars}字）：\n{memory_text}",
                "CHUNK_FINAL_REDUCE_PROMPT": "综合整理以下信息回答问题：{question}\n\n{memory_text}",
            }
            return _fallbacks.get(name, "{chunk_text}")

    @staticmethod
    def _emit(callback: Optional[Callable], event_type: str, data: dict):
        """发送 SSE 事件"""
        if callback:
            try:
                callback(event_type, data)
            except Exception:
                pass

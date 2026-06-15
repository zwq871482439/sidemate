# -*- coding: utf-8 -*-
"""内存预算管理器

基于"可卸载模块"追踪，不依赖进程总 RSS。
- budget_mb = 用户设定的模型内存预算上限
- modules_used_mb = 所有已注册模块的占用之和（非进程 RSS）
- can_allocate = 检查 (已注册模块总和 + 新请求) 是否超预算
- 提供 recommended_budget() 基于系统可用内存动态建议
"""
import logging
from typing import Dict

log = logging.getLogger(__name__)


class MemoryManager:
    """内存预算管理器 v2 — 基于"可卸载模块"追踪，不依赖进程总 RSS

    核心变更（Patch 8B）：
    - budget_mb = 用户设定的模型内存预算上限
    - modules_used_mb = 所有已注册模块的占用之和（非进程 RSS）
    - can_allocate = 检查 (已注册模块总和 + 新请求) 是否超预算
    - 提供 recommended_budget() 基于系统可用内存动态建议
    - register() 增加 category 参数（"llm" | "kb" | "other"）
    """

    def __init__(self, budget_mb: int = 8000):
        self.budget_mb = budget_mb
        self.modules: Dict[str, dict] = {}  # {name: {"mb": int, "category": str}}

    def measure(self) -> int:
        """psutil 进程总 RSS（仅供参考，不参与预算计算）"""
        try:
            import psutil
            return psutil.Process().memory_info().rss // (1024 * 1024)
        except Exception as e:
            log.warning("[MemoryManager] psutil 不可用，返回 0: %s", str(e)[:80])
            return 0

    def register(self, module_name: str, mb: int, category: str = "kb"):
        """注册模块占用，带分类标签

        Args:
            module_name: 模块名称（如 "llm", "embedder", "reranker"）
            mb: 占用内存（MB）
            category: 分类标签，"llm" | "kb" | "other"
        """
        self.modules[module_name] = {"mb": mb, "category": category}
        log.info("[MemoryManager] 注册模块 %s: %dMB (%s)", module_name, mb, category)

    def unregister(self, module_name: str):
        """注销模块"""
        mb_info = self.modules.pop(module_name, None)
        if mb_info:
            log.info("[MemoryManager] 注销模块 %s: 释放 %dMB", module_name, mb_info["mb"])

    @property
    def modules_used_mb(self) -> int:
        """已注册模块的总占用（不含进程基础）"""
        return sum(m["mb"] for m in self.modules.values())

    def can_allocate(self, estimated_mb: int) -> bool:
        """检查是否有足够预算（保留 10% 安全余量）

        逻辑：(已注册模块总和 + 新请求) <= 预算 × 90%
        不再依赖进程 RSS！
        """
        return (self.modules_used_mb + estimated_mb) <= self.budget_mb * 0.9

    def get_report(self) -> dict:
        """返回预算报告 v2"""
        used = self.modules_used_mb
        available = max(0, self.budget_mb - used)
        ratio = round(used / self.budget_mb, 2) if self.budget_mb > 0 else 0
        return {
            "budget_mb": self.budget_mb,
            "modules_used_mb": used,
            "available_mb": available,
            "usage_ratio": ratio,
            "modules": {name: info["mb"] for name, info in self.modules.items()},
            "module_categories": {name: info["category"] for name, info in self.modules.items()},
        }

    @staticmethod
    def recommended_budget() -> dict:
        """基于系统物理内存，建议预算范围"""
        try:
            import psutil
            total = psutil.virtual_memory().total // (1024 * 1024)
        except Exception:
            return {"min_mb": 8192, "max_mb": 12288, "suggested_mb": 10240}

        # 建议策略：
        # - 系统总内存 >= 32G → 建议 12G
        # - 系统总内存 >= 16G → 建议 10G
        # - 系统总内存 < 16G  → 建议 8G
        if total >= 32768:
            suggested = 12288
        elif total >= 16384:
            suggested = 10240
        else:
            suggested = 8192

        return {
            "min_mb": 8192,
            "max_mb": min(16384, int(total * 0.8)),  # 不超过系统总内存的 80%
            "suggested_mb": suggested,
        }

    def set_budget(self, new_mb: int) -> bool:
        """更新预算上限（用户通过滑块调整）

        注意：持久化由调用方（server.py POST /api/budget）负责，
        此处仅更新内存中的值。
        """
        rec = self.recommended_budget()
        new_mb = max(rec["min_mb"], min(rec["max_mb"], new_mb))
        self.budget_mb = new_mb
        return True

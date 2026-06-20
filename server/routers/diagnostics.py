# -*- coding: utf-8 -*-
"""
routers/diagnostics.py — 系统诊断路由 (Patch5 C7 T03)

提供两个端点：
  GET /api/diagnostics/info    — 返回 JSON 格式的诊断信息
  GET /api/diagnostics/export  — 返回可读文本格式的诊断报告（可下载）
"""
import os
import sys
import json
import platform
import logging
from datetime import datetime

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

from config import get as _cfg_get, PROJECT_ROOT, __version__ as _VERSION
from routers.deps import get_mgr

router = APIRouter()
log = logging.getLogger(__name__)


# ============================================================
#  辅助函数
# ============================================================

def _collect_model_status() -> dict:
    """收集模型状态信息

    Returns:
        dict: {"llm": {...}, "embedder": {...}, "reranker": {...}}
    """
    result = {"llm": None, "embedder": None, "reranker": None}
    try:
        mgr = get_mgr()
        if mgr and hasattr(mgr, "status"):
            status = mgr.status()
            # status 格式: {model_name: {type, loaded, ...}, "_stats": {...}}
            for name, info in status.items():
                if name == "_stats":
                    continue
                if not isinstance(info, dict):
                    continue
                mtype = info.get("type", "")
                entry = {
                    "name": name,
                    "loaded": info.get("loaded", False),
                    "mem_mb": getattr(mgr, "_rss_mb", lambda: 0)() if info.get("loaded") else 0,
                    "description": info.get("description", ""),
                    "device": info.get("device", ""),
                }
                if mtype == "llm":
                    result["llm"] = entry
                elif mtype in ("embedder", "embedding"):
                    result["embedder"] = entry
                elif mtype in ("reranker", "rerank"):
                    result["reranker"] = entry
    except Exception as e:
        log.warning("[DIAG] 收集模型状态失败: %s" % str(e)[:100])
    return result


def _collect_system_info() -> dict:
    """收集操作系统与硬件信息

    Returns:
        dict: {os, python_version, ram_total_gb, ram_available_gb, disk_free_gb}
    """
    info = {
        "os": platform.platform(),
        "python_version": sys.version.split()[0],
        "ram_total_gb": 0,
        "ram_available_gb": 0,
        "disk_free_gb": 0,
    }
    try:
        import psutil
        mem = psutil.virtual_memory()
        info["ram_total_gb"] = round(mem.total / (1024 ** 3), 1)
        info["ram_available_gb"] = round(mem.available / (1024 ** 3), 1)
        disk = psutil.disk_usage(PROJECT_ROOT)
        info["disk_free_gb"] = round(disk.free / (1024 ** 3), 1)
    except Exception as e:
        log.warning("[DIAG] psutil 信息获取失败: %s" % str(e)[:80])
    return info


def _collect_extensions() -> list:
    """收集已安装扩展列表

    Returns:
        list: 已安装扩展的 ID 列表
    """
    ext_ids = []
    try:
        from config import EXTENSIONS_DIR
        from core.extension_manager import ExtensionRegistry
        registry = ExtensionRegistry(EXTENSIONS_DIR)
        installed = registry.list_installed()
        for ext in installed:
            if isinstance(ext, dict):
                ext_ids.append(ext.get("id", str(ext)))
            else:
                ext_ids.append(str(ext))
    except Exception as e:
        log.warning("[DIAG] 扩展信息获取失败: %s" % str(e)[:80])
    return ext_ids


def _build_info() -> dict:
    """构建完整的诊断信息字典

    Returns:
        dict: 完整诊断信息
    """
    return {
        "timestamp": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "version": _VERSION,
        "system": _collect_system_info(),
        "models": _collect_model_status(),
        "config": {
            "ai_mode": _cfg_get("ai_mode", "local"),
            "kb_permission": _cfg_get("kb_permission", "full"),
            "ollama_port": _cfg_get("ollama_port", 11434),
        },
        "extensions": _collect_extensions(),
    }


def _format_report(info: dict) -> str:
    """将诊断信息字典格式化为可读文本报告

    Args:
        info: 诊断信息字典

    Returns:
        str: 可读文本报告
    """
    lines = []
    lines.append("=" * 60)
    lines.append("桌伴 Sidemate 诊断报告")
    lines.append("=" * 60)
    lines.append("")
    lines.append("生成时间: %s" % info.get("timestamp", ""))
    lines.append("程序版本: %s" % info.get("version", ""))
    lines.append("")

    # 系统信息
    lines.append("-" * 40)
    lines.append("系统环境")
    lines.append("-" * 40)
    sys_info = info.get("system", {})
    lines.append("操作系统: %s" % sys_info.get("os", ""))
    lines.append("Python:  %s" % sys_info.get("python_version", ""))
    lines.append("内存总量:   %s GB" % sys_info.get("ram_total_gb", 0))
    lines.append("可用内存:   %s GB" % sys_info.get("ram_available_gb", 0))
    lines.append("磁盘可用:   %s GB" % sys_info.get("disk_free_gb", 0))
    lines.append("")

    # 模型状态
    lines.append("-" * 40)
    lines.append("模型状态")
    lines.append("-" * 40)
    models = info.get("models", {})
    for mtype in ("llm", "embedder", "reranker"):
        m = models.get(mtype)
        if m:
            lines.append("%s: %s (loaded=%s, mem=%sMB)" % (
                mtype, m.get("name", ""), m.get("loaded", False), m.get("mem_mb", 0)))
        else:
            lines.append("%s: 未加载" % mtype)
    lines.append("")

    # 配置
    lines.append("-" * 40)
    lines.append("配置")
    lines.append("-" * 40)
    cfg = info.get("config", {})
    lines.append("AI 模式:       %s" % cfg.get("ai_mode", ""))
    lines.append("文库权限:      %s" % cfg.get("kb_permission", ""))
    lines.append("Ollama 端口:   %s" % cfg.get("ollama_port", ""))
    lines.append("")

    # 扩展
    lines.append("-" * 40)
    lines.append("已安装扩展")
    lines.append("-" * 40)
    exts = info.get("extensions", [])
    if exts:
        for ext in exts:
            lines.append("  - %s" % ext)
    else:
        lines.append("  (无)")
    lines.append("")
    lines.append("=" * 60)

    return "\n".join(lines)


# ============================================================
#  API 端点
# ============================================================

@router.get("/api/diagnostics/info")
def api_diagnostics_info():
    """返回 JSON 格式的诊断信息"""
    return _build_info()


@router.get("/api/diagnostics/export")
def api_diagnostics_export():
    """导出可读文本格式的诊断报告"""
    info = _build_info()
    report = _format_report(info)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = "sidemate_diagnostic_%s.txt" % ts
    return PlainTextResponse(
        content=report,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=%s" % filename},
    )

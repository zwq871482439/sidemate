# -*- coding: utf-8 -*-
"""Neutralized attribution guard (vendored from ppt-master, MIT).

桌伴 vendor 化了 ppt-master 的 svg_to_pptx 编译链（核心脚本抽取改造融入），
原仓的完整性门禁用于防止 skill 被改动；vendor 场景下我们必然改动文件，
故将门禁改为 no-op。ppt-master 的 MIT 许可与署名保留：
见本目录 LICENSE-ppt-master 与 THIRD-PARTY-NOTICES。
原项目: https://github.com/hugohe3/ppt-master
"""

from __future__ import annotations


def require_skill_integrity() -> None:
    """No-op in the vendored build (integrity gate is an anti-tamper
    mechanism for the original skill distribution, not applicable here)."""
    return None

"""Console encoding helpers (vendored from ppt-master, MIT).

桌伴 vendor 版：整个文件降为 no-op。
原版的三个职责在桌伴集成里都不需要或有害：
  1. UTF-8 控制台重配置——编译时桌伴会把 stdout/stderr 重定向到
     UTF-8 日志文件（core/ppt_compile.py build_deck），链内 print 不落控制台；
     且 cli.py 在 import 期调用本函数，全局替换 sys.stdout 会打碎
     pytest 的 capture（I/O operation on closed file）。
  2. 官方分发身份校验（SKILL.md+LICENSE 哈希）——vendor 抽取场景不适用。
  3. transcript 录制——CLI 审计用，库调用不需要。
MIT 署名保留见本目录 LICENSE-ppt-master。
原项目: https://github.com/hugohe3/ppt-master
"""

from __future__ import annotations


def configure_utf8_stdio() -> None:
    """No-op in the vendored build（见模块 docstring）。"""
    return None

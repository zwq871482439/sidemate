# -*- coding: utf-8 -*-
"""
session/continuation.py — 续写检测

从 routers/chat.py 提取的续写相关函数：
  - get_latest_chat       — 获取当天最新的对话文件
  - is_output_incomplete  — 检测输出是否被截断
"""
import os
import re
import glob as _glob

from config import CHAT_DIR
from session.chat_store import today_str


def get_latest_chat():
    """获取当天最新的对话文件"""
    today = today_str()
    files = sorted(_glob.glob(os.path.join(CHAT_DIR, "%s_*.json" % today)), reverse=True)
    if files:
        return files[0]
    return None


def is_output_incomplete(text):
    """检测输出是否被截断"""
    if not text or len(text) < 30:
        return False
    fence_count = text.count("```")
    if fence_count % 2 == 1:
        return True
    empty_blocks = re.findall(r'```[^\n]*\n\s*\n```', text)
    if empty_blocks:
        return True
    tail_text = text[-50:] if len(text) > 50 else text
    if re.search(r'```\s*\n\s*```\s*$', tail_text):
        return True
    code_sections = []
    parts = text.split("```")
    for i in range(1, len(parts), 2):
        lines = parts[i].split("\n", 1)
        code_sections.append(lines[1] if len(lines) > 1 else "")
    for code in code_sections:
        balance = 0
        in_string = False
        string_char = None
        for ch in code:
            if in_string:
                if ch == string_char:
                    in_string = False
                continue
            if ch in ('"', "'"):
                in_string = True
                string_char = ch
                continue
            if ch in "({[":
                balance += 1
            elif ch in ")}]":
                balance -= 1
        if balance > 0:
            return True
    stripped = text.rstrip()
    if stripped:
        tail = stripped[-10:]
        truncation_markers = ["#", "==", "->", "=>", "...", " ,", " (", " {", " ,\n", " ="]
        for marker in truncation_markers:
            if tail.endswith(marker):
                if marker == "#":
                    last_line = stripped.split("\n")[-1]
                    # 只在看起来像不完整的 Markdown 标题时判定截断
                    # 合法的 Markdown 标题: # 后跟空格和内容
                    if not re.match(r'^#{1,6}\s+\S', last_line):
                        if last_line == "#" or (last_line.startswith("#") and not last_line.startswith("# ")):
                            return True
                    continue
                return True
    trailing_patterns = [
        r'应该(是|为)[：:]\s*$',
        r'如下[：:]\s*$',
        r'(代码|修复|修改)(如下|如下所示)[：:]\s*$',
        r'改正后[：:]\s*$',
    ]
    for pattern in trailing_patterns:
        m = re.search(pattern + r'\s*(```)?\s*$', stripped)
        if m:
            m2 = re.search(pattern, stripped)
            if m2:
                after_match = stripped[m2.end():]
                code_in_tail = re.findall(r'```.*?```', after_match, re.DOTALL)
                if not code_in_tail:
                    return True
    return False

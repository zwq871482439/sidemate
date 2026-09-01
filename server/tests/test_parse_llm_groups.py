# -*- coding: utf-8 -*-
"""Unit tests for _parse_llm_groups() — BUG-1 & BUG-2 regression tests."""

import sys
import os
import json

# Ensure server is on path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from routers.kb import _parse_llm_groups


ALL_TAGS = ["中医基础", "中医理论", "五运六气", "六气学说", "运气学说", "中医诊断"]


# ===== BUG-1: Non-greedy extraction =====

def test_clean_json_array():
    """Clean JSON array should parse correctly."""
    raw = '[{"group":"中医","members":["中医基础","中医理论"]},{"group":"运气学说","members":["五运六气","六气学说"]}]'
    result = _parse_llm_groups(raw, ALL_TAGS)
    assert len(result) == 2, f"Expected 2 groups, got {len(result)}"
    assert result[0]["group"] == "中医"
    assert result[1]["group"] == "运气学说"


def test_markdown_code_block():
    """Markdown code block should be stripped."""
    raw = '```json\n[{"group":"中医","members":["中医基础","中医理论"]}]\n```'
    result = _parse_llm_groups(raw, ALL_TAGS)
    assert len(result) == 1
    assert result[0]["group"] == "中医"


def test_bug1_multiple_arrays_non_greedy():
    """BUG-1 regression: multiple arrays should not get merged greedily.

    The old greedy regex would grab from first [ to last ],
    corrupting the JSON when LLM outputs extra text with brackets.
    The fix extracts individual valid objects, so both valid
    {"group":"...","members":[...]} objects are correctly parsed.

    Note: the second object uses 2 members — single-member/empty groups
    get folded by _postmerge_groups (P0 标签太散修复), which would mask
    the parsing assertion this test protects.
    """
    raw = (
        '[{"group":"中医","members":["中医基础","中医理论"]}]\n'
        '以上是分组结果。另外参考格式 [{"group":"西医","members":["西医内科","西医外科"]}]'
    )
    result = _parse_llm_groups(raw, ALL_TAGS)
    # Both valid group objects should be extracted (no greedy merge corruption)
    assert len(result) == 2, f"BUG-1: expected 2 valid groups, got {len(result)}"
    groups_names = {g["group"] for g in result}
    assert "中医" in groups_names
    assert "西医" in groups_names


def test_bug1_text_with_explanation():
    """BUG-1 regression: LLM adds explanation before/after the JSON."""
    raw = (
        '根据语义分析，我将标签分为以下组：\n'
        '[{"group":"中医基础理论","members":["中医基础","中医理论"]},'
        '{"group":"运气学说","members":["五运六气","六气学说","运气学说"]}]\n'
        '这样分组符合中医学科体系。'
    )
    result = _parse_llm_groups(raw, ALL_TAGS)
    assert len(result) == 2


# ===== BUG-2: Item validation =====

def test_bug2_malformed_items_filtered():
    """BUG-2 regression: non-dict items should be filtered, not crash."""
    raw = '[{"group":"中医","members":["中医基础","中医理论"]}, "just a string", 123, null]'
    result = _parse_llm_groups(raw, ALL_TAGS)
    assert len(result) == 1, f"BUG-2: expected 1 valid group, got {len(result)}"
    assert result[0]["group"] == "中医"


def test_bug2_missing_members_key():
    """BUG-2 regression: item without 'members' key should be skipped."""
    raw = '[{"group":"中医","members":["中医基础"]}, {"group":"运气学说"}]'
    result = _parse_llm_groups(raw, ALL_TAGS)
    assert len(result) == 1, f"BUG-2: expected 1 valid (with members), got {len(result)}"
    assert result[0]["group"] == "中医"


def test_bug2_missing_group_key():
    """BUG-2 regression: item without 'group' key should be skipped."""
    raw = '[{"group":"中医","members":["中医基础"]}, {"members":["运气学说"]}]'
    result = _parse_llm_groups(raw, ALL_TAGS)
    assert len(result) == 1
    assert result[0]["group"] == "中医"


def test_bug2_members_not_list():
    """BUG-2 regression: members that isn't a list should be skipped."""
    raw = '[{"group":"中医","members":["中医基础"]}, {"group":"运气学说","members":"not_a_list"}]'
    result = _parse_llm_groups(raw, ALL_TAGS)
    assert len(result) == 1
    assert result[0]["group"] == "中医"


def test_bug2_all_invalid_falls_back():
    """BUG-2: if all items are invalid, fallback to 「其他」group."""
    raw = '[123, "string", null]'
    result = _parse_llm_groups(raw, ALL_TAGS)
    assert len(result) == 1
    assert result[0]["group"] == "其他"


# ===== General robustness =====

def test_completely_unparseable():
    """Completely unparseable text should fallback to 其他."""
    raw = '这是一段完全无法解析的文字，没有任何 JSON 结构。'
    result = _parse_llm_groups(raw, ALL_TAGS)
    assert len(result) == 1
    assert result[0]["group"] == "其他"
    assert sorted(result[0]["members"]) == sorted(ALL_TAGS)


def test_empty_input():
    """Empty input should fallback."""
    result = _parse_llm_groups("", ALL_TAGS)
    assert len(result) == 1
    assert result[0]["group"] == "其他"


def test_partial_json_extraction():
    """Partial regex extraction (step 4) should still work."""
    raw = '分组1: {"group":"中医","members":["中医基础","中医理论"]} 分组2: {"group":"运气学说","members":["五运六气","六气学说","运气学说"]}'
    result = _parse_llm_groups(raw, ALL_TAGS)
    assert len(result) == 2


if __name__ == "__main__":
    tests = [
        ("clean_json_array", test_clean_json_array),
        ("markdown_code_block", test_markdown_code_block),
        ("bug1_multiple_arrays_non_greedy", test_bug1_multiple_arrays_non_greedy),
        ("bug1_text_with_explanation", test_bug1_text_with_explanation),
        ("bug2_malformed_items_filtered", test_bug2_malformed_items_filtered),
        ("bug2_missing_members_key", test_bug2_missing_members_key),
        ("bug2_missing_group_key", test_bug2_missing_group_key),
        ("bug2_members_not_list", test_bug2_members_not_list),
        ("bug2_all_invalid_falls_back", test_bug2_all_invalid_falls_back),
        ("completely_unparseable", test_completely_unparseable),
        ("empty_input", test_empty_input),
        ("partial_json_extraction", test_partial_json_extraction),
    ]

    passed = 0
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  PASS  {name}")
            passed += 1
        except AssertionError as e:
            print(f"  FAIL  {name}: {e}")
            failed += 1
        except Exception as e:
            print(f"  ERROR {name}: {type(e).__name__}: {e}")
            failed += 1

    print(f"\n{passed} passed, {failed} failed out of {len(tests)}")
    sys.exit(0 if failed == 0 else 1)

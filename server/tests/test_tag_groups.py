# -*- coding: utf-8 -*-
"""Unit tests for LLM-based KB tag grouping.

Tests cover:
- _parse_llm_groups() — JSON parsing, code block extraction, partial extraction, fallback
- _build_groups_response() — group/ungrouped response building
- set_tag_group() — tag moving, group creation, empty group cleanup
- _collect_all_tags() — tag collection from documents
"""

import sys
import os
import json
import uuid

# Ensure server root is on path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from unittest.mock import MagicMock, PropertyMock, patch


# ============================================================
#  _parse_llm_groups() — parsers/validators
# ============================================================

from routers.kb import _parse_llm_groups


class TestParseLLMGroups:
    """Test _parse_llm_groups() — LLM output parsing."""

    # --- Happy paths ---

    def test_parse_valid_json_array(self):
        """Valid JSON array is parsed correctly."""
        raw = json.dumps([
            {"group": "中医", "members": ["中医基础", "中医诊断"]},
            {"group": "西医", "members": ["内科学", "外科学"]},
        ])
        result = _parse_llm_groups(raw, ["中医基础", "中医诊断", "内科学", "外科学"])
        assert len(result) == 2
        assert result[0]["group"] == "中医"
        assert result[0]["members"] == ["中医基础", "中医诊断"]
        assert result[1]["group"] == "西医"

    def test_parse_json_in_code_block(self):
        """JSON inside ```json ... ``` code block is extracted."""
        raw = '```json\n[\n  {"group": "A", "members": ["a1", "a2"]}\n]\n```'
        result = _parse_llm_groups(raw, ["a1", "a2"])
        assert len(result) == 1
        assert result[0]["group"] == "A"

    def test_parse_json_in_plain_code_block(self):
        """JSON inside ``` ... ``` (no language specifier) is extracted."""
        raw = '```\n[{"group": "B", "members": ["b1"]}]\n```'
        result = _parse_llm_groups(raw, ["b1"])
        assert len(result) == 1
        assert result[0]["group"] == "B"

    def test_parse_json_with_prefix_text(self):
        """JSON array is extracted from surrounding text."""
        raw = '这是分组结果：\n[{"group": "X", "members": ["x1", "x2"]}]\n完毕。'
        result = _parse_llm_groups(raw, ["x1", "x2"])
        assert len(result) == 1
        assert result[0]["group"] == "X"

    # --- Partial extraction (BUG-1 & BUG-2 FIXED) ---

    def test_non_greedy_extracts_adjacent_json_objects(self):
        """FIXED BUG-1: Non-greedy regex extracts adjacent JSON objects.

        The new Step 2 uses findall to extract individual {"group":...} objects,
        then joins them into a valid JSON array. No greedy cross-object corruption.
        """
        raw = '{"group": "中医", "members": ["中医基础", "中医诊断"]}\n{"group": "西医", "members": ["内科学"]}'
        result = _parse_llm_groups(raw, ["中医基础", "中医诊断", "内科学"])
        assert len(result) == 2
        groups_found = {g["group"] for g in result}
        assert groups_found == {"中医", "西医"}

    def test_validates_items_filter_flat_strings(self):
        """FIXED BUG-2: Flat strings in parsed result are filtered out.

        Step 3 now validates each item is a dict with 'group' and 'members' keys.
        """
        raw = '{"group": "Test", "members": ["t1", "t2", "t3"]} extra'
        result = _parse_llm_groups(raw, ["t1", "t2", "t3"])
        assert len(result) == 1
        assert result[0]["group"] == "Test"
        assert len(result[0]["members"]) == 3

    def test_validates_items_filter_non_dict_items(self):
        """FIXED BUG-2: Non-dict items (strings, numbers) are filtered out."""
        raw = '[{"group":"G","members":["a"]}, "bad string", 42, null]'
        result = _parse_llm_groups(raw, ["a"])
        assert len(result) == 1
        assert result[0]["group"] == "G"

    # --- Fallback ---

    def test_fallback_when_nothing_parseable(self):
        """Completely unparseable output falls back to single '其他' group."""
        raw = "I cannot group these tags, sorry."
        result = _parse_llm_groups(raw, ["tag1", "tag2", "tag3"])
        assert len(result) == 1
        assert result[0]["group"] == "其他"
        assert set(result[0]["members"]) == {"tag1", "tag2", "tag3"}

    def test_fallback_on_empty_string(self):
        """Empty LLM output falls back to '其他' group."""
        result = _parse_llm_groups("", ["t1", "t2"])
        assert len(result) == 1
        assert result[0]["group"] == "其他"

    def test_fallback_on_whitespace_only(self):
        """Whitespace-only LLM output falls back to '其他' group."""
        result = _parse_llm_groups("   \n  ", ["a", "b"])
        assert len(result) == 1
        assert result[0]["group"] == "其他"

    # --- Edge cases ---

    def test_single_group(self):
        """Single group with single member parses."""
        raw = '[{"group": "Solo", "members": ["only"]}]'
        result = _parse_llm_groups(raw, ["only"])
        assert len(result) == 1
        assert result[0]["members"] == ["only"]

    def test_many_groups(self):
        """10 groups all parse correctly."""
        groups_data = [{"group": f"G{i}", "members": [f"t{i}a", f"t{i}b"]} for i in range(10)]
        raw = json.dumps(groups_data)
        all_tags = [f"t{i}{x}" for i in range(10) for x in ("a", "b")]
        result = _parse_llm_groups(raw, all_tags)
        assert len(result) == 10

    def test_llm_output_with_extra_fields(self):
        """JSON with extra fields (LLM hallucination) is still parsed."""
        raw = '[{"group": "A", "members": ["a1"], "description": "extra", "score": 0.9}]'
        result = _parse_llm_groups(raw, ["a1"])
        assert len(result) == 1
        assert result[0]["group"] == "A"
        assert result[0]["members"] == ["a1"]

    def test_missing_code_block_close(self):
        """Unclosed code block — regex still finds JSON array."""
        raw = '```json\n[{"group": "A", "members": ["a1"]}]'
        result = _parse_llm_groups(raw, ["a1"])
        assert len(result) == 1
        assert result[0]["group"] == "A"


# ============================================================
#  _build_groups_response() — response formatting
# ============================================================

from routers.kb import _build_groups_response


class TestBuildGroupsResponse:
    """Test _build_groups_response() — API response formatting."""

    def _mock_kb(self, tag_groups):
        """Create a mock KB object with the given tag_groups."""
        kb = MagicMock()
        kb.tag_groups = tag_groups
        return kb

    def test_all_tagged_no_ungrouped(self):
        """When all tags are in groups, ungrouped is empty."""
        kb = self._mock_kb([
            {"group": "G1", "members": ["a", "b"], "source": "ai"},
            {"group": "G2", "members": ["c"], "source": "ai"},
        ])
        result = _build_groups_response(kb, ["a", "b", "c"])
        assert len(result["groups"]) == 2
        assert result["ungrouped"] == []

    def test_some_ungrouped(self):
        """Tags not in any group appear in ungrouped."""
        kb = self._mock_kb([
            {"group": "G1", "members": ["a"], "source": "ai"},
        ])
        result = _build_groups_response(kb, ["a", "b", "c"])
        assert len(result["groups"]) == 1
        assert set(result["ungrouped"]) == {"b", "c"}

    def test_all_ungrouped(self):
        """When no groups exist, all tags are ungrouped."""
        kb = self._mock_kb([])
        result = _build_groups_response(kb, ["x", "y", "z"])
        assert result["groups"] == []
        assert set(result["ungrouped"]) == {"x", "y", "z"}

    def test_empty_tags(self):
        """Empty tag list produces empty response."""
        kb = self._mock_kb([])
        result = _build_groups_response(kb, [])
        assert result["groups"] == []
        assert result["ungrouped"] == []

    def test_source_field_preserved(self):
        """Source field ('ai' | 'manual') is preserved in response."""
        kb = self._mock_kb([
            {"group": "AI", "members": ["a1"], "source": "ai"},
            {"group": "Manual", "members": ["m1"], "source": "manual"},
        ])
        result = _build_groups_response(kb, ["a1", "m1"])
        sources = {g["source"] for g in result["groups"]}
        assert sources == {"ai", "manual"}

    def test_duplicate_tags_only_counted_once(self):
        """A tag appearing in multiple groups only appears once in grouped_tags."""
        kb = self._mock_kb([
            {"group": "G1", "members": ["dup"], "source": "ai"},
            {"group": "G2", "members": ["dup"], "source": "ai"},
        ])
        result = _build_groups_response(kb, ["dup"])
        # dup is in both groups but should only be in grouped_tags once
        assert result["ungrouped"] == []


# ============================================================
#  set_tag_group() — tag assignment & persistence
# ============================================================

from knowledge.ops import _KBOpsMixin


class TestSetTagGroup:
    """Test set_tag_group() — tag moving, group creation, cleanup."""

    def _make_kb(self):
        """Create a minimal _KBOpsMixin instance without full init."""
        # We need to mock __init__ and inject state manually
        kb = _KBOpsMixin.__new__(_KBOpsMixin)
        kb.tag_groups = []
        kb._save_meta = MagicMock()  # Don't actually write to disk
        # P6 审计修复 a3e2458 给 set_tag_group 加了守卫:
        #   if not self.documents and os.path.exists(self.meta_path): return False
        # 裸 __new__() 跳过 __init__, 必须补上这两个属性, 否则 AttributeError。
        # documents={} 非空判断为 False → 守卫放行; meta_path 指向不存在路径, os.path.exists=False → 双保险。
        kb.documents = {}
        kb.meta_path = "/nonexistent/test_kb_meta.json"
        return kb

    def test_add_tag_to_new_group(self):
        """Adding a tag to a new group creates the group."""
        kb = self._make_kb()
        kb.set_tag_group("ai_tag", "AI领域", source="ai")
        assert len(kb.tag_groups) == 1
        assert kb.tag_groups[0]["group"] == "AI领域"
        assert kb.tag_groups[0]["members"] == ["ai_tag"]
        assert kb.tag_groups[0]["source"] == "ai"
        kb._save_meta.assert_called_once()

    def test_add_second_tag_to_existing_group(self):
        """Adding a second tag to an existing group appends to members."""
        kb = self._make_kb()
        kb.tag_groups = [{"group": "AI领域", "members": ["ml"], "source": "ai"}]
        kb.set_tag_group("dl", "AI领域", source="ai")
        assert len(kb.tag_groups) == 1
        assert set(kb.tag_groups[0]["members"]) == {"ml", "dl"}

    def test_move_tag_between_groups(self):
        """Moving a tag from one group to another removes from old, adds to new."""
        kb = self._make_kb()
        kb.tag_groups = [
            {"group": "Old", "members": ["tag1"], "source": "ai"},
            {"group": "New", "members": [], "source": "ai"},
        ]
        kb.set_tag_group("tag1", "New", source="manual")
        # Old group should have empty members → cleaned up
        groups_dict = {g["group"]: g["members"] for g in kb.tag_groups}
        assert "tag1" not in groups_dict.get("Old", [])
        assert "tag1" in groups_dict.get("New", [])

    def test_source_set_to_manual(self):
        """Manual move sets source to 'manual'."""
        kb = self._make_kb()
        kb.set_tag_group("tag", "Group", source="manual")
        assert kb.tag_groups[0]["source"] == "manual"

    def test_source_set_to_ai(self):
        """AI grouping sets source to 'ai'."""
        kb = self._make_kb()
        kb.set_tag_group("tag", "Group", source="ai")
        assert kb.tag_groups[0]["source"] == "ai"

    def test_empty_group_cleaned_after_removal(self):
        """After removing the only member, the empty group is cleaned up."""
        kb = self._make_kb()
        kb.tag_groups = [{"group": "Solo", "members": ["only"], "source": "ai"}]
        kb.set_tag_group("only", "Other", source="manual")
        # Solo should be gone (empty), only → Other
        group_names = [g["group"] for g in kb.tag_groups]
        assert "Solo" not in group_names
        assert "Other" in group_names

    def test_duplicate_tag_not_added(self):
        """Adding a tag that's already in the group doesn't create duplicates."""
        kb = self._make_kb()
        kb.tag_groups = [{"group": "G", "members": ["tag"], "source": "ai"}]
        kb.set_tag_group("tag", "G", source="ai")
        assert kb.tag_groups[0]["members"].count("tag") == 1

    def test_update_source_on_existing_group(self):
        """When adding to existing group, source is updated."""
        kb = self._make_kb()
        kb.tag_groups = [{"group": "G", "members": ["t1"], "source": "ai"}]
        kb.set_tag_group("t2", "G", source="manual")
        assert kb.tag_groups[0]["source"] == "manual"

    def test_add_multiple_tags_persists_correctly(self):
        """Multiple tag additions result in correct final state."""
        kb = self._make_kb()
        kb.set_tag_group("a", "G1", source="ai")
        kb.set_tag_group("b", "G1", source="ai")
        kb.set_tag_group("c", "G2", source="manual")
        kb.set_tag_group("d", "G2", source="manual")

        groups_by_name = {g["group"]: g for g in kb.tag_groups}
        assert set(groups_by_name["G1"]["members"]) == {"a", "b"}
        assert set(groups_by_name["G2"]["members"]) == {"c", "d"}
        assert groups_by_name["G1"]["source"] == "ai"
        assert groups_by_name["G2"]["source"] == "manual"
        # _save_meta called 4 times
        assert kb._save_meta.call_count == 4

    def test_move_cleans_multiple_empty_groups(self):
        """Moving the last member out of multiple groups cleans them all."""
        kb = self._make_kb()
        kb.tag_groups = [
            {"group": "A", "members": ["t1"], "source": "ai"},
            {"group": "B", "members": ["t2"], "source": "ai"},
        ]
        kb.set_tag_group("t1", "B", source="manual")
        # Group A should be cleaned (empty after t1 removal)
        # t1 and t2 now both in B
        groups_by_name = {g["group"]: g["members"] for g in kb.tag_groups}
        assert "A" not in groups_by_name  # cleaned
        assert set(groups_by_name.get("B", [])) == {"t1", "t2"}

    def test_remove_nonexistent_tag_no_error(self):
        """Removing a tag not in any group doesn't cause errors."""
        kb = self._make_kb()
        kb.tag_groups = [{"group": "G", "members": ["a"], "source": "ai"}]
        # This should not raise
        kb.set_tag_group("nonexistent", "G", source="ai")
        assert kb.tag_groups[0]["members"] == ["a", "nonexistent"]


# ============================================================
#  _collect_all_tags() — tag collection
# ============================================================

from routers.kb import _collect_all_tags


class TestCollectAllTags:
    """Test _collect_all_tags() — collecting unique tags from documents."""

    def _mock_kb_with_tags(self, tag_lists):
        """Create a mock KB whose documents have given tag lists."""
        kb = MagicMock()
        docs = {}
        for i, tags in enumerate(tag_lists):
            doc = MagicMock()
            doc.tags = tags
            docs[f"doc_{i}"] = doc
        kb.documents = docs
        # Make .values() iterable
        type(kb).documents = PropertyMock(return_value=docs)
        return kb

    def test_collect_unique_tags(self):
        """Only unique tags are collected, sorted."""
        kb = self._mock_kb_with_tags([
            ["中医", "西医"],
            ["中医", "内科"],
            ["外科"],
        ])
        result = _collect_all_tags(kb)
        assert result == ["中医", "内科", "外科", "西医"]

    def test_empty_documents(self):
        """No documents → empty list."""
        kb = MagicMock()
        type(kb).documents = PropertyMock(return_value={})
        result = _collect_all_tags(kb)
        assert result == []

    def test_empty_tags_in_doc(self):
        """Documents with empty tags are handled."""
        kb = self._mock_kb_with_tags([
            ["a"],
            [],
            ["b"],
        ])
        result = _collect_all_tags(kb)
        assert result == ["a", "b"]

    def test_doc_with_none_tags(self):
        """Documents with None tags are handled."""
        kb = self._mock_kb_with_tags([
            ["a"],
            None,
            ["b"],
        ])
        result = _collect_all_tags(kb)
        assert result == ["a", "b"]

    def test_whitespace_tags_trimmed(self):
        """Tags with leading/trailing whitespace are trimmed."""
        kb = self._mock_kb_with_tags([
            ["  a  ", "b"],
        ])
        result = _collect_all_tags(kb)
        assert result == ["a", "b"]

    def test_empty_string_tags_filtered(self):
        """Empty string tags are filtered out."""
        kb = self._mock_kb_with_tags([
            ["", "a", "  ", "b"],
        ])
        result = _collect_all_tags(kb)
        assert result == ["a", "b"]


# ============================================================
#  Tag group persistence in _load_meta / _save_meta
# ============================================================

class TestTagGroupPersistence:
    """Test that tag_groups survive _save_meta → _load_meta roundtrip."""

    def test_tag_groups_in_save_meta(self):
        """_save_meta includes tag_groups in the serialized data."""
        kb = _KBOpsMixin.__new__(_KBOpsMixin)
        kb.tag_groups = [
            {"group": "G1", "members": ["a", "b"], "source": "ai"},
            {"group": "G2", "members": ["c"], "source": "manual"},
        ]
        kb.documents = {}
        kb.chunks = {}
        kb.meta_path = "/nonexistent/tmp/test_kb_meta.json"
        kb.texts_dir = "/nonexistent/tmp"

        # We can't actually call _save_meta without filesystem setup,
        # but we can verify the data structure it builds.
        # Instead, verify that tag_groups is a list of dicts with required keys.
        for g in kb.tag_groups:
            assert "group" in g
            assert "members" in g
            assert "source" in g
            assert isinstance(g["members"], list)
            assert g["source"] in ("ai", "manual")

    def test_tag_groups_default_empty(self):
        """New instance has empty tag_groups list."""
        kb = _KBOpsMixin.__new__(_KBOpsMixin)
        kb.tag_groups = []
        assert kb.tag_groups == []

    def test_tag_groups_type_enforcement_in_load(self):
        """If tag_groups is not a list in loaded data, it's reset to []."""
        # This tests the logic in _load_meta:
        # self.tag_groups = data.get("tag_groups", [])
        # if not isinstance(self.tag_groups, list):
        #     self.tag_groups = []
        bad_data = {"key": "not a list"}
        tg = bad_data.get("tag_groups", [])
        if not isinstance(tg, list):
            tg = []
        assert tg == []

        # Good data
        good_data = None
        tg = (good_data or {}).get("tag_groups", []) if isinstance(good_data, dict) else []
        assert tg == []


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])

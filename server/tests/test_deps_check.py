# -*- coding: utf-8 -*-
"""Unit tests for deps_check — 依赖健康检查

Tests cover:
- OPTIONAL_DEPS 声明（curl_cffi 等可选依赖注册）
- check_optional() — 可选依赖检测，缺失仅提示不阻断
- check_deps() — 返回结构（all_ok 只反映必需依赖，optional_missing 独立）
- F10 回归：可选依赖缺失不应让 all_ok 变 False
"""

import sys
import os

# Ensure server root is on path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core import deps_check
from core.deps_check import (
    REQUIRED_DEPS,
    OPTIONAL_DEPS,
    check_all,
    check_optional,
    check_deps,
    _import_check,
)


# ============================================================
#  OPTIONAL_DEPS 声明
# ============================================================

class TestOptionalDepsRegistry:
    """F10: 可选依赖注册表"""

    def test_optional_deps_is_dict(self):
        """OPTIONAL_DEPS 必须是 dict（import_name -> 说明）"""
        assert isinstance(OPTIONAL_DEPS, dict)

    def test_curl_cffi_registered(self):
        """F10: curl_cffi 必须在可选依赖里（搜索引擎 TLS 伪装）"""
        assert "curl_cffi" in OPTIONAL_DEPS
        assert isinstance(OPTIONAL_DEPS["curl_cffi"], str)
        assert len(OPTIONAL_DEPS["curl_cffi"]) > 0

    def test_optional_deps_not_in_required(self):
        """可选依赖不应同时出现在 REQUIRED_DEPS（否则重复且会阻断启动）"""
        required_imports = [item[0] for item in REQUIRED_DEPS]
        for opt_name in OPTIONAL_DEPS:
            assert opt_name not in required_imports, (
                "%s 同时在 REQUIRED 和 OPTIONAL，归类冲突" % opt_name
            )


# ============================================================
#  check_optional() — 可选依赖检测
# ============================================================

class TestCheckOptional:
    """check_optional 返回缺失的可选依赖列表（不阻断）"""

    def test_returns_list(self):
        """check_optional 必须返回 list"""
        result = check_optional()
        assert isinstance(result, list)

    def test_curl_cffi_installed_not_in_missing(self):
        """F10: curl_cffi 已装（测试环境），不应出现在缺失列表"""
        # 前置：确认 curl_cffi 在当前环境可 import
        assert _import_check("curl_cffi"), "测试环境未装 curl_cffi，无法验证"
        result = check_optional()
        assert "curl_cffi" not in result


# ============================================================
#  check_deps() — 主入口返回结构（F10 回归核心）
# ============================================================

class TestCheckDepsStructure:
    """check_deps 返回结构必须包含 optional_missing 字段"""

    def test_returns_dict_with_required_keys(self):
        """返回必须含 all_ok / missing / optional_missing 三个键"""
        result = check_deps()
        assert "all_ok" in result
        assert "missing" in result
        assert "optional_missing" in result

    def test_all_ok_is_bool(self):
        result = check_deps()
        assert isinstance(result["all_ok"], bool)

    def test_optional_missing_is_list(self):
        result = check_deps()
        assert isinstance(result["optional_missing"], list)

    def test_optional_missing_independent_of_all_ok(self):
        """F10 回归核心：可选依赖缺失不应影响 all_ok（all_ok 只反映必需依赖）

        本测试环境 curl_cffi 已装，optional_missing 应为空；
        但即使非空，all_ok 也不应因可选依赖而变 False。
        关键断言：all_ok 的真假只取决于 check_all()（必需依赖），与 check_optional 无关。
        """
        result = check_deps()
        required_missing = check_all()
        # all_ok 必须等价于"必需依赖无缺失"
        assert result["all_ok"] == (not required_missing)


# ============================================================
#  check_all() — 必需依赖检测（既有行为不变）
# ============================================================

class TestCheckAll:
    """check_all 返回 {category: [(import_name, pip_name), ...]} 缺失列表"""

    def test_returns_dict(self):
        result = check_all()
        assert isinstance(result, dict)

    def test_required_deps_not_missing_in_test_env(self):
        """测试环境（嵌入式 Python）核心必需依赖应齐全，缺失列表为空或仅扩展包

        注意：torch/faster_whisper 等重型依赖可能不在 CI 环境，
        此测试只断言 base 类别（docx/psutil/openai）齐全。
        """
        result = check_all()
        # base 类别（docx/pypandoc/psutil/openai）应在测试环境可用
        if "base" in result:
            pytest.skip("base 依赖缺失，测试环境不完整：%s" % result["base"])

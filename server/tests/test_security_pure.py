# -*- coding: utf-8 -*-
"""
test_security_pure.py — 安全相关纯函数单元测试

覆盖：
  1. _safe_math_eval（AST 求值器）：正常表达式 + 注入防御
  2. safe_workspace_path：路径穿越 / 绝对路径 / 正常路径
  3. SidemateValidator：合法包 / 篡改 / 缺 _meta 兼容 / ZIP Slip
  4. classify_url（SSRF）：公网 / 私网 / 链路本地 / 非法协议
  5. _translate_cloud_error：各错误类型映射

运行：cd server && python -m pytest tests/test_security_pure.py -v
     或单独：python -m pytest tests/test_security_pure.py::test_xxx -v
"""
import os
import sys
import json
import zipfile
import hashlib

import pytest

# 确保 server/ 在 sys.path（pytest 从 server/ 目录运行时已包含，IDE 运行时补一下）
_SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SERVER_DIR not in sys.path:
    sys.path.insert(0, _SERVER_DIR)


# ============================================================
# 1. _safe_math_eval（AST 求值器）
# ============================================================

from core.agent_loop import _safe_math_eval


class TestSafeMathEval:
    """测试 AST 数学求值器：正常计算 + 注入防御"""

    @pytest.mark.parametrize("expr, expected", [
        ("1 + 2", 3),
        ("3 * 4 - 5", 7),
        ("(2 + 3) * 4", 20),
        ("10 / 4", 2.5),
        ("2 ** 10", 1024),
        ("-5 + 3", -2),
        ("7 % 3", 1),
        ("min(3, 5, 2)", 2),
        ("max(1, 2) + abs(-3)", 5),
        ("round(3.7)", 4),
        ("round(3.14159, 2)", 3.14),
        ("pow(2, 3)", 8),
        ("sum([1, 2, 3])" if False else "abs(-10)", 10),  # sum 需列表，跳过；用 abs 替代
    ])
    def test_normal_expressions(self, expr, expected):
        assert _safe_math_eval(expr) == expected

    @pytest.mark.parametrize("malicious", [
        '__import__("os")',
        'os.system("ls")',
        'open("x")',
        'eval("1")',
        'exec("1")',
        '1; 2',                      # 分号（多语句）
        'x = 1',                     # 赋值
        '(1).__class__',             # 属性访问（逃逸）
        '__builtins__',              # 双下划线
        '1 if 1 else 2',             # 条件表达式（AST 白名单应拒）
        '[1, 2, 3][0]',              # 下标（AST 白名单应拒）
        '{1: 2}',                    # 字典（AST 白名单应拒）
        'lambda x: x',               # lambda
        '1 and 0',                   # 布尔运算
    ])
    def test_injection_rejected(self, malicious):
        """所有注入尝试必须被拒绝（抛 ValueError 或其它异常，绝不能执行成功）"""
        with pytest.raises(Exception):
            _safe_math_eval(malicious)

    def test_no_eval_used(self):
        """回归保护：确认求值器不再使用 eval/compile 执行"""
        import re
        import core.agent_loop as mod
        import inspect
        src = inspect.getsource(mod._safe_math_eval)
        # 求值器内部不应出现 eval(...) 或 compile(...) 调用（注释除外）
        # 用正则匹配独立的 eval(/compile( 调用，排除函数名定义 _safe_math_eval
        eval_call = re.compile(r'\beval\s*\(')
        compile_call = re.compile(r'\bcompile\s*\(')
        for line in src.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            assert not eval_call.search(stripped), "求值器仍使用 eval: %s" % stripped
            assert not compile_call.search(stripped), "求值器仍使用 compile: %s" % stripped


# ============================================================
# 2. safe_workspace_path（路径安全）
# ============================================================

from core.doc_session import safe_workspace_path, _chat_root

VALID_CHAT_ID = "2026-06-27_001"


class TestSafeWorkspacePath:
    """测试 workspace 路径安全：穿越 / 绝对路径 / 正常"""

    @pytest.mark.parametrize("rel", [
        "outline.md",
        "drafts/v1.md",
        "sub/dir/file.txt",
        "报告/第一章.md",
    ])
    def test_normal_paths(self, rel):
        """正常相对路径应返回 workspace 内的绝对路径"""
        result = safe_workspace_path(VALID_CHAT_ID, rel)
        assert os.path.isabs(result)
        assert "workspace" in result

    @pytest.mark.parametrize("malicious", [
        "../etc/passwd",
        "../../secret",
        "sub/../../../escape",
    ])
    def test_traversal_rejected(self, malicious):
        with pytest.raises(ValueError, match="越界|path|目录"):
            safe_workspace_path(VALID_CHAT_ID, malicious)

    @pytest.mark.parametrize("abs_path", [
        "/etc/passwd",
        "C:\\Windows\\system32",
        "/absolute/path",
    ])
    def test_absolute_path_rejected(self, abs_path):
        with pytest.raises(ValueError):
            safe_workspace_path(VALID_CHAT_ID, abs_path)

    def test_null_byte_rejected(self):
        with pytest.raises(ValueError):
            safe_workspace_path(VALID_CHAT_ID, "file\x00.md")

    def test_empty_rejected(self):
        with pytest.raises(ValueError):
            safe_workspace_path(VALID_CHAT_ID, "")
        with pytest.raises(ValueError):
            safe_workspace_path("", "file.md")


class TestChatRoot:
    """测试 _chat_root 路径穿越防护（1.7 修复项）

    校验策略：只拦截危险路径模式（../、绝对路径、盘符、null byte），
    不强制 YYYY-MM-DD_NNN 格式（兼容测试用临时 chat_id）。
    """

    @pytest.mark.parametrize("chat_id", [
        "2026-06-27_001",        # 生产格式
        "2026-01-01_999",
        "_test_v31_regression",  # 测试用临时 id（非日期格式但安全）
        "abc-def-gh_ijk",        # 非日期格式但无穿越
    ])
    def test_valid_chat_id(self, chat_id):
        """安全 chat_id 应正常返回路径"""
        result = _chat_root(chat_id)
        assert chat_id in result

    @pytest.mark.parametrize("chat_id", [
        "../etc",                  # 路径穿越
        "2026-06-27_001/../../",   # 穿越
        "/etc/passwd",             # POSIX 绝对路径
        "C:\\Windows\\system32",   # Windows 盘符
        "",                        # 空
    ])
    def test_dangerous_rejected(self, chat_id):
        """危险路径模式应被拒绝"""
        with pytest.raises(ValueError):
            _chat_root(chat_id)

    def test_null_byte_rejected(self):
        with pytest.raises(ValueError):
            _chat_root("safe\x00../../etc")


# ============================================================
# 3. SidemateValidator（包完整性校验）
# ============================================================

from common.sidemate_validator import SidemateValidator


def _make_zip(tmp_path, files: dict, meta: dict = None):
    """辅助：构造 .sidemate 测试包。
    files: {相对路径: 内容bytes}
    meta: 若提供则写 _meta.json（含 file_hashes）
    """
    pkg_path = str(tmp_path / "test.sidemate")
    with zipfile.ZipFile(pkg_path, "w") as zf:
        zf.writestr("manifest.json", json.dumps({
            "type": "llm", "name": "test", "version": "1.0"
        }))
        for rel, content in files.items():
            if isinstance(content, str):
                content = content.encode("utf-8")
            zf.writestr(rel, content)
        if meta is not None:
            zf.writestr("_meta.json", json.dumps(meta))
    return pkg_path


class TestSidemateValidator:
    """测试 .sidemate 包校验器"""

    def test_legacy_package_no_meta(self, tmp_path):
        """旧包（无 _meta.json）应宽松模式通过"""
        pkg = _make_zip(tmp_path, {"models/a.gguf": b"model data"})
        v = SidemateValidator()
        ok, msg, manifest = v.validate_sidemate(pkg)
        assert ok, "旧包应通过: %s" % msg
        assert "宽松模式" in msg
        assert manifest["type"] == "llm"

    def test_strict_package_with_hashes(self, tmp_path):
        """新包（有 file_hashes）应严格模式通过"""
        content = b"model data here"
        sha = hashlib.sha256(content).hexdigest()
        pkg = _make_zip(tmp_path, {"models/a.gguf": content},
                        meta={"file_hashes": {"models/a.gguf": sha}})
        v = SidemateValidator()
        ok, msg, _ = v.validate_sidemate(pkg)
        assert ok, "严格模式应通过: %s" % msg
        assert "严格模式" in msg

    def test_tampered_file_detected(self, tmp_path):
        """篡改文件内容后，严格模式应检出"""
        # 用正确 hash，但文件内容被改
        wrong_sha = "0" * 64
        pkg = _make_zip(tmp_path, {"models/a.gguf": b"tampered content"},
                        meta={"file_hashes": {"models/a.gguf": wrong_sha}})
        v = SidemateValidator()
        ok, msg, _ = v.validate_sidemate(pkg)
        assert not ok
        assert "SHA256" in msg or "校验失败" in msg

    def test_strict_missing_hash_entry(self, tmp_path):
        """严格模式下，文件未登记在 file_hashes 应失败（修复原漏洞）"""
        pkg = _make_zip(tmp_path, {"models/a.gguf": b"data", "models/b.gguf": b"data2"},
                        meta={"file_hashes": {"models/a.gguf": hashlib.sha256(b"data").hexdigest()}})
        v = SidemateValidator()
        ok, msg, _ = v.validate_sidemate(pkg)
        assert not ok
        assert "b.gguf" in msg or "file_hashes" in msg

    def test_zip_slip_rejected(self, tmp_path):
        """ZIP Slip（路径穿越）应被拒绝"""
        pkg = _make_zip(tmp_path, {"../../../etc/passwd": b"hacked"})
        v = SidemateValidator()
        ok, msg, _ = v.validate_sidemate(pkg)
        assert not ok
        assert "路径遍历" in msg

    def test_missing_manifest_rejected(self, tmp_path):
        """缺 manifest.json 应失败"""
        pkg_path = str(tmp_path / "test.sidemate")
        with zipfile.ZipFile(pkg_path, "w") as zf:
            zf.writestr("models/a.gguf", b"data")
            # 故意不写 manifest.json
        v = SidemateValidator()
        ok, msg, _ = v.validate_sidemate(pkg_path)
        assert not ok

    def test_not_zip_rejected(self, tmp_path):
        """非 ZIP 文件应失败"""
        pkg_path = str(tmp_path / "test.sidemate")
        with open(pkg_path, "wb") as f:
            f.write(b"this is not a zip")
        v = SidemateValidator()
        ok, msg, _ = v.validate_sidemate(pkg_path)
        assert not ok


# ============================================================
# 4. classify_url（SSRF 防护）
# ============================================================

from core.search_engine import classify_url


class TestClassifyUrl:
    """测试 SSRF URL 分类"""

    @pytest.mark.parametrize("url", [
        "https://www.example.com",
        "http://www.baidu.com",
    ])
    def test_public(self, url):
        cat, _ = classify_url(url)
        assert cat == "public"

    @pytest.mark.parametrize("url", [
        "http://127.0.0.1/test",
        "http://localhost/test",
        "http://192.168.1.1/admin",
        "http://10.0.0.1/",
    ])
    def test_private(self, url):
        cat, _ = classify_url(url)
        assert cat == "private"

    def test_cloud_metadata_blocked(self):
        """云元数据端点（169.254.169.254）必须硬拒绝"""
        cat, detail = classify_url("http://169.254.169.254/latest/meta-data/")
        assert cat == "blocked"
        assert "链路本地" in detail or "元数据" in detail

    @pytest.mark.parametrize("url", [
        "file:///etc/passwd",
        "ftp://example.com/",
        "gopher://x/",
        "dict://x/",
    ])
    def test_illegal_scheme_blocked(self, url):
        cat, _ = classify_url(url)
        assert cat == "blocked"


# ============================================================
# 5. _translate_cloud_error（错误翻译）
# ============================================================

from core.cloud_engine import _translate_cloud_error


class TestTranslateCloudError:
    """测试云端错误翻译"""

    def _make_status_error(self, status_code, message="error"):
        """构造带 status_code 属性的异常（模拟 openai APIStatusError）"""
        class FakeStatusError(Exception):
            pass
        e = FakeStatusError(message)
        e.status_code = status_code
        return e

    def test_dns_error(self):
        e = Exception("getaddrinfo failed for api.example.com")
        result = _translate_cloud_error(e)
        assert result["error_type"] == "network_dns"

    def test_timeout(self):
        e = Exception("Request timed out after 30s")
        result = _translate_cloud_error(e)
        assert result["error_type"] == "network_timeout"

    def test_auth_401(self):
        e = self._make_status_error(401, "Invalid API key")
        result = _translate_cloud_error(e)
        assert result["error_type"] == "auth_error"

    def test_rate_limit_429(self):
        e = self._make_status_error(429, "Rate limited")
        result = _translate_cloud_error(e)
        assert result["error_type"] == "rate_limit"

    def test_server_error_500(self):
        e = self._make_status_error(500, "Internal error")
        result = _translate_cloud_error(e)
        assert result["error_type"] == "server_error"

    def test_forbidden_403(self):
        e = self._make_status_error(403, "Forbidden")
        result = _translate_cloud_error(e)
        assert result["error_type"] == "auth_forbidden"

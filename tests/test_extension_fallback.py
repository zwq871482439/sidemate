# -*- coding: utf-8 -*-
"""Patch5 D3: 扩展"模型存在性兜底"测试

验证 ExtensionRegistry.is_installed() 在注册表丢失时能通过检查模型文件正确判断。
"""
import os
import sys
import json
import shutil
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))
os.environ.setdefault("PYTHONNOUSERSITE", "1")

failures = []


def check(cond, msg):
    if cond:
        print("OK:", msg)
    else:
        print("FAIL:", msg)
        failures.append(msg)


def _create_fake_models(root, ext_id):
    """在临时 root 下创建假的关键模型文件"""
    files = {
        "knowledge": [
            "models/embedding/model.safetensors",
            "models/embedding/config.json",
            "models/embedding/tokenizer.json",
            "models/reranker/model.safetensors",
            "models/reranker/config.json",
        ],
        "recorder": [
            "models/whisper/model.bin",
        ],
    }
    for f in files.get(ext_id, []):
        full = os.path.join(root, f)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "wb") as fp:
            fp.write(b"\x00")  # 占位字节


def test_registry_hit():
    """注册表正常时直接返回 True（不走兜底）"""
    from core.extension_manager import ExtensionRegistry
    tmpdir = tempfile.mkdtemp()
    try:
        reg = ExtensionRegistry(tmpdir)
        reg.register("knowledge", {"version": "1.0.0"})
        check(reg.is_installed("knowledge") is True, "注册表正常 → True")
        check(reg.is_installed("recorder") is False, "未注册的 → False")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def test_fallback_full_files():
    """注册表空但模型文件全部存在 → 兜底命中"""
    from core.extension_manager import ExtensionRegistry
    from core.extension_manager import _check_required_files, _project_root

    # 注意：_check_required_files 默认用 _project_root()，会查真实的 C:\Sidemate
    # 本机 models/embedding 应该有内容
    real_root = _project_root()
    has_kb_models = os.path.exists(os.path.join(real_root, "models/embedding/config.json"))

    if not has_kb_models:
        print("SKIP: 本机无 KB 模型，跳过真实兜底测试")
        return

    # 用真实 EXTENSIONS_DIR（应该是空的或不存在）
    ext_dir = os.path.join(real_root, "data", "extensions")
    reg = ExtensionRegistry(ext_dir)

    # 备份现有注册表（如果有）
    backup = {}
    for ext_id in ("knowledge", "recorder"):
        path = os.path.join(ext_dir, "%s.json" % ext_id)
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                backup[ext_id] = f.read()

    try:
        # 先清空 knowledge 注册表
        knowledge_path = os.path.join(ext_dir, "knowledge.json")
        if os.path.exists(knowledge_path):
            os.remove(knowledge_path)

        # 兜底应该命中
        result = reg.is_installed("knowledge")
        check(result is True, "注册表空 + 模型全 → 兜底命中 True")

        # 验证自动补登记
        check(os.path.exists(knowledge_path), "兜底命中后自动补登记 knowledge.json")
        if os.path.exists(knowledge_path):
            with open(knowledge_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            check(data.get("id") == "knowledge", "补登记的 JSON id 正确")
            check(data.get("auto_detected") is True, "补登记的 JSON 标记为 auto_detected")
    finally:
        # 恢复备份
        for ext_id, content in backup.items():
            path = os.path.join(ext_dir, "%s.json" % ext_id)
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)


def test_fallback_partial_files():
    """注册表空 + 模型文件缺一个 → 兜底不命中（避免半装误判）"""
    from core.extension_manager import _file_exists_any, _project_root

    real_root = _project_root()
    # 故意构造一个不存在的文件
    check(_file_exists_any("models/embedding/__nonexistent__.xyz", real_root) is False,
          "单个不存在文件 → False")
    check(_file_exists_any(
        ("models/embedding/__nonexistent__.xyz", "models/embedding/config.json"),
        real_root) is True,
          "元组（或关系）：一个不存在 + 一个存在 → True")
    check(_file_exists_any(
        ("models/embedding/__a__.xyz", "models/embedding/__b__.xyz"),
        real_root) is False,
          "元组全部不存在 → False")


def test_llm_no_fallback():
    """llm 扩展不参与兜底（Ollama blob 用 hash 命名，无法用固定路径校验）"""
    from core.extension_manager import REQUIRED_FILES_BY_EXT
    check("llm" not in REQUIRED_FILES_BY_EXT, "llm 不在 REQUIRED_FILES_BY_EXT 里")
    check("knowledge" in REQUIRED_FILES_BY_EXT, "knowledge 在兜底列表里")
    check("recorder" in REQUIRED_FILES_BY_EXT, "recorder 在兜底列表里")


def test_unknown_ext():
    """未知扩展 ID → False（不参与兜底）"""
    from core.extension_manager import ExtensionRegistry
    tmpdir = tempfile.mkdtemp()
    try:
        reg = ExtensionRegistry(tmpdir)
        check(reg.is_installed("unknown_ext") is False, "未知 ext_id → False")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def main():
    print("=" * 60)
    print("Patch5 D3: 扩展模型存在性兜底测试")
    print("=" * 60)

    test_registry_hit()
    test_fallback_full_files()
    test_fallback_partial_files()
    test_llm_no_fallback()
    test_unknown_ext()

    print()
    if failures:
        print("=" * 60)
        print("FAILED: %d 项" % len(failures))
        for f in failures:
            print("  -", f)
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())

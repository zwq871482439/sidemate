# -*- coding: utf-8 -*-
"""
sidemate_validator.py - .sidemate 包校验器
======================================
桌伴·Sidemate 包格式验证器，负责校验 .sidemate 包的完整性、签名和安全性。
"""

import hashlib
import hmac
import json
import os
import zipfile
from typing import Tuple, Optional, Dict, Any

# 文件类型白名单 -- 允许的扩展名
ALLOWED_EXTENSIONS = {
    '.bin', '.xml', '.json', '.whl', '.tar', '.gz', '.txt', '.md',
    '.safetensors', '.vocab', '.model', '.onnx', '.idx', '.flac',
    '.wav', '.mp3', '.ogg', '.png', '.jpg', '.jpeg', '.svg',
    '.ttf', '.otf', '.woff', '.woff2', '.css', '.js', '.html',
    '.cfg', '.ini', '.toml', '.yaml', '.yml', '.csv',
    '.tsv', '.pdf', '.docx', '.xlsx', '.pptx', '.lock',
    # HF / OV 扩展
    '.gitattributes', '.jinja', '.msc', '.mv', '.metadata',
    # GGUF 格式（Ollama LLM 模型）
    '.gguf',
    # CTranslate2 格式（faster-whisper）
    '.ct2',
    # 通用：无扩展名文件直接放行（HF metadata 等）
}

# 禁止的文件名模式（即使扩展名在白名单中）
BLOCKED_PATTERNS = [
    '__pycache__',
    '.git/',
    '.DS_Store',
    'Thumbs.db',
    'desktop.ini',
]

# 最大文件/包大小
MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024  # 5GB 单文件
MAX_TOTAL_SIZE = 10 * 1024 * 1024 * 1024  # 10GB 总包


class SidemateValidator:
    def __init__(self, hmac_key: str):
        self.hmac_key = hmac_key.encode('utf-8')

    def validate_sidemate(self, sidemate_path: str) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        """
        验证 .sidemate 包
        返回: (is_valid, message, manifest_dict)
        """
        # 1. 扩展名检查
        if not sidemate_path.lower().endswith('.sidemate'):
            return False, "文件扩展名不是 .sidemate", None

        # 2. 文件存在性
        if not os.path.exists(sidemate_path):
            return False, "文件不存在: %s" % sidemate_path, None

        # 3. ZIP 格式验证
        if not zipfile.is_zipfile(sidemate_path):
            return False, "不是有效的 ZIP 格式（.sidemate 必须是 ZIP）", None

        try:
            with zipfile.ZipFile(sidemate_path, 'r') as zf:
                names = zf.namelist()

                # 4. 读取 _meta.json
                if '_meta.json' not in names:
                    return False, "包中缺少 _meta.json", None

                try:
                    meta_bytes = zf.read('_meta.json')
                    meta = json.loads(meta_bytes)
                except (json.JSONDecodeError, Exception) as e:
                    return False, "_meta.json 解析失败: %s" % str(e)[:100], None

                checksums_json = meta.get('checksums', '')
                signature = meta.get('signature', '')

                if not checksums_json or not signature:
                    return False, "_meta.json 缺少 checksums 或 signature 字段", None

                # 5. HMAC 签名验证
                if not self._verify_hmac(checksums_json, signature):
                    return False, "HMAC 签名验证失败，包可能被篡改", None

                # 解析 checksums
                try:
                    checksums = json.loads(checksums_json)
                except json.JSONDecodeError:
                    return False, "checksums 不是有效的 JSON", None

                # 6. manifest.json 校验
                if 'manifest.json' not in names:
                    return False, "包中缺少 manifest.json", None

                try:
                    # ZIP 中可能有多个 manifest.json（原始目录 + packager 写入）
                    # 遍历所有条目，取最后一个（packager 版本，含 type 字段）
                    manifest = None
                    for info in zf.infolist():
                        if info.filename == 'manifest.json':
                            raw = zf.read(info)
                            try:
                                candidate = json.loads(raw)
                                # 优先取有 type 字段的版本（packager 生成的）
                                if 'type' in candidate:
                                    manifest = candidate
                                elif manifest is None:
                                    manifest = candidate
                            except (json.JSONDecodeError, Exception):
                                pass  # 多个 manifest.json 条目，跳过无法解析的
                    if manifest is None:
                        return False, "包中缺少 manifest.json", None
                except (json.JSONDecodeError, Exception) as e:
                    return False, "manifest.json 解析失败: %s" % str(e)[:100], None

                # 必填字段
                for field in ('type', 'name', 'version'):
                    if field not in manifest:
                        return False, "manifest.json 缺少必填字段: %s" % field, None

                # 7. 逐文件校验
                total_size = 0
                for name in names:
                    if name in ('_meta.json', 'manifest.json'):
                        continue
                    if name.endswith('/'):
                        continue

                    # 路径遍历检查（ZIP Slip）
                    if self._check_path_traversal(name):
                        return False, "检测到路径遍历攻击: %s" % name, None

                    # 文件类型白名单
                    if not self._check_file_type(name):
                        return False, "文件类型不在白名单中: %s" % name, None

                    # 禁止模式检查
                    for pattern in BLOCKED_PATTERNS:
                        if pattern in name:
                            return False, "文件名包含禁止模式 (%s): %s" % (pattern, name), None

                    # SHA256 校验（如果有对应的 checksum）
                    info = zf.getinfo(name)
                    data = zf.read(info)
                    total_size += len(data)

                    if len(data) > MAX_FILE_SIZE:
                        return False, "文件超过大小限制 (%s): %s" % (name, len(data)), None

                    if name in checksums:
                        actual_hash = self._compute_sha256(data)
                        expected_hash = checksums[name]
                        if actual_hash != expected_hash:
                            return False, "SHA256 校验失败: %s" % name, None

                if total_size > MAX_TOTAL_SIZE:
                    return False, "包总大小超过限制 (%d bytes)" % total_size, None

                return True, "校验通过", manifest

        except Exception as e:
            return False, "ZIP 处理失败: %s" % str(e)[:100], None

    def _verify_hmac(self, checksums_json: str, signature: str) -> bool:
        """验证 HMAC-SHA256 签名"""
        expected = hmac.new(self.hmac_key, checksums_json.encode('utf-8'), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature)

    def _compute_sha256(self, data: bytes) -> str:
        """计算 SHA256"""
        return hashlib.sha256(data).hexdigest()

    def _check_path_traversal(self, filepath: str) -> bool:
        """检查路径遍历，返回 True 表示检测到危险路径"""
        # 检查 .. 组件
        parts = filepath.replace('\\', '/').split('/')
        for part in parts:
            if part == '..':
                return True
        # 检查绝对路径
        if filepath.startswith('/') or (len(filepath) > 1 and filepath[1] == ':'):
            return True
        return False

    def _check_file_type(self, filepath: str) -> bool:
        """检查文件类型白名单"""
        # 目录条目（以 / 结尾）直接放行
        if filepath.endswith('/'):
            return True
        _, ext = os.path.splitext(filepath.lower())
        # 无扩展名文件放行（HF metadata 等常有此类文件）
        if ext == '':
            return True
        return ext in ALLOWED_EXTENSIONS

    def infer_type(self, zf: zipfile.ZipFile, names: list) -> str:
        """自动推断包类型（基于 manifest.type 优先，回退到结构推断）"""
        name_set = set(n.lower() for n in names)

        # 优先级 1：manifest.json 中显式声明了 type
        manifest = None
        for info in zf.infolist():
            if info.filename == 'manifest.json':
                try:
                    raw = zf.read(info)
                    candidate = json.loads(raw)
                    if 'type' in candidate:
                        manifest = candidate
                        break
                    elif manifest is None:
                        manifest = candidate
                except Exception:
                    pass  # inferrer 只做最佳推测，失败不影响主流程

        if manifest and manifest.get("type") == "extension-knowledge":
            return "extension-knowledge"
        if manifest and manifest.get("type") == "extension-recorder":
            return "extension-recorder"
        if manifest and manifest.get("type") == "llm":
            return "llm"

        # 优先级 2：结构推断（旧格式兼容）
        # 有 models/ + wheels/ -> "knowledge"
        has_models = any(n.lower().startswith('models/') for n in names)
        has_wheels = any(n.lower().startswith('wheels/') for n in names)
        if has_models and has_wheels:
            return "knowledge"

        # 有 model/ + wheels/ + HF 相关 -> "whisper"
        has_model = any(n.lower().startswith('model/') for n in names)
        has_hf = any('.safetensors' in n.lower() or '.vocab' in n.lower() for n in names)
        if has_model and has_wheels and has_hf:
            return "whisper"

        return "unknown"

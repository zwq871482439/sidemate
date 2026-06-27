#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pack_sidemate.py — .sidemate 扩展包打包脚本（v2，SHA256 完整性校验版）
=========================================================================

将一个模型目录 + manifest.json 打包成 .sidemate 文件，并自动生成
_meta.json（含 file_hashes 字段）供 SidemateValidator 严格校验。

用法：
  python pack_sidemate.py --dir <源目录> --out <输出.sidemate>

示例（重打现有包，补 _meta.json）：
  python pack_sidemate.py --repack output/extensions/sidemate-llm-qwen3.5-4b-v1.0.0.sidemate

源目录结构（--dir 模式）：
  <源目录>/
    manifest.json        # 必须存在，含 type/name/version
    models/...           # 模型文件
    wheels/...           # 可选，Python 依赖

打包后结构：
  <输出>.sidemate
    manifest.json        # 原样写入
    _meta.json           # 自动生成：{"file_hashes": {"path": "sha256", ...}, "tool": "pack_sidemate v2"}
    models/...           # 模型文件（相对路径保留）
    wheels/...

v2 设计说明：
  - 不再生成 HMAC 签名（默认密钥在源码公开，安全增益为零）
  - SHA256 防的是传输损坏/下载截断/磁盘错误，非恶意篡改
  - 用户自建包：可手工编辑 manifest.json 后运行本脚本自动补 _meta.json
"""

import argparse
import hashlib
import json
import os
import sys
import zipfile
from datetime import datetime


def compute_sha256(file_path: str, buf_size: int = 1024 * 1024) -> str:
    """流式计算文件 SHA256（支持 GB 级文件，内存占用恒定 1MB）。"""
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        while True:
            buf = f.read(buf_size)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest()


def collect_files(src_dir: str) -> list:
    """收集源目录下所有文件的相对路径（排除 _meta.json，保留 manifest.json）。"""
    files = []
    for dirpath, dirnames, filenames in os.walk(src_dir):
        # 排除隐藏目录（.git 等）
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fname in filenames:
            if fname == "_meta.json":
                continue  # _meta.json 由本脚本生成，不读取旧的
            full = os.path.join(dirpath, fname)
            rel = os.path.relpath(full, src_dir).replace("\\", "/")
            files.append((full, rel))
    return sorted(files, key=lambda x: x[1])


def pack_from_dir(src_dir: str, out_path: str) -> dict:
    """从源目录打包成 .sidemate。

    Returns: 打包结果统计 dict
    """
    if not os.path.isdir(src_dir):
        raise FileNotFoundError("源目录不存在: %s" % src_dir)

    manifest_path = os.path.join(src_dir, "manifest.json")
    if not os.path.isfile(manifest_path):
        raise FileNotFoundError("源目录缺少 manifest.json: %s" % manifest_path)

    files = collect_files(src_dir)
    if not files:
        raise ValueError("源目录为空（无文件可打包）: %s" % src_dir)

    # 确保 manifest.json 在列表中（即使 walk 顺序问题）
    rel_paths = [rel for _, rel in files]
    if "manifest.json" not in rel_paths:
        files.append((manifest_path, "manifest.json"))

    print("[PACK] 源目录: %s" % src_dir)
    print("[PACK] 输出: %s" % out_path)
    print("[PACK] 文件数: %d" % len(files))

    # 计算每个文件的 SHA256（GB 级文件耗时，显示进度）
    file_hashes = {}
    total_size = 0
    for i, (full, rel) in enumerate(files, 1):
        size = os.path.getsize(full)
        total_size += size
        size_mb = size / 1024 / 1024
        if size_mb > 10:
            print("[PACK]   [%d/%d] SHA256 %s (%.1f MB)..." % (i, len(files), rel[:50], size_mb))
        sha = compute_sha256(full)
        # manifest.json 自身不写入 file_hashes（validator 不校验 manifest.json）
        if rel != "manifest.json":
            file_hashes[rel] = sha

    # 生成 _meta.json
    meta = {
        "file_hashes": file_hashes,
        "packed_at": datetime.now().isoformat(),
        "tool": "pack_sidemate.py v2",
        "file_count": len(files),
        "total_bytes": total_size,
    }

    # 写入 .sidemate（ZIP）
    # 对 GB 级文件用 ZIP_STORED（不压缩，模型文件压缩率低且耗时）
    out_dir = os.path.dirname(out_path)
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    print("[PACK] 写入 .sidemate (ZIP_STORED, 无压缩)...")
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_STORED) as zf:
        # 先写 manifest.json（惯例：放第一个）
        zf.write(manifest_path, "manifest.json")
        # 写 _meta.json
        zf.writestr("_meta.json", json.dumps(meta, ensure_ascii=False, indent=2))
        # 写其余文件（跳过 manifest.json，已写过）
        for full, rel in files:
            if rel == "manifest.json":
                continue
            zf.write(full, rel)

    out_size = os.path.getsize(out_path)
    print("[PACK] ✅ 打包完成")
    print("[PACK]    输出大小: %.2f GB (%d bytes)" % (out_size / 1024**3, out_size))
    print("[PACK]    文件数: %d，校验 hash 数: %d" % (len(files), len(file_hashes)))
    print("[PACK]    _meta.json 已生成（含 file_hashes）")

    return {
        "out_path": out_path,
        "out_size": out_size,
        "file_count": len(files),
        "hash_count": len(file_hashes),
    }


def repack_existing(sidemate_path: str) -> str:
    """重打现有 .sidemate 包：解压到临时目录 → 补 _meta.json → 重新打包。

    输出文件名加 .v2 后缀，避免覆盖原包。
    Returns: 新包路径
    """
    import tempfile
    import shutil

    if not os.path.isfile(sidemate_path):
        raise FileNotFoundError("包不存在: %s" % sidemate_path)

    print("[REPACK] 重打: %s" % sidemate_path)
    tmp_dir = tempfile.mkdtemp(prefix="sidemate_repack_")
    try:
        with zipfile.ZipFile(sidemate_path, "r") as zf:
            zf.extractall(tmp_dir)

        # 输出路径：原路径加 .v2 后缀
        base, ext = os.path.splitext(sidemate_path)
        out_path = base + ".v2" + ext
        pack_from_dir(tmp_dir, out_path)
        return out_path
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        print("[REPACK] 临时目录已清理")


def main():
    parser = argparse.ArgumentParser(
        description="打包 .sidemate 扩展包（v2，SHA256 完整性校验）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例：
  # 从源目录打包
  python pack_sidemate.py --dir ./my_model --out ./my_model.sidemate

  # 重打现有包，补 _meta.json（输出加 .v2 后缀）
  python pack_sidemate.py --repack output/extensions/sidemate-llm-qwen3.5-4b-v1.0.0.sidemate
        """,
    )
    parser.add_argument("--dir", help="源目录（含 manifest.json + 模型文件）")
    parser.add_argument("--out", help="输出 .sidemate 路径（--dir 模式必填）")
    parser.add_argument("--repack", help="重打现有 .sidemate 包，补 _meta.json")
    args = parser.parse_args()

    try:
        if args.repack:
            new_path = repack_existing(args.repack)
            print("\n[完成] 新包: %s" % new_path)
        elif args.dir:
            if not args.out:
                parser.error("--dir 模式需要 --out 参数")
            result = pack_from_dir(args.dir, args.out)
            print("\n[完成] 新包: %s" % result["out_path"])
        else:
            parser.error("需要 --dir 或 --repack 参数")
    except Exception as e:
        print("\n[错误] %s" % e, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

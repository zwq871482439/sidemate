"""
make_snapshot.py — ISS 安装后脚本：压缩 site-packages 为初始备份

用法：
    python make_snapshot.py <install_dir>

功能：
    将 <install_dir>/python/Lib/site-packages/ 压缩为
    <install_dir>/backup/site_packages.zip

    使用 ZIP_DEFLATED 压缩，跳过 __pycache__、*.pyc、*.pyo、.dist-info
"""

import os
import sys
import zipfile

# 需要跳过的目录/文件后缀
SKIP_DIRS = {"__pycache__"}
SKIP_SUFFIXES = (".pyc", ".pyo")
SKIP_DIR_SUFFIX = ".dist-info"


def make_snapshot(install_dir: str):
    site_packages = os.path.join(install_dir, "python", "Lib", "site-packages")
    backup_dir = os.path.join(install_dir, "backup")
    snapshot_path = os.path.join(backup_dir, "site_packages.zip")

    if not os.path.isdir(site_packages):
        print(f"[make_snapshot] site-packages 不存在: {site_packages}")
        sys.exit(1)

    os.makedirs(backup_dir, exist_ok=True)

    print(f"[make_snapshot] 压缩 {site_packages} -> {snapshot_path}")

    count = 0
    with zipfile.ZipFile(snapshot_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for root, dirs, files in os.walk(site_packages):
            # 跳过 __pycache__
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.endswith(SKIP_DIR_SUFFIX)]

            for f in files:
                if f.endswith(SKIP_SUFFIXES):
                    continue
                filepath = os.path.join(root, f)
                arcname = os.path.relpath(filepath, site_packages)
                zf.write(filepath, arcname)
                count += 1
                if count % 500 == 0:
                    print(f"  已压缩 {count} 个文件...")

    size_mb = os.path.getsize(snapshot_path) / (1024 * 1024)
    print(f"[make_snapshot] 完成！共 {count} 个文件，压缩后 {size_mb:.1f} MB")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python make_snapshot.py <install_dir>")
        sys.exit(1)
    make_snapshot(sys.argv[1])

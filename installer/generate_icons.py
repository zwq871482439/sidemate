#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
generate_icons.py — 品牌图标批量生成工具
==========================================
从 logo.jpg（或 logo.svg）生成多尺寸 PNG + 多尺寸 favicon.ico。

用法：
    python installer/generate_icons.py

产出文件（输出到 server/static/img/）：
    - icon-16.png     16x16   任务栏 / 标签 favicon
    - icon-32.png     32x32   标准 favicon
    - icon-48.png     48x48   Windows 小图标
    - icon-256.png    256x256 Windows 大图标 / apple-touch-icon
    - favicon.ico     多尺寸（16/32/48）ICO 文件

Patch5 C3（T01.1.1）：品牌视觉全套。
"""

import os
import sys
import logging

from PIL import Image

# ===== 日志配置 =====
logging.basicConfig(level=logging.INFO, format="[ICON] %(message)s")
log = logging.getLogger(__name__)

# ===== 路径常量 =====
# 脚本所在目录：installer/
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
# 项目根目录：C:\Sidemate
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
# 图片输出目录
IMG_DIR = os.path.join(PROJECT_DIR, "server", "static", "img")

# 源 logo 文件（优先 jpg，回退 svg 但 Pillow 不支持 svg 渲染）
LOGO_JPG = os.path.join(IMG_DIR, "logo.jpg")
LOGO_SVG = os.path.join(IMG_DIR, "logo.svg")

# 需要生成的 PNG 尺寸列表
PNG_SIZES = [16, 32, 48, 256]

# ICO 内嵌的尺寸
ICO_SIZES = [(16, 16), (32, 32), (48, 48)]

# LANCZOS = 高质量重采样滤镜（Pillow >= 9.1 使用 Image.LANCZOS，旧版 Image.ANTIALIAS）
RESAMPLE_FILTER = Image.LANCZOS


def find_source_image():
    """查找可用的源 logo 图片。

    优先使用 logo.jpg（位图，Pillow 原生支持）。
    如果只有 logo.svg，Pillow 无法直接渲染，需要 cairosvg。

    Returns:
        str: 源图片绝对路径
    Raises:
        FileNotFoundError: 找不到任何可用的源图片
    """
    if os.path.isfile(LOGO_JPG):
        return LOGO_JPG
    if os.path.isfile(LOGO_SVG):
        log.warning("logo.jpg 不存在，尝试用 cairosvg 渲染 logo.svg...")
        return LOGO_SVG
    raise FileNotFoundError(
        "找不到源 logo 图片（logo.jpg 或 logo.svg），请确认文件存在于: %s" % IMG_DIR
    )


def load_source_image(path: str) -> Image.Image:
    """加载源图片并转换为 RGBA 模式。

    Pillow 不支持 SVG。如果传入 SVG，尝试用 cairosvg 渲染为位图。

    Args:
        path: 源图片路径

    Returns:
        PIL.Image: RGBA 模式的图片对象

    Raises:
        RuntimeError: SVG 渲染失败或图片加载失败
    """
    if path.lower().endswith(".svg"):
        try:
            import cairosvg  # 延迟导入，避免未安装时报错
        except ImportError:
            raise RuntimeError(
                "logo.svg 需要 cairosvg 才能渲染，请 pip install cairosvg，"
                "或提供 logo.jpg 作为源图片"
            )
        # 渲染为高分辨率 PNG 内存流
        import io
        png_bytes = cairosvg.svg2png(url=path, output_width=512, output_height=512)
        img = Image.open(io.BytesIO(png_bytes))
    else:
        img = Image.open(path)

    # 统一转为 RGBA（带 alpha 通道），确保 resize 和 save 一致
    if img.mode != "RGBA":
        img = img.convert("RGBA")

    log.info("源图片: %s (%s %dx%d)", os.path.basename(path), img.mode, img.width, img.height)
    return img


def generate_png_icons(img: Image.Image) -> list:
    """生成多尺寸 PNG 图标。

    Args:
        img: 源 PIL.Image 对象（RGBA）

    Returns:
        list: 生成的文件路径列表
    """
    generated = []
    for size in PNG_SIZES:
        resized = img.resize((size, size), RESAMPLE_FILTER)
        out_path = os.path.join(IMG_DIR, "icon-%d.png" % size)
        resized.save(out_path, "PNG", optimize=True)
        generated.append(out_path)
        log.info("  ✓ icon-%d.png (%dx%d)", size, size, size)
    return generated


def generate_favicon(img: Image.Image) -> str:
    """生成多尺寸 favicon.ico。

    将源图片分别缩放到 16/32/48 并保存为单个 ICO 文件。

    Args:
        img: 源 PIL.Image 对象（RGBA）

    Returns:
        str: favicon.ico 文件路径
    """
    ico_path = os.path.join(IMG_DIR, "favicon.ico")
    # Pillow 的 ICO 格式支持 sizes 参数指定多尺寸
    img.save(
        ico_path,
        format="ICO",
        sizes=ICO_SIZES,
    )
    log.info("  ✓ favicon.ico (sizes: %s)", ", ".join("%dx%d" % s for s in ICO_SIZES))
    return ico_path


def main() -> int:
    """主入口：生成所有图标文件。

    Returns:
        int: 退出码（0=成功，1=失败）
    """
    log.info("=== 品牌图标生成工具 (Patch5 T01.1.1) ===")
    log.info("输出目录: %s", IMG_DIR)

    # 确保输出目录存在
    os.makedirs(IMG_DIR, exist_ok=True)

    try:
        source_path = find_source_image()
        img = load_source_image(source_path)
    except (FileNotFoundError, RuntimeError) as e:
        log.error("加载源图片失败: %s", e)
        return 1
    except Exception as e:
        log.error("加载图片时发生异常: %s", e)
        return 1

    # 生成 PNG
    log.info("生成 PNG 图标...")
    png_files = generate_png_icons(img)

    # 生成 favicon.ico
    log.info("生成 favicon.ico...")
    ico_file = generate_favicon(img)

    log.info("=== 完成 ===")
    log.info("共生成 %d 个 PNG + 1 个 ICO", len(png_files))
    for f in png_files + [ico_file]:
        size_kb = os.path.getsize(f) / 1024.0
        log.info("  %s (%.1f KB)", os.path.basename(f), size_kb)

    return 0


if __name__ == "__main__":
    sys.exit(main())

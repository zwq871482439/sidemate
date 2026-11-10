"""拼桌伴的 icon.ico（米白方块里一条墨色小岛）。

一次性拼图脚本，不进产品依赖；跑法：python build/make-icon.py
- 16 / 24 / 32 / 256 四档直接用 build/icon-src/ 里设计师对齐过像素的 PNG；
- 48 从 icon-256.png 用 LANCZOS 缩；
- 写到 build/icon.ico，再原样拷一份到 app/assets/icon.ico（两份是同一个文件）。

拼完读回来核：五个尺寸都在，16/24/32/256 每档像素跟源 PNG 一致，
48 跟「icon-256.png LANCZOS 缩到 48」一致。以后换图标照着改 SRC 里的文件再跑。
"""
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
SRC = HERE / "icon-src"
OUT = HERE / "icon.ico"
RUNTIME_OUT = HERE.parent / "app" / "assets" / "icon.ico"

DIRECT = (16, 24, 32, 256)  # 用源 PNG 原样放进 ico
FROM_256 = (48,)  # 从 icon-256.png 用 LANCZOS 缩出来
SIZES = [(s, s) for s in (*DIRECT, *FROM_256)]  # ico 里五个尺寸，按小到大


def load(size):
    im = Image.open(SRC / f"icon-{size}.png")
    assert im.mode == "RGBA" and im.size == (size, size), (size, im.mode, im.size)
    return im.copy()


def build():
    frames = {s: load(s) for s in DIRECT}
    big = frames[256]
    for s in FROM_256:
        frames[s] = big.resize((s, s), Image.LANCZOS)
    # Pillow 的 ICO 保存：sizes 列出要写的档，append_images 里尺寸对得上的原样用，
    # 对不上的才会从底图缩；底图给 256，五档全都有现成帧。
    big.save(OUT, format="ICO", sizes=SIZES, append_images=[frames[s] for s in (16, 24, 32, 48)])
    return frames


def verify(frames):
    ico = Image.open(OUT)
    got = sorted(w for (w, h) in ico.info["sizes"] if w == h)
    assert got == [16, 24, 32, 48, 256], f"ico 里的尺寸不对: {got}"
    for size in (*DIRECT, *FROM_256):
        ico.size = (size, size)
        ico.load()
        back = ico.copy()
        assert back.mode == "RGBA" and back.size == (size, size), (size, back.mode, back.size)
        assert back.tobytes() == frames[size].tobytes(), f"{size} 档像素跟源不一致"
    print(f"读回核对通过：五档 {'/'.join(str(s) for s in got)}，像素逐档一致（48 对 LANCZOS 源）")


def main():
    frames = build()
    verify(frames)
    RUNTIME_OUT.write_bytes(OUT.read_bytes())
    import hashlib
    digest = hashlib.sha256(OUT.read_bytes()).hexdigest()
    print(f"写出 {OUT} 和 {RUNTIME_OUT}（同一份），SHA-256 {digest}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()

# -*- coding: utf-8 -*-
"""数据备份/恢复 API — 导出/导入聊天记录、设置、文库元数据"""
import os, json, io, time, logging, zipfile, glob as _glob
from datetime import datetime
from fastapi import APIRouter, UploadFile, File
from fastapi.responses import StreamingResponse
from config import CHAT_DIR, DATA_DIR, ROOT_DIR

router = APIRouter()
log = logging.getLogger(__name__)

# 文库元数据可能的位置（优先 documents.json，其次 kb_meta.json）
_KB_META_CANDIDATES = [
    os.path.join(DATA_DIR, "kb", "documents.json"),
    os.path.join(DATA_DIR, "kb", "kb_meta.json"),
]


def _is_unsafe_zip_name(name: str) -> bool:
    """检查 ZIP 条目名是否包含路径穿越或危险形式（覆盖 POSIX / Windows / UNC / null byte）。

    返回 True 表示危险应跳过。用于备份恢复阶段逐条校验。
    """
    if not name or "\x00" in name:
        return True
    # 规范化分隔符后按组件检查 ..
    norm = name.replace("\\", "/")
    for part in norm.split("/"):
        if part == "..":
            return True
    # POSIX 绝对路径
    if name.startswith("/"):
        return True
    # Windows 盘符绝对路径（C:\ / C:/）或 UNC（\\server\...）
    if len(name) >= 2 and name[1] == ":":
        return True
    if name.startswith("\\\\"):
        return True
    return False


def _find_kb_meta() -> str | None:
    """查找文库元数据文件路径，不存在则返回 None"""
    for path in _KB_META_CANDIDATES:
        if os.path.isfile(path):
            return path
    return None


@router.post("/api/backup/export")
def export_backup():
    """导出备份：将聊天记录、设置、文库元数据打包为 ZIP 流式返回

    ZIP 结构:
      chats/            — 所有聊天 .json 文件
      settings.json     — 全局设置
      kb_meta/          — 文库元数据（如有）
      backup_meta.json  — 备份元信息（版本、时间、聊天数）
    """
    buf = io.BytesIO()
    chat_count = 0

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # 1) 聊天记录
        if os.path.isdir(CHAT_DIR):
            for fname in sorted(os.listdir(CHAT_DIR)):
                if fname.endswith(".json"):
                    fpath = os.path.join(CHAT_DIR, fname)
                    zf.write(fpath, os.path.join("chats", fname))
                    chat_count += 1

        # 2) 设置
        settings_path = os.path.join(DATA_DIR, "settings.json")
        if os.path.isfile(settings_path):
            zf.write(settings_path, "settings.json")

        # 3) 文库元数据
        kb_meta_path = _find_kb_meta()
        kb_meta_included = False
        if kb_meta_path:
            zf.write(kb_meta_path, os.path.join("kb_meta", os.path.basename(kb_meta_path)))
            kb_meta_included = True

        # 4) 备份元信息
        meta = {
            "version": "0.9.4",
            "created_at": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
            "chat_count": chat_count,
            "kb_meta_included": kb_meta_included,
        }
        zf.writestr("backup_meta.json", json.dumps(meta, ensure_ascii=False, indent=2))

    buf.seek(0)
    filename = "sidemate-backup-%s.zip" % datetime.now().strftime("%Y%m%d")
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="%s"' % filename},
    )


@router.post("/api/backup/import")
async def import_backup(file: UploadFile = File(...)):
    """导入备份：从 ZIP 文件恢复聊天记录、设置、文库元数据

    安全措施:
      - 验证 ZIP 格式
      - 防路径穿越（禁止 .. 和绝对路径）
      - 设置采用合并不覆盖策略
    """
    content = await file.read()

    # 验证 ZIP 格式
    if not content[:4] == b"PK\x03\x04" and not content[:4] == b"PK\x05\x06":
        return {"ok": False, "error": "无效的 ZIP 文件"}

    buf = io.BytesIO(content)
    restored_chats = 0
    restored_settings = False
    restored_kb_meta = False

    try:
        with zipfile.ZipFile(buf, "r") as zf:
            for info in zf.infolist():
                # 跳过目录
                if info.is_dir():
                    continue

                name = info.filename

                # 防路径穿越：禁止 .. / 绝对路径 / UNC / null byte（覆盖 Windows）
                if _is_unsafe_zip_name(name):
                    log.warning("[BACKUP] 跳过可疑路径: %s" % name)
                    continue

                # 恢复聊天记录
                if name.startswith("chats/") and name.endswith(".json"):
                    dest = os.path.join(CHAT_DIR, os.path.basename(name))
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                    with zf.open(info) as src, open(dest, "wb") as dst:
                        dst.write(src.read())
                    restored_chats += 1

                # 恢复设置（合并不覆盖已有 key）
                elif name == "settings.json":
                    try:
                        incoming = json.loads(zf.read(info).decode("utf-8"))
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        log.warning("[BACKUP] settings.json 解析失败，跳过")
                        continue

                    settings_path = os.path.join(DATA_DIR, "settings.json")
                    existing = {}
                    if os.path.isfile(settings_path):
                        try:
                            with open(settings_path, "r", encoding="utf-8") as f:
                                existing = json.load(f)
                        except Exception:
                            existing = {}

                    # 合并：已有 key 保留原值，仅补充新 key
                    changed = False
                    for k, v in incoming.items():
                        if k not in existing:
                            existing[k] = v
                            changed = True

                    if changed:
                        with open(settings_path, "w", encoding="utf-8") as f:
                            json.dump(existing, f, ensure_ascii=False, indent=2)
                    restored_settings = True

                # 恢复文库元数据
                elif name.startswith("kb_meta/"):
                    kb_dir = os.path.join(DATA_DIR, "kb")
                    os.makedirs(kb_dir, exist_ok=True)
                    dest = os.path.join(kb_dir, os.path.basename(name))
                    with zf.open(info) as src, open(dest, "wb") as dst:
                        dst.write(src.read())
                    restored_kb_meta = True

    except zipfile.BadZipFile:
        return {"ok": False, "error": "损坏的 ZIP 文件"}
    except Exception as e:
        log.error("[BACKUP] 导入失败: %s" % str(e))
        return {"ok": False, "error": str(e)}

    return {
        "ok": True,
        "restored": {
            "chats": restored_chats,
            "settings": restored_settings,
            "kb_meta": restored_kb_meta,
        },
    }

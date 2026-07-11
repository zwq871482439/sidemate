# -*- coding: utf-8 -*-
"""ModelRegistry — 模型注册表：扫描 models/ 下的 meta.json

P7-4 底座替换：替代 Ollama 的 /api/tags 模型发现机制。
llama.cpp 不维护模型列表，我们用本地 meta.json 注册表管理。

meta.json schema：
{
  "model_id": "qwen3.5-4b-q4",
  "display_name": "通义千问 3.5 (4B · Q4_K_M)",
  "size_b": 4,
  "quant": "Q4_K_M",
  "gguf_filename": "Qwen3.5-4B-Q4_K_M.gguf",
  "gguf_size_bytes": 2740937888,
  "download": {"source":"modelscope","repo_id":"...","filename":"..."},
  "requirements": {"min_ram_gb":8,"min_vram_gb":0,"recommended_vram_gb":6},
  "default_num_ctx": 8192,
  "supports_think": true,
  "multimodal": false
}
"""
import json
import logging
from pathlib import Path
from typing import Optional, List, Dict

log = logging.getLogger(__name__)


class ModelInfo:
    """单个模型的元数据"""

    def __init__(self, meta: dict, model_dir: Path):
        self._meta = meta
        self._dir = model_dir

    @property
    def model_id(self) -> str:
        return self._meta["model_id"]

    @property
    def display_name(self) -> str:
        return self._meta.get("display_name", self.model_id)

    @property
    def gguf_path(self) -> Path:
        return self._dir / self._meta["gguf_filename"]

    @property
    def gguf_filename(self) -> str:
        return self._meta["gguf_filename"]

    @property
    def gguf_exists(self) -> bool:
        return self.gguf_path.exists()

    @property
    def gguf_size_bytes(self) -> int:
        return self._meta.get("gguf_size_bytes", 0)

    @property
    def size_b(self) -> float:
        return self._meta.get("size_b", 0)

    @property
    def quant(self) -> str:
        return self._meta.get("quant", "Q4_K_M")

    @property
    def default_num_ctx(self) -> int:
        return self._meta.get("default_num_ctx", 8192)

    @property
    def min_ram_gb(self) -> int:
        return self._meta.get("requirements", {}).get("min_ram_gb", 8)

    @property
    def min_vram_gb(self) -> int:
        return self._meta.get("requirements", {}).get("min_vram_gb", 0)

    @property
    def recommended_vram_gb(self) -> int:
        return self._meta.get("requirements", {}).get("recommended_vram_gb", 0)

    @property
    def supports_think(self) -> bool:
        return self._meta.get("supports_think", False)

    @property
    def download_info(self) -> dict:
        return self._meta.get("download", {})

    def to_dict(self) -> dict:
        """导出为可序列化的 dict（含 gguf 是否存在）"""
        d = dict(self._meta)
        d["gguf_path"] = str(self.gguf_path)
        d["gguf_exists"] = self.gguf_exists
        return d


class ModelRegistry:
    """模型注册表：扫描并管理所有 meta.json"""

    def __init__(self, models_root):
        self._root = Path(models_root)
        self._models: Dict[str, ModelInfo] = {}
        self._scanned = False

    def scan(self) -> List[ModelInfo]:
        """扫描 models/ 下所有子目录的 meta.json"""
        self._models.clear()
        self._scanned = True
        if not self._root.exists():
            log.warning("[REGISTRY] models 目录不存在: %s" % self._root)
            return []

        # P7-4 BP-2: 一次性迁移 Ollama blob → meta.json（检测到旧格式自动转换）
        self._migrate_ollama_blobs()

        for sub in sorted(self._root.iterdir()):
            if not sub.is_dir():
                continue
            meta_path = sub / "meta.json"
            if not meta_path.exists():
                continue
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                info = ModelInfo(meta, sub)
                self._models[info.model_id] = info
                log.info("[REGISTRY] 加载模型: %s (gguf=%s, %sB)" % (
                    info.model_id, info.gguf_exists, info.size_b))
            except Exception as e:
                log.warning("[REGISTRY] 跳过 %s: %s" % (sub.name, str(e)[:80]))

        return list(self._models.values())

    def _migrate_ollama_blobs(self):
        """P7-4 BP-2: 一次性迁移 Ollama blob/manifest → GGUF + meta.json

        检测 models/manifests/registry.ollama.ai/library/*/latest，
        把 model layer 的 blob 硬链接为 models/<model_id>/model.gguf，
        生成 meta.json。迁移完写 .migrated 标记避免重复执行。
        """
        import shutil

        manifests_dir = self._root / "manifests" / "registry.ollama.ai" / "library"
        if not manifests_dir.exists():
            return  # 不是 Ollama 格式，无需迁移

        # 已迁移标记
        marker = self._root / ".ollama_migrated"
        if marker.exists():
            return

        blobs_dir = self._root / "blobs"
        if not blobs_dir.exists():
            return

        log.info("[REGISTRY] 检测到 Ollama blob 格式模型，开始迁移...")
        migrated = 0

        for model_dir in sorted(manifests_dir.iterdir()):
            if not model_dir.is_dir():
                continue
            manifest_path = model_dir / "latest"
            if not manifest_path.exists():
                continue

            try:
                with open(manifest_path, "r", encoding="utf-8") as f:
                    manifest = json.load(f)

                # 找 model layer（mediaType 含 .model）
                model_digest = None
                model_size = 0
                for layer in manifest.get("layers", []):
                    if "image.model" in layer.get("mediaType", ""):
                        model_digest = layer.get("digest", "").replace("sha256:", "")
                        model_size = layer.get("size", 0)
                        break

                if not model_digest:
                    continue

                # blob 文件路径
                blob_path = blobs_dir / ("sha256-" + model_digest)
                if not blob_path.exists():
                    log.warning("[REGISTRY] blob 不存在: %s" % blob_path)
                    continue

                # 从模型名推断信息
                model_name = model_dir.name  # 如 "qwen3-5-4b"
                model_id = model_name
                # 推断参数量和量化
                size_b, quant, display_name = self._infer_model_info(model_name, model_size)

                # 创建目标目录
                target_dir = self._root / model_id
                target_dir.mkdir(parents=True, exist_ok=True)
                gguf_path = target_dir / (display_name.replace(" ", "_") + ".gguf")

                # 硬链接（零拷贝）；失败则复制
                if not gguf_path.exists():
                    try:
                        os.link(str(blob_path), str(gguf_path))
                        log.info("[REGISTRY] 硬链接: %s → %s" % (blob_path.name, gguf_path.name))
                    except OSError:
                        shutil.copy2(str(blob_path), str(gguf_path))
                        log.info("[REGISTRY] 复制: %s → %s" % (blob_path.name, gguf_path.name))

                # 生成 meta.json
                meta = {
                    "model_id": model_id,
                    "display_name": display_name,
                    "size_b": size_b,
                    "quant": quant,
                    "gguf_filename": gguf_path.name,
                    "gguf_size_bytes": model_size,
                    "download": {"source": "migrated_from_ollama", "repo_id": "", "filename": ""},
                    "requirements": {"min_ram_gb": 8, "min_vram_gb": 0, "recommended_vram_gb": 6},
                    "default_num_ctx": 8192,
                    "supports_think": size_b >= 2,
                    "multimodal": False,
                }
                meta_path = target_dir / "meta.json"
                with open(meta_path, "w", encoding="utf-8") as f:
                    json.dump(meta, f, ensure_ascii=False, indent=2)

                migrated += 1
                log.info("[REGISTRY] 迁移完成: %s → %s (%.1fGB)" % (
                    model_name, gguf_path.name, model_size / 1024**3))

            except Exception as e:
                log.warning("[REGISTRY] 迁移 %s 失败: %s" % (model_dir.name, str(e)[:100]))

        # 写迁移标记
        try:
            marker.write_text("migrated %d models at %s" % (migrated, str(__import__("datetime").datetime.now())))
        except Exception:
            pass

        if migrated > 0:
            log.info("[REGISTRY] Ollama → llama.cpp 迁移完成: %d 个模型" % migrated)

    @staticmethod
    def _infer_model_info(model_name, model_size_bytes):
        """从模型名和文件大小推断参数量、量化等级、显示名"""
        name_lower = model_name.lower()
        # 推断参数量
        size_b = 4  # 默认
        if "0.5b" in name_lower or "0.6b" in name_lower:
            size_b = 0.5
        elif "0.8b" in name_lower:
            size_b = 0.8
        elif "1.5b" in name_lower:
            size_b = 1.5
        elif "1.7b" in name_lower:
            size_b = 1.7
        elif "2b" in name_lower:
            size_b = 2
        elif "4b" in name_lower:
            size_b = 4
        elif "7b" in name_lower:
            size_b = 7
        elif "8b" in name_lower:
            size_b = 8
        elif "14b" in name_lower:
            size_b = 14

        # 从文件大小推断量化（粗略）
        quant = "Q4_K_M"
        size_gb = model_size_bytes / 1024**3
        if size_b > 0:
            gb_per_b = size_gb / size_b
            if gb_per_b > 0.9:
                quant = "Q8_0"
            elif gb_per_b > 0.7:
                quant = "Q6_K"
            elif gb_per_b > 0.5:
                quant = "Q5_K_M"
            else:
                quant = "Q4_K_M"

        # 显示名
        display_name = model_name.replace("-", " ").replace("qwen", "Qwen").replace("Qwen3 5", "Qwen3.5")
        # 更友好的格式
        if "qwen" in name_lower and "3" in name_lower and "5" in name_lower:
            display_name = "Qwen3.5 %sB" % str(size_b).replace(".0", "")
        display_name = "%s (%sB · %s)" % (display_name.split(" (")[0], size_b, quant)

        return size_b, quant, display_name

    def list_available(self) -> List[ModelInfo]:
        """返回 GGUF 已下载的模型（可立即启动）"""
        if not self._scanned:
            self.scan()
        return [m for m in self._models.values() if m.gguf_exists]

    def list_all(self) -> List[ModelInfo]:
        """返回所有 meta.json 中定义的模型（含未下载的）"""
        if not self._scanned:
            self.scan()
        return list(self._models.values())

    def get(self, model_id: str) -> Optional[ModelInfo]:
        """按 ID 查询"""
        if not self._scanned:
            self.scan()
        return self._models.get(model_id)

    def recommend(self, vram_gb: float = 0, ram_gb: float = 0) -> Optional[ModelInfo]:
        """根据硬件推荐模型：选满足要求的最大模型"""
        if not self._scanned:
            self.scan()
        candidates = []
        for m in self.list_available():
            if vram_gb >= m.min_vram_gb and ram_gb >= m.min_ram_gb:
                candidates.append(m)
        if not candidates:
            return None
        candidates.sort(key=lambda m: m.size_b, reverse=True)
        return candidates[0]

    def add_meta(self, model_dir: Path, meta: dict) -> ModelInfo:
        """写入 meta.json 并注册（安装新模型时用）"""
        model_dir = Path(model_dir)
        model_dir.mkdir(parents=True, exist_ok=True)
        meta_path = model_dir / "meta.json"
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        info = ModelInfo(meta, model_dir)
        self._models[info.model_id] = info
        log.info("[REGISTRY] 注册新模型: %s" % info.model_id)
        return info

    def remove(self, model_id: str) -> bool:
        """删除模型 GGUF 文件（释放磁盘），保留 meta.json（用户可重新下载）"""
        info = self._models.get(model_id)
        if not info:
            return False
        try:
            if info.gguf_path.exists():
                info.gguf_path.unlink()
            # 保留 meta.json：catalog 的 list_all() 仍能列出此模型（显示"未安装"），
            # 用户可在下载页点「下载」重新下载恢复。
            # 删 .part 临时文件（如果断点续传中断留下的）
            part_path = info.gguf_path.with_suffix(info.gguf_path.suffix + ".part")
            if part_path.exists():
                part_path.unlink()
        except Exception as e:
            log.warning("[REGISTRY] 删除模型文件失败 %s: %s" % (model_id, str(e)[:80]))
        # 注意：不从 _models 弹出——meta.json 还在，scan() 下次仍会加载它（gguf_exists=False）
        return True

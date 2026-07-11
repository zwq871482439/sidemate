# -*- coding: utf-8 -*-
"""
Patch4 v3.1：向量库迁移脚本 bge-base-zh-v1.5 → bge-m3
- 备份旧向量索引
- 删除旧索引，触发 ops.py 自动重建（维度不匹配自动清除）
- 验证重建成功
"""
import os, sys, shutil, time

PROJECT_DIR = r"C:\Sidemate"
KB_DATA_DIR = os.path.join(PROJECT_DIR, "server", "knowledge", "data", "kb")
VECTORS_PATH = os.path.join(KB_DATA_DIR, "kb_vectors.npz")

def main():
    print("=" * 60)
    print("BGE-M3 向量库迁移")
    print("=" * 60)

    # 1. 检查旧向量索引
    if os.path.exists(VECTORS_PATH):
        import numpy as np
        old_npz = np.load(VECTORS_PATH)
        old_vecs = old_npz["vectors"]
        print("\n[1/3] 旧向量索引：")
        print("  路径:", VECTORS_PATH)
        print("  shape:", old_vecs.shape)
        print("  维度:", old_vecs.shape[1], "(bge-base-zh-v1.5 = 768)")

        # 2. 备份
        backup_path = VECTORS_PATH + ".bak_bge-base-zh"
        if not os.path.exists(backup_path):
            shutil.copy2(VECTORS_PATH, backup_path)
            print("\n[2/3] 备份完成:", backup_path)
        else:
            print("\n[2/3] 备份已存在，跳过:", backup_path)

        # 3. 删除旧索引（ops.py 会自动用 bge-m3 重建）
        os.remove(VECTORS_PATH)
        print("\n[3/3] 已删除旧索引，下次启动 KB 服务会自动用 bge-m3 重建")
        print("  新维度: 1024 (bge-m3)")
    else:
        print("\n向量索引文件不存在，无需迁移（可能是首次启动）")

    # 验证模型文件
    print("\n" + "-" * 40)
    print("模型文件验证：")
    emb_dir = os.path.join(PROJECT_DIR, "models", "embedding")
    rnk_dir = os.path.join(PROJECT_DIR, "models", "reranker")
    for name, path in [("Embedding (bge-m3)", emb_dir), ("Reranker (v2-m3)", rnk_dir)]:
        cfg = os.path.join(path, "config.json")
        if os.path.exists(cfg):
            import json
            with open(cfg, 'r') as f:
                c = json.load(f)
            print("  %s: %s (hidden=%s, max_pos=%s)" % (
                name, c.get("architectures", ["?"])[0],
                c.get("hidden_size"), c.get("max_position_embeddings")))
        else:
            print("  %s: config.json 缺失!" % name)

    # 配置验证
    print("\n配置验证：")
    sys.path.insert(0, os.path.join(PROJECT_DIR, "server"))
    os.chdir(os.path.join(PROJECT_DIR, "server"))
    try:
        from config import get as _cfg
        print("  kb_embedding_model:", _cfg("kb_embedding_model"))
        print("  kb_vector_dim:", _cfg("kb_vector_dim"))
    except Exception as e:
        print("  配置加载失败:", e)

    print("\n" + "=" * 60)
    print("迁移准备完成！")
    print("=" * 60)
    print("\n下一步：重启 Sidemate.exe")
    print("启动时 KB 服务会自动：")
    print("  1. 加载 bge-m3 embedder")
    print("  2. 发现向量索引缺失")
    print("  3. 用 bge-m3 对所有 chunks 重新 embedding")
    print("  4. 保存新的 kb_vectors.npz (1024 维)")
    print("\n预计耗时：40 篇文档 × 122 chunks ≈ 1-2 分钟")

if __name__ == "__main__":
    main()

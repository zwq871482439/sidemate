# -*- coding: utf-8 -*-
"""
Patch4 v3.1：向量库重建脚本
单独运行，生成 kb_vectors.npz，服务启动时直接读取，不阻塞启动。

用法：
  C:\Sidemate\python\python.exe C:\Sidemate\rebuild_vectors.py

流程：
  1. 加载 bge-m3 embedder
  2. 读取所有 chunks 文本
  3. 分批 encoding（每批 8 个，避免内存爆）
  4. 保存 kb_vectors.npz（带 chunk_order 对齐）
  5. 验证检索效果
"""
import sys, os, time

# 切到 server 目录
PROJECT_DIR = r"C:\Sidemate"
SERVER_DIR = os.path.join(PROJECT_DIR, "server")
os.chdir(SERVER_DIR)
sys.path.insert(0, SERVER_DIR)

print("=" * 60)
print("Sidemate 向量库重建工具")
print("=" * 60)
print()

# 1. 加载 KB
print("[1/5] 初始化 KnowledgeBase...")
t0 = time.time()
from knowledge import get_knowledge_base
kb = get_knowledge_base()
print("  chunks: %d" % len(kb.chunks))
print("  vectors is None: %s" % (kb.vectors is None))

# 2. 加载 embedder
print("\n[2/5] 加载 embedder (bge-m3)...")
if not kb._embedder_loaded:
    kb.init_embedder()
if kb.embedder.mode != "bge":
    print("  ❌ embedder 模式=%s，无法重建" % kb.embedder.mode)
    sys.exit(1)
print("  embedder mode: %s" % kb.embedder.mode)
print("  vector_dim: %d" % kb.embedder.vector_dim)

# 3. 检查是否已有有效向量
if kb.vectors is not None and kb.vectors.shape[1] == kb.embedder.vector_dim:
    print("\n⚠️  向量索引已存在且维度匹配 (%s, dim=%d)" % (
        kb.vectors.shape, kb.vectors.shape[1]))
    print("   如要强制重建，请先删除 server/data/kb/kb_vectors.npz")
    ans = input("\n是否强制重建？(y/N): ").strip().lower()
    if ans != "y":
        print("取消")
        sys.exit(0)

# 4. 重建
print("\n[3/5] 开始重建向量索引...")
t1 = time.time()
chunk_ids = list(kb.chunks.keys())
texts = []
for cid in chunk_ids:
    c = kb.chunks.get(cid)
    texts.append(c.text if c and c.text else "")

total = len(texts)
print("  待 encoding: %d chunks" % total)

# 分批 encoding（每批 8 个，bge-m3 在 CPU 上较慢）
BATCH = 8
import numpy as np
all_vecs = []
for i in range(0, total, BATCH):
    batch = texts[i:i + BATCH]
    vecs = kb.embedder.encode(batch)
    if vecs is not None and len(vecs) > 0:
        all_vecs.append(vecs)
    done = min(i + BATCH, total)
    elapsed = time.time() - t1
    speed = done / max(elapsed, 0.1)
    eta = (total - done) / max(speed, 0.01)
    print("  [%d/%d] %.0fs elapsed, ETA %.0fs (%.1f chunks/s)" % (
        done, total, elapsed, eta, speed))

print("\n[4/5] 合并向量并保存...")
kb.vectors = np.vstack(all_vecs)
kb.chunk_order = chunk_ids
kb._save_vectors()
print("  ✅ 保存完成: %s" % kb.vectors_path)
print("  shape: %s" % str(kb.vectors.shape))
print("  耗时: %.1fs" % (time.time() - t1))

# 5. 验证检索
print("\n[5/5] 验证检索...")
test_queries = [
    "中医如何调养情绪和心态",
    "养生运动方法",
    "经络疏通",
]
for q in test_queries:
    results = kb.search(q, top_k=3)
    print("\n  query: %s" % q)
    if not results:
        print("    ❌ 无结果")
        continue
    for r in results[:3]:
        print("    - %.4f  %s" % (r.get("score", 0), r.get("source_label", "")[:50]))

print("\n" + "=" * 60)
print("✅ 向量库重建完成！")
print("=" * 60)
print("总耗时: %.1fs" % (time.time() - t0))
print()
print("现在重启 Sidemate.exe，服务会直接读取已生成的向量库，秒级启动。")

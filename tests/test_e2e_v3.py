# -*- coding: utf-8 -*-
"""
Sidemate Patch4 v3 自动化测试
模拟前端发送 chat stream 请求，捕获 SSE 事件，验证 v3 新设计。
"""
import sys, os, json, time, urllib.request, urllib.error

BASE = "http://127.0.0.1:8976"
CHAT_ID = "2026-06-17_004"
CHAT_FILE = "C:\\Sidemate\\server\\data\\chats\\%s" % CHAT_ID
TIMEOUT = 180  # 单次请求最多 3 分钟


def send_message(message, action_mode="chat"):
    """发送 chat stream 请求，返回 SSE 事件流（生成器）"""
    body = json.dumps({
        "message": message,
        "chat_file": CHAT_FILE,
        "action_mode": action_mode,
        "history": [],
        "model": None,
        "max_tokens": None,
        "file_path": None,
    }, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(
        BASE + "/api/chat/stream",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    start_ts = time.time()
    print(">>> 发送：%s（mode=%s）" % (message[:60], action_mode))
    print("    等待响应（最多 %d 秒）..." % TIMEOUT)

    try:
        resp = urllib.request.urlopen(req, timeout=TIMEOUT)
    except urllib.error.HTTPError as e:
        print("    HTTP Error %d: %s" % (e.code, e.reason))
        return
    except Exception as e:
        print("    请求失败：%s" % str(e)[:120])
        return

    events = []
    data_buf = ""

    for raw_line in resp:
        if time.time() - start_ts > TIMEOUT:
            print("    ⚠️ 超时")
            break

        line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")

        # Sidemate SSE 格式：data: {...}（无 event: 前缀）
        # 事件类型在 data 内的 type 字段
        if line.startswith("data:"):
            data_buf = line[5:].strip()
        elif line == "" and data_buf:
            # 事件边界（空行）
            if data_buf == "[DONE]":
                break
            try:
                data = json.loads(data_buf)
            except json.JSONDecodeError:
                data = {"raw": data_buf}
            # type 从 data 里取
            event_type = data.get("type", "unknown") if isinstance(data, dict) else "unknown"
            events.append({"type": event_type, "data": data})
            data_buf = ""

    elapsed = time.time() - start_ts
    print("    完成，耗时 %.1f 秒，收到 %d 个事件" % (elapsed, len(events)))
    return events


def analyze_events(events, label):
    """分析 SSE 事件流，打印关键事件"""
    print("\n" + "=" * 60)
    print("📊 %s 事件分析" % label)
    print("=" * 60)

    # 统计事件类型
    type_counts = {}
    for e in events:
        t = e["type"]
        type_counts[t] = type_counts.get(t, 0) + 1
    print("\n事件类型统计：")
    for t, c in sorted(type_counts.items()):
        print("  %-25s × %d" % (t, c))

    # 关键事件：工具调用
    print("\n工具调用记录：")
    for e in events:
        if e["type"] == "agent_status":
            d = e["data"]
            status = d.get("status", "")
            phase = d.get("phase", "")
            elapsed_ms = d.get("elapsed_ms")
            if status in ("searching", "fetching", "kb_searching",
                          "workspace_writing", "workspace_appending",
                          "workspace_editing", "workspace_listing",
                          "workspace_reading", "doc_status_updating", "docs_listing"):
                # 工具开始
                detail = ""
                if "query" in d:
                    detail = '"' + str(d.get("query", ""))[:30] + '"'
                elif "url" in d:
                    detail = str(d.get("url", ""))[:40]
                elif "path" in d:
                    detail = str(d.get("path", ""))[:30]
                elif "filename" in d:
                    detail = str(d.get("filename", ""))[:30]
                print("  ▶ %-25s %s" % (status, detail))
            elif status.endswith("_done") or status in ("workspace_appended", "workspace_edited",
                                                          "docs_listed", "doc_status_done",
                                                          "workspace_write_done", "workspace_listed"):
                detail = ""
                if "count" in d:
                    detail = str(d.get("count", 0)) + " 条"
                elif "length" in d:
                    detail = str(d.get("length", 0)) + " 字"
                elif "name" in d:
                    detail = str(d.get("name", ""))[:30]
                elif "filename" in d:
                    detail = str(d.get("filename", ""))[:30]
                if elapsed_ms:
                    detail += " (%dms)" % elapsed_ms
                print("  ✓ %-25s %s" % (status, detail))

    # 关键事件：doc_complete
    print("\n文档完成事件：")
    doc_done = False
    for e in events:
        if e["type"] == "doc_complete":
            d = e["data"]
            print("  ✅ doc_complete: filename=%s doc_url=%s md_filename=%s" % (
                d.get("filename", ""),
                d.get("doc_url", ""),
                d.get("md_filename", ""),
            ))
            doc_done = True
    if not doc_done:
        print("  （无 doc_complete 事件）")

    # 关键事件：agent_summary
    print("\nAgent 摘要：")
    for e in events:
        if e["type"] == "agent_summary":
            d = e["data"]
            print("  rounds=%s, searches=%s, fetches=%s, kb=%s, docs=%s, elapsed=%ss" % (
                d.get("rounds"), d.get("searches"), d.get("fetches"),
                d.get("kb_hits"), d.get("docs"), d.get("elapsed"),
            ))

    # 错误事件
    print("\n错误事件：")
    errors = [e for e in events if e["type"] in ("error", "doc_error")]
    if errors:
        for e in errors:
            print("  ❌ %s: %s" % (e["type"], str(e["data"])[:120]))
    else:
        print("  （无错误）")

    # 最终回答
    print("\n最终回答（前 300 字）：")
    for e in reversed(events):
        if e["type"] == "done":
            content = e["data"].get("content", "") if isinstance(e["data"], dict) else ""
            if content:
                print("  " + content[:300].replace("\n", "\n  "))
            break


def check_workspace_files():
    """检查 workspace 目录的文件"""
    print("\n" + "=" * 60)
    print("📂 workspace 目录检查")
    print("=" * 60)
    ws_dir = "C:\\Sidemate\\server\\data\\chats\\%s\\workspace" % CHAT_ID
    docs_dir = "C:\\Sidemate\\server\\data\\chats\\%s\\docs" % CHAT_ID

    if os.path.isdir(ws_dir):
        for f in sorted(os.listdir(ws_dir)):
            fp = os.path.join(ws_dir, f)
            size = os.path.getsize(fp) if os.path.isfile(fp) else 0
            print("  workspace/%s (%d 字节)" % (f, size))
            # 如果是 .md，打印前几行
            if f.endswith(".md") and os.path.isfile(fp):
                with open(fp, "r", encoding="utf-8") as fh:
                    content = fh.read()
                lines = content.split("\n")
                print("    内容预览（%d 字, %d 行）：" % (len(content), len(lines)))
                for line in lines[:5]:
                    print("      " + line[:80])
    else:
        print("  workspace/ 目录不存在")

    if os.path.isdir(docs_dir):
        print("")
        for f in sorted(os.listdir(docs_dir)):
            fp = os.path.join(docs_dir, f)
            size = os.path.getsize(fp) if os.path.isfile(fp) else 0
            print("  docs/%s (%d 字节)" % (f, size))


# ============================================================
# 主测试流程
# ============================================================

def main():
    print("=" * 60)
    print("🚀 Sidemate Patch4 v3 自动化测试")
    print("=" * 60)
    print("Chat ID: %s" % CHAT_ID)
    print("Mode: cloud (deepseek-v4-pro)")
    print("")

    # ========== 测试 1：智能聊天写文档 ==========
    print("\n" + "🔴" * 30)
    print("🔴 测试 1：智能聊天写文档（chat 模式）")
    print("🔴" * 30)

    events1 = send_message(
        "帮我写一份关于团队协作的简短文档，3 个章节",
        action_mode="chat"
    )
    if events1:
        analyze_events(events1, "测试 1：智能聊天写文档")
        check_workspace_files()


if __name__ == "__main__":
    main()

# -*- coding: utf-8 -*-
"""Patch12 QA Round 6 — 验证三个修复
1. recorder_manager.py 缩进错误修复（服务能正常启动）
2. 多轮对话纯 think 空输出重试
3. check_topic_drift 语义偏离检测恢复
"""
import requests
import json
import time
import sys

API = "http://127.0.0.1:8976"
results = []

def api_post(endpoint, data, timeout=120):
    """POST 请求并返回 SSE 文本"""
    r = requests.post(f"{API}{endpoint}", json=data, timeout=timeout, stream=True)
    return r

def parse_sse(resp):
    """解析 SSE 事件流"""
    events = []
    for line in resp.iter_lines(decode_unicode=True):
        if line and line.startswith("data: "):
            payload = line[6:]
            if payload == "[DONE]":
                break
            try:
                events.append(json.loads(payload))
            except:
                events.append({"raw": payload})
    return events

def test(name, passed, detail=""):
    status = "PASS" if passed else "FAIL"
    results.append({"name": name, "status": status, "detail": detail})
    print(f"  [{status}] {name}" + (f" — {detail}" if detail else ""))

# ====== 前置检查 ======
print("\n===== 前置检查 =====")

# 检查服务状态
r = requests.get(f"{API}/api/status", timeout=5).json()
test("服务运行中", r.get("status") == "ok", f"status={r.get('status')}")

# 检查模型已加载
r = requests.get(f"{API}/api/status", timeout=5).json()
loaded = r.get("loaded_models", [])
test("模型已加载", len(loaded) > 0, f"models={loaded}")

# 检查 Whisper 状态
r = requests.get(f"{API}/api/recorder/status", timeout=5).json()
whisper_installed = r.get("whisper_installed", False)
test("Whisper 扩展识别", whisper_installed, f"installed={whisper_installed}, status={r.get('whisper_status')}")

# ====== Test 1: 多轮对话（验证纯 think 空输出重试） ======
print("\n===== Test 1: 多轮对话稳定性 =====")

# 创建新对话
chat_name = f"qa-round6-{int(time.time())}"
requests.post(f"{API}/api/chats", json={"name": chat_name}, timeout=5)

chat_file = None
r = requests.get(f"{API}/api/chats", timeout=5).json()
for c in r.get("chats", []):
    if c.get("name") == chat_name:
        chat_file = c.get("file", "")
        break
test("创建测试对话", bool(chat_file), f"file={chat_file}")

messages_history = []

def chat_turn(msg_text, turn_num):
    """执行一轮对话"""
    data = {
        "message": msg_text,
        "history": messages_history,
        "chat_file": chat_file,
        "action_mode": "chat",
    }
    try:
        resp = api_post("/api/chat/stream", data, timeout=90)
        events = parse_sse(resp)
        
        # 提取回复文本
        response_text = ""
        task_type = ""
        has_fallback = False
        has_drift = False
        has_think_open = False
        has_error = False
        
        for e in events:
            if e.get("type") == "token":
                response_text += e.get("content", "")
            elif e.get("type") == "task_type":
                task_type = e.get("task_type", "")
            elif e.get("type") == "topic_drift":
                has_drift = True
            elif e.get("type") == "think_open":
                has_think_open = True
            elif e.get("type") == "error":
                has_error = True
            elif e.get("type") == "truncate":
                if "暂时无法回答" in e.get("content", ""):
                    has_fallback = True
        
        # 检查 done 事件
        done_event = next((e for e in events if e.get("type") == "done"), {})
        chars = done_event.get("chars", 0)
        elapsed = done_event.get("time", 0)
        speed = done_event.get("speed", 0)
        
        # 更新历史
        if response_text.strip():
            messages_history.append({"role": "user", "content": msg_text})
            messages_history.append({"role": "assistant", "content": response_text})
        
        return {
            "text": response_text,
            "chars": chars,
            "elapsed": elapsed,
            "speed": speed,
            "task_type": task_type,
            "fallback": has_fallback,
            "drift": has_drift,
            "think_open": has_think_open,
            "error": has_error,
        }
    except Exception as ex:
        return {"text": "", "error": True, "exception": str(ex)}

# 第1轮：简单问候
r1 = chat_turn("你好，请记住数字42", 1)
test("第1轮-问候", r1.get("chars", 0) > 0 and not r1.get("fallback"), 
     f"chars={r1.get('chars',0)}, speed={r1.get('speed',0):.0f}字/s")
print(f"    回复: {r1.get('text','')[:80]}...")

# 第2轮：追问
r2 = chat_turn("我刚才让你记住的数字是什么？", 2)
test("第2轮-记忆", r2.get("chars", 0) > 0 and not r2.get("fallback"),
     f"chars={r2.get('chars',0)}, speed={r2.get('speed',0):.0f}字/s")
has_42 = "42" in r2.get("text", "")
test("第2轮-内容正确", has_42, f"包含42: {has_42}")
print(f"    回复: {r2.get('text','')[:80]}...")

# 第3轮：新话题（之前这轮会挂）
r3 = chat_turn("帮我数到10", 3)
test("第3轮-新话题", r3.get("chars", 0) > 0 and not r3.get("fallback"),
     f"chars={r3.get('chars',0)}, speed={r3.get('speed',0):.0f}字/s, fallback={r3.get('fallback')}")
print(f"    回复: {r3.get('text','')[:80]}...")

# 第4轮：完全不同的新话题
r4 = chat_turn("解释量子纠缠", 4)
test("第4轮-量子纠缠", r4.get("chars", 0) > 0 and not r4.get("fallback"),
     f"chars={r4.get('chars',0)}, speed={r4.get('speed',0):.0f}字/s, fallback={r4.get('fallback')}")
print(f"    回复: {r4.get('text','')[:80]}...")

# 第5轮：又一个话题
r5 = chat_turn("写一首关于春天的四行诗", 5)
test("第5轮-诗歌创作", r5.get("chars", 0) > 0 and not r5.get("fallback"),
     f"chars={r5.get('chars',0)}, speed={r5.get('speed',0):.0f}字/s")
print(f"    回复: {r5.get('text','')[:80]}...")

# ====== Test 2: 语义偏离检测 ======
print("\n===== Test 2: 语义偏离检测 =====")

# 构建足够长的历史来触发检测
drift_history = list(messages_history)
drift_turns = []
topics = ["数学", "编程", "历史", "物理", "化学"]
for i, topic in enumerate(topics):
    drift_history.append({"role": "user", "content": f"讲一下{topic}"})
    drift_history.append({"role": "assistant", "content": f"关于{topic}的内容讲解..." * 10})

# 发送一个完全不相关的话题
data = {
    "message": "教我做红烧肉",
    "history": drift_history,
    "chat_file": chat_file,
    "action_mode": "chat",
}
try:
    resp = api_post("/api/chat/stream", data, timeout=90)
    events = parse_sse(resp)
    
    drift_event = next((e for e in events if e.get("type") == "topic_drift"), None)
    has_drift = drift_event is not None
    
    test("语义偏离检测触发", has_drift, 
         f"drift_event={'yes' if has_drift else 'no'}")
    if has_drift:
        print(f"    drift_level={drift_event.get('drift_level')}, reason={drift_event.get('reason')}")
        print(f"    suggestion={drift_event.get('suggestion')}")
    
    # 检查返回的字段完整性
    if has_drift:
        fields_ok = all(k in drift_event for k in ["drift_level", "reason", "overlap", "msg_count", "suggestion"])
        test("偏离事件字段完整", fields_ok, f"keys={list(drift_event.keys())}")
except Exception as ex:
    test("语义偏离检测触发", False, f"exception: {str(ex)[:100]}")

# ====== Test 3: Whisper 状态检查 ======
print("\n===== Test 3: Whisper 扩展状态 ======")

r = requests.get(f"{API}/api/recorder/status", timeout=5).json()
test("Whisper installed=True", r.get("whisper_installed") == True,
     f"installed={r.get('whisper_installed')}, status={r.get('whisper_status')}")

manifest = r.get("whisper_manifest", {}) or r.get("manifest", {})
if manifest:
    test("manifest.model_name 存在", bool(manifest.get("model_name")),
         f"model_name={manifest.get('model_name')}")
    test("manifest.model_size_mb 存在", manifest.get("model_size_mb") is not None,
         f"model_size_mb={manifest.get('model_size_mb')}")
else:
    test("manifest 可读", False, "无 manifest 数据返回")

# ====== 汇总 ======
print("\n" + "=" * 50)
passed = sum(1 for r in results if r["status"] == "PASS")
failed = sum(1 for r in results if r["status"] == "FAIL")
total = len(results)
print(f"总计: {total} 项 | 通过: {passed} | 失败: {failed}")
print(f"通过率: {passed/total*100:.0f}%")

if failed > 0:
    print("\n失败项：")
    for r in results:
        if r["status"] == "FAIL":
            print(f"  ❌ {r['name']}: {r['detail']}")

# 保存报告
report = {
    "round": "Round 6",
    "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    "fixes_tested": [
        "recorder_manager.py IndentationError 修复",
        "多轮对话纯 think 空输出重试（stream_engine.py）",
        "check_topic_drift 语义偏离检测恢复（task_classifier.py）",
    ],
    "results": results,
    "summary": {"total": total, "passed": passed, "failed": failed}
}
with open(r"C:\tmp\桌伴-设计文档\p12_第六轮QA报告.json", "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)

print(f"\n报告已保存: C:\\tmp\\桌伴-设计文档\\p12_第六轮QA报告.json")

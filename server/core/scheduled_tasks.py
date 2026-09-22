# -*- coding: utf-8 -*-
"""
core/scheduled_tasks.py — 定时任务/自动化（0.10 M4-6，学 AnythingLLM）
=======================================================================

cron 定时 prompt + agent 能力，产物落项目文件夹。
桌面语义 = 错过补跑 + 开机通知（关机不跑）。
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from typing import List

log = logging.getLogger(__name__)

TASKS_FILE = "scheduled_tasks.json"
CHECK_INTERVAL = 60
CATCHUP_WINDOW = 3600


def _tasks_path():
    from config import DATA_DIR
    return os.path.join(DATA_DIR, TASKS_FILE)


def _load_tasks():
    try:
        with open(_tasks_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"tasks": []}


def _save_tasks(data):
    with open(_tasks_path(), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def add_task(name, prompt, project_dir, schedule_type="daily", time_str="09:00", interval_minutes=60):
    task = {"id": uuid.uuid4().hex[:12], "name": name, "prompt": prompt,
            "project_dir": project_dir, "schedule": {"type": schedule_type},
            "enabled": True, "last_run": "", "last_result": "",
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S")}
    if schedule_type == "daily":
        task["schedule"]["time"] = time_str
    else:
        task["schedule"]["minutes"] = interval_minutes
    data = _load_tasks()
    data["tasks"].append(task)
    _save_tasks(data)
    return task


def remove_task(task_id):
    data = _load_tasks()
    n = len(data["tasks"])
    data["tasks"] = [t for t in data["tasks"] if t["id"] != task_id]
    if len(data["tasks"]) < n:
        _save_tasks(data)
        return True
    return False


def toggle_task(task_id, enabled):
    data = _load_tasks()
    for t in data["tasks"]:
        if t["id"] == task_id:
            t["enabled"] = enabled
            _save_tasks(data)
            return True
    return False


def list_tasks():
    return _load_tasks().get("tasks", [])


def _should_run(task, now):
    if not task.get("enabled"):
        return False
    sched = task.get("schedule", {})
    now_st = time.localtime(now)
    if sched.get("type") == "daily":
        target = time.strftime("%Y-%m-%d", now_st) + " " + sched.get("time", "00:00")
        now_str = time.strftime("%Y-%m-%d %H:%M", now_st)
        if now_str >= target:
            last = task.get("last_run", "")
            if not last.startswith(time.strftime("%Y-%m-%d", now_st)):
                return True
        return False
    elif sched.get("type") == "interval":
        interval = sched.get("minutes", 60) * 60
        last = task.get("last_run", "")
        if not last:
            return True
        try:
            last_ts = time.mktime(time.strptime(last, "%Y-%m-%d %H:%M:%S"))
            return (now - last_ts) >= interval
        except ValueError:
            return True
    return False


def _execute_task(task):
    log.info("[SCHED] 执行: %s", task["name"])
    try:
        chat_name = "sched_" + task["id"] + "_" + time.strftime("%H%M%S")
        from config import CHAT_DIR
        chat_dir = os.path.join(CHAT_DIR, chat_name)
        os.makedirs(chat_dir, exist_ok=True)
        meta = {"id": chat_name, "title": "[定时] " + task["name"],
                "message_count": 0, "project_dir": task.get("project_dir", ""),
                "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"), "version": 3}
        with open(os.path.join(chat_dir, "meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False)
        msgs = {"messages": [{"role": "user", "content": task.get("prompt", ""),
                               "ts": time.strftime("%H:%M:%S")}]}
        with open(os.path.join(chat_dir, "messages.json"), "w", encoding="utf-8") as f:
            json.dump(msgs, f, ensure_ascii=False)
        # 通过 gen_manager 触发后台生成
        from core.gen_manager import get_gen_manager
        from pipelines import create_pipeline
        ctx = type("Ctx", (), {})()
        ctx.chat_id = chat_name
        ctx.message = task.get("prompt", "")
        ctx.ai_mode = "cloud"
        ctx.history = []
        ctx.action_mode = "chat"
        gen = create_pipeline(ctx)
        get_gen_manager().start(chat_name, chat_dir, gen)
        data = _load_tasks()
        for t in data["tasks"]:
            if t["id"] == task["id"]:
                t["last_run"] = time.strftime("%Y-%m-%d %H:%M:%S")
                t["last_result"] = "已触发 " + chat_name
        _save_tasks(data)
    except Exception as e:
        log.warning("[SCHED] 失败 %s: %s", task["name"], str(e)[:120])
        data = _load_tasks()
        for t in data["tasks"]:
            if t["id"] == task["id"]:
                t["last_run"] = time.strftime("%Y-%m-%d %H:%M:%S")
                t["last_result"] = "失败: " + str(e)[:80]
        _save_tasks(data)


def _loop():
    log.info("[SCHED] 调度器启动（%ds 周期）", CHECK_INTERVAL)
    while True:
        time.sleep(CHECK_INTERVAL)
        try:
            now = time.time()
            for task in list_tasks():
                if _should_run(task, now):
                    threading.Thread(target=_execute_task, args=(task,), daemon=True).start()
                    time.sleep(2)
        except Exception as e:
            log.warning("[SCHED] 异常: %s", str(e)[:80])


def start_scheduler():
    if os.environ.get("SIDEMATE_SCHED_STARTED"):
        return
    os.environ["SIDEMATE_SCHED_STARTED"] = "1"
    threading.Thread(target=_loop, daemon=True, name="scheduler").start()

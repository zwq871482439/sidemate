# 归档代码

本目录存放已下线但保留以备将来恢复的模块。

## recorder_pkg（归档于 2026-06-22）

**归档原因**：v0.9.6 P6 移除纪要模块（录音转写+摘要），前端已无入口，后端 router 不再注册。

**原位置**：
- `server/recorder_pkg/` → `archive/recorder_pkg/`
- `server/routers/recorder.py` → `archive/routers/recorder.py`

**关联 pip 包（已删除）**：
- `faster-whisper` — 语音转写引擎
- `av` — 音频解码（faster-whisper 间接依赖）
- `ctranslate2` — faster-whisper 的推理后端

**依赖清理**：
- `server.py` 删除 `from recorder_pkg...import RecorderManager` 和 `app.include_router(_r_recorder.router)`
- `routers/deps.py` 删除 `get_recorder()`
- `routers/settings_system.py` 删除 recorder_status 引用
- `routers/settings_extensions.py` 删除 whisper load/unload 调用

**复活方式**：
1. 把 `archive/recorder_pkg/` 拷回 `server/`
2. 把 `archive/routers/recorder.py` 拷回 `server/routers/`
3. 在 `server.py` 添加 `from recorder_pkg.recorder_manager import RecorderManager` 和 `recorder = RecorderManager()` + `recorder.recover_sessions()`
4. 在 `server.py` 添加 `app.include_router(_r_recorder.router)` 和对应的 `from routers import recorder as _r_recorder`
5. 在 `routers/deps.py` 恢复 `get_recorder()`
6. 在 `routers/settings_system.py` 和 `settings_extensions.py` 恢复 recorder 引用
7. `pip install faster-whisper av ctranslate2`
8. 前端恢复录音 Tab（已在 `static/js/minutes.js.archived`）

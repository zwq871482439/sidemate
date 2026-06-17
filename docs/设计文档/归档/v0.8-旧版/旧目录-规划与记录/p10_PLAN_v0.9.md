# 桌伴 · Sidemate v0.9 — 一键安装打包计划

> 项目名称：桌伴 · Sidemate（ZhuoBan Sidemate）
> 方案：Embedded Python + Inno Setup 安装包
> 目标：用户双击 EXE 安装 → 桌面图标 → 双击运行 → 浏览器自动打开
> 日期：2026-05-23

---

## 一、现状盘点

| 项目 | 说明 |
|------|------|
| 版本 | v0.8 patch10 |
| Python | 3.14 Embedded（开发+打包统一） |
| 依赖 | 100 个 .whl (vendor/), 428MB |
| 前端 | Vanilla HTML/JS/CSS, ~2MB |
| 后端代码 | 25 个 .py, ~180KB |
| 运行时目录 | data/, models/, chats/, logs/, files/, extensions/, workspace/, tmp_upload/, export/ |
| 配置 | config.py 集中管理, ROOT_DIR 自动推断 |
| 端口 | 8976（环境变量 LOCAL_AI_PORT 可覆盖） |
| 启动方式 | setup.bat（首次安装）→ start.bat（日常启动） |

## 二、打包架构

```
Sidemate-Setup-v0.9.exe          ← Inno Setup 生成的安装包（~490MB）
  │
  ├─ 安装到 C:\Users\<用户>\Sidemate\（固定路径，无 UAC 弹窗）
  │    ├── python\                ← Python 3.14 Embedded（~15MB）
  │    │     ├── python.exe
  │    │     ├── python314.zip    （标准库）
  │    │     └── site-packages\   （pip 依赖，从 vendor/*.whl 安装）
  │    │
  │    ├── app\                   ← 应用代码（只读区）
  │    │     ├── server.py
  │    │     ├── config.py
  │    │     ├── routers\
  │    │     ├── static\
  │    │     ├── index.html
  │    │     ├── pipeline\
  │    │     ├── skills\
  │    │     ├── pipelines\
  │    │     └── requirements.txt
  │    │
  │    ├── data\                  ← 运行时数据（用户区，升级时保留）
  │    │     ├── models\          （用户导入的模型）
  │    │     ├── chats\
  │    │     ├── kb\
  │    │     ├── logs\
  │    │     ├── recordings\
  │    │     ├── files\
  │    │     ├── extensions\
  │    │     ├── tmp_upload\
  │    │     └── export\
  │    │
  │    ├── launcher.exe           ← 启动器（Go 编写，~8MB，零运行时依赖）
  │    │                            - 启动 python/python.exe app/server.py
  │    │                            - 等端口就绪后打开浏览器
  │    │                            - 系统托盘图标（nickeb/systray）
  │    │                            - 关闭时优雅退出 Python 进程
  │    │
  │    ├── uninstall.exe          ← Inno Setup 自动生成
  │    └── settings.json          （用户配置，升级时保留）
  │
  └─ 桌面快捷方式 → launcher.exe
```

## 三、工作分解（8 个任务）

### Task 1：Python Embedded 准备
**目标**：制作独立的 Python 3.14 Embedded 运行时

步骤：
1. 下载 Python 3.14 Windows Embeddable Package
2. 解压到 `build/python-embed/`
3. 修改 `python314._pth` 文件，添加 `site-packages` 路径
4. 用这个嵌入式 Python 执行 `pip install --no-index --find-links=../../vendor/ -r ../../requirements.txt`
5. 验证：`python-embed/python.exe -c "import openvino; print('OK')"`
6. ✅ vendor/ 现有的 cp314 whl 直接可用，无需重新下载

产出：`build/python-embed/` 目录，可直接复制到安装包

### Task 2：config.py 路径适配
**目标**：让应用在新目录结构下正确找到数据和代码

改动：
```python
# config.py — 修改路径逻辑
import os, sys

# 检测是否在打包模式下运行
def _is_packaged():
    """打包模式下 python/ 和 app/ 分离"""
    return os.path.exists(os.path.join(os.path.dirname(ROOT_DIR), 'app'))

# ROOT_DIR 始终指向 app/ 目录（代码所在位置）
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))

# DATA_DIR 在打包模式下指向安装根目录下的 data/
if _is_packaged():
    INSTALL_DIR = os.path.dirname(ROOT_DIR)          # LocalAI/
    DATA_DIR = os.path.join(INSTALL_DIR, "data")
else:
    DATA_DIR = os.path.join(ROOT_DIR, "data")         # 开发模式，保持原样

# 其余路径从 DATA_DIR 派生，不变
CHAT_DIR = os.path.join(DATA_DIR, "chats")
LOG_DIR = os.path.join(DATA_DIR, "logs")
# ...
```

关键原则：
- 开发模式（`python server.py`）行为完全不变
- 打包模式自动检测，无需环境变量

### Task 3：Launcher 启动器
**目标**：编写 launcher.exe，替代 start.bat

功能：
1. 启动 `python/python.exe app/server.py`
2. 轮询 `http://localhost:8976/api/info` 直到服务就绪（最多等 30 秒）
3. 打开默认浏览器访问 `http://localhost:8976`
4. 在系统托盘显示图标（右键菜单：打开网页、停止服务、退出）
5. 退出时向 Python 进程发送 SIGTERM，等待 5 秒后强杀

技术选型：**Go**（确定）
- 编译为单个静态二进制，零运行时依赖，任何 Windows 都能跑
- 系统托盘库 `nickeb/systray` 成熟稳定
- `go build` 一条命令出 exe，无需安装 IDE
- ~8MB 体积，相对 490MB 安装包可忽略

预估代码量：~200 行 Go

### Task 4：server.py 适配
**目标**：确保在 Embedded Python 下正常启动

改动：
1. 添加静态文件路径适配：`static/` 在打包模式下相对 `app/` 目录
2. 环境变量设置（原来 start.bat 做的事）移到 server.py 开头：
   ```python
   os.environ.setdefault('HF_HUB_OFFLINE', '1')
   os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
   os.environ.setdefault('OPENVINO_TELEMETRY', '0')
   ```
3. 确保日志目录在 `data/logs` 下（由 config.py 保证）

### Task 5：Inno Setup 脚本
**目标**：生成一键安装包

`installer.iss` 核心逻辑：
```iss
[Setup]
AppName=桌伴 Sidemate
AppVersion=0.9
DefaultDirName={userpf}\Sidemate
; 安装到用户目录，无 UAC 弹窗，无需管理员权限
PrivilegesRequired=lowest
DefaultGroupName=桌伴 Sidemate
OutputBaseFilename=Sidemate-Setup-v0.9
Compression=lzma2/ultra64
SolidCompression=yes

[Files]
; Python 运行时
Source: "build\python-embed\*"; DestDir: "{app}\python"; Flags: recursesubdirs

; 应用代码
Source: "app\*"; DestDir: "{app}\app"; Flags: recursesubdirs

; 启动器
Source: "build\launcher.exe"; DestDir: "{app}"; Flags: ignoreversion

; 运行时目录（仅首次安装时创建，升级时保留）
[Dirs]
Name: "{app}\data"; Flags: uninsneveruninstall
Name: "{app}\data\models"; Flags: uninsneveruninstall
Name: "{app}\data\chats"; Flags: uninsneveruninstall
Name: "{app}\data\kb"; Flags: uninsneveruninstall
Name: "{app}\data\logs"; Flags: uninsneveruninstall
; ... 其他运行时目录

[Icons]
Name: "{userdesktop}\桌伴 Sidemate"; Filename: "{app}\launcher.exe"
Name: "{group}\桌伴 Sidemate"; Filename: "{app}\launcher.exe"

[Run]
Filename: "{app}\launcher.exe"; Description: "启动 桌伴 Sidemate"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 只删除代码和 Python，不删 data/
Type: filesandordirs; Name: "{app}\python"
Type: filesandordirs; Name: "{app}\app"
```

关键设计：
- **data/ 目录标记 `uninsneveruninstall`**：卸载时保留用户数据
- **升级安装时只覆盖 python/ 和 app/**，不动 data/
- 使用 LZMA2 压缩，490MB → 安装包约 ~400MB（压缩率 ~80%）

### Task 6：构建脚本
**目标**：一键执行完整打包流程

`build.py`（或 `build.bat`）步骤：
1. 清理 `build/` 输出目录
2. 准备 Python Embedded + pip 安装依赖
3. 复制 `app/` 代码文件（排除 `__pycache__`、`.pyc`、开发用文件）
4. 编译 launcher.exe（`go build`）
5. 运行 Inno Setup 编译 `installer.iss`
6. 输出 `dist/Sidemate-Setup-v0.9.exe`

### Task 7：升级机制
**目标**：支持从 v0.8 → v0.9 平滑升级

设计：
- Inno Setup 安装时自动检测已安装版本
- 只覆盖 `python/` 和 `app/` 目录
- `data/` 和 `settings.json` 完全不动
- 升级后首次启动执行数据迁移检查（如果格式有变化）

### Task 8：测试验证
**目标**：在干净 Windows 环境验证

检查清单：
- [ ] 全新安装：双击 EXE → 安装 → 启动 → 浏览器打开 → 能对话
- [ ] 升级安装：覆盖安装 → 数据保留 → 服务正常
- [ ] 卸载：data/ 保留
- [ ] NPU / GPU / CPU 三种模式都能跑
- [ ] 模型导入正常
- [ ] 知识库正常
- [ ] 深色/浅色模式正常

---

## 四、目录结构变更总览

```
开发模式 (现在):                    打包模式 (v0.9):
├── server.py                       安装目录/
├── config.py                       ├── python/          ← Python Embed
├── routers/                        │     ├── python.exe
├── static/                         │     └── site-packages/
├── vendor/  (428MB)                ├── app/             ← 代码（只读）
├── data/                           │     ├── server.py
│   ├── chats/                      │     ├── config.py
│   ├── kb/                         │     ├── routers/
│   ├── models/                     │     ├── static/
│   └── logs/                       │     └── index.html
├── start.bat                       ├── data/            ← 用户数据（持久化）
├── setup.bat                       │     ├── chats/
└── requirements.txt                │     ├── kb/
                                    │     ├── models/
                                    │     └── logs/
                                    ├── launcher.exe     ← 启动器
                                    └── settings.json
```

## 五、时间估算

| 任务 | 预估时间 |
|------|----------|
| Task 1: Python Embed 准备 | 2h |
| Task 2: config.py 路径适配 | 1h |
| Task 3: Launcher 启动器 | 4h |
| Task 4: server.py 适配 | 1h |
| Task 5: Inno Setup 脚本 | 2h |
| Task 6: 构建脚本 | 2h |
| Task 7: 升级机制 | 2h |
| Task 8: 测试验证 | 4h |
| **总计** | **~18h (2-3 天)** |

## 六、风险点

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Python 3.14 Embed 尚未正式发布 | 打包无法进行 | ✅ 已决定使用 3.14 Embed（与开发环境一致） |
| OpenVINO native DLL 路径问题 | import 失败 | 预测试 + PYTHONPATH 配置 |
| 安装包 400MB+ 下载慢 | 用户体验差 | 提供 SHA256 校验 + 断点续传说明 |
| Windows Defender 误报 launcher.exe | 用户不敢运行 | Go 二进制误报率低；代码签名（v1.0 考虑） |
| 某些机器缺少 VC Runtime（增加一个如果没有就给他装！） | 启动失败 | 安装包内置 VC Runtime 检测 |

## 七、不做的事（v0.9 范围外）

- ❌ 自动更新（OTA）→ v1.0 考虑
- ❌ 代码签名 → v1.0 考虑（需要购买证书）
- ❌ Electron/Tauri 桌面壳 → v1.x 考虑
- ❌ 多语言安装界面 → 后续按需
- ❌ Linux/macOS 支持 → 后续按需

## 八、⚠️ 待确认事项

1. ~~**vendor/ 的 whl 版本**~~：✅ 已决定统一用 Python 3.14，现有 vendor/ 直接可用
2. ~~**Program Files 需要 UAC 提权**~~：✅ 已决定安装到用户目录，无权限问题
3. ~~**项目名称**~~：✅ 已确定 — **桌伴 · Sidemate**（ZhuoBan Sidemate）
   - 桌伴：桌面上的伙伴，直白亲切
   - Sidemate：Side + Mate，身边的伙伴
   - v0.9 需完成：品牌更替（UI 文案、安装包名称、launcher 标题栏、关于页面）

---

*等待 slow 审阅确认后开始执行*

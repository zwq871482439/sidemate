; ====================================================================
; Sidemate 全量安装脚本 (Inno Setup) — 主程序 + LLM + KB 模型
; 版本: 0.9.5.0
; 包含: 程序本体 + Qwen3.5-4B LLM + BGE-M3 Embedder + Reranker-v2-m3
; 不含: 纪要扩展 (Whisper)
;
; 打包策略（方案 C）：单入口 exe + 自动分卷 .bin
;   - 主 exe < 4GB（Windows 安全限制）
;   - DiskSpanning 自动按 3GB 切分卷
;   - 用户下载 exe + 所有 .bin 放同目录，运行 exe 自动合并
;
; 产出文件（压缩后约 8GB）：
;   Sidemate_Full_Setup_v0.9.5.exe       ← 入口（< 4GB）
;   Sidemate_Full_Setup_v0.9.5-1.bin     ← 分卷 1
;   Sidemate_Full_Setup_v0.9.5-2.bin     ← 分卷 2
;   Sidemate_Full_Setup_v0.9.5-3.bin     ← 分卷 3（可能没有，视压缩率）
;
; 组件体积（未压缩）：
;   Launcher + Ollama + lib + Python + Server ≈ 1.6GB
;   Qwen3.5-4B (blobs)                      ≈ 3.0GB
;   BGE-M3 (embedding)                      ≈ 4.3GB
;   BGE-Reranker-v2-m3 (reranker)           ≈ 2.2GB
;   合计 ≈ 11GB → LZMA2 压缩后 ≈ 8GB
; ====================================================================

#define MyAppName "桌伴 Sidemate"
#define MyAppVersion "0.9.5.0"
#define MyAppPublisher "Sidemate Team"
#define MyAppURL "https://sidemate.app"
#define MyAppExeName "Sidemate.exe"

[Setup]
; 应用基本信息
AppId={{B7E3F2A1-8C9D-4E5F-A6B0-1D2E3F4A5B6C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName=Sidemate v0.9 Patch 5 (Full)
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
DefaultDirName={localappdata}\Sidemate
DefaultGroupName={#MyAppName}
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
DisableDirPage=yes

; 输出设置
OutputDir=output
OutputBaseFilename=Sidemate_Full_Setup_v0.9.5
SetupIconFile=installer\setup.ico

; 压缩（Patch4 v3.1：ultra64 → normal，模型文件压缩率<5%但耗时差 20 倍）
Compression=lzma2/normal
SolidCompression=no

; ====== 分卷设置（方案 C 核心）======
; DiskSpanning 启用后，ISCC 自动将安装包切分为：
;   主 .exe（含安装逻辑 + 部分数据，< DiskSliceSize）
;   .bin 分卷（纯数据，每片 ≤ DiskSliceSize）
; 用户运行 .exe 时自动从同目录读取 .bin
DiskSpanning=yes
DiskSliceSize=3000000000
SlicesPerDisk=1

; 界面风格
WizardStyle=modern

; 权限（安装到用户目录，无需管理员权限）
PrivilegesRequired=lowest

; EULA 页（展示 LICENSE 文件，编码由 BOM 自动检测）
InfoBeforeFile=LICENSE

; 版本信息
VersionInfoVersion=0.9.5.0
VersionInfoCompany=Sidemate Team
VersionInfoProductName=桌伴 Sidemate
VersionInfoProductVersion=0.9.5.0

; 禁用程序组页
DisableProgramGroupPage=yes

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加图标:"

[Files]
; ====== Go Launcher (6.5MB) ======
Source: "launcher\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

; ====== Ollama 引擎 (34MB) ======
Source: "ollama.exe"; DestDir: "{app}"; Flags: ignoreversion

; ====== Ollama 运行时依赖库 Vulkan/CPU DLL (134MB) ======
Source: "lib\*"; DestDir: "{app}\lib"; Flags: ignoreversion recursesubdirs

; ====== Python 嵌入式环境 (1.4GB) ======
Source: "python\*"; DestDir: "{app}\python"; Flags: ignoreversion recursesubdirs; Excludes: "__pycache__,*.pyc,.fingerprint"

; ====== Server 源码（排除用户数据）======
Source: "server\*"; DestDir: "{app}\server"; Flags: ignoreversion recursesubdirs; Excludes: "__pycache__,*.pyc,data\chats,data\kb,data\kbsession,data\recordings,data\cache,data\logs,data\deps_manifest.json,settings.json,extensions\*.json,requirements.txt"

; ====== LLM 模型: Qwen3.5-4B (Ollama blob 格式, ~3.0GB) ======
Source: "server\models\blobs\*"; DestDir: "{app}\server\models\blobs"; Flags: ignoreversion
Source: "server\models\manifests\*"; DestDir: "{app}\server\models\manifests"; Flags: ignoreversion recursesubdirs

; ====== KB Embedding 模型: BGE-M3 (~4.3GB, 1024维, 8192序列) ======
; Patch4 v3.1: bge-base-zh-v1.5 (390MB) → bge-m3 (4.3GB)
; 多语言 + 长序列 + dense/sparse/colbert 三合一检索
Source: "server\models\embedding\*"; DestDir: "{app}\server\models\embedding"; Flags: ignoreversion recursesubdirs

; ====== KB Reranker 模型: BGE-Reranker-v2-m3 (~2.2GB) ======
; Patch4 v3.1: bge-reranker-base (1.06GB) → bge-reranker-v2-m3 (2.2GB)
; 与 embedder 同源（m3 系列），精排协同更优
Source: "server\models\reranker\*"; DestDir: "{app}\server\models\reranker"; Flags: ignoreversion recursesubdirs

; ====== LICENSE 和第三方许可 ======
Source: "LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "THIRD-PARTY-NOTICES"; DestDir: "{app}"; Flags: ignoreversion

; ====== 安装工具脚本 ======
Source: "installer\make_snapshot.py"; DestDir: "{app}\installer"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; 安装完成后自动压缩 site-packages 备份
Filename: "{app}\python\python.exe"; Parameters: "-u ""{app}\installer\make_snapshot.py"" ""{app}"""; Flags: runhidden; StatusMsg: "正在生成环境备份..."
; 启动应用（用户勾选时）
Filename: "{app}\{#MyAppExeName}"; Description: "启动 桌伴 Sidemate"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 清理 cache 和 logs（非用户数据）
Type: filesandordirs; Name: "{app}\server\data\cache"
Type: filesandordirs; Name: "{app}\server\data\logs"
Type: filesandordirs; Name: "{app}\backup"
; 注意：不删除 {app}\server\data\chats, kb, kbsession, recordings（用户数据）

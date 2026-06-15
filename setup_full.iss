; ====================================================================
; Sidemate 全量安装脚本 (Inno Setup) — 主程序 + LLM + KB 模型
; 版本: 0.9.4.0
; 包含: 程序本体 + Qwen3.5-4B LLM + BGE Embedder + Reranker
; 不含: 纪要扩展 (Whisper)
; ====================================================================

#define MyAppName "桌伴 Sidemate"
#define MyAppVersion "0.9.4.0"
#define MyAppPublisher "Sidemate Team"
#define MyAppURL "https://sidemate.app"
#define MyAppExeName "Sidemate.exe"

[Setup]
; 应用基本信息
AppId={{B7E3F2A1-8C9D-4E5F-A6B0-1D2E3F4A5B6C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName=Sidemate v0.9 Patch 4 (Full)
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
OutputBaseFilename=Sidemate_Full_Setup_v0.9.4
SetupIconFile=installer\setup.ico
Compression=lzma2/ultra64
SolidCompression=yes
DiskSpanning=yes
SlicesPerDisk=1
WizardStyle=modern

; 权限（安装到用户目录，无需管理员权限）
PrivilegesRequired=lowest

; EULA 页（展示 LICENSE 文件，编码由 BOM 自动检测）
InfoBeforeFile=LICENSE

; 版本信息
VersionInfoVersion=0.9.4.0
VersionInfoCompany=Sidemate Team
VersionInfoProductName=桌伴 Sidemate
VersionInfoProductVersion=0.9.4.0

; 禁用程序组页
DisableProgramGroupPage=yes

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加图标:"

[Files]
; ====== Go Launcher ======
Source: "launcher\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

; ====== Ollama 引擎 ======
Source: "ollama.exe"; DestDir: "{app}"; Flags: ignoreversion

; ====== Ollama 运行时依赖库（Vulkan/CPU DLL）======
Source: "lib\*"; DestDir: "{app}\lib"; Flags: ignoreversion recursesubdirs

; ====== Python 嵌入式环境 ======
Source: "python\*"; DestDir: "{app}\python"; Flags: ignoreversion recursesubdirs; Excludes: "__pycache__,*.pyc,.fingerprint"

; ====== Server 源码（排除用户数据，但保留扩展注册文件）======
Source: "server\*"; DestDir: "{app}\server"; Flags: ignoreversion recursesubdirs; Excludes: "__pycache__,*.pyc,data\chats,data\kb,data\kbsession,data\recordings,data\cache,data\logs,data\deps_manifest.json,settings.json"

; ====== LLM 模型: Qwen3.5-4B (Ollama blob 格式, ~3.0GB) ======
Source: "server\models\blobs\*"; DestDir: "{app}\server\models\blobs"; Flags: ignoreversion
Source: "server\models\manifests\*"; DestDir: "{app}\server\models\manifests"; Flags: ignoreversion recursesubdirs

; ====== KB Embedding 模型: BGE-base-zh (~390MB) ======
Source: "server\models\embedding\*"; DestDir: "{app}\server\models\embedding"; Flags: ignoreversion recursesubdirs

; ====== KB Reranker 模型 (~1.06GB) ======
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

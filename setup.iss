; ====================================================================
; Sidemate 安装脚本 (Inno Setup)
; 版本: 0.9.6.0
; ====================================================================

#define MyAppName "桌伴 Sidemate"
#define MyAppVersion "0.9.6.0"
#define MyAppPublisher "Sidemate Team"
#define MyAppURL "https://sidemate.app"
#define MyAppExeName "Sidemate.exe"

[Setup]
; 应用基本信息
AppId={{B7E3F2A1-8C9D-4E5F-A6B0-1D2E3F4A5B6C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName=Sidemate v0.9.6
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
OutputBaseFilename=Sidemate_Setup_v0.9.6
SetupIconFile=installer\setup.ico
; Patch4 v3.1：ultra64 → normal（含模型时 ultra 跑一整天，normal 30 分钟）
Compression=lzma2/normal
SolidCompression=no
WizardStyle=modern

; 权限（安装到用户目录，无需管理员权限）
PrivilegesRequired=lowest

; EULA 页（展示 LICENSE 文件，编码由 BOM 自动检测）
InfoBeforeFile=LICENSE

; 品牌图（可选，如不存在会使用默认图）
; 取消注释以下两行当品牌图准备好后:
; WizardImageFile=installer\wizard_image.bmp
; WizardSmallSetupFile=installer\wizard_small.bmp

; 版本信息
VersionInfoVersion=0.9.6.0
VersionInfoCompany=Sidemate Team
VersionInfoProductName=桌伴 Sidemate
VersionInfoProductVersion=0.9.6.0

; 禁用程序组页（桌面应用不需要）
DisableProgramGroupPage=yes

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加图标:"

; 模型目录占位：空目录，内容由 .sidemate 扩展包运行时注入
[Dirs]
Name: "{app}\server\models"

[Files]
; Go Launcher
Source: "launcher\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

; Ollama 引擎
Source: "ollama.exe"; DestDir: "{app}"; Flags: ignoreversion

; Ollama 运行时依赖库（Vulkan/CPU DLL）
Source: "lib\*"; DestDir: "{app}\lib"; Flags: ignoreversion recursesubdirs

; Python 嵌入式环境
Source: "python\*"; DestDir: "{app}\python"; Flags: ignoreversion recursesubdirs; Excludes: "__pycache__,*.pyc,.fingerprint"

; Server 源码（排除：用户数据、缓存、日志、开发测试、本地设置、归档旧代码、用户工作区、模型）
; 注意：实际用户数据运行时落在 {app}\server\data\ 下；
;       models/ 下的模型（embedding/reranker/ollama blobs）由 .sidemate 扩展包按需安装，
;       安装包只保留空目录占位（见下方 [Dirs]），避免把 9GB+ 模型打进安装包。
Source: "server\*"; DestDir: "{app}\server"; Flags: ignoreversion recursesubdirs; Excludes: "__pycache__,*.pyc,data\chats,data\kb,data\kbsession,data\recordings,data\cache,data\logs,data\backup,data\deps_manifest.json,data\*.db,data\*.db-shm,data\*.db-wal,settings.json,extensions\*.json,requirements.txt,tests,archive,workspace,models"

; 模型目录空壳：models 必须存在（OLLAMA_MODELS 指向此），但内容由扩展包注入。
; Excludes 排除了整个 models 子树，这里用 [Dirs] 重建空目录占位。

; LICENSE 和第三方许可
Source: "LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "THIRD-PARTY-NOTICES"; DestDir: "{app}"; Flags: ignoreversion

; 注：make_snapshot.py（site-packages 备份）首发版本不需要——
; 0.9.6 是首个公开版本，无老扩展需回滚保护，自动备份会拖慢安装且占空间。
; 后续版本（用户可能装过扩展）再启用：解开下方两行注释即可。
; Source: "installer\make_snapshot.py"; DestDir: "{app}\installer"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; 注：首发版本不自动生成 site-packages 备份（无老扩展需保护）
; Filename: "{app}\python\python.exe"; Parameters: "-u ""{app}\installer\make_snapshot.py"" ""{app}"""; Flags: runhidden; StatusMsg: "正在生成环境备份..."
; 启动应用（用户勾选时）
Filename: "{app}\{#MyAppExeName}"; Description: "启动 桌伴 Sidemate"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 清理 cache 和 logs（非用户数据）
Type: filesandordirs; Name: "{app}\server\data\cache"
Type: filesandordirs; Name: "{app}\server\data\logs"
Type: filesandordirs; Name: "{app}\backup"
; 注意：不删除 {app}\server\data\chats, kb, kbsession, recordings（用户数据）

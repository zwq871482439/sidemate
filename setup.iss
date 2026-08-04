; ====================================================================
; Sidemate 安装脚本 (Inno Setup)
; 版本: 0.9.8.0
; ====================================================================

#define MyAppName "桌伴 Sidemate"
#define MyAppVersion "0.9.8.0"
#define MyAppPublisher "Sidemate Team"
#define MyAppURL "https://sidemate.app"
#define MyAppExeName "Sidemate.exe"

[Setup]
; 应用基本信息
AppId={{B7E3F2A1-8C9D-4E5F-A6B0-1D2E3F4A5B6C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName=Sidemate v0.9.8
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
OutputBaseFilename=Sidemate_Setup_v0.9.8
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
VersionInfoVersion=0.9.8.0
VersionInfoCompany=Sidemate Team
VersionInfoProductName=桌伴 Sidemate
VersionInfoProductVersion=0.9.8.0

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

; P7-4: 底座已换 llama.cpp，ollama.exe 不再需要（launcher 已不校验）
; Ollama 引擎行已删除

; llama.cpp 运行时（llama-server.exe + ggml/vulkan DLL）
Source: "lib\*"; DestDir: "{app}\lib"; Flags: ignoreversion recursesubdirs

; Python 嵌入式环境
Source: "python\*"; DestDir: "{app}\python"; Flags: ignoreversion recursesubdirs; Excludes: "__pycache__,*.pyc,.fingerprint"

; Server 源码（排除：用户数据、缓存、日志、开发测试、本地设置、归档旧代码、用户工作区、模型）
; 注意：实际用户数据运行时落在 {app}\data\ 下（DATA_DIR=项目根\data）；
;       models/ 下的模型（embedding/reranker/ollama blobs）由 .sidemate 扩展包按需安装，
;       安装包只保留空目录占位（见下方 [Dirs]），避免把 9GB+ 模型打进安装包。
Source: "server\*"; DestDir: "{app}\server"; Flags: ignoreversion recursesubdirs; Excludes: "__pycache__,*.pyc,.pytest_cache,data\chats,data\kb,data\kbsession,data\recordings,data\cache,data\logs,data\backup,data\deps_manifest.json,data\*.db,data\*.db-shm,data\*.db-wal,settings.json,extensions\*.json,requirements.txt,tests,archive,workspace,models,2026-*"

; 模型目录空壳：models 必须存在（OLLAMA_MODELS 指向此），但内容由扩展包注入。
; Excludes 排除了整个 models 子树，这里用 [Dirs] 重建空目录占位。

; LLM 3 档默认模型的 meta.json（仅描述文件，不含 GGUF 权重）——
; 模型下载页靠 registry.list_all() 读这些 meta.json 展示"可下载"列表，
; 不打包会导致下载页 LLM 列表为空。GGUF 权重由用户在应用内按需下载。
Source: "server\models\qwen3.5-0.8b-q4\meta.json"; DestDir: "{app}\server\models\qwen3.5-0.8b-q4"; Flags: ignoreversion
Source: "server\models\qwen3.5-2b-q4\meta.json"; DestDir: "{app}\server\models\qwen3.5-2b-q4"; Flags: ignoreversion
Source: "server\models\qwen3.5-4b-q4\meta.json"; DestDir: "{app}\server\models\qwen3.5-4b-q4"; Flags: ignoreversion

; LICENSE 和第三方许可
Source: "LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "THIRD-PARTY-NOTICES"; DestDir: "{app}"; Flags: ignoreversion
; 品牌图标（Splash/Tray 使用）
Source: "logo.ico"; DestDir: "{app}"; Flags: ignoreversion

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
; 清理 cache 和 logs（非用户数据，无论用户如何选择都删除）
Type: filesandordirs; Name: "{app}\data\cache"
Type: filesandordirs; Name: "{app}\data\logs"
Type: filesandordirs; Name: "{app}\data\backup"
; 强制删除 Python 目录（含运行时生成的 __pycache__、.fingerprint、site-packages_bak 等）
Type: filesandordirs; Name: "{app}\python"
; 注意：{app}\server 不再静态删除——模型在 server\models 下，
;       由 [Code] 卸载选项页按用户选择处理（默认保留模型）。
; 注意：{app}\data 的个人数据（chats/kb/recordings/settings.json）
;       同样由 [Code] 按用户选择处理（默认保留）。

[Code]
var
  OptPage: TWizardPage;
  chkDelModels, chkDelData: TNewCheckBox;

{ 卸载选项页：让用户选择是否删除模型和个人数据（默认都保留） }
function InitializeUninstall(): Boolean;
var
  lbl: TNewStaticText;
begin
  OptPage := CreateCustomPage(wpWelcome, '卸载选项', '请选择要一并删除的内容');

  lbl := TNewStaticText.Create(OptPage);
  lbl.Parent := OptPage.Surface;
  lbl.Left := 0;
  lbl.Top := 0;
  lbl.Width := OptPage.SurfaceWidth;
  lbl.Height := 36;
  lbl.WordWrap := True;
  lbl.Caption := '默认仅删除程序本体，已下载的模型和个人数据都会保留（重装后可直接使用）。如需彻底清理，请勾选：';

  chkDelModels := TNewCheckBox.Create(OptPage);
  chkDelModels.Parent := OptPage.Surface;
  chkDelModels.Left := 0;
  chkDelModels.Top := 48;
  chkDelModels.Width := OptPage.SurfaceWidth;
  chkDelModels.Caption := '删除已下载的模型（LLM + 知识库模型，约 5-10GB，删除后需重新下载）';
  chkDelModels.Checked := False;

  chkDelData := TNewCheckBox.Create(OptPage);
  chkDelData.Parent := OptPage.Surface;
  chkDelData.Left := 0;
  chkDelData.Top := 72;
  chkDelData.Width := OptPage.SurfaceWidth;
  chkDelData.Caption := '删除个人数据（聊天记录、知识库文档、API 密钥与所有设置）';
  chkDelData.Checked := False;

  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  AppDir, KeepDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    AppDir := ExpandConstant('{app}');

    { ---- server/：按模型选择处理 ---- }
    if chkDelModels.Checked then
    begin
      { 连模型一起删 }
      DelTree(AppDir + '\server', True, True, True);
    end
    else
    begin
      { 保留模型：暂移 models → 删 server → 放回（同卷 rename，瞬时完成） }
      KeepDir := AppDir + '\__models_keep__';
      if DirExists(AppDir + '\server\models') then
        RenameFile(AppDir + '\server\models', KeepDir);
      DelTree(AppDir + '\server', True, True, True);
      if DirExists(KeepDir) then
      begin
        ForceDirectories(AppDir + '\server');
        RenameFile(KeepDir, AppDir + '\server\models');
      end;
    end;

    { ---- data/：按个人数据选择处理（cache/logs/backup 已由静态规则清除） ---- }
    if chkDelData.Checked then
      DelTree(AppDir + '\data', True, True, True);
  end;
end;

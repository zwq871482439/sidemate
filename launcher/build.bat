@echo off
REM Sidemate Launcher build script
REM #58：launcher 不再持有/显示版本号（无 AppVersion 变量、无 -X 注入）。
REM   版本号唯一来源是 server/config.py，界面上只在「设置 → 关于」显示。
REM   图标嵌入：rsrc_windows_amd64.syso（由 rsrc.exe 从 logo.ico 生成）

setlocal

set LAUNCHER_DIR=%~dp0
cd /d "%LAUNCHER_DIR%"

echo [INFO] Building Sidemate.exe
echo [INFO]   - GUI subsystem (windowsgui)
echo [INFO]   - No version injection (see #58)

go build -ldflags "-H windowsgui" -o Sidemate.exe .

if %ERRORLEVEL% EQU 0 (
    echo [OK] Build success: Sidemate.exe
    dir Sidemate.exe | findstr /C:"Sidemate.exe"
) else (
    echo [FAIL] Build failed
    exit /b 1
)

endlocal

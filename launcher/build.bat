@echo off
REM Sidemate Launcher build script
REM P6 统一版本号：唯一来源是 server/config.py
REM   - Go 编译时从 config.py 读取版本号注入 -X main.AppVersion
REM   - Go 运行时也从 config.py 读取（启动时）
REM   - 图标嵌入：rsrc_windows_amd64.syso（由 rsrc.exe 从 logo.ico 生成）

setlocal

set LAUNCHER_DIR=%~dp0
cd /d "%LAUNCHER_DIR%"

REM Extract version from config.py (find the "version": "x.y.z" line)
set VERSION=
set RAW=
for /f "tokens=2 delims=:," %%a in ('findstr /C:"\"version\"" ..\server\config.py') do (
    set RAW=%%a
    goto :got_version
)
:got_version

REM Strip quotes and spaces
set VERSION=%RAW:"=%
set VERSION=%VERSION: =%

if "%VERSION%"=="" (
    echo [WARN] Failed to extract version from config.py, fallback to v0.9.8
    set VERSION=0.9.8
)

echo [INFO] Building Sidemate.exe v%VERSION%
echo [INFO]   - GUI subsystem (windowsgui)
echo [INFO]   - Version inject (-X main.AppVersion)
echo [INFO]   - Source of truth: server/config.py

go build -ldflags "-H windowsgui -X main.AppVersion=v%VERSION%" -o Sidemate.exe .

if %ERRORLEVEL% EQU 0 (
    echo [OK] Build success: Sidemate.exe v%VERSION%
    dir Sidemate.exe | findstr /C:"Sidemate.exe"
) else (
    echo [FAIL] Build failed
    exit /b 1
)

endlocal

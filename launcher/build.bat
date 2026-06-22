@echo off
REM Sidemate Launcher build script
REM P6 统一版本号：唯一来源是 server/config.py
REM   - Go 编译时从 config.py 读取版本号注入 -X main.AppVersion
REM   - Go 运行时也从 config.py 读取（启动时）
REM   - PE 资源由 update_pe_version.py 在编译后自动 patch

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
    echo [WARN] Failed to extract version from config.py, fallback to v0.9.6
    set VERSION=0.9.6
)

echo [INFO] Building Sidemate.exe v%VERSION%
echo [INFO]   - GUI subsystem (windowsgui)
echo [INFO]   - Version inject (-X main.AppVersion)
echo [INFO]   - Source of truth: server/config.py

go build -ldflags "-H windowsgui -X main.AppVersion=v%VERSION%" -o Sidemate.exe .

if %ERRORLEVEL% EQU 0 (
    echo [OK] Build success: Sidemate.exe v%VERSION%
    
    REM P6: 自动 patch PE 资源版本号（从 config.py 读取）
    echo [INFO] Patching PE version info...
    ..\python\python.exe update_pe_version.py
    if %ERRORLEVEL% NEQ 0 (
        echo [WARN] PE patch failed, but build succeeded
    )
    
    dir Sidemate.exe | findstr /C:"Sidemate.exe"
) else (
    echo [FAIL] Build failed
    exit /b 1
)

endlocal

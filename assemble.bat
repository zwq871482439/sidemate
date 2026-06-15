@echo off
chcp 65001 >nul 2>&1
REM ====================================================================
REM Sidemate assemble.bat
REM 一键组装打包工作区：拷贝源码 + 建运行时符号链接
REM 用法：双击运行 或 assemble.bat [目标目录]
REM 默认目标：C:\tmp\_Sidemate_build
REM ====================================================================

setlocal

set "SRC=%~dp0"
if "%~1"=="" (
    set "DST=C:\tmp\_Sidemate_build"
) else (
    set "DST=%~1"
)

echo ============================================
echo   Sidemate 打包工作区组装
echo   源:   %SRC%
echo   目标: %DST%
echo ============================================
echo.

REM 清理旧目录
if exist "%DST%" (
    echo [1/4] 清理旧工作区...
    rmdir /s /q "%DST%" 2>nul
)

REM 创建目标目录
mkdir "%DST%" 2>nul

REM [2/4] 拷贝源码（排除运行时和数据）
echo [2/4] 拷贝源码...
robocopy "%SRC%server" "%DST%\server" /MIR /XD "__pycache__" "models" "data\cache" "data\logs" "data\backup" "data\chats" "data\kb" "data\kbsession" "data\recordings" /XF "*.pyc" "deps_manifest.json" "settings.json" /NJH /NJS /NFL /NDL /NC /NS >nul 2>&1
robocopy "%SRC%launcher" "%DST%\launcher" /MIR /XD "__pycache__" /XF "*.pyc" /NJH /NJS /NFL /NDL /NC /NS >nul 2>&1
robocopy "%SRC%installer" "%DST%\installer" /MIR /NJH /NJS /NFL /NDL /NC /NS >nul 2>&1
robocopy "%SRC%docs" "%DST%\docs" /MIR /NJH /NJS /NFL /NDL /NC /NS >nul 2>&1

REM 拷贝根文件
copy /y "%SRC%setup.iss" "%DST%\" >nul 2>&1
copy /y "%SRC%setup_full.iss" "%DST%\" >nul 2>&1
copy /y "%SRC%LICENSE" "%DST%\" >nul 2>&1
copy /y "%SRC%THIRD-PARTY-NOTICES" "%DST%\" >nul 2>&1
copy /y "%SRC%logo.ico" "%DST%\" >nul 2>&1
copy /y "%SRC%build_full.py" "%DST%\" >nul 2>&1
if exist "%SRC%requirements_gen.txt" copy /y "%SRC%requirements_gen.txt" "%DST%\" >nul 2>&1

echo     源码拷贝完成
echo.

REM [3/4] 建运行时符号链接
echo [3/4] 创建运行时符号链接...
mklink /J "%DST%\python" "%SRC%python" >nul 2>&1
mklink /J "%DST%\server\models" "%SRC%server\models" >nul 2>&1
copy /y "%SRC%ollama.exe" "%DST%\" >nul 2>&1
copy /y "%SRC%Sidemate.exe" "%DST%\" >nul 2>&1

echo     运行时链接完成
echo.

REM [4/4] 验证
echo [4/4] 验证工作区...
set "OK=1"
if not exist "%DST%\server\server.py" ( echo   [X] server\server.py 缺失 & set "OK=0" )
if not exist "%DST%\python\python.exe" ( echo   [X] python\python.exe 缺失 & set "OK=0" )
if not exist "%DST%\ollama.exe" ( echo   [X] ollama.exe 缺失 & set "OK=0" )
if not exist "%DST%\setup.iss" ( echo   [X] setup.iss 缺失 & set "OK=0" )
if exist "%DST%\server\models\blobs" ( echo   [OK] server\models\blobs ) else ( echo   [X] server\models\blobs 缺失 & set "OK=0" )

echo.
if "%OK%"=="1" (
    echo ============================================
    echo   组装成功！
    echo   工作区: %DST%
    echo   下一步: 用 Inno Setup 编译 %DST%\setup.iss
    echo ============================================
) else (
    echo ============================================
    echo   [警告] 部分组件缺失，请检查上方日志
    echo ============================================
)
echo.
pause
endlocal

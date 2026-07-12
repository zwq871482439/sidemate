@echo off
chcp 65001 >nul 2>&1
REM ====================================================================
REM Sidemate 一键开发环境部署脚本 (Windows)
REM ====================================================================
REM 用法：clone 仓库后双击或在终端运行此脚本
REM 会自动：安装 Python 依赖 → 下载 llama-server → 编译 Go Launcher
REM 模型文件不包含在此脚本中，启动后在「设置→模型下载」页下载
REM ====================================================================

set ROOT=%~dp0
cd /d "%ROOT%"

echo ============================================
echo   Sidemate 开发环境部署
echo ============================================
echo.

REM --- 1. 检查 Python ---
echo [1/4] 检查 Python...
where python >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   ❌ 未找到 Python。请安装 Python 3.12+ 并加入 PATH
    echo   下载: https://www.python.org/downloads/
    pause
    exit /b 1
)
python --version
echo   ✅ Python 已安装
echo.

REM --- 2. 安装 Python 依赖 ---
echo [2/4] 安装 Python 依赖...
if not exist requirements_gen.txt (
    echo   ❌ 未找到 requirements_gen.txt
    pause
    exit /b 1
)
pip install -r requirements_gen.txt
if %ERRORLEVEL% neq 0 (
    echo   ⚠️ pip install 有警告，继续尝试...
)
echo   ✅ Python 依赖安装完成
echo.

REM --- 3. 检查/下载 llama-server ---
echo [3/4] 检查 llama-server...
if exist "lib\ollama\llama-server.exe" (
    echo   ✅ llama-server 已存在
) else (
    echo   下载 llama-server...
    mkdir lib\ollama 2>nul
    REM 从 llama.cpp releases 下载预编译版
    echo   请从 https://github.com/ggerganov/llama.cpp/releases 下载 Windows 版
    echo   将 llama-server.exe 放到 lib\ollama\ 目录
    echo   或使用 Inno Setup 安装包自动安装
    echo   ⚠️ 需要手动放置 llama-server.exe
)
echo.

REM --- 4. 编译 Go Launcher (可选) ---
echo [4/4] 检查 Go Launcher...
where go >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   ⚠️ 未安装 Go，跳过 Launcher 编译
    echo   可直接用 python server/server.py 启动后端
) else (
    if exist "Sidemate.exe" (
        echo   ✅ Sidemate.exe 已存在
    ) else (
        echo   编译 Sidemate.exe...
        cd launcher
        go build -ldflags "-H windowsgui -X main.AppVersion=v0.9.7" -o ..\Sidemate.exe .
        cd ..
        if exist "Sidemate.exe" (
            echo   ✅ Sidemate.exe 编译成功
        ) else (
            echo   ⚠️ 编译失败，可直接用 python server/server.py 启动
        )
    )
)
echo.

REM --- 完成 ---
echo ============================================
echo   部署完成！
echo ============================================
echo.
echo 启动方式：
echo   方式一：Sidemate.exe（完整启动，含看门狗）
echo   方式二：python server/server.py（仅后端，调试用）
echo.
echo 首次使用：
echo   1. 启动后进入 设置 → 模型下载
echo   2. 下载 LLM 模型（推荐 4B）和知识库模型
echo   3. 开始对话或知识库问答
echo.
pause

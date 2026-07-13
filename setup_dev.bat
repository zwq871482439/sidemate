@echo off
REM ====================================================================
REM Sidemate Development Environment Setup Script (Windows)
REM ====================================================================
REM Usage: run this script after cloning the repository
REM Steps: install Python deps -> download llama-server -> build Go Launcher
REM Model files are NOT included; download them via Settings -> Model Download
REM ====================================================================

set ROOT=%~dp0
cd /d "%ROOT%"

echo ============================================
echo   Sidemate Dev Environment Setup
echo ============================================
echo.

REM --- 1. Check Python ---
echo [1/4] Checking Python...
where python >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   [ERROR] Python not found. Please install Python 3.12+ and add it to PATH
    echo   Download: https://www.python.org/downloads/
    pause
    exit /b 1
)
python --version
echo   [OK] Python is installed
echo.

REM --- 2. Install Python dependencies ---
echo [2/4] Installing Python dependencies...
if not exist requirements_gen.txt (
    echo   [ERROR] requirements_gen.txt not found
    pause
    exit /b 1
)
pip install -r requirements_gen.txt
if %ERRORLEVEL% neq 0 (
    echo   [WARN] pip install returned warnings, continuing...
)
echo   [OK] Python dependencies installed
echo.

REM --- 3. Check / download llama-server ---
echo [3/4] Checking llama-server...
if exist "lib\ollama\llama-server.exe" (
    echo   [OK] llama-server already exists
) else (
    echo   Downloading llama-server...
    mkdir lib\ollama 2>nul
    REM Download prebuilt binary from llama.cpp releases
    echo   Please download from https://github.com/ggerganov/llama.cpp/releases
    echo   Place llama-server.exe in the lib\ollama\ directory
    echo   Or use the Inno Setup installer to install automatically
    echo   [WARN] llama-server.exe needs to be placed manually
)
echo.

REM --- 4. Build Go Launcher (optional) ---
echo [4/4] Checking Go Launcher...
where go >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   [WARN] Go not installed, skipping Launcher build
    echo   You can start the backend directly with: python server/server.py
) else (
    if exist "Sidemate.exe" (
        echo   [OK] Sidemate.exe already exists
    ) else (
        echo   Building Sidemate.exe...
        cd launcher
        go build -ldflags "-H windowsgui -X main.AppVersion=v0.9.7" -o ..\Sidemate.exe .
        cd ..
        if exist "Sidemate.exe" (
            echo   [OK] Sidemate.exe built successfully
        ) else (
            echo   [WARN] Build failed, you can start with: python server/server.py
        )
    )
)
echo.

REM --- Done ---
echo ============================================
echo   Setup Complete!
echo ============================================
echo.
echo How to start:
echo   Option 1: Sidemate.exe (full launch with watchdog)
echo   Option 2: python server/server.py (backend only, for debugging)
echo.
echo First-time setup:
echo   1. Launch the app, go to Settings -> Model Download
echo   2. Download an LLM model (4B recommended) and KB models
echo   3. Start chatting or using knowledge base Q&A
echo.
pause

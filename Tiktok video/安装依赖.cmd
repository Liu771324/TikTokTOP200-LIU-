@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found. Install Node.js 20 or later and try again.
    pause
    exit /b 1
)

for /f "tokens=1 delims=v." %%V in ('node --version') do set "NODE_MAJOR=%%V"
if %NODE_MAJOR% LSS 20 (
    echo Node.js 20 or later is required. Please upgrade Node.js and try again.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo npm was not found. Reinstall Node.js and make sure npm is on PATH.
    pause
    exit /b 1
)

if not exist "package-lock.json" (
    echo package-lock.json is missing. Run this script from the project folder.
    pause
    exit /b 1
)

echo Installing project dependencies from package-lock.json...
call npm ci --no-audit --no-fund
if errorlevel 1 (
    echo Dependency installation failed. Check your network and npm settings.
    pause
    exit /b 1
)

echo Dependencies installed. You can now run the collector.
pause

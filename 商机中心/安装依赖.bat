@echo off
cd /d "%~dp0"

echo ============================================
echo   Doudian Business Center - Install
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo Please install Node.js v20+ from https://nodejs.org
  echo Select the LTS version, click Next all the way.
  pause
  exit /b 1
)

echo Node.js found. Installing dependencies...
echo This may take 1-2 minutes. Please wait...
echo.

call npm install --registry=https://registry.npmmirror.com
if errorlevel 1 (
  echo.
  echo [ERROR] Installation failed. Check your network and try again.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   Install complete!
echo   Now double-click StartCollect.bat to begin.
echo ============================================
pause

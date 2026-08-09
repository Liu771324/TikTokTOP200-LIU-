@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 20 or newer is required.
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 20 (
  echo [ERROR] Node.js is too old. Install Node.js 20 or newer.
  pause
  exit /b 1
)
echo Installing project dependencies...
call npm install
if errorlevel 1 (
  echo [ERROR] Dependency installation failed. Check the network and try again.
  pause
  exit /b 1
)
echo Installation completed. Double-click the collector start batch file.
pause

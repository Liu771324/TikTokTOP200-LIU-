@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 20 or newer is required.
  echo Run InstallDeps.bat first.
  pause
  exit /b 1
)
if not exist "node_modules\playwright-core" (
  echo [ERROR] Dependencies are not installed.
  echo Run InstallDeps.bat first.
  pause
  exit /b 1
)
echo TOP200 Collector is starting at http://127.0.0.1:8080
echo Keep this window open while collecting data.
node server.js
if errorlevel 1 (
  echo [ERROR] The collector stopped unexpectedly.
  pause
)

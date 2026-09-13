@echo off
cd /d "%~dp0"

echo ============================================
echo   Doudian Business Center - Collector
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo Please double-click InstallDeps.bat first.
  pause
  exit /b 1
)

if not exist "%~dp0node_modules" (
  echo [ERROR] Dependencies not installed.
  echo Please double-click InstallDeps.bat first.
  pause
  exit /b 1
)

echo Starting at http://localhost:8080
echo Close this window to stop the service.
echo.
start "" http://localhost:8080
node server.js
pause

@echo off
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 20 or newer, then run this file again.
  pause
  exit /b 1
)
call npm.cmd ci --ignore-scripts --no-audit --no-fund
if errorlevel 1 (
  echo Dependency installation failed. Check your network and try again.
  pause
  exit /b 1
)
echo Dependencies installed. Run the workbench launcher next.
pause

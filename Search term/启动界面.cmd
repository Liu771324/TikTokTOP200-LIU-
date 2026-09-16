@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "APP_URL=http://127.0.0.1:4173"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found.
  echo Please install Node.js and try again.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm.cmd was not found.
  pause
  exit /b 1
)

curl.exe --silent --fail --max-time 2 "%APP_URL%/api/status" >nul 2>nul
if not errorlevel 1 (
  echo Service is already running. Opening browser...
  start "" "%APP_URL%"
  exit /b 0
)

echo Starting Opportunity Search Console...
start "Opportunity Search Console" /D "%~dp0" cmd.exe /k "npm.cmd start"
timeout /t 2 /nobreak >nul
start "" "%APP_URL%"

endlocal

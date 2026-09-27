@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "APP_PORT=%PORT%"
if not defined APP_PORT set "APP_PORT=8080"
set "APP_URL=http://127.0.0.1:%APP_PORT%/"

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

if not exist "node_modules\playwright-core\package.json" (
    echo Installing project dependencies for the first run...
    call npm ci --no-audit --no-fund
    if errorlevel 1 (
        echo Dependency installation failed. Check your network and npm settings.
        pause
        exit /b 1
    )
)

curl.exe --silent --show-error --fail --output nul "%APP_URL%api/session" >nul 2>nul
if not errorlevel 1 (
    echo The collector is already running. Opening %APP_URL%
    start "" "%APP_URL%"
    exit /b 0
)

echo Starting the collector...
start "" cmd.exe /k node server.js
set "WAIT_COUNT=0"
:wait_for_service
curl.exe --silent --show-error --fail --output nul "%APP_URL%api/session" >nul 2>nul
if not errorlevel 1 goto service_ready
set /a WAIT_COUNT+=1
if %WAIT_COUNT% GEQ 15 goto service_timeout
timeout /t 1 /nobreak >nul
goto wait_for_service

:service_ready
echo The collector is ready. Opening %APP_URL%
start "" "%APP_URL%"
exit /b 0

:service_timeout
echo The service did not start within 15 seconds. Check the collector window for errors.
pause
exit /b 1

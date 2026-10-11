@echo off
setlocal
cd /d "%~dp0"
python -m cost_sync.desktop_app --data-dir "%~dp0storage\test" --environment test --port 8765
if errorlevel 1 pause

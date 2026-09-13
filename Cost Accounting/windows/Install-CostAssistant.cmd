@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-CostAssistant.ps1" -PackageRoot "%~dp0."
if errorlevel 1 (
  echo.
  echo Installation failed. Please send the message above to support.
) else (
  echo.
  echo Installation completed. Finish the Edge step shown above, then open "Cost Assistant" from the desktop.
)
pause
endlocal

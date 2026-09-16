$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot
Write-Host "启动商机双链路控制台：http://127.0.0.1:4173" -ForegroundColor Cyan
npm start

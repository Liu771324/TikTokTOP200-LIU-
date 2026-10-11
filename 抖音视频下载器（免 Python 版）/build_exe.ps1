$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot

python -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --windowed `
    --name "DouyinVideoDownloader" `
    --collect-all playwright `
    --collect-all greenlet `
    --add-binary "ffmpeg.exe;." `
    "douyin_downloader_gui.py"

Write-Host "Build complete: $PSScriptRoot\dist\DouyinVideoDownloader.exe"

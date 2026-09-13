[CmdletBinding()]
param(
    [string]$ProjectRoot = "",
    [string]$PythonExecutable = "python"
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
    $ProjectRoot = Split-Path -Parent $scriptDirectory
}
$projectPath = [System.IO.Path]::GetFullPath($ProjectRoot)
$buildRoot = Join-Path $projectPath "build\cost-assistant"
$distRoot = Join-Path $projectPath "dist"
$packageRoot = Join-Path $distRoot "CostAssistant-Package"
$archivePath = Join-Path $distRoot "CostAssistant-Package.zip"
$appTarget = Join-Path $packageRoot "app"
$extensionTarget = Join-Path $packageRoot "browser_extension"
$seedTarget = Join-Path $packageRoot "seed_data"
$releaseAssets = Join-Path $buildRoot "release-webview-static"

& $PythonExecutable -m PyInstaller --version | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller is required on the build computer. Target computers do not need Python."
}

foreach ($target in @($buildRoot, $packageRoot, $archivePath)) {
    if (Test-Path -LiteralPath $target) {
        $resolved = (Resolve-Path -LiteralPath $target).Path
        if (-not $resolved.StartsWith($projectPath, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Build cleanup target is outside the project directory: $resolved"
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null

& $PythonExecutable `
    (Join-Path $projectPath "windows\prepare_release_webview.py") `
    (Join-Path $projectPath "cost_sync\webview_static") `
    $releaseAssets
if ($LASTEXITCODE -ne 0) {
    throw "Seven-page V2 release WebView asset preparation failed."
}

& $PythonExecutable -m PyInstaller `
    --noconfirm `
    --clean `
    --windowed `
    --name CostAssistant `
    --distpath $packageRoot `
    --workpath $buildRoot `
    --specpath $buildRoot `
    --collect-submodules cost_sync `
    --add-data "$releaseAssets;cost_sync\webview_static" `
    --hidden-import webview.platforms.edgechromium `
    --hidden-import requests `
    --exclude-module tkinter `
    (Join-Path $projectPath "cost_sync\desktop_app.py")
if ($LASTEXITCODE -ne 0) {
    throw "Cost Assistant client build failed."
}

Move-Item -LiteralPath (Join-Path $packageRoot "CostAssistant") -Destination $appTarget
New-Item -ItemType Directory -Path $extensionTarget -Force | Out-Null
$extensionFiles = @(
    "manifest.json",
    "background.js",
    "content.js",
    "core.js",
    "panel.js"
)
foreach ($extensionFile in $extensionFiles) {
    Copy-Item -LiteralPath (Join-Path $projectPath "browser_extension\$extensionFile") -Destination $extensionTarget
}
New-Item -ItemType Directory -Path $seedTarget -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectPath "storage\test\cost_accounting.sqlite3") -Destination $seedTarget
Copy-Item -LiteralPath (Join-Path $projectPath "storage\test\enabled_product_costs.xlsx") -Destination $seedTarget
Copy-Item -LiteralPath (Join-Path $projectPath "windows\Install-CostAssistant.ps1") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectPath "windows\Install-CostAssistant.cmd") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectPath "windows\Show-EdgeExtensionSetup.ps1") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectPath "README.md") -Destination (Join-Path $packageRoot "README.txt")

Compress-Archive -Path (Join-Path $packageRoot "*") -DestinationPath $archivePath -CompressionLevel Optimal
Write-Output "Package created: $packageRoot"
Write-Output "Archive created: $archivePath"
Write-Output "Release profile: V2 (seven desktop pages)"

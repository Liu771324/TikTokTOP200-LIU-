[CmdletBinding()]
param(
    [string]$PackageRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "CostAssistant"),
    [string]$DesktopDirectory = [Environment]::GetFolderPath("Desktop"),
    [string]$NativeRegistryRoot = "HKCU:\Software",
    [string]$EdgeExecutable = "",
    [switch]$SkipEdgeLaunch,
    [switch]$SkipClipboard,
    [switch]$Uninstall,
    [switch]$RemoveData
)

$ErrorActionPreference = "Stop"
$packagePath = [System.IO.Path]::GetFullPath($PackageRoot)
$installPath = [System.IO.Path]::GetFullPath($InstallRoot)
$appSource = Join-Path $packagePath "app"
$extensionSource = Join-Path $packagePath "browser_extension"
$seedDataSource = Join-Path $packagePath "seed_data"
$appTarget = Join-Path $installPath "app"
$extensionTarget = Join-Path $installPath "browser_extension"
$dataTarget = Join-Path $installPath "data"
$executableTarget = Join-Path $appTarget "CostAssistant.exe"
$desktopShortcut = Join-Path $DesktopDirectory "Cost Assistant.lnk"
$legacyNativeHostName = "com.costassistant.launcher"
$legacyNativeManifest = Join-Path $installPath "native-messaging-host.json"
$legacyNativeRegistryKeys = @(
    (Join-Path $NativeRegistryRoot "Google\Chrome\NativeMessagingHosts\$legacyNativeHostName"),
    (Join-Path $NativeRegistryRoot "Microsoft\Edge\NativeMessagingHosts\$legacyNativeHostName")
)
$shell = New-Object -ComObject WScript.Shell
$webView2OfflineInstaller = Join-Path $packagePath "prerequisites\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
$edgeSetupHelper = Join-Path $packagePath "Show-EdgeExtensionSetup.ps1"
$extensionFiles = @(
    "manifest.json",
    "background.js",
    "content.js",
    "core.js",
    "panel.js"
)

function Get-WebView2RuntimeVersion {
    $clientRoots = @(
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients",
        "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients",
        "HKCU:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients"
    )
    foreach ($clientRoot in $clientRoots) {
        if (-not (Test-Path -LiteralPath $clientRoot)) {
            continue
        }
        foreach ($client in Get-ChildItem -LiteralPath $clientRoot -ErrorAction SilentlyContinue) {
            $properties = Get-ItemProperty -LiteralPath $client.PSPath -ErrorAction SilentlyContinue
            if ($properties.name -eq "Microsoft Edge WebView2 Runtime" -and $properties.pv -and $properties.pv -notmatch '^0(?:\.0)*$') {
                return [string]$properties.pv
            }
        }
    }
    return $null
}

function Get-ShortcutArguments {
    return "--data-dir `"$dataTarget`" --environment test --port 8765"
}

function Test-OwnedShortcut {
    if (-not (Test-Path -LiteralPath $desktopShortcut -PathType Leaf)) {
        return $false
    }
    $shortcut = $shell.CreateShortcut($desktopShortcut)
    return (
        [System.IO.Path]::GetFullPath($shortcut.TargetPath) -eq $executableTarget -and
        $shortcut.Arguments -eq (Get-ShortcutArguments) -and
        [System.IO.Path]::GetFullPath($shortcut.WorkingDirectory) -eq $appTarget
    )
}

function Test-OwnedLegacyNativeRegistration([string]$RegistryKey) {
    if (-not (Test-Path -LiteralPath $RegistryKey)) {
        return $false
    }
    $registeredManifest = (Get-Item -LiteralPath $RegistryKey).GetValue("")
    if ([string]::IsNullOrWhiteSpace($registeredManifest)) {
        return $false
    }
    try {
        return [System.IO.Path]::GetFullPath($registeredManifest) -eq $legacyNativeManifest
    }
    catch {
        return $false
    }
}

function Remove-OwnedLegacyNativeMessaging {
    foreach ($registryKey in $legacyNativeRegistryKeys) {
        if ((Test-Path -LiteralPath $registryKey) -and (Test-OwnedLegacyNativeRegistration $registryKey)) {
            Remove-Item -LiteralPath $registryKey -Recurse -Force
        }
    }
    if (Test-Path -LiteralPath $legacyNativeManifest -PathType Leaf) {
        if ((Split-Path -Parent ([System.IO.Path]::GetFullPath($legacyNativeManifest))) -ne $installPath) {
            throw "Legacy native messaging manifest is outside the install root: $legacyNativeManifest"
        }
        Remove-Item -LiteralPath $legacyNativeManifest -Force
    }
}

function Get-Sha256([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "")
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Confirm-ExtensionFilesMatch {
    foreach ($extensionFile in $extensionFiles) {
        $source = Join-Path $extensionSource $extensionFile
        $target = Join-Path $extensionTarget $extensionFile
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Package is missing browser extension file: $source"
        }
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
            throw "Browser extension integrity check failed; installed file is missing: $target"
        }
        $sourceHash = Get-Sha256 $source
        $targetHash = Get-Sha256 $target
        if ($sourceHash -ne $targetHash) {
            throw "Browser extension integrity check failed for: $extensionFile"
        }
    }
}

if ($Uninstall) {
    if (Test-Path -LiteralPath $desktopShortcut -PathType Leaf) {
        if (-not (Test-OwnedShortcut)) {
            throw "Refusing to remove a desktop shortcut not owned by this package: $desktopShortcut"
        }
        Remove-Item -LiteralPath $desktopShortcut -Force
    }
    Remove-OwnedLegacyNativeMessaging
    foreach ($target in @($appTarget, $extensionTarget)) {
        if (Test-Path -LiteralPath $target) {
            $resolved = (Resolve-Path -LiteralPath $target).Path
            if ((Split-Path -Parent $resolved) -ne $installPath) {
                throw "Uninstall target is outside the install root: $resolved"
            }
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
    if ($RemoveData -and (Test-Path -LiteralPath $dataTarget)) {
        $resolvedData = (Resolve-Path -LiteralPath $dataTarget).Path
        if ((Split-Path -Parent $resolvedData) -ne $installPath) {
            throw "Data target is outside the install root: $resolvedData"
        }
        Remove-Item -LiteralPath $resolvedData -Recurse -Force
    }
    $dataStatus = if ($RemoveData) { "removed" } else { "preserved" }
    Write-Output "Cost Assistant uninstalled. Business data: $dataStatus."
    exit 0
}

if (-not (Test-Path -LiteralPath (Join-Path $appSource "CostAssistant.exe") -PathType Leaf)) {
    throw "Package is missing the client executable: $appSource"
}
if (-not (Test-Path -LiteralPath (Join-Path $extensionSource "manifest.json") -PathType Leaf)) {
    throw "Package is missing the browser extension: $extensionSource"
}
foreach ($extensionFile in $extensionFiles) {
    $source = Join-Path $extensionSource $extensionFile
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Package is missing browser extension file: $source"
    }
}
if (-not (Test-Path -LiteralPath $edgeSetupHelper -PathType Leaf)) {
    throw "Package is missing the Edge extension setup helper: $edgeSetupHelper"
}
if (-not (Test-Path -LiteralPath (Join-Path $seedDataSource "cost_accounting.sqlite3") -PathType Leaf)) {
    throw "Package is missing the seed database: $seedDataSource"
}
if (Get-Process -Name "CostAssistant" -ErrorAction SilentlyContinue) {
    throw "Close Cost Assistant before installing or upgrading."
}

$webView2Version = Get-WebView2RuntimeVersion
if (-not $webView2Version -and (Test-Path -LiteralPath $webView2OfflineInstaller -PathType Leaf)) {
    Write-Output "Installing bundled Microsoft Edge WebView2 Runtime..."
    $runtimeProcess = Start-Process -FilePath $webView2OfflineInstaller -ArgumentList "/silent", "/install" -Wait -PassThru -WindowStyle Hidden
    if ($runtimeProcess.ExitCode -ne 0) {
        throw "Bundled WebView2 Runtime installer failed with exit code $($runtimeProcess.ExitCode)."
    }
    $webView2Version = Get-WebView2RuntimeVersion
}
if (-not $webView2Version) {
    throw "Microsoft Edge WebView2 Runtime is required. For online installation visit https://developer.microsoft.com/microsoft-edge/webview2/. For offline installation place MicrosoftEdgeWebView2RuntimeInstallerX64.exe in the package prerequisites folder and run this installer again."
}
Write-Output "Microsoft Edge WebView2 Runtime detected: $webView2Version"

if ((Test-Path -LiteralPath $desktopShortcut -PathType Leaf) -and -not (Test-OwnedShortcut)) {
    throw "A desktop shortcut with the same name is not owned by this package: $desktopShortcut"
}

& $edgeSetupHelper `
    -ExtensionDirectory $extensionSource `
    -EdgeExecutable $EdgeExecutable `
    -SkipEdgeLaunch `
    -SkipClipboard | Out-Null

New-Item -ItemType Directory -Path $installPath -Force | Out-Null
New-Item -ItemType Directory -Path $dataTarget -Force | Out-Null
New-Item -ItemType Directory -Path $DesktopDirectory -Force | Out-Null
Remove-OwnedLegacyNativeMessaging

foreach ($pair in @(
    @{ Source = $appSource; Target = $appTarget },
    @{ Source = $extensionSource; Target = $extensionTarget }
)) {
    if (Test-Path -LiteralPath $pair.Target) {
        $resolved = (Resolve-Path -LiteralPath $pair.Target).Path
        if ((Split-Path -Parent $resolved) -ne $installPath) {
            throw "Upgrade target is outside the install root: $resolved"
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    Copy-Item -LiteralPath $pair.Source -Destination $pair.Target -Recurse
}
Confirm-ExtensionFilesMatch

foreach ($seedName in @("cost_accounting.sqlite3", "enabled_product_costs.xlsx")) {
    $source = Join-Path $seedDataSource $seedName
    $target = Join-Path $dataTarget $seedName
    if (-not (Test-Path -LiteralPath $target) -and (Test-Path -LiteralPath $source)) {
        Copy-Item -LiteralPath $source -Destination $target
    }
}

$shortcut = $shell.CreateShortcut($desktopShortcut)
$shortcut.TargetPath = $executableTarget
$shortcut.Arguments = Get-ShortcutArguments
$shortcut.WorkingDirectory = $appTarget
$shortcut.Description = "Open Cost Assistant manually"
$shortcut.IconLocation = "$executableTarget,0"
$shortcut.WindowStyle = 1
$shortcut.Save()
if (-not (Test-OwnedShortcut)) {
    throw "Desktop shortcut verification failed: $desktopShortcut"
}

Write-Output "Cost Assistant installed: $installPath"
Write-Output "Desktop shortcut: $desktopShortcut"
Write-Output "Browser extension: $extensionTarget"
Write-Output "Existing data is preserved during upgrades: $dataTarget"

& $edgeSetupHelper `
    -ExtensionDirectory $extensionTarget `
    -EdgeExecutable $EdgeExecutable `
    -SkipEdgeLaunch:$SkipEdgeLaunch `
    -SkipClipboard:$SkipClipboard

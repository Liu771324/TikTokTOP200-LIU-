[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ExtensionDirectory,
    [string]$ExpectedExtensionId = "kbdiohjlofljeafaddehaeciappaefka",
    [string]$ExpectedVersion = "0.1.0",
    [string]$EdgeExecutable = "",
    [switch]$SkipEdgeLaunch,
    [switch]$SkipClipboard
)

$ErrorActionPreference = "Stop"
$extensionPath = [System.IO.Path]::GetFullPath($ExtensionDirectory)
$manifestPath = Join-Path $extensionPath "manifest.json"

function Get-ExtensionId([string]$PublicKey) {
    try {
        $keyBytes = [Convert]::FromBase64String($PublicKey)
    }
    catch {
        throw "Browser extension manifest contains an invalid public key."
    }
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha256.ComputeHash($keyBytes)
    }
    finally {
        $sha256.Dispose()
    }
    $alphabet = "abcdefghijklmnop"
    $characters = foreach ($byte in $digest[0..15]) {
        $alphabet[[int]($byte -shr 4)]
        $alphabet[[int]($byte -band 15)]
    }
    return -join $characters
}

function Find-EdgeExecutable([string]$ExplicitPath) {
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        $resolvedExplicit = [System.IO.Path]::GetFullPath($ExplicitPath)
        if (-not (Test-Path -LiteralPath $resolvedExplicit -PathType Leaf)) {
            throw "Microsoft Edge browser is missing: $resolvedExplicit"
        }
        return $resolvedExplicit
    }

    $candidates = @()
    $command = Get-Command "msedge.exe" -ErrorAction SilentlyContinue
    if ($command) {
        $candidates += $command.Source
    }
    if (${env:ProgramFiles(x86)}) {
        $candidates += (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe")
    }
    if ($env:ProgramFiles) {
        $candidates += (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe")
    }
    if ($env:LOCALAPPDATA) {
        $candidates += (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
    }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return [System.IO.Path]::GetFullPath($candidate)
        }
    }
    throw "Microsoft Edge browser is required for the browser extension. WebView2 Runtime alone is not Microsoft Edge."
}

if (-not (Test-Path -LiteralPath $extensionPath -PathType Container)) {
    throw "Browser extension directory is missing: $extensionPath"
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Browser extension manifest is missing: $manifestPath"
}

try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
}
catch {
    throw "Browser extension manifest is invalid: $manifestPath"
}
$actualId = Get-ExtensionId ([string]$manifest.key)
if ($actualId -ne $ExpectedExtensionId) {
    throw "Browser extension ID mismatch. Expected $ExpectedExtensionId, found $actualId."
}
if ([string]$manifest.version -ne $ExpectedVersion) {
    throw "Browser extension version mismatch. Expected $ExpectedVersion, found $($manifest.version)."
}

$edgePath = Find-EdgeExecutable $EdgeExecutable
if (-not $SkipClipboard) {
    try {
        Set-Clipboard -Value $extensionPath
        Write-Output "Extension directory copied to the clipboard: $extensionPath"
    }
    catch {
        Write-Warning "Clipboard copy was unavailable. Copy this directory manually: $extensionPath"
    }
}

if (-not $SkipEdgeLaunch) {
    Start-Process -FilePath $edgePath -ArgumentList "edge://extensions/"
}

Write-Output "Microsoft Edge extension setup page: edge://extensions/"
Write-Output "Expected extension ID: $ExpectedExtensionId"
Write-Output "Expected extension version: $ExpectedVersion"
Write-Output "Extension directory: $extensionPath"
Write-Output "EXTENSION_NOT_LOADED: If no card with this ID exists, enable Developer mode, choose Load unpacked, and paste the copied directory."
Write-Output "EXTENSION_VERSION_MISMATCH: If the card exists but its version differs, choose Reload and verify the version again."
Write-Output "EXTENSION_READY: If the ID and version both match, no additional extension installation is needed."

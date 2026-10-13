param(
    [Parameter(Mandatory=$true)][string]$Version,
    [Parameter(Mandatory=$true)][string]$PythonExe,
    [Parameter(Mandatory=$true)][string]$NodeExe,
    [Parameter(Mandatory=$true)][string]$FFmpegExe,
    [Parameter(Mandatory=$true)][string]$ISCCExe,
    [Parameter(Mandatory=$true)][string]$WebView2Bootstrapper,
    [string]$NodeLicense,
    [string]$FFmpegLicense,
    [string]$BuildVenvPath
)
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $WebView2Bootstrapper
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') {
    throw 'WebView2 bootstrapper must have a valid Microsoft signature.'
}
$buildArguments = @((Join-Path $PSScriptRoot 'build.py'), '--version', $Version,
    '--node', $NodeExe, '--ffmpeg', $FFmpegExe, '--iscc', $ISCCExe,
    '--bootstrapper', $WebView2Bootstrapper)
if ($NodeLicense) { $buildArguments += @('--node-license', $NodeLicense) }
if ($FFmpegLicense) { $buildArguments += @('--ffmpeg-license', $FFmpegLicense) }
if ($BuildVenvPath) { $buildArguments += @('--build-venv', $BuildVenvPath) }
& $PythonExe @buildArguments
if ($LASTEXITCODE -ne 0) { throw "Windows build failed with exit code $LASTEXITCODE" }

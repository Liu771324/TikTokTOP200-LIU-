$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskUrl = 'http://127.0.0.1:8080'
$taskExisting = $null
try { $taskExisting = Invoke-RestMethod -Uri "$taskUrl/api/state" -TimeoutSec 2 } catch {}
if ($taskExisting.app -eq 'product-title-workbench') {
    if ($taskExisting.phase -in @('disconnected', 'error')) {
        try {
            $taskDebug = Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 2
            if ($taskDebug.webSocketDebuggerUrl) {
                [void](Invoke-RestMethod -Uri "$taskUrl/api/connect" -Method Post -Headers @{ Origin = $taskUrl } -ContentType 'application/json' -Body '{}' -TimeoutSec 3)
            }
        } catch {}
    }
    Start-Process -FilePath $taskUrl
    Write-Host '已打开现有标题工作台。'
    exit 0
}
$taskNode = Get-Command node.exe -ErrorAction Stop
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\playwright-core'))) {
    Write-Host '请先运行 安装依赖.bat'
    exit 1
}
$taskInfo = New-Object System.Diagnostics.ProcessStartInfo
$taskInfo.FileName = $taskNode.Source
$taskInfo.Arguments = 'server.js'
$taskInfo.WorkingDirectory = $PSScriptRoot
$taskInfo.UseShellExecute = $false
$taskInfo.CreateNoWindow = $true
$taskInfo.RedirectStandardInput = $true
$taskInfo.RedirectStandardOutput = $true
$taskInfo.RedirectStandardError = $true
$taskInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$taskInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
$taskInfo.EnvironmentVariables['PRODUCT_TITLE_OWNER_PID'] = [string]$PID
$taskProcess = New-Object System.Diagnostics.Process
$taskProcess.StartInfo = $taskInfo
try {
    [void]$taskProcess.Start()
    $taskError = $taskProcess.StandardError.ReadToEndAsync()
    while (-not $taskProcess.StandardOutput.EndOfStream) {
        Write-Host $taskProcess.StandardOutput.ReadLine()
    }
    $taskProcess.WaitForExit()
    $taskErrorText = $taskError.GetAwaiter().GetResult()
    if ($taskErrorText) { Write-Host $taskErrorText }
    $taskExitCode = $taskProcess.ExitCode
} finally {
    if (-not $taskProcess.HasExited) {
        $taskProcess.StandardInput.Close()
        [void]$taskProcess.WaitForExit(45000)
    }
    $taskProcess.Dispose()
}
exit $taskExitCode

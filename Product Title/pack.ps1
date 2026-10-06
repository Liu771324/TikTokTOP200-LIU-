$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$taskOutput = Join-Path $taskRoot 'portable'
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskStage = Join-Path $taskOutput ('.staging-' + [Guid]::NewGuid().ToString('N'))
$taskPackage = Join-Path $taskStage 'Product Title'
$taskZip = Join-Path $taskOutput "Product-Title-$taskStamp.zip"
$taskFiles = @(
    'browser.js', 'server.js', 'task.js', 'report.js', 'workbook.js',
    'launch.ps1', 'package.json', 'package-lock.json',
    '安装依赖.bat', '启动标题工作台.bat', '使用说明.md', '迁移说明.md',
    'pack.ps1', '打包工作台.bat'
)
$taskInput = @(Get-ChildItem -LiteralPath $taskRoot -File | Where-Object { $_.Name -match '^标题\.(xls|xlsx)$' })
if ($taskInput.Count -gt 1) { throw '同时存在两份标题表，请只保留本次迁移的一份再打包。' }
if (Test-Path -LiteralPath $taskZip) { throw "同名压缩包已存在：$taskZip，请稍后重试。" }
foreach ($taskFile in $taskFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot $taskFile) -PathType Leaf)) { throw "缺少必要文件：$taskFile" }
}
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'public') -PathType Container)) { throw '缺少 public 界面目录。' }

[void](New-Item -ItemType Directory -Path $taskPackage -Force)
try {
    foreach ($taskFile in $taskFiles) {
        Copy-Item -LiteralPath (Join-Path $taskRoot $taskFile) -Destination $taskPackage
    }
    Copy-Item -LiteralPath (Join-Path $taskRoot 'public') -Destination $taskPackage -Recurse
    foreach ($taskSheet in $taskInput) { Copy-Item -LiteralPath $taskSheet.FullName -Destination $taskPackage }
    Compress-Archive -LiteralPath $taskPackage -DestinationPath $taskZip -CompressionLevel Optimal
    $taskHash = (Get-FileHash -LiteralPath $taskZip -Algorithm SHA256).Hash.ToLowerInvariant()
    [System.IO.File]::WriteAllText("$taskZip.sha256", "$taskHash  $([System.IO.Path]::GetFileName($taskZip))`r`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "迁移包：$taskZip"
    Write-Host "大小：$([Math]::Round((Get-Item -LiteralPath $taskZip).Length / 1KB, 1)) KB"
    Write-Host '其他电脑解压后先运行 安装依赖.bat，再运行 启动标题工作台.bat。'
    if (-not $taskInput.Count) { Write-Host '当前没有附带标题表，请在新电脑自行放入 标题.xls 或 标题.xlsx。' }
} finally {
    $taskResolvedStage = [System.IO.Path]::GetFullPath($taskStage)
    $taskExpectedPrefix = [System.IO.Path]::GetFullPath($taskOutput) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $taskResolvedStage.StartsWith($taskExpectedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw '暂存目录校验失败，不执行清理。' }
    if (Test-Path -LiteralPath $taskResolvedStage) { Remove-Item -LiteralPath $taskResolvedStage -Recurse -Force }
}

# 抖店商机中心 — 一键采集入口（终端版）
# 用法：右键此文件 → “使用 PowerShell 运行”
# 流程：确保调试版 Edge（自动检测路径/自动拉起）→ 等登录 → 自动采集 → 生成报告
# 界面版请看 启动采集.bat

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cdpUrl = 'http://localhost:9222'

Push-Location $scriptDir
try {
    # 检查依赖
    node -e "require.resolve('playwright-core');require.resolve('xlsx')" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw '未安装项目依赖。请先双击 安装依赖.bat。'
    }

    Write-Host '========================================' -ForegroundColor Cyan
    Write-Host '  抖店商机中心 - 成交增长采集' -ForegroundColor Cyan
    Write-Host '========================================' -ForegroundColor Cyan

    # 确保调试版 Edge（自动检测路径，没有则自动拉起）
    $result = node edge.js ensure | ConvertFrom-Json
    if ($result.status -eq 'need-path') {
        Write-Host '未自动找到 Microsoft Edge。请在浏览器地址栏输入 edge://version，' -ForegroundColor Yellow
        Write-Host '复制「可执行文件路径」粘贴到这里（只需一次，之后自动记住）：' -ForegroundColor Yellow
        $edgePath = Read-Host 'Edge 路径'
        if ([string]::IsNullOrWhiteSpace($edgePath) -or -not (Test-Path -LiteralPath $edgePath)) {
            throw "Edge 路径无效：$edgePath"
        }
        node edge.js save-path $edgePath | Out-Null
        # 保存后再拉起
        $result = node edge.js ensure | ConvertFrom-Json
    }

    if ($result.status -eq 'launched') {
        Write-Host '已启动调试版 Edge。请在 Edge 中登录抖店，' -ForegroundColor Green
        Write-Host '登录完成后回到此窗口按任意键开始。' -ForegroundColor Green
        $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    }

    # 可选：选择类目（默认取 categories.json 第一条）
    $categories = (Get-Content -Raw -Path (Join-Path $scriptDir 'categories.json') | ConvertFrom-Json).categories
    if ($categories.Count -gt 1) {
        Write-Host ''
        Write-Host '请选择类目：' -ForegroundColor Cyan
        for ($i = 0; $i -lt $categories.Count; $i++) {
            Write-Host ("{0}. {1}" -f ($i + 1), $categories[$i].name)
        }
        $choice = Read-Host '输入编号（直接回车 = 第1个）'
        if ([string]::IsNullOrWhiteSpace($choice)) { $choice = '1' }
        $idx = [int]$choice - 1
        if ($idx -lt 0 -or $idx -ge $categories.Count) { throw '编号无效' }
        $cat = $categories[$idx]
    } else {
        $cat = $categories[0]
    }
    Write-Host ('开始采集：' + $cat.name) -ForegroundColor Cyan

    # 采集
    $env:CATEGORY_SEARCH = $cat.search
    $env:CATEGORY_LABEL = $cat.label
    $env:MIN_SALES = if ($env:MIN_SALES) { $env:MIN_SALES } else { '10000' }
    $env:MAX_SALES = if ($null -ne $env:MAX_SALES) { $env:MAX_SALES } else { '' }
    $collectionStartedAt = Get-Date
    node .\collect_v4.js
    if ($LASTEXITCODE -ne 0) {
        throw '采集未完成；请查看上方错误信息。'
    }
} finally {
    Remove-Item Env:CATEGORY_SEARCH -ErrorAction SilentlyContinue
    Remove-Item Env:CATEGORY_LABEL -ErrorAction SilentlyContinue
    Remove-Item Env:MAX_SALES -ErrorAction SilentlyContinue
    Pop-Location
}

Write-Host ''
$partialReport = Join-Path $scriptDir '选品报告-成交增长-部分.md'
if ((Test-Path -LiteralPath $partialReport) -and (Get-Item -LiteralPath $partialReport).LastWriteTime -ge $collectionStartedAt) {
    Write-Host '采集提前结束。部分报告：选品报告-成交增长-部分.md；上一份完整报告已保留。' -ForegroundColor Yellow
} else {
    Write-Host '采集完成。最新报告：选品报告-成交增长.md；历史归档在 reports 目录。' -ForegroundColor Green
}
Write-Host '按任意键退出...'
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')

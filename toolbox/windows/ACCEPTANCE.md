# 本机安装、覆盖升级与卸载验收步骤

这是可重复执行的开发验收步骤。2026-10-13已执行的本机结果见[本机验收记录](../../docs/TOOLBOX_V1_LOCAL_ACCEPTANCE.md)，未覆盖场景继续保留为待验证。本机验收不能替代没有 Python/Node 的干净 Windows 10/11 验收。

## 前置条件

1. 真实业务任务已收尾，源码桌面和所有工具箱实例通过“退出”正常结束，固定 InstallGuard 已释放。不要仅关闭窗口到托盘，不强杀进程。
2. 使用普通用户权限；确认当前账号尚未安装另一个需要保留的工具箱版本。若已有安装，记录其程序位置和卸载信息，由主协调者安排覆盖，不能用测试卸载另一个用户的安装。
3. 正式发布目录必须同时有 onedir、installer、manifest.json、SHA256SUMS.txt。早期手工修复后单独编译成功的安装包，没有完整清单时不作为正式发布。
4. 核对 manifest 的版本、sourceCommit、sourceDirty。正式包应来自指定提交且 sourceDirty=false；四个 tools.json 的 available 均为 true。构建脚本会如实记录 dirty，不自动提交或替开发者启用工具。
5. 本机已具备 Edge/WebView2；本轮不卸载这些系统组件来制造缺失场景。缺失引导另在干净目标环境验证。

验收过程不删除 `%LOCALAPPDATA%\ScriptAllToolbox`。现有 SQLite、任务、媒体、profile 不改名、不移动、不注入测试数据。下面的快照只读文件并保存路径/哈希，不读取或输出数据库内容、Cookie、签名链接或商家明细。请勿把快照和安装日志提交 Git。

## 1. 设置正式包与中文程序目录

在仓库根目录 PowerShell 执行；首先把 `<正式构建目录>` 替换为实际新目录。其余路径不是普通用户操作要求。

```powershell
$releaseRoot = (Resolve-Path -LiteralPath 'D:\前端\ai\Script All\dist\release\<正式构建目录>').Path
$manifest = Get-Content -LiteralPath (Join-Path $releaseRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
if ($manifest.sourceDirty) { throw '正式包包含未提交变更，请核对后重新完整构建。' }
$installer = Join-Path $releaseRoot $manifest.installer.path
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $manifest.installer.sha256) {
    throw '安装包哈希与manifest不一致。'
}
$toolsPath = Join-Path $releaseRoot 'app\ScriptAllToolbox\_internal\toolbox\tools.json'
$tools = @(Get-Content -LiteralPath $toolsPath -Raw -Encoding UTF8 | ConvertFrom-Json)
if ($tools.Count -ne 4 -or @($tools | Where-Object { -not $_.available }).Count) {
    throw '四工具尚未全部启用，不能执行正式包验收。'
}
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\电商工具箱 安装验收'
$userDataDir = Join-Path $env:LOCALAPPDATA 'ScriptAllToolbox'
$evidenceDir = Join-Path $PWD ('toolbox\build\install-acceptance\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $evidenceDir -ErrorAction Stop | Out-Null
$installedExe = Join-Path $installDir 'ScriptAllToolbox.exe'
```

第一次安装时，`$installDir` 应为尚不存在的新目录；如果已经存在，先确认是本次验收登记的安装目录，不删目录“重来”。manifest 内还应核对应用文件总数/总大小与源码提交。SHA256SUMS.txt 的每个条目均需核验，可由主协调者现有文件验证工具完成。

## 2. 用户数据保留快照

在应用完全退出时运行快照。范围包括数据库、任务、媒体和浏览器配置；日志、scratch 不作为内容保持不变的断言。首次无数据时记录为空，之后还需在使用过的账户/有现成结果环境补验证。

```powershell
function Save-ToolboxDataSnapshot([string]$Name) {
    $base = [System.IO.Path]::GetFullPath($userDataDir).TrimEnd('\')
    $records = @()
    foreach ($entry in @('toolbox.sqlite3', 'toolbox.sqlite3-wal', 'toolbox.sqlite3-shm', 'tasks', 'media', 'browser-profile', 'webview-profile')) {
        $path = Join-Path $base $entry
        if (-not (Test-Path -LiteralPath $path)) { continue }
        foreach ($file in @(Get-Item -LiteralPath $path) + @(Get-ChildItem -LiteralPath $path -Recurse -File -ErrorAction Stop)) {
            if ($file.PSIsContainer) { continue }
            $absolute = [System.IO.Path]::GetFullPath($file.FullName)
            if (-not $absolute.StartsWith($base + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
                throw '快照目标超出用户数据目录。'
            }
            $records += [pscustomobject]@{ path=$absolute.Substring($base.Length + 1); size=$file.Length;
                sha256=(Get-FileHash -LiteralPath $absolute -Algorithm SHA256).Hash }
        }
    }
    $records = @($records | Sort-Object path -Unique)
    ConvertTo-Json -InputObject $records -Depth 4 | Set-Content -LiteralPath (Join-Path $evidenceDir ($Name + '.json')) -Encoding UTF8
}
function Assert-ToolboxDataUnchanged([string]$Before, [string]$After) {
    $left = Get-Content -LiteralPath (Join-Path $evidenceDir ($Before + '.json')) -Raw -Encoding UTF8
    $right = Get-Content -LiteralPath (Join-Path $evidenceDir ($After + '.json')) -Raw -Encoding UTF8
    if ($left -ne $right) { throw '数据快照变化，停止验收并检查；不要删除或重建数据。' }
}
Save-ToolboxDataSnapshot 'before-install'
```

快照需要现有 profile 文件可读；若仍被占用，先确认工具箱已正常退出，不为取得快照结束用户的其他浏览器或更改文件权限。

## 3. 安装到中文/空格路径

以下是显式执行安装的步骤，只有主协调者开始安装验收时才运行。`/SILENT` 配合脚本现有 skipifsilent 不自动启动桌面；`/NORESTART` 禁止自动重启系统。

```powershell
$installLog = Join-Path $evidenceDir 'install.log'
$process = Start-Process -FilePath $installer -ArgumentList @('/SP-', '/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
    "/DIR=`"$installDir`"", "/LOG=`"$installLog`"") -WindowStyle Hidden -PassThru
if (-not $process.WaitForExit(60000)) { throw '安装超过60秒；保留进程和日志，由人检查，不强杀。' }
if ($process.ExitCode -ne 0) { throw "安装失败，退出码 $($process.ExitCode)" }
if (-not (Test-Path -LiteralPath $installedExe)) { throw '安装后未找到程序。' }
Save-ToolboxDataSnapshot 'after-install'
Assert-ToolboxDataUnchanged 'before-install' 'after-install'
```

人工核对开始菜单快捷方式指向中文安装目录；默认不勾选桌面快捷方式。确认安装日志没有启动微软 bootstrapper（当前已有 WebView2），没有请求管理员权限或重启。

## 4. 安装后桌面与结果可用性

由人点击快捷方式启动安装版，核对四工具导航、已有任务/结果、分页与打开/导出。此处不新建真实采集任务；媒体只播放已有结果。关闭窗口应缩到托盘，从托盘恢复，再通过托盘“退出”正常结束。程序目录只含程序，新增应用数据位于 `$userDataDir`。

可单独对安装目录 exe 执行 `--smoke`，使用临时数据并等待60秒的退出码；这是冻结启动回归，不代表正式用户数据已正确恢复。不要给冻结版传 `--acceptance`，它只允许源码验收。

应用运行会正常改变 SQLite/profile，所以在正常退出后重新建立下一步的数据基线，不能拿启动前后的整个 profile 哈希相等作为要求。

## 5. 运行中升级保护与退出后覆盖安装

1. 在安装版正常运行且没有采集任务时记录已安装 exe 的 SHA256。
2. 再运行同包安装程序，使用上一步的静默参数及新的 upgrade-blocked.log。AppMutex 应使安装取消/返回非零，安装文件哈希不变，原桌面仍可用。若运行交互向导，应明确要求退出原实例；取消向导，不使用强制关闭参数。
3. 从工具箱托盘正常退出；确认没有工具箱所属后台进程残留后执行下面命令。此处同版本覆盖验证升级保留路径/数据的机制；不同版本升级还需用另一个已提交版本的完整包单独验证。

```powershell
Save-ToolboxDataSnapshot 'before-upgrade'
$upgradeLog = Join-Path $evidenceDir 'upgrade.log'
$process = Start-Process -FilePath $installer -ArgumentList @('/SP-', '/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
    "/LOG=`"$upgradeLog`"") -WindowStyle Hidden -PassThru
if (-not $process.WaitForExit(60000)) { throw '覆盖安装超过60秒，请人工检查。' }
if ($process.ExitCode -ne 0) { throw "覆盖安装失败，退出码 $($process.ExitCode)" }
if (-not (Test-Path -LiteralPath $installedExe)) { throw '覆盖安装没有保留原程序目录。' }
Save-ToolboxDataSnapshot 'after-upgrade'
Assert-ToolboxDataUnchanged 'before-upgrade' 'after-upgrade'
```

覆盖安装故意不传 `/DIR`，验证 UsePreviousAppDir 记住中文/空格路径。再次启动验证旧结果可打开，然后正常退出。

## 6. 卸载保留数据与再次安装识别

仅运行本次验收安装目录内、由安装程序生成的卸载器，绝不手动递归删除目录。

```powershell
Save-ToolboxDataSnapshot 'before-uninstall'
$uninstaller = Join-Path $installDir 'unins000.exe'
if (-not (Test-Path -LiteralPath $uninstaller)) { throw '未找到本次验收卸载器，请核对安装登记。' }
$uninstallLog = Join-Path $evidenceDir 'uninstall.log'
$process = Start-Process -FilePath $uninstaller -ArgumentList @('/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
    "/LOG=`"$uninstallLog`"") -WindowStyle Hidden -PassThru
if (-not $process.WaitForExit(60000)) { throw '卸载超过60秒，请人工检查。' }
if ($process.ExitCode -ne 0) { throw "卸载失败，退出码 $($process.ExitCode)" }
if (Test-Path -LiteralPath $installedExe) { throw '程序尚未卸载。' }
Save-ToolboxDataSnapshot 'after-uninstall'
Assert-ToolboxDataUnchanged 'before-uninstall' 'after-uninstall'
```

人工确认快捷方式已移除，`$userDataDir`、任务、最终媒体、登录profile仍保留。若程序目录中存在用户另加的文件，保留并说明，不自行清除。按照步骤3再次安装，再启动核对原任务和结果能重新识别；正常退出。是否最后保留安装由主协调者决定。

## 7. 必须另行记录的场景

| 场景 | 本机步骤覆盖情况 |
| --- | --- |
| 普通用户中文/空格程序目录 | 上述步骤待执行 |
| 已有 WebView2 不重复安装 | 本机安装日志/注册信息待核对 |
| 没有 Python/Node 的 Windows10/11 | 仍需干净机器/虚拟机 |
| Edge 缺少、WebView2 缺少 | 不破坏本机组件；目标环境另验 |
| 不同版本升级 | 同版本覆盖不能替代，需第二个正式包 |
| 静默 `/DIR` 指向用户数据根或子目录 | 新增PrepareToInstall保护；应另执行负例，确认非零且数据快照不变 |
| 运行中卸载 | AppMutex应同样阻止，单独记录 |
| 真实平台采集和下载 | 独立业务验收，不由安装流程代替 |

每步保存操作时间、账号权限、Windows版本、安装包版本/哈希、进程退出码、日志位置与数据快照比对结果。没有实际执行的项保持待验证。

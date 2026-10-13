# Windows 安装包构建

这些脚本面向开发者。普通用户拿到安装程序后直接安装、从快捷方式打开工具箱，无需配置 Python、Node、FFmpeg 或业务文件路径。

## 范围与当前验收边界

- 目标：Windows 10/11 x64，PyInstaller `onedir` 目录和 Inno Setup 按用户安装包。
- 入口是 `bootstrap.py`，调用 `toolbox.desktop.main`；不启动旧工具的独立服务或界面。
- 本目录的静态测试不执行 PyInstaller、npm、安装程序或平台采集。实际构建、中文路径安装、升级、卸载和干净系统验收需要单独记录。
- 脚本不清理旧业务数据，不自动删除任何已有构建目录。每次构建生成新的时间戳目录。
- 未包含应用或安装包代码签名步骤；不能据此宣称已满足公开分发条件。

## 输入与锁定版本

| 输入 | 要求 |
| --- | --- |
| Python | Windows x64 3.13.2 |
| Python 运行依赖 | `toolbox/requirements.lock.txt` |
| 构建依赖 | 本目录 `requirements-build.lock.txt`，PyInstaller 6.22.2 |
| Node | Windows x64 24.19.0，文件名 `node.exe`，同一发行目录内须有 npm CLI |
| Node 生产依赖 | `toolbox/package-lock.json`；复制到独立目录后 `npm ci --omit=dev` |
| FFmpeg | 已记录的 7.1 构建，文件名 `ffmpeg.exe`；实际大小与 SHA256 写入清单 |
| Inno Setup | 6.7.3，使用其 `ISCC.exe` |
| WebView2 | 微软 Evergreen bootstrapper；PowerShell 入口要求有效微软签名 |
| 许可证 | Node LICENSE、FFmpeg GPLv3 完整文本，以及两个已登记的 THIRD_PARTY_NOTICES.md |

`build.py` 检查构建解释器、Node 版本与架构、FFmpeg 版本、虚拟环境身份和锁中 Python 包的实际版本。构建工具也只安装到构建虚拟环境。不会改写仓库已有依赖锁。

### Inno 6.7.3 脚本兼容性

安装脚本按固定的 Inno Setup 6.7.3 编译。该版本的 `RegQueryStringValue` 注册表根参数为 `Integer`，因此 `HasRuntimeIn(Hive: Integer)` 必须保留；使用 `HKEY` 会报 `Unknown type 'HKEY'`。依据是官方 [is-6_7_3 标签的 Shared.ScriptFunc.pas](https://github.com/jrsoftware/issrc/blob/is-6_7_3/Projects/Src/Shared.ScriptFunc.pas)，其中注册的脚本函数参数是 `const RootKey: Integer`。官网在线帮助随新版本变化，不应直接用新文档的类型替换固定构建版本的接口。升级编译器时需同时复核脚本 API 并重新实际编译。

## 开发者命令

在仓库根目录执行。将以下示例中的 Python、Node、FFmpeg 和许可证路径替换为本机真实文件；路径参数支持空格和中文。

```powershell
.\toolbox\windows\build.ps1 `
  -Version '0.1.0' `
  -PythonExe 'C:\Python313\python.exe' `
  -NodeExe 'D:\Program Files\nodejs\node.exe' `
  -FFmpegExe 'D:\运行时\ffmpeg.exe' `
  -ISCCExe "$PWD\toolbox\build\tools\inno\ISCC.exe" `
  -WebView2Bootstrapper "$PWD\toolbox\build\downloads\MicrosoftEdgeWebview2Setup.exe" `
  -NodeLicense "$PWD\toolbox\build\downloads\NodeLICENSE" `
  -FFmpegLicense "$PWD\toolbox\build\downloads\COPYING.GPLv3" `
  -BuildVenvPath "$PWD\toolbox\build\venv"
```

`-BuildVenvPath` 可省略：脚本在本次构建工作目录创建独立 venv。传入已有环境时，必须位于仓库 `toolbox/build` 内，并且确实是 Python 3.13.2 x64 虚拟环境。`-NodeLicense` 默认取 `node.exe` 同目录的 `LICENSE`；`-FFmpegLicense` 默认取上例位置。缺少许可证时停止构建。

许可证输入可使用开发者自己的文件名；构建工作目录中统一复制为 `LICENSE` / `COPYING.GPLv3`，确保随包声明中的位置固定。清单仍记录原始输入文件名和哈希。

请使用 `build.ps1` 作为发布入口，它在调用 Python 前校验 bootstrapper 签名。直接执行 `build.py --help` 只用于查看底层参数，不包含该 PowerShell 签名校验。

静态验收命令：

```powershell
.\toolbox\build\venv\Scripts\python.exe -m unittest toolbox.tests.test_packaging -v
```

## 冻结布局与白名单

```text
ScriptAllToolbox/
  ScriptAllToolbox.exe
  _internal/
    python313.dll、Python 冻结模块及运行依赖
    node_modules/                    # 只安装一份共享生产依赖
    playwright/driver/package/       # Python Playwright 的 JS 驱动
    toolbox/
      node/                          # worker、SDK、浏览器客户端、4 个适配器
      web/                           # 工具箱统一界面
      tools.json
      release-info.json
      THIRD_PARTY_NOTICES.md
      runtime/
        node.exe
        ffmpeg.exe
        licenses/node/许可证文件
        licenses/ffmpeg/许可证文件
    商机中心/                        # 仅 layout.py 指定的业务 JS
    Tiktok TOP200/                    # 同上
    Tiktok video/                     # 同上
    抖音视频下载器（免 Python 版）/
      douyin_downloader_core.py
      THIRD_PARTY_NOTICES.md
```

精确文件白名单见 `layout.py` 的 `SOURCE_FILES` / `BUSINESS_FILES`；新增本地 `require()` 依赖必须同时进入白名单，否则构建前失败。业务目录与工具箱前端/Node 目录在产物中也按白名单复查。旧 data、旧服务器、旧 UI、工具自带 node_modules、测试、用户浏览器配置和旧 exe 均不是构建输入。

Python Playwright 1.58.0 与 Node playwright-core 1.58.2 的 JS 驱动分别保留各自版本。Python Playwright 自带的第二份 `driver/node.exe` 会在 Analysis 后过滤，通过 `PLAYWRIGHT_NODEJS_PATH` 使用共享 Node；不打包 Chromium，也不执行浏览器下载。共享 npm 安装内的传递依赖可能包含嵌套 `node_modules`，这是 npm 的依赖解析结果，不是第二套工具安装。

冻结后的 `application.ROOT` 指向 `_internal`，工具相对路径保持不变。用户数据继续使用 `%LOCALAPPDATA%\ScriptAllToolbox`，与默认程序目录 `%LOCALAPPDATA%\Programs\ScriptAllToolbox` 分开。

## 输出与可追溯清单

每次构建输出：

```text
toolbox/build/windows/<版本-UTC时间-随机后缀>/  # 环境、npm 暂存、冻结工作目录
dist/release/<版本-UTC时间-随机后缀>/
  app/ScriptAllToolbox/                       # 可运行 onedir
  installer/ScriptAllToolbox-<版本>-windows-x64.exe
  manifest.json
  SHA256SUMS.txt
```

以上构建/发布目录由现有 `.gitignore` 排除。脚本不执行清理；重试生成新目录，不覆盖或删除未知目录。

`release-info.json` 随应用安装，`manifest.json` 额外记录应用文件和安装包的大小/SHA256。两者包含产品版本、源码 commit、是否有未提交修改、构建时间、运行时版本、Python/npm 依赖、锁文件哈希及外部运行时/许可证/bootstrapper 输入哈希。`SHA256SUMS.txt` 列出发布目录内其余文件（不包含自身）。源码 commit 和 dirty 状态通过只读 Git 命令取得；脚本不提交、切换分支或修改 Git。

ISCC 使用固定 6.7.3 支持的 `/Qp`，保留进度及错误，省去逐文件压缩信息；编译器文件的哈希也登记到 inputs.innoCompiler。只有安装编译成功且找到唯一安装包才生成最终 manifest/SHA256SUMS。若早期编译中断后手工补编译，目录中仍可能没有这两份文件；正式发布应在启用四工具并提交后重新完整构建，不把该半成品当作完成交付。

## 安装、升级与用户数据

- `PrivilegesRequired=lowest`，默认按用户安装；支持中文用户名和带空格路径。
- 安装/卸载均检查固定 `Local\ScriptAllToolbox.InstallGuard`。工具箱运行期间要求先退出；不强杀进程，不启用自动关闭应用。
- 保留上次程序目录；拒绝把程序安装到用户数据目录内。
- 没有卸载数据目录的规则。卸载只移除安装程序登记的程序文件与快捷方式，保留用户任务、结果和浏览器配置。仍需真实升级/卸载验收证明。
- 安装程序检查 HKCU/HKLM 的 32/64 位 WebView2 注册信息；已有运行时直接跳过。缺少时运行随包的微软 Evergreen bootstrapper `/silent /install`，这一步需要联网。安装后再次检查运行时，失败时给出中文错误。
- Edge 与 WebView2 分别检查；缺少 Edge 时提供微软官方下载页。Edge 仍需在开始采集前安装。未捆绑浏览器。
- 当前使用 Inno 内置默认向导语言；工具箱名称、提示与业务界面为中文。没有引入未随本机 Inno 发行的第三方语言文件。

本机可执行验收步骤见 [ACCEPTANCE.md](ACCEPTANCE.md)，涵盖中文路径安装、运行中升级保护、同版本覆盖、卸载保留数据与再次安装识别；这些步骤尚待主协调者执行。目录保护同时在交互向导与 PrepareToInstall 检查，静默 `/DIR` 也不能指向用户数据目录。

## 许可证与发布检查

脚本强制携带 Node、FFmpeg 许可证及现有第三方说明；npm 生产依赖目录整体保留其包内许可文件。PyInstaller spec 为锁中的 Python 运行依赖加入 `copy_metadata`，但元数据收集不能证明每个上游包都包含完整许可证。

实际构建后必须扫描产物的 npm LICENSE/NOTICE、Python dist-info 许可目录、pywebview/.NET 组件与 Playwright 的第三方说明，记录缺项并补齐。FFmpeg 是既有 7.1 GPL 构建，来源和构建信息见随包旧下载器说明；公开再分发前还需核对对应源码及分发义务。当前脚本没有验证公开再分发合规，也没有完成干净 Windows 10/11 安装验收。

## 官方参考

- [PyInstaller spec 与 onedir](https://pyinstaller.org/en/stable/spec-files.html)
- [Inno Setup AppMutex](https://jrsoftware.org/ishelp/topic_setup_appmutex.htm)
- [Inno 6.7.3 脚本函数注册源码](https://github.com/jrsoftware/issrc/blob/is-6_7_3/Projects/Src/Shared.ScriptFunc.pas)
- [Inno 架构标识](https://jrsoftware.org/ishelp/topic_archidentifiers.htm)
- [微软 WebView2 分发与运行时检测](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)

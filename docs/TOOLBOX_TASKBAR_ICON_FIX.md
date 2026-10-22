# 任务栏仍显示 Python 图标的处理

## 现象与已取得证据

用户在 0.1.9 升级后反馈任务栏仍为 Python 图标。本次检查范围为工具箱自己的进程、窗口、快捷方式和任务栏按钮，不清理全局图标缓存，不重启 Explorer。

- 实际运行路径是原安装目录的 `ScriptAllToolbox.exe`，没有运行 Python 开发版。
- 通过 WM_GETICON 读取的窗口大、小图标及 SHGetFileInfo 返回的 EXE 图标，均为用户提供的小叶图标。
- 重新打开软件后，工具箱自己的任务栏按钮截图仍显示 Python 图标，重现用户反馈。
- 任务栏按钮自动标识为 EXE 路径；源码没有声明显式 AppUserModelID，窗口也没有单独声明。它仍依赖 Windows 的自动应用识别与既有任务栏分组状态。

## 最小诊断及实施计划

1. 只为当前工具箱窗口设置独立 AppUserModelID，核对同一任务栏按钮的图案是否恢复，验证应用身份这一假设。
2. 若验证有效，在窗口创建前为主进程声明固定 `ScriptAll.XiaoyeToolbox`，并为安装生成的桌面、开始菜单快捷方式声明同一 ID 和明确的图标路径。内部 EXE 文件名、安装 AppId、单实例互斥量、资料路径保持原值。
3. 生成升级包，在用户退出程序后更新原目录，核对任务栏的实际按钮截图，记录真实结果。检查限定为本问题的诊断、语法、构建与安装交付，不新增或运行测试套件。
4. 代码合并前按既定流程完成一次范围审查，保存 Git 回溯版本；清理本轮专属构建临时文件。

微软说明：显式应用身份应在创建界面前设置，快捷方式与进程应使用一致的 ID；自动分配的 ID 依赖系统启发式识别。参考 [AppUserModelID](https://learn.microsoft.com/en-us/windows/win32/shell/appids)、[SetCurrentProcessExplicitAppUserModelID](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-setcurrentprocessexplicitappusermodelid)。

## 执行结果

- 同一运行窗口仅设置 `ScriptAll.XiaoyeToolbox` 后，任务栏按钮标识立即从 EXE 路径变为该 ID，按钮截图也立即从 Python 图案变为小叶图案，确认应用身份这一假设有效。未清空全局缓存或改动其他程序。
- 永久修复仅改主程序启动和两条安装快捷方式配置：通过 `ctypes.OleDLL` 的 HRESULT 检查调用，在创建界面前声明进程身份；两条快捷方式使用同一 ID 并明确指定现有 ICO。
- 本轮按中等范围检查，预算为一次语法/配置检查、一次合并前审查及新安装版任务栏实际显示核对；不重复前一版不变的业务功能检查。
- 语法、发布白名单和一次独立范围审查通过；审查核对了 OleDLL 的 HRESULT 行为、调用时机与快捷方式图标路径。
- 0.1.10 安装包已生成：`dist/release/0.1.10-20261022T103525Z-4f4f7496/installer/ScriptAllToolbox-0.1.10-windows-x64.exe`，源码 `d5e6042`，构建时工作区干净。安装包 73,560,820 字节，SHA256 `4fff8ff7028b03f339c849c216c6b06ca66fe6b96879e59ecb0bc5f792a0baae`，与 manifest 一致。
- 用户确认当前图标已变更并退出程序后，0.1.10 已安装到原目录，安装器退出码为 0，无需重启 Windows。
- 7,698 个安装文件与清单一致；启动前核对任务库、成本库、Cookies、Local State、数据位置设置的 SHA256，与安装前完全一致。
- 桌面和开始菜单快捷方式均已声明 `ScriptAll.XiaoyeToolbox`，明确指向工具箱现有 ICO；原 EXE 路径不变。
- 正常启动新安装版，新进程任务栏 AutomationId 为 `Appid: ScriptAll.XiaoyeToolbox`，实际任务栏按钮截图确认是小叶图案。本次未对新进程临时设置窗口属性，证明启动配置已永久生效；未运行自动化测试套件或真实平台采集。
- 本轮构建工作目录、解包 app、专属 `.tmp/taskbar-icon` 及诊断编译临时目录已清理，共释放约 389.6 MiB。保留安装包、发布清单和 `toolbox/build/taskbar-icon` 中的前后任务栏截图与构建日志。
- 安装日志、资料保留校验和 `TaskbarInstalled-0.1.10.png` 保存在同一证据目录；安装专属临时文件在交付时清理。

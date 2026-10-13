# 电商工具箱

这里是桌面工具箱实现目录，包含桌面外壳、托盘、单实例、操作桥接、任务/浏览器调度、结果存储、工作者协议及四个业务适配器。当前交付0.1.3本机验收版，四入口已启用，支持自选数据和默认导出目录；存储页加载及切页保护见[修复记录](../docs/TOOLBOX_STORAGE_LOADING_FIX.md)，迁移与空间清理见[实施记录](../docs/TOOLBOX_DATA_MIGRATION_PLAN.md)，此前业务验证范围见[本机验收记录](../docs/TOOLBOX_V1_LOCAL_ACCEPTANCE.md)。

普通用户见[使用说明](用户使用说明.md)；构建与安装验收见[Windows 构建说明](windows/README.md)。

## 开发启动

总仓根目录执行 `toolbox/.venv/Scripts/python.exe -m toolbox.desktop`。依赖由 toolbox/requirements.txt 与 package-lock.json 固定；普通用户最终使用安装包，不需要运行这些命令。

开发桌面验收 `toolbox/.venv/Scripts/python.exe -m toolbox.desktop --smoke` 使用独占临时目录、测试 worker，验证主界面桥接、窗口隐藏恢复、托盘、单实例及任务后自动退出。不会登录或采集真实平台。真实 Edge 空白会话可单独运行 `python -m toolbox.tests.smoke_browser`。

源码真实验收使用 `toolbox/.venv/Scripts/python.exe -m toolbox.desktop --acceptance`，开放四工具并使用当前用户的正式任务、结果与专用浏览器资料；仅供开发者验收，冻结发布程序拒绝此参数。

## 开发验证

在总仓根目录、Python 3.13 与 Node 24 环境执行：

```powershell
toolbox/.venv/Scripts/python.exe -m unittest toolbox.tests.test_foundation toolbox.tests.test_runtime toolbox.tests.test_bridge_operations toolbox.tests.test_manual toolbox.tests.test_files toolbox.tests.test_integrated_engines toolbox.tests.test_packaging -q
node --test toolbox/tests/sdk.test.cjs
```

验证使用独占临时目录、测试 worker 和模拟页面，不采集真实平台。运行测试中的实际 FFmpeg 本地样本解码不证明网站下载可用。Windows 路径边界验证会在测试临时目录创建并移除一个 junction。

公共集成验证会检查旧工具历史目录不被改写；请在旧工具测试全部结束后运行，避免其他测试同时写入它监测的目录。

## 入口与边界

- `host/paths.py`：显式创建数据目录和 RunContext，导入不写文件。
- `host/store.py`：SQLite schema 1，任务摘要、候选幂等、精确共享与删除事务。文件操作不能嵌套于未提交事务；最终文件登记前保留 staging 原件及小型登记意图，重启协调后可重试。
- `host/state.py`：唯一 engine-state envelope 与状态机。
- `host/resources.py`：FIFO lease，暂停期间由调用者保留 lease。
- `host/worker.py` 与 `node/worker.cjs`：隐藏 Node、NDJSON、心跳、请求身份过滤和关闭宽限；Windows Job Object 管理其子进程。
- `node/sdk.cjs`：业务适配器调用边界，人工单条下载不能写任务检查点。

worker 的 `--test-adapter` 只用于本地公共验证，不属于桌面桥接参数；生产模式仅接受四个固定工具 ID，未接入方法返回不支持。候选视频登记必须提供实际的视频检查器；测试替身不能用于发布。

完整依据见 [接口约定](../docs/TOOLBOX_V1_CONTRACTS.md) 和 [实施清单](../docs/TOOLBOX_V1_EXECUTION.md)。

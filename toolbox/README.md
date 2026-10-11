# 电商工具箱公共基础

这里是桌面工具箱的新实现目录。当前已实现任务数据库、受管目录、状态保存、结果登记/共享引用、删除协调、FIFO 资源锁和 Node 工作者协议；尚不能作为完整桌面应用启动。真实工具适配、浏览器和界面仍按总仓实施清单推进。

## 开发验证

在总仓根目录、Python 3.13 与 Node 24 环境执行：

```powershell
python -m unittest toolbox.tests.test_foundation -v
node --test toolbox/tests/sdk.test.cjs
```

验证使用独占临时目录、测试 worker 和模拟视频检查器，不采集真实平台，不证明视频流有效或网站能力可用。Windows 路径边界验证会在测试临时目录创建并移除一个 junction。

## 入口与边界

- `host/paths.py`：显式创建数据目录和 RunContext，导入不写文件。
- `host/store.py`：SQLite schema 1，任务摘要、候选幂等、精确共享与删除事务。文件操作不能嵌套于未提交事务；最终文件登记前保留 staging 原件及小型登记意图，重启协调后可重试。
- `host/state.py`：唯一 engine-state envelope 与状态机。
- `host/resources.py`：FIFO lease，暂停期间由调用者保留 lease。
- `host/worker.py` 与 `node/worker.cjs`：隐藏 Node、NDJSON、心跳、请求身份过滤和关闭宽限；Windows Job Object 管理其子进程。
- `node/sdk.cjs`：业务适配器调用边界，人工单条下载不能写任务检查点。

worker 的 `--test-adapter` 只用于本地公共验证，不属于桌面桥接参数；生产模式仅接受四个固定工具 ID，未接入方法返回不支持。候选视频登记必须提供实际的视频检查器；测试替身不能用于发布。

完整依据见 [接口约定](../docs/TOOLBOX_V1_CONTRACTS.md) 和 [实施清单](../docs/TOOLBOX_V1_EXECUTION.md)。

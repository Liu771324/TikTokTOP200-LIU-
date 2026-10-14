# TOP200 脱敏回归素材

## 用途与限制

`top200-table.html` 是既有两行榜单 DOM，覆盖 aurora 上升与 ecom 首次上榜。

`task-states.json` 是阶段 01 新增静态任务快照，依据设计与接口约定 0.2。它复用现有 task-store、collector 和 Excel 测试的数据形状，不包含真实商家、登录资料、媒体地址或磁盘路径。示例商品地址仅使用保留测试域名 `example.test`，测试不会请求它。

每项包含 `id`、`description`、`task` 和独立的 `expected`。`task` 保留旧引擎实际字段和状态，不能把宿主字段混入原生任务。`expected` 是适配器验收预期；素材自身不实现状态映射、恢复或重试。`fixtureVersion` 为素材格式版本，不是引擎状态文件版本。

## 七种场景

| ID | 原生快照 | 未来验收预期 |
| --- | --- | --- |
| clean | 两组合完成，无失败 | completed |
| interrupted | A 完成；B 第 2 页运行中，组合结果未合入任务 | 宿主重启归 interrupted；保留 A，B 从第 1 页重采 |
| combination_failed | A 完成；B 三次尝试后失败，旧任务仍 completed | completed_with_errors；整体替换重采 B |
| row_link_failed | 两组合完成；A 存在空商品链接和失败明细 | completed_with_errors；整体替换重采 A |
| row_trend_failed | 两组合完成；B 多一条无法识别趋势的行 | completed_with_errors；整体替换重采 B |
| all_failed | 两组合失败，无结果，旧任务仍 completed | failed；重试全部异常组合 |
| connection_failed | 旧连接异常前已落盘 running，未进入采集 | 捕获连接错误后 failed，不遗留 running；恢复从第一页开始 |

连接失败的 `observedError` 属于外部观察信息：旧代码在 try 外连接，所以该错误不会存在于旧 task.failures。`expected.trigger` 区分收到引擎结果、宿主重启和已捕获连接错误；如果只是重启遇到遗留 running，应按中断处理，不能凭磁盘快照猜测连接失败。

`resumeCombinationIds` 表示正常恢复时尚未完成的组合；`retryCombinationIds` 表示明确失败或含失败明细的组合。已完成但含逐行错误的组合只在“重试异常组合”时重采，不能把正常恢复和异常重试混为一谈。`restartPage` 为 1 表示这些组合从第一页重采，不代表具备页级续采。

## 本地验证

在本工具目录执行：

```powershell
node --test test/task-state-fixtures.test.js
```

该验证只读取 JSON 和纯函数模块，检查 ID、组合归属、统计、去重后的预期重试集合、脱敏地址及旧状态差异；不导入 task-store，不写文件、不启动服务或浏览器。

完整既有回归使用 `node --test`。其中原有存储/导出测试会创建并清理测试文件，安全测试会启动本机 HTTP 服务。

阶段 05 的实际适配器测试入口为：

```powershell
node --test test/toolbox-adapter.test.js
```

它在独占临时目录写统一状态 envelope 与 XLSX，使用真实 `runTask` 加假组合采集器验证恢复/重试、暂停取消、人工等待、报表登记恢复及只读分页；另以假页面调用真实组合核心验证原始前 200 名、五种趋势、周期回退和逐行安全边界。发现返回结构和公共浏览器连接使用替身，不启动 Edge，不访问平台。它不证明宿主资源排队、历史列表 UI、真实商品链接获取或真实登录验证页面已通过。

## 后续适配器如何复用

按场景克隆 `task`，把 observedError 或宿主重启事件送入实际适配器，再比对 `expected`。注入假浏览器记录实际组合执行顺序和起始页，确认完成组合未重跑、异常组合替换而非追加、未选中组合结果不变。现有 fixture 自洽测试通过不能代替这些行为测试，也不能证明真实平台可用。

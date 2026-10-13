# 商机中心最小状态样本

依据工具箱设计与契约 0.2，用于阶段 01 本地回归。`task_states.js` 只创建脱敏对象，不调用浏览器、不读写任务文件、不运行采集；所有时间、类目、商品和失败原因均为人工构造，不包含商家信息、机器路径、登录信息或媒体地址。

每个样本保留旧任务的 parameters/combinations/results/failures/unparseableItems 形状，包含健康类目 A 与目标类目 B。工具箱 envelope 由公共 SDK 包装，样本本身不实现宿主存储。

| name | 旧任务事实 | 工具箱目标与重采范围 |
| --- | --- | --- |
| clean | 两类目完成、无错误、覆盖完整 | completed；不重采 |
| detail_failure | B 已完成但含详情失败 | completed_with_errors；B 整类目重试 |
| parse_failure | B 已完成但含解析错误 | completed_with_errors；B 整类目重试 |
| category_failure | 旧任务仍为 completed，但 B failed | completed_with_errors；B 整类目重试 |
| stopped | A 完成，B 停止并保存部分结果 | cancelled；恢复跳过 A，B 从头重采 |
| incomplete_coverage | B 标 completed，但覆盖不完整 | 不报告完整成功；重采 B 以完成范围 |

`expected.nativeStats` 是原有纯函数的可验证结果。`toolboxStatus/reprocessCombinationIds/reprocessMode` 在阶段 04 由 `toolbox_adapter.test.js` 验证。旧独立入口的重试行为继续保留；工具箱重试通过 `toolbox_task.js` 选择异常类目，整体替换其结果。

本地验证：在商机中心目录运行 `node --test test/task_state_fixtures.test.js`；总仓运行 `npm --prefix "商机中心" test` 包含所有本地测试。原阶段 01 测试复用旧统计、报告及合并函数，验证序列化、归属、统计守恒、部分覆盖、类目整体替换与重复合并不追加。

## 阶段 04 本地验收

- `fake_business_page.js`：纯内存 DOM 替身，实际执行采集器的页面 evaluate 函数；不启动浏览器、不访问网络。覆盖金额档位、趋势、详情抽屉、排序及页码检查。它只模拟现有选择器，不能证明真实网站仍使用这些 DOM。
- `toolbox_collector.test.js`：真实采集流程的金额与增长分类、近30天预筛选、三次失败、安全暂停点、页面改变拒绝继续、取消，以及注入 PAUSE_FILE/STOP_FILE 的旧入口兼容。
- `toolbox_discovery.test.js`：已提供 page 时直接执行类目接口解析，不另开 CDP；发现登录页立即报错。
- `toolbox_adapter.test.js`：六类状态归一化、恢复跳过完成类目、异常类目整体替换、登录等待、取消保存、真实 SDK pause/resume、稳定候选 lookup 与 replaceRole、同数据根目录的 A/B Excel 独立、results/failures/unparseableItems 分区只读分页、冷导入不写旧目录/不启动 HTTP/CDP/子进程。

工具箱直接在隐藏 worker 中调用采集器，以宿主提供的 page、控制回调和唯一 statePath 运行。没有旧子采集进程、源码 pause.flag、任务备份或临时结果 JSON；Excel 只写当前任务 staging，交由宿主登记。旧 CLI 和独立 server 仍按原路径使用延迟初始化的旧 store。

实际测试只创建各测试独占的系统临时目录。Windows 沙箱可能拒绝原子状态文件 rename；同一命令以正常权限运行用于区分环境限制，不修改或绕过状态原子写入。真实商机页面最小类目采集、统一 UI 联调与宿主文件引用集成由主协调者安排，未由这些本地测试验证。

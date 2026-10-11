# 商机中心最小状态样本

依据工具箱设计与契约 0.2，用于阶段 01 本地回归。`task_states.js` 只创建脱敏对象，不调用浏览器、不读写任务文件、不运行采集；所有时间、类目、商品和失败原因均为人工构造，不包含商家信息、机器路径、登录信息或媒体地址。

每个样本保留旧任务的 parameters/combinations/results/failures/unparseableItems 形状，包含健康类目 A 与目标类目 B。需要工具箱 envelope 时由未来适配器包装，此处不提前实现宿主格式或状态映射。

| name | 旧任务事实 | 工具箱目标与重采范围 |
| --- | --- | --- |
| clean | 两类目完成、无错误、覆盖完整 | completed；不重采 |
| detail_failure | B 已完成但含详情失败 | completed_with_errors；B 整类目重试 |
| parse_failure | B 已完成但含解析错误 | completed_with_errors；B 整类目重试 |
| category_failure | 旧任务仍为 completed，但 B failed | completed_with_errors；B 整类目重试 |
| stopped | A 完成，B 停止并保存部分结果 | cancelled；恢复跳过 A，B 从头重采 |
| incomplete_coverage | B 标 completed，但覆盖不完整 | 不报告完整成功；重采 B 以完成范围 |

`expected.nativeStats` 是现有纯函数的可验证结果。`toolboxStatus/reprocessCombinationIds/reprocessMode` 仅记录待实现目标，不证明新版调度、状态归一化、异常类目选择或真实恢复已经可用。尤其旧重试仅选择 failed 类目，尚不会自动选择已完成但含失败明细的 B。

本地验证：在商机中心目录运行 `node --test test/task_state_fixtures.test.js`；总仓运行 `npm --prefix "商机中心" test` 可包含该文件。测试复用旧统计、报告及合并函数，验证序列化、归属、统计守恒、部分覆盖、类目整体替换与重复合并不追加。它不执行新版重试选择器，不测试真实页面或商品级断点恢复。现有 batch-runner 导入仍会初始化默认 store 目录，属于后续迁移需解除的旧副作用。

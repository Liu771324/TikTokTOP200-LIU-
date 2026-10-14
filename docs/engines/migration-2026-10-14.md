# 下载、TOP200 与视频源码迁移记录

## 范围和完整性

外部下载器只读，复制 `douyin_downloader_core.py` 与 `THIRD_PARTY_NOTICES.md` 到 `toolbox/engines/downloader`；迁入其核心测试，去除已不迁入的独立 GUI 导入断言。未复制 GUI、构建产物、FFmpeg、下载结果或浏览器资料。

TOP200 迁入原发布白名单5个模块，视频迁入6个模块；三个 Node 适配器改为新路径。搜索词独立服务仍依赖旧商机 Edge 模块，因此把这一模块迁到 `toolbox/engines/shared/edge.js`，只改搜索词服务的一处引用；该兼容模块仅源码保留，不进入工具箱发布包。

复制后逐文件核对 SHA-256；原始复制hash、现状hash与容量见 `migration-inventory.json`。迁移回归发现视频候选详情携带带token的封面URL；`compass-page.identity()` 已有规范化封面计算，本次仅使返回对象覆盖 `cover` 属性，保存 origin+pathname。其他迁入的生产引擎文件保持原始内容。旧测试一处封面候选身份期待改为当前 `page:` 口径。

必要业务规则已提取到 `top200.md` 与 `video.md`，旧独立网页/HTTP服务/Windows启动专项测试随入口删除；保留业务测试及脱敏fixture。

## 清理与数据保留

清理前两目录无重解析点，绝对路径位于明确工作区边界。宿主加载、适配器和发布白名单已改新路径后，确认生产代码不再引用旧目录。

| 旧目录 | 清理前文件/字节 | 删除旧代码与重复依赖 | 保留业务输出 |
| --- | ---: | ---: | ---: |
| Tiktok TOP200 | 2,746 / 50,318,853 | 2,708 / 39,708,211 | 38 / 10,610,642 |
| Tiktok video | 417 / 19,784,274 | 389 / 9,529,419 | 28 / 10,254,855 |

最初整体删除命令被自动审批拒绝：它会同时删除检查点、报告和视频等业务输出，审批认为存在不可逆数据丢失风险；该命令未执行。随后采用保留数据策略，删除的仅为旧源码、独立前端/服务、启动文件、旧测试/历史文档及重复 `node_modules`，共释放49,237,630字节。

全部66个业务文件、20,865,497字节经逐文件hash核对后移动到工作区本地归档：`local-archive/legacy-tools/top200/{data,reports,logs}` 与 `local-archive/legacy-tools/video/{data,logs,视频}`。源/目标绝对路径逐一校验，使用原生 PowerShell 同盘移动；未复制认证或修改业务文件。完整逐文件校验清单位于归档内 `archive-integrity.json`，归档不进Git和发布包。视频旧目录已空并移除，TOP200仅剩空 `.git` 交主任务处理。未接入搜索词、商品标题、成本助手数据未动，外部下载器原目录未动。

## 验证证据

- 15个生产 Node 模块的本地依赖闭包检查通过。
- `node --test --test-concurrency=1 --test-reporter=dot toolbox/tests/engines/top200/*.test.js toolbox/tests/engines/video/*.test.js`：126项通过，0失败。
- `python -m unittest discover -s toolbox/tests/engines/downloader -p test_downloader_core.py`：29项通过，0失败。
- 最终测试在沙箱外运行，TEMP限定本轮工作区专用目录；DOM测试仅加载内存fixture并拦截外网，HTTP测试仅访问本地服务，没有发起真实平台采集。本轮测试临时目录已删除。
- 初始沙箱测试遭遇本地HTTP `EACCES`、临时文件 `EPERM` 和Edge crashpad失败；并发Node回归出现瞬时重命名失败，最终串行回归全部通过。未据此修改公共状态写入实现。

本次为整体Large重组中的局部迁移核对；未重复运行无关业务测试，公共宿主、Python商机与包装验证由主任务统一负责。

# 电商工具箱第一版：接口与数据约定

> 版本：0.3；日期：2026-10-13；状态：公共基础、桌面桥接与四工具适配已实现，验收进行中。
>
> 本文描述工具箱实现使用的接口，不描述旧 HTTP 服务现有 API；具体通过范围以实施证据为准。以[总体设计](TOOLBOX_V1_PLAN.md)确定范围，按[实施清单](TOOLBOX_V1_EXECUTION.md)验证。

## 1. 通用约定

- 应用内工具 ID：`business-center`、`top200`、`video-ranking`、`manual-video`。
- taskId、artifactId、itemId、requestId 为宿主生成的不透明 ID；界面不得从 ID 推导文件路径。
- 时间保存为 UTC ISO 8601，界面按 Asia/Shanghai 显示，原 Excel 北京时间格式保留。
- 所有协议使用 UTF-8；业务文案保留中文，不手工转为 Unicode 转义。
- 状态和错误使用稳定英文标识，用户界面显示中文。
- 文件大小使用字节，进度计数使用非负整数；无法确定总量时 total 为 null。
- 任务参数创建后固定；重试记录 attempt 次数，不覆盖原任务条件。修改条件创建新任务。
- 所有操作校验工具、任务、状态及资源归属。重复发起相同控制操作返回当前状态，不重复创建执行进程。
- 桌面桥接仅允许预定义 action；没有执行任意命令、打开任意路径和请求任意网址的通用 action。

## 2. 桌面桥接

### 2.1 调用与返回

调用形式：`window.pywebview.api.invoke(action, payload)`，返回 Promise。该调用只在本地自有界面完成加载和可信绑定后开放。

返回约定：

```json
{
  "ok": true,
  "data": {},
  "error": null
}
```

失败返回：

```json
{
  "ok": false,
  "data": null,
  "error": {
    "code": "BROWSER_BUSY",
    "message": "浏览器正在被另一个任务使用，请等待或先停止该任务。",
    "retryable": true,
    "details": {"taskId": "example-task-id"}
  }
}
```

details 只包含供界面使用的结构化信息，不携带 traceback、Cookie 或内部完整路径。开发日志可记录经脱敏的诊断细节。

### 2.2 Action 表

| Action | 输入重点 | 返回与行为 |
| --- | --- | --- |
| `app.get_state` | 无 | 应用版本、工具列表、运行环境检查、当前事件序号 |
| `app.show` | 无 | 恢复主窗口 |
| `app.request_exit` | 确认关闭标志 | 无任务则退出；有任务先返回需确认，确认后保存并停止 |
| `events.read` | afterSeq、limit | 增量事件与当前 seq；有缺口时要求重新读取状态 |
| `browser.get_state` | 无 | 连接状态、各站点最近检查状态、资源持有者 |
| `browser.open` | source 枚举 | 打开受管平台页；浏览器被占用时不擅自导航 |
| `browser.list_pages` | source 可选 | 支持读取的标签 ID、标题、来源，不返回调试凭证 |
| `browser.clear_login` | 已确认标志 | 无浏览器任务时关闭受管会话并清除其登录资料 |
| `tools.discover` | toolId | 入队发现类目/榜单/周期，返回 operationId |
| `tasks.create` | toolId、parameters；人工下载提交 itemIds | 校验后保存并入队；宿主生成选中条目快照，返回 taskId |
| `tasks.list` | 工具/状态、offset、limit | 全量历史的分页摘要，默认每页 20，最多 100 |
| `tasks.get` | taskId | 摘要、当前进度、能力、错误和结果索引 |
| `tasks.control` | taskId、command | pause/resume/cancel/retry_failed；按能力与状态校验 |
| `tasks.results` | taskId、offset、limit、section可选 | 业务结果分页；默认50、最多200。section默认results，商机另支持failures/unparseableItems，TOP200另支持failures；不支持的分区拒绝 |
| `tasks.artifacts` | taskId、offset、limit | 交付文件分页；默认50、最多200，含本任务的文件名、商品与文案引用 |
| `tasks.logs` | taskId、游标、limit | 有界日志分页及已轮转提示 |
| `capture.read_page` | pageId | 入队读取当前页，返回 operationId；完成后更新人工待选列表 |
| `capture.add_text` | 分享文本 | 按现有规则提取、校验链接并加入待选列表 |
| `capture.list` | offset、limit | 人工待选条目，默认 50，最多 200 |
| `capture.remove` | itemIds | 删除待选条目，不影响已创建任务的参数快照 |
| `capture.copy` | itemIds、字段选择 | 宿主复制标题/链接到剪贴板，返回复制数量与不可用项 |
| `capture.export` | itemIds | 选择保存位置，导出 Excel：标题、链接、链接类型、来源、读取时间 |
| `artifacts.open` | artifactId | 宿主核对记录及实际文件后调用系统打开 |
| `artifacts.export` | artifactIds、taskId可选 | 单文件保存或批量选择文件夹；taskId指定本任务的文件名/商品/文案引用；返回成功、跳过、失败数量 |
| `storage.get_usage` | 无 | 结果、媒体、恢复数据、缓存、日志分类占用 |
| `storage.preview_delete` | taskIds/itemIds/artifactIds | 删除摘要和确认操作 token，拒绝活动任务 |
| `storage.confirm_delete` | token | 重新校验引用后删除，返回实际释放量与待删除项 |
| `storage.clean_cache` | 无 | 清理确认可重建、未被活动任务占用的缓存 |

这些是内部桌面接口，不承诺外部网络 API。确认 token 仅限当前实例、当前选择，生成后五分钟失效；确认时再检查任务状态和文件引用，防止预览后数据变化造成误删。

### 2.3 界面事件

界面前台每秒增量读取 events，隐藏到托盘时每五秒读取。事件队列仅保存最近 1000 条，详细日志走日志接口。重新显示窗口先读取应用和活动任务摘要，再继续增量事件；事件缺口不触发业务重跑。

```json
{
  "seq": 42,
  "type": "task.progress",
  "at": "2026-10-11T08:00:00.000Z",
  "taskId": "example-task-id",
  "data": {
    "phase": "collecting",
    "current": 12,
    "total": 200,
    "message": "正在处理第 12 名"
  }
}
```

事件类型：`task.state`、`task.progress`、`task.artifact`、`task.error`、`operation.state`、`browser.state`、`capture.updated`、`storage.updated`。事件只供刷新界面，数据库与引擎状态才是重启后的数据依据。

## 3. 工具描述与参数

### 3.1 工具描述

每个适配器明确声明 toolId、显示名、引擎类型、参数版本、是否需要浏览器，以及 supportsPause/supportsResume/supportsRetryFailed。能力不能只由界面硬编码。

支持能力必须有实现与验收证据。公网下载第一版不支持单文件断点续传，也不显示暂停按钮；可取消，重试时跳过已经登记成功的文件，失败文件重新解析和下载。

商机恢复/重试的粒度为类目，TOP200 为类目与榜单组合。retry_failed 同时选取显式 failed 单元及包含未处理失败/解析错误的已完成单元，整体重采并替换这些单元的结果；界面显示“重试异常类目/组合”，不显示“仅重试失败商品”。未选中单元保持不变。适配器必须从失败明细映射回正确单元，无法定位时报告明确错误，不能选择另一单元代替。

### 3.2 参数保持业务含义

| 工具 | 参数 | 验证来源 |
| --- | --- | --- |
| 商机中心 | categories、minSales、maxSales、only30dGrowth | 复用原类目规范化及服务端验证，不改变销量单位和边界 |
| TOP200 | categories、rankingTypes、brandType | 来源为发现结果；periodPolicy 与 rankLimit 继续由业务固定 |
| 自动视频 | category、brandType、period、trendMode | trendMode 保留 first/up_and_first；其他选项来自页面 |
| 人工视频 | 选中条目的参数快照 | 至少一条有效来源；每条记录保留读取时间、标题与链接类型 |

参数本身不包含输出目录、任意可执行程序位置或用户输入的 CDP 地址。宿主检查 JSON 类型和工具允许字段，适配器执行原业务校验。

页面发现结果关联 source、读取得到的时间与选项版本，运行前检查它仍可选。未取得登录状态时返回 unknown/needs_login，不能把缺少证据解释成已登录。

## 4. 宿主与 Node 引擎协议

### 4.1 通道

- 每个工作者使用隐藏 Node 进程，专属 stdin/stdout 管道；一行一个 JSON 对象，protocolVersion 固定为 1。
- 宿主按参数数组启动进程，不通过拼接 shell 命令执行。
- stdout 只能输出协议；已有 console.log 改为回调或 stderr。多行日志拆成合法事件，不破坏 JSON 行边界。
- message 含 requestId；任务事件另含 taskId 与 attempt，拒绝旧 attempt 的迟到消息。
- 单消息最多 1 MiB，结果数据经状态文件交换，不通过 stdout 传整份结果；消息过大或非法行作为协议错误，停止相应工作者并保留进度。
- 启动十秒内须返回 ready。任务运行中每五秒报告心跳，连续三十秒没有心跳则标记失联，保存已有数据并回收所属进程。异步长任务不能阻塞协议控制消息和心跳。

### 4.2 命令和事件

| 方向 | 类型 | 用途 |
| --- | --- | --- |
| 宿主 → Node | `discover` | 获取实际页面支持条件 |
| 宿主 → Node | `capture_page` | 读取指定当前页面的已加载视频条目 |
| 宿主 → Node | `download_item` | 下载人工任务中的单条会话来源；不写人工任务的权威状态 |
| 宿主 → Node | `run` | 用固定参数及上下文启动任务 |
| 宿主 → Node | `pause` / `resume` / `cancel` | 改变控制标记，返回 ack；执行边界另报状态 |
| 宿主 → Node | `read_results` | 分页读取已保存结果，不占用浏览器 |
| 宿主 → Node | `artifact_result` | 返回候选登记成功的 artifactId，或登记错误 |
| 宿主 → Node | `shutdown` | 释放工作者自己的连接和资源 |
| Node → 宿主 | `ready` / `heartbeat` / `ack` | 进程就绪、存活及命令接收 |
| Node → 宿主 | `progress` / `log` / `state` | 进度、诊断与实际执行状态 |
| Node → 宿主 | `options_chunk` | 仅商机中心 discover 的大类目列表分片；field 固定 categories，每片一至五十项，总数最多一万 |
| Node → 宿主 | `checkpoint` | 已原子保存状态文件，供宿主更新摘要 |
| Node → 宿主 | `artifact_candidate` | 临时结果已关闭文件句柄，申请宿主登记 |
| Node → 宿主 | `artifact_lookup` | 按稳定 candidateId 查询本任务已登记结果，宿主以 artifact_result 返回 registration 或 null |
| Node → 宿主 | `result` / `error` | 操作结束或结构化错误 |

接到 pause ack 只表示已收请求，直到引擎到达安全边界、保存状态并报告 paused 才能显示暂停完成。取消同理；立即退出进程只用于超时或异常回收，不当成正常完成。

discover 与 capture_page 使用 operationId 和独立临时工作区，不创建伪造的正式任务。它们的上下文只包含 toolId、operationId、dataRoot、scratchRoot 与有效浏览器 lease。read_results 使用只读状态路径，任务结束后可启动短时工作者分页读取，读取完退出；不得因此初始化 store 或取得浏览器锁。

商机中心 discover 的原始 JSON 超过 900 KiB 时，按原顺序通过 `options_chunk` 回传类目，每项保留 displayPath、segments、valuePath，最终 result 的 categories 为空数组。宿主只接受同一请求的商机 discover 分片，校验每片数量与累计一万项上限，收到 result 后合并为原有完整 categories 接口再交给界面；错误、取消或超时不发布部分选项。小结果保持原样，单消息 1 MiB 限制不变。

### 4.3 RunContext

以下为设计类型，实施时由宿主构造并验证，不由用户填写：

```typescript
interface RunContext {
  protocolVersion: 1;
  taskId: string;
  attempt: number;
  toolId: string;
  parameterVersion: 1;
  dataRoot: string;
  taskRoot: string;
  statePath: string;
  scratchRoot: string;
  artifactStagingRoot: string;
  ffmpegPath: string;
  browser: null | { endpoint: string; pageId?: string; leaseId: string };
  controlRoot: string;
  retryFailed?: boolean; // 仅控制本次执行范围；不修改任务参数
}
```

- 所有内部路径为宿主计算的绝对路径，磁盘持久化引用为数据根目录内相对路径。
- 浏览器 endpoint 仅在操作持有有效 lease 时提供；公网下载无需店铺浏览器时 browser 为 null。
- 旧子进程需要的 STOP_FILE、PAUSE_FILE、RESULT_FILE 和 CDP_URL 由适配器从上下文设置，不能让子进程退回默认源码位置。
- 工作者可以关闭自己的 CDP 连接，但不得调用导致共享浏览器整体退出的 browser.close。
- worker 对状态文件只有本次任务写权限约定；scratch/artifact 候选必须位于本任务目录。宿主登记前再次校验，不把此约定当成安全沙箱。

### 4.4 候选结果登记

artifact_candidate 包含候选 ID、相对临时路径、类型、角色、展示名和必要业务元数据；宿主返回已登记 artifactId 或错误。工具检查点保存宿主返回的 artifactId 后才将该项标为完成。

视频可带现有视觉指纹，宿主使用同一版本算法查询已登记媒体。文件 hash 由宿主对实际文件计算，不能信任候选消息提供的 hash。登记事件重发使用相同候选 ID，宿主返回已有登记结果，避免崩溃重试造成重复引用。

artifact_result 明确返回 disposition（created/exact_reuse/visual_reuse）、artifactId、candidateSha256、artifactSha256。视觉复用另返回 matchReason/matchPercent；候选内容与实际复用媒体的 hash 可能不同，不能混用。自动采集根据复用类型继续执行原候选选择规则，重复候选不增加“新保存”计数、不突破每商品上限；人工选择只允许精确复用。复用命中的任务文案及来源仍保留，不能写成 caption:null。

自动短视频恢复从最早未完成视频、趋势解析异常或缺文案的商品重新检查，保留已有成功媒体。缺文案只重新读取相同卡片并通过 `artifact_metadata` 更新本任务引用的 title/caption，不重复下载、登记或修改其他任务共享媒体的引用。宿主仅允许当前 active attempt 更新已登记视频，拒绝其他字段、空值、过长值和停止后的更新。候选无法唯一定位记 UNSUPPORTED_SOURCE 并检查后续候选；已保存卡片身份发生变化仍以 PAGE_CHANGED 停止。每商品满足 4 条新保存视频后，候选下载失败标记为 quota_satisfied 已解决并保留诊断历史，不为这些失败增加第 5 条视频；缺文案仍需补全，趋势异常只有重新识别成功后才清除。


`artifact_metadata` 的 data 仅含 `{candidateId, metadata}`：candidateId 长度 1–200，metadata 非空且仅允许非空字符串 title（最多 2000 个字符）和 caption（最多 20000 个字符）。run/download_item 可调用，短操作不能调用；沿用 requestId/taskId/attempt 校验与 artifact_result 成功/错误回执，不移动媒体文件、不改变 artifactId/disposition。成功先提交本任务引用更新，再确认给 worker；被取消或旧 attempt 的迟到消息不落库。

关联记录以 taskId 和候选 ID 建唯一约束。恢复后能够从已登记关系找回 artifactId，不因 attempt 增加而再次登记同一业务结果。

报表/文本候选可声明 `replaceRole: true`，同任务、同 kind、同 role 只保留当前交付文件。固定 candidateId 在同 attempt 内幂等；下一 attempt 生成新报表后先完成新文件与登记事务，再撤销旧角色引用并回收无引用文件。失败保留原报告；文件占用则保留 delete_pending 等待协调。视频不允许 replaceRole。

## 5. Python 下载核心接口

### Node 适配器实施边界（公共基础第一步）

适配器以 CommonJS 导出 `descriptor` 与已实现的方法；worker 仅加载工具 ID 白名单中的模块，不接受界面指定模块路径。方法签名为 `async run(parameters, context, api)`、`discover(parameters, context, api)`、`capture_page(parameters, context, api)`、`download_item(parameters, context, api)`、`read_results(parameters, context, api)`。未实现的方法返回 UNSUPPORTED_OPERATION。

`api.emit(type, data)` 发送带任务/操作身份的事件；`api.checkpoint(state)` 原子写入唯一状态 envelope 后报告 checkpoint；`api.boundary()` 在安全边界处理暂停/取消；`api.register(candidate)` 等待宿主登记并返回 artifact_result。业务代码不得用 console.log 输出协议外数据。控制对象提供 `cancelled`、`pauseRequested`；适配器必须在本单元完成保存后调用 boundary。read_results 不使用 checkpoint 或 register。

`api.waitForUser(message)` 报告 waiting_user 并等待显式 resume/cancel，浏览器 lease 由宿主保留。`api.lookup(candidateId)` 返回 `{candidateId, registration}`，用于登记成功但尚未 checkpoint 的恢复接缝；registration 为 null 表示未登记。视觉指纹存入宿主 artifact_fingerprints，algorithm_version=1，沿用每秒采样、64 位 dHash、序列距离12、开头5帧距离16、80%匹配规则；首选最高分，同分保持先登记者。业务适配器提交候选指纹，宿主完成共享查询，无需把全量索引塞进 RunContext。

waitForUser只允许正式run或人工download_item；discover/capture_page/read_results为短操作，没有继续按钮，遇登录/验证应返回错误，用户处理后重新读取。SDK拒绝短操作人工等待，防止队列永久阻塞。

源码开发入口可用 `--acceptance` 临时开放四工具执行真实验收，不修改tools.json的发布状态；冻结发布入口拒绝此标记。使用同一用户数据/profile，验收结果仍由正式宿主记录。只有完成真实页面验收后才把发布描述的available改为true。

导出单个Excel/文本使用保存对话框，用户确认后原子替换；单个或多个视频选择文件夹，同时交付视频与文案txt，按本任务和商品分组。批量同名使用递增后缀，不覆盖已有文件。取消返回cancelled:true；失败计入对应项目，不损坏内部结果。外部目标不能位于内部数据目录。

候选 `relpath` 相对 dataRoot，必须位于当前任务 artifactStagingRoot；包含 candidateId、kind、role、displayName、metadata。宿主负责计算 hash、移动文件和登记。worker 退出前不会自行删除已提交候选。公共基础验证期间只使用测试适配器，四个真实适配器尚未实现时保持不可用。

保留原有解析与合并逻辑，目标调用边界：

```text
download_one(source, context, on_progress, on_log, should_cancel)
    -> 候选视频文件、标题、来源信息
```

- source 为受支持的公开视频地址或宿主已验证的来源记录；必须依赖罗盘会话的媒体交给 Node 适配器处理。
- context 提供 scratch 和 FFmpeg 路径，不让下载函数向 cwd 写正式结果。
- on_progress 报告阶段、已下载字节和可选总字节，不能在回调里直接修改界面。
- should_cancel 在每个下载块、解析阶段边界和 FFmpeg 等待循环检查；网络超时控制单次阻塞时长。
- 取消先关闭响应/浏览器/所属 FFmpeg，再删除不可用 part 文件，返回 cancelled；不能把半个文件作为成功候选。
- 解析优先顺序保持旧实现，拆分后用相同 fixture 验证，不在本次悄悄替换下载策略。
- 单条失败不取消其他已选条目，最终状态可以为 completed_with_errors。
- 取消异常必须独立传播，不能被浏览器解析失败的通用捕获吞掉后继续走 requests fallback。

### 5.1 人工混合来源任务

manual-video 由宿主协调器维护选中条目快照、逐条状态、attempt 和唯一 engine-state。每次只执行一条子下载；公开来源调用 Python 核心，会话来源取得浏览器 lease 后调用 Node download_item，完成或失败时释放该条目的资源。等待浏览器期间报告等待阶段，不占住公网下载锁等待另一个资源。

子下载器报告进度、候选和错误，宿主登记成功后才把条目标为完成并保存状态。Node download_item 不执行 task-store.saveTask，不另建 checkpoint。取消/重启恢复由协调器读取已登记条目，跳过成功项、重新解析未完成项。两个引擎不能同时写同一任务文件。

### 5.2 视觉指纹与共享索引

视觉指纹沿用现有 headless Edge、本机媒体服务和采样参数，FFmpeg 不代替其算法。文件读取边界由当前任务 scratch 和已登记 artifact 的受控映射提供，禁止公开整个磁盘目录。

业务适配器通过公共媒体查询获得 artifactId、内容 hash、文件大小、可用状态及带算法版本的指纹；内部路径只提供给受控处理模块，不传界面。视觉复用结果包含原 artifactId、匹配原因及分值，文案仍保存为新任务的引用元数据。人工任务不调用视觉去重来排除用户选择。

## 6. 状态机与控制规则

| 状态 | 中文 | 允许后续 |
| --- | --- | --- |
| queued | 排队中 | running、cancelled、failed（启动环境失败） |
| running | 执行中 | pausing、waiting_user、stopping、completed、completed_with_errors、failed、interrupted |
| pausing | 正在暂停 | paused、waiting_user、stopping、completed、completed_with_errors、failed、interrupted |
| paused | 已暂停 | running、stopping、interrupted |
| waiting_user | 等待处理 | running、stopping、interrupted |
| stopping | 正在停止 | cancelled、failed、interrupted |
| cancelled | 已停止 | queued（支持恢复时）、删除 |
| interrupted | 意外中断 | queued、删除 |
| failed | 任务失败 | queued（重试或恢复）、删除 |
| completed_with_errors | 部分失败 | queued（重试失败项）、删除 |
| completed | 已完成 | 查看、导出、删除 |

- 正常用户停止显示“已停止”，内部 cancelled；与进程崩溃 interrupted 区分。
- 暂停请求与末尾完成事件交错时，允许 pausing 直接完成；已完成工作不进入永久暂停等待。停止请求后的末尾结果保留，但任务收敛为 cancelled。
- 等待用户优先于暂停：宿主处于 pausing 时收到在途 waiting_user 消息，应显示 waiting_user；用户继续时，由现有 resume 同时清除 pauseRequested 与 waitingUser。
- completed 表示执行范围已完成且没有未处理错误，不允许仅凭子进程退出码 0 判断。
- 部分结果可在 failed/cancelled/interrupted 状态下查看，不伪装为整项任务成功。
- 重试和恢复增加 attempt，已登记的成功视频保留，已完成类目/组合按旧恢复规则跳过。
- cancelled 是否可恢复由能力与实际 checkpoint 决定。不可恢复时界面提供以相同条件创建新任务。
- 启动恢复把上次 running/pausing/paused/waiting_user/stopping 归为 interrupted，保留最后检查点与原因；不自动执行。
- 上次尚未执行的 queued 按创建顺序重新入队；当前版本不支持其工具时标记 failed。没有运行 handle 的 queued 仍可取消，不遗留不可操作记录。
- 浏览器锁在暂停/等待期间保留，正常停止、失败、结束或异常回收后释放。

## 7. 持久化数据模型

SQLite schemaVersion 起始为 1。仅宿主通过数据库事务写入；启用外键，数据库操作使用参数绑定。第一版核心实体如下，实际 SQL 与迁移实现放在公共存储阶段。

| 表 | 最小字段与约束 |
| --- | --- |
| `tasks` | id 主键；tool_id、parameter_version、parameters_json、state、attempt、进度摘要 JSON、错误摘要 JSON、state_relpath、created_at/updated_at |
| `artifacts` | id 主键；kind、sha256 可空、relpath 唯一、size、mime、ready/delete_pending/missing、created_at；视频 sha256 建唯一约束 |
| `task_artifacts` | task_id/artifact_id 外键；role、display_name、metadata_json；关联 ID 作为候选登记幂等依据 |
| `capture_items` | id 主键；source_key 唯一、source_kind、source_page、provider_id 可空、title、public_url 可空、link_kind、locator_json、captured_at |
| `schema_meta` | 当前 schema_version 与应用版本 |
| `pending_task_deletions` | 已确认删除任务的 ID 与时间；保留私有目录清理意图，文件占用后重启重试 |
| `artifact_fingerprints` | artifact_id 外键并随资产级联删除；algorithm_version、fingerprint_json；仅宿主写共享索引 |

任务配置包含人工选中条目的固定快照。删除或更新待选列表不影响已经创建的任务。视频标题、商品分组及配套文案保存在任务引用元数据中，不依赖共享视频文件名。

文件引用数从 task_artifacts 查询，第一版不额外维护容易失配的 ref_count 字段。共享媒体删除条件是没有有效引用且无活动登记操作。

engine-state.json 的 envelope 包含 formatVersion、toolId、taskId、attempt、savedAt 及该工具原生业务 state。业务结果和恢复位置只在其中保存一份；旧 taskId/id 通过适配器映射，不另建同内容 checkpoint 文件。临时写入采用同目录临时文件加替换，异常留下的临时状态文件不直接作为有效检查点。

数据库进度摘要更新可合并：运行中最多每秒一次，状态转换、checkpoint 和结果登记立即提交。摘要落后不影响已原子保存的业务进度；恢复优先读取有效 engine-state。

## 8. 人工条目身份与链接

### 8.1 来源与链接类型

source_kind：已接入 compass_ranking、public（公开分享链接及0.1.4新增的抖音页面稳定视频ID链接）。抖音详情/作者/搜索/推荐保留规范化公开URL，展示来源放在扩展信息中，不另建重复的下载通道。当前实际观测范围见[人工工作台记录](TOOLBOX_MANUAL_VIDEO_WORKSPACE.md)。

link_kind：public_page、temporary_media、unavailable。无公开视频地址时，不从媒体 URL 猜测视频 ID。

公开 URL 保存经域名与协议校验后的页面地址；页面定位记录保存来源及可验证身份。带签名的临时媒体 URL 仅保存在本次应用运行内存，复制与即时下载可使用，日志和永久数据库不保存。0.1.4的capture.resolve以最多10条的resolve_items短操作排队提取；重启后保留标题与定位，界面提示从原页面重新提取链接或下载，不把缺少临时地址等同于不能下载。

capture_item_details以item_id外键关联原capture_items，保存有限展示JSON（商品/店铺/作者、封面、来源、标题状态、序号、时长和提取失败提示）。原待选表保持十列，旧记录可无扩展信息。封面仅允许已登记平台图片CDN的HTTPS地址，临时视频地址不进入扩展JSON。

### 8.2 去重与重新读取

1. 有平台视频 ID 或可规范化公开视频 URL 时，以其作为 source_key。
2. 同一来源的页面原生记录 ID 可作为稳定身份，保存时同时保存来源。
3. 无原生ID但有唯一封面时，使用页码/类目/榜单/品牌/商品清单身份与商品、卡片特征；无封面弱条目仍使用完整卡片快照。只在可验证范围合并，不跨页仅按相同标题合并。提取每条均重核当前页面身份，严格快照条目重新拍快照。
4. 重新读取出现新的临时地址时更新内存来源；不改已运行任务的身份快照。
5. 使用旧定位下载前核对标题、商品或可取得的原生 ID；不匹配返回 PAGE_CHANGED 并要求重新读取。

一条视频可以有标题而无链接，界面仍可复制标题；不能下载时给出原因。条目有公开地址但暂不能解析时允许保存与复制，下载状态单独显示失败，不删除条目。

## 9. 文件安全与删除事务

- 所有 artifact 路径相对数据根目录；登记、打开、导出、删除前解析绝对路径，按 Windows 路径边界检查归属，拒绝 `..` 越界、其他盘符和指向外部的链接/重解析路径。
- 引擎可以使用绝对工作路径，但界面只能传 artifactId，不接受路径穿透接口。
- 正式登记前验证文件存在、已关闭、大小与类型符合预期。视频不仅检查扩展名，使用 FFmpeg 检查可读取的视频流。
- 每个任务的 scratch 由该任务负责；缓存清理不会通配扫描其他工具项目或用户下载文件夹。
- 删除预览针对用户选择计算独占文件与共享引用，不能把共享媒体大小重复统计为可释放空间。
- 确认删除在事务中撤销选定引用、标记无引用文件 delete_pending；随后删实际文件并清理记录。启动时继续处理未完成删除。
- 文件占用时保留 delete_pending 并报告，稍后重试，不清除恢复该操作需要的索引。
- 导出取消返回 cancelled，不进入任务失败；空间不足或文件占用返回对应错误，内部结果保留。

## 10. 错误代码

| 代码 | 用户操作/系统处理 |
| --- | --- |
| `INVALID_PARAMETERS` | 标明需修正字段 |
| `UNSUPPORTED_OPERATION` | 按能力隐藏/拒绝该操作 |
| `EDGE_NOT_FOUND` / `WEBVIEW2_MISSING` | 安装界面指引 |
| `BROWSER_BUSY` | 展示占用任务，等待或停止 |
| `BROWSER_DISCONNECTED` | 保存进度，重新连接后恢复 |
| `LOGIN_REQUIRED` / `VERIFICATION_REQUIRED` | 在 Edge 完成登录/验证后继续 |
| `PAGE_CHANGED` / `PAGE_UNSUPPORTED` | 重新打开或读取支持页面 |
| `LINK_EXPIRED` / `MEDIA_UNAVAILABLE` | 重新读取或重试该项 |
| `NETWORK_ERROR` | 保留成功项，重试失败项 |
| `DISK_FULL` / `FILE_IN_USE` | 清理空间/关闭占用文件后重试 |
| `ARTIFACT_MISSING` | 标记缺失，允许删除记录或重新生成 |
| `WORKER_PROTOCOL_ERROR` / `WORKER_EXITED` | 回收相关进程，保存检查点并报告任务错误 |
| `STATE_CORRUPT` | 不自动覆盖损坏状态；显示诊断并保留已登记结果 |

异常须保留原始诊断类别，不能把所有问题统一写成“下载失败”。是否可重试由错误及任务能力共同决定。


罗盘卡片身份按优先级使用已观察原生 videoId（含公开视频链接中的 ID）、封面 origin+pathname、最后才使用标题。标题和封面签名查询参数不影响已取得更稳定身份的卡片；标题仅作为展示元数据。无原生 ID 的卡片仍受整个页面商品、卡片顺序快照约束；相同封面无法区分的弱卡片不供人工选择，不能以不同标题假装能唯一定位。更新前已生成的弱身份待选项须重新读取页面，旧自动任务检查点须新建任务，不猜测迁移身份。

悬浮卡片缺标题时，最多等待 1 秒，只读取可见 popover 中含相同封面 origin+pathname 的唯一浮层标题；每次等待保留取消/暂停边界。其他卡片迟到的 tooltip、无对应封面或多个对应浮层均不提供标题，不能取任意最后可见浮层。媒体登记文案优先使用正常播放器的实际非空标题，缺失或空占位（-、--）才使用与卡片绑定的标题。

更多视频浮层可能重复展示可见卡片的完整列表。只有浮层列表前缀与全部可见卡片的可观察身份按顺序完全一致，才保留可见卡片并追加浮层剩余项，且保留各项原始浮层 cardIndex；例如 4 张可见卡片加包含同前缀的 10 项浮层最终为 10 项，不能拼成 14 项导致漏扫末尾候选。没有完整有序前缀时仅按原生 ID 保守去重；同一列表中不同位置的相同弱封面仍保留为歧义，不凭封面合并。只有浮层列表时保留完整列表。

正常播放器打开后仅在可见 video 有 currentSrc 且 readyState≥2 时接收媒体；等待仍保留 7 秒上限和外部 popup 分支。video.error（例如平台将 HTML 页面当视频导致 code=4）立即作为单条 MEDIA_UNAVAILABLE 记录并继续其他候选，不把该地址交给下载流程；提示此视频在平台播放器中无法播放，可跳过或稍后重试。


## 2026-10-13：实现状态与实际验收边界

- `tools.json`四项`available=true`表示可从统一界面使用，不能解释为所有平台、安装或异常场景验收完成。可选作者主页/推荐流仍未宣称支持。
- 自动采集的媒体复用按任务引用保存文案状态；引用存在不代表本次新建文件，文案缺失须明确显示。平台播放器的`currentSrc`若实际指向罗盘HTML页面且媒体error=4，应返回`MEDIA_UNAVAILABLE`，不得登记成下载成功或把页面地址当视频链接。
- 复制标题可处理无公开链接的会话条目；复制公开链接仅统计实际可用地址，无地址项返回unavailable计数。非法分享链接按输入校验拒绝。该约定已有真实最小范围证据，详细计数与限制见EXECUTION最新记录。
- 本次版本更新记录当前实现状态及上述验收语义；NDJSON、状态机与共享引用约定继续按本文执行。最终冻结包、干净目标环境、清理和Git交付仍需独立通过门槛。

## 0.1.2：数据位置与默认导出位置

新增无参桥接storage.get_location、storage.choose_location、storage.clean_old_location；当前目录/剩余空间/待迁移/旧副本状态仅用于界面展示，路径选择通过系统目录对话框。迁移在下次启动且数据库/浏览器启动前完成复制与校验，最后切换小配置。已配置目录缺数据库时拒绝启动，不静默新建空库；旧副本清理前核验当前索引和结果，活动任务/读取时拒绝更改或清理。

storage.get_export_location、storage.choose_export_location同样无参。配置位于数据根preferences.json，随迁移保留；内部视频去重路径不变，指定的外部位置只用于默认导出。单报告和待选列表仍使用保存对话框，默认打开所选目录。具体字段与取消语义见TOOLBOX_EXPORT_LOCATION.md。

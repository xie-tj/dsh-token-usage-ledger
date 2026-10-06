# dsh Usage Ledger Plugin

dsh-plugin-usage-ledger 为 DeepSeek Harness Web profile 提供持久化的模型用量账本和 Usage 仪表盘。它记录每次 provider dispatch，包括失败和重试，保存输入、输出和缓存 token。

账本不会进入当前 session 的 flush barrier。模型请求、session durability 和页面打开都不等待历史统计完成。

## 运行方式

插件使用独立低优先级 worker。worker 以单 session 串行方式读取日志，并在每个小批次后让出执行权。主 dsh 进程只发送压缩后的 live 事件，读取小批量 SQLite 查询结果；它不保留历史 assistant 内容或完整 call 账本。

SQLite 是唯一账本存储：

- 使用 profile 中 storages/usage-ledger-v4.sqlite；
- 每个 session 只在 worker 内加载当前 replay cursor 和仍然活跃的 request；
- 已完成 call 永远留在 SQLite，不会进入常驻 Map；
- Snapshot 使用分页数据库扫描和事件循环让出，聚合值完整，逐条 events 有固定上限；
- 旧 usage_ledger.json、usage-ledger-v2.sqlite 和 usage-ledger-v3.sqlite 不读取、不删除、不迁移。v4 从 retained session 日志重新统计。

这让历史规模主要增加磁盘占用和后台耗时，不会线性增加当前 dsh 任务的内存。

## 自适应历史回填

默认策略是完整历史，最近 30 天优先。最近窗口完成后，worker 自动继续较早的 retained sessions；进程重启后根据 SQLite cursor 断点恢复。

主进程每隔 1 秒观测自身的事件循环延迟、事件循环利用率、RSS 和电源状态：

- 事件循环压力需要连续 backfillPauseSamples 个采样都超过上限才暂停；单次尖峰只降低处理占比；
- 中度繁忙时降低处理占比，连续两个空闲采样后逐步提高；
- RSS 或可用内存越界时仍然立即暂停；
- 只有配置 backfillPowerMode: ac-only 时才在确认使用电池后暂停；默认 always，电源 probe 不可用（例如非 macOS）不再暂停；
- live usage 事件始终优先于历史扫描。

Usage 页面以独立状态面板显示统计中、暂停原因、异常或历史完成状态，并展示已处理／总会话数、已处理事件数、待处理会话数和扫描进度。百分比只按已完成会话计算，不代表 token 处理量或预计剩余时间；会话总数尚未发现时显示扫描中的不定进度，不标记为 100%。进度每两秒自动更新；状态读取失败时保留上次的计数并提示数据暂未刷新。因资源或电源暂停时，已有统计仍可阅读和刷新。

JSONL persistence 提供 provider-owned 流式 session header lister，因此主进程不会先创建全量 session 列表。自定义 persistence 若仅支持 reader、未提供 lister，会采用一次兼容性 listing；完全没有 isolated reader 时仅启用 live ledger，并在状态中说明历史回填暂停。

## 安装与启动

从 Git 安装到 Web profile；生产环境固定到 commit SHA：

    dsh plugin --profile web add github:xie-tj/dsh-token-usage-ledger#<commit-sha>
    pnpm dsh web

本版本面向 DSH 0.2.0-rc.2 及以上的 0.2.x（peerDependencies 为 `^0.2.0-rc.2`）。安装包已包含 Host、Client、Typert 和 worker 的编译产物，不依赖安装时构建。

打开 Settings → Usage 查看最近 7 天或 30 天的数据。页头按钮等高并保持成组，说明文字独占一行；提供方、模型和时间范围采用等宽筛选布局，按设置面板的内容宽度自适应而不是按整个 app 窗口宽度。筛选提供方或模型时，页面向 Host 请求该筛选的数据库聚合，而不是把全部 request 明细传入浏览器。

同一个仪表盘也挂在插件页里本包自己的行上（plugins.row.config，键为 dsh-plugin-usage-ledger#usage-ledger-plugin）。plugins.item 属于官方设置页，本包不占用它，因此不会出现在官方分组里。

设置导航栏里「用量」行的图标：已发布的外壳按 section id 固定映射图标，插件无法注册，因此本插件在客户端适配——按自己的导航文案（当前语言）找到自己的那一行并打上标记，由本插件样式表隐藏外壳的兜底图标、改画本插件的柱状图。适配只作用于本插件自己的行；找不到对应行时不产生任何影响，卸载时标记与观察器一并撤销。较新的外壳若提供 settings.section.glyph seat，则由外壳直接渲染插件图标，标记逻辑检测到之后自动让位，不重复绘制。

页面默认显示全部历史的汇总。Export CSV 会把当前筛选的完整 call 记录按 SQLite 页流式写入 owner-only 文件，完成后显示保存路径；导出不会把整份 CSV 或整本账本装入浏览器内存。

## 配置

bundle patch 默认提供 databasePath，通常不需要手动配置。需要调整部署策略时，可在 usage-ledger-plugin 的 Cordis config 中设置：

| 字段 | 默认值 | 含义 |
|---|---:|---|
| databasePath | profile patch | 私有 v4 SQLite 文件 |
| backfillMode | process | process 启用 worker；off 停止历史回填 |
| backfillScope | all | all 为全历史；recent 只处理优先窗口 |
| backfillDays | 30 | 优先处理的最近天数 |
| workerMaxHeapMiB | 512 | worker V8 堆上限 |
| workerMaxActiveAttempts | 256 | 单个 session 可保留的未完成 request 上限 |
| workerBatchEvents | 512 | 每次解析的最大事件数 |
| workerSliceMs | 50 | 处理后主动让出的最长时间片 |
| backfillPowerMode | always | always 忽略电源状态；ac-only 仅接电回填 |
| loadSampleIntervalMs | 1000 | 主进程负载采样间隔 |
| backfillMaxDelayMs | 15000 | 暂停或强退让的最长间隔 |
| backfillInitialWorkShare | 0.25 | worker 初始处理时间占比 |
| backfillMinWorkShare | 0.10 | worker 的最低处理时间占比 |
| backfillMaxWorkShare | 0.80 | worker 的最高处理时间占比 |
| backfillAimdIncrease | 0.10 | 健康窗口后的线性增量 |
| backfillAimdDecrease | 0.50 | 繁忙采样时的乘性降幅 |
| backfillPauseRssMiB | 2048 | 暂停回填的 dsh RSS 阈值 |
| snapshotEventLimit | 256 | 单次 Snapshot 返回的明细行上限 |
| snapshotScanBatchRows | 256 | Snapshot 每个 event-loop 回合读取的行数 |

高级阈值也可配置：backfillRecoverySamples、backfillPauseSamples、backfillBusyEventLoopUtilization、backfillPauseEventLoopUtilization、backfillBusyEventLoopDelayMs、backfillPauseEventLoopDelayMs 和 backfillPauseAvailableMemoryMiB。AIMD 的 work share 会转换为每个 worker slice 之间的等待时间。

## Snapshot API

Remote 方法为 usageLedgerPlugin/snapshot：

    interface UsageLedgerSnapshotRequest {
      workspace?: string | null
      provider?: string | null
      model?: string | null
      days?: number
      all?: boolean
      timeZone?: string
    }

返回值保留 events、models 和 daily。all 为 true 时，models 与 daily 覆盖最早匹配 call 至今天的完整历史；页面只把最近 30 个 daily bucket 画成图表，指标和模型表仍是全历史。eventsTruncated 表示逐条明细达到 snapshotEventLimit；models 和 daily 始终基于完整匹配范围计算。days 的范围是 1 到 366，timeZone 决定日边界和 daily 分组。

usageLedgerPlugin/status 返回 idle、running、paused 或 failed，以及处理进度、最近错误和当前 pace。pace 的 reason 为 battery、event-loop 或 memory 时，说明历史扫描正退让；live 记录仍会继续进入 worker。

## 统计语义

- 一个 provider dispatch 计为一次 request；success、failure、aborted 与 retry attempt 分别计数。
- retryRequests 标记随后被 retry 的失败或中断 attempt，不额外生成 request。
- provider 和 model 从 request/header 或 request/context 恢复；无法恢复时为 unknown。
- final assistant-message usage 优先于最后一个 provisional usage chunk。
- 未报告 usage 的 attempt 仍计入 request，token 为 0，并标记为 unmetered。
- inputTokens 为 provider 报告的非缓存输入；outputTokens 包含 provider 报告的 reasoning token；cache read/write 分别保存。

## 构建与验证

    pnpm install
    pnpm run typecheck
    pnpm run test
    pnpm run pack:check

## License

MIT

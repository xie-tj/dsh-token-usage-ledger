# dsh Usage Ledger Plugin

`dsh-plugin-usage-ledger` 为 DeepSeek Harness Web profile 提供持久化用量账本和可视化 Usage 仪表盘。它记录每次 provider dispatch（包括失败与重试），保存输入、输出和缓存 token，并把 live 事件、历史回填和账本写入隔离到低优先级后台进程；当前任务不等待 Usage durability 或历史回放。

核心能力：

- 独立持久化账本：重启后保留历史，并由独立 worker 对最近 30 天 session 执行 best-effort 回填；
- 精确统计：曲线、柱状图和 API 请求次数保留精确值，模型明细使用 K/M/B/T 紧凑单位；
- 日级明细：Token 流量图表的悬停提示显示当日输入、输出、缓存和总计；
- 灵活筛选：支持提供方、模型和最近 7 天／30 天筛选，模型明细默认按具体模型聚合；
- 缓存可见：单独展示缓存命中 token，并保留失败、未计量和重试请求。

当前版本按 `@deepseek-ai/dsh` `0.1.2-alpha.5` 依赖线构建，要求 Node.js `^22.19.0 || >=24.0.0`。

## 安装与启动

从 Git 安装到 Web profile；生产环境应将 Git spec 固定到 commit SHA：

```sh
dsh plugin --profile web add github:xie-tj/dsh-token-usage-ledger
# 例如：github:xie-tj/dsh-token-usage-ledger#<commit-sha>
dsh --profile web
```

仓库包含可加载的 Host、Client 和 Typert `lib/` 产物，安装时不依赖 `prepare` 构建。若包管理器要求批准 Git dependency 的构建脚本，请按实际 profile 的 pnpm 配置处理；本包的预构建安装路径本身不需要执行源码构建。

安装后打开 Settings → Usage。页面读取最近 30 个浏览器本地日历日的数据，并按提供方、模型和最近 7 天或 30 天筛选；模型明细默认隐藏提供方并按具体模型聚合，也可以开启提供方显示。Usage 导航和 Plugins 中的只读卡片只在 Host 正在提供 `usage-ledger` settings namespace 时注册；Loader 停用 Host 后，两处显示会随 namespace 镜像刷新而移除。

## Ledger 存储与迁移

本包将高频 `usage_ledger` domain 路由到 profile 的 SQLite backend，数据库路径为 `dshHomePath('storages/usage-ledger-v3.sqlite')`；其他 domain 仍使用 profile 的默认 backend。主进程只应用 worker 产生的 call/cursor mutation，单次写入只修改 SQLite 中的记录，不会重写完整 JSON 账本。

v3 首次启用时从 session 日志重新统计，插件不会读取、删除或迁移已有 `usage_ledger.json` 和 `usage-ledger-v2.sqlite`；旧文件保留为只读备份。仓库中保留的旧迁移脚本不属于启动流程，也不会被 worker 调用。

卸载本包使用：

```sh
dsh plugin --profile web remove dsh-plugin-usage-ledger
```

卸载会移除本包的 bundle、`usageLedgerPlugin` Remote 和 Client 显示贡献，但不会删除 `usage_ledger` storage domain 中的已有数据。`cordis.patch.yml` 只在目标行存在时禁用 stock Web Usage，并为本包路由独立的 v3 SQLite domain；若 profile 另行提供同名 Usage 实现，它们的显示由各自的 Loader 配置决定。

## 用量页面预览

https://github.com/user-attachments/assets/8c3c7876-d97c-4a73-abdf-bd1dc57ca906

[下载用量页面演示视频](./assets/usage-demo.mp4)

视频展示了 Settings → Usage 中的筛选、指标卡、图表和模型统计明细。

## 从源码构建

```sh
pnpm install
pnpm run build
```

`build` 依次清理产物、检查 Host 类型、构建 Host、生成 Typert Remote、检查 Client 类型并构建 Client。单独命令见 `package.json`：`typecheck:host`、`typecheck:client`、`bundle:host`、`generate:typert` 和 `bundle:client`。

## 运行时前置条件与自定义 profile

Host 插件硬依赖以下 Cordis 服务：

- `storageDomain`：打开 `usage_ledger` 持久化域；
- `sessions`：观察 live session；
- `sessionPersistence`：枚举和读取历史 session。

可选的 `settings` 服务存在时，插件注册只读的 `usage-ledger` 设置 namespace；缺少它不影响 Host 账本。Client 依赖 Web 的 Slots、Locale、Remote Gateway、Settings namespace 镜像和 Client Runtime。

`cordis.patch.yml` 安装 SQLite backend，并只把 `usage_ledger` 路由到它；它不改变 session persistence provider，也不覆盖其他 domain 的默认 backend。自定义 Cordis route、scope 或 isolate 必须让本插件能够访问上述 Host 服务，并让 Client Remote Gateway 能够访问 Host Remote；否则插件不会提供完整功能。

## Bundle 如何替换内置 Web Usage

`cordis.patch.yml` 先按行 ID 禁用 stock Web profile 中的两个可选内置实现：

- `usage-ledger` / `@deepseek-ai/dsh-usage-ledger`；
- `ui-settings-usage` / `@deepseek-ai/dsh-client-ui-settings-usage`。

随后安装 SQLite backend，并插入 `usage-ledger-plugin` / `dsh-plugin-usage-ledger`。目标行不存在时，patch 仍可应用；因此不要在其他位置再次挂载内置 Usage Host 或本插件，否则可能出现重复 service、Remote 或 Settings section 注册。

Host service 名为 `usageLedger`，但本包使用独立 Remote namespace `usageLedgerPlugin`，避免与 stock `usageLedger` Remote 冲突。Client 若发现该 namespace 已挂载会复用它，否则挂载包内生成的 Typert Remote。

## Snapshot API

Remote 方法为 `usageLedgerPlugin/snapshot`，请求字段均可省略：

```ts
interface UsageLedgerSnapshotRequest {
  workspace?: string | null
  days?: number
  timeZone?: string
}
```

默认值：

- `workspace: null`：合并所有 workspace；字符串表示精确匹配该 workspace 路径；
- `days: 30`：截至请求当天的 30 个连续日历日；
- `timeZone: "UTC"`：决定日期范围和按日分组。

Client Usage 页面显式请求 `{ days: 30, timeZone: <浏览器 IANA 时区> }`，再在本地执行提供方、模型和时间范围筛选。

请求在 Remote 边界执行以下校验并抛出对应错误：

- `workspace` 既不是字符串也不是 `null`：`TypeError: usage ledger workspace must be a string or null`；
- `timeZone` 不是非空字符串：`TypeError: usage ledger timeZone must be a non-empty IANA timezone`；
- `timeZone` 不是 `Intl.DateTimeFormat` 接受的 IANA 时区：`RangeError: usage ledger timeZone is invalid: '<value>'`；
- `days` 不是 1–366 的安全整数：`RangeError: usage ledger days must be a safe integer from 1 through 366`。

返回值包括请求解析后的范围、生成时间、范围内的逐尝试 `events`、按 workspace/provider/model 聚合的 `models`，以及包含零用量日期的 `daily`。snapshot 只读取当前已提交的 SQLite 数据，不等待 worker、历史回填或写入队列；页面先展示已有数据，后台统计完成后可刷新获取新增记录。

另有 `usageLedgerPlugin/status` Remote，返回 `idle`、`running`、`paused` 或 `failed` 及最近 30 天处理进度和最近错误。它只用于非阻塞状态展示。

## 持久化与历史回填

插件打开版本为 3 的 `usage_ledger` storage domain，并通过 SQLite backend 保存：

- `calls` 按 `[sessionId, session.createdAt, attemptId]` 的稳定键保存每次 provider dispatch；
- `sessions` 保存每个 session lifecycle 的回放 cursor，以及当前和成功 attempt 的 `turn:step` 映射。

主进程只提取 `usage`、retry、step、route 和 terminal outcome 等必要字段并投递给 worker，不跨进程传递 assistant 内容。worker 在单 session、每批最多 256 个事件、约 25ms 时间片内执行 reducer，然后返回压缩的 call/cursor mutation；主进程按小批次应用到 SQLite。session cursor 可在 worker 重启后继续使用，call key 保证重放幂等；session disposed 时删除 cursor，但已记录的 call 行保留用于历史统计。fork 的继承前缀不会作为新 session 用量重复计入。

启动时，插件只在主进程轻量枚举最近 30 天的 session header，然后把 provider-owned `backgroundReaderSpec` 和路径配置交给 worker。JSONL provider 使用一次扫描、分批解码的 streaming reader，不再通过 `read(offset, 256)` 反复完整解压同一日志。自定义 persistence 未提供该 seam 时只启用 live ledger、记录 warning，并跳过历史回填，不退回主线程全量回放。live session 始终优先；单个损坏 session、worker 崩溃或 SQLite 写失败只影响 Usage，并按状态显示和后台重试。

alpha.5 会记录 `step/start` 创建的 provider dispatch，并在 `llm/retry-started` 创建后续 attempt；官方 `assistant/chunk` usage、`assistant/message` final usage 和 `llm/retry`／`turn/end` 事件补全可用记录。provider/model 从此前最近的 `request/header` 或 `request/context` 推导；无法推导时写为 `unknown`。

本包不发布 `./invariant` companion。迁移后它不再生产自有 session event，也没有两个可独立观察、必须始终一致的运行时事实：官方事件的有效性由其生产包负责，账本存储则是明确允许滞后的 best-effort 派生数据。Host service、Remote 和 Client slot 都通过各自的注册 disposer 管理，并不构成独立 invariant。

## Best-effort recovery

账本观察器不会注册 `session/flush` durability listener，因此 Usage 永远不进入当前任务的 flush barrier。主进程到 worker 的 IPC 在 pipe 满时按 session 合并为 high-water mark；后续 provider-backed rescan 会补齐丢失的 live 通知。worker 以低 OS 优先级、512 MiB 默认堆和时间片运行；崩溃按退避重启，SQLite mutation 失败留在有界重试队列中。读取 snapshot 只返回已提交数据，不等待历史 session 枚举或回填。

这是 best-effort 派生数据，不是请求事务的一部分。storage backend 持续不可用、历史 session 无法读取、进程在持久化前终止，或源 session 本身缺少必要事件时，Usage 数据可能暂时滞后或永久不完整。插件不会伪造缺失 token。

## Model、token 与 KV-cache 统计语义

- 一次 provider dispatch 计为一次 request；success、failure、aborted 和 retry attempt 都分别计数。仅有 start、没有 terminal event 的 attempt 显示为 `started`。
- `retryRequests` 标记因 `llm/retry-started` 而被后续 attempt 重试的最近 failure/aborted attempt；它不是额外生成的一次请求。
- provider/model 来自最近的官方 `request/header` 或 `request/context` route；无法推导时记为 `unknown`。
- `inputTokens` 是 provider 报告的非缓存输入 token，`outputTokens` 包含 provider 报告在输出中的 reasoning token。
- `cacheReadTokens` 与 `cacheWriteTokens` 在 API 和持久化中分开保存。Web 的 Token 流量将二者相加显示为 Cached，模型明细另外显示 `cacheReadTokens` 作为缓存命中；Input + Output + Cache Read + Cache Write 组成 Token Total。模型明细中的数值使用 K、M、B、T 紧凑单位，曲线和柱状图保留精确数字；模型明细默认按具体模型跨提供方聚合，开启提供方显示后再拆分为 provider/model 行。
- final assistant-message usage 优先于最后一个 provisional usage chunk。两者都不存在时，该 attempt 仍计入请求数，但计为 unmetered，token 为 0。
- Host 按 workspace/provider/model 分组；当前 Web 页面在显示所有 workspace 时会把相同 provider/model 的 workspace 行合并。

插件只展示 provider 报告的计量结果，不估算 token，也不计算费用、折扣、缓存价格或配额影响。

## Settings shell 与 Usage 图标

Client 注册一组由 Host capability 控制的显示贡献：`settings.section` 的 ID 为 `usage`、顺序为 20，`settings.plugin.item` 的 key 为 `usage-ledger`。两者使用相同的中英文文案和只读 dashboard，并在 settings namespace 镜像不再包含 `usage-ledger` 时一起释放。Host 注册的空设置 schema 不提供可编辑选项。

侧栏图标由 Settings shell 根据 section ID 映射，不由本插件注册。包含 `usage` 图标映射的兼容 Web shell 会显示柱状图图标；旧版或自定义 shell 可能只显示标签或默认图标，但这不改变 Usage section 和 Remote 数据功能。

## Known Limitations and Deferred Work

- Web 尚无 workspace 选择器；Remote 已支持精确 workspace 过滤。
- Legacy session 可能显示 `unknown` route，且无法恢复源日志未记录的失败、abort、retry 或 token。
- 页面合并展示 cache read/write，未分别绘图；也不显示价格或金额。
- 持久化保留、清理和导出工具未实现。
- 旧 JSON/v2 SQLite 不会自动迁移；首次 v3 账本只从 session 日志重新统计。
- best-effort warning 会进入 Host 日志和 `status` Remote；页面只展示最近的后台状态。
- 插件设置卡当前只读，没有运行时配置项。
- 回归测试覆盖发布入口、Typert source location、Client Host-availability/late-slot/HMR 生命周期、Plugins 卡交互、Host service 生命周期、快照字段投影、官方事件 accounting 和实际 Loader composition；它们不替代真实 Web profile 启动测试。

## 验证

提交前运行：

```sh
pnpm run typecheck
pnpm run build
pnpm run test
pnpm run pack:check
```

`pnpm run test` 会先构建 Host、Typert 和 Client，再运行 Vitest；`pnpm run pack:check` 会检查归档内容、exports 目标及 source map/cache 泄漏。

## License

MIT

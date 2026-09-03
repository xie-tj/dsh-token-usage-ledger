# dsh Usage Ledger Plugin

`dsh-plugin-usage-ledger` 为 DeepSeek Harness Web profile 提供持久化用量账本和可视化 Usage 仪表盘。它记录每次 provider dispatch（包括失败与重试），保存输入、输出和缓存 token，用 session 历史回填数据，并在 Settings → Usage 中按提供方、模型和时间范围查看用量。

核心能力：

- 独立持久化账本：重启后保留历史，并对已有 session 执行 best-effort 回填；
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

卸载本包使用：

```sh
dsh plugin --profile web remove dsh-plugin-usage-ledger
```

卸载会移除本包的 bundle、`usageLedgerPlugin` Remote 和 Client 显示贡献，但不会删除 `usage_ledger` storage domain 中的已有数据。`cordis.patch.yml` 只插入本包，不会修改或恢复 stock Web profile 的行；若 profile 另行提供同名 Usage 实现，它们的显示由各自的 Loader 配置决定。

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

`cordis.patch.yml` 不会安装 storage-domain backend、session persistence provider，也不会为自定义 profile 增加服务路由。自定义 Cordis route、scope 或 isolate 必须让本插件能够访问上述 Host 服务，并让 Client Remote Gateway 能够访问 Host Remote；否则插件不会提供完整功能。持久化能力取决于 profile 为 `storageDomain` 配置的 backend，当前 DSH alpha.5 stock Web profile 使用 `storage-json` backend（`storage-domain` 的 backend key 为 `json`）。

## Bundle 如何挂载外部 Web Usage

`cordis.patch.yml` 仅插入 `usage-ledger-plugin` / `dsh-plugin-usage-ledger`：

- alpha.5 stock Web profile 已不包含旧的 `usage-ledger` 或 `ui-settings-usage` 行，因此 patch 不再声明禁用或替换操作；
- patch 不安装 storage-domain backend、session persistence provider 或服务路由；
- 安装时只应通过该 patch 挂载本包一次。卸载时移除 `dsh-plugin-usage-ledger`；不会删除已有账本数据，也不会改变 profile 中其他 Usage 行。

因此不要在其他位置再次挂载内置 Usage Host 或本插件，否则可能出现重复 service、Remote 或 Settings section 注册。

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

返回值包括请求解析后的范围、生成时间、范围内的逐尝试 `events`、按 workspace/provider/model 聚合的 `models`，以及包含零用量日期的 `daily`。生成 snapshot 前，Host 会等待历史回填和已观察到的 session 队列完成。

## 持久化与历史回填

插件打开版本为 2 的 `usage_ledger` storage domain：

- `calls` 按 `[sessionId, session.createdAt, attemptId]` 的稳定键保存每次 provider dispatch；
- `sessions` 保存每个 session lifecycle 的回放 cursor，以及当前和成功 attempt 的 `turn:step` 映射。

账本观察已提交的官方 usage-bearing `assistant/chunk`、`assistant/message` 以及 `llm/retry`、`llm/retry-started`。call 行独立、幂等地更新；session cursor 在 `session/flush`、历史回填结束和插件关闭时写入。session disposed 时删除 cursor，但已记录的 call 行保留用于历史统计。fork 的继承前缀不会作为新 session 用量重复计入。

启动时，插件通过 `sessionPersistence.list()` 枚举历史 session。alpha.5 的已发布声明/runtime 使用 `list(): SessionHeader[]` 加 `inspect()`，而当前 source checkout 可能使用带 revision 的 `list()` 加 `open(id, 'read')`；两者版本号相同但运行时接口不同。Host 在这一处用属性检查适配，并优先使用有界 `open`/`read`，同时校验返回 metadata、在 finally 释放 read handle。live session 直接接管；非 live session 建立不发布到 session registry 的临时实例并回放。冷历史按 session 串行读取、写入和释放；一个解压日志完成后才读取下一个，避免同时保留全部临时 session 的事件图。历史列表读取失败会记录 warning 并结束该次回填；单个 session 读取失败只跳过该 session。snapshot 仍可汇总成功写入的账本数据。fork 的继承前缀只用于推导 owned event 的 route，不作为新 session 用量计入。

alpha.5 会记录 `step/start` 创建的 provider dispatch，并在 `llm/retry-started` 创建后续 attempt；官方 `assistant/chunk` usage、`assistant/message` final usage 和 `llm/retry`／`turn/end` 事件补全可用记录。provider/model 从此前最近的 `request/header` 或 `request/context` 推导；无法推导时写为 `unknown`。

本包不发布 `./invariant` companion。迁移后它不再生产自有 session event，也没有两个可独立观察、必须始终一致的运行时事实：官方事件的有效性由其生产包负责，账本存储则是明确允许滞后的 best-effort 派生数据。Host service、Remote 和 Client slot 都通过各自的注册 disposer 管理，并不构成独立 invariant。

## Best-effort recovery

账本观察器不会阻塞 session event append。每个 session 使用顺序队列处理；更新失败会写 warning，而不是使模型请求失败。运行期间，仍待处理的 sequence 会再次调度。稳定 call key 以及 cursor 回放使部分写入可以安全重试；重启时会从持久化 cursor 之后继续回放可用事件。读取 snapshot 会等待当前 backfill，并接管 live session、排空已观察到的队列，但不会重新尝试一次已经结束的历史 session 枚举。

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
- 持久化保留、清理、导出和迁移工具未实现。
- best-effort warning 只写 Host 日志；页面没有逐 session 回填诊断。
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

# dsh Usage Ledger Plugin

`dsh-plugin-usage-ledger` 是一个可安装的 DeepSeek Harness bundle，提供持久化用量统计、历史 session 回填，以及 Web 设置中的「用量」页面和 Plugins 配置卡片。

## 安装

```sh
dsh plugin --profile web add github:xie-tj/dsh-plugin-usage-ledger
# 生产环境建议把 github spec 固定到一个 commit SHA
dsh --profile web
```

安装后打开 Settings，进入「用量」即可查看 API 请求次数、Token 曲线/柱状图、模型汇总和历史数据。

## Bundle 内容

- Host：监听 `llm/request-attempt`，将请求尝试和报告的 token 用量写入 `usage_ledger` 存储域，并从历史 session 回填。
- Client：注册 `settings.section` 的 `usage` 页面和 `settings.plugin.item` 的 `usage-ledger` 配置卡片。
- Remote：客户端在目标 dsh 已提供 `usageLedger` Remote 时复用；缺失时由本插件挂载生成的 Remote 描述符。
- 构建产物：仓库提交可直接加载的 `lib/client.js` 和 Typert 产物，不要求 Git 安装时执行构建脚本。

## 兼容性

插件面向 `@deepseek-ai/dsh` `0.1.0-rc.8` 的 `next` 依赖线，要求 Web profile 提供 `storage-domain`、SQLite backend、Client Runtime、Settings 和 Remote Gateway。

当前 DeepSeek Harness 源码工作区已经把 Usage 行组合进 `dsh-web-app`；在该工作区内不要同时安装本 bundle，否则会重复挂载 Usage Host 服务。这个仓库用于不内置 Usage 的 dsh profile 或拆分后的发行版本。

导航栏柱状图图标由 dsh Settings shell 的 `usage` 导航映射提供；使用包含该映射的 Web shell 才会显示图标。

Git 安装的包应固定 commit；pnpm 可能要求 profile 的 `pnpm-workspace.yaml` 为 Git dependency 的构建脚本配置 `allowBuilds`，本 bundle 的预构建产物本身不需要执行 prepare。

## License

MIT

# dsh-plugins

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件开发仓。一个插件一个目录，每个包独立版本、独立发布到 npm 的 `@t4r71` 作用域。

本仓只负责三件事：**插件索引**（本文件）、**构建与发布脚手架**（`scripts/`）、**发布流程**（`docs/PUBLISHING.md`）。本仓**不设仓级版本号，不打仓级 tag**——版本属于包，不属于仓。

## 包索引

| 目录 | 包名 | 面向 DSH | 状态 | npm |
| --- | --- | --- | --- | --- |
| [`packages/dual-axis`](packages/dual-axis) | `@t4r71/dsh-dual-axis` | `0.1.7-rc.2` | 已发布、已验证 | [0.1.0](https://www.npmjs.com/package/@t4r71/dsh-dual-axis) |
| [`packages/dual-axis-ui`](packages/dual-axis-ui) | `@t4r71/dsh-dual-axis-ui` | `0.1.7-rc.2` | 已发布、已验证 | [0.1.0](https://www.npmjs.com/package/@t4r71/dsh-dual-axis-ui) |
| [`packages/task-tree`](packages/task-tree) | `@t4r71/dsh-task-tree` | `0.1.6-alpha.2` | 未迁移 | 未发布 |
| [`packages/task-tree-host`](packages/task-tree-host) | `@t4r71/dsh-task-tree-host` | `0.1.6-alpha.2` | 未迁移 | 未发布 |
| [`packages/plan-tree`](packages/plan-tree) | `@t4r71/dsh-plan-tree` | `0.1.6-alpha.2` | 未迁移 | 未发布 |
| [`packages/ui-plan-tree`](packages/ui-plan-tree) | `@t4r71/dsh-ui-plan-tree` | `0.1.6-alpha.2` | 未迁移 | 未发布 |
| [`packages/ui-task-tree`](packages/ui-task-tree) | `@t4r71/dsh-ui-task-tree` | `0.1.6-alpha.2` | 未迁移 | 未发布 |
| [`packages/stream-guard`](packages/stream-guard) | `@t4r71/dsh-stream-guard` | `0.1.6-alpha.2` | 未迁移 | 未发布 |
| [`packages/idle-guard`](packages/idle-guard) | `@t4r71/dsh-idle-guard` | `0.1.6-alpha.2` | 未迁移 | 未发布 |

「面向 DSH」取该包 `package.json` 里 `peerDependencies` 钉住的版本，权威矩阵见 [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)。

**「未迁移」的含义**：源码从 `0.1.6-alpha.2` 的检出里搬过来并改了作用域，依赖已改为从 npm 解析，但**还没有针对 `0.1.7-rc.2` 做过接口适配，也没有在真机上装过**。不要把它们当作可用插件发布。

## 常用命令

```sh
pnpm install --ignore-scripts          # 装依赖（工作区根）
pnpm --filter @t4r71/dsh-dual-axis build
pnpm --filter @t4r71/dsh-dual-axis test
```

各包的 `build` / `test` / `typecheck` 脚本定义在各自的 `package.json` 里，不要用仓库级的 `-r` 全量构建去跑「未迁移」的包。

## 文档

- [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) — 插件 × DSH 版本矩阵，迁移动态记在这里
- [`docs/PUBLISHING.md`](docs/PUBLISHING.md) — 发布流程（含强制冷装冒烟）
- [`docs/BOUNDARIES.md`](docs/BOUNDARIES.md) — 已知边界与不修的窟窿
- [`docs/UPSTREAM-PATCHES.md`](docs/UPSTREAM-PATCHES.md) — 对上游 DSH 源码的补丁记录（补丁本身不在本仓）
- [`AGENTS.md`](AGENTS.md) — 仓库约定（人和代理都读这份）

## 与其它仓库的关系

| 仓库 | 关系 |
| --- | --- |
| [`T4R71/dsh-dual-axis`](https://github.com/T4R71/dsh-dual-axis) | 历史仓。`@t4r71/dsh-dual-axis` 与 `-ui` 的 **0.1.0** 发布于它。本仓是它的后继开发仓，0.1.0 之后的新版本一律从本仓发布 |
| `deepseek-ai/deepseek-harness` | 上游。本仓不 fork、不镜像、不 track，只按 `peerDependencies` 钉版本消费它的公开包 |

## 许可

MIT，见 [LICENSE](LICENSE)。

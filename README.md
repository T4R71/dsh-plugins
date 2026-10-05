# dsh-plugins

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件开发仓。一个插件一个目录，每个包独立版本、独立发布到 npm 的 `@t4r71` 作用域。

本仓只负责三件事：**插件索引**（本文件）、**构建与发布脚手架**（`scripts/`）、**发布流程**（`docs/PUBLISHING.md`）。本仓**不设仓级版本号，不打仓级 tag**——版本属于包，不属于仓。

## 包索引

| 目录 | 包名 | 面向 DSH | 状态 | npm |
| --- | --- | --- | --- | --- |
| [`packages/dual-axis`](packages/dual-axis) | `@t4r71/dsh-dual-axis` | `^0.2.0-rc.2`（11 条同值） | 已发布（**2026-09-30 迁到 0.2.0-rc.2**：11 条 dsh peer 由 `^0.1.7-rc.2` 抬到 `^0.2.0-rc.2`、devDeps 钉版改 `0.2.0-rc.2`；本轮 [S4](file:///M:/T4/out/stage3/evidence/S4) 复跑 `build` **EXIT 0**、单测 **117 / 117** EXIT 0；`typecheck` 的第 7 条既有错仍在 `tests/*.spec.ts`（本轮未修，见 [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)）；**真机冷装未重做**） | [0.1.1](https://www.npmjs.com/package/@t4r71/dsh-dual-axis)（本地 `0.1.2` **未发布**） |
| [`packages/dual-axis-ui`](packages/dual-axis-ui) | `@t4r71/dsh-dual-axis-ui` | `^0.2.0-rc.2`（16 条同值） | 已发布（**2026-09-30 迁到 0.2.0-rc.2**：16 条 dsh peer → `^0.2.0-rc.2`、devDeps 钉版改 `0.2.0-rc.2`；本轮 [S4](file:///M:/T4/out/stage3/evidence/S4) 复跑 `build` **EXIT 0**、单测 **54 / 54** EXIT 0；**本包没有 `typecheck` 脚本**；**真机冷装未重做**） | [0.1.1](https://www.npmjs.com/package/@t4r71/dsh-dual-axis-ui)（本地 `0.1.2` **未发布**） |
| [`packages/task-tree`](packages/task-tree) | `@t4r71/dsh-task-tree` | —（不直接依赖 DSH；devDeps 的 `dsh-app-boot` / `dsh-plugin-manager` 钉 `0.2.0-rc.2`） | 迁移完成待发布（组合包：插入 `plan-tree` + `plan-tree-sessions` + `task-tree-ui` + **`task`** 共**四行**，其中 `plan-tree` 一行带 `exposeTools: false` ⇒ **默认收口**，实测 20 工具 / `tools:sdk` 22,518 字符；单测 **1 / 1** 本轮（[S2](file:///M:/T4/out/stage3/evidence/S2)）复跑 EXIT 0；`build` EXIT 0。**四行形态的隔离 DSH_HOME 冷装**是 2026-09-29 在 0.1.7-rc.2 上跑的证据（`M:\T4\out\stage2\smoke2\runs\task-tree4-r2\verdict.txt`），**0.2.0-rc.2 上本轮未重做**。四行清单与工具面出处见 [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)「task-tree 的四行与「默认收口」」一节） | 未发布 |
| [`packages/task`](packages/task) | `@t4r71/dsh-task` | `^0.2.0-rc.2`（3 条同值） | **在用 desktop profile 已装载运行**（**2026-09-30 迁到 0.2.0-rc.2**：3 条 peer → `^0.2.0-rc.2`、devDeps 4 条钉版 → `0.2.0-rc.2`；本轮 [S3](file:///M:/T4/out/stage3/evidence/S3) `build` EXIT 0、单测 **21 / 21** EXIT 0（此前单测条数记录已作废）；`taskTree` 服务由 `plan-tree` 提供并一手验证——四端口方法、扁平进嵌套出、环拒绝、会话隔离、`replace=false` 合并；真机上 `plan` / `step` / `list scope:tree` 已实测（嵌套与状态正确）；`result` 的**结算回读**仍未验证——实测只回 `running`，与账本 `S23-result回读定因.md` 的时序定因一致） | 未发布 |
| [`packages/plan-tree`](packages/plan-tree) | `@t4r71/dsh-plan-tree` | `^0.2.0-rc.2`（2 条同值：`dsh-session` / `dsh-tools`） | 迁移完成待发布（**2026-09-30 迁到 0.2.0-rc.2**：2 条 peer → `^0.2.0-rc.2`、devDeps 5 条钉版 → `0.2.0-rc.2`；本轮 [S2](file:///M:/T4/out/stage3/evidence/S2) `build` EXIT 0、单测 **64 / 64** EXIT 0；**四个模型面工具**（`plan_write` / `plan_step` / `plan_dispatch` / `plan_ask`）由 `exposeTools` 键控制（**键默认 `true`**）；**对外提供 `taskTree` 服务**；`tests/verification/` 8 个 spec 未迁未跑（不在 test 脚本内）；隔离 DSH_HOME 冷装通过（2026-09-29，0.1.7-rc.2），面板的数据源是 `plan-tree-sessions` 这份**设置文档的共享镜像**。`packages/plan-tree/README.md` **已于 2026-09-29 重写**，见 `docs/COMPATIBILITY.md`「已知文档欠账」） | 未发布 |
| ~~`packages/ui-plan-tree`~~ | `@t4r71/dsh-ui-plan-tree` | — | 索引残留：该目录在盘上不存在 | — |
| [`packages/ui-task-tree`](packages/ui-task-tree) | `@t4r71/dsh-ui-task-tree` | `^0.2.0-rc.2`（6 条同值：六个 `dsh-client-*`） | 迁移完成待发布（**2026-09-30 迁到 0.2.0-rc.2**：6 条 peer → `^0.2.0-rc.2`、devDeps 8 条钉版 → `0.2.0-rc.2`；本轮 [S2](file:///M:/T4/out/stage3/evidence/S2) `build` EXIT 0、单测 **50 / 50** EXIT 0——**此前本行记的 57 / 57 已作废**，本轮 test 脚本含 `plan-tree-data` / `plan-tree-directory` 两个 spec；客户端 bundle 已被真机经 `/plugins` combo 路由服务出来；**面板在浏览器里实际渲染出 DOM 已由使用者在 live GUI 上目视确认**（2026-09-29，本条为使用者观察，非自动化取证）） | 未发布 |
| [`packages/guard`](packages/guard) | `@t4r71/dsh-guard` | `^0.2.0-rc.2`（3 条同值：`dsh-agent` / `dsh-llm` / `dsh-session`） | **合并形态**（**流式刹车 + 回合续写 + 自动重试**三合一，取代已删除的 `stream-guard` + `idle-guard`），**在用 desktop profile 已装载运行**；**2026-09-30 迁到 0.2.0-rc.2**（[S1](file:///M:/T4/out/stage3/evidence/S1)）：3 条 peer → `^0.2.0-rc.2`、devDeps 钉版 → `0.2.0-rc.2`、`tests/guard.spec.ts` 的类型错全修；`build` **EXIT 0**、`tsc -p tsconfig.test.json --noEmit` **EXIT 0（零诊断）**、单测 **12 / 12** EXIT 0（**guard 未继承两个旧包的测试**：旧包 237 / 13 个 test 未并入）；**隔离 DSH_HOME 冷装冒烟未做** | 未发布（registry 404 实测） |
| [`packages/prompt-plan`](packages/prompt-plan) | `@t4r71/dsh-prompt-plan` | `^0.2.0-rc.2`（五条 dsh peer 同值：`dsh-agent` / `dsh-llm` / `dsh-session` / `dsh-settings` / `dsh-system-prompt`） | **在用 desktop profile 已装载运行**（`mode: observe`）；**2026-09-30 迁到 0.2.0-rc.2**（[S3](file:///M:/T4/out/stage3/evidence/S3)）：5 条 peer → `^0.2.0-rc.2`、devDeps 5 条钉版 → `0.2.0-rc.2`、`build` EXIT 0（含删 `.tsbuildinfo` 后的强制全量复编）；包内**没有 `test` 脚本** ⇒ 单测列**无**，不声称任何一档。包内那套与 `@t4r71/dsh-guard` 重叠的守卫（`./guards` 子路径、`guards` 字段、`src/guards/**` 14 个文件）**已于 2026-09-29 删除** | 未发布（registry 404 实测） |
| [`packages/ask-panel-fix`](packages/ask-panel-fix) | `@t4r71/dsh-ask-panel-fix` | `@deepseek-ai/cordis` = `^4.0.4`（**无** `@deepseek-ai/dsh-*` peer） | 新增（2026-10-06）。**纯客户端**插件：宿主半边是空 `apply(){}`，全部逻辑在 `lib/client.js`——用 `MutationObserver` 把问答面板的卡片标上自带属性，再注入 2 条 CSS 把滚动容器从 `.body` 提级到卡片整体，修掉「正文一长就把选项挤出可见区」。不 fork 官方、不改 asar、不接管 slot。产物由 `build.mjs` 拼装并自带产物级断言（`vm.Script` 解析 + 无 `document` 沙箱里 `factory(require)` 物化 + CSS 与源码逐字反向比对）；`build` / `test` 本轮 **EXIT 0**。**「页面上真的修好了」本仓给不出**——需浏览器里正文超长时目视，本机无浏览器自动化 | 未发布 |

> **2026-09-30 迁移总览（0.1.7-rc.2 → 0.2.0-rc.2）**：本表所有仍存在的包的 `@deepseek-ai/dsh*` peer 已全部写成 `^0.2.0-rc.2`（逐包实测值见 `M:\T4\out\stage3\evidence\S5\peer-ledger.md`）；`packages/stream-guard` 与 `packages/idle-guard` 两个包**已删除**、功能并入 `packages/guard`。逐条迁移记录见 [`CHANGELOG.md`](CHANGELOG.md)。

「面向 DSH」取该包 `package.json` 里 `peerDependencies` 钉住的版本，权威矩阵见 [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)。该列**一格只装一个值**：包内多条同行锚的取值一致时缩写成一个（例如 `^0.2.0-rc.2` 代表该包所有 `@deepseek-ai/dsh-*` peer 的下界）；包内出现不同值时会在该行写全。`packages/task-tree` 没有 dsh peer，故写 `—`。

### 守卫系：`packages/guard` 是两个旧守卫的合并形态（旧包已于 2026-09-30 删除）

**取代关系（2026-09-29 取证，2026-09-30 落成删除）**

`@t4r71/dsh-guard` 是 `@t4r71/dsh-stream-guard` + `@t4r71/dsh-idle-guard` 的**合并形态**，是**流式刹车 + 回合续写 + 自动重试**三合一：
它把两者的监听器收进同一个 `apply`，共享一份 per-session 状态与一个边界令牌（包内自述：`packages/guard/src/index.ts:6-16`、`:877-895`）。

- **两个旧包已删除（2026-09-30）**：`packages/stream-guard` 与 `packages/idle-guard` 的目录、源码、`cordis.patch.yml` 与测试**已从仓里移除**（`git status` 为 ` D ` 行），功能由 `packages/guard` 吸收。**guard 未继承它们的测试**——guard 自己的 `tests/guard.spec.ts` 当前 12 个 test，旧包的 237（stream-guard）+ 13（idle-guard）个 test 未并入。改前原件备份在 [`M:\T4\out\stage3\backup\S1\deleted-guards`](file:///M:/T4/out/stage3/backup/S1/deleted-guards)（含 `MANIFEST.csv`）。本表因此不再有 `stream-guard` / `idle-guard` 两行。
- **同挂会重复注入（一手）**：`agent/turn-stopping` 是 serial 派发，两个旧包各自 `ctx.on()` 注册的监听器**都不返回 bail 值**，所以两个都跑到（`packages/guard/src/index.ts:881-887` 原文：「Neither returns a value, so cordis's serial dispatch never bailed and both ran on every boundary」）。而 guard 的去重**只在包内生效**——靠包内的 `injected` map + `boundary = turn:lastAssistantMessageId`（`packages/guard/src/index.ts:927-944`）。在用 profile 里逐字记着这一条：[`M:\DSH-T4\home\profiles\desktop\cordis.patch.yml:494-495`](file:///M:/DSH-T4/home/profiles/desktop/cordis.patch.yml)。**同挂两个旧包这件事现在从结构上不可能发生**（包已删除）。
- **在用的 desktop profile 只挂 `guard`（一手）**：同文件 `:505-510`（`id: guard` / `name: '@t4r71/dsh-guard'` / `receiptFile: M:/T4/out/guard/evidence/apply-receipt.log`）。该文件全文 grep `stream-guard|idle-guard` 只命中 `:494` 那一条**注释**，没有任何装载行。
- **它真的被装载过（一手）**：`M:\T4\out\guard\evidence\apply-receipt.log`，**25 行** `guard: apply`，时间跨度 `2026-09-29T03:47:48.404Z` → `2026-09-29T04:46:06.096Z`。

**`packages/dsh-prompt-plan` 是 Junction，不是第二个包（对旧描述的纠正）**

`packages/dsh-prompt-plan` 的 `LinkType = Junction`、`Target = M:\dsh-plugins\packages\prompt-plan`；它有 `package.json`，且与 `packages/prompt-plan/package.json` 的 SHA256 **逐字节相同**（两侧同为 `5B02C8D9F529D5387DAEF4EC1C526A93F7891081ADD4C502F0D27E7EF7037023`）。它是**同一个包的第二条路径**，因此**没有、也不该有自己的索引行**。风险：`git status --untracked-files=all` 会把同一批文件按第二条路径再列一遍，`git add -A` 有把同一份内容按两条路径加进索引的风险。

**prompt-plan 的守卫已删除（2026-09-29），仓库现在只有一份守卫实现（一手）**：`packages/prompt-plan` 里那套与 `@t4r71/dsh-guard` 重叠的守卫（`./guards` 子路径、`guards` 配置字段、`src/guards/**` 共 **14 个 .ts**）**已删除**，改前副本在 `M:\T4\out\stage2\guardpurge\backup\`；`cordis.patch.yml` 只 insert 一行 `prompt-plan`，`prompt-plan-guards` 这一行**从未存在**、`guards` 字段在任何在用 profile 里**零命中**，所以删除不触及在用行为（出处 `M:\T4\out\stage2\S17-删除重叠守卫.md`）。该包 README 里那两处守卫说明已随之重写（现 `packages/prompt-plan/README.md:273-293`）。

**两行 npm 列都写「未发布」，依据是 registry 实测（一手）**：2026-09-29 轮 `GET https://registry.npmjs.org/@t4r71/dsh-guard` → **404**、`GET .../@t4r71/dsh-prompt-plan` → **404**；对照 `.../@t4r71/dsh-dual-axis` → **200**（`dist-tags.latest = 0.1.1`）。**版本号大于 `0.1.0` 不构成「发布过」的证据**——`prompt-plan` 是 `0.1.2`，注册表上仍是 404。

### 已知显示取舍：面板把「失败」画成「受阻」（2026-09-29，用户裁决：接受并写进文档）

`@t4r71/dsh-task` 的状态词表是 `pending | in_progress | completed | failed`，
而 `@t4r71/dsh-plan-tree` 的是 `pending | in_progress | completed | blocked`——**它没有 `failed`**。
两者共用一个存储（`plan-tree-sessions` 命名空间的 `trees` 字段），而**两端遇到不认识的词都会丢弃整棵树**，
因此 `failed` 只能**存成** `blocked`，读出来再还原成 `failed`（见 `packages/plan-tree/src/task-tree.ts` 的模块注释）。

**后果**：`task` 工具自己报的状态是准确的 `failed`，但**右侧边栏面板只认四态，会把失败的任务画成「受阻」**。
**这是有意接受的不精确**，不是缺陷：要精确区分需同时改 `ui-task-tree`、`PlanNode.status` 与 `session-store` 的 `isStatus`，
收益不抵改动面。**看面板时请记住「受阻」可能意味着「失败」。**

**「未迁移」的含义（历史定义，2026-09-30 起本仓已无此档）**：源码从 `0.1.6-alpha.2` 的检出里搬过来并改了作用域，依赖已改为从 npm 解析，但**还没有针对目标版本做过接口适配，也没有在真机上装过**。本批 0.2.0-rc.2 迁移后，本仓所有在盘包都已迁到 `0.2.0-rc.2`，「未迁移」不再是任何在盘包的状态。

## 常用命令

```sh
pnpm install --ignore-scripts          # 装依赖（工作区根）
pnpm --filter @t4r71/dsh-dual-axis build
pnpm --filter @t4r71/dsh-dual-axis test
```

各包的 `build` / `test` / `typecheck` 脚本定义在各自的 `package.json` 里。

## 文档

- [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) — 插件 × DSH 版本矩阵，迁移动态记在这里；另含「task-tree 的四行与「默认收口」」「任务树数据链路」「已知文档欠账」三节
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

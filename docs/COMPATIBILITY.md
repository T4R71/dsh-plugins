# 兼容矩阵

一张表回答「这个包对着哪个 DeepSeek Harness」。**权威来源永远是该包自己的 `package.json` 的 `peerDependencies`**；本表是它的索引，改了 peer 锚必须同步改这里。

## 矩阵

| 包 | 目录 | 面向 DSH | 依赖解析 | 构建 | 单测 | 真机冷装 | 首次发布 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `@t4r71/dsh-dual-axis` | `packages/dual-axis` | `^0.1.7-rc.2`（11 条 dsh peer 全为范围同值；2026-09-29 由 S28 改，见下「peer 锚同步（2026-09-29，S28）」） | 通过 | `build` **EXIT 0**（本轮复跑）；`typecheck` **EXIT 1 / 7 条错**，全部落在 `tests/*.spec.ts`，且与本次 peer 锚改动**无关**——把 peer 改回精确值后同一条命令仍是同 7 条（一手 before/after 回显 `M:\T4\out\stage2\dualaxis-r2\before-after-typecheck.txt`） | **117 / 117**（本轮复跑，EXIT 0） | 未重做 | registry 0.1.0 / 0.1.1；本地 `0.1.2` **未发布** |
| `@t4r71/dsh-dual-axis-ui` | `packages/dual-axis-ui` | `^0.1.7-rc.2`（16 条 dsh peer 全为范围同值；2026-09-29 由 S28 改，见下「peer 锚同步（2026-09-29，S28）」） | 通过 | `build` **EXIT 0**（本轮复跑，`build` = `tsc -b tsconfig.json && tsdown`，含 src 全量类型检查）；**本包没有 `typecheck` 脚本**（`package.json:40-43` 只有 `build` / `test`），`pnpm --filter @t4r71/dsh-dual-axis-ui typecheck` → `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`，EXIT 1（原始回显 `M:\T4\out\stage2\dualaxis-r2\commands.txt`） | **54 / 54**（本轮复跑，EXIT 0） | 未重做 | registry 0.1.0 / 0.1.1；本地 `0.1.2` **未发布** |
| `@t4r71/dsh-task-tree` | `packages/task-tree` | —（不直接依赖 DSH） | 通过 | 通过（`build` + `typecheck` 对 0.1.7-rc.2 = 0） | **1 / 1** | 通过（隔离 DSH_HOME + 真机 0.1.7-rc.2 CLI：组合包被发现、补丁插入的**四行**进入组合树且无 `disabled`、客户端 bundle 经 `/plugins` combo 路由 HTTP 200 返回且内含本仓源码）。**该行的冷装回显原先是对「两行」形态做的；2026-09-29 已在四行形态上重跑通过**（隔离 `DSH_HOME` + 真机 0.1.7-rc.2 CLI，补丁 sha256 `9dbb71f852666d57…`）：`boot.ok=true`、`rows=188`、`counts={"disabled":31,"loaded":157}`、`allMatch=true`，四行逐行 `gate=no gate line`、`fiber=active`；其中三行 resolve 到本仓 `M:\dsh-plugins\packages\{plan-tree\lib\index.js, plan-tree\lib\session-store.js, task\lib\index.js, ui-task-tree\lib\index.js}`。另有一次「live desktop profile 组合 + 本组合包」的隔离复现：`rows` 由 192 增至 **196**、`disabled` 计数**仍是 31**（四行全 `loaded`，没有挤掉或新禁任何行）。工具面证据见下「task-tree 的四行与默认收口」 | — |
| `@t4r71/dsh-task` | `packages/task` | `^0.1.7-rc.2` | 通过 | 通过（`build` + `typecheck` 对 0.1.7-rc.2 = 0；静态三关已过） | **17 / 17** | **通过**（2026-09-29 首次真机装载：隔离 `DSH_HOME` 冷启四行形态，`task` 行 `loaded`、`gate=no gate line`、`fiber=active`，resolve 到 `M:\dsh-plugins\packages\task\lib\index.js`。**此前「从未启动任何 DSH 实例」的记载已作废。** 另有一手真机行为证据：`dispatch` 异步返回（程序结束前即返回 `status=running`，孩子的 LLM 请求在其后到达）、预设→persona 逐字生效、预设→toolFilter 经 `ToolArgsMap` 收窄、结算由运行时**推**进父会话。三处真机缺陷亦由本轮实测抓出并修复：出厂三预设 `restrict()` 抛未知工具名（组合包侧）、`dispatch` 不传 `bind` 抛 `value is not lossless JSON`、`wait` 挂满执行期限（已删）。**仍未证**：`result` 取回结算的 `completed` 态） | — |
| `@t4r71/dsh-plan-tree` | `packages/plan-tree` | `^0.1.7-rc.2` | 通过 | 通过（同上） | **64 / 64**（2026-09-29 协调者一手重跑：`pnpm --filter @t4r71/dsh-plan-tree test` → `EXIT=0`，`tests 64 / pass 64 / fail 0`；此前本格记的 39/39 已作废） | 通过（同一隔离 profile：`plan-tree` 与 `plan-tree-sessions` 两行均 `loaded`、`gate=no`；面板的数据源是 `plan-tree-sessions` 这份**设置文档的共享镜像**，不是会话投影。`tests/verification/` 的 8 个 spec 仍是 vitest 写法，未迁、未跑、已从 `typecheck` 排除） | — |
| `@t4r71/dsh-ui-plan-tree` | `packages/ui-plan-tree` | — | — | — | — | — | **索引残留：该目录在盘上不存在**（上游 0.1.6 已停用的包），待清理 |
| `@t4r71/dsh-ui-task-tree` | `packages/ui-task-tree` | `^0.1.7-rc.2` | 通过 | 通过（同上） | **57 / 57**（2026-09-29 协调者一手重跑：`pnpm --filter @t4r71/dsh-ui-task-tree test` → `EXIT=0`，`tests 57 / pass 57 / fail 0`；此前本格记的 50/50 已作废） | 通过（同一隔离 profile：`task-tree-ui` 行 `loaded`、`gate=no`；客户端 bundle 经 `/plugins` combo 路由 200）。**取数通道已于 2026-09-29 改为设置文档镜像**：旧的 `useProjection('planTree')` 已删除，改为 `ctx.configForms.describe()` 镜像 + `useSyncExternalStore`，三态渲染。**注意：这只证明 bundle 被服务出来，不证明浏览器里肉眼能看见树**。2026-09-29 追加：宿主写 → 设置文档 → Web 面权限内 `describe` **逐字节相等**、热更新事件 `settings/document-updated` 经 `/api/remote.mux` 的 `$events` 流到达客户端（两条独立探针）；**仍然没有**浏览器里 React 渲染成 DOM 的证据（当时本机无浏览器自动化；**2026-10-06 起这条限制已不存在**——Playwright MCP 可用，见 `packages/ask-panel-fix/README.md`「实测」那一手 A/B，本行结论未变、仍是「未证」）——详情与「未证」清单见下「任务树数据链路」 | — |
| `@t4r71/dsh-stream-guard` | `packages/stream-guard` | `^0.1.7-rc.2` | 通过 | 通过（`build` + `typecheck` 对已装的 0.1.6-alpha.2 = 0；把三条 dsh peer 的 `paths` 指向 store 里的 0.1.7-rc.2 后 `typecheck` 仍 = 0） | **237 / 237** | 通过（隔离 DSH_HOME 冷装，桌面副本 0.1.7-rc.2） | — |
| `@t4r71/dsh-idle-guard` | `packages/idle-guard` | `^0.1.7-rc.2` | 通过 | 通过（同上，两条路径都 = 0） | **13 / 13** | 通过（同一隔离 DSH_HOME，与 stream-guard 同挂） | — |
| `@t4r71/dsh-guard` | `packages/guard` | `^0.1.7-rc.2` | **未验证**（`pnpm-lock.yaml:160-195` 有完整 importer；本轮未跑 `pnpm install`，干净 checkout 上的安装从未做过） | **部分通过**：`build`（`tsc -b` + `tsdown`）在前序阶段 = EXIT 0（`M:\T4\out\guard\E-守卫插件.md:82`、`:87`，本轮未重跑）；**`tsc -p tsconfig.test.json --noEmit` = EXIT 2，23 条类型错全部在 `tests/guard.spec.ts`**（本轮实测，原始输出 `M:\T4\out\stage2\guardidx\guard-tsc-test.txt`） | **16 / 16**（本轮重跑 `node --import tsx/esm --test tests/guard.spec.ts` → `TEST_EXIT=0`，`tests 16 / pass 16 / fail 0`；输出 `M:\T4\out\stage2\guardidx\guard-test.txt`） | **未做**（**没有**隔离 DSH_HOME 冷装冒烟；它另有「在用 desktop profile 已装载运行」这一档证据，两者不是一回事，见下「守卫系两包入表」） | — |
| `@t4r71/dsh-prompt-plan` | `packages/prompt-plan` | `^0.1.7-rc.2`（五条 dsh peer 同值：`dsh-agent` / `dsh-llm` / `dsh-session` / `dsh-settings` / `dsh-system-prompt`）；2026-09-29 由协调者改（见下「peer 锚同步」第二条） | **未验证**（`pnpm-lock.yaml:277-311` 有 importer；本轮未跑 `pnpm install`） | **未验证**（本轮未为它跑过任何构建命令；前序阶段 `M:\T4\out\merge\A-守卫合并.md` 里那份 0.1.2 构建回显**不是本轮的证据**） | **无**（`package.json:28-31` 只有 `build` 与 `typecheck`，**没有 `test` 脚本**） | **未做**（无隔离冷装冒烟；但已在在用 profile 里以 `mode: observe` 装载运行，见下「守卫系两包入表」） | — |
| `@t4r71/dsh-ask-panel-fix` | `packages/ask-panel-fix` | `@deepseek-ai/cordis` = `^4.0.4`（**没有**任何 `@deepseek-ai/dsh-*` peer：它只操作 DOM，不接宿主服务面） | **通过**：`pnpm install --frozen-lockfile --ignore-scripts` **EXIT 0**（工作区 11 个项目；本包 `dependencies` 为空，`devDependencies` 只有一条 `@deepseek-ai/cordis@^4.0.4`，`pnpm-lock.yaml` 有 `packages/ask-panel-fix` importer） | **通过**：`pnpm build` **EXIT 0**（= `node build.mjs`）。这不是「tsc 通过」那一档——本包没有编译步骤，产物由脚本拼装，脚本自带**产物级**断言：`vm.Script` 解析、在**无 `module`/`exports`/`document`** 的沙箱里按真实 loader 约定 `factory(require)` 物化一次、内嵌 CSS 与源码逐字反向比对、选择器契约与红线（无哈希类名 / 无 `max-height` / 无 `!important`）逐条 | **通过**：`pnpm test` = `node build.mjs`，同一套断言，**EXIT 0**（产物内容一致时写盘为 `unchanged`，幂等） | **未做**（无隔离 `DSH_HOME` 冷装冒烟）。页面行为另有一手 A/B（见上方引用块「页面行为这一档已补上」） | 未发布 |

> **`@t4r71/dsh-ask-panel-fix` 这一行不是「构建通过」那一档**：它是一个**纯客户端**插件，宿主半边是空 `apply(){}`，全部逻辑在 `lib/client.js`（注入 CSS + 用 `MutationObserver` 给卡片打自带属性）。因此本表的构建格只记产物级那一档（产物按真实 loader 约定可物化 + 与官方三条 DOM 契约相符）。**页面行为这一档已补上**（2026-10-06，一手）：把产物注入本机正在运行的 GUI 页面，对**同一张真待答卡片**做「只切本插件 `style.disabled`」的 A/B，缺陷与修复都量到了数值——关插件时卡片 `overflow:hidden` 且内层滚动容器 `clientHeight` 塌成 **0**、最后选项超出卡片底边 175px 且最大可滚距离为 0（**够不到**）；开插件后卡片可滚 280px、滚到底最后选项落在卡片内（**够得到**）。三条契约与复核命令写在 `packages/ask-panel-fix/README.md` 的「依赖的官方契约」与「实测」两节。**仍未做**：本包尚未装配进 profile（`/plugins/??@t4r71/dsh-ask-panel-fix/client.js` 实测 404），所以「由宿主自然加载」与「真机冷装冒烟」两档都是空的（与 `ui-task-tree` 那一行同一个缺口，见「任务树数据链路」表最后一行）。

> **入表时顺带处理的一处工作区坑（2026-10-06，一手）**：新包若**只有 `peerDependencies`、`dependencies`/`devDependencies` 全空**，pnpm 12.5.1 会把它当作「不需要 importer」而不写进 `pnpm-lock.yaml`，于是 `pnpm install --frozen-lockfile` 以
> `ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER: pnpm-lock.yaml has no importers["packages/<名>"] entry` 退出 1——干净检出上的标准安装路径因此断掉（`rebuild-plugins.ps1` 本身用的是 `pnpm add`，不走 frozen，所以它不是这条的受害者）。
> 逐条排除过的无效手段（都在一个隔离的小工作区里复现，不改本仓）：反复 `pnpm install --lockfile-only`、`--force`、`--force --lockfile-only`、删 `node_modules/.modules.yaml`、删 `node_modules/.pnpm-workspace-state-v1.json`、`touch` 包清单 —— **全部不写 importer**；只有「给新包加一条真实的 `devDependencies`」才让它出现（对照：同一小工作区里 `packages/empty: {}` 空条目不写、`packages/withdep:` 写）。本包因此把 `@deepseek-ai/cordis` 同时写进 `peerDependencies` 与 `devDependencies`（与 `packages/mermaid-ui` 同一种写法）。

「依赖解析通过」= `pnpm install` 在工作区里退出码 0。**工作区规模已随包增减而变**（本节上面那句「10 包工作区 / `importers:` 下 10 个条目」是 2026-09-29 的快照，此后 `stream-guard` / `idle-guard` 两个包已删、`ask-panel-fix` 已加，**现已不是 10 个**）。这个「通过」记的是**那一次安装**的结果，不是对每一行的持续断言：本轮**没有**重跑 `pnpm install`，因此 `@t4r71/dsh-guard` 与 `@t4r71/dsh-prompt-plan` 两行的「依赖解析」写的是**未验证**。

「单测」列 = `pnpm --filter <包> test` 的通过数 / 总数；守卫包跑的是 `node --test`（见下「守卫包迁移进度」第 5 条）。**`ask-panel-fix` 那一行不是测试计数**——它的 `test` 脚本就是 `build.mjs` 的产物级断言，没有用例数这个概念。

### `@t4r71/dsh-task` 的「未做」是什么意思

新增于 2026-09-29（`packages/task/`）。该行的验证只到**静态三关**这一档：

- **做过的**：`build` / `typecheck` / `test` 三条命令对 0.1.7-rc.2 目标各自退出码 0，单测 17 passed / 0 failed。逐字命令与退出码存 `M:\T4\out\stage2\S7-task包入仓.md` §1 与 `M:\T4\out\stage2\evidence\task-package-commands.log`（两者都在本仓之外，是本次入仓会话的存档）。
- **没做的**（因此「真机冷装」列写「未做」而不是「通过」）：没有在真机上装载过、没有跑冷装冒烟、没有启动过任何 DSH 实例。按本仓 `AGENTS.md`「构建通过不等于能用」，静态可编译**不等于**插件能被 Loader 装上跑起来。
- **已知未联通**：`ask` 动作依赖的 `userQuestions` 服务在测试里是缺席路径；`dispatch` / `send` / `interrupt` / `result` 全在假 ctx 上测（`startContinuable` 返回写死的 `{childId}`、`sendMessage` 返回写死的 `'inbox-1'`），真实子代理运行时、真实 inbox、`subagent-settled` 投递都没被触碰。同一报告 §5 另记了一处**未改的语义偏差**：`output.schema` 里 `result` 的描述写的是「子代理收尾文本」，而实现带回的是整条 settle 通知的正文。

改这一节之前先读 S1 报告的 §4 / §5，那里列的是它对「没做」的完整清点。

## 两条必须知道的构建事实

### 1. CSS Module 的类名哈希由源码**绝对路径**派生

`dual-axis-ui` 打包时，CSS Module 的类名后缀是路径派生哈希。同一份源码放在不同目录下构建，产物**不是逐字节相同的**：

| 构建位置 | 类名后缀 | `lib/client.js` sha256 前 12 |
| --- | --- | --- |
| `M:\T4\out\release\dsh-dual-axis` | `_9vJ8OG_` | `C3D0AD138103`（= 已发布的 0.1.0 产物） |
| `M:\dsh-plugins` | `_3QVNGW_` | `E5922A8998E3` |

两者除这些不透明类名外**内容一致**（3401 行全部对齐，差异仅出现在 `//#region \0t4-css:<路径>` 与类名表）。含义：**搬家之后不能再声称产物与已冒烟的那份逐字节相同**，升级版本前要重做一次真机冷装。

### 2. 宿主包的单测需要 `TSX_TSCONFIG_PATH`

`@deepseek-ai/dsh-settings` 发行了 `lib/types/schema.js`，但 exports map 里**没有** `./schema` 子路径。`packages/dual-axis/tests/settings.spec.ts` 与 `tests/session-store.spec.ts` 依赖它，靠 `tsconfig.runtime.json` 里的映射绕开。`test` 脚本必须带 `cross-env TSX_TSCONFIG_PATH=tsconfig.runtime.json`——**本仓重组前这个脚本是漏的，两个 spec 因此跑不起来**（旧仓同样跑不起来，不是搬家造成的）。

## 「未迁移」是什么意思

源码从 `0.1.6-alpha.2` 的检出搬来，做了四件事：

1. 作用域从 `@deepseek-ai` 改到 `@t4r71`（含 `cordis.patch.yml` 与源码里的交叉引用）；
2. `workspace:^` 依赖改写成各自在 npm 上的具体版本（`@deepseek-ai/dsh-*` → `0.1.6-alpha.2`，`cordis` → `^4.0.4`，`schemastery` → `^3.18.4`）；兄弟包之间保留 `workspace:^`；
3. 通配的 peer 锚（`*`）钉成精确版本 —— 不钉的话会拉到 latest 的传递依赖 `@deepseek-ai/dsh-type-meta`，而那个包在 npm 上不存在（404）；
4. 版本统一为 `0.1.0`，补 `publishConfig.access=public` 与带 `directory` 的 `repository`。

**没有做的**：没有针对 `0.1.7-rc.2` 做接口适配，没有跑过构建，没有在真机上装过。

## 迁移到 0.1.7-rc.2 的已知障碍

来自 0.1.6 检出与 0.1.7-rc.2 干净检出的对拍（词边界 grep 计数）。**「0 命中」是必要不充分证据**——符号可能只是改了名，仍需逐个源码确认：

| 被砍掉的接缝 | 0.1.6 侧命中 | 0.1.7 侧命中 |
| --- | --- | --- |
| `AxisScope` | 105 | 0 |
| `settingsScope` | 80 | 0 |
| `DEFAULT_READ_SCOPE` / `axisValues` / `readKind` / `parseCustomScope` | 非 0 | 0 |

另外两条搬迁前就存在的未声明跨包 import，迁移时要一起处理：

- `packages/plan-tree` 的源码 import 了 `@deepseek-ai/dsh-interaction-user-questions`，但**未在 `package.json` 里声明**，且该包在 npm 上不存在。
- `packages/idle-guard` 的源码引用了 `@t4r71/dsh-stream-guard`，同样**未声明**。
  （2026-09-28 复核：现有 `src/` 与 `tests/` 里**已无**该 import——`packages/idle-guard/src/index.ts` 的全部 import 只有 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-agent`（类型）、`@deepseek-ai/dsh-session`（类型）、`@deepseek-ai/dsh-llm` 与两个同目录相对模块；只有 JSDoc 文字提到 stream-guard。此条对 idle-guard 应视为已消失；`packages/plan-tree` 那条未复核。）

## 守卫包迁移进度（G1，2026-09-28）——**历史记录，结论已被下方 G2/G3 一节取代**

只记实际做过的。**这一节不是「已验证」**：两个包都没有在 0.1.7-rc.2 真机上装过。

### 做了什么

1. **peer 锚从精确版本改成范围**。`@deepseek-ai/dsh-agent` / `dsh-llm` / `dsh-session` 由 `0.1.6-alpha.2` 改成 `^0.1.6-alpha.2`。
   理由：桌面运行时的兼容判定是 `semver.satisfies(runtime, requirement, { includePrerelease: true })`，**精确版本号不是范围**，对运行中的 0.1.7-rc.2 判 false。
   实测（仓库内 `semver@7.8.5`，`includePrerelease: true`，runtime = `0.1.7-rc.2`）：`0.1.6-alpha.2` → false；`^0.1.6-alpha.2` → true；`0.1.7-rc.2` → true。
   下界取 0.1.6 而不是 0.1.7：源码是 0.1.6 的 API 表面，G2 还没做适配，写 0.1.7 会谎报适配完成。
   `@deepseek-ai/cordis` 的 `^4.0.4` 未动。
2. **补 `dsh.bundle.patch` 声明**（两个包此前 `dsh` 字段缺失），各自新增 `cordis.patch.yml`，只插入本包一行：
   `stream-guard` → `@t4r71/dsh-stream-guard`；`idle-guard` → `@t4r71/dsh-idle-guard`。
   没有这一行就不是 bundle，无法进 profile 的 `dsh.profile.bundles`。
3. **补构建链**。此前两个包的 `scripts` 为空、且 `tsconfig.json` 指向仓库里不存在的 `../../../tsconfig.base.json` 与 `vendor/`、`core/`、`llm/` 工程引用（那些路径属于 0.1.6-alpha.2 的检出）。
   现在与 `packages/dual-axis` 同一套：包内 `tsconfig.base.json` + `tsconfig.json`（`rootDir: src`、`outDir: lib/types`）+ `tsconfig.test.json` + 包内 `tsdown.config.ts`；`scripts` 补 `build` / `typecheck`；`exports` 与 `files` 补 `./cordis.patch.yml`。
   之后跑了 `pnpm install --ignore-scripts`：**`pnpm-lock.yaml` 逐字节未变**（实测 `Compare-Object` 判定 IDENTICAL，273,496 B / mtime 未动），因为那四个 devDependency 本来就在锁文件里——锁文件是新鲜的，只是包清单里没写。落盘后 `packages/{stream-guard,idle-guard}/node_modules` 出现 `typescript` / `tsdown` / `tsx` / `@types/node` 与对应 `.bin`。
4. **构建 / 类型检查 / 单测全部实测通过**（跑的是包自己的脚本，不再是「借 store 里的工具临时跑通」）：
   - `pnpm --filter @t4r71/dsh-stream-guard build` 与 `pnpm --filter @t4r71/dsh-idle-guard build`：两个包 `EXIT=0`，产出 `lib/index.js` 56,128 B / 8,601 B，无哈希命名共享 chunk。
   - `typecheck`（`tsc -b && tsc -p tsconfig.test.json --noEmit`，与 dual-axis 同形）：两个包 `EXIT=0`。
   - `test`：**stream-guard 237 / 237 通过，idle-guard 13 / 13 通过**，退出码均为 0。
5. **单测从 vitest 迁到 `node --test`**（本仓没有 vitest；dual-axis 也用 `node --test`）。10 个 spec、305 处断言机械改写，`it.each` 展开成 for 循环里的 `it()`（测试数因此略有增加）。断言映射：`toBe`→`assert.strictEqual`、`toEqual` / `toStrictEqual`→`assert.deepStrictEqual`、`toContain`→`includes` 包裹、`toHaveLength`→`length` 比较、`.not.X`→对应的否定形式；`expect(v, msg)` 的第二个参数搬进 `node:assert` 的 message 槽（11 处），没有静默丢弃。
   连带结清两笔旧账：
   - `tests/verification/` 下 25 个脚本（含 4 份 .md 台账）**已删除**：它们 import 的 `src/prefix.ts` 与 `src/filler.ts` 在搬迁后的 `src/` 里不存在，且它们从来不是测试运行器的一部分。删除可逆（此前已被 git 跟踪，见 `git status` 的 ` D ` 行）。
   - `MockAdapter` / `textResponse` 夹具原本 import `'../../../core/agent-loop/tests/mock-adapter.ts'`——那是 0.1.6-alpha.2 检出里的路径，本仓没有 `core/`；而该夹具**没有随 npm 包发布**（`@deepseek-ai/dsh-agent-loop` 的 exports 只有 `.` 与 `./invariant`）。现在两包各有一份 `tests/mock-adapter.ts`（上游 136 行逐字副本，文件头注明来历），3 个受影响 spec 的 import 改成 `./mock-adapter.ts`。
   单测跑的是 **`lib/index.js` 构建产物**而不是 `src/`：spec 用包名 `@t4r71/dsh-stream-guard` import，经包自己的 `exports` 解析到 `lib/index.js`（内部模块仍走相对路径），所以这 250 个测试同时也是产物可加载性的证据。

### 没做的 / 卡在哪

上面这段写于 G1。其中「0.1.7-rc.2 类型没验过」与「真机装载没做」两条**已在 G2 / G3 结清**（见下一节）；「`agent/turn-stopping` 顺序语义」只做到静态结论 + 两包同时被导入的真机证据，**没有做到端到端的事件顺序观测**。

另：G1 记的产物尺寸 `56,128 B / 8,601 B` 是 G1 当时的产物。G2 改了源码（各自 `declare module` 声明消息来源 kind），产物已变，见下一节。

## 守卫包迁移进度（G2 / G3，2026-09-28）——**当前状态**

### 版本锚（已裁决）

两个包的 `@deepseek-ai/dsh-agent` / `dsh-llm` / `dsh-session` 三条 peer 下界由 `^0.1.6-alpha.2` 抬到 **`^0.1.7-rc.2`**；`@deepseek-ai/cordis` 的 `^4.0.4` 未动。裁决理由：**只声明实际验证过的版本**。实测该下界在 0.1.7-rc.2 桌面运行时里被判 true（见下「真机装载」）。

### 0.1.7-rc.2 接口适配（G2）

契约层只有 1 处真不兼容：0.1.7 删掉了 plugin 消息来源的共享 catch-all `kind`。修法是各自 `declare module '@deepseek-ai/dsh-llm'` 增强 `MessageSourceMap` 并声明自己的 kind（`stream-guard` / `idle-guard`）。

**0.1.7 类型下的类型检查（G3 补测）**：把三条 dsh peer 的 `paths` 指向 pnpm store 里的 `0.1.7-rc.2` 目录后跑 `tsc`——
- `idle-guard`：`src` + `tests` 全量 `EXIT=0`。
- `stream-guard`：修掉 `tests/guard-branches.spec.ts` 的 2 处 `'tool-result'` 夹具后 `EXIT=0`（修法见下）。

注意：这只证明**类型面**兼容。仓库里装的仍然是 `0.1.6-alpha.2` 的类型，日常 `pnpm typecheck` 走的还是那一套。

### `'tool-result'` 夹具（G3）

`0.1.7-rc.2` 的 `ContentBlockMap` 删掉了 `'tool-result'`（`dsh-llm` `lib/types/types.d.ts:114-122`）；`0.1.6-alpha.2` 里它在（同文件 `:104-111`）。`tests/guard-branches.spec.ts` 的「deferring a brake」夹具借它当「typed-but-unknown 块」，于是随运行时的块词汇表一起失效。

处置：**不删用例、不改断言**，改用在测试文件里 `declare module` 合并出来的 `'guard-test-unknown'` 块类型。该接口在两个版本里都是 merge-extensible，所以夹具从此与运行时的块词汇表解耦，测的还是守卫的 fall-through（`src/index.ts:437`、`:504`、`:548-552` 的 `'other'` 分支）。断言原样保留：`published(emitted) === FILLER_RUN`、`braked(emitted, upstream) === false`。

### 构建产物

| 包 | `lib/index.js` 字节 | sha256 |
| --- | --- | --- |
| `stream-guard` | 56,136 | `a6e025b803fe8e59040fbf2254209fba306cf0f58bd18a892798527e9c37b9e8` |
| `idle-guard` | 8,576 | `55d76a7f689bb707431fa6a5a0670d10c5c04ff45256f4b6d7f246b4c966aa62` |

### 单测（G3 复核）

`pnpm --filter @t4r71/dsh-stream-guard test` → **237 pass / 0 fail**，退出码 0。
`pnpm --filter @t4r71/dsh-idle-guard test` → **13 pass / 0 fail**，退出码 0。

**这两条命令现在能跑**，G1 记的 237 / 13 属实。此前「单测跑不动」的说法来自从**仓库根**直接调 `node --import tsx/esm --test …`：根 `node_modules` 里没有 `tsx`（没有 `.bin`、没有链接），于是 `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'`。走 `pnpm --filter` 时 cwd 是包目录，`tsx` 从包自己的 `node_modules` 解析，正常。`@deepseek-ai/dsh-agent-loop` 与 `dsh-agent-loop-testkit` 确实仍是 `0.1.6-alpha.2`，**但它们不是阻塞项**——spec 能 import 到、也能跑通。

### 真机装载（G3，隔离 DSH_HOME）

隔离目录（不复用 `M:\DSH-T4` 的任何路径）：

| 用途 | 路径 |
| --- | --- |
| `DSH_HOME` | `M:\T4\out\cold-install\home` |
| `--user-data-dir` | `M:\T4\out\cold-install\userdata` |
| profile | `home\profiles\desktop`（两个包装在 `node_modules\@t4r71\` 下，`cordis.patch.yml` 用两个独立 `insert` 项挂载） |
| 日志 | `M:\T4\out\cold-install\logs` |

桌面副本版本 `0.1.7-rc.2`（`resources\runtime\primary-runtime\runtime.json`）。两包**被真实导入**（`lib/index.js` 的 NTFS last-access time 在启动后 3 秒内推进），无误加载、无报错。`M:\DSH-T4` 全程零改写（实测「22:20 之后被改动的文件 = 无」）。

**静默禁用陷阱**：桌面副本**不会**把兼容性拒绝写到被重定向的 stdout/stderr——把两个包的 peer 故意钉成不匹配的精确 `0.1.6-alpha.2` 后，stderr 仍是 0 字节。同一 profile 换到 `dsh` CLI（同为 0.1.7-rc.2）才打印出拒绝行，原文是
`dsh: disabling profile plugin row "<id>": Plugin <name>@<version> is incompatible with dsh 0.1.7-rc.2: peerDependencies {…}. Running it may cause crashes or data loss. … Exact-version exemption: not active.`
**所以「stderr 干净」在桌面副本上不构成「未被禁用」的证据**；判据要用「模块是否真的被导入」这种行为差分。

### 还没做的

- **两包同挂 `agent/turn-stopping` 的端到端事件顺序没观测**：只做到静态结论 + 两包在同一 profile 同一运行时里同时被导入、无冲突报错。谁先跑、两次 `steer` 的落点，需要驱动一次真实模型回合才能看。
- **隔离 profile 没有配模型 provider**，所以冷装验证里没有任何真实回合。
- **`dsh-agent-loop` / `dsh-agent-loop-testkit` 没有 `0.1.7-rc.2` 版本**（本机 pnpm store 里 6 个变体全是 `0.1.6-alpha.2`），所以单测只能在 0.1.6 的 agent-loop 上跑。

## peer 锚同步（2026-09-29，R2 侧改动）——**「面向 DSH」列的取值口径**

`packages/plan-tree` 与 `packages/ui-task-tree` 的 DSH peer 锚**已由精确版本改成范围**，这是 `AGENTS.md`「兼容矩阵的更新义务」第 1 条点名必须同步本表的改动。本表与根 `README.md` 的「面向 DSH」列因此按新值改写。

**2026-09-29 追加第二条（`packages/prompt-plan`）**：

- `@deepseek-ai/dsh-settings` 与 `@deepseek-ai/dsh-system-prompt` 两条由**精确** `0.1.7-rc.2` 改成**范围** `^0.1.7-rc.2`（改后与包内其余三条 dsh peer 同值），因此矩阵里那一格由「混合锚」改成 `^0.1.7-rc.2`，「守卫系两包入表」表里的「混合锚」一行同步更正。
- **devDependencies 里的精确值是有意保留的**：全仓约定如此（对照 `packages/prompt-plan/package.json:58-70`）。本表只对 `peerDependencies` 给值，这条不构成违规，**不要**把它读成 `AGENTS.md` 的违反项。
- 该包**未发布**（registry 404 实测），所以这次改锚不需要抬版本号。
- **改后全仓复核**：当时仅剩的精确 peer 是 `packages/dual-axis`（11 条）与 `packages/dual-axis-ui`（16 条），两者都已发布（`0.1.0` / `0.1.1`）——修它们必须升版重发。**2026-09-29 这 27 条已由 S28 改成 `^0.1.7-rc.2`，两包版本抬到 `0.1.2`（未发布）**，见下「peer 锚同步（2026-09-29，S28）」；全仓现在有 **0 条**精确 dsh peer。本条原指向的「已知欠账」一节已随之改写为「已结清」。
- 逐字复核（本次现场实读）：`packages/prompt-plan/package.json` 的 `peerDependencies`（`:49-57`）共 7 条，其中 5 条 `@deepseek-ai/dsh-*` 全为 `^0.1.7-rc.2`，`@deepseek-ai/cordis` = `^4.0.4`、`@deepseek-ai/schemastery` = `^3.18.4`；`packages/dual-axis/package.json`（peerDependencies `:66-80`，14 条中 11 条精确）与 `packages/dual-axis-ui/package.json`（peerDependencies `:61-78`，17 条中 16 条精确）里的 dsh peer 逐条仍是精确 `0.1.7-rc.2`。
- 简报与本次改动记录：`M:\T4\out\stage2\ledger\prompts\S15.md` 第 2 条。该简报给出的「改后 2055 字节、sha256 前 16 位 `afcfea78dac143ad`」**本次未复算**，故只在此处标出路径与性质，不当一手回显引用。

| 包 | 改动后的 `peerDependencies`（逐字抄自各自的 `package.json`，本轮实测读取） | 改动前 |
| --- | --- | --- |
| `@t4r71/dsh-plan-tree` | `@deepseek-ai/cordis` = `^4.0.4`；`@deepseek-ai/dsh-session` = `^0.1.7-rc.2`；`@deepseek-ai/dsh-tools` = `^0.1.7-rc.2` | 三条 dsh peer 是精确 `0.1.7-rc.2`（改前本表「面向 DSH」列与根 `README.md` 记的都是这个值） |
| `@t4r71/dsh-ui-task-tree` | `@deepseek-ai/cordis` = `^4.0.4`；`dsh-client-locale` / `dsh-client-store` / `dsh-client-ui-primitives` / `dsh-client-ui-settings` / `dsh-client-ui-sidebar-right` / `dsh-client-ui-slots` 六条 = `^0.1.7-rc.2` | 六条 dsh-client peer 是精确 `0.1.7-rc.2`（改前本表「面向 DSH」列与根 `README.md` 记的都是这个值） |

**本次同步只改「面向 DSH」列，没改验证列。** 这两行的「依赖解析 / 构建 / 单测 / 真机冷装」四列仍是改动前记录的那次实测结果；本轮**没有**为它们重跑任何一条命令。理由：peer 锚改成范围在语义上确实扩大了可装载的运行版本集合，而**「装了能跑」必须靠真机装载证明**（`AGENTS.md`「构建通过不等于能用」），本表没有这一轮的冷装证据，所以不往上写。

依据（一手，均为本地文件）：

- `packages/plan-tree/package.json` 的 `peerDependencies`（该文件 mtime 2026-09-29 14:23:04，晚于本文件上一次写入的 14:05:34——即文档当时确实落后于包清单）。
- `packages/ui-task-tree/package.json` 的 `peerDependencies`（mtime 2026-09-29 14:18:25，同样晚于本文件）。
- 口径说明：本表「面向 DSH」列**一格只能装一个值**；上面两个包改前是精确版本、改后是范围，且包内多条 peer 的值一致。若某包内部出现不同值（一部分精确、一部分范围），该列会被拆成多行说明。

## peer 锚同步（2026-09-29，S28）：dual-axis 两包的 27 条精确 peer → 范围

`packages/dual-axis`（11 条）与 `packages/dual-axis-ui`（16 条）的 dsh `peerDependencies` **原本全部是精确版本** `0.1.7-rc.2`（合计 **27 条**；逐条现值、包名与所在行号见 `M:\T4\out\stage2\dualaxis-r2\REPORT.md` §1）。本次改动把这 27 条全部改成 `^0.1.7-rc.2`；改后两包的精确 dsh peer 计数均为 **0**（`ConvertFrom-Json` 逐条复核，回显在 `M:\T4\out\stage2\dualaxis-r2\commands.txt`）。

**下界取 `^0.1.7-rc.2` 的依据（一手）**

1. 两包的 `devDependencies` 钉的是 `0.1.7-rc.2`，且本机 `node_modules` 里这 27 条 peer 对应的包**逐条实测版本都是 `0.1.7-rc.2`**（读 `packages/<包>/node_modules/@deepseek-ai/<peer>/package.json` 的 `version`；27/27 命中，无一缺失，清单见 S28 REPORT §4）。
2. `build`（`tsc -b tsconfig.json && tsdown`）改动后 **EXIT 0**：源码表层对装着的 0.1.7-rc.2 类型检查通过。`dual-axis` 另有单测 **117 / 117**（EXIT 0）、`dual-axis-ui` **54 / 54**（EXIT 0），均为改动后本轮复跑。
3. 两包源码里带版本语义的适配都指向 0.1.7，不是 0.1.6：`packages/dual-axis/src/session-axes.ts:5-24`（「0.1.6 carried both axes on the `sandbox/mode` event … 0.1.7 的 payload 锁成 `{ mode, source }`」）、`packages/dual-axis/src/axis.ts:143`（「0.1.7's `SandboxExecutionPolicy` has no `readScope` / `writeScope`」）、`packages/dual-axis/README.md:54-63`（专节 "What 0.1.7 removed, and what this package carries instead"，逐条列 0.1.6 的家 vs 0.1.7 的现状）。

**为什么不写更低**：源码已按 0.1.7 的接口面改写（上条第 3 点），下界写到 0.1.6 就是谎报适配完成（`AGENTS.md`「版本与 peer 锚」）。
**为什么不写更高**：这两包只声明到 `0.1.7-rc.2` 这一条已验证线，没有任何面向更高运行版本的适配证据。

**版本**：两包 `package.json` 的 `version` 由 `0.1.0` 抬到 **`0.1.2`**（patch 档）。依据：本次只把「能被装载的运行版本集合」由 1 个版本扩到 0.1.7 线的一整个范围，包的对外 API、工具面、行为都没变，属**修正装载期误判**的修复 ⇒ patch；且 registry 上 `0.1.0` 与 `0.1.1` 都已存在（`dist-tags.latest = 0.1.1`），本地清单里那个 `0.1.0` 是**落后于 registry 的旧值**——原样发布会被 registry 以「版本已存在」拒收，所以下一个可发布版本就是 `0.1.2`。

**未做**：真机冷装（隔离 `DSH_HOME` + 真机 0.1.7-rc.2）。本表这两行的「真机冷装」列因此仍写「未重做」，不得改写为通过——peer 锚改动的语义后果是「可装载集合变大」，它必须由真机装载证明，本轮没有做。

**本次未动的两条**：`@deepseek-ai/cordis`（两包均 `^4.0.4`）与 `@deepseek-ai/schemastery`（`^3.18.4`）、`zod`（`^4.4.3`）——它们本来就是范围，且前两条的版本线独立于 DSH。

## task-tree 的四行与「默认收口」（2026-09-29）

`packages/task-tree/cordis.patch.yml` 的 `insert` 现在插**四行**（同一组合包声明，插件页只出现一个条目）：

| # | 行 id | 包 | 该行携带的配置 |
| --- | --- | --- | --- |
| 1 | `plan-tree` | `@t4r71/dsh-plan-tree` | `exposeTools: false`（组合包**默认收口**） |
| 2 | `plan-tree-sessions` | `@t4r71/dsh-plan-tree/session-store` | 无（树的权威存储，id 即设置命名空间） |
| 3 | `task-tree-ui` | `@t4r71/dsh-ui-task-tree` | 无（浏览器半边） |
| 4 | `task` | `@t4r71/dsh-task` | `provider: spawn` + 三个预设 `recon` / `impl` / `verify` |

一手：`packages/task-tree/cordis.patch.yml:6-90`（四行逐行可读；行序要求见同文件 `:40-51` 的注释——`task` 必须排在 `plan-tree` 之后，因为它经 `ctx.get('taskTree')` 取前两行建立的那一份）。

**「默认收口」是什么意思**：`plan-tree` 那一行带 `config.exposeTools: false` ⇒ 挂上本组合包**默认**只给收口后的工具面，四个 `plan_*` 工具默认不在。

- **实测值**：**20 个工具 / `tools:sdk` 22,518 字符**（收口前 28 工具；九件旧工具 0/9 在面上，`task` 在）——出处 `M:\T4\out\stage2\S13-收口落地.md` §2 的态 C 与态 E 两行、§3 的 20 工具计数行、以及 §4 对 22,518 / 22,489 两个数的口径说明。**本表未复算这两个数**，只引用该报告的实测。
- **拿回四个工具**：在自己 profile 层写 `- id: plan-tree` + `config.exposeTools: true`（`packages/task-tree/cordis.patch.yml:21`）。`exposeTools: false` **不会**摘掉 `taskTree` 服务（`packages/plan-tree/src/index.ts:667-682`：`ctx.provide('taskTree', ...)` 在开关之外），因为第 4 行 `task` 正是靠这个服务读同一棵树。
- **键的默认值**：`exposeTools` 的默认是 **`true`**（`packages/plan-tree/src/index.ts:654`：`const exposeTools = config.exposeTools ?? true`）——即**不写这个键就是四个工具都在**；「默认收口」是**组合包那一行写了 `false`** 的结果，不是键的默认值。`packages/plan-tree/README.md` 现有这个键的说明（`exposeTools` 一节；该文件 2026-09-29 重写，见下方「已知文档欠账」）。
- 该包单测从 **59 涨到 64**（`tests 64 / pass 64 / fail 0`），**一条原有断言没删**——出处 `M:\T4\out\stage2\S13-收口落地.md` §1 与 §1 后的「测试基线守住了」段。
- `task` 这一段链路的服务面证据（`ctx.get('taskTree')` 四端口方法、扁平进嵌套出、环拒绝、会话隔离）见根 `README.md` 的 `packages/task` 行所引的协调者一手验证。

## 任务树数据链路（2026-09-29，`M:\T4\out\stage2\S18-任务树数据链路.md`）

**链路**：宿主写树 → 落盘到 profile 的**设置文档**（命名空间 `plan-tree-sessions`，字段 `trees`）→ 经 `/api` 设置镜像由 Web 面读回 → **与宿主写进去的逐字节相等**。

| 环节 | 档位 | 一手载体 |
| --- | --- | --- |
| 宿主读写逐字节相等 | **一手** | `byteCompare.equal=true`（该报告 §3；`{"equal": true, "byteLengthHost": 469, "byteLengthDocument": 469}`） |
| 落到设置文档（`describe` 取回原文） | **一手** | 该报告 §3 第 3 步，`treesRawText` 结尾与独立重编码的期望串逐字节相等（`canonicalEncode.suffixMatches = true`） |
| Web 面读回与宿主逐字节相等 | **一手** | `webCompare.rawFieldEqual / mainTreeEqual = true`（该报告 §5；`session-alpha` 469 字节、`session-beta` 134 字节） |
| 热更新事件到达客户端 | **一手**（出自 `S11` / `panel-proof` 那两条探针，**不是** `S18`） | `settings/document-updated` 经 `/api/remote.mux` 的 `$events` 流到达客户端：`M:\T4\out\stage2\S11-任务树数据链路证明.md:278-290`（`{"dir":"in","kind":"emit","event":"settings/document-updated","args":["plan-tree-sessions",1]}`）；独立复核 `M:\T4\out\stage2\panel-proof\runs\ws-events\verdict.txt`（`探针：PASS 收到 settings/document-updated`、`event=settings/document-updated args=["plan-tree-sessions",1]`）。转发白名单本身：上游 `dsh-api-remotes\lib\types\remote-events.js:37`（转引 `M:\T4\out\stage2\R1-官方数据通道.md:148`）。**`S18` 报告里没有这条事件的回显**，本节不再把它记在 `S18` 名下 |
| 阴性对照：坏数据不抛错、不连坐别的会话 | **一手** | 该报告 §5：`badSessionRead.threw = null`、`recordsKeys = ["session-alpha","session-beta"]`、别会话 `equalToWritten = true`；客户端侧 `brokenDropped = true` |
| **浏览器里 React 真的把树渲染成 DOM** | **未证** | 该报告 §7 与「面板真的把这块 DOM 画出来」一行都写「没做到」。**任何「面板已经能看见」的说法都不能引本表，本表不给这一档**。机制层面的障碍已于 2026-10-06 消失（Playwright MCP 可用、并用它在真 GUI 上验过 `ask-panel-fix` 的页面行为），但 **task-tree 这条路本身仍未在任何浏览器里被看过**——障碍没了不等于证据有了 |

**答案字段契约（S14 已修，2026-09-29）**：宿主把 `plan_ask` 的答案写进 **`answer` 字段**，而客户端原先从 `detail` 的「答：」前缀里找、且解码器把 `answer` 丢掉 ⇒ 面板上永远没有答案。修法是**客户端改**：`answer` 字段优先、前缀只作向后兼容回落。依据：`M:\T4\out\stage2\S19-答案字段契约.md`（§1 改动清单、§2.2 计数行 `tests 57 / pass 57 / fail 0`、§3 新增 7 条断言、§5「我不能证明的事」）。**该报告的浏览器面同样未证**（§5 第 1 条），与上表最后一行同一口径。

## 已知文档欠账（2026-09-29 备案；同日 S27 结清）

**本节原记的两条欠账都已在 2026-09-29 的重写里结清。** 结清内容与本次清点**新发现**的欠账一并留档如下。

- `packages/plan-tree/README.md`（157 行）**落后于包现状**：它仍写「Mounting the package adds **two** tools」与「The tree lives on the session log and folds into a `planTree` projection」，而包现在（i）提供**四个**模型面工具（`plan_write` / `plan_step` / `plan_dispatch` / `plan_ask`）、（ii）数据落在 `plan-tree-sessions` 这份**设置文档**里、（iii）对外提供 `taskTree` 服务、（iv）有 `exposeTools` 键。该文件已于 2026-09-29 **重写**（188 行；中文对照 `README.zh.md` 同批重写为 105 行，`README.i18n.yaml` 的两个 blob hash 已按 `git hash-object` 重录）：现内容写的是四个工具及其参数与返回、`plan-tree-sessions` 这份设置文档存储、`taskTree` 服务与 `exposeTools` 键，上面两处旧说法均已不存在。**重写后的 `README.md` 里那句「本包声明中没有 `dsh` 字段」的推论（列进 `dsh.profile.bundles` 是否会生效）仍未实测**，属推断。
- 缺 README 的包**不是四个，是五个**（原条目漏了 `idle-guard`）：一手清点为 `Get-ChildItem packages -Directory` 后逐包 `Test-Path README.md`，为 `False` 的是 `guard` / `idle-guard` / `task` / `task-tree` / `ui-task-tree`。这五个 README 已由 S27 补齐。根 `README.md` 的索引链接仍指向目录——那只是链接写法，不再表示缺文档。

**本次清点新发现的欠账（2026-09-29 第二轮已全部结清；都不是本次改动引入的）**

下表三行均已于 **2026-09-29** 修改，改法与复核方式逐行写在「处置」列。

| 文件 | 不实之处 | 一手出处 | 处置（2026-09-29） |
| --- | --- | --- | --- |
| `packages/stream-guard/README.md:79` | 写「The per-turn and per-session budgets bound that recovery, so a session that keeps collapsing stops being steered」，与包内实现相反：**只有每轮额度会停止续写，会话级没有上限** | `packages/stream-guard/src/index.ts:224-233`（"Deliberately not a cap … Steering without limit and escalating the wording"）、`:622-631`（"Only the per-turn allowance stops steering. There is deliberately no session-wide cap"） | 该句已重写为「Recovery is bounded **per turn** rather than per session：`maxContinues` 是唯一会停止续写的额度，**故意没有会话级上限**；超过 `warnAfterContinues` 后提示词开始带警告并逐步升级措辞，所以无上限的续写仍然可见、可恢复」。改后该行不再与 `:622-631` 冲突。 |
| `packages/prompt-plan/README.md` 的 Layout 表 | 漏列 `src/transform.ts`（181 行） | `packages/prompt-plan/src/transform.ts:110`、`:168` | Layout 表已补一行 `src/transform.ts`（描述 = 「a rule 用来做保形变换、而不是整体替换 section 文本」）。**行数 181 已复核**（`(Get-Content …).Count`）。 |
| `packages/stream-guard/README.md:75`、`:111-113` | 4 条相对链接指向本仓**不存在**的路径（`../../../docs/config-catalog.md`、`../../../docs/subsystems/llm-streaming.md`、`../README.md`） | `Test-Path` 全为 False；本仓 `docs/` 只有 4 个文件，也没有仓根 `package.json`（三项本轮复核仍为 False / 4） | 4 条链接已全部换成本仓真实存在的目标：配置目录那一句改为「值在 `src/index.ts` 的 `Config` 里声明 + 指本文件 `#setting-the-budgets-and-channels`」，并明写**本仓不带生成的配置目录**；subsystem 那一页改指 `src/index.ts`（并明写本仓没有那一页）；`../README.md` 改指仓根 `README.md#守卫系…`（该节确实讲守卫家族）。复核脚本 `check-links.mjs` 重跑：三份 README 的**相对链接全部 OK、MISS 归零**。 |

`packages/dual-axis/README.md` 与 `packages/dual-axis-ui/README.md` 本轮**未发现**与源码冲突的条目，其相对链接也全部有效；但**未逐句复核**，本表不声称它们是准的。

## 守卫系两包入表（2026-09-29，S11）——这两行的每一格是怎么来的

`packages/guard` 与 `packages/prompt-plan` 此前**在盘上、在 `pnpm-lock.yaml` 的 `importers:` 里、却不在任何索引表里**。两行已补进上面的矩阵与根 `README.md` 的包索引。**验证状态按实测档位写，不比证据高一档。**
本节**取代**旧文本「顺手记下的两件事实（未改动本仓任何包）」——那句话写在取证之前，其中一条已被实测推翻（见本节「`packages/dsh-prompt-plan` 是 Junction，不是第二个包」一段）。

| 格 | `@t4r71/dsh-guard` | `@t4r71/dsh-prompt-plan` |
| --- | --- | --- |
| 包名 / 版本 | `@t4r71/dsh-guard` @ `0.1.0` | `@t4r71/dsh-prompt-plan` @ `0.1.2` |
| 依据 | `packages/guard/package.json:2,4` | `packages/prompt-plan/package.json:2,4` |
| 面向 DSH | `^0.1.7-rc.2`（`dsh-agent` / `dsh-llm` / `dsh-session` 三条同值；`@deepseek-ai/cordis` = `^4.0.4`）；依据 `packages/guard/package.json:44-49` | `^0.1.7-rc.2`（五条同值；`@deepseek-ai/cordis` = `^4.0.4`）；依据 `packages/prompt-plan/package.json:49-57`（**2026-09-29 现场实读**）。**本节首次入表时记的「混合锚」（`dsh-settings` / `dsh-system-prompt` 两条曾是精确 `0.1.7-rc.2`）已失效** —— 那两条已于 2026-09-29 改成范围，见下「peer 锚同步」第二条。改后全仓曾**仅剩** `dual-axis`（11 条）与 `dual-axis-ui`（16 条）两处精确 peer（两者都已发布）；**2026-09-29 这 27 条亦已改成范围**，见下「peer 锚同步（2026-09-29，S28）」——全仓现有 0 条精确 dsh peer |
| 依赖解析 | 未验证：`pnpm-lock.yaml:160-195` 有完整 importer（12 条依赖全解析），但本轮未跑 `pnpm install` | 未验证：`pnpm-lock.yaml:277-311` 有 importer，本轮未跑 `pnpm install` |
| 构建 | **部分通过**——见下「为什么只写部分通过」 | **未验证**——本轮未为它跑过任何构建命令 |
| 单测 | **16 / 16**（本轮重跑） | **无**——`package.json:28-31` 只有 `build` 与 `typecheck`，没有 `test` 脚本 |
| 真机冷装 | **未做**（无隔离 DSH_HOME 冷装冒烟） | **未做**（同上） |
| 首次发布 | —（registry 404 实测，未发布） | —（registry 404 实测，未发布） |

### 为什么 guard 的「构建」只写「部分通过」

本轮实测 `tsc -p tsconfig.test.json --noEmit`（cwd = `packages/guard`，用包自己的 `node_modules` 里的 typescript）：
**`TSC_EXIT=2`**，**23 条**类型错，**全部落在 `tests/guard.spec.ts`**（分布：`TS2345` ×11、`TS2722` ×7、`TS18048` ×3、`TS2353` ×2；首条在 `(105,56)`）。
原始输出存 `M:\T4\out\stage2\guardidx\guard-tsc-test.txt`，可复现脚本 `M:\T4\out\stage2\guardidx\verify.ps1`（第 4 节）。

> **口径更正**：前序简报把这一条记成「20 条错」。本轮**两次独立实测都是 23 条**，本节以实测的 23 为准。（`tsconfig.test.json` 自带 `noEmit: true`、`composite: false`、`incremental: false`，因此这条命令**不落任何产物**、重跑不改变结果；`--noEmit` 是冗余但无害的显式写法。）

「部分通过」的正面那一半来自**前序阶段**、本轮**未重跑**：`tsc -b` = EXIT 0、`tsdown` = EXIT 0（`M:\T4\out\guard\E-守卫插件.md:82`、`:87`）。本轮实测到的产物 `packages/guard/lib/index.js` = **77,095 B**、sha256 `446F0F5E7CDE5E7AC2E6B2246FD8991A98FD46E59A116F6BE0EA68B9AA990085`、mtime `2026-09-29T12:18:53`——**它在这两次测量之间没变**，所以正面那一半没有失效。

单测那一格是本轮真跑的（`node --import tsx/esm --test tests/guard.spec.ts`，cwd = `packages/guard`）：
**`TEST_EXIT=0`，`tests 16` / `pass 16` / `fail 0` / `duration_ms 221.2402`**，输出存 `M:\T4\out\stage2\guardidx\guard-test.txt`。

### 为什么 guard 的「真机冷装」写「未做」而不是「通过」

`AGENTS.md` 说的真机冷装是**隔离 `DSH_HOME` 的冷装冒烟**。guard **没有**这一档证据。
它有的是另一档、也确实有价值的证据：**已在操作者的在用 desktop profile 里装载运行**——

- 挂载行：`M:\DSH-T4\home\profiles\desktop\cordis.patch.yml:505-510`（`id: guard` / `name: '@t4r71/dsh-guard'`）。
- 载荷凭据：`M:\T4\out\guard\evidence\apply-receipt.log`，**25 行** `guard: apply`，`2026-09-29T03:47:48.404Z` → `2026-09-29T04:46:06.096Z`。

**两者不是一回事，本表不拿后者顶替前者。** `prompt-plan` 同理：它在 `M:\DSH-T4\home\profiles\desktop\cordis.patch.yml:93-100` 里以 `id: prompt-plan` / `mode: observe` 装载，但那也是**在用 profile**，不是隔离冷装。

### 为什么 guard 的「依赖解析」写「未验证」

`packages/guard/node_modules` 下 `tsdown` / `tsx` / `typescript` 三条是 **Junction**（`LinkType = Junction`，目标为**绝对路径** `M:\dsh-plugins\node_modules\.pnpm\…`，三条创建时间同为 `2026-09-29T11:30:42`）；
而同仓 pnpm 生成的链接是 **SymbolicLink**（目标为**相对路径** `..\..\..\node_modules\.pnpm\…`）——对照 `packages/stream-guard/node_modules` 与 `packages/prompt-plan/node_modules`（本轮实测，见 `verify.ps1` 第 6 节）。
**这三条链接的形成方式与全仓其余包不同**（「是手工建的」属**推断**：未取到创建命令，只取到形态与时间戳的差异）。**干净 checkout 上的 `pnpm install && pnpm build` 从未跑过**，所以这一格只能写未验证。

### 取代关系：guard 是两条旧守卫的合并形态（一手出处）

`@t4r71/dsh-guard` 是 `@t4r71/dsh-stream-guard` + `@t4r71/dsh-idle-guard` 的**合并形态**，不是第三个独立守卫：

- 包内自述：`packages/guard/src/index.ts:6-16`（「This package is both of them, in one `apply`, sharing one per-session state and one boundary token.」）、`:877-895`。
- **同挂会重复注入**：`agent/turn-stopping` 是 serial 派发，两条旧监听器**都不返回 bail 值**，所以两个都跑到（`packages/guard/src/index.ts:881-887`）；guard 的去重**只在包内生效**（`packages/guard/src/index.ts:927-944` 的 `injected` map + `boundary = turn:lastAssistantMessageId`）。
- **在用 desktop profile 只挂 `guard`**：`M:\DSH-T4\home\profiles\desktop\cordis.patch.yml:505-510`；该文件全文 grep `stream-guard|idle-guard` 只命中 `:494` 那条**注释**（`:494-495` 原文即写着去重只在包内生效、本文件里没有那两行）。

**但 stream-guard / idle-guard 两行的验证列不改、行也不删**：那两列是隔离 `DSH_HOME` 冷装真跑出来的；两包的目录、源码、`cordis.patch.yml` 与测试也都还在盘上，仍是独立包。「取代」是**代码层 + 部署层**的结论，不是文件级顶替。是否标「已弃用」属人裁决，本表不给值。

### `packages/dsh-prompt-plan` 是 Junction，不是第二个包（对旧描述的纠正）

旧文本（已由本节取代）写的是：「`packages/prompt-plan` 与 `packages/dsh-prompt-plan` 两个目录同时存在于盘上，后者没有 `package.json`（不构成包）」。**这一句与实测不符。**

本轮实测：

- `Get-Item -Force M:\dsh-plugins\packages\dsh-prompt-plan` → `LinkType = Junction`，`Target = M:\dsh-plugins\packages\prompt-plan`（`CreationTime = 2026-09-29T12:06:21`）。
- `Test-Path …\dsh-prompt-plan\package.json` → **True**。
- 两侧 `package.json` 的 SHA256 **逐字节相同**：同为 `8E9328E97016A480433B902D48AA4AB8A8B91A6F2A468B3D63275E33E2C72476`。

⇒ `packages/dsh-prompt-plan` **有** `package.json`，但它是**指向 `packages/prompt-plan` 的 Junction**——**同一个包的第二条路径**，既不是独立包，也不是「不构成包」的目录。因此它**没有、也不该有自己的索引行**。

旧文本里关于 `git status` 的那半句**本轮实测为真**：`git status --porcelain -- packages` 里 `?? packages/prompt-plan/` 与 `?? packages/dsh-prompt-plan/` **两条都在**（`git --version` = 2.54.0.windows.1）。风险照旧：`git status --untracked-files=all` 会把同一批文件按第二条路径再列一遍，`git add -A` 有把**同一份内容按两条路径**加进索引的风险。

### prompt-plan 的重叠守卫已删除（2026-09-29）

本节**取代**本表先前那节「顺带记下：prompt-plan 自带第二套守卫实现（记下，不裁决）」——**那一节已随本次同步删除**；本次同步同时把它的结论（「两套实现并存…属人裁决」）**判为已终结**：`packages/prompt-plan` 里那套与 `@t4r71/dsh-guard` 重叠的守卫**已被删除**，仓库现在只有一份守卫实现（`packages/guard`）。

- `packages/prompt-plan/src/guards/**` 共 **14 个 .ts 已删**，改前副本在 `M:\T4\out\stage2\guardpurge\backup\src\guards\`（同目录另有被编辑的 5 个文件的改前副本）；`package.json` 的 `exports["./guards"]` 子路径已移除（现 exports 只有 `.` / `./cordis.patch.yml` / `./package.json`，见 `packages/prompt-plan/package.json:11-18`）；tsdown 的第二入口已移除；构建产物从 3 文件 187.07 kB 变成 1 文件 115.04 kB。
- **那个子路径从未被任何 profile 注册过**：在用 profile 的补丁层里 `guards` 字段**零命中**（`M:\DSH-T4\home\profiles\desktop\cordis.patch.yml:93-100` 只有 `mode` / `rulesFile` / `artifactDir` / `fullText`），`packages/prompt-plan/cordis.patch.yml` 全文只 insert 一行 `prompt-plan`，**从来没有 `prompt-plan-guards` 这一行**。⇒ 删除不触及任何在用行为。
- 该包 README 里那两处守卫说明**已重写**为「Guarding is not this package's job」（现 `packages/prompt-plan/README.md:273-293`）。本节正文此前引用的 `packages/prompt-plan/README.md:273-303` 那一节**已不存在**，该引用作废。
- 一手出处：`M:\T4\out\stage2\S17-删除重叠守卫.md`（§2 删除清单 + 改前 sha256、§3 R1–R15 引用点清单、§6.2 真机改前改后 95 行行集逐条相同）。

## 维护义务

### 已知欠账（2026-09-29 备案 → 2026-09-29 由 S28 结清）

**本节已结清。** 2026-09-29 的两包 `peerDependencies` 已由精确版本改成范围、版本已抬到 `0.1.2`（未发布），逐条改法、下界依据与回显见下「peer 锚同步（2026-09-29，S28）」。**下文保留备案原文与危害分析**，因为 registry 上的 `0.1.0` / `0.1.1` 两个版本**仍然带着那 27 条精确锚**——在 `0.1.2` 发布之前，消费者侧的后果一字未变。

`packages/dual-axis`（11 条）与 `packages/dual-axis-ui`（16 条）的 DSH `peerDependencies` **全部是精确版本**
`0.1.7-rc.2`，**零范围**。这违反 `AGENTS.md`「版本与 peer 锚」的「必须写成范围」。

**危害**：0.1.7 的装载闸门按 `semver.satisfies(runtime, requirement, { includePrerelease: true })` 逐行判定，
精确版本号只对**恰好那一个**运行版本为真；换任何别的运行版本，这两包会被**静默 `disabled`**（只在 stderr 留一行，不报错、不加载）。

**当时的裁决**：不改。改锚必须升版重发，而这两个包不在当时那次作战的目标范围内；**下次给这两个包升版时必须一并改成范围**，改完同步本表「面向 DSH」列。
**2026-09-29 执行结果**：改为 `^0.1.7-rc.2`（27/27 条），版本抬到 `0.1.2`，本表「面向 DSH」列已同步；`build` / 单测均在本轮复跑，`typecheck` 的既有失败已单独记录（见矩阵行）。

**2026-09-29 追加：协调者从 registry 一手核到的事实——比初次记录时更严重。**

| 包 | 已发布版本 | 各版本 dsh peer 条数 | 其中精确锚 |
|---|---|---|---|
| `@t4r71/dsh-dual-axis` | `0.1.0`（09-27）、`0.1.1`（09-28） | 11 | **11 / 11，两个版本都是** |
| `@t4r71/dsh-dual-axis-ui` | `0.1.0`（09-27）、`0.1.1`（09-28） | 16 | **16 / 16，两个版本都是** |

证据：`GET https://registry.npmjs.org/@t4r71%2Fdsh-dual-axis`（与 `…-ui`）返回 HTTP 200，
`dist-tags.latest` 均为 **`0.1.1`**；逐版本读 `versions[v].peerDependencies` 统计得出上表。

⇒ **这个缺陷不是「还没发出去」，它已经发出去了**；而且 **`0.1.1` 那次升版并没有顺手修掉它**。
**消费者侧的实际后果**：运行版本只要不是恰好 `0.1.7-rc.2`，这两个包会被装载闸门**静默 `disabled`**
（不报错、不加载，只在 stderr 留一行）。
**⇒ 下一版必须改成范围。若在此之前有人报告「装了但没反应」，先查这里。**
**2026-09-29 更新**：本地清单已改成范围、版本已是 `0.1.2`，但**尚未发布**——只要 registry 的 `dist-tags.latest` 还是 `0.1.1`，上面这条排查指引就仍然有效。

同时更正：根 `README.md` 的 npm 列原写 `0.1.0`，**已按 registry 实测改为 `0.1.1`**。

## 维护义务（常规）

- 新增包：同步本表 + 根 `README.md` 的包索引。
- 改 peer 锚：同步本表的「面向 DSH」列（**只改这一列**，除非同时重跑了验证命令）。锚由精确版本改成范围属于此类改动，见上「peer 锚同步」一节（该节现有两条：`plan-tree` / `ui-task-tree`，以及 `prompt-plan` 的 `dsh-settings` / `dsh-system-prompt`）。
- 只改 `devDependencies` 的精确值：**不是** peer 锚改动，不动本表任何一列（全仓约定 devDependencies 用精确值）。
- 状态变化：只有真机冷装跑过才能把「真机冷装」列写成「通过」；`build` + `typecheck` + `test` 全绿只到「静态三关已过」这一档，措辞必须与证据档位一致（`AGENTS.md`：「构建通过不等于能用」）。

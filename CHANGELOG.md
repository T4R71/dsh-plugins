# Changelog

包版本独立于所面向的 DeepSeek Harness 版本：包从 `0.1.0` 起走自己的 semver，面向的 DSH 版本写在各自的 `peerDependencies` 里。条目按日期倒序。

## 2026-09-29 — 守卫系两包补进索引 + 修掉一处与实测不符的描述

### 补进索引的两行

仓里有两个**真实在用却不在任何索引表里**的包，本轮补进 `README.md` 的包索引与 `docs/COMPATIBILITY.md` 的矩阵：

- [`packages/guard`](packages/guard) → `@t4r71/dsh-guard@0.1.0`（`stream-guard` + `idle-guard` 的**合并形态**，另加自动重试；**在用 desktop profile 已装载运行**）。
- [`packages/prompt-plan`](packages/prompt-plan) → `@t4r71/dsh-prompt-plan@0.1.2`（**在用 desktop profile 已装载运行**，`mode: observe`；包内**没有 `test` 脚本**）。

两行在 `pnpm-lock.yaml` 的 `importers:` 里本来就有（`:160` / `:277`），只是文档漏了。

### 验证状态按实测写，没有写高

- **`guard` 的「构建」列写「部分通过」**：本轮实测 `tsc -p tsconfig.test.json --noEmit` = **EXIT 2**，**23 条**类型错，**全部落在 `tests/guard.spec.ts`**（`TS2345` ×11、`TS2722` ×7、`TS18048` ×3、`TS2353` ×2）。原始输出与可复现脚本存 `M:\T4\out\stage2\guardidx\guard-tsc-test.txt` / `M:\T4\out\stage2\guardidx\verify.ps1`。
  > 与 S10 取证简报记的「20 条错」不一致：本轮两次独立实测都是 **23 条**，文档以实测为准，并已在 `docs/COMPATIBILITY.md` 里写明这处口径更正。
- **`guard` 的「真机冷装」列写「未做」**：它**没有**隔离 `DSH_HOME` 冷装冒烟。它有的是「在用 profile 已装载运行 + 25 行 `apply` receipt」这一档证据（`M:\DSH-T4\home\profiles\desktop\cordis.patch.yml:505-510`、`M:\T4\out\guard\evidence\apply-receipt.log`）。两回事，没有互相顶替。
- **`guard` 的「依赖解析」列写「未验证」**：`packages/guard/node_modules` 下 `tsdown` / `tsx` / `typescript` 三条是 **Junction**（绝对目标），而全仓 pnpm 生成的是 **SymbolicLink**（相对目标）；干净 checkout 上的 `pnpm install` 从未跑过。
- **`prompt-plan` 的「构建 / 单测 / 冷装」三列写「未验证 / 无 / 未做」**：本轮没为它跑过任何命令。

### 修掉一处假陈述（`docs/COMPATIBILITY.md`）

原文写「`packages/prompt-plan` 与 `packages/dsh-prompt-plan` 两个目录同时存在于盘上，**后者没有 `package.json`（不构成包）**」——**与实测不符**。
实测：`packages/dsh-prompt-plan` 是 **Junction**（`LinkType = Junction`，`Target = M:\dsh-plugins\packages\prompt-plan`），`Test-Path …\package.json` = **True**，且两侧 `package.json` 的 SHA256 **逐字节相同**（同为 `8E9328E97016A480433B902D48AA4AB8A8B91A6F2A468B3D63275E33E2C72476`）。
原文里关于 `git status` 的那半句**实测为真**（`?? packages/prompt-plan/` 与 `?? packages/dsh-prompt-plan/` 两条都在），保留并改成「**它没有、也不该有自己的索引行**；风险是 `git add -A` 会把同一份内容按两条路径加进索引」。

### 写清「取代」关系（`stream-guard` / `idle-guard` 两行不删）

`README.md` 与 `docs/COMPATIBILITY.md` 各加一节，给出一手出处：

- `@t4r71/dsh-guard` 是两条旧守卫的**合并形态**（`packages/guard/src/index.ts:6-16`、`:877-895`）；
- **同挂会重复注入**（`agent/turn-stopping` 是 serial，两条旧监听器都不 bail；guard 的去重只在包内生效，`packages/guard/src/index.ts:927-944`）；
- **在用 desktop profile 只挂 `guard`**（`M:\DSH-T4\home\profiles\desktop\cordis.patch.yml:505-510`；全文 grep `stream-guard|idle-guard` 只命中 `:494` 那条注释）。

`stream-guard` / `idle-guard` 的**验证列不改、索引行不删**——那两列是隔离冷装真跑出来的，两包也仍是盘上的独立包。「取代」是代码层 + 部署层的结论，不是文件级顶替。是否标「已弃用」属人裁决，本轮不给值。

### 被证否的一条线索

「版本号大于 `0.1.0` 说明发布过」**不成立**。本轮实测：`GET https://registry.npmjs.org/@t4r71/dsh-guard` → **404**、`…/@t4r71/dsh-prompt-plan` → **404**；对照 `…/@t4r71/dsh-dual-axis` → **200**（`dist-tags.latest = 0.1.1`）。`prompt-plan` 已是 `0.1.2`，注册表上仍是 404。
两行的 npm 列因此写「未发布（registry 404 实测）」。

### 本轮没动的东西

- `packages/**` **一个文件都没改**（尤其 `packages/guard/**`——那 23 条类型错不是本轮的范围）。
- 未 `git add` / 未 `git commit`；未启动任何 DSH 实例（`M:\DSH-T4` 全程只读）。
- 写入面：`README.md`、`docs/COMPATIBILITY.md`、本文件，以及 `M:\T4\out\stage2\guardidx\**`（验证脚本与原始输出）。

### 我核不出来的格

- `guard` 在**干净 checkout** 上能否 `pnpm install && pnpm build`——未跑（跑了会动 `pnpm-lock.yaml` 与 `packages/**`）。
- `guard` 的 `node_modules` 那三条 Junction **是谁、用什么命令建的**——只取到形态与时间戳（`2026-09-29T11:30:42`），未取到创建记录。
- **三包（或 `guard` 与 `prompt-plan` 的 `./guards`）同挂的真实行为**——未真机观测，只到「源码 + cordis serial 语义 + profile 注释」三条一手材料的静态结论。

## 2026-09-29 — 新增 `@t4r71/dsh-task`（并在同一轮同步 peer 锚）

### 新增包 `packages/task` → `@t4r71/dsh-task@0.1.0`

一个新的一等任务工具：自己持有任务树，并持有在树上干活的子代理（异步派发、预设人设 + 工具过滤、状态与结果回收）。它不是 `task-tree` 组合包的替代品，也不插任何客户端行。

### 验证到哪一档（不要读高）

- **做过的**：对 0.1.7-rc.2 目标，`pnpm --filter @t4r71/dsh-task` 的 `build` / `typecheck` / `test` 三条命令退出码均 0，单测 **17 passed / 0 failed**。逐字命令与退出码存 `M:\T4\out\stage2\evidence\task-package-commands.log`。
- **没做的**：没有真机装载、没有冷装冒烟、没有启动过任何 DSH 实例（`DSH_HOME` 未被设置）。按 `AGENTS.md`「构建通过不等于能用」，这只算「静态三关已过」，**不是**「已验证」。
- 兼容矩阵里该行因此写成「真机冷装：未做」，见 `docs/COMPATIBILITY.md` 的「`@t4r71/dsh-task` 的『未做』是什么意思」一节；同处也记了未联通面（`taskTree`、真实 `dispatch` / `send` / `interrupt` / `result` 路径、真实 `userQuestions` 服务）与一处**未改的语义偏差**（`result` 的描述说「子代理收尾文本」，实现带回整条 settle 通知正文）。
- 详细依据：S1 报告 `M:\T4\out\stage2\S7-task包入仓.md`（§4「我没能做的事」、§5「我没有验证的事」）。

### peer 锚：R2 把两条精确锚改成范围（同轮同步文档）

`packages/plan-tree` 的三条 DSH peer、与 `packages/ui-task-tree` 的六条 `dsh-client-*` peer，由精确 `0.1.7-rc.2` 改为范围 `^0.1.7-rc.2`（两个包的 `@deepseek-ai/cordis` 都仍是 `^4.0.4`，本轮未动）。理由是 0.1.7 的装载闸门按 `semver.satisfies(runtime, requirement, { includePrerelease: true })` 逐行预检，精确版本号只对那一个版本为真，别的运行版本一律判 false 并被**静默 disabled**。

按 `AGENTS.md`「兼容矩阵的更新义务」第 1 条，同一提交内同步了 `docs/COMPATIBILITY.md` 与根 `README.md` 的「面向 DSH」列；**只改了这一列，验证列未动**（本轮没有为这两个包重跑任何命令，措辞保持与证据一致）。

### 文档口径修正

- `docs/COMPATIBILITY.md`：「依赖解析通过」原来写「8 包工作区」，与 `pnpm-lock.yaml` 的 `importers:`（10 条）不符，改为 10 并列出包名。
- `docs/COMPATIBILITY.md`：新增「peer 锚同步」一节，写明两表列口径、依据文件与其 mtime，并记下两个**在盘上存在却在索引里没有行**的包（`packages/guard`、`packages/prompt-plan`，后者版本已是 0.1.2）——它们的验证状态未取到一手证据，故未擅自入表。
- `docs/COMPATIBILITY.md`「维护义务」：补写「改 peer 锚只改『面向 DSH』列」与「冷装那一列只有真机跑过才能写『通过』」两条。
- `README.md`：包索引新增 `packages/task` 一行；「面向 DSH」列的口径（一格只装一个值）写进表下注。

### 复核 `@t4r71/dsh-task-tree-host` 的删除

复核结论：**已清干净，无需修改**。`README.md` 与 `docs/COMPATIBILITY.md` 里零命中；`docs/PUBLISHING.md` 只剩发布顺序末尾那句「`task-tree-host` 已于 2026-09-29 整包删除，不再发布」，是**故意的墓碑**（防止有人照旧顺序去发这个不存在的包）；`CHANGELOG.md` 里的四处在「2026-09-29 — 删除 `@t4r71/dsh-task-tree-host`」这一节内，按本文件「不要改写历史」的惯例原样保留。

### 未随本轮处理

- `packages/ui-plan-tree` 在两张表里仍是「索引残留：该目录在盘上不存在」（待清理，非本轮范围）。
- 根 `README.md` 里 `dual-axis` / `dual-axis-ui` 两行标「已发布、已验证」，字面读像是针对本仓当前源码的验证；`docs/COMPATIBILITY.md` 记的是「真机冷装：未重做」。待澄清。
- `packages/{dual-axis,dual-axis-ui}` 的全部 `@deepseek-ai/dsh-*` peer 仍是**精确版本** `0.1.7-rc.2`（与 2026-09-27 那条 0.1.0 记录一致）。按 `AGENTS.md`「版本与 peer 锚」应为范围；这是包侧改动，本轮未动 `packages/**`，只在 `docs/PUBLISHING.md` 第 0 节标注了这一例外。

## 2026-09-29 — 删除 `@t4r71/dsh-task-tree-host`

**整包删除** `packages/task-tree-host`。它不是「暂时不插」的行，而是一个**会毒死会话日志**的缺陷源，因此不再保留成可开启的开关。

### 为什么要删

该包提供的 `taskTree` 会话投影**零消费者**（没有任何面板读它），却会写入 `taskTree/declared` 事件。
而 0.1.7-rc.2 的持久化读路径（`dsh-session-persistence/lib/index.js:184`）对**不在** `KNOWN_SESSION_EVENT_TYPES` 白名单里、
且没有 `ignorable: true` 标记的事件，会**拒绝解释整个日志**（`SessionFormatUnsupportedError`）；
公开的 `Session.append` 又只能产出 `{type, seq, time, data, surfaceOp?, sourceEventSeqs?}`，**没有任何途径**设那个标记。

最险的是**写入侧毫无警告**：追加成功、flush 成功、当次会话一切正常——直到某天重开该会话时整份日志作废。
协调者已于 2026-09-29 用真实 0.1.7-rc.2 的 `dsh-session` + `dsh-session-persistence-jsonl` 一手复现（控制组用白名单内类型对照），
证据存档 `M:\T4\out\stage2\evidence\verify-log-safety\`。

### 同时改动

- `packages/task-tree/package.json`：移除对 `@t4r71/dsh-task-tree-host` 的 `workspace:^` 依赖。
- `packages/task-tree/cordis.patch.yml`：删掉那两行**已注释**的 host 行，换成一段说明，不留可再开启的开关。
- `packages/task-tree/tests/bundle-listing.spec.ts`：更新注释（断言未变）。
- `README.md`、`docs/COMPATIBILITY.md`：删掉对应的包索引行。
- `docs/PUBLISHING.md`：从发布顺序里移除。

### 后续

任务树的状态承载将整体迁到「独立 Loader entry 的 volatile settings 命名空间 + 客户端读 `configForms` 镜像」，
使任务树**不再写任何会话事件**。设计与证据见 `M:\T4\out\stage2\R1-官方数据通道.md`。
## 2026-09-28 — 仓库重组

`T4R71/dsh-dual-axis` 拆成独立插件开发仓 `T4R71/dsh-plugins`（**新仓，不带旧仓的 git 历史**）：

- 已发布的 `@t4r71/dsh-dual-axis` 与 `@t4r71/dsh-dual-axis-ui`（0.1.0）源码整体迁入。
- 另外 7 个自研插件从 `0.1.6-alpha.2` 检出搬入并改到 `@t4r71` 作用域，统一为 `0.1.0`，**标记为「未迁移」**：
  `dsh-task-tree`、`dsh-task-tree-host`、`dsh-plan-tree`、`dsh-ui-plan-tree`、`dsh-ui-task-tree`、
  `dsh-stream-guard`、`dsh-idle-guard`。依赖从 `workspace:^` 解析为各自的 npm 版本。
- 被取代的 `@deepseek-ai/dsh-client-ui-sandbox-axis`（`dual-axis-ui` 的前身）**未收录**，只作归档。

旧仓的 0.1.0 历史条目保留在下节。

## 2026-09-27 — 0.1.0（首版）

首次公开发布：`@t4r71/dsh-dual-axis`（宿主半边）与 `@t4r71/dsh-dual-axis-ui`（客户端半边）。

### 功能

- **按会话的双轴**：读轴与写轴各自取 `deny | workspace | all | custom`；`custom` 在某个底座上叠加绝对路径的 `allow` / `deny` 条目。
- **可复用规则组**：设置行维护命名规则片段库（`groups`），`defaultGroups` 决定新会话开局引用哪几条；组定义改动作用到引用它的会话。
- **每会话轴对存储**：设置命名空间 `dual-axis-sessions`（会话 id → 轴对），整份 `axes` 一次 `replace`，按 revision 重试；四次都冲突则抛 `DUAL_AXIS_AXES_CONFLICT`。轴对不写进会话日志。
- **读轴围栏**：`read-guard` 在工具派发层拦 `read` / `read_image` / `grep` / `glob` 四个入口。
- **模型可见的取值段落**：会话组装时按已解析的范围渲染（段落名 `sandbox:dual-axis`），中途改轴在下一次请求生效。
- **`/axis <轴>:<值>` 命令**：按会话改轴，并冻结该会话的轴对。
- **客户端半边**：插件页配置行（两轴 + 规则组，一次原子保存）与输入框上方的读/写两个下拉；行键 `@t4r71/dsh-dual-axis#dual-axis`。
- **安装即取代官方权限行**：补丁禁用上游 `ui-permission` 行（单占槽与 locale 命名空间两处冲突，技术不可行共存）。想拿回官方界面必须卸载本组合包。
- **bundle 补丁**：`dsh.bundle.patch` 声明的补丁插入四个 Loader 行并关掉上游那一行，profile 无需手写 Loader 条目。

### 兼容性

面向 DeepSeek Harness `0.1.7-rc.2`（两个包的 `peerDependencies` 全部钉在该版本）。
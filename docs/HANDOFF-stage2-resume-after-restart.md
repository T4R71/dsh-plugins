# 交接：task 插件「自动放行流水线」第 2 阶段 · 重启后立刻做

> 作者：中枢玖（会话 `session-ad7460f7-90f0-4582-9698-dc2e2fb9f755`）
> 写于 2026-10-01 15:0x，**重启前**。工作目录 `M:\DSH-T4`，插件仓 `M:\dsh-plugins`，Windows + pwsh，沙箱 danger-full-access。
> 前置文档：`M:\dsh-plugins\docs\HANDOFF-auto-dispatch-stage2.md`（第 1 阶段与现场，仍然有效）。

---

## 0. 一句话状态

第 1 阶段（结语回传状态 → 父树节点自动置位）**真机通过**；第 2 阶段「后继自动放行」在现场失败，
**根因在运行时源码层已定位**（名册上限 + 队友通道无退路），现在需要**重启宿主**把 14:33 那次构建装上去，
然后按下面两条探针取现场证据。

---

## 1. 已钉死的事实

### 1.1 宿主比产物旧（一手，时间戳）
- 宿主进程 PID 18576（`dsh-desktop-host`）启动 **2026/10/1 14:31:41**。
- `M:\dsh-plugins\packages\task\lib\index.js` 构建于 **14:33:21**（101252 B / `DA1CD4EA7720D1D4AF7B9D0F2986D5FDD3CF3CE21002526948D66E86B425899A`）。
- ⇒ 宿主装的**不是**最新那份产物。**「派发失败写进 detail」那处可见性补丁在不在当前进程里，判不了**（磁盘上没有启动时刻的副本）。

### 1.2 宿主侧插件没有模块级热重载（一手，源码 + 实机）
- `dsh-base/cordis.patch.yml:27-32` 把 `hmr` 行设成启用但 `root: []`（只监听配置，不监听模块）。
- `dsh-hmr/lib/index.js` 里唯一会重新执行模块代码的 `partialReload()`（:516-600）只由 watcher 命中 `loadCache` 触发；`root` 为空 ⇒ 永不触发。
- `cordis-plugin-loader/lib/index.js:214-228` 的 `import()` 无 cache-busting。
- ⇒ **改 `lib/` 必须重启宿主**（改 profile 的 `cordis.patch.yml` 才不用重启）。

### 1.3 名册上限 = 8，且只增不减（一手，源码）
- 判定：`app.asar\dsh\node_modules\@deepseek-ai\dsh-experimental-agent-team\lib\index.js:562-570`
  ```js
  if (state.members.length >= this.maxMembers) throw new TeamError(`Team member limit ${this.maxMembers} reached`, "TEAM_MEMBER_LIMIT");
  ```
- `maxMembers: 8` 来自 bundle `@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml:17-22`；desktop patch 未覆盖。
- 计数维度：**按 root 会话（=一个 Lead 会话 = 一支 Team）**，**含 failed**，**Lead 不占名额**，**没有任何删除/回收入口**（事件只追加；`stopTeammates` 只停活的孩子，不动记录）。
- 满了抛：`TeamError`，code `TEAM_MEMBER_LIMIT`，消息逐字 `Team member limit 8 reached`。
- **重启不重置**：名册由 Lead 会话日志里的 `team/member` 事件重建（`<DSH_HOME>\sessions\<slug>\<lead-session-id>\session.v4.jsonl.zstd`）。

### 1.4 队友通道抛错时没有退路（一手，本包源码）
`packages/task/src/index.ts` `dispatchTo`（:1170-1279）：
```ts
if (teams !== undefined && membership?.role === 'lead') { ... await teams.spawnTeammate(...) ... return ... }
```
⇒ Lead 这条路上 `spawnTeammate` 抛出的异常**直接冒泡**，不会退到下面的 `ctx.subagents.startContinuable`。
`dispatchRunNode`（:1291-1323）的 catch 把它回滚成 `pending` —— 与「依赖没满足」在面板上一模一样。

### 1.5 旧会话的现场（侦察已解码旧会话日志 4006 条事件，逐字取证）

证据文件：`M:\DSH-T4\home\sessions\--C-Users-TRI-Documents-deepseek-harness-default-workspace--\session-d2da5302-748e-4cb5-b276-1bd37720d0c8\session.v4.jsonl.zstd`（2168 帧 zstd 全解、0 非 JSON 行）。

**有正面证据**
- 该会话共 **8 名队友**（16 条 `team/member` = 8 建档 + 8 active，无 failed、无删除）：`impl-status`(10:36) → `impl-ui-failed`(11:13) → `status-probe`(11:50) → `status-probe-stop`(11:50) → `impl-auto-dispatch`(12:29) → `impl-runs-row`(12:47) → `chain-a`(14:24:57) → **`chain-a-2`（14:32:08.234，seq 3884）= 第 8 个**。
- `seq=3886`（14:32:11.685）之后到日志结束（`seq=4004`，14:34:21）共 118 条事件，**`team/member` 0 条**；`seq=3914` 的 `list_agents` 实测 **9 行 = lead + 8 队友**（8 人全 inactive 仍占名额）。
- 判定是「先判后加」（`state.members.length >= maxMembers`）⇒ 名册满 8 之后**任何** `spawnTeammate` 必抛 `TEAM_MEMBER_LIMIT` / `Team member limit 8 reached`。
- chain-b 在账本里始终 `pending`、无 childId（14:32:21.758 落盘版 + 14:32:31 diag 读回版）。
- `advanceRuns` 的前置条件全部满足：结算通知 `seq=3905`（14:32:21.078）已落成 `user/message`；账本 0.68 s 后确有写入（记账写）；`seq=3923` diag 显示 `agentsService:"present"` + `get(sid) -> live agent`。

**判不了（关键）**
- `spawnTeammate` **到底有没有被调用、有没有抛** —— 抛错只进 `ctx.logger.warn`，而宿主正常运行时 warn **没有任何落盘通道**（`main.js:3685-3697` stdio 接线；`dsh-app-boot` 的 `startupLogs` 只在启动失败时用）。
- 全库搜索：`Team member limit` **0 次**；`TEAM_MEMBER_LIMIT` 唯一一次出现在 `seq=3927` 的 **assistant 独白**（旧中枢自己在猜「怀疑是名册满了」），**不是运行时错误**。
- ⇒ 「被上限拒了」= **机制必然（源码）+ 现场计数吻合（日志）**，但**没有直接观测到那次抛错**。这正是必须重启、让新构建把原因写进节点 detail 的原因。

### 1.5b 顺带确认的两件事
- 账本 mtime 14:32:21.758 **不能**当作「派发被尝试过」的证据（`advanceRuns` 的记账写单独就能解释它）。
- `AUTO_DISPATCH_FAILED_PREFIX` 在产物里是 `M:\dsh-plugins\packages\task\lib\index.js:2180`，逐字 `派发失败：`（旧会话里旧中枢有时口头写成「派发节点失败」，以产物为准）。

### 1.6 结算正文可全文回读（一手，源码 + 语料）
- `dsh-subagent` 的 `createSettlementMessage` 把「摘要 + `Its closing message:` + 子代理收尾文本」做成一条 `source.kind='subagent-settled'` 的 user message；**正文不截断**（只有 `source.summary` 截到 120 字符）。
- 但**同一个 childId 会有多条**结算通知（每次 Activation 一条）⇒ 取「最新那条」，别假设唯一。

---

## 2. 用户已拍板的设计（逐字见会话，这里是执行口径）

| 事项 | 裁决 |
|---|---|
| 上游结论来源 | **父会话历史里的结算正文**（不是树 detail 那 200 字）——原话「中枢规划出方案，然后先探查，再执行，执行直接拿探查的结论」 |
| 拼装方式 | **中枢先写框架、结论填进框架里的槽位**（用户 15:07 修正口径，推翻「整段追加」）：槽位语法 `{{<nodeId>}}`，就地替换成该依赖的结论文本全文；**没被槽位吃掉的依赖**按 needs 声明顺序追加到末尾；全被吃掉则一个块都不加 |
| 槽位校验 | 声明期拒收：`{{id}}` 里的 id 必须是同一 run 的节点、且必须是本节点的 needs 成员（中枢自定，理由同 needs 存在性检查） |
| 结论上限 | **不设小上限：整段照抄；单条超 20000 字才截断并注明**（推荐项，用户已选） |
| 上游简略度 | **改提示词**（用户原话「改提示词啊」）：只在 run 链路简报里加一句「结语里给下游用的结论尽量简略（建议 ≤500 字），不复述过程、不贴长日志」；普通 `dispatch` 简报逐字不变 |
| 多依赖排序 | **按 `needs` 声明顺序** |
| 取不到上游结论 | **阻塞：节点保持 pending，把原因写进 detail 与账本**（用户原话「阻塞让中枢处理」）；仍遵守「不通知中枢」 |
| 名册满/队友通道抛错 | **不退回直连通道：停在 pending，把原因写进 detail 与账本** |
| §六 账本路径 | **做**：装载时优先 `ctx.baseUrl`，拿不到退回环境变量（`ledgerPathFor` 是唯一决议点） |
| 重启时机 | 先重启取证，再改代码 |

**仍然有效的硬设计（旧文档 §五，不许退化）**：树只写 status/detail（依赖不进树）；失败只停这一支、平行分支照跑；自动放行不通知中枢；没收到状态回报 = failed。

---

## 3b. 探针结果（已于 14:57–14:59 实跑，原始回显）

**探针 1（probe-chain-3，正常链）——通过**
- `task run` 返回 `dispatched: ["t3-a"]`；t3-a 结算后 **t3-b 被自动派出**：树 `- [in_progress] t3-b … (child 4953f39b-cc64-4479-a98d-762a3a12b21d)`，账本 `"status": "dispatched"` + 同 childId。
- t3-b 真实跑完并回报：读 `M:\DSH-T4\scratch\chain3.txt` → `t3-a-done`（exit 0），`node -e "console.log('t3-b-ok')"` → `t3-b-ok`（exit 0），沙箱 danger-full-access、denied:false。
- ⇒ **名册有位时，「后继自动放行」在这版构建下工作正常**；旧会话的失败与「名册满载」这一环境条件吻合。

**探针 2（probe-fail-1，故意注入失败）——通过**
- f-b（`preset: "no-such-preset"`）停在 pending，持久化树上 detail 逐字：
  `派发失败：UnknownPresetError: unknown preset "no-such-preset"; configured presets: impl, lead, recon, verify`
- ⇒ 「派发失败」现在**写进节点 detail**，不再只进没有落点的 `ctx.logger.warn`。

**顺带发现（要修的小缺口）**：`renderTree`（`src/index.ts:1789-1799`）**不渲染 detail**，于是 `task list scope=tree` 看不到上面那条 `派发失败：` —— 只有面板与 profile yml 能看。实施时一并补上（非 completed 节点带 detail）。

**名册预算**：已用 **4/8**（recon-runtime、t3-a、t3-b、f-a），还剩 4 位。

---

## 3. 重启后立刻做的两件事（照抄即可）

> 名册预算：上限 8。已用 **5 位**（recon-runtime、t3-a、t3-b、f-a、impl-upstream）⇒ **只剩 3 位**；下面这条收官链（v-a、v-b）再占 2 位，最后一格留作返工。

### 探针 1：正常链（证明「有名册位时链路通」）

```
task(action="run", run="probe-chain-3", nodes=[
  { id: "t3-a", prompt: "用 pwsh 执行 node -e \"console.log('t3-a-ok')\" 并记下真实回显；把字符串 t3-a-done 覆盖写入 M:\\DSH-T4\\scratch\\chain3.txt。报回两条真实回显，末尾单独一行写状态。不要动别的文件，不要派子代理。", name: "t3-a", label: "验证" },
  { id: "t3-b", prompt: "你是后继节点。先用 pwsh 读 M:\\DSH-T4\\scratch\\chain3.txt 的内容并记下真实回显，再执行 node -e \"console.log('t3-b-ok')\"。报回两条真实回显，末尾单独一行写状态。不要动别的文件，不要派子代理。", needs: ["t3-a"], name: "t3-b", label: "验证" }
])
```

**判据（读树 + 账本原文）**
- `task(action="list")` 里 `t3-a` 应 `completed`；`t3-b` 应变成 `in_progress` 并挂 child（说明后继被自动派出去）。
- `M:\DSH-T4\home\task-runs.json` 里 `t3-b` 应有 `"status":"dispatched"` 与 `childId`。
- 若 `t3-b` 仍是 `pending`：它的 detail 应出现 `派发失败：<原因>`（这就是「让它报出来」；没有这行说明重启后仍不是最新构建）。

### 探针 2：故意注入一次真实失败（证明「失败必进 detail」的可见性通道）

用**未知预设名**触发 `resolvePreset` 抛错（这一步在 `dispatchTo` 起孩子之前，**不占名册名额**）。
注意：队友名走 `slugMemberName` 归一，**故意写非法名字不会失败**，别用那条路。

```
task(action="run", run="probe-fail-1", nodes=[
  { id: "f-a", prompt: "执行 node -e \"console.log('f-a-ok')\"; 报回真实回显，末尾单独一行写状态。不要动别的文件，不要派子代理。", name: "f-a", label: "验证" },
  { id: "f-b", prompt: "这一条不应该被派出去。", needs: ["f-a"], preset: "no-such-preset", name: "f-b", label: "验证" }
])
```

**判据**：`f-a` 结算后，`f-b` 应保持 `pending`，且 detail 里出现 `派发失败：` 前缀 + `no-such-preset` 相关的原因；账本里 `f-b` 仍 `pending`。**若 detail 里没有这行** ⇒ 当前进程不是 14:33 那版构建，先查 `lib` 时间戳与宿主启动时间。

---

## 3c. 实施已完成（15:14，含槽位版修订）

| 文件 | 字节 | SHA256 |
|---|---|---|
| `src/index.ts` | 123652 | `B0358A29A8065877EC25AC489973F8AAEFF7856B8C1AC98E3C53EAE0863D7575` |
| `src/session-store.ts` | 31066 | `D9A0D3B94438179AE21578A5A679E78B35B8A1B210B69BD1B7ABD126D8FA23B2` |
| `tests/task.spec.ts` | 115813 | `E3B4DF9D6017A5572F752C7B6FA1AC8D1A7CA672C38F2E6918FBDF92FE74ABC4` |
| `lib/index.js` | 116724 | `EDBF6AA3197AA3068FBA667B4A137673144EC6BE1F1E09C634694774E888F424` |
| `lib/session-store.js` | 22774 | `CB6D6711BD6608EC0FD6B72BF949307470E0FE75F28F758EB96A3F867463B083` |

（这五个哈希由中枢自己 `Get-FileHash` 复核过，与实现者报的逐字一致。）

- 命令（实现者原始回显）：`npx tsc --noEmit` **exit 0**；`npm test` **99/99 pass / 0 fail**（87 既有 + 12 新增）**exit 0**；`npx tsc -b --force` **exit 0**；`npm run build` **exit 0**。
- 产物自证（中枢自己 grep 产物）：`lib/index.js` L378 `RUN_SLOT`、L402 `fillRunPrompt`、L850 `CONCISE_CONCLUSION_LINE`、L1645 `DISPATCHED_DETAIL_WITH_UPSTREAM`；**`diag` 命中 0**；`lib/session-store.js` L216/L240 槽位件、L76 `baseUrlDirectory`、L162 `note` 读回。
- 备份：`packages/task/_bak-upstream-20261001-150500\`（4 个文件，改前原样）。
- 已知的一处实现者自行判断（口径一致，但请知悉）：**>20000 字的截断对槽位填进去的文本同样生效**。

## 3d. 第二次重启后的收官验证（v-a → v-b，逐字照抄）

前置判据：重启后宿主进程启动时间必须**晚于** `lib/index.js` 的 mtime（15:14:12），否则新产物没装上。

```
task(action="run", run="verify-upstream-1", nodes=[
  { id: "v-a", name: "v-a", label: "验证",
    prompt: "用 pwsh 跑这两条并记下真实回显：① (Get-Item -LiteralPath 'M:\\dsh-plugins\\packages\\task\\lib\\index.js').Length ；② (Get-FileHash -LiteralPath 'M:\\dsh-plugins\\packages\\task\\lib\\index.js' -Algorithm SHA256).Hash 。结语**不要复述过程**，只用不超过 5 行写下这两个值。不要动别的文件，不要派子代理。" },
  { id: "v-b", name: "v-b", label: "验证", needs: ["v-a"],
    prompt: "你是执行节点。中枢给你的框架如下：\n\n——上游探查结论（直接用它，不要去重新采集）——\n{{v-a}}\n——上游结论结束——\n\n请照做：\n1. **逐字回引**上面「上游探查结论」那一段（原样贴一遍，一个字都不要改），这就是你收到的东西。\n2. 用 pwsh 对同一个文件重算一次 SHA256，贴真实回显，并说明它与上游给的哈希是否一致。\n不要动别的文件，不要派子代理。" }
])
```

**判据**
1. `task(action="list")`：v-a `completed`、v-b 被自动派出（`in_progress`/挂 child）——机制没退化。
2. v-b 的结语里**出现 v-a 报的那段文本（含它算出的哈希）** ⇒ 槽位 `{{v-a}}` 被就地填入且原文送达；再与 v-a 的结语比对该哈希**逐字一致**。
3. v-b 回引的第一行会是宿主那句 `Background subagent …`——因为 `settledNotice` 返回的是**整条结算消息正文**（含宿主摘要句与 `Its closing message:`）。这是已知冗余；若要去掉，是 `upstreamSection` 里一行的事。
4. §六 生效的话，**新账本落在 `M:\DSH-T4\home\profiles\desktop\task-runs.json`**（旧 `M:\DSH-T4\home\task-runs.json` 原样留着，未搬运）。这是推断，重启后必须实测确认。

---

## 3e. 收官链结果（15:19–15:24 实跑，第二次重启后）

宿主第二次重启：**15:18:36** 启动 > `lib/index.js` mtime **15:14:12** ⇒ 新产物已装上（旁证：工具 schema 里 `diag` 已消失）。

`task run verify-upstream-1`（v-a → v-b，v-b 的框架里写 `{{v-a}}`）返回 `dispatched: ["v-a"]`。
- v-a 结算后 **v-b 被自动派出**：树 `- [in_progress] v-b … (child 6a15a833-5514-4fe6-a63b-2c1f2bbeadd0)`；账本 `"status":"dispatched"` + 同 childId。
- **槽位替换的证据（v-b 自己逐字回引收到的那一段）**：
  ```
  ——上游探查结论（直接用它，不要去重新采集）——
  Background subagent b0a8502f-54de-43c6-88c9-681f4fc63e09 finished and will do no further work unless you send it more.
  Its closing message:
  Length：116724
  SHA256：EDBF6AA3197AA3068FBA667B4A137673144EC6BE1F1E09C634694774E888F424

  状态：完成
  长度 116724 字节；SHA256 = EDBF6AA3…E888F424。
  ——上游结论结束——
  ```
  ⇒ 框架原文（前后两行围栏句）原样保留，中间 `{{v-a}}` 被换成了**上游结算正文全文**。
- v-b 随后用 `Get-Item` + `Get-FileHash` **再**用 `certutil` 双工具重算，得到同一个哈希，判定「完全一致」。
- 终态：树上 v-a `completed`、v-b `completed`；账本两节点都 `completed`、`note` 为空（成功派发时清空，符合设计）。
- **§六 实测确认**：账本已落在 **`M:\DSH-T4\home\profiles\desktop\task-runs.json`**（1464 B / 15:19:19），旧 `M:\DSH-T4\home\task-runs.json`（5066 B / 14:59:26）原样留着、未搬运。
- `task list scope=tree` 现在会渲染非 completed 节点的 detail（实测能看到 `detail: 等待依赖：v-a`），可见性缺口已补。

**已知瑕疵（都不影响功能，供你决定要不要修）**
1. 槽位里填的是**整条结算正文**，所以带宿主的 `Background subagent …` 与 `Its closing message:` 两行，以及上游自己的 `状态：完成` 行——是噪声。去掉是一行改动（`upstreamSection` 里剥掉首行与 `Its closing message:`）。
2. 节点被派发后，树 detail 仍短暂显示声明期写的 `等待依赖：<x>`（`clearStaleDetail` 只认 `结论缺失：`/`派发失败：` 两个前缀）；结算时会被结论覆盖。
3. 故意注入失败的 `f-b`（probe-fail-1）会**永久停在 pending**：本会话之后每一次结算都会重新评估它、再失败一次、再写一遍同样的 detail。这是那条探针的性质，不是缺陷。

---

## 4. 之后的工作顺序（还没做）

1. **实施**（只动 `packages/task`；先备份 + `Get-FileHash` 逐字节核对）：
   - `dispatchRunNode`：派发前按 `needs` 声明顺序回读每个已完成依赖的**结算正文全文**（`settledNotice({ agent: parent }, childId)`，同一 childId 取**最新**一条）；把框架里的 `{{<depId>}}` **就地替换**成该依赖的结论文本，**没被槽位吃掉的**再按声明顺序追加成 `【上游结论】` 段；单条 >20000 字截断并注明。
   - 派发成功时，若节点 detail 仍停在此前的 `结论缺失：` / `派发失败：`，覆盖成 `已派发：上游结论已注入`（无上游时写 `已派发`）。
   - **取不到结论 ⇒ 不派发**：节点留 pending，detail 写 `结论缺失：<哪个依赖>`，账本节点也记原因。
   - **队友通道失败 ⇒ 不退回**：保持 pending，原因写进 detail 与账本（把现在只在宿主日志里的那一行变成可读的）。
   - §六：`ledgerPathFor` 优先 `ctx.baseUrl`（`file:///M:/DSH-T4/home/profiles/desktop/`），拿不到再退回环境变量。
   - 删掉临时 diag 分支（argue enum + 实现两处，`src/index.ts:1425/1512-1534`）。
   - 测试：`tests/task.spec.ts` 补回归（结论注入顺序/截断/缺失阻塞/名册满不退回）。
2. **构建**：`npx tsc -b --force` + `npm run build`（陷阱：`tsc -b` 会跳过重编译，必须 `--force`；构建后用「产物里搜得到新代码」验证）。
3. **真机验证**：再重启一次宿主，跑一条 A→B→C 链，读树 + 账本原文；贴上原始回显。
4. **收尾**：报 `lib` 字节数 + SHA256、每条命令真实退出码、哪些没做/判不了。

---

## 5. 环境陷阱（沿用，别踩）

1. `ctx.plugin()` 只排程、不激活 fiber、不会调 apply —— 拿它写探针的结论全是废的。
2. `lib/` 是独立构建的：测试走 `tsx` 读 `src`，探针/宿主走 `lib/`。
3. `tsc -b` 会因 `tsBuildInfoFile` 跳过重编译，收官一律 `--force`。
4. cordis 服务没进 `inject` 就不能读（读一下直接抛）；加服务前先想这条。
5. 宿主不落盘日志（`userdata\logs` 只有崩溃记录）⇒ 静默失败必须自己造可见性。
6. `npm run typecheck` 里 `tsconfig.test.json` 项目**改前就有 54 条错**，别当成本次引入的。
7. **硬约束**：不改 `M:\DSH-T4\home\profiles\desktop\cordis.patch.yml`（它自己会变）、不改 `M:\DSH-T4\home\.agent-presets\ptc-custom\agent.cordis.yml`、不改 `C:\Users\TRI\.dsh` 下任何文件、只动 `packages/task`。
8. 备份用 `Get-FileHash -LiteralPath`（不要 `.ExpandProperty('Hash')`——本机会 InvalidOperation 但退出码 0、哈希为空）。

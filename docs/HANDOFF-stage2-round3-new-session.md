# 交接：自动放行流水线 · 第三轮（**新会话**里做，名册清零才够位）

> 作者：中枢玖（会话 `session-ad7460f7-90f0-4582-9698-dc2e2fb9f755`，2026-10-01 15:50 前后）
> 前两份：`HANDOFF-auto-dispatch-stage2.md`（第 1 阶段与现场）、`HANDOFF-stage2-resume-after-restart.md`（第 2 阶段全过程）。
> 工作目录 `M:\DSH-T4`，插件仓 `M:\dsh-plugins`，只动 `packages/task`，Windows + pwsh，沙箱 danger-full-access。

---

## 0. 为什么要在**新会话**里做

名册上限是**每个 Lead 会话 8 名队友**（`agent-team-profile` bundle 设 `maxMembers: 8`），**只增不减、重启不重置、没有任何回收入口**。
旧会话已经用掉 7–8 格，**新会话的名册是从 0 开始的**，下面两个真机实验合计只要 6 格。

---

## 1. 现在在哪（一手）

### 1.1 代码与产物（第二轮已落地，中枢自己复核过哈希与测试）

| 文件 | 字节 | SHA256 |
|---|---|---|
| `packages/task/src/index.ts` | 128289 | `4F03DBC1D0D44C9C57CCB5518AE743BF62AF5B4F3B19038C9E7D209B723FC370` |
| `packages/task/src/session-store.ts` | 32876 | `39A47C50CFA059C29C1851448FEC40BE6406343665D3FD61B0574745509F87A2` |
| `packages/task/tests/task.spec.ts` | 125847 | `4173CEEC0DA20B437FEBC853F63731B4E9D6231A47097D9F66E0AE34B760E80A` |
| `packages/task/lib/index.js` | 120549 | `CBB2D2862B1CFB05223AF86F89A16A9E032E89CF62FFCD3763DD7BB4780B8574` |
| `packages/task/lib/session-store.js` | 23385 | `F2D0E838D4D96FE791CFF8723DF29D7E183DCDCE44914414F6B746F5C492B4E2` |

命令（中枢亲跑）：`npx tsc --noEmit` **exit 0**；`npm test` **104 tests / 104 pass / 0 fail**；实现者另跑 `npx tsc -b --force` exit 0、`npm run build` exit 0。备份 `packages/task/_bak-upstream-20261001-150500\`。

### 1.2 已实现的行为（口径都已由用户拍板）

- 节点 prompt = **中枢写的框架**，`{{<节点id>}}` **就地替换**成该依赖的结论正文；没被槽位吃掉的依赖按 `needs` 声明顺序追加成 `【上游结论】` 段；全被吃掉就不加。声明期就拒收「引用了不存在/不属于自己 needs 的槽位」。
- 「结语里给下游用的结论尽量简略（建议 ≤500 字）」这一句**只进 run 链路**的简报。
- **结论文本在结算时落进账本**（`RunNodeRecord.conclusion`，上限 20000、与注入同一个截断记号）；注入时**优先账本**，账本没有才退回会话历史 → 从此不怕上下文压缩。
- 取不到上游结论 ⇒ **阻塞**：节点留 `pending`，`结论缺失：…` 同时进树 detail 与账本 `note`。
- 队友通道失败 ⇒ **不退回直连**，原因同样进 detail 与账本 `note`。
- **新增显式重试入口**：`task(action="run", run="<已存在的 id>", retry=true)` —— 不写树、不重存账本、不重置已判终态的节点，只重评估这条 run 里「`pending` 且 `needs` 全 `completed`」的节点；run 不存在或同时给 `nodes` 都抛错；没有待办返回 `dispatched: []`。
- 账本文件已按 §六 挪到 **`M:\DSH-T4\home\profiles\desktop\task-runs.json`**（实测确认）；旧 `M:\DSH-T4\home\task-runs.json` 原样留着、未搬运。

### 1.3 还没验的（就是本轮的活）

① 三段链 A→B→C 的连续自动放行与两跳结论传递；② `retry` 入口在真机上「阻塞 → 修好 → 派出去」的全过程。
（③「名册满 → 停在 pending 并写明原因」旧会话会用掉最后一格来取证，若那份证据没拿到，本会话也可以补：把名册填到 8 再声明一个 run，起点就该失败。）

---

## 2. 实验一：三段链（名册 3 格）

```
task(action="run", run="chain3x", nodes=[
  { id: "x-a", name: "x-a", label: "验证",
    prompt: "用 pwsh 执行 `node -e "console.log('x-a-ok')"`，并在同一台机器上取一个可核对的常量：`(Get-Item -LiteralPath 'M:\\dsh-plugins\\packages\\task\\lib\\index.js').Length`。结语**不要复述过程**，≤5 行写下这两项。不要动别的文件，不要派子代理。" },
  { id: "x-b", name: "x-b", label: "验证", needs: ["x-a"],
    prompt: "框架如下：\n——上游 x-a 的结论（直接用它）——\n{{x-a}}\n——结束——\n请：① **逐字回引**上面整段；② 用 pwsh 复算一次 `node -e "console.log('x-b-ok')"` 贴回显。结语 ≤10 行。不要动别的文件，不要派子代理。" },
  { id: "x-c", name: "x-c", label: "验证", needs: ["x-b"],
    prompt: "框架如下：\n——上游 x-b 的结论（直接用它）——\n{{x-b}}\n——结束——\n请：① **逐字回引**上面整段（它里面应当嵌着 x-a 的数字 120549）；② 说明你从中间接拿到的 x-a 的 `Length` 是多少。结语 ≤10 行。不要动别的文件，不要派子代理。" }
])
```

**判据（全部要贴原始回显）**
1. `task run` 返回 `dispatched: ["x-a"]`；随后 **x-b、x-c 都被自动派出**（树里各自挂 child；账本里两条都走到 `completed` 且 `childId` 有值）。
2. **x-c 回引出的文本**里能同时看到 x-b 自己的回显与 **x-a 的 `Length`**（两跳传递成立）。
3. 账本原文里 `x-a`、`x-b` 两条节点记录都带 **`conclusion`** 字段，且 `x-a.conclusion` 里那段数字与 x-c 间接拿到的逐字一致 ⇒ 来源是账本。
4. 想更狠一点：在**声明 x-c 之前**先把 x-a 的结算正文从会话历史里弄不可读是不可能的（历史由宿主管），所以「历史没了也能拿到」这条**只由单测覆盖**（用例名：「历史里已无 child-1 通知，仍从账本取到」），真机不重复。

---

## 3. 实验二：`retry` 恢复全过程（名册 3 格）

> 前提：声明与手改期间**确保没有队友在跑**（否则账本的读-改-写会互相覆盖）。手改前先备份账本文件，改完逐字节核对。

1. 声明 `task(action="run", run="retry-test", nodes=[{id:"r-a", name:"r-a", label:"验证", prompt:"回一句 r-a-ok 就完事；结语 ≤3 行。不要派子代理。"},{id:"r-b", name:"r-b", label:"验证", needs:["r-a"], prompt:"回一句 r-b-ok 就完事；结语 ≤3 行。不要派子代理。"}])` → r-a 派出（**第 1 格**）→ 结算 → r-b 自动派出（**第 2 格**）→ 结算。两条都 `completed`。
2. 备份 `M:\DSH-T4\home\profiles\desktop\task-runs.json` → `_bak-retry-test-<时间戳>.json`，记下 r-a 的**真实 childId**。
3. 手改账本（这是**人为制造阻塞**的测试手段，请如实标注）：把 `r-b` 改回 `status: "pending"`、删掉它的 `childId`；把 `r-a` 的 `childId` 换成一个不存在的 uuid、删掉它的 `conclusion`。
4. `task(action="run", run="retry-test", retry=true)` ⇒ **r-b 必须保持 pending**，detail 与账本 `note` 出现 `结论缺失：依赖 r-a（child …）的结算正文在父会话历史里读不到`。**不占名额**（它没被派出去）。
5. 把 `r-a` 的 `childId` 改回**真实值**（`conclusion` 保持删除）→ 再 `retry` ⇒ 此时走**历史回退**，r-b 应被真正派出（**第 3 格**）并结算。
6. 贴：每一步的 `retry` 返回值、树 detail、账本原文片段（含 `note` 与 `conclusion`）。
7. 收尾：确认账本里 `retry-test` **只有一条** run（`retry` 绝不 `store`，`store` 是追加，会让同 id 重复累积）。

---

## 4. 实验三（可选）：名册满 → 停在 pending 并写明原因

把名册填到 8（`完成实验一/二后应当是 6/8，再派 2 个哑元队友`），然后声明一个 run：
```
task(action="run", run="roster-full-1", nodes=[
  { id: "rf-a", name: "rf-a", label: "验证", prompt: "回一句 rf-a-ok 就完事。" },
  { id: "rf-b", name: "rf-b", label: "验证", needs: ["rf-a"], prompt: "这一条应当因为名册满而派不出去。" }
])
```
**判据**：`rf-a` 派出去成为第 8 名（或第 9 名直接失败）；`rf-a` 结算后 `rf-b` 保持 `pending`，detail 与账本 `note` 出现 `派发失败：…Team member limit 8 reached` —— **这就是本次事故的原始路径第一次被现场抓住**。
再对它调一次 `retry` ⇒ 会**再失败一次并刷新 note**（证明重试入口真的重跑了评估；名册不可回收，所以它不可能靠 retry 自己恢复）。

---

## 5. 纪律（违反即事故）

1. **绝对不许改** `M:\DSH-T4\home\profiles\desktop\cordis.patch.yml`（它自己会变，任务树与设置持久化在里面）、`M:\DSH-T4\home\.agent-presets\ptc-custom\agent.cordis.yml`、`C:\Users\TRI\.dsh` 下任何文件。只动 `packages/task`。
2. 改 `lib` 必须 `npx tsc -b --force` + `npm run build` + **重启宿主**（宿主侧插件无模块级热重载；漏了 `--force` 会得到「build exit 0 但产物是旧的」）。
3. 宿主不落盘日志 ⇒ 任何静默失败都要自己造可见性；结论分三档写（有正面证据／有反面证据／判不了）。
4. 哈希一律 `(Get-FileHash -LiteralPath <p> -Algorithm SHA256).Hash`（不要 `.ExpandProperty('Hash')`：本机会 InvalidOperation 但退出码 0、哈希为空）。
5. 手改账本前必须备份并核对；改完贴原文。

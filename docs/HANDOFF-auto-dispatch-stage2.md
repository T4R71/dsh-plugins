# 交接：task 插件「自动放行流水线」（第二阶段）续做

你是玖，中枢身份。接着做 `M:\dsh-plugins\packages\task` 的**自动放行流水线**。
工作目录 `M:\DSH-T4`，插件仓 `M:\dsh-plugins`。Windows + pwsh，沙箱 danger-full-access。

---

## 一、当前进度（一手，都已验证）

### 已完成并落盘的

| 事项 | 状态 |
|---|---|
| 第 1 阶段：子代理结语回传 `状态：完成/失败` → 父树节点自动置 completed/failed（没报=failed） | ✅ 真机验证通过 |
| `task run` 动作：声明一条依赖流水线（校验 needs 存在性、id 查重、成环报错） | ✅ 真机通过，返回 `dispatched` 只有起点 |
| 后端账本：**插件自己的 JSON 文件**（`M:\DSH-T4\home\task-runs.json`），原子写（temp+rename） | ✅ 真机通过，文件内容可读可解析 |
| 结算监听里自动放行后继 | ❌ **没跑通**，见下 |

产物（重建后哈希）：`lib/index.js` 101252 / `DA1CD4EA7720D1D4AF7B9D0F2986D5FDD3CF3CE21002526948D66E86B425899A`；
`lib/session-store.js` 16628 / `E286B9B583212999A885884ED10C45F17C37036B9154902234CAF0D1003A3483`。
`npx tsc --noEmit`=0、`npm test`=87/87/0。

### 卡在哪

真机跑 `task run`（run id `probe-chain-2`，节点 `chain-a` → `chain-b`，`chain-b.needs=['chain-a']`）：

- `task run` 返回值正确：`dispatched: ["chain-a"]` ✅
- A 结算后：树上 `chain-a` = `completed` ✅、账本里 A = `completed` ✅
- **但 `chain-b` 仍是 `pending`、没有 `childId`** ❌ —— 后继没被自动派出去

排掉的可能：
- ~~`ctx.agents` 取不到~~ → 已加进 `inject`，诊断确认 `get(sid) -> live agent`
- ~~账本读不回来~~ → 诊断确认账本内容完整
- **剩下**：`dispatchRunNode` 在派发那一步抛了错，被 catch 回滚成 pending

### 本轮已修 + 留下的可见性

1. `export const inject = ['tools','subagents','userQuestions','systemPrompt','agents']`
   —— 之前漏了 `'agents'`，而 cordis **对没声明 inject 的服务读一下就抛**
   （`cannot get property "agents" without inject`），异常被「绝不抛」的 catch 吞成一行宿主日志。
   已补回归用例钉死。
2. `dispatchRunNode` 的 catch 现在**把失败原因写进那个节点的 detail**，前缀 `派发失败：`。
   为什么必须这么做：派发失败会回滚成 pending，与「依赖没满足」在面板上一模一样 —— 这个坑
   （诊断信息进了读不到的通道）本次踩了两次。
3. 临时诊断入口：`task(action="list", scope="diag")` → 返回 `ctx.agents` 是否在、`get(sid)` 结果、
   全部活 Agent id、账本文件路径与账本内容。**排查完请删掉这个分支**（argue enum 与实现两处）。

### 下一步的第一步（重启后立刻做）

重启宿主，然后重跑一条链（**用新的 run id 与节点 id**，避开树里前两轮的残留）：

```
task(action="run", run="probe-chain-3", nodes=[
  { id: "t3-a", prompt: "<随便一条一分钟能跑完的活>", name: "t3-a", label: "验证" },
  { id: "t3-b", prompt: "...", needs: ["t3-a"], name: "t3-b", label: "验证" },
])
```

等 A 结算，然后读树：**`t3-b` 的 detail 里应该出现 `派发失败：<原因>`**。那个原因就是根因。

### 一个具体怀疑（等它自己印证或推翻）

`list_agents` 现在**正好 9 个成员**（含 lead），交接文档写着名册上限 **8 人 + lead = 9 且不可回收**，
本次会话已派掉 5 个（`impl-status`/`impl-ui-failed`/`impl-runs-row`/`impl-auto-dispatch`/`status-probe*`）。
若上限判定把「已达上限」判死，`dispatchTo` 的第一条通道 `spawnTeammate` 会抛。
但 `dispatchTo` 里还有第二条通道（`ctx.subagents.startContinuable`），所以这**只解释为什么抛、
不解释为什么不退到第二条**。**不要猜，让它报出来。**

---

## 二、新需求：链式调用要传递上游结论

用户明确要求：**下游节点必须能拿到上游阶段的结论**，否则链式调用没有意义。

现状：`dispatchRunNode` 传给子代理的只有该节点自己的 `prompt`（账本里的原样文本），
上游的收尾结论**完全没有传下去**。

建议做法（可再议，但方向是这样）：
- 上游节点的结论**账本里已经有了**：结算时账本记录 status，但**没记结论文本** ——
  结论文本目前在树上（detail）、也在会话历史里（`task result` 能回读）。
- 派发后继时，把已 completed 的 `needs` 的结论拼进简报尾部。来源有二：
  1. 父树节点 detail（已被 `settlementPatch` 截到 200 字）—— 够用但短；
  2. 父会话历史里的结算消息（`settledNotice(session, childId)` 的正文）—— 完整。
- 设计要定的事：截断多少、用哪种来源、多个依赖怎么排、没拿到结论时是如实说明还是阻塞。
  这几条**先问用户**，别自己拍。

---

## 三、环境陷阱（踩过，别再踩）

1. **`ctx.plugin()` 只排程、不激活 fiber、不会调 apply**。我拿它写了四个子进程探针，
   结论**全是废的**。要复现宿主行为，要么走真 Loader，要么别用这条。
2. **`lib/` 是独立构建的**。测试走 `tsx` 读 `src`，探针/宿主走 `lib` —— 拿旧 `lib` 做探针会得到错误结论。
   改完必须 `npx tsc -b --force` 再 `npm run build`。
3. **`tsc -b` 会跳过重编译**：`tsconfig.json` 设了 `tsBuildInfoFile`；把源码换成旧 mtime 的文件后，
   增量判定认为「输入没变新」，tsdown 于是把过期中间产物重新打包，**build 仍然 exit 0**。
   收官一律 `tsc -b --force`，并用「产物里搜得到新代码」验证。
4. **cordis 服务没进 `inject` 就不能读**，读一下直接抛。加新服务前先想这一条。
5. **宿主不落盘日志**：`userdata\logs` 里只有崩溃记录。Loader 的装载错误、插件的 `logger.warn`
   **都读不到**。所以任何「静默失败」都必须自己想办法可见（本次的教训）。
6. `npm run typecheck` 里那个 `tsconfig.test.json` 项目**改前就不通过**（54 条既有错，`src` 侧 0 条）。
   别把它当成本次引入的。
7. 名册上限 8+1 且**不可回收**，重启不重置。

---

## 四、硬约束（违反即事故）

1. **绝对不许改** `M:\DSH-T4\home\profiles\desktop\cordis.patch.yml`
   —— ⚠️ **它自己会变**：任务树与设置持久化在里面，别误判成有人违规。
2. **绝对不许改** `M:\DSH-T4\home\.agent-presets\ptc-custom\agent.cordis.yml`。
3. **绝对不许改** `C:\Users\TRI\.dsh` 下任何文件。
4. 只动 `packages/task`。**不要动** `ui-task-tree`、`plan-tree`、`task-tree`。
5. 改活文件前先备份，用 `$a=(Get-FileHash -LiteralPath <p> -Algorithm SHA256).Hash` 逐字节核对
   （**不要**用 `.ExpandProperty('Hash')`——本机会 InvalidOperation 但退出码 0、哈希为空）。
6. **不许编造**哈希、字节数、回显、构建或验证结论。没跑就说没跑。
7. 结论分三档：有正面证据 / 有反面证据 / 判不了。

---

## 五、设计决定（用户已拍板，别改）

- **树是树，后端是后端**：依赖图、每步的 prompt、身份配置全在后端账本里；**树上只写 status 与 detail**，
  绝不加 `dependsOn` 之类的字段。判据是用户原话。
- **失败只停这一支**：某节点 failed 时，它的下游及其后代保持 pending，**平行分支照常推进**。
- **不通知中枢**：自动放行只写树与账本，绝不 `followup`/`inject`/发 `subagent-settled`。
- **账本落盘**：用插件自己的 JSON 文件（已实现），不走设置命名空间、不开新 Loader 行。
- 第 1 阶段的语义不许退化：**没收到状态回报 = failed**。

---

## 六、值得接着改的一件小事（未做，等你点头）

账本落在 `M:\DSH-T4\home\task-runs.json`，因为**宿主进程里没有 `DSH_PROFILE_DIR`**，
路径决议从 `DSH_PROFILE_DIR` 退到了 `DSH_HOME`。更合适的是装载时优先用 `ctx.baseUrl`（Loader 的
profile 基准），拿不到再退回环境变量。`ledgerPathFor(configured)` 是唯一决议点，改动很小。

---

## 七、收尾要求

- 每步跑完用 `task` 的 `step` 改节点状态，收工前不留 in_progress 节点。
- 真机验证要贴**原始回显**（树、账本文件内容），不要转述。
- 报告要写清楚：改了哪些文件 + 字节数 + SHA256；每条命令的真实退出码；
  哪些**没做**、哪些**判不了**。

# 交接：task 插件「状态回报 + 自动放行流水线」

你是玖，中枢身份。接手的是一份已完成大半的 DSH 插件改造，用户已明确敲定下一步方向。
工作目录 `M:\DSH-T4`，插件仓 `M:\dsh-plugins`。Windows + pwsh，沙箱已放开。

---

## 一、用户已敲定的设计（照着做，不要另起炉灶）

### 1. 状态由子代理「报」，不是「写」

**背景缺陷（已实测，一手证据）**：`withNodeBrief` 现在告诉子代理
「干完时你必须自己用 task 工具的 step 把节点置 completed」。**这句话做不到。**
实测报错：

```
task(action="step", node="live", status="completed")
→ ToolCallError: task-tree: no node with id "live" in this session's tree
```

根因：树按 `sessionId` 隔离。`bind` 写的节点只在**父会话**的树里，子代理的树里没有它。

**用户裁定的解法**：不要试图给子代理跨会话写树的权限，改走**回传**——
派发时在简报里要求子代理**在结语里必须原样输出一行状态**：

```
状态：完成
```
或
```
状态：失败
```

插件在**结算监听**里解析这一行，自己落到父树的节点上。链接就接上了。

**三档判定（用户明确要求）**：

| 子代理报了什么 | 节点置为 | detail |
|---|---|---|
| `状态：完成` | `completed` | 状态行 + 摘要（截断） |
| `状态：失败` | `failed` | 状态行 + 理由 |
| **没报 / 被强停 / 格式不对** | **`failed`** | `未收到状态回报` |

⚠️ **「没报 = 失败」是用户点名的设计**，绝不允许把「没消息」当成功放过去。

### 2. 落点

- 监听：`ctx.on('session/event', …)`，筛 `event.type === 'user/message'` 且
  `data.source?.kind === 'subagent-settled'`，`data.source.senderSessionId` 就是子会话 id。
- 取正文：代码里**已有**现成函数 `settledNotice(exec, childId)`（约 L1464，`result` 动作在用它），
  它读父会话派生历史里那条结算消息。
- 节点定位：在父会话树里找 `assignedTo === childId` 的节点。
- **失败判定必须查实宿主的结算消息形状**（是否含机器可读的失败/中断字段），查不到就
  一律按「未收到状态回报」处理并在 detail 里注明来源，**不许编造失败判定**。

### 3. 输出长度受控（用户要求）

detail 只写**状态 + 一句话摘要**，上限约 200 字，完整结语**不进树**。

### 4. 成功结果「截流」（用户已确认可做）

- 成功 → 存档进 detail，**不主动上报中枢**；
- 完整结语留在会话历史里，**随时可按需回读**（`task result`）；
- 回到中枢只有三种：**报错/强停**、**子代理显式说做不到/缺前提**、**它要用户拍板（提问）**。

### 5. 第二阶段：自动放行流水线（等第 1 步验证通过再做）

`plan` 一次写全链路，节点用 `dependsOn` 表达顺序；某节点结算且**状态=完成、无异常**时，
程序自动派发其后继，**不通知中枢**。

⚠️ **依赖关系**：这一阶段的**地基就是第 1 步**——程序必须知道「上一节点干完了没有」。
没有状态回报，自动放行无从谈起。**顺序不能反。**

---

## 二、已完成并验证的改动（不要再动，除非发现真 bug）

### `packages/task`
| 文件 | 字节 | SHA-256 |
|---|---|---|
| `src/index.ts` | 83049 | `ACDA674F19EF605284F1AE49FD3937DF8ABFDBA088F513F9FE1BACA037C6D836` |
| `tests/task.spec.ts` | 56852 | `787D6EDB9AD9117608B116BE69E4F5FFD0C3A50226919BEF150C5B0DE6D64DA7` |
| `tests/ask-proxy.spec.ts` | 11473 | `D0B2FA7527697C33273640286ACB6AC8D12F25F88E8B96CC303174CB4E5E0424` |
| `lib/index.js` | 65068 | `078507EEBE7401C5742CBBF0DACA2BB9970E1F46DD20B53D5524D66E5969B419` |

改动：
1. **删掉「把子代理决策搬进父会话树」的写入**——`carryDecisions` 与 `askedRecords` 全删，
   连带那条 `session/event` 结算监听器。`port.step` 调用点 1→0（写入路径净减少）。
2. **决策段改读合并视图**：`renderDecisions` 用 `port.readMerged(sid, DECISION_MERGE_DEPTH)`，
   `DECISION_MERGE_DEPTH = MAX_DELEGATION_DEPTH`（=3，委派硬上限），
   并且**必须递归铺平**（`flattenNodes`）才找得到——合并视图把子会话树挂在派发节点的
   `children` 上。端口没有 `readMerged` 时退回 `read(sid)`。
3. **子代理侧节点标题加 `[<label>]` 前缀**（`installAskProxy` 写进子代理自己树的那条）；
   `task` 工具的 `ask` 动作（提问者自己问）**不加**。

验证：`npx tsc --noEmit` exit 0；`npm test` **65/65/0**；`npm run build` exit 0 且**重跑产物哈希逐字可复现**。
鉴别力：把读合并视图改回 `read(sid)` → 2 条红。

### `packages/ui-task-tree`
| 文件 | 字节 | SHA-256 |
|---|---|---|
| `src/client/plan-tree-data.ts` | 13518 | `2F455D0482E600A06E9F187CF0ADBF0D5370DD91245E0C504FC23948D2F8151F` |
| `tests/merge-and-teammate-status.spec.ts` | 11332 | `0CB8D7DD65564F3C135723B8F9149661B0FFA35789954611F58BA354A6F5DFBD` |
| `lib/client.js` | 54218 | `8A919BFE8BAD48B67646819B5C3A1A5577F4298514C77A7857FCBD388CA3404E` |

改动：`mergedTreeOf` 拼接子树前整棵按**来源会话 id** 改名（`renameSubtree`，前缀 `<会话id>:`），
于是合并结果里 id 全局唯一；**根会话自己的 id 逐字不动**，`assignedTo` 保留（它是会话 id），
`dependsOn` 同前缀改名。

**修的是什么 bug**：面板把同一行画了 5 遍。根因是合并后出现两个 id 都叫 `ask-1` 的节点，
而 `TaskListView.tsx:140` 是 `rows.map(row => <Row key={row.id} …/>)`——同列表 key 重复，
React 协调错乱，多余 DOM 行留在页面上。

验证：`npm test` **68/68/0**；`tsc -b` exit 0；`build` exit 0。
鉴别力：阉割改名 → **6 条红（含回归用例）**；还原后哈希与实验前逐字相同。

---

## 三、硬约束（违反即事故）

1. **绝对不许改** `M:\DSH-T4\home\profiles\desktop\cordis.patch.yml`。
   ⚠️ 注意：**它自己会变**——任务树持久化在它的 `plan-tree-sessions` 命名空间里（`trees` 字段）。
   我从未写过它，别误判成有人违规。
2. **绝对不许改** `M:\DSH-T4\home\.agent-presets\ptc-custom\agent.cordis.yml`。
3. **绝对不许改** `C:\Users\TRI\.dsh` 下任何文件。
4. **改任何活文件前先备份，并用 sha256 逐字节核对备份本身**。这台机器出现过
   `Copy-Item` 静默失败却照常打印哈希的情况；`(Get-FileHash …).ExpandProperty('Hash')`
   也不是方法（会 `InvalidOperation` 但退出码 0、哈希为空）。用 `$a=(Get-FileHash …).Hash`。
5. **不许编造**哈希、字节数、回显、构建或验证结论。没跑就说没跑。
6. 结论分三档：**有正面证据 / 有反面证据 / 判不了**。

## 四、环境陷阱（踩过，别再踩）

- **插件加载时实例化，改动必须重启宿主才生效。** 加载链：
  `cordis.patch.yml:138` → `node_modules\@t4r71\dsh-task`（**Junction**）→ `M:\dsh-plugins\packages\task`。
  重启即加载新 `lib/`，不需要复制文件。
- **Agent Teams 名册上限 8 人（含 lead 共 9）且不可回收**，没有解散成员的工具。
  **重启不会重置它。** 派不出子代理时就是被它卡住了，此时自己动手，别空等。
- **树按 `sessionId` 隔离**：父写的节点子看不到，这是上面第 1 节那个缺陷的根因。
- 客户端解析节点语义看的是 **detail 前缀**（`答：`/`死因：`/`注：`/`归并：`/`结：`，见
  `ui-task-tree/src/client/semantics.ts` 的 `kindOf`），**不看 id**——所以改 id 是安全的。
- `ui-task-tree` 客户端产物由 `npm run build` 生成到 `lib/client.js`；改了客户端源码必须重新构建。
- 本机**没有** yaml 解析库（node 与 python 都没有）。要解析 `cordis.patch.yml` 得自己按缩进写。

## 五、下一步该做的

**先做第 1 节（状态回报），做完让用户重启验证；通过后再做第 2 节（自动放行流水线）。**

具体改动面：
1. `packages/task/src/index.ts`：重写 `withNodeBrief` 文案（改成要求结语带 `状态：完成|失败`）；
   恢复一条 `session/event` 结算监听：解析状态行 → 找 `assignedTo === childId` 的节点 →
   `step` 置 `completed`/`failed` + 截断 detail（≤200 字）；没解析到就按 `failed` +
   `未收到状态回报`。
2. 测试：三条分支（完成/失败/没报）**各一条用例**，并**证明鉴别力**
   （阉割解析逻辑要能看到「没报」那条变红），贴真实回显。
3. 跑 `npx tsc --noEmit`、`npm test`、`npm run build`，报告退出码与产物哈希。
4. 让用户重启，现场验证：派一个子代理 → 节点应自动从 `in_progress` 变成
   `completed`/`failed`，detail 里有状态与摘要。

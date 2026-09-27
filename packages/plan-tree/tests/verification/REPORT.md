# task-7 对抗性核验报告：plan-tree 四工具与 schema 边界

核验者：task-07（对抗性核验者，独立于实现者与 Lead）
工作目录：`M:\dsh`　文件策略：danger-full-access　审批：已关闭

## 复现命令

```
npx vitest run packages/plan/plan-tree
npx tsc --noEmit -p packages/plan/plan-tree/tsconfig.json
npx tsx scripts/gen-persistence-catalog.ts --check
```

## 最终状态

| 项 | 结果 |
|---|---|
| `npx vitest run packages/plan/plan-tree` | **9 files / 79 tests 全绿** |
| `npx tsc --noEmit -p packages/plan/plan-tree/tsconfig.json` | **exit 0** |
| `npx tsx scripts/gen-persistence-catalog.ts --check` | **exit 1（stale，未修复）** |

核验文件全部位于 `packages/plan/plan-tree/tests/verification/`，未修改 `src/` 下任何文件，未使用 `any` / `as any` / `@ts-ignore`。

## 逐条判定

| # | 主张 | 判定 |
|---|---|---|
| 1 | 8 层被拒、3 层通过；`MAX_NODE_SCHEMA_DEPTH=6` | **证实**（边界精确为 6 接受 / 7 拒绝） |
| 2 | 未携带 `assignedTo` 的 `plan/step` 保留既有归属；`answer` 同理 | **证实**（曾发现清除路径缺失，**已修复**） |
| 3 | `plan_ask` 服务缺失时保持 `blocked` 且不静默成功 | **证实**（含 4 个额外反例） |
| 4 | 软依赖不引入 agent-team 依赖 | **证实** |
| 5 | `planNodeSchema` 同步三个新字段 | **证实**（但原始验证方法无效，见下） |
| 6 | `plan_dispatch` 两条错误路径抛错 | **证实**（含 2 个额外反例） |

## 关键发现（实现者盲区）

### A. `plan_step` 静默丢弃 `assignedTo`/`answer`（已修复）

事件类型 `src/types.ts:74` 声明了 `assignedTo?`/`answer?`，但工具参数 schema 只声明 `["id","status"]`。实测：

- `validateJsonSchemaValue(plan_step.parameters, {id,status,assignedTo})` → **`[]`（零违规）**
- `ctx.tools.execute('plan_step', {..., assignedTo:'worker-x'})` → **`isError=false`**
- 落盘事件为 `{"id":"a","status":"in_progress"}` — **字段消失**

即调用者被告知成功，字段却被丢弃。修复后（`src/index.ts:573-645`）参数已声明且 `execute` 真实读取，三个断言全部转为通过。

### B. 归属只能设、不能清（已修复）

`applyStep` 原为二态（仅 `undefined` 保留）。修复后为三态：缺省保留、非空设置、**空串清除**（`src/index.ts:165-172`，空串存为字段缺失而非空字符串）。已加两个测试覆盖 set/clear。

### C. 我自己的验证方法一度无效（重要方法论发现）

首版主张 5 的测试经 `ctx.sessionProjections.stateOf()` 读取，**该路径不跑 `viewSchema.parse`**。我用一个未声明字段 `bogusField` 做对照，它**存活**了 —— 证明那批测试对 schema 同步毫无证明力。

真正跑 parse 的是两条路径，均已单独覆盖：
- 监听路径：`session-projection/src/index.ts:692`（需 `onChanged` 订阅 + 显式 emit `session/event`）
- 恢复路径：`session-projection/src/index.ts:533`（`restore()`）

在真实 parse 路径上，`bogusField` **被剥掉**，而 `task`/`assignedTo`/`answer` **全部存活** → 主张 5 成立，且这次是有敏感度对照的成立。

### D. `plan_dispatch` 失败路径与孤儿任务（已修复）

修复前实测：`createTask` 成功 1 次 → `sendMessage` 失败 → `isError=true`，计划**未移动**（`node.status=pending`，`plan/step` 事件 0 条）—— 无「in_progress 但没人收到」。**但已创建的 Team 任务成为孤儿**，无任何补偿调用（`updateTask`=0，`deleteTask`=0）。

修复后实测补偿生效：

```
[ATOM-orphan] created = ["task-1"]
[ATOM-orphan] compensating updateTask calls = 1
[ATOM-orphan] compensating actions = ["delete:task-1"]
[ATOM-compfail] isError=true error={"message":"DELIVERY-FAILED"}   # 补偿失败不掩盖原始错误
[ATOM-nocomp] isError=true                                          # updateTask 缺失仍干净失败
```

### E. `plan_write` 重复调用静默销毁计划（未修复，破坏性语义）

证实 Lead 的观察，并补充三点：

1. 14 节点树 → 8 节点重声明后，**前树整棵消失**（含子节点 `child-a`）。
2. 重列父节点但不带 `children` → 子结构**丢失而非合并**。
3. 重声明还会**回滚 `plan_step` 记录的进度**（`completed` → `pending`）。
4. 返回值仅 `{total, counts}`，**没有任何字段或警告**提示发生了破坏性覆盖。
5. 作用域限定在同一 session（进程内 registry 无跨 session 泄漏）；但 `plan_ask` 也发**全量快照**，其「读-改-写」之间若插入并发 `plan_write`，该写入会被覆盖 —— 竞态面真实存在。

## 未修复风险清单

1. **持久化目录过期**（`gen-persistence-catalog --check` exit 1）：`docs/persistence-catalog.md:706` 仍写 `'plan/step': { id: string; status: PlanStatus }`，而源码 `types.ts:74` 已是 `{ id; status; assignedTo?; answer? }`。这是 CI 门禁（`scripts/run-gates.ts:754` 的 `persistence-catalog`，属 `doc-sync`）。`plan/declared`/`PlanNode` 的文档条目也缺三个字段。需跑 `pnpm run gen-persistence-catalog` 并提交。
2. **`plan_step` 无 `additionalProperties: false`**：`plan_write` 的节点 schema 会拒绝未声明属性，但 `plan_step` 不会。拼错的参数（如 `assignedtoo`）被静默接受并忽略，调用者仍收到成功。已加测试记录该残余风险。
3. **`plan_write` 破坏性语义无警示**（发现 E）。
4. **`plan_dispatch` 降级路径**：`teammate` 给了但无 Team 服务时，节点仍转 `in_progress` 且无归属 —— 即注释所称「不会出现的 in_progress 但没人」在降级路径下**确实会出现**（`[ATOM-degrade] node.status=in_progress assignedTo=undefined`）。返回值不含 `dispatchedTo`，但计划面板会显示无人认领的进行中节点。
5. **`dependsOn` 自依赖被静默丢弃**：`toPlanNodes` 过滤自边（`src/index.ts:267`），既不报错也不保留。`assertDependenciesResolve` 因此永不面对自依赖。属设计选择，但「静默」而非「拒绝」值得注意。

## 构建事实（陷阱核实）

`packages/plan/plan-tree/tsdown.config.ts` **确认不存在**（`glob` 无匹配 + `Test-Path` 为假），而仓库根 `tsdown.config.ts` 存在。因此 `npx tsdown --config packages/plan/plan-tree/tsdown.config.ts` 会向上 discovery 落到根配置，执行**全 workspace 构建**而非单包构建。本次核验以 `npx tsc --noEmit -p packages/plan/plan-tree/tsconfig.json`（exit 0）为准，未跑仓库级构建。

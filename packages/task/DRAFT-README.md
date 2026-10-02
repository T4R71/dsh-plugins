# `packages/task` 草稿（暂存目录，尚未落入仓）

**为什么在仓外**：`packages/plan-tree` 与 `packages/ui-task-tree` 正由子代理 R2 实施数据通道迁移，
为避免同抢文件，本包先写在这里。R2 收工后整体移入 `M:\dsh-plugins\packages\task\`。

## 这是什么

② 的交付物：**一等 `task` 工具**。它取代九件工具——delegation 五件套
（`subagent` / `subagent_fork` / `list_agents` / `send_message` / `interrupt_agent`）
与任务树四件套（`plan_write` / `plan_step` / `plan_ask` / `plan_dispatch`）。

## 已经写好的

| 文件 | 内容 |
|---|---|
| `package.json` | 包清单：peers `cordis ^4.0.4` / `dsh-subagent ^0.1.7-rc.2` / `dsh-tools ^0.1.7-rc.2`（AGENTS.md 要求范围写法）、`publishConfig`、带 `directory` 的 `repository`、`dsh.bundle.patch` |
| ~~`cordis.patch.yml`~~ | **2026-09-30 已删除**：本包不再自带 Loader 行，也不再作为可独立启停的组合包出现。row id `task` 的插入交给 `@t4r71/dsh-task-tree` 整包（那一包里写着「把宿主投影行、浏览器面板行与任务工具作为一层整体启停」），它同时仍是本行 Config 的设置命名空间（预设表存这里） |
| `src/presets.ts` | **预设表**：预设名 → persona + `{allow,deny}` + maxDepth；含两个具名错误类 |
| `src/index.ts` | 插件本体：`Config`、`TaskTreePort`、扁平节点类型、以及**实测过的 schema**（2,354 字符）与 `dispatch` 分支的完整实现 |

## 关键设计决定（都有据）

1. **预设名必须自建表**。`SubagentStartRequest`（`dsh-subagent/lib/typert.host.js:779`）没有 `preset` 槽，
   只有 `persona` 与 `toolFilter`。内置 `tool-subagent` 也是这么干的，区别只在它的这两个字段挂在**行配置**上、
   每行只能给一套，而本包把它们提到**逐次可选的预设名**上。
2. **派发配方逐字对齐内置实现**（`dsh-tool-subagent/lib/index.js:509-532`）：
   `parent = exec.agent`（缺席即抛）、`persona`/`toolFilter`/`maxDepth` 平铺进 request、
   再包成 `{ provider, label, request, signal }` 交给 `ctx.subagents.startContinuable()`，返回 `{childId}`。
3. **查不到预设名一律抛错**，不静默退化成「继承父」——那会把一次笔误变成一次权限提升。
   省略预设名而继承父是允许的，但那是模型**显式**选择的结果，不是兜底。
4. **树的状态不在本包**。通过 `taskTree` 服务拿 plan-tree 的 store；服务缺席时树类动作**明确报错**。
5. **schema 里的 `nodes.items.additionalProperties: false` 是必须的**，漏了 `defineTool` 直接抛 `JsonSchemaError`。

## 落进仓之前必须先做的一件事

**`packages/plan-tree` 需要把 store `provide` 成服务**（约三行）：在它的 `apply` 里
`ctx.provide('taskTree', store)`（或等价的带命名空间的注册），否则本包的 `tree()` 永远抛错。
R2 目前的实现是**模块导出**（`planTreeStore(ctx): PlanTreeStore`，见 `plan-tree/src/session-store.ts:467`），
**没有 `provide`**——这一条是对它的小增补，不推翻它的设计。

服务面收窄成四个方法（`read` / `write` / `step` / `bind`），见 `src/index.ts` 的 `TaskTreePort`。

## 还没写的

- `apply` 里七个 action 的实现：`plan` / `step` / `ask` / `list` / `result` / `send` / `interrupt`。
  目前只有 `dispatch` 是完整的，其余走 `default` 抛「not implemented yet」。
- 构建配置三件套（从 `packages/idle-guard/` 机械照抄）：`tsconfig.base.json` / `tsconfig.json` /
  `tsconfig.test.json` / `tsdown.config.ts`。
- `tests/task.spec.ts`：至少覆盖「查不到的预设名抛错」「空围栏抛错」「dispatch 组装的 request 形状」。
- **未编译、未跑测、未冷装**。本目录里的代码**一行都没有被构建过**，不许当成已验证。

## schema 的来源

`src/index.ts` 里 `parameters` 与 `output.schema` 的两段描述文字，与已实测的 2,354 字符版本**逐字相同**
（`M:\T4\out\probe-tool\index.js`）。改任何一句描述都要**重测**，否则 `E1` §9 的账作废。

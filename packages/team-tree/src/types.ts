/**
 * Agent Teams → 任务树 的单向投影。
 *
 * ## 为什么是**独立插件**，而不是塞进 plan-tree 或 task
 *
 * Cordis 的 `inject` 是硬声明：没 inject 就 `ctx.<service>` 抛
 * "cannot get property without inject"，**整个插件挂载失败**。
 *
 * `plan-tree` 的 inject 是 `['tools','systemPrompt']`，并且注释写明它**故意**不 inject
 * `settings`——它必须能在一个根本没装 settings 的组合里正常工作。若给它加上
 * `agentTeams`，plan-tree 就**强依赖**实验性的 Agent Teams：没装 Team 的环境里它直接挂掉。
 *
 * 所以本包把这份依赖单独承载：`inject: ['agentTeams', 'taskTree']`。
 * 没装 Team 或没装树，本包不挂载，而另外两个包各自照常。
 *
 * ## 投影是**读时**的，不是写时的
 *
 * 树是持久真相，teammate 状态是实时事实，两者的更新频率完全不同（一个跟着工作走，
 * 一个跟着 turn 走）。若在状态变化时写树，每次 turn 抖动都要写一次 settings 文档，
 * 而且会污染"树 = 工作记录"这个语义——树里会混进大量机器生成的噪声。
 *
 * 因此本包**只读不写**：它把两侧读出来，合成一个带 teammate 状态的视图交给调用方。
 * 存储一个字节都不动，撤销本插件不会留下任何痕迹。
 *
 * ## inactive **不是** completed
 *
 * DSH 自己的措辞："inactive means no turn is executing; it does not describe task
 * completion, success, failure, or waiting for other agents."
 *
 * 所以本包**绝不**把 inactive 映射成 completed。一个 teammate 没在跑，可能因为它干完了，
 * 也可能因为它在等人、或者它刚被创建还没开工。把这两件事混为一谈，树就会说谎。
 * 本包只投影 running/inactive/provisioning/failed 这四个**运行时**事实，
 * 工作状态（completed/failed）仍然只由显式的 `task step` 决定。
 *
 * @module @t4r71/dsh-team-tree
 */

/** Cordis 插件名。 */
export const name = 'team-tree'

/**
 * 本包需要的服务。两个都是**硬依赖**——缺任一，本包不挂载，而不是退化运行：
 * 一个读不到 teammate 投影的空实现只会让调用方以为"这个团队真的没人"。
 */
export const inject = ['agentTeams', 'taskTree']

/** teammate 行，与 Agent Teams 的 roster 逐字对应。 */
export interface MemberRow {
  /** teammate 的 agent id，也就是它自己那棵树的会话 id。 */
  readonly id: string
  /** 团队内的名字（Lead 恒为 "lead"）。 */
  readonly name: string
  /** lead 或 teammate。 */
  readonly role: 'lead' | 'teammate'
  /** 运行时状态。**不含**工作是否完成。 */
  readonly status: 'running' | 'inactive' | 'provisioning' | 'failed'
  /** 创建时给的职责说明。 */
  readonly description?: string
}

/** 树上被认领的节点：哪个节点挂了哪个 teammate。 */
export interface ClaimedNode {
  /** 树里的节点 id。 */
  readonly nodeId: string
  /** 该节点派给的那个 teammate 名。 */
  readonly member: MemberRow
}

/** 回填后的视图：树 + 每个节点的 teammate 状态。 */
export interface TeamTreeView {
  /** 认领关系，按树的遍历顺序。 */
  readonly claims: readonly ClaimedNode[]
  /** teammate 名 → 状态，供渲染层直接查。 */
  readonly byName: Readonly<Record<string, MemberRow['status']>>
}

/** 本插件的行配置：留空——本包没有任何可配的东西，它只是一条只读投影。 */
export interface Config {}

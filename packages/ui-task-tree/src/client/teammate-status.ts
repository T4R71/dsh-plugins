/**
 * 队友状态：把 Agent Teams 的 roster 投影折成一张「assignedTo → 名字 · 状态」的字典。
 *
 * 单独一个模块，理由与 `plan-tree-data.ts` 一样：它必须能在**不被 React 与 store 污染**
 * 的程序里逐个用例地钉住。面板只负责把 store 里的三样东西取出来喂给它。
 *
 * 状态公式逐字照抄宿主（`@deepseek-ai/dsh-experimental-client-ui-agent-team/lib/client.js`）：
 *   const status = member.phase === 'active'
 *     ? ((running ?? summaryRunning) === true ? 'running' : 'inactive')
 *     : member.phase;
 *
 * 于是：phase 只有 provisioning / active / failed 三个，running / inactive 是**会话**状态。
 * **inactive 绝不能算成 completed** —— 一个队友没在跑，可能因为它干完了，也可能因为它在等人、
 * 或者刚被创建还没开工。把它读成「完成」，树就会说谎。
 *
 * 名册只贡献**名字**（与 phase 那道门槛）：状态那一半本来就与名册无关，用的是会话状态表。
 * 直连子代理（`ctx.subagents.startContinuable`）不写名册，投影里根本没有它那一行 ——
 * 那种行改走 {@link ownerBadgesWithFallback} 的兜底：名字取**节点 id**，状态走同一条公式。
 *
 * @module @t4r71/dsh-ui-task-tree/client/teammate-status
 */

/** 行尾能出现的四个状态词，逐字显示，一个都不翻译、不改写。 */
export type OwnerStatus = 'running' | 'inactive' | 'provisioning' | 'failed'

/** Agent Teams 投影里的一行成员（`agentTeam.members` 的元素形状）。 */
export interface TeamMemberLike {
  readonly id: string
  readonly name: string
  readonly role: 'lead' | 'teammate'
  readonly phase: 'provisioning' | 'active' | 'failed'
}

/** 本模块要用到的投影切片；整个投影缺席时传 undefined。 */
export interface TeamProjectionLike {
  readonly members: readonly TeamMemberLike[]
}

/**
 * 一个节点的行尾标记：名字与运行时的状态。
 *
 * 没有 role 字段 —— 用户要的形态是 `(名字 · 状态)`，role 由名字表达：lead 那一行
 * 在投影里名字恒为 `"lead"`（宿主 `buildTeamProjection` 写的）。
 */
export interface OwnerBadge {
  readonly name: string
  readonly status: OwnerStatus
}

/** assignedTo → 标记。 */
export type OwnerBadgeIndex = Readonly<Record<string, OwnerBadge>>

/** 状态是不是四个合法词之一（投影是不可信输入）。 */
function isPhase(value: unknown): value is TeamMemberLike['phase'] {
  return value === 'provisioning' || value === 'active' || value === 'failed'
}

/** 取值是否为可枚举的普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读一行成员，形状不可读时返回 undefined。
 * @param value - 不可信取值
 * @returns 校验后的成员，或 undefined
 */
function memberOf(value: unknown): TeamMemberLike | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.id !== 'string' || value.id === '') return undefined
  if (typeof value.name !== 'string') return undefined
  if (value.role !== 'lead' && value.role !== 'teammate') return undefined
  if (!isPhase(value.phase)) return undefined
  return { id: value.id, name: value.name, role: value.role, phase: value.phase }
}

/**
 * 一个队友当刻该显示的状态 —— 宿主那条公式，逐字。
 * @param member - roster 行
 * @param running - `useSessionStatus` 表里这一行的 running；没有基线时 undefined
 * @param summaryRunning - `useSessions` 列表里这一行的 running；没有这一行时 undefined
 * @returns running / inactive / provisioning / failed 之一
 */
export function ownerStatusOf(
  member: TeamMemberLike,
  running: boolean | undefined,
  summaryRunning: boolean | undefined,
): OwnerStatus {
  if (member.phase !== 'active') return member.phase
  return (running ?? summaryRunning) === true ? 'running' : 'inactive'
}

/**
 * 把整张 roster 折成一张按 **成员 id** 索引的字典。
 *
 * 键是 id 而不是名字：节点上的 `assignedTo` 记的是子会话 id，也就是成员 id
 * （宿主 `buildTeamProjection` 里 `id: rootId` / `id: member.id`）。名字只是显示用的。
 *
 * 投影整个缺席（这个 profile 没装 Agent Teams 那一行）时返回**空字典**：面板因此照旧
 * 显示 `@childId`，而不是编一个状态出来。
 * @param team - `agentTeam` 投影；缺席时 undefined
 * @param runningById - `useSessionStatus` 的整张表折成的纯字典
 * @param summaryRunningById - `useSessions` 的 `byId` 折成的纯字典
 * @returns assignedTo → 名字 · 状态
 */
export function ownerBadgesOf(
  team: TeamProjectionLike | undefined,
  runningById: Readonly<Record<string, boolean | undefined>>,
  summaryRunningById: Readonly<Record<string, boolean | undefined>>,
): OwnerBadgeIndex {
  const out: Record<string, OwnerBadge> = {}
  if (team === undefined || !Array.isArray(team.members)) return out
  for (const raw of team.members) {
    const member = memberOf(raw)
    if (member === undefined) continue
    out[member.id] = {
      name: member.name,
      status: ownerStatusOf(member, runningById[member.id], summaryRunningById[member.id]),
    }
  }
  return out
}

/** 树上一行里兜底要用的三个字段；刻意不是 `TreeNode` —— 本模块不吃树与 React 的依赖。 */
export interface TreeNodeLike {
  readonly id: string
  readonly assignedTo?: string | undefined
  readonly children?: readonly TreeNodeLike[] | undefined
}

/**
 * 一行**兜底**标记：roster 投影里查不到这个 `assignedTo` 时用它。
 *
 * 名字取**节点 id**（树上那个值：稳定，且与用户看得见的那一行一致），状态走
 * {@link ownerStatusOf} 的**同一条公式** —— 合成员 phase 恒为 `'active'`，于是这条公式
 * 只可能给出 running / inactive：**provisioning / failed 是名册才有的 phase，这条路编不出来**。
 * 合成员的两个 id 字段不参与状态计算（公式只读 phase），写成节点 id / 子会话 id 是为了形状不歪。
 * @param nodeId - 节点 id，兜底时当名字用
 * @param assignedTo - 节点记着的子会话 id，也就是会话状态表的键
 * @param running - `useSessionStatus` 表里这一行的 running；没有基线时 undefined
 * @param summaryRunning - `useSessions` 列表里这一行的 running；没有这一行时 undefined
 * @returns 名字 · 状态
 */
export function fallbackOwnerOf(
  nodeId: string,
  assignedTo: string,
  running: boolean | undefined,
  summaryRunning: boolean | undefined,
): OwnerBadge {
  return {
    name: nodeId,
    status: ownerStatusOf({ id: assignedTo, name: nodeId, role: 'teammate', phase: 'active' }, running, summaryRunning),
  }
}

/**
 * 面板要的那张字典：roster 认得出来的行照旧，**投影里查不到的 assignedTo** 补一行兜底。
 *
 * 三种情形分得很清，一种都不许混：
 *   1. roster 有这一行 —— 名字与状态逐字来自 roster（走 {@link ownerBadgesOf}，一个字节不动）；
 *   2. 投影**整个缺席**（这份 profile 没装 Agent Teams）—— 一条都不补，面板照旧显示 `@childId`。
 *      「这里没有名册」与「名册里没有这个人」是两件事：前者是那件东西不存在，
 *      后者才是「名册之外还有子代理」——直连通道
 *      （`ctx.subagents.startContinuable`，不写名册）走的正是后者；
 *   3. 投影在、这一行查不到 —— 兜底，见 {@link fallbackOwnerOf}。
 * @param team - `agentTeam` 投影；缺席时 undefined
 * @param nodes - 树上的节点；只有带非空 `assignedTo` 的才参与，孩子递归算进来
 * @param runningById - `useSessionStatus` 的整张表折成的纯字典
 * @param summaryRunningById - `useSessions` 的 `byId` 折成的纯字典
 * @returns assignedTo → 名字 · 状态
 */
export function ownerBadgesWithFallback(
  team: TeamProjectionLike | undefined,
  nodes: readonly TreeNodeLike[],
  runningById: Readonly<Record<string, boolean | undefined>>,
  summaryRunningById: Readonly<Record<string, boolean | undefined>>,
): OwnerBadgeIndex {
  const out: Record<string, OwnerBadge> = { ...ownerBadgesOf(team, runningById, summaryRunningById) }
  // 投影缺席：一条都不补 —— 没有名册可查，与「名册里查不到」不是同一件事。
  if (team === undefined || !Array.isArray(team.members)) return out
  const visit = (rows: readonly TreeNodeLike[]): void => {
    for (const row of rows) {
      const assignedTo = row.assignedTo
      // 空串不是会话 id：留着 `@`，不编一个名字出来。
      if (typeof assignedTo === 'string' && assignedTo !== '' && out[assignedTo] === undefined) {
        out[assignedTo] = fallbackOwnerOf(row.id, assignedTo, runningById[assignedTo], summaryRunningById[assignedTo])
      }
      visit(row.children ?? [])
    }
  }
  visit(nodes)
  return out
}

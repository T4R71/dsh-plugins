/**
 * 回填实现：把 Agent Teams 的 roster 投影到任务树的节点上。
 *
 * @module @t4r71/dsh-team-tree
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ClaimedNode, Config, MemberRow, TeamTreeView } from './types.ts'
import { inject, name } from './types.ts'

export { inject, name }
export type { ClaimedNode, Config, MemberRow, TeamTreeView }

/** 树上一条节点所需的最小形状（结构声明，避免反向依赖 plan-tree）。 */
interface TreeNodeLike {
  readonly id: string
  readonly title: string
  readonly assignedTo?: string
  readonly children?: readonly TreeNodeLike[]
}

/** 本包要用到的那部分 task 树服务。 */
interface TaskTreeLike {
  read(sessionId: string): readonly TreeNodeLike[]
}

/** 本包要用到的那部分 Agent Teams 服务。 */
interface AgentTeamsLike {
  listMembers(agent: unknown): readonly MemberRow[]
}

/**
 * 把 roster 按名字索引起来。
 *
 * Lead 也在里面——它同样是一个"正在跑的东西"，渲染层需要能查到它的状态。
 * @param members - roster 行。
 * @returns 名字 → 行。
 */
function indexByName(members: readonly MemberRow[]): Readonly<Record<string, MemberRow>> {
  const by: Record<string, MemberRow> = {}
  for (const m of members) by[m.name] = m
  return by
}

/**
 * 深度优先收集树里所有"派出去过"的节点，按树的顺序。
 *
 * 只有带了 `assignedTo` 的节点才是一条认领记录：没派过活的节点不属于任何 teammate，
 * 它由主代理自己推进。
 * @param nodes - 树的根列表。
 * @param out - 收集用的累加器。
 */
function collectClaims(nodes: readonly TreeNodeLike[], out: string[]): void {
  for (const node of nodes) {
    if (node.assignedTo !== undefined && node.assignedTo !== '') out.push(node.assignedTo)
    if (node.children !== undefined) collectClaims(node.children, out)
  }
}

/**
 * 把 node 上记录的 child id 对应到 roster 里的一行。
 *
 * 用 **id** 而不是名字去匹配：`bind` 记下的就是子会话的 agent id，而名字是 Team 层
 * 后来才有的概念，两者不是同一个键。名字只在找不到 id 时做一次兜底，因为早期派发的
 * 子代理没有名字，却可能有一个恰好等于其名字的 id 被写进来。
 * @param members - roster。
 * @param byName - 名字索引。
 * @param assignedTo - 节点上记的 child id。
 * @returns 匹配到的行，或 undefined。
 */
function resolveMember(
  members: readonly MemberRow[],
  byName: Readonly<Record<string, MemberRow>>,
  assignedTo: string,
): MemberRow | undefined {
  const byId = members.find((m) => m.id === assignedTo)
  if (byId !== undefined) return byId
  return byName[assignedTo]
}

/**
 * 建立"哪个节点挂了哪个 teammate"的映射。
 * @param tree - 任务树的根列表。
 * @param members - roster。
 * @returns 认领记录，按树的遍历顺序。
 */
export function projectClaims(
  tree: readonly TreeNodeLike[],
  members: readonly MemberRow[],
): readonly ClaimedNode[] {
  const byName = indexByName(members)
  const ids: string[] = []
  collectClaims(tree, ids)
  const claims: ClaimedNode[] = []
  const walk = (nodes: readonly TreeNodeLike[]): void => {
    for (const node of nodes) {
      const assigned = node.assignedTo
      if (assigned !== undefined && assigned !== '') {
        const member = resolveMember(members, byName, assigned)
        if (member !== undefined) claims.push({ nodeId: node.id, member })
      }
      if (node.children !== undefined) walk(node.children)
    }
  }
  walk(tree)
  return claims
}

/**
 * 读出一份"树 + teammate 状态"的合并视图。
 *
 * **只读**：既不写树，也不改 teammate。撤销本插件不会留下任何痕迹。
 * @param tree - task 树服务。
 * @param teams - Agent Teams 服务。
 * @param agent - 调用方（Lead）Agent，roster 的可见性由它决定。
 * @param sessionId - 根会话 id，也就是树的主键。
 * @returns 合并视图。
 */
export function readTeamTree(
  tree: TaskTreeLike,
  teams: AgentTeamsLike,
  agent: unknown,
  sessionId: string,
): TeamTreeView {
  const nodes = tree.read(sessionId)
  const members = teams.listMembers(agent)
  const claims = projectClaims(nodes, members)
  const byName: Record<string, MemberRow['status']> = {}
  for (const m of members) byName[m.name] = m.status
  return { claims, byName }
}

/**
 * 挂载本插件。
 *
 * 本插件**不注册任何工具**：它只在 ctx 上暴露一个只读服务 `teamTree`，
 * 由渲染层或上层工具按需取用。理由是这个投影没有任何"副作用语义"——
 * 它是一个查询，不是一个动作；包成工具只会让模型多一个要选的东西，
 * 而它真正该出现的地方是树的渲染路径上。
 * @param ctx - Cordis 上下文。
 */
export function apply(ctx: Context, _config: Config): void {
  const expose = {
    /**
     * 取一份合并视图。
     * @param agent - 调用方 Agent。
     * @param sessionId - 根会话 id。
     * @returns 树与 teammate 状态的合并视图。
     */
    view(agent: unknown, sessionId: string): TeamTreeView {
      const tree = ctx.get('taskTree') as TaskTreeLike | undefined
      const teams = ctx.get('agentTeams') as AgentTeamsLike | undefined
      if (tree === undefined || teams === undefined) {
        return { claims: [], byName: {} }
      }
      return readTeamTree(tree, teams, agent, sessionId)
    },
  }
  ctx.set('teamTree', expose)
}

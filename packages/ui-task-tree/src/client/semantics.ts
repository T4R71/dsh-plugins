/**
 * 树节点的扩展语义。
 *
 * 为什么不用独立字段：宿主的 plan_write 用 additionalProperties: false 校验，
 * 只接受 id/title/status/detail/task/assignedTo/dependsOn/children —— 多一个字段直接被拒。
 * 所以呈现语义必须由 detail 承载，面板再解析回来。
 *
 * 约定（写在 detail 开头，可省）：
 *   死因：<为什么走不通>   → 这条线死了，原因是引号里的话
 *   答：<用户的回答>       → 用户问答节点
 *   注：<补充信息>         → 补充信息节点
 *   归并：<说明>           → 几条线在此汇合
 *   结：<说明>             → 最终结果节点
 *
 * 人写的普通 detail 不受影响，原样当副标题显示。
 */

/** 节点的呈现种类。 */
export type NodeKind = 'step' | 'note' | 'merge' | 'result'

/** 这条线是活着还是死了。 */
export type NodeLife = 'alive' | 'done' | 'dead' | 'orphan'

/** 宿主允许的四种状态。 */
export type NodeStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

/** 树节点：宿主 PlanNode 的形状（多一个字段都会被 plan_write 拒绝）。 */
export interface TreeNode {
  id: string
  title: string
  status: NodeStatus
  detail?: string | undefined
  task?: string | undefined
  assignedTo?: string | undefined
  dependsOn?: string[] | undefined
  children?: TreeNode[] | undefined
}

/** detail 里能被识别的语义前缀。 */
const PREFIXES = ['死因：', '答：', '注：', '归并：', '结：'] as const
type Prefix = (typeof PREFIXES)[number]

/** 解析 detail：取出语义前缀与剩下的正文。 */
function parse(detail: string | undefined): { prefix: Prefix | ''; body: string } {
  const d = (detail ?? '').trim()
  for (const p of PREFIXES) {
    if (d.startsWith(p)) return { prefix: p, body: d.slice(p.length).trim() }
  }
  return { prefix: '', body: d }
}

/**
 * 推断一个节点的生命状态。
 * @param node - 树节点
 * @param upstreamDead - 祖先里有没有已经走不通的
 * @returns 生命状态
 */
export function lifeOf(node: TreeNode, upstreamDead: boolean): NodeLife {
  const { prefix } = parse(node.detail)
  if (node.status === 'completed') return 'done'
  if (node.status === 'blocked' || prefix === '死因：') return 'dead'
  if (upstreamDead) return 'orphan'
  return 'alive'
}

/**
 * 死因：detail 里的「死因：」优先，其次整条 detail，最后给一句兜底。
 * 不允许空着 —— 看不到为什么死，用户就只能猜。
 * @param node - 树节点
 * @returns 可直接显示的死因
 */
export function deathReason(node: TreeNode): string {
  const { prefix, body } = parse(node.detail)
  if (prefix === '死因：' && body) return body
  if (body) return body
  return '未记录原因'
}

/**
 * 节点的呈现种类：先看 detail 前缀，再按状态回退。
 * @param node - 树节点
 * @param life - 已算出的生命状态
 * @returns 呈现种类
 */
export function kindOf(node: TreeNode, life: NodeLife): NodeKind {
  const { prefix } = parse(node.detail)
  if (prefix === '答：' || prefix === '注：') return 'note'
  if (prefix === '归并：') return 'merge'
  if (prefix === '结：') return 'result'
  if (life === 'done' && (node.children ?? []).length === 0) return 'result'
  return 'step'
}

/**
 * 副标题：去掉语义前缀后剩下的话；用户问答与死因有自己的位置，不重复显示。
 * @param node - 树节点
 * @returns 副标题文本，没有就返回空串
 */
export function subtitleOf(node: TreeNode): string {
  const { prefix, body } = parse(node.detail)
  // 死因与回答各有专属位置，不在副标题里重复一遍。
  if (prefix === '死因：' || prefix === '答：') return ''
  return body
}

/**
 * 用户问答的正文（只有「答：」节点有）。
 * @param node - 树节点
 * @returns 回答文本，没有就返回空串
 */
export function answerOf(node: TreeNode): string {
  const { prefix, body } = parse(node.detail)
  return prefix === '答：' ? body : ''
}

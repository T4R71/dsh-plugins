/**
 * 大纲数据层：把树摊成一串行，一行一个节点，层级靠缩进表达。
 *
 * 结构形状（与用户约定的一致）：
 *   计划            第 0 层 —— 中枢定义的整个目标
 *     功能块        第 1 层 —— 中枢按功能拆出来的大块
 *       代理执行项   第 2 层 —— 一个功能块并行丢给几个代理，行尾写是谁
 *         内部阶段   第 3 层 —— 代理自己绘制的工作阶段，默认收起、可展开
 *
 * 纯计算，不碰 DOM。折叠语义：折叠的节点，其子树整段隐藏。
 */
import { lifeOf, deathReason, kindOf, subtitleOf, answerOf, type TreeNode } from './semantics.ts'

/** 大纲里的一行 = 一个节点。 */
export interface OutlineRow {
  id: string
  title: string
  status: string
  life: string
  kind: string
  /** 层级，缩进宽度由它决定。 */
  depth: number
  /** 后面还有同级兄弟 —— 视图据此画一根淡虚线，把同一层的节点连起来。 */
  link: boolean
  /** 有子节点才可以展开/折叠。 */
  hasChildren: boolean
  /** 子节点当前是不是被藏起来了。 */
  collapsed: boolean
  detail?: string | undefined
  reason?: string | undefined
  answer?: string | undefined
  assignedTo?: string | undefined
}

/** 四种状态的计数。 */
export interface StatusCounts {
  pending: number
  in_progress: number
  completed: number
  blocked: number
}

/** 状态的固定顺序：越需要注意越靠前。 */
export const STATUS_KEYS = ['blocked', 'in_progress', 'pending', 'completed'] as const

/** 四种状态的字符。只有这四种，别的信息一律走圆形符号或样式。 */
const STATE_GLYPH: Record<string, string> = {
  pending: '○',
  in_progress: '●',
  completed: '✓',
  blocked: '✗',
}

/**
 * 这一行是不是用户问答节点（视图据此换成问号圆环）。
 * @param row - 大纲里的一行
 * @returns 是问答就 true
 */
export function isNote(row: OutlineRow): boolean {
  return row.kind === 'note'
}

/**
 * 数一数一组行里四种状态各多少。
 * @param rows - 要数的行
 * @returns 四种状态的计数
 */
export function tallyRows(rows: readonly OutlineRow[]): StatusCounts {
  const out: StatusCounts = { pending: 0, in_progress: 0, completed: 0, blocked: 0 }
  for (const r of rows) {
    if (isStatus(r.status)) out[r.status] += 1
  }
  return out
}

/**
 * 数一整棵树（不管折叠）。顶部总览那行用它。
 * @param roots - 根节点数组
 * @returns 四种状态的计数
 */
export function tallyTree(roots: readonly TreeNode[]): StatusCounts {
  const out: StatusCounts = { pending: 0, in_progress: 0, completed: 0, blocked: 0 }
  const visit = (node: TreeNode): void => {
    if (isStatus(node.status)) out[node.status] += 1
    for (const k of node.children ?? []) visit(k)
  }
  for (const r of roots) visit(r)
  return out
}

/** 宿主状态是不是那四种之一。 */
function isStatus(s: string): s is keyof StatusCounts {
  return s === 'pending' || s === 'in_progress' || s === 'completed' || s === 'blocked'
}

/**
 * 把计数压成一行字符，零的不显示。
 * @param counts - 四种状态的计数
 * @returns 形如 '✓3 ●1 ✗1' 的短标签
 */
export function countsLabel(counts: StatusCounts): string {
  const parts: string[] = []
  for (const k of STATUS_KEYS) {
    const n = counts[k]
    if (n > 0) parts.push(STATE_GLYPH[k] + ' ' + n)
  }
  return parts.join('   ')
}

/** 代理内部阶段从第几层开始默认收起。 */
const INTERNAL_FROM_DEPTH = 3

/**
 * 哪些节点默认折叠：
 *   1. 走不通的分支 —— 子树已经作废，收起来；
 *   2. 代理内部阶段（第 3 层及更深）—— 需要时再展开。
 * @param roots - 根节点数组
 * @returns 默认折叠的 id 集合
 */
export function defaultCollapsed(roots: readonly TreeNode[]): Set<string> {
  const out = new Set<string>()
  const visit = (node: TreeNode, depth: number, upstreamDead: boolean): void => {
    const life = lifeOf(node, upstreamDead)
    const kids = node.children ?? []
    if (kids.length > 0 && (life === 'dead' || life === 'orphan' || depth >= INTERNAL_FROM_DEPTH)) {
      out.add(node.id)
    }
    for (const k of kids) visit(k, depth + 1, upstreamDead || life === 'dead')
  }
  for (const r of roots) visit(r, 0, false)
  return out
}

/**
 * 摊平成大纲。深度优先，一个节点一行，顺序就是阅读顺序。
 * @param roots - 根节点数组
 * @param collapsed - 已被用户折叠的 id 集合
 * @returns 行数组
 */
export function buildOutline(roots: readonly TreeNode[], collapsed: ReadonlySet<string>): OutlineRow[] {
  const rows: OutlineRow[] = []
  const visit = (node: TreeNode, depth: number, upstreamDead: boolean, link: boolean): void => {
    const life = lifeOf(node, upstreamDead)
    const kids = node.children ?? []
    const isCollapsed = collapsed.has(node.id)
    const detail = subtitleOf(node)
    const answer = answerOf(node)
    rows.push({
      id: node.id, title: node.title, status: node.status, life, kind: kindOf(node, life),
      depth, link, hasChildren: kids.length > 0, collapsed: isCollapsed,
      ...(detail ? { detail } : {}),
      // 只有自己走不通才写原因；「上游已死」是别人的原因，由样式（变淡+划掉）表达，
      // 在这里硬塞一句「未记录原因」反而是假的。
      ...(life === 'dead' ? { reason: deathReason(node) } : {}),
      ...(answer ? { answer } : {}),
      ...(node.assignedTo !== undefined ? { assignedTo: node.assignedTo } : {}),
    })
    if (isCollapsed) return
    for (let i = 0; i < kids.length; i++) {
      visit(kids[i]!, depth + 1, upstreamDead || life === 'dead', i < kids.length - 1)
    }
  }
  for (const r of roots) visit(r, 0, false, false)
  return rows
}

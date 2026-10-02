/**
 * 任务树在配置文档里的形状，以及按会话 id 取值的纯读取。
 *
 * 单独一个模块，唯一的理由是它必须能在**不被 store 依赖污染**的程序里被直接测到：
 * 宿主半边把它存进自有的设置命名空间 \`plan-tree-sessions\`，字段 \`trees\` 是
 * 「会话 id → 树」的字典（见 \`@t4r71/dsh-plan-tree/session-store\`）。这里没有任何
 * React、cordis 或 store 依赖，所以判定逻辑可以逐个用例地钉住。
 *
 * 文档是**不可信输入**：人可能手改过 settings.yaml，别的进程也可能刚好写过。于是一条
 * 读不动的记录被**丢掉**，而不是让整份文档作废 —— 宿主半边的 \`parsePlanTreesField\`
 * 是同一条规则，两侧因此对「哪条会话有树」永远给同一个答案。
 *
 * @module @t4r71/dsh-ui-task-tree/client/plan-tree-data
 */

/** 本包读取的设置命名空间，与宿主 \`session-store.ts\` 的常量一字不差。 */
export const PLAN_TREE_NAMESPACE = 'plan-tree-sessions'

/** 该命名空间里唯一那个字段：会话 id → 树。 */
export const PLAN_TREE_FIELD = 'trees'

/** 宿主允许的四种状态。 */
export type PlanStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

/** 树节点：宿主 \`PlanNode\` 的形状。 */
export interface PlanNode {
  id: string
  title: string
  status: PlanStatus
  detail?: string | undefined
  task?: string | undefined
  assignedTo?: string | undefined
  dependsOn?: string[] | undefined
  children?: PlanNode[] | undefined
}

/** \`trees\` 字段的三种状态。 */
export type PlanTreesSection =
  /** 有这份文档，字段也读得动（可能是空对象：还没有任何会话声明过计划）。 */
  | { readonly kind: 'parsed'; readonly records: Readonly<Record<string, readonly PlanNode[]>> }
  /** 文档在，但字段读不动 —— 不是「没有计划」，是「不知道」。 */
  | { readonly kind: 'unreadable' }

/**
 * 这条会话的树，以及那份取值的来源。
 *
 * 返回的永远是三态而不是「有/没有」：没有记录与读不到文档是两件事 —— 前者宿主那边
 * 也确实没有树（面板显示空态是实话），后者本进程没有任何可声称的值（必须如实说
 * 不知道，而不是画一棵空树冒充「没有计划」）。
 */
export type PlanTreeView =
  | { readonly state: 'record'; readonly roots: readonly PlanNode[] }
  | { readonly state: 'empty' }
  | { readonly state: 'unreadable' }

/** 取值是否为可枚举的普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取值是否为四种合法状态之一。 */
function isStatus(value: unknown): value is PlanStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'blocked'
}

/**
 * 读一个存储节点，形状不可读时返回 undefined。
 * @param value - 不可信节点
 * @returns 校验后的节点，或 undefined
 */
function planNodeOf(value: unknown): PlanNode | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.id !== 'string' || value.id === '') return undefined
  if (typeof value.title !== 'string') return undefined
  if (!isStatus(value.status)) return undefined
  const node: PlanNode = { id: value.id, title: value.title, status: value.status }
  if (typeof value.detail === 'string') node.detail = value.detail
  if (typeof value.task === 'string') node.task = value.task
  if (typeof value.assignedTo === 'string') node.assignedTo = value.assignedTo
  if (Array.isArray(value.dependsOn) && value.dependsOn.every(dep => typeof dep === 'string')) {
    node.dependsOn = [...value.dependsOn as string[]]
  }
  // 空 children 视为叶子：宿主也用「省略或空」表示叶子，多一个空数组只会让
  // 「有没有孩子」这件事出现两种写法。
  if (Array.isArray(value.children) && value.children.length > 0) {
    const children: PlanNode[] = []
    for (const child of value.children) {
      const parsed = planNodeOf(child)
      if (parsed === undefined) return undefined
      children.push(parsed)
    }
    node.children = children
  }
  return node
}

/**
 * 从一份不可信字段值里解出「会话 id → 树」。
 *
 * 一条记录读不动就丢掉它，不影响别的会话；整个字段不是对象则整份读不动。
 * @param value - 不可信字段值
 * @returns 可读记录，或「读不动」
 */
export function planTreesSectionOf(value: unknown): PlanTreesSection {
  if (!isRecord(value)) return { kind: 'unreadable' }
  const records: Record<string, readonly PlanNode[]> = {}
  for (const [sessionId, raw] of Object.entries(value)) {
    if (!Array.isArray(raw)) continue
    const nodes: PlanNode[] = []
    let readable = true
    for (const item of raw) {
      const node = planNodeOf(item)
      if (node === undefined) {
        readable = false
        break
      }
      nodes.push(node)
    }
    if (readable) records[sessionId] = nodes
  }
  return { kind: 'parsed', records }
}

/**
 * 命名空间行在文档里的形状，只取本包要用的两个字段。
 * 与 \`@deepseek-ai/dsh-client-ui-settings\` 的 \`SettingsNamespaceView\` 结构兼容。
 */
export interface PlanTreeNamespaceView {
  readonly ns: string
  readonly value: unknown
}

/**
 * 从整份 describe 文档里取出本包那个命名空间里的 \`trees\` 字段。
 *
 * 命名空间**缺席**与字段**读不动**都归入 \`unreadable\`：两者都不能推出「这条会话
 * 没有计划」。而命名空间在、字段是 \`{}\` 则是实打实的空 —— 那份文档确实说
 * 「还没有任何会话声明过计划」。
 * @param namespaces - describe 镜像里的命名空间行；镜像还没有答案时 undefined
 * @param ns - 本包的命名空间名
 * @param field - 命名空间里承载树的那个字段名
 * @returns 字段的三种状态
 */
export function planTreesOf(
  namespaces: readonly PlanTreeNamespaceView[] | undefined,
  ns: string,
  field: string,
): PlanTreesSection {
  if (namespaces === undefined) return { kind: 'unreadable' }
  const row = namespaces.find(candidate => candidate.ns === ns)
  if (row === undefined || !isRecord(row.value)) return { kind: 'unreadable' }
  return planTreesSectionOf(row.value[field])
}

/**
 * 一条会话的树。
 * @param section - \`trees\` 字段的三种状态
 * @param sessionId - 会话 id
 * @returns 该会话的树，没有记录时 undefined
 */
export function planTreeOf(section: PlanTreesSection, sessionId: string): readonly PlanNode[] | undefined {
  if (section.kind !== 'parsed') return undefined
  return section.records[sessionId]
}
/**
 * 某个节点的子树要不要往下拼。
 *
 * 「没有记录」与「读不到文档」都算没有：两种情况下本进程都不知道那个会话写过什么，
 * 能诚实表达的就只有「这里没有东西可拼」。
 * @param section - `trees` 字段的三种状态
 * @param assignedTo - 节点上记的子会话 id
 * @returns 子会话那棵树，没有时 undefined
 */
function subTreeOf(section: PlanTreesSection, assignedTo: string | undefined): readonly PlanNode[] | undefined {
  if (section.kind !== 'parsed') return undefined
  if (assignedTo === undefined || assignedTo === '') return undefined
  return section.records[assignedTo]
}

/**
 * 深拷贝一棵树：合并**不改动入参**，面板拿到的永远是一份自有的值。
 * @param node - 要拷贝的节点
 * @returns 拷贝出的新节点
 */
function cloneNode(node: PlanNode): PlanNode {
  const copy: PlanNode = { id: node.id, title: node.title, status: node.status }
  if (node.detail !== undefined) copy.detail = node.detail
  if (node.task !== undefined) copy.task = node.task
  if (node.assignedTo !== undefined) copy.assignedTo = node.assignedTo
  if (node.dependsOn !== undefined) copy.dependsOn = [...node.dependsOn]
  if (node.children !== undefined) copy.children = node.children.map(cloneNode)
  return copy
}

/**
 * 深拷贝一棵**将要被拼进来的**子树，并把每个节点的 id 改写成 `<来源会话id>:<原id>`。
 *
 * 为什么必须改名：合并结果是「本会话那棵树」与「被派发的子会话自己写的树」的并集，
 * 两边各有自己的命名空间，同名 id（最典型的是两边各有一条 `ask-1`）在合并结果里会撞车。
 * 撞车的代价落在 React 上：`TaskListView` 用 `key={row.id}`，键一重复协调就错乱，
 * 多出来的行留在页面上 —— 面板上表现为同一行被画了好几遍。
 *
 * 改名的边界（逐条钉死）：
 *   - **只有拼进来的子树改名**：本会话自己的节点一个字节都不动；
 *   - 前缀是**来源会话 id**，每一层拼进来的子树用它自己那一层来源会话的 id，
 *     不层层套娃（孙会话的树用孙会话的 id，不是「子前缀 + 孙前缀」）；
 *   - `assignedTo` 是**会话 id**不是节点 id：原样保留，改了下一层就找不到了；
 *   - `dependsOn` 指向同树内的兄弟节点 id：跟着同一前缀改名，保持数据自洽。
 * @param node - 子会话树里的一个节点
 * @param prefix - 来源会话 id
 * @returns 改过名的深拷贝
 */
function renameSubtree(node: PlanNode, prefix: string): PlanNode {
  const copy: PlanNode = { id: `${prefix}:${node.id}`, title: node.title, status: node.status }
  if (node.detail !== undefined) copy.detail = node.detail
  if (node.task !== undefined) copy.task = node.task
  if (node.assignedTo !== undefined) copy.assignedTo = node.assignedTo
  if (node.dependsOn !== undefined) copy.dependsOn = node.dependsOn.map(dep => `${prefix}:${dep}`)
  if (node.children !== undefined) copy.children = node.children.map(kid => renameSubtree(kid, prefix))
  return copy
}

/**
 * 读取侧合并：把被派发的子会话自己写的树，拼到记着 `assignedTo` 的那个节点下面。
 *
 * 语义与宿主 `readMerged`（`packages/plan-tree/src/task-tree.ts`）逐条对齐，两件事分开做 ——
 * 混在一起就会把子树的嵌套结构铺平：
 *
 *   deepen —— 在【已嵌套】的节点上继续往下拼更深的委派层，形状不动；
 *   splice —— 只在【顶层列表】上做一次，把被派发的那个子会话整棵树挂上去。
 *
 * `maxDepth` 是「还要往下拼几层」：用尽之后保持原样，不再往下看。
 * 「子代理没留下树」不是错误 —— 读不到就是没有，节点原样留着。
 *
 * 命名空间：本会话那棵树的 id **逐字不动**；拼进来的每一层子树在挂上去之前按**来源会话
 * id** 整棵改名（`renameSubtree`），于是合并结果里 id 全局唯一 —— 父子两边各有一条
 * `ask-1` 不会再撞成同一个 key。
 *
 * 纯函数：不碰 store、不碰 React，也不回写任何东西。**入参一个字节都不改**：
 * 整棵树先深拷贝，再在拷贝上拼。
 * @param section - `trees` 字段的三种状态
 * @param sessionId - 根会话 id
 * @param maxDepth - 还要往下拼几层；面板用 2（主代理 → 子代理 → 孙代理）
 * @returns 合并后的树；这条会话没有记录时 undefined
 */
export function mergedTreeOf(
  section: PlanTreesSection,
  sessionId: string,
  maxDepth: number,
): readonly PlanNode[] | undefined {
  const roots = planTreeOf(section, sessionId)
  if (roots === undefined) return undefined
  const deepen = (node: PlanNode, depth: number): PlanNode => {
    const copy = cloneNode(node)
    const own = node.children === undefined ? [] : node.children.map(kid => deepen(kid, depth))
    const from = node.assignedTo
    const sub = depth <= 0 ? undefined : subTreeOf(section, from)
    if (from === undefined || sub === undefined) {
      if (own.length > 0) copy.children = own
      else delete copy.children
      return copy
    }
    // 子会话那棵树整体挂在这个节点下面，它自己的嵌套原样带过来，绝不铺平。
    // 挂上去之前按**来源会话 id**（`from` 是会话 id，不是节点 id，所以它自己不改名）
    // 把整棵子树改名：两棵树各自的命名空间到此为止，合并结果里 id 不会撞车。
    const grafted = sub.map(kid => deepen(renameSubtree(kid, from), depth - 1))
    return { ...copy, children: [...own, ...grafted] }
  }
  return roots.map(node => deepen(node, maxDepth))
}

/**
 * 这条会话当刻该显示的树 —— 面板看到的三态。
 *
 * 放在纯模块里而不是目录类里：判定与「跟随镜像」是两件事，前者要能在**不被 store
 * 依赖污染**的程序里逐个用例地钉住。
 * @param namespaces - describe 镜像里的命名空间行；镜像还没有答案时 undefined
 * @param sessionId - 当前会话 id；没有选中会话时是 undefined
 * @returns 三态取值：有记录 / 没有记录 / 读不到文档
 */
export function planTreeView(
  namespaces: readonly PlanTreeNamespaceView[] | undefined,
  sessionId: string | undefined,
): PlanTreeView {
  const section = planTreesOf(namespaces, PLAN_TREE_NAMESPACE, PLAN_TREE_FIELD)
  if (section.kind === 'unreadable') return { state: 'unreadable' }
  if (sessionId === undefined) return { state: 'empty' }
  const roots = planTreeOf(section, sessionId)
  if (roots === undefined) return { state: 'empty' }
  return { state: 'record', roots }
}

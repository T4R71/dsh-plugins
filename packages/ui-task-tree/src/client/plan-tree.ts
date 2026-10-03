/**
 * 任务树在客户端这一侧的取值面：从宿主那个**只读 HTTP 路由**里，一次取全会话的树。
 *
 * 树不随会话日志下发，也不在设置文档里了 —— 宿主把它存进 SQLite，并注册了
 * `GET /t4/plan-tree`（见 `@t4r71/dsh-plan-tree/http-route`）：不带参数就是
 * 「全部会话 → 各自那棵树」的字典。老的 settings describe 镜像把整棵树塞进 profile
 * 文档，文档随会话数与步数一路长（退出时 5496 行 / 311 KB），这就是它被换掉的原因。
 *
 * 两条通道的差别决定了两件事：
 *
 *  1. **一次取全**。面板的 `mergedTreeOf` 要同时看见多条会话的树（父树节点上的
 *     `assignedTo` 指向子会话 id，合并要把那条子会话的树整体挂上去），所以只能走批量
 *     端点：按会话逐条发请求既要猜该问谁，又会在每层树各发一轮。
 *  2. **没有推送**。宿主写库不会通知浏览器，于是这里轮询（{@link POLL_INTERVAL_MS}），
 *     并在标签页重新可见时立刻补一次。重画仍然靠内容去重挡掉：序列化结果一字未变就
 *     **不换快照对象**，否则每次轮询都会把面板整棵重画（折叠状态、滚动位置跟着抖）。
 *
 * 三态在这里只有一条通路，与旧实现同一套语义：
 *   取到这份字典           → record（这条会话有自己的树）/ empty（字典里没有它）
 *   请求失败、状态码不是 2xx、响应不是 JSON、形状不是对象 → **unreadable**
 * 最后一条是硬约束：读不到绝不能装成「没有计划」。
 *
 * @module @t4r71/dsh-ui-task-tree/client/plan-tree
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  PLAN_TREE_FIELD,
  PLAN_TREE_NAMESPACE,
  mergedTreeOf,
  planTreeOf,
  planTreesSectionOf,
  type PlanNode,
  type PlanTreesSection,
  type PlanTreeView,
} from './plan-tree-data.ts'

/**
 * 宿主那条只读路由。
 *
 * **同源相对路径**，不写 host／port：面板就是从这个源被送下来的，相对路径天然跟着它走，
 * 也就不会把面板钉死在某个监听地址上。与宿主 `http-route.ts` 里的
 * `PLAN_TREE_ROUTE` 一字不差 —— 浏览器半边不导入 plan-tree 的值（跨插件值导入会被
 * 客户端打包的纯度门禁挡下），所以这条路径在这里再写一遍，由本包的测试钉住。
 */
export const PLAN_TREE_ROUTE = '/t4/plan-tree'

/** 轮询周期：够快到看不出延迟，又远低于会打疼宿主的频率。 */
export const POLL_INTERVAL_MS = 1500

/** 按会话 id 取树的读取函数。 */
export type PlanTreeReader = (sessionId: string | undefined) => PlanTreeView

/** 读取侧合并的读取函数：会话 id + 还要往下拼几层。 */
export type PlanTreeMergedReader = (sessionId: string | undefined, maxDepth: number) => PlanTreeView

/**
 * 本目录交给 `useSyncExternalStore` 的稳定快照。
 *
 * 装的是**三态**而不是原样的响应体：请求失败与「响应里没有这一项」在这里就已经分开了，
 * 往下每一次同步读取（`treeOf` / `mergedTreeOf`）都只做一次查表，不再有第二种解释。
 */
export type PlanTreeSnapshot =
  /** 拿到过宿主的一份完整字典：可能为空（确实还没有任何会话声明过计划）。 */
  | { readonly kind: 'records'; readonly section: Extract<PlanTreesSection, { kind: 'parsed' }> }
  /** 取不到：还没有会话、请求在飞、请求失败、或者响应读不动。 */
  | { readonly kind: 'unreadable' }

/** 默认的取数实现：同源 GET。 */
const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init)

/** 宿主那份响应（不可信输入）的形状。 */
interface TreesDocument {
  /** 会话 id → 树。 */
  readonly trees?: unknown
}

export type { PlanNode, PlanTreeView, PlanTreesSection }
export { PLAN_TREE_FIELD, PLAN_TREE_NAMESPACE }

/** 三态取值的唯一出处：一份字典，加上要问的那条会话。 */
function viewOf(section: PlanTreesSection, sessionId: string | undefined): PlanTreeView {
  if (section.kind !== 'parsed') return { state: 'unreadable' }
  if (sessionId === undefined) return { state: 'empty' }
  const roots = planTreeOf(section, sessionId)
  if (roots === undefined) return { state: 'empty' }
  return { state: 'record', roots }
}

/** 这份响应体是不是一份能读的字典；不是就整份读不动。 */
function sectionOfDocument(document: unknown): PlanTreesSection {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return { kind: 'unreadable' }
  const trees = (document as TreesDocument).trees
  // 字段缺席与字段读不动是同一件事：这份响应没有说「谁有哪些树」，所以什么都不能声称。
  if (trees === undefined) return { kind: 'unreadable' }
  return planTreesSectionOf(trees)
}

/** 环境里有定时器就用它，没有（例如被裁剪的宿主）就退化成「只拉一次」。 */
const timerOf = (): typeof globalThis.setTimeout | undefined =>
  (globalThis as { setTimeout?: typeof globalThis.setTimeout }).setTimeout

/** 环境里有 `document` 才订阅可见性变化；纯取值层不假设自己跑在浏览器里。 */
const documentOf = (): Document | undefined =>
  (globalThis as { document?: Document }).document

/**
 * 任务树目录：把宿主那份 HTTP 读数换成能直接喂给 `useSyncExternalStore` 的稳定值。
 */
export class PlanTreeDirectory {
  private readonly local: SnapshotStore<PlanTreeSnapshot>
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribes: readonly (() => void)[]
  /** 当前这一次排好的闹钟；undefined = 现在没有排。 */
  private timer: ReturnType<typeof setTimeout> | undefined
  /** 在飞的那次取数；同刻只允许一次，避免轮询与可见性变化叠成两个请求。 */
  private inFlight: Promise<void> | undefined
  private disposed = false

  /**
   * @param route - 取数地址；省略即宿主的 {@link PLAN_TREE_ROUTE}
   * @param sessionId - 当前会话 id；没有选中会话时是 undefined
   * @param fetchLike - 取数实现（测试替身用）；省略即同源 fetch
   * @param intervalMs - 轮询周期；测试要推得动定时器就得能把它调小，生产用默认值
   */
  constructor(
    private readonly route: string = PLAN_TREE_ROUTE,
    private readonly sessionId: string | undefined = undefined,
    private readonly fetchLike: typeof fetch = defaultFetch,
    private readonly intervalMs: number = POLL_INTERVAL_MS,
  ) {
    // 初始值是 unreadable 而不是空字典：还没有从宿主那儿拿到任何东西之前，
    // 「这条会话有没有计划」是一个本进程还没有答案的问题。
    this.local = createSnapshotStore<PlanTreeSnapshot>({ kind: 'unreadable' })
    // 有会话才发请求：没有 sessionId 时不发请求，读数就是 unreadable —— 与旧实现里
    // 「镜像还没有答案」那一支同一个意思，绝不凭空声称「这条会话没有计划」。
    if (this.sessionId === undefined) {
      this.unsubscribes = []
    } else {
      this.unsubscribes = [this.attachVisibility(), this.startPolling()]
      void this.refresh()
    }
  }

  /** 稳定快照，直接交给 `useSyncExternalStore`。 */
  readonly getSnapshot = (): PlanTreeSnapshot => this.local.getSnapshot()

  /** 订阅本地快照的替换。 */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 一条会话当刻该显示的树。同步，供渲染取初值与核对计数使用。
   * @param sessionId - 当前会话 id；没有选中会话时是 undefined。
   * @returns 三态取值：有记录 / 没有记录 / 取不到。
   */
  readonly treeOf: PlanTreeReader = sessionId => viewOf(this.section(), sessionId)

  /**
   * 一条会话当刻该显示的**合并后**的树：本会话那棵树，加上被派发的子会话自己写的树。
   *
   * 与 `treeOf` 同一套三态与同一份同步快照，只在「有记录」这一支上多做一次读取侧合并
   * （`mergedTreeOf`，语义照抄宿主 `readMerged`）。合并是**只读投影**：不写回任何东西，
   * 子代理对自己被拼进父树这件事一无所知。
   * @param sessionId - 当前会话 id；没有选中会话时是 undefined。
   * @param maxDepth - 还要往下拼几层。
   * @returns 三态取值：有记录（已合并）/ 没有记录 / 取不到。
   */
  readonly mergedTreeOf: PlanTreeMergedReader = (sessionId, maxDepth) => {
    const section = this.section()
    if (section.kind !== 'parsed') return { state: 'unreadable' }
    if (sessionId === undefined) return { state: 'empty' }
    const roots: readonly PlanNode[] | undefined = mergedTreeOf(section, sessionId, maxDepth)
    if (roots === undefined) return { state: 'empty' }
    return { state: 'record', roots }
  }

  /** 立刻向宿主取一次（可见性变化与轮询都走它）；已经在飞的不重入。 */
  refresh(): Promise<void> {
    if (this.disposed || this.sessionId === undefined) return Promise.resolve()
    this.inFlight ??= this.read().finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  /** 停掉定时器、可见性订阅与后续发布；在飞的请求回来时不再落地。 */
  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    for (const off of this.unsubscribes) off()
  }

  /** 当前快照里那份字典；取不到时是「读不动」。 */
  private section(): PlanTreesSection {
    const held = this.local.getSnapshot()
    return held.kind === 'records' ? held.section : { kind: 'unreadable' }
  }

  /** 一次取数：同一个源、同一个只读路由，带上不缓存的头。 */
  private async read(): Promise<void> {
    let next: PlanTreeSnapshot
    try {
      const response = await this.fetchLike(this.route, {
        method: 'GET',
        headers: { accept: 'application/json' },
        // 宿主那条路由本来就发 no-store，这里再钉一次：面板宁可多问一次，也不要
        // 一份被中间层缓存的树 —— 那正是「看起来像面板坏了」的那种错。
        cache: 'no-store',
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(this.route + ' answered ' + String(response.status))
      next = snapshotOf(await response.json())
    } catch {
      // 网络失败、状态码不是 2xx、响应不是 JSON：全都是「不知道」，不是「没有计划」。
      next = { kind: 'unreadable' }
    }
    if (this.disposed) return
    this.publish(next)
  }

  /** 内容没变就不换对象：否则每次轮询都会把面板整棵重画。 */
  private publish(next: PlanTreeSnapshot): void {
    const held = this.local.getSnapshot()
    if (JSON.stringify(sequenceOf(next)) === JSON.stringify(sequenceOf(held))) return
    this.local.set(next)
    for (const listener of [...this.listeners]) listener()
  }

  /** 按周期重排下一次取数；环境没有定时器时这一层直接缺席。 */
  private startPolling(): () => void {
    const schedule = timerOf()
    if (schedule === undefined) return () => {}
    const tick = (): void => {
      this.timer = undefined
      void this.refresh().then(() => {
        if (this.disposed) return
        this.timer = schedule(tick, this.intervalMs)
      })
    }
    this.timer = schedule(tick, this.intervalMs)
    return () => {
      if (this.timer !== undefined) clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** 标签页重新可见时立刻补一次：后台标签的定时器会被浏览器拖慢，回来时不该还看旧的。 */
  private attachVisibility(): () => void {
    const document = documentOf()
    if (document === undefined || typeof document.addEventListener !== 'function') return () => {}
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      void this.refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => { document.removeEventListener('visibilitychange', onVisible) }
  }
}

/** 把一份不可信的响应体折成读数。 */
function snapshotOf(document: unknown): PlanTreeSnapshot {
  const section = sectionOfDocument(document)
  if (section.kind !== 'parsed') return { kind: 'unreadable' }
  return { kind: 'records', section }
}

/**
 * 快照的可比较形状：**树逐字保留**（去重靠它），三态折成一个可以比的标记。
 *
 * 把 kind 一起放进来是有意的：两份都读不动的快照在这里相等（它们确实没差别），
 * 而「读不动」与「确实为空」永远不相等 —— 后者是一次关于计划的断言，前者不是。
 * @param snapshot - 一份读数
 * @returns 可序列化的形状，直接比较即可判定「内容变了没有」
 */
function sequenceOf(snapshot: PlanTreeSnapshot): unknown {
  return snapshot.kind === 'records'
    ? { kind: 'records', records: snapshot.section.records }
    : { kind: 'unreadable' }
}

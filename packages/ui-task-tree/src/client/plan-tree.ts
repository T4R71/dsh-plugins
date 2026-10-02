/**
 * 任务树在客户端这一侧的取值面：从共享的 settings describe 镜像里，按**会话 id**
 * 读出这条会话的那棵树。
 *
 * 树不再随会话日志下发（宿主半边把它写进自有的设置命名空间 \`plan-tree-sessions\`，
 * 见 \`@t4r71/dsh-plan-tree/session-store\`），于是客户端唯一的取数通道就是那份配置
 * 文档的镜像。变更通知因此是免费的：宿主写文档后发 \`settings/document-updated\`，
 * 该事件在转发白名单上，共享镜像已订阅它并重读，本目录只是跟着镜像的快照走。
 *
 * 镜像每次重读都换一个对象，而重渲染的代价只有在这一层做一次比较才能省掉：本目录
 * 在命名空间序列化结果没变时**不发布**新快照。
 *
 * @module @t4r71/dsh-ui-task-tree/client/plan-tree
 */

import type { SettingsDescribeFace, SettingsMirrorSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  PLAN_TREE_FIELD,
  PLAN_TREE_NAMESPACE,
  mergedTreeOf,
  planTreesOf,
  planTreeView,
  type PlanNode,
  type PlanTreeView,
} from './plan-tree-data.ts'

/** 按会话 id 取树的读取函数。 */
export type PlanTreeReader = (sessionId: string | undefined) => PlanTreeView

/** 读取侧合并的读取函数：会话 id + 还要往下拼几层。 */
export type PlanTreeMergedReader = (sessionId: string | undefined, maxDepth: number) => PlanTreeView

export type { PlanTreeView }
export { PLAN_TREE_FIELD, PLAN_TREE_NAMESPACE, planTreeView }

/**
 * 任务树目录：把共享镜像的快照换成一个能直接喂给 \`useSyncExternalStore\` 的稳定值。
 */
export class PlanTreeDirectory {
  private readonly local: SnapshotStore<SettingsMirrorSnapshot>
  private readonly following: () => void

  /**
   * @param describeFace - 共享的 describe 镜像（\`ctx.configForms.describe()\`）。
   */
  constructor(private readonly describeFace: SettingsDescribeFace) {
    this.local = createSnapshotStore(describeFace.getSnapshot())
    this.following = describeFace.subscribe(() => { this.fold() })
    // 镜像可能在上面的构造与订阅之间换了快照，所以订阅之后再折一次。
    this.fold()
  }

  /** 稳定快照，直接交给 \`useSyncExternalStore\`。 */
  readonly getSnapshot = (): SettingsMirrorSnapshot => this.local.getSnapshot()

  /** 订阅本地快照的替换。 */
  readonly subscribe = (listener: () => void): (() => void) => this.local.subscribe(listener)

  /**
   * 一条会话当刻该显示的树。同步，供渲染取初值与核对计数使用。
   * @param sessionId - 当前会话 id；没有选中会话时是 undefined。
   * @returns 三态取值：有记录 / 没有记录 / 读不到文档。
   */
  readonly treeOf: PlanTreeReader = sessionId =>
    planTreeView(this.local.getSnapshot().view?.namespaces, sessionId)

  /**
   * 一条会话当刻该显示的**合并后**的树：本会话那棵树，加上被派发的子会话自己写的树。
   *
   * 与 `treeOf` 同一套三态与同一份同步快照，只在「有记录」这一支上多做一次读取侧合并
   * （`mergedTreeOf`，语义照抄宿主 `readMerged`）。合并是**只读投影**：不写回任何东西，
   * 子代理对自己被拼进父树这件事一无所知。
   * @param sessionId - 当前会话 id；没有选中会话时是 undefined。
   * @param maxDepth - 还要往下拼几层。
   * @returns 三态取值：有记录（已合并）/ 没有记录 / 读不到文档。
   */
  readonly mergedTreeOf: PlanTreeMergedReader = (sessionId, maxDepth) => {
    const section = planTreesOf(this.local.getSnapshot().view?.namespaces, PLAN_TREE_NAMESPACE, PLAN_TREE_FIELD)
    if (section.kind === 'unreadable') return { state: 'unreadable' }
    if (sessionId === undefined) return { state: 'empty' }
    const roots: readonly PlanNode[] | undefined = mergedTreeOf(section, sessionId, maxDepth)
    if (roots === undefined) return { state: 'empty' }
    return { state: 'record', roots }
  }

  /** 停掉对镜像的跟随；之后的发布不再进入本目录。 */
  dispose(): void {
    this.following()
  }

  private fold(): void {
    const held = this.local.getSnapshot()
    const next = this.describeFace.getSnapshot()
    const sameNamespaces = JSON.stringify(next.view?.namespaces ?? null)
      === JSON.stringify(held.view?.namespaces ?? null)
    if (sameNamespaces && next.status === held.status && next.error === held.error) return
    this.local.set(next)
  }
}
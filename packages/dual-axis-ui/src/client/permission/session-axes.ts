/**
 * 会话轴在本包浏览器半边的取值面：从共享的 settings describe 镜像里，按**会话 id**
 * 读出这条会话的那一对轴。
 *
 * 轴不再随会话日志下发（宿主半边把它存进自有的设置命名空间 `dual-axis-sessions`，
 * 见 `@t4r71/dsh-dual-axis/session-store`），于是客户端唯一的取数通道就是那份
 * 配置文档的镜像。变更通知因此是免费的：宿主写文档后发 `settings/document-updated`，
 * 该事件在转发白名单上，共享镜像已订阅它并重读（`ui-settings/src/client/index.ts:43`），
 * 本目录只是跟着镜像的快照走。
 *
 * 读的是**另一个命名空间**里的按会话分区字段，不是设置页那一行
 * （`dual-axis`）：那一行的 read/write/defaultGroups 是新会话的种子，已经在跑的
 * 会话只认自己的记录。但**记录缺席**时两者交汇：那时宿主执行的正是那一行算出来的
 * 种子（见 `./session-axes-seed.ts`），所以本目录在没有记录时也要读那一行，才能显示
 * 与宿主同一个值。分组库仍由那一行的表单拥有，见 `./axis-editor.ts`。
 *
 * @module @deepseek-ai/dsh-client-ui-permission-presets/client/session-axes
 */

import type { SettingsDescribeFace, SettingsMirrorSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { sessionAxesView } from './session-axes-data.ts'
import type { SessionAxesView } from './session-axes-data.ts'

/**
 * 一条会话的父会话 id，子代理子会话才有。
 *
 * 由组合层注入：子会话的种子取父会话**当刻的记录**，所以界面必须知道这条会话是不是
 * 子会话、父是谁。取不到（不是子会话、或本进程还没学到这条血缘）时返回 undefined，
 * 那时种子退回设置页那一行 —— 与宿主「父会话没有记录时」同一条分支。
 */
export type SessionAxesParentOf = (sessionId: string) => string | undefined

/**
 * 这条会话该显示的那一对轴，以及那份取值的来源。
 *
 * 返回的永远是三态而不是「有/没有」：没有记录与读不到文档是两件事，前者宿主当刻执行的
 * 就是内置默认对（所以照它显示），后者没有任何可声称与宿主一致的值（所以如实说不知道）。
 * 见 `./session-axes-data.ts` 的 `SessionAxesView`。
 */
export type SessionAxesReader = (sessionId: string | undefined) => SessionAxesView

/**
 * 会话轴目录：把共享镜像的快照换成一个能直接喂给 `useSyncExternalStore` 的稳定值。
 *
 * 快照在这里重新发布，而不是把镜像的快照原样透出去：镜像每次重读都换一个对象，
 * 而重渲染的代价只有在这一层做一次比较才能省掉。比较是序列化比较 —— 镜像只在这份
 * 文档真的变了之后才发布（宿主只在 entry 的 raw 变化时发 `settings/document-updated`，
 * 见 `settings/src/index.ts:311-317`），所以那次序列化每次文档变更只做一次。
 */
export class SessionAxesDirectory {
  private readonly local: SnapshotStore<SettingsMirrorSnapshot>
  private readonly following: () => void

  /**
   * @param describeFace - 共享的 describe 镜像（`ctx.configForms.describe()`）。
   * @param parentOf - 这条会话的父会话 id；默认「不是子会话」，于是种子只按设置页那一行算。
   */
  constructor(
    private readonly describeFace: SettingsDescribeFace,
    private readonly parentOf: SessionAxesParentOf = () => undefined,
  ) {
    this.local = createSnapshotStore(describeFace.getSnapshot())
    this.following = describeFace.subscribe(() => { this.fold() })
    // 镜像可能在上面的构造与订阅之间换了快照，所以订阅之后再折一次。
    this.fold()
  }

  /** 稳定快照，直接交给 `useSyncExternalStore`。 */
  readonly getSnapshot = (): SettingsMirrorSnapshot => this.local.getSnapshot()

  /** 订阅本地快照的替换。 */
  readonly subscribe = (listener: () => void): (() => void) => this.local.subscribe(listener)

  /**
   * 一条会话当刻该显示的轴。同步，供编辑器取初值与提交后的核对使用。
   * @param sessionId - 当前会话 id；没有选中会话时是 undefined。
   * @returns 三态取值：有记录 / 照这条会话的种子显示 / 无从得知。
   */
  readonly axesOf: SessionAxesReader = sessionId =>
    sessionAxesView(
      this.local.getSnapshot().view?.namespaces,
      sessionId,
      sessionId === undefined ? undefined : this.parentOf(sessionId),
    )

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

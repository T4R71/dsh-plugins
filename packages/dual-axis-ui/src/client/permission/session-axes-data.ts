/**
 * 会话轴在配置文档里的形状，以及按会话 id 取值的纯读取。
 *
 * 单独一个模块，唯一的理由是它必须能在**不被 store 依赖污染**的程序里被直接测到：
 * 本包的宿主半边把它存进自有的设置命名空间 `dual-axis-sessions`，字段名与结构是
 * 两边之间的接口，改一处就要改另一处。订阅与快照那一层在 `./session-axes.ts`。
 *
 * 这里只管**文档里有没有这条会话的记录**。「没有记录时该显示哪一对」是另一件事，
 * 由 `./session-axes-seed.ts` 按与宿主同一份计算给出 —— 那一对是设置页那一行
 * （加上子代理继承），不是内置默认对。
 *
 * @module @deepseek-ai/dsh-client-ui-permission-presets/client/session-axes-data
 */

import type { DualAxisAxesWire, DualAxisNarrowingWire } from './presentation.ts'
import { sessionAxesSeed } from './session-axes-seed.ts'

export { SESSION_AXES_FALLBACK, sessionAxesSeed } from './session-axes-seed.ts'
export type { SeededAxes, SeededAxis } from './session-axes-seed.ts'

/** 宿主存轴用的设置命名空间（Loader entry id）。 */
export const SESSION_AXES_NAMESPACE = 'dual-axis-sessions'

/** 设置页那一行的设置命名空间（Loader entry id）：新会话的**种子**来源。 */
export const DUAL_AXIS_ROW_NAMESPACE = 'dual-axis'

/** 该命名空间里那个按会话 id 分区的字段名。 */
export const SESSION_AXES_FIELD = 'axes'

/** 一份文档快照里，本命名空间那一行的取值形状。 */
interface StoredSection {
  readonly axes?: unknown
}

/** 快照里本命名空间那一行 —— 只声明这里真的会读的两个成员。 */
export interface SessionAxesSectionView {
  readonly ns: string
  readonly value: unknown
}

/**
 * 从一条记录里读出宿主发布的收窄结论。
 *
 * 未信任输入：文档可能被人手改过，也可能带着旧版本写下的、没有这个成员的记录。
 * 前者读不懂就**丢掉**（当作没有收窄可显示），而不是把一份读不出来的报告渲染成
 * 「什么也没被削」—— 那正是最坏的那一种错。后者（成员整个缺席）本来就是「没有收窄」，
 * 与宿主围栏在那种记录下执行的范围一致。
 * @param value - 记录里的 `narrowing` 成员，未信任。
 * @returns 收窄结论，或 undefined（缺席 / 读不懂 / 两侧都说没有）。
 */
export function narrowingOf(value: unknown): DualAxisNarrowingWire | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as { narrowed?: unknown; droppedRoots?: unknown; lostUnbounded?: unknown }
  if (typeof candidate.narrowed !== 'boolean' || typeof candidate.lostUnbounded !== 'boolean') return undefined
  if (!candidate.narrowed) return undefined
  const dropped = candidate.droppedRoots
  if (!Array.isArray(dropped) || dropped.some(root => typeof root !== 'string')) return undefined
  return {
    narrowed: true,
    droppedRoots: [...dropped as string[]],
    lostUnbounded: candidate.lostUnbounded,
  }
}

/**
 * 一份 describe 快照里，本命名空间那一行的取值。
 * @param namespaces - 快照里的全部命名空间行，或 undefined（还没有读到答案）。
 * @returns 那一行的取值，或 undefined（宿主没服务这一节）。
 */
export function sessionAxesSectionValue(
  namespaces: readonly SessionAxesSectionView[] | undefined,
): unknown {
  return namespaces?.find(row => row.ns === SESSION_AXES_NAMESPACE)?.value
}

/**
 * 一份 describe 快照里，设置页那一行（`dual-axis`）的取值 —— 新会话的种子。
 *
 * 它与 {@link sessionAxesSectionValue} 是**两节**，不能混：那一行的 read/write/defaultGroups
 * 描述的是**将要建立**的会话，判定路径不读它；而「这条会话没有记录」时判定路径执行的
 * 是种子算出来的那一对，所以界面必须能读到同一行才能显示同一个值。
 * @param namespaces - 快照里的全部命名空间行，或 undefined。
 * @returns 那一行的取值，或 undefined（宿主没服务这一节）。
 */
export function sessionAxesRowValue(
  namespaces: readonly SessionAxesSectionView[] | undefined,
): unknown {
  return namespaces?.find(row => row.ns === DUAL_AXIS_ROW_NAMESPACE)?.value
}

/**
 * 按会话 id 从一份文档快照里取出那一对轴。
 *
 * 未信任输入：文档可能被人手改过、也可能由别的写入方改过，所以只在形状真的读得懂时才
 * 返回取值；读不懂时返回 `undefined`，由 {@link sessionAxesView} 决定那是「照种子
 * 显示」还是「无从得知」。这里**不抛**：一个读不懂的会话轴不该让整个输入条崩掉。
 * @param value - 本命名空间那一行的取值。
 * @param sessionId - 要读的那条会话。
 * @returns 那条会话的轴对，或 undefined。
 */
export function sessionAxesOf(
  value: unknown,
  sessionId: string | undefined,
): DualAxisAxesWire | undefined {
  if (sessionId === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const field = (value as StoredSection).axes
  if (typeof field !== 'object' || field === null || Array.isArray(field)) return undefined
  const record = (field as Record<string, unknown>)[sessionId]
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return undefined
  const pair = record as { read?: unknown; write?: unknown; narrowing?: unknown }
  if (typeof pair.read !== 'object' || pair.read === null) return undefined
  if (typeof pair.write !== 'object' || pair.write === null) return undefined
  const narrowing = narrowingOf(pair.narrowing)
  return {
    read: pair.read as DualAxisAxesWire['read'],
    write: pair.write as DualAxisAxesWire['write'],
    ...narrowing === undefined ? {} : { narrowing },
  }
}

/**
 * What the two dropdowns display for one session, and why.
 *
 * Three states, because two of them look alike and mean different things:
 *
 * - `record` — the document carries this session's pair. This is the ordinary
 *   state and the only one that has an answer of its own.
 * - `default` — the document was read and does NOT carry this session. The host
 *   is holding the session to its SEED right now — the pair `pin` pins a new
 *   session with, recomputed by {@link sessionAxesSeed} from the settings row —
 *   so that is what is shown. Showing nothing here is the defect this type exists
 *   to prevent: it reads to a person as "the feature is gone". Showing
 *   `SESSION_AXES_FALLBACK` here instead would be the OTHER defect: it labels the
 *   axis with a range the host does not enforce.
 * - `unknown` — there is nothing to read: no session is selected, or the settings
 *   mirror has not delivered a document yet. No value can be claimed to agree
 *   with the host, so the dropdowns say so instead of inventing one.
 */
export type SessionAxesView =
  | { readonly state: 'record'; readonly axes: DualAxisAxesWire }
  | { readonly state: 'default'; readonly axes: DualAxisAxesWire }
  | { readonly state: 'unknown' }

/**
 * Resolve what the two dropdowns show for one session.
 *
 * Never returns nothing and never throws: an unreadable document, an unknown
 * session id, and a missing record each have a state of their own.
 * @param namespaces - every namespace row of one describe snapshot, or `undefined`
 *   when the mirror has not delivered a document (which is NOT the same as a
 *   document that carries no record for this session).
 * @param sessionId - the session to read; `undefined` when none is selected.
 * @param parentSessionId - the session's parent when it is a subagent child, which
 *   changes the seed: a child inherits its parent's STORED pair rather than the
 *   settings row, exactly as `inheritedAxes` does on the host. `undefined` for a
 *   top-level session (and for a child whose lineage the client has not learned).
 * @returns the view the dropdowns render from.
 */
export function sessionAxesView(
  namespaces: readonly SessionAxesSectionView[] | undefined,
  sessionId: string | undefined,
  parentSessionId?: string | undefined,
): SessionAxesView {
  if (sessionId === undefined) return { state: 'unknown' }
  if (namespaces === undefined) return { state: 'unknown' }
  const stored = sessionAxesSectionValue(namespaces)
  const axes = sessionAxesOf(stored, sessionId)
  if (axes !== undefined) return { state: 'record', axes }
  const inherited = parentSessionId === undefined ? undefined : sessionAxesOf(stored, parentSessionId)
  return {
    state: 'default',
    axes: sessionAxesSeed(sessionAxesRowValue(namespaces), inherited),
  }
}

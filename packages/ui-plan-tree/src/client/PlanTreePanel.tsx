/**
 * The plan tree's body: the session's declared plan, one row per node.
 *
 * The data source is the `planTree` session projection — the durable tree the
 * lead declares with `plan_write` and walks with `plan_step`/`plan_dispatch`.
 * That is the point of this panel: the rows are not a model-authored progress
 * note (the todo panel's failure mode, where the work and the display have no
 * causal link), they are the steps the host actually recorded.
 *
 * Everything a reader opens this pane for rides on the nodes themselves:
 * - `status` says where the work is (and the working stage opens by itself);
 * - `dependsOn` says what a step waits for;
 * - `assignedTo` says which teammate is doing it.
 *
 * Nothing here writes: the plan belongs to the plan tools' own commands.
 */
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the `planTree` key merge (and its `PlanNode` payload) lives in the
// host package's types outlet, which this program never evaluates.
import type { PlanNode } from '@t4r71/dsh-plan-tree/client'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconPlanOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from './locales.ts'
import css from './PlanTreePanel.module.css'

/** The panel's composed props: the session standard kit plus its copy seat. */
export type PlanTreePanelProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'planTree'>

/** The four glyphs the panel draws. */
type DisplayStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

/** Local exhaustiveness helper — client packages do not depend on `dsh-llm`. */
/* v8 ignore next 3 -- closed-union backstop; only reached if status is forged */
function assertNever(value: never): never {
  throw new Error(`unreachable plan status: ${String(value)}`)
}

/** Pending: dashed unstarted ring, the todo panel's figma dash (2.4 2.4). */
function PendingGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className={css.glyphPending}>
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.4 2.4" />
    </svg>
  )
}

/** In progress: business-blue ring fading out; CSS spins the svg. */
function ProgressGlyph() {
  const gradientId = useId()
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className={css.glyphProgress}>
      <defs>
        <linearGradient id={gradientId} x1="2.5" y1="12" x2="10.5" y2="3.5" gradientUnits="userSpaceOnUse">
          <stop stopColor="currentColor" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <circle cx="7" cy="7" r="6.4" stroke={`url(#${gradientId})`} strokeWidth="1.2" />
    </svg>
  )
}

/** Completed: a filled disc with a knocked-out check. */
function CompletedGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className={css.glyphCompleted}>
      <circle cx="7" cy="7" r="6.4" fill="currentColor" />
      <path
        d="M10.2 4.9L6.35 8.95C6.16 9.15 5.99 9.32 5.85 9.43C5.7 9.55 5.53 9.65 5.31 9.66C5.09 9.67 4.91 9.58 4.76 9.47C4.61 9.37 4.44 9.21 4.24 9.02L2.8 7.66L3.6 6.82L5.04 8.18C5.27 8.4 5.41 8.52 5.51 8.59C5.58 8.63 5.6 8.63 5.61 8.63C5.62 8.63 5.64 8.63 5.71 8.58C5.81 8.51 5.94 8.39 6.17 8.16L10.02 4.1L10.2 4.9Z"
        fill="var(--dsw-alias-bg-layer-1)"
      />
    </svg>
  )
}

/** Blocked: the same ring with a cross, in the error ink. */
function BlockedGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className={css.glyphBlocked}>
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.9 4.9L9.1 9.1M9.1 4.9L4.9 9.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/** The glyph for one displayed status. */
function StatusGlyph({ status }: { status: DisplayStatus }): ReactNode {
  switch (status) {
    case 'completed': return <CompletedGlyph />
    case 'in_progress': return <ProgressGlyph />
    case 'pending': return <PendingGlyph />
    case 'blocked': return <BlockedGlyph />
    /* v8 ignore next -- closed DisplayStatus union */
    default: return assertNever(status)
  }
}

/** Per-status task counts over the whole board. */
interface Counts {
  total: number
  done: number
  active: number
  blocked: number
  pending: number
}

/**
 * The summary line: "3/5 已完成 · 1 进行中"; zero-count segments are omitted as
 * noise (a non-empty plan always keeps at least one).
 * @param counts - whole-plan totals.
 * @param t - namespace-bound translate.
 * @returns the joined summary.
 */
function summaryLabel(counts: Counts, t: PlanTreePanelProps['t']): string {
  // En spaces (U+2002): HTML collapses runs of ASCII spaces, so widening the
  // separator's breathing room needs a literal wide space.
  return [
    ...counts.total > 0 ? [t('summary.done', { done: counts.done, total: counts.total })] : [],
    ...counts.active > 0 ? [t('summary.active', { active: counts.active })] : [],
    ...counts.blocked > 0 ? [t('summary.blocked', { blocked: counts.blocked })] : [],
    ...counts.pending > 0 ? [t('summary.pending', { pending: counts.pending })] : [],
  ].join('\u2002·\u2002')
}

/** Decorative bar widths, narrowing downward so the ghosts read as a fading list. */
const EMPTY_BAR_WIDTHS = [148, 112, 76]

/**
 * The empty board.
 *
 * A panel that returns nothing is indistinguishable from a panel that failed to
 * load, so an empty board says so in the pane's own visual language: three
 * ghost rows on the same rail the real rows use, drawn in the pending ink and
 * carrying no glyph, no hover, and no disclosure. The dotted rail is the point
 * — it reads as "the plan will be drawn down here", which is what the timeline
 * does, rather than as a spinner or an error.
 * @param props - the namespace-bound translate.
 * @returns the placeholder body.
 */
function EmptyBoard({ t }: { t: PlanTreePanelProps['t'] }): ReactNode {
  return (
    <div className={css.empty} data-plan-tree="empty">
      <div className={css.emptyRail} aria-hidden>
        {EMPTY_BAR_WIDTHS.map(width => (
          <span key={width} className={css.emptyRow}>
            <span className={css.emptyGlyph} />
            <span className={css.emptyBar} style={{ width: `${width}px` }} />
          </span>
        ))}
      </div>
      <p className={css.emptyTitle}>{t('empty.title')}</p>
      <p className={css.emptyHint}>{t('empty.hint')}</p>
    </div>
  )
}

/**
 * One declared-plan node, recursively.
 *
 * The declared tree is a DIFFERENT shape from the Team board: it is genuinely
 * nested (`children`), its status is authored rather than derived, and it has
 * no owner. It therefore gets its own row rather than being flattened into the
 * task list — flattening would lose the nesting that makes a plan a plan.
 *
 * Indentation comes from the nested `<ul>` (the `.level .level` rule), NOT from
 * an inline padding: doing both double-indents every level and pushes rows out
 * of the pane's width.
 * @param props - the node and the shared open-state board.
 * @returns the node's row plus its subtree when open.
 */
function PlanNodeRow({ node, board }: {
  node: PlanNode
  board: BoardContext
}): ReactNode {
  const children = node.children ?? []
  const hasChildren = children.length > 0
  const autoOpen = node.status === 'in_progress'
  const open = hasChildren && board.expanded(`plan:${node.id}`, autoOpen)
  const body = (
    <>
      <span className={css.rail} aria-hidden>
        <StatusGlyph status={node.status} />
      </span>
      <span className={css.text}>
        <span className={css.title}>{node.title}</span>
        {node.assignedTo !== undefined && node.assignedTo !== '' && (
          <span className={css.assignee}>{board.t('row.assignee', { name: node.assignedTo })}</span>
        )}
        {node.detail !== undefined && node.detail !== '' && (
          <span className={css.detail}>{node.detail}</span>
        )}
      </span>
      {hasChildren && (
        <span className={css.chevron} aria-hidden>
          {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        </span>
      )}
    </>
  )
  return (
    <li className={css.item} data-status={node.status} data-plan-node={node.id}>
      {/* A node WITH children is a disclosure control, so it is a real <button>.
          A leaf is not a control at all: rendering it as a disabled-looking
          button leaks the UA's own button face (a light slab on a dark sidebar)
          and its shrink-to-fit width, which drew every leaf as a grey card of a
          different width. A leaf is therefore a plain <div> — no UA styles to
          reset, and nothing for the keyboard to land on that does nothing. */}
      {hasChildren ? (
        <button
          type="button"
          className={css.row}
          aria-expanded={open}
          aria-label={open ? board.t('collapse') : board.t('expand')}
          onClick={() => { board.onToggle(`plan:${node.id}`, autoOpen) }}
        >
          {body}
        </button>
      ) : (
        <div className={css.leaf}>{body}</div>
      )}
      {open && (
        <ul className={css.level}>
          {children.map(child => (
            <PlanNodeRow key={child.id} node={child} board={board} />
          ))}
        </ul>
      )}
    </li>
  )
}

/** Per-status counts over the declared plan tree. */
function countPlanNodes(nodes: readonly PlanNode[]): Counts {
  const counts: Counts = { total: 0, done: 0, active: 0, blocked: 0, pending: 0 }
  const walk = (list: readonly PlanNode[]): void => {
    for (const node of list) {
      counts.total++
      if (node.status === 'completed') counts.done++
      else if (node.status === 'in_progress') counts.active++
      else if (node.status === 'blocked') counts.blocked++
      else counts.pending++
      if (node.children !== undefined) walk(node.children)
    }
  }
  walk(nodes)
  return counts
}

/** What every row shares: open state, its two gestures, and copy. */
interface BoardContext {
  readonly expanded: (id: string, autoOpen: boolean) => boolean
  readonly onToggle: (id: string, autoOpen: boolean) => void
  readonly t: PlanTreePanelProps['t']
}

/**
 * The plan tree panel: the session's declared plan, as one tree.
 *
 * The panel shows ONE data source, deliberately. An earlier revision also drew
 * the Team task board beside it, which duplicated the plan: a dispatched step
 * appeared twice, once as a plan node and once as a board task, and a task's
 * fields mostly restated what the node already carried. The reader could not
 * tell which half was authoritative, and the honest answer was "neither" —
 * they are the same fact written twice by the same tool call.
 *
 * So the plan is the single view, and everything worth knowing rides on its
 * nodes: `status` says where the work is, `dependsOn` says what it waits for,
 * and `assignedTo` says who is doing it. Those are the three questions a
 * reader opens this pane to answer, and one tree answers all three.
 *
 * An absent projection (`undefined`) draws nothing: there is no second source
 * to fall back to.
 * @param props - the session standard kit plus its copy seat.
 * @returns the panel.
 */
export function PlanTreePanel({ useProjection, t }: PlanTreePanelProps): ReactNode {
  // `undefined` = the reader has not touched this row; `true`/`false` = they did.
  // Keeping the absence distinct from a chosen `false` is what lets the
  // working-stage default apply to untouched rows only. Plan-node ids are
  // namespaced so they can never collide with anything else on this map.
  const [touched, setTouched] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const board: BoardContext = {
    expanded: (id, autoOpen) => touched.get(id) ?? autoOpen,
    onToggle: (id, autoOpen) => {
      setTouched((current) => {
        const next = new Map(current)
        next.set(id, !(current.get(id) ?? autoOpen))
        return next
      })
    },
    t,
  }
  // Typed by the host package's type-only merge, so no cast is needed.
  const plan = useProjection('planTree')
  if (plan === undefined) return null

  const nodes = plan ?? []
  const counts = countPlanNodes(nodes)

  return (
    <div className={css.root} data-plan-tree="tree">
      <div className={css.summary}>
        <span className={css.summaryTitle}>{t('type.label')}</span>
        <span className={css.summaryProgress}>
          {nodes.length === 0 ? t('summary.empty') : summaryLabel(counts, t)}
        </span>
      </div>
      <div className={css.body}>
        {nodes.length > 0 ? (
          <section className={css.section} data-plan-section="plan">
            <div className={css.sectionHead}>
              <span className={css.sectionTitle}>{t('section.plan')}</span>
              <span className={css.sectionCount}>{summaryLabel(counts, t)}</span>
            </div>
            <ul className={css.level} data-order="timeline">
              {nodes.map(node => <PlanNodeRow key={node.id} node={node} board={board} />)}
            </ul>
          </section>
        ) : (
          <EmptyBoard t={t} />
        )}
      </div>
    </div>
  )
}

/** The plan tree type's chip title: the plan glyph before the type's label. */
export function PlanTreeTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return (
    <>
      <IconPlanOutline14 className={css.titleIcon} />
      {tab.title}
    </>
  )
}

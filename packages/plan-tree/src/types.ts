/**
 * Pure types of the plan-tree domain: the ONE home of the `planTree`
 * projection-key declaration plus the payload types of the two plan events,
 * free of this package's host-side value imports (cordis, dsh-tools, zod).
 *
 * A `planTree` is two events, not one: `plan/declared` is the whole-tree
 * snapshot the model writes once when it declares the plan (last-write-wins,
 * the same whole-value rule `todo/write` follows), while `plan/step` is a
 * single node's status update written as the work proceeds. Splitting them
 * keeps the ordinary step cheap: a status change does not restate the tree.
 *
 * @module @t4r71/dsh-plan-tree/types
 */

/** Lifecycle state of one plan node. */
export type PlanStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

/**
 * One node of a declared plan. A node without `children` is a leaf; the tree
 * is arbitrary-depth and `id` is unique across the WHOLE tree, not per level,
 * because `plan/step` addresses a node by id alone.
 */
export interface PlanNode {
  /** Stable identity across the plan's life, unique within the whole tree. */
  id: string
  /** What this step is — a short imperative line shown in the UI. */
  title: string
  /** Lifecycle state. */
  status: PlanStatus
  /** Optional longer explanation of the step. */
  detail?: string | undefined
  /** Prompt to hand a subagent when this node is dispatched. */
  task?: string | undefined
  /** Name of the teammate this node was dispatched to; absent until dispatch. */
  assignedTo?: string | undefined
  /**
   * The human's answer to the question this node asked, once `plan_ask` has
   * one. The node is the QUESTION's durable home: a question that shaped the
   * plan stays readable beside the steps it shaped, instead of existing only
   * as a chat turn the plan no longer references.
   */
  answer?: string | undefined
  /**
   * Ids of nodes this one waits on, drawn as a dependency edge in the panel.
   * The list is a display contract, not a scheduler: the host never blocks a
   * `plan_step` because a dependency is unfinished — a plan that cannot be
   * walked in order is a plan-mistake the reader should SEE, not one the tool
   * silently repairs (the todo tool's stance on parallel in-progress work).
   */
  dependsOn?: string[] | undefined
  /** Nested sub-steps, in display order. Omitted (or empty) marks a leaf. */
  children?: PlanNode[] | undefined
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whole-tree snapshot; latest write wins on replay. Log-only UI state,
     * never derived history.
     */
    'plan/declared': { plan: PlanNode[] }
    /**
     * One node's status update, addressed by its tree-unique id. Written by
     * the `plan_step` tool, never by the model restating the tree.
     *
     * `assignedTo` and `answer` are the fields a step may carry beyond
     * `status`: they are how a dispatch records "who is doing this" and how
     * `plan_ask` records "what the human answered" without turning the
     * whole-tree `plan/declared` snapshot into a routine operation. Absent
     * means the step says nothing about that field, so it leaves any existing
     * value standing — which is what lets a later plain status change neither
     * erase an assignment nor lose an answer.
     */
    'plan/step': { id: string; status: PlanStatus; assignedTo?: string; answer?: string }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** The current whole plan tree, or null before the first declaration. */
    planTree: PlanNode[] | null
  }
  interface SessionProjectionMap {
    /**
     * The session's declared plan tree with every folded step status, or
     * `null` before the first `plan/declared`. Whole-value rule: the last
     * declaration replaces the tree, and each `plan/step` replaces one node.
     */
    planTree: PlanNode[] | null
  }
}

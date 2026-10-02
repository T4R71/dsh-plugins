/**
 * Pure types of the plan-tree domain: the node shape the four tools walk, free
 * of this package's host-side value imports (cordis, dsh-tools, zod).
 *
 * A tree is not an event and not a projection any more. It is one entry of the
 * \`trees\` field in this package's OWN settings namespace
 * (\`plan-tree-sessions\`, see \`./session-store.ts\`), keyed by session id: the
 * host writes the whole field through \`ctx.get("settings").replace(...)\` under a
 * revision CAS, and the panel reads the same document out of the shared settings
 * describe mirror. Nothing here is a session-log type — an event type outside
 * 0.1.7's \`KNOWN_SESSION_EVENT_TYPES\` makes the whole log unreadable.
 *
 * @module @t4r71/dsh-plan-tree/types
 */

/** Lifecycle state of one plan node. */
export type PlanStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

/**
 * One node of a declared plan. A node without \`children\` is a leaf; the tree
 * is arbitrary-depth and \`id\` is unique across the WHOLE tree, not per level,
 * because \`plan_step\` addresses a node by id alone.
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
   * The human's answer to the question this node asked, once \`plan_ask\` has
   * one. The node is the QUESTION's durable home: a question that shaped the
   * plan stays readable beside the steps it shaped, instead of existing only
   * as a chat turn the plan no longer references.
   */
  answer?: string | undefined
  /**
   * Ids of nodes this one waits on, drawn as a dependency edge in the panel.
   * The list is a display contract, not a scheduler: the host never blocks a
   * \`plan_step\` because a dependency is unfinished — a plan that cannot be
   * walked in order is a plan-mistake the reader should SEE, not one the tool
   * silently repairs (the todo tool's stance on parallel in-progress work).
   */
  dependsOn?: string[] | undefined
  /** Nested sub-steps, in display order. Omitted (or empty) marks a leaf. */
  children?: PlanNode[] | undefined
}

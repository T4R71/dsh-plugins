/**
 * Pure types of the task-tree host domain: the ONE home of the `taskTree`
 * projection-key declaration, free of this package's host-side value imports
 * (cordis, zod).
 *
 * The `taskTree` unit is deliberately minimal: it is a pass-through carrier.
 * Events carry a whole array, the fold stores that array, and the wire view
 * republishes it unchanged. There is no derived state and no per-node step
 * event, so the unit costs one reference comparison per unrelated event.
 *
 * @module @t4r71/dsh-task-tree-host/types
 */

/**
 * One entry of the task tree as the carrier transports it. The shape is open
 * by design: the carrier transports whole values and never interprets them, so
 * a producer may put any JSON object in the array.
 */
export interface TaskTreeNode {
  /** Stable identity of the entry, unique within the transported array. */
  id: string
  /** Human-readable label of the entry. */
  title: string
  /** Optional nested entries, in producer order. */
  children?: TaskTreeNode[] | undefined
  /** Any additional producer-owned JSON fields, transported verbatim. */
  [key: string]: unknown
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whole-array snapshot; latest write wins on replay. The carrier stores
     * exactly what it was given and derives nothing from it.
     */
    'taskTree/declared': { nodes: TaskTreeNode[] }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** The current whole task-tree array, or null before the first declaration. */
    taskTree: TaskTreeNode[] | null
  }
  interface SessionProjectionMap {
    /**
     * The session's task tree as the producer declared it, or `null` before
     * the first `taskTree/declared`. Whole-value rule: the last declaration
     * replaces the array outright.
     */
    taskTree: TaskTreeNode[] | null
  }
}

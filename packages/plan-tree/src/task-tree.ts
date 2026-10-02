/**
 * The `taskTree` service: @t4r71/dsh-task's four-method port onto THIS
 * package's per-session plan tree.
 *
 * The task tool (`packages/task/src/index.ts:133-143`) reaches the tree through
 * `ctx.get('taskTree')` and owns none of the storage. This module is the other
 * half of that seam, and it exists for exactly one reason: without it the port
 * is absent and every tree-shaped action of `task` (`plan`, `step`,
 * `list(scope=tree)`) throws
 * `task: the 'taskTree' service is unavailable — load @t4r71/dsh-plan-tree...`.
 *
 * Three translations happen here and nowhere else:
 *
 * 1. **Shape.** The port speaks FLAT (a `FlatNode` carries `parent`, the node it
 *    hangs under) and NESTED (a `TaskNode` carries `children`); the store speaks
 *    only nested `PlanNode[]`. The flat input is normalized into nesting on the
 *    way in.
 * 2. **Status vocabulary.** The port's `TaskNodeStatus` is
 *    `pending | in_progress | completed | failed`; `PlanStatus` is
 *    `pending | in_progress | completed | blocked`. Both ends DROP the whole
 *    tree they are parsing when they meet a status they do not know — the host's
 *    `parsePlanTreesField` (session-store.ts:163-202) and the panel's own
 *    `planTreeOf` (@t4r71/dsh-ui-task-tree, plan-tree-data.ts:62-80) — so a
 *    status written in the wrong vocabulary does not degrade one node, it makes
 *    the session's tree invisible to both halves. `failed` is therefore STORED
 *    as `blocked` (the plan's word for "cannot proceed") and READ back out as
 *    `failed`; nothing else is ever written.
 * 3. **Ownership.** `bind` records the dispatched child session id in the plan
 *    node's `assignedTo` field.
 *
 * This module never touches the session log, so no event type outside
 * `KNOWN_SESSION_EVENT_TYPES` can be introduced here (see session-store.ts:1-27
 * for why that matters).
 *
 * @module @t4r71/dsh-plan-tree/task-tree
 */

import type { PlanNode, PlanStatus } from './types.ts'
import type { PlanTreeStore } from './session-store.ts'

/**
 * One node of the tree the `task` tool reads and the panel renders. Spelled
 * structurally, exactly as this package's other soft dependencies are (see
 * `TeamsDispatchSurface` in index.ts): @t4r71/dsh-task sits ABOVE plan-tree, so
 * importing its types would invert the layering. The declaration is assignable
 * to and from `TaskTreePort` in `packages/task/src/index.ts:134-143`.
 */
export interface TaskTreePort {
  /** Read the session's tree — nested, statuses in the port's vocabulary. */
  read(sessionId: string): readonly TaskNode[]
  /**
   * Read the session's tree with every dispatched child's OWN tree spliced in
   * under the node that was bound to it.
   *
   * Child agents keep writing their own session's tree through the ordinary
   * `sessionId(exec)` — they know nothing about this call. The join is the
   * `assignedTo` field `bind` already records, so nothing new has to be
   * threaded through a dispatch for a parent to see the whole picture.
   * @param sessionId - the delegating session whose tree is the root.
   * @param maxDepth - how many delegation levels to splice; 0 is `read`.
   * @returns the merged tree; a node whose child left no tree keeps no children.
   */
  readMerged(sessionId: string, maxDepth?: number): readonly TaskNode[]
  /** Write flat nodes; `replace` true replaces the whole tree, false merges. */
  write(sessionId: string, nodes: readonly FlatNode[], replace: boolean): Promise<void>
  /** Move ONE node's status and/or detail; fields the patch omits are kept. */
  step(sessionId: string, nodeId: string, patch: { status?: TaskNodeStatus; detail?: string }): Promise<void>
  /** Record which child session a node was dispatched to. */
  bind(sessionId: string, nodeId: string, childId: string): Promise<void>
}

/** Status vocabulary of the `task` port. */
export type TaskNodeStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

/** One nested node, as the port reads it. */
export interface TaskNode {
  readonly id: string
  readonly title: string
  readonly detail?: string
  readonly status: TaskNodeStatus
  readonly assignedTo?: string
  readonly children?: readonly TaskNode[]
}

/** One flat node, as the port writes it: nesting comes from `parent` alone. */
export interface FlatNode {
  readonly id: string
  readonly parent?: string
  readonly title: string
  readonly detail?: string
}

// --- status translation -----------------------------------------------------

/**
 * `TaskNodeStatus` as it is STORED. `failed` is the only status the plan's
 * vocabulary lacks, and it is stored as `blocked`. The four-status document is
 * the contract BOTH parsers enforce (see the module comment), so writing a fifth
 * value would make the whole session's tree unreadable rather than marking one
 * node red.
 * @param status - the status the port was asked to store.
 * @returns the status the store and the panel both accept.
 */
export function toPlanStatus(status: TaskNodeStatus): PlanStatus {
  return status === 'failed' ? 'blocked' : status
}

/**
 * A STORED status as the port reads it.
 *
 * `blocked` is read as `failed`, which covers both of its provenances: a task
 * step that failed (stored as `blocked` by {@link toPlanStatus}) and a node
 * `plan_ask` parked on a question. Both are "this node did not complete", which
 * is the whole of what the port's vocabulary can say; reading it as
 * `in_progress` would report work as running when nothing is.
 *
 * A stored value outside the plan's four statuses cannot reach here —
 * `parsePlanTreesField` drops such a node — so the fallback keeps this total
 * rather than describing a reachable case.
 * @param status - the status as stored.
 * @returns the port's status.
 */
export function fromPlanStatus(status: PlanStatus): TaskNodeStatus {
  if (status === 'pending' || status === 'in_progress' || status === 'completed') return status
  return 'failed'
}

/**
 * One stored node as the port reads it, recursively.
 * @param node - the stored node.
 * @returns the port's node.
 */
function toTaskNode(node: PlanNode): TaskNode {
  const task: TaskNode = {
    id: node.id,
    title: node.title,
    status: fromPlanStatus(node.status),
    // Exact optional properties: an absent field is OMITTED rather than set to
    // undefined, so a round trip drops nothing that was not absent already.
    ...(node.detail === undefined ? {} : { detail: node.detail }),
    ...(node.assignedTo === undefined ? {} : { assignedTo: node.assignedTo }),
    ...(node.children === undefined ? {} : { children: node.children.map(toTaskNode) }),
  }
  return task
}

// --- flat -> nested ---------------------------------------------------------

/** A flat node after validation: every member resolved, nothing implicit left. */
interface Entry {
  /** Node id. */
  id: string
  /** The parent's id, or `undefined` for a root. */
  parent: string | undefined
  /** Node title. */
  title: string
  /** Optional detail line. */
  detail: string | undefined
}

/**
 * Validate one flat list and reject everything that cannot become a tree.
 *
 * The old design stored a literal nesting, which excluded cycles STRUCTURALLY. A
 * flat list carries no such protection, so the four malformed shapes a `parent`
 * field makes expressible are each REFUSED here rather than silently repaired or
 * — far worse — walked until the stack dies:
 *
 * - a node naming ITSELF as its parent (`a.parent === 'a'`);
 * - a cycle (`a.parent === 'b'` with `b.parent === 'a'`);
 * - a `parent` naming an id no node of the call carries;
 * - two entries carrying the same id, which would make one node reachable under
 *   two parents and make the flat list's meaning ambiguous.
 *
 * Multiple roots are NOT an error: the stored shape is an array of roots, so a
 * flat list with two parent-less nodes is a two-root forest and is written as
 * one.
 * @param nodes - the model-supplied flat nodes.
 * @param known - ids that exist OUTSIDE this write and are therefore legal
 *   parents: the stored tree on the merge path, empty on the replace path.
 *   Without it a merge could not add a child to a node it does not restate.
 * @returns the validated entries, in input order.
 * @throws When any shape above is present. The message names the ids, so the
 *   caller can fix the call instead of guessing.
 */
export function validateFlatNodes(nodes: readonly FlatNode[], known: ReadonlySet<string> = new Set()): Entry[] {
  const entries: Entry[] = []
  const byId = new Map<string, Entry>()
  for (const node of nodes) {
    const id = node.id.trim()
    const title = node.title.trim()
    if (id === '') throw new Error('task-tree: `id` must be a non-empty string')
    if (title === '') {
      throw new Error('task-tree: `title` must be a non-empty string (node ' + JSON.stringify(id) + ')')
    }
    if (byId.has(id)) {
      throw new Error('task-tree: duplicate node id ' + JSON.stringify(id) + ' in one write')
    }
    const parent = node.parent === undefined ? undefined : node.parent.trim()
    const detail = node.detail === undefined ? undefined : node.detail.trim()
    const entry: Entry = {
      id,
      parent: parent === undefined || parent === '' ? undefined : parent,
      title,
      detail: detail === undefined || detail === '' ? undefined : detail,
    }
    entries.push(entry)
    byId.set(id, entry)
  }
  for (const entry of entries) {
    if (entry.parent === undefined) continue
    if (entry.parent === entry.id) {
      throw new Error('task-tree: node ' + JSON.stringify(entry.id) + ' names itself as its parent')
    }
    if (!byId.has(entry.parent) && !known.has(entry.parent)) {
      throw new Error(
        'task-tree: node ' + JSON.stringify(entry.id) + ' names an unknown parent '
        + JSON.stringify(entry.parent) + '; a `parent` must be an id carried by this write or by the stored tree',
      )
    }
  }
  // Each parent chain is walked once and its verdict memoized, so the whole list
  // costs O(n) rather than one walk per node. An id met twice ON ONE CHAIN is the
  // cycle: flat lists have no structural protection, and `a.parent=b` with
  // `b.parent=a` must be refused rather than walked.
  const settled = new Set<string>()
  for (const entry of entries) {
    if (settled.has(entry.id)) continue
    const walked: string[] = []
    const onChain = new Set<string>()
    let cursor: Entry | undefined = entry
    while (cursor !== undefined && !settled.has(cursor.id)) {
      if (onChain.has(cursor.id)) {
        throw new Error('task-tree: the `parent` links form a cycle: ' + [...walked, cursor.id].join(' -> '))
      }
      onChain.add(cursor.id)
      walked.push(cursor.id)
      cursor = cursor.parent === undefined ? undefined : byId.get(cursor.parent)
    }
    for (const id of walked) settled.add(id)
  }
  return entries
}

/**
 * Turn a flat forest into a nested one.
 *
 * Implemented as an explicit worklist rather than recursion: a long chain is
 * data, not a reason to grow the JavaScript stack, and each node is placed
 * exactly once (its `children` array is taken from a per-parent group that is
 * consumed on the node's own visit).
 * @param roots - the top-level ids, in display order.
 * @param childrenOf - child ids per parent id, in display order.
 * @param byId - every node by id.
 * @returns the nested forest.
 * @throws When the result would carry a duplicate id, which a cross-linked
 *   parent table can produce.
 */
function assemble(
  roots: readonly string[],
  childrenOf: ReadonlyMap<string, string[]>,
  byId: ReadonlyMap<string, Entry>,
): PlanNode[] {
  // Pass 1: walk the nesting from the roots with an EXPLICIT worklist — a long
  // chain is data, not a reason to grow the JavaScript stack — and place every
  // node it reaches. A node reached twice is a cross-link the parent table
  // cannot express as a tree, and is refused here.
  const built = new Map<string, PlanNode>()
  const pending = [...roots]
  while (pending.length > 0) {
    const id = pending.pop()
    if (id === undefined) break
    if (built.has(id)) {
      throw new Error('task-tree: the `parent` links do not form a tree (duplicate node ' + JSON.stringify(id) + ')')
    }
    const entry = byId.get(id)
    if (entry === undefined) throw new Error('task-tree: unknown node ' + JSON.stringify(id))
    const node: PlanNode = { id: entry.id, title: entry.title, status: 'pending' }
    if (entry.detail !== undefined) node.detail = entry.detail
    built.set(id, node)
    for (const child of childrenOf.get(id) ?? []) pending.push(child)
  }
  // Pass 2: attach the children, now that every reachable node is placed. That
  // is what makes the result a tree rather than a parent table with stubs.
  for (const [id, node] of built) {
    const kids = childrenOf.get(id) ?? []
    if (kids.length > 0) node.children = kids.map(child => builtNode(built, child))
  }
  return roots.map(id => builtNode(built, id))
}

/**
 * Read a node {@link assemble} has already built.
 *
 * The worklist pushes a node's children BEFORE it places that node, so every id
 * in a `children` array is in the map by construction. The throw states that
 * invariant instead of asserting it away.
 * @param built - the nodes placed so far.
 * @param id - the id to read.
 * @returns the node.
 * @throws When the id was never placed.
 */
function builtNode(built: ReadonlyMap<string, PlanNode>, id: string): PlanNode {
  const node = built.get(id)
  if (node === undefined) {
    throw new Error('task-tree: internal error, node ' + JSON.stringify(id) + ' was not built')
  }
  return node
}

/**
 * Verify the tree that was ASSEMBLED rather than the flat list it came from:
 * the two are different values and only the assembled one is stored.
 *
 * The walk is depth-first over the real nesting, so an id reachable twice (a
 * cross-link a flat list cannot express directly) and a node lost entirely both
 * surface here — the caller compares the returned count against the number of
 * nodes it expected.
 * @param nodes - the assembled forest.
 * @returns the total node count.
 * @throws When an id appears twice.
 */
function assertNoDuplicates(nodes: readonly PlanNode[]): number {
  const seen = new Set<string>()
  let total = 0
  const walk = (list: readonly PlanNode[]): void => {
    for (const node of list) {
      if (seen.has(node.id)) {
        throw new Error('task-tree: node ' + JSON.stringify(node.id) + ' appears twice in the assembled tree')
      }
      seen.add(node.id)
      total += 1
      if (node.children !== undefined) walk(node.children)
    }
  }
  walk(nodes)
  return total
}

/**
 * Build a whole tree from a flat list — the `replace` path.
 * @param entries - the validated flat nodes, in input order.
 * @returns the nested forest.
 * @throws When the assembly would drop or duplicate a node.
 */
export function buildTree(entries: readonly Entry[]): PlanNode[] {
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const roots: string[] = []
  const childrenOf = new Map<string, string[]>()
  for (const entry of entries) {
    if (entry.parent === undefined) {
      roots.push(entry.id)
      continue
    }
    const siblings = childrenOf.get(entry.parent)
    if (siblings === undefined) childrenOf.set(entry.parent, [entry.id])
    else siblings.push(entry.id)
  }
  const tree = assemble(roots, childrenOf, byId)
  const total = assertNoDuplicates(tree)
  if (total !== entries.length) {
    throw new Error(
      'task-tree: the write declares ' + String(entries.length) + ' node(s) but only '
      + String(total) + ' are reachable from the roots',
    )
  }
  return tree
}

// --- merge ------------------------------------------------------------------

/**
 * Merge a flat list into the stored tree — the `replace: false` path.
 *
 * The granularity, stated exactly:
 *
 * - a node NOT mentioned is kept as it is, in place, with its whole subtree and
 *   its runtime fields (status, assignment, answer); nothing is pruned;
 * - a node mentioned keeps its runtime fields and has `title` and `detail`
 *   overwritten — a mention WITHOUT `detail` clears the detail, which is the one
 *   destructive edit a merge can make;
 * - a node mentioned WITH `parent` is MOVED there — from wherever it currently
 *   sits, root level included, with its subtree — and is appended after the
 *   siblings already there;
 * - a node mentioned WITHOUT `parent` keeps the parent it has, or becomes a root
 *   when it is new;
 * - a new node is `pending` and carries no runtime fields.
 *
 * Every node of the stored tree is carried over, so a merge never loses work
 * another writer declared; the assembled result is verified before it returns.
 * @param tree - the session's stored tree.
 * @param entries - the validated flat nodes of this write.
 * @returns the merged forest.
 * @throws When the assembly would drop or duplicate a node.
 */
export function mergeTree(tree: readonly PlanNode[], entries: readonly Entry[]): PlanNode[] {
  const byId = new Map<string, Entry>()
  // The stored nodes THEMSELVES, not a summary of them: a merge must carry a
  // node's runtime fields (status, assignedTo, answer, dependsOn, task) over
  // untouched, and re-deriving them from an `Entry` is how a merge would roll a
  // `completed` node back to `pending`.
  const carried = new Map<string, PlanNode>()
  const order: string[] = []
  const parentOf = new Map<string, string | undefined>()
  const childrenOf = new Map<string, string[]>()
  const key = (parent: string | undefined): string => parent ?? ''
  const group = (parent: string | undefined, id: string): void => {
    const siblings = childrenOf.get(key(parent))
    if (siblings === undefined) childrenOf.set(key(parent), [id])
    else siblings.push(id)
  }
  const collect = (list: readonly PlanNode[], parent: string | undefined): void => {
    for (const node of list) {
      parentOf.set(node.id, parent)
      carried.set(node.id, node)
      order.push(node.id)
      if (node.children !== undefined) collect(node.children, node.id)
    }
  }
  collect(tree, undefined)

  // The flat list is authoritative for every id it names: its title and detail
  // replace the stored ones, and its `parent` — when given — replaces the stored
  // position. Runtime fields are NOT taken from it, because a flat node carries
  // none: a merge must not roll a node's status back to `pending`.
  const mentioned = new Set<string>()
  const entryOf = new Map(entries.map(entry => [entry.id, entry]))
  for (const entry of entries) {
    mentioned.add(entry.id)
    const held = carried.get(entry.id)
    if (held === undefined) {
      parentOf.set(entry.id, entry.parent)
      if (!order.includes(entry.id)) order.push(entry.id)
      continue
    }
    // A stored node keeps EVERYTHING except the two fields a flat node carries:
    // its status, its assignment, its answer and its task prompt survive, and
    // `parent` is taken from the write when the write names one.
    if (entry.parent !== undefined) parentOf.set(entry.id, entry.parent)
    carried.set(entry.id, { ...held, title: entry.title })
  }
  // Only now is every node's final parent known, so the entry table (the
  // assembly's view of the tree) is derived from it: a mentioned node's `parent`
  // was just written, and re-reading a stale one here would undo the move.
  for (const id of order) {
    const held = carried.get(id)
    const mentionedEntry = entryOf.get(id)
    const parent = parentOf.get(id)
    if (mentionedEntry !== undefined && held !== undefined) {
      byId.set(id, {
        id,
        parent,
        title: mentionedEntry.title,
        detail: mentionedEntry.detail,
      })
      continue
    }
    if (mentionedEntry !== undefined) {
      byId.set(id, mentionedEntry)
      continue
    }
    byId.set(id, { id, parent, title: held?.title ?? id, detail: held?.detail })
  }
  // The detail is applied here rather than above because it lives on the carried
  // node: a mention without `detail` CLEARS the stored line, which is the one
  // destructive edit a merge can make.
  for (const entry of entries) {
    const held = carried.get(entry.id)
    if (held === undefined) continue
    const next: PlanNode = { ...held, title: entry.title }
    if (entry.detail === undefined) delete next.detail
    else next.detail = entry.detail
    carried.set(entry.id, next)
  }
  // Stored order first, then this write's order, so a group's order is stable
  // across merges and a moved or new node lands after the siblings already there.
  for (const id of order) if (!mentioned.has(id)) group(parentOf.get(id), id)
  for (const id of order) if (mentioned.has(id)) group(parentOf.get(id), id)

  const roots: string[] = []
  for (const [parent, kids] of childrenOf) if (parent === '') roots.push(...kids)
  // The assembly builds a bare node for every id; the runtime fields come from
  // the carried originals, so a merge never loses a node's status or assignment.
  const merged = assemble(roots, childrenOf, byId).map(function restore(node) {
    return mergeRuntime(node, carried)
  })
  const total = assertNoDuplicates(merged)
  if (total !== byId.size) {
    throw new Error(
      'task-tree: the merge would leave ' + String(byId.size - total)
      + ' node(s) unreachable: the `parent` links named by this write and the stored tree form a cycle',
    )
  }
  return merged
}

// --- the port ---------------------------------------------------------------

/**
 * Put one assembled node's runtime fields back, recursively, from the stored
 * nodes the merge carried over. A node the write introduced has no stored
 * original and keeps the assembled shape (status `pending`, nothing else).
 * @param node - the assembled node.
 * @param carried - the stored originals, by id.
 * @returns the node with its runtime fields restored.
 */
function mergeRuntime(node: PlanNode, carried: ReadonlyMap<string, PlanNode>): PlanNode {
  const held = carried.get(node.id)
  const restored: PlanNode = held === undefined ? { ...node } : { ...held, title: node.title }
  if (node.detail === undefined) delete restored.detail
  else restored.detail = node.detail
  if (node.children === undefined) delete restored.children
  else restored.children = node.children.map(child => mergeRuntime(child, carried))
  return restored
}

/**
 * Rebuild the spine from the root to one node, applying `patch` to it.
 *
 * The unchanged branches are returned BY REFERENCE, so a step matching nothing
 * is detectable by identity — that is how the port knows a `step` naming an
 * unknown id costs no write.
 * @param nodes - the tree to update.
 * @param id - the addressed node's id.
 * @param patch - the fields to write; an absent field is left standing.
 * @returns a new tree, or `null` when no node carries `id`.
 */
function patchNode(
  nodes: readonly PlanNode[],
  id: string,
  patch: { status?: PlanStatus; detail?: string },
): PlanNode[] | null {
  let changed = false
  const next = nodes.map((node) => {
    if (node.id === id) {
      changed = true
      const updated: PlanNode = { ...node }
      if (patch.status !== undefined) updated.status = patch.status
      if (patch.detail !== undefined) {
        // Same convention as `plan_step`: a blank detail clears it, because a
        // caller that cannot clear a field has a one-way door. An ABSENT detail
        // is not a patch at all and leaves the stored line standing.
        if (patch.detail.trim() === '') delete updated.detail
        else updated.detail = patch.detail.trim()
      }
      return updated
    }
    if (node.children === undefined) return node
    const children = patchNode(node.children, id, patch)
    if (children === null) return node
    changed = true
    return { ...node, children }
  })
  return changed ? next : null
}

/**
 * Every id of one tree.
 * @param nodes - the tree to walk.
 * @param into - the set to fill; a fresh one when omitted.
 * @returns the set of ids.
 */
function collectIds(nodes: readonly PlanNode[], into: Set<string> = new Set()): Set<string> {
  for (const node of nodes) {
    into.add(node.id)
    if (node.children !== undefined) collectIds(node.children, into)
  }
  return into
}

/**
 * Find one node by id, depth-first in declaration order.
 * @param nodes - the tree to search.
 * @param id - the id to find.
 * @returns the node, or `undefined`.
 */
function findPlanNode(nodes: readonly PlanNode[], id: string): PlanNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node
    if (node.children === undefined) continue
    const found = findPlanNode(node.children, id)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Write `assignedTo` on one node, rebuilding only the spine to it.
 * @param nodes - the tree to update.
 * @param id - the addressed node's id.
 * @param assignedTo - the child session id to record.
 * @returns a new tree, or `null` when no node carries `id`.
 */
function patchAssignedTo(nodes: readonly PlanNode[], id: string, assignedTo: string): PlanNode[] | null {
  let changed = false
  const next = nodes.map((node) => {
    if (node.id === id) {
      changed = true
      return { ...node, assignedTo }
    }
    if (node.children === undefined) return node
    const children = patchAssignedTo(node.children, id, assignedTo)
    if (children === null) return node
    changed = true
    return { ...node, children }
  })
  return changed ? next : null
}

/** The rejection for a node id the session's tree does not carry. */
function unknownNode(id: string): Error {
  return new Error('task-tree: no node with id ' + JSON.stringify(id) + ' in this session\'s tree')
}

/** The rejection for a session that has no tree at all. */
function unknownSession(sessionId: string, action: string): Error {
  return new Error(
    'task-tree: session ' + JSON.stringify(sessionId) + ' has no tree to ' + action
    + '; write one with the `task plan` action first',
  )
}

/**
 * The `taskTree` service over one {@link PlanTreeStore}.
 *
 * It has NO storage of its own: every read is `store.get` and every write goes
 * through `store.replace` or `store.updateStored`, which is what keeps the port
 * inside the store's revision CAS and its retry budget
 * (`PLAN_TREE_WRITE_ATTEMPTS` / `PLAN_TREE_WRITE_BACKOFF_MS`). A second store
 * would put the `task` tool and the panel on two documents that could disagree.
 *
 * `step` and `bind` compute their mutation INSIDE the store's write loop
 * (`updateStored`), so a node another writer added between this call's read and
 * its write is not clobbered: the loser re-reads, re-applies and writes again.
 * @param store - this context's plan tree store.
 * @returns the port the `task` tool reaches through `ctx.get('taskTree')`.
 */
export function createTaskTreePort(store: PlanTreeStore): TaskTreePort {
  return {
    read(sessionId: string): readonly TaskNode[] {
      // No tree yet is an EMPTY TREE, not an error: reading the tree of a
      // session that has not planned anything is legitimate. A read also never
      // throws when the settings namespace is not composed — the store simply
      // has nothing to hand back.
      const stored = store.get(sessionId)
      return stored === undefined ? [] : stored.map(toTaskNode)
    },

    readMerged(sessionId: string, maxDepth = 1): readonly TaskNode[] {
      // 读取侧合并：子代理照常写自己那棵树（sessionId(exec)），父侧在这里顺着
      // bind 记下的 assignedTo 递归拼进来。子代理对这件事一无所知——这正是
      // 「子代理只负责自己那一部分，程序自动合并」的全部实现。
      // 两件事分开做，混在一起就会把子树的嵌套结构铺平（第一版就是这么错的）：
      //   deepen  —— 在【已嵌套】的节点上继续往下拼更深的委派层，shape 不动；
      //   splice   —— 只在【顶层列表】上做一次，把被派发的子会话整棵树挂上去。
      // toTaskNode 已经把一棵树递归转好了，所以子树的 children 必须原样保留，
      // 绝不能再 map 一遍——那会把 c1 的孩子 c2 提到与 c1 平级。
      const deepen = (node: TaskNode, depth: number): TaskNode => {
        const own = node.children === undefined
          ? []
          : node.children.map((kid) => deepen(kid, depth))
        const child = node.assignedTo
        // depth 用尽、没派过活、或那个会话没有树：保持原样。
        // 「子代理没留下树」不是错误，读不到就是没有。
        if (depth <= 0 || child === undefined || child === '') {
          return own.length === 0 ? node : { ...node, children: own }
        }
        const sub = store.get(child)
        if (sub === undefined) return own.length === 0 ? node : { ...node, children: own }
        // 子会话那棵树整体挂在这个节点下面，内部嵌套原样带过来。
        const grafted = sub.map(toTaskNode).map((kid) => deepen(kid, depth - 1))
        return { ...node, children: [...own, ...grafted] }
      }
      const splice = (nodes: readonly TaskNode[], depth: number): readonly TaskNode[] =>
        nodes.map((node) => deepen(node, depth))
      const stored = store.get(sessionId)
      return stored === undefined ? [] : splice(stored.map(toTaskNode), maxDepth)
    },

    async write(sessionId: string, nodes: readonly FlatNode[], replace: boolean): Promise<void> {
      if (replace) {
        await store.replace(sessionId, buildTree(validateFlatNodes(nodes)))
        return
      }
      if (nodes.length === 0) return
      if (store.get(sessionId) === undefined) {
        // A merge into a session that has NO tree CREATES one. The alternative —
        // `updateStored` on an absent session, which reports `undefined` and
        // writes nothing — would turn the port's most ordinary first call
        // (`task plan` without `replace`) into a silent no-op, and the caller
        // would be told the plan was recorded when no document carries it.
        await store.replace(sessionId, buildTree(validateFlatNodes(nodes)))
        return
      }
      await store.updateStored(sessionId, (current) => {
        // The stored tree is read INSIDE the write loop, so the parent ids a
        // merge may name are the ones the document holds at write time, not the
        // ones this call happened to read a revision earlier.
        const entries = validateFlatNodes(nodes, collectIds(current))
        return mergeTree(current, entries)
      })
    },

    async step(
      sessionId: string,
      nodeId: string,
      patch: { status?: TaskNodeStatus; detail?: string },
    ): Promise<void> {
      const id = nodeId.trim()
      if (id === '') throw new Error('task-tree: `nodeId` must be a non-empty string')
      if (patch.status === undefined && patch.detail === undefined) {
        throw new Error('task-tree: `step` was given neither a `status` nor a `detail` to write')
      }
      const applied = await store.updateStored(sessionId, (current) => {
        const next = patchNode(current, id, {
          ...(patch.status === undefined ? {} : { status: toPlanStatus(patch.status) }),
          ...(patch.detail === undefined ? {} : { detail: patch.detail }),
        })
        if (next === null) throw unknownNode(id)
        return next
      })
      // `undefined` means the session has no tree at all — the mutation is never
      // called for a session without one — which is a different mistake from a
      // missing node and is reported as one.
      if (applied === undefined) throw unknownSession(sessionId, 'step')
    },

    async bind(sessionId: string, nodeId: string, childId: string): Promise<void> {
      const id = nodeId.trim()
      if (id === '') throw new Error('task-tree: `nodeId` must be a non-empty string')
      const child = childId.trim()
      if (child === '') throw new Error('task-tree: `childId` must be a non-empty string')
      const applied = await store.updateStored(sessionId, (current) => {
        if (findPlanNode(current, id) === undefined) throw unknownNode(id)
        return patchAssignedTo(current, id, child) ?? current
      })
      if (applied === undefined) throw unknownSession(sessionId, 'bind')
    },
  }
}

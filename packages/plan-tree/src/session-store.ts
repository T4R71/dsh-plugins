/**
 * THE per-session plan-tree store, outside the session log.
 *
 * The tree cannot live in a session's own log. This package wrote two event
 * types, \`plan/declared\` and \`plan/step\`, and neither is in 0.1.7's
 * \`KNOWN_SESSION_EVENT_TYPES\`; \`Session.append\` takes no envelope option, so
 * the event cannot be marked \`ignorable\`, and a log carrying it is refused
 * WHOLE by \`validateStoredEvents\`
 * (\`dsh-session-persistence/lib/index.js:182-197\`, :184 is the throw). A
 * session this package had written to could therefore not be opened at all
 * after a restart.
 *
 * The trees live instead in this package's OWN settings namespace,
 * \`plan-tree-sessions\`, partitioned by session id. That namespace is a
 * separate Loader entry from \`plan-tree\` because the row's namespace carries
 * the settings page's read/write/defaultGroups form: an undeclared field inside
 * that row would be projected into the row's form. This namespace declares
 * exactly one field (\`trees\`) and the settings page never renders it.
 *
 * The session log therefore no longer records the plan at all. What replaces
 * the folded projection is this document: the host writes the whole field
 * through \`ctx.get("settings").replace(...)\` under a revision CAS, and the
 * browser half reads the same document out of the shared settings describe
 * mirror (\`@t4r71/dsh-ui-task-tree\`).
 *
 * @module @t4r71/dsh-plan-tree/session-store
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Dict } from '@deepseek-ai/cosmokit'
import type { PlanNode } from './types.ts'

/**
 * The settings namespace holding every session's plan tree. It is a Loader
 * entry id (\`cordis.patch.yml\`), which is what \`SettingsForms.write\` looks up.
 */
export const PLAN_TREE_NAMESPACE = 'plan-tree-sessions'

/** The single Config field: session id -> plan tree. */
export const PLAN_TREE_FIELD = 'trees'

/** The whole stored field: session id -> declared tree. */
export type PlanTreeField = Readonly<Record<string, readonly PlanNode[]>>

/**
 * This entry's composition config. The field is \`.volatile()\` because 0.1.7
 * refuses an entry with no volatile field outright
 * (\`packages/settings/settings/src/index.ts:385-386\`) and because path writes
 * are refused for every non-volatile path (:387-389).
 *
 * \`z.dict(z.any())\` rather than a per-session object schema: the keys are
 * session ids, which no schema can enumerate. The VALUES are validated by
 * {@link parsePlanTreesField}, where an unreadable tree is dropped rather than
 * rejected — the same rule the browser half's \`planTreeOf\` follows, so the two
 * halves never disagree about which sessions have a tree.
 *
 * Annotated rather than inferred: \`z.dict\`'s output names \`Dict\` from
 * \`@deepseek-ai/cosmokit\`, and declaration emit refuses a type it can only
 * reach through a nested \`node_modules\` path (TS2883). The annotation states
 * the same type through that package's own entry.
 */
export const Config: z<{ trees: Dict<any> }> = z.object({
  trees: z.dict(z.any()).default({}).volatile(),
})

/**
 * The bridge to the host's settings service, declared structurally on purpose.
 *
 * This package resolves every \`@deepseek-ai/*\` import from its own
 * \`node_modules\` by design, and it does not depend on
 * \`@deepseek-ai/dsh-settings\`: the only two members it needs are \`describe\`
 * and \`replace\`, whose contract is fixed by the settings service itself. A real
 * import would put that package on this one's dependency list for no gain, and a
 * composition without settings must still LOAD this plugin — every read of the
 * service goes through \`ctx.get("settings")\`, never through \`inject\`.
 */
export interface PlanTreeSettingsFacade {
  /**
   * Project every configurable entry's current form values.
   * @returns one descriptor per live volatile entry, keyed by namespace.
   */
  describe(): readonly { ns: string; value: unknown; revision: number }[]
  /**
   * Reset this namespace's volatile fields, then set the supplied ones.
   * @param ns - the entry id.
   * @param section - the complete form values to keep.
   * @param expectedRevision - the revision \`describe\` reported; a write under
   *   a stale revision is refused with the settings service's conflict error.
   */
  replace(ns: string, section: object, expectedRevision?: number): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The host's settings service, when the composition mounts it. Declared
     * here because this package never imports \`@deepseek-ai/dsh-settings\`;
     * the shape is {@link PlanTreeSettingsFacade}, which declares only the two
     * members this package calls.
     */
    settings?: PlanTreeSettingsFacade
  }
}

/** How many times one write re-reads the revision after a conflict. */
export const PLAN_TREE_WRITE_ATTEMPTS = 4

/** Milliseconds before attempt N is issued, N counted from zero. */
export const PLAN_TREE_WRITE_BACKOFF_MS: readonly number[] = [0, 25, 75, 200]

/**
 * A whole-document write was refused because another writer moved the settings
 * document between this writer's read and its write.
 *
 * It is thrown, never swallowed: the tree a tool just reported as written is not
 * in force unless it was stored, and reporting success for a lost write would
 * leave the panel showing a plan the model does not have.
 */
export class PlanTreeConflictError extends Error {
  /** Stable machine code for callers that map failures to their own taxonomy. */
  readonly code = 'PLAN_TREE_CONFLICT'
  /** The namespace whose write was refused. */
  readonly ns = PLAN_TREE_NAMESPACE
  /** Attempts made before giving up. */
  readonly attempts: number

  /**
   * @param cause - the last conflict the settings service raised.
   * @param attempts - attempts made before giving up.
   */
  constructor(cause: unknown, attempts: number) {
    super(
      'plan-tree: the settings document changed under this writer '
      + String(attempts) + ' times while storing a plan tree; nothing was written',
      { cause },
    )
    this.name = 'PlanTreeConflictError'
    this.attempts = attempts
  }
}

/** Whether a value is a plain data object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value is one of the four lifecycle states. */
function isStatus(value: unknown): boolean {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'blocked'
}

/**
 * Read one stored node, or \`undefined\` when its shape is unreadable.
 *
 * Untrusted input: a human may have edited the settings document, so a node that
 * does not carry an id, a title and a legal status is dropped instead of being
 * rendered as a nameless row. Optional members are dropped when their type is
 * wrong for the same reason, but never invented.
 * @param value - the untrusted node.
 * @returns the validated node, or \`undefined\`.
 */
function parsePlanNode(value: unknown): PlanNode | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.id !== 'string' || value.id === '') return undefined
  if (typeof value.title !== 'string' || value.title === '') return undefined
  if (!isStatus(value.status)) return undefined
  const node: PlanNode = { id: value.id, title: value.title, status: value.status as PlanNode['status'] }
  if (typeof value.detail === 'string') node.detail = value.detail
  if (typeof value.task === 'string') node.task = value.task
  if (typeof value.assignedTo === 'string') node.assignedTo = value.assignedTo
  if (typeof value.answer === 'string') node.answer = value.answer
  if (Array.isArray(value.dependsOn) && value.dependsOn.every(dep => typeof dep === 'string')) {
    node.dependsOn = [...value.dependsOn as string[]]
  }
  if (Array.isArray(value.children) && value.children.length > 0) {
    const children: PlanNode[] = []
    for (const child of value.children) {
      const parsed = parsePlanNode(child)
      if (parsed === undefined) return undefined
      children.push(parsed)
    }
    node.children = children
  }
  return node
}

/**
 * Read one session's stored tree out of the untrusted document.
 * @param value - the raw \`trees[sessionId]\` entry.
 * @returns the tree, or \`undefined\` when it is absent or unreadable.
 */
export function parsePlanTree(value: unknown): PlanNode[] | undefined {
  if (!Array.isArray(value)) return undefined
  const nodes: PlanNode[] = []
  for (const item of value) {
    const node = parsePlanNode(item)
    if (node === undefined) return undefined
    nodes.push(node)
  }
  return nodes
}

/**
 * Read the whole stored field.
 *
 * Total on purpose: an unreadable session entry is DROPPED rather than thrown
 * on, because one hand-broken record must not make every other session's plan
 * unreadable — and because the browser half reads the same document and applies
 * the same rule, so host and panel agree on which sessions carry a tree.
 * @param value - the untrusted \`trees\` field.
 * @returns every readable tree, by session id.
 */
export function parsePlanTreesField(value: unknown): Record<string, readonly PlanNode[]> {
  if (!isRecord(value)) return {}
  const parsed: Record<string, readonly PlanNode[]> = {}
  for (const [id, raw] of Object.entries(value)) {
    const tree = parsePlanTree(raw)
    if (tree !== undefined) parsed[id] = tree
  }
  return parsed
}

/** Options for {@link PlanTreeStore}. */
export interface PlanTreeStoreOptions {
  /** Attempts per write; defaults to {@link PLAN_TREE_WRITE_ATTEMPTS}. */
  readonly attempts?: number
  /** Backoff before attempt N; defaults to {@link PLAN_TREE_WRITE_BACKOFF_MS}. */
  readonly backoffMs?: readonly number[]
  /** Delay used by {@link PlanTreeStore.sleep}; injectable so tests do not wait. */
  readonly sleep?: (ms: number) => Promise<void>
}

/** What one mutation did to a session's tree. */
export type PlanTreeMutation = (nodes: readonly PlanNode[]) => readonly PlanNode[]

/**
 * The read and write face of {@link PLAN_TREE_NAMESPACE}: the session tree the
 * four tools walk, with the whole-document write that keeps it.
 *
 * Reads go through \`settings.describe()\`, the same projection the settings page
 * renders from, and are memoized on the namespace's \`revision\` — which 0.1.7
 * bumps exactly when that entry's stored profile override changes
 * (\`dsh-settings/lib/index.js:428-435\`). A tool dispatch therefore pays one
 * \`describe()\` per document change, not one per node.
 */
export class PlanTreeStore {
  private readonly options: Required<PlanTreeStoreOptions>
  private cachedRevision: number | undefined
  private cachedRecords: Record<string, readonly PlanNode[]> = {}
  /** Parsed trees by the JSON spelling that produced them. */
  private readonly bySpelling = new Map<string, Record<string, readonly PlanNode[]>>()

  /**
   * @param ctx - host context; the settings service is looked up, never
   *   injected, so a composition without settings still loads this plugin's
   *   tools (they simply have no tree to walk).
   * @param options - retry policy and the sleep used between attempts.
   */
  constructor(private readonly ctx: Context, options: PlanTreeStoreOptions = {}) {
    this.options = {
      attempts: options.attempts ?? PLAN_TREE_WRITE_ATTEMPTS,
      backoffMs: options.backoffMs ?? PLAN_TREE_WRITE_BACKOFF_MS,
      sleep: options.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })),
    }
  }

  /**
   * This namespace's current settings row, or \`undefined\` when no settings
   * service is mounted or the entry is not composed.
   * @returns the descriptor carrying the value and the revision.
   */
  private descriptor(): { value: unknown; revision: number } | undefined {
    const settings = this.ctx.get('settings')
    if (settings === undefined) return undefined
    return settings.describe().find(row => row.ns === PLAN_TREE_NAMESPACE)
  }

  /**
   * Whether the namespace this store writes is served at all.
   *
   * False means the \`plan-tree-sessions\` Loader row is not active (or no
   * settings service is mounted), which is the one case where a write cannot
   * even be attempted. A row that exists with an empty field is NOT this case:
   * that is simply a deployment with no plan declared yet.
   * @returns whether \`replace\` has a namespace to write.
   */
  served(): boolean {
    return this.descriptor() !== undefined
  }

  /**
   * Every stored tree, by session id.
   * @returns the parsed field.
   */
  records(): Record<string, readonly PlanNode[]> {
    const descriptor = this.descriptor()
    if (descriptor === undefined) return {}
    if (descriptor.revision === this.cachedRevision) return this.cachedRecords
    const value = isRecord(descriptor.value) ? descriptor.value[PLAN_TREE_FIELD] : undefined
    const spelling = JSON.stringify(value ?? null)
    let records = this.bySpelling.get(spelling)
    if (records === undefined) {
      records = parsePlanTreesField(value)
      this.bySpelling.set(spelling, records)
    }
    this.cachedRevision = descriptor.revision
    this.cachedRecords = records
    return records
  }

  /**
   * One session's stored tree.
   * @param sessionId - the session whose plan to read.
   * @returns the tree, or \`undefined\` when this session has none yet.
   */
  get(sessionId: string): readonly PlanNode[] | undefined {
    return this.records()[sessionId]
  }

  /**
   * Replace one session's tree wholesale.
   *
   * A whole-document write of the field, not a path write: removal needs the
   * whole map anyway (a session whose declaration drops nodes replaces its
   * array), and a per-id path write cannot prune. Every attempt re-reads the
   * revision, so an edit that landed between the read and the write is retried
   * against the value it produced instead of being overwritten from a stale
   * snapshot.
   * @param sessionId - the session the tree belongs to.
   * @param nodes - the complete next tree.
   * @throws {PlanTreeConflictError} when every attempt lost the revision race.
   * @throws When no settings service serves this namespace.
   */
  async replace(sessionId: string, nodes: readonly PlanNode[]): Promise<void> {
    await this.replaceRecords({ ...this.records(), [sessionId]: nodes })
  }

  /**
   * Re-derive one session's tree and store the result.
   *
   * The mutation runs INSIDE the write loop, against the field as it stands at
   * that moment: that is what makes a step atomic without a lock — two writers
   * adding different nodes to one session cannot clobber each other, because the
   * loser re-reads, re-applies and writes again (the projection this replaced
   * got the same property from the log's per-event fold).
   * @param sessionId - the session to update.
   * @param mutate - applies the change to the tree as it stands; called once per
   *   attempt, so it must be pure.
   * @returns whether the change was applied — false when the session has no tree
   *   (the mutation is never called with \`undefined\`).
   * @throws {PlanTreeConflictError} when every attempt lost the revision race.
   * @throws When no settings service serves this namespace, which is checked
   *   before the mutation so a lost write is never reported as a success.
   */
  async update(sessionId: string, mutate: PlanTreeMutation): Promise<boolean> {
    return await this.writeRecords(records => {
      const current = records[sessionId]
      if (current === undefined) return undefined
      return { ...records, [sessionId]: mutate(current) }
    })
  }

  /**
   * Append one node at the END of the ROOT level, without touching any other node.
   *
   * The tree is not restated, and this is deliberately NOT a whole-tree
   * replacement: \`plan_write\` means "the plan is settled, here it is" and
   * REPLACES everything, so re-sending one to add a single node would drop work
   * declared in between by another writer. Appending states the ONE new fact.
   * @param sessionId - the session to update.
   * @param node - the node to append.
   * @returns whether the session had a tree to append to.
   */
  async append(sessionId: string, node: PlanNode): Promise<boolean> {
    return await this.update(sessionId, nodes => [...nodes, node])
  }

  /**
   * {@link PlanTreeStore.update} for a change computed by the caller from the
   * tree it just read, kept honest by re-reading before the write.
   *
   * The returned tree is what the caller should report, because it is the value
   * that was actually stored: the caller's own fold of the tree it read may be
   * one document-revision stale, and reporting a tree the document does not
   * carry would make the panel and the tool disagree.
   * @param sessionId - the session to update.
   * @param mutate - applies the change to the tree as it stands.
   * @returns the stored tree, or \`undefined\` when the session has no tree.
   * @throws {PlanTreeConflictError} when every attempt lost the revision race.
   */
  async updateStored(
    sessionId: string,
    mutate: PlanTreeMutation,
  ): Promise<readonly PlanNode[] | undefined> {
    let stored: readonly PlanNode[] | undefined
    const applied = await this.writeRecords(records => {
      const current = records[sessionId]
      if (current === undefined) return undefined
      stored = mutate(current)
      return { ...records, [sessionId]: stored }
    })
    return applied ? stored : undefined
  }

  /**
   * Run one whole-field mutation under the revision CAS, retrying while the
   * fence refuses it.
   * @param mutate - derives the complete next field, or \`undefined\` to abort
   *   without writing (the caller's preconditions did not hold).
   * @returns whether a write landed.
   * @throws {PlanTreeConflictError} when every attempt was refused.
   * @throws When no settings service serves this namespace.
   */
  private async writeRecords(
    mutate: (records: Record<string, readonly PlanNode[]>) => Record<string, readonly PlanNode[]> | undefined,
  ): Promise<boolean> {
    const settings = this.ctx.get('settings')
    if (settings === undefined || !this.served()) {
      throw new Error(
        'plan-tree: no configurable plugin entry "' + PLAN_TREE_NAMESPACE
        + '"; the plan tree store cannot be written',
      )
    }
    let conflict: unknown
    for (let attempt = 0; attempt < this.options.attempts; attempt += 1) {
      const backoff = this.options.backoffMs[attempt]
        ?? this.options.backoffMs[this.options.backoffMs.length - 1]
        ?? 0
      if (backoff > 0) await this.options.sleep(backoff)
      const next = mutate(this.records())
      if (next === undefined) return false
      const revision = this.descriptor()?.revision
      try {
        await settings.replace(PLAN_TREE_NAMESPACE, { [PLAN_TREE_FIELD]: next }, revision)
        return true
      } catch (error: unknown) {
        conflict = error
      }
    }
    throw new PlanTreeConflictError(conflict, this.options.attempts)
  }

  /**
   * Replace the whole field, retrying while the revision fence refuses it.
   * @param records - the complete next field.
   * @throws {PlanTreeConflictError} when every attempt was refused.
   */
  private async replaceRecords(records: Record<string, readonly PlanNode[]>): Promise<void> {
    const applied = await this.writeRecords(() => records)
    // Total by construction — the mutation always returns a field — so this is
    // the no-settings guard above having already thrown.
    if (!applied) throw new Error('plan-tree: the plan tree store refused a whole-field write')
  }
}

/** Stores by host context, so every consumer of one process shares one cache. */
const stores = new WeakMap<Context, PlanTreeStore>()

/**
 * The store of one host context. The tools hold no store of their own: they must
 * keep working in a composition that never mounted the settings service, where
 * the store simply has nothing to read.
 * @param ctx - host context.
 * @returns the shared store.
 */
export function planTreeStore(ctx: Context): PlanTreeStore {
  const existing = stores.get(ctx)
  if (existing !== undefined) return existing
  const created = new PlanTreeStore(ctx)
  stores.set(ctx, created)
  return created
}

/**
 * This entry's plugin body.
 *
 * The entry exists for its Config: \`SettingsForms.describe\` projects the schemas
 * of LOADED entries, so the plan tree store has no namespace to live in until a
 * Loader row activates with this plugin. The body itself does nothing — every
 * read and write goes through {@link PlanTreeStore}, which the \`plan-tree\` row
 * owns.
 * @returns nothing.
 */
async function apply(): Promise<void> {}

/**
 * \`Loader.unwrapExports\` returns \`exports.default\` and DROPS every sibling named
 * export, while the registry reads the schema off the plugin value itself. The
 * Config therefore has to ride the default export.
 */
export interface PlanTreeStoreEntry {
  /** Does nothing; every read and write goes through {@link PlanTreeStore}. */
  (): Promise<void>
  /** This entry's composition config, projected by the settings form. */
  Config: z<{ trees: Dict<any> }>
}

/**
 * The Loader entry's value: the no-op apply carrying the Config the registry
 * reads off the plugin value itself. Spelled as an interface for the same reason
 * {@link Config} is annotated — the inferred type of \`Object.assign(apply, {
 * Config })\` names \`Dict\` from \`@deepseek-ai/cosmokit\`, which declaration emit
 * cannot reach by name.
 */
const entry: PlanTreeStoreEntry = Object.assign(apply, { Config })

export default entry

// \`name\` is only settable through defineProperty: Function.name is configurable
// but not writable, so Object.assign's [[Set]] would throw.
Object.defineProperty(apply, 'name', { value: 'plan-tree-sessions', configurable: true })

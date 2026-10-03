/**
 * THE per-session plan-tree store, in SQLite.
 *
 * The tree cannot live in a session's own log: \`plan/declared\` and
 * \`plan/step\` are not in the harness's \`KNOWN_SESSION_EVENT_TYPES\`, and a log
 * carrying an unknown type is refused WHOLE, so such a session could not be
 * opened after a restart.
 *
 * It lived instead in this package's own settings namespace,
 * \`plan-tree-sessions\`, as one YAML document. That was wrong twice over:
 *
 *  1. The settings document IS the profile's \`cordis.patch.yml\`. Storing a
 *     plan tree there meant every \`plan_step\` re-parsed and rewrote the whole
 *     profile document (311 KB / 5496 lines at the time of the change), and the
 *     revision CAS that fences it is recomputed on every \`describe()\`, so the
 *     write loop lost its own fence and reported
 *     "the settings document changed under this writer 4 times". Orchestration
 *     was dead: \`task plan\`, \`task step\` and \`task ask\` all failed.
 *  2. One malformed byte anywhere in that document made the WHOLE profile
 *     unreadable, and the host refuses to start on a profile it cannot parse.
 *     A comment containing a literal backslash-n did exactly that.
 *
 * This module replaces that document with one SQLite database holding one row
 * per session. A write is one \`INSERT ... ON CONFLICT DO UPDATE\` of one row;
 * there is no document to re-parse, no revision to lose, and a damaged row
 * costs one session rather than the whole profile.
 *
 * @module @t4r71/dsh-plan-tree/session-store
 */

import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PlanNode } from './types.ts'

/** Basename of the database under the harness home's \`storages\` directory. */
export const PLAN_TREE_DB_FILE = 'plan-tree.db'

/** The table holding one row per session. */
export const PLAN_TREE_TABLE = 'plan_tree_sessions'

/**
 * A tree could not be stored or read back.
 *
 * It is thrown, never swallowed: the tree a tool just reported as written is
 * not in force unless it was stored, and reporting success for a lost write
 * would leave the model's plan and the stored plan disagreeing.
 */
export class PlanTreeStoreError extends Error {
  override readonly name = 'PlanTreeStoreError'
  /**
   * @param message - what failed, in the caller's terms.
   * @param options - the underlying failure, kept as \`cause\`.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions)
  }
}

/** One row as it comes back from SQLite. */
interface Row {
  session_id: string
  tree: string
}

/**
 * The minimum of \`node:sqlite\`'s \`DatabaseSync\` this store uses.
 *
 * Declared structurally rather than imported: \`node:sqlite\` is a runtime
 * builtin with no type package this bundle can resolve, and the three methods
 * below are its whole surface here.
 */
export interface SqliteStatement {
  /** Run the statement and return every row. */
  all(...params: unknown[]): unknown[]
  /** Run the statement once. */
  run(...params: unknown[]): unknown
}

/** The \`node:sqlite\` database handle this store uses. */
export interface SqliteDatabase {
  /** Prepare a statement for repeated execution. */
  prepare(sql: string): SqliteStatement
  /** Run one statement with no result. */
  exec(sql: string): void
  /** Close the handle. */
  close(): void
}

/** How the store obtains its database handle. */
export type DatabaseOpener = (file: string) => SqliteDatabase

/**
 * Open the harness home's \`storages\` directory without importing the harness.
 *
 * \`DSH_HOME\` is set by the launcher; \`DSH_PROFILE_DIR\` names the profile,
 * whose parent is the home. The last fallback is the process's own directory
 * tree, which is where the desktop host always runs from.
 * @returns an absolute directory path; the caller creates it.
 */
function storageDir(): string {
  const home = process.env['DSH_HOME']
  if (home !== undefined && home !== '') return join(home, 'storages')
  const profile = process.env['DSH_PROFILE_DIR']
  if (profile !== undefined && profile !== '') return join(profile, '..', 'storages')
  return join(process.cwd(), 'storages')
}

/** Lazily resolved \`node:path\` helpers, kept out of the module's value imports. */

/**
 * Open a database handle through \`node:sqlite\`.
 *
 * Loaded through \`createRequire\` rather than a static import so that a
 * composition whose runtime has no \`node:sqlite\` still LOADS this plugin: only
 * a store that is actually opened fails.
 * @param file - absolute database path.
 * @returns the open handle.
 */
function openSqliteSync(file: string): SqliteDatabase {
  const require = createRequire(import.meta.url)
  const sqlite = require('node:sqlite') as {
    DatabaseSync: new (path: string) => SqliteDatabase
  }
  return new sqlite.DatabaseSync(file)
}

/** Options for {@link PlanTreeStore}. */
export interface PlanTreeStoreOptions {
  /** Absolute database path; defaults to the harness home's storages directory. */
  file?: string
  /** Database opener, injectable so tests need no real \`node:sqlite\`. */
  open?: DatabaseOpener
}

/**
 * The per-session plan-tree store.
 *
 * Reads are served from an in-memory map that is authoritative for this
 * process and is loaded once when the database opens. Writes go straight to
 * SQLite and update that map only after the row landed.
 */
export class PlanTreeStore {
  private readonly options: PlanTreeStoreOptions
  private database: SqliteDatabase | undefined
  private readonly rows = new Map<string, readonly PlanNode[]>()

  /**
   * @param options - database location and opener.
   */
  constructor(options: PlanTreeStoreOptions = {}) {
    this.options = options
    this.database = this.connect()
  }

  /** @returns the absolute database path this store uses. */
  file(): string {
    return this.options.file ?? join(storageDir(), PLAN_TREE_DB_FILE)
  }

  /**
   * Open the database, create the table, and load every stored row.
   *
   * Synchronous on purpose: \`reads are the tool path's hot path and the store's
   * own readers (\`records\`/\`get\`) are synchronous by contract, so the load has
   * to have happened by the time the constructor returns. \`node:sqlite\`'s
   * \`DatabaseSync\` is a synchronous API, which is what makes that possible.
   * @returns the open handle.
   * @throws {PlanTreeStoreError} when the database cannot be opened.
   */
  private connect(): SqliteDatabase {
    const file = this.file()
    try {
      mkdirSync(dirname(file), { recursive: true })
    } catch { /* an existing directory is the normal case */ }
    let database: SqliteDatabase
    try {
      database = this.options.open !== undefined ? this.options.open(file) : openSqliteSync(file)
    } catch (error: unknown) {
      throw new PlanTreeStoreError('plan-tree: opening ' + file + ' failed', { cause: error })
    }
    try {
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA synchronous = NORMAL')
      database.exec(
        'CREATE TABLE IF NOT EXISTS ' + PLAN_TREE_TABLE
        + ' (session_id TEXT PRIMARY KEY, tree TEXT NOT NULL, updated_at INTEGER NOT NULL)',
      )
      const rows = database.prepare('SELECT session_id, tree FROM ' + PLAN_TREE_TABLE).all() as Row[]
      for (const row of rows) {
        const parsed = parseStoredTree(row.tree)
        if (parsed !== undefined) this.rows.set(row.session_id, parsed)
      }
    } catch (error: unknown) {
      throw new PlanTreeStoreError('plan-tree: preparing ' + file + ' failed', { cause: error })
    }
    return database
  }

  /**
   * The open database.
   * @returns the handle.
   * @throws {PlanTreeStoreError} when the store was closed.
   */
  private ready(): SqliteDatabase {
    if (this.database === undefined) {
      throw new PlanTreeStoreError('plan-tree: the plan tree store is closed')
    }
    return this.database
  }

  /**
   * Whether this store can be written at all.
   *
   * Always true once the database opens. It exists because the settings-backed
   * store it replaced could be un-served by its composition, and callers still
   * ask.
   * @returns whether a write has somewhere to go.
   */
  served(): boolean {
    return true
  }

  /**
   * Every stored tree, by session id.
   * @returns the parsed map, a fresh object each call.
   */
  records(): Record<string, readonly PlanNode[]> {
    return Object.fromEntries(this.rows)
  }

  /**
   * One session's stored tree.
   * @param sessionId - the session whose plan to read.
   * @returns the tree, or \`undefined\` when this session has none yet.
   */
  get(sessionId: string): readonly PlanNode[] | undefined {
    return this.rows.get(sessionId)
  }

  /**
   * Replace one session's tree wholesale.
   * @param sessionId - the session the tree belongs to.
   * @param nodes - the complete next tree.
   * @throws {PlanTreeStoreError} when the row could not be written.
   */
  async replace(sessionId: string, nodes: readonly PlanNode[]): Promise<void> {
    await this.store(sessionId, nodes)
  }

  /**
   * Re-derive one session's tree and store the result.
   *
   * The mutation runs against the tree as it stands in this process. Two
   * writers adding different nodes to one session cannot clobber each other
   * silently: the mutation sees the current value and its result is what is
   * written.
   * @param sessionId - the session to update.
   * @param mutate - applies the change to the tree as it stands.
   * @returns whether the change was applied — false when the session has no tree.
   * @throws {PlanTreeStoreError} when the row could not be written.
   */
  async update(sessionId: string, mutate: (nodes: readonly PlanNode[]) => readonly PlanNode[]): Promise<boolean> {
    const current = this.rows.get(sessionId)
    if (current === undefined) return false
    await this.store(sessionId, mutate(current))
    return true
  }

  /**
   * Append one node at the END of the ROOT level, without touching any other node.
   * @param sessionId - the session to update.
   * @param node - the node to append.
   * @returns whether the session had a tree to append to.
   */
  async append(sessionId: string, node: PlanNode): Promise<boolean> {
    return await this.update(sessionId, nodes => [...nodes, node])
  }

  /**
   * {@link PlanTreeStore.update} that also returns the stored tree.
   * @param sessionId - the session to update.
   * @param mutate - applies the change to the tree as it stands.
   * @returns the stored tree, or \`undefined\` when the session has no tree.
   */
  async updateStored(
    sessionId: string,
    mutate: (nodes: readonly PlanNode[]) => readonly PlanNode[],
  ): Promise<readonly PlanNode[] | undefined> {
    const current = this.rows.get(sessionId)
    if (current === undefined) return undefined
    const next = mutate(current)
    await this.store(sessionId, next)
    return next
  }

  /** Remove one session's tree. */
  async remove(sessionId: string): Promise<void> {
    const database = this.ready()
    database.prepare('DELETE FROM ' + PLAN_TREE_TABLE + ' WHERE session_id = ?').run(sessionId)
    this.rows.delete(sessionId)
  }

  /** Close the database. */
  close(): void {
    this.database?.close()
    this.database = undefined
  }

  /**
   * Write one row and update the in-memory map.
   *
   * The row lands FIRST: reporting a tree as stored that SQLite refused would
   * make the tools and the stored plan disagree.
   */
  private async store(sessionId: string, nodes: readonly PlanNode[]): Promise<void> {
    const database = this.ready()
    const tree = JSON.stringify(nodes)
    try {
      database.prepare(
        'INSERT INTO ' + PLAN_TREE_TABLE + ' (session_id, tree, updated_at) VALUES (?, ?, ?)'
        + ' ON CONFLICT(session_id) DO UPDATE SET tree = excluded.tree, updated_at = excluded.updated_at',
      ).run(sessionId, tree, Date.now())
    } catch (error: unknown) {
      throw new PlanTreeStoreError('plan-tree: storing the tree of session ' + sessionId + ' failed', { cause: error })
    }
    this.rows.set(sessionId, nodes)
  }
}

/**
 * Parse one stored tree.
 *
 * Exported because the read path is a pure step worth testing on its own: a row
 * another writer left malformed must be reported as no tree rather than
 * throwing out of a read.
 * @param text - the stored JSON text.
 * @returns the tree, or \`undefined\` when the row is unreadable.
 */
export function parseStoredTree(text: string): readonly PlanNode[] | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return Array.isArray(value) ? value as PlanNode[] : undefined
  } catch {
    return undefined
  }
}

/** Stores by host context, so every consumer of one process shares one store. */
const stores = new WeakMap<Context, PlanTreeStore>()

/**
 * The database every NEW store opens.
 *
 * A test sets this before mounting the plugin so the plugin's own store writes a
 * database that dies with the test instead of the profile's real one; production
 * never calls it and the default is the harness home's \`storages\` directory.
 */
let defaultDatabase: PlanTreeStoreOptions | undefined

/**
 * Choose the database every store created from now on opens.
 * @param options - database location and opener; \`undefined\` restores the default.
 * @returns nothing.
 */
export function setPlanTreeDatabase(options: PlanTreeStoreOptions | undefined): void {
  defaultDatabase = options
}

/**
 * Replace one host context's store.
 *
 * Exposed so a test can point a mounted plugin at a database dying with the
 * test: the plugin builds its store from the context, and the real one writes
 * the profile's own database.
 * @param ctx - host context whose store to replace.
 * @param store - the store to install.
 * @returns nothing.
 */
export function setPlanTreeStore(ctx: Context, store: PlanTreeStore): void {
  const root = (ctx as { root?: Context }).root ?? ctx
  stores.set(root, store)
}

/**
 * The store of one host context.
 * @param ctx - host context.
 * @returns the shared store.
 */
export function planTreeStore(ctx: Context): PlanTreeStore {
  // Keyed by the ROOT context, not by the context handed in: cordis derives a
  // child context per plugin, so two callers holding the same application can
  // hold different \`ctx\` objects. Keying by the argument would hand them two
  // stores over one database, and a tree written through one would read back
  // empty through the other.
  const root = (ctx as { root?: Context }).root ?? ctx
  const existing = stores.get(root)
  if (existing !== undefined) return existing
  const created = new PlanTreeStore(defaultDatabase ?? {})
  stores.set(root, created)
  return created
}

/**
 * This entry's plugin body.
 *
 * The entry exists only so a Loader row can name it; every read and write goes
 * through {@link PlanTreeStore}, which the \`plan-tree\` row owns. It is kept
 * because the profile still lists a \`plan-tree-sessions\` row and a row that
 * resolves to nothing would fail the whole profile load.
 * @returns nothing.
 */
async function apply(): Promise<void> {}

/** The Loader entry's value: a no-op apply. */
export default apply

// \`name\` is only settable through defineProperty: Function.name is configurable
// but not writable, so Object.assign's [[Set]] would throw.
Object.defineProperty(apply, 'name', { value: 'plan-tree-sessions', configurable: true })

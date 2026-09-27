/**
 * THE per-session axis store, outside the session log.
 *
 * The axes cannot live in a session's own log: this package's own event type is
 * not in 0.1.7's `KNOWN_SESSION_EVENT_TYPES`, and `Session.append` takes no
 * envelope option, so the event cannot be marked `ignorable` and a log carrying
 * it is refused WHOLE by `validateStoredEvents`
 * (`packages/session/session-persistence/src/storage-contract.ts:75-77`).
 * A session this package had written to could therefore not be opened at all
 * after a restart.
 *
 * The axes live instead in this package's OWN settings namespace,
 * `dual-axis-sessions`, partitioned by session id. That namespace is a
 * separate Loader entry from `dual-axis` because the row's namespace carries the
 * settings page's read/write/defaultGroups form: an undeclared field inside that
 * row would be projected into the row's form. This namespace declares exactly one
 * field and the settings page never renders it.
 *
 * `sandbox/mode` REMAINS the write axis's legal landing place in the log — see
 * `./session-axes.ts`, which mirrors the write base onto it. The log therefore
 * still records the containment the operating-system layer enforces; what it no
 * longer records is the path-level axis pair, which is this module's.
 *
 * A session with NO record is neither an error state nor a reason to hide a
 * control: every live decision path reads through {@link SessionAxesStore.ensure},
 * which answers {@link seedAxesFor} — the deployment seed a newly created session
 * is pinned with — and hands that SAME value to the ONE repair write it
 * schedules. Such a session therefore runs under the deployment's seed from its
 * first read, not under {@link DEFAULT_AXES} until the record lands, and the pair
 * a picker shows before the record exists is the pair the fence and the prompt
 * are already enforcing (the client half recomputes that seed from the same row —
 * see `sessionAxesSeed` in `@t4r71/dsh-dual-axis-ui`).
 * {@link DEFAULT_AXES} is now only the answer {@link SessionAxesStore.getOr} gives
 * a caller that holds no session to build a seed from.
 *
 * A session with no record that has ALSO never been used is a different case, and
 * it is the one the workspace picker creates every time: reopening the same
 * workspace reopens the same session id, so freezing it at creation would pin the
 * axes of a conversation nobody has had to whatever the settings row said that
 * day. Its record is therefore written when it is USED ({@link hasContent}), not
 * when it is created: until then every read recomputes the seed from the row as
 * it stands NOW, and the dropdown follows the settings page in real time.
 *
 * @module @t4r71/dsh-dual-axis/session-store
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Dict } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import type { Session } from '@deepseek-ai/dsh-session'
import { DEFAULT_READ_SCOPE, DEFAULT_WRITE_SCOPE } from './axis.ts'
import type { AxisScope, EffectiveScopes } from './axis.ts'
import { axesOf, declaredSection, defaultGroupIds, normalizeScope } from './config.ts'
import { parseNarrowing, seedGroupReferences } from './groups.ts'
import type { WriteNarrowing } from './groups.ts'
import { hasContent } from './content.ts'

/**
 * The settings namespace holding every session's axis pair. It is a Loader entry
 * id (`cordis.patch.yml`), which is what `SettingsForms.write` looks up.
 */
export const SESSION_AXES_NAMESPACE = 'dual-axis-sessions'

/** The single Config field: session id -> axis pair. */
export const SESSION_AXES_FIELD = 'axes'

/**
 * One session's stored axis pair, keyed by session id inside
 * {@link SESSION_AXES_FIELD}. Both members are the session's own preset, group
 * references included; a group's rules are never copied here, so editing a group
 * still reaches every session that references it.
 */
export interface SessionAxesRecord {
  /** The read axis preset. */
  readonly read: AxisScope
  /** The write axis preset. */
  readonly write: AxisScope
  /**
   * What the write-never-exceeds-read invariant removed from that write axis, as
   * the resolution computed it.
   *
   * Stored rather than recomputed by the reader because only the host can compute
   * it: the resolution canonicalizes every root with `realpath` and derives a
   * `workspace` base from `os.tmpdir()`. A browser surface showing a narrowing
   * the fence does not enforce — or missing one it does — is worse than showing
   * none, so the display reads the resolution's own output instead of a second
   * implementation of the path algebra.
   *
   * Absent for a record written before this member existed, and for a record
   * whose write range the intersection left alone: the reader then shows no
   * narrowing, which is what the fence enforced in both cases.
   */
  readonly narrowing?: WriteNarrowing
}

/** The whole stored field: session id -> pair. */
export type SessionAxesField = Readonly<Record<string, SessionAxesRecord>>

/**
 * This entry's composition config. The field is `.volatile()` because 0.1.7
 * refuses an entry with no volatile field outright
 * (`packages/settings/settings/src/index.ts:385-386`) and because path writes
 * are refused for every non-volatile path (`:387-389`).
 *
 * `z.dict(z.any())` rather than a per-session object schema: the keys are session
 * ids, which no schema can enumerate, and the VALUES are validated by
 * {@link parseSessionAxesField}, where an unreadable axis becomes a throw rather
 * than an invented boundary — the same rule the row's own axes follow.
 *
 * Annotated rather than inferred: `z.dict`'s output names `Dict` from
 * `@deepseek-ai/cosmokit`, and declaration emit refuses a type it can only reach
 * through a nested `node_modules` path (TS2883). The annotation states the same
 * type through that package's own entry.
 */
export const Config: z<{ axes: Dict<any> }> = z.object({
  axes: z.dict(z.any()).default({}).volatile(),
})

/**
 * The pair {@link SessionAxesStore.getOr} answers for a session with no stored
 * record, and nothing else.
 *
 * It is deliberately NOT what a session with no record is held to any more:
 * every live read goes through {@link SessionAxesStore.ensure}, which answers the
 * deployment's seed ({@link seedAxesFor}), so the pair in force is the pair the
 * session was created with rather than the built-in one. Reaching for this
 * constant on a decision path would hold a session to a boundary the settings
 * page never chose — narrower than an `all` default, wider than a `deny` one.
 * @see SessionAxesStore.getOr
 */
export const DEFAULT_AXES: EffectiveScopes = { read: DEFAULT_READ_SCOPE, write: DEFAULT_WRITE_SCOPE }

/**
 * The axis pair a session with no stored record is REPAIRED to — the same seed a
 * newly created session is pinned with.
 *
 * Repairing to the standing pair instead (`DEFAULT_AXES`) would be narrower but wrong: a
 * session whose creation-time write was lost would keep the built-in defaults
 * for the rest of its life, and the settings page's seed would never reach it.
 * Repairing to the seed keeps `pin`'s retry semantics intact — the retry just
 * happens on the next touch of the session instead of only at creation.
 *
 * The seed is computed from two synchronous reads: the settings row's
 * `read`/`write`/`defaultGroups` (seeds for a session that has none of its own)
 * and, for a subagent child, the parent's pair AS IT STANDS NOW. A parent with
 * no record of its own yields `undefined` from {@link inheritedAxes}, which is
 * the same answer `pin` gets, so parent and child agree in that case too.
 * @param ctx - host context; carries the settings service the seed is read from.
 * @param session - the session to seed.
 * @param fallback - the composing plugin's own config, used only when no settings
 *   service is mounted (where the namespace cannot be written anyway).
 * @returns the pair a newly created session would have been pinned with.
 */
export function seedAxesFor(
  ctx: Context,
  session: Session,
  fallback?: { readonly axes: EffectiveScopes; readonly groups: readonly string[] },
): EffectiveScopes {
  const section = declaredSection(ctx)
  const inherited = inheritedAxes(ctx, session)
  if (section === undefined) {
    // No settings row: the composing plugin's own config is the only seed source,
    // and it carries values the loader already validated, so nothing throws here.
    return seedGroupReferences(inherited ?? fallback?.axes ?? DEFAULT_AXES, fallback?.groups ?? [])
  }
  return seedPair(section, inherited)
}

/**
 * The pure core of {@link seedAxesFor}: one settings row value, plus the pair a
 * subagent child inherits, into the pair a session with no record is seeded with.
 *
 * It is TOTAL on purpose, and the client half mirrors it step for step
 * (`sessionAxesSeed` in `@t4r71/dsh-dual-axis-ui`, pinned by
 * `tests/seed-parity.spec.ts`): an unreadable row, and an unreadable inherited
 * pair, answer {@link DEFAULT_AXES}. That is also what a live read answers — see
 * {@link SessionAxesStore.ensure} — so the pair a picker shows for a session with
 * no record and the pair the host enforces are one value rather than two.
 * @param row - the settings row's value, untrusted: a human may have edited it.
 * @param inherited - the parent's pair for a subagent child, or `undefined`.
 * @returns the seed pair.
 */
export function seedPair(row: unknown, inherited: EffectiveScopes | undefined): EffectiveScopes {
  try {
    return seedGroupReferences(
      inherited === undefined ? axesOf(row) : pairOf(inherited),
      defaultGroupIds(row),
    )
  } catch {
    // An invented boundary is worse than the deployment's built-in one, and this
    // is the answer every other reader of an unreadable document already gives.
    return DEFAULT_AXES
  }
}

/**
 * Re-normalize a pair another reader produced.
 *
 * A pair this package stored is already normalized; a hand-edited document's is
 * not, and the inherited pair the client half reads comes straight off the wire.
 * Running both through the same validation is what makes the two halves agree on
 * the bytes, not merely on the kinds.
 * @param pair - the untrusted pair.
 * @returns the normalized pair.
 * @throws When either member is not a legal axis value.
 */
function pairOf(pair: EffectiveScopes): EffectiveScopes {
  return { read: normalizeScope('read', pair.read), write: normalizeScope('write', pair.write) }
}

/**
 * The pair a **subagent child session** inherits, or `undefined` when this is not
 * a child or its parent holds no record.
 *
 * A child does not read the settings page: 0.1.7 deliberately seeds a child with
 * its parent's explicit per-session override, and the parent's STORED pair is the
 * only copy of that override this package has. Returning `undefined` (rather than
 * inventing one) leaves the caller on the settings seed, which is what the child
 * would have received had the parent never overridden anything — and is exactly
 * the pair an un-recorded parent is itself held to.
 *
 * The record is looked up by the id the child's header names. The parent's own
 * Session object is NOT required: requiring it made the answer depend on whether
 * the parent happened to be resident in this process, and the client half — which
 * reads the same document by the same id — cannot observe residency, so the two
 * would disagree for a child whose parent is not materialized.
 * @param ctx - host context carrying the axis store.
 * @param session - the session whose parent to read.
 * @returns the parent's pair, or `undefined`.
 */
export function inheritedAxes(ctx: Context, session: Session): EffectiveScopes | undefined {
  if (session.header.origin !== 'subagent') return undefined
  const parentId = session.header.parentSession
  if (parentId === undefined) return undefined
  return sessionAxesStore(ctx).get(String(parentId))
}

/**
 * The one persistence read the sweep performs.
 *
 * Declared here rather than imported: this package resolves every
 * `@deepseek-ai/*` import from its own `node_modules` (tsconfig.base.json declares
 * no `paths`), and `@deepseek-ai/dsh-session-persistence` is not one of its
 * dependencies, so a type-only import of it would not resolve.
 * The member is declared OPTIONAL on purpose — a composition without persistence
 * (an in-memory session store) must not fail this plugin's load, it must simply
 * leave the sweep unable to judge.
 */
export interface SessionPersistenceLister {
  /**
   * List every stored session visible to this process.
   * @returns one entry per stored session, carrying its header.
   */
  list(): Promise<readonly { header: { id: string } }[]>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The mounted persistence backend, when the composition has one. */
    sessionPersistence?: SessionPersistenceLister
  }
}

/** The axes this package writes and the settings document it writes them through. */
export interface SessionAxesWriter {
  /** Project every configurable entry's current form values. */
  describe(): readonly { ns: string; value: unknown }[]
  /**
   * Reset this namespace's volatile fields, then set the supplied ones.
   * @param ns - the entry id.
   * @param section - the complete form values to keep.
   * @param expectedRevision - the revision `describe` reported, or none.
   */
  replace(ns: string, section: object, expectedRevision?: number): Promise<void>
}

/** How many times one write re-reads the revision after a conflict. */
export const AXES_WRITE_ATTEMPTS = 4

/** Milliseconds before attempt N is issued, N counted from zero. */
export const AXES_WRITE_BACKOFF_MS: readonly number[] = [0, 25, 75, 200]

/**
 * A whole-document write was refused because another writer moved the settings
 * document between this writer's read and its write.
 *
 * It is thrown, never swallowed: the axis a person just picked is not in force
 * unless it was stored, and reporting success for a lost write would leave the
 * fence enforcing a range the picker does not show.
 */
export class SessionAxesConflictError extends Error {
  /** Stable machine code for callers that map failures to their own taxonomy. */
  readonly code = 'DUAL_AXIS_AXES_CONFLICT'
  /** The namespace whose write was refused. */
  readonly ns = SESSION_AXES_NAMESPACE
  /** Attempts made before giving up. */
  readonly attempts: number

  /**
   * @param cause - the last conflict the settings service raised.
   * @param attempts - attempts made before giving up.
   */
  constructor(cause: unknown, attempts: number) {
    super(
      'dual-axis: the settings document changed under this writer '
      + String(attempts) + ' times while storing a session axis pair; nothing was written',
      { cause },
    )
    this.name = 'SessionAxesConflictError'
    this.attempts = attempts
  }
}

/**
 * Whether two narrowing reports say the same thing, so a republish that changes
 * nothing does not write the document.
 * @param left - one report, absent when nothing was ever published.
 * @param right - the other, absent under the same condition.
 * @returns whether both report the same removal.
 */
function sameNarrowing(left: WriteNarrowing | undefined, right: WriteNarrowing | undefined): boolean {
  if (left === undefined || right === undefined) return false
  return left.narrowed === right.narrowed
    && left.lostUnbounded === right.lostUnbounded
    && left.droppedRoots.length === right.droppedRoots.length
    && left.droppedRoots.every(root => right.droppedRoots.includes(root))
}

/**
 * Whether a value is a plain data object.
 * @param value - the candidate.
 * @returns whether it is an object that is not null and not an array.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one stored record into an axis pair, or throw naming the member that is
 * unreadable.
 * @param id - the session id the record belongs to, for the error message.
 * @param value - the untrusted record.
 * @returns the validated pair.
 * @throws When either member is not a legal axis value.
 */
export function parseSessionAxesRecord(id: string, value: unknown): SessionAxesRecord {
  if (!isRecord(value)) {
    throw new Error('dual-axis: the stored axes of session ' + JSON.stringify(id) + ' must be an object')
  }
  const narrowing = parseNarrowing(value.narrowing)
  return {
    read: normalizeScope('read', value.read ?? DEFAULT_READ_SCOPE),
    write: normalizeScope('write', value.write ?? DEFAULT_WRITE_SCOPE),
    // Omitted rather than stored as the empty report: a record that narrowed
    // nothing stays spelled exactly as it was before this member existed.
    ...narrowing.narrowed ? { narrowing } : {},
  }
}

/**
 * Read the whole stored field. A human may have edited the settings document, so
 * an unreadable entry throws instead of being dropped: dropping it would silently
 * widen that session back to the deployment defaults.
 * @param value - the untrusted `axes` field.
 * @returns every stored pair, by session id.
 * @throws When the field is not an object of readable records.
 */
export function parseSessionAxesField(value: unknown): Record<string, SessionAxesRecord> {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw new Error('dual-axis: the stored session axes field must be an object')
  const parsed: Record<string, SessionAxesRecord> = {}
  for (const [id, record] of Object.entries(value)) parsed[id] = parseSessionAxesRecord(id, record)
  return parsed
}

/**
 * The stored pair as this package spells it everywhere else. The stored record is
 * already a pair; this exists so the store's return type is the shared one and a
 * caller cannot start depending on the record's identity.
 * @param record - the stored pair.
 * @returns the same pair.
 */
function scopesOf(record: SessionAxesRecord): EffectiveScopes {
  return { read: record.read, write: record.write }
}

/** What one GC sweep removed. */
export interface SessionAxesSweep {
  /** Session ids whose records were dropped. */
  readonly removed: readonly string[]
  /** How many records the store held before the sweep. */
  readonly before: number
}

/** Options for {@link SessionAxesStore}. */
export interface SessionAxesStoreOptions {
  /** Attempts per write; defaults to {@link AXES_WRITE_ATTEMPTS}. */
  readonly attempts?: number
  /** Backoff before attempt N; defaults to {@link AXES_WRITE_BACKOFF_MS}. */
  readonly backoffMs?: readonly number[]
  /** Delay used by {@link SessionAxesStore.sleep}; injectable so tests do not wait. */
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * The read and write face of {@link SESSION_AXES_NAMESPACE}, plus the sweep that
 * keeps it from growing with the sessions that no longer exist.
 *
 * Reads go through `settings.describe()`, the same projection the settings page
 * renders from, and are memoized on the namespace's `revision` — which 0.1.7 bumps
 * exactly when that entry's stored profile override changes
 * (`packages/settings/settings/src/index.ts:311-317`). A decision path therefore
 * pays one `describe()` per document change, not one per tool dispatch.
 */
export class SessionAxesStore {
  private readonly options: Required<SessionAxesStoreOptions>
  private cachedRevision: number | undefined
  private cachedRecords: Record<string, SessionAxesRecord> = {}
  /** Parsed records by the JSON spelling that produced them. */
  private readonly bySpelling = new Map<string, Record<string, SessionAxesRecord>>()
  /**
   * Session ids with a repair write outstanding (or already landed) since the
   * record was found missing. Prevents one repair per tool dispatch while the
   * whole-document write is in flight; cleared when a write FAILS so the next
   * touch retries instead of leaving the session on the defaults forever.
   */
  private readonly repairing = new Set<string>()
  /**
   * The last narrowing report this store handed to a write, by session id. A
   * decision path re-resolves on every touch, so this is what keeps it from
   * queueing the same document write over and over; it is cleared when a write
   * lands (or fails), never on a read.
   */
  private readonly narrowingMemo = new Map<string, WriteNarrowing>()
  /** Sessions with a narrowing write outstanding right now. */
  private readonly narrowingWriting = new Set<string>()

  /**
   * @param ctx - host context; the settings service is looked up, never injected,
   *   so a composition without settings still loads this package's fence.
   * @param options - retry policy and the sleep used between attempts.
   */
  constructor(private readonly ctx: Context, options: SessionAxesStoreOptions = {}) {
    this.options = {
      attempts: options.attempts ?? AXES_WRITE_ATTEMPTS,
      backoffMs: options.backoffMs ?? AXES_WRITE_BACKOFF_MS,
      sleep: options.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })),
    }
  }

  /**
   * This namespace's current settings row, or `undefined` when no settings
   * service is mounted or the entry is not composed.
   * @returns the descriptor carrying the value and the revision.
   */
  private descriptor(): { value: unknown; revision: number } | undefined {
    const settings = this.ctx.get('settings')
    if (settings === undefined) return undefined
    return settings.describe().find(row => row.ns === SESSION_AXES_NAMESPACE)
  }

  /**
   * Every stored pair, by session id.
   * @returns the parsed field.
   * @throws When the document carries an unreadable record.
   */
  records(): Record<string, SessionAxesRecord> {
    const descriptor = this.descriptor()
    if (descriptor === undefined) return {}
    if (descriptor.revision === this.cachedRevision) return this.cachedRecords
    const value = isRecord(descriptor.value) ? descriptor.value[SESSION_AXES_FIELD] : undefined
    const spelling = JSON.stringify(value ?? null)
    let records = this.bySpelling.get(spelling)
    if (records === undefined) {
      records = parseSessionAxesField(value)
      this.bySpelling.set(spelling, records)
    }
    this.cachedRevision = descriptor.revision
    this.cachedRecords = records
    return records
  }

  /**
   * One session's stored pair.
   * @param sessionId - the session whose axes to read.
   * @returns the pair, or `undefined` when this session has no record yet.
   */
  get(sessionId: string): EffectiveScopes | undefined {
    const record = this.records()[sessionId]
    return record === undefined ? undefined : scopesOf(record)
  }

  /**
   * One session's stored pair, or the built-in defaults.
   *
   * The answer for a caller that has no session to build a seed from, and the only
   * remaining reader of {@link DEFAULT_AXES}. Every live path reads {@link ensure}
   * instead, whose un-recorded answer is the session's own seed.
   * @param sessionId - the session whose axes to read.
   * @returns the pair in force.
   */
  getOr(sessionId: string): EffectiveScopes {
    return this.get(sessionId) ?? DEFAULT_AXES
  }

  /**
   * One session's pair, with an un-recorded session scheduled for repair.
   *
   * This is the read every LIVE touch point uses (the model-facing prompt, the
   * read fence, and `/axis`). A session that has a record answers it; a session
   * that has none answers {@link seedAxesFor} — the pair `pin` writes for a newly
   * created session — and that ONE value is both this read's answer and what the
   * scheduled repair stores. The answer and the write therefore cannot disagree,
   * and a session created under a saved default runs under that default from its
   * FIRST turn instead of waiting for the record to land. The record is what
   * answers from the moment it lands.
   *
   * An un-recorded session is only REPAIRED when it has been used
   * ({@link hasContent}). Until then the seed is recomputed on every read, so the
   * settings row stays live: a session the workspace picker reopens before anyone
   * has sent anything follows the settings page, which is the whole point of not
   * having a record yet. The moment a turn lands, the next read repairs the
   * session and it freezes — the same seed it answered with, computed from the row
   * as it then stood.
   *
   * The seed is a thunk because only the caller can build it (it needs the
   * session, and the composing plugin's config for a settings-less host). It is
   * evaluated exactly once per un-recorded read — those reads are a prompt
   * assembly, a tool dispatch and a pick, never a hot loop — and it must have no
   * side effect, because its value IS this read's answer.
   * @param sessionId - the session whose axes to read.
   * @param seed - builds the pair a repair persists AND this read answers; never
   *   called when a record exists.
   * @param frozen - whether the session has been used, so its pair must be
   *   written rather than recomputed. Defaults to `true`: a caller that cannot
   *   judge the session's content keeps the pre-existing freeze-on-first-touch
   *   behaviour, which is the safe direction — it never widens a live session's
   *   axes behind the person's back.
   * @returns the pair in force right now.
   */
  ensure(sessionId: string, seed: () => EffectiveScopes, frozen = true): EffectiveScopes {
    const standing = this.get(sessionId)
    if (standing !== undefined) return standing
    let seeded: EffectiveScopes
    try {
      seeded = seed()
    } catch {
      // The thunk reads the settings document, which a human may have broken, and
      // — for a subagent child — the inherited pair parsed out of that same
      // document. Its value reaches a fence and a prompt, so this read is held to
      // DEFAULT_AXES (the pair the client half falls back to for a row it cannot
      // read) and the repair stays armed on the thunk, so a document repaired
      // later still reaches this session.
      if (frozen) this.scheduleRepair(sessionId, seed)
      return DEFAULT_AXES
    }
    // A session nobody has used keeps no record: its axes are this thunk's answer
    // recomputed from the settings row on the next read, which is what makes the
    // row live for it. ONE evaluation for both when it HAS been used: the repair
    // can only ever store the pair this read answered with.
    if (frozen) this.scheduleRepair(sessionId, () => seeded)
    return seeded
  }

  /**
   * Publish the narrowing a live read just resolved, when the record does not
   * already carry it.
   *
   * This is how the client half learns what the read axis removed from the write
   * range without re-implementing the path algebra: it reads this member out of
   * the same document its two dropdowns already read. The value comes from the
   * very resolution the prompt and the fence used, so the surfaced narrowing and
   * the enforced one are one computation rather than two that must agree.
   *
   * Called on every touch of a session that references groups, so an edit to a
   * group's rules is republished by the next touch instead of waiting for the
   * record to be rewritten for another reason. A session with no record is left
   * alone: its axes are recomputed from the settings row on every read, and a
   * store of its own would freeze that. Writes are fire-and-forget — a caller is
   * a synchronous decision path and its answer must not depend on a document
   * write.
   * @param sessionId - the session whose narrowing to publish.
   * @param narrowing - the value {@link resolveEffectiveAxes} returned for it.
   */
  refreshNarrowing(sessionId: string, narrowing: WriteNarrowing): void {
    const record = this.records()[sessionId]
    if (record === undefined) return
    const stored = record.narrowing
    // Nothing to publish and nothing to retire: the record already says exactly
    // what this resolution says, and the document is not written for that.
    if (stored === undefined && !narrowing.narrowed) return
    if (sameNarrowing(stored, narrowing)) {
      this.narrowingMemo.delete(sessionId)
      return
    }
    if (sameNarrowing(this.narrowingMemo.get(sessionId), narrowing)) return
    this.narrowingMemo.set(sessionId, narrowing)
    this.writeNarrowing(sessionId, narrowing)
  }

  /**
   * Store one narrowing report for a session that already has a record, at most
   * once per value.
   *
   * A failed write only forgets what was attempted: the next touch republishes
   * the same report, and the dropdowns keep showing the last stored one instead
   * of nothing. It never touches the axes, so a refresh that loses its race
   * cannot revert a pick.
   * @param sessionId - the session to update.
   * @param narrowing - the report to store.
   */
  private writeNarrowing(sessionId: string, narrowing: WriteNarrowing): void {
    if (this.narrowingWriting.has(sessionId)) return
    this.narrowingWriting.add(sessionId)
    void Promise.resolve()
      .then(async () => {
        const record = this.records()[sessionId]
        // Re-read at the last moment: a refresh is only ever due for a record the
        // document may have moved since, and this write must not carry a stale
        // report forward over a newer one.
        if (record === undefined) return
        const stored = record.narrowing
        if (stored === undefined && !narrowing.narrowed) return
        if (sameNarrowing(stored, narrowing)) return
        // The axes are carried over untouched; only this member moves. A report
        // that removed nothing is stored by OMITTING the member, and a stale one is
        // RETIRED — leaving it standing would show a narrowing the fence no longer
        // applies.
        const { narrowing: _retired, ...axes } = record
        await this.replaceRecords({
          ...this.records(),
          [sessionId]: { ...axes, ...narrowing.narrowed ? { narrowing } : {} },
        })
      })
      .catch((error: unknown) => {
        this.ctx.logger?.warn(
          'dual-axis: could not store the narrowing of session "%s"; the dropdowns keep the last stored report',
          sessionId,
        )
        this.ctx.logger?.warn(error)
      })
      .finally(() => {
        this.narrowingWriting.delete(sessionId)
        this.narrowingMemo.delete(sessionId)
      })
  }

  /**
   * Store one session's pair, whole-document, and report a lost write loudly.
   *
   * A single `replace` of the field: removal needs the whole map anyway, and a
   * per-id path write cannot prune. Every attempt re-reads the revision, so an
   * edit that landed between the read and the write is retried against the value
   * it produced instead of being overwritten from a stale snapshot.
   * @param sessionId - the session the pair belongs to.
   * @param axes - the pair to store.
   * @throws {SessionAxesConflictError} when every attempt lost the revision race.
   * @throws When no settings service serves this namespace.
   */
  async set(sessionId: string, axes: EffectiveScopes, narrowing?: WriteNarrowing): Promise<void> {
    await this.replaceRecords({
      ...this.records(),
      [sessionId]: {
        read: axes.read,
        write: axes.write,
        ...narrowing === undefined || !narrowing.narrowed ? {} : { narrowing },
      },
    })
    if (narrowing !== undefined) this.narrowingMemo.set(sessionId, narrowing)
  }

  /**
   * Persist one un-recorded session's seed, at most once until it lands.
   *
   * Fire-and-forget on purpose: every caller is a synchronous decision path
   * (a tool dispatch, a prompt assembly) that cannot await a whole-document
   * write, and none of them may fail because the repair could not be stored —
   * the answer that read already gave stands either way. A failed repair is
   * logged and re-armed.
   * @param sessionId - the session to repair.
   * @param seed - builds the pair to persist; may throw on an unreadable document.
   */
  private scheduleRepair(sessionId: string, seed: () => EffectiveScopes): void {
    if (this.repairing.has(sessionId)) return
    this.repairing.add(sessionId)
    // The seed reads the settings document, which a human may have broken; a
    // throw here must not escape into tool dispatch, so it is evaluated inside
    // the guarded chain rather than before it.
    void Promise.resolve()
      .then(async () => {
        // Re-checked at the last moment: a repair is only ever due for a session
        // that has no record. Something else — `/axis` itself, in the ordinary
        // case where the touch that scheduled this repair was a pick — may have
        // stored one while this chain was waiting, and overwriting THAT with the
        // seed would revert the change the person just made.
        if (this.get(sessionId) !== undefined) return
        await this.set(sessionId, seed())
        this.repairing.delete(sessionId)
      })
      .catch((error: unknown) => {
        this.repairing.delete(sessionId)
        this.ctx.logger?.warn(
          'dual-axis: could not store the axes of session "%s"; it stays on the default pair',
          sessionId,
        )
        this.ctx.logger?.warn(error)
      })
  }

  /**
   * Prune records whose session no longer exists.
   *
   * The deletion signal is the persistence layer itself: a session whose id is
   * absent from `sessionPersistence.list()` has no stored log. `session/disposed`
   * is NOT that signal — residency churn disposes a session whose file is still on
   * disk, and dropping its axes there would silently reset a session that is about
   * to be resumed.
   * @returns the ids dropped, or `undefined` when the sweep cannot judge (no
   *   persistence service mounted, or a listing failed): an unjudgeable sweep
   *   removes nothing.
   */
  async sweep(): Promise<SessionAxesSweep | undefined> {
    const records = this.records()
    const ids = Object.keys(records)
    if (ids.length === 0) return { removed: [], before: 0 }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    let live: ReadonlySet<string>
    try {
      const listed = await persistence.list()
      live = new Set(listed.map(snapshot => String(snapshot.header.id)))
    } catch (error) {
      this.ctx.logger?.warn('dual-axis: could not list stored sessions, keeping every axis record')
      this.ctx.logger?.warn(error)
      return undefined
    }
    const kept: Record<string, SessionAxesRecord> = {}
    const removed: string[] = []
    for (const id of ids) {
      const record = records[id]
      if (record === undefined) continue
      if (live.has(id)) kept[id] = record
      else removed.push(id)
    }
    if (removed.length === 0) return { removed: [], before: ids.length }
    await this.replaceRecords(kept)
    return { removed, before: ids.length }
  }

  /**
   * Replace the whole field, retrying while the revision fence refuses it.
   * @param records - the complete next field.
   * @throws {SessionAxesConflictError} when every attempt was refused.
   */
  private async replaceRecords(records: Record<string, SessionAxesRecord>): Promise<void> {
    const settings = this.ctx.get('settings')
    const entryExists = this.descriptor() !== undefined
    if (settings === undefined || !entryExists) {
      throw new Error(
        'dual-axis: no configurable plugin entry "' + SESSION_AXES_NAMESPACE
        + '"; the session axis store cannot be written',
      )
    }
    let conflict: unknown
    for (let attempt = 0; attempt < this.options.attempts; attempt += 1) {
      const backoff = this.options.backoffMs[attempt] ?? this.options.backoffMs[this.options.backoffMs.length - 1] ?? 0
      if (backoff > 0) await this.options.sleep(backoff)
      const revision = this.descriptor()?.revision
      try {
        await settings.replace(SESSION_AXES_NAMESPACE, { [SESSION_AXES_FIELD]: records }, revision)
        return
      } catch (error) {
        conflict = error
      }
    }
    throw new SessionAxesConflictError(conflict, this.options.attempts)
  }
}

/** Stores by host context, so every consumer of one process shares one cache. */
const stores = new WeakMap<Context, SessionAxesStore>()

/**
 * The store of one host context. Consumers hold no service of their own: the
 * fence and the prompt must keep working in a composition that never mounted the
 * settings service, where the store simply has nothing to read.
 * @param ctx - host context.
 * @returns the shared store.
 */
export function sessionAxesStore(ctx: Context): SessionAxesStore {
  const existing = stores.get(ctx)
  if (existing !== undefined) return existing
  const created = new SessionAxesStore(ctx)
  stores.set(ctx, created)
  return created
}

/**
 * This entry's plugin body.
 *
 * The entry exists for its Config: `SettingsForms.describe` projects the schemas
 * of LOADED entries, so the session axis store has no namespace to live in until
 * a Loader row activates with this plugin. The body itself does nothing — every
 * read and write goes through {@link SessionAxesStore}, which the composing
 * plugin owns.
 * @returns nothing.
 */
async function apply(): Promise<void> {}

/**
 * `Loader.unwrapExports` returns `exports.default` and DROPS every sibling named
 * export (`vendor/loader/src/index.ts:201-208`), while the registry reads the
 * schema off the plugin value itself. The Config therefore has to ride the
 * default export, exactly as `./read-guard.ts` attaches its own.
 */
export interface SessionStoreEntry {
  /** Does nothing; every read and write goes through {@link SessionAxesStore}. */
  (): Promise<void>
  /** This entry's composition config, projected by the settings form. */
  Config: z<{ axes: Dict<any> }>
}

/**
 * The Loader entry's value: the no-op apply carrying the Config the registry
 * reads off the plugin value itself. Spelled as an interface for the same reason
 * {@link Config} is annotated — the inferred type of `Object.assign(apply, {
 * Config })` names `Dict` from `@deepseek-ai/cosmokit`, which declaration emit
 * cannot reach by name.
 */
const entry: SessionStoreEntry = Object.assign(apply, { Config })

export default entry

// `name` is only settable through defineProperty: Function.name is configurable
// but not writable, so Object.assign's [[Set]] would throw.
Object.defineProperty(apply, 'name', { value: 'dual-axis-sessions', configurable: true })

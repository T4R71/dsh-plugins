/**
 * The narrowing report the settings document publishes: ONE resolution, ONE answer.
 *
 * The client half shows "the read axis narrowed the write axis, and these roots
 * were removed" from the session's stored record. It cannot compute that itself:
 * the resolution canonicalizes every root with `realpath` and derives a
 * `workspace` base from `os.tmpdir()`, neither of which exists in a browser.
 * This file is what keeps the published value and the enforced one the same
 * computation: it feeds the real store the value `resolveEffectiveAxes` returned
 * for a real preset and a real library, and asserts the record carries exactly
 * that — never a second, independently derived answer.
 *
 * The fixture's two roots are REAL directories outside both the workspace and the
 * OS temp area (which a `workspace` base includes, so a directory under the temp
 * area would be covered by it and would not be dropped). A root inside either
 * would make the case prove nothing.
 *
 * Run with:
 *   node --import tsx/esm --test tests/narrowing.spec.ts
 *
 * @module @t4r71/dsh-dual-axis/tests/narrowing
 */

import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import type { EffectiveScopes } from '../src/axis.ts'
import type { RuleGroup, WriteNarrowing } from '../src/groups.ts'
import { NO_NARROWING, parseNarrowing, resolveEffectiveAxes } from '../src/groups.ts'
import { resolveScope } from '../src/scope.ts'
import { SESSION_AXES_FIELD, SessionAxesStore, parseSessionAxesRecord } from '../src/session-store.ts'
import type { AxesDatabase } from '../src/session-store.ts'

/**
 * The two real directories the fixture works with.
 *
 * Deliberately NOT under the OS temp area: a `workspace` base includes that area
 * (`writableRoots`), so a root inside it is covered by a workspace-scoped read
 * axis and would never be dropped — the case would prove nothing.
 */
const WORKSPACE_ROOT = 'M:/T4/out/narrowing-ws'
const OUTSIDE = 'M:/T4/out/narrowing-out'

/**
 * A real directory, created if it is not there yet, returned in this platform's
 * own spelling — which is the spelling the host's algebra canonicalizes to.
 * @param path - the directory to create.
 * @returns its absolute path.
 */
function realDir(path: string): string {
  mkdirSync(path, { recursive: true })
  return resolve(path)
}

/**
 * The reported shape: a read axis that covers only the workspace, and a write
 * axis whose rule group grants a directory the read axis does not cover. The
 * group therefore grants nothing at all, which is what must be visible.
 */
function fixture(grant: string = OUTSIDE, base: 'all' | 'deny' = 'all'): {
  preset: EffectiveScopes
  library: readonly RuleGroup[]
} {
  return {
    preset: {
      read: { kind: 'workspace' },
      write: { kind: 'custom', base, groups: ['A'], allow: [], deny: [] },
    },
    library: [{ id: 'A', name: 'A', write: { allow: [grant] } }],
  }
}

/** A settings double over the one namespace the store writes. */
function fakeStore(): {
  store: SessionAxesStore
  writes(): number
  field(): Record<string, unknown>
  seed(record: Record<string, unknown>): Promise<void>
} {
  // One in-memory database, and a counter over the WRITE statements the store
  // issues against it. The settings double stays because the store still looks
  // the service up; it no longer holds the records.
  const handle = new DatabaseSync(':memory:') as unknown as AxesDatabase
  handle.exec(
    'CREATE TABLE IF NOT EXISTS dual_axis_sessions (session_id TEXT PRIMARY KEY, axes TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  )
  const rows: string[] = []
  const realPrepare = handle.prepare.bind(handle)
  let counting = true
  ;(handle as { prepare: unknown }).prepare = (sql: string) => {
    const statement = realPrepare(sql)
    if (!/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) return statement
    // Counts EXECUTIONS, not prepares: the store prepares its upsert on every
    // write, so counting prepares would count one write several times.
    const realRun = (statement as { run: unknown }).run.bind(statement)
    ;(statement as { run: unknown }).run = (...args: unknown[]) => {
      if (counting) rows.push(sql)
      return realRun(...args)
    }
    return statement
  }
  const settings = { describe: () => [] }
  const ctx = {
    get: (name: string) => (name === 'settings' ? settings : undefined),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  } as never
  const readRows = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const row of handle.prepare('SELECT session_id, axes FROM dual_axis_sessions').all() as { session_id: string; axes: string }[]) {
      out[row.session_id] = JSON.parse(row.axes) as unknown
    }
    return out
  }
  const store = new SessionAxesStore(ctx, { sleep: async () => {}, open: () => handle })
  return {
    store,
    writes: () => rows.length,
    // Wrapped in the field name, the shape every assertion below was written
    // against when this was a settings document.
    field: () => ({ [SESSION_AXES_FIELD]: readRows() }),
    seed: async (record: Record<string, unknown>) => {
      // Seeded through the STORE, not the handle: the store keeps an in-memory
      // copy of every row it loaded, so a row written behind its back would be
      // invisible to `refreshNarrowing` — which is exactly what that cache means
      // in production. The counter is paused across the seed so a test still
      // counts only the writes it is asserting about.
      counting = false
      try {
        for (const [id, value] of Object.entries(record)) {
          await store.set(id, value as EffectiveScopes)
        }
      } finally {
        counting = true
      }
    },
  }
}

/** Let the fire-and-forget narrowing write run to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

/** The stored narrowing of one session, as the document carries it. */
function storedNarrowing(document: Record<string, unknown>, id: string): unknown {
  const field = document[SESSION_AXES_FIELD] as Record<string, Record<string, unknown>> | undefined
  return field?.[id]?.narrowing
}

test('the two fixture roots sit outside the workspace AND the temp area', () => {
  // If either were inside the temp area, a `workspace` read axis would cover it
  // and the case below would prove nothing.
  const workspace = resolveScope({ kind: 'workspace' }, { workspaceRoot: realDir(WORKSPACE_ROOT) })
  // A workspace base is the workspace root PLUS the platform temp areas
  // (`writableRoots`), which is why the fixture's roots may not live under them.
  assert.ok(workspace.allow.includes(realDir(WORKSPACE_ROOT)), 'the workspace root itself is covered')
  assert.ok(!workspace.allow.includes(realDir(OUTSIDE)), 'the granted root is not covered by a workspace read axis')
})

test('the stored report is the resolution own answer, byte for byte', async () => {
  const { preset, library } = fixture()
  const resolved = resolveEffectiveAxes(preset, library, { workspaceRoot: realDir(WORKSPACE_ROOT) })
  assert.equal(resolved.ok, true, 'the fixture must resolve')
  if (!resolved.ok) return

  const fake = fakeStore()
  await fake.seed({ s1: { read: resolved.axes.read, write: resolved.axes.write } })
  fake.store.refreshNarrowing('s1', resolved.axes.narrowing)
  await flush()

  const published = storedNarrowing(fake.field(), 's1')
  assert.deepEqual(published, resolved.axes.narrowing, 'the published value IS the resolution value')
  assert.equal(JSON.stringify(published), JSON.stringify(resolved.axes.narrowing), 'same bytes, key order included')
})

test('a bounded write axis that loses its only root names that root', () => {
  const { preset, library } = fixture(OUTSIDE, 'deny')
  const resolved = resolveEffectiveAxes(preset, library, { workspaceRoot: realDir(WORKSPACE_ROOT) })
  assert.equal(resolved.ok, true)
  if (!resolved.ok) return
  // Canonicalized by the host's own algebra: a browser has neither realpath nor
  // os.tmpdir(), so this spelling can only come from the host's resolution.
  const canonical = resolveScope(
    { kind: 'custom', base: 'deny', allow: [OUTSIDE], deny: [] },
    { workspaceRoot: realDir(WORKSPACE_ROOT) },
  ).allow[0]
  assert.ok(canonical !== undefined)
  assert.deepEqual(resolved.axes.narrowing, {
    narrowed: true,
    droppedRoots: [canonical],
    lostUnbounded: false,
  } satisfies WriteNarrowing)
})

test('an unbounded write axis reduced to the read range reports the loss no root list can state', () => {
  const { preset, library } = fixture()
  const resolved = resolveEffectiveAxes(preset, library, { workspaceRoot: realDir(WORKSPACE_ROOT) })
  assert.equal(resolved.ok, true)
  if (!resolved.ok) return
  // Its allow list is never consulted while it is unbounded, so the loss is the
  // bound itself — and the surface has to say that, not print an empty list.
  assert.equal(resolved.axes.narrowing.narrowed, true)
  assert.equal(resolved.axes.narrowing.lostUnbounded, true)
})

test('widening the read axis over that directory publishes no narrowing at all', async () => {
  const { preset, library } = fixture()
  const resolved = resolveEffectiveAxes({ ...preset, read: { kind: 'all' } }, library, { workspaceRoot: realDir(WORKSPACE_ROOT) })
  assert.equal(resolved.ok, true)
  if (!resolved.ok) return
  // The root is still granted, so nothing was removed — the surface must show
  // nothing, and the store must not manufacture a report to show.
  assert.equal(resolved.axes.narrowing.narrowed, false)
  assert.deepEqual(resolved.axes.narrowing, NO_NARROWING)

  const fake = fakeStore()
  await fake.seed({ s1: { read: resolved.axes.read, write: resolved.axes.write } })
  fake.store.refreshNarrowing('s1', resolved.axes.narrowing)
  assert.equal(fake.writes(), 0, 'a report that removed nothing is not written')
})

test('an unchanged report is published once, and a changed one is republished', async () => {
  const { preset, library } = fixture(OUTSIDE, 'deny')
  const workspaceRoot = realDir(WORKSPACE_ROOT)
  const resolved = resolveEffectiveAxes(preset, library, { workspaceRoot })
  assert.equal(resolved.ok, true)
  if (!resolved.ok) return
  const fake = fakeStore()
  await fake.seed({ s1: { read: resolved.axes.read, write: resolved.axes.write } })

  fake.store.refreshNarrowing('s1', resolved.axes.narrowing)
  await flush()
  assert.equal(fake.writes(), 1)
  // Every touch re-resolves; the ones that resolve to the same report write nothing.
  fake.store.refreshNarrowing('s1', resolved.axes.narrowing)
  await flush()
  assert.equal(fake.writes(), 1, 'a republish that changes nothing does not write the document')

  // The group edited to grant a directory the read axis DOES cover: the removal is
  // gone, so the stored report has to be replaced, not kept standing.
  const covered = resolveEffectiveAxes(preset, [{ id: 'A', name: 'A', write: { allow: [workspaceRoot] } }], { workspaceRoot })
  assert.equal(covered.ok, true)
  if (!covered.ok) return
  assert.equal(covered.axes.narrowing.narrowed, false)
  fake.store.refreshNarrowing('s1', covered.axes.narrowing)
  await flush()
  assert.equal(fake.writes(), 2)
  assert.equal(storedNarrowing(fake.field(), 's1'), undefined, 'the stale report is gone, not left standing')
})

test('a session with no record is left alone: its axes are recomputed, not frozen', async () => {
  const { preset, library } = fixture()
  const resolved = resolveEffectiveAxes(preset, library, { workspaceRoot: realDir(WORKSPACE_ROOT) })
  assert.equal(resolved.ok, true)
  if (!resolved.ok) return
  const fake = fakeStore()
  fake.store.refreshNarrowing('s1', resolved.axes.narrowing)
  await flush()
  assert.equal(fake.writes(), 0, 'there is no record to attach the report to')
})

test('a failed narrowing write is reported and the stored record stands', async () => {
  const { preset, library } = fixture()
  const resolvable = resolveEffectiveAxes(preset, library, { workspaceRoot: realDir(WORKSPACE_ROOT) })
  assert.equal(resolvable.ok, true)
  if (!resolvable.ok) return
  const warnings: unknown[] = []
  const record = { read: resolvable.axes.read, write: resolvable.axes.write }
  // A database that refuses the narrowing write: the record is loaded, then every
  // write against it fails.
  const handle = new DatabaseSync(':memory:') as unknown as AxesDatabase
  handle.exec(
    'CREATE TABLE IF NOT EXISTS dual_axis_sessions (session_id TEXT PRIMARY KEY, axes TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  )
  handle.prepare('INSERT INTO dual_axis_sessions (session_id, axes, updated_at) VALUES (?, ?, ?)').run('s1', JSON.stringify(record), Date.now())
  const realPrepare = handle.prepare.bind(handle)
  ;(handle as { prepare: unknown }).prepare = (sql: string) => {
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) throw new Error('the database is read-only')
    return realPrepare(sql)
  }
  const settings = { describe: () => [] }
  const ctx = {
    get: (name: string) => (name === 'settings' ? settings : undefined),
    logger: { warn: (...args: unknown[]) => { warnings.push(args) }, info: () => {}, error: () => {} },
  } as never
  const store = new SessionAxesStore(ctx, { sleep: async () => {}, attempts: 1, open: () => handle })
  store.refreshNarrowing('s1', resolvable.axes.narrowing)
  await flush()
  assert.equal(warnings.length, 2, 'the failed refresh is logged, not swallowed')
  // The stored record stands exactly as it was: the failed refresh changed no
  // member of it.
  const after = handle.prepare('SELECT axes FROM dual_axis_sessions WHERE session_id = ?').all('s1') as { axes: string }[]
  assert.deepEqual(JSON.parse(after[0]!.axes), record, 'a refresh never touches the axes')
})

test('a stored report is validated, and an unreadable one refuses the record', () => {
  const report: WriteNarrowing = { narrowed: true, droppedRoots: ['M:\\T4\\out\\narrowing-out'], lostUnbounded: false }
  assert.deepEqual(parseNarrowing(report), report)
  assert.deepEqual(parseNarrowing(undefined), NO_NARROWING, 'a record written before this member existed')
  assert.throws(() => parseNarrowing('nope'), /must be an object/)
  assert.throws(() => parseNarrowing({ narrowed: 'yes', lostUnbounded: false }), /boolean/)
  assert.throws(() => parseNarrowing({ narrowed: true, lostUnbounded: false, droppedRoots: [1] }), /absolute path/)

  assert.deepEqual(
    parseSessionAxesRecord('s', { read: { kind: 'deny' }, write: { kind: 'all' }, narrowing: report }).narrowing,
    report,
  )
  assert.equal(
    parseSessionAxesRecord('s', { read: { kind: 'deny' }, write: { kind: 'all' } }).narrowing,
    undefined,
    'a record that narrowed nothing carries no member',
  )
  assert.equal(
    parseSessionAxesRecord('s', { read: { kind: 'deny' }, write: { kind: 'all' }, narrowing: NO_NARROWING }).narrowing,
    undefined,
    'the empty report is not stored back as a member',
  )
})

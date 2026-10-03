/**
 * Unit tests for the session axis store: the settings namespace the pair lives
 * in, the read path every decision shares, the revision-fence retry, and the
 * sweep that drops the records of sessions that no longer exist.
 *
 * Run with:
 *   node --import tsx/esm --test tests/session-store.spec.ts
 *
 * @module @t4r71/dsh-dual-axis/tests/session-store
 */

import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { isVolatilePath, volatileForm } from '@deepseek-ai/dsh-settings/schema'

import { Config, DEFAULT_AXES, SESSION_AXES_FIELD, SESSION_AXES_NAMESPACE, seedAxesFor } from '../src/session-store.ts'
import {
  SessionAxesStore,
  parseSessionAxesField,
  parseSessionAxesRecord,
  setSessionAxesDatabase,
} from '../src/session-store.ts'
import type { EffectiveScopes } from '../src/axis.ts'

/** The pair used wherever a test needs one that is not the built-in default. */
const PAIR: EffectiveScopes = { read: { kind: 'workspace' }, write: { kind: 'deny' } }

/** One stored-section write the fake settings service observed. */
interface Write {
  ns: string
  section: Record<string, unknown>
  expected: number | undefined
}

/**
 * The store's storage, as a test sees it: ONE shared in-memory database plus the
 * settings service the store still looks up for the \`axes\` config field.
 *
 * The returned object keeps the shape the tests below were written against
 * (\`fake.settings\` for the context, \`value()\` for what is stored), but the value
 * now comes from the database rather than from a rewritten settings document.
 * @param initial - records to seat before the store opens.
 * @returns the double.
 */
function fakeSettings(initial: Record<string, unknown> = {}): {
  settings: { describe(): { ns: string; value: unknown; revision: number }[] }
  writes: Write[]
  value(): Record<string, unknown>
  revision(): number
  failNext: number
  /** The database opener every store built by this fake must be given. */
  open: (file: string) => AxesDatabase
  /** The one handle behind that opener. */
  handle: AxesDatabase
} {
  const handle = new DatabaseSync(':memory:') as unknown as AxesDatabase
  handle.exec(
    'CREATE TABLE IF NOT EXISTS dual_axis_sessions (session_id TEXT PRIMARY KEY, axes TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  )
  const seed = initial[SESSION_AXES_FIELD]
  if (seed !== undefined && typeof seed === 'object' && seed !== null) {
    const put = handle.prepare('INSERT INTO dual_axis_sessions (session_id, axes, updated_at) VALUES (?, ?, ?)')
    for (const [id, record] of Object.entries(seed as Record<string, unknown>)) put.run(id, JSON.stringify(record), Date.now())
  }
  // Installed AFTER the seed, so a test counts the store's own writes only.
  const state = { failNext: 0 }
  // "writes" counts WRITE STATEMENTS the store issued: it upserts rows instead of
  // rewriting a settings document, and what these tests assert about is how often
  // it touched storage, not how many rows exist.
  const rows: string[] = []
  const writes = { get length(): number { return rows.length }, rows }
  const realPrepare = handle.prepare.bind(handle)
  ;(handle as { prepare: unknown }).prepare = (sql: string) => {
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) rows.push(sql)
    return realPrepare(sql)
  }
  return {
    writes: writes as unknown as Write[],
    handle,
    open: () => handle,
    value: () => {
      const out: Record<string, unknown> = {}
      for (const row of handle.prepare('SELECT session_id, axes FROM dual_axis_sessions').all() as { session_id: string; axes: string }[]) {
        out[row.session_id] = JSON.parse(row.axes) as unknown
      }
      return { [SESSION_AXES_FIELD]: out }
    },
    revision: () => 0,
    get failNext() { return state.failNext },
    set failNext(count: number) { state.failNext = count },
    // The store no longer writes a settings document, so nothing to observe
    // there; a test that needs a failing write swaps the database for one whose
    // prepare throws (see the "fails loudly" case).
    settings: { describe: () => [] },
  }
}

/** A context double exposing only what the store looks up. */
function fakeCtx(services: Record<string, unknown>, warnings: unknown[] = []): never {
  return {
    get: (name: string) => services[name],
    logger: { warn: (...args: unknown[]) => { warnings.push(args) }, info: () => {}, error: () => {} },
  } as never
}

/** The field the fake document holds. */
function fieldOf(document: Record<string, unknown>): unknown {
  return document[SESSION_AXES_FIELD]
}

/* ------------------------------- the entry ------------------------------- */

test('the session store is its own namespace with one volatile field', () => {
  assert.equal(SESSION_AXES_NAMESPACE, 'dual-axis-sessions')
  assert.notEqual(SESSION_AXES_NAMESPACE, 'dual-axis')
  assert.equal(SESSION_AXES_FIELD, 'axes')
  assert.equal(isVolatilePath(Config, ['axes']), true)
  const form = volatileForm(Config)
  assert.ok(form !== undefined, 'an entry with no volatile field is refused outright in 0.1.7')
  assert.deepEqual(Object.keys(form.dict ?? {}), ['axes'])
})

/* ------------------------------- the read path ------------------------------- */

test('an empty document reads as no records, and getOr falls back to the defaults', () => {
  const fake = fakeSettings()
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { open: fake.open })
  assert.deepEqual(store.records(), {})
  assert.equal(store.get('s1'), undefined)
  assert.deepEqual(store.getOr('s1'), { read: { kind: 'all' }, write: { kind: 'workspace' } })
})

test('a stored record is read back per session id', () => {
  const fake = fakeSettings({ [SESSION_AXES_FIELD]: { s1: { read: { kind: 'deny' }, write: { kind: 'workspace' } } } })
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { open: fake.open })
  assert.deepEqual(store.get('s1'), { read: { kind: 'deny' }, write: { kind: 'workspace' } })
  assert.equal(store.get('s2'), undefined)
})

test('a read answers from memory and never asks the settings document', () => {
  let describes = 0
  const fake = fakeSettings({ [SESSION_AXES_FIELD]: { s1: { read: { kind: 'deny' }, write: { kind: 'deny' } } } })
  const settings = { describe: () => { describes += 1; return fake.settings.describe() } }
  const store = new SessionAxesStore(fakeCtx({ settings }), { open: fake.open })
  store.get('s1')
  store.get('s1')
  store.get('s1')
  // The rows were loaded once when the database opened; a read is a map lookup.
  assert.equal(describes, 0, 'the store no longer reads its state out of the settings document')
  assert.deepEqual(store.get('s1'), { read: { kind: 'deny' }, write: { kind: 'deny' } })
})

test('a row written by another store is visible to a store opened afterwards', async () => {
  const fake = fakeSettings({ [SESSION_AXES_FIELD]: { s1: { read: { kind: 'deny' }, write: { kind: 'deny' } } } })
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { open: fake.open })
  assert.deepEqual(store.getOr('s1').read, { kind: 'deny' })
  // A second writer — another process, or another store over the same file —
  // lands a row.
  const other = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { open: fake.open })
  await other.set('s1', { read: { kind: 'all' }, write: { kind: 'all' } })
  // A store opened AFTER that write sees it; the first one keeps its snapshot,
  // which is what "one process, one cache" means.
  const reopened = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { open: fake.open })
  assert.deepEqual(reopened.getOr('s1').read, { kind: 'all' })
})

test('no settings service still reads and writes: the store owns its rows', async () => {
  const fake = fakeSettings()
  const store = new SessionAxesStore(fakeCtx({}), { open: fake.open })
  assert.deepEqual(store.records(), {})
  assert.deepEqual(store.getOr('s1'), { read: { kind: 'all' }, write: { kind: 'workspace' } })
  // The composition that never mounted settings still stores a pair: the row no
  // longer lives in the settings document.
  await store.set('s1', PAIR)
  assert.deepEqual(store.get('s1'), PAIR)
})

/* ------------------------------ parsing ------------------------------ */

test('parseSessionAxesRecord fills a missing member and refuses an illegal one', () => {
  assert.deepEqual(parseSessionAxesRecord('s', { read: { kind: 'deny' } }), {
    read: { kind: 'deny' },
    write: { kind: 'workspace' },
  })
  assert.throws(() => parseSessionAxesRecord('s', null), /must be an object/)
  assert.throws(() => parseSessionAxesRecord('s', { read: { kind: 'wide' } }), /unknown kind/)
})

test('parseSessionAxesField names the unreadable record instead of dropping it', () => {
  assert.deepEqual(parseSessionAxesField(undefined), {})
  assert.throws(() => parseSessionAxesField([]), /must be an object/)
  assert.throws(
    () => parseSessionAxesField({ s1: { read: { kind: 'deny' }, write: { kind: 'nope' } } }),
    /unknown kind/,
  )
})

/* -------------------------------- writing -------------------------------- */

test('set lands one row and leaves every other session alone', async () => {
  const fake = fakeSettings({ [SESSION_AXES_FIELD]: { other: { read: { kind: 'all' }, write: { kind: 'all' } } } })
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { open: fake.open })
  await store.set('s1', PAIR)

  // The other session's row survives: one upsert, no whole-field rewrite.
  assert.deepEqual(fieldOf(fake.value()), {
    other: { read: { kind: 'all' }, write: { kind: 'all' } },
    s1: PAIR,
  })
  assert.deepEqual(store.get('s1'), PAIR)
})

test('two stores over one database both keep their own rows', async () => {
  const fake = fakeSettings()
  const a = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { open: fake.open })
  const b = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { open: fake.open })
  await a.set('s1', PAIR)
  await b.set('s2', { read: { kind: 'all' }, write: { kind: 'all' } })
  // Each row is written on its own, so neither write can lose the other's.
  assert.deepEqual(fieldOf(fake.value()), {
    s1: PAIR,
    s2: { read: { kind: 'all' }, write: { kind: 'all' } },
  })
})

test('a write against a broken database fails loudly and stores nothing', async () => {
  const fake = fakeSettings()
  // A handle whose prepare throws stands in for a database that went away.
  // Built from the real fake, then broken afterwards: the store has to open and
  // load before a write can fail, and that is the case under test.
  // A handle that opens and loads, then fails every write. \`value()\` is read
  // from a snapshot taken before the break, so it still answers.
  const before = fieldOf(fake.value())
  const handle = fake.handle
  let broken = false
  const realPrepare = handle.prepare.bind(handle)
  ;(handle as { prepare: unknown }).prepare = (sql: string) => {
    if (broken) throw new Error('database is closed')
    return realPrepare(sql)
  }
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { open: fake.open })
  broken = true
  await assert.rejects(store.set('s1', PAIR), /storing the session axes failed/)
  assert.deepEqual(before, {}, 'a failed write leaves the database untouched')
})

test('writing works with no settings entry composed at all', async () => {
  const fake = fakeSettings()
  const store = new SessionAxesStore(fakeCtx({}), { open: fake.open })
  await store.set('s1', PAIR)
  assert.deepEqual(fieldOf(fake.value()), { s1: PAIR })
})

/* ------------------------- repair of a missing record ------------------------- */

/** Let the fire-and-forget repair chain run to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * A context double carrying the two rows `seedAxesFor` reads: the bundle's own
 * `dual-axis` row (the seed) and its `dual-axis-sessions` row (the store).
 */
function seedCtx(
  row: Record<string, unknown>,
  sessions: Record<string, unknown> = {},
  warnings: unknown[] = [],
): never {
  return fakeCtx({
    settings: {
      describe: () => [
        { ns: 'dual-axis', value: row, revision: 1 },
        { ns: SESSION_AXES_NAMESPACE, value: {}, revision: 1 },
      ],
    },
    sessions: { get: (id: string) => sessions[id] },
  }, warnings)
}

test('DEFAULT_AXES is getOr\'s answer only, and is still the built-in pair', () => {
  // What a session with no record is DISPLAYED as is no longer this constant: it
  // is the session's own seed, which the client half recomputes with
  // `sessionAxesSeed`. tests/seed-parity.spec.ts feeds both halves the same rows
  // and asserts the two answers are the same bytes; this test only pins what the
  // constant itself still means.
  assert.deepEqual(DEFAULT_AXES, { read: { kind: 'all' }, write: { kind: 'workspace' } })
})

test('ensure answers the SEED of an un-recorded session, and repairs it to that same pair', async () => {
  const fake = fakeSettings()
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { sleep: async () => {}, open: fake.open })
  const seen = store.ensure('s1', () => PAIR)
  // The answer IS the seed: a session created under a saved default runs under
  // that default from its first read, not under the built-in pair until the
  // record lands. The write that follows stores the very same value.
  assert.deepEqual(seen, PAIR)
  // A second touch while the first repair is still in flight evaluates ITS OWN
  // thunk — every live caller passes the same `seedAxesFor`, so this is the same
  // pair — and does not queue a second write.
  assert.deepEqual(
    store.ensure('s1', () => PAIR),
    PAIR,
    'a second touch during the write answers the same pair',
  )
  await flush()
  // One RECORD landed. (The store may also issue a narrowing refresh for the same
  // session; that is a separate member on the same row, not a second record.)
  assert.deepEqual(fieldOf(fake.value()), { s1: PAIR }, 'one repair per missing record, not one per read')
  const afterRepair = fake.writes.length
  assert.deepEqual(store.ensure('s1', () => PAIR), PAIR, 'the record is what answers from now on')
  await flush()
  assert.equal(fake.writes.length, afterRepair, 'a session that now has a record is not written again')
})

test('a record that exists is never repaired', async () => {
  const fake = fakeSettings({ [SESSION_AXES_FIELD]: { s1: PAIR } })
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { sleep: async () => {}, open: fake.open })
  assert.deepEqual(store.ensure('s1', () => ({ read: { kind: 'deny' }, write: { kind: 'deny' } })), PAIR)
  await flush()
  assert.equal(fake.writes.length, 0, 'the session own axis is never overwritten by the seed')
})

test('a repair never overwrites a record that appeared while it was waiting', async () => {
  const fake = fakeSettings()
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { sleep: async () => {}, open: fake.open })
  store.ensure('s1', () => PAIR)
  // The touch that scheduled the repair was a pick: /axis stored its own pair
  // before the repair chain reached the write.
  const picked: EffectiveScopes = { read: { kind: 'deny' }, write: { kind: 'all' } }
  await store.set('s1', picked)
  await flush()
  assert.deepEqual(fieldOf(fake.value()), { s1: picked }, 'the pick stands; the seed does not revert it')
})

test('a repair that cannot be stored is reported and re-armed, never thrown at the caller', async () => {
  const warnings: unknown[] = []
  const fake = fakeSettings()
  // A database that refuses every write, then recovers: this is the "repair could
  // not be stored" path now that there is no revision race to lose.
  const handle = fake.handle
  const realPrepare = handle.prepare.bind(handle)
  let failing = true
  ;(handle as { prepare: unknown }).prepare = (sql: string) => {
    if (failing && /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) throw new Error('disk is full')
    return realPrepare(sql)
  }
  const store = new SessionAxesStore(
    fakeCtx({ settings: fake.settings }, warnings),
    { sleep: async () => {}, attempts: 1, open: fake.open },
  )
  assert.deepEqual(store.ensure('s1', () => PAIR), PAIR, 'the answer does not depend on the write landing')
  await flush()
  assert.equal(warnings.length, 2, 'the failed repair is logged, not swallowed')
  assert.deepEqual(fieldOf(fake.value()), {}, 'nothing was written')
  // Re-armed: the next touch tries again, and this time it lands.
  failing = false
  store.ensure('s1', () => PAIR)
  await flush()
  assert.deepEqual(fieldOf(fake.value()), { s1: PAIR })
})

test('a seed that cannot be computed does not escape into the decision path', async () => {
  const warnings: unknown[] = []
  const fake = fakeSettings()
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }, warnings), { open: fake.open })
  const seen = store.ensure('s1', () => { throw new Error('the settings row is unreadable') })
  assert.deepEqual(seen, { read: { kind: 'all' }, write: { kind: 'workspace' } })
  await flush()
  assert.equal(warnings.length, 2)
  assert.equal(fake.writes.length, 0)
})

test('the seed is the settings row a new session starts from, groups included', () => {
  const ctx = seedCtx({
    read: { kind: 'custom', base: 'deny' },
    write: { kind: 'all' },
    defaultGroups: ['A'],
  } as Record<string, unknown>)
  // The closed write axis keeps the kind the row declares: only the axis whose
  // own kind is custom can carry the reference.
  assert.deepEqual(seedAxesFor(ctx, { header: { id: 's1' } } as never), {
    read: { kind: 'custom', base: 'deny', groups: ['A'], allow: [], deny: [] },
    write: { kind: 'all' },
  })
})

test('the seed of a row with no custom axis is the row verbatim', () => {
  const ctx = seedCtx({
    read: { kind: 'all' },
    write: { kind: 'workspace' },
    defaultGroups: ['A'],
  } as Record<string, unknown>)
  assert.deepEqual(seedAxesFor(ctx, { header: { id: 's1' } } as never), DEFAULT_AXES)
})

test('a subagent child seeds from its parent CURRENT stored pair', () => {
  // seedAxesFor builds its OWN store internally, so the process-wide default
  // database has to be this test's.
  const parentPair: EffectiveScopes = { read: { kind: 'deny' }, write: { kind: 'workspace' } }
  const db = fakeSettings({ [SESSION_AXES_FIELD]: { p1: parentPair } })
  setSessionAxesDatabase({ open: db.open })
  const ctx = fakeCtx({
    settings: {
      describe: () => [
        { ns: 'dual-axis', value: { read: { kind: 'all' }, write: { kind: 'workspace' } }, revision: 1 },
      ],
    },
    sessions: { get: (id: string) => (id === 'p1' ? { header: { id: 'p1' } } : undefined) },
  })
  const child = { header: { id: 'c1', origin: 'subagent', parentSession: 'p1' } } as never
  assert.deepEqual(seedAxesFor(ctx, child), parentPair)
})

test('a child inherits its parent record whether or not the parent is resident here', () => {
  const db = fakeSettings({ [SESSION_AXES_FIELD]: { p1: { read: { kind: 'deny' }, write: { kind: 'deny' } } } })
  setSessionAxesDatabase({ open: db.open })
  // The client half reads the same document by the same id and cannot observe
  // host residency, so the answer may not depend on it: otherwise a child whose
  // parent is not materialized would be shown one pair and held to another.
  const parentPair: EffectiveScopes = { read: { kind: 'deny' }, write: { kind: 'deny' } }
  const ctx = fakeCtx({
    settings: {
      describe: () => [
        { ns: 'dual-axis', value: { read: { kind: 'all' }, write: { kind: 'workspace' } }, revision: 1 },
        { ns: SESSION_AXES_NAMESPACE, value: { [SESSION_AXES_FIELD]: { p1: parentPair } }, revision: 1 },
      ],
    },
    sessions: { get: () => undefined },
  })
  const child = { header: { id: 'c1', origin: 'subagent', parentSession: 'p1' } } as never
  assert.deepEqual(seedAxesFor(ctx, child), parentPair)
})

test('a settings-less host seeds from the composing plugin own config', () => {
  const ctx = fakeCtx({})
  assert.deepEqual(seedAxesFor(ctx, { header: { id: 's1' } } as never), DEFAULT_AXES)
  // The config's own pair is closed too, so the group list changes nothing: the
  // same per-axis rule governs the composing plugin's fallback.
  assert.deepEqual(
    seedAxesFor(ctx, { header: { id: 's1' } } as never, { axes: PAIR, groups: ['A'] }),
    PAIR,
  )
})

/* ---------------------------------- GC ---------------------------------- */

/** A persistence double listing exactly the ids a test wants to exist. */
function fakePersistence(ids: readonly string[], fail = false): { list(): Promise<{ header: { id: string } }[]> } {
  return {
    list: async () => {
      if (fail) throw new Error('storage unavailable')
      return ids.map(id => ({ header: { id } }))
    },
  }
}

test('the sweep drops the records of sessions the persistence layer no longer lists', async () => {
  const fake = fakeSettings({
    [SESSION_AXES_FIELD]: {
      keep: { read: { kind: 'deny' }, write: { kind: 'deny' } },
      gone: { read: { kind: 'all' }, write: { kind: 'all' } },
    },
  })
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings, sessionPersistence: fakePersistence(['keep']) }), { open: fake.open })
  const result = await store.sweep()
  assert.deepEqual(result, { removed: ['gone'], before: 2 })
  assert.deepEqual(Object.keys(fieldOf(fake.value()) ?? {}), ['keep'])
})

test('the sweep leaves everything alone when it cannot judge', async () => {
  const failing = fakeSettings({ [SESSION_AXES_FIELD]: { gone: { read: { kind: 'all' }, write: { kind: 'all' } } } })
  const warnings: unknown[] = []
  const noStore = new SessionAxesStore(
    fakeCtx({ settings: failing.settings, sessionPersistence: fakePersistence([], true) }, warnings),
    { open: failing.open },
  )
  assert.equal(await noStore.sweep(), undefined)
  assert.equal(failing.writes.length, 0)
  assert.equal(warnings.length, 2, 'the failed listing is reported, not swallowed')

  const noService = new SessionAxesStore(fakeCtx({ settings: failing.settings }), { open: failing.open })
  assert.equal(await noService.sweep(), undefined)
  assert.equal(failing.writes.length, 0)
})

test('a sweep with nothing to drop does not write the document', async () => {
  const fake = fakeSettings({ [SESSION_AXES_FIELD]: { keep: { read: { kind: 'deny' }, write: { kind: 'deny' } } } })
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings, sessionPersistence: fakePersistence(['keep']) }), { open: fake.open })
  assert.deepEqual(await store.sweep(), { removed: [], before: 1 })
  assert.equal(fake.writes.length, 0)
})

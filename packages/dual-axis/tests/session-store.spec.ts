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
import assert from 'node:assert/strict'
import { isVolatilePath, volatileForm } from '@deepseek-ai/dsh-settings/schema'

import { Config, DEFAULT_AXES, SESSION_AXES_FIELD, SESSION_AXES_NAMESPACE, seedAxesFor } from '../src/session-store.ts'
import {
  AXES_WRITE_ATTEMPTS,
  SessionAxesConflictError,
  SessionAxesStore,
  parseSessionAxesField,
  parseSessionAxesRecord,
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
 * A fake settings service over one field: enough of `describe` and `replace` for
 * the store, with a hook that can refuse a write the way the revision fence does.
 */
function fakeSettings(initial: Record<string, unknown> = {}): {
  settings: { describe(): { ns: string; value: unknown; revision: number }[]; replace(ns: string, section: object, expected?: number): Promise<void> }
  writes: Write[]
  value(): Record<string, unknown>
  revision(): number
  failNext: number
} {
  let value = initial
  let revision = 0
  const writes: Write[] = []
  const state = { failNext: 0 }
  return {
    writes,
    value: () => value,
    revision: () => revision,
    get failNext() { return state.failNext },
    set failNext(count: number) { state.failNext = count },
    settings: {
      describe: () => [{ ns: SESSION_AXES_NAMESPACE, value, revision }],
      replace: async (ns, section, expected) => {
        writes.push({ ns, section: section as Record<string, unknown>, expected })
        if (state.failNext > 0) {
          state.failNext -= 1
          revision += 1
          throw new Error('settings namespace changed since it was read')
        }
        value = { ...(section as Record<string, unknown>) }
        revision += 1
      },
    },
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
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }))
  assert.deepEqual(store.records(), {})
  assert.equal(store.get('s1'), undefined)
  assert.deepEqual(store.getOr('s1'), { read: { kind: 'all' }, write: { kind: 'workspace' } })
})

test('a stored record is read back per session id', () => {
  const fake = fakeSettings({ [SESSION_AXES_FIELD]: { s1: { read: { kind: 'deny' }, write: { kind: 'workspace' } } } })
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }))
  assert.deepEqual(store.get('s1'), { read: { kind: 'deny' }, write: { kind: 'workspace' } })
  assert.equal(store.get('s2'), undefined)
})

test('the read is memoized on the namespace revision', () => {
  let describes = 0
  const fake = fakeSettings({ [SESSION_AXES_FIELD]: { s1: { read: { kind: 'deny' }, write: { kind: 'deny' } } } })
  const settings = {
    describe: () => { describes += 1; return fake.settings.describe() },
    replace: fake.settings.replace,
  }
  const store = new SessionAxesStore(fakeCtx({ settings }))
  store.get('s1')
  store.get('s1')
  store.get('s1')
  assert.equal(describes, 3, 'every read asks for the document, which is how it notices a change')
})

test('a document change is visible on the next read without a remount', () => {
  const fake = fakeSettings({ [SESSION_AXES_FIELD]: { s1: { read: { kind: 'deny' }, write: { kind: 'deny' } } } })
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }))
  assert.deepEqual(store.getOr('s1').read, { kind: 'deny' })
  // A second writer (the settings page, another session) replaces the document.
  void fake.settings.replace(SESSION_AXES_NAMESPACE, { [SESSION_AXES_FIELD]: { s1: { read: { kind: 'all' }, write: { kind: 'all' } } } })
  assert.deepEqual(store.getOr('s1').read, { kind: 'all' })
})

test('no settings service means no records, never a throw', () => {
  const store = new SessionAxesStore(fakeCtx({}))
  assert.deepEqual(store.records(), {})
  assert.deepEqual(store.getOr('s1'), { read: { kind: 'all' }, write: { kind: 'workspace' } })
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

test('set stores the whole field with the revision it read', async () => {
  const fake = fakeSettings({ [SESSION_AXES_FIELD]: { other: { read: { kind: 'all' }, write: { kind: 'all' } } } })
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }))
  await store.set('s1', PAIR)

  assert.equal(fake.writes.length, 1)
  assert.equal(fake.writes[0]?.ns, SESSION_AXES_NAMESPACE)
  assert.equal(fake.writes[0]?.expected, 0)
  // The other session's record survives: the write is a merge of one field, not a wipe.
  assert.deepEqual(fieldOf(fake.value()), {
    other: { read: { kind: 'all' }, write: { kind: 'all' } },
    s1: PAIR,
  })
})

test('a refused write is retried against the revision the other writer produced', async () => {
  const fake = fakeSettings()
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { sleep: async () => {} })
  fake.failNext = 1
  await store.set('s1', PAIR)
  assert.equal(fake.writes.length, 2)
  assert.equal(fake.writes[1]?.expected, 1, 'the retry re-reads the revision')
  assert.deepEqual(fieldOf(fake.value()), { s1: PAIR })
})

test('a write that loses every race fails loudly and writes nothing', async () => {
  const fake = fakeSettings()
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { sleep: async () => {} })
  fake.failNext = AXES_WRITE_ATTEMPTS
  await assert.rejects(store.set('s1', PAIR), (error: unknown) => {
    assert.ok(error instanceof SessionAxesConflictError)
    assert.equal(error.code, 'DUAL_AXIS_AXES_CONFLICT')
    assert.equal(error.attempts, AXES_WRITE_ATTEMPTS)
    assert.match(error.message, /nothing was written/)
    return true
  })
  assert.equal(fake.writes.length, AXES_WRITE_ATTEMPTS)
  assert.deepEqual(fake.value(), {}, 'a lost write leaves the document untouched')
})

test('writing without the entry composed fails instead of silently dropping the axis', async () => {
  const store = new SessionAxesStore(fakeCtx({}))
  await assert.rejects(store.set('s1', PAIR), /no configurable plugin entry "dual-axis-sessions"/)
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
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { sleep: async () => {} })
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
  assert.equal(fake.writes.length, 1, 'one repair per missing record, not one per read')
  assert.deepEqual(fieldOf(fake.value()), { s1: PAIR })
  assert.deepEqual(store.ensure('s1', () => PAIR), PAIR, 'the record is what answers from now on')
  assert.equal(fake.writes.length, 1)
})

test('a record that exists is never repaired', async () => {
  const fake = fakeSettings({ [SESSION_AXES_FIELD]: { s1: PAIR } })
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { sleep: async () => {} })
  assert.deepEqual(store.ensure('s1', () => ({ read: { kind: 'deny' }, write: { kind: 'deny' } })), PAIR)
  await flush()
  assert.equal(fake.writes.length, 0, 'the session own axis is never overwritten by the seed')
})

test('a repair never overwrites a record that appeared while it was waiting', async () => {
  const fake = fakeSettings()
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { sleep: async () => {} })
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
  const store = new SessionAxesStore(
    fakeCtx({ settings: fake.settings }, warnings),
    { sleep: async () => {}, attempts: 1 },
  )
  fake.failNext = 1
  assert.deepEqual(store.ensure('s1', () => PAIR), PAIR, 'the answer does not depend on the write landing')
  await flush()
  assert.equal(warnings.length, 2, 'the failed repair is logged, not swallowed')
  assert.deepEqual(fake.value(), {}, 'nothing was written')
  // Re-armed: the next touch tries again, and this time it lands.
  store.ensure('s1', () => PAIR)
  await flush()
  assert.deepEqual(fieldOf(fake.value()), { s1: PAIR })
})

test('a seed that cannot be computed does not escape into the decision path', async () => {
  const warnings: unknown[] = []
  const fake = fakeSettings()
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }, warnings))
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
  const parentPair: EffectiveScopes = { read: { kind: 'deny' }, write: { kind: 'workspace' } }
  const fake = fakeSettings({ [SESSION_AXES_FIELD]: { p1: parentPair } })
  const ctx = fakeCtx({
    settings: {
      describe: () => [
        { ns: 'dual-axis', value: { read: { kind: 'all' }, write: { kind: 'workspace' } }, revision: 1 },
        { ns: SESSION_AXES_NAMESPACE, value: { [SESSION_AXES_FIELD]: { p1: parentPair } }, revision: 1 },
      ],
      replace: fake.settings.replace,
    },
    sessions: { get: (id: string) => (id === 'p1' ? { header: { id: 'p1' } } : undefined) },
  })
  const child = { header: { id: 'c1', origin: 'subagent', parentSession: 'p1' } } as never
  assert.deepEqual(seedAxesFor(ctx, child), parentPair)
})

test('a child inherits its parent record whether or not the parent is resident here', () => {
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
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings, sessionPersistence: fakePersistence(['keep']) }))
  const result = await store.sweep()
  assert.deepEqual(result, { removed: ['gone'], before: 2 })
  assert.deepEqual(Object.keys(fieldOf(fake.value()) ?? {}), ['keep'])
})

test('the sweep leaves everything alone when it cannot judge', async () => {
  const failing = fakeSettings({ [SESSION_AXES_FIELD]: { gone: { read: { kind: 'all' }, write: { kind: 'all' } } } })
  const warnings: unknown[] = []
  const noStore = new SessionAxesStore(
    fakeCtx({ settings: failing.settings, sessionPersistence: fakePersistence([], true) }, warnings),
  )
  assert.equal(await noStore.sweep(), undefined)
  assert.equal(failing.writes.length, 0)
  assert.equal(warnings.length, 2, 'the failed listing is reported, not swallowed')

  const noService = new SessionAxesStore(fakeCtx({ settings: failing.settings }))
  assert.equal(await noService.sweep(), undefined)
  assert.equal(failing.writes.length, 0)
})

test('a sweep with nothing to drop does not write the document', async () => {
  const fake = fakeSettings({ [SESSION_AXES_FIELD]: { keep: { read: { kind: 'deny' }, write: { kind: 'deny' } } } })
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings, sessionPersistence: fakePersistence(['keep']) }))
  assert.deepEqual(await store.sweep(), { removed: [], before: 1 })
  assert.equal(fake.writes.length, 0)
})

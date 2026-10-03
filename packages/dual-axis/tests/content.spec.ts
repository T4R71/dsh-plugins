/**
 * Whether a session has been used — the predicate that decides when its axis
 * pair stops following the settings page and freezes.
 *
 * Run with:
 *   node --import tsx/esm --test tests/content.spec.ts
 *
 * @module @t4r71/dsh-dual-axis/tests/content
 */

import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'

import { CONTENT_EVENT_TYPES, hasContent } from '../src/content.ts'
import { SESSION_AXES_FIELD, SessionAxesStore } from '../src/session-store.ts'
import type { AxesDatabase } from '../src/session-store.ts'
import type { EffectiveScopes } from '../src/axis.ts'
import type { Session } from '@deepseek-ai/dsh-session'

/** The pair used wherever a test needs one that is not the built-in default. */
const PAIR: EffectiveScopes = { read: { kind: 'workspace' }, write: { kind: 'deny' } }

/**
 * A session double exposing only `snapshotEvents`, which is all {@link hasContent}
 * reads. The events are the shapes the session log actually carries, taken from a
 * real log: a fresh session has the header plus the three startup records, and the
 * first thing a turn appends is the loop's runtime-context snapshot.
 */
function sessionOf(events: readonly { type: string; data?: unknown }[]): Session {
  return { snapshotEvents: () => events } as unknown as Session
}

/** The loop's per-turn runtime-context snapshot, as the log spells it. */
const RUNTIME_CONTEXT = {
  type: 'user/message',
  data: { content: [{ type: 'text', text: 'Current runtime context. …' }], source: { kind: 'runtime-context', form: 'snapshot', sections: [] } },
}

/** What a real person's typed turn looks like in the log. */
const HUMAN_TURN = {
  type: 'user/message',
  data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user', rpcId: 'r1' }, role: 'user', id: 'm1' },
}

/* --------------------------- what "no content" means --------------------------- */

test('a session carrying only startup records has no content', () => {
  // The four events a fresh session's log holds: header, preset, mode, policy.
  assert.equal(hasContent(sessionOf([
    { type: 'session' },
    { type: 'permission/preset' },
    { type: 'sandbox/mode' },
    { type: 'approval/policy' },
  ])), false)
})

test('the loop runtime-context snapshot is NOT content', () => {
  // This is the case the whole predicate exists for. The loop appends this on the
  // FIRST turn, before any human input, so counting it would make every session
  // look used the moment anything rendered its prompt — and the settings page
  // would stop reaching the conversation the workspace picker reopens.
  assert.equal(hasContent(sessionOf([{ type: 'session' }, RUNTIME_CONTEXT])), false)
})

test('a session whose only user messages are runtime-context snapshots has no content', () => {
  // Every turn appends one, so a long-lived session accumulates them; none is a
  // reason to freeze an axis pair.
  assert.equal(hasContent(sessionOf([
    { type: 'session' }, RUNTIME_CONTEXT, RUNTIME_CONTEXT, RUNTIME_CONTEXT,
  ])), false)
})

/* ---------------------------- what "content" means ---------------------------- */

test('a real user turn is content', () => {
  assert.equal(hasContent(sessionOf([{ type: 'session' }, HUMAN_TURN])), true)
})

test('an assistant reply is content, even with no user turn before it', () => {
  assert.equal(hasContent(sessionOf([{ type: 'session' }, { type: 'assistant/message', data: { message: { role: 'assistant' } } }])), true)
})

test('a system message is content', () => {
  assert.equal(hasContent(sessionOf([{ type: 'session' }, { type: 'system/message', data: { message: { role: 'system' } } }])), true)
})

test('any other user message source counts as content', () => {
  // The skill catalogue is the other source a session acquires without a human
  // turn. It is still the session entering a turn, so it freezes.
  assert.equal(hasContent(sessionOf([
    { type: 'session' },
    { type: 'user/message', data: { source: { kind: 'skill-catalog', form: 'catalog', entries: [] } } },
  ])), true)
})

test('a runtime-context snapshot does not hide a later human turn', () => {
  assert.equal(hasContent(sessionOf([
    { type: 'session' }, RUNTIME_CONTEXT, HUMAN_TURN, RUNTIME_CONTEXT,
  ])), true)
})

test('a user message with no source at all is content', () => {
  // Defensive direction: an unrecognized message is treated as content, which
  // freezes rather than silently keeps following the settings page.
  assert.equal(hasContent(sessionOf([{ type: 'session' }, { type: 'user/message', data: {} }])), true)
})

/* ------------------------- how the store uses the predicate ------------------------- */

/** Let the fire-and-forget repair chain run to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

/** A fake settings service over one field, with a record of every write. */
function fakeSettings(initial: Record<string, unknown> = {}): {
  settings: { describe(): { ns: string; value: unknown; revision: number }[] }
  writes: unknown[]
  value(): Record<string, unknown>
  open: (file: string) => AxesDatabase
} {
  const handle = new DatabaseSync(':memory:') as unknown as AxesDatabase
  handle.exec(
    'CREATE TABLE IF NOT EXISTS dual_axis_sessions (session_id TEXT PRIMARY KEY, axes TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  )
  // Seat the records the caller asked for, BEFORE the write counter is installed
  // so a test counts only what the store itself wrote.
  const seed = initial[SESSION_AXES_FIELD]
  if (seed !== undefined && typeof seed === 'object' && seed !== null) {
    const put = handle.prepare('INSERT INTO dual_axis_sessions (session_id, axes, updated_at) VALUES (?, ?, ?)')
    for (const [id, record] of Object.entries(seed as Record<string, unknown>)) put.run(id, JSON.stringify(record), Date.now())
  }
  const rows: string[] = []
  const realPrepare = handle.prepare.bind(handle)
  ;(handle as { prepare: unknown }).prepare = (sql: string) => {
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) rows.push(sql)
    return realPrepare(sql)
  }
  const counter = { get length() { return rows.length } }
  return {
    writes: counter as unknown as unknown[],
    open: () => handle,
    value: () => {
      const out: Record<string, unknown> = {}
      for (const row of handle.prepare('SELECT session_id, axes FROM dual_axis_sessions').all() as { session_id: string; axes: string }[]) {
        out[row.session_id] = JSON.parse(row.axes) as unknown
      }
      return { [SESSION_AXES_FIELD]: out }
    },
    // No settings document is written any more; the store still looks the
    // service up for its own config field, so an empty describe is enough.
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

test('an un-frozen session answers the seed and writes NO record', async () => {
  const fake = fakeSettings()
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { sleep: async () => {}, open: fake.open })
  assert.deepEqual(store.ensure('s1', () => PAIR, false), PAIR)
  await flush()
  assert.equal(fake.writes.length, 0, 'a session nobody has used issues no write at all')
  assert.deepEqual(fake.value().axes, {}, 'and holds no record')
})

test('the seed is recomputed on every read while the session is un-frozen', async () => {
  // This is what makes the settings page live for a session with no content: the
  // answer is whatever the row says NOW, not what it said at creation.
  const fake = fakeSettings()
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { sleep: async () => {}, open: fake.open })
  const first: EffectiveScopes = { read: { kind: 'all' }, write: { kind: 'workspace' } }
  const second: EffectiveScopes = { read: { kind: 'deny' }, write: { kind: 'deny' } }
  assert.deepEqual(store.ensure('s1', () => first, false), first)
  assert.deepEqual(store.ensure('s1', () => second, false), second, 'the row changed, so the answer changed')
  await flush()
  assert.equal(fake.writes.length, 0)
})

test('a used session IS repaired to the seed', async () => {
  const fake = fakeSettings()
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { sleep: async () => {}, open: fake.open })
  assert.deepEqual(store.ensure('s1', () => PAIR, true), PAIR)
  await flush()
  assert.deepEqual(fake.value().axes, { s1: PAIR }, 'the seed it answered with is the record that landed')
  assert.deepEqual(store.ensure('s1', () => ({ read: { kind: 'all' }, write: { kind: 'all' } }), false), PAIR,
    'once the record lands it answers, even for a caller that judges the session empty')
})

test('a frozen session becomes un-frozen the moment it is used', async () => {
  // The transition the rule is about: no record while empty, one record once a
  // turn lands, and the recorded pair is the seed computed at THAT moment.
  const fake = fakeSettings()
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { sleep: async () => {}, open: fake.open })
  const atCreation: EffectiveScopes = { read: { kind: 'all' }, write: { kind: 'workspace' } }
  const atFirstTurn: EffectiveScopes = { read: { kind: 'deny' }, write: { kind: 'workspace' } }
  // The person changed the settings row between opening the session and using it.
  assert.deepEqual(store.ensure('s1', () => atCreation, false), atCreation)
  await flush()
  assert.deepEqual(store.ensure('s1', () => atFirstTurn, true), atFirstTurn)
  await flush()
  assert.deepEqual(store.ensure('s1', () => atCreation, true), atFirstTurn, 'the record now wins over any later row')
})

test('the default for a caller that cannot judge content is to freeze', async () => {
  // Safe direction: an unjudged session keeps the pre-existing freeze-on-first-touch
  // behaviour rather than silently following the row.
  const fake = fakeSettings()
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { sleep: async () => {}, open: fake.open })
  assert.deepEqual(store.ensure('s1', () => PAIR), PAIR)
  await flush()
  assert.deepEqual(fake.value().axes, { s1: PAIR }, 'an unjudged session freezes on first touch')
})

test('a session that gains content is frozen at that moment, not at creation', async () => {
  // The transition the rule is about, in the order it happens in a real turn: the
  // session is created empty (no record), a turn starts and the prompt is
  // assembled BEFORE the human message lands, and the reply arrives with no tool
  // call in between. Nothing on the live read paths fires after the content
  // exists, so the event listener is what freezes it.
  const fake = fakeSettings()
  const store = new SessionAxesStore(fakeCtx({ settings: fake.settings }), { sleep: async () => {}, open: fake.open })

  // 1. Empty session: answered by the seed, nothing written.
  const atCreation: EffectiveScopes = { read: { kind: 'all' }, write: { kind: 'workspace' } }
  assert.deepEqual(store.ensure('s1', () => atCreation, false), atCreation)
  await flush()
  assert.equal(fake.writes.length, 0, 'an empty session keeps no record')

  // 2. The person edits the settings row while the session sits unused.
  const afterEdit: EffectiveScopes = { read: { kind: 'deny' }, write: { kind: 'deny' } }
  assert.deepEqual(store.ensure('s1', () => afterEdit, false), afterEdit, 'the row is live for it')

  // 3. A turn runs; the listener now judges the session USED and freezes it.
  assert.deepEqual(store.ensure('s1', () => afterEdit, true), afterEdit)
  await flush()
  assert.deepEqual(fake.value().axes, { s1: afterEdit }, 'the pair in force when it was used is what froze')

  // 4. Later edits reach it no more.
  const later: EffectiveScopes = { read: { kind: 'all' }, write: { kind: 'all' } }
  assert.deepEqual(store.ensure('s1', () => later, true), afterEdit)
})

test('CONTENT_EVENT_TYPES is the set the predicate and the freeze listener share', () => {
  // The listener skips every other event type without touching the session, so the
  // set has to cover exactly the types `hasContent` can return true for.
  assert.deepEqual([...CONTENT_EVENT_TYPES].sort(), ['assistant/message', 'system/message', 'user/message'])
})

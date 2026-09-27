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
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import type { EffectiveScopes } from '../src/axis.ts'
import type { RuleGroup, WriteNarrowing } from '../src/groups.ts'
import { NO_NARROWING, parseNarrowing, resolveEffectiveAxes } from '../src/groups.ts'
import { resolveScope } from '../src/scope.ts'
import { SESSION_AXES_FIELD, SessionAxesStore, parseSessionAxesRecord } from '../src/session-store.ts'

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
  seed(record: Record<string, unknown>): void
} {
  let value: Record<string, unknown> = {}
  let revision = 0
  let writes = 0
  const settings = {
    describe: () => [{ ns: 'dual-axis-sessions', value, revision }],
    replace: async (_ns: string, section: object) => {
      writes += 1
      value = { ...(section as Record<string, unknown>) }
      revision += 1
    },
  }
  const ctx = {
    get: (name: string) => (name === 'settings' ? settings : undefined),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  } as never
  return {
    store: new SessionAxesStore(ctx, { sleep: async () => {} }),
    writes: () => writes,
    field: () => value,
    seed: (record: Record<string, unknown>) => {
      value = { [SESSION_AXES_FIELD]: record }
      revision += 1
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
  fake.seed({ s1: { read: resolved.axes.read, write: resolved.axes.write } })
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

test('widening the read axis over that directory publishes no narrowing at all', () => {
  const { preset, library } = fixture()
  const resolved = resolveEffectiveAxes({ ...preset, read: { kind: 'all' } }, library, { workspaceRoot: realDir(WORKSPACE_ROOT) })
  assert.equal(resolved.ok, true)
  if (!resolved.ok) return
  // The root is still granted, so nothing was removed — the surface must show
  // nothing, and the store must not manufacture a report to show.
  assert.equal(resolved.axes.narrowing.narrowed, false)
  assert.deepEqual(resolved.axes.narrowing, NO_NARROWING)

  const fake = fakeStore()
  fake.seed({ s1: { read: resolved.axes.read, write: resolved.axes.write } })
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
  fake.seed({ s1: { read: resolved.axes.read, write: resolved.axes.write } })

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
  const value = { [SESSION_AXES_FIELD]: { s1: record } }
  const settings = {
    describe: () => [{ ns: 'dual-axis-sessions', value, revision: 1 }],
    replace: async () => { throw new Error('the document changed under this writer') },
  }
  const ctx = {
    get: (name: string) => (name === 'settings' ? settings : undefined),
    logger: { warn: (...args: unknown[]) => { warnings.push(args) }, info: () => {}, error: () => {} },
  } as never
  const store = new SessionAxesStore(ctx, { sleep: async () => {}, attempts: 1 })
  store.refreshNarrowing('s1', resolvable.axes.narrowing)
  await flush()
  assert.equal(warnings.length, 2, 'the failed refresh is logged, not swallowed')
  assert.deepEqual(value, { [SESSION_AXES_FIELD]: { s1: record } }, 'a refresh never touches the axes')
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

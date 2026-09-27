/**
 * Unit tests for the settings surface and the write axis's log mirror: the
 * volatile gate 0.1.7 imposes, the axis-declaration shape the Loader entry
 * carries, and the exact write `mirrorWriteMode` performs on a session log.
 *
 * Run with:
 *   node --import tsx/esm --test tests/settings.spec.ts
 *
 * @module @t4r71/dsh-dual-axis/tests/settings
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { isVolatilePath, volatileForm } from '@deepseek-ai/dsh-settings/schema'

import { Config, DUAL_AXIS_ROW_ID, RETIRED_SETTINGS_NAMESPACE } from '../src/config.ts'
import { mirrorWriteMode } from '../src/session-axes.ts'
import type { AxisScope } from '../src/axis.ts'
import { resolveEffectiveAxes } from '../src/groups.ts'
import { renderScopePrompt, unresolvedAxesNotice } from '../src/scope-prompt.ts'

/** A workspace root used only as a string. */
const WS = process.platform === 'win32' ? 'C:\\ws' : '/ws'

/* -------------------------- the 0.1.7 volatile gate -------------------------- */

test('both axis fields are declared volatile, so 0.1.7 projects and writes them', () => {
  // 0.1.7's settings form only projects fields beneath a `.volatile()` node
  // (settings/src/schema.ts:37-47) and refuses every other path (:74-78).
  assert.equal(isVolatilePath(Config, ['read']), true)
  assert.equal(isVolatilePath(Config, ['write']), true)
  // The declared accessor is the runtime fact the projection reads.
  const parsed = Config({ read: { kind: 'all' }, write: { kind: 'workspace' } }) as { read: unknown }
  assert.equal(isVolatile(parsed.read), true)
})

test('the group fields are volatile too, so the settings page projects and writes them', () => {
  assert.equal(isVolatilePath(Config, ['groups']), true)
  assert.equal(isVolatilePath(Config, ['defaultGroups']), true)
  const parsed = Config({ read: { kind: 'all' }, write: { kind: 'workspace' } }) as {
    groups: { get(): unknown }
    defaultGroups: { get(): unknown }
  }
  // Both default to empty, so a deployment that never configures a rule group
  // behaves exactly as one that predates them.
  assert.equal(isVolatile(parsed.groups), true)
  assert.deepEqual(parsed.groups.get(), [])
  assert.deepEqual(parsed.defaultGroups.get(), [])
})

test('the axis schema yields a form carrying the two axes and the two group fields', () => {
  const form = volatileForm(Config)
  assert.ok(form !== undefined, 'an entry with no volatile field is refused outright in 0.1.7')
  assert.deepEqual(Object.keys(form.dict ?? {}).sort(), ['defaultGroups', 'groups', 'read', 'write'])
})

test('the schema preserves a custom axis payload through the volatile accessor', () => {
  // `z.any()` per axis is deliberate: a schemastery union would strip the
  // custom branch's base/allow/deny, degrading a custom axis silently.
  // `.volatile()` wraps the field in schemastery's live accessor, so the value
  // is read back through `.get()` — which is also exactly what
  // `plainConfig` does when it projects the form (settings/src/schema.ts:11).
  const parsed = Config({
    read: { kind: 'custom', base: 'workspace', allow: ['/a'], deny: ['/b'] },
    write: { kind: 'all' },
  }) as { read: { get(): unknown }; write: { get(): unknown } }

  assert.deepEqual(parsed.read.get(), {
    kind: 'custom', base: 'workspace', allow: ['/a'], deny: ['/b'],
  })
  assert.deepEqual(parsed.write.get(), { kind: 'all' })
})

test('the row id is the settings namespace, and the 0.1.6 name is retired', () => {
  assert.equal(DUAL_AXIS_ROW_ID, 'dual-axis')
  assert.equal(RETIRED_SETTINGS_NAMESPACE, 'sandbox-axis')
  assert.notEqual(DUAL_AXIS_ROW_ID, RETIRED_SETTINGS_NAMESPACE)
})

/* --------------------------- the write-axis log mirror -------------------------- */

/** A minimal session double recording every append, in order. */
function fakeSession(): {
  appends: { type: string; data: unknown }[]
  append(type: string, data: unknown): void
} {
  const appends: { type: string; data: unknown }[] = []
  return {
    appends,
    append(type: string, data: unknown): void { appends.push({ type, data }) },
  }
}

test('mirrorWriteMode records the NARROWER of the two bases, and nothing else', () => {
  const session = fakeSession()
  const read: AxisScope = { kind: 'workspace' }
  const write: AxisScope = { kind: 'custom', base: 'all', allow: [], deny: ['C:' + (process.platform === 'win32' ? '\\' : '/') + 'secret'] }
  mirrorWriteMode(session as never, { read, write })

  assert.deepEqual(session.appends, [{ type: 'sandbox/mode', data: { mode: 'workspace-write' } }])
  // The mirror is what makes the inherited 0.1.7 write fence see the same base.
  // It is the READ axis's base here, because the effective write range is the
  // write axis intersected with that read axis and never exceeds it: mirroring
  // the write axis's own `all` would leave the layer below the tool fence
  // granting writes the intersection forbids.
})

test('mirrorWriteMode spells each write base as its own legacy mode', () => {
  const cases: [AxisScope, string][] = [
    [{ kind: 'deny' }, 'read-only'],
    [{ kind: 'workspace' }, 'workspace-write'],
    [{ kind: 'all' }, 'danger-full-access'],
    [{ kind: 'custom', base: 'deny', allow: [], deny: [] }, 'read-only'],
    [{ kind: 'custom', base: 'workspace', allow: [], deny: [] }, 'workspace-write'],
  ]
  for (const [write, mode] of cases) {
    const session = fakeSession()
    mirrorWriteMode(session as never, { read: { kind: 'all' }, write })
    assert.deepEqual(session.appends, [{ type: 'sandbox/mode', data: { mode } }], write.kind)
  }
})

test('no session-log event type of this package is written any more', () => {
  // The pair lives in ./session-store.ts instead: an event type this package
  // declares is outside 0.1.7's KNOWN_SESSION_EVENT_TYPES and cannot be marked
  // ignorable, so a log carrying it is refused whole on the next start.
  const session = fakeSession()
  mirrorWriteMode(session as never, { read: { kind: 'all' }, write: { kind: 'workspace' } })
  assert.deepEqual([...new Set(session.appends.map(a => a.type))], ['sandbox/mode'])
})

/* ------------------------------- prompt text ------------------------------- */

test('the prompt states the intersection instead of denying it', () => {
  const resolved = resolveEffectiveAxes({ read: { kind: 'workspace' }, write: { kind: 'all' } }, [], { workspaceRoot: WS })
  assert.equal(resolved.ok, true)
  const text = renderScopePrompt(resolved.ok ? resolved.axes : { read: { kind: 'all' }, write: { kind: 'all' }, narrowing: { narrowed: false, droppedRoots: [], lostUnbounded: false } }, WS)
  assert.match(text, /INTERSECTED with the read axis/)
  assert.doesNotMatch(text, /not narrowed by the read axis/)
})

test('the prompt reports the roots the read axis removed when it removed any', () => {
  const resolved = resolveEffectiveAxes(
    { read: { kind: 'workspace' }, write: { kind: 'custom', base: 'all', allow: ['C:\\outside'], deny: [] } },
    [],
    { workspaceRoot: WS },
  )
  assert.equal(resolved.ok, true)
  if (!resolved.ok) return
  const text = renderScopePrompt(resolved.axes, WS)
  assert.match(text, /The read axis narrowed this write range/)
  assert.match(text, /C:\\\\outside/)
})

test('an unresolvable reference is stated as permitting nothing, naming the id', () => {
  const resolved = resolveEffectiveAxes({ read: { kind: 'custom', base: 'all', groups: ['gone'], allow: [], deny: [] }, write: { kind: 'workspace' } }, [], { workspaceRoot: WS })
  assert.equal(resolved.ok, false)
  const text = unresolvedAxesNotice(resolved.ok ? '' : resolved.problem)
  assert.match(text, /no path is known to be allowed/)
  assert.match(text, /"gone"/)
})

test('a single dispatch appends exactly one mode record', () => {
  const session = fakeSession()
  mirrorWriteMode(session as never, { read: { kind: 'all' }, write: { kind: 'workspace' } })
  assert.equal(session.appends.filter(a => a.type === 'sandbox/mode').length, 1)
})


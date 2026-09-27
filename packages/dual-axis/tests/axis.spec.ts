/**
 * Unit tests for the dual-axis host half: the axis algebra, the scope
 * containment relation, and the read-path fence decision.
 *
 * Run with `node --test` under tsx's ESM loader, which is how this repository
 * executes TypeScript test sources:
 *   node --import tsx/esm --test tests/axis.spec.ts
 *
 * Every assertion here exercises a pure function or a fold; the filesystem
 * fence overrides are covered through `readAxisRefusal`, which is the whole
 * decision they delegate to.
 *
 * @module @t4r71/dsh-dual-axis/tests
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_READ_SCOPE,
  DEFAULT_WRITE_SCOPE,
  effectiveScopes,
  isModeConsistent,
  isSandboxMode,
  modeOfAxisBase,
  modeOfScope,
  scopeOfMode,
} from '../src/axis.ts'
import type { AxisScope } from '../src/axis.ts'
import {
  ScopeConfigError,
  isAbsoluteSpelling,
  isLexicallyUnder,
  resolveScope,
  scopeContains,
} from '../src/scope.ts'
import { axesOf, normalizeScope, sameScope } from '../src/config.ts'
import { readAxisRefusal, readAxisRefusalAsync } from '../src/fs-fence.ts'

/** A workspace root used only as a string, for containment tests. */
const WS = process.platform === 'win32' ? 'C:\\ws' : '/ws'
/** A second absolute root outside WS. */
const OUT = process.platform === 'win32' ? 'C:\\outside' : '/outside'
/** The host's path separator, for building descendants. */
const S = process.platform === 'win32' ? '\\' : '/'

/* ------------------------------ axis algebra ------------------------------ */

test('the closed kinds map onto the three sandbox modes and back', () => {
  assert.equal(modeOfScope({ kind: 'deny' }), 'read-only')
  assert.equal(modeOfScope({ kind: 'workspace' }), 'workspace-write')
  assert.equal(modeOfScope({ kind: 'all' }), 'danger-full-access')
  assert.deepEqual(scopeOfMode('read-only'), { kind: 'deny' })
  assert.deepEqual(scopeOfMode('workspace-write'), { kind: 'workspace' })
  assert.deepEqual(scopeOfMode('danger-full-access'), { kind: 'all' })
})

test('a custom write scope spells the mode of its own base, not of custom', () => {
  for (const base of ['deny', 'workspace', 'all'] as const) {
    const scope: AxisScope = { kind: 'custom', base, allow: [], deny: [] }
    assert.equal(modeOfScope(scope), modeOfAxisBase(base))
  }
  assert.equal(modeOfScope({ kind: 'custom', base: 'all', allow: [OUT], deny: [] }), 'danger-full-access')
})

test('isSandboxMode narrows untrusted log values', () => {
  assert.equal(isSandboxMode('read-only'), true)
  assert.equal(isSandboxMode('danger-full-access'), true)
  assert.equal(isSandboxMode('yolo'), false)
  assert.equal(isSandboxMode(undefined), false)
  assert.equal(isSandboxMode(3), false)
})

test('the built-in defaults are the host for reads and the workspace for writes', () => {
  assert.deepEqual(DEFAULT_READ_SCOPE, { kind: 'all' })
  assert.deepEqual(DEFAULT_WRITE_SCOPE, { kind: 'workspace' })
})

test('effectiveScopes falls back to mode for writes and all for reads', () => {
  const readOnly = { mode: 'read-only' as const, workspaceRoot: WS }
  const bare = effectiveScopes(readOnly)
  assert.deepEqual(bare.read, { kind: 'all' })
  assert.deepEqual(bare.write, { kind: 'deny' })

  const custom: AxisScope = { kind: 'custom', base: 'workspace', allow: [OUT], deny: [] }
  const carried = effectiveScopes(readOnly, { read: { kind: 'deny' }, write: custom })
  assert.deepEqual(carried.read, { kind: 'deny' })
  assert.deepEqual(carried.write, custom)
})

test('isModeConsistent holds exactly when mode spells the write base', () => {
  const policy = { mode: 'workspace-write' as const, workspaceRoot: WS }
  assert.equal(isModeConsistent(policy, { write: { kind: 'workspace' } }), true)
  assert.equal(isModeConsistent(policy, { write: { kind: 'all' } }), false)
  assert.equal(
    isModeConsistent(policy, { write: { kind: 'custom', base: 'workspace', allow: [OUT], deny: [] } }),
    true,
  )
})

/* --------------------------- scope containment --------------------------- */

test('deny permits nothing at all', () => {
  const scope = resolveScope({ kind: 'deny' }, { workspaceRoot: WS })
  assert.equal(scope.unbounded, false)
  assert.deepEqual(scope.allow, [])
  assert.equal(scopeContains(scope, WS, isLexicallyUnder), false)
})

test('all is unbounded: the flag carries it, not a root path', () => {
  const scope = resolveScope({ kind: 'all' }, { workspaceRoot: WS })
  assert.equal(scope.unbounded, true)
  assert.equal(scopeContains(scope, OUT, isLexicallyUnder), true)
  assert.equal(scopeContains(scope, 'D:' + S + 'anywhere', isLexicallyUnder), true)
})

test('workspace permits the workspace root and descendants, nothing else', () => {
  const scope = resolveScope({ kind: 'workspace' }, { workspaceRoot: WS })
  assert.equal(scope.unbounded, false)
  assert.equal(scopeContains(scope, WS, isLexicallyUnder), true)
  assert.equal(scopeContains(scope, WS + S + 'sub' + S + 'file.txt', isLexicallyUnder), true)
  assert.equal(scopeContains(scope, OUT, isLexicallyUnder), false)
  // A sibling whose spelling shares a textual prefix must NOT be contained.
  assert.equal(scopeContains(scope, WS + '-sibling', isLexicallyUnder), false)
})

test('custom additions are permitted over their base', () => {
  const scope = resolveScope(
    { kind: 'custom', base: 'workspace', allow: [OUT], deny: [] },
    { workspaceRoot: WS },
  )
  assert.equal(scopeContains(scope, WS, isLexicallyUnder), true)
  assert.equal(scopeContains(scope, OUT, isLexicallyUnder), true)
  assert.equal(scopeContains(scope, OUT + S + 'x', isLexicallyUnder), true)
})

test('custom removals win over both the base and an addition', () => {
  const denied = WS + S + 'secret'
  const scope = resolveScope(
    { kind: 'custom', base: 'workspace', allow: [OUT], deny: [denied] },
    { workspaceRoot: WS },
  )
  assert.equal(scopeContains(scope, denied, isLexicallyUnder), false)
  assert.equal(scopeContains(scope, denied + S + 'f', isLexicallyUnder), false)
  // The removal does not spill onto the rest of the workspace.
  assert.equal(scopeContains(scope, WS, isLexicallyUnder), true)
  assert.equal(scopeContains(scope, OUT, isLexicallyUnder), true)
})

test('removal wins even on an unbounded base', () => {
  const scope = resolveScope(
    { kind: 'custom', base: 'all', allow: [], deny: [OUT] },
    { workspaceRoot: WS },
  )
  assert.equal(scope.unbounded, true)
  assert.equal(scopeContains(scope, OUT, isLexicallyUnder), false)
  assert.equal(scopeContains(scope, OUT + S + 'k', isLexicallyUnder), false)
  assert.equal(scopeContains(scope, WS, isLexicallyUnder), true)
})

test('a custom entry that is not an absolute path fails closed', () => {
  assert.throws(
    () => resolveScope({ kind: 'custom', base: 'workspace', allow: ['relative/path'], deny: [] }, { workspaceRoot: WS }),
    ScopeConfigError,
  )
  assert.throws(
    () => resolveScope({ kind: 'custom', base: 'workspace', allow: [], deny: [''] }, { workspaceRoot: WS }),
    ScopeConfigError,
  )
})

test('absolute spelling accepts POSIX and Windows forms', () => {
  assert.equal(isAbsoluteSpelling('/tmp'), true)
  assert.equal(isAbsoluteSpelling('C:' + S + 'x'), true)
  assert.equal(isAbsoluteSpelling('c:/x'), true)
  assert.equal(isAbsoluteSpelling('\\\\server\\share'), true)
  assert.equal(isAbsoluteSpelling('relative'), false)
  assert.equal(isAbsoluteSpelling('./x'), false)
})

test('workspace roots are deduplicated and canonicalized', () => {
  const scope = resolveScope({ kind: 'workspace' }, { workspaceRoot: WS })
  assert.equal(new Set(scope.allow).size, scope.allow.length)
})

test('lexical containment honours the host case convention', () => {
  // The predicate splits on the HOST separator, so the descendant is built with S.
  const under = '/a' + S + 'b'
  assert.equal(isLexicallyUnder(under, '/a', true), true)
  assert.equal(isLexicallyUnder('/a' + S + 'b', '/a', true), true)
  assert.equal(isLexicallyUnder('/a', '/a', true), true)
  // Case is preserved only when the caller asks for it.
  assert.equal(isLexicallyUnder('/A' + S + 'b', '/a', true), false)
  assert.equal(isLexicallyUnder('/A' + S + 'b', '/a', false), true)
  // A root spelled with a trailing separator is the same root.
  assert.equal(isLexicallyUnder(under, '/a' + S, true), true)
})

/* --------------------------- read-path decision --------------------------- */

test('the read fence permits everything under the default read axis', () => {
  assert.equal(readAxisRefusal({ kind: 'all' }, { workspaceRoot: WS }, OUT, isLexicallyUnder), undefined)
})

test('the read fence refuses outside a narrowed read axis, naming the axis', () => {
  assert.equal(
    readAxisRefusal({ kind: 'workspace' }, { workspaceRoot: WS }, OUT, isLexicallyUnder),
    'file access denied under the workspace read axis',
  )
  assert.equal(readAxisRefusal({ kind: 'workspace' }, { workspaceRoot: WS }, WS, isLexicallyUnder), undefined)
})

test('the read fence never reports a write-mode name', () => {
  const refusal = readAxisRefusal({ kind: 'workspace' }, { workspaceRoot: WS }, OUT, isLexicallyUnder)
  assert.ok(refusal !== undefined && !refusal.includes('workspace-write'))
  assert.equal(
    readAxisRefusal({ kind: 'deny' }, { workspaceRoot: WS }, WS, isLexicallyUnder),
    'file access denied under the deny read axis',
  )
})

test('the read fence honours custom allow and deny', () => {
  assert.equal(
    readAxisRefusal({ kind: 'custom', base: 'workspace', allow: [OUT], deny: [] }, { workspaceRoot: WS }, OUT, isLexicallyUnder),
    undefined,
  )
  assert.equal(
    readAxisRefusal({ kind: 'custom', base: 'all', allow: [], deny: [OUT] }, { workspaceRoot: WS }, OUT, isLexicallyUnder),
    'file access denied under the custom read axis',
  )
})

test('the async read fence agrees with the synchronous one', async () => {
  const cases: AxisScope[] = [
    { kind: 'all' },
    { kind: 'deny' },
    { kind: 'workspace' },
    { kind: 'custom', base: 'workspace', allow: [OUT], deny: [] },
    { kind: 'custom', base: 'all', allow: [], deny: [OUT] },
  ]
  for (const read of cases) {
    for (const target of [WS, OUT, WS + S + 'd' + S + 'f']) {
      const sync = readAxisRefusal(read, { workspaceRoot: WS }, target, isLexicallyUnder)
      const asyn = await readAxisRefusalAsync(read, { workspaceRoot: WS }, target, async (p, r) => isLexicallyUnder(p, r))
      assert.equal(asyn, sync, read.kind + ' vs ' + target)
    }
  }
})

/* ---------------------------- config validation --------------------------- */

test('normalizeScope accepts every legal axis and rejects the rest', () => {
  assert.deepEqual(normalizeScope('read', { kind: 'all' }), { kind: 'all' })
  assert.deepEqual(
    normalizeScope('read', { kind: 'custom', base: 'workspace', allow: ['/a'], deny: ['/b'] }),
    { kind: 'custom', base: 'workspace', groups: [], allow: ['/a'], deny: ['/b'] },
  )
  // A rule-group reference is a list of non-empty names; whether a name exists
  // is decided where it is used, not here.
  assert.deepEqual(
    normalizeScope('read', { kind: 'custom', base: 'all', groups: ['g1', 'g1'] }).kind === 'custom'
      ? (normalizeScope('read', { kind: 'custom', base: 'all', groups: ['g1', 'g1'] }) as { groups: string[] }).groups
      : [],
    ['g1'],
  )
  assert.throws(() => normalizeScope('read', { kind: 'custom', base: 'all', groups: [1] }), /non-empty rule-group ids/)
  assert.throws(() => normalizeScope('read', null), /must be an access-axis object/)
  assert.throws(() => normalizeScope('read', { kind: 'wide' }), /unknown kind/)
  assert.throws(() => normalizeScope('read', { kind: 'custom', base: 'nope' }), /custom base must be/)
  assert.throws(() => normalizeScope('read', { kind: 'custom', base: 'all', allow: ['rel'] }), /must be an absolute path/)
  assert.throws(() => normalizeScope('read', { kind: 'custom', base: 'all', allow: [1] }), /array of absolute path strings/)
})

test('a custom axis with omitted lists normalizes to empty lists', () => {
  assert.deepEqual(
    normalizeScope('write', { kind: 'custom', base: 'deny' }),
    { kind: 'custom', base: 'deny', groups: [], allow: [], deny: [] },
  )
})

test('axesOf fills the defaults and honours declared values', () => {
  assert.deepEqual(axesOf({}), { read: { kind: 'all' }, write: { kind: 'workspace' } })
  assert.deepEqual(
    axesOf({ read: { kind: 'deny' }, write: { kind: 'all' } }),
    { read: { kind: 'deny' }, write: { kind: 'all' } },
  )
})

test('sameScope compares members, including list order', () => {
  assert.equal(sameScope({ kind: 'all' }, { kind: 'all' }), true)
  assert.equal(sameScope({ kind: 'all' }, { kind: 'deny' }), false)
  const a: AxisScope = { kind: 'custom', base: 'workspace', allow: ['/a', '/b'], deny: [] }
  assert.equal(sameScope(a, { kind: 'custom', base: 'workspace', allow: ['/a', '/b'], deny: [] }), true)
  assert.equal(sameScope(a, { kind: 'custom', base: 'workspace', allow: ['/b', '/a'], deny: [] }), false)
  assert.equal(sameScope(a, { kind: 'custom', base: 'all', allow: ['/a', '/b'], deny: [] }), false)
})

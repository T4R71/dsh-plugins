/**
 * Unit tests for RULE GROUPS and the write-never-exceeds-read invariant: the
 * one resolution both the fence and the prompt consume (`src/groups.ts`), the
 * mode tier it mirrors to the layer below the tool fence, the seeding of a new
 * session's group references, and the `groups=` command grammar.
 *
 * Run with `node --test` under tsx's ESM loader, which is how this repository
 * executes TypeScript test sources:
 *   node --import tsx/esm --test tests/groups.spec.ts
 *
 * Every assertion exercises a pure function or a fold. The runtime facts the
 * package cannot prove offline (that a settings edit reaches a running session
 * without a restart) are recorded in `agent-reports/rule-groups-host.md`
 * instead.
 *
 * @module @t4r71/dsh-dual-axis/tests/groups
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { AxisScope, EffectiveScopes } from '../src/axis.ts'
import { DEFAULT_READ_SCOPE, DEFAULT_WRITE_SCOPE } from '../src/axis.ts'
import {
  intersectResolved,
  narrowerBase,
  referencedGroupIds,
  resolveEffectiveAxes,
  ruleGroupIds,
  scopeOfResolved,
  seedGroupReferences,
} from '../src/groups.ts'
import type { RuleGroup } from '../src/groups.ts'
import { isLexicallyUnder, resolveScope, scopeContains } from '../src/scope.ts'
import { parseAxisEntry } from '../src/axis-entry.ts'
import { sameScope } from '../src/config.ts'

/** A workspace root used only as a string, for containment tests. */
const WS = process.platform === 'win32' ? 'C:\\ws' : '/ws'
/** A second absolute root outside WS. */
const OUT = process.platform === 'win32' ? 'C:\\outside' : '/outside'
/** A root inside WS, for read-axis removals. */
const INNER = WS + (process.platform === 'win32' ? '\\' : '/') + 'secret'
/** The resolver's workspace policy. */
const POLICY = { workspaceRoot: WS }

/**
 * One custom axis. `groups` is present only when the caller passes it: an
 * EXPANDED axis references no group, so it carries no `groups` member at all,
 * and a test that expected `groups: []` there would be asserting a stale copy.
 */
function custom(
  base: 'deny' | 'workspace' | 'all',
  rest: Partial<{ groups: readonly string[]; allow: readonly string[]; deny: readonly string[] }> = {},
): AxisScope {
  const axis = {
    kind: 'custom' as const,
    base,
    allow: rest.allow ?? [],
    deny: rest.deny ?? [],
  }
  return rest.groups === undefined ? axis : { ...axis, groups: rest.groups }
}

/** A preset with `all` read and `workspace` write: the composition's own defaults. */
function defaults(): EffectiveScopes {
  return { read: DEFAULT_READ_SCOPE, write: DEFAULT_WRITE_SCOPE }
}

/** Resolve a preset, asserting that the resolution succeeded. */
function resolved(preset: EffectiveScopes, library: unknown) {
  const result = resolveEffectiveAxes(preset, library, POLICY)
  assert.equal(result.ok, true, result.ok ? '' : result.problem)
  if (!result.ok) throw new Error(result.problem)
  return result.axes
}

/** Whether an evaluated axis permits one root. */
function permits(axis: AxisScope, root: string): boolean {
  return scopeContains(resolveScope(axis, POLICY), root, isLexicallyUnder)
}

/* ------------------------------ group expansion ------------------------------ */

test('a group only contributes the axis it covers', () => {
  const library: RuleGroup[] = [{
    id: 'g1',
    name: 'writes only',
    write: { allow: [OUT], deny: [] },
  }]
  const preset: EffectiveScopes = {
    read: custom('all', { groups: ['g1'] }),
    write: custom('all', { groups: ['g1'], allow: [INNER] }),
  }
  const axes = resolved(preset, library)

  // The read axis referenced g1, but g1 has no read rules: nothing is added.
  // The expansion also drops the reference itself.
  assert.deepEqual(axes.read, custom('all'))
  assert.equal('groups' in axes.read, false)
  // The write axis gains the group's addition beside its own.
  assert.deepEqual(axes.write, custom('all', { allow: [INNER, OUT] }))
})

test('session additions and every selected group merge into one allow list and one deny list', () => {
  const library: RuleGroup[] = [
    { id: 'g1', name: 'g1', read: { allow: [OUT], deny: [INNER] } },
    { id: 'g2', name: 'g2', read: { deny: [OUT] } },
  ]
  const axes = resolved({ read: custom('workspace', { groups: ['g1', 'g2'], allow: ['C:\\extra'] }), write: DEFAULT_WRITE_SCOPE }, library)

  assert.deepEqual(axes.read, custom('workspace', { allow: ['C:\\extra', OUT], deny: [INNER, OUT] }))
  // Removal wins over both the base and every addition, in either direction:
  // a session-level addition cannot rescue a group's removal, and a group's
  // addition cannot rescue a session-level removal.
  assert.equal(permits(axes.read, OUT), false)
  assert.equal(permits(axes.read, INNER), false)
})

test('an expanded axis carries no group ids', () => {
  const axes = resolved({ read: custom('workspace', { groups: ['g1'] }), write: DEFAULT_WRITE_SCOPE }, [
    { id: 'g1', name: 'g1', read: { allow: [OUT] } },
  ])
  assert.deepEqual(axes.read, custom('workspace', { allow: [OUT] }))
})

test('a preset that references nothing is described exactly as the seed declared it', () => {
  const axes = resolved(defaults(), [])
  assert.deepEqual(axes.read, { kind: 'all' })
  assert.deepEqual(axes.write, { kind: 'workspace' })
  assert.equal(axes.narrowing.narrowed, false)
})

test('referencedGroupIds reads both axes, in order and without repeats', () => {
  const preset: EffectiveScopes = {
    read: custom('all', { groups: ['g2', 'g1'] }),
    write: custom('workspace', { groups: ['g1'] }),
  }
  assert.deepEqual(referencedGroupIds(preset), ['g2', 'g1'])
})

/* ------------------------- an unresolvable reference ------------------------- */

test('an undefined group id fails the resolution and names the id', () => {
  const result = resolveEffectiveAxes(
    { read: custom('all', { groups: ['g9'] }), write: DEFAULT_WRITE_SCOPE },
    [{ id: 'g1', name: 'g1', read: { allow: [OUT] } }],
    POLICY,
  )
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.problem, /"g9"/)
  assert.match(result.ok ? '' : result.problem, /does not define/)
})

test('a library that cannot be read fails the resolution instead of dropping rules', () => {
  // A group whose path entry is not absolute: reading it as "no rules" would
  // silently drop a removal the user configured.
  const result = resolveEffectiveAxes(defaults(), [{ id: 'g1', name: 'g1', read: { deny: ['relative'] } }], POLICY)
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.problem, /absolute path/)
})

test('a duplicate id fails the resolution, because two definitions of one id are the drift this design forbids', () => {
  const result = resolveEffectiveAxes(defaults(), [
    { id: 'g1', name: 'a', read: { allow: [OUT] } },
    { id: 'g1', name: 'b', read: { allow: [INNER] } },
  ], POLICY)
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.problem, /more than once/)
})

test('ruleGroupIds reports the defined ids and nothing for an unusable library', () => {
  assert.deepEqual([...ruleGroupIds([{ id: 'g1', name: 'g1' }])], ['g1'])
  assert.equal(ruleGroupIds('not a library').size, 0)
})

/* ------------------------- write never exceeds read ------------------------- */

test('a group granting write access outside the read axis is narrowed away, and the narrowing is reported', () => {
  const axes = resolved(
    { read: { kind: 'workspace' }, write: custom('all', { groups: ['g1'] }) },
    [{ id: 'g1', name: 'outside', write: { allow: [OUT] } }],
  )

  // The write axis was unbounded and added OUT; the read axis covers neither.
  assert.equal(axes.narrowing.narrowed, true)
  assert.equal(axes.narrowing.lostUnbounded, true)
  assert.deepEqual(axes.narrowing.droppedRoots, [OUT])
  assert.equal(permits(axes.write, OUT), false)
  // The intersection still permits what both axes do cover.
  assert.equal(permits(axes.write, WS), true)
  assert.equal(permits(axes.write, WS + (process.platform === 'win32' ? '\\' : '/') + 'file.txt'), true)
})

test('a read removal inside the write range is a narrowing too', () => {
  const axes = resolved(
    { read: custom('all', { deny: [INNER] }), write: { kind: 'workspace' } },
    [],
  )
  assert.equal(axes.narrowing.narrowed, true)
  assert.deepEqual(axes.narrowing.droppedRoots, [INNER])
  assert.equal(permits(axes.write, INNER), false)
  assert.equal(permits(axes.write, WS), true)
})

test('an irrelevant read removal is not reported as a narrowing', () => {
  const axes = resolved(
    { read: custom('all', { deny: [INNER] }), write: { kind: 'workspace' } },
    [],
  )
  // INNER does lie inside the workspace, so it IS relevant; the control is a
  // removal outside every write root.
  const control = resolved(
    { read: custom('all', { deny: [OUT] }), write: { kind: 'workspace' } },
    [],
  )
  assert.equal(axes.narrowing.narrowed, true)
  assert.equal(control.narrowing.narrowed, false)
  assert.deepEqual(control.write, { kind: 'workspace' })
})

test('a read axis of deny empties the write range', () => {
  const axes = resolved({ read: { kind: 'deny' }, write: { kind: 'all' } }, [])
  assert.equal(axes.narrowing.lostUnbounded, true)
  assert.equal(permits(axes.write, WS), false)
  assert.equal(permits(axes.write, OUT), false)
})

test('the intersection of two ranges is the deeper of two nested roots and empty for disjoint ones', () => {
  const nested = intersectResolved(
    { unbounded: false, allow: [WS], deny: [] },
    { unbounded: false, allow: [INNER], deny: [] },
  )
  assert.deepEqual(nested.allow, [INNER])
  const disjoint = intersectResolved(
    { unbounded: false, allow: [WS], deny: [] },
    { unbounded: false, allow: [OUT], deny: [] },
  )
  assert.deepEqual(disjoint.allow, [])
  const union = intersectResolved(
    { unbounded: true, allow: [], deny: [] },
    { unbounded: false, allow: [WS], deny: [] },
  )
  assert.deepEqual(union, { unbounded: false, allow: [WS], deny: [] })
})

test('a range spelled back as an axis evaluates to the same range', () => {
  const range = { unbounded: false, allow: [WS, OUT], deny: [INNER] } as const
  const again = resolveScope(scopeOfResolved(range), POLICY)
  assert.equal(again.unbounded, false)
  assert.deepEqual([...again.allow].sort(), [WS, OUT].sort())
  assert.deepEqual([...again.deny], [INNER])
  assert.equal(resolveScope(scopeOfResolved({ unbounded: true, allow: [], deny: [] }), POLICY).unbounded, true)
})

/* ------------------------------ the mode tier ------------------------------ */

test('the mirrored mode is the narrower of the two bases', () => {
  assert.equal(narrowerBase({ kind: 'all' }, { kind: 'workspace' }), 'workspace')
  assert.equal(narrowerBase({ kind: 'workspace' }, { kind: 'all' }), 'workspace')
  assert.equal(narrowerBase({ kind: 'all' }, { kind: 'all' }), 'all')
  assert.equal(narrowerBase({ kind: 'deny' }, { kind: 'all' }), 'deny')
  assert.equal(narrowerBase(custom('all'), { kind: 'workspace' }), 'workspace')
  assert.equal(narrowerBase(custom('workspace'), { kind: 'deny' }), 'deny')
})

/* -------------------------------- seeding -------------------------------- */

test('seeding leaves a closed kind verbatim instead of promoting it to custom', () => {
  // A closed axis has nowhere to carry an id, and promoting it would report a
  // custom scope the settings page never showed.
  const seeded = seedGroupReferences(defaults(), ['g1', 'g2'])
  assert.deepEqual(seeded.read, DEFAULT_READ_SCOPE)
  assert.deepEqual(seeded.write, DEFAULT_WRITE_SCOPE)
})

test('seeding judges each axis on its own kind', () => {
  const seeded = seedGroupReferences(
    { read: custom('all', { groups: ['g1'] }), write: DEFAULT_WRITE_SCOPE },
    ['g1', 'g2'],
  )
  assert.deepEqual(seeded.read, custom('all', { groups: ['g1', 'g2'] }))
  assert.deepEqual(seeded.write, DEFAULT_WRITE_SCOPE)
})

test('seeding a custom pair keeps the references an axis already carries', () => {
  const before = custom('workspace', { groups: ['g1'] })
  const seeded = seedGroupReferences({ read: before, write: before }, ['g1', 'g2'])
  assert.deepEqual(seeded.read.kind === 'custom' && seeded.read.groups, ['g1', 'g2'])
  assert.deepEqual(seeded.write.kind === 'custom' && seeded.write.groups, ['g1', 'g2'])
})

test('seeding nothing leaves the pair untouched', () => {
  assert.deepEqual(seedGroupReferences(defaults(), []), defaults())
})

/* --------------------------------- grammar --------------------------------- */

test('a groups entry records the ids verbatim and never expands them', () => {
  const parsed = parseAxisEntry(
    'write:custom:base=all,groups=g1|g2',
    defaults(),
    new Set(['g1', 'g2']),
  )
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.ok ? parsed.axes.write : undefined, custom('all', { groups: ['g1', 'g2'] }))
  // The axis the entry does not name keeps the session's own value.
  assert.deepEqual(parsed.ok ? parsed.axes.read : undefined, { kind: 'all' })
})

test('a groups entry naming an unknown id is refused by name', () => {
  const parsed = parseAxisEntry('read:custom:base=all,groups=g1|g9', defaults(), new Set(['g1']))
  assert.equal(parsed.ok, false)
  assert.match(parsed.ok ? '' : parsed.problem, /"g9" is not a rule group/)
})

test('a groups entry carries no empty id and repeats do not duplicate', () => {
  assert.equal(parseAxisEntry('read:custom:base=all,groups=g1|', defaults(), new Set(['g1'])).ok, false)
  const repeated = parseAxisEntry('read:custom:base=all,groups=g1,groups=g1', defaults(), new Set(['g1']))
  assert.deepEqual(repeated.ok ? repeated.axes.read : undefined, custom('all', { groups: ['g1'] }))
})

test('an unknown key is still refused, now naming the three legal keys', () => {
  const parsed = parseAxisEntry('read:custom:base=all,group=g1', defaults(), new Set(['g1']))
  assert.equal(parsed.ok, false)
  assert.match(parsed.ok ? '' : parsed.problem, /expected groups, allow, or deny/)
})

test('groups are part of an axis value for the purposes of comparison', () => {
  assert.equal(sameScope(custom('all', { groups: ['g1'] }), custom('all')), false)
  assert.equal(sameScope(custom('all', { groups: ['g1'] }), custom('all', { groups: ['g1'] })), true)
  // An axis written before groups existed references none.
  assert.equal(sameScope(custom('all'), { kind: 'custom', base: 'all', allow: [], deny: [] }), true)
})

test('an axis value read from a log written before groups existed resolves unchanged', () => {
  const legacy = { kind: 'custom', base: 'all', allow: [OUT], deny: [] } as AxisScope
  const axes = resolved({ read: legacy, write: legacy }, undefined)
  assert.deepEqual(axes.read, legacy)
  assert.deepEqual(axes.write, legacy)
})

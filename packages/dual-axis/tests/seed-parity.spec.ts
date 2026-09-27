/**
 * The seed of a session that has no stored record: ONE computation, TWO packages.
 *
 * The host answers {@link seedPair} from the settings row (plus, for a subagent
 * child, the parent's stored pair) on every live read — the model-facing prompt,
 * the read fence, and `/axis` — and repairs the session to the very same pair.
 * The client half shows that pair for a session the settings document carries no
 * record of, recomputed locally by `sessionAxesSeed` because the two packages
 * share no import (one is a host bundle, the other a browser bundle).
 *
 * Two implementations of one rule drift. This file is the only thing that stops
 * them: it feeds BOTH the SAME rows and asserts the answers are the same BYTES,
 * key order included. A change to either side alone fails here.
 *
 * Run with:
 *   node --import tsx/esm --test tests/seed-parity.spec.ts
 *
 * @module @t4r71/dsh-dual-axis/tests/seed-parity
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_AXES, seedPair } from '../src/session-store.ts'
import type { EffectiveScopes } from '../src/axis.ts'
// The client half's own pure module, imported by path: it has no imports at all,
// which is exactly why it can be loaded into this program. A package boundary
// here would need a dependency edge that does not exist (and must not).
import { sessionAxesSeed } from '../../dual-axis-ui/src/client/permission/session-axes-seed.ts'

/** One row value, and the inherited pair a subagent child would carry. */
interface Case {
  /** What the case is about, for the failure message. */
  readonly what: string
  /** The `dual-axis` row's value, untrusted. */
  readonly row: unknown
  /** The parent's pair, or `undefined` for a top-level session. */
  readonly inherited?: EffectiveScopes | undefined
}

/** A closed inherited pair, as the host's parser hands one to the seed. */
const INHERITED: EffectiveScopes = { read: { kind: 'deny' }, write: { kind: 'workspace' } }

/**
 * A custom inherited pair, normalized the way the host's parser normalizes one.
 */
const INHERITED_CUSTOM: EffectiveScopes = {
  read: { kind: 'custom', base: 'deny', groups: ['A', 'B'], allow: ['D:\\one'], deny: [] },
  write: { kind: 'custom', base: 'workspace', groups: [], allow: [], deny: ['D:\\two'] },
}

const CASES: readonly Case[] = [
  {
    what: 'the distinctive pair the acceptance run saves: read deny, write deny, one group',
    // Both axes are closed, so neither takes the reference: the group needs a
    // axis whose own kind is custom to live on, and no axis was set to custom.
    row: { read: { kind: 'deny' }, write: { kind: 'deny' }, defaultGroups: ['A'] },
  },
  {
    what: 'a row that declares no default group',
    row: { read: { kind: 'deny' }, write: { kind: 'deny' } },
  },
  {
    what: 'a row with an empty defaultGroups list',
    row: { read: { kind: 'all' }, write: { kind: 'workspace' }, defaultGroups: [] },
  },
  {
    what: 'a row naming the same group twice, which the ids are deduped for',
    row: { read: { kind: 'all' }, write: { kind: 'workspace' }, defaultGroups: ['A', 'B', 'A'] },
  },
  {
    what: 'a custom row carrying its own groups, paths and removals',
    row: {
      read: { kind: 'custom', base: 'all', groups: ['B', 'A'], allow: ['D:\\x'], deny: ['D:\\y'] },
      write: { kind: 'custom', base: 'deny', allow: [], deny: [] },
      defaultGroups: ['A'],
    },
  },
  {
    what: 'a row that declares only one axis, the other falling back to its built-in default',
    row: { read: { kind: 'deny' } },
  },
  {
    what: 'a row with every field absent',
    row: {},
  },
  {
    what: 'no row at all (a composition without the settings entry)',
    row: undefined,
  },
  {
    what: 'a row that is not an object at all',
    row: 'nope',
  },
  {
    what: 'a row whose read axis names a kind this build does not know',
    row: { read: { kind: 'wide' }, write: { kind: 'deny' }, defaultGroups: ['A'] },
  },
  {
    what: 'a row whose custom axis has no base',
    row: { read: { kind: 'custom', allow: [] }, write: { kind: 'deny' } },
  },
  {
    what: 'a row whose custom axis carries a relative path',
    row: { read: { kind: 'custom', base: 'all', allow: ['relative/path'], deny: [] }, write: { kind: 'deny' } },
  },
  {
    what: 'a row whose defaultGroups is not an array',
    row: { read: { kind: 'deny' }, write: { kind: 'deny' }, defaultGroups: 'A' },
  },
  {
    what: 'a row whose defaultGroups names an empty id',
    row: { read: { kind: 'deny' }, write: { kind: 'deny' }, defaultGroups: [''] },
  },
  {
    what: 'a row whose read axis is null, which the volatile unwrap refuses',
    row: { read: null, write: { kind: 'deny' } },
  },
  {
    what: 'a row that is an array',
    row: [],
  },
  {
    what: 'a subagent child inheriting a closed pair, with a default group to attach',
    row: { read: { kind: 'all' }, write: { kind: 'all' }, defaultGroups: ['A'] },
    inherited: INHERITED,
  },
  {
    what: 'a subagent child inheriting a custom pair, with a default group to attach',
    row: { read: { kind: 'all' }, write: { kind: 'workspace' }, defaultGroups: ['C'] },
    inherited: INHERITED_CUSTOM,
  },
  {
    what: 'a subagent child inheriting a pair while the row declares no group',
    row: { read: { kind: 'all' }, write: { kind: 'workspace' } },
    inherited: INHERITED_CUSTOM,
  },
  {
    what: 'the reported defect: read all and write workspace, with a default group that has nowhere to go',
    row: { read: { kind: 'all' }, write: { kind: 'workspace' }, defaultGroups: ['A'] },
  },
  {
    what: 'a mixed row: a custom read axis takes the group, a closed write axis is seeded verbatim',
    row: { read: { kind: 'custom', base: 'deny' }, write: { kind: 'workspace' }, defaultGroups: ['A'] },
  },
  {
    what: 'a closed read axis and a custom write axis, the other way round',
    row: { read: { kind: 'all' }, write: { kind: 'custom', base: 'all' }, defaultGroups: ['A'] },
  },
  {
    what: 'a deny axis, which is a closed kind too and takes no reference',
    row: { read: { kind: 'deny' }, write: { kind: 'deny' }, defaultGroups: ['A'] },
  },
  {
    what: 'a subagent child inheriting a pair the host could not have stored',
    row: { read: { kind: 'all' }, write: { kind: 'workspace' }, defaultGroups: ['A'] },
    inherited: { read: { kind: 'nope' }, write: { kind: 'deny' } } as unknown as EffectiveScopes,
  },
]

test('both halves compute the seed of a session with no record, byte for byte', () => {
  for (const one of CASES) {
    const host = seedPair(one.row, one.inherited)
    const client = sessionAxesSeed(one.row, one.inherited)
    assert.deepEqual(client, host, one.what)
    // Key order is part of the stored document's spelling, and it is what a
    // string comparison of two documents would catch: pin it too.
    assert.equal(JSON.stringify(client), JSON.stringify(host), one.what)
  }
})

test('the two halves agree on what "unreadable" means, too', () => {
  // Not every case above falls back, so the fallback has to be asserted on the
  // cases that do — otherwise an implementation that answered the fallback for
  // EVERYTHING would pass the parity test.
  for (const one of CASES) {
    const host = seedPair(one.row, one.inherited)
    if (JSON.stringify(host) !== JSON.stringify(DEFAULT_AXES)) continue
    assert.deepEqual(sessionAxesSeed(one.row, one.inherited), DEFAULT_AXES, one.what)
  }
  const broken: readonly Case[] = CASES.filter(one =>
    one.what.includes('does not know')
    || one.what.includes('no base')
    || one.what.includes('relative path')
    || one.what.includes('not an array')
    || one.what.includes('empty id')
    || one.what.includes('is null')
    || one.what.includes('could not have stored'))
  assert.equal(broken.length, 7, 'every unreadable case is accounted for')
  for (const one of broken) {
    assert.deepEqual(seedPair(one.row, one.inherited), DEFAULT_AXES, one.what)
    assert.deepEqual(sessionAxesSeed(one.row, one.inherited), DEFAULT_AXES, one.what)
  }
})

test('a closed axis is seeded as declared, and a custom one takes the group', () => {
  // The defect this pins: the group tick used to promote whichever axis it was
  // attached to into `custom`, so a settings row reading all/workspace produced a
  // session pair reading custom/custom. The kind a session runs under is the kind
  // the row declares per axis, and the tick only decides what a `custom` axis
  // references.
  const closed = { read: { kind: 'all' }, write: { kind: 'workspace' }, defaultGroups: ['A'] }
  assert.deepEqual(seedPair(closed, undefined), {
    read: { kind: 'all' },
    write: { kind: 'workspace' },
  })
  assert.deepEqual(sessionAxesSeed(closed, undefined), seedPair(closed, undefined))

  // The two axes are judged independently: one takes the references, the other
  // keeps the closed kind it was declared with.
  const mixed = { read: { kind: 'custom', base: 'deny' }, write: { kind: 'workspace' }, defaultGroups: ['A'] }
  assert.deepEqual(seedPair(mixed, undefined), {
    read: { kind: 'custom', base: 'deny', groups: ['A'], allow: [], deny: [] },
    write: { kind: 'workspace' },
  })
  assert.deepEqual(sessionAxesSeed(mixed, undefined), seedPair(mixed, undefined))

  // An empty list is the pre-existing answer: both axes verbatim.
  const noGroups = { read: { kind: 'all' }, write: { kind: 'workspace' }, defaultGroups: [] }
  assert.deepEqual(seedPair(noGroups, undefined), {
    read: { kind: 'all' },
    write: { kind: 'workspace' },
  })
  assert.deepEqual(sessionAxesSeed(noGroups, undefined), seedPair(noGroups, undefined))
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { FlatNode, TaskNode, TaskTreePort } from '../src/task-tree.ts'
import { PLAN_TREE_FIELD, PLAN_TREE_NAMESPACE, planTreeStore } from '../src/session-store.ts'

import * as planTree from '../src/index.ts'

/**
 * Drives the REAL `taskTree` service the plugin provides, over the same
 * in-memory stand-in for the host settings service the tool tests use.
 *
 * Every assertion below is made against the SERVICE (the seam
 * `@t4r71/dsh-task` reaches through `ctx.get('taskTree')`) and against the
 * settings DOCUMENT, never against plugin memory: a port that lived in a second
 * store would pass the first kind of assertion and fail the second.
 */

/**
 * An in-memory stand-in for the host settings service, narrowed to the two
 * members `PlanTreeStore` calls and enforcing the revision CAS it retries on.
 */
class FakeSettings {
  /** The whole document: namespace id -> section. */
  readonly sections: Record<string, Record<string, unknown>> = { [PLAN_TREE_NAMESPACE]: { [PLAN_TREE_FIELD]: {} } }
  /** Revision per namespace, bumped on every accepted write. */
  private readonly revisions: Record<string, number> = { [PLAN_TREE_NAMESPACE]: 0 }
  /** How many replacements were attempted, refusals included. */
  attempts = 0
  /** How many of the next replacements to refuse with a conflict. */
  conflicts = 0

  /** @returns one descriptor per namespace, with its revision and value. */
  describe(): { ns: string; value: unknown; revision: number }[] {
    return Object.entries(this.sections).map(([ns, value]) => ({ ns, value, revision: this.revisions[ns] ?? 0 }))
  }

  /**
   * Replace one namespace's section under the revision CAS.
   * @param ns - the namespace to write.
   * @param section - the complete next section.
   * @param expectedRevision - the revision the caller read.
   * @returns nothing; rejects with the settings conflict code on a stale write.
   */
  replace(ns: string, section: object, expectedRevision?: number): Promise<void> {
    this.attempts += 1
    const actual = this.revisions[ns] ?? 0
    if (this.conflicts > 0) {
      this.conflicts -= 1
      return Promise.reject(Object.assign(new Error('settings: conflict'), { code: 'SETTINGS_CONFLICT' }))
    }
    if (expectedRevision !== undefined && expectedRevision !== actual) {
      return Promise.reject(Object.assign(
        new Error('settings: the document moved under this writer'),
        { code: 'SETTINGS_CONFLICT', expected: expectedRevision, actual },
      ))
    }
    this.sections[ns] = section as Record<string, unknown>
    this.revisions[ns] = actual + 1
    return Promise.resolve()
  }

  /** One session's tree exactly as the document stores it. */
  stored(sessionId: string): unknown {
    return (this.sections[PLAN_TREE_NAMESPACE]?.[PLAN_TREE_FIELD] as Record<string, unknown> | undefined)?.[sessionId]
  }
}

/** The stand-in every `setup` mounts, so a test can read the document back. */
let settings = new FakeSettings()

/**
 * Mount the real plugin on a real cordis Context.
 * @returns the context, carrying the `taskTree` service the plugin provides.
 */
async function setup(): Promise<Context> {
  const ctx = new Context()
  // The plugin's own `inject` list is ['tools', 'systemPrompt']: without both
  // services its fiber never activates, the body never runs, and no `taskTree`
  // is provided. That is the same gate a real composition passes.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  settings = new FakeSettings()
  ctx.provide('settings' as never, settings as never)
  await ctx.plugin(planTree)
  return ctx
}

/**
 * The `taskTree` service of one context, as `@t4r71/dsh-task` obtains it.
 * @param ctx - the mounted context.
 * @returns the port.
 */
function portOf(ctx: Context): TaskTreePort {
  const port = ctx.get('taskTree') as TaskTreePort | undefined
  assert.ok(port !== undefined, 'the plugin must provide the taskTree service')
  return port
}

/** Walk one nested tree for an id, depth-first. */
function nodeById(nodes: readonly TaskNode[] | undefined, id: string): TaskNode | undefined {
  for (const node of nodes ?? []) {
    if (node.id === id) return node
    const found = nodeById(node.children, id)
    if (found !== undefined) return found
  }
  return undefined
}

/** The stored tree of one session, as the settings document holds it. */
function storedTree(sessionId: string): unknown {
  return settings.stored(sessionId)
}

describe('taskTree service: flat in, nested out', () => {
  it('nests a flat list by `parent`, in declaration order', async () => {
    const ctx = await setup()
    const port = portOf(ctx)
    const flat: FlatNode[] = [
      { id: 'root', title: 'Root' },
      { id: 'mid', parent: 'root', title: 'Mid' },
      { id: 'leaf', parent: 'mid', title: 'Leaf', detail: 'the deep one' },
      { id: 'sibling', parent: 'root', title: 'Sibling' },
    ]
    await port.write('s1', flat, true)
    const tree = port.read('s1')
    assert.deepStrictEqual(tree.map(node => node.id), ['root'])
    assert.deepStrictEqual(tree[0]?.children?.map(node => node.id), ['mid', 'sibling'])
    assert.strictEqual(nodeById(tree, 'leaf')?.detail, 'the deep one')
    assert.strictEqual(nodeById(tree, 'leaf')?.status, 'pending')
    // The DOCUMENT holds the nesting too: the panel reads that, not this port.
    assert.deepStrictEqual(storedTree('s1'), [{
      id: 'root',
      title: 'Root',
      status: 'pending',
      children: [
        { id: 'mid', title: 'Mid', status: 'pending', children: [{ id: 'leaf', title: 'Leaf', status: 'pending', detail: 'the deep one' }] },
        { id: 'sibling', title: 'Sibling', status: 'pending' },
      ],
    }])
  })

  it('keeps two sessions in two trees that never share a node', async () => {
    const ctx = await setup()
    const port = portOf(ctx)
    await port.write('one', [{ id: 'a', title: 'A' }, { id: 'a-child', parent: 'a', title: 'A child' }], true)
    await port.write('two', [{ id: 'b', title: 'B' }], true)
    assert.deepStrictEqual(port.read('one').map(node => node.id), ['a'])
    assert.deepStrictEqual(port.read('two').map(node => node.id), ['b'])
    await port.step('one', 'a', { status: 'completed' })
    assert.strictEqual(nodeById(port.read('one'), 'a')?.status, 'completed')
    assert.strictEqual(nodeById(port.read('two'), 'b')?.status, 'pending')
    // Partitioned in the document as well, under the session id keys.
    assert.deepStrictEqual(Object.keys(settings.sections[PLAN_TREE_NAMESPACE]?.[PLAN_TREE_FIELD] as object), ['one', 'two'])
  })

  it('a merge into a session with no tree CREATES that tree', async () => {
    const ctx = await setup()
    const port = portOf(ctx)
    // `task plan` without `replace` is the first call any session makes, so it
    // must record the plan rather than report a write it never made.
    await port.write('first', [{ id: 'a', title: 'A' }, { id: 'b', parent: 'a', title: 'B' }], false)
    assert.deepStrictEqual(port.read('first').map(node => node.id), ['a'])
    assert.deepStrictEqual(storedTree('first'), [{
      id: 'a',
      title: 'A',
      status: 'pending',
      children: [{ id: 'b', title: 'B', status: 'pending' }],
    }])
  })

  it('reads the tree of a session that never planned anything as empty, not as an error', async () => {
    const ctx = await setup()
    const port = portOf(ctx)
    assert.deepStrictEqual(port.read('untouched'), [])
    assert.strictEqual(storedTree('untouched'), undefined)
  })
})

describe('taskTree service: the malformed flat shapes are refused', () => {
  it('REFUSES a two-node cycle instead of looping', async () => {
    const ctx = await setup()
    const port = portOf(ctx)
    await assert.rejects(
      port.write('cyc', [{ id: 'a', parent: 'b', title: 'A' }, { id: 'b', parent: 'a', title: 'B' }], true),
      /cycle/,
    )
    assert.strictEqual(storedTree('cyc'), undefined)
  })

  it('REFUSES a self-parent and writes nothing', async () => {
    const ctx = await setup()
    const port = portOf(ctx)
    await assert.rejects(port.write('self', [{ id: 'a', parent: 'a', title: 'A' }], true), /itself/)
    assert.strictEqual(storedTree('self'), undefined)
  })

  it('REFUSES a `parent` naming an id the write does not carry', async () => {
    const ctx = await setup()
    const port = portOf(ctx)
    await assert.rejects(port.write('orphan', [{ id: 'a', parent: 'ghost', title: 'A' }], true), /unknown parent "ghost"/)
    assert.strictEqual(storedTree('orphan'), undefined)
  })

  it('REFUSES a longer cycle and a duplicate id', async () => {
    const ctx = await setup()
    const port = portOf(ctx)
    await assert.rejects(
      port.write('ring', [
        { id: 'a', parent: 'c', title: 'A' },
        { id: 'b', parent: 'a', title: 'B' },
        { id: 'c', parent: 'b', title: 'C' },
      ], true),
      /cycle/,
    )
    await assert.rejects(
      port.write('dup', [{ id: 'a', title: 'One' }, { id: 'a', title: 'Two' }], true),
      /duplicate/,
    )
    assert.strictEqual(storedTree('ring'), undefined)
    assert.strictEqual(storedTree('dup'), undefined)
  })

  it('ACCEPTS multiple roots: several parent-less nodes are a forest', async () => {
    const ctx = await setup()
    const port = portOf(ctx)
    await port.write('forest', [{ id: 'r1', title: 'R1' }, { id: 'r2', title: 'R2' }, { id: 'c', parent: 'r2', title: 'C' }], true)
    const tree = port.read('forest')
    assert.deepStrictEqual(tree.map(node => node.id), ['r1', 'r2'])
    assert.deepStrictEqual(tree[1]?.children?.map(node => node.id), ['c'])
  })
})

describe('taskTree service: write, step and bind', () => {
  it('MERGES when replace is false: unmentioned nodes keep everything', async () => {
    const ctx = await setup()
    const port = portOf(ctx)
    await port.write('m', [
      { id: 'root', title: 'Root' },
      { id: 'kept', parent: 'root', title: 'Kept', detail: 'old detail' },
      { id: 'moved', parent: 'root', title: 'Moved' },
    ], true)
    await port.step('m', 'kept', { status: 'completed' })
    await port.bind('m', 'kept', 'child-session-7')
    // `new` is new; `kept` is NOT mentioned, so its title, detail, status and
    // assignment all survive; `moved` is re-parented under `new`.
    await port.write('m', [
      { id: 'new', parent: 'root', title: 'New', detail: 'added by the merge' },
      { id: 'moved', parent: 'new', title: 'Moved elsewhere' },
    ], false)
    const tree = port.read('m')
    assert.deepStrictEqual(tree.map(node => node.id), ['root'])
    const kept = nodeById(tree, 'kept')
    assert.strictEqual(kept?.title, 'Kept')
    assert.strictEqual(kept?.detail, 'old detail')
    assert.strictEqual(kept?.status, 'completed')
    assert.strictEqual(kept?.assignedTo, 'child-session-7')
    const moved = nodeById(tree, 'moved')
    assert.strictEqual(moved?.title, 'Moved elsewhere')
    assert.deepStrictEqual(nodeById(tree, 'new')?.children?.map(node => node.id), ['moved'])
  })

  it('a merge that would nest a node under its own descendant is refused, and the stored tree survives', async () => {
    const ctx = await setup()
    const port = portOf(ctx)
    await port.write('loop', [{ id: 'a', title: 'A' }, { id: 'b', parent: 'a', title: 'B' }], true)
    // `a` is moved under `b`, which is already a's child: the `parent` links and
    // the stored tree together form a cycle, which no flat list shows by itself.
    await assert.rejects(port.write('loop', [{ id: 'a', parent: 'b', title: 'A' }], false), /cycle|unreachable/)
    const tree = port.read('loop')
    assert.deepStrictEqual(tree.map(node => node.id), ['a'])
    assert.deepStrictEqual(nodeById(tree, 'a')?.children?.map(node => node.id), ['b'])
  })

  it('`step` writes only the fields the patch carries', async () => {
    const ctx = await setup()
    const port = portOf(ctx)
    await port.write('s', [{ id: 'a', title: 'A', detail: 'the original detail' }], true)
    await port.step('s', 'a', { status: 'in_progress' })
    assert.strictEqual(nodeById(port.read('s'), 'a')?.detail, 'the original detail')
    await port.step('s', 'a', { detail: 'a new detail' })
    const node = nodeById(port.read('s'), 'a')
    assert.strictEqual(node?.detail, 'a new detail')
    assert.strictEqual(node?.status, 'in_progress')
    // A blank detail CLEARS it, the same convention plan_step follows.
    await port.step('s', 'a', { detail: '' })
    assert.strictEqual(nodeById(port.read('s'), 'a')?.detail, undefined)
  })

  it('stores `failed` in the plan vocabulary and reads it back as `failed`', async () => {
    const ctx = await setup()
    const port = portOf(ctx)
    await port.write('f', [{ id: 'a', title: 'A' }], true)
    await port.step('f', 'a', { status: 'failed' })
    assert.strictEqual(nodeById(port.read('f'), 'a')?.status, 'failed')
    // Stored as `blocked`: a fifth status value would make BOTH parsers drop
    // the whole tree, the host's and the panel's, rather than flag one node.
    assert.deepStrictEqual(storedTree('f'), [{ id: 'a', title: 'A', status: 'blocked' }])
  })

  it('`bind` records the child session id on the addressed node', async () => {
    const ctx = await setup()
    const port = portOf(ctx)
    await port.write('b', [{ id: 'a', title: 'A' }, { id: 'a1', parent: 'a', title: 'A1' }], true)
    await port.bind('b', 'a1', 'child-42')
    assert.strictEqual(nodeById(port.read('b'), 'a1')?.assignedTo, 'child-42')
    assert.deepStrictEqual(storedTree('b'), [{
      id: 'a',
      title: 'A',
      status: 'pending',
      children: [{ id: 'a1', title: 'A1', status: 'pending', assignedTo: 'child-42' }],
    }])
  })

  it('reports an unknown node id instead of writing a silent no-op', async () => {
    const ctx = await setup()
    const port = portOf(ctx)
    await port.write('x', [{ id: 'a', title: 'A' }], true)
    const before = settings.attempts
    await assert.rejects(port.step('x', 'nope', { status: 'completed' }), /no node with id/)
    await assert.rejects(port.bind('x', 'nope', 'child-1'), /no node with id/)
    // Neither call reached the document at all.
    assert.strictEqual(settings.attempts, before)
  })

  it('reports a session with no tree instead of creating one implicitly', async () => {
    const ctx = await setup()
    const port = portOf(ctx)
    await assert.rejects(port.step('nothing', 'a', { status: 'completed' }), /has no tree/)
    await assert.rejects(port.bind('nothing', 'a', 'child-1'), /has no tree/)
    assert.strictEqual(storedTree('nothing'), undefined)
  })

  it('reports a `step` that carries nothing to write', async () => {
    const ctx = await setup()
    const port = portOf(ctx)
    await assert.rejects(port.step('idle', 'a', {}), /neither a/)
  })

  it('a write the revision fence refused is retried and lands', async () => {
    const ctx = await setup()
    const port = portOf(ctx)
    await port.write('r', [{ id: 'a', title: 'A' }], true)
    const before = settings.attempts
    settings.conflicts = 1
    // One forced conflict models the other writer that landed between this
    // writer's read and its write: the store must re-read and retry.
    await port.step('r', 'a', { status: 'completed' })
    assert.strictEqual(settings.attempts, before + 2)
    assert.deepStrictEqual(storedTree('r'), [{ id: 'a', title: 'A', status: 'completed' }])
  })

  it('REFUSES a write when no settings namespace is composed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(planTree)
    const port = portOf(ctx)
    await assert.rejects(port.write('nowhere', [{ id: 'a', title: 'A' }], true), /plan-tree-sessions/)
    assert.deepStrictEqual(port.read('nowhere'), [])
  })
})

describe('taskTree service: one store, not two', () => {
  it('serves the SAME tree the four plan tools read and write', async () => {
    const ctx = await setup()
    const port = portOf(ctx)
    // Written through the port...
    await port.write('shared', [{ id: 'a', title: 'A' }, { id: 'b', parent: 'a', title: 'B' }], true)
    // ...and read back through the store the tools hold, with no second copy.
    const held = planTreeStore(ctx).get('shared')
    assert.deepStrictEqual(held?.map(node => node.id), ['a'])
    assert.deepStrictEqual(held?.[0]?.children?.map(node => node.id), ['b'])
    // A step through the port moves the node the store reports as well.
    await port.step('shared', 'b', { status: 'completed' })
    assert.strictEqual(planTreeStore(ctx).get('shared')?.[0]?.children?.[0]?.status, 'completed')
  })
})

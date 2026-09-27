/**
 * VERIFICATION of the Lead's report: `plan/declared` is a WHOLE-TREE snapshot
 * (last-write-wins), so a repeated `plan_write` silently discards nodes the
 * caller did not re-list.
 *
 * Also settles the SCOPING question the finding depends on: is the loss
 * confined to the caller's OWN session, or can it destroy ANOTHER session's
 * plan? (A plan/declared event carries no session id, so if the projection
 * were shared across sessions this would be cross-session data loss.)
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PlanNode } from '../../src/types.ts'

import * as planTree from '../../src/index.ts'

const testToolSignal = new AbortController().signal

function agentWithSession(id: string): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(planTree)
  return ctx
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown, agent: Agent) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`snap-${++callCounter}`),
    name,
    arguments: args,
    agent,
  })
}

function treeOf(ctx: Context, agent: Agent & { session: Session }): PlanNode[] | null {
  return ctx.sessionProjections.stateOf(agent.session, 'planTree') ?? null
}

/**
 * Narrow a successful tool result's `value` to a plain object. The runtime types
 * it as the lossless-JSON union, so a test that reads named fields has to say
 * what it expects rather than reaching through the union member by member.
 * @param result - the settled tool result.
 * @returns the value as a field map.
 */
function valueOf(result: { value?: unknown }): Record<string, unknown> {
  return (result.value ?? {}) as Record<string, unknown>
}

/** Flatten every id in the tree, in traversal order. */
function allIds(nodes: readonly PlanNode[] | null): string[] {
  const out: string[] = []
  const walk = (level: readonly PlanNode[] | null): void => {
    for (const node of level ?? []) {
      out.push(node.id)
      walk(node.children ?? null)
    }
  }
  walk(nodes)
  return out
}

describe('LEAD REPORT — repeated plan_write is destructive (whole-tree snapshot)', () => {
  it('CONFIRMS: a second plan_write silently discards every node it does not re-list', async () => {
    const ctx = await setup()
    const agent = agentWithSession('snap-confirm')

    // Declaration 1: a 13-node tree with nested structure.
    const first = Array.from({ length: 13 }, (_, i) => ({
      id: `n${i}`, title: `N${i}`, status: 'pending' as const,
      ...(i === 0 ? { children: [{ id: 'child-a', title: 'CA', status: 'pending' as const }] } : {}),
    }))
    const r1 = await call(ctx, 'plan_write', { nodes: first }, agent)
    expect(r1.isError).toBe(false)
    if (r1.isError) throw new Error('expected success')
    console.log(`[SNAP] declaration 1: total=${valueOf(r1).total} ids=${JSON.stringify(allIds(treeOf(ctx, agent)).slice(0, 20))}`)

    // Declaration 2: only 8 nodes, none of them re-listing n5..n12.
    const second = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, title: `M${i}`, status: 'pending' as const }))
    const r2 = await call(ctx, 'plan_write', { nodes: second }, agent)
    expect(r2.isError).toBe(false)
    if (r2.isError) throw new Error('expected success')
    console.log(`[SNAP] declaration 2: total=${valueOf(r2).total} ids=${JSON.stringify(allIds(treeOf(ctx, agent)))}`)

    const ids = allIds(treeOf(ctx, agent))
    // The confirmed semantics: the FIRST declaration is entirely gone.
    expect(ids).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'])
    expect(ids).not.toContain('n0')
    expect(ids).not.toContain('child-a')

    // And plan_write never warns: it reports only the NEW totals.
    console.log(`[SNAP] call 2 returned total=${valueOf(r2).total} (previous tree had 14 nodes incl. child-a)`)
  })

  it('CONFIRMS: nested structure is lost, not merged, when the parent is re-listed WITHOUT children', async () => {
    const ctx = await setup()
    const agent = agentWithSession('snap-nested')

    await call(ctx, 'plan_write', {
      nodes: [{
        id: 'root', title: 'Root', status: 'pending',
        children: [{ id: 'kid', title: 'Kid', status: 'pending' }],
      }],
    }, agent)
    expect(allIds(treeOf(ctx, agent))).toEqual(['root', 'kid'])

    // Re-declare the SAME id without its children.
    await call(ctx, 'plan_write', { nodes: [{ id: 'root', title: 'Root', status: 'pending' }] }, agent)
    console.log(`[SNAP-nested] after re-declare without children: ${JSON.stringify(allIds(treeOf(ctx, agent)))}`)
    expect(allIds(treeOf(ctx, agent))).toEqual(['root'])
    expect(treeOf(ctx, agent)?.[0]?.children).toBeUndefined()
  })

  it('CONFIRMS: a re-declaration also resets statuses the caller does not restate', async () => {
    const ctx = await setup()
    const agent = agentWithSession('snap-status')
    await call(ctx, 'plan_write', { nodes: [{ id: 'a', title: 'A', status: 'pending' }] }, agent)
    await call(ctx, 'plan_step', { id: 'a', status: 'completed' }, agent)
    expect(treeOf(ctx, agent)?.[0]?.status).toBe('completed')

    // Re-declare the same single node, but as `pending`.
    await call(ctx, 'plan_write', { nodes: [{ id: 'a', title: 'A', status: 'pending' }] }, agent)
    console.log(`[SNAP-status] after re-declare: status=${treeOf(ctx, agent)?.[0]?.status}`)
    // Progress recorded by plan_step is silently rolled back.
    expect(treeOf(ctx, agent)?.[0]?.status).toBe('pending')
  })

  it('SCOPING: the damage is confined to the SAME session (projection is per-session)', async () => {
    const ctx = await setup()
    const alice = agentWithSession('snap-alice')
    const bob = agentWithSession('snap-bob')

    await call(ctx, 'plan_write', { nodes: [{ id: 'alice-1', title: 'A1', status: 'pending' }] }, alice)
    await call(ctx, 'plan_write', { nodes: [{ id: 'bob-1', title: 'B1', status: 'pending' }] }, bob)

    // Alice re-declares; Bob's plan must be untouched.
    await call(ctx, 'plan_write', { nodes: [{ id: 'alice-2', title: 'A2', status: 'pending' }] }, alice)
    console.log(`[SNAP-scope] alice=${JSON.stringify(allIds(treeOf(ctx, alice)))}`)
    console.log(`[SNAP-scope] bob  =${JSON.stringify(allIds(treeOf(ctx, bob)))}`)

    expect(allIds(treeOf(ctx, alice))).toEqual(['alice-2'])
    // No cross-session bleed in the in-process registry.
    expect(allIds(treeOf(ctx, bob))).toEqual(['bob-1'])
  })

  it('SCOPING (ADVERSARIAL): plan_ask rebuilds the WHOLE tree too, so it inherits the same hazard', async () => {
    const ctx = await setup()
    const agent = agentWithSession('snap-ask')

    await call(ctx, 'plan_write', {
      nodes: [
        { id: 'a', title: 'A', status: 'pending' },
        { id: 'b', title: 'B', status: 'pending' },
      ],
    }, agent)
    await call(ctx, 'plan_ask', { id: 'q', question: 'Q?' }, agent)
    console.log(`[SNAP-ask] after ask: ${JSON.stringify(allIds(treeOf(ctx, agent)))}`)
    // plan_ask appends to the tree it read, so nothing is lost here...
    expect(allIds(treeOf(ctx, agent))).toEqual(['a', 'b', 'q'])

    // ...but it re-emits the WHOLE tree as a fresh plan/declared snapshot. A
    // concurrent plan_write between the read and the append would be clobbered,
    // because the snapshot is computed from a value read BEFORE the append.
    const events = agent.session.snapshotEvents().filter(e => e.type === 'plan/declared')
    console.log(`[SNAP-ask] plan/declared event count = ${events.length}`)
    console.log(`[SNAP-ask] last plan/declared plan size = ${JSON.stringify(
      (events.at(-1)?.data as { plan: PlanNode[] }).plan.length)}`)
    // Every plan_ask emits a FULL snapshot — the race surface is real.
    expect(events.length).toBe(2)
  })

  it('FIXED: plan_write now WARNS the caller about the nodes it drops and the progress it resets', async () => {
    const ctx = await setup()
    const agent = agentWithSession('snap-warn')
    await call(ctx, 'plan_write', {
      nodes: [
        { id: 'keep', title: 'K', status: 'completed' },
        { id: 'dropped', title: 'D', status: 'in_progress' },
      ],
    }, agent)
    // Re-declare WITHOUT `dropped`, and with `keep` rolled back to pending.
    const result = await call(ctx, 'plan_write', { nodes: [{ id: 'keep', title: 'K', status: 'pending' }] }, agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    console.log(`[SNAP-warn] result value = ${JSON.stringify(result.value)}`)
    // The overwrite is now REPORTED, not silent: the dropped node is named and
    // the completed -> pending regression is named.
    const value = result.value as Record<string, unknown>
    expect(value['dropped']).toEqual(['dropped'])
    expect(value['regressed']).toEqual(['keep'])
  })

  it('FIXED: a non-destructive re-declaration carries neither warning field', async () => {
    const ctx = await setup()
    const agent = agentWithSession('snap-warn-clean')
    await call(ctx, 'plan_write', { nodes: [{ id: 'only', title: 'O', status: 'pending' }] }, agent)
    const result = await call(ctx, 'plan_write', { nodes: [{ id: 'only', title: 'O', status: 'pending' }] }, agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    // Nothing was lost, so nothing is reported: the warning must not cry wolf.
    const value = result.value as Record<string, unknown>
    expect(Object.keys(value).sort()).toEqual(['counts', 'total'])
  })
})

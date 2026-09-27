/**
 * ADVERSARIAL verification — Claim 1: "8 levels rejected, 3 levels pass;
 * MAX_NODE_SCHEMA_DEPTH = 6, the 6th level omits `children`".
 *
 * The implementer's own test (plan-tree.spec.ts:97) only asserts that a
 * NINE-level tree is rejected and that a THIRD level still declares `children`.
 * Neither pins the actual boundary. This file drives the REAL tool registry end
 * to end and measures the exact deepest NESTED level that is accepted.
 *
 * Depth is counted as LEVELS OF NODES: a bare root is depth 1, a root with a
 * child is depth 2, etc.
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
    callId: ToolCallId(`verify-${++callCounter}`),
    name,
    arguments: args,
    agent,
  })
}

/** Build a single-chain tree exactly `depth` NODE LEVELS deep. */
function chain(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = { id: 'n1', title: 'N1', status: 'pending' }
  let cursor = root
  for (let level = 2; level <= depth; level += 1) {
    const child: Record<string, unknown> = { id: `n${level}`, title: `N${level}`, status: 'pending' }
    cursor.children = [child]
    cursor = child
  }
  return root
}

/** Actual folded tree depth (levels of nodes) of the FIRST node. */
function measuredDepth(nodes: PlanNode[] | null): number {
  let depth = 0
  let level: PlanNode[] | undefined = nodes ?? []
  while (level !== undefined && level.length > 0) {
    depth += 1
    level = level[0]!.children
  }
  return depth
}

describe('CLAIM 1 — plan_write nested-depth boundary', () => {
  it('measures the exact accepted/rejected boundary across depths 1..9', async () => {
    const ctx = await setup()
    const agent = agentWithSession('depth-sweep')
    const accepted: number[] = []
    const rejected: number[] = []

    for (let depth = 1; depth <= 9; depth += 1) {
      const result = await call(ctx, 'plan_write', { nodes: [chain(depth)] }, agent)
      if (result.isError) rejected.push(depth)
      else accepted.push(depth)
    }

    // Report the measured boundary rather than asserting a guessed one.
    console.log(`[CLAIM1] accepted depths = ${JSON.stringify(accepted)}`)
    console.log(`[CLAIM1] rejected depths = ${JSON.stringify(rejected)}`)

    // The boundary the implementer claims: MAX_NODE_SCHEMA_DEPTH = 6.
    expect(accepted).toEqual([1, 2, 3, 4, 5, 6])
    expect(rejected).toEqual([7, 8, 9])
  })

  it('the deepest accepted tree really folds to that many levels (not silently truncated)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('depth-fold')
    const result = await call(ctx, 'plan_write', { nodes: [chain(6)] }, agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected 6 levels to be accepted')

    const tree = ctx.sessionProjections.stateOf(agent.session, 'planTree')
    console.log(`[CLAIM1] 6-level declaration folded depth = ${measuredDepth(tree ?? null)}`)
    // A schema that ACCEPTS then TRUNCATES would be a silent data-loss bug.
    expect(measuredDepth(tree ?? null)).toBe(6)
  })

  it('three levels pass (the implementer\'s positive control)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('depth-3')
    const result = await call(ctx, 'plan_write', {
      nodes: [{
        id: 'root', title: 'Root', status: 'in_progress',
        children: [{ id: 'mid', title: 'Mid', status: 'pending', children: [{ id: 'leaf', title: 'Leaf', status: 'pending' }] }],
      }],
    }, agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected 3 levels to be accepted')
    expect(measuredDepth(ctx.sessionProjections.stateOf(agent.session, 'planTree') ?? null)).toBe(3)
  })

  it('PROBES the failure MODE: is 7 rejected as "unknown property" or silently accepted?', async () => {
    const ctx = await setup()
    const agent = agentWithSession('depth-mode')
    const result = await call(ctx, 'plan_write', { nodes: [chain(7)] }, agent)
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected rejection')
    console.log(`[CLAIM1] depth-7 rejection payload = ${JSON.stringify(result).slice(0, 400)}`)
    // Depth 7 must be a hard, VISIBLE rejection — not a silent truncation.
    expect(JSON.stringify(result)).toContain('children')
  })
})

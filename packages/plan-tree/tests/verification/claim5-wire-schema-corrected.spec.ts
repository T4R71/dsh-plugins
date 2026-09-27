/**
 * CORRECTION OF MY OWN TEST — Claim 5 tested through the REAL wire path.
 *
 * The previous claim-5 tests in claim3-4-5.spec.ts read state via
 * `ctx.sessionProjections.stateOf(...)`, which returns the RAW in-memory state
 * and NEVER runs `viewSchema.parse`. A control proved those tests were vacuous:
 * an undeclared `bogusField` survived `stateOf` untouched.
 *
 * The schema is actually enforced at:
 *   - `SessionProjectionRegistry` line 692: `wire.viewSchema.parse(...)` when a
 *     LISTENER is notified of a state change, and
 *   - line 533: `wire.viewSchema.parse(...)` inside `restore()`.
 *
 * This file drives BOTH real paths. If planNodeSchema were missing the three
 * fields, a zod object strips unknown keys and the fields would vanish HERE.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PlanNode } from '../../src/types.ts'

import * as planTree from '../../src/index.ts'

/**
 * Drive the REAL listener path. Notifications only fire for changes the
 * registry OBSERVES through its `session/event` subscription, so each test
 * emits that event explicitly after appending — the same emit production's
 * Session performs on commit.
 */
function emitCommitted(ctx: Context, session: Session, fromSeq: number): void {
  for (const event of session.snapshotEvents(SessionLogOffset(fromSeq), SessionLogOffset(session.seq))) {
    ctx.emit('session/event', session, event)
  }
}

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

describe('CLAIM 5 (CORRECTED) — the three fields survive viewSchema.parse', () => {
  it('LISTENER PATH: the value handed to a subscriber keeps task/assignedTo/answer', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c5-listener')

    const received: unknown[] = []
    ctx.sessionProjections.onChanged((_session, key, value) => {
      if (key === 'planTree') received.push(value)
    })

    const declared: PlanNode[] = [{
      id: 'n', title: 'N', status: 'pending',
      task: 'the prompt', assignedTo: 'worker-a', answer: 'the answer',
      children: [{ id: 'c', title: 'C', status: 'pending', task: 'child task', assignedTo: 'kid' }],
    }]
    agent.session.append('plan/declared', { plan: declared })
    emitCommitted(ctx, agent.session, 0)

    console.log(`[CLAIM5-listener] notifications = ${received.length}`)
    const last = received.at(-1) as PlanNode[] | null | undefined
    console.log(`[CLAIM5-listener] wire value = ${JSON.stringify(last)}`)

    expect(received.length).toBeGreaterThan(0)
    expect(last?.[0]?.task).toBe('the prompt')
    expect(last?.[0]?.assignedTo).toBe('worker-a')
    expect(last?.[0]?.answer).toBe('the answer')
    expect(last?.[0]?.children?.[0]?.task).toBe('child task')
    expect(last?.[0]?.children?.[0]?.assignedTo).toBe('kid')
  })

  it('LISTENER PATH CONTROL: an undeclared field IS stripped here (proves this path parses)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c5-listener-control')

    const received: unknown[] = []
    ctx.sessionProjections.onChanged((_session, key, value) => {
      if (key === 'planTree') received.push(value)
    })

    const declared = [{ id: 'n', title: 'N', status: 'pending', bogusField: 'MUST VANISH' }] as unknown as PlanNode[]
    agent.session.append('plan/declared', { plan: declared })
    emitCommitted(ctx, agent.session, 0)

    const last = received.at(-1) as Record<string, unknown>[] | null | undefined
    const first = last?.[0]
    console.log(`[CLAIM5-listener-control] wire value = ${JSON.stringify(last)}`)
    console.log(`[CLAIM5-listener-control] bogusField survived? ${first !== undefined && 'bogusField' in first}`)

    // zod object() strips unknown keys -> control proves parse() really ran.
    expect(first !== undefined && 'bogusField' in first).toBe(false)
    // And the declared fields still survive the SAME parse.
    expect(first?.['id']).toBe('n')
  })

  it('RESTORE PATH: restore() viewSchema.parse keeps the three fields', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c5-restore')
    const declared: PlanNode[] = [{
      id: 'n', title: 'N', status: 'pending', task: 't', assignedTo: 'w', answer: 'a',
    }]
    agent.session.append('plan/declared', { plan: declared })
    agent.session.append('plan/step', { id: 'n', status: 'completed', answer: 'b' })

    const events = agent.session.snapshotEvents()
    const result = ctx.sessionProjections.restore({}, events, SessionLogOffset(0), agent.session.header, SessionLogOffset(0))
    const value: PlanNode[] | null | undefined = result.snapshot.values.planTree
    console.log(`[CLAIM5-restore] restored value = ${JSON.stringify(value)}`)

    expect(value?.[0]?.task).toBe('t')
    expect(value?.[0]?.assignedTo).toBe('w')
    // The later step's answer overrides the declared one.
    expect(value?.[0]?.answer).toBe('b')
    expect(value?.[0]?.status).toBe('completed')
  })
})

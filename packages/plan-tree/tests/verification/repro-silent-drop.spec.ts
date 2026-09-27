/**
 * MINIMAL REPRODUCTION — `plan_step` silently discards `assignedTo`/`answer`.
 *
 * Measured facts (from diagnostic-step-surface.spec.ts):
 *  - plan_step's DECLARED parameter schema has exactly ["id","status"].
 *  - validateJsonSchemaValue(plan_step.parameters, {id,status,assignedTo}) === []
 *    i.e. the extra property raises NO violation.
 *  - ctx.tools.execute('plan_step', {..., assignedTo}) returns isError === FALSE.
 *  - The folded node has NO assignedTo, because execute() builds the event from
 *    `args.assignedTo` — which it never reads.
 *
 * So the model is TOLD the step succeeded while the field vanished. This file
 * proves the silent loss end to end, for BOTH fields, through the real registry.
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
    callId: ToolCallId(`repro-${++callCounter}`),
    name,
    arguments: args,
    agent,
  })
}

function nodeById(nodes: readonly PlanNode[] | null, id: string): PlanNode | undefined {
  for (const node of nodes ?? []) {
    if (node.id === id) return node
    const found = nodeById(node.children ?? null, id)
    if (found !== undefined) return found
  }
  return undefined
}

describe('REPRO — plan_step SILENTLY DROPS assignedTo and answer', () => {
  it('assignedTo passed to plan_step: call SUCCEEDS, field is GONE', async () => {
    const ctx = await setup()
    const agent = agentWithSession('repro-assignee')
    await call(ctx, 'plan_write', { nodes: [{ id: 'a', title: 'A', status: 'pending' }] }, agent)

    const result = await call(ctx, 'plan_step', {
      id: 'a', status: 'in_progress', assignedTo: 'worker-x',
    }, agent)

    const tree = ctx.sessionProjections.stateOf(agent.session, 'planTree') ?? null
    const node = nodeById(tree, 'a')

    console.log(`[REPRO] plan_step isError = ${result.isError}`)
    console.log(`[REPRO] node.status = ${node?.status}`)
    console.log(`[REPRO] node.assignedTo = ${JSON.stringify(node?.assignedTo)}`)
    console.log(`[REPRO] last plan/step event = ${JSON.stringify(
      agent.session.snapshotEvents().findLast(e => e.type === 'plan/step')?.data)}`)

    // The call reports SUCCESS...
    expect(result.isError).toBe(false)
    // ...the status really did change...
    expect(node?.status).toBe('in_progress')
    // ...AND (FIXED) the caller-supplied assignment is now recorded, and the
    // same value reaches the durable log rather than being dropped.
    expect(node?.assignedTo).toBe('worker-x')
    const step = agent.session.snapshotEvents().findLast(e => e.type === 'plan/step')
    expect(step?.data).toMatchObject({ id: 'a', status: 'in_progress', assignedTo: 'worker-x' })
  })

  it('answer passed to plan_step: call SUCCEEDS and the answer IS recorded (FIXED)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('repro-answer')
    await call(ctx, 'plan_write', { nodes: [{ id: 'q', title: 'Q', status: 'blocked' }] }, agent)

    const result = await call(ctx, 'plan_step', {
      id: 'q', status: 'completed', answer: 'the human said yes',
    }, agent)

    const node = nodeById(ctx.sessionProjections.stateOf(agent.session, 'planTree') ?? null, 'q')
    console.log(`[REPRO-answer] plan_step isError = ${result.isError}`)
    console.log(`[REPRO-answer] node.answer = ${JSON.stringify(node?.answer)}`)

    expect(result.isError).toBe(false)
    expect(node?.status).toBe('completed')
    // FIXED: the answer the model supplied to plan_step is now durable.
    expect(node?.answer).toBe('the human said yes')
    const step = agent.session.snapshotEvents().findLast(e => e.type === 'plan/step')
    expect(step?.data).toMatchObject({ id: 'q', status: 'completed', answer: 'the human said yes' })
  })

  it('CONTRAST: the same fields DO land when written by the internal tools', async () => {
    const ctx = await setup()
    const agent = agentWithSession('repro-contrast')
    await call(ctx, 'plan_write', {
      nodes: [{ id: 'w', title: 'W', status: 'pending', task: 'do it' }],
    }, agent)
    ctx.provide('agentTeams', {
      createTask: () => Promise.resolve({ id: 't-1' }),
      sendMessage: () => Promise.resolve({ messageId: 'm-1', status: 'accepted' }),
    })
    await call(ctx, 'plan_dispatch', { id: 'w', teammate: 'worker-a' }, agent)
    const node = nodeById(ctx.sessionProjections.stateOf(agent.session, 'planTree') ?? null, 'w')
    console.log(`[REPRO-contrast] after plan_dispatch assignedTo = ${JSON.stringify(node?.assignedTo)}`)
    // plan_dispatch DOES set it — so the field plumbing works; only the
    // plan_step PARAMETER surface is missing it.
    expect(node?.assignedTo).toBe('worker-a')
  })
})

/**
 * DIAGNOSTIC — why did two CLAIM 2 adversarial probes fail?
 *
 * Hypothesis A (my bug): `plan_step`'s declared parameter schema does NOT
 * declare `assignedTo`/`answer`, so the registry rejects the whole call before
 * the plugin body runs — meaning `applyStep`'s preservation logic is correct but
 * UNREACHABLE from the model-facing surface.
 *
 * Hypothesis B (real defect): the fold drops the field.
 *
 * This file distinguishes them by (1) inspecting the declared plan_step
 * parameters and (2) calling plan_step with the extra field and printing the
 * exact error.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
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
    callId: ToolCallId(`diag-${++callCounter}`),
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

describe('DIAGNOSTIC — is plan_step\'s assignedTo/answer reachable from the model surface?', () => {
  it('prints the DECLARED plan_step parameter schema', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(s => s.name === 'plan_step')!
    console.log(`[DIAG] plan_step.parameters = ${JSON.stringify(schema.parameters, null, 2)}`)
    const props = (schema.parameters as { properties: Record<string, unknown> }).properties
    console.log(`[DIAG] plan_step declared property names = ${JSON.stringify(Object.keys(props))}`)

    // The event type declares `assignedTo`/`answer` (src/types.ts:74). The TOOL
    // parameter schema must declare them too (FIXED — they were missing).
    const declared = Object.keys(props)
    expect(declared).toContain('id')
    expect(declared).toContain('status')
    expect(declared).toContain('assignedTo')
    expect(declared).toContain('answer')
    console.log(`[DIAG-VERDICT] assignedTo declared on plan_step tool params? ${declared.includes('assignedTo')}`)
    console.log(`[DIAG-VERDICT] answer declared on plan_step tool params? ${declared.includes('answer')}`)
  })

  it('passing assignedTo to plan_step SUCCEEDS and the value LANDS on the node (FIXED)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('diag-assignee')
    await call(ctx, 'plan_write', { nodes: [{ id: 'a', title: 'A', status: 'pending' }] }, agent)

    const result = await call(ctx, 'plan_step', { id: 'a', status: 'in_progress', assignedTo: 'worker-x' }, agent)
    console.log(`[DIAG] isError=${result.isError}`)
    if (result.isError) console.log(`[DIAG] error = ${JSON.stringify(result.error)}`)
    expect(result.isError).toBe(false)
    const node = nodeById(ctx.sessionProjections.stateOf(agent.session, 'planTree') ?? null, 'a')
    console.log(`[DIAG] node.assignedTo = ${JSON.stringify(node?.assignedTo)}`)
    expect(node?.assignedTo).toBe('worker-x')
  })

  it('validates the payload against the DECLARED schema directly', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(s => s.name === 'plan_step')!
    const violations = validateJsonSchemaValue(
      schema.parameters,
      { id: 'a', status: 'in_progress', assignedTo: 'worker-x' },
      '',
    )
    console.log(`[DIAG] direct validation violations = ${JSON.stringify(violations)}`)
    // The declared parameters accept the payload. NOTE: plan_step's spec still
    // carries no `additionalProperties: false`, so an argument that is NOT
    // declared (e.g. a typo like `assignedtoo`) raises no violation either —
    // see the typo test below.
    expect(violations).toEqual([])
  })

  it('RESIDUAL RISK: a MISSPELLED argument is still accepted silently', async () => {
    const ctx = await setup()
    const agent = agentWithSession('diag-typo')
    await call(ctx, 'plan_write', { nodes: [{ id: 'a', title: 'A', status: 'pending' }] }, agent)

    // `assignedtoo` is a plausible typo and is NOT a declared property.
    const result = await call(ctx, 'plan_step', {
      id: 'a', status: 'in_progress', assignedtoo: 'worker-typo',
    }, agent)

    const node = nodeById(ctx.sessionProjections.stateOf(agent.session, 'planTree') ?? null, 'a')
    console.log(`[DIAG-typo] isError=${result.isError} node.assignedTo=${JSON.stringify(node?.assignedTo)}`)
    // The call succeeds, the typo is ignored, and nothing tells the caller.
    // plan_step declares no `additionalProperties: false`, unlike plan_write's
    // node schema, which DOES reject undeclared properties.
    expect(result.isError).toBe(false)
    expect(node?.assignedTo).toBeUndefined()
  })

  it('the EVENT TYPE does declare them (so this is a surface gap, not a type gap)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('diag-event')
    await call(ctx, 'plan_write', { nodes: [{ id: 'a', title: 'A', status: 'pending' }] }, agent)
    // Append the event DIRECTLY, bypassing the tool surface.
    agent.session.append('plan/step', { id: 'a', status: 'in_progress', assignedTo: 'worker-x' })
    const node = nodeById(ctx.sessionProjections.stateOf(agent.session, 'planTree') ?? null, 'a')
    console.log(`[DIAG] direct event append -> assignedTo=${JSON.stringify(node?.assignedTo)}`)
    expect(node?.assignedTo).toBe('worker-x')
  })
})

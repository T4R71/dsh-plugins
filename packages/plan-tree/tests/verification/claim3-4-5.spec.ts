/**
 * ADVERSARIAL verification — Claims 3, 4, 5.
 *
 * Claim 3: "plan_ask keeps the node blocked when the question service is
 *          missing, and does not silently succeed" — i.e. the return value must
 *          DISTINGUISH delivered-and-answered from not-delivered, rather than
 *          both looking like success.
 * Claim 4: "the soft dependency introduces no agent-team dependency".
 * Claim 5: "planNodeSchema synchronised the three new fields" — the key
 *          reverse-test: a hand-built `plan/declared` carrying task/assignedTo/
 *          answer must survive the projection fold, NOT be stripped by zod.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
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
    callId: ToolCallId(`v345-${++callCounter}`),
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

function treeOf(ctx: Context, agent: Agent & { session: Session }): PlanNode[] | null {
  return ctx.sessionProjections.stateOf(agent.session, 'planTree') ?? null
}

describe('CLAIM 3 — plan_ask distinguishes delivered-and-answered from not-delivered', () => {
  it('service ABSENT: delivered=false, no answer, node stays blocked', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c3-absent')
    await call(ctx, 'plan_write', { nodes: [{ id: 'root', title: 'Root', status: 'pending' }] }, agent)
    expect(ctx.get('userQuestions')).toBeUndefined()

    const result = await call(ctx, 'plan_ask', { id: 'q-a', question: 'Proceed?' }, agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a degraded result, not a failure')
    console.log(`[CLAIM3-absent] value = ${JSON.stringify(result.value)}`)
    expect(result.value).toMatchObject({ delivered: false, status: 'blocked' })
    expect((result.value as { answer?: string }).answer).toBeUndefined()
    expect(nodeById(treeOf(ctx, agent), 'q-a')?.status).toBe('blocked')
    expect(nodeById(treeOf(ctx, agent), 'q-a')?.answer).toBeUndefined()
  })

  it('service PRESENT and answering: delivered=true, answer present, node completed', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c3-present')
    await call(ctx, 'plan_write', { nodes: [{ id: 'root', title: 'Root', status: 'pending' }] }, agent)
    ctx.provide('userQuestions', {
      ask: (request: { questions: { id: string }[] }) => Promise.resolve({
        answers: [{ id: request.questions[0]!.id, selected: ['go'] }],
      }),
    })

    const result = await call(ctx, 'plan_ask', { id: 'q-b', question: 'Proceed?' }, agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    console.log(`[CLAIM3-present] value = ${JSON.stringify(result.value)}`)
    expect(result.value).toMatchObject({ delivered: true, status: 'completed', answer: 'go' })
    expect(nodeById(treeOf(ctx, agent), 'q-b')?.answer).toBe('go')
  })

  it('KEY REVERSE-TEST: the two outcomes are NOT the same shape', async () => {
    const ctx = await setup()
    const degradedAgent = agentWithSession('c3-degraded')
    const answeredAgent = agentWithSession('c3-answered')

    await call(ctx, 'plan_write', { nodes: [{ id: 'root', title: 'Root', status: 'pending' }] }, degradedAgent)
    const degraded = await call(ctx, 'plan_ask', { id: 'q', question: 'Q?' }, degradedAgent)

    ctx.provide('userQuestions', {
      ask: (request: { questions: { id: string }[] }) => Promise.resolve({
        answers: [{ id: request.questions[0]!.id, selected: ['go'] }],
      }),
    })
    await call(ctx, 'plan_write', { nodes: [{ id: 'root', title: 'Root', status: 'pending' }] }, answeredAgent)
    const answered = await call(ctx, 'plan_ask', { id: 'q', question: 'Q?' }, answeredAgent)

    expect(degraded.isError).toBe(false)
    expect(answered.isError).toBe(false)
    if (degraded.isError || answered.isError) throw new Error('expected two non-error results')

    const d = degraded.value as { delivered: boolean; status: string; answer?: string }
    const a = answered.value as { delivered: boolean; status: string; answer?: string }
    console.log(`[CLAIM3-compare] degraded = ${JSON.stringify(d)}`)
    console.log(`[CLAIM3-compare] answered = ${JSON.stringify(a)}`)
    // The whole point: a caller reading only `status`/`delivered` can tell them apart.
    expect(d.delivered).not.toBe(a.delivered)
    expect(d.status).not.toBe(a.status)
    expect(d.answer).toBeUndefined()
    expect(a.answer).toBe('go')
  })

  it('ADVERSARIAL: an answerer that RESOLVES with a MISMATCHED id must not be treated as answered', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c3-mismatch')
    await call(ctx, 'plan_write', { nodes: [{ id: 'root', title: 'Root', status: 'pending' }] }, agent)
    ctx.provide('userQuestions', {
      // Resolves "successfully" but names a different question id.
      ask: () => Promise.resolve({ answers: [{ id: 'some-other-id', selected: ['go'] }] }),
    })

    const result = await call(ctx, 'plan_ask', { id: 'q-mine', question: 'Q?' }, agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected degraded result')
    console.log(`[CLAIM3-mismatch] value = ${JSON.stringify(result.value)}`)
    expect(result.value).toMatchObject({ delivered: false, status: 'blocked' })
    expect(nodeById(treeOf(ctx, agent), 'q-mine')?.status).toBe('blocked')
  })

  it('ADVERSARIAL: an empty answers array must not be treated as answered', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c3-empty')
    await call(ctx, 'plan_write', { nodes: [{ id: 'root', title: 'Root', status: 'pending' }] }, agent)
    ctx.provide('userQuestions', { ask: () => Promise.resolve({ answers: [] }) })

    const result = await call(ctx, 'plan_ask', { id: 'q-e', question: 'Q?' }, agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected degraded result')
    console.log(`[CLAIM3-empty] value = ${JSON.stringify(result.value)}`)
    expect(result.value).toMatchObject({ delivered: false, status: 'blocked' })
  })

  it('ADVERSARIAL: a REJECTING answerer must not be treated as answered', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c3-reject')
    await call(ctx, 'plan_write', { nodes: [{ id: 'root', title: 'Root', status: 'pending' }] }, agent)
    ctx.provide('userQuestions', {
      ask: () => Promise.reject(Object.assign(new Error('nobody there'), { code: 'NO_PROVIDER' })),
    })

    const result = await call(ctx, 'plan_ask', { id: 'q-r', question: 'Q?' }, agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected degraded result')
    console.log(`[CLAIM3-reject] value = ${JSON.stringify(result.value)}`)
    expect(result.value).toMatchObject({ delivered: false, status: 'blocked' })
    expect(nodeById(treeOf(ctx, agent), 'q-r')?.status).toBe('blocked')
  })

  it('ADVERSARIAL: the question node is recorded even when the ask NEVER reaches an answerer', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c3-recorded')
    await call(ctx, 'plan_write', { nodes: [{ id: 'root', title: 'Root', status: 'pending' }] }, agent)
    ctx.provide('userQuestions', { ask: () => Promise.reject(new Error('dead')) })

    await call(ctx, 'plan_ask', { id: 'q-rec', question: 'What now?' }, agent)
    const node = nodeById(treeOf(ctx, agent), 'q-rec')
    console.log(`[CLAIM3-recorded] node = ${JSON.stringify(node)}`)
    // The question must still be durably readable in the plan.
    expect(node).toBeDefined()
    expect(node?.detail).toBe('What now?')
  })
})

describe('CLAIM 5 — planNodeSchema carries the three new fields through the fold', () => {
  it('KEY REVERSE-TEST: hand-built plan/declared with task/assignedTo/answer is NOT stripped', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c5-wire')
    const declared: PlanNode[] = [{
      id: 'n', title: 'N', status: 'in_progress',
      task: 'the prompt', assignedTo: 'worker-a', answer: 'the answer',
      dependsOn: [],
    }]
    agent.session.append('plan/declared', { plan: declared })

    const state = ctx.sessionProjections.stateOf(agent.session, 'planTree')
    console.log(`[CLAIM5] folded[0] = ${JSON.stringify(state?.[0])}`)
    expect(state?.[0]?.task).toBe('the prompt')
    expect(state?.[0]?.assignedTo).toBe('worker-a')
    expect(state?.[0]?.answer).toBe('the answer')
  })

  it('KEY REVERSE-TEST: the fields survive on a NESTED node (deep path, not just root)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c5-nested')
    const declared: PlanNode[] = [{
      id: 'root', title: 'Root', status: 'pending',
      children: [{
        id: 'mid', title: 'Mid', status: 'pending', assignedTo: 'mid-worker',
        children: [{ id: 'leaf', title: 'Leaf', status: 'pending', task: 'leaf task', answer: 'leaf answer' }],
      }],
    }]
    agent.session.append('plan/declared', { plan: declared })

    const state = ctx.sessionProjections.stateOf(agent.session, 'planTree') ?? null
    console.log(`[CLAIM5-nested] mid = ${JSON.stringify(nodeById(state, 'mid'))}`)
    console.log(`[CLAIM5-nested] leaf = ${JSON.stringify(nodeById(state, 'leaf'))}`)
    expect(nodeById(state, 'mid')?.assignedTo).toBe('mid-worker')
    expect(nodeById(state, 'leaf')?.task).toBe('leaf task')
    expect(nodeById(state, 'leaf')?.answer).toBe('leaf answer')
  })

  it('REVERSE-TEST: an event replayed through the FULL fold keeps the fields', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c5-replay')
    const declared: PlanNode[] = [{ id: 'a', title: 'A', status: 'pending', task: 't', assignedTo: 'w' }]
    agent.session.append('plan/declared', { plan: declared })
    agent.session.append('plan/step', { id: 'a', status: 'completed', answer: 'final' })

    // Re-fold every event from scratch, as a restoring client would.
    const folded = ctx.sessionProjections.stateOf(agent.session, 'planTree')
    const node = nodeById(folded ?? null, 'a')
    console.log(`[CLAIM5-replay] replayed node = ${JSON.stringify(node)}`)
    expect(node?.task).toBe('t')
    expect(node?.assignedTo).toBe('w')
    expect(node?.answer).toBe('final')
    expect(node?.status).toBe('completed')
  })

  it('SENSITIVITY CONTROL: stateOf does NOT parse — so this file\'s reads are not proof of schema sync', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c5-sensitivity')
    // `bogusField` is genuinely absent from planNodeSchema.
    const declared = [{ id: 'a', title: 'A', status: 'pending', bogusField: 'should vanish' }] as unknown as PlanNode[]
    agent.session.append('plan/declared', { plan: declared })

    const state = ctx.sessionProjections.stateOf(agent.session, 'planTree')
    const raw = state?.[0] as Record<string, unknown> | undefined
    console.log(`[CLAIM5-sensitivity] stateOf folded[0] = ${JSON.stringify(state?.[0])}`)
    console.log(`[CLAIM5-sensitivity] bogusField present? ${raw !== undefined && 'bogusField' in raw}`)
    // MEASURED: the undeclared field SURVIVES stateOf, because `stateOf` returns
    // the raw in-memory state and never runs `viewSchema.parse`.
    //
    // => The stateOf-based claim-5 tests in THIS file are therefore vacuous as
    //    proof of schema synchronisation. The real wire path is exercised in
    //    claim5-wire-schema-corrected.spec.ts (listener + restore), where the
    //    control field IS stripped and the three real fields survive.
    expect(raw !== undefined && 'bogusField' in raw).toBe(true)
  })

  it('SENSITIVITY CONTROL (on the REAL parse path): restore() strips the undeclared field', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c5-sensitivity-restore')
    const declared = [{ id: 'a', title: 'A', status: 'pending', bogusField: 'MUST VANISH' }] as unknown as PlanNode[]
    agent.session.append('plan/declared', { plan: declared })

    // `restore()` runs `wire.viewSchema.parse` (session-projection index.ts:533),
    // so THIS path is sensitive to the schema.
    const events = agent.session.snapshotEvents()
    const result = ctx.sessionProjections.restore({}, events, SessionLogOffset(0), agent.session.header, SessionLogOffset(0))
    const value = result.snapshot.values.planTree as Record<string, unknown>[] | null | undefined
    console.log(`[CLAIM5-sensitivity-restore] restored = ${JSON.stringify(value)}`)
    // The control field is stripped here — proving this path really parses —
    // while the three REAL fields survive the same parse (see the tests above).
    expect(value?.[0] !== undefined && 'bogusField' in value[0]).toBe(false)
    expect(value?.[0]?.['id']).toBe('a')
  })
})

describe('CLAIM 4 — the soft dependency introduces no agent-team dependency', () => {
  it('the registered tools are exactly the four, with no agent-team service on the context', async () => {
    const ctx = await setup()
    const names = ctx.tools.schemas().map(s => s.name).filter(n => n.startsWith('plan_')).sort()
    console.log(`[CLAIM4] plan_* tools = ${JSON.stringify(names)}`)
    expect(names).toEqual(['plan_ask', 'plan_dispatch', 'plan_step', 'plan_write'])
    // plan-tree mounts and functions with NO agentTeams service present.
    expect(ctx.get('agentTeams')).toBeUndefined()
  })

  it('plan-tree works end to end with NO optional sibling service mounted', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c4-composable')
    const w = await call(ctx, 'plan_write', { nodes: [{ id: 'a', title: 'A', status: 'pending', task: 't' }] }, agent)
    const s = await call(ctx, 'plan_step', { id: 'a', status: 'in_progress' }, agent)
    const d = await call(ctx, 'plan_dispatch', { id: 'a', teammate: 'w' }, agent)
    expect(w.isError).toBe(false)
    expect(s.isError).toBe(false)
    // Degrades rather than failing when the Team service is absent.
    expect(d.isError).toBe(false)
  })
})

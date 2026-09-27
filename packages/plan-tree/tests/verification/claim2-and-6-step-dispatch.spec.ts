/**
 * ADVERSARIAL verification — Claims 2 and 6, plus the implementer's
 * "extra self-check" items that concern the step fold and dependency rules.
 *
 * Claim 2: "a plan/step without assignedTo preserves existing assignment";
 *          likewise `answer` survives a step that does not carry it.
 * Claim 6: "plan_dispatch throws when the id is missing; throws when the node
 *          has no task and none was passed."
 * Extra:   self-dependency in `dependsOn`; appendNode snapshot safety.
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
    callId: ToolCallId(`verify2-${++callCounter}`),
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

/** Minimal stand-in for the OPTIONAL agentTeams service, reached via the context. */
function mountTeams(ctx: Context, hooks: {
  onCreate?: () => void
  onCreateFail?: () => never
  onSend?: () => void
  onSendFail?: () => never
} = {}): void {
  ctx.provide('agentTeams', {
    createTask: (_caller: Agent, request: { subject: string; description: string }) => {
      hooks.onCreate?.()
      hooks.onCreateFail?.()
      return Promise.resolve({ id: `task-for-${request.subject}` })
    },
    sendMessage: (_caller: Agent, request: { target: string; content: { type: string; text?: string }[] }) => {
      hooks.onSend?.()
      hooks.onSendFail?.()
      return Promise.resolve({ messageId: `m-${request.target}`, status: 'accepted' })
    },
  })
}

describe('CLAIM 2 — a step that omits a field leaves the existing value standing', () => {
  it('assignedTo written by plan_dispatch survives a later status-only plan_step', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c2-assignee')
    mountTeams(ctx)
    await call(ctx, 'plan_write', {
      nodes: [{ id: 'work', title: 'Work', status: 'pending', task: 'do it' }],
    }, agent)

    const dispatched = await call(ctx, 'plan_dispatch', { id: 'work', teammate: 'worker-a' }, agent)
    expect(dispatched.isError).toBe(false)
    expect(nodeById(treeOf(ctx, agent), 'work')?.assignedTo).toBe('worker-a')

    // A plain status change carries NO assignedTo.
    await call(ctx, 'plan_step', { id: 'work', status: 'completed' }, agent)
    const node = nodeById(treeOf(ctx, agent), 'work')
    console.log(`[CLAIM2] after status-only step: status=${node?.status} assignedTo=${node?.assignedTo}`)
    expect(node?.status).toBe('completed')
    expect(node?.assignedTo).toBe('worker-a')
  })

  it('answer recorded by plan_ask survives a status-only plan_step', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c2-answer')
    await call(ctx, 'plan_write', { nodes: [{ id: 'root', title: 'Root', status: 'in_progress' }] }, agent)
    ctx.provide('userQuestions', {
      ask: (request: { questions: { id: string }[] }) => Promise.resolve({
        answers: [{ id: request.questions[0]!.id, selected: ['blue'] }],
      }),
    })
    await call(ctx, 'plan_ask', { id: 'q1', question: 'Colour?' }, agent)
    expect(nodeById(treeOf(ctx, agent), 'q1')?.answer).toBe('blue')

    await call(ctx, 'plan_step', { id: 'q1', status: 'in_progress' }, agent)
    const node = nodeById(treeOf(ctx, agent), 'q1')
    console.log(`[CLAIM2] after status-only step: status=${node?.status} answer=${node?.answer}`)
    expect(node?.status).toBe('in_progress')
    expect(node?.answer).toBe('blue')
  })

  it('ADVERSARIAL: a step carrying ONLY assignedTo must not erase an existing answer, and vice versa', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c2-cross')
    await call(ctx, 'plan_write', { nodes: [{ id: 'root', title: 'Root', status: 'pending' }] }, agent)
    ctx.provide('userQuestions', {
      ask: (request: { questions: { id: string }[] }) => Promise.resolve({
        answers: [{ id: request.questions[0]!.id, selected: ['yes'] }],
      }),
    })
    await call(ctx, 'plan_ask', { id: 'q2', question: 'Ship?' }, agent)
    expect(nodeById(treeOf(ctx, agent), 'q2')?.answer).toBe('yes')

    // NOTE: plan_ask appends the question node at the ROOT level. A root-level
    // node has no `task`, so plan_dispatch on it can only succeed by being
    // given an explicit task override.
    mountTeams(ctx)
    const dispatched = await call(ctx, 'plan_dispatch', { id: 'q2', teammate: 'worker-z', task: 'answer follow-up' }, agent)
    expect(dispatched.isError).toBe(false)
    const node = nodeById(treeOf(ctx, agent), 'q2')
    console.log(`[CLAIM2] after dispatch: assignedTo=${node?.assignedTo} answer=${node?.answer} status=${node?.status}`)
    expect(node?.assignedTo).toBe('worker-z')
    // The dispatch carried no `answer`, so the recorded answer must survive.
    expect(node?.answer).toBe('yes')
  })

  it('FIXED: an empty-string assignedTo CLEARS the assignment (three-state semantics)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c2-clear')
    await call(ctx, 'plan_write', {
      nodes: [{ id: 'a', title: 'A', status: 'pending', task: 'the work' }],
    }, agent)
    mountTeams(ctx)
    await call(ctx, 'plan_dispatch', { id: 'a', teammate: 'worker-a' }, agent)
    expect(nodeById(treeOf(ctx, agent), 'a')?.assignedTo).toBe('worker-a')

    // Three-state semantics: ABSENT preserves, non-empty SETS, empty CLEARS.
    const step = await call(ctx, 'plan_step', { id: 'a', status: 'pending', assignedTo: '' }, agent)
    const node = nodeById(treeOf(ctx, agent), 'a')
    console.log(`[CLAIM2-clearcase] step accepted=${!step.isError} assignedTo=${JSON.stringify(node?.assignedTo)}`)
    expect(step.isError).toBe(false)
    // Cleared as ABSENCE, not stored as an empty string: the panel and
    // plan_dispatch both read "no assignee" from the field being missing.
    expect(node?.assignedTo).toBeUndefined()
    const stepEvent = agent.session.snapshotEvents().findLast(e => e.type === 'plan/step')
    console.log(`[CLAIM2-clearcase] step event = ${JSON.stringify(stepEvent?.data)}`)
  })

  it('FIXED: an empty-string answer CLEARS a recorded answer', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c2-clear-answer')
    await call(ctx, 'plan_write', { nodes: [{ id: 'root-node', title: 'Q', status: 'pending' }] }, agent)
    ctx.provide('userQuestions', {
      ask: (request: { questions: { id: string }[] }) => Promise.resolve({
        answers: [{ id: request.questions[0]!.id, selected: ['yes'] }],
      }),
    })
    await call(ctx, 'plan_ask', { id: 'q-clear', question: 'Ship?' }, agent)
    expect(nodeById(treeOf(ctx, agent), 'q-clear')?.answer).toBe('yes')

    await call(ctx, 'plan_step', { id: 'q-clear', status: 'blocked', answer: '' }, agent)
    const node = nodeById(treeOf(ctx, agent), 'q-clear')
    console.log(`[CLAIM2-clearanswer] answer=${JSON.stringify(node?.answer)} status=${node?.status}`)
    expect(node?.answer).toBeUndefined()
    expect(node?.status).toBe('blocked')
  })
})

describe('CLAIM 6 — plan_dispatch error paths', () => {
  it('throws when the id is not in the current plan', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c6-missing')
    await call(ctx, 'plan_write', {
      nodes: [{ id: 'present', title: 'Present', status: 'pending', task: 'p' }],
    }, agent)
    const result = await call(ctx, 'plan_dispatch', { id: 'absent' }, agent)
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected rejection')
    console.log(`[CLAIM6-id] ${JSON.stringify(result.error)}`)
    expect(JSON.stringify(result)).toContain('absent')
  })

  it('throws when the node has no task and none was passed', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c6-notask')
    await call(ctx, 'plan_write', { nodes: [{ id: 'bare', title: 'Bare', status: 'pending' }] }, agent)
    const result = await call(ctx, 'plan_dispatch', { id: 'bare' }, agent)
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected rejection')
    console.log(`[CLAIM6-task] ${JSON.stringify(result.error)}`)
    expect(JSON.stringify(result)).toContain('task')
  })

  it('ADVERSARIAL: a WHITESPACE-only `task` override must not satisfy the dispatch', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c6-blank')
    await call(ctx, 'plan_write', { nodes: [{ id: 'bare', title: 'Bare', status: 'pending' }] }, agent)
    const result = await call(ctx, 'plan_dispatch', { id: 'bare', task: '    ' }, agent)
    console.log(`[CLAIM6-blank] isError=${result.isError}`)
    expect(result.isError).toBe(true)
  })

  it('ADVERSARIAL: a whitespace-only node `task` declared via plan_write is dropped, so dispatch still throws', async () => {
    const ctx = await setup()
    const agent = agentWithSession('c6-blankdecl')
    await call(ctx, 'plan_write', { nodes: [{ id: 'b', title: 'B', status: 'pending', task: '   ' }] }, agent)
    expect(nodeById(treeOf(ctx, agent), 'b')?.task).toBeUndefined()
    const result = await call(ctx, 'plan_dispatch', { id: 'b' }, agent)
    expect(result.isError).toBe(true)
  })
})

describe('EXTRA — dependency rules and appendNode snapshot safety', () => {
  it('SELF-DEPENDENCY: a node depending on itself is silently dropped (not rejected, not kept)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('x-selfdep')
    const result = await call(ctx, 'plan_write', {
      nodes: [{ id: 'self', title: 'Self', status: 'pending', dependsOn: ['self'] }],
    }, agent)
    console.log(`[X-selfdep] isError=${result.isError}`)
    expect(result.isError).toBe(false)
    // toPlanNodes drops the self-edge rather than rejecting the declaration.
    const node = nodeById(treeOf(ctx, agent), 'self')
    console.log(`[X-selfdep] dependsOn=${JSON.stringify(node?.dependsOn)}`)
    expect(node?.dependsOn).toBeUndefined()
  })

  it('SELF-DEPENDENCY mixed with a real dependency keeps only the real one', async () => {
    const ctx = await setup()
    const agent = agentWithSession('x-selfdep2')
    await call(ctx, 'plan_write', {
      nodes: [
        { id: 'a', title: 'A', status: 'pending' },
        { id: 'b', title: 'B', status: 'pending', dependsOn: ['a', 'b'] },
      ],
    }, agent)
    const node = nodeById(treeOf(ctx, agent), 'b')
    console.log(`[X-selfdep2] dependsOn=${JSON.stringify(node?.dependsOn)}`)
    expect(node?.dependsOn).toEqual(['a'])
  })

  it('appendNode: plan_ask must NOT clobber an existing node\'s assignedTo/answer', async () => {
    const ctx = await setup()
    const agent = agentWithSession('x-append')
    mountTeams(ctx)
    await call(ctx, 'plan_write', {
      nodes: [{ id: 'w', title: 'W', status: 'pending', task: 'work' }],
    }, agent)
    await call(ctx, 'plan_dispatch', { id: 'w', teammate: 'worker-a' }, agent)

    ctx.provide('userQuestions', {
      ask: (request: { questions: { id: string }[] }) => Promise.resolve({
        answers: [{ id: request.questions[0]!.id, selected: ['ok'] }],
      }),
    })
    await call(ctx, 'plan_ask', { id: 'q-append', question: 'Proceed?' }, agent)
    await call(ctx, 'plan_ask', { id: 'q-append-2', question: 'Again?' }, agent)

    const tree = treeOf(ctx, agent)
    const w = nodeById(tree, 'w')
    const q1 = nodeById(tree, 'q-append')
    console.log(`[X-append] w: assignedTo=${w?.assignedTo} status=${w?.status}`)
    console.log(`[X-append] q1: answer=${q1?.answer} status=${q1?.status}`)
    console.log(`[X-append] ids=${JSON.stringify((tree ?? []).map(n => n.id))}`)
    // A wholesale plan/declared snapshot is exactly where fields get lost.
    expect(w?.assignedTo).toBe('worker-a')
    expect(q1?.answer).toBe('ok')
    expect((tree ?? []).map(n => n.id)).toEqual(['w', 'q-append', 'q-append-2'])
  })

  it('appendNode preserves a DEEP node\'s fields (append is root-level, must not flatten)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('x-append-deep')
    await call(ctx, 'plan_write', {
      nodes: [{
        id: 'root', title: 'Root', status: 'pending', assignedTo: 'keeper',
        children: [{ id: 'deep', title: 'Deep', status: 'pending', task: 'deep task', assignedTo: 'deep-worker' }],
      }],
    }, agent)
    await call(ctx, 'plan_ask', { id: 'q-deep', question: 'Q?' }, agent)

    const deep = nodeById(treeOf(ctx, agent), 'deep')
    console.log(`[X-append-deep] deep: task=${deep?.task} assignedTo=${deep?.assignedTo}`)
    expect(deep?.task).toBe('deep task')
    expect(deep?.assignedTo).toBe('deep-worker')
    expect(nodeById(treeOf(ctx, agent), 'root')?.assignedTo).toBe('keeper')
  })
})

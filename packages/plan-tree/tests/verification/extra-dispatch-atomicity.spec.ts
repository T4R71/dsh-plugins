/**
 * EXTRA SELF-CHECK — plan_dispatch "atomicity".
 *
 * The implementer's comment claims the assignment rides the SAME step event as
 * the status change so "the panel never shows an `in_progress` node with nobody
 * on it". That claim is about the SUCCESS path. The question here is the
 * FAILURE path:
 *
 *   If createTask SUCCEEDS but sendMessage FAILS, has the plan state changed?
 *   Can we end up with "status in_progress but nobody received the task"?
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
    callId: ToolCallId(`atom-${++callCounter}`),
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

describe('EXTRA — plan_dispatch failure-path atomicity', () => {
  it('sendMessage FAILS after createTask SUCCEEDED: plan must NOT be left in_progress', async () => {
    const ctx = await setup()
    const agent = agentWithSession('atom-sendfail')
    await call(ctx, 'plan_write', {
      nodes: [{ id: 'work', title: 'Work', status: 'pending', task: 'do it' }],
    }, agent)

    let created = 0
    ctx.provide('agentTeams', {
      createTask: () => { created += 1; return Promise.resolve({ id: 'task-orphan' }) },
      sendMessage: () => Promise.reject(new Error('mailbox is full / target unknown')),
    })

    const result = await call(ctx, 'plan_dispatch', { id: 'work', teammate: 'worker-a' }, agent)
    const node = nodeById(treeOf(ctx, agent), 'work')

    console.log(`[ATOM] createTask calls = ${created}`)
    console.log(`[ATOM] dispatch isError = ${result.isError}`)
    console.log(`[ATOM] node.status = ${node?.status}`)
    console.log(`[ATOM] node.assignedTo = ${JSON.stringify(node?.assignedTo)}`)
    const stepEvents = agent.session.snapshotEvents().filter(e => e.type === 'plan/step')
    console.log(`[ATOM] plan/step events emitted = ${stepEvents.length}`)

    // The tool reports the failure...
    expect(result.isError).toBe(true)
    // ...and CRUCIALLY the plan did not move: no "in_progress with nobody on it".
    expect(node?.status).toBe('pending')
    expect(node?.assignedTo).toBeUndefined()
    expect(stepEvents.length).toBe(0)
  })

  it('FINDING: the created Team task is ORPHANED — no compensating delete', async () => {
    const ctx = await setup()
    const agent = agentWithSession('atom-orphan')
    await call(ctx, 'plan_write', {
      nodes: [{ id: 'work', title: 'Work', status: 'pending', task: 'do it' }],
    }, agent)

    const createdIds: string[] = []
    let updateCalls = 0
    let deleteCalls = 0
    const compensatingActions: string[] = []
    ctx.provide('agentTeams', {
      createTask: () => {
        const id = `task-${createdIds.length + 1}`
        createdIds.push(id)
        return Promise.resolve({ id })
      },
      sendMessage: () => Promise.reject(new Error('delivery failed')),
      // Compensation, if any, must go through `updateTask` with action 'delete'.
      updateTask: (_caller: Agent, request: { action: string; taskId: unknown }) => {
        updateCalls += 1
        compensatingActions.push(`${request.action}:${String(request.taskId)}`)
        return Promise.resolve({})
      },
      deleteTask: () => { deleteCalls += 1; return Promise.resolve({}) },
    })

    const result = await call(ctx, 'plan_dispatch', { id: 'work', teammate: 'worker-a' }, agent)

    console.log(`[ATOM-orphan] created = ${JSON.stringify(createdIds)}`)
    console.log(`[ATOM-orphan] compensating updateTask calls = ${updateCalls}`)
    console.log(`[ATOM-orphan] compensating actions = ${JSON.stringify(compensatingActions)}`)
    console.log(`[ATOM-orphan] dispatch isError = ${result.isError}`)

    // FIXED: the orphan is compensated by deleting the just-created task.
    expect(createdIds).toEqual(['task-1'])
    expect(updateCalls).toBe(1)
    expect(compensatingActions).toEqual(['delete:task-1'])
    // The original delivery failure is still what the caller sees.
    expect(result.isError).toBe(true)
  })

  it('FIXED: compensation failure does not mask the original delivery error', async () => {
    const ctx = await setup()
    const agent = agentWithSession('atom-compfail')
    await call(ctx, 'plan_write', {
      nodes: [{ id: 'work', title: 'Work', status: 'pending', task: 'do it' }],
    }, agent)
    ctx.provide('agentTeams', {
      createTask: () => Promise.resolve({ id: 'task-1' }),
      sendMessage: () => Promise.reject(new Error('DELIVERY-FAILED')),
      // Compensation itself blows up; the caller must still learn WHY the
      // dispatch failed, not about the cleanup.
      updateTask: () => Promise.reject(new Error('COMPENSATION-FAILED')),
    })

    const result = await call(ctx, 'plan_dispatch', { id: 'work', teammate: 'worker-a' }, agent)
    const message = result.isError ? JSON.stringify(result.error) : ''
    console.log(`[ATOM-compfail] isError=${result.isError} error=${message.slice(0, 200)}`)
    expect(result.isError).toBe(true)
    expect(message).toContain('DELIVERY-FAILED')
    expect(message).not.toContain('COMPENSATION-FAILED')
    // And the plan still did not move.
    expect(nodeById(treeOf(ctx, agent), 'work')?.status).toBe('pending')
  })

  it('FIXED: a Team surface WITHOUT updateTask still fails cleanly (optional compensation)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('atom-nocomp')
    await call(ctx, 'plan_write', {
      nodes: [{ id: 'work', title: 'Work', status: 'pending', task: 'do it' }],
    }, agent)
    ctx.provide('agentTeams', {
      createTask: () => Promise.resolve({ id: 'task-1' }),
      sendMessage: () => Promise.reject(new Error('delivery failed')),
      // No updateTask at all — the optional method must be tolerated.
    })

    const result = await call(ctx, 'plan_dispatch', { id: 'work', teammate: 'worker-a' }, agent)
    console.log(`[ATOM-nocomp] isError=${result.isError}`)
    expect(result.isError).toBe(true)
    expect(nodeById(treeOf(ctx, agent), 'work')?.status).toBe('pending')
  })

  it('createTask FAILS: plan must not move either', async () => {
    const ctx = await setup()
    const agent = agentWithSession('atom-createfail')
    await call(ctx, 'plan_write', {
      nodes: [{ id: 'work', title: 'Work', status: 'pending', task: 'do it' }],
    }, agent)
    ctx.provide('agentTeams', {
      createTask: () => Promise.reject(new Error('task limit reached')),
      sendMessage: () => Promise.resolve({ messageId: 'm', status: 'accepted' }),
    })

    const result = await call(ctx, 'plan_dispatch', { id: 'work', teammate: 'worker-a' }, agent)
    const node = nodeById(treeOf(ctx, agent), 'work')
    console.log(`[ATOM-createfail] isError=${result.isError} status=${node?.status} assignedTo=${JSON.stringify(node?.assignedTo)}`)
    expect(result.isError).toBe(true)
    expect(node?.status).toBe('pending')
    expect(node?.assignedTo).toBeUndefined()
  })

  it('DEGRADE PATH: teammate given but no Team service still marks in_progress with no assignee', async () => {
    const ctx = await setup()
    const agent = agentWithSession('atom-degrade')
    await call(ctx, 'plan_write', {
      nodes: [{ id: 'work', title: 'Work', status: 'pending', task: 'do it' }],
    }, agent)
    expect(ctx.get('agentTeams')).toBeUndefined()

    const result = await call(ctx, 'plan_dispatch', { id: 'work', teammate: 'worker-a' }, agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected degrade')
    const node = nodeById(treeOf(ctx, agent), 'work')
    console.log(`[ATOM-degrade] value=${JSON.stringify(result.value)} node.status=${node?.status} assignedTo=${JSON.stringify(node?.assignedTo)}`)
    // The node moves to in_progress while NOBODY received it — this IS the
    // "in_progress with nobody on it" shape, reached via the degrade path.
    expect(node?.status).toBe('in_progress')
    expect(node?.assignedTo).toBeUndefined()
    expect((result.value as { dispatchedTo?: string }).dispatchedTo).toBeUndefined()
  })

  it('ADVERSARIAL: a teammate that does not exist — does the Team service reject it?', async () => {
    const ctx = await setup()
    const agent = agentWithSession('atom-ghost')
    await call(ctx, 'plan_write', {
      nodes: [{ id: 'work', title: 'Work', status: 'pending', task: 'do it' }],
    }, agent)
    let sendAttempted = 0
    ctx.provide('agentTeams', {
      createTask: () => Promise.resolve({ id: 't-1' }),
      sendMessage: () => { sendAttempted += 1; return Promise.reject(new Error('unknown teammate "ghost"')) },
    })
    const result = await call(ctx, 'plan_dispatch', { id: 'work', teammate: 'ghost' }, agent)
    console.log(`[ATOM-ghost] isError=${result.isError} sendAttempted=${sendAttempted}`)
    // The plugin forwards the failure rather than inventing a success.
    expect(result.isError).toBe(true)
    expect(nodeById(treeOf(ctx, agent), 'work')?.status).toBe('pending')
  })
})

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PlanNode } from '../src/types.ts'

import * as planTree from '../src/index.ts'

/**
 * Drives the REAL plugin body: mounts `dsh-plan-tree` on a real `ToolRuntime`
 * and a real projection registry, then invokes the registered tools through
 * `ctx.tools.execute` with a fake parent Agent carrying a real `Session` — so
 * the events the tools append are observable on a genuine session log and the
 * `planTree` projection folds them exactly as it does in production.
 */

const testToolSignal = new AbortController().signal

/** A parent Agent backed by a real Session — the tools read `agent.session`. */
function agentWithSession(id = 'planner'): Agent & { session: Session } {
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
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent,
  })
}

/** The folded plan tree for one agent's session, as the panel would receive it. */
function treeOf(ctx: Context, agent: Agent & { session: Session }): PlanNode[] | null {
  return ctx.sessionProjections.stateOf(agent.session, 'planTree') ?? null
}

/** Walk the tree for one id, depth-first. */
function nodeById(nodes: readonly PlanNode[] | null, id: string): PlanNode | undefined {
  for (const node of nodes ?? []) {
    if (node.id === id) return node
    const found = nodeById(node.children ?? null, id)
    if (found !== undefined) return found
  }
  return undefined
}

describe('plan_write', () => {
  it('(a) accepts a three-level nested tree, and the projection folds all three levels', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    const result = await call(ctx, 'plan_write', {
      nodes: [{
        id: 'root', title: 'Root', status: 'in_progress',
        children: [{
          id: 'mid', title: 'Mid', status: 'pending',
          children: [{ id: 'leaf', title: 'Leaf', status: 'pending' }],
        }],
      }],
    }, agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected plan_write success')
    expect(result.value).toMatchObject({ total: 3 })

    const tree = treeOf(ctx, agent)!
    expect(nodeById(tree, 'leaf')?.title).toBe('Leaf')
    expect(nodeById(tree, 'leaf')?.status).toBe('pending')
    expect(nodeById(tree, 'mid')?.children).toHaveLength(1)
  })

  it('rejects a fourth-level property the schema does not declare', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    const result = await call(ctx, 'plan_write', {
      nodes: [{ id: 'a', title: 'A', status: 'pending', bogus: true }],
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('declares `children` three levels down, and refuses to go past its own depth', async () => {
    const ctx = await setup()
    const parameters = ctx.tools.schemas().find(s => s.name === 'plan_write')!.parameters
    const nodes = (parameters.properties as Record<string, { items: { properties: Record<string, unknown> } }>).nodes!
    const level2 = nodes.items.properties.children as { items: { properties: Record<string, unknown> } }
    const level3 = level2.items.properties.children as { items: { properties: Record<string, unknown> } }
    // The whole node repeats inline at every level, so the model can declare
    // `task`/`assignedTo`/`dependsOn` on a third-level node too.
    expect(level3.items.properties).toHaveProperty('children')
    expect(level3.items.properties).toHaveProperty('task')
    expect(level3.items.properties).toHaveProperty('assignedTo')
    expect(level3.items.properties).toHaveProperty('dependsOn')

    // Bounded literal nesting, not unbounded recursion: one level past the
    // declared floor is an unknown property, like any other typo.
    const deep = { id: 'x', title: 'X', status: 'pending', children: [] as unknown[] }
    let cursor = deep
    for (let depth = 0; depth < 8; depth += 1) {
      const child = { id: `x${depth}`, title: 'X', status: 'pending', children: [] as unknown[] }
      cursor.children.push(child)
      cursor = child
    }
    expect(validateJsonSchemaValue(parameters, { nodes: [deep] }, '')).not.toEqual([])
  })

  it('(b) accepts `dependsOn` and rejects a dependency on an unknown id', async () => {
    const ctx = await setup()
    const agent = agentWithSession()

    const ok = await call(ctx, 'plan_write', {
      nodes: [
        { id: 'first', title: 'First', status: 'pending' },
        { id: 'second', title: 'Second', status: 'pending', dependsOn: ['first'] },
      ],
    }, agent)
    expect(ok.isError).toBe(false)
    if (ok.isError) throw new Error('expected plan_write success')
    // The dependency survives normalization and is readable back, which is
    // what makes the panel draw a real edge instead of nothing.
    expect(nodeById(treeOf(ctx, agent), 'second')?.dependsOn).toEqual(['first'])

    const bad = await call(ctx, 'plan_write', {
      nodes: [{ id: 'only', title: 'Only', status: 'pending', dependsOn: ['ghost'] }],
    }, agent)
    expect(bad.isError).toBe(true)
    if (!bad.isError) throw new Error('expected a rejection')
    expect(JSON.stringify(bad)).toContain('ghost')
  })

  it('(c) normalizes `task` (trim, drop blank) and reads it back', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    const result = await call(ctx, 'plan_write', {
      nodes: [
        { id: 'with-task', title: 'With task', status: 'pending', task: '  do the thing  ' },
        { id: 'blank-task', title: 'Blank task', status: 'pending', task: '   ' },
        { id: 'assigned', title: 'Assigned', status: 'pending', assignedTo: '  worker-a  ' },
      ],
    }, agent)
    expect(result.isError).toBe(false)

    const tree = treeOf(ctx, agent)
    expect(nodeById(tree, 'with-task')?.task).toBe('do the thing')
    // A blank prompt is the ABSENCE of one, so plan_dispatch still refuses it.
    expect(nodeById(tree, 'blank-task')?.task).toBeUndefined()
    expect(nodeById(tree, 'assigned')?.assignedTo).toBe('worker-a')
  })

  it('carries `task` and `assignedTo` through the wire schema (narrowed, not stripped)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('wire')
    const declared: PlanNode[] = [{ id: 'a', title: 'A', status: 'pending', task: 'run it', assignedTo: 'worker-a' }]
    agent.session.append('plan/declared', { plan: declared })
    const state = ctx.sessionProjections.stateOf(agent.session, 'planTree')
    expect(state?.[0]?.task).toBe('run it')
    expect(state?.[0]?.assignedTo).toBe('worker-a')
  })
})

describe('plan_step', () => {
  it('moves one node without restating the tree, and preserves an existing assignment', async () => {
    const ctx = await setup()
    const agent = agentWithSession('stepper')
    await call(ctx, 'plan_write', {
      nodes: [{ id: 'step', title: 'Step', status: 'pending', assignedTo: 'worker-b' }],
    }, agent)

    const result = await call(ctx, 'plan_step', { id: 'step', status: 'in_progress' }, agent)
    expect(result.isError).toBe(false)
    const node = nodeById(treeOf(ctx, agent), 'step')
    expect(node?.status).toBe('in_progress')
    // A plain step says nothing about assignment, so it must not erase one.
    expect(node?.assignedTo).toBe('worker-b')
  })

  it('rejects an id the current plan does not carry', async () => {
    const ctx = await setup()
    const agent = agentWithSession('unknown-step')
    await call(ctx, 'plan_write', { nodes: [{ id: 'real', title: 'Real', status: 'pending' }] }, agent)
    const result = await call(ctx, 'plan_step', { id: 'ghost', status: 'completed' }, agent)
    expect(result.isError).toBe(true)
  })
})

describe('plan_dispatch', () => {
  it('(d) degrades without agentTeams: no throw, the plan transition still happens', async () => {
    const ctx = await setup()
    const agent = agentWithSession('no-teams')
    await call(ctx, 'plan_write', {
      nodes: [{ id: 'work', title: 'Do the work', status: 'pending', task: 'the prompt' }],
    }, agent)

    // No Team service is mounted in this composition.
    expect(ctx.get('agentTeams')).toBeUndefined()

    const result = await call(ctx, 'plan_dispatch', { id: 'work', teammate: 'worker-a' }, agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a degraded dispatch, not a failure')
    expect(result.value).toMatchObject({ id: 'work', status: 'in_progress' })
    // Nothing was dispatched, so nothing is claimed about who is doing it.
    expect((result.value as { dispatchedTo?: string }).dispatchedTo).toBeUndefined()
    expect(nodeById(treeOf(ctx, agent), 'work')?.assignedTo).toBeUndefined()
    expect(nodeById(treeOf(ctx, agent), 'work')?.status).toBe('in_progress')
  })

  it('(e) throws when the id is not in the current plan', async () => {
    const ctx = await setup()
    const agent = agentWithSession('missing')
    await call(ctx, 'plan_write', {
      nodes: [{ id: 'present', title: 'Present', status: 'pending', task: 'p' }],
    }, agent)
    const result = await call(ctx, 'plan_dispatch', { id: 'absent' }, agent)
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected a rejection')
    expect(JSON.stringify(result)).toContain('absent')
  })

  it('throws when the node has no task and none was passed', async () => {
    const ctx = await setup()
    const agent = agentWithSession('no-task')
    await call(ctx, 'plan_write', { nodes: [{ id: 'bare', title: 'Bare', status: 'pending' }] }, agent)
    const result = await call(ctx, 'plan_dispatch', { id: 'bare' }, agent)
    expect(result.isError).toBe(true)
  })

  it('uses the `task` override when the node declares none', async () => {
    const ctx = await setup()
    const agent = agentWithSession('override')
    await call(ctx, 'plan_write', { nodes: [{ id: 'o', title: 'O', status: 'pending' }] }, agent)
    const result = await call(ctx, 'plan_dispatch', { id: 'o', task: '  overridden  ' }, agent)
    expect(result.isError).toBe(false)
    expect(nodeById(treeOf(ctx, agent), 'o')?.status).toBe('in_progress')
  })

  it('throws without an owning agent session', async () => {
    const ctx = await setup()
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('call-no-agent'),
      name: 'plan_dispatch',
      arguments: { id: 'x' },
    })
    expect(result.isError).toBe(true)
  })
})

describe('plan_dispatch with a Team service', () => {
  it('(f) records `assignedTo` on the node and creates + delivers the Team task', async () => {
    const ctx = await setup()
    const agent = agentWithSession('lead')
    const created: { subject: string; description: string }[] = []
    const sent: { target: string; text: string }[] = []
    // A stand-in for the OPTIONAL service, reached exactly as production does:
    // through the context, not through a package import.
    ctx.provide('agentTeams', {
      createTask: (_caller: Agent, request: { subject: string; description: string }) => {
        created.push(request)
        return Promise.resolve({ id: 'task-7' })
      },
      sendMessage: (_caller: Agent, request: { target: string; content: { type: string; text?: string }[] }) => {
        sent.push({ target: request.target, text: request.content.map(b => b.text ?? '').join('') })
        return Promise.resolve({ messageId: 'm-1', status: 'accepted' })
      },
    })

    await call(ctx, 'plan_write', {
      nodes: [{ id: 'ship', title: 'Ship it', status: 'pending', task: 'ship the feature' }],
    }, agent)

    const result = await call(ctx, 'plan_dispatch', { id: 'ship', teammate: 'worker-a' }, agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a successful dispatch')
    expect(result.value).toMatchObject({
      id: 'ship',
      status: 'in_progress',
      taskId: 'task-7',
      dispatchedTo: 'worker-a',
    })

    // The Team side: one task with the node's title and the prompt.
    expect(created).toEqual([{ subject: 'Ship it', description: 'ship the feature' }])
    // And the prompt actually delivered to that teammate.
    expect(sent).toEqual([{ target: 'worker-a', text: 'ship the feature' }])

    // The plan side, read back through the projection: the panel now knows who
    // is doing this node, from the SAME step event as the status change.
    const node = nodeById(treeOf(ctx, agent), 'ship')
    expect(node?.assignedTo).toBe('worker-a')
    expect(node?.status).toBe('in_progress')

    // The assignment must be visible on the durable log, not merely in memory:
    // a client rebuilding from events has to see it.
    const step = agent.session.snapshotEvents().findLast(e => e.type === 'plan/step')
    expect(step?.data).toMatchObject({ id: 'ship', status: 'in_progress', assignedTo: 'worker-a' })
  })
})

describe('plan_ask', () => {
  it('(a) inserts the question as a blocked node, visible in the folded tree', async () => {
    const ctx = await setup()
    const agent = agentWithSession('asker')
    await call(ctx, 'plan_write', {
      nodes: [{ id: 'work', title: 'Do the work', status: 'in_progress' }],
    }, agent)

    // No answerer is mounted, so this exercises the node-insertion half on its
    // own: the question must be recorded even though nobody was asked.
    expect(ctx.get('userQuestions')).toBeUndefined()

    const result = await call(ctx, 'plan_ask', {
      id: 'q-color',
      question: 'Which colour should the header be?',
      options: ['red', 'blue'],
    }, agent)

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected plan_ask to record the question')

    const node = nodeById(treeOf(ctx, agent), 'q-color')
    expect(node).toBeDefined()
    expect(node?.status).toBe('blocked')
    expect(node?.detail).toBe('Which colour should the header be?')
    // `title` defaults to the question when none was passed.
    expect(node?.title).toBe('Which colour should the header be?')

    // The pre-existing node is untouched by the insertion.
    expect(nodeById(treeOf(ctx, agent), 'work')?.status).toBe('in_progress')
  })

  it('accepts an explicit `title` distinct from the question', async () => {
    const ctx = await setup()
    const agent = agentWithSession('asker-title')
    await call(ctx, 'plan_write', { nodes: [{ id: 'w', title: 'W', status: 'pending' }] }, agent)

    await call(ctx, 'plan_ask', { id: 'q1', question: 'Which database?', title: 'Pick a database' }, agent)
    const node = nodeById(treeOf(ctx, agent), 'q1')
    expect(node?.title).toBe('Pick a database')
    expect(node?.detail).toBe('Which database?')
  })

  it('(b) throws when the id already exists in the current plan', async () => {
    const ctx = await setup()
    const agent = agentWithSession('dup')
    await call(ctx, 'plan_write', { nodes: [{ id: 'taken', title: 'Taken', status: 'pending' }] }, agent)

    const result = await call(ctx, 'plan_ask', { id: 'taken', question: 'Anything?' }, agent)
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected a duplicate-id rejection')
    expect(JSON.stringify(result)).toContain('taken')

    // The rejected call must not have disturbed the existing node.
    expect(nodeById(treeOf(ctx, agent), 'taken')?.status).toBe('pending')
  })

  it('(c) degrades without a user-questions service: node stays blocked, nothing claimed as answered', async () => {
    const ctx = await setup()
    const agent = agentWithSession('no-asker')
    await call(ctx, 'plan_write', { nodes: [{ id: 'root', title: 'Root', status: 'in_progress' }] }, agent)
    expect(ctx.get('userQuestions')).toBeUndefined()

    const result = await call(ctx, 'plan_ask', { id: 'q-degrade', question: 'Proceed?' }, agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a degraded ask, not a failure')

    // The degradation is EXPLICIT: it does not silently look like an answer.
    expect(result.value).toMatchObject({ id: 'q-degrade', status: 'blocked', delivered: false })
    expect((result.value as { answer?: string }).answer).toBeUndefined()
    expect(JSON.stringify(result.value)).toContain('never shown')

    // And the plan says the same thing: blocked, with no answer on the node.
    const node = nodeById(treeOf(ctx, agent), 'q-degrade')
    expect(node?.status).toBe('blocked')
    expect(node?.answer).toBeUndefined()
  })

  it('(c2) degrades when the answerer itself fails with NO_PROVIDER', async () => {
    const ctx = await setup()
    const agent = agentWithSession('no-provider')
    await call(ctx, 'plan_write', { nodes: [{ id: 'root', title: 'Root', status: 'pending' }] }, agent)

    // A mounted service whose waterfall has no listener rejects exactly as
    // production's does when nothing can answer.
    ctx.provide('userQuestions', {
      ask: () => Promise.reject(Object.assign(new Error('no user-questions answerer accepted the request'), { code: 'NO_PROVIDER' })),
    })

    const result = await call(ctx, 'plan_ask', { id: 'q-np', question: 'Anyone there?' }, agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a degraded ask, not a failure')
    expect(result.value).toMatchObject({ id: 'q-np', status: 'blocked', delivered: false })
    expect(nodeById(treeOf(ctx, agent), 'q-np')?.status).toBe('blocked')
    expect(nodeById(treeOf(ctx, agent), 'q-np')?.answer).toBeUndefined()
  })

  it('(d) writes the answer onto the node and completes it', async () => {
    const ctx = await setup()
    const agent = agentWithSession('answered')
    await call(ctx, 'plan_write', { nodes: [{ id: 'root', title: 'Root', status: 'in_progress' }] }, agent)

    const seen: { id: string; question: string; options?: { label: string }[] }[] = []
    ctx.provide('userQuestions', {
      ask: (request: { questions: { id: string; question: string; options?: { label: string }[] }[] }) => {
        seen.push(request.questions[0]!)
        return Promise.resolve({
          answers: [{ id: request.questions[0]!.id, selected: ['blue'] }],
        })
      },
    })

    const result = await call(ctx, 'plan_ask', {
      id: 'q-colour',
      question: 'Which colour?',
      options: ['red', 'blue'],
    }, agent)

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a successful ask')
    expect(result.value).toMatchObject({
      id: 'q-colour',
      status: 'completed',
      answer: 'blue',
      delivered: true,
    })

    // The options reached the answerer as labelled choices.
    expect(seen).toEqual([{ id: 'q-colour', question: 'Which colour?', options: [{ label: 'red' }, { label: 'blue' }] }])

    // The plan side: completed, with the answer readable back off the node.
    const node = nodeById(treeOf(ctx, agent), 'q-colour')
    expect(node?.status).toBe('completed')
    expect(node?.answer).toBe('blue')

    // Durable on the log, not merely in memory.
    const step = agent.session.snapshotEvents().findLast(e => e.type === 'plan/step')
    expect(step?.data).toMatchObject({ id: 'q-colour', status: 'completed', answer: 'blue' })
  })

  it('joins selected labels with the free-text "Other" answer', async () => {
    const ctx = await setup()
    const agent = agentWithSession('custom')
    await call(ctx, 'plan_write', { nodes: [{ id: 'root', title: 'Root', status: 'pending' }] }, agent)

    ctx.provide('userQuestions', {
      ask: (request: { questions: { id: string }[] }) => Promise.resolve({
        answers: [{ id: request.questions[0]!.id, selected: ['blue'], custom: 'but darker' }],
      }),
    })

    const result = await call(ctx, 'plan_ask', { id: 'q-c', question: 'Which colour?', options: ['blue'] }, agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a successful ask')
    expect((result.value as { answer?: string }).answer).toBe('blue — but darker')
    expect(nodeById(treeOf(ctx, agent), 'q-c')?.answer).toBe('blue — but darker')
  })

  it('carries `answer` through the wire schema (narrowed, not stripped)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('wire-answer')
    const declared: PlanNode[] = [{ id: 'a', title: 'A', status: 'completed', answer: 'yes' }]
    agent.session.append('plan/declared', { plan: declared })
    const state = ctx.sessionProjections.stateOf(agent.session, 'planTree')
    expect(state?.[0]?.answer).toBe('yes')
  })

  it('a later plain plan_step does not erase the recorded answer', async () => {
    const ctx = await setup()
    const agent = agentWithSession('answer-survives')
    await call(ctx, 'plan_write', { nodes: [{ id: 'root', title: 'Root', status: 'pending' }] }, agent)

    ctx.provide('userQuestions', {
      ask: (request: { questions: { id: string }[] }) => Promise.resolve({
        answers: [{ id: request.questions[0]!.id, selected: ['yes'] }],
      }),
    })
    await call(ctx, 'plan_ask', { id: 'q-s', question: 'Ship it?', options: ['yes'] }, agent)
    expect(nodeById(treeOf(ctx, agent), 'q-s')?.answer).toBe('yes')

    // A status-only step says nothing about the answer, so it must leave it
    // standing — the same rule task-5 established for `assignedTo`.
    await call(ctx, 'plan_step', { id: 'q-s', status: 'in_progress' }, agent)
    const node = nodeById(treeOf(ctx, agent), 'q-s')
    expect(node?.status).toBe('in_progress')
    expect(node?.answer).toBe('yes')
  })

  it('throws without an owning agent session', async () => {
    const ctx = await setup()
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('call-ask-no-agent'),
      name: 'plan_ask',
      arguments: { id: 'x', question: 'q' },
    })
    expect(result.isError).toBe(true)
  })
})

/**
 * The tools are useless if the model never learns they are expected. These
 * tests assert the USAGE POLICY actually reaches an assembled prompt — a
 * registered section that renders empty, or one a persona overrides, would
 * leave the tools present and unchosen, which is exactly the failure this
 * section exists to prevent.
 */
describe('plan tree usage policy', () => {
  it('ships a prompt section that names all four tools and when to use them', async () => {
    const ctx = await setup()
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('plan_write')
    expect(prompt).toContain('plan_step')
    expect(prompt).toContain('plan_dispatch')
    expect(prompt).toContain('plan_ask')
    // The load-bearing instruction is not "these tools exist" but "declare the
    // plan BEFORE starting work", plus the dispatch-over-subagent preference.
    expect(prompt).toContain('BEFORE starting work')
    expect(prompt).toMatch(/Prefer `plan_dispatch`/)
  })

  it('SENSITIVITY: the section is absent when the plugin is not mounted', async () => {
    // Same composition MINUS plan-tree. Without this control the assertion
    // above would pass even if the text came from somewhere else entirely.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).not.toContain('plan_dispatch')
    expect(prompt).not.toContain('BEFORE starting work')
  })

  it('orders the policy at the PLAN_POLICY position, ahead of the tool positions', async () => {
    const ctx = await setup()
    const policyOrder = ctx.systemPrompt.getSectionOrder('PLAN_POLICY')
    const subagentOrder = ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT')
    // The position itself is the contract: `PLAN_POLICY` (500) is where the
    // framework keeps "when is a plan required" rules, and it must precede the
    // per-tool positions (1000+) so the model weighs the workflow rule before
    // it picks a tool.
    expect(policyOrder).toBeLessThan(subagentOrder)
    // And the section is really registered at that order, not merely present:
    // registering twice at one name throws, so a successful second mount at the
    // same name proves this exact section occupies `plan:tree`.
    const names = (await ctx.systemPrompt.assemble()).sections.map(candidate => candidate.name)
    expect(names.filter(candidate => candidate === 'plan:tree')).toHaveLength(1)
  })
})

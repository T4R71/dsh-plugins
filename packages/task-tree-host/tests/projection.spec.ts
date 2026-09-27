/**
 * Drives the REAL host plugin body: mounts `dsh-task-tree-host` on a real
 * `ToolRuntime` and a real projection registry, then invokes `task_tree_write`
 * through `ctx.tools.execute` with a fake parent Agent carrying a real
 * `Session` — so the event the tool appends is observable on a genuine session
 * log and the `taskTree` projection folds it exactly as it does in production.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TaskTreeNode } from '../src/types.ts'
import * as taskTreeHost from '../src/index.ts'

const testToolSignal = new AbortController().signal

/** A parent Agent backed by a real Session — the tool reads `agent.session`. */
function agentWithSession(id = 'planner'): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  // ToolRuntime injects `systemPrompt`, so the prompt service mounts first.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(taskTreeHost)
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

/** The folded task tree for one session, as the panel would receive it. */
function treeOf(ctx: Context, agent: Agent & { session: Session }): TaskTreeNode[] | null {
  return ctx.sessionProjections.stateOf(agent.session, 'taskTree') ?? null
}

describe('taskTree projection', () => {
  it('registers the taskTree key and transports a nested array verbatim', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    // Before the first declaration the key is present and null, not absent: a
    // reader can tell "no tree yet" from "this composition has no task tree".
    expect(treeOf(ctx, agent)).toBeNull()
    const result = await call(ctx, 'task_tree_write', {
      nodes: [{ id: 'root', title: 'Root', children: [{ id: 'leaf', title: 'Leaf' }] }],
    }, agent)
    // A successful tool call answers with the tool's own value under `value`.
    expect(result).toMatchObject({ isError: false, value: { total: 2 } })
    const tree = treeOf(ctx, agent)
    expect(tree).toEqual([{ id: 'root', title: 'Root', children: [{ id: 'leaf', title: 'Leaf' }] }])
  })

  it('replaces the whole array on a second declaration (whole-value rule)', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    await call(ctx, 'task_tree_write', { nodes: [{ id: 'a', title: 'A' }] }, agent)
    await call(ctx, 'task_tree_write', { nodes: [{ id: 'b', title: 'B' }] }, agent)
    expect(treeOf(ctx, agent)).toEqual([{ id: 'b', title: 'B' }])
  })

  it('refuses a blank id or title instead of transporting an unlabelled row', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    // The tool pipeline reports a thrown tool error as an `isError` result
    // rather than rejecting, so that is what the caller actually observes.
    const blankId = await call(ctx, 'task_tree_write', { nodes: [{ id: '', title: 'A' }] }, agent) as { isError?: boolean; error?: { message: string } }
    expect(blankId.isError).toBe(true)
    expect(blankId.error?.message).toMatch(/`id` must be a non-empty string/)
    const blankTitle = await call(ctx, 'task_tree_write', { nodes: [{ id: 'a', title: '  ' }] }, agent) as { isError?: boolean; error?: { message: string } }
    expect(blankTitle.isError).toBe(true)
    expect(blankTitle.error?.message).toMatch(/`title` must be a non-empty string/)
    expect(treeOf(ctx, agent)).toBeNull()
  })
})
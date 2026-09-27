/**
 * Does the guard's durable summary actually carry a screenable diagnosis?
 *
 * This is the load-bearing check for screening later: if the summary does not
 * survive, a person reading the session afterwards sees a truncated answer with no
 * explanation, and the guard is indistinguishable from a bug.
 *
 * The stored corpus contains no guard firing — it has never fired in real use —
 * and the only plugin messages it does contain carry no `form`/`summary`, so the
 * exact shape here is unproven in production. The mechanism itself is proven: the
 * corpus holds 89 persisted plugin-sourced `user/message` events, so a
 * plugin-sourced message with a summary is durable by construction. These tests
 * pin the *content* of that evidence.
 *
 * Driven through the real agent loop with the real LLM stream invariant mounted.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Invariants from '@deepseek-ai/dsh-invariants'
import * as LlmInvariant from '@deepseek-ai/dsh-llm/invariant'
import * as StreamGuard from '@t4r71/dsh-stream-guard'
import type { Config } from '@t4r71/dsh-stream-guard'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Invariants)
  await ctx.plugin(LlmInvariant)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(StreamGuard, config)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const d = ctx.on('agent/status', ({ agent: s, status: st }) => {
      if (s === agent && st === 'idle') { d(); resolve() }
    })
  })
}

/** A response that answers, then collapses into a filler run. */
function collapsingResponse(good: string, filler: string[]): StreamChunk[] {
  const text = `${good}\n${filler.join('\n')}\n`
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** The guard's own notices, as (source, joined text) pairs. */
function notices(agent: Agent): { summary: string | undefined; form: string | undefined; text: string }[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind === 'plugin')
    .map((e) => {
      const source = e.data.source as { form?: string; summary?: string }
      return {
        summary: source.summary,
        form: source.form,
        text: e.data.content.map(b => b.type === 'text' ? b.text : '').join(''),
      }
    })
}

describe('durable guard evidence', () => {
  it('records a diagnosis a later reader can screen, not just a bare notice', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      collapsingResponse('Real answer.', ['Let me write it.', 'Writing.', 'Now.', 'Here.', 'Emitting.']),
      textResponse('Recovered.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('durable-1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const all = notices(agent)
    expect(all.length).toBeGreaterThan(0)
    const n = all[0]!
    // The three things a screening reader needs: that this was a guard notice
    // rather than user speech, which rule fired, and what the measurement was.
    expect(n.form).toBe('notice')
    expect(n.summary).toMatch(/^stream-guard: braked (announce|repeat|echo) on (text|reasoning)/)
    // The measurement is the third thing, and it is rule-specific: how many
    // announcements, how many restated lines, or how many recycled lines against
    // how many distinct ones. There is no `kept N chars` any more — nothing is
    // held back, so "kept" would name a quantity that does not exist.
    expect(n.summary).toMatch(/\((\d+ announcements|\d+ lines restated|\d+ lines, \d+ distinct)\)$/)
  })

  it('tells the continuation what to resume from, so the reader sees the anchor', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      collapsingResponse('The answer is 42.', ['Let me write it.', 'Writing.', 'Now.', 'Here.', 'Emitting.']),
      textResponse('Recovered.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('durable-2'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const steered = notices(agent).map(n => n.text).join('\n')
    // Rewritten for the no-holdback design. The old guard buffered a prefix and
    // appended it to the continuation as a resume anchor; nothing is buffered any
    // more, so there is no anchor and the notice must NOT restate the answer. The
    // model reaches the published text through the transcript, which is the whole
    // point of removing the holdback: the answer was already shown to the user.
    expect(steered).not.toContain('The answer is 42.')
    // What the continuation does carry is the plain instruction to resume.
    expect(steered).toContain('Continue from where the text above was cut off.')
  })
})

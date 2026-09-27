import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as IdleGuard from '@t4r71/dsh-idle-guard'
import type { Config } from '@t4r71/dsh-idle-guard'
import { isIdleCompletion } from '../src/index.ts'
import { CJK as CJK_WORDING, LATIN } from '../src/wording.ts'
import { prefersCjk } from '../src/language.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Behavior suite for the turn-completion guard.
 *
 * The claim under test is structural rather than statistical: when a step
 * settles an assistant message that answers nothing and calls nothing, the loop
 * calls the turn complete (`agent-loop/src/agent.ts:488`), and this plugin has to
 * turn that into another step. Driven through a real agent loop against a
 * scripted mock adapter, so the assertion is on the transcript the loop actually
 * produced rather than on the plugin's counters.
 */

/** A response whose only content is a reasoning block. */
function reasoningOnlyResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'reasoning-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'reasoning', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Boot the core spine + the guard; the caller registers adapters. */
async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(IdleGuard, config)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => { const d = ctx.on('agent/status', ({ agent: s, status: st }) => { if (s === agent && st === 'idle') { d(); resolve() } }) })
}

/** Every plugin-sourced user message (the guard's own nudges). */
function nudges(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind === 'plugin')
    .map(e => e.data.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

describe('isIdleCompletion', () => {
  it('treats a reasoning-only message as idle', () => {
    expect(isIdleCompletion([{ type: 'reasoning', text: 'thinking hard' }], 0)).toBe(true)
  })

  it('does not treat a message with visible text as idle', () => {
    expect(isIdleCompletion([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'Here is the answer.' },
    ], 0)).toBe(false)
  })

  it('does not treat a whitespace-only text block as an answer', () => {
    expect(isIdleCompletion([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: '   \n  ' },
    ], 0)).toBe(true)
  })

  it('does not treat a message that calls a tool as idle', () => {
    expect(isIdleCompletion([
      { type: 'reasoning', text: 'thinking' },
      { type: 'tool-call', text: undefined },
    ], 0)).toBe(false)
  })

  it('honours the reasoning length floor', () => {
    expect(isIdleCompletion([{ type: 'reasoning', text: 'short' }], 100)).toBe(false)
    expect(isIdleCompletion([{ type: 'reasoning', text: 'x'.repeat(150) }], 100)).toBe(true)
  })
})

describe('turn-completion guard', () => {
  it('steers a continuation when a turn ends on reasoning alone', async () => {
    // The first response is thinking only, so the loop would call the turn
    // complete; the guard steers, and the second response answers.
    const ctx = await harness()
    const adapter = new MockAdapter([
      reasoningOnlyResponse('I should probably answer this, but let me think about the approach first.'),
      textResponse('Here is the answer.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('idle-1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(nudges(agent)).toHaveLength(1)
    expect(nudges(agent)[0]).toContain('thinking only')
  })

  it('stops nudging once the session budget is spent', async () => {
    // Every response idles, so without a budget the session would be steered
    // forever. `idleBudget: 1` means exactly one nudge.
    const ctx = await harness({ idleBudget: 1 })
    const idle = (): StreamChunk[] => reasoningOnlyResponse('Still thinking about it.')
    const adapter = new MockAdapter([idle(), idle(), idle(), idle(), idle()])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('idle-2'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(nudges(agent)).toHaveLength(1)
  })

  it('stays silent when the turn answers the user', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([textResponse('Done: here is the summary.')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('idle-3'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(nudges(agent)).toHaveLength(0)
  })

  it('does nothing when the guard is disabled', async () => {
    const ctx = await harness({ enabled: false })
    const adapter = new MockAdapter([reasoningOnlyResponse('Only thinking.'), reasoningOnlyResponse('Still.')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('idle-4'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(nudges(agent)).toHaveLength(0)
  })

  it('names itself and its budget in the durable summary', async () => {
    const ctx = await harness({ idleBudget: 3 })
    const adapter = new MockAdapter([reasoningOnlyResponse('Thinking.'), textResponse('ok')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('idle-5'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const source = agent.session.snapshotEvents()
      .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind === 'plugin')
      .map(e => e.data.source)[0]
    expect(source.kind).toBe('plugin')
    expect(source.kind === 'plugin' ? source.plugin : '').toBe('idle-guard')
    expect(source.kind === 'plugin' ? source.summary : '').toContain('reasoning alone')
  })
})

describe('wording', () => {
  it('injects Chinese wording in a Chinese conversation', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([reasoningOnlyResponse('Thinking.'), textResponse('ok')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('idle-zh'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '帮我看看这个问题' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(nudges(agent)[0]).toBe(CJK_WORDING.idle)
  })

  it('keeps Latin wording for a Latin conversation', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([reasoningOnlyResponse('Thinking.'), textResponse('ok')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('idle-en'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'please look into this' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(nudges(agent)[0]).toBe(LATIN.idle)
  })

  it('counts CJK and Latin script separately', () => {
    const cjk = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好世界' }] }]
    const latin = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello world' }] }]
    expect(prefersCjk(cjk as never)).toBe(true)
    expect(prefersCjk(latin as never)).toBe(false)
  })
})

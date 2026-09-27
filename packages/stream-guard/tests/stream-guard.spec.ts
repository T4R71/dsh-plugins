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
import { AnnounceGuard } from '../src/announce.ts'
import { RepeatGuard } from '../src/repeat.ts'
import { EchoGuard } from '../src/echo.ts'
import { textLen } from '../src/text.ts'
import { judgeHesitation } from '../src/hesitation.ts'
import { CJK as CJK_WORDING, LATIN } from '../src/wording.ts'
import { prefersCjk, scriptCounts } from '../src/language.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Behavior suite for the streaming degeneration guard.
 *
 * The load-bearing claims are the ones that cannot be tested at the detector
 * level: that a braked stream is still a **legal** stream, that the brake
 * **steers** the turn instead of severing it, and that a braked reasoning block
 * keeps a replay signature the next request can use. There is no holdback any
 * more, so the guard never retracts text — these tests assert on the *observable*
 * assistant output, the blocks the assembler settles and the deltas the live
 * `assistant-stream` published, rather than on the guard's internal counters.
 *
 * Driven through a real agent loop against a scripted mock adapter (no network).
 */

/**
 * A response that streams `good` and then collapses into filler lines.
 *
 * Written as one delta per character so the guard sees exactly the fragmented
 * input a real provider produces; a single whole-string delta would hide every
 * streaming-boundary bug. The run is newline-terminated on both sides because the guard
 * counts only *terminated* lines — an unterminated line may still grow into real
 * content, so it is deliberately not countable.
 */
function collapsingResponse(good: string, fillerLines: string[], replayState?: unknown): StreamChunk[] {
  const text = `${good}\n${fillerLines.join('\n')}\n`
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    {
      type: 'finish',
      reason: { kind: 'stop' },
      ...replayState === undefined ? {} : { replayState: replayState as never },
    },
  ]
}

/** Every assistant reasoning block settled into the log, in order. */
function settledReasoning(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'assistant/message'> => e.type === 'assistant/message')
    .flatMap(e => e.data.message.content.filter(b => b.type === 'reasoning').map(b => b.text))
}

/**
 * Boot the core spine + the guard; the caller registers adapters.
 *
 * The real LLM stream invariant is mounted, so every chunk the guard emits is
 * checked against the production grammar rather than a hand-rolled copy of it:
 * it registers `{global: true, prepend: true}` (`llm/src/invariant.ts:88`), so it
 * wraps the guard's own output and a violation surfaces as a failed test instead
 * of silently corrupting a transcript.
 */
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
  return new Promise((resolve) => { const d = ctx.on('agent/status', ({ agent: s, status: st }) => { if (s === agent && st === 'idle') { d(); resolve() } }) })
}

/** Every assistant text block settled into the log, in order. */
function settledText(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'assistant/message'> => e.type === 'assistant/message')
    .map(e => e.data.message.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

/** Every delta published live on `agent/assistant-stream`, as one string. */
function publishedText(frames: StreamChunk[]): string {
  return frames
    .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
    .map(chunk => chunk.text)
    .join('')
}

/** Collect the live-published chunks of one turn. */
function recordFrames(ctx: Context, agent: Agent): StreamChunk[] {
  const frames: StreamChunk[] = []
  ctx.on('agent/assistant-stream', (payload) => {
    if (payload.agent !== agent) return
    if (payload.frame.type === 'chunk') frames.push(payload.frame.chunk)
  })
  return frames
}

/** Every plugin-sourced user message (the guard's own nudges). */
function nudges(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind === 'plugin')
    .map(e => e.data.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

describe('announce detection (layer one)', () => {
  // The merged rule is ONE counter over two vocabularies, so these cases assert
  // through the guard rather than through a predicate: `isFiller` no longer
  // exists, and a predicate was never what the plugin did — it counted a *run*.
  // Every distinction the old predicate tests drew is preserved below, restated
  // at the level the guard actually works on.

  it('counts short filler lines and ignores markdown structure', () => {
    // One short clause is not a run, however filler-shaped it looks.
    expect(new AnnounceGuard().feed('Let me write it.\n')).toBeNull()
    const guard = new AnnounceGuard()
    let verdict = null
    for (const line of ['Let me write it.', 'Writing.', 'Now.', 'Here.']) {
      verdict = guard.feed(`${line}\n`) ?? verdict
    }
    expect(verdict).toBeNull()
    verdict = guard.feed('Emitting.\n')
    expect(verdict).not.toBeNull()
    expect(verdict?.count).toBe(5)
  })

  it('never fires on a run of real content, however short each line is', () => {
    // Both shapes the old predicate tests protected: a config path, and a long
    // "let me" sentence that opens like an announcement but keeps going. Repeating
    // them must not manufacture a run.
    const guard = new AnnounceGuard()
    let verdict = null
    for (let i = 0; i < 8; i += 1) {
      verdict = guard.feed('The config lives at M:/dsh.\n') ?? verdict
      verdict = guard.feed('Let me explain why the retry ladder runs before the brake fires here.\n') ?? verdict
    }
    expect(verdict).toBeNull()
  })

  it('recognises Chinese filler, which the reference lexicon could not', () => {
    // The reference lexicon was Latin-only, so a Chinese collapse was never
    // detected at all — the guard was structurally blind to it.
    const guard = new AnnounceGuard()
    let verdict = null
    for (const line of ['让我写一下。', '现在', '写', '输出']) verdict = guard.feed(`${line}\n`) ?? verdict
    expect(verdict).toBeNull()
    verdict = guard.feed('生成\n')
    expect(verdict).not.toBeNull()
    expect(verdict?.count).toBe(5)
  })

  it('does not treat ordinary Chinese discourse as filler', () => {
    // These occur in genuine Chinese prose. Admitting them would trade a silent
    // miss for a false brake, which truncates real output — the worse failure.
    const guard = new AnnounceGuard()
    let verdict = null
    for (let i = 0; i < 10; i += 1) {
      for (const line of ['好的', '那么', '然后', '其实']) {
        verdict = guard.feed(`${line}。\n`) ?? verdict
      }
    }
    expect(verdict).toBeNull()
  })

  it('resets the run when real content intervenes beyond tolerance', () => {
    const guard = new AnnounceGuard()
    guard.feed('Now.\nWriting.\n')
    // A long content line exceeds the benign tolerance and clears the run.
    guard.feed(`${'x'.repeat(200)}\n`)
    let verdict = null
    for (const line of ['Now.', 'Writing.', 'Here.']) verdict = guard.feed(`${line}\n`) ?? verdict
    expect(verdict).toBeNull()
  })
})

describe('hesitation detection', () => {
  it('stays quiet on ordinary prose', () => {
    expect(judgeHesitation('The build succeeded.\nTests passed.\nDone.')).toBeNull()
  })

  it('fires on a churning tail and reports the share', () => {
    const churn = Array.from({ length: 10 }, () => 'Wait, that is wrong.').join('\n')
    const verdict = judgeHesitation(churn)
    expect(verdict).not.toBeNull()
    expect(verdict!.share).toBeGreaterThanOrEqual(0.5)
  })

  it('requires a minimum number of lines before judging', () => {
    expect(judgeHesitation('Hmm.\nWait.\n')).toBeNull()
  })

  /**
   * Every marker the pattern claims to match, driven through the real judge.
   *
   * This exists because the `no,` branch was **unreachable** and nothing caught
   * it: written as `no,` inside a `\b`-anchored group, it could only match when a
   * word character followed the comma, so "No, that fails." — the exact phrase the
   * branch was added for — never matched, while the malformed "no,x" did. The
   * reference implementation carries the same bug
   * (`M:\ds-guard\src\guards\hesitation.rs:37`) and this port inherited it. A
   * per-marker test is what makes a silently dead alternative visible.
   */
  it.each([
    'Hmm.',
    'Wait, that is wrong.',
    'Actually no.',
    'Hold on.',
    'Ugh.',
    'No, that fails.',
    'But wait.',
    '等等，这不对',
    '等一下',
    '慢着',
    '不对',
  ])('counts %j as hesitation', (marker) => {
    // Ten marked lines among eleven: a share well above RATIO, so a null verdict
    // can only mean this marker was not recognised.
    const text = `${marker}\n`.repeat(10) + 'A line of ordinary prose.\n'
    expect(judgeHesitation(text)).not.toBeNull()
  })

  it('never credits a marker inside ordinary prose', () => {
    // The boundary that keeps the lexicon from firing on content: a hesitation
    // *word* only counts as the opening of a short line.
    const prose = 'Now, let us look at the parser and see what it does here.\n'.repeat(10)
    expect(judgeHesitation(prose)).toBeNull()
  })

  it('rejects the malformed no-comma form the old pattern wrongly accepted', () => {
    // The other half of the fix. Moving `no,` out of the `\b` group must not
    // start matching "no,x", which is not English and was the only thing the
    // broken branch ever matched.
    const text = 'no,x\n'.repeat(10) + 'A line of ordinary prose.\n'
    expect(judgeHesitation(text)).toBeNull()
  })
})

describe('stream brake', () => {
  it('publishes the braked run, since nothing is held back', async () => {
    // Rewritten for the no-holdback design. The old guard buffered a filler run
    // and asserted none of it was ever published; the rules now judge text that
    // has already arrived, so the run IS published. That is the visible price of
    // removing the ~1024-character holdback, and what the brake still buys is
    // that the run stops growing and the turn is steered rather than severed.
    const ctx = await harness()
    const adapter = new MockAdapter([
      collapsingResponse('Real work starts here.', ['Let me write it.', 'Writing.', 'Now.', 'Here.', 'Emitting.']),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('brake-1'), { provider: 'mock', model: 'mock' })
    const frames = recordFrames(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const published = publishedText(frames)
    const settled = settledText(agent).join('')

    // The run reached the consumer on both the live stream and the log.
    expect(published).toContain('Writing.')
    expect(settled).toContain('Writing.')
    // The real work before the collapse survives untouched.
    expect(settled).toContain('Real work starts here.')
  })

  it('keeps the stream legal: the real invariant accepts every emitted chunk', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      collapsingResponse('Work.', ['Let me write it.', 'Writing.', 'Now.', 'Here.', 'Emitting.']),
      textResponse('Recovered.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('brake-2'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // The real invariant is mounted, and it throws into the stream on any
    // grammar violation, so a violation would have surfaced as a failed turn.
    expect(agent.status).toBe('idle')
    // Both attempts ran: the braked one and the steered continuation.
    expect(adapter.requests.length).toBe(2)
    expect(settledText(agent).join('')).toContain('Recovered.')
  })

  it('arms the invariant the brake is validated against', async () => {
    // Guards against the previous test passing vacuously: if the invariant were
    // not actually installed, an illegal stream would go through unnoticed.
    const ctx = await harness()
    const adapter = new MockAdapter([[
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'orphan' },
      // No block-end, and a finish while the block is still open: illegal.
      { type: 'finish', reason: { kind: 'stop' } },
    ]])
    ctx.llm.registerAdapter(['mock'], adapter)

    const consume = async (): Promise<void> => {
      for await (const _chunk of ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [] })) { /* drain */ }
    }
    await expect(consume()).rejects.toThrow(/open block/)
  })

  it('steers a continuation so the turn resumes instead of ending severed', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      collapsingResponse('Genuine partial output.', ['Let me write it.', 'Writing.', 'Now.', 'Here.', 'Emitting.']),
      textResponse('The rest of the answer.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('brake-3'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const found = nudges(agent)
    expect(found).toHaveLength(1)
    // The human turn is Latin-scripted, so the nudge must be too.
    expect(found[0]).toContain(LATIN.continue)
    // Rewritten for the no-holdback design. The continuation used to append the
    // kept prefix as a resume anchor; nothing is buffered now, so the prompt is the
    // plain instruction and the notice must NOT restate the output. The model reads
    // the published text from the transcript, which is exactly what removing the
    // holdback means — the text was already shown to the user.
    expect(found[0]).not.toContain('Genuine partial output.')
    // And the resumed output is in the log.
    expect(settledText(agent).join('')).toContain('The rest of the answer.')
  })

  it('preserves token accounting on a braked stream', async () => {
    // The brake rebuilds the terminal frames, so usage is the frame most easily
    // lost: dropping it would silently blank the turn's token counts.
    const ctx = await harness()
    const adapter = new MockAdapter([
      collapsingResponse('Work.', ['Let me write it.', 'Writing.', 'Now.', 'Here.', 'Emitting.']),
      textResponse('Recovered.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('usage-1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const usage = agent.session.snapshotEvents()
      .filter((e): e is SessionEvent<'assistant/message'> => e.type === 'assistant/message')
      .map(e => (e.data as { usage?: { outputTokens?: number } }).usage)
    expect(usage[0]).toBeDefined()
    expect(usage[0]!.outputTokens).toBeGreaterThan(0)
  })

  it('keeps the text signature across a brake, since it carries no text', async () => {
    // A text signature is `{v:1, id}` — id only, measured across the corpus: 3570
    // of them, none carrying any text — so pi-ai takes the block's text and the
    // signature merely names the item (`openai-responses-shared.js:156-161`).
    // Keeping it therefore costs nothing, preserves the item's identity, and
    // measurably leaves the cache prefix readable up to the cut point. The
    // truncated text is what reaches the wire.
    //
    // What must hold either way is that the recovered prefix still reaches the
    // next request: losing it would make the continuation resume from nothing.
    const signature = {
      response: { api: 'openai-responses', provider: 'mock', model: 'mock', stopReason: 'stop' },
      blocks: [{ type: 'text', textSignature: JSON.stringify({ v: 1, id: 'msg_abc' }) }],
    }
    const ctx = await harness()
    const adapter = new MockAdapter([
      collapsingResponse('Genuine partial output.', ['Let me write it.', 'Writing.', 'Now.', 'Here.', 'Emitting.'], signature),
      textResponse('The rest.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('prefix-1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const second = adapter.requests[1]
    expect(second).toBeDefined()
    const assistant = second!.messages.filter(m => m.role === 'assistant')
    expect(assistant).toHaveLength(1)
    // The prefix is present...
    const text = assistant[0]!.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text).join('')
    expect(text).toContain('Genuine partial output.')
    // ...and so is the run that triggered the brake, because nothing is held back.
    // This assertion used to pin the opposite; that it flipped is the point of
    // deleting the holdback, and the signature question is untouched by it because
    // the text signature is id-only either way.
    expect(text).toContain('Emitting.')
    // The envelope survived, and the block count still matches the content: a
    // mismatch would make the adapter reject it and degrade the message instead.
    const kept = (assistant[0]!.source as { replayState?: { blocks?: unknown[] } }).replayState
    expect(kept).toBeDefined()
    expect(kept!.blocks).toHaveLength(1)
  })

  it('keeps the signature when the same stream never brakes', async () => {
    // The control that makes the assertion above meaningful: with the guard off,
    // the identical envelope survives untouched. The old version of this test
    // switched off one rule (`brakeText`); the merge replaced the per-rule switches
    // with the guard-wide `enabled`, and that is what the control needs anyway.
    const signature = {
      response: { api: 'openai-responses', provider: 'mock', model: 'mock', stopReason: 'stop' },
      blocks: [{ type: 'text', textSignature: 'SIG_FOR_THE_FULL_COLLAPSED_TEXT' }],
    }
    const ctx = await harness({ enabled: false })
    const adapter = new MockAdapter([
      collapsingResponse('Genuine partial output.', ['Let me write it.', 'Writing.', 'Now.', 'Here.', 'Emitting.'], signature),
      textResponse('The rest.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('prefix-2'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const settled = agent.session.snapshotEvents()
      .filter((e): e is SessionEvent<'assistant/message'> => e.type === 'assistant/message')
    const withSignature = settled.filter(e => (e.data.message.source as { replayState?: unknown }).replayState !== undefined)
    expect(withSignature).toHaveLength(1)
    expect((withSignature[0]!.data.message.source as { replayState?: unknown }).replayState).toStrictEqual(signature)
  })

  it('degrades to a normal stream when nothing collapses', async () => {
    const ctx = await harness()
    const clean = 'All of this is ordinary prose that no guard should touch.\nSecond line.\nThird line.'
    const adapter = new MockAdapter([textResponse(clean)])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('clean-1'), { provider: 'mock', model: 'mock' })
    const frames = recordFrames(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // Byte-for-byte: an untouched stream must not be re-ordered or truncated,
    // and no spurious continuation is steered.
    expect(publishedText(frames)).toBe(clean)
    expect(settledText(agent)[0]).toBe(clean)
    expect(nudges(agent)).toHaveLength(0)
  })

  it('does not brake when the guard is disabled', async () => {
    // `enabled: false` short-circuits the whole guard, so the stream is passed
    // through untouched. The old version of this test disabled two separate
    // per-rule switches (`brakeText`, `prefixText`); the merge collapsed those
    // into one guard-wide switch, so the old config no longer exists.
    const ctx = await harness({ enabled: false })
    const adapter = new MockAdapter([
      collapsingResponse('Work.', ['Let me write it.', 'Writing.', 'Now.', 'Here.', 'Emitting.']),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('off-1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // Disabled means disabled: the filler is passed through and no brake was
    // recorded, so the turn ended on its own.
    expect(settledText(agent).join('')).toContain('Let me write it.')
    expect(nudges(agent)).toHaveLength(0)
  })

})

describe('continuation budget', () => {
  it('stops steering once the per-turn budget is spent', async () => {
    // Every attempt collapses, so without a cap the turn would be steered
    // forever; maxContinues: 1 means exactly one continuation is issued.
    const ctx = await harness({ maxContinues: 1 })
    const collapse = (): StreamChunk[] => collapsingResponse('Work.', ['Let me write it.', 'Writing.', 'Now.', 'Here.', 'Emitting.'])
    const adapter = new MockAdapter([collapse(), collapse(), collapse(), collapse()])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('budget-1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(nudges(agent)).toHaveLength(1)
  })

  it('keeps steering across turns, since no session-wide cap exists', async () => {
    // The per-turn counter resets on a new turn, and there is deliberately no
    // session budget behind it. A session that keeps collapsing is steered again
    // rather than abandoned: the old hard cap left the guard still braking but
    // never steering, which ended the turn mid-thought with nothing durable in
    // the transcript to explain it.
    const ctx = await harness({ maxContinues: 5 })
    const collapse = (): StreamChunk[] => collapsingResponse('Work.', ['Let me write it.', 'Writing.', 'Now.', 'Here.', 'Emitting.'])
    const adapter = new MockAdapter([collapse(), collapse(), collapse(), collapse()])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('budget-session-1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    // A second turn, so the per-turn counter resets and steering resumes.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // Both turns were steered, and none of them carried the escalation yet.
    expect(nudges(agent).length).toBeGreaterThan(1)
    expect(nudges(agent).every(n => !n.includes('repeated interruption'))).toBe(true)
  })

  it('escalates to warning wording once the threshold is crossed', async () => {
    // Past `warnAfterContinues` the guard still steers — it never gives up — but
    // the prompt stops being the plain instruction. The extra sentence is the
    // only signal the model gets that resuming has already failed repeatedly.
    const ctx = await harness({ maxContinues: 5, warnAfterContinues: 1 })
    const collapse = (): StreamChunk[] => collapsingResponse('Work.', ['Let me write it.', 'Writing.', 'Now.', 'Here.', 'Emitting.'])
    const adapter = new MockAdapter([collapse(), collapse(), collapse(), collapse()])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('budget-warn-1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const all = nudges(agent)
    // The first continuation is plain; later ones carry the escalation.
    expect(all[0]).not.toContain('repeated interruption')
    expect(all.slice(1).some(n => n.includes('repeated interruption'))).toBe(true)
  })
})

describe('hesitation nudge', () => {
  it('injects a request-side nudge on a churning turn and then stops', async () => {
    const churn = Array.from({ length: 10 }, () => 'Wait, that is wrong.').join('\n')
    const ctx = await harness({ hesitationBudget: 1 })
    const adapter = new MockAdapter([textResponse(churn), textResponse('Committed answer.'), textResponse('More.')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('hes-1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const found = nudges(agent)
    expect(found).toHaveLength(1)
    // The human turn is Latin-scripted, so the nudge must be too.
    expect(found[0]).toBe(LATIN.hesitation)
    // It rides the logged channel, so it is durable and model-visible.
    const source = agent.session.snapshotEvents()
      .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind === 'plugin')
      .map(e => e.data.source as { kind: 'plugin'; plugin: string; form: string; summary: string })
    expect(source[0]!.plugin).toBe('stream-guard')
    expect(source[0]!.form).toBe('notice')
    // The summary names the measurement, not just the fact: a person screening the
    // session later can see why the nudge was considered justified.
    expect(source[0]!.summary).toBe('stream-guard: hesitation churn (10/10 lines, share 1.00)')
  })

  it('names the rule, channel and cost in the durable summary', async () => {
    // The summary is the ONLY evidence a person screening a session afterwards can
    // read: `ctx.logger` writes to a 1000-message in-memory ring buffer that no
    // shipped profile persists. A bare "resume after collapse" would leave "why was
    // my answer cut?" unanswerable without reproducing the episode, so the summary
    // must name the rule, the channel, and what was kept.
    const ctx = await harness()
    const adapter = new MockAdapter([
      collapsingResponse('Real answer.', ['Let me write it.', 'Writing.', 'Now.', 'Here.', 'Emitting.']),
      textResponse('Recovered.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('sum-1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const summary = agent.session.snapshotEvents()
      .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind === 'plugin')
      .map(e => (e.data.source as { summary?: string }).summary)[0]
    expect(summary).toBeDefined()
    // Which rule fired, on which channel, and how much of it there was.
    //
    // Rewritten for the no-holdback design. The old summary ended in `kept N
    // chars`, naming what the guard preserved from the cut; nothing is preserved
    // any more, so the closing clause reports the measurement instead. Asserting
    // `kept` now would be asserting a quantity that does not exist.
    expect(summary).toContain('braked announce on text')
    expect(summary).toContain('(5 announcements)')
  })

  it('stays silent on ordinary turns', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([textResponse('Done.\nNothing to see.\nResult: 4.')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('hes-2'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(nudges(agent)).toHaveLength(0)
  })
})

describe('nudge language matches the conversation', () => {
  // A nudge is a user message, so its language is a signal the model reads. An
  // English nudge in a Chinese conversation flips the reply language, and the
  // nudge stays in the transcript, so every later turn inherits the flip.

  it('counts CJK and Latin script separately', () => {
    expect(scriptCounts('你好世界')).toEqual({ cjk: 4, latin: 0 })
    expect(scriptCounts('hello')).toEqual({ cjk: 0, latin: 5 })
    expect(scriptCounts('混合 mixed')).toEqual({ cjk: 2, latin: 5 })
  })

  it('treats a script-free conversation as not CJK', () => {
    // Digits, punctuation, and emoji are not evidence of a language, so the
    // guard keeps the Latin default rather than guessing.
    expect(prefersCjk([{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '12345 ?! 🎉' }] }] as never)).toBe(false)
    expect(prefersCjk([])).toBe(false)
  })

  it('ignores assistant and plugin messages when judging language', () => {
    // Only human turns are evidence: an assistant reply is downstream of the
    // nudge being chosen, and a plugin notice is written by a guard.
    const messages = [
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好，请继续。' }] },
      { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'English reply here.' }] },
      { role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'plugin notice in English' }] },
    ]
    expect(prefersCjk(messages as never)).toBe(true)
  })

  it('injects Chinese wording after a brake in a Chinese conversation', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      collapsingResponse('真实内容。', ['Let me write it.', 'Writing.', 'Now.', 'Here.', 'Emitting.']),
      textResponse('The rest.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('lang-zh'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '请继续完成任务。' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const found = nudges(agent)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain(CJK_WORDING.continue)
    expect(found[0]).not.toContain(LATIN.continue)
  })

  it('injects Chinese hesitation wording in a Chinese conversation', async () => {
    const churn = Array.from({ length: 10 }, () => '等等，这不对。').join('\n')
    const ctx = await harness({ hesitationBudget: 1 })
    const adapter = new MockAdapter([textResponse(churn), textResponse('答案。'), textResponse('More.')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('lang-zh-hes'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '请分析这个问题。' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const found = nudges(agent)
    expect(found).toHaveLength(1)
    expect(found[0]).toBe(CJK_WORDING.hesitation)
  })

  it('keeps Latin wording for a Latin conversation', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      collapsingResponse('Real content.', ['Let me write it.', 'Writing.', 'Now.', 'Here.', 'Emitting.']),
      textResponse('The rest.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('lang-en'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Please continue the task.' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const found = nudges(agent)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain(LATIN.continue)
    expect(found[0]).not.toContain(CJK_WORDING.continue)
  })
})

describe('streams without a session', () => {
  it('leaves a hand-built one-shot call untouched', async () => {
    const ctx = await harness()
    const text = 'A one-shot call with no session id at all.'
    const adapter = new MockAdapter([textResponse(text)])
    ctx.llm.registerAdapter(['mock'], adapter)

    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [] })) chunks.push(chunk)

    expect(publishedText(chunks)).toBe(text)
  })
})

describe('layered detection', () => {
  /**
   * The two layers are complementary, and this block pins that they stay so.
   *
   * Every offset below is **measured** on 1-character deltas with the shipped
   * defaults, not estimated. Layer one is a vocabulary counter: it fires early
   * (12-84 characters) but only on phrases it knows. Layer two's recycling rule
   * is line-based and therefore blind to vocabulary, but it cannot fire until the
   * line count clears `REPEAT_MIN_LINES` — hence the much later offsets.
   */

  /** Feed text one character per delta; report where the first rule fires. */
  function firstFire(text: string): { rule: string | null; by: number } {
    const announce = new AnnounceGuard()
    const repeat = new RepeatGuard()
    const echo = new EchoGuard()
    let seen = 0
    for (const char of Array.from(text)) {
      seen += 1
      let rule: string | null = null
      // Same precedence as the plugin's `judge`: the cross-channel rule first,
      // then recycling, then the vocabulary counter.
      if (echo.feedText(char) !== null) rule = 'echo'
      if (rule === null && repeat.feed(char) !== null) rule = 'repeat'
      if (rule === null) {
        const verdict = announce.feed(char)
        if (verdict !== null) rule = `announce/${verdict.kind}`
      }
      // A real brake stops the stream here, so the first rule to fire owns the
      // channel and the others are no longer reachable.
      if (rule !== null) return { rule, by: seen }
    }
    return { rule: null, by: -1 }
  }

  /** Every shape here is a degeneration a real stream takes, and is caught. */
  const BLEEDS: { name: string; text: string; rule: string; by: number }[] = [
    { name: 'Latin pool the lexicon knows', text: 'Let me write it.\n'.repeat(300), rule: 'announce/intent', by: 84 },
    { name: 'CJK phrase the lexicon knows', text: '让我来写。\n'.repeat(300), rule: 'announce/intent', by: 29 },
    { name: 'Latin pool outside the lexicon', text: 'Pondering the matter.\n'.repeat(300), rule: 'repeat', by: 704 },
    { name: 'CJK pool the lexicon is blind to', text: '好。执行。'.repeat(600), rule: 'announce/filler', by: 12 },
    { name: 'hesitation churn', text: `${Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? 'Hmm.' : 'Wait.')).join('\n')}\n`, rule: 'repeat', by: 176 },
  ]

  /**
   * The measured gaps, kept deliberately.
   *
   * Deleting the character-period rule was the approved tradeoff (PLAN §4.4): it
   * bought zero visible delay and cost single-channel exact-period coverage. What
   * is lost is precisely the loops that **never emit a newline**. Layer two's
   * recycling rule counts *lines*, so a single line repeated forever presents as
   * one line with one distinct label and the fraction never rises; nothing else in
   * either layer looks inside a line for periodicity.
   *
   * These cases assert the gap rather than hiding it, so it cannot regress
   * silently and so the next reader learns it is known rather than rediscovers it
   * as a bug. Closing it means either restoring an intra-line periodicity check or
   * segmenting lines on sentence terminators as well as newlines — the second is
   * the cheaper candidate, and neither has been measured yet.
   */
  const GAPS: { name: string; text: string }[] = [
    { name: 'one long line repeated', text: 'The same long sentence over and over again. '.repeat(400) },
    { name: 'character cycle with no newlines', text: 'abcdefgh'.repeat(600) },
  ]

  it.each(BLEEDS)('catches $name', ({ text, rule, by }) => {
    expect(firstFire(text)).toStrictEqual({ rule, by })
  })

  it.each(GAPS)('misses $name, a documented gap', ({ text }) => {
    // Not an aspiration: this is the honest current behaviour. `by: -1` and a
    // null rule mean no layer fired before the text ran out.
    expect(firstFire(text)).toStrictEqual({ rule: null, by: -1 })
  })

  // Explicit budget for the same reason as the case above: character-by-character
  // streaming dominates, and the default 5s times out under a parallel run.
  it('stays silent on content that is repetitive in shape but not verbatim', { timeout: 30_000 }, () => {
    // The false-positive boundary, and the reason the recycling rule demands exact
    // label equality rather than similarity. Both of these are long and highly
    // repetitive, and neither is a loop.
    const table = `${Array.from({ length: 300 }, (_, i) => `| row ${i} | value ${i * 7} |`).join('\n')}\n`
    const prose = `${Array.from({ length: 200 }, (_, i) => `Paragraph ${i} explaining a distinct point in ordinary language.`).join('\n')}\n`
    expect(firstFire(table)).toStrictEqual({ rule: null, by: -1 })
    expect(firstFire(prose)).toStrictEqual({ rule: null, by: -1 })
  })

  it('is blind to four of the seven bleeds with layer two disabled', () => {
    // The measurement that makes "layered" a claim rather than a label: with only
    // the vocabulary counter, four shapes reach the user entirely unbraked. This is
    // the non-vacuous control for the `it.each` above.
    const missed = [...BLEEDS, ...GAPS].filter(({ text }) => {
      const guard = new AnnounceGuard()
      for (const char of Array.from(text)) if (guard.feed(char) !== null) return false
      return true
    })
    expect(missed.map(m => m.name)).toStrictEqual([
      'Latin pool outside the lexicon',
      'hesitation churn',
      'one long line repeated',
      'character cycle with no newlines',
    ])
  })
})

describe('braked replay signature', () => {
  it('rewrites the reasoning signature so the braked loop is not re-sent', async () => {
    // The load-bearing end-to-end claim of the signature work. pi-ai replays a
    // `thinkingSignature` *verbatim* and ignores the block text
    // (`openai-responses-shared.js:137-141`), so a brake that kept the original
    // signature would put the suppressed loop back on the wire while the
    // transcript claimed otherwise. What must reach the next request is the kept
    // prefix, as a native reasoning item.
    const loop = 'The same thought over and over. '.repeat(40)
    const signature = {
      response: { api: 'openai-responses', provider: 'mock', model: 'mock', stopReason: 'stop' },
      blocks: [{
        type: 'reasoning',
        thinkingSignature: JSON.stringify({
          id: 'item_pinned',
          status: 'completed',
          summary: [{ text: `Real reasoning.\n${loop}`, type: 'summary_text' }],
          type: 'reasoning',
        }),
      }],
    }
    // Intent vocabulary, deliberately. A filler-kind hit is refused on the
    // reasoning channel by default (`brakeReasoning: false`), because truncating
    // reasoning costs the next request its passback state — so a fixture that must
    // brake *reasoning* has to use the vocabulary that is admissible there.
    const period = '让我来写。'
    const text = `Real reasoning.\n${period.repeat(400)}`
    const ctx = await harness()
    const adapter = new MockAdapter([
      [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        ...Array.from(text, (char): StreamChunk => ({ type: 'reasoning-delta', index: 0, text: char })),
        { type: 'block-end', index: 0, block: { type: 'reasoning', text } },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
        { type: 'finish', reason: { kind: 'stop' }, replayState: signature },
      ],
      textResponse('Recovered.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('sig-1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // The turn continued rather than bleeding.
    expect(adapter.requests.length).toBe(2)
    // The loop the brake removed is absent from the settled transcript.
    expect(settledReasoning(agent).join('')).not.toContain(period.repeat(400))

    // The envelope survived with its identity intact, which is only possible if
    // the rewrite produced a shape the adapter's validator accepted.
    const kept = (agent.session.snapshotEvents()
      .filter((e): e is SessionEvent<'assistant/message'> => e.type === 'assistant/message')
      .map(e => (e.data.message.source as { replayState?: { blocks?: { thinkingSignature?: string }[] } }).replayState)
      .find(s => s !== undefined))
    expect(kept).toBeDefined()
    const rewrittenSig = kept!.blocks?.[0]?.thinkingSignature
    expect(rewrittenSig).toBeDefined()
    const parsed = JSON.parse(rewrittenSig!) as { id: string; summary: { text: string }[] }
    expect(parsed.id).toBe('item_pinned')
    // The replayed text is the kept prefix, not the loop.
    expect(parsed.summary[0]!.text).not.toContain(period.repeat(400))
  })

  it('drops the envelope when the signature shape is unrecognised', async () => {
    // The safe half of the same decision. An opaque provider blob cannot be
    // rewritten, so the message must degrade to provider-neutral history rather
    // than replay a signature that contradicts the brake.
    const signature = {
      response: { api: 'openai-responses', provider: 'mock', model: 'mock', stopReason: 'stop' },
      blocks: [{ type: 'reasoning', thinkingSignature: JSON.stringify({ id: 'item_x', encrypted_content: 'BLOB' }) }],
    }
    // Intent vocabulary for the same reason as the case above.
    const period = '让我来写。'
    const text = period.repeat(400)
    const ctx = await harness()
    const adapter = new MockAdapter([
      [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        ...Array.from(text, (char): StreamChunk => ({ type: 'reasoning-delta', index: 0, text: char })),
        { type: 'block-end', index: 0, block: { type: 'reasoning', text } },
        { type: 'finish', reason: { kind: 'stop' }, replayState: signature },
      ],
      textResponse('Recovered.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('sig-2'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const braked = agent.session.snapshotEvents()
      .filter((e): e is SessionEvent<'assistant/message'> => e.type === 'assistant/message')
      .map(e => (e.data.message.source as { replayState?: unknown }).replayState)
      .find(s => s !== undefined)
    expect(braked).toBeUndefined()
  })
})

describe('exports', () => {
  it('exposes the helpers the guard actually applies', () => {
    expect(textLen('  ab  ')).toBe(2)
    // `isFiller` is gone. The merge turned a per-line predicate into a *counted
    // run*, so the observable unit of this module is now the verdict, and that is
    // what an exports test has to reach for.
    const guard = new AnnounceGuard()
    let verdict = null
    for (const line of ['Let me write it.', 'Writing.', 'Now.', 'Here.']) {
      verdict = guard.feed(`${line}\n`) ?? verdict
    }
    expect(verdict).toBeNull()
    expect(guard.feed('Emitting.\n')).not.toBeNull()
  })
})

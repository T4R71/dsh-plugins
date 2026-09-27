import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as StreamGuard from '@t4r71/dsh-stream-guard'
import type { Config } from '@t4r71/dsh-stream-guard'
import { LATIN } from '../src/wording.ts'

/**
 * Branch-level suite for the plugin itself (`src/index.ts`).
 *
 * The behaviour suite (`stream-guard.spec.ts`) drives the guard through a real
 * agent loop, which is the right level for the claims that need a transcript and
 * a settled assistant message. This suite instead dispatches the two hooks the
 * plugin registers **directly**: the `llm/stream` waterfall is handed a scripted
 * chunk sequence, and `agent/turn-stopping` is handed a stub agent whose
 * transcript the test controls. That is what makes the structural branches
 * reachable — a half-open tool call, an empty delta, a block with no published
 * text, the terminal frames a brake rebuilds — without scripting them through a
 * provider.
 *
 * What is deliberately NOT mocked away: the plugin's own `apply()`, its real
 * config resolution, and the real detector objects it constructs. A `?? default`
 * test that resolved the config through schemastery would prove nothing, so the
 * defaults below are reached by calling `apply` the way a direct caller does.
 */

/** Chunk kinds the fixtures need, spelled once so the streams read as scripts. */
function blockStart(index: number, blockType: 'text' | 'reasoning' | 'tool-call' | 'tool-result'): StreamChunk {
  return { type: 'block-start', index, blockType }
}

/** One delta on the channel the block belongs to. */
function delta(index: number, text: string, channel: 'text' | 'reasoning' = 'text'): StreamChunk {
  return channel === 'text'
    ? { type: 'text-delta', index, text }
    : { type: 'reasoning-delta', index, text }
}

/** The terminal frame every fixture ends on. */
function finishStop(): StreamChunk {
  return { type: 'finish', reason: { kind: 'stop' } }
}

/** A complete text turn: one block, one delta, a close and the terminal frames. */
function textTurn(text: string, index = 0): StreamChunk[] {
  return [
    blockStart(index, 'text'),
    delta(index, text),
    { type: 'block-end', index, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 7 } },
    finishStop(),
  ]
}

/** Five clauses, the first an intent opening: the shortest run the default counter proves. */
const FILLER_RUN = 'Let me write it.\nWriting.\nNow.\nHere.\nEmitting.\n'

/** Five bare filler clauses: the run the reasoning channel refuses without `brakeReasoning`. */
const FILLER_ONLY = 'Writing.\nNow.\nHere.\nOK.\nEmitting.\n'

/** Eight distinct lines, replayed verbatim on the other channel to prove an echo. */
const ECHO_LINES = [
  'The first line of the trace.',
  'The second line of the trace.',
  'The third line of the trace.',
  'The fourth line of the trace.',
  'The fifth line of the trace.',
  'The sixth line of the trace.',
  'The seventh line of the trace.',
  'The eighth line of the trace.',
].join('\n')

/** The minimum recycling sample: 32 identical lines score a rate of 32. */
const LOOP_LINES = Array.from({ length: 32 }, () => 'the same recycled line').join('\n')

/** Ten self-corrections: the churn `judgeHesitation` proves at share 1.00. */
const CHURN = Array.from({ length: 10 }, () => 'Wait, that is wrong.').join('\n')

/**
 * A context carrying only the guard, applied the way a direct caller applies it.
 *
 * No loader, no schemastery: every field the caller omits exercises the plugin's
 * own `??` fallback rather than the schema's default.
 */
function newContext(config: Config = {}): Context {
  const ctx = new Context()
  StreamGuard.apply(ctx, config)
  return ctx
}

/** Run one scripted upstream through the plugin's own `llm/stream` hook. */
async function drive(ctx: Context, chunks: StreamChunk[], id: string): Promise<StreamChunk[]> {
  const upstream = (async function* (): AsyncIterable<StreamChunk> {
    for (const chunk of chunks) yield chunk
  })()
  const options = { provider: 'mock', model: 'mock', messages: [], sessionId: SessionId(id) }
  const stream = ctx.waterfall('llm/stream', options as never, (() => upstream) as never)
  const emitted: StreamChunk[] = []
  for await (const chunk of stream) emitted.push(chunk)
  return emitted
}

/**
 * Whether the guard replaced the upstream terminal frame.
 *
 * A braked stream is terminated by frames the guard builds itself, so the last
 * emitted chunk is no longer the upstream object; an untouched stream forwards
 * the upstream `finish` by identity.
 */
function braked(emitted: readonly StreamChunk[], upstream: readonly StreamChunk[]): boolean {
  return emitted[emitted.length - 1] !== upstream[upstream.length - 1]
}

/** Every published text delta of one run, as one string. */
function published(emitted: readonly StreamChunk[]): string {
  return emitted
    .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
    .map(chunk => chunk.text)
    .join('')
}

/** Capture `ctx.logger.info` so the verbose diagnostics can be asserted verbatim. */
function captureLogs(ctx: Context): unknown[][] {
  const calls: unknown[][] = []
  ctx.logger.info = ((...args: unknown[]) => { calls.push(args) }) as typeof ctx.logger.info
  return calls
}

/** A transcript the test owns, plus the steers the guard issued against it. */
interface StubAgent {
  agent: Agent
  steered: { text: string; summary: string }[]
}

/**
 * A stub standing in for a live agent at the turn boundary.
 *
 * Only the three faces the hook reads are real: the session id (the budget key),
 * `deriveMessages()` (the transcript the hesitation rule judges) and `steer()`
 * (where a continuation or nudge lands).
 */
function stubAgent(id: string, messages: Message[]): StubAgent {
  const steered: { text: string; summary: string }[] = []
  const agent = {
    session: {
      id: SessionId(id),
      deriveMessages: (): Message[] => messages,
    },
    steer: (message: { content: Message['content']; source: Message['source'] }): void => {
      const source = message.source
      steered.push({
        text: message.content.map(part => (part.type === 'text' ? part.text : '')).join(''),
        summary: source.kind === 'plugin' && source.form === 'notice' ? source.summary : '',
      })
    },
  }
  return { agent: agent as unknown as Agent, steered }
}

/** Dispatch the turn boundary the way the loop does. */
async function stopTurn(ctx: Context, stub: StubAgent, turn: number): Promise<void> {
  await ctx.serial('agent/turn-stopping', {
    agent: stub.agent,
    turn,
    signal: new AbortController().signal,
  })
}

/** One assistant message with exactly the content parts given. */
function assistantMessage(id: string, content: Message['content']): Message {
  return { id, role: 'assistant', content, source: { kind: 'model' } } as unknown as Message
}

/** One human message, the only role that counts as language evidence. */
function userMessage(text: string): Message {
  return { id: 'u1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } as unknown as Message
}

/** Reasoning replayed verbatim as the visible answer: what the echo rule exists for. */
function echoStream(): StreamChunk[] {
  const trace = `${ECHO_LINES}\n`
  return [
    blockStart(0, 'reasoning'),
    delta(0, trace, 'reasoning'),
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: trace } },
    blockStart(1, 'text'),
    delta(1, trace),
    finishStop(),
  ]
}

/** A channel recycling one line: what the repeat rule exists for. */
function loopStream(): StreamChunk[] {
  return [blockStart(0, 'text'), delta(0, `${LOOP_LINES}\n`), finishStop()]
}

describe('resolved configuration', () => {
  it('resolves every omitted field instead of reading undefined', async () => {
    // A direct caller may omit all eleven fields. The resolved defaults must
    // still be the shipped ones: the fifth filler clause is what proves the run.
    const ctx = newContext()
    const calls = captureLogs(ctx)
    const upstream = textTurn(FILLER_RUN)
    const emitted = await drive(ctx, upstream, 'defaults-1')

    expect(braked(emitted, upstream)).toBe(true)
    // `verbose` defaults to false, so a working guard stays silent.
    expect(calls).toHaveLength(0)

    // The resolved count is load-bearing rather than incidental: asking for one
    // more announcement leaves the identical five-clause run unproven.
    const strict = newContext({ announceCount: 6 })
    const strictUpstream = textTurn(FILLER_RUN)
    expect(braked(await drive(strict, strictUpstream, 'defaults-2'), strictUpstream)).toBe(false)
  })

  it('logs the rule and its measurement, one format per brake kind', async () => {
    const ctx = newContext({ verbose: true })
    const calls = captureLogs(ctx)
    await drive(ctx, textTurn(FILLER_RUN), 'log-announce')
    await drive(ctx, echoStream(), 'log-echo')
    await drive(ctx, loopStream(), 'log-repeat')

    expect(calls).toContainEqual(['[stream-guard]', 'brake', 'text', 'rule', 'announce', '5 hits, last "Emitting"'])
    expect(calls).toContainEqual(['[stream-guard]', 'brake', 'text', 'rule', 'echo', '8 lines restated'])
    expect(calls).toContainEqual(['[stream-guard]', 'brake', 'text', 'rule', 'repeat', '32 lines, 1 distinct'])
  })
})

describe('delta publishing', () => {
  it('drops an empty delta instead of publishing it', async () => {
    // A provider that emits a zero-length delta must not produce a zero-length
    // frame downstream, and must not disturb the text already published.
    const ctx = newContext()
    const upstream: StreamChunk[] = [
      blockStart(0, 'text'),
      { type: 'text-delta', index: 0, text: '' },
      delta(0, 'Real content.\n'),
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Real content.\n' } },
      finishStop(),
    ]
    const emitted = await drive(ctx, upstream, 'empty-delta')

    const deltas = emitted.filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0]?.text).toBe('Real content.\n')
    expect(braked(emitted, upstream)).toBe(false)
  })

  it('forwards a chunk kind the guard does not read', async () => {
    // A tool-call delta reaches the guard's final fall-through, which passes it
    // through by identity: the guard is a text/reasoning rule, not a filter.
    const ctx = newContext()
    const toolDelta: StreamChunk = { type: 'tool-call-delta', index: 0, id: 'call-1' as never, name: 'read', argumentsDelta: '{}' }
    const upstream: StreamChunk[] = [
      blockStart(0, 'tool-call'),
      toolDelta,
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1' as never, name: 'read', arguments: '{}' } },
      finishStop(),
    ]
    const emitted = await drive(ctx, upstream, 'tool-delta')

    expect(emitted).toContain(toolDelta)
    expect(braked(emitted, upstream)).toBe(false)
  })
})

describe('deferring a brake', () => {
  it('defers every rule while a non-text block is open', async () => {
    // A half-open tool call and a typed-but-unknown block both make truncation
    // unsafe: the assembler would corrupt the step rather than shorten it. The
    // rules are monotone, so the verdict is simply re-offered once it closes.
    const ctx = newContext()
    const upstream: StreamChunk[] = [
      blockStart(0, 'tool-call'),
      blockStart(1, 'tool-result'),
      delta(0, FILLER_RUN),
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1' as never, name: 'read', arguments: '{}' } },
      { type: 'block-end', index: 1, block: { type: 'tool-result', toolCallId: 'call-1' as never, content: [] } },
      finishStop(),
    ]
    const emitted = await drive(ctx, upstream, 'blocking-1')

    // The whole filler run reached the consumer: a blocked rule never brakes.
    expect(published(emitted)).toBe(FILLER_RUN)
    expect(braked(emitted, upstream)).toBe(false)
  })

  it('refuses a filler-kind announcement on the reasoning channel by default', async () => {
    // Truncating reasoning costs the next request its passback state, so the
    // filler vocabulary alone is not admissible there — the run is real, the
    // remedy is not. `brakeReasoning` is what admits it.
    const reasoningFiller = (): StreamChunk[] => [
      blockStart(0, 'reasoning'),
      delta(0, FILLER_ONLY, 'reasoning'),
      finishStop(),
    ]
    const refusedCtx = newContext()
    const refusedUpstream = reasoningFiller()
    const refused = await drive(refusedCtx, refusedUpstream, 'reasoning-filler-refused')
    expect(braked(refused, refusedUpstream)).toBe(false)

    const admittedCtx = newContext({ brakeReasoning: true })
    const admittedUpstream = reasoningFiller()
    const admitted = await drive(admittedCtx, admittedUpstream, 'reasoning-filler-admitted')
    expect(braked(admitted, admittedUpstream)).toBe(true)
  })
})

describe('brake termination', () => {
  it('closes every open block, in index order, from its published text', async () => {
    // The reasoning block was opened and never written to, so the brake must
    // close it with the empty text the consumer actually received — the
    // assembler treats a block-end payload as authoritative.
    const ctx = newContext()
    const upstream: StreamChunk[] = [
      blockStart(0, 'reasoning'),
      blockStart(1, 'text'),
      delta(1, FILLER_RUN),
      finishStop(),
    ]
    const emitted = await drive(ctx, upstream, 'open-blocks-1')

    const closes = emitted.filter((chunk): chunk is Extract<StreamChunk, { type: 'block-end' }> => chunk.type === 'block-end')
    expect(closes.map(chunk => chunk.index)).toStrictEqual([0, 1])
    expect(closes[0]?.block).toStrictEqual({ type: 'reasoning', text: '' })
    expect(closes[1]?.block).toStrictEqual({ type: 'text', text: FILLER_RUN })
    expect(braked(emitted, upstream)).toBe(true)
  })

  it('brakes a verbatim restatement and still publishes the delta that proved it', async () => {
    const ctx = newContext()
    const upstream = echoStream()
    const emitted = await drive(ctx, upstream, 'echo-1')

    expect(published(emitted)).toBe(`${ECHO_LINES}\n`)
    expect(braked(emitted, upstream)).toBe(true)
  })

  it('brakes a channel recycling its own lines', async () => {
    const ctx = newContext()
    const upstream = loopStream()
    const emitted = await drive(ctx, upstream, 'repeat-1')

    expect(braked(emitted, upstream)).toBe(true)
  })
})

describe('continuation summaries', () => {
  it('names the echo rule and its measurement', async () => {
    const ctx = newContext()
    await drive(ctx, echoStream(), 'summary-echo')
    const stub = stubAgent('summary-echo', [])
    await stopTurn(ctx, stub, 1)

    expect(stub.steered).toHaveLength(1)
    expect(stub.steered[0]?.summary).toBe('stream-guard: braked echo on text (8 lines restated)')
  })

  it('names the repeat rule and its measurement', async () => {
    const ctx = newContext()
    await drive(ctx, loopStream(), 'summary-repeat')
    const stub = stubAgent('summary-repeat', [])
    await stopTurn(ctx, stub, 1)

    expect(stub.steered).toHaveLength(1)
    expect(stub.steered[0]?.summary).toBe('stream-guard: braked repeat on text (32 lines, 1 distinct)')
  })
})

describe('hesitation nudge branches', () => {
  it('honours the switch that turns the nudge off', async () => {
    const ctx = newContext({ hesitationNudge: false })
    const stub = stubAgent('hes-off', [assistantMessage('a1', [{ type: 'text', text: CHURN }])])
    await stopTurn(ctx, stub, 1)

    expect(stub.steered).toHaveLength(0)
  })

  it('has nothing to judge without a trailing assistant message', async () => {
    const ctx = newContext()
    const empty = stubAgent('hes-empty', [])
    await stopTurn(ctx, empty, 1)
    const userLast = stubAgent('hes-user', [userMessage('hello')])
    await stopTurn(ctx, userLast, 1)

    expect(empty.steered).toHaveLength(0)
    expect(userLast.steered).toHaveLength(0)
  })

  it('judges only the text parts of the trailing assistant message', async () => {
    // The reasoning part contributes nothing to the judged text: churn is a
    // property of what the model said, not of what it thought.
    const ctx = newContext()
    const stub = stubAgent('hes-parts', [
      assistantMessage('a1', [
        { type: 'reasoning', text: CHURN },
        { type: 'text', text: CHURN },
      ]),
    ])
    await stopTurn(ctx, stub, 1)

    expect(stub.steered).toHaveLength(1)
    expect(stub.steered[0]?.text).toBe(LATIN.hesitation)
    expect(stub.steered[0]?.summary).toBe('stream-guard: hesitation churn (10/10 lines, share 1.00)')
  })

  it('nudges one churning transcript once', async () => {
    // Without the transcript dedup the nudge's own turn is judged again and
    // nudged again — the 61-request feedback loop the reference hit. The budget
    // is left at its default, so the second boundary must be refused by the
    // dedup rather than the cap (and a default of 0 would fail this test).
    const ctx = newContext()
    const stub = stubAgent('hes-once', [assistantMessage('a1', [{ type: 'text', text: CHURN }])])
    await stopTurn(ctx, stub, 1)
    await stopTurn(ctx, stub, 1)

    expect(stub.steered).toHaveLength(1)
  })
})

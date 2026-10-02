/**
 * Guard unit tests.
 *
 * The merge's whole point is the arbitration, so the tests that matter are the
 * ones that drive two rules into the same turn boundary and assert that exactly
 * one message came out. Everything here runs against a hand-built context: no
 * cordis, no agent loop, no network.
 *
 * @module @t4r71/dsh-guard/tests
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../src/index.ts'
import { isIdleCompletion, isEmptyCompletion } from '../src/idle.ts'
import { DEFAULT_RETRY_POLICY, RetryLedger } from '../src/retry.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

type Listener = (payload: any, next?: any) => unknown

/**
 * Brand a readable literal as a session key.
 *
 * The 0.2.0 session API brands `SessionId`, so `RetryLedger`'s methods no longer
 * accept a plain string; the tests keep naming their sessions `'s'` / `'other'`
 * and pay the brand here, once, at the type level only.
 */
const sid = (id: string): SessionId => id as SessionId

/** The listener `apply()` registered on the `agent/request-error` waterfall. */
function requestErrorListener(listeners: Map<string, Listener[]>): Listener {
  const fn = (listeners.get('agent/request-error') ?? [])[0]
  assert.ok(fn, 'apply() registers an agent/request-error listener')
  return fn
}

/** A context that records listeners instead of dispatching them. */
function makeContext(): { ctx: any; listeners: Map<string, Listener[]> } {
  const listeners = new Map<string, Listener[]>()
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on(name: string, fn: Listener) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {}
    },
  }
  return { ctx, listeners }
}

/** One assistant message carrying the given content blocks. */
function assistant(id: string, content: any[]): any {
  return { id, role: 'assistant', content }
}

interface Harness {
  steers: any[]
  fireTurnStopping: (turn: number, messages: any[]) => Promise<void>
  driveStream: (chunks: any[]) => Promise<any[]>
}

function harness(config: Record<string, unknown> = {}): Harness {
  const { ctx, listeners } = makeContext()
  apply(ctx, config as any)
  let current: any[] = []
  const steers: any[] = []
  const session = { id: 'session-1', deriveMessages: () => current }
  const agent = { session, steer: (message: any) => { steers.push(message) } }
  return {
    steers,
    async fireTurnStopping(turn: number, messages: any[]) {
      current = messages
      for (const fn of listeners.get('agent/turn-stopping') ?? []) {
        await fn({ agent, turn, signal: new AbortController().signal }, undefined)
      }
    },
    async driveStream(chunks: any[]) {
      const out: any[] = []
      for (const fn of listeners.get('llm/stream') ?? []) {
        const upstream = async function* () { for (const chunk of chunks) yield chunk }
        const stream = fn({ sessionId: 'session-1' }, () => upstream()) as AsyncIterable<any>
        for await (const chunk of stream) out.push(chunk)
      }
      return out
    },
  }
}

/** The delta sequence that makes the announcement rule fire on its fifth hit. */
function degenerateChunks(): any[] {
  const chunks: any[] = [{ type: 'block-start', index: 0, blockType: 'text' }]
  for (let i = 0; i < 40; i++) chunks.push({ type: 'text-delta', index: 0, text: 'Let me check. ' })
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  return chunks
}

test('isIdleCompletion: the default minReasoningChars is not a threshold', () => {
  assert.equal(isIdleCompletion([{ type: 'reasoning', text: 'x' }], 0), true)
  // An empty message is also "idle" under the source rule, which is exactly why
  // the arbitration consults isEmptyCompletion first.
  assert.equal(isIdleCompletion([], 0), true)
  assert.equal(isIdleCompletion([{ type: 'reasoning', text: 'x' }], 1), true)
  assert.equal(isIdleCompletion([{ type: 'reasoning', text: '' }], 1), false)
  assert.equal(isIdleCompletion([{ type: 'text', text: 'answer' }], 0), false)
  assert.equal(isIdleCompletion([{ type: 'tool-call' }], 0), false)
  assert.equal(isIdleCompletion([{ type: 'text', text: '   ' }], 0), true)
})

test('isEmptyCompletion only matches a message with no blocks at all', () => {
  assert.equal(isEmptyCompletion([]), true)
  // Bound to variables first: the parameter's minimal shape is `{ type }`, so a
  // fresh literal carrying `text` is rejected by excess-property checking even
  // though that is exactly the block the rule has to look at.
  const reasoningOnly = [{ type: 'reasoning', text: 'thought' }]
  const emptyText = [{ type: 'text', text: '' }]
  assert.equal(isEmptyCompletion(reasoningOnly), false)
  assert.equal(isEmptyCompletion(emptyText), false)
})

test('RetryLedger: one budget, both tiers, bounded', () => {
  const ledger = new RetryLedger({ ...DEFAULT_RETRY_POLICY, codes: ['SERVER'], maxRetries: 2, delayMs: 7 })
  const declined = ledger.decideRequestFailure(sid('s'), 'TRANSPORT')
  assert.equal(declined.kind, 'decline')
  assert.match(declined.kind === 'decline' ? declined.reason : '', /TRANSPORT/)
  assert.deepEqual(ledger.decideRequestFailure(sid('s'), 'SERVER'), { kind: 'retry', attempt: 1, delayMs: 7 })
  ledger.spend(sid('s'))
  assert.deepEqual(ledger.decideTurnRecovery(sid('s'), 'empty'), { kind: 'retry', attempt: 2, delayMs: 7 })
  ledger.spend(sid('s'))
  assert.equal(ledger.decideRequestFailure(sid('s'), 'SERVER').kind, 'decline')
  assert.equal(ledger.decideTurnRecovery(sid('s'), 'degenerate').kind, 'decline')
  // A different session has its own budget.
  assert.equal(ledger.decideRequestFailure(sid('other'), 'SERVER').kind, 'retry')
})

test('RetryLedger: switches decline without spending', () => {
  const off = new RetryLedger({ ...DEFAULT_RETRY_POLICY, enabled: false })
  assert.equal(off.decideRequestFailure(sid('s'), 'PI_AI_ERROR').kind, 'decline')
  const noEmpty = new RetryLedger({ ...DEFAULT_RETRY_POLICY, onEmptyResponse: false })
  assert.equal(noEmpty.decideTurnRecovery(sid('s'), 'empty').kind, 'decline')
  assert.equal(noEmpty.decideTurnRecovery(sid('s'), 'degenerate').kind, 'retry')
})

test('the brake fires and steers one continuation per boundary', async () => {
  const h = harness()
  const out = await h.driveStream(degenerateChunks())
  assert.equal(out.filter((c) => c.type === 'finish').length, 1)
  assert.equal(out.at(-1).reason.kind, 'stop')
  const published = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(published, 'Let me check. '.repeat(5))

  const idle = [assistant('a-1', [{ type: 'reasoning', text: 'thought' }])]
  await h.fireTurnStopping(1, idle)
  assert.equal(h.steers.length, 1)
  assert.match(h.steers[0].source.summary, /braked announce on text/)

  // Same boundary again: the token has not changed, so nothing is injected.
  await h.fireTurnStopping(1, idle)
  assert.equal(h.steers.length, 1)

  // A new assistant message means a new boundary, and the per-turn allowance
  // still has room, so the second continuation is steered.
  await h.driveStream(degenerateChunks())
  await h.fireTurnStopping(1, [assistant('a-2', [{ type: 'reasoning', text: 'thought' }])])
  assert.equal(h.steers.length, 2)
})

test('one boundary, one injection: the brake wins over the idle rule', async () => {
  const h = harness()
  await h.driveStream(degenerateChunks())
  await h.fireTurnStopping(1, [assistant('a-1', [{ type: 'reasoning', text: 'thought' }])])
  assert.equal(h.steers.length, 1)
  assert.match(h.steers[0].content[0].text, /Continue from where the text above was cut off/)
  assert.doesNotMatch(h.steers[0].content[0].text, /thinking only/)
})

test('the idle rule fires on its own and stops at idleBudget', async () => {
  const h = harness()
  for (let i = 1; i <= 4; i++) {
    await h.fireTurnStopping(1, [assistant('a-' + i, [{ type: 'reasoning', text: 'thought' }])])
  }
  assert.equal(h.steers.length, 3)
  h.steers.forEach((message, index) => {
    assert.match(message.content[0].text, /thinking only/)
    assert.match(message.source.summary, new RegExp('\\(' + (index + 1) + '/3\\)'))
  })
})

test('an empty completion takes the retry tier, not the idle wording', async () => {
  const h = harness({ retryDelayMs: 0 })
  await h.fireTurnStopping(1, [assistant('a-1', [])])
  assert.equal(h.steers.length, 1)
  assert.match(h.steers[0].content[0].text, /came back empty/)
  assert.match(h.steers[0].source.summary, /empty response \(1\/3\)/)
})

test('retryEnabled=false leaves the request-error waterfall to the shipped policy', async () => {
  const { ctx, listeners } = makeContext()
  apply(ctx, { retryEnabled: false } as any)
  const fn = requestErrorListener(listeners)
  let called = 0
  const result = await fn(
    { agent: { session: { id: 's' } }, failure: { code: 'PI_AI_ERROR' }, signal: new AbortController().signal },
    async () => { called += 1; return undefined },
  )
  assert.equal(called, 1)
  assert.equal(result, undefined)
})

test('the request-error tier defers when downstream already retries', async () => {
  const { ctx, listeners } = makeContext()
  apply(ctx, { retryDelayMs: 0, retryCodes: ['PI_AI_ERROR'] } as any)
  const fn = requestErrorListener(listeners)
  const result = await fn(
    { agent: { session: { id: 's' } }, failure: { code: 'PI_AI_ERROR' }, signal: new AbortController().signal },
    async () => ({ kind: 'retry' }),
  )
  assert.deepEqual(result, { kind: 'retry' })
})

test('the request-error tier retries what downstream declined, within its cap', async () => {
  const { ctx, listeners } = makeContext()
  apply(ctx, { retryDelayMs: 0, retryCodes: ['PI_AI_ERROR'], retryMax: 2 } as any)
  const fn = requestErrorListener(listeners)
  const call = () => fn(
    { agent: { session: { id: 's' } }, failure: { code: 'PI_AI_ERROR' }, signal: new AbortController().signal },
    async () => undefined,
  )
  assert.deepEqual(await call(), { kind: 'retry' })
  assert.deepEqual(await call(), { kind: 'retry' })
  assert.equal(await call(), undefined)
})

test('an aborted turn is never retried', async () => {
  const { ctx, listeners } = makeContext()
  apply(ctx, { retryDelayMs: 60000, retryCodes: ['PI_AI_ERROR'] } as any)
  const fn = requestErrorListener(listeners)
  const controller = new AbortController()
  controller.abort()
  const result = await fn(
    { agent: { session: { id: 's' } }, failure: { code: 'PI_AI_ERROR' }, signal: controller.signal },
    async () => undefined,
  )
  assert.equal(result, undefined)
})

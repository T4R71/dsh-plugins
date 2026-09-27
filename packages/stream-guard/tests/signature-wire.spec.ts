import { describe, expect, it } from 'vitest'
import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
import { rewriteReasoningSignature } from '../src/signature.ts'

/**
 * Wire-level suite for the reasoning-signature rewrite.
 *
 * The guard's own suite drives a mock adapter, which never reaches pi-ai — so it
 * can prove the envelope was rebuilt but *not* what the rewrite becomes on the
 * request. That is the claim this file exists to nail down, because the two
 * possible outcomes are not close: pi-ai replays a `thinkingSignature` verbatim
 * and ignores the block's own text (`openai-responses-shared.js:137-141`), so a
 * signature left alone puts the entire braked loop back on the wire while the
 * transcript claims it was removed.
 *
 * Driven against the real converter, so a pi-ai upgrade that changes the
 * replay rule fails here instead of silently re-enabling the loop.
 */

/** The signature shape this provider mints — 1983/1983 observed signatures match it. */
function liveSignature(text: string): string {
  return JSON.stringify({
    id: 'item_pinned',
    status: 'completed',
    summary: [{ text, type: 'summary_text' }],
    type: 'reasoning',
  })
}

const LOOP = 'The same thought over and over. '
const KEPT = 'Real reasoning line.'
const FULL = `Real reasoning line.\n${LOOP.repeat(40)}`

/** A pi-ai assistant message carrying one thinking block. */
function thinkingMessage(signature?: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{
      type: 'thinking',
      thinking: KEPT,
      ...signature === undefined ? {} : { thinkingSignature: signature },
    }],
    api: 'openai-responses',
    provider: 'mock',
    model: 'mock',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
  }
}

const MODEL: Model<string> = {
  id: 'mock',
  name: 'mock',
  provider: 'mock',
  api: 'openai-responses',
  baseUrl: 'https://example.invalid',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1,
  maxTokens: 1,
}

/** Convert one assistant message to the request items pi-ai would send. */
function wire(signature?: string): string {
  return JSON.stringify(
    convertResponsesMessages(
      MODEL,
      { messages: [thinkingMessage(signature)] },
      new Set(['mock']),
    ),
  )
}

describe('reasoning signature on the wire', () => {
  it('re-sends the whole loop when the original signature is carried', () => {
    // The failure mode this whole module exists to prevent, measured rather than
    // asserted from the docs. If this test ever starts failing because the loop is
    // absent, pi-ai's replay rule changed and `signature.ts` can be simplified.
    const sent = wire(liveSignature(FULL))
    expect(sent).toContain('"reasoning"')
    expect(sent).toContain(LOOP.trim())
  })

  it('sends the kept prefix, with no loop, for a rewritten signature', () => {
    const rewritten = rewriteReasoningSignature(liveSignature(FULL), KEPT)
    expect(rewritten).toBeDefined()
    const sent = wire(rewritten)

    // A native reasoning item survives: it is not merely dropped.
    expect(sent).toContain('"reasoning"')
    expect(sent).toContain(KEPT)
    // And the loop the brake removed is genuinely gone from the request.
    expect(sent).not.toContain(LOOP.trim())
    // Identity is preserved, which keeps tool-call/reasoning pairing valid.
    expect(sent).toContain('item_pinned')
  })

  it('sends nothing at all when the signature is dropped', () => {
    // The control that makes the rewrite worth having: without a signature the
    // reasoning item disappears entirely, so the cache breaks at the item start
    // rather than at the cut point.
    expect(wire(undefined)).toBe('[]')
  })
})

import { describe, expect, it } from 'vitest'
import {
  classifySignature,
  rebuildBrakedEnvelope,
  rewriteReasoningSignature,
} from '../src/signature.ts'

/**
 * Unit suite for the reasoning-signature rewrite.
 *
 * The module exists because a provider's reasoning signature is replayed
 * *verbatim* (`pi-ai/dist/api/openai-responses-shared.js:137-141`), so a brake
 * that kept the original signature would put the suppressed loop back on the
 * wire. These tests pin the two things that make the rewrite safe: it fires only
 * on a shape this build fully understands, and it changes nothing but the text.
 */

/** A signature shaped exactly as the live provider mints it. */
function liveSignature(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'item_7be51c54bd35ba6c74d1bcdd',
    status: 'completed',
    summary: [{ text, type: 'summary_text' }],
    type: 'reasoning',
    ...extra,
  })
}

describe('signature classification', () => {
  it('accepts the exact shape the live provider mints', () => {
    expect(classifySignature(liveSignature('Reasoning.'))).toBe('rewritable')
  })

  it('treats a missing signature as absent, not unknown', () => {
    // The distinction matters at the call site: `absent` means there is nothing
    // to contradict the brake, while `unknown` means the message must degrade.
    expect(classifySignature(undefined)).toBe('absent')
    expect(classifySignature(null)).toBe('absent')
  })

  it('refuses a signature carrying an opaque provider blob', () => {
    // With `encrypted_content` present the provider's own text would win over a
    // rewritten summary, so the rewrite would be a silent no-op that still
    // shipped the loop. This provider never sends it — 0 of 1983 — but a
    // different gateway could.
    expect(classifySignature(liveSignature('x', { encrypted_content: 'BLOB' }))).toBe('opaque')
    expect(classifySignature(liveSignature('x', { content: [{ text: 'x' }] }))).toBe('opaque')
  })

  it('refuses shapes it does not recognise rather than guessing', () => {
    expect(classifySignature('not json')).toBe('unknown')
    expect(classifySignature('42')).toBe('unknown')
    expect(classifySignature('[]')).toBe('unknown')
    expect(classifySignature(JSON.stringify({ id: 'x', extraField: 1, summary: [{ text: 'a', type: 't' }] }))).toBe('unknown')
    expect(classifySignature(JSON.stringify({ id: 'x', summary: [] }))).toBe('unknown')
    expect(classifySignature(JSON.stringify({ id: 'x', summary: [{ text: 5, type: 't' }] }))).toBe('unknown')
    expect(classifySignature(JSON.stringify({ id: 'x', summary: [{ text: 'a' }] }))).toBe('unknown')
  })
})

describe('reasoning signature rewrite', () => {
  it('replaces only the text and preserves every other field', () => {
    const original = liveSignature('The whole loop. '.repeat(50))
    const rewritten = rewriteReasoningSignature(original, 'Kept prefix.')
    expect(rewritten).toBeDefined()
    const before = JSON.parse(original) as Record<string, unknown>
    const after = JSON.parse(rewritten!) as Record<string, unknown>

    expect(Object.keys(after).sort()).toStrictEqual(Object.keys(before).sort())
    expect(after['id']).toBe(before['id'])
    expect(after['status']).toBe(before['status'])
    expect(after['type']).toBe(before['type'])
    expect((after['summary'] as { text: string }[])[0]!.text).toBe('Kept prefix.')
    // The part type is shape-faithful, not invented.
    expect((after['summary'] as { type: string }[])[0]!.type).toBe('summary_text')
  })

  it('collapses to a single part, adding no separator the text never had', () => {
    // The provider joins parts with a blank line
    // (`openai-responses-shared.js:582`), so preserving a two-part summary that
    // now holds one string would inject `\n\n` into the replayed reasoning.
    const twoPart = JSON.stringify({
      id: 'item_x',
      status: 'completed',
      summary: [{ text: 'a', type: 'summary_text' }, { text: 'b', type: 'summary_text' }],
      type: 'reasoning',
    })
    const rewritten = rewriteReasoningSignature(twoPart, 'kept')
    expect(rewritten).toBeDefined()
    const summary = (JSON.parse(rewritten!) as { summary: unknown[] }).summary
    expect(summary).toHaveLength(1)
    expect((summary[0] as { text: string }).text).toBe('kept')
  })

  it('returns undefined instead of a guess for unknown shapes', () => {
    expect(rewriteReasoningSignature('garbage', 'kept')).toBeUndefined()
    expect(rewriteReasoningSignature(liveSignature('x', { encrypted_content: 'B' }), 'kept')).toBeUndefined()
    expect(rewriteReasoningSignature(undefined, 'kept')).toBeUndefined()
  })
})

describe('braked envelope rebuild', () => {
  const envelope = {
    response: { api: 'openai-responses', provider: 'mock', model: 'mock', stopReason: 'stop' },
    blocks: [
      { type: 'reasoning', thinkingSignature: liveSignature('Loop. '.repeat(200)) },
      { type: 'text', textSignature: '{"v":1,"id":"msg_1"}' },
    ],
  }

  it('rewrites the truncated reasoning and leaves the text block alone', () => {
    const rebuilt = rebuildBrakedEnvelope(envelope, [0, 1], new Map([[0, 'Kept reasoning.']])) as typeof envelope
    expect(rebuilt.blocks).toHaveLength(2)

    const reasoningSig = JSON.parse(
      (rebuilt.blocks[0] as { thinkingSignature: string }).thinkingSignature,
    ) as { summary: { text: string }[]; id: string }
    expect(reasoningSig.summary[0]!.text).toBe('Kept reasoning.')
    // Identity survives, which is what keeps the item's pairing valid.
    expect(reasoningSig.id).toBe('item_7be51c54bd35ba6c74d1bcdd')

    // A text signature carries no text, so it is passed through by identity.
    expect((rebuilt.blocks[1] as { textSignature: string }).textSignature).toBe('{"v":1,"id":"msg_1"}')
  })

  it('leaves a reasoning block the brake did not truncate untouched', () => {
    const rebuilt = rebuildBrakedEnvelope(envelope, [0, 1], new Map()) as typeof envelope
    expect(rebuilt.blocks[0]).toBe(envelope.blocks[0])
    expect(rebuilt.blocks[1]).toBe(envelope.blocks[1])
  })

  it('preserves the response half of the envelope', () => {
    const rebuilt = rebuildBrakedEnvelope(envelope, [0, 1], new Map()) as typeof envelope
    expect(rebuilt.response).toBe(envelope.response)
  })

  it('drops the envelope rather than ship an un-rewritable signature', () => {
    // The load-bearing failure mode: an unrecognised signature must not pass
    // through, because it would re-send the whole braked loop. Dropping the
    // envelope degrades one message to provider-neutral history instead.
    const opaque = {
      response: envelope.response,
      blocks: [{ type: 'reasoning', thinkingSignature: JSON.stringify({ id: 'x', encrypted_content: 'B' }) }],
    }
    expect(rebuildBrakedEnvelope(opaque, [0], new Map([[0, 'kept']]))).toBeUndefined()
  })

  it('refuses an envelope whose block count disagrees with the stream', () => {
    expect(rebuildBrakedEnvelope(envelope, [0], new Map())).toBeUndefined()
    expect(rebuildBrakedEnvelope({ response: {}, blocks: 'nope' }, [0], new Map())).toBeUndefined()
    expect(rebuildBrakedEnvelope(undefined, [0], new Map())).toBeUndefined()
  })
})

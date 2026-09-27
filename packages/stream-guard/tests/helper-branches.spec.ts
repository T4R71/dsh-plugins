import { describe, expect, it } from 'vitest'
import {
  classifySignature,
  rebuildBrakedEnvelope,
  rewriteReasoningSignature,
} from '../src/signature.ts'
import { prefersCjk } from '../src/language.ts'
import { isBenign } from '../src/text.ts'

/**
 * Branch-completeness suite for the guard's pure helpers.
 *
 * The three sibling suites pin what these helpers *mean*; this file adds only the
 * inputs they never needed — the malformed shapes a hostile or merely different
 * provider response can carry. Every case here is a shape the module documents a
 * decision about, reached through the exported function itself; none of them was
 * invented to light up a line.
 */

/** A signature shaped as the live provider mints it, so only the field under test differs. */
function liveSignature(summary: unknown): string {
  return JSON.stringify({ id: 'item_x', status: 'completed', summary, type: 'reasoning' })
}

describe('signature shape guards', () => {
  it('refuses a signature that is not a string at all', () => {
    // The envelope field is `unknown`: a gateway that hands back an already-parsed
    // item, a number, or an array must be refused rather than coerced into a
    // rewrite, because the rewrite's whole safety argument is about this shape.
    expect(classifySignature(42)).toBe('unknown')
    expect(classifySignature({ id: 'x' })).toBe('unknown')
    expect(classifySignature([])).toBe('unknown')
    expect(rewriteReasoningSignature(42, 'kept')).toBeUndefined()
  })

  it('drops the envelope when a truncated reasoning block carries a non-string signature', () => {
    // Reached through the caller's path rather than `classifySignature`: a
    // reasoning block whose signature is not the JSON string the wire promises
    // cannot be rewritten, so the message degrades to provider-neutral history.
    const blocks = [{ type: 'reasoning', thinkingSignature: 42 }]
    expect(rebuildBrakedEnvelope({ blocks }, [0], new Map([[0, 'kept']]))).toBeUndefined()
  })

  it('refuses a summary that is not a list at all', () => {
    // `summary` is documented as a list of parts, and every positive case here goes
    // through the list path, so the non-list shapes were the gap. A bare string or
    // number has no parts to re-emit and is refused rather than coerced into one.
    expect(classifySignature(liveSignature('summary_text'))).toBe('unknown')
    expect(classifySignature(liveSignature(7))).toBe('unknown')
    expect(classifySignature(liveSignature(undefined))).toBe('unknown')
  })

  it('refuses a summary whose parts are not objects', () => {
    // A part may be anything JSON allows; only an object carrying a string `text`
    // and a string `type` is a shape this build can re-emit faithfully.
    expect(classifySignature(liveSignature([7]))).toBe('unknown')
    expect(classifySignature(liveSignature([null]))).toBe('unknown')
    expect(classifySignature(liveSignature(['text']))).toBe('unknown')
    expect(classifySignature(liveSignature([[]]))).toBe('unknown')
  })
})

describe('braked envelope guards', () => {
  it('drops the envelope when the block order has a hole', () => {
    // `blockOrder` is built by pushing each chunk's own index
    // (`index.ts:523`), so a chunk that arrives without one widens the order
    // without filling it. Reading past that hole would pair a kept text with the
    // next block's signature, so the envelope is dropped instead of misaligned.
    const blockOrder: number[] = []
    blockOrder.length = 1
    expect(rebuildBrakedEnvelope({ blocks: [{ type: 'text' }] }, blockOrder, new Map())).toBeUndefined()
  })

  it('drops the envelope when a block entry is not an object', () => {
    // `blocks` is raw upstream data, so a null or a scalar entry is a malformed
    // envelope rather than a TypeScript impossibility.
    expect(rebuildBrakedEnvelope({ blocks: [null] }, [0], new Map())).toBeUndefined()
    expect(rebuildBrakedEnvelope({ blocks: ['nope'] }, [0], new Map())).toBeUndefined()
  })
})

describe('text and language shortcuts', () => {
  it('treats a one- or two-character Latin line as structure', () => {
    // The shortcut is calibrated for Latin script: a line that short is a list
    // marker or stray punctuation, never an announcement. `judgeHesitation`
    // skips such lines through this predicate (`hesitation.ts:96`), so a stray
    // "ok" must not enter the hesitation window.
    expect(isBenign('ok')).toBe(true)
    expect(isBenign('x')).toBe(true)
    // The boundary is the length, not the content: one more character is content.
    expect(isBenign('ok!')).toBe(false)
  })

  it('does not exempt a short CJK line as structure', () => {
    // `现在` is two characters and a complete word, so the Latin shortcut must not
    // apply: it falls through to the structural regex, which does not match.
    expect(isBenign('现在')).toBe(false)
  })

  it('ignores non-text blocks in a human turn when judging language', () => {
    // A human turn can carry an image beside its text; only the text blocks are
    // evidence of the conversation's language.
    const messages = [{
      role: 'user',
      source: { kind: 'user' },
      content: [
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'text', text: '请继续。' },
      ],
    }]
    expect(prefersCjk(messages as never)).toBe(true)
  })
})

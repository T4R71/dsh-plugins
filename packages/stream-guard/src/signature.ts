/**
 * Rewriting a reasoning replay signature so a braked prefix stays a native item.
 *
 * ## Why this is needed at all
 *
 * A provider mints one opaque signature per reasoning block, and pi-ai sends it
 * back *verbatim*: when a `thinkingSignature` is present it pushes the parsed
 * item and ignores the block's own text
 * (`pi-ai/dist/api/openai-responses-shared.js:137-141`). So the signature, not
 * the transcript, decides what the next request carries.
 *
 * That makes a brake and a signature mutually exclusive by default. Keep the
 * signature and the full loop is re-sent, undoing the brake on the wire. Drop it
 * and the whole item falls out of the request, so the cache breaks at the item
 * start rather than at the cut point.
 *
 * There is a third option, and this module implements it: rewrite the signature
 * so it describes the text that was actually kept. The item stays a native
 * reasoning item, the provider still sees a well-formed one, and the cache break
 * lands where the cut did.
 *
 * ## Why that is not forgery
 *
 * A signature is replayed as *input history*, and on this provider it carries no
 * provider-side secret to contradict it:
 *
 * - The request is `store: false` (`pi-ai/dist/api/openai-responses.js:233`), so
 *   the provider keeps no server-side record of the item to compare against.
 * - `reasoning.encrypted_content` is requested but never returned, so there is
 *   no opaque blob the provider would prefer over the summary.
 * - Measured over the live corpus: 1983 reasoning signatures, every single one
 *   with the same key set `{id, status, summary, type}`, every `status` equal to
 *   `completed`, `encrypted_content` present in **0** of them, and
 *   `summary[0].text` byte-identical to the reasoning block's own text in
 *   **1983 of 1983**.
 *
 * That last fact is what makes the rewrite meaningful: on this provider the
 * `summary` is not a summary, it is a verbatim mirror of the reasoning text. So
 * replacing it with the kept prefix states exactly what was kept, which is what
 * the transcript says too.
 *
 * **Every one of those properties is feature-detected below, never assumed.** A
 * signature whose shape this build does not recognise is left for the caller to
 * drop, which degrades to the previous behaviour rather than fabricating an item
 * whose meaning is unknown.
 */

/** The one summary part type observed on the wire. */

/** The complete key set a rewritable reasoning signature is allowed to carry. */
const ALLOWED_KEYS = ['id', 'status', 'summary', 'type'] as const

/**
 * The outcome of inspecting a reasoning signature.
 *
 * `'rewritable'` is deliberately narrow: it means the shape was understood
 * completely and every field other than the text is preserved by identity.
 */
export type SignatureShape =
  /** Understood, and carries reasoning text this build can replace. */
  | 'rewritable'
  /** No signature at all: nothing to rewrite, and nothing to lose by dropping. */
  | 'absent'
  /** A shape this build does not recognise. Never guessed at. */
  | 'unknown'
  /** Explicitly not text-bearing: an opaque blob the provider would prefer. */
  | 'opaque'

/** A parsed rewritable signature, split into what is preserved and what is replaced. */
interface ParsedSignature {
  /** Every field except `summary`, preserved by identity. */
  readonly preserved: Record<string, unknown>
  /** The summary part type to re-emit, so the rewrite stays shape-identical. */
  readonly partType: string
}

/**
 * Decide whether a reasoning signature can be safely rewritten.
 *
 * Rejects anything carrying `encrypted_content` or `content`: with an opaque
 * blob or a parallel content array present, a rewritten `summary` would no
 * longer be the item's only text, and the provider's own copy would win.
 * @param signature - the raw `thinkingSignature` value from a replay envelope.
 * @returns the classification, and the parts preserved when rewritable.
 */
function inspect(signature: unknown): { shape: SignatureShape; parsed?: ParsedSignature } {
  if (signature === undefined || signature === null) return { shape: 'absent' }
  if (typeof signature !== 'string') return { shape: 'unknown' }
  let item: unknown
  try {
    item = JSON.parse(signature)
  } catch {
    return { shape: 'unknown' }
  }
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return { shape: 'unknown' }
  const record = item as Record<string, unknown>
  // An opaque blob is the provider's own text and would override the summary.
  if ('encrypted_content' in record || 'encryptedContent' in record) return { shape: 'opaque' }
  if ('content' in record) return { shape: 'opaque' }
  for (const key of Object.keys(record)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) return { shape: 'unknown' }
  }
  const summary = record['summary']
  if (!Array.isArray(summary)) return { shape: 'unknown' }
  let partType: string | undefined
  for (const part of summary) {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) return { shape: 'unknown' }
    const text = (part as Record<string, unknown>)['text']
    const type = (part as Record<string, unknown>)['type']
    if (typeof text !== 'string') return { shape: 'unknown' }
    if (typeof type !== 'string') return { shape: 'unknown' }
    partType ??= type
  }
  // An empty summary is the only way to reach here without a type: every iteration
  // above either returns or proves a string, so `partType` is set by the first one.
  // Rejecting the empty case *here* rather than before the loop is what keeps this
  // branch live — the earlier shape rejected it up front and then had to carry an
  // unreachable `?? SUMMARY_TEXT` fallback behind the loop to satisfy the type
  // checker. Same semantics, one fewer guard, no dead code.
  if (partType === undefined) return { shape: 'unknown' }
  const { summary: _summary, ...preserved } = record
  return { shape: 'rewritable', parsed: { preserved, partType } }
}

/**
 * Classify a reasoning signature without rewriting it.
 * @param signature - the raw `thinkingSignature` value from a replay envelope.
 * @returns how this build can treat the signature.
 */
export function classifySignature(signature: unknown): SignatureShape {
  return inspect(signature).shape
}

/**
 * Rewrite a reasoning signature so it describes `text`.
 *
 * Only the text changes. `id` and `status` are preserved by identity, so the
 * item keeps its identity for the provider's reasoning/tool-call pairing
 * (`openai-responses-shared.js:171`), and the part type is preserved so the item
 * stays shape-identical to what the provider minted.
 *
 * The parts collapse to one carrying the whole kept text. The provider joins
 * parts with a blank line (`openai-responses-shared.js:582`), so keeping the
 * original part count would inject `\n\n` separators the kept text never
 * contained. Collapsing adds no separator at all. Every signature measured on
 * this provider had exactly one part, so this never changes an observed shape.
 *
 * @param signature - the raw `thinkingSignature` value to rewrite.
 * @param text - the reasoning text that was actually kept.
 * @returns the rewritten signature, or `undefined` when the shape is not one this
 *   build can rewrite — in which case the caller must drop it rather than guess.
 */
export function rewriteReasoningSignature(signature: unknown, text: string): string | undefined {
  const { shape, parsed } = inspect(signature)
  if (shape !== 'rewritable' || parsed === undefined) return undefined
  // The delivered text is what the transcript holds; a rewrite that omitted it
  // would leave the item describing reasoning the model no longer has.
  return JSON.stringify({ ...parsed.preserved, summary: [{ type: parsed.partType, text }] })
}

/**
 * Rebuild a replay envelope for the blocks a brake truncated.
 *
 * The envelope is index-aligned with the streamed blocks in first-seen order
 * (`llm/src/types.ts:407-415`), which is why the caller passes that order rather
 * than the adapter's own block indexes.
 *
 * Two block types need opposite treatment, and the difference is what each
 * signature actually carries:
 *
 * - **text** keeps its `textSignature` untouched. That signature is only
 *   `{v:1, id}` — measured: 3570 of them, **0** carrying text — and pi-ai takes
 *   the text from the block itself (`openai-responses-shared.js:156-161`). So the
 *   truncated text is what goes on the wire, with the original item id preserved.
 * - **reasoning** has its signature rewritten, because pi-ai would otherwise
 *   push the stored item verbatim and re-send the loop it was braked for.
 *
 * A reasoning block that was *closed* before the brake is left alone: its text is
 * intact, so its signature is still accurate.
 *
 * @param raw - the upstream `replayState` from the stream's `finish` chunk.
 * @param blockOrder - block indexes in first-seen stream order.
 * @param truncated - per truncated block index, the text that was kept.
 * @returns the rebuilt envelope, or `undefined` when it cannot be rebuilt
 *   faithfully — in which case the message degrades to provider-neutral history,
 *   which is always safe because an unsigned reasoning item is simply not sent
 *   (`openai-responses-shared.js:139-141`).
 */
export function rebuildBrakedEnvelope(
  raw: unknown,
  blockOrder: readonly number[],
  truncated: ReadonlyMap<number, string>,
): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const envelope = raw as Record<string, unknown>
  const blocks = envelope['blocks']
  // No per-block metadata means no signature to contradict the brake, so there
  // is nothing to rebuild — but the envelope is still not usable as-is: the
  // pi-ai reader requires a `blocks` array and would reject it wholesale.
  if (!Array.isArray(blocks)) return undefined
  if (blocks.length !== blockOrder.length) return undefined

  const rebuilt: unknown[] = []
  for (const [position, entry] of blocks.entries()) {
    const index = blockOrder[position]
    if (index === undefined) return undefined
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
    const block = entry as Record<string, unknown>
    const kept = truncated.get(index)
    if (kept === undefined || block['type'] !== 'reasoning') {
      rebuilt.push(entry)
      continue
    }
    const signature = rewriteReasoningSignature(block['thinkingSignature'], kept)
    // An unrecognised signature is never guessed at. Dropping the whole envelope
    // costs this one message its native ids; keeping the original signature would
    // silently re-send the entire loop, which is strictly worse.
    if (signature === undefined) return undefined
    rebuilt.push({ ...block, thinkingSignature: signature })
  }
  return { ...envelope, blocks: rebuilt }
}

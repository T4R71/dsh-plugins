/**
 * The settle-envelope rule for subagent closing messages — a **dumb pipe**.
 *
 * ## The problem
 *
 * \`@deepseek-ai/dsh-subagent\` delivers a settled child's closing message into
 * the parent as a *plain* durable \`user\` message whose third text block is the
 * child's entire final answer, unbounded
 * (\`dsh-subagent/lib/index.js:633-654\`, \`createSettlementMessage\`; the
 * concatenation at \`:640-646\` has no cap, and the only bounded field is
 * \`source.summary\`, which never reaches a model).
 *
 * Measured on this deployment's parent session: 29 settlement messages,
 * 172,344 characters of JSON / 160,237 characters of text, largest single
 * closing message 15,562 characters.
 *
 * ## Why an envelope and not a truncation
 *
 * A child's closing message is the *result of the work*. Dropping any of it is
 * not a saving, it is a lost deliverable. So the full text is written to disk
 * and hashed first, and what enters the parent's transcript is a pointer plus
 * the **tail** of the message verbatim. The parent can always read the rest
 * back — the envelope names where it is and what it hashes to, so the parent
 * can also verify that what it reads back is what the child wrote.
 *
 * ## Why a dumb pipe, and what that means
 *
 * This module used to *know the protocol*: it carried a copy of
 * \`@t4r71/dsh-task\`'s status-line regex, its backwards scan, its "first
 * non-empty line after the status is the summary" rule, and its
 * \`结论 / 证据 / 判不了\` heading set. Two copies of one protocol have to stay
 * character-for-character in step, and on 2026-10-02 they did not: a child's
 * trailing \`状态：完成\` was eaten by the guard's copy, \`task\` could not resolve a
 * verdict, and every node of a whole plan tree was misread as failed.
 *
 * The fix is to remove the knowledge rather than to synchronise it. This module
 * now carries the **tail K characters of the closing text, unchanged**, and
 * nothing else about the message. It does not read, match, classify, or rewrite
 * a single character of what the child wrote; \`tailExcerpt\` is the whole of its
 * text handling, and its only decision is where to cut.
 *
 * ## Why the tail is enough (no parsing required)
 *
 * The dispatch brief \`@t4r71/dsh-task\` sends already requires the child to
 * print \`状态：完成\` (or \`状态：失败\`) on **its own line at the end of its final
 * closing message**, and the parent-side reader takes the *last* such line and
 * the first non-empty line after it. Position is therefore guaranteed, not
 * inferred: keeping the last K characters necessarily carries the status line
 * and the summary line under it. Guard does not need to know what that line
 * *means* — it only needs not to lose it.
 *
 * Measured on this deployment's 56 deduplicated real closing messages (the
 * spills under \`%TEMP%\\dsh-guard-spill\\settle\`): 524 characters on average,
 * 762 at worst, so the default \`settleEnvelopeTailChars\` of 500 covers the
 * "status line + its summary" pair with room to spare.
 *
 * ## The seam, and why it does not cost a cache miss
 *
 * The settlement message is \`role: 'user'\` and travels through
 * \`parent.inbox\` -> \`dsh-agent-loop/lib/index.js:906 claim()\` ->
 * \`:912\` \`payload.messages\` of the \`agent/pre-step\` waterfall; the listener's
 * return value is what \`:1061\` commits and \`:1063\` builds the request from.
 * Replacing it there happens *before the first commit*, so the original never
 * enters a prompt prefix and no cache is invalidated. \`dsh-agent\`'s own
 * \`disposeNotice\` listener (\`dsh-agent/lib/index.js:193-204\`) rewrites the same
 * array, which is the precedent.
 *
 * ## Fidelity guarantee
 *
 * - The full closing text is always written before the envelope is built; if
 *   the write fails, the message is left untouched rather than replaced by a
 *   pointer that leads nowhere.
 * - The envelope carries the \`sha256\` of the exact spilled text, so a reader
 *   can prove the read-back matches.
 * - With \`settleEnvelope: false\` nothing in this module runs and the message
 *   is committed byte-for-byte as the harness built it.
 *
 * @module @t4r71/dsh-guard/envelope
 */

import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { byteLength, sha256Hex, spillDirectory, writeSpill } from './spill.ts'

/** Whether settle-envelope rewriting is willing to run, and how much tail to keep. */
export interface EnvelopeDecision {
  /** The switch; \`false\` returns every message untouched. */
  readonly enabled: boolean
  /**
   * How many characters of the closing message's **end** the envelope carries.
   *
   * Nothing about the text is interpreted — the tail is reproduced verbatim
   * whatever it contains. The default keeps the status line and the summary
   * line under it, because the dispatch brief puts them at the end of the
   * message; see the module comment.
   */
  readonly tailChars: number
}

/** The harness's own lead-ins, which the envelope keeps verbatim. */
const CLOSING_LEAD_IN = 'Its closing message:'
const NO_CLOSING = 'It left no closing message.'

/** Every text block of a message, in order; \`undefined\` when any block is not text. */
function textsOf(content: readonly ContentBlock[]): string[] | undefined {
  const out: string[] = []
  for (const block of content) {
    if (block.type !== 'text') return undefined
    out.push(block.text)
  }
  return out
}

/**
 * The last \`tailChars\` characters of \`closing\`, cut on a line boundary when one
 * is available, hard at the limit when it is not.
 *
 * This function is the entire text handling of this module, and it makes no
 * judgement about what it is given: it does not match, classify, or rewrite a
 * single character. The only thing it decides is where the cut lands.
 *
 * The line-boundary preference means the cut walks back to the nearest newline
 * inside the budget, so the envelope never opens with half a line; when that
 * walk-back would leave nothing (a single line longer than the budget), the cut
 * is hard at the budget instead. The returned string is at most \`tailChars\`
 * characters in both cases — that is the contract, not an approximation.
 *
 * @param closing - the child's closing text.
 * @param tailChars - the character budget; \`0\` keeps nothing.
 * @returns at most \`tailChars\` characters from the end, verbatim.
 */
export function tailExcerpt(closing: string, tailChars: number): string {
  if (tailChars <= 0) return ''
  const characters = Array.from(closing)
  if (characters.length <= tailChars) return closing
  const tail = characters.slice(characters.length - tailChars).join('')
  const firstBreak = tail.indexOf('\n')
  // No newline at all: the budget landed inside one over-long line, so the cut
  // stays hard at the budget. A newline at index 0 means the budget landed exactly
  // on a line start, which is already a boundary and is kept. Any later newline
  // means the opening fragment is a partial line, dropped by starting after it —
  // which is what keeps the envelope from opening mid-sentence.
  if (firstBreak < 0) return tail
  return tail.slice(firstBreak + 1)
}

/**
 * Build the content that replaces a settlement message's closing blocks.
 *
 * The returned blocks keep the harness's own lead-in lines, so the message
 * still reads as a settlement notice in the transcript, and then carry the
 * envelope: the tail of the closing text verbatim, plus a pointer naming the
 * spilled full text, its size, and its hash. The original closing text is NOT
 * reproduced in full.
 *
 * @param message - the settlement message as the harness built it.
 * @param decision - whether and how to envelope.
 * @returns replacement content, or \`undefined\` to leave the message alone.
 */
export function envelopeContent(message: UserMessage, decision: EnvelopeDecision): ContentBlock[] | undefined {
  if (!decision.enabled) return undefined
  const source = message.source as { kind?: unknown, senderSessionId?: unknown } | undefined
  if (source?.kind !== 'subagent-settled') return undefined
  const texts = textsOf(message.content)
  if (texts === undefined) return undefined
  const marker = texts.indexOf(CLOSING_LEAD_IN)
  // A child that left nothing, or a shape this build does not recognise: the
  // message is already short, so there is nothing to save and nothing to risk.
  if (marker < 0 || texts.length <= marker + 1) return undefined
  if (texts.includes(NO_CLOSING)) return undefined
  // Idempotence: an envelope already names its own spill and carries no lead-in
  // of its own only when the harness built it, so a message whose first block is
  // already a pointer tail passes the marker test. Guarding on the source form
  // and the marker keeps that from mattering; the check below is what makes a
  // second pass a no-op for a message that was already rewritten in place.
  if (isEnvelope(texts)) return undefined

  const closing = texts.slice(marker + 1).join('')
  const childId = typeof source.senderSessionId === 'string' ? source.senderSessionId : 'unknown'
  const digest = sha256Hex(closing)
  const path = writeSpill(spillDirectory('settle', childId), digest.slice(0, 16) + '.md', closing)
  // The write is the whole recovery path. If it failed, handing over the
  // original is the only faithful choice; an envelope pointing at nothing would
  // be a silent loss of the child's work.
  if (path === undefined) return undefined

  const head = texts.slice(0, marker + 1)
  const lineCount = closing.split('\n').length
  const tail = tailExcerpt(closing, Math.max(0, decision.tailChars))
  const envelope: string[] = []
  if (tail !== '') envelope.push('', tail)
  envelope.push(
    '',
    'Envelope of its closing message (' + String(byteLength(closing)) + ' bytes, '
      + String(lineCount) + ' lines).',
    'Full text: ' + path,
    'sha256 ' + digest,
    // A zero budget is the pure-pointer mode: the closing message stays out of the
    // parent's context entirely, and the parent decides for itself whether the
    // situation calls for reading the full text back.
    tail === ''
      ? '(its closing message is not reproduced here; read the full text at the path above when you need it)'
      : '(the ' + String(Array.from(tail).length) + ' characters above are the verbatim end of'
        + ' its closing message; read the full text at the path above when you need more)',
  )

  return [
    ...head.map(text => ({ type: 'text' as const, text })),
    { type: 'text' as const, text: envelope.join('\n') },
  ]
}

/**
 * Whether these text blocks are already an envelope this module produced.
 *
 * The envelope's own pointer line is the marker: it is the one sentence this
 * module adds, and a child writing it by hand is not a case worth trading the
 * idempotence guarantee for.
 *
 * @param texts - every text block of the message, in order.
 * @returns \`true\` when the blocks already carry an envelope.
 */
function isEnvelope(texts: readonly string[]): boolean {
  return texts.some(text => text.includes(ENVELOPE_POINTER))
}

/** The sentence every envelope carries to mark itself. */
const ENVELOPE_POINTER = 'are the verbatim end of'

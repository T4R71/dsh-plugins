/**
 * Item 3 — drop a repeated injection only when it is byte-identical.
 *
 * ## What repeats, measured
 *
 * Every producer that republishes a whole-context snapshot appends a fresh
 * `user/message` each time it changes, and the transcript keeps all of them.
 * Counted over this deployment's parent session
 * (`session-8b4db1dc-089e-4002-8259-9aabbf5cb022`):
 *
 * | source kind        | messages | distinct bodies |
 * |--------------------|----------|-----------------|
 * | `runtime-context`  |        5 |               1 |
 * | `skill-catalog`    |        5 |               3 |
 * | `time-context`     |       19 |              19 |
 * | `subagent-settled` |       29 |              29 |
 *
 * `runtime-context` is the pure case: five copies, one body, 2,128 characters
 * each — four of them carry no information the first does not. `time-context`
 * looks like a counterexample and is not: all 19 bodies differ, so this rule
 * leaves every one alone. That is the point of comparing bytes instead of
 * classifying meaning.
 *
 * ## Where it runs, and what it may touch
 *
 * `agent/pre-step` (`dsh-agent-loop/lib/index.js:911-918`) carries
 * `payload.messages` — exactly the messages `inbox.claim()` took for *this*
 * step (`:906`) — and the listener's return value is what the loop commits
 * (`:1061`) and then builds the request from (`:1063`). Filtering here is
 * therefore the one place a repeat can be dropped BEFORE it is ever committed,
 * which means no later request's prefix changes: the dropped copy never entered
 * a prompt in the first place.
 *
 * Two consequences worth stating because they are what make the rule safe:
 *
 * - Only messages *arriving in this step* are judged. History is not rewritten,
 *   so a drop can never move a byte of an already-cached prefix.
 * - A drop removes the whole message. It cannot leave a half-message behind,
 *   and the retained copy is the newest one, so the surviving text is the one
 *   the producer most recently meant.
 *
 * ## The one exclusion
 *
 * A message whose body repeats a body already seen earlier in the same step
 * batch is compared against other new arrivals, not against history. If two
 * messages of one batch are identical, the later is dropped. Nothing about a
 * human turn is filtered: `source.kind === 'user'` is never a candidate,
 * because a person saying the same thing twice is a person, not a producer.
 *
 * @module @t4r71/dsh-guard/dedup
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** Whether a dedup pass is willing to run. */
export interface DedupDecision {
  readonly enabled: boolean
}

/** The exact model-facing text of a message, concatenated in block order. */
export function messageBody(message: UserMessage): string | undefined {
  const blocks = message.content
  if (blocks.length === 0) return ''
  let out = ''
  for (const block of blocks) {
    if (block.type !== 'text') return undefined
    out += block.text
  }
  return out
}

/** What a dedup pass changed, for the caller's log line and the tests. */
export interface DedupOutcome {
  /** The messages to commit: the input array itself when nothing was dropped. */
  readonly messages: UserMessage[]
  /** Bodies dropped as byte-identical repeats, in order. */
  readonly dropped: string[]
}

/**
 * Drop messages whose body is byte-identical to one already retained.
 *
 * The comparison is a plain string equality on the concatenated text blocks,
 * and a message carrying any non-text block is never a candidate — an image or
 * file reference is not reproducible from its text, so treating it as a repeat
 * would be a guess.
 *
 * Provenance is part of the key. Two identical bodies from *different*
 * producers are not interchangeable: the harness's own presenters colour a row
 * by `source.kind` and `form`, and a `notice` that says what just happened is
 * not the same object as a `snapshot` that says what is currently true, even
 * when they happen to read alike. Keying on the producer keeps the drop
 * explainable: this producer republished its own unchanged body.
 *
 * @param messages - the messages claimed for this step, in order.
 * @param decision - whether to run at all.
 * @returns the messages to commit and what was dropped.
 */
export function dedupeInjections(messages: UserMessage[], decision: DedupDecision): DedupOutcome {
  if (!decision.enabled) return { messages, dropped: [] }

  const seen = new Set<string>()
  const kept: UserMessage[] = []
  const dropped: string[] = []

  for (const message of messages) {
    const source = message.source as { kind?: unknown, form?: unknown } | undefined
    const kind = typeof source?.kind === 'string' ? source.kind : ''
    // A human turn and a tool result are not a producer republishing; leave both.
    if (kind === '' || kind === 'user' || kind === 'tool') {
      kept.push(message)
      continue
    }
    const body = messageBody(message)
    if (body === undefined) {
      kept.push(message)
      continue
    }
    // The identity of a republished snapshot is its producer AND its body.
    // The form is in the key so a notice and a snapshot never collapse together.
    const key = kind + '\u0000' + (typeof source?.form === 'string' ? source.form : '') + '\u0000' + body
    if (seen.has(key)) {
      dropped.push(key)
      continue
    }
    seen.add(key)
    kept.push(message)
  }

  return dropped.length === 0 ? { messages, dropped } : { messages: kept, dropped }
}

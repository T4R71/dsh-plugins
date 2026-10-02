/**
 * Item 1 — bound `job_output` at the point the transcript is written.
 *
 * ## The defect
 *
 * `job.outputLimitBytes` is the only cap `@deepseek-ai/dsh-tool-jobs` applies
 * to a `job_output` result (`dsh-tool-jobs/lib/index.js:240-255`,
 * `finalizeJobContent`), and it is read from the *producer's* job record
 * (`:168`, `:194-200` `visibleOutputLimit`). `@deepseek-ai/dsh-tool-pwsh`
 * registers its jobs without that field (`dsh-tool-pwsh/lib/index.js:362-390`,
 * `registry.start({kind, label, owner, output, run, ...})`), and
 * `dsh-tool-jobs`' own `Config` (`:88-93`) has no key to set a default. So for
 * the jobs this harness actually runs, `maxBytes` is `undefined` and every
 * branch that would truncate returns the input unchanged.
 *
 * Measured over the sessions in this deployment's `home/sessions`: 67
 * `job_output` sub-dispatches totalling 438,502 characters, the largest single
 * result 49,932 characters — a stream of trading-loop lines no one reads back.
 *
 * ## Why this seam
 *
 * The value the *program* already received cannot be taken away, and rewriting
 * the `tools/post-execute` result would change what `run_code` returns to the
 * caller. `tools/ptc-dispatch-log` is the one seam that owns exactly "the copy
 * that reaches the transcript": `dsh-tools/lib/index.js:706-714`
 * (`shapeDispatchLog`) runs the waterfall and appends the returned blocks to
 * the `tool/ptc-dispatch` event. The shipped `@deepseek-ai/dsh-spill-policy`
 * hangs its own retention there (`dsh-spill-policy/lib/index.js:133-136`), which
 * is the precedent this follows.
 *
 * ## What is deliberately not done
 *
 * Only the text of a `job_output` dispatch is bounded, and only when it
 * exceeds the cap. Nothing else about the event changes: the job id, status
 * line, `isError`, arguments, and severity all pass through untouched, so a
 * reader can still tell what the job was and how it ended from the transcript
 * alone.
 *
 * @module @t4r71/dsh-guard/joblog
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { byteLength, retainTailBytes, spillDirectory, writeSpill } from './spill.ts'

/** One `tools/ptc-dispatch-log` payload, as `dsh-tools` passes it. */
export interface PtcDispatchLogPayload {
  readonly exec: { readonly callId?: string, readonly agent?: { readonly id?: string } }
  readonly agent?: { readonly id?: string }
  readonly subCallId?: string
  readonly name: string
  readonly isError: boolean
  readonly content: readonly ContentBlock[]
}

/** Whether a listener is willing to bound one dispatch's logged copy. */
export interface JobLogDecision {
  /** Whether the bound applies at all. */
  readonly enabled: boolean
  /** The byte cap; text at or under it is passed through unchanged. */
  readonly maxBytes: number
  /** Directory to spill the full copy into; the session id is appended. */
  readonly spillRoot: string
}

/** What the bound did, for the caller's log line and the tests. */
export interface JobLogOutcome {
  /** The blocks to log: the original content when nothing was bounded. */
  readonly content: readonly ContentBlock[]
  /** True when the copy was replaced. */
  readonly bounded: boolean
  /** Bytes the reader keeps. */
  readonly keptBytes: number
  /** Bytes the dispatch produced. */
  readonly totalBytes: number
  /** Where the full copy went, when it was written. */
  readonly spillPath?: string
}

/** The notice that replaces the elided middle; it must always name the way back. */
function truncationNotice(keptBytes: number, totalBytes: number, spillPath: string | undefined): string {
  return '\n[job_output truncated: kept the last ' + String(keptBytes) + ' of '
    + String(totalBytes) + ' bytes. Full copy: '
    + (spillPath === undefined
      ? '(spill write failed — read the job again and the text is still there)'
      : spillPath)
    + ']'
}

/**
 * Bound the text of one settled `job_output` dispatch.
 *
 * Tail retention rather than head: a job's output is a stream whose *end* is
 * the part a reader came back for (a final status line, the exit marker), and
 * `@deepseek-ai/dsh-tool-jobs` already retains tails for its own model-facing
 * bound (`dsh-tool-jobs/lib/index.js:131-138`, `retainTail`). Bounding from
 * the other end would keep the least useful half.
 *
 * @param payload - the dispatch as `dsh-tools` passes it.
 * @param decision - whether and how far to bound.
 * @returns the blocks to log and what happened.
 */
export function boundJobOutput(payload: PtcDispatchLogPayload, decision: JobLogDecision): JobLogOutcome {
  const totalBytes = payload.content.reduce(
    (total, block) => total + (block.type === 'text' ? byteLength(block.text) : 0), 0)
  const unchanged: JobLogOutcome = {
    content: payload.content, bounded: false, keptBytes: totalBytes, totalBytes,
  }
  if (!decision.enabled) return unchanged
  if (payload.name !== 'job_output') return unchanged
  // A failed read is a short diagnostic; truncating it would hide the reason.
  if (payload.isError) return unchanged
  if (totalBytes <= decision.maxBytes) return unchanged
  // A non-text block (an image, a file reference) cannot be split safely, so the
  // dispatch is left whole rather than half-rewritten.
  if (!payload.content.every(block => block.type === 'text')) return unchanged

  const full = payload.content.map(block => (block.type === 'text' ? block.text : '')).join('')
  const sessionId = payload.exec.agent?.id ?? payload.agent?.id ?? 'unknown'
  const fileName = String(payload.subCallId ?? payload.exec.callId ?? 'job').replace(/[^A-Za-z0-9._-]/g, '_')
    + '.txt'
  const spillPath = writeSpill(spillDirectory('job-output', sessionId), fileName, full)

  // Reserve the notice's own bytes before retaining, so the result cannot land
  // over the cap it was asked to fit — the mistake that makes a bound useless.
  //
  // The notice's length depends on the very number being computed: it prints how
  // many bytes were kept, so retaining more digits makes the notice longer, which
  // takes budget away from the text, which can shorten the number again. One
  // pass therefore does not converge — the naive reservation under-reserves by
  // exactly the digits it added and lands at keptBytes = cap + 2, measured.
  // Two passes settle it: the second computes the budget from the notice the
  // first actually produced, and both the notice text and the retained tail are
  // then recomputed from that budget so the two can never disagree.
  let budget = Math.max(0, decision.maxBytes - byteLength(truncationNotice(0, totalBytes, spillPath)))
  let kept = retainTailBytes(full, budget)
  for (let pass = 0; pass < 2; pass += 1) {
    const current = byteLength(truncationNotice(byteLength(kept), totalBytes, spillPath))
    const next = Math.max(0, decision.maxBytes - current)
    if (next === budget) break
    budget = next
    kept = retainTailBytes(full, budget)
  }
  const notice = truncationNotice(byteLength(kept), totalBytes, spillPath)
  const keptBytes = byteLength(kept) + byteLength(notice)
  // A cap too small to hold even the notice is honoured by keeping the notice:
  // an unattributed truncation would be worse than an over-budget one.
  return {
    content: [{ type: 'text', text: kept + notice }],
    bounded: true,
    keptBytes,
    totalBytes,
    ...spillPath === undefined ? {} : { spillPath },
  }
}

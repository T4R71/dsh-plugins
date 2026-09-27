/**
 * Hesitation-density detection — the request-side signal for class-B churn.
 *
 * Class B looks nothing like class A: the model keeps producing real content
 * but repeatedly contradicts itself, marked by a flood of short lines opening
 * with Hmm / Wait / Actually / Ugh / Hold on.
 *
 * Measured over the tail 60 short lines of 7,431 real healthy samples:
 *
 *   threshold 0.30 -> 38 hits (0.51%)
 *   threshold 0.40 -> 23 hits (0.31%)
 *   threshold 0.50 ->  9 hits (0.12%)
 *   threshold 0.60 ->  1 hit  (0.01%)
 *
 * 0.30 was the original setting and it was too loose: in production it fired on
 * 61 consecutive requests against the *same* content. 0.50 is the calibrated
 * value.
 *
 * Unlike the filler guard this never truncates — a class-B turn has already
 * finished writing by the time the pattern is visible, so cutting the stream
 * would discard real output. Consumers inject a nudge into the next request
 * instead.
 *
 * @module @t4r71/dsh-stream-guard/hesitation
 */

import { isBenign, MAX_SHORT_LINE, textLen } from './text.ts'

/**
 * Line openings that mark self-contradiction churn.
 *
 * Two script families, because the marker is a *word*, not a script: the same
 * churn reads "Wait, that is wrong" in English and "等等，这不对" in Chinese. A
 * Latin-only pattern silently never fires on the latter, which is not a
 * conservative default — it is no detection at all.
 *
 * The CJK alternation omits `其实` / `嗯` / `唔`: those are ordinary Chinese
 * discourse markers rather than churn, and including them would move the false
 * positive rate that {@link RATIO} was calibrated against. The CJK half is
 * therefore **uncalibrated** — the reference corpus was English — and is kept to
 * markers that are self-correction on their own. Anchored without `\b`, which
 * does not exist between two CJK characters.
 *
 * `no,` is matched **outside** the `\b` group, and that placement is the whole
 * point. `\b` asserts a word/non-word transition, so `no,\b` can only match when
 * a *word* character follows the comma — but the phrase this branch exists for is
 * "No, that fails.", where the next character is a space. Written inside the group
 * it is unreachable: measured, it matched only the malformed "no,x" and failed
 * "No, that fails." outright. The reference has exactly that bug
 * (`M:\ds-guard\src\guards\hesitation.rs:37`) and this port inherited it until a
 * probe exposed it. It now requires whitespace or end of line after the comma, so
 * real prose matches while "no,x" still does not.
 */
const HESITATION_OPEN = /^(?:hmm|wait|actually|hold on|ugh|but wait)\b|^no,(?:\s|$)|^(?:等等|等一下|慢着|不对)/i

/** Tail window, in short lines. */
export const WINDOW = 60

/** Minimum short lines before judging; avoids deciding on a thin sample. */
export const MIN_LINES = 8

/**
 * Fraction of hesitation lines in the window that counts as churn.
 *
 * Calibrated on the real corpus: 0.50 costs 9/7431 false positives (0.12%)
 * against 38 (0.51%) at 0.30.
 */
export const RATIO = 0.5

/** How much of a transcript tail is examined. */
export interface HesitationVerdict {
  /** Share of hesitation lines among the judged window. */
  readonly share: number
  /** Hesitation lines counted. */
  readonly hits: number
  /** Short lines in the window. */
  readonly lines: number
  /** Characters of transcript text considered. */
  readonly charsSeen: number
}

/**
 * Judge one already-complete text (an assistant message or reasoning summary).
 *
 * Deliberately a pure function over a finished string rather than a streaming
 * state machine: the caller has the transcript in hand, and a request-side
 * signal is only useful once the turn that produced it has finished.
 *
 * @param text - the transcript text to judge.
 * @returns the verdict when the hesitation share reaches {@link RATIO}, else null.
 */
export function judgeHesitation(text: string): HesitationVerdict | null {
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    const s = raw.trim()
    if (s === '' || textLen(s) > MAX_SHORT_LINE || isBenign(s)) continue
    lines.push(s)
  }
  if (lines.length < MIN_LINES) return null
  const tail = lines.slice(-WINDOW)
  const hits = tail.filter(line => HESITATION_OPEN.test(line)).length
  const share = hits / tail.length
  if (share < RATIO) return null
  return { share, hits, lines: tail.length, charsSeen: Array.from(text).length }
}

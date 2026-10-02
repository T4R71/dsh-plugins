/**
 * Layer-two rule R2: cross-channel verbatim restatement.
 *
 * ## The failure this exists for
 *
 * A model can finish a long reasoning block and then emit the **same text again**
 * as the visible answer, verbatim. Measured on the live corpus, eight blocks do
 * exactly this, with a text length equal to the reasoning length to within two
 * characters — e.g. 116,081 reasoning characters answered by 116,079 text
 * characters, of which every single line was already in the reasoning.
 *
 * R1 (`repeat.ts`) cannot see this: the text is a verbatim copy, so each line
 * appears only *twice* across the merged stream and the recycle rate stays near
 * 2. That is why layer two is two rules and not one — measured on the corpus,
 * three of the eleven degenerate blocks are visible only to R1, six only to R2,
 * and just two to both.
 *
 * ## The statistic
 *
 * One set intersection: `lineEcho = |textLines ∩ reasoningLines| / |textLines|`.
 *
 * This is deliberately line-level rather than n-gram level. Both were measured
 * on the same streaming basis (the max over every text prefix, which is the
 * honest false-positive risk because a detector fires mid-stream):
 *
 * ```
 * statistic   fires   highest healthy prefix   threshold   margin
 * lineEcho    8/186        0.7143                 0.9       0.186
 * 8-gram      8/186        0.7667                 0.9       0.133
 * ```
 *
 * The two select exactly the same blocks, so the simpler statistic wins; the
 * n-gram variant is the documented fallback if traffic ever shows a healthy
 * prefix above 0.714. Threshold 0.9 rather than 0.8 is measured too: every real
 * positive scores 1.000 because it copies verbatim, so raising 0.8 -> 0.9 drops
 * nothing and doubles the margin, while still leaving room for a model that adds
 * a line of its own (`21/22 = 0.954`).
 *
 * ## Why 0.9 is safe for legitimate quotation
 *
 * The rule fires only when at least 90% of the text lines are verbatim reasoning
 * lines. A quotation *embedded in prose* does not reach that: measured over a
 * sweep, quoting 80 of 90 reasoning lines and then writing ten new lines scores
 * 0.889 and stays silent, as does a 50-line CJK quotation followed by ten new
 * lines (0.833). Only copying the reasoning as the answer — the failure itself —
 * reaches 1.000. See `tests/echo.spec.ts`, which pins that boundary.
 *
 * ## Ordering assumption
 *
 * The rule needs the reasoning to be complete before the text is judged. Measured
 * across 3,906 assistant messages, reasoning precedes text in **2,522 of 2,522**
 * mixed-content messages and is interleaved in **0** — so the assumption holds on
 * this provider. (It also fails safe: were text to arrive first, the reasoning set
 * would be empty and `lineEcho` would be 0.)
 *
 * @module @t4r71/dsh-stream-guard/echo
 */

import { LINE_MIN_CHARS, lineLabel } from './repeat.ts'

export { lineLabel }

/** Fraction of text lines that must already exist in the reasoning. */
export const ECHO_MIN = 0.9

/**
 * Text lines that must be seen before the fraction is trusted.
 *
 * Measured: the smallest genuine restatement has 22 text lines, and a quotation
 * embedded in ten lines of new prose needs 90 quoted lines to reach the
 * threshold at all, so a gate of 8 is free on real data while keeping the
 * statistic off tiny samples where a 4-of-4 copy would score 1.0.
 */
export const ECHO_MIN_LINES = 8

/** Why R2 considered the visible answer to be a restatement. */
export interface EchoVerdict {
  /** Discriminant, so a caller can tell which layer-two rule spoke. */
  readonly kind: 'echo'
  /** Text lines judged. */
  readonly lines: number
  /** Lines that were already present in the reasoning. */
  readonly hits: number
  /** `hits / lines`, the fraction that crossed the threshold. */
  readonly echo: number
}

/**
 * Incremental cross-channel restatement detector for one assistant message.
 *
 * The reasoning side is a plain label set and the text side a running count, so
 * both feeds are O(1) amortised and the rule holds no text back.
 */
export class EchoGuard {
  /** Labels of the reasoning lines emitted before any text arrived. */
  private readonly reasoning = new Set<string>()
  /** Text lines judged so far. */
  private lines = 0
  /** Text lines that were already reasoning lines. */
  private hits = 0
  /**
   * Text after the last newline, kept **per channel**.
   *
   * Sharing one carry would splice a trailing partial reasoning line onto the
   * first text line and corrupt exactly the comparison this rule makes.
   */
  private reasoningCarry = ''
  private textCarry = ''
  /** The verdict once proven, replayed to every later `feedText`. */
  private verdict: EchoVerdict | null = null

  /**
   * @param min - fraction of text lines that must already be reasoning lines.
   */
  constructor(private readonly min: number = ECHO_MIN) {}

  /**
   * Feed reasoning text, building the reference set.
   *
   * Ignored once a verdict exists: the decision is already made and the set is
   * no longer read.
   *
   * @param delta - the next incremental reasoning text.
   */
  feedReasoning(delta: string): void {
    if (this.verdict !== null) return
    this.reasoningCarry += delta
    let start = 0
    for (;;) {
      const nl = this.reasoningCarry.indexOf('\n', start)
      if (nl === -1) break
      const label = lineLabel(this.reasoningCarry.slice(start, nl))
      if (label.length >= LINE_MIN_CHARS) this.reasoning.add(label)
      start = nl + 1
    }
    this.reasoningCarry = this.reasoningCarry.slice(start)
  }

  /**
   * Feed visible text and judge the fraction already seen in the reasoning.
   * @param delta - the next incremental text for the visible channel.
   * @returns the verdict once the fraction is proven, else `null`.
   */
  feedText(delta: string): EchoVerdict | null {
    if (this.verdict !== null) return this.verdict
    this.textCarry += delta
    let start = 0
    for (;;) {
      const nl = this.textCarry.indexOf('\n', start)
      if (nl === -1) break
      this.addLine(this.textCarry.slice(start, nl))
      start = nl + 1
    }
    this.textCarry = this.textCarry.slice(start)
    return this.verdict
  }

  /**
   * Count one complete text line, and prove the fraction if it has crossed.
   * @param raw - the line, without its terminator.
   */
  private addLine(raw: string): void {
    const label = lineLabel(raw)
    if (label.length < LINE_MIN_CHARS) return
    this.lines += 1
    if (this.reasoning.has(label)) this.hits += 1
    if (this.lines < ECHO_MIN_LINES) return
    const echo = this.hits / this.lines
    if (echo < this.min) return
    this.verdict = { kind: 'echo', lines: this.lines, hits: this.hits, echo }
  }
}

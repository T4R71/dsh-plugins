/**
 * Layer-two rule R1: intra-channel line recycling.
 *
 * ## Why a second layer exists at all
 *
 * The first layer (see `announce.ts`) is a lexicon rule: it only sees filler
 * whose *words* it already knows. Measured on the live corpus, the lexicon rule
 * and the character-period rule are both **blind** to the shape that actually
 * exhausts a context window — a channel recycling a small pool of
 * ordinary-looking lines. The worst measured block re-emitted 10,190 lines drawn
 * from a pool of 118 (rate 87), while the character-period rule saw only a local
 * `period=53, span=618` and the lexicon saw nothing.
 *
 * ## The statistic
 *
 * One division: `lines / distinctLines`. A channel writing new material keeps
 * this near 1; a channel recycling a pool drives it toward the pool size.
 *
 * Measured over 1,656 reasoning blocks (>= 1500 chars) of the live corpus
 * (`tests/verification/verify-two-layer.mts`):
 *
 * ```
 * rate      blocks
 * 1.0-1.1   1354
 * 1.1-1.5     86
 * 1.5-2        6
 * 2-4          4
 * 4-8          2   <- threshold
 * 8-16         0
 * 16-inf       3
 * ```
 *
 * The threshold is 4 rather than this corpus's optimum because 4 is the value
 * calibrated against 735 sessions in the upstream reference this rule is ported
 * from: there, genuine loops ran 7.16-22.99 occurrences per line while code
 * quotations and planning ran 1.40-2.48, leaving roughly 1.6x margin on both
 * sides. The live corpus reproduces that separation — its highest healthy block
 * is 2.66.
 *
 * ## Why this rule needs no holdback
 *
 * The statistic is **monotone**: it is computed from text already received, and
 * a brake acts on the stream *forward* from that point. Nothing already
 * published has to be retracted, so this rule costs no streaming delay — unlike
 * the character-period rule it replaces, whose retrospective window forced a
 * permanent ~1024-character visible lag.
 *
 * ## Termination guarantee
 *
 * With `H` healthy lines, `L` looped lines and `d` distinct looped lines the
 * rate is `(H+L)/(H+d)`; reaching 4 requires `L >= 3H + 4d`. A loop that does
 * not stop grows `L` without bound, so **the rate must eventually cross the
 * threshold**: this rule cannot miss a non-terminating recycle, it can only
 * delay. Measured lag after the repetition actually begins: 225-389 characters.
 *
 * @module @t4r71/dsh-stream-guard/repeat
 */

/**
 * Lines shorter than this are not counted.
 *
 * A bare `}`, `);` or `|` is a legitimate line that can repeat hundreds of
 * times inside one code block or table, so counting it would let ordinary
 * formatting look like a recycle. Pairs with `LINE_MIN_CHARS` in the upstream
 * reference, where the same bound guards the same shape.
 */
export const LINE_MIN_CHARS = 2

/**
 * Lines that must be seen before the rate is trusted.
 *
 * The rate is meaningless on a handful of lines: four identical lines already
 * score 4.0. This gate is what keeps the rule from firing on **hesitation
 * churn**, which is a different disease with a different remedy: a model saying
 * `Wait, that is wrong.` ten times has already finished writing, so truncating
 * it would discard real output, and `hesitation.ts` nudges it instead — never
 * brakes it.
 *
 * Measured on the live corpus, feeding the guard in 64-character chunks and
 * recording the character offset at which each real positive fires:
 *
 * ```
 * positive    fire offset   lines at fire
 * smallest        2560            150
 * others         12096-47616     475-1420
 * 10x churn        209             10   <- must NOT fire
 * ```
 *
 * `REPEAT_MIN_LINES = 32` sits 3.2x above the churn fixture and 4.7x below the
 * smallest genuine positive, so both margins are large.
 *
 * A character floor was evaluated as a second gate and **rejected as
 * impossible**: a grid search showed no `(minLines, minChars)` pair can reject
 * churn at every scale while keeping the 150-line positive, because a 256-line
 * churn (5,375 characters) simply outweighs a 2,560-character real positive.
 * That case needs no gate, though: churn of that size is caught by
 * `judgeHesitation` first, since it judges a 60-line tail as soon as 8 lines
 * are present and steers the turn rather than cutting it.
 */
export const REPEAT_MIN_LINES = 32

/** Repetition rate that proves the channel is recycling its own lines. */
export const REPEAT_MIN = 4

/**
 * Trailing punctuation stripped before comparison.
 *
 * The same sentence may end `.`, `!` or `？` across repeats, so the terminator
 * must not be part of the identity. Both scripts are listed because a Chinese
 * line ends with the fullwidth forms.
 */
const TRAILING_PUNCT = /[.!?。！？,，:：;；]+$/u

/**
 * Reduce a line to the label used for identity comparison.
 *
 * Case, surrounding whitespace and trailing punctuation are not evidence of a
 * new line, so they are normalised away; internal runs of whitespace collapse
 * for the same reason. Digits are deliberately **not** masked: measured on the
 * live corpus, masking found 0 additional loops while making enumerated lists,
 * log lines and tables collide — `Step 1`/`Step 2` became one label.
 *
 * @param line - one raw line, with or without its terminator.
 * @returns the comparison label.
 */
export function lineLabel(line: string): string {
  return line.trim().toLowerCase().replace(TRAILING_PUNCT, '').replace(/\s+/g, ' ')
}

/** Why R1 considered a channel to be recycling. */
export interface RepeatVerdict {
  /** Discriminant, so a caller can tell which layer-two rule spoke. */
  readonly kind: 'repeat'
  /** Lines counted on the channel. */
  readonly lines: number
  /** Distinct labels among them. */
  readonly distinct: number
  /** `lines / distinct`, the statistic that crossed the threshold. */
  readonly rate: number
}

/**
 * Incremental line-recycling detector over one channel.
 *
 * Stateless with respect to the stream's position: it consumes deltas and needs
 * no release cursor, because it never asks for text back.
 */
export class RepeatGuard {
  /** Occurrence count per label; its size is the distinct-line count. */
  private readonly counts = new Map<string, number>()
  /** Complete lines consumed so far. */
  private lines = 0
  /** Text after the last newline: an unterminated line, not yet countable. */
  private carry = ''
  /** The verdict once proven, replayed to every later `feed`. */
  private verdict: RepeatVerdict | null = null

  /**
   * Feed one text delta.
   *
   * Only complete lines are judged, so a partially streamed line can never
   * contribute a bogus label. Splitting on the accumulated buffer rather than on
   * the delta is what makes the result independent of how the provider chunks
   * the stream.
   *
   * @param delta - the next incremental text for this channel.
   * @returns the verdict once the rate is proven, else `null`.
   */
  feed(delta: string): RepeatVerdict | null {
    if (this.verdict !== null) return this.verdict
    this.carry += delta
    let start = 0
    for (;;) {
      const nl = this.carry.indexOf('\n', start)
      if (nl === -1) break
      this.addLine(this.carry.slice(start, nl))
      start = nl + 1
    }
    this.carry = this.carry.slice(start)
    return this.verdict
  }

  /**
   * Count one complete line, and prove the rate if it has crossed.
   * @param raw - the line, without its terminator.
   */
  private addLine(raw: string): void {
    const label = lineLabel(raw)
    if (label.length < LINE_MIN_CHARS) return
    this.counts.set(label, (this.counts.get(label) ?? 0) + 1)
    this.lines += 1
    if (this.lines < REPEAT_MIN_LINES) return
    const rate = this.lines / this.counts.size
    if (rate < REPEAT_MIN) return
    this.verdict = { kind: 'repeat', lines: this.lines, distinct: this.counts.size, rate }
  }
}

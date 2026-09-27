/**
 * Layer-two R1: intra-channel line recycling.
 *
 * The rule is one division — `lines / distinctLines >= 4` — so the suite is mostly
 * about the two gates that keep it off healthy traffic and off the *other*
 * disease:
 *
 * - `LINE_MIN_CHARS` keeps structural noise (a bare `}`, a table row) out of the
 *   counts, where it can repeat hundreds of times legitimately.
 * - `REPEAT_MIN_LINES` keeps the rule off short hesitation churn, which is already
 *   written and must not be truncated. Measured, the 10-line churn fixture fires
 *   at 209 characters while the smallest genuine positive fires at 2,560.
 *
 * Every case is re-run at several delta sizes: the statistic is over complete
 * lines, so the provider's chunking must not change the verdict.
 */
import { describe, expect, it } from 'vitest'
import { LINE_MIN_CHARS, REPEAT_MIN, REPEAT_MIN_LINES, RepeatGuard, lineLabel } from '../src/repeat.ts'

/** The verdict shape, taken from the method rather than imported by name. */
type Verdict = NonNullable<ReturnType<RepeatGuard['feed']>>

/** Newline terminate a set of lines, as a streaming channel would. */
function block(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`
}

/** A channel recycling `distinct` lines `times` each. */
function pool(distinct: number, times: number): string {
  const lines: string[] = []
  for (let t = 0; t < times; t += 1) {
    for (let d = 0; d < distinct; d += 1) {
      lines.push(`Recovering the same intermediate state for case ${d}`)
    }
  }
  return block(lines)
}

/** A channel writing `n` distinct lines, never repeating one. */
function healthy(n: number): string {
  return block(Array.from(
    { length: n },
    (_, i) => `Examining case ${i}, which requires its own reasoning about the frame order`,
  ))
}

/** One exact line, repeated `n` times. */
function repeated(line: string, n: number): string {
  return block(Array.from({ length: n }, () => line))
}

/** Feed a string in fixed-size chunks, returning the first verdict. */
function feedInChunks(guard: RepeatGuard, text: string, size: number): Verdict | null {
  let seen: Verdict | null = null
  for (let i = 0; i < text.length; i += size) {
    const v = guard.feed(text.slice(i, i + size))
    if (v !== null && seen === null) seen = v
  }
  return seen
}

/** The verdict for one case at the default single-delta feed. */
function judge(text: string): Verdict | null {
  return new RepeatGuard().feed(text)
}

// ---------------------------------------------------------------------------

describe('repeat: constants', () => {
  it('exposes the frozen thresholds', () => {
    expect(REPEAT_MIN).toBe(4)
    expect(REPEAT_MIN_LINES).toBe(32)
    expect(LINE_MIN_CHARS).toBe(2)
  })

  it('normalises a line to a stable label', () => {
    expect(lineLabel('  Recovering State.  ')).toBe('recovering state')
    // Digits are preserved: masking them was measured to find zero extra loops
    // while collapsing enumerated lists onto a single label.
    expect(lineLabel('case 1')).not.toBe(lineLabel('case 2'))
  })
})

describe('repeat: must trigger', () => {
  it('fires on a pool recycled many times', () => {
    const v = judge(pool(20, 60))
    expect(v).not.toBeNull()
    expect(v?.distinct).toBe(20)
    expect(v?.rate).toBeGreaterThanOrEqual(REPEAT_MIN)
  })

  it('fires on a single line repeated without bound', () => {
    const v = judge(repeated('Still working on exactly the same thing', 80))
    expect(v).not.toBeNull()
    expect(v?.distinct).toBe(1)
  })

  it('fires on the smallest real positive shape: 150 lines at rate 4.17', () => {
    // Taken from the corpus: session-d531c71b fires at 2,560 characters with 150
    // lines counted. Reproduce the rate, not the content.
    const v = judge(pool(36, 5))
    expect(v).not.toBeNull()
    expect(v?.lines).toBeGreaterThanOrEqual(REPEAT_MIN_LINES)
  })

  it('fires on a CJK pool', () => {
    const lines: string[] = []
    for (let t = 0; t < 5; t += 1) {
      for (let d = 0; d < 20; d += 1) lines.push(`重新检查第${d}个模块的不变式`)
    }
    expect(judge(block(lines))).not.toBeNull()
  })
})

describe('repeat: must not trigger', () => {
  it('stays silent on healthy distinct output', () => {
    expect(judge(healthy(400))).toBeNull()
  })

  it('stays silent on short hesitation churn, which is a different disease', () => {
    // Measured: ten lines of churn fire at 209 characters, where the smallest
    // genuine positive needs 2,560. Churn is already written, so `hesitation.ts`
    // nudges it; truncating it would discard real output.
    expect(judge(repeated('Wait, that is wrong.', 10))).toBeNull()
  })

  it('stays silent on churn that varies its wording, as real churn does', () => {
    // The realistic shape: the same complaint, reworded each time, so the rate
    // stays at 1 no matter how long the churn runs.
    const varied = block(Array.from(
      { length: 400 },
      (_, i) => `Wait, that is wrong for reason ${i} and I should reconsider the approach`,
    ))
    expect(judge(varied)).toBeNull()
  })

  it('fires on one exact line repeated past every plausible churn, and that is right', () => {
    // Measured across every text block in the live corpus, the longest run of
    // *identical* consecutive lines is 4. Churn varies its wording (`Hmm`, then
    // `Wait`, then `Actually`); it does not repeat one exact sentence 40 times.
    // Forty identical lines is a channel that cannot terminate, so the rule must
    // fire — an earlier draft of this suite asserted the opposite and was wrong.
    const v = judge(repeated('Wait, that is wrong.', 40))
    expect(v).not.toBeNull()
    expect(v?.distinct).toBe(1)
  })

  it('stays silent below the minimum line count even at an extreme rate', () => {
    const few = repeated('Same line', REPEAT_MIN_LINES - 1)
    expect(judge(few)).toBeNull()
  })

  it('ignores lines shorter than the structural floor', () => {
    // A bare `}` repeats legitimately hundreds of times inside one code block.
    expect(judge(block(Array.from({ length: 400 }, () => '}')))).toBeNull()
    // Whitespace-only lines collapse to an empty label, so they never count.
    expect(judge(block(Array.from({ length: 400 }, () => ' ')))).toBeNull()
  })

  it('stays silent on ordinary code quoted a few times', () => {
    const code = block([
      'function f() {',
      '  if (a) { return 1 }',
      '  if (b) { return 2 }',
      '  if (c) { return 3 }',
      '  return 0',
      '}',
    ])
    expect(judge(code)).toBeNull()
  })
})

describe('repeat: streaming independence', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['recycled pool', pool(20, 60)],
    ['healthy output', healthy(400)],
    ['short churn', repeated('Wait, that is wrong.', 10)],
    ['varied churn', block(Array.from({ length: 200 }, (_, i) => 'Wait, reason ' + String(i)))] ,
  ]

  for (const [label, text] of cases) {
    it(`gives the same verdict for "${label}" at every delta size`, () => {
      const expected = feedInChunks(new RepeatGuard(), text, 1_000_000) !== null
      for (const size of [1, 7, 64, 4096]) {
        expect(feedInChunks(new RepeatGuard(), text, size) !== null, `size ${size}`).toBe(expected)
      }
    })
  }

  it('never revises a verdict once it has fired', () => {
    const g = new RepeatGuard()
    const first = g.feed(pool(20, 60))
    expect(first).not.toBeNull()
    expect(g.feed(healthy(100))).toBe(first)
  })

  it('does not count a line that has not been terminated', () => {
    // An unterminated final line is waited for, never guessed at.
    const g = new RepeatGuard()
    expect(g.feed('Same line')).toBeNull()
    expect(g.feed(repeated('Same line', 40))).not.toBeNull()
  })
})

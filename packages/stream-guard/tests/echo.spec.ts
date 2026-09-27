/**
 * Layer-two R2: cross-channel verbatim restatement.
 *
 * This file exists because of a fair objection: an earlier draft called the
 * "legitimate long quotation" shape an untestable blind spot. It is not. The
 * shape is *generatable*, so the boundary is pinned here by construction rather
 * than asserted in prose.
 *
 * The suite has four parts:
 *
 * - **must trigger.** Eight real blocks restate the reasoning as the answer,
 *   verbatim, with text length equal to reasoning length to within two
 *   characters. The degenerate case below reproduces that shape.
 * - **must not trigger.** A quotation *embedded in prose* — the benign
 *   look-alike, and the reason this rule could plausibly be dangerous.
 * - **the streaming basis.** The rule judges the *running* fraction, so the same
 *   finished block behaves differently depending on how the quotation is
 *   arranged. That is pinned explicitly, because it is the difference between a
 *   legitimate long quotation and the failure this rule detects.
 * - **streaming independence.** Every case is re-run at several delta sizes and
 *   must produce an identical verdict.
 */
import { describe, expect, it } from 'vitest'
import { ECHO_MIN, ECHO_MIN_LINES, EchoGuard, lineLabel } from '../src/echo.ts'

/** The verdict shape, taken from the method rather than imported by name. */
type Verdict = NonNullable<ReturnType<EchoGuard['feedText']>>

// ---------------------------------------------------------------------------
// Generators. Both sides of the boundary come from the same code path, so the
// only difference between a legitimate quotation and a restatement is how the
// lines are arranged.
// ---------------------------------------------------------------------------

/**
 * Reasoning of `n` distinct, realistically-sized lines.
 *
 * Newline terminated: an unterminated final line is not yet countable, so a
 * fixture missing the trailing newline silently contributes one line fewer.
 */
function reasoning(n: number): string {
  const lines = Array.from(
    { length: n },
    (_, i) => `Step ${i}: the assembler preserves ordering across frames, so the invariant holds`,
  )
  return `${lines.join('\n')}\n`
}

/** New prose sharing no line with any reasoning fixture. */
function prose(n: number): string {
  const lines = Array.from(
    { length: n },
    (_, i) => `Conclusion ${i}: I recommend changing the module boundary in this specific way`,
  )
  return `${lines.join('\n')}\n`
}

/**
 * A quotation **interleaved** with new prose, which is how real quotation reads.
 *
 * This distinction matters more than it looks. The rule judges the **running**
 * fraction as the text streams, not the finished block, so the two arrangements
 * have identical finished statistics and different behaviour:
 *
 * - interleaved: the running fraction dips below the threshold on every prose
 *   line, so the rule never fires — a legitimate long quotation;
 * - quoted-first (see `quotationThenProse`): eight consecutive verbatim
 *   reasoning lines with no prose between them *is* the detected shape, and the
 *   rule fires there correctly.
 *
 * A fixture that quarantines the quotation at the front is therefore more
 * adversarial than real traffic, and only the interleaved form models a
 * legitimate long quotation.
 */
function interleaved(total: number, k: number, p: number): string {
  const quoted = reasoning(total).trim().split('\n').slice(0, k)
  const fresh = prose(p).trim().split('\n')
  const out: string[] = []
  let q = 0
  let f = 0
  while (q < quoted.length || f < fresh.length) {
    const qFirst = out.length % 2 === 0
    const next = qFirst ? quoted[q] : fresh[f]
    if (next !== undefined && qFirst) { out.push(next); q += 1 }
    else if (fresh[f] !== undefined) { out.push(fresh[f] as string); f += 1 }
    else if (quoted[q] !== undefined) { out.push(quoted[q] as string); q += 1 }
  }
  return `${out.join('\n')}\n`
}

/** Quote the first `k` reasoning lines, then write `p` lines of new prose. */
function quotationThenProse(total: number, k: number, p: number): string {
  const quoted = reasoning(total).trim().split('\n').slice(0, k)
  return `${[...quoted, ...prose(p).trim().split('\n')].join('\n')}\n`
}

/** Feed a string in fixed-size chunks, returning the first verdict. */
function feedInChunks(guard: EchoGuard, ref: string, text: string, size: number): Verdict | null {
  for (let i = 0; i < ref.length; i += size) guard.feedReasoning(ref.slice(i, i + size))
  let seen: Verdict | null = null
  for (let i = 0; i < text.length; i += size) {
    const v = guard.feedText(text.slice(i, i + size))
    if (v !== null && seen === null) seen = v
  }
  return seen
}

/** The verdict for one case at the default single-delta feed. */
function judge(ref: string, text: string): Verdict | null {
  const g = new EchoGuard()
  g.feedReasoning(ref)
  return g.feedText(text)
}

/** The finished-block fraction, which is what a non-streaming detector would see. */
function finishedEcho(ref: string, text: string): number {
  const labels = new Set(ref.trim().split('\n').map(lineLabel))
  const tl = text.trim().split('\n')
  return tl.filter(l => labels.has(lineLabel(l))).length / tl.length
}

// ---------------------------------------------------------------------------

describe('echo: constants', () => {
  it('exposes the frozen thresholds', () => {
    expect(ECHO_MIN).toBe(0.9)
    expect(ECHO_MIN_LINES).toBe(8)
  })

  it('normalises case, surrounding space and trailing punctuation only', () => {
    // Digits are deliberately preserved: masking them was measured to find zero
    // extra loops while collapsing enumerated lists onto one label.
    expect(lineLabel('  Wait, That Is Wrong.  ')).toBe('wait, that is wrong')
    expect(lineLabel('Step 1')).not.toBe(lineLabel('Step 2'))
  })

  it('treats the CJK terminators as terminators', () => {
    expect(lineLabel('现在。')).toBe('现在')
    expect(lineLabel('现在！')).toBe('现在')
  })
})

describe('echo: must trigger', () => {
  it('fires on a verbatim restatement of the whole reasoning', () => {
    const ref = reasoning(40)
    const v = judge(ref, ref)
    expect(v).not.toBeNull()
    expect(v?.echo).toBe(1)
    expect(v?.hits).toBe(v?.lines)
  })

  it('fires when the text differs from the reasoning only by trailing whitespace', () => {
    const ref = reasoning(40)
    const text = ref.trim().split('\n').map(l => l + '  ').join('\n') + '\n'
    expect(judge(ref, text)).not.toBeNull()
  })

  it('fires on a restatement that adds one line of its own', () => {
    // The real corpus has a positive at exactly this shape: 20 of 21 lines
    // lifted, a finished fraction of 0.952.
    const ref = reasoning(40)
    const text = quotationThenProse(40, 20, 1)
    expect(judge(ref, text)).not.toBeNull()
    expect(finishedEcho(ref, text)).toBeCloseTo(20 / 21, 6)
  })

  it('fires on a CJK restatement', () => {
    const ref = Array.from({ length: 30 }, (_, i) => `第${i}步：检查模块的不变式是否仍然成立`).join('\n') + '\n'
    expect(judge(ref, ref)).not.toBeNull()
  })
})

describe('echo: must not trigger', () => {
  it('stays silent on reasoning that is never restated', () => {
    expect(judge(reasoning(40), prose(40))).toBeNull()
  })

  it('stays silent below the minimum line count', () => {
    // Identical lines score 1.0 but are too thin to judge.
    for (const n of [4, 7]) {
      expect(judge(reasoning(40), reasoning(40).trim().split('\n').slice(0, n).join('\n') + '\n')).toBeNull()
    }
  })

  it('ignores reasoning lines too short to be a label', () => {
    // The same structural floor R1 uses: a bare `}` or a blank line is noise, so
    // it must not enter the reference set and make a text line look lifted.
    const g = new EchoGuard()
    g.feedReasoning('}\n\n-\n')
    expect(g.feedText('}\n\n-\n}\n\n-\n}\n\n-\n}\n\n-\n')).toBeNull()
  })

  it('stays silent when text arrives before any reasoning', () => {
    // The ordering assumption fails safe: an empty reference means no hits.
    const g = new EchoGuard()
    expect(g.feedText(reasoning(40))).toBeNull()
  })

  it('stays silent on an interleaved quotation at every quoted fraction', () => {
    const total = 60
    // Measured boundary: every fraction up to 0.88 stays silent even when the
    // quotation is interleaved one-for-one with prose. 0.95 is deliberately
    // excluded — at that point 57 of 60 lines are verbatim reasoning, which is
    // no longer a quotation embedded in prose but a copy with a tail.
    for (const fraction of [0.1, 0.3, 0.5, 0.7, 0.8, 0.85, 0.88]) {
      const k = Math.round(total * fraction)
      const ref = reasoning(total)
      // p chosen so the FINISHED fraction is k/(k+p) = the requested fraction.
      const p = Math.max(1, Math.round(k / fraction) - k)
      const text = interleaved(total, k, p)
      expect(judge(ref, text), `fraction ${fraction} should be safe`).toBeNull()
      // And it really is a quotation: the finished block is that fraction lifted
      // (interleaving changes the order, not the composition).
      expect(finishedEcho(ref, text)).toBeCloseTo(fraction, 1)
    }
  })

  it('stays silent on a long interleaved quotation of 80 of 90 lines', () => {
    const ref = reasoning(200)
    const text = interleaved(200, 80, 10)
    expect(judge(ref, text)).toBeNull()
  })

  it('stays silent on a long CJK quotation interleaved with new prose', () => {
    const ref = Array.from({ length: 100 }, (_, i) => `第${i}步：检查模块的不变式是否仍然成立`).join('\n') + '\n'
    const quoted = ref.trim().split('\n').slice(0, 50)
    const fresh = prose(10).trim().split('\n')
    const out: string[] = []
    for (let i = 0; i < Math.max(quoted.length, fresh.length); i += 1) {
      if (quoted[i] !== undefined) out.push(quoted[i] as string)
      if (fresh[i] !== undefined) out.push(fresh[i] as string)
    }
    expect(judge(ref, out.join('\n') + '\n')).toBeNull()
  })
})

describe('echo: the streaming basis', () => {
  it('judges the running fraction, not the finished block', () => {
    // Same finished composition, opposite verdicts. This is the whole reason
    // a streaming rule cannot be evaluated on the end-of-block statistic.
    const ref = reasoning(60)
    const front = quotationThenProse(60, 18, 22)
    const woven = interleaved(60, 18, 22)
    expect(finishedEcho(ref, front)).toBeLessThan(0.5)
    expect(finishedEcho(ref, woven)).toBeLessThan(0.5)
    // Quoted-first fires: 18 consecutive verbatim reasoning lines with no prose
    // between them is precisely the detected shape.
    expect(judge(ref, front)).not.toBeNull()
    // Interleaved does not: every prose line pulls the running fraction down.
    expect(judge(ref, woven)).toBeNull()
  })

  it('crosses over only once the running fraction is sustained', () => {
    const ref = reasoning(200)
    // 8 straight quoted lines: 1.0 at the moment of decision.
    expect(judge(ref, quotationThenProse(200, 8, 20))).not.toBeNull()
    // 7 straight quoted lines: below the minimum line gate.
    expect(judge(ref, quotationThenProse(200, 7, 20))).toBeNull()
  })
})

describe('echo: streaming independence', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['verbatim restatement', reasoning(40)],
    ['benign interleaved quotation', interleaved(200, 80, 10)],
    ['quoted-first quotation', quotationThenProse(200, 18, 22)],
    ['no restatement', prose(40)],
  ]

  for (const [label, text] of cases) {
    it(`gives the same verdict for "${label}" at every delta size`, () => {
      const ref = reasoning(200)
      const expected = feedInChunks(new EchoGuard(), ref, text, 1_000_000) !== null
      for (const size of [1, 7, 64, 4096]) {
        expect(feedInChunks(new EchoGuard(), ref, text, size) !== null, `size ${size}`).toBe(expected)
      }
    })
  }

  it('never revises a verdict once it has fired', () => {
    const g = new EchoGuard()
    const ref = reasoning(40)
    g.feedReasoning(ref)
    const first = g.feedText(ref)
    expect(first).not.toBeNull()
    expect(g.feedText(prose(40))).toBe(first)
  })

  it('ignores reasoning fed after the verdict', () => {
    const g = new EchoGuard()
    g.feedReasoning(reasoning(40))
    const first = g.feedText(reasoning(40))
    expect(first).not.toBeNull()
    g.feedReasoning(prose(40))
    expect(g.feedText(prose(40))).toBe(first)
  })

  it('does not splice a partial reasoning line onto a text line', () => {
    // Each channel keeps its own carry. Sharing one would join the reasoning's
    // unterminated tail to the first text line and corrupt the comparison.
    const g = new EchoGuard()
    g.feedReasoning('a shared unterminated tail')
    g.feedText('\na shared unterminated tail\n')
    expect(g.feedText(prose(20))).toBeNull()
  })
})

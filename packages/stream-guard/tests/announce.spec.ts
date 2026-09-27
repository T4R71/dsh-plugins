/**
 * The `prefix` rule: a stream that keeps restating its intent.
 *
 * Contracts pinned here come from the rule's frozen specification — §2 mechanism, §3 lexicon and
 * thresholds, §4 acceptance behaviour, §7 conventions.
 *
 * The suite has two halves, and the second one matters more:
 *
 * - **must trigger.** A stalled model emits short intent lines and bare filler
 *   words. §3.7 measured 22.56% of all reasoning lines in the corpus to be that
 *   shape, so a miss here means the rule does nothing.
 * - **must not trigger.** The v1 design (opening matched with no length cap) braked
 *   healthy work 17 times out of 17 triggers on real reasoning. The load-bearing
 *   gate is `ANNOUNCE_MAX = 18` (§3.5): a real planning sentence opens with `Let me`
 *   and then keeps going. Every case below is a shape taken from the corpus or from
 *   the measured false positive, not an invented one.
 *
 * Streaming independence (§2.7) is asserted by re-running every corpus case at five
 * delta sizes and requiring an identical verdict.
 */
import { describe, expect, it } from 'vitest'
import {
  FILLER_WORDS,
  INTENT_PREFIXES,
  ANNOUNCE_MAX,
  ANNOUNCE_COUNT,
  ANNOUNCE_GAP,
  AnnounceGuard,
} from '../src/announce.ts'

/**
 * The verdict shape, taken from the method rather than imported by name: the type
 * name is not part of the frozen interface, so a rename must not break the suite.
 */
type Verdict = NonNullable<ReturnType<AnnounceGuard['feed']>>

// ---------------------------------------------------------------------------
// Text helpers. Every fixture is newline terminated: §2.7 says an unterminated
// clause must be waited for, never guessed at, so a trailing newline is what makes
// the last fixture clause decidable.
// ---------------------------------------------------------------------------

/** One clause per line. */
function lines(...clauses: readonly string[]): string {
  let text = ''
  for (const clause of clauses) text += `${clause}\n`
  return text
}

/** `count` copies of one clause, one per line. */
function repeat(clause: string, count: number): string {
  return lines(...Array.from({ length: count }, () => clause))
}

/** Split `text` the way a provider fragments a stream. */
function split(text: string, size: number): string[] {
  const chars = Array.from(text)
  const step = Math.max(1, size)
  const pieces: string[] = []
  for (let i = 0; i < chars.length; i += step) {
    pieces.push(chars.slice(i, i + step).join(''))
  }
  return pieces
}

function feedAll(guard: AnnounceGuard, pieces: readonly string[]): Verdict | null {
  let verdict: Verdict | null = null
  for (const piece of pieces) {
    const got = guard.feed(piece)
    if (got !== null && verdict === null) verdict = got
  }
  return verdict
}

/** Feed `text` as a single delta. */
function judge(text: string): Verdict | null {
  return feedAll(new AnnounceGuard(), [text])
}

/** Feed `text` in `delta`-character pieces. */
function judgeStreamed(text: string, delta: number): Verdict | null {
  return feedAll(new AnnounceGuard(), split(text, delta))
}

/** Assert the run is braked, and braked exactly at the count limit. */
function expectFlood(text: string): void {
  const verdict = judge(text)
  expect(verdict, `expected a verdict for: ${JSON.stringify(text.slice(0, 70))}`).not.toBeNull()
  if (verdict === null) return
  expect(verdict.count).toBe(ANNOUNCE_COUNT)
  expect(verdict.charsSeen).toBeGreaterThan(0)
  expect(verdict.charsSeen).toBeLessThanOrEqual(text.length)
  expect(typeof verdict.opener).toBe('string')
  expect(verdict.opener.length).toBeGreaterThan(0)
  // Whatever case the reporter normalises to, the opening is a slice of the stream.
  expect(text.toLowerCase()).toContain(verdict.opener.toLowerCase())
}

/** Assert the run is left alone. */
function expectQuiet(text: string): void {
  expect(judge(text), `expected no verdict for: ${JSON.stringify(text.slice(0, 70))}`).toBeNull()
}

// ---------------------------------------------------------------------------
// §4 必须触发 fixtures
// ---------------------------------------------------------------------------

/** The canonical flood: one short intent line, repeated verbatim. */
const INTENT_WRITE = repeat('Let me write.', 5)

/**
 * Wording drift. Each line is its own kind of joint: intent (a), filler word (b),
 * filler word (b), filler word (b), intent (a) at exactly 18 characters.
 */
const DRIFT = lines('Let me write.', 'Writing.', 'Producing.', 'OK.', 'Let me just do it.')

/** No internal newline: clause starts come from sentence terminators alone. */
const INLINE = 'Let me check. Let me look. Let me verify. Let me read. Let me write. \n'

/** Chinese intent prefix, whole line far inside the cap. */
const CHINESE = repeat('让我看看。', 5)

/**
 * Out-of-table content between joints. Widest gap is `write.` + `x` = 7 effective
 * characters, well inside the tolerance, so the run survives.
 */
const WITH_NOISE = lines(
  'Let me write.',
  'x',
  'Writing.',
  'y',
  'Producing.',
  'z',
  'OK.',
  'w',
  'Let me just do it.',
)

// ---------------------------------------------------------------------------
// §4 必须不触发 fixtures
// ---------------------------------------------------------------------------

/**
 * §3.5 in one fixture: a real planning sentence. It opens with `Let me`, so the
 * only thing separating it from filler is the whole-line length.
 */
const PLANNING_LINE = 'Let me check the config number 3 before I continue.'
const LONG_PLANNING = repeat(PLANNING_LINE, 8)

/** The 187-character corpus line §3.5 names, trimmed to its opening. */
const HARNESS_LINE_TEXT =
  'Let me also check the harness identity is suppressed with complete — HARNESS_IDENTITY is order -1000'
const HARNESS_LINE = repeat(HARNESS_LINE_TEXT, 8)

/**
 * Healthy work: joints that really are joints, separated by real prose. Without the
 * tolerance reset the counter would reach the limit here, so this fixture is what
 * proves step 5 of §2 works.
 */
const HEALTHY = lines(
  'Let me write.',
  'The parser reads tokens from the buffer and pushes them into the queue in order.',
  'Writing.',
  'Timeout is thirty seconds and the retry count is three by default in this build.',
  'Producing.',
  'The output contains the full text of every assistant message that was streamed.',
  'OK.',
  'Imports resolve through the workspace protocol and are checked by the project build.',
  'Let me read.',
  'The patch changes only one file and keeps every other line exactly as it was.',
)

/** Ordinary prose: no clause opens with an intent prefix. */
const PROSE = lines(
  'The guard scans the stream and counts the joints it recognises.',
  'A joint has to sit at the start of a clause, which is the buffer start, a newline, or a sentence terminator.',
  'Ordinary writing mentions intent markers, but not where this rule is looking.',
  'A healthy model explains what it found, quotes the evidence, and names the next concrete step.',
)

/** Markdown structure. */
const TABLE = lines(
  '| Rule | Tolerance | Limit |',
  '| --- | --- | --- |',
  '| prefix | 20 chars | 5 joints |',
  '| filler | 20 chars | 8 lines |',
  '| cycle | exact period | 3 repeats |',
)

/** A code listing. */
const CODE = lines(
  '```ts',
  'export function clamp(value: number, low: number, high: number): number {',
  '  if (value < low) return low',
  '  if (value > high) return high',
  '  return value',
  '}',
  '```',
)

/**
 * §3.4, the measured false positive: a model writing test data. `Writing.`,
 * `Producing.` and `Emitting.` are table-B words, but `Output.` and `Executing.`
 * are the entries §3.4 deleted, so this block holds only three joints — one short of
 * the limit. The fence lines stay in the fixture on purpose: the escape is the
 * lexicon, not any notion of a code block.
 */
const FILLER_LIST_CODE = lines('```', 'Writing.', 'Producing.', 'Output.', 'Executing.', 'Emitting.', '```')

/**
 * The control for the fixture above: the same block made only of table-B words does
 * brake, which is what shows the code-block test is not vacuous.
 */
const FILLER_LIST_TABLE_ONLY = lines('```', 'Writing.', 'Producing.', 'Emitting.', 'Final.', 'Here.', '```')

/**
 * Every line opens with a lexicon word and keeps going, so whole-line matching is
 * the only thing keeping these quiet.
 */
const EMBEDDED = lines(
  'Now the parser reads the buffer and emits tokens in the order they arrive.',
  'Write the number of effective characters into the counter on every single step.',
  'Here the guard resets its counter once the tolerance has been exceeded.',
  'Go through every branch of the switch and check the fallthrough in each case.',
  'Final answer assembled only after every delta has been scanned by the state.',
  'Ok the fallback branch never runs because the first condition always holds.',
)

/**
 * Intent markers inside sentences — never at a clause start. The v1 rule matched
 * these, which is why it braked healthy work.
 */
const MID_SENTENCE = lines(
  'The parser stops when I want to read the next token from a queue that is empty.',
  'The retry loop ends only then I think the gap has exceeded the tolerance we set.',
  'A caller may ask whether I should keep scanning after the verdict has fired.',
  'It is not obvious that I need to keep the whole buffer in memory for this rule.',
  'The spec says that next I check the list of joints at every clause start here.',
  'Nothing in the run tells us that I am going to stop before the limit is reached.',
  'Teams rarely document why I will keep a counter that long content resets.',
  'The log shows that now I understand the shape of the failure we are chasing.',
)

/** Table-A shaped fragments that must fail the word boundary. */
const NEAR_MISS = lines('letter', 'letterbox', 'let men', 'let mew', 'nowhere', 'now items', 'now it', 'now is')

// ---------------------------------------------------------------------------
// §3 lexicon and thresholds
// ---------------------------------------------------------------------------

const TABLE_A_LATIN = [
  'let me',
  'let us',
  "let's",
  "i'll",
  'i will',
  'i need to',
  'i should',
  'i want to',
  'i am going to',
  "i'm going to",
  'now let me',
  'now i',
  'next i',
  'then i',
]
const TABLE_A_CJK = ['让我', '我先', '我需要', '接下来', '现在我']

const TABLE_B_LATIN = ['ok', 'go', 'now', 'write', 'emit', 'here', 'final', 'writing', 'producing', 'emitting']
const TABLE_B_CJK = ['好', '现在', '写', '输出', '生成', '写入', '接下去', '执行']

/** §3.4: added by the v1 design, removed because they only produced a false positive. */
const TABLE_B_FORBIDDEN = ['output', 'continue', 'done', 'execute', 'executing']

const lower = (values: readonly string[]): Set<string> => new Set(values.map(value => value.toLowerCase()))

describe('§3 lexicon and thresholds', () => {
  it('exposes the frozen thresholds', () => {
    expect(ANNOUNCE_GAP).toBe(20)
    expect(ANNOUNCE_COUNT).toBe(5)
    expect(ANNOUNCE_MAX).toBe(18)
  })

  it('carries every table-A intent prefix', () => {
    const table = lower(INTENT_PREFIXES)
    for (const prefix of TABLE_A_LATIN.concat(TABLE_A_CJK)) {
      expect(table.has(prefix), `table A is missing ${prefix}`).toBe(true)
    }
  })

  it('carries every table-B filler word', () => {
    const table = lower(FILLER_WORDS)
    for (const word of TABLE_B_LATIN.concat(TABLE_B_CJK)) {
      expect(table.has(word), `table B is missing ${word}`).toBe(true)
    }
  })

  it('§3.4 keeps the five unmeasured words out of table B', () => {
    const table = lower(FILLER_WORDS)
    for (const word of TABLE_B_FORBIDDEN) {
      expect(table.has(word), `table B must not contain ${word}`).toBe(false)
    }
  })

  it('table A does not carry a bare `let`, which would defeat the boundary rule', () => {
    expect(lower(INTENT_PREFIXES).has('let')).toBe(false)
  })

  // Every table entry has to work as a joint on its own, otherwise a word can sit in
  // the table and never match.

  const SHORT_INTENT_LINES: ReadonlyArray<readonly [string, string]> = [
    ['let me', 'Let me write.'],
    ['let us', 'Let us write.'],
    ["let's", "Let's write."],
    ["i'll", "I'll write."],
    ['i will', 'I will write.'],
    ['i need to', 'I need to write.'],
    ['i should', 'I should write.'],
    ['i want to', 'I want to write.'],
    ['i am going to', 'I am going to go.'],
    ["i'm going to", "I'm going to do."],
    ['now let me', 'Now let me write.'],
    ['now i', 'Now I write.'],
    ['next i', 'Next I write.'],
    ['then i', 'Then I write.'],
    ['让我', '让我看看。'],
    ['我先', '我先看看。'],
    ['我需要', '我需要看看。'],
    ['接下来', '接下来我看。'],
    ['现在我', '现在我看看。'],
  ]

  for (const [prefix, line] of SHORT_INTENT_LINES) {
    it(`table A ${prefix} brakes when it repeats on short lines`, () => {
      expect(line.length, `${line} must be a short line`).toBeLessThanOrEqual(ANNOUNCE_MAX)
      expectFlood(repeat(line, 5))
    })
  }

  const FILLER_LINES: ReadonlyArray<readonly [string, string]> = [
    ['ok', 'OK.'],
    ['go', 'Go.'],
    ['now', 'Now.'],
    ['write', 'Write.'],
    ['emit', 'Emit.'],
    ['here', 'Here.'],
    ['final', 'Final.'],
    ['writing', 'Writing.'],
    ['producing', 'Producing.'],
    ['emitting', 'Emitting.'],
    ['好', '好。'],
    ['现在', '现在。'],
    ['写', '写。'],
    ['输出', '输出。'],
    ['生成', '生成。'],
    ['写入', '写入。'],
    ['接下去', '接下去。'],
    ['执行', '执行。'],
  ]

  for (const [word, line] of FILLER_LINES) {
    it(`table B ${word} brakes as a whole line`, () => {
      expectFlood(repeat(line, 5))
    })
  }
})

// ---------------------------------------------------------------------------
// §4 必须触发
// ---------------------------------------------------------------------------

describe('§4 must trigger', () => {
  it('a short intent line repeated verbatim', () => {
    expectFlood(INTENT_WRITE)
  })

  it('wording drift: intent, filler, filler, filler, intent', () => {
    expectFlood(DRIFT)
  })

  it('no internal newline: sentence terminators alone start the clauses', () => {
    expectFlood(INLINE)
  })

  it('Chinese intent prefix', () => {
    expectFlood(CHINESE)
  })

  it('out-of-table content between joints, inside the tolerance', () => {
    expectFlood(WITH_NOISE)
  })

  it('a code block of table-B words (control for the §3.4 fixture)', () => {
    expectFlood(FILLER_LIST_TABLE_ONLY)
  })
})

// ---------------------------------------------------------------------------
// §4 必须不触发 — the half that matters
// ---------------------------------------------------------------------------

describe('§4 must not trigger', () => {
  it('the false-positive fixtures really are longer than the cap', () => {
    expect(PLANNING_LINE.length).toBeGreaterThan(ANNOUNCE_MAX)
    expect(HARNESS_LINE_TEXT.length).toBeGreaterThan(ANNOUNCE_MAX)
  })

  it('a real planning sentence that merely opens with `Let me`', () => {
    expectQuiet(LONG_PLANNING)
  })

  it('the long harness-identity line', () => {
    expectQuiet(HARNESS_LINE)
  })

  it('healthy reasoning: joints separated by real prose', () => {
    expectQuiet(HEALTHY)
  })

  it('ordinary prose', () => {
    expectQuiet(PROSE)
  })

  it('a Markdown table', () => {
    expectQuiet(TABLE)
  })

  it('a code listing', () => {
    expectQuiet(CODE)
  })

  it('§3.4: a code block listing filler words as test data', () => {
    expectQuiet(FILLER_LIST_CODE)
  })

  it('lexicon words opening a line that keeps going', () => {
    expectQuiet(EMBEDDED)
  })

  it('intent markers inside sentences', () => {
    expectQuiet(MID_SENTENCE)
  })
})

// ---------------------------------------------------------------------------
// §3 table-A word boundary
// ---------------------------------------------------------------------------

describe('§3 table-A word boundary', () => {
  it('rejects table-A shaped fragments that continue into a longer word', () => {
    expectQuiet(NEAR_MISS)
  })

  it('accepts the same shape when the boundary really ends the opener', () => {
    expectFlood(repeat('Let me just do it.', 5))
    expectFlood(repeat('Now I write.', 5))
  })

  it('`Let me just do it.` sits exactly at the cap', () => {
    expect('Let me just do it.'.length).toBe(ANNOUNCE_MAX)
  })
})

// ---------------------------------------------------------------------------
// §2.5 tolerance boundary
// ---------------------------------------------------------------------------

describe('§2 tolerance', () => {
  it('keeps counting when the gap between joints is exactly the tolerance', () => {
    expectFlood(lines('OK', 'x'.repeat(ANNOUNCE_GAP), 'OK', 'OK', 'OK', 'OK'))
  })

  it('resets the counter when the gap exceeds the tolerance by one character', () => {
    // Five joints, but the first gap resets the count, leaving only four.
    expectQuiet(lines('OK', 'x'.repeat(ANNOUNCE_GAP + 1), 'OK', 'OK', 'OK', 'OK'))
  })

  it('restarts counting after a reset', () => {
    expectFlood(lines('OK', 'x'.repeat(ANNOUNCE_GAP + 1), 'OK', 'OK', 'OK', 'OK', 'OK'))
  })

  it('does not charge whitespace against the tolerance', () => {
    // 12 indented blank lines: far more whitespace than the tolerance, no content.
    expectFlood(lines('OK', ...Array.from({ length: 12 }, () => '   '), 'OK', 'OK', 'OK', 'OK'))
  })

  it('accepts leading whitespace before a joint', () => {
    expectFlood(lines('   OK', '\tOK', '  OK', ' OK', 'OK'))
  })
})

// ---------------------------------------------------------------------------
// §2.5 length boundary
// ---------------------------------------------------------------------------

describe('§2 length boundary', () => {
  it('brakes at the cap with no trailing punctuation in play', () => {
    expect('Let me check a bit'.length).toBe(ANNOUNCE_MAX)
    expectFlood(repeat('Let me check a bit', 5))
  })

  it('leaves a line one character over the cap alone', () => {
    expect('Let me check a flag'.length).toBe(ANNOUNCE_MAX + 1)
    expectQuiet(repeat('Let me check a flag', 8))
  })

  it('measures the length with trailing punctuation still counted (§2.2)', () => {
    // 19 characters raw, 18 once the full stop is removed. The raw length is what
    // counts, so this is NOT a joint. `Let me verify that.` and `Let me
    // investigate.` have exactly this shape, and §3.5 lists both as real work that
    // ANNOUNCE_MAX = 18 exists to exclude.
    expect('Let me check a bit.'.length).toBe(ANNOUNCE_MAX + 1)
    expectQuiet(repeat('Let me check a bit.', 8))
    expectQuiet(repeat('Let me verify that.', 8))
    expectQuiet(repeat('Let me investigate.', 8))
  })
})

// ---------------------------------------------------------------------------
// §2.2 whole-line matching for table B
// ---------------------------------------------------------------------------

describe('§2 table-B whole-line matching', () => {
  it('brakes on bare words and on words with trailing punctuation alike', () => {
    expectFlood(repeat('ok', 5))
    expectFlood(repeat('OK', 5))
    expectFlood(repeat('Writing', 5))
    expectFlood(repeat('Writing.', 5))
  })

  it('does not brake on a filler word embedded in a longer line', () => {
    expectQuiet(EMBEDDED)
  })
})

// ---------------------------------------------------------------------------
// §2.7 streaming independence
// ---------------------------------------------------------------------------

const DELTAS = [1, 3, 7, 64, 1000]

const STREAM_CASES: ReadonlyArray<readonly [string, string, number]> = [
  ['short intent line x5', INTENT_WRITE, ANNOUNCE_COUNT],
  ['wording drift', DRIFT, ANNOUNCE_COUNT],
  ['inline, no newline', INLINE, ANNOUNCE_COUNT],
  ['Chinese', CHINESE, ANNOUNCE_COUNT],
  ['short out-of-table noise', WITH_NOISE, ANNOUNCE_COUNT],
  ['table-B code block control', FILLER_LIST_TABLE_ONLY, ANNOUNCE_COUNT],
  ['real planning sentence', LONG_PLANNING, 0],
  ['long harness-identity line', HARNESS_LINE, 0],
  ['healthy alternation', HEALTHY, 0],
  ['filler-word code block', FILLER_LIST_CODE, 0],
  ['near misses', NEAR_MISS, 0],
  ['whitespace-only gap', lines('OK', ...Array.from({ length: 12 }, () => '   '), 'OK', 'OK', 'OK', 'OK'), ANNOUNCE_COUNT],
]

describe('§2.7 streaming independence', () => {
  for (const [name, text, expected] of STREAM_CASES) {
    it(`${name} reaches the same verdict at every delta size`, () => {
      const whole = judge(text)
      const wholeCount = whole === null ? 0 : whole.count
      expect(wholeCount, 'single-delta verdict').toBe(expected)

      for (const delta of DELTAS) {
        const streamed = judgeStreamed(text, delta)
        expect(
          { delta, count: streamed === null ? 0 : streamed.count },
          `delta ${delta} disagreed with the single-delta verdict`,
        ).toEqual({ delta, count: expected })
      }
    })
  }

  it('does not commit to an opener that is still arriving', () => {
    // `Let me` split across deltas must count once, not zero times and not twice.
    const guard = new AnnounceGuard()
    for (const piece of ['L', 'e', 't', ' ', 'm', 'e', ' ', 'w', 'r', 'i', 't', 'e', '.\n']) {
      expect(guard.feed(piece)).toBeNull()
    }
    // Four more joints to reach the limit; the first one above must be counted.
    const verdict = feedAll(guard, split(repeat('Let me write.', 4), 1))
    expect(verdict).not.toBeNull()
    if (verdict === null) return
    expect(verdict.count).toBe(ANNOUNCE_COUNT)
  })

  it('does not commit to a whole-line word before the line ends', () => {
    // `OK` is a table-B word only once the line is known to end there.
    const guard = new AnnounceGuard()
    expect(guard.feed('OK')).toBeNull()
    expect(guard.feed('X')).toBeNull()
    expect(guard.feed('\n')).toBeNull()
    expect(feedAll(guard, split(repeat('OK', 5), 1))).not.toBeNull()
  })

  it('reports the same opening regardless of delta size', () => {
    const ones = judgeStreamed(DRIFT, 1)
    const whole = judge(DRIFT)
    expect(ones).not.toBeNull()
    expect(whole).not.toBeNull()
    if (ones === null || whole === null) return
    expect(ones.opener.toLowerCase()).toBe(whole.opener.toLowerCase())
  })

  it('exposes the running joint count, not only the final verdict', () => {
    const guard = new AnnounceGuard()
    expect(guard.openings).toBe(0)
    feedAll(guard, split(repeat('Let me write.', 2), 3))
    expect(guard.openings).toBe(2)
  })

  it('treats an empty delta as a no-op', () => {
    // The wiring feeds whole published slices, which can be empty when the filler
    // guard released nothing on this chunk. It must not disturb the scan.
    const guard = new AnnounceGuard()
    expect(guard.feed('')).toBeNull()
    feedAll(guard, split(repeat('Let me write.', 4), 2))
    expect(guard.feed('')).toBeNull()
    expect(guard.feed('')).toBeNull()
    const verdict = guard.feed('Let me write.')
    expect(verdict).not.toBeNull()
    if (verdict === null) return
    expect(verdict.count).toBe(ANNOUNCE_COUNT)
    // Sticky: later deltas keep answering with the same verdict.
    expect(guard.feed('more text')).toEqual(verdict)
  })
})

describe('§2.2(a) word boundary is the full `\\w` sense', () => {
  /**
   * The reference reading is "非单词字符" — a *word* character, not merely an
   * ASCII alphanumeric. A narrower test fires on continuations a reader would
   * immediately recognise as one longer token.
   */
  it.each([
    ['underscore after the prefix', 'Let me_x.'],
    ['underscore in `now i`', 'Now i_x.'],
    ['letter from another script', 'Let meé.'],
    ['Cyrillic continuation', 'Then iд.'],
    ['digit continuation', 'Let me9.'],
    ['full-width letter', 'Let meｘ.'],
  ])('stays quiet on %s', (_label, line) => {
    expectQuiet(repeat(line, 8))
  })

  it.each([
    ['a space', 'Let me write.'],
    ['a full stop', 'Let me.'],
    ['a comma', 'Now i, then more.'],
    ['end of the clause', 'Then i\n'],
  ])('still fires when the next character is %s', (_label, line) => {
    expectFlood(repeat(line, 8))
  })

  it('counts an astral character once, not as two UTF-16 units', () => {
    // Astral characters are two UTF-16 units. Stepping by unit would make the
    // 20-character tolerance expire after 10 astral characters, so a run separated
    // by astral noise would reset early and never reach the limit.
    //
    // Table-B joints are used because they consume their whole clause, leaving the
    // gap exactly the noise width: `OK.` contributes nothing after the count.
    const at = (width: number): string => {
      const noise = '\u{1F600}'.repeat(width)
      return ['OK.', noise, 'OK.', noise, 'OK.', noise, 'OK.', noise, 'OK.'].join('\n')
    }
    // Exactly the tolerance keeps the run alive.
    expectFlood(at(ANNOUNCE_GAP))
    // One past it resets, exactly as it does for single-unit text.
    expectQuiet(at(ANNOUNCE_GAP + 1))
  })
})

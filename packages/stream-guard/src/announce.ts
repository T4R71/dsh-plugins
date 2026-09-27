/**
 * Layer one: the announcement brake.
 *
 * ## What this replaces
 *
 * Three separate rules used to watch one stream: a filler lexicon (A), a
 * character-period scan (B), and an intent-prefix counter (C). A and C were
 * asking the same question — *is the model announcing instead of working?* —
 * with two different vocabularies, so they are one rule here with two hit types:
 *
 * - **hit type A**: a clause that is *nothing but* a filler word (`Writing.`, `现在。`);
 * - **hit type C**: a clause that *opens* with an intent prefix and is short
 *   enough to be an announcement rather than a sentence (`Let me check.`).
 *
 * The character-period rule is **deleted**, not merged. Measured, a periodic
 * character run is blind to the shape that actually exhausts a context window —
 * a channel recycling a pool of ordinary phrases: on the worst observed flood it
 * saw only a local `period=53, span=618` inside a 10190-line degeneration. The
 * line-level rule in `repeat.ts` sees that shape directly, so this rule no longer
 * has to pay for a scan that could not see it.
 *
 * ## Why this costs no holdback
 *
 * The judgement is about the shape of **already-complete clauses**, so it runs on
 * text that has already been published. A verdict never asks for text back, and
 * the whole release-cursor machine the previous design needed — `takeSafe`,
 * `takePrefix`, `goodPrefix`, `published`, `decline`, the cycle floor and its muting
 * flag — is gone. That machine existed only to make a retrospective rule safe,
 * and it cost a permanent ~1024-character visible delay on the channel a person
 * is actually watching.
 *
 * ## Streaming safety
 *
 * A clause that has not finished arriving is left **pending** rather than
 * consumed, so the count is a function of the text alone and not of the delta
 * boundaries. `L`, `e`, `t` arriving separately counts exactly once, as it would had
 * it arrived whole.
 *
 * @module @t4r71/dsh-stream-guard/announce
 */

/**
 * Intent prefixes — the announcements a stalled model repeats (hit type C).
 *
 * Deliberately *intent* markers rather than content words, because content words
 * legitimately recur in healthy output. A clause opening with one of these is a
 * hit only if the whole clause is at most {@link ANNOUNCE_MAX} characters.
 */
export const INTENT_PREFIXES: readonly string[] = [
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
  '让我',
  '我先',
  '我需要',
  '接下来',
  '现在我',
]

/**
 * Filler words — a clause that is *nothing but* one of these (hit type A).
 *
 * Frozen to the reference implementation's measured list. It is deliberately
 * narrow: a looser rule (any short single word) flags list output, and extending
 * it with `output` / `continue` / `done` / `execute` / `executing` was measured to
 * buy exactly one extra trigger block — a model writing test data, listing filler
 * words inside a code fence. The measurement is recorded in `README.md` under
 * Dev Note.
 */
export const FILLER_WORDS: readonly string[] = [
  'ok',
  'go',
  'now',
  'write',
  'emit',
  'here',
  'final',
  'writing',
  'producing',
  'emitting',
  '好',
  '现在',
  '写',
  '输出',
  '生成',
  '写入',
  '接下去',
  '执行',
]

/**
 * Characters tolerated between two hits before the count resets.
 *
 * "Characters" means non-whitespace: indentation and blank lines between filler
 * lines are formatting, not work. The reference measured 0 false positives in
 * 7,395 healthy samples at 20; 30 produced 1.
 */
export const ANNOUNCE_GAP = 20

/** hits required before the run is proven. */
export const ANNOUNCE_COUNT = 5

/**
 * Longest clause that can still open with an intent prefix and count as a hit.
 *
 * Measured optimum, and load-bearing: see the module comment. Tightening it to 12
 * loses half of the genuine filler; loosening it to 20 admits 14 samples of real
 * planning work.
 */
export const ANNOUNCE_MAX = 18

/** What {@link AnnounceGuard} found, and which vocabulary saw it. */
export interface AnnounceVerdict {
  /**
   * Which vocabulary saw the completing hit.
   *
   * Kept on the verdict because the two are different evidence: a run of bare
   * filler words is unambiguous padding, while a run of intent openings in the
   * visible channel can be ordinary enumeration. A caller screening a session
   * needs to know which one it acted on.
   */
  readonly kind: 'filler' | 'intent'
  /** The hit that completed the run, as it appeared in the stream. */
  readonly opener: string
  /** Hits accumulated when the run was proven. */
  readonly count: number
  /** Characters since the previous hit; `0` at the moment of a hit. */
  readonly gap: number
  /** UTF-16 units of the buffer scanned when the verdict fired. */
  readonly charsSeen: number
}

/** Characters that end a clause on their own, without needing whitespace. */
const SENTENCE_TERMINATORS = new Set(['.', '!', '?', '。', '！', '？', '；', ';'])

/** Whitespace, which never counts against the tolerance. */
const WHITESPACE = /\s/

/** Punctuation dropped from a clause's tail before a whole-word comparison. */
const TRAILING_PUNCTUATION = /[.:;!?。：；！？，,、]+$/

/**
 * What a clause at the scan position amounts to.
 *
 * `wait` is not a failure: it means the clause is still arriving and its answer
 * could still change, so nothing may be consumed yet.
 */
type ClauseReading =
  | { readonly kind: 'filler' | 'intent'; readonly opener: string; readonly next: number }
  | 'miss'
  | 'wait'

/**
 * Index just past the first clause terminator at or after `from`, or `-1` while
 * the clause is still arriving.
 *
 * @param text - the buffer.
 * @param from - the clause's first character.
 * @returns the exclusive end of the clause, or `-1` when unterminated.
 */
function clauseEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    const char = text.charAt(i)
    if (char === '\n' || SENTENCE_TERMINATORS.has(char)) return i + 1
  }
  return -1
}

/**
 * True when `text` holds more than `max` characters.
 *
 * Character count, not UTF-16 length, so an astral character is one. The unit
 * check first is an exact short-circuit rather than an approximation: a character
 * is at most two units, so anything over `max * 2` units is certainly over `max`
 * characters, and only strings that could still qualify are counted exactly.
 *
 * @param text - the text to measure.
 * @param max - the bound.
 * @returns true when the text exceeds the bound.
 */
function longerThan(text: string, max: number): boolean {
  if (text.length > max * 2) return true
  return Array.from(text).length > max
}

/**
 * Drop punctuation from the tail of a clause.
 *
 * @param text - a trimmed clause.
 * @returns the clause without trailing punctuation.
 */
function stripTrailingPunctuation(text: string): string {
  return text.replace(TRAILING_PUNCTUATION, '')
}

/**
 * Match an intent prefix at the head of a clause, or `null`.
 *
 * @param buffer - the whole buffer.
 * @param head - the clause's first non-whitespace character.
 * @param contentEnd - the index of the clause's terminating character.
 * @returns the matched prefix as it appeared, or `null`.
 */
function matchIntentPrefix(buffer: string, head: number, contentEnd: number): string | null {
  let best: string | null = null
  for (const prefix of INTENT_PREFIXES) {
    // The prefix has to fit before the terminator: `Let me\n` counts, `Let m\n`
    // cannot.
    if (head + prefix.length > contentEnd) continue
    if (buffer.slice(head, head + prefix.length).toLowerCase() !== prefix) continue
    // A Latin opening must end on a word boundary, so `let men` is not `let me`
    // and `now items` is not `now i`. CJK openings end at a character that is
    // itself a word, so no such test applies to them.
    if (/[a-z']$/i.test(prefix)) {
      // `head + prefix.length <= contentEnd < buffer.length` was established
      // above, so a character always follows the match.
      const after = buffer.charAt(head + prefix.length)
      // A word character, in the `\w` sense the spec means by 词边界: letters,
      // digits, and the underscore, across scripts. A narrower `[a-z0-9]` test
      // would wrongly fire on `let me_x`, `now i_`, and any continuation in
      // another alphabet (`let meé`, `now iд`).
      if (/[\p{L}\p{N}_]/u.test(after)) continue
    }
    // A plain assignment, not a longest-wins comparison: two entries could only
    // both match if one began with another, and no pair in the list has that shape.
    best = buffer.slice(head, head + prefix.length)
  }
  return best
}

/**
 * A streaming counter over the hits of one channel.
 *
 * Streaming-safe by construction: a clause that has not finished arriving is left
 * pending rather than consumed, so the verdict is a function of the text alone and
 * not of the delta boundaries.
 */
export class AnnounceGuard {
  private buffer = ''
  /** How far the scan has consumed, in UTF-16 units. */
  private scanned = 0
  private count = 0
  private gap = 0
  private verdict: AnnounceVerdict | null = null

  /**
   * @param tolerance - non-whitespace characters tolerated between two hits.
   * @param limit - hits required before the run is proven.
   * @param maxClause - longest clause that can still count as an announcement.
   */
  constructor(
    private readonly tolerance: number = ANNOUNCE_GAP,
    private readonly limit: number = ANNOUNCE_COUNT,
    private readonly maxClause: number = ANNOUNCE_MAX,
  ) {}

  /**
   * Consume one delta.
   *
   * @param delta - newly streamed text.
   * @returns the verdict once the run is proven, else `null`.
   */
  feed(delta: string): AnnounceVerdict | null {
    if (this.verdict !== null) return this.verdict
    if (delta !== '') this.buffer += delta

    while (this.scanned < this.buffer.length) {
      if (this.atClauseStart(this.scanned)) {
        const reading = this.readClause()
        // The clause can still change: leave it and everything after it pending.
        if (reading === 'wait') return null
        if (reading !== 'miss') {
          this.count += 1
          this.gap = 0
          this.scanned = reading.next
          if (this.count >= this.limit) {
            this.verdict = {
              kind: reading.kind,
              opener: reading.opener,
              count: this.count,
              gap: this.gap,
              charsSeen: this.scanned,
            }
            return this.verdict
          }
          continue
        }
      }

      // Consume. Whitespace goes in one step: it never counts against the
      // tolerance, and the clause it belongs to is judged at the first character
      // after it, which is where the loop lands.
      const char = this.buffer.charAt(this.scanned)
      if (WHITESPACE.test(char)) {
        let next = this.scanned
        while (next < this.buffer.length && WHITESPACE.test(this.buffer.charAt(next))) next += 1
        this.scanned = next
        continue
      }
      this.gap += 1
      if (this.gap > this.tolerance) {
        this.count = 0
        this.gap = 0
      }
      // Step a whole code point, so an astral character is charged once. A high
      // surrogate opens a pair; nothing else is two units wide, and a lone low
      // surrogate cannot appear first in well-formed text.
      const unit = this.buffer.charCodeAt(this.scanned)
      this.scanned += unit >= 0xd800 && unit <= 0xdbff ? 2 : 1
    }
    return null
  }

  /**
   * hits counted so far.
   *
   * The verdict carries the final count; this exposes the running one, which the
   * corpus verification reads to attribute a trigger to a block.
   */
  get openings(): number {
    return this.count
  }

  /**
   * Whether a clause begins at `index`.
   *
   * @param index - a position in the buffer.
   * @returns true when a clause begins here.
   */
  private atClauseStart(index: number): boolean {
    if (index === 0) return true
    let i = index - 1
    while (i >= 0 && WHITESPACE.test(this.buffer.charAt(i))) {
      if (this.buffer.charAt(i) === '\n') return true
      i -= 1
    }
    /* v8 ignore next -- unreachable: the scanner reaches a position beyond 0 only
       by consuming a hit or by skipping a whitespace run, so a non-whitespace
       character always precedes it. Index 0 is answered above. */
    if (i < 0) return true
    return SENTENCE_TERMINATORS.has(this.buffer.charAt(i))
  }

  /**
   * Judge the clause at the scan position.
   *
   * @returns the hit it found, `'miss'` when it is definitively not one, or
   * `'wait'` while the answer could still change.
   */
  private readClause(): ClauseReading {
    const pos = this.scanned
    const end = clauseEnd(this.buffer, pos)

    if (end < 0) {
      // Still arriving. Decide only when the answer can no longer change: the
      // clause is already longer than any hit can be, or it can no longer grow
      // into one. Waiting is what makes the count independent of delta size.
      const content = this.buffer.slice(pos).trim()
      if (content === '') return 'wait'
      if (longerThan(content, this.maxClause)) return 'miss'
      const lower = content.toLowerCase()
      if (INTENT_PREFIXES.some(prefix => prefix.startsWith(lower) || lower.startsWith(prefix))) {
        return 'wait'
      }
      if (FILLER_WORDS.some(word => word.startsWith(stripTrailingPunctuation(lower)))) return 'wait'
      return 'miss'
    }

    const clause = this.buffer.slice(pos, end)
    /** The terminator sits at `end - 1`; content is everything before it. */
    const contentEnd = end - 1
    // Indentation before a hit is formatting, not part of it.
    let head = pos
    while (head < contentEnd && WHITESPACE.test(this.buffer.charAt(head))) head += 1

    const trimmed = clause.trim()
    // (a) intent prefix, on a clause short enough to be an announcement rather
    // than a sentence.
    if (head < contentEnd && !longerThan(trimmed, this.maxClause)) {
      const opener = matchIntentPrefix(this.buffer, head, contentEnd)
      if (opener !== null) return { kind: 'intent', opener, next: head + opener.length }
    }
    // (b) a clause that is nothing but a filler word. Trailing punctuation is
    // dropped here and only here: `Writing.` is the word, `Writing more` is not.
    const body = stripTrailingPunctuation(trimmed)
    if (body !== '' && FILLER_WORDS.includes(body.toLowerCase())) {
      return { kind: 'filler', opener: body, next: end }
    }
    return 'miss'
  }
}

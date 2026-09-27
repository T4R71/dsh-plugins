/**
 * Small text predicates shared by the rules.
 *
 * These lived in `filler.ts` because the filler lexicon happened to need them first,
 * but none of them is about filler: `hesitation.ts` uses them to decide what counts
 * as a line at all. They moved here when the lexicon was retired, so that
 * removing one rule cannot silently remove a predicate another rule depends on.
 *
 * @module @t4r71/dsh-stream-guard/text
 */

import { hasCjkLetter } from './language.ts'

/**
 * Lines longer than this are never treated as an announcement.
 *
 * Was `MAX_SHORT_LINE` in `filler.ts`; the name is now about what the bound
 * means to every caller rather than to the one rule that introduced it.
 */
export const MAX_SHORT_LINE = 60

/**
 * Lines that are pure Markdown structure: fences, table rules, bullets,
 * headings, list markers — neither content nor filler, so they are noise rather
 * than counting either way.
 *
 * A branch-for-branch transcription of the reference regex. Do not "simplify"
 * it: in the Rust port an attempted rewrite dropped the `[\s:\-|]+` whitespace
 * case (which is what accepts a rule row like `----   --------`) and changed the
 * verdict on 2 of 7,433 corpus samples.
 */
const BENIGN = /^\s*(`{3,}|-{3,}|\|?[\s:\-|]+\|?|\*+|#{1,6}\s*|[0-9]+\.\s*|[-*+]\s*)$/

/**
 * Character count of a line, with padding ignored.
 *
 * **Every length comparison uses this, never `.length` on an untrimmed line.** The
 * unit is characters, not bytes: a 36-character Chinese line is 88 UTF-8 bytes,
 * so a byte test would classify it as content and drop it. (JS strings index
 * UTF-16 code units, which matches character count for every BMP character and
 * counts astral characters as 2.)
 *
 * @param line - the line to measure; surrounding whitespace is ignored.
 * @returns the line's length in characters, after trimming.
 */
export function textLen(line: string): number {
  return Array.from(line.trim()).length
}

/**
 * Whether a line is pure Markdown structure (see `BENIGN`).
 *
 * The `textLen <= 2` shortcut is calibrated for Latin script, where one or two
 * characters are essentially always punctuation or a list marker. It is **not**
 * valid for CJK, where two characters are routinely a complete word — `现在`,
 * `输出`, `生成` are all two characters, and short-circuiting them to "structure"
 * would make a CJK announcement line undetectable. A CJK-letter-bearing line
 * therefore always falls through to the real structural test.
 *
 * @param line - the line to classify.
 * @returns true for fences, rules, bullets, headings, and list markers.
 */
export function isBenign(line: string): boolean {
  const s = line.trim()
  if (textLen(s) <= 2 && !hasCjkLetter(s)) return true
  return BENIGN.test(s)
}

/**
 * Language-matched guard wording.
 *
 * Guard nudges are injected as **user messages**, so their language is a signal
 * the model reads: an English nudge in a Chinese conversation flips the reply
 * language, and because the nudge stays in the transcript, every later turn
 * inherits that flip. The reference implementation hard-coded Chinese
 * (`M:\ds-guard\src\policy.rs:21-35`) and that is what ships here — but hard
 * coding either language breaks the other half of users, so the wording is
 * selected from the conversation itself.
 *
 * Detection is deliberately crude and local: the guard must not cost a network
 * call or a dependency, and the only decision it drives is which of two
 * constant strings to emit. CJK ideographs, kana, and Hangul are counted
 * against Latin letters across the **human** turns; a conversation whose
 * non-Latin script share reaches {@link CJK_RATIO} is treated as CJK.
 *
 * @module @t4r71/dsh-stream-guard/language
 */

import type { Message } from '@deepseek-ai/dsh-llm'

/** Non-Latin (CJK) share of scripted characters at or above which wording is CJK. */
export const CJK_RATIO = 0.2

/**
 * Characters counted as CJK script: CJK ideographs, kana, Hangul, and the
 * fullwidth/CJK punctuation blocks that only appear in CJK prose.
 *
 * Ranges are written as escapes so the source stays pure ASCII and cannot be
 * mangled by an encoding-unaware tool.
 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffef]/gu

/**
 * CJK **letters** only: ideographs, kana, and Hangul.
 *
 * Deliberately narrower than {@link CJK}, which also counts CJK-specific
 * punctuation. The two answer different questions: {@link CJK} measures how much
 * of a text is CJK-scripted, where fullwidth punctuation is a legitimate signal;
 * this one asks whether a text *carries CJK wording*, where punctuation is not
 * wording. A lone `。` is not a word, and treating it as one would make a
 * punctuation-only line count as content.
 */
export const CJK_LETTER = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u

/**
 * Whether a text contains at least one CJK letter.
 *
 * Script density matters because a fixed character count means different things
 * per script: two Latin characters are rarely a word, while two CJK characters
 * routinely are.
 *
 * @param text - text to test.
 * @returns true when the text carries CJK wording.
 */
export function hasCjkLetter(text: string): boolean {
  return CJK_LETTER.test(text)
}

/** Characters counted as Latin script. */
const LATIN = /[A-Za-z]/gu

/** How many leading human messages to weigh. */
const SAMPLE_LIMIT = 8

/**
 * Count the scripted characters of one text.
 *
 * @param text - text to scan.
 * @returns CJK and Latin character counts.
 */
export function scriptCounts(text: string): { cjk: number; latin: number } {
  return {
    cjk: (text.match(CJK) ?? []).length,
    latin: (text.match(LATIN) ?? []).length,
  }
}

/**
 * Decide whether a conversation is CJK-scripted.
 *
 * Empty or script-free input (a conversation of digits, code, or emoji) is not
 * evidence of anything, so it reports `false` and the caller keeps the Latin
 * wording — the safer default for a transcript the guard cannot read.
 *
 * @param messages - derived transcript, in order.
 * @returns true when the human turns are predominantly CJK.
 */
export function prefersCjk(messages: readonly Message[]): boolean {
  let cjk = 0
  let latin = 0
  // Only human-authored turns are evidence: an assistant reply is downstream of
  // the very nudge being chosen, and a plugin notice is written by a guard.
  const human = messages.filter(message => message.role === 'user' && message.source.kind === 'user')
  for (const message of human.slice(0, SAMPLE_LIMIT)) {
    for (const block of message.content) {
      if (block.type !== 'text') continue
      const counts = scriptCounts(block.text)
      cjk += counts.cjk
      latin += counts.latin
    }
  }
  const total = cjk + latin
  if (total === 0) return false
  return cjk / total >= CJK_RATIO
}

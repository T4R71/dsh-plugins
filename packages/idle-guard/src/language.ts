/**
 * Language-matched guard wording.
 *
 * A guard nudge is injected as a **user message**, so its language is a signal
 * the model reads: an English nudge in a Chinese conversation flips the reply
 * language, and because the nudge stays in the transcript, every later turn
 * inherits that flip. The wording is therefore selected from the conversation
 * itself rather than hard-coded.
 *
 * Detection is deliberately crude and local: the guard must not cost a network
 * call or a dependency, and the only decision it drives is which of two constant
 * strings to emit. CJK ideographs, kana, and Hangul are counted against Latin
 * letters across the **human** turns; a conversation whose non-Latin script
 * share reaches {@link CJK_RATIO} is treated as CJK.
 *
 * Duplicated from `@t4r71/dsh-stream-guard`'s `src/language.ts` rather
 * than shared: both are leaf guard packages, and a turn-completion guard
 * depending on a streaming guard to reach forty lines of script counting would
 * be the worse coupling.
 *
 * @module @t4r71/dsh-idle-guard/language
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

/** Characters counted as Latin script. */
const LATIN = /[A-Za-z]/gu

/** How many leading human messages to weigh. */
const SAMPLE_LIMIT = 8

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
      cjk += (block.text.match(CJK) ?? []).length
      latin += (block.text.match(LATIN) ?? []).length
    }
  }
  const total = cjk + latin
  if (total === 0) return false
  return cjk / total >= CJK_RATIO
}

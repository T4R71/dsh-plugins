/**
 * Guard wording, in the conversation's own language.
 *
 * Two rules shape every string here, both from measurement recorded in the
 * reference implementation's `src/policy.rs`:
 *
 * 1. **Short and neutral.** Wording that *describes the fault* ("STOP. Your
 *    output degenerated into a repetition loop…") measurably pushed the model
 *    into re-organising and wrapping up instead of resuming: ~960 characters of
 *    output against ~1400 for a neutral instruction. Naming the loop adds
 *    nothing, so it is not named.
 * 2. **Matched to the transcript.** A nudge is a user message; the wrong
 *    language flips the reply language for the rest of the conversation.
 *
 * @module @t4r71/dsh-stream-guard/wording
 */

/**
 * Wording for one language.
 *
 * `continue` resumes a braked stream; `hesitation` interrupts self-contradiction
 * churn. Both are injected as user messages, so neither may describe a fault.
 */
export interface Wording {
  /** Appended after a brake so the model resumes instead of restarting. */
  continue: string
  /**
   * Appended after {@link continue} once a session has spent more than the
   * warning threshold worth of continuations.
   *
   * The session budget is no longer a hard stop: a session that keeps
   * collapsing past the threshold is still steered, because ending the turn
   * silently is worse for the user than the filler it replaced. The warning
   * carries the one fact the plain instruction lacks — that this has happened
   * repeatedly — so the model can change approach instead of just resuming.
   */
  continueWarning: string
  /** Injected when the turn is churning around one decision. */
  hesitation: string
  /**
   * Label introducing the resume point, formatted with the prefix tail.
   *
   * Separate from {@link continue} because it is spliced into a sentence with
   * the actual text, and the elision character belongs with it: a Latin label
   * inside Chinese prose reintroduces exactly the language mixing this module
   * exists to prevent.
   */
  resumeLabel: string
}

/**
 * Latin-script wording.
 *
 * Kept deliberately terse: see the module note on measurement.
 */
export const LATIN: Wording = {
  continue: 'Continue from where the text above was cut off. '
    + 'Do not repeat or restate what you have already written.',
  continueWarning: ' This is a repeated interruption: your output has collapsed '
    + 'the same way many times in this session. If you have been announcing an '
    + 'action instead of taking it, take it now. If the work is finished, say so '
    + 'and stop.',
  hesitation: 'You seem to be re-deriving the same conclusion. If you already '
    + 'have enough evidence, settle on it and continue; if you need more, say '
    + 'exactly what is missing.',
  resumeLabel: 'Where you stopped: …',
}

/**
 * CJK wording, verbatim from the reference implementation
 * (`M:\ds-guard\src\policy.rs:21` and `:33`).
 *
 * Not a translation: this is the measured text, and rewriting it discards the
 * calibration the reference recorded.
 */
export const CJK: Wording = {
  continue: '从上面被截断的地方接着写。不要重复或复述已经写过的内容。',
  continueWarning: '这是本次会话里反复出现的同一种中断：你的输出已经多次以同样的方式崩塌。'
    + '如果你一直在宣告某个动作而没有真的去做，现在就去做；如果工作已经完成，直接说明并结束。',
  hesitation: '你似乎在同一结论周围反复推导。如果已有足够证据，请收敛到结论并继续；'
    + '如果还需要更多信息，请明确说明缺什么。',
  resumeLabel: '上次写到：…',
}

/**
 * Pick the wording for a transcript.
 *
 * @param cjk - whether the conversation is CJK-scripted.
 * @returns the matching wording set.
 */
export function wordingFor(cjk: boolean): Wording {
  return cjk ? CJK : LATIN
}

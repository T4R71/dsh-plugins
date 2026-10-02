/**
 * Turn-completion rule: a turn that ends on reasoning alone gets one more step.
 *
 * Moved here verbatim from \`@t4r71/dsh-idle-guard\`'s \`src/index.ts\`
 * (\`isIdleCompletion\`, lines 119-143 of that file). Merging the two guards into one
 * package changed where this lives, not what it decides: the thresholds, the
 * per-session budget it is spent against, and the message it steers are the ones
 * the standalone package shipped.
 *
 * The failure it covers is the complement of the stream guard's: nothing
 * degenerates, the model finishes a step whose only content is a \`reasoning\`
 * block, and the loop calls that a completed turn
 * (\`dsh-agent-loop/lib/index.js:1137-1138\` — \`toolCalls.length === 0\` returns
 * \`{kind:'completed'}\`). Nothing is answered and nothing is attempted.
 *
 * @module @t4r71/dsh-guard/idle
 */

/**
 * Whether one assistant message is an idle completion.
 *
 * Idle means: no visible answer and no action. A message that says anything to
 * the user, or that calls any tool, has done something and is left alone —
 * including a message that only apologises or reports a blocker, since those are
 * legitimate endings.
 *
 * @param content - the message's content blocks.
 * @param minReasoningChars - minimum reasoning length to count.
 * @returns true when the message neither answers nor acts.
 */
export function isIdleCompletion(
  content: readonly { type: string; text?: string }[],
  minReasoningChars: number,
): boolean {
  let reasoning = 0
  let text = 0
  for (const block of content) {
    if (block.type === 'reasoning') reasoning += Array.from(block.text ?? '').length
    else if (block.type === 'text') text += (block.text ?? '').trim().length
    else if (block.type === 'tool-call') return false
  }
  return text === 0 && reasoning >= minReasoningChars
}

/**
 * Whether one assistant message is an **empty** completion: the provider
 * settled a message with no content blocks at all.
 *
 * A separate predicate from {@link isIdleCompletion} rather than a case of it,
 * because {@link isIdleCompletion} is true for an empty message too
 * (\`text === 0 && 0 >= 0\`) and the two want different wording. The recovery
 * arbitration consults this one first so an empty message is never labelled
 * "thinking only".
 *
 * @param content - the message's content blocks.
 * @returns true when the message carries nothing at all.
 */
export function isEmptyCompletion(content: readonly { type: string }[]): boolean {
  return content.length === 0
}

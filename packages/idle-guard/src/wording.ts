/**
 * Idle wording, in the conversation's own language.
 *
 * A single sentence per language, injected as a user message. Like the stream
 * guard's continuation it must not describe a fault: the measured finding there
 * (see `@t4r71/dsh-stream-guard/wording`) is that naming the failure
 * pushes the model into wrapping up instead of resuming.
 *
 * @module @t4r71/dsh-idle-guard/wording
 */

/** Wording for one language. */
export interface Wording {
  /** Injected when a turn ended on reasoning alone. */
  idle: string
}

/** Latin-script wording. */
export const LATIN: Wording = {
  idle: 'Your last message was thinking only: it contained no answer to the user '
    + 'and no tool call. If you were planning an action, take it now. If you were '
    + 'thinking, write the conclusion and act on it. Do not restate the thinking.',
}

/** CJK wording. */
export const CJK: Wording = {
  idle: '你刚才那条消息只有思考：既没有给用户的答复，也没有任何工具调用。'
    + '如果你在计划某个动作，现在就去做；如果你在思考，请写出结论并据此行动。不要复述思考过程。',
}

/**
 * Pick the wording for a conversation.
 *
 * @param cjk - whether the conversation is CJK-scripted.
 * @returns the matching wording set.
 */
export function wordingFor(cjk: boolean): Wording {
  return cjk ? CJK : LATIN
}

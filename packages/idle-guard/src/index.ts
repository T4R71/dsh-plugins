/**
 * Turn-completion guard: a turn that ends on reasoning alone gets one more step.
 *
 * The stream guard covers degeneration *inside* a stream — it truncates a
 * collapse and steers a continuation. This package covers the complementary
 * failure, which no streaming rule can see because nothing degenerates: the
 * model finishes a step whose only content is a `reasoning` block, and the loop
 * calls that a completed turn (`agent-loop/src/agent.ts:488` — "no tool calls
 * means completed"). Nothing is answered and nothing is attempted; the user sees
 * a turn that simply stopped.
 *
 * Measured on a real session: three separate turns ended exactly this way, each
 * after a long reasoning block (3,769 / 9,445 / 3,811 characters) with no text
 * and no tool call. Two of them immediately followed a stream-guard
 * continuation, so the guard had already done its job and the turn still died.
 *
 * Unlike a brake, this never truncates anything: the reasoning has already been
 * written by the time the turn boundary is reached, so the remedy is a steered
 * continuation and nothing else.
 *
 * @module @t4r71/dsh-idle-guard
 */

import z from '@deepseek-ai/schemastery'
// Type-only, no runtime import: this pulls in dsh-agent's `Events` augmentation
// (the `agent/turn-stopping` signature) without depending on the package's
// runtime.
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { prefersCjk } from './language.ts'
import { wordingFor } from './wording.ts'
import type { Wording } from './wording.ts'

/** Plugin name, as registered with cordis. */
export const name = 'idle-guard'

/**
 * Services this plugin reads.
 *
 * `sessions` is declared because the guard keeps a per-session budget and the
 * loop's own session registry is what those ids belong to.
 */
export const inject = ['sessions']

/** Plugin configuration. */
export interface Config {
  /** Run the guard at all (default `true`). */
  enabled?: boolean
  /**
   * Continuations steered per session (default `3`).
   *
   * A budget rather than a single shot: a model that idles once often idles
   * again, and one nudge that is ignored would leave the turn dead. It stays
   * small on purpose — this is a nudge, not a substitute for the model deciding
   * to act, and an unbounded budget would let a pathological session spend
   * forever re-prompting a model that has nothing to do.
   */
  idleBudget?: number
  /**
   * Minimum reasoning length, in characters, before the guard considers the turn
   * idle (default `0`).
   *
   * Zero by default: a turn that produced no text and no action is wrong
   * whether the thinking was long or short. Raising it narrows the guard to
   * turns that clearly thought about something and then did not act.
   */
  minReasoningChars?: number
  /** Emit diagnostics through the logger (default `false`). */
  verbose?: boolean
}

/** Validated plugin configuration. */
export const Config: z<Config> = z.object({
  /** Run the guard at all. */
  enabled: z.boolean().default(true),
  /** Continuations steered per session. */
  idleBudget: z.number().min(0).max(64).default(3),
  /** Minimum reasoning length before a turn counts as idle. */
  minReasoningChars: z.number().min(0).max(1000000).default(0),
  /** Emit diagnostics through the logger. */
  verbose: z.boolean().default(false),
})

/** Validated config, with the loader's defaults filled in. */
export type ResolvedConfig = Config

/** Per-session state, keyed by id. */
interface SessionState {
  /** Continuations steered so far in this session. */
  steered: number
  /** Id of the last assistant message judged, so one message yields one nudge. */
  judged: string
}

/**
 * The wording to inject for one agent, matched to its conversation's language.
 *
 * @param session - the session whose transcript decides the language.
 * @returns the wording set for that conversation.
 */
function wordingForAgent(session: Session): Wording {
  return wordingFor(prefersCjk(session.deriveMessages()))
}

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
 * Register the guard.
 *
 * @param ctx - plugin context; the `agent/turn-stopping` listener is added here.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  const enabled = config.enabled ?? true
  const idleBudget = config.idleBudget ?? 3
  const minReasoningChars = config.minReasoningChars ?? 0
  const verbose = config.verbose ?? false

  /** Per-session budgets. Keyed by id: the hook carries no SessionId. */
  const states = new Map<SessionId, SessionState>()

  const stateOf = (id: SessionId): SessionState => {
    let state = states.get(id)
    if (state === undefined) {
      state = { steered: 0, judged: '' }
      states.set(id, state)
    }
    return state
  }

  const log = (...args: unknown[]): void => {
    if (verbose) ctx.logger.info('[idle-guard]', ...args)
  }

  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (!enabled) return

    const session = agent.session
    const state = stateOf(session.id)
    if (state.steered >= idleBudget) return

    // The last assistant message is what the turn produced. A turn with no
    // assistant message never reached a model reply, so there is nothing to
    // judge and nothing to correct.
    const messages = session.deriveMessages()
    const last = messages.at(-1)
    if (last === undefined || last.role !== 'assistant') return
    // One nudge per distinct message: without this the nudge's own turn would be
    // judged and nudged again, which is an unbounded feedback loop.
    if (state.judged === last.id) return

    if (!isIdleCompletion(last.content, minReasoningChars)) return

    state.judged = last.id
    state.steered += 1

    // Steering here is what keeps the turn alive: the machine re-reads its inbox
    // at this boundary and runs another step when fresh work is present
    // (`agent-loop/src/agent.ts:316-322`).
    //
    // The summary carries the diagnosis because it is the only durable evidence
    // the guard leaves — `ctx.logger` output goes to a 1000-message in-memory
    // ring buffer that no shipped profile persists
    // (`vendor/cordis/src/logger.ts:213`).
    agent.steer(
      createUserMessage({
        content: [{ type: 'text', text: wordingForAgent(session).idle }],
        source: {
          kind: 'plugin',
          plugin: name,
          form: 'notice',
          summary: 'idle-guard: turn ended on reasoning alone ('
            + state.steered + '/' + idleBudget + ')',
        },
      }),
    )
    log('steered an idle continuation', state.steered, '/', idleBudget)
  })
}

/** Cordis context, narrowed to what this plugin uses. */
interface Context {
  logger: { info(...args: unknown[]): void }
  on(event: 'agent/turn-stopping', listener: (payload: { agent: Agent }) => void): void
}

/** The part of an agent this plugin reads. */
interface Agent {
  session: Session
  steer(message: unknown): void
}

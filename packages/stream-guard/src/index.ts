/**
 * Streaming degeneration guard — two layers over one stream.
 *
 * ## The two layers
 *
 * **Layer one** (`announce.ts`) is the fast, vocabulary rule: a clause that is
 * nothing but a filler word, or that opens with an intent prefix and stops
 * short, is the model announcing instead of working. Five hits within twenty
 * characters of each other prove it.
 *
 * **Layer two** is two rules, because two *different* diseases were measured and
 * no single statistic sees both:
 *
 * - `repeat.ts` — the channel recycles its own lines (`lines / distinct >= 4`).
 *   Measured, a block re-emitted 10,190 lines drawn from a pool of 118.
 * - `echo.ts` — the visible answer restates the reasoning verbatim (at least 90%
 *   of its lines already appeared in the reasoning). Measured, eight blocks do
 *   this, one of them 116,081 reasoning characters answered by 116,079.
 *
 * Measured overlap on 1,669 corpus blocks: three degenerate blocks are visible
 * only to R1, six only to R2, two to both — eleven in total, against zero false
 * positives.
 *
 * ## Why no holdback
 *
 * All three rules judge **text that has already arrived**. A verdict therefore
 * never asks for a character back, so nothing is ever buffered to be
 * un-published. This is the deliberate simplification of the previous design,
 * whose retrospective character-period rule needed a release cursor and cost a
 * permanent ~1024-character visible delay on the channel a person watches —
 * about 17 seconds before the first token at 60 characters per second. The 1024
 * figure survives only as the **judging deadline** these rules are measured
 * against; R2's worst observed fire is at 897 characters.
 *
 * One consequence is worth stating plainly: because nothing is held back, a
 * brake cannot remove the run that triggered it. The user has already seen those
 * characters; what the brake buys is that the run **stops growing** and the
 * turn is steered back to work.
 *
 * ## Why the turn boundary
 *
 * A mid-stream cut cannot be resumed in place: the loop's retry ladder only
 * fires on `error`/`aborted` finishes (`agent-loop/src/agent.ts:444`), the
 * request options are deep-frozen with `options.messages ===`
 * `session.deriveMessages()` enforced by an invariant, and the assistant message
 * is settled from the assembled blocks. So the brake ends the step cleanly with
 * a normal `stop`, and the continuation is **steered** at `agent/turn-stopping`
 * (`agent-loop/src/agent.ts:316-320`), which keeps the turn alive and runs
 * another step with the resume prompt in the transcript.
 *
 * @module @t4r71/dsh-stream-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only, no runtime import: this pulls in dsh-agent's `Events` augmentation
// (the `agent/turn-stopping` signature) without depending on the package's
// runtime.
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AnnounceGuard } from './announce.ts'
import { RepeatGuard } from './repeat.ts'
import { EchoGuard } from './echo.ts'
import { judgeHesitation } from './hesitation.ts'
import { rebuildBrakedEnvelope } from './signature.ts'
import { prefersCjk } from './language.ts'
import { wordingFor } from './wording.ts'
import type { Wording } from './wording.ts'

/** Plugin name, as registered with cordis. */
export const name = 'stream-guard'

/**
 * Services this plugin reads.
 *
 * `llm` supplies the stream hook and the `sessionId` every loop-built request
 * carries; `sessions` is declared because the guard keeps per-session budgets and
 * the loop's own session registry is what those ids belong to.
 */
export const inject = ['llm', 'sessions']

/** Which channel a delta belongs to. */
export type Channel = 'text' | 'reasoning'

/**
 * Plugin configuration.
 *
 * Nine switches, down from thirteen. Two things made the old set large and both
 * are gone: the character-period rule needed its own channel switches, a holdback
 * size and a holdback ceiling, and the filler lexicon needed a switch per channel
 * because its reasoning evidence is weak. The first rule is deleted; the second
 * is now the same rule as the intent counter, whose evidence is strong on both
 * channels.
 *
 * Every field is optional here and defaulted in {@link Config}: the loader
 * validates through the schema, so `apply` sees the defaults filled in, while a
 * direct caller may omit them.
 */
export interface Config {
  /** Run the guard at all (default `true`). */
  enabled?: boolean
  /**
   * Let the bare filler vocabulary brake the reasoning channel (default `false`).
   *
   * Intent openings always may; this switch governs only the *filler* hits, whose
   * reasoning evidence is weak. The default matters and is inherited from the
   * design this rule replaced, for two measured reasons: reasoning blocks carry
   * replay signatures upstream, and assembly discards the whole replay envelope
   * when the block layout stops matching — so truncating reasoning costs the next
   * request its passback state. A bare `Writing.` in a private trace is also much
   * weaker evidence of collapse than the same word in the answer a person reads.
   *
   * Measured on the live corpus: with this off, 12 reasoning blocks brake on the
   * rule, all of them on intent evidence. Allowing filler as well brakes 20 more,
   * including a 109,217-character block.
   */
  brakeReasoning?: boolean
  /**
  * Longest clause that can still count as an announcement (default `18`).
  *
  * Load-bearing rather than cosmetic: a real planning sentence opens with
  * `Let me` and then keeps going, so measuring only the opening brakes healthy
  * work. Measured, tightening this to 12 loses half of the genuine filler and
  * loosening it to 20 admits 14 samples of real planning.
  */
  announceMax?: number
  /**
  * Non-whitespace characters tolerated between two announcements (default `20`).
  *
  * The reference measured 0 false positives in 7,395 healthy samples at 20; 30
  * produced 1.
  */
  announceGap?: number
  /** Announcements required to prove a stall (default `5`). */
  announceCount?: number
  /**
  * Fraction of the answer's lines that must already be reasoning lines before
  * the echo rule brakes (default `0.9`).
  *
  * Every measured positive scores 1.000 because it copies verbatim, so raising
  * this from 0.8 drops nothing while doubling the margin: the highest healthy
  * streaming prefix observed is 0.714.
  */
  echoMin?: number
  /** Continuations steered per turn (default 2). */
  maxContinues?: number
  /**
   * Continuations after which the prompt starts carrying a warning (default 10).
   *
   * Not a cap: the session is steered indefinitely, because a silent stop is
   * worse for the user than the degeneration it replaced. Crossing this
   * threshold appends {@link Wording.continueWarning} to the continuation so the
   * model learns that resuming has already failed repeatedly.
   */
  warnAfterContinues?: number
  /** Inject a request-side nudge on hesitation churn (default `true`). */
  hesitationNudge?: boolean
  /** Hesitation nudges allowed per session (default 2). */
  hesitationBudget?: number
  /** Emit diagnostics through the logger (default `false`). */
  verbose?: boolean
}

/** Validated plugin configuration. */
export const Config: z<Config> = z.object({
  /**
  * Run the guard at all.
  *
  * One switch rather than one per rule: the rules answer different questions but
  * share a remedy (stop the step, steer the turn), so a caller wanting the guard
  * off wants it off, and a caller wanting to tune a rule has the thresholds
  * below.
  */
  enabled: z.boolean().default(true),
  /**
   * Let the bare filler vocabulary brake the reasoning channel.
   *
   * Default `false`, and the default matters — see the interface documentation
   * above for the measured reasoning.
   */
  brakeReasoning: z.boolean().default(false),
  /**
  * Longest clause that can still count as an announcement.
  *
  * The bound is what separates "Let me check." from "Let me walk through the
  * three cases where the assembler could reorder frames."
  */
  announceMax: z.number().min(1).max(200).default(18),
  /** Non-whitespace characters tolerated between two announcements. */
  announceGap: z.number().min(0).max(500).default(20),
  /** Announcements required to prove a stall. */
  announceCount: z.number().min(1).max(50).default(5),
  /**
  * Fraction of the answer's lines that must already be reasoning lines.
  *
  * A quotation embedded in new prose does not reach this: measured over a sweep,
  * quoting 80 of 90 reasoning lines and then writing ten new lines scores 0.889,
  * and an interleaved CJK quotation scores lower still.
  */
  echoMin: z.number().min(0.1).max(1).default(0.9),
  /**
  * Continuation prompts issued per turn once a brake fires.
  *
  * The reference uses 3. A non-zero floor matters more than the exact number:
  * without a continuation the turn ends mid-sentence, which is worse for the
  * user than the filler it replaced.
  */
  maxContinues: z.number().min(0).max(10).default(2),
  /**
  * Continuations after which the prompt starts carrying a warning.
  *
  * Deliberately not a cap. A hard session budget turned the guard into a silent
  * truncator once spent: the stream was still braked, but no continuation was
  * steered and nothing durable was recorded, so the turn ended mid-thought with
  * no evidence of why. Steering without limit and escalating the wording keeps
  * the failure visible and recoverable.
  */
  warnAfterContinues: z.number().min(0).max(1000).default(10),
  /**
  * Inject a request-side nudge when the transcript shows hesitation churn (the
  * model keeps contradicting itself with Hmm / Wait / Actually openers instead of
  * making progress).
  *
  * Unlike a brake this never truncates: the churn has already finished writing by
  * the time the pattern is visible, so cutting would discard real output.
  */
  hesitationNudge: z.boolean().default(true),
  /**
  * Hesitation nudges allowed per session.
  *
  * Measured on the reference: with the cap absent, one piece of churning content
  * produced 61 consecutive nudged requests, because each nudge fed back into the
  * transcript and re-armed the detector. The cap must live in process state —
  * counting nudge markers in the transcript reported `already=0` on every one of
  * those 61 turns.
  */
  hesitationBudget: z.number().min(0).max(64).default(2),
  /**
  * Emit brake and nudge diagnostics through the logger.
  *
  * Off by default: a working guard is silent, and the only reason to turn it on
  * is to calibrate thresholds against real traffic.
  */
  verbose: z.boolean().default(false),
})

/** Resolved configuration. */
export type ResolvedConfig = Config

/** Per-session guard state. */
interface SessionState {
  /** Turn the counters below belong to; a new turn resets the per-turn one. */
  lastTurn: number
  /** Continuations steered during the current turn. */
  turnContinues: number
  /** Continuations steered over the session's lifetime. */
  spentContinues: number
  /** Hesitation nudges injected over the session's lifetime. */
  spentNudges: number
  /** Signature of the transcript already judged, so one churn is nudged once. */
  judged: string
}

/** Where a brake left the stream, recorded for the turn-stopping hook. */
interface BrakeRecord {
  /** The channel that collapsed. */
  channel: Channel
  /** Which rule fired. */
  kind: 'announce' | 'repeat' | 'echo'
  /** Hits or lines counted when the verdict fired. */
  count: number
  /** Distinct line labels, for the recycling rule; `0` otherwise. */
  span: number
  /** The clause that completed an announcement run; for the log only. */
  opener: string
}

/**
 * The wording to inject for one agent, matched to its conversation's language.
 *
 * Read at injection time rather than cached, because the first nudge of a
 * session can precede any human turn the guard has seen, and a conversation can
 * legitimately change language mid-session.
 *
 * @param session - the session whose transcript decides the language.
 * @returns the wording set for that conversation.
 */
function wordingForAgent(session: Session): Wording {
  return wordingFor(prefersCjk(session.deriveMessages()))
}

/**
 * Register the guard.
 *
 * @param ctx - plugin context; the `llm/stream` and `agent/turn-stopping`
 * listeners are added here.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  // schemastery's `.default()` fills these in for a loader-validated config, but
  // a direct caller may omit them; resolve once here so the hot path reads plain
  // booleans and numbers.
  const enabled = config.enabled ?? true
  const brakeReasoning = config.brakeReasoning ?? false
  const announceMax = config.announceMax ?? 18
  const announceGap = config.announceGap ?? 20
  const announceCount = config.announceCount ?? 5
  const echoMin = config.echoMin ?? 0.9
  const maxContinues = config.maxContinues ?? 2
  const warnAfterContinues = config.warnAfterContinues ?? 10
  const hesitationNudge = config.hesitationNudge ?? true
  const hesitationBudget = config.hesitationBudget ?? 2
  const verbose = config.verbose ?? false

  /** Per-session budgets. Keyed by id: the stream hook carries no Session object. */
  const states = new Map<SessionId, SessionState>()
  /** Brake recorded during a stream, consumed by the turn-stopping hook. */
  const brakes = new Map<SessionId, BrakeRecord>()

  const stateOf = (id: SessionId): SessionState => {
    let state = states.get(id)
    if (state === undefined) {
      state = { lastTurn: 0, turnContinues: 0, spentContinues: 0, spentNudges: 0, judged: '' }
      states.set(id, state)
    }
    return state
  }

  const log = (...args: unknown[]): void => {
    if (verbose) ctx.logger.info('[stream-guard]', ...args)
  }

  ctx.on('llm/stream', (options, next) => {
    const sessionId = options.sessionId
    // A hand-built one-shot call has no session, so there is no turn to
    // continue and no transcript to judge. Leave it entirely alone.
    if (sessionId === undefined || !enabled) return next()

    return (async function* guarded(): AsyncIterable<StreamChunk> {
      /** Layer one, one announcement counter per channel. */
      const announces: Record<Channel, AnnounceGuard> = {
        text: new AnnounceGuard(announceGap, announceCount, announceMax),
        reasoning: new AnnounceGuard(announceGap, announceCount, announceMax),
      }
      /** Layer two R1, one recycling counter per channel. */
      const repeats: Record<Channel, RepeatGuard> = {
        text: new RepeatGuard(),
        reasoning: new RepeatGuard(),
      }
      /** Layer two R2, shared: it compares the text channel against the reasoning one. */
      const echoes = new EchoGuard(echoMin)
      /**
       * Open block indexes and their kind, so a brake knows exactly which blocks
       * it must close and whether closing them is safe at all.
       */
      const open = new Map<number, Channel | 'tool-call' | 'other'>()
      /**
       * Block indexes in first-seen stream order.
       *
       * The replay envelope is aligned to this order, not to the indexes
       * themselves (`llm/src/types.ts:407-415`), so a rebuilt envelope has to be
       * assembled against it rather than against a sorted index list.
       */
      const blockOrder: number[] = []
      /**
       * Text the brake truncated, per block index.
       *
       * Only truncated *reasoning* blocks need this: their signatures are
       * rewritten from it. A truncated text block keeps its signature, which is
       * id-only and takes its text from the block.
       */
      const truncated = new Map<number, string>()
      /**
       * The upstream replay envelope, captured from the `finish` chunk.
       *
       * A braked stream discards the upstream tail, but the `finish` still
       * arrives and still carries the envelope — the signature the provider
       * would replay. Capturing it is what lets the brake rewrite it instead of
       * forfeiting it.
       */
      let envelope: unknown
      /**
       * Text actually published per block index.
       *
       * A synthesized `block-end` must carry what the consumer already received:
       * the assembler treats the payload as authoritative and ignores deltas
       * after a close (`llm/src/assembler.ts:81`), so a payload disagreeing with
       * the live stream would make the settled message differ from what the user
       * watched arrive.
       */
      const streamed = new Map<number, string>()
      /** Upstream usage, kept so a brake does not silently drop accounting. */
      let usage: StreamChunk | null = null
      /** Once a brake fires, the rest of the upstream stream is discarded. */
      let braked = false
      /** The brake produced by this stream, if any. */
      let record: BrakeRecord | null = null

      /** A delta chunk, the only kind the guard reads or rewrites. */
      type DeltaChunk = Extract<StreamChunk, { type: 'text-delta' | 'reasoning-delta' }>

      /** Append published text and hand the chunk to the consumer. */
      function* publish(chunk: DeltaChunk, text: string): Generator<DeltaChunk> {
        if (text === '') return
        streamed.set(chunk.index, (streamed.get(chunk.index) ?? '') + text)
        yield { ...chunk, text }
      }

      /**
       * Whether a block that a brake must not disturb is open.
       *
       * A half-open tool call assembles to nothing
       * (`llm/src/assembler.ts:113-118`) and an unknown block type throws outright
       * (`:119`), so braking would corrupt the step rather than shorten the
       * answer. Every rule defers while this is true; each is monotone, so the
       * verdict is re-offered and nothing is lost by waiting.
       *
       * @returns true when a non-text block is open.
       */
      function blocking(): boolean {
        for (const kind of open.values()) {
          if (kind !== 'text' && kind !== 'reasoning') return true
        }
        return false
      }

      /**
       * Judge all three rules over one delta.
       *
       * Fed the **raw** delta rather than published text: none of these rules
       * holds anything back, so a verdict is about content the stream has already
       * produced and is independent of what the consumer has been handed.
       *
       * @param target - the channel the delta belongs to.
       * @param text - the delta itself.
       * @returns the brake to apply, or `null` to keep streaming.
       */
      function judge(target: Channel, text: string): BrakeRecord | null {
        if (blocking()) return null
        // R2 first: it is the only rule that reads both channels, so it must see
        // each delta before either per-channel rule can end the stream.
        if (target === 'reasoning') echoes.feedReasoning(text)
        else {
          const ev = echoes.feedText(text)
          if (ev !== null) {
            return { channel: target, kind: 'echo', count: ev.lines, span: 0, opener: '' }
          }
        }
        const rv = repeats[target].feed(text)
        if (rv !== null) {
          return { channel: target, kind: 'repeat', count: rv.lines, span: rv.distinct, opener: '' }
        }
        const av = announces[target].feed(text)
        if (av !== null) {
          // The verdict names which vocabulary completed the run, and the channel
          // decides whether that vocabulary's evidence is strong enough here. The
          // counter is deliberately not reset when a run is inadmissible: the run is
          // real, it is the *remedy* that differs by channel, and a later intent hit
          // completes the same run and brakes normally.
          if (target === 'text' || brakeReasoning || av.kind === 'intent') {
            return { channel: target, kind: 'announce', count: av.count, span: 0, opener: av.opener }
          }
        }
        return null
      }

      for await (const chunk of next()) {
        // After a brake the upstream tail is degenerate by construction, so it is
        // discarded wholesale — but the terminal frames still have to be rebuilt
        // here, because the grammar requires a `finish` and forbids leaving a
        // block open (`llm/src/invariant.ts:75-83`).
        if (braked) {
          if (chunk.type === 'usage') usage = chunk
          else if (chunk.type === 'finish') {
            // The upstream finish still carries the provider's replay envelope,
            // even though its text was discarded. Capture it before rebuilding:
            // it is the only source of the per-block signatures.
            if (chunk.replayState !== undefined) envelope = chunk.replayState
            // Close exactly the blocks this brake cut, from their published text,
            // in index order. Nothing was held back, so `streamed` is what the
            // consumer received and the only faithful source for the payload.
            for (const [index, kind] of [...open.entries()].sort((a, b) => a[0] - b[0])) {
              // Unreachable backstop. `braked` implies every open block is text or
              // reasoning: `judge()` refuses to brake while `blocking()` is true —
              // while any open value is neither — and a braked stream discards
              // block-starts instead of recording them, so `open` cannot gain such an
              // entry afterwards. Kept because that invariant spans two functions.
              /* v8 ignore next -- see the invariant above. */
              if (kind !== 'text' && kind !== 'reasoning') continue
              const text = streamed.get(index) ?? ''
              if (kind === 'reasoning') truncated.set(index, text)
              yield {
                type: 'block-end',
                index,
                block: kind === 'text' ? { type: 'text', text } : { type: 'reasoning', text },
              }
            }
            open.clear()
            if (usage !== null) yield usage
            // Emitted as a normal `stop`. It is not an error: the loop would treat
            // `error` as a failed attempt and re-run its retry ladder over the
            // same request. The turn continues through the steering below.
            //
            // The replay envelope is rebuilt rather than dropped, and the reason
            // is the asymmetry between the two signature kinds:
            //
            // - A **text** signature is `{v:1, id}` — measured, 3570 of them, none
            //   carrying text — so pi-ai takes the text from the block
            //   (`openai-responses-shared.js:156-161`). The published text is
            //   what reaches the wire, with the original item id intact.
            // - A **reasoning** signature is replayed *verbatim*: pi-ai pushes the
            //   stored item and ignores the block text entirely
            //   (`openai-responses-shared.js:137-141`). Passing the original
            //   through would re-send the very loop that was braked, so it is
            //   rewritten to describe what was published — see `signature.ts`.
            //
            // `rebuildBrakedEnvelope` returns `undefined` for any signature shape
            // this build does not recognise, and the envelope is then dropped
            // entirely. That degrades this one assistant message to
            // provider-neutral history (`llm-pi-ai/src/replay.ts:251`,
            // `llm-deepseek/src/protocols/messages/replay.ts:49`), which keeps the
            // recovered prefix in the transcript — verified: the next request
            // carries it as an unsigned `thinking` block. Guessing at an unknown
            // shape is never an option: a wrong signature silently ships the loop.
            const rebuilt = rebuildBrakedEnvelope(envelope, blockOrder, truncated)
            yield rebuilt === undefined
              ? { type: 'finish', reason: { kind: 'stop' } }
              : { type: 'finish', reason: { kind: 'stop' }, replayState: rebuilt as never }
          }
          continue
        }

        if (chunk.type === 'block-start') {
          blockOrder.push(chunk.index)
          open.set(chunk.index, chunk.blockType === 'text' || chunk.blockType === 'reasoning'
            ? chunk.blockType
            : chunk.blockType === 'tool-call' ? 'tool-call' : 'other')
          yield chunk
          continue
        }

        if (chunk.type === 'block-end') {
          open.delete(chunk.index)
          yield chunk
          continue
        }

        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          const channel: Channel = chunk.type === 'text-delta' ? 'text' : 'reasoning'
          const brake = judge(channel, chunk.text)
          if (brake !== null) {
            record = brake
            braked = true
            log('brake', channel, 'rule', brake.kind, brake.kind === 'announce'
              ? `${brake.count} hits, last ${JSON.stringify(brake.opener)}`
              : brake.kind === 'echo'
                ? `${brake.count} lines restated`
                : `${brake.count} lines, ${brake.span} distinct`)
          }
          // Nothing is withheld, so the delta that completed the pattern is
          // published like any other: the brake stops the run growing, it does
          // not retract what the user has already been shown.
          yield* publish(chunk, chunk.text)
          continue
        }

        if (chunk.type === 'usage') {
          // Forwarded immediately, and deliberately *not* recorded as pending: a
          // usage chunk that arrived before the brake was already emitted, and
          // re-sending it at `finish` would trip the once-only rule
          // (`llm/src/invariant.ts:71`).
          yield chunk
          continue
        }

        if (chunk.type === 'finish') {
          // Only a stream that never braked reaches here; a braked one is
          // terminated in the `braked` branch above.
          yield chunk
          continue
        }

        yield chunk
      }

      // Publish the brake once the stream has settled, so the turn boundary sees
      // a record only for a stream that really was cut.
      if (record !== null) brakes.set(sessionId, record)
    })()
  })

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const sessionId = agent.session.id
    const state = stateOf(sessionId)
    // The per-turn allowance is keyed on the turn number, not reset on every
    // step: a steered continuation re-enters `preStep` within the *same* turn
    // (`agent-loop/src/agent.ts:316-322`), so a per-step reset would hand the
    // turn an unlimited supply of continuations.
    if (state.lastTurn !== turn) {
      state.lastTurn = turn
      state.turnContinues = 0
    }

    const record = brakes.get(sessionId)
    if (record !== undefined) {
      brakes.delete(sessionId)
      // Only the per-turn allowance stops steering. There is deliberately no
      // session-wide cap: when one existed, a session that spent it kept getting
      // braked but was never steered again, and because the only durable record
      // is the continuation message itself, that state was invisible in the
      // transcript — the turn just ended mid-thought. Past
      // `warnAfterContinues` the wording escalates instead of the guard giving up.
      if (state.turnContinues >= maxContinues) {
        log('continuation budget exhausted for turn', turn)
        return
      }

      state.turnContinues += 1
      state.spentContinues += 1
      const warn = state.spentContinues > warnAfterContinues

      const wording = wordingForAgent(agent.session)
      // Steering here is what keeps the turn alive: the machine re-reads its
      // inbox at this boundary and runs another step when fresh work is present
      // (`agent-loop/src/agent.ts:316-322`).
      //
      // The summary carries the diagnosis, not just the fact, because it is the
      // only durable evidence the guard leaves. `ctx.logger` output goes to a
      // 1000-message in-memory ring buffer that no shipped profile persists
      // (`vendor/cordis/src/logger.ts:213`), so a person screening a session
      // afterwards can read this line and nothing else. Naming the rule and the
      // channel here is what makes "why was my answer cut?" answerable without
      // reproducing the episode.
      //
      // No resume hint is attached, and that is deliberate rather than an
      // omission: nothing was held back, so there is no cut point to name. The
      // text the model wrote is in the transcript verbatim, and the plain
      // instruction to continue without repeating is what the measured wording
      // already says.
      agent.steer(
        createUserMessage({
          content: [{
            type: 'text',
            text: warn ? wording.continue + wording.continueWarning : wording.continue,
          }],
          source: {
            kind: 'plugin',
            plugin: name,
            form: 'notice',
            summary: `stream-guard: braked ${record.kind} on ${record.channel}`
              + (record.kind === 'announce' ? ` (${record.count} announcements)`
                : record.kind === 'echo' ? ` (${record.count} lines restated)`
                  : ` (${record.count} lines, ${record.span} distinct)`)
              + (warn ? ` [continuations ${state.spentContinues} > ${warnAfterContinues}]` : ''),
          },
        }),
      )
      log('continuation steered', state.turnContinues, '/', maxContinues,
        warn ? `(warned, ${state.spentContinues} total)` : '', 'on', record.channel)
      return
    }

    // Hesitation is judged here rather than in `preStep` because a turn that
    // completed in one step never reaches another `preStep`: it ends. Steering
    // at this boundary is what buys the nudge a request to ride on, which is the
    // reference's "inject on the next request" semantics.
    if (!hesitationNudge) return
    if (state.spentNudges >= hesitationBudget) return

    // The transcript tail is what the rule reads, and the last assistant message
    // is what it judges. A turn with no assistant message has nothing to judge.
    const messages = agent.session.deriveMessages()
    const last = messages.at(-1)
    if (last === undefined || last.role !== 'assistant') return
    const verdict = judgeHesitation(
      last.content.map(part => (part.type === 'text' ? part.text : '')).join(''),
    )
    if (verdict === null) return
    // One nudge per distinct transcript: without this the nudge's own turn would
    // be judged and nudged again, which is the 61-request feedback loop the
    // reference hit.
    if (state.judged === last.id) return
    state.judged = last.id

    state.spentNudges += 1
    log('hesitation nudge', verdict.hits, '/', verdict.lines)
    agent.steer(
      createUserMessage({
        content: [{ type: 'text', text: wordingForAgent(agent.session).hesitation }],
        source: {
          kind: 'plugin',
          plugin: name,
          form: 'notice',
          // Same reasoning as the brake summary: this is the durable evidence, so
          // it carries the measurement that justified the nudge.
          summary: `stream-guard: hesitation churn (${verdict.hits}/${verdict.lines} lines, `
            + `share ${verdict.share.toFixed(2)})`,
        },
      }),
    )
  })
}

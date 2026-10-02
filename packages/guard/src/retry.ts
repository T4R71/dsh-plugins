/**
 * Automatic retry / continuation policy.
 *
 * ## What already exists, and what this adds
 *
 * The shipped runtime **already retries provider-request failures**, and this
 * module is deliberately built on top of that rather than beside it
 * (`@deepseek-ai/dsh-llm-retry`, mounted by the `dsh-base` bundle at
 * `dsh-base/cordis.patch.yml:91-92`):
 *
 * - its listener runs on the loop's `agent/request-error` waterfall, whose
 *   `{kind:'retry'}` answer makes the loop re-run the same step
 *   (`dsh-agent-loop/lib/index.js:1109-1119`);
 * - with no `retryPolicy` in the provider configuration it resolves to
 *   `normal` mode with `maxRetries: 5`, `retryableCodes` =
 *   `[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]` and backoff
 *   `500 ms → 10 s` at `10%` jitter (`dsh-llm/lib/index.js:247-251`,
 *   `:316-322`, `resolveRetryPolicy`).
 *
 * So there is exactly one thing left to add, and this module adds only that:
 *
 * 1. **A post-delegation fallback tier.** The listener calls `next()` first —
 *    the shipped policy keeps every case it already owns — and only when the
 *    downstream chain declines (a non-retryable code, or a spent
 *    `maxRetries` budget) does this tier offer its own bounded, delayed retry.
 *    (`dsh-llm-retry/lib/index.js:215-223` is where it declines.)
 * 2. **Turn-level recovery.** A turn can also end with nothing to show — an
 *    empty assistant message, or one that is reasoning only — and that is not a
 *    request failure at all, so no request-level policy can see it. The same
 *    budget caps the continuations steered for those
 *    (see `index.ts`'s `agent/turn-stopping` arbitration).
 *
 * Both share one counter per session, so the two tiers cannot multiply into an
 * unbounded loop.
 *
 * The numbers are the ones the previous `ds-guard` proxy shipped
 * (`MAX_CONTINUES = 3`, `CONTINUE_DELAY_MS = 500`), which is what the operator
 * asked this guard to reproduce.
 *
 * @module @t4r71/dsh-guard/retry
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** Resolved automatic-retry policy. */
export interface RetryPolicy {
  /** Offer the fallback tier at all (default `true`). */
  enabled: boolean
  /** Fallback retries allowed per session (default `3`). */
  maxRetries: number
  /** Delay before a fallback retry or a recovery continuation (default `500` ms). */
  delayMs: number
  /**
   * Failure codes the fallback tier will retry.
   *
   * Deliberately **not** the shipped policy's own list: those five codes are
   * already retried upstream, and re-listing them here would only describe a
   * second retry of the same failure. These are the protocol failures the
   * shipped list omits — a stream that closed early, or a response the provider
   * adapter could not parse — where a fresh attempt is the cheapest remedy and
   * nothing retries today.
   */
  codes: readonly string[]
  /** Steer a recovery continuation for an assistant message with no blocks (default `true`). */
  onEmptyResponse: boolean
  /** Steer a recovery continuation for a turn that ended on reasoning alone (default `true`). */
  onDegenerateTurn: boolean
}

/** Default {@link RetryPolicy}. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  enabled: true,
  maxRetries: 3,
  delayMs: 500,
  codes: ['STREAM_CLOSED', 'MALFORMED_RESPONSE', 'PI_AI_ERROR'],
  onEmptyResponse: true,
  onDegenerateTurn: true,
}

/** Why a fallback retry was or was not offered. */
export type RetryDecision =
  | { readonly kind: 'retry'; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: 'decline'; readonly reason: string }

/**
 * The fallback tier's own budget, keyed by session.
 *
 * One counter for both tiers, on purpose: a session that fails at the request
 * level and then keeps closing turns with nothing in them is one session that
 * is not working, and it must not be able to spend a fresh budget each time the
 * failure changes shape.
 */
export class RetryLedger {
  private readonly policy: RetryPolicy
  private readonly spent = new Map<SessionId, number>()

  /**
   * @param policy - resolved {@link RetryPolicy}.
   */
  constructor(policy: RetryPolicy) {
    this.policy = policy
  }

  /** Retries this policy allows per session. */
  get limit(): number {
    return this.policy.maxRetries
  }

  /** Delay this policy waits before each retry, in milliseconds. */
  get delay(): number {
    return this.policy.delayMs
  }

  /** Fallback retries already granted in one session. */
  spentIn(sessionId: SessionId): number {
    return this.spent.get(sessionId) ?? 0
  }

  /**
   * Decide whether to offer one fallback retry for a request failure.
   *
   * Called only after the downstream chain has declined, so a `retry` verdict
   * here can never shadow a policy that already owns the failure.
   *
   * @param sessionId - the session the failure belongs to.
   * @param code - the failure's stable code (`LlmFailure.code`).
   * @returns the verdict, with the attempt number and the delay to wait.
   */
  decideRequestFailure(sessionId: SessionId, code: string): RetryDecision {
    if (!this.policy.enabled) return { kind: 'decline', reason: 'fallback tier disabled' }
    if (this.policy.maxRetries <= 0) return { kind: 'decline', reason: 'maxRetries is 0' }
    if (!this.policy.codes.includes(code)) return { kind: 'decline', reason: `code \`${code}\` is not in the fallback set` }
    const spent = this.spentIn(sessionId)
    if (spent >= this.policy.maxRetries) return { kind: 'decline', reason: `budget spent (\${spent}/\${this.policy.maxRetries})` }
    return { kind: 'retry', attempt: spent + 1, delayMs: this.policy.delayMs }
  }

  /**
   * Decide whether to steer one recovery continuation for a turn-level miss.
   *
   * @param sessionId - the session the turn belongs to.
   * @param reason - `empty` for a message with no blocks, `degenerate` for a
   *   turn that ended on reasoning alone.
   * @returns the verdict, with the attempt number and the delay to wait.
   */
  decideTurnRecovery(sessionId: SessionId, reason: 'empty' | 'degenerate'): RetryDecision {
    if (!this.policy.enabled) return { kind: 'decline', reason: 'fallback tier disabled' }
    if (reason === 'empty' && !this.policy.onEmptyResponse) return { kind: 'decline', reason: 'onEmptyResponse is off' }
    if (reason === 'degenerate' && !this.policy.onDegenerateTurn) return { kind: 'decline', reason: 'onDegenerateTurn is off' }
    if (this.policy.maxRetries <= 0) return { kind: 'decline', reason: 'maxRetries is 0' }
    const spent = this.spentIn(sessionId)
    if (spent >= this.policy.maxRetries) return { kind: 'decline', reason: `budget spent (\${spent}/\${this.policy.maxRetries})` }
    return { kind: 'retry', attempt: spent + 1, delayMs: this.policy.delayMs }
  }

  /**
   * Charge one granted retry against the session's budget.
   *
   * Kept separate from the decision so a caller that is cancelled during the
   * wait does not pay for a retry it never issued.
   *
   * @param sessionId - the session the retry belongs to.
   */
  spend(sessionId: SessionId): void {
    this.spent.set(sessionId, this.spentIn(sessionId) + 1)
  }
}

/**
 * Wait for `delayMs`, giving up when the turn aborts.
 *
 * The same shape the shipped policy uses for its own backoff
 * (`dsh-llm-retry/lib/index.js:83-96`): resolve `true` when the delay elapsed,
 * `false` when the signal aborted first, and never leave a timer behind.
 *
 * @param delayMs - milliseconds to wait; `0` resolves immediately.
 * @param signal - the turn's abort signal.
 * @returns whether the delay completed.
 */
export function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (delayMs <= 0) return Promise.resolve(!signal.aborted)
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

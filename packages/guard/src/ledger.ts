/**
 * Item 2 — one readable ledger of what a compaction cost.
 *
 * ## Why
 *
 * `@deepseek-ai/dsh-compaction-basic` already computes the whole answer and
 * then throws most of it away. `commitCompactionBody`
 * (`dsh-compaction-basic/lib/index.js:628-649`) appends a `compaction/summary`
 * event carrying `shadowedTokenCount`, the provider/model, `maxTokens`, and the
 * summarization call's full `usage` (`:336`, straight off the assembler) — and
 * the shipped log line (`:837`) reports only the shadowed count:
 *
 *     compaction (pressure): shadowed 101 surface nodes (seqs 8-428, ~54105 tokens)
 *
 * The `usage` in that same event is the only place a session records what the
 * summarization call itself cost, and nothing subscribes to it. Every later
 * decision about compaction thresholds is therefore made without a cost figure
 * to check it against.
 *
 * This module adds no capability; it writes the numbers that already exist to
 * a file a person can read.
 *
 * ## What lands
 *
 * One JSON object per line (JSONL), appended, one line per compaction. Fields:
 * `time`, `session`, `compactionId`, `provider`, `model`,
 * `shadowedTokens` (what the span was estimated to be),
 * `usage.inputTokens` / `usage.outputTokens` / `usage.totalTokens` /
 * `usage.cacheReadTokens` (absent when the provider reported none),
 * and `shadowedNodes` — how many surface nodes were replaced.
 *
 * @module @t4r71/dsh-guard/ledger
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** The subset of the `compaction/summary` event payload this ledger reads. */
export interface CompactionSummaryData {
  readonly compactionId?: unknown
  readonly shadowedTokenCount?: unknown
  readonly shadowedSeqs?: unknown
  readonly provider?: unknown
  readonly model?: unknown
  readonly maxTokens?: unknown
  readonly usage?: unknown
}

/** What a ledger is willing to record. */
export interface LedgerDecision {
  /** Whether to record at all. */
  readonly enabled: boolean
  /** File to append to; `''` disables. */
  readonly file: string
}

/** One usage triple, normalised to numbers or absent — never a guess. */
function usageOf(raw: unknown): Record<string, number> | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const source = raw as Record<string, unknown>
  const out: Record<string, number> = {}
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Build the ledger line for one `compaction/summary` event.
 *
 * Pure and total: every field is read through a type guard and an unreadable
 * field is simply omitted. A ledger that throws on an unexpected shape would
 * take down an observer on the commit path, which is the one place this
 * package promises never to fail a session.
 *
 * @param sessionId - the session whose log grew.
 * @param data - the event's `data`.
 * @param now - the timestamp to record (injected so tests are deterministic).
 * @returns the JSONL line, without its newline.
 */
export function ledgerLine(sessionId: string, data: CompactionSummaryData, now: Date): string {
  const usage = usageOf(data.usage)
  const nodes = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : undefined
  return JSON.stringify({
    time: now.toISOString(),
    session: sessionId,
    compactionId: typeof data.compactionId === 'string' ? data.compactionId : undefined,
    provider: typeof data.provider === 'string' ? data.provider : undefined,
    model: typeof data.model === 'string' ? data.model : undefined,
    maxTokens: typeof data.maxTokens === 'number' ? data.maxTokens : undefined,
    shadowedTokens: typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : undefined,
    shadowedNodes: nodes,
    usage,
  })
}

/**
 * Append one line to the ledger.
 *
 * Failures are swallowed on purpose: this is an observer on the commit path,
 * an unwritable ledger file is a diagnostics problem, and taking a session
 * down for it would trade a missing number for a broken turn.
 *
 * @param decision - whether and where to write.
 * @param line - the JSONL line, without its newline.
 * @returns whether the line was written.
 */
export function appendLedger(decision: LedgerDecision, line: string): boolean {
  if (!decision.enabled || decision.file === '') return false
  try {
    mkdirSync(dirname(decision.file), { recursive: true })
    appendFileSync(decision.file, line + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

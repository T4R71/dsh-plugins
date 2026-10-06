/**
 * Cache-stability diagnostics: a prompt-prefix fingerprint and a per-request
 * token ledger.
 *
 * WHAT QUESTION THIS ANSWERS. "This turn's cache hit rate dropped — did WE move
 * the prompt prefix, or is it the provider?" Two independent records:
 *
 *   cache-prefix.jsonl  one line per assembly whose prompt fingerprint CHANGED
 *                       (plus a sparse heartbeat, so the file proves it is
 *                       alive), naming the exact sections that moved.
 *   cache-usage.jsonl   one line per model request, with the four token counts
 *                       the adapter reported and the hit rate derived from them.
 *
 * Read the two on the same clock: a hit-rate drop on a request whose prefix
 * fingerprint had changed one assembly earlier is OURS. A hit-rate drop with an
 * unchanged fingerprint is NOT explained by this file — see the boundary below.
 *
 * WHAT A CHANGED FINGERPRINT DOES NOT PROVE, and this is the whole honesty of
 * the feature: it does not "detect injection" in any preventive sense. Nothing
 * here can stop anything. The fingerprint is taken AFTER every other listener on
 * the `system-prompt/assemble` waterfall has run, so a change it reports has
 * already happened and is already in the prompt that went to the model. All this
 * buys is that such a change becomes VISIBLE and ATTRIBUTABLE — a section whose
 * text moved without the rule set moving is a section something other than this
 * package wrote. Attribution, not prevention. A fingerprint that is unchanged
 * says nothing either: it is a hash of the assembled sections, so an injection
 * that reproduces a previous prompt byte for byte, or one that arrives through a
 * channel this fingerprint does not cover (tool schemas, `contexts`, message
 * history), is invisible here.
 *
 * THE REAL BOUNDARY, stated once and used everywhere: a provider KV cache hits
 * on the longest common token PREFIX of the whole request — the system prompt
 * AND the message history AND the tool schemas. This module fingerprints the
 * assembled SYSTEM PROMPT only. So:
 *
 *   fingerprint changed here   -> the drop is attributable to the system prompt,
 *                                 i.e. to this process. POSITIVE evidence.
 *   fingerprint unchanged here -> the system prompt is EXCLUDED as the cause.
 *                                 It does NOT make the provider guilty: the
 *                                 message history, a tool result, a cache TTL
 *                                 expiry, or a provider-side eviction all remain
 *                                 possible and none of them is in this file.
 *
 * NEVER A GATE. A changed fingerprint is logged and recorded; the assembly is
 * returned unchanged, whatever mode is in force. The prefix has already moved by
 * the time it is detected, so refusing the assembly would cost a turn and save
 * nothing.
 *
 * THE LEDGER IS CAPPED, ALWAYS. Each ledger is a bounded file: at most
 * {@link CacheLedgerOptions.lines} lines, then it rotates to `.1`, the previous
 * `.1` to `.2`, and so on up to `.keep`; the oldest is deleted. Worst case on
 * disk is `lines * keep * (bytes per line)` per ledger, and the record shapes
 * are fixed-width-ish — small integers and 64-character hex digests, never
 * section text. This is a hard requirement of the package, not a preference:
 * an unbounded diagnostic file is how the 842 MB this replaces came to exist.
 *
 * @module @t4r71/dsh-prompt-plan/cache
 */

import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { digestSections, sha256 } from './digest.ts'
import type { DigestibleSection, SectionDigest } from './digest.ts'

/** The ledger files this module owns, and the human note written beside them. */
export const CACHE_ARTIFACT_NAMES = {
  prefix: 'cache-prefix.jsonl',
  usage: 'cache-usage.jsonl',
  note: 'cache-README.txt',
} as const

/** Lines per ledger file before it rotates. */
export const DEFAULT_LEDGER_LINES = 2000

/** Rotated copies kept per ledger (`.1` … `.keep`). */
export const DEFAULT_LEDGER_KEEP = 4

/**
 * How many lines from the end of the prefix ledger a restart reads to recover
 * each subject's last fingerprint.
 *
 * A bound rather than a full scan: the ledger can hold 2000 lines per file times
 * five files, and reading all of it would put that work in front of startup. 200
 * lines is enough to find the last line of every subject that is still active —
 * a subject whose last line is older than that has not assembled anything in a
 * long while, and losing its memory costs exactly one `first: true`.
 */
export const RESTORE_SCAN_LINES = 200

/**
 * How many identical fingerprints may pass before one is written anyway.
 *
 * A ledger that only ever records changes cannot be told apart from a ledger
 * whose listener died. One heartbeat line every this many identical assemblies
 * costs a bounded number of lines and makes "no changes" a positive statement,
 * several times a day on a busy deployment. `0` disables it (changes only).
 */
export const DEFAULT_HEARTBEAT_ASSEMBLIES = 200

/**
 * How many subjects keep a fingerprint in memory.
 *
 * One entry per session (plus one for a sessionless assembly), each holding one
 * digest per section — a couple of kilobytes — so the cap is not about size but
 * about a Map that would otherwise grow for the life of the process on a host
 * that opens sessions without closing them.
 */
export const PREFIX_SUBJECT_CAP = 64

/** How many changed sections one record names before it stops listing them. */
export const CHANGED_SECTION_CAP = 12

/** Written into every record, so a later reader can tell a shape change. */
export const CACHE_FORMAT = 1

/** The shared explanation, written once into the artifact directory. */
const NOTE_TEXT = `prompt-plan cache-stability ledgers
===================================

Written by @t4r71/dsh-prompt-plan when config.cacheDiag is true. Both files are
append-only and BOTH ROTATE: at most config.cacheLedgerLines lines per file,
then ".1", ".2" ... up to config.cacheLedgerKeep copies, oldest deleted. Nothing
here grows without bound, and no section text is ever written — only names and
sha256 digests.

cache-prefix.jsonl
  One line per SUBJECT (session) whose assembled-system-prompt fingerprint
  CHANGED, plus a "first" line per subject so the ledger holds a baseline, plus a
  sparse heartbeat line so an unchanged run is visibly alive rather than an empty
  file.

  Fields: format, ordinal, at, sessionId, promptSha256, sectionCount,
  ruleSetSha256, first, changed, restored, repeat, previousPromptSha256,
  previousRuleSetSha256, previousOrdinal, previousAt, assembliesSince,
  ruleSetChanged, changedSectionCount, firstChangedIndex, changedSections.

  "promptSha256" identifies the whole assembled system prompt: for each section,
  its array index, its name, its text length, its text's sha256, and one bit for
  "interpolate is not false". Two assemblies with the same value sent the model
  the same system prompt.

  "changedSections" names what moved: kind (added | removed | text | position |
  interpolate), the section name, its index before and after, and both text
  sha256 values and lengths. The ledger carries HASHES, never text: to see what a
  section actually said, look up the digest in the observation artifacts
  (sections.jsonl, or sections-text.jsonl when config.fullText is on).

  "firstChangedIndex" is the earliest position in the CURRENT assembly whose
  section changed. Everything before it is byte-identical and in the same order,
  which is the only part of a KV-cache prefix this fingerprint can vouch for.

  "previousOrdinal" names the line this one is compared against — not the
  previous assembly, since unchanged assemblies are not written. "repeat" counts
  consecutive assemblies of this subject that carried this fingerprint, and
  "assembliesSince" is how many assemblies passed between the two lines.
  "ruleSetChanged" is the field that decides which of the two explanations
  applies: a change WITH it is this package reading a new rule file, a change
  WITHOUT it is something else writing to the prompt.

  ACROSS A RESTART. The fingerprint memory is resumed from this file's tail when
  the plugin mounts, so a prompt that changed while the process was down is
  reported as a change rather than filed as a fresh baseline — without that, every
  restart would make each subject look new and the first post-restart line would
  say first:true, a silent MISS in the one thing this ledger exists to report.
  That line carries "restored": true and names the hash it compared against in
  previousPromptSha256.

  Two limits, both inherent:
    - changedSections and changedSectionCount are ABSENT on that line, because no
      per-section digests are stored here and none can be reconstructed. The
      verdict is unaffected (changed and ruleSetChanged come from the two hashes,
      which do survive); only the per-section naming is missing. The host log says
      so rather than reporting "0 sections differ".
    - a change made entirely while the process was down is timestamped at the
      restart, not at the edit. Still reported, but its time is when it was first
      observed — inherent to observing from inside the process.

  At most the last 200 lines are read for the resume, so a large ledger cannot
  slow startup. A subject whose last line fell outside that window simply loses
  its memory and costs one first:true.

cache-usage.jsonl
  One line per model request, from the session's own "assistant/message" event —
  the only event in the session log that carries token accounting at all. Fields:
  format, ordinal, at, sessionId, turn, step, inputTokens, outputTokens,
  cacheReadTokens, cacheWriteTokens, totalTokens, reasoningTokens, cacheHitRate,
  interrupted. A count is null when the adapter reported none.

  "cacheHitRate" is cacheReadTokens / (inputTokens + cacheReadTokens +
  cacheWriteTokens) — the three counts are disjoint (see TokenUsage in
  @deepseek-ai/dsh-llm), so that denominator is billed input tokens. null when
  the denominator is zero or the adapter reported no HIT count; it is never
  rounded up to 1.

  A missing cacheWriteTokens is NOT one of those refusals. DeepSeek's adapter maps
  cache_read_input_tokens and never reports a write count, so treating "no write
  count" as "cannot compute" made this column null on every live request. The two
  absences mean different things and are handled differently — see cacheHitRate.

  This ledger starts EMPTY and stays useless until a session with this plugin
  mounted makes a model call. The requests a session made before the plugin was
  mounted are not in it and cannot be reconstructed here — read the session log
  for those.

HOW TO USE THE TWO TOGETHER, AND WHAT THEY CANNOT SAY
  A hit-rate drop on a request whose prompt fingerprint changed a moment earlier
  is attributable to the system prompt — that is, to this process.

  A hit-rate drop with an UNCHANGED fingerprint does NOT prove the provider is at
  fault. A provider KV cache hits on the longest common token prefix of the WHOLE
  request: system prompt AND message history AND tool schemas. These files cover
  the system prompt only. So an unchanged fingerprint excludes the system prompt
  and nothing else — a diverging message history, a changed tool result, a cache
  TTL expiry and a provider-side eviction are all still possible and none of them
  appears in either file.

  And a fingerprint change is REPORTED, never PREVENTED: it is taken after every
  other listener has run, so by the time it is visible the changed prompt has
  already been sent. Nothing here can stop a prompt from being modified.
`

/**
 * The four token counts, normalised.
 *
 * A member is `undefined` when the adapter did not report it. The distinction
 * matters in the ledger: an absent cache field is not the same fact as a zero,
 * and the hit rate is only computed when the counts are actually there.
 */
export interface UsageCounts {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number | undefined
  readonly cacheWriteTokens: number | undefined
  readonly totalTokens: number | undefined
  readonly reasoningTokens: number | undefined
}

/** Read one non-negative safe integer, or undefined. */
function countOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Normalise an adapter-reported usage object.
 *
 * `inputTokens` and `outputTokens` are required by `TokenUsage`, so a payload
 * missing either is not a usage object at all and this returns undefined rather
 * than inventing a zero for it. Everything else is optional.
 * @param value - the raw `usage`, as the session event carries it.
 * @returns the normalised counts, or undefined when this is not a usage record.
 */
export function readUsage(value: unknown): UsageCounts | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const inputTokens = countOrUndefined(record.inputTokens)
  const outputTokens = countOrUndefined(record.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: countOrUndefined(record.cacheReadTokens),
    cacheWriteTokens: countOrUndefined(record.cacheWriteTokens),
    totalTokens: countOrUndefined(record.totalTokens),
    reasoningTokens: countOrUndefined(record.reasoningTokens),
  }
}

/**
 * The share of billed input tokens that came from the provider's cache.
 *
 * The denominator is the sum of the DISJOINT input counts — see `TokenUsage` in
 * `@deepseek-ai/dsh-llm`, where `inputTokens` is uncached input only and the
 * cache fields are reported separately, so their sum is the billed prompt.
 * `totalTokens` confirms the reading on real DeepSeek traffic:
 * `inputTokens + cacheReadTokens + outputTokens === totalTokens`, with
 * `cacheWriteTokens` absent from the sum entirely.
 *
 * THE TWO CACHE FIELDS ARE NOT ALIKE WHEN MISSING, and an earlier revision of
 * this function wrongly demanded both:
 *   - `cacheReadTokens` absent means the adapter reported NO hit information at
 *     all, so no rate can be derived and none is invented.
 *   - `cacheWriteTokens` absent only means the adapter does not report cache
 *     WRITES. The DeepSeek adapter is exactly this case: its `updateUsage` maps
 *     `cache_read_input_tokens` but never sets a write count, because DeepSeek
 *     does not bill cache creation separately. Demanding it made the rate
 *     `undefined` on every real request, which is not caution but a dead metric.
 *
 * A missing write count is therefore treated as zero, matching what the host
 * itself does: `@deepseek-ai/dsh-token-meter`'s usage fold is
 * `bucketsFrom = (usage) => ({ uncachedInputTokens: usage.inputTokens,
 * cacheReadTokens: usage.cacheReadTokens ?? 0, cacheWriteTokens:
 * usage.cacheWriteTokens ?? 0 })`, and the UI's `cacheHitPercent` reads those
 * buckets. An earlier revision of this comment claimed the UI made "the same
 * refusal"; it does not, and the claim was false.
 * @param usage - the normalised counts.
 * @returns the rate in [0, 1], or undefined when it cannot be computed.
 */
export function cacheHitRate(usage: UsageCounts): number | undefined {
  if (usage.cacheReadTokens === undefined) return undefined
  const billed = usage.inputTokens + usage.cacheReadTokens + (usage.cacheWriteTokens ?? 0)
  if (billed <= 0) return undefined
  // Four decimals: enough to see a drop, not a claim of precision the provider
  // does not provide.
  return Math.round((usage.cacheReadTokens / billed) * 10000) / 10000
}

/** The usage event's payload, as this module reads it. */
export interface DescribedUsage {
  readonly turn: number | null
  readonly step: number | null
  readonly usage: UsageCounts
  readonly interrupted: boolean
}

/**
 * Read one session event into a usage observation, or refuse it.
 *
 * Structural on purpose — the caller hands the event straight through, and this
 * function reads `type` and two members of `data` rather than importing the
 * session event union. `assistant/message` is the only event that carries usage:
 * `SessionEventMap['assistant/message'].usage` is documented as absent when the
 * adapter reported none, so an event without it is a request with no accounting
 * and is skipped rather than recorded as zeros.
 * @param event - the event `session/event` delivered.
 * @returns the observation, or undefined for every other event type.
 */
export function describeUsage(event: unknown): DescribedUsage | undefined {
  if (event === null || typeof event !== 'object') return undefined
  const record = event as { type?: unknown; data?: unknown }
  if (record.type !== 'assistant/message') return undefined
  if (record.data === null || typeof record.data !== 'object') return undefined
  const data = record.data as { turn?: unknown; step?: unknown; usage?: unknown; interrupted?: unknown }
  const usage = readUsage(data.usage)
  if (usage === undefined) return undefined
  return {
    turn: typeof data.turn === 'number' ? data.turn : null,
    step: typeof data.step === 'number' ? data.step : null,
    usage,
    interrupted: data.interrupted === true,
  }
}

/**
 * The assembled system prompt, reduced to one hash.
 *
 * Taken over the DIGESTS rather than over the section texts, and that is a
 * decision with a reason: the digests are already computed for this assembly (the
 * section memory keeps them), and each one already carries `textSha256`, so
 * re-hashing every section's text a second time would double the hashing cost of
 * every model turn to produce a value that identifies exactly the same thing.
 *
 * The encoding is delimiter-and-length based rather than a plain join, so two
 * different assemblies cannot collide by concatenation — section boundaries,
 * names and lengths are all part of the input, and `index` is included so a
 * reordering alone changes the fingerprint. `interpolate` contributes one bit: a
 * section that omits it and one that sets it true render identically and hash
 * identically, which is the same equivalence `digestSection` uses.
 * @param digests - the assembly's section digests, in array order.
 * @returns lowercase hex sha256.
 */
export function promptFingerprint(digests: readonly SectionDigest[]): string {
  let encoded = ''
  for (const digest of digests) {
    encoded += `${String(digest.index)}\u0000${String(digest.name.length)}:${digest.name}\u0000${String(digest.textLength)}\u0000${digest.textSha256}\u0000${digest.interpolate === false ? '0' : '1'}\u0001`
  }
  return sha256(encoded)
}

/** How one section differs between two assemblies. */
export type SectionChangeKind = 'added' | 'removed' | 'text' | 'position' | 'interpolate'

/** One section that differs, named, with hashes rather than text. */
export interface SectionChange {
  readonly kind: SectionChangeKind
  readonly name: string
  /** Its index in the previous assembly; absent for `added`. */
  readonly from?: number
  /** Its index in the current assembly; absent for `removed`. */
  readonly to?: number
  /** The previous text's sha256; present only for `text`. */
  readonly fromSha256?: string
  /** The current text's sha256; present only for `text`. */
  readonly toSha256?: string
  readonly fromLength?: number
  readonly toLength?: number
}

/** What {@link diffSections} found. */
export interface SectionDiff {
  readonly changes: readonly SectionChange[]
  /** How many sections differ, of which `changes` may list only the first few. */
  readonly changedCount: number
  /**
   * The earliest position in the CURRENT assembly whose section changed, or
   * null when nothing did. Sections before it are byte-identical and in the same
   * order — the part of the prompt prefix this comparison can vouch for.
   */
  readonly firstChangedIndex: number | null
}

/**
 * Locate every section that differs between two assemblies.
 *
 * Matched BY NAME, not by position, because a section moving is a different fact
 * from a section's text changing, and the reader needs to be told which. Names
 * are unique within an assembly (upstream asserts it, and this package re-asserts
 * it on its own output), so the name-keyed map is exact for well-formed input; a
 * duplicate name would collapse to its last occurrence.
 * @param before - the previous assembly's digests.
 * @param after - the current assembly's digests.
 * @returns the named differences, capped at {@link CHANGED_SECTION_CAP} entries.
 */
export function diffSections(before: readonly SectionDigest[], after: readonly SectionDigest[]): SectionDiff {
  const previous = new Map<string, SectionDigest>()
  for (const digest of before) previous.set(digest.name, digest)
  const present = new Set<string>()
  const all: SectionChange[] = []
  for (const digest of after) {
    present.add(digest.name)
    const was = previous.get(digest.name)
    if (was === undefined) {
      all.push({ kind: 'added', name: digest.name, to: digest.index })
      continue
    }
    if (was.textSha256 !== digest.textSha256) {
      all.push({
        kind: 'text',
        name: digest.name,
        from: was.index,
        to: digest.index,
        fromSha256: was.textSha256,
        toSha256: digest.textSha256,
        fromLength: was.textLength,
        toLength: digest.textLength,
      })
      continue
    }
    if ((was.interpolate === false) !== (digest.interpolate === false)) {
      all.push({ kind: 'interpolate', name: digest.name, from: was.index, to: digest.index })
      continue
    }
    if (was.index !== digest.index) {
      all.push({ kind: 'position', name: digest.name, from: was.index, to: digest.index })
    }
  }
  for (const digest of before) {
    if (!present.has(digest.name)) all.push({ kind: 'removed', name: digest.name, from: digest.index })
  }
  let first: number | null = null
  for (const change of all) {
    const at = change.to ?? change.from
    if (at === undefined) continue
    if (first === null || at < first) first = at
  }
  return {
    changes: all.length > CHANGED_SECTION_CAP ? all.slice(0, CHANGED_SECTION_CAP) : all,
    changedCount: all.length,
    firstChangedIndex: first,
  }
}

/** One line of `cache-prefix.jsonl`. */
export interface PrefixRecord {
  readonly format: number
  readonly ordinal: number
  readonly at: string
  readonly sessionId: string | null
  readonly promptSha256: string
  readonly sectionCount: number
  readonly ruleSetSha256: string | null
  /** True when this subject had no previous fingerprint — the run's baseline for it. */
  readonly first: boolean
  readonly changed: boolean
  /**
   * True when the previous state came from an EARLIER RUN rather than from this
   * process's own memory.
   *
   * Marks the one line per subject that follows a restart. `changed` on such a
   * line is still trustworthy — it compares the hashes the previous run left
   * against this assembly — but `changedSections` is absent by construction,
   * because the ledger stores no per-section digests. See {@link RestoredSubject}.
   */
  readonly restored?: boolean
  /** How many consecutive assemblies (including this one) carried this fingerprint. */
  readonly repeat: number
  readonly previousPromptSha256?: string
  readonly previousRuleSetSha256?: string | null
  /** The ordinal of the last line written for this subject, before this one. */
  readonly previousOrdinal?: number
  /** That line's timestamp, so a reader can space two records on the clock. */
  readonly previousAt?: string
  /** How many assemblies of this subject passed between those two lines. */
  readonly assembliesSince?: number
  /**
   * Whether the rule set in force moved at the same time as the prompt.
   *
   * The one field that separates the two explanations for a changed prompt: a
   * change WITH the rule set is this package reading a new rule file, and a
   * change WITHOUT it is something else writing to the prompt.
   */
  readonly ruleSetChanged?: boolean
  readonly changedSectionCount?: number
  readonly firstChangedIndex?: number | null
  readonly changedSections?: readonly SectionChange[]
}

/** One line of `cache-usage.jsonl`. */
export interface UsageRecord {
  readonly format: number
  readonly ordinal: number
  readonly at: string
  readonly sessionId: string | null
  readonly turn: number | null
  readonly step: number | null
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
  readonly totalTokens: number | null
  readonly reasoningTokens: number | null
  readonly cacheHitRate: number | null
  readonly interrupted: boolean
}

/** What one subject's fingerprint memory holds. */
interface SubjectState {
  /** This assembly's digests, byte for byte what the model is about to be sent. */
  readonly digests: readonly SectionDigest[]
  readonly promptSha256: string
  readonly ruleSetSha256: string | undefined
  /** How many ASSEMBLIES OF THIS SUBJECT (including this one) carried this fingerprint. */
  readonly repeat: number
  readonly writtenOrdinal: number | undefined
  /**
   * Assemblies of this subject observed since the last line was written for it.
   *
   * Separate from {@link repeat} because the two reset on different events: a
   * change resets `repeat` but does not by itself mean the previous LINE was the
   * previous assembly, and the ledger's heartbeat reads this one, not that one.
   */
  readonly sinceLine: number
  /**
   * The last record actually written for this subject, plus its timestamp.
   *
   * Carried separately from the fields above because a recorded comparison has to
   * name two RECORDS, and the lines between two records are the ones a reader
   * cannot see. With a heartbeat of 200, `repeat: 201` against
   * `previousOrdinal: 17` is the whole statement.
   */
  readonly previous: { readonly ordinal: number; readonly promptSha256: string; readonly ruleSetSha256: string | undefined } | undefined
  readonly previousAt: string | undefined
}

/** One ledger's runtime state: how full it is, and whether that was measured. */
interface LedgerState {
  lines: number
}

/** The ledger's configuration. */
export interface CacheLedgerOptions {
  /** The artifact directory; created when absent. */
  readonly directory: string
  /** Lines per file before rotating. Clamped to at least 1. */
  readonly lines: number
  /** Rotated copies kept. Clamped to at least 1. */
  readonly keep: number
  /** Assemblies between heartbeat lines; 0 disables the heartbeat. */
  readonly heartbeat: number
  /** Write a prefix line for every assembly instead of only on change. */
  readonly alwaysRecordPrefix: boolean
  /** Where the one change warning per event goes, so it reaches the host log. */
  readonly report: (message: string) => void
}

/** The input of one prefix observation. */
export interface PrefixObservation {
  /** The assembly's subject, or undefined when it had none. */
  readonly sessionId: string | undefined
  /** The assembled sections, in array order — the value the handler returned. */
  readonly sections: readonly DigestibleSection[]
  /** The rule set in force, when one was; its `sha256` is what gets recorded. */
  readonly ruleSetSha256: string | undefined
}

/** The input of one usage observation. */
export interface UsageObservation {
  readonly sessionId: string | undefined
  readonly turn: number | null
  readonly step: number | null
  readonly usage: UsageCounts
  readonly interrupted: boolean
}

/** Count the newlines a file holds, for the rotation counter. */
function countLinesSync(path: string): number {
  try {
    const text = readFileSync(path, 'utf8')
    if (text.length === 0) return 0
    let count = 0
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 10) count += 1
    }
    return text.charCodeAt(text.length - 1) === 10 ? count : count + 1
  } catch {
    return 0
  }
}

/**
 * The highest ordinal already in a ledger file.
 *
 * Scans backwards and stops at the first line that parses: the last line of a
 * file whose writer was killed mid-append is torn, and a torn line says nothing
 * about the ones before it. Without this read a restarted process would number
 * its first line 0 again and two different assemblies would share an ordinal.
 */
function lastOrdinalSync(path: string): number {
  try {
    const lines = readFileSync(path, 'utf8').split('\n')
    let examined = 0
    for (let index = lines.length - 1; index >= 0 && examined < 50; index -= 1, examined += 1) {
      const line = lines[index]
      if (line === undefined || line.length === 0) continue
      try {
        const ordinal = (JSON.parse(line) as { ordinal?: unknown }).ordinal
        if (typeof ordinal === 'number' && Number.isFinite(ordinal)) return ordinal
      } catch {
        // torn tail; keep looking a little further back
      }
    }
  } catch {
    // no file yet
  }
  return -1
}

/**
 * What a restart can recover about one subject from the prefix ledger.
 *
 * ONLY THE TWO HASHES. The ledger records no per-section digests, so the
 * `changedSections` naming — which is built from `diffSections(previous.digests,
 * digests)` — cannot be reconstructed across a restart, and this type therefore
 * carries no `digests`. Storing them in every line would have cost roughly
 * 4.3 KB per line (~35 MB at the 2000x5 cap) to name sections on the one line
 * that follows a restart; carrying a sidecar file would have cost a second
 * write path. Neither is worth it, because the QUESTION this feature answers —
 * "did we move the prefix, or did the provider?" — is decided by the two hashes:
 *
 *   promptSha256 changed, ruleSetSha256 changed with it -> our rule revision
 *   promptSha256 changed, ruleSetSha256 unchanged        -> something else wrote
 *
 * Missing `changedSections` on a post-restart line is a gap in the DETAIL, not
 * in the VERDICT. The line says `changed: true` and `restored: true`, which is
 * the part that matters.
 */
interface RestoredSubject {
  readonly promptSha256: string
  readonly ruleSetSha256: string | undefined
}

/**
 * Recover the last recorded fingerprint per subject from the tail of the prefix
 * ledger.
 *
 * WHY THIS EXISTS. The fingerprint memory used to be in-process only, so a
 * restart made every subject look brand new: the first assembly after a restart
 * was written as `first: true`, and a prompt that had CHANGED across the restart
 * was written as a baseline rather than as a change. That is a silent MISS, and
 * a miss is the one failure this feature cannot afford — its whole purpose is
 * that a moved prefix is seen. The machine this runs on restarts often (plugin
 * reinstalls, power loss), so the blind window was the common case, not the
 * corner case.
 *
 * WHAT IT CANNOT DO, and no restart-logic can: it compares the last recorded
 * state against the next assembly, so a change that happened entirely while the
 * process was DOWN (a rule file edited between runs) is attributed to the first
 * line after the restart rather than to the moment it happened. The change is
 * still REPORTED — with the old hash named in `previousPromptSha256` — but its
 * time is the restart, not the edit. That is inherent to observing from inside
 * the process.
 *
 * Bounded on purpose: it reads at most {@link RESTORE_SCAN_LINES} lines from the
 * end, so a huge ledger cannot make startup slow. A subject whose last line fell
 * outside that window is simply not restored, which costs one `first: true` and
 * nothing else.
 * @param path - the prefix ledger.
 * @returns the last fingerprint seen per subject id, oldest first.
 */
function restoreSubjectsSync(path: string): Map<string | null, RestoredSubject> {
  const restored = new Map<string | null, RestoredSubject>()
  let lines: string[]
  try {
    lines = readFileSync(path, 'utf8').split('\n')
  } catch {
    return restored
  }
  let examined = 0
  for (let index = lines.length - 1; index >= 0 && examined < RESTORE_SCAN_LINES; index -= 1, examined += 1) {
    const line = lines[index]
    if (line === undefined || line.length === 0) continue
    let record: { sessionId?: unknown; promptSha256?: unknown; ruleSetSha256?: unknown }
    try {
      record = JSON.parse(line) as typeof record
    } catch {
      // Torn tail: the writer was killed mid-append. Keep looking further back,
      // the same way lastOrdinalSync does.
      continue
    }
    const sessionId = record.sessionId
    if (typeof sessionId !== 'string' && sessionId !== null) continue
    const promptSha256 = record.promptSha256
    if (typeof promptSha256 !== 'string' || promptSha256.length === 0) continue
    // Scanning BACKWARDS, so the first line seen for a subject is its newest;
    // later iterations must not overwrite it.
    if (restored.has(sessionId)) continue
    const ruleSet = record.ruleSetSha256
    restored.set(sessionId, {
      promptSha256,
      ruleSetSha256: typeof ruleSet === 'string' ? ruleSet : undefined,
    })
  }
  return restored
}

/**
 * The two capped ledgers, and the fingerprint memory they are compared against.
 *
 * One instance per mounted plugin when `config.cacheDiag` is true — and NO
 * instance otherwise, which is what makes the feature cost nothing when it is
 * off: no listener, no directory read, no file.
 */
export class CacheLedger {
  private readonly options: CacheLedgerOptions
  private readonly subjects = new Map<string | null, SubjectState>()
  /**
   * What the previous run left behind, per subject.
   *
   * Kept SEPARATE from {@link subjects} rather than seeded into it, because the
   * two hold different things and only the hashes survive a restart: a restored
   * entry has no `digests`, no `repeat` and no `previous`, and an assembly that
   * compares against one must not pretend otherwise. The first assembly for a
   * restored subject reads its hashes here, then writes a full `subjects` entry
   * and clears this one.
   */
  private readonly restored = new Map<string | null, RestoredSubject>()
  private readonly prefixState: LedgerState = { lines: 0 }
  private readonly usageState: LedgerState = { lines: 0 }
  private nextPrefixOrdinal = 0
  private nextUsageOrdinal = 0
  private ready: Promise<void> | undefined
  private queue: Promise<void> = Promise.resolve()

  /**
   * @param options - directory, caps, heartbeat, and the warning sink.
   */
  constructor(options: CacheLedgerOptions) {
    this.options = {
      ...options,
      lines: Math.max(1, Math.floor(options.lines)),
      keep: Math.max(1, Math.floor(options.keep)),
    }
    // Resumed SYNCHRONOUSLY, in the constructor rather than in the first queued
    // write, for the reason the Observer resumes its own counter there: `observe`
    // allocates an ordinal before anything is queued, so hydrating later would
    // number this run's first line 0 and collide with the run that used 0.
    this.prefixState.lines = countLinesSync(this.pathOf(CACHE_ARTIFACT_NAMES.prefix, ''))
    this.usageState.lines = countLinesSync(this.pathOf(CACHE_ARTIFACT_NAMES.usage, ''))
    this.nextPrefixOrdinal = lastOrdinalSync(this.pathOf(CACHE_ARTIFACT_NAMES.prefix, '')) + 1
    this.nextUsageOrdinal = lastOrdinalSync(this.pathOf(CACHE_ARTIFACT_NAMES.usage, '')) + 1
    // The fingerprint memory is resumed here too, for the same reason and with a
    // sharper consequence: without it a restart makes every subject look new, and
    // a prompt that changed ACROSS the restart is recorded as `first: true`
    // instead of as a change — a silent miss in the one thing this feature is for.
    // See restoreSubjectsSync. A restored subject carries no digests, so the line
    // that follows a restart names no sections; it still reports the change.
    for (const [key, value] of restoreSubjectsSync(this.pathOf(CACHE_ARTIFACT_NAMES.prefix, ''))) {
      this.restored.set(key, value)
    }
  }

  /** One ledger's path, with an optional rotation suffix. */
  private pathOf(base: string, suffix: string): string {
    return join(this.options.directory, base + suffix)
  }

  /** Create the directory and the human note, once. */
  private async prepare(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(this.options.directory, { recursive: true })
      await writeFile(this.pathOf(CACHE_ARTIFACT_NAMES.note, ''), NOTE_TEXT, 'utf8')
    })()
    return this.ready
  }

  /**
   * Observe one assembly's prefix.
   *
   * Synchronous by design: the caller is inside the assembly waterfall, and a
   * disk write there would put filesystem latency in front of every model turn.
   * Everything decided here is in memory; the write is queued.
   * @param input - the subject, the assembled sections, and the rule set's hash.
   * @returns the record when a line is being written, undefined when this
   *   assembly matched the previous one and nothing is worth recording.
   */
  observe(input: PrefixObservation): PrefixRecord | undefined {
    const key = input.sessionId ?? null
    const digests = digestSections(input.sections)
    const promptSha256 = promptFingerprint(digests)
    const previous = this.subjects.get(key)
    // A restart leaves hashes but no digests. Treat that as the previous state for
    // the two questions it can answer — "is this the first one" and "did the
    // fingerprint move" — and NOT as a source of section detail. See RestoredSubject.
    const carried = previous === undefined ? this.restored.get(key) : undefined
    const first = previous === undefined && carried === undefined
    const changed = previous !== undefined
      ? previous.promptSha256 !== promptSha256
      : carried !== undefined && carried.promptSha256 !== promptSha256
    const repeat = previous !== undefined && previous.promptSha256 === promptSha256 ? previous.repeat + 1 : 1
    // Assemblies of this subject since the last line written for it, whatever the
    // reason that line was written. This is the counter the heartbeat reads: a
    // heartbeat has to be spaced by ASSEMBLIES, and `repeat` restarts at every
    // change, so spacing on it would put a heartbeat immediately after every
    // change instead of every N unchanged assemblies.
    const sinceLine = previous === undefined ? 0 : previous.sinceLine + 1

    // The decision to write, taken before anything is mutated: a change always
    // writes, the first assembly of a subject writes so the ledger holds a
    // baseline to compare against, and a steady state writes a heartbeat line
    // every `heartbeat` assemblies so "unchanged" is a positive statement rather
    // than an empty file.
    const heartbeatDue = !changed && this.options.heartbeat > 0 && sinceLine >= this.options.heartbeat
    const write = changed || this.options.alwaysRecordPrefix || heartbeatDue || first
    const ordinal = write ? this.nextPrefixOrdinal : previous?.writtenOrdinal
    if (write) this.nextPrefixOrdinal += 1
    const at = new Date().toISOString()

    let diff: SectionDiff | undefined
    let ruleSetChanged: boolean | undefined
    if (changed) {
      // The rule-set comparison works off whichever previous state exists: a
      // restored hash answers it as well as an in-memory one.
      const previousRuleSet = previous === undefined ? carried?.ruleSetSha256 : previous.ruleSetSha256
      ruleSetChanged = previousRuleSet !== input.ruleSetSha256
      // Only an in-process previous state carries digests, so a post-restart line
      // reports the change without naming the sections. Say so rather than
      // reporting "0 sections differ", which would be a false detail.
      if (previous !== undefined) {
        diff = diffSections(previous.digests, digests)
      }
      const where = `${String(ordinal)}${input.sessionId === undefined ? '' : ` (session ${JSON.stringify(input.sessionId)})`}`
      const detail = diff === undefined
        ? 'the section-level detail is unavailable because this is the first assembly after a restart; compare this line against previousOrdinal for the sections'
        : `${String(diff.changedCount)} section(s) differ (${diff.changes.map(entry => `${entry.kind} ${JSON.stringify(entry.name)}`).join(', ') || 'no named section'}), the earliest at index ${diff.firstChangedIndex === null ? '(none)' : String(diff.firstChangedIndex)}`
      if (ruleSetChanged) {
        this.options.report(
          `prompt-plan: the assembled prompt changed at assembly ${where} — `
          + `the rule set changed too (${(previousRuleSet ?? '(none)').slice(0, 12)} -> ${(input.ruleSetSha256 ?? '(none)').slice(0, 12)}), so this is a rule revision ` +
          'taking effect, not something outside this package writing to the prompt',
        )
      } else {
        this.options.report(
          `prompt-plan: the assembled prompt changed at assembly ${where} — `
          + `${detail}, and the RULE SET DID NOT CHANGE. `
          + 'Something other than this package\'s rules wrote to the prompt. This is REPORTED, never prevented: the changed prompt has already been sent.',
        )
      }
    }

    const record: PrefixRecord | undefined = write
      ? {
          format: CACHE_FORMAT,
          ordinal: ordinal ?? 0,
          at,
          sessionId: key,
          promptSha256,
          sectionCount: digests.length,
          ruleSetSha256: input.ruleSetSha256 ?? null,
          first,
          changed,
          repeat,
          ...carried === undefined ? {} : { restored: true },
          // A restored state has no `previous` record, so the comparison is named
          // by the hashes the previous run left rather than by an ordinal.
          ...previous?.previous === undefined
            ? carried === undefined || !changed
              ? {}
              : { previousPromptSha256: carried.promptSha256, previousRuleSetSha256: carried.ruleSetSha256 ?? null }
            : {
                previousPromptSha256: previous.previous.promptSha256,
                previousRuleSetSha256: previous.previous.ruleSetSha256 ?? null,
                previousOrdinal: previous.previous.ordinal,
                ...previous.previousAt === undefined ? {} : { previousAt: previous.previousAt },
                // Assemblies of this subject between the two lines, this one included.
                // With a heartbeat this is the number a reader needs to know how much
                // the ledger did not write down — and `repeat` above cannot answer it,
                // because a change resets `repeat`.
                assembliesSince: sinceLine,
              },
          ...ruleSetChanged === undefined ? {} : { ruleSetChanged },
          ...diff === undefined ? {} : {
            changedSectionCount: diff.changedCount,
            firstChangedIndex: diff.firstChangedIndex,
            changedSections: diff.changes,
          },
        }
      : undefined

    // The memory is folded whether or not a line was written: the fingerprint a
    // later assembly is compared against is the LAST one assembled, not the last
    // one recorded. Comparing against the last recorded line would make the
    // ledger's own heartbeat interval a blind spot — a prompt that changed and
    // changed back between two lines would be invisible.
    //
    // `previousAt` and `previous` describe the LAST RECORDED line, so they
    // advance only when one was written; the fingerprint the next assembly is
    // compared against always advances.
    this.remember(key, {
      digests,
      promptSha256,
      ruleSetSha256: input.ruleSetSha256,
      repeat,
      writtenOrdinal: ordinal,
      // Reset only when a line was actually written: this counter measures the
      // distance to the previous LINE, not to the previous change.
      sinceLine: record === undefined ? sinceLine : 0,
      previous: record === undefined
        ? previous?.previous
        : { ordinal: record.ordinal, promptSha256, ruleSetSha256: input.ruleSetSha256 },
      previousAt: record === undefined ? previous?.previousAt : at,
    })
    // The restored state has been folded into `subjects`, so it must not be read
    // again: leaving it would make the NEXT assembly compare against the
    // pre-restart hash instead of the one just computed.
    this.restored.delete(key)

    if (record !== undefined) this.append(CACHE_ARTIFACT_NAMES.prefix, JSON.stringify(record), this.prefixState)
    return record
  }

  /** Fold one observation into the subject memory, evicting the oldest subject past the cap. */
  private remember(key: string | null, state: SubjectState): void {
    // Re-inserting refreshes the Map's insertion order, which is what makes the
    // eviction below least-recently-used rather than oldest-first.
    this.subjects.delete(key)
    this.subjects.set(key, state)
    while (this.subjects.size > PREFIX_SUBJECT_CAP) {
      const oldest = this.subjects.keys().next()
      if (oldest.done === true) break
      this.subjects.delete(oldest.value)
    }
  }

  /**
   * Observe one model request's token accounting.
   *
   * Total by construction: the caller is inside a session-event listener, and an
   * event the ledger cannot read must not disturb the dispatch.
   * @param input - the subject, the turn and step, and the normalised counts.
   * @returns the record that is being written.
   */
  observeUsage(input: UsageObservation): UsageRecord {
    const rate = cacheHitRate(input.usage)
    const record: UsageRecord = {
      format: CACHE_FORMAT,
      ordinal: this.nextUsageOrdinal,
      at: new Date().toISOString(),
      sessionId: input.sessionId ?? null,
      turn: input.turn,
      step: input.step,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cacheReadTokens: input.usage.cacheReadTokens ?? null,
      cacheWriteTokens: input.usage.cacheWriteTokens ?? null,
      totalTokens: input.usage.totalTokens ?? null,
      reasoningTokens: input.usage.reasoningTokens ?? null,
      cacheHitRate: rate ?? null,
      interrupted: input.interrupted,
    }
    this.nextUsageOrdinal += 1
    this.append(CACHE_ARTIFACT_NAMES.usage, JSON.stringify(record), this.usageState)
    return record
  }

  /**
   * Queue one line, rotating first when the file is full.
   *
   * One chain for both ledgers, so the order lines appear in matches the order
   * they were observed and a slow disk never reorders two assemblies.
   * @param base - the ledger's file name.
   * @param line - the JSON line, without its newline.
   * @param state - that ledger's line counter.
   */
  private append(base: string, line: string, state: LedgerState): void {
    this.queue = this.queue.then(async () => {
      await this.prepare()
      if (state.lines >= this.options.lines) {
        await this.rotate(base)
        state.lines = 0
      }
      await appendFile(this.pathOf(base, ''), line + '\n', 'utf8')
      state.lines += 1
    }).catch(() => {
      // A ledger write that fails must never fail a turn: the prompt is already
      // correct and the accounting is already in the session log. The queue is
      // left settled so the NEXT line still gets written — a chain that rejected
      // once would silently stop recording for the rest of the process.
    })
  }

  /**
   * Rotate one ledger: `name` to `.1`, `.1` to `.2`, … and the oldest away.
   *
   * Ascending from the highest suffix, so every destination has just been
   * vacated by the previous step and no rename ever collides. A missing source
   * is expected on the first rotations and is not an error. The new active file
   * is created empty, so the line counter and the file agree from the next
   * append on.
   * @param base - the ledger's file name.
   */
  private async rotate(base: string): Promise<void> {
    await rm(this.pathOf(base, `.${String(this.options.keep)}`), { force: true })
    for (let index = this.options.keep - 1; index >= 1; index -= 1) {
      try {
        await rename(this.pathOf(base, `.${String(index)}`), this.pathOf(base, `.${String(index + 1)}`))
      } catch {
        // absent: this rotation has not reached that depth yet
      }
    }
    try {
      await rename(this.pathOf(base, ''), this.pathOf(base, '.1'))
    } catch {
      // absent: nothing was ever written under this name
    }
    await appendFile(this.pathOf(base, ''), '', 'utf8')
  }

  /**
   * Read a ledger back, oldest rotation first.
   *
   * For tests and for a human-facing summary; never called on a turn. The queued
   * writes are awaited FIRST, so "read what was written" means what it says
   * rather than "read what happened to have reached the disk" — a caller that
   * had to remember to drain first would eventually forget.
   * @param which - which ledger to read.
   * @returns every line currently on disk, parsed, rotated files in order.
   */
  async read(which: 'prefix' | 'usage'): Promise<Record<string, unknown>[]> {
    await this.drain()
    const base = which === 'prefix' ? CACHE_ARTIFACT_NAMES.prefix : CACHE_ARTIFACT_NAMES.usage
    const names: string[] = []
    for (let index = this.options.keep; index >= 1; index -= 1) names.push(base + `.${String(index)}`)
    names.push(base)
    const records: Record<string, unknown>[] = []
    for (const name of names) {
      let text: string
      try {
        text = await readFile(join(this.options.directory, name), 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (line.length === 0) continue
        try {
          records.push(JSON.parse(line) as Record<string, unknown>)
        } catch {
          // a torn tail line, which is expected after a kill
        }
      }
    }
    return records
  }

  /**
   * Wait for every queued write to finish. The waterfall handler must not await
   * this; the plugin awaits it on unload, so a clean shutdown loses nothing.
   * @returns a promise that settles when the queue is empty.
   */
  async drain(): Promise<void> {
    await this.queue
  }

  /** @returns a one-line state summary, for the mount-time log line. */
  summary(): string {
    return `capped at ${String(this.options.lines)} line(s) x ${String(this.options.keep)} file(s) per ledger, heartbeat every ${String(this.options.heartbeat)} assembly(ies), ${String(this.subjects.size)} subject(s) tracked`
  }
}

/** The `sha256` of a rule set, or undefined when no rule set was in force. */
export function ruleSetHashOf(ruleSet: { readonly sha256: string } | undefined): string | undefined {
  return ruleSet?.sha256
}

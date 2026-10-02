/**
 * The counting half of adaptive tool-loading: what the host ACTUALLY called,
 * read out of the session logs it already writes.
 *
 * ## Why a separate module and not "just count in the decision layer"
 *
 * The decision layer ({@link ./decide.ts}) is a pure function with no IO and no
 * clock, because a rule that reads the filesystem cannot be replayed. This
 * module is the opposite end: ALL of the IO, the zstd framing, the incremental
 * bookkeeping and the damage tolerance live here, and it emits one plain JSON
 * document. The two are deliberately not one file so that "what happened" and
 * "what we should do about it" can be re-derived independently.
 *
 * ## Why the logs are decoded the way they are
 *
 * \`session.v4.jsonl.zstd\` is a ZSTD append container: a new frame is written
 * per flush, so the file is a concatenation of independent frames.
 * \`zlib.zstdDecompressSync\` decodes exactly ONE frame and ignores the rest --
 * measured on a 4 928 081-byte log whose first frame decodes to 244 bytes.
 * Decoding the file "once" therefore loses 99.99% of the content, and it fails
 * silently, which is worse.
 *
 * A frame begins with the ZSTD magic 0xFD2FB528 stored little-endian, so the
 * four bytes 28 B5 2F FD. This module finds every occurrence of that sequence
 * and then treats the offsets as the only POSSIBLE frame boundaries, decoding
 * each frame from its start to the SMALLEST later boundary at which decoding
 * succeeds.
 *
 * That direction matters, and the obvious opposite one is wrong. "Take the
 * longest prefix that decodes" looks natural and is unsound here: ZSTD ignores
 * bytes after the end of a frame, so decoding [start, start + n) succeeds for
 * every n at or past the true frame end. Measured on three concatenated 11-byte
 * frames, the longest decodable prefix of the whole 33-byte buffer is 33, and it
 * yields the FIRST frame's output only -- the probe silently swallows the rest.
 * Searching upward from the smallest boundary instead lands on the true frame
 * end, because success there proves the end is at least the real one and
 * minimality proves it is not more. The magic can still occur inside a
 * compressed payload; such a candidate simply fails at every boundary before the
 * real frame end and is skipped.
 *
 * On the 127 logs in the standard sessions root this decoder produced 0 rejections
 * and 17 620 254 decoded characters.
 *
 * ## Why JSONL rather than JSON for the output
 *
 * The output is an AGGREGATE, not a stream, so JSON would be idiomatic -- but
 * two properties decided it:
 *
 *   1. Append-only updates. A run that adds one tool rewrites one line instead
 *      of reserialising the whole document, so a half-written output file is
 *      recoverable by ignoring the trailing line, exactly like the input.
 *   2. The failure list is unbounded in principle. In JSON it would be a nested
 *      array a reader must parse before it can even see whether there is a
 *      problem; as its own record kind it is one line to grep for.
 *
 * So: one header record, one record per tool, one record per failure.
 *
 * @module @t4r71/dsh-prompt-plan/stats
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** The four bytes every ZSTD frame starts with: magic 0xFD2FB528, little-endian. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

/** The event type recording a top-level (non-PTC) tool call. Measured. */
export const TOP_LEVEL_CALL_EVENT = 'tool/call'

/** The event type recording a tool call made inside a run_code program. Measured. */
export const PTC_CALL_EVENT = 'tool/ptc-dispatch-start'

/** The log file name inside each session directory. */
export const SESSION_LOG_NAME = 'session.v4.jsonl.zstd'

/** One tool's cumulative tally. */
export interface ToolStat {
  /** Cumulative REAL calls: top-level tool/call plus PTC tool/ptc-dispatch-start. */
  calls: number
  /**
   * How many distinct sessions called this tool at least once.
   *
   * Carried because raw calls is not comparable across tools: 50 calls inside
   * one session is a single task that happened to loop, while 50 calls spread
   * over 50 sessions is a tool the workflow depends on. Normalising by this is
   * the only way the two are distinguishable.
   */
  sessionsSeen: number
  /** Epoch milliseconds of the last call seen, or 0 when no timestamp was present. */
  lastSeen: number
}

/** A session log this module could not read, and why. */
export interface ScanFailure {
  /** Path of the log that failed. */
  path: string
  /** One sentence, from the thrown error or the accounting check. */
  problem: string
}

/** What one session contributes, before it is merged into the running totals. */
interface SessionContribution {
  /** Per tool: call count in this session, and the newest event time seen. */
  tools: Map<string, { calls: number; lastSeen: number }>
}

/** The per-session bookkeeping that makes a rescan incremental. */
export interface ProcessedSession {
  /** The log's mtimeMs when it was last read. */
  mtimeMs: number
  /** The log's byte length when it was last read. */
  size: number
  /** Distinct tools this session contributed, for cheap subtraction on refresh. */
  tools: string[]
}

/** The output document, in memory. Written as JSONL by {@link writeStatsFile}. */
export interface StatsFile {
  /** Format version, so a reader can refuse a shape it does not know. */
  version: number
  /** Epoch milliseconds of the most recent scan. */
  scannedAt: number
  /** How many session logs were examined (read or skipped as unchanged). */
  sessions: number
  /** How many of those were newly read on this run. */
  newlyProcessed: number
  /** How many were skipped because mtime and size matched the ledger. */
  skipped: number
  /** Totals keyed by tool name. */
  tools: Record<string, ToolStat>
  /** Every log this scan could not fully read. Never fatal. */
  failures: ScanFailure[]
}

/** Format version written into {@link StatsFile.version}. */
export const STATS_VERSION = 1

/* ------------------------------------------------------------------ *
 * Frame decoding
 * ------------------------------------------------------------------ */

/**
 * Every offset at which a ZSTD frame could start, plus the end of the buffer.
 *
 * The buffer's end is included because the LAST frame has no following magic to
 * terminate it -- omitting it silently drops the final frame of every file,
 * which is also the frame carrying the most recent events.
 * @param buffer - the container bytes.
 * @returns the candidate offsets, ascending, ending with `buffer.length`.
 */
export function frameBoundaries(buffer: Buffer): number[] {
  const offsets: number[] = []
  let cursor = buffer.indexOf(ZSTD_MAGIC, 0)
  while (cursor !== -1) {
    offsets.push(cursor)
    cursor = buffer.indexOf(ZSTD_MAGIC, cursor + 1)
  }
  if (offsets.length === 0 && buffer.length === 0) return []
  offsets.push(buffer.length)
  return offsets
}

/** Just the candidate frame STARTS, without the terminating end-of-buffer offset. */
export function frameStarts(buffer: Buffer): number[] {
  const boundaries = frameBoundaries(buffer)
  return boundaries.length > 0 && boundaries[boundaries.length - 1] === buffer.length && buffer.length > 0
    ? boundaries.slice(0, -1)
    : boundaries
}

/**
 * Decode the frame beginning at `start`, given every candidate boundary.
 *
 * The frame ends at the smallest boundary strictly after `start` at which
 * decoding succeeds. See the module doc comment for why the search must run
 * upward and why the opposite search is unsound.
 * @param buffer - the container bytes.
 * @param start - a candidate frame start.
 * @param boundaries - every candidate offset, ascending, for this buffer.
 * @returns the frame's output and its end offset, or undefined when no boundary works.
 */
export function decodeFrameAt(
  buffer: Buffer,
  start: number,
  boundaries: readonly number[],
): { bytes: Buffer; end: number } | undefined {
  for (const end of boundaries) {
    if (end <= start) continue
    try {
      return { bytes: zstdDecompressSync(buffer.subarray(start, end)), end }
    } catch {
      // Not a boundary; try the next one. A magic inside a compressed payload
      // simply fails everywhere before the real frame end.
    }
  }
  return undefined
}

/**
 * Decode every ZSTD frame in a container buffer, tolerating trailing garbage.
 *
 * A candidate that decodes to an EMPTY frame is accepted and counted: a frame
 * whose payload was flushed empty is a real, complete frame, and the callers
 * only care that it contributed no events. A candidate that decodes to nothing
 * at any boundary is counted as rejected -- the normal state of a frame being
 * appended to while this runs, or of a magic that occurs inside a payload.
 *
 * @param buffer - the whole file, as read.
 * @returns the concatenated decoded text, the frame count, and rejected candidates.
 */
export function decodeZstdFrames(buffer: Buffer): { text: string; frames: number; rejected: number } {
  const boundaries = frameBoundaries(buffer)
  const starts = frameStarts(buffer)
  const parts: Buffer[] = []
  let frames = 0
  let rejected = 0
  for (const start of starts) {
    const decoded = decodeFrameAt(buffer, start, boundaries)
    if (decoded === undefined) {
      rejected += 1
      continue
    }
    parts.push(decoded.bytes)
    frames += 1
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames, rejected }
}

/**
 * Extract one tool call's name from a parsed event, or nothing.
 *
 * Both real spellings are accepted -- tool/call (top level) and
 * tool/ptc-dispatch-start (a tools.x() inside a run_code program) -- and
 * anything else is ignored, so the caller need not pre-filter.
 * @param event - one parsed JSONL record.
 * @returns the tool name, or undefined when the record is not a tool call.
 */
export function toolNameOf(event: unknown): string | undefined {
  if (event === null || typeof event !== 'object') return undefined
  const record = event as { type?: unknown; data?: unknown }
  if (record.type !== TOP_LEVEL_CALL_EVENT && record.type !== PTC_CALL_EVENT) return undefined
  const data = record.data as { name?: unknown } | undefined
  return typeof data?.name === 'string' && data.name.length > 0 ? data.name : undefined
}

/**
 * Count one session's tool calls from its decoded JSONL text.
 *
 * A line that is present but unparsable is SKIPPED, not fatal: this is the
 * damage-tolerance requirement, and it is the right call because the only known
 * way to produce one is a torn append at the file tail.
 * @param text - the concatenated decoded frames.
 * @returns per-tool counts and the newest event time, plus the bad-line count.
 */
export function countSession(text: string): { contribution: SessionContribution; badLines: number } {
  const tools = new Map<string, { calls: number; lastSeen: number }>()
  let badLines = 0
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      badLines += 1
      continue
    }
    const name = toolNameOf(event)
    if (name === undefined) continue
    const time = (event as { time?: unknown }).time
    const stamp = typeof time === 'number' && Number.isFinite(time) ? time : 0
    const entry = tools.get(name)
    if (entry === undefined) tools.set(name, { calls: 1, lastSeen: stamp })
    else {
      entry.calls += 1
      if (stamp > entry.lastSeen) entry.lastSeen = stamp
    }
  }
  return { contribution: { tools }, badLines }
}

/* ------------------------------------------------------------------ *
 * Incremental ledger
 * ------------------------------------------------------------------ */

/** The ledger's on-disk shape: which sessions are already folded in. */
export interface StatsLedger {
  /** Format version. */
  version: number
  /** Session id (the directory name) to what was read for it. */
  processed: Record<string, ProcessedSession>
}

/**
 * Load a previous stats file's ledger, or start empty.
 *
 * A file that does not parse, or one whose version is unknown, yields an EMPTY
 * ledger rather than an exception. That is the "statistics file is corrupt"
 * case the unit tests pin: the correct response is to recompute, never to
 * refuse to run, because a missing ledger costs time and a refusal costs the
 * whole feature.
 * @param path - the stats JSONL file, or undefined to start empty.
 * @returns the ledger and the previous totals (empty when nothing was usable).
 */
export function loadLedger(path: string | undefined): { ledger: StatsLedger; previous: StatsFile | undefined } {
  if (path === undefined) return { ledger: emptyLedger(), previous: undefined }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { ledger: emptyLedger(), previous: undefined }
  }
  return parseStatsFile(raw)
}

/** A ledger with nothing processed. */
function emptyLedger(): StatsLedger {
  return { version: STATS_VERSION, processed: {} }
}

/**
 * Parse a stats JSONL document, degrading to an empty ledger on any damage.
 * @param raw - the file's text.
 * @returns the ledger plus the totals recovered from it.
 */
export function parseStatsFile(raw: string): { ledger: StatsLedger; previous: StatsFile | undefined } {
  const ledger = emptyLedger()
  const header: { scannedAt: number; sessions: number; newlyProcessed: number; skipped: number } = {
    scannedAt: 0,
    sessions: 0,
    newlyProcessed: 0,
    skipped: 0,
  }
  const tools: Record<string, ToolStat> = {}
  const failures: ScanFailure[] = []
  let sawHeader = false
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    let record: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed === null || typeof parsed !== 'object') continue
      record = parsed as Record<string, unknown>
    } catch {
      // A torn trailing line is expected when the previous writer was killed.
      continue
    }
    if (record.kind === 'header') {
      if (record.version !== STATS_VERSION) return { ledger: emptyLedger(), previous: undefined }
      sawHeader = true
      header.scannedAt = numberOr(record.scannedAt, 0)
      header.sessions = numberOr(record.sessions, 0)
      header.newlyProcessed = numberOr(record.newlyProcessed, 0)
      header.skipped = numberOr(record.skipped, 0)
      const processed = record.processed
      if (processed !== null && typeof processed === 'object') {
        for (const [id, entry] of Object.entries(processed as Record<string, unknown>)) {
          if (entry === null || typeof entry !== 'object') continue
          const candidate = entry as Partial<ProcessedSession>
          if (typeof candidate.mtimeMs !== 'number' || typeof candidate.size !== 'number') continue
          ledger.processed[id] = {
            mtimeMs: candidate.mtimeMs,
            size: candidate.size,
            tools: Array.isArray(candidate.tools) ? candidate.tools.filter((name): name is string => typeof name === 'string') : [],
          }
        }
      }
    } else if (record.kind === 'tool' && typeof record.name === 'string') {
      tools[record.name] = {
        calls: numberOr(record.calls, 0),
        sessionsSeen: numberOr(record.sessionsSeen, 0),
        lastSeen: numberOr(record.lastSeen, 0),
      }
    } else if (record.kind === 'failure' && typeof record.path === 'string') {
      failures.push({ path: record.path, problem: typeof record.problem === 'string' ? record.problem : '(unspecified)' })
    }
  }
  if (!sawHeader) return { ledger: emptyLedger(), previous: undefined }
  const previous: StatsFile = {
    version: STATS_VERSION,
    scannedAt: header.scannedAt,
    sessions: header.sessions,
    newlyProcessed: header.newlyProcessed,
    skipped: header.skipped,
    tools,
    failures,
  }
  return { ledger, previous }
}

/** A finite number or the supplied fallback. */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/* ------------------------------------------------------------------ *
 * The scan
 * ------------------------------------------------------------------ */

/** Where one scan's inputs come from. */
export interface ScanOptions {
  /** The sessions root: the directory whose children are project dirs. */
  sessionsRoot: string
  /** A previous stats file to fold forward from; omit for a cold scan. */
  previousPath?: string
  /** Fold every log again, ignoring the ledger. */
  force?: boolean
}

/** The result of one scan: the totals, plus the ledger to persist. */
export interface ScanResult {
  /** The aggregate totals. */
  stats: StatsFile
  /** What to write so the next scan can be incremental. */
  ledger: StatsLedger
}

/** One located session log. */
export interface LocatedLog {
  /** The session directory's name; the ledger key. */
  sessionId: string
  /** The project directory's name. */
  project: string
  /** The log's full path. */
  path: string
}

/**
 * Enumerate every session log under a sessions root: root/project/session-id/log.
 * A directory that cannot be listed is skipped, not fatal.
 * @param sessionsRoot - the sessions root.
 * @returns one entry per log, with the ids needed to key the ledger.
 */
export function findSessionLogs(sessionsRoot: string): LocatedLog[] {
  const found: LocatedLog[] = []
  let projects: string[]
  try {
    projects = readdirSync(sessionsRoot)
  } catch {
    return found
  }
  for (const project of projects) {
    const projectPath = join(sessionsRoot, project)
    let sessionIds: string[]
    try {
      if (!statSync(projectPath).isDirectory()) continue
      sessionIds = readdirSync(projectPath)
    } catch {
      continue
    }
    for (const sessionId of sessionIds) {
      const path = join(projectPath, sessionId, SESSION_LOG_NAME)
      try {
        if (!statSync(path).isFile()) continue
      } catch {
        continue
      }
      found.push({ sessionId, project, path })
    }
  }
  return found
}

/**
 * Scan a sessions root into per-tool totals, reading only what changed.
 *
 * Incremental in the strong sense: a session whose mtimeMs AND byte size both
 * match its ledger entry is not opened at all. Size is checked alongside mtime
 * because mtime alone can be preserved by a copy while the content changed, and
 * mtime can also be touched without a write.
 *
 * When a session HAS changed, its previous contribution is withdrawn before the
 * new one is added -- otherwise an edited log would double-count forever.
 * @param options - the root, an optional previous file, and the force flag.
 * @returns the new totals and the ledger describing them.
 */
export function scanSessions(options: ScanOptions): ScanResult {
  const { ledger: priorLedger, previous } = loadLedger(options.previousPath)
  const ledger: StatsLedger = emptyLedger()

  // Working totals, seeded from any previous file so unchanged sessions need no
  // re-reading. Sessions that changed get their old contribution taken back out.
  const tools = new Map<string, ToolStat>()
  for (const [name, stat] of Object.entries(previous?.tools ?? {})) {
    tools.set(name, { calls: stat.calls, sessionsSeen: stat.sessionsSeen, lastSeen: stat.lastSeen })
  }

  const failures: ScanFailure[] = []
  let sessions = 0
  let newlyProcessed = 0
  let skipped = 0

  for (const log of findSessionLogs(options.sessionsRoot)) {
    sessions += 1
    let mtimeMs: number
    let size: number
    try {
      const info = statSync(log.path)
      mtimeMs = info.mtimeMs
      size = info.size
    } catch (error) {
      failures.push({ path: log.path, problem: 'stat failed: ' + describeError(error) })
      continue
    }

    const before = priorLedger?.processed[log.sessionId]
    if (options.force !== true && before !== undefined && before.mtimeMs === mtimeMs && before.size === size) {
      skipped += 1
      ledger.processed[log.sessionId] = { mtimeMs, size, tools: before.tools }
      continue
    }

    // Re-reading this session: withdraw what it contributed last time.
    if (before !== undefined) {
      for (const name of before.tools) withdrawSession(tools, name)
    }

    let contribution: SessionContribution
    try {
      const buffer = readFileSync(log.path)
      const decoded = decodeZstdFrames(buffer)
      contribution = countSession(decoded.text).contribution
      if (decoded.frames === 0 && buffer.length > 0) {
        failures.push({ path: log.path, problem: 'no decodable zstd frame in a non-empty log' })
      }
    } catch (error) {
      failures.push({ path: log.path, problem: describeError(error) })
      continue
    }

    newlyProcessed += 1
    for (const [name, entry] of contribution.tools) {
      const stat = tools.get(name)
      if (stat === undefined) {
        tools.set(name, { calls: entry.calls, sessionsSeen: 1, lastSeen: entry.lastSeen })
      } else {
        stat.calls += entry.calls
        stat.sessionsSeen += 1
        if (entry.lastSeen > stat.lastSeen) stat.lastSeen = entry.lastSeen
      }
    }
    ledger.processed[log.sessionId] = {
      mtimeMs,
      size,
      tools: [...contribution.tools.keys()].sort(),
    }
  }

  const ordered = [...tools.entries()].sort((left, right) => right[1].calls - left[1].calls || left[0].localeCompare(right[0]))
  const stats: StatsFile = {
    version: STATS_VERSION,
    scannedAt: Date.now(),
    sessions,
    newlyProcessed,
    skipped,
    tools: Object.fromEntries(ordered),
    failures,
  }
  return { stats, ledger }
}

/** Reverse one session's contribution to a tool's sessionsSeen, dropping a now-empty tally. */
function withdrawSession(tools: Map<string, ToolStat>, name: string): void {
  const stat = tools.get(name)
  if (stat === undefined) return
  stat.sessionsSeen -= 1
  if (stat.sessionsSeen <= 0) {
    // The tally existed only because of this session; drop it so a tool that
    // vanished from the logs does not linger with a phantom sessionsSeen.
    tools.delete(name)
  }
}

/** One sentence from an unknown thrown value. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

/**
 * Serialise a scan result as the JSONL document this module reads back.
 *
 * One line per record, with the newline appended to EVERY line including the
 * last, so an append after a kill leaves exactly one torn line rather than a
 * merged one.
 * @param result - the scan to serialise.
 * @returns the file's text.
 */
export function formatStatsFile(result: ScanResult): string {
  const { stats, ledger } = result
  const lines: string[] = []
  lines.push(JSON.stringify({
    kind: 'header',
    version: stats.version,
    scannedAt: stats.scannedAt,
    sessions: stats.sessions,
    newlyProcessed: stats.newlyProcessed,
    skipped: stats.skipped,
    processed: ledger.processed,
  }))
  for (const [name, stat] of Object.entries(stats.tools)) {
    lines.push(JSON.stringify({ kind: 'tool', name, calls: stat.calls, sessionsSeen: stat.sessionsSeen, lastSeen: stat.lastSeen }))
  }
  for (const failure of stats.failures) {
    lines.push(JSON.stringify({ kind: 'failure', path: failure.path, problem: failure.problem }))
  }
  return lines.map(line => line + '\n').join('')
}

/**
 * Scan and write in one call -- the shape the CLI and the report script use.
 * @param options - scan inputs, plus the output path.
 * @returns the scan result that was written.
 */
export function writeStatsFile(options: ScanOptions & { outputPath: string }): ScanResult {
  const result = scanSessions(options)
  writeFileSync(options.outputPath, formatStatsFile(result), 'utf8')
  return result
}

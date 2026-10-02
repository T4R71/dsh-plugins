/**
 * Item 4 — a second identical read answers with a pointer, not the file.
 *
 * ## What repeats, measured
 *
 * Across every session in this deployment's `home/sessions`, counting `read`
 * sub-dispatches by (path, offset, limit, pattern):
 *
 * | calls | target |
 * |-------|--------|
 * |    17 | `M:\\DSH-T4\\home\\profiles\\desktop\\task-runs.json` (limit 300) |
 * |    14 | `M:\\DSH-T4\\tmp-compaction-audit\\zread.js` |
 * |    14 | `fx-play/app.js` (offset 1, limit 3) |
 * |    11 | `task-plugin-answer-rule/probe.cjs` |
 *
 * 1,475 `read` sub-dispatches in total. The large majority are first reads and
 * are not touched by this hook; the repeats are re-reads of a file whose bytes
 * the transcript already carries in full.
 *
 * ## Why the transcript and not a cache
 *
 * The previous answer is already in the conversation, so the cheap correct
 * reply is a *pointer to it*: the path, the range, and the flags to re-read
 * with. Returning the same bytes again buys nothing the model does not already
 * have; returning a shortened body instead would be worse than either — it
 * would silently hand back a different value under the same call.
 *
 * ## Why this one may replace a result
 *
 * Every other bound in this package is careful to leave the model-facing value
 * alone. This hook is the exception and says so: `dsh-tools` refolds a
 * post-execute `accept` decision into the result the model sees, so the
 * pointer really is what the model reads, not just what the log says. That is
 * the intended effect here — the whole point is to spend fewer bytes on a read
 * whose answer the transcript already contains.
 *
 * ## Why a change to the file voids the pointer
 *
 * "You already read this" is only true while the file has not moved. The first
 * read's byte length and modification time are recorded and compared on every
 * later read of the same target; either one changing means the earlier answer
 * may no longer describe the file, and the read is served in full. A pointer to
 * a stale answer is exactly the silent wrong value this design refuses to
 * produce.
 *
 * @module @t4r71/dsh-guard/reread
 */

import { statSync } from 'node:fs'

/** Whether repeat-read suppression is willing to run. */
export interface RereadDecision {
  /** The switch; `false` leaves every result untouched. */
  readonly enabled: boolean
}

/** A file identity recorded when a read was answered in full. */
export interface ReadStamp {
  /** File size in bytes at that moment. */
  readonly size: number
  /** Modification time in milliseconds at that moment. */
  readonly mtimeMs: number
}

/** What suppression did, for the caller's log line and the tests. */
export interface RereadOutcome {
  /** Whether this call was a repeat and the stamp is unchanged. */
  readonly suppress: boolean
  /** The pointer text, when suppressed. */
  readonly text?: string
  /** The stamp to record, when this call should become the new baseline. */
  readonly record?: ReadStamp
  /** Why the pointer was refused, when it was. */
  readonly reason?: string
}

/** Read the current identity of a file; `undefined` when it is gone or unreadable. */
export function stampOf(path: string): ReadStamp | undefined {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return undefined
    return { size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return undefined
  }
}

/**
 * The key one read is identified by.
 *
 * Every parameter that changes the answer is in the key, so a read of the same
 * file at a different offset is a different read. Parts left out of the key do
 * not change what comes back: the tool has no other argument that selects
 * content.
 *
 * @param args - the parsed tool arguments.
 * @returns a stable key, or `undefined` when this call is not a plain file read.
 */
export function rereadKey(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const a = args as Record<string, unknown>
  const path = a.file_path
  if (typeof path !== 'string' || path === '') return undefined
  const at = (value: unknown): string => (typeof value === 'number' && Number.isFinite(value) ? String(value) : '-')
  return [path, at(a.offset), at(a.limit)].join('\u0000')
}

/**
 * Decide whether one `read` call is an unchanged repeat of an earlier one.
 *
 * @param name - the tool being dispatched.
 * @param args - the parsed arguments.
 * @param seen - stamps of reads already served in full, keyed by {@link rereadKey}.
 * @param decision - whether to run at all.
 * @returns whether to replace the result, and the stamp to record when not.
 */
export function suppressRepeatRead(
  name: string,
  args: unknown,
  seen: Map<string, ReadStamp>,
  decision: RereadDecision,
): RereadOutcome {
  if (!decision.enabled) return { suppress: false }
  if (name !== 'read') return { suppress: false }
  const key = rereadKey(args)
  if (key === undefined) return { suppress: false, reason: 'no readable file_path' }
  const a = args as Record<string, unknown>
  const path = a.file_path as string
  const current = stampOf(path)
  // A file that cannot be stat'ed is served normally: the tool owns the error
  // text for a missing file, and a pointer to a read that cannot be re-made is
  // not a recovery path.
  if (current === undefined) return { suppress: false, reason: 'not a readable file' }

  const previous = seen.get(key)
  if (previous === undefined) return { suppress: false, record: current }
  if (previous.size !== current.size || previous.mtimeMs !== current.mtimeMs) {
    return { suppress: false, record: current, reason: 'file changed since the earlier read' }
  }

  const range = [
    typeof a.offset === 'number' ? 'offset ' + String(a.offset) : undefined,
    typeof a.limit === 'number' ? 'limit ' + String(a.limit) : undefined,
  ].filter((part): part is string => part !== undefined).join(', ')
  return {
    suppress: true,
    text: 'Already read ' + path + (range === '' ? '' : ' (' + range + ')')
      + ' earlier in this session, and the file has not changed since ('
      + String(current.size) + ' bytes, mtime ' + String(current.mtimeMs) + ').'
      + ' The earlier result is still in the conversation above — reuse it instead of re-reading.'
      + ' To force the bytes back, re-read with an explicit offset and limit, or a different range.'
      + ' Re-read only if you need to confirm nothing changed.',
  }
}

/**
 * Recoverable truncation, shared by the hooks that bound what a parent's model
 * sees.
 *
 * ## Why this exists
 *
 * Two of this package's hooks answer the same question — "this is too big to
 * put in front of a model, so where does the original go?" — and the answer has
 * to be the same in both or a reader cannot recover the text from either. The
 * shipped `@deepseek-ai/dsh-spill-policy` solves it with an execution-readable
 * spill path printed next to the retained head; this module does the same thing
 * without depending on that package, because a bound must not silently become a
 * deletion when the backend is absent.
 *
 * ## The contract every caller keeps
 *
 * 1. The **original text is written to disk first**, and the notice names the
 *    path — a truncation the reader cannot undo is data loss, not a bound.
 * 2. The notice states the **byte counts** (kept / total) and the flags to pass
 *    to `read` to see the rest. A pointer the reader cannot follow is a
 *    dead end.
 * 3. If the write fails, the caller **returns the text unbounded**. An
 *    unbounded result is a cost problem; a lost result is a correctness
 *    problem, and this module always prefers the former.
 *
 * @module @t4r71/dsh-guard/spill
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Bytes in one UTF-8 string, the unit every bound in this package counts in. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Retain the first `maxBytes` bytes of `text` without splitting a character.
 *
 * `Buffer.subarray` cuts on byte boundaries, which lands inside a multi-byte
 * sequence whenever the text is CJK — the common case for this harness. The
 * decode below is lossy by definition, so the fix is to walk back to a byte
 * that starts a UTF-8 sequence, then decode with replacement for the pathological
 * input (a string that is all continuation bytes) rather than throw.
 *
 * @param text - the text to bound.
 * @param maxBytes - the byte budget; `0` retains nothing.
 * @returns the longest prefix whose UTF-8 encoding fits the budget.
 */
export function retainHeadBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  let end = maxBytes
  // Back off over continuation bytes (0b10xxxxxx) so the cut is on a boundary.
  while (end > 0 && (bytes[end] as number) !== undefined
    && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

/** Retain the last `maxBytes` bytes of `text`, cut on a UTF-8 boundary. */
export function retainTailBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  let start = bytes.length - maxBytes
  while (start < bytes.length && ((bytes[start] as number) & 0xc0) === 0x80) start += 1
  return bytes.subarray(start).toString('utf8')
}

/** Stable lowercase hex SHA-256 of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Write one recoverable copy and return its path, or `undefined` when the
 * write failed.
 *
 * Never throws: every caller's fallback is "keep the text inline", and a
 * spill that cannot be written must not fail the step it was only trying to
 * make cheaper.
 *
 * @param directory - directory to create and write into.
 * @param fileName - file name inside it.
 * @param text - the exact bytes to preserve.
 * @returns the absolute path written, or `undefined` on any failure.
 */
export function writeSpill(directory: string, fileName: string, text: string): string | undefined {
  try {
    mkdirSync(directory, { recursive: true })
    const path = join(directory, fileName)
    writeFileSync(path, text, 'utf8')
    return path
  } catch {
    return undefined
  }
}

/**
 * Where a spill for one session and purpose belongs.
 *
 * Under the OS temp directory rather than the workspace: these files are
 * scratch for one reader, they must not appear in `git status` of a project
 * a person is working in, and the temp directory is the one location a model
 * running commands can be told to read without further grants.
 *
 * @param purpose - short directory-safe label for the kind of spill.
 * @param sessionId - the owning session, so two sessions never collide.
 * @returns the directory to pass to {@link writeSpill}.
 */
export function spillDirectory(purpose: string, sessionId: string): string {
  const safeSession = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  return join(tmpdir(), 'dsh-guard-spill', purpose, safeSession)
}

/**
 * Test helpers for the session axis store's SQLite backend.
 *
 * @module @t4r71/dsh-dual-axis/tests/memory-database
 */

import { DatabaseSync } from 'node:sqlite'
import type { AxesDatabase } from '../src/session-store.ts'

/**
 * One in-memory database per call. Each call is a SEPARATE database, so a test
 * that needs two stores to see each other must share one handle.
 * @returns an open in-memory handle.
 */
export function memoryDatabase(): AxesDatabase {
  return new DatabaseSync(':memory:') as unknown as AxesDatabase
}

/**
 * A database opener that hands every store the same handle, so a store built
 * later in a test reads what an earlier one wrote.
 * @param handle - the shared handle, or one built for you.
 * @returns the opener, plus the handle it serves.
 */
export function sharedDatabase(handle: AxesDatabase = memoryDatabase()): {
  open: (file: string) => AxesDatabase
  handle: AxesDatabase
} {
  return { open: () => handle, handle }
}

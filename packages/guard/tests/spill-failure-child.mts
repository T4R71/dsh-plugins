/**
 * The source substitution the un-writable-spill test needs, kept apart so its
 * reason is stated once. See `spill-failure-run.mts` for what is being run.
 *
 * @module @t4r71/dsh-guard/tests
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Result of one redirected child run. */
export interface SpillRun {
  /** Exit status of the child; `0` means every copied test passed. */
  readonly status: number | null
  /** Child stdout, which carries the runner's own summary. */
  readonly stdout: string
  /** Child stderr, which carries a loader or syntax failure. */
  readonly stderr: string
}

/**
 * Run `spill-failure-run.mts` with `tmpdir()` redirected to an unusable path.
 *
 * @returns the child's status and output; the temporary directory is already gone.
 */
export function runSpillFailureChild(): SpillRun {
  const testsDir = dirname(fileURLToPath(import.meta.url))
  const packageRoot = dirname(testsDir)
  const work = mkdtempSync(join(tmpdir(), 'guard-spill-failure-'))
  try {
    // A regular file in the middle of the path is what makes the directory
    // uncreatable: `mkdirSync` does not refuse a missing parent — it creates it —
    // but it cannot create a parent that is a file. That is the production
    // failure, not a stubbed return value.
    const blocked = join(work, 'blocked')
    writeFileSync(blocked, 'not a directory')
    // The runner's own variables are stripped: this run happens *under*
    // `node --test`, and an inherited `NODE_TEST_CONTEXT` makes the child's runner
    // skip its files as a recursive run.
    const env: Record<string, string> = { T4_GUARD_TEST_TMP: join(blocked, 'deeper') }
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith('NODE_TEST') && value !== undefined) env[key] = value
    }
    writeFileSync(join(work, 'os-shim.ts'), [
      '/** Stands in for `node:os` with a `tmpdir()` nothing can be written under. */',
      'const unusable: string = process.env.T4_GUARD_TEST_TMP as string',
      'export function tmpdir(): string { return unusable }',
      'export default { tmpdir }',
      '',
    ].join('\n'))
    for (const file of ['spill.ts', 'envelope.ts']) {
      const source = readFileSync(join(packageRoot, 'src', file), 'utf8')
        .replaceAll("'node:os'", "'./os-shim.ts'")
      writeFileSync(join(work, file), source)
    }
    // The runner ships as `.txt` so the package typecheck does not try to resolve
    // the imports that only exist in this copied directory; it becomes a test file
    // the moment it lands here.
    const spec = join(work, 'spill-failure-run.spec.ts')
    writeFileSync(spec, readFileSync(join(testsDir, 'spill-failure-run.txt'), 'utf8'))
    // The loader is resolved, not guessed: `tsx` is a pnpm link whose internal
    // layout is not this package's to assume.
    const loader = fileURLToPath(import.meta.resolve('tsx/esm'))
    const run = spawnSync(process.execPath, [
      '--import', pathToFileURL(loader).href,
      '--test', spec,
    ], { cwd: packageRoot, encoding: 'utf8', env })
    return { status: run.status, stdout: run.stdout, stderr: run.stderr }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * The observation logs are BOUNDED: each of the three `.jsonl` artifacts rotates
 * at its own line cap and deletes its oldest file, so the directory cannot grow
 * without limit the way it did in the incident this revision answers (842 MB in
 * 62 hours, `sections-text.jsonl` alone 769.8 MB over 8733 lines).
 *
 * Stated as the requirements rather than as the implementation, so they keep
 * their meaning if the code moves:
 *
 *   1. a log that reaches its cap rotates, and the rotation is VISIBLE as
 *      `name.1` — not as a truncated file and not as a silently stopped writer;
 *   2. after `keep + 1` rotations the oldest file is DELETED, so the window is
 *      `cap x (keep + 1)` lines and never more;
 *   3. the LIVE file holds exactly as many lines as the counter believes it does.
 *      This is the one that is easy to get wrong, and it fails silently in both
 *      directions: a counter that drifts low lets the file grow past its cap, and
 *      one that drifts high rotates a file that was not full. The assertion is on
 *      the file, at every step, because the file is the fact;
 *   4. the three logs count independently. One shared counter would make the
 *      100-line `sections-text.jsonl` cap dictate the rotation of the 2000-line
 *      `purity.jsonl`, shrinking its window twentyfold;
 *   5. `baseline.json` is NOT rotated. It is an overwritten index, one entry per
 *      section name, and it is the union the rotations would otherwise destroy.
 *
 * The tests drive the REAL `Observer` — the class the plugin mounts — and read the
 * files off the disk rather than trusting a return value.
 *
 * @module @t4r71/dsh-prompt-plan/tests
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import PromptPlan from '../src/index.ts'
import { ARTIFACT_NAMES, DEFAULT_OBSERVATION_KEEP, DEFAULT_OBSERVATION_LINES, Observer } from '../src/observe.ts'
import { resolvedConfig } from '../src/config.ts'
import type { SectionRecord } from '../src/sections.ts'

/** A fresh directory for one test. */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'prompt-plan-observation-'))
}

/** The lines a file holds, as strings; empty when it does not exist. */
function linesOf(directory: string, name: string): string[] {
  const path = join(directory, name)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(line => line.length > 0)
}

/** The ordinals a file holds, as numbers. */
function ordinalsOf(directory: string, name: string): number[] {
  return linesOf(directory, name).map(line => (JSON.parse(line) as { ordinal: number }).ordinal)
}

/** One assembly's sections, with text long enough to be worth capping. */
function sections(tag: string): SectionRecord[] {
  return [{ name: 'persona', text: `${tag} `.repeat(20) }, { name: 'tools:sdk', text: `${tag} interface ToolArgsMap {}` }]
}

/** The log file names a directory holds, for a base name. */
function rotationNames(directory: string, base: string): string[] {
  return readdirSync(directory).filter(name => name === base || name.startsWith(base + '.')).sort()
}

/**
 * Drive `count` assemblies through one Observer and wait for the queue.
 * @param observer - the observer under test.
 * @param count - how many assemblies to record.
 * @param fullText - whether each assembly also writes the full-text log.
 */
async function drive(observer: Observer, count: number, fullText: boolean): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    observer.record(sections(`a${String(index)}`), sections(`a${String(index)}`), true, false, fullText, undefined, [], 'session-A')
  }
  await observer.drain()
}

// -----------------------------------------------------------------------------
// The caps: each log is a bounded file
// -----------------------------------------------------------------------------

test('each log rotates at its own cap, and the rotation is visible as name.1', async () => {
  const dir = tempDir()
  const observer = new Observer({
    directory: dir,
    mode: 'observe',
    report: () => undefined,
    lines: { sections: 3, sectionsText: 2, purity: 4 },
    keep: 1,
  })
  await drive(observer, 6, true)

  // `sections.jsonl`: six lines through a cap of 3 with one rotation kept is two
  // rotations, so the live file holds 3 lines (records 4-6) and `.1` holds the
  // first 3 (records 1-3), which is the oldest file and was deleted at the second
  // rotation. The live file exists and is not empty; that is the whole requirement.
  assert.deepEqual(rotationNames(dir, ARTIFACT_NAMES.sections), [ARTIFACT_NAMES.sections, ARTIFACT_NAMES.sections + '.1'])
  assert.deepEqual(ordinalsOf(dir, ARTIFACT_NAMES.sections), [3, 4, 5], 'the live file is the newest lines')
  assert.ok(linesOf(dir, ARTIFACT_NAMES.sections + '.1').length <= 3, 'and the rotation is within the cap too')

  // The full-text log has the smaller cap, so it rotated more often — evidence
  // that the cap in force is the log's own and not a shared number.
  assert.ok(existsSync(join(dir, ARTIFACT_NAMES.sectionsText)), 'the full-text log was written')
  assert.ok(existsSync(join(dir, ARTIFACT_NAMES.sectionsText + '.1')), 'and it rotated')
  assert.ok(linesOf(dir, ARTIFACT_NAMES.sectionsText).length <= 2, 'within the 2-line cap')

  // purity's cap is 4, so six records fill it once and rotate once: the live file
  // holds records 5 and 6, and the first four are in `.1`. That is a DIFFERENT
  // rotation count from either of the other two logs on the same six records —
  // which is itself the evidence that the three caps are three caps.
  assert.equal(linesOf(dir, ARTIFACT_NAMES.purity).length, 2, 'purity rotated once, on its own cap of 4')
  assert.deepEqual(ordinalsOf(dir, ARTIFACT_NAMES.purity + '.1'), [0, 1, 2, 3], 'and the four that filled it were kept')
})

test('after keep+1 rotations the oldest file is deleted, so the window is cap x (keep+1)', async () => {
  const dir = tempDir()
  const observer = new Observer({
    directory: dir,
    mode: 'observe',
    report: () => undefined,
    lines: { sections: 2, sectionsText: 100, purity: 100 },
    keep: 2,
  })
  // 2 lines x (1 live + 2 rotations) = a 6-line window. Twelve records means six
  // rotations, so the first six ordinals are gone and the last six remain.
  await drive(observer, 12, false)

  const names = rotationNames(dir, ARTIFACT_NAMES.sections)
  assert.deepEqual(names, [ARTIFACT_NAMES.sections, ARTIFACT_NAMES.sections + '.1', ARTIFACT_NAMES.sections + '.2'], 'exactly the live file and the two rotations it is allowed — never a third')
  assert.equal(existsSync(join(dir, ARTIFACT_NAMES.sections + '.3')), false, 'the third rotation has no file of its own')

  const kept = [
    ...ordinalsOf(dir, ARTIFACT_NAMES.sections + '.2'),
    ...ordinalsOf(dir, ARTIFACT_NAMES.sections + '.1'),
    ...ordinalsOf(dir, ARTIFACT_NAMES.sections),
  ]
  assert.deepEqual(kept, [6, 7, 8, 9, 10, 11], 'the window slid forward: the six oldest lines were deleted, not kept')
  assert.ok(!kept.includes(0), 'specifically, ordinal 0 was deleted')
  for (const name of names) {
    assert.ok(linesOf(dir, name).length <= 2, name + ' holds ' + String(linesOf(dir, name).length) + ' line(s), which must be at most the cap of 2')
  }
})

test('the live file holds exactly as many lines as the counter believes, at every step', async () => {
  // The failure this guards: a counter that drifts low lets the file grow past
  // its cap; one that drifts high rotates a file that was not full. Both are
  // silent, and both are caught by comparing the FILE against the sequence the
  // caps imply — which is why the assertion is made after EVERY record rather
  // than once at the end.
  const dir = tempDir()
  const observer = new Observer({
    directory: dir,
    mode: 'observe',
    report: () => undefined,
    lines: { sections: 3, sectionsText: 100, purity: 100 },
    keep: 1,
  })

  for (let index = 0; index < 9; index += 1) {
    observer.record(sections(`a${String(index)}`), sections(`a${String(index)}`), true, false, false, undefined, [], 'session-A')
    await observer.drain()
    // Rotation happens BEFORE the write that would overflow, so record n leaves
    // ((n - 1) mod 3) + 1 lines in the live file. A counter and a file that had
    // drifted apart could not produce this for nine consecutive steps.
    const expected = (index % 3) + 1
    assert.equal(
      linesOf(dir, ARTIFACT_NAMES.sections).length,
      expected,
      'after record ' + String(index) + ' the live file must hold ' + String(expected) + ' line(s)',
    )
    assert.ok(linesOf(dir, ARTIFACT_NAMES.sections).length <= 3, 'and never more than the cap')
  }
})

test('the counter resumes from the file at mount, so a restart still rotates on time', async () => {
  const dir = tempDir()
  const options = { directory: dir, mode: 'observe', report: () => undefined, lines: { sections: 3, sectionsText: 100, purity: 100 }, keep: 1 }
  const first = new Observer(options)
  await drive(first, 2, false)
  assert.equal(linesOf(dir, ARTIFACT_NAMES.sections).length, 2, 'two lines, no rotation yet')

  // A second mount over the same directory is what a host restart looks like. If
  // it started its counter at 0 it would write three MORE lines into the same
  // file before rotating — five lines in a file capped at three.
  const second = new Observer(options)
  await drive(second, 1, false)
  assert.equal(linesOf(dir, ARTIFACT_NAMES.sections).length, 3, 'the resumed counter wrote the third line, not a fresh first one')
  assert.equal(existsSync(join(dir, ARTIFACT_NAMES.sections + '.1')), false, 'and nothing rotated yet, because the file is exactly full')

  await drive(second, 1, false)
  assert.deepEqual(ordinalsOf(dir, ARTIFACT_NAMES.sections), [3], 'the fourth line rotated first, so the live file holds exactly it')
  assert.deepEqual(ordinalsOf(dir, ARTIFACT_NAMES.sections + '.1'), [0, 1, 2], 'and the rotation holds the three that filled it')
})

test('a rotated-away file is still read for the ordinal, so a restart after a rotation never reuses one', async () => {
  // The mount that follows a rotation sees an EMPTY live file. Reading only that
  // file would answer 0 and the next line would reuse an ordinal `.1` already
  // holds, which breaks the cross-reference the ordinal exists for.
  const dir = tempDir()
  const options = { directory: dir, mode: 'observe', report: () => undefined, lines: { sections: 2, sectionsText: 100, purity: 100 }, keep: 1 }
  const first = new Observer(options)
  await drive(first, 2, false)
  await drive(first, 1, false) // the third record rotates; the live file holds it alone
  assert.deepEqual(ordinalsOf(dir, ARTIFACT_NAMES.sections), [2])
  assert.deepEqual(ordinalsOf(dir, ARTIFACT_NAMES.sections + '.1'), [0, 1])

  const second = new Observer(options)
  await drive(second, 1, false)
  const written = [...ordinalsOf(dir, ARTIFACT_NAMES.sections + '.1'), ...ordinalsOf(dir, ARTIFACT_NAMES.sections)]
  assert.equal(new Set(written).size, written.length, 'no ordinal was written twice: ' + JSON.stringify(written))
  assert.ok(Math.max(...written) === 3, 'and the next free ordinal was 3')
})

test('the three logs count independently: one rotating never resets another', async () => {
  const dir = tempDir()
  const observer = new Observer({
    directory: dir,
    mode: 'observe',
    report: () => undefined,
    // Deliberately coprime, so each log's first rotation lands on a different
    // record and a shared counter could not satisfy all three.
    lines: { sections: 4, sectionsText: 3, purity: 5 },
    keep: 1,
  })

  // Three records: the full-text log (cap 3) has just filled, the other two have
  // not. A shared counter would have reset all three together at whatever the
  // first cap to fire was.
  await drive(observer, 3, true)
  assert.equal(linesOf(dir, ARTIFACT_NAMES.sections).length, 3, 'sections holds 3 of its 4 lines')
  assert.equal(linesOf(dir, ARTIFACT_NAMES.sectionsText).length, 3, 'the full-text log is exactly full')
  assert.equal(linesOf(dir, ARTIFACT_NAMES.purity).length, 3, 'purity holds 3 of its 5')
  assert.equal(existsSync(join(dir, ARTIFACT_NAMES.sections + '.1')), false, 'nothing rotated yet')
  assert.equal(existsSync(join(dir, ARTIFACT_NAMES.purity + '.1')), false, 'and nothing else rotated with it')

  // A fourth record rotates the full-text log ALONE. Sections (4) and purity (5)
  // keep counting and do not rotate, which is the requirement.
  await drive(observer, 1, true)
  assert.equal(existsSync(join(dir, ARTIFACT_NAMES.sectionsText + '.1')), true, 'the full-text log rotated at its own cap')
  assert.equal(linesOf(dir, ARTIFACT_NAMES.sectionsText).length, 1, 'and the new active file holds the one line written after it')
  assert.deepEqual(ordinalsOf(dir, ARTIFACT_NAMES.sectionsText + '.1'), [0, 1, 2], 'with the three that filled it preserved')
  assert.equal(existsSync(join(dir, ARTIFACT_NAMES.sections + '.1')), false, 'sections did NOT rotate, and did not reset')
  assert.equal(existsSync(join(dir, ARTIFACT_NAMES.purity + '.1')), false, 'nor did purity')
  assert.equal(linesOf(dir, ARTIFACT_NAMES.sections).length, 4, 'sections reached its own cap of 4, on its own count')
  assert.equal(linesOf(dir, ARTIFACT_NAMES.purity).length, 4, 'and purity is on its fifth line next, not back at one')
})

test('a cap of zero configured by hand is clamped to one, not honoured as unbounded', () => {
  // The same clamp the cache ledgers get, for the same reason: this function also
  // reads a settings document that never went through the schema, and a cap of
  // zero would mean "never rotate" — the 842 MB shape again.
  const clamped = resolvedConfig({ observationLines: 0, observationTextLines: -5, observationPurityLines: 0, observationKeep: 0 })
  assert.equal(clamped.observationLines, 1)
  assert.equal(clamped.observationTextLines, 1)
  assert.equal(clamped.observationPurityLines, 1)
  assert.equal(clamped.observationKeep, 1)
})

test('the defaults bound each log from the measured bytes per line, and baseline.json is not capped at all', () => {
  const defaults = resolvedConfig({})
  assert.equal(defaults.observationLines, 1000, 'sections.jsonl: 6.9 KB/line measured')
  assert.equal(defaults.observationTextLines, 100, 'sections-text.jsonl: 92 KB/line measured, 13x larger, so 10x fewer lines')
  assert.equal(defaults.observationPurityLines, 2000, 'purity.jsonl: ~0.2 KB/line, so the widest window is affordable')
  assert.equal(defaults.observationKeep, 2)

  // Worst case per log, `lines x (keep + 1) x bytes per line`, in MB: 20.7 + 27.6
  // + 1.2 ~= 50 MB for the whole directory. The KILOBYTES are what make this a
  // check rather than a restatement: the numbers are the measured sizes, and a cap
  // raised into the hundreds of megabytes fails here.
  const megabytes = (lines: number, kilobytes: number): number => (lines * (defaults.observationKeep + 1) * kilobytes) / 1024
  const total = megabytes(defaults.observationLines, 6.9) + megabytes(defaults.observationTextLines, 92) + megabytes(defaults.observationPurityLines, 0.2)
  assert.ok(total < 64, 'the whole artifact directory is bounded at about ' + total.toFixed(1) + ' MB worst case, against 842 MB unbounded')

  // The full-text default is the one that matters most: it is the file that grew
  // to 769.8 MB, and its window is what has to stay small.
  assert.ok(megabytes(defaults.observationTextLines, 92) < 32, 'the full-text log alone stays under 32 MB')
  assert.equal(DEFAULT_OBSERVATION_KEEP, defaults.observationKeep)
  assert.equal(DEFAULT_OBSERVATION_LINES.sectionsText, defaults.observationTextLines)
})

test('baseline.json is never rotated and keeps accumulating across every rotation', async () => {
  const dir = tempDir()
  const observer = new Observer({
    directory: dir,
    mode: 'observe',
    report: () => undefined,
    lines: { sections: 2, sectionsText: 2, purity: 2 },
    keep: 1,
  })
  await drive(observer, 7, true)

  // Seven records through a 2-line cap rotated the logs several times; the index
  // must have no rotations of its own, must still exist, and must still carry
  // every name the run established.
  assert.equal(existsSync(join(dir, ARTIFACT_NAMES.baseline + '.1')), false, 'an index is overwritten, not appended to, so it has no rotations')
  const baseline = JSON.parse(readFileSync(join(dir, ARTIFACT_NAMES.baseline), 'utf8')) as { sections: Record<string, { seen: number }> }
  assert.deepEqual(Object.keys(baseline.sections).sort(), ['persona', 'tools:sdk'], 'every name survives the rotations of the logs beside it')
  assert.equal(baseline.sections.persona?.seen, 7, 'and every assembly is still counted, including the ones whose lines were deleted')
})

test('the logs stay bounded when every assembly carries a rule trace, which writes a second line into sections.jsonl', async () => {
  // The `:rules` companion shares `sections.jsonl` with the assembly line, so this
  // log takes TWO lines per assembly when rules ran. A cap that counted only the
  // assembly line would let the file reach twice its cap.
  const dir = tempDir()
  const observer = new Observer({
    directory: dir,
    mode: 'observe',
    report: () => undefined,
    lines: { sections: 2, sectionsText: 100, purity: 100 },
    keep: 1,
  })
  for (let index = 0; index < 5; index += 1) {
    observer.record(sections('x'), sections('x'), true, false, false, { path: '/r.yaml', sha256: 'a'.repeat(64) }, ['rule -> replace'], 'session-A')
  }
  await observer.drain()

  for (const name of rotationNames(dir, ARTIFACT_NAMES.sections)) {
    const count = linesOf(dir, name).length
    assert.ok(count <= 2, name + ' holds ' + String(count) + ' line(s), which must be at most the cap of 2')
  }
  // The companion is counted, which is what keeps the file bounded: the trace
  // lines are in the files too, so ten lines went through a six-line window.
  const all = [...ordinalsOf(dir, ARTIFACT_NAMES.sections + '.1'), ...ordinalsOf(dir, ARTIFACT_NAMES.sections)]
  assert.ok(all.length <= 2 * 2, 'the whole log is within cap x (keep + 1)')
})

// -----------------------------------------------------------------------------
// The wiring: the configured caps reach the observer the plugin actually mounts
// -----------------------------------------------------------------------------

test('the plugin hands its configured caps to the Observer, and the artifacts rotate through the real waterfall', async () => {
  // The caps are worth nothing if they stop at `config.ts`. This drives a REAL
  // cordis Context and the REAL plugin through the REAL waterfall, with tiny caps
  // set through the config the way a deployment would set them.
  const dir = tempDir()
  const artifacts = join(dir, 'artifacts')
  const ctx = new Context()
  ctx.logger.exporter({ levels: { default: 3 }, export: () => undefined } as never)
  new PromptPlan(ctx as never, {
    mode: 'observe',
    artifactDir: artifacts,
    observe: true,
    fullText: true,
    observationLines: 2,
    observationTextLines: 2,
    observationPurityLines: 2,
    observationKeep: 1,
  })

  const agent = { session: { id: 'session-A' } }
  for (let index = 0; index < 5; index += 1) {
    const assembly = {
      sections: [{ name: 'persona', text: `x${String(index)}` }, { name: 'tools:sdk', text: 'interface ToolArgsMap {}' }],
      contexts: [],
      tools: [],
      variables: {},
    }
    await ctx.waterfall('system-prompt/assemble', assembly, { agent, scope: agent }, async () => assembly)
  }
  // The queue is drained when ALL THREE logs hold the last assembly. Writing one
  // log is not the signal: one queued record appends to `sections.jsonl`, then to
  // `sections-text.jsonl`, then to `purity.jsonl`, so an assertion that fired when
  // the first of the three reached the last ordinal would read the other two
  // mid-record. `baseline.assemblies` is not the signal either: it counts records
  // handed to the observer rather than lines written.
  const highest = (base: string): number => {
    const all = rotationNames(artifacts, base).flatMap(name => ordinalsOf(artifacts, name))
    return all.length === 0 ? -1 : Math.max(...all)
  }
  const deadline = Date.now() + 8000
  let written = [-1, -1, -1]
  while (Date.now() < deadline) {
    written = [highest(ARTIFACT_NAMES.sections), highest(ARTIFACT_NAMES.sectionsText), highest(ARTIFACT_NAMES.purity)]
    if (written.every(value => value >= 4)) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.deepEqual(written, [4, 4, 4], 'all five assemblies reached all three logs before the assertions run')

  for (const base of [ARTIFACT_NAMES.sections, ARTIFACT_NAMES.sectionsText, ARTIFACT_NAMES.purity]) {
    assert.equal(existsSync(join(artifacts, base + '.1')), true, base + ' rotated through the plugin, at the configured cap')
    assert.equal(existsSync(join(artifacts, base + '.2')), false, base + ' kept exactly the one rotation it was configured to keep')
    for (const name of rotationNames(artifacts, base)) {
      assert.ok(linesOf(artifacts, name).length <= 2, name + ' is within its configured cap of 2')
    }
  }
  // And the index beside them was never rotated, because it is not a log.
  assert.equal(existsSync(join(artifacts, ARTIFACT_NAMES.baseline + '.1')), false, 'baseline.json has no rotations')
  assert.equal(existsSync(join(artifacts, ARTIFACT_NAMES.baseline)), true, 'and it is still there')
})

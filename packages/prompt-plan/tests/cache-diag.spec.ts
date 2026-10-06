/**
 * The cache-stability diagnostics: a prompt-prefix fingerprint and a per-request
 * ledger.
 *
 * These are stated as the requirements rather than as the implementation, so
 * they keep their meaning if the code moves:
 *
 *   1. a changed assembled prompt is REPORTED and NAMED — which section moved,
 *      where, and whether the rule set moved with it — and an unchanged one is
 *      silent;
 *   2. the second seam is `assistant/message`, because the assembly waterfall
 *      runs before any usage exists; the ledger reads the adapter's own four
 *      counts off that event and computes the hit rate from a disjoint
 *      denominator. It refuses to invent a rate only when the adapter reported no
 *      HIT count — a missing WRITE count is zero for the denominator, because
 *      DeepSeek never reports writes and demanding one made the rate undefined on
 *      every real request;
 *   3. the ledgers are CAPPED: at most N lines per file, then rotation, with the
 *      oldest file deleted and nothing ever lost from the newest;
 *   4. nothing here gates. A changed prefix is recorded and the assembly is
 *      returned exactly as it would have been without the diagnostics.
 *
 * The wiring group drives a REAL cordis Context and the REAL plugin through the
 * real waterfall, and reads the ledgers back off the disk rather than trusting
 * an in-memory counter.
 *
 * @module @t4r71/dsh-prompt-plan/tests
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Logger } from '@deepseek-ai/cordis'
import PromptPlan from '../src/index.ts'
import {
  CACHE_ARTIFACT_NAMES,
  CacheLedger,
  PREFIX_SUBJECT_CAP,
  cacheHitRate,
  describeUsage,
  diffSections,
  promptFingerprint,
  readUsage,
} from '../src/cache.ts'
import { digestSections } from '../src/digest.ts'
import { resolvedConfig } from '../src/config.ts'

/** A fresh directory for one test. */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'prompt-plan-cache-'))
}

/** Write a file and return its path. */
function write(path: string, text: string): string {
  writeFileSync(path, text)
  return path
}

/** One rule file that changes a section's text, so rule-driven changes can be staged. */
const RULE_FILE = [
  'version: 1',
  'rules:',
  '  - id: replace-persona',
  '    match:',
  '      kind: exact',
  '      value: persona',
  '    action:',
  '      kind: replace',
  '      text: REWRITTEN',
].join('\n') + '\n'

/** A second revision of the same rule file, with different replacement text. */
const RULE_FILE_V2 = RULE_FILE.replace('REWRITTEN', 'REWRITTEN-AGAIN')

/** Parse a JSONL ledger, skipping blank lines. */
function linesOf(directory: string, name: string): Record<string, unknown>[] {
  const path = join(directory, name)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
}

/** Wait until a predicate over the on-disk ledger holds, or fail with what arrived. */
async function waitFor(directory: string, name: string, count: number, label: string): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + 8000
  let last: Record<string, unknown>[] = []
  while (Date.now() < deadline) {
    last = linesOf(directory, name)
    if (last.length >= count) return last
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(label + ': wanted ' + String(count) + ' line(s), have ' + String(last.length) + ': ' + JSON.stringify(last, null, 1))
}

/** Capture the host log lines a plugin writes, through cordis's own exporter API. */
function captureLines(): { lines: string[]; exporter: { export: (message: unknown) => void } } {
  const lines: string[] = []
  const exporter = {
    levels: { default: 3 },
    export(message: unknown): void {
      lines.push(Logger.format(exporter as never, message as never))
    },
  }
  return { lines, exporter }
}

/** Wait until a captured line matches, or fail with the lines that did arrive. */
async function waitForLine(lines: readonly string[], pattern: RegExp, label: string): Promise<string> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const found = lines.find(line => pattern.test(line))
    if (found !== undefined) return found
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(label + ': no line matched ' + String(pattern) + '; captured: ' + JSON.stringify(lines, null, 1))
}

/** Drive the real waterfall once with a given section list. */
async function assembleWith(ctx: Context, agent: unknown, sections: { name: string; text: string }[]): Promise<void> {
  const assembly = { sections, contexts: [], tools: [], variables: {} }
  await ctx.waterfall('system-prompt/assemble', assembly, { agent, scope: agent }, async () => assembly)
}

/** The default two-section assembly the wiring tests start from. */
const BASE_SECTIONS = [{ name: 'persona', text: 'x' }, { name: 'tools:sdk', text: 'interface ToolArgsMap {}' }]

// -----------------------------------------------------------------------------
// The fingerprint and the section diff
// -----------------------------------------------------------------------------

test('the fingerprint ignores nothing that reaches the model and is stable across a re-render', () => {
  const first = promptFingerprint(digestSections(BASE_SECTIONS))
  const again = promptFingerprint(digestSections(BASE_SECTIONS.map(section => ({ ...section }))))
  assert.equal(first, again, 'the same sections hash the same')
  assert.match(first, /^[0-9a-f]{64}$/, 'and the value is a sha256')

  // Every member that changes what the model is sent must move the hash.
  const cases: { label: string; sections: { name: string; text: string }[] }[] = [
    { label: 'a section text', sections: [{ name: 'persona', text: 'y' }, BASE_SECTIONS[1]!] },
    { label: 'a section name', sections: [{ name: 'person', text: 'x' }, BASE_SECTIONS[1]!] },
    { label: 'the section order', sections: [BASE_SECTIONS[1]!, BASE_SECTIONS[0]!] },
    { label: 'a section count', sections: [BASE_SECTIONS[0]!] },
    { label: 'an added section', sections: [...BASE_SECTIONS, { name: 'extra', text: '' }] },
  ]
  for (const item of cases) {
    assert.notEqual(promptFingerprint(digestSections(item.sections)), first, 'changing ' + item.label + ' changes the fingerprint')
  }

  // Concatenation must not collide: two assemblies whose joined text is equal
  // but whose section boundaries differ are different prompts.
  const boundaries = promptFingerprint(digestSections([{ name: 'a', text: 'bc' }, { name: 'b', text: '' }]))
  const other = promptFingerprint(digestSections([{ name: 'a', text: 'b' }, { name: 'b', text: 'c' }]))
  assert.notEqual(boundaries, other, 'section boundaries are part of the identity')
})

test('the section diff names what changed, and separates a moved section from a retexted one', () => {
  const before = digestSections([{ name: 'a', text: '1' }, { name: 'b', text: '2' }, { name: 'c', text: '3' }])
  const after = digestSections([{ name: 'b', text: '2' }, { name: 'a', text: 'CHANGED' }, { name: 'd', text: '4' }])
  const diff = diffSections(before, after)
  const byName = new Map(diff.changes.map(change => [change.name, change]))
  assert.equal(byName.get('a')?.kind, 'text', 'a retexted section is reported as text, with both hashes')
  assert.equal(byName.get('a')?.fromSha256, before[0]!.textSha256)
  assert.equal(byName.get('a')?.toSha256, after[1]!.textSha256)
  assert.equal(byName.get('b')?.kind, 'position', 'a section that only moved is not reported as retexted')
  assert.equal(byName.get('c')?.kind, 'removed')
  assert.equal(byName.get('d')?.kind, 'added')
  assert.equal(diff.changedCount, 4)
  assert.equal(diff.firstChangedIndex, 0, 'the earliest changed index in the CURRENT assembly')

  const identical = diffSections(before, digestSections([{ name: 'a', text: '1' }, { name: 'b', text: '2' }, { name: 'c', text: '3' }]))
  assert.deepEqual(identical.changes, [])
  assert.equal(identical.firstChangedIndex, null)
})

// -----------------------------------------------------------------------------
// The usage record
// -----------------------------------------------------------------------------

test('the four counts are read from the event, and a payload missing the required two is not one', () => {
  const event = {
    type: 'assistant/message',
    data: { turn: 3, step: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 90, cacheWriteTokens: 0 } },
  }
  const described = describeUsage(event)
  assert.ok(described !== undefined, 'an assistant/message with usage is a request to record')
  assert.equal(described.turn, 3)
  assert.equal(described.step, 1)
  assert.equal(described.usage.cacheReadTokens, 90)

  // Every other event type is skipped: none of them carries accounting.
  assert.equal(describeUsage({ type: 'step/end', data: { turn: 1, step: 1 } }), undefined)
  assert.equal(describeUsage({ type: 'user/message', data: { usage: { inputTokens: 1, outputTokens: 1 } } }), undefined)
  // An assistant/message the adapter reported no usage for is a request with no
  // accounting, which must not be recorded as a row of zeros.
  assert.equal(describeUsage({ type: 'assistant/message', data: { turn: 1, step: 1 } }), undefined)
  // A malformed count is refused rather than coerced.
  assert.equal(readUsage({ inputTokens: 1.5, outputTokens: 1 }), undefined)
  assert.equal(readUsage({ inputTokens: -1, outputTokens: 1 }), undefined)
  assert.equal(readUsage({ inputTokens: 1 }), undefined)
  // A payload with the two required counts but no cache fields is a valid usage
  // record whose cache counts are ABSENT — which is a different fact from zero,
  // and is what makes the hit rate undefined rather than 0.
  const noCache = readUsage({ inputTokens: 1, outputTokens: 2 })
  assert.ok(noCache !== undefined)
  assert.equal(noCache.cacheReadTokens, undefined, 'absent stays absent; it is not coerced to 0')
  // The READ count is the one whose absence is fatal: without it nothing is known
  // about hits, so no rate is invented.
  assert.equal(cacheHitRate(noCache), undefined)
  const zeroCache = readUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 })
  assert.ok(zeroCache !== undefined)
  assert.equal(zeroCache.cacheReadTokens, 0, 'an explicit zero is kept as zero, and the two are told apart')
  assert.equal(cacheHitRate(zeroCache), 0)
})

test('a missing cache WRITE count yields a rate, not undefined (the DeepSeek shape)', () => {
  // The real DeepSeek adapter maps `cache_read_input_tokens` and never sets a
  // write count, so every live request looks like this. An earlier revision
  // demanded both cache fields and therefore returned undefined on every request,
  // which silently disabled the metric it exists to report.
  const deepseek = readUsage({ inputTokens: 720, outputTokens: 453, cacheReadTokens: 128768 })
  assert.ok(deepseek !== undefined)
  assert.equal(deepseek.cacheReadTokens, 128768)
  assert.equal(deepseek.cacheWriteTokens, undefined, 'the write count is still recorded as absent, not as 0')
  // billed = 720 + 128768 (+ 0) = 129488; 128768/129488 = 0.99443...
  assert.equal(cacheHitRate(deepseek), 0.9944, 'a missing write count is zero for the denominator only')

  // The two absences must stay distinguishable, or "adapter reports no writes"
  // and "adapter reports no hits" would collapse into one fact.
  const noRead = readUsage({ inputTokens: 720, outputTokens: 453 })
  assert.ok(noRead !== undefined)
  assert.equal(cacheHitRate(noRead), undefined, 'a missing READ count still refuses')
})

test('the hit rate uses the disjoint denominator and refuses to invent one', () => {
  const billed = { inputTokens: 100, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 0, totalTokens: undefined, reasoningTokens: undefined }
  assert.equal(cacheHitRate(billed), 0.9, 'cacheRead over billed input (uncached + read + write)')

  // A write-only request is a 0% hit, not an undefined rate.
  const writeOnly = { inputTokens: 1000, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: undefined, reasoningTokens: undefined }
  assert.equal(cacheHitRate(writeOnly), 0)

  // No cache fields at all: the rate cannot be computed and is not guessed.
  const absent = readUsage({ inputTokens: 10, outputTokens: 1 })
  assert.ok(absent !== undefined)
  assert.equal(cacheHitRate(absent), undefined)

  // Zero billed input: no rate, rather than a division by zero or a fabricated 1.
  const empty = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: undefined, reasoningTokens: undefined }
  assert.equal(cacheHitRate(empty), undefined)

  // And it never rounds a partial hit up to a whole one.
  const partial = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 9999, cacheWriteTokens: 0, totalTokens: undefined, reasoningTokens: undefined }
  assert.equal(cacheHitRate(partial), 0.9999)
})

// -----------------------------------------------------------------------------
// The caps: the ledger is a bounded file
// -----------------------------------------------------------------------------

test('the ledger rotates at its line cap, deletes the oldest, and loses no line that is still within the window', async () => {
  const dir = tempDir()
  const ledger = new CacheLedger({
    directory: dir,
    lines: 3,
    keep: 2,
    heartbeat: 0,
    alwaysRecordPrefix: true,
    report: () => undefined,
  })

  // Ten lines through a 3-line x 2-rotation cap. The window is 3 x 3 = 9 lines,
  // so the tenth forces a rotation that DELETES the oldest file — which is the
  // whole point: the ledger is a bounded file, and this is where it is bounded.
  for (let index = 0; index < 10; index += 1) {
    ledger.observeUsage({
      sessionId: 's',
      turn: index,
      step: 1,
      usage: { inputTokens: index, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: undefined, reasoningTokens: undefined },
      interrupted: false,
    })
  }
  await ledger.drain()

  const names = readdirSync(dir).filter(name => name.startsWith(CACHE_ARTIFACT_NAMES.usage))
  assert.deepEqual(
    names.sort(),
    [CACHE_ARTIFACT_NAMES.usage, CACHE_ARTIFACT_NAMES.usage + '.1', CACHE_ARTIFACT_NAMES.usage + '.2'].sort(),
    'exactly the live file and the two rotations it is allowed — never a fourth file',
  )
  // Every file is within the cap. This is the requirement: no file ever grows
  // past `lines`, however long the process runs.
  for (const name of names) {
    const count = linesOf(dir, name).length
    assert.ok(count <= 3, name + ' holds ' + String(count) + ' line(s), which must be at most the cap of 3')
  }

  const kept = await ledger.read('usage')
  assert.deepEqual(kept.map(record => record.ordinal), [3, 4, 5, 6, 7, 8, 9], 'the window slid forward: the three oldest lines are gone')
  assert.ok(!kept.some(record => record.ordinal === 0), 'specifically, ordinal 0 was deleted rather than kept')
  assert.ok(kept.length <= 3 * 3, 'and the whole ledger is within 3 lines x 3 files')
})

test('the prefix ledger resumes its ordinal across a restart instead of renumbering from zero', async () => {
  const dir = tempDir()
  const options = { directory: dir, lines: 100, keep: 2, heartbeat: 0, alwaysRecordPrefix: true, report: () => undefined }
  const first = new CacheLedger(options)
  first.observe({ sessionId: 'a', sections: BASE_SECTIONS, ruleSetSha256: undefined })
  first.observe({ sessionId: 'a', sections: BASE_SECTIONS, ruleSetSha256: undefined })
  await first.drain()

  // A second mount over the same directory is what a host restart looks like.
  const second = new CacheLedger(options)
  second.observe({ sessionId: 'a', sections: BASE_SECTIONS, ruleSetSha256: undefined })
  await second.drain()

  const records = await second.read('prefix')
  assert.deepEqual(records.map(record => record.ordinal), [0, 1, 2], 'one counter across the directory, resumed from the file')
})

test('a prompt that CHANGED across a restart is reported as a change, not as a baseline', async () => {
  // The miss this guards against: the fingerprint memory used to be in-process
  // only, so the first assembly after a restart was written `first: true` even
  // when the fingerprint had moved — a silent MISS in the one thing this feature
  // exists to report. The machine this runs on restarts often, so the blind
  // window was the common case, not the corner case.
  const dir = tempDir()
  const reports: string[] = []
  const options = { directory: dir, lines: 100, keep: 2, heartbeat: 0, alwaysRecordPrefix: false, report: (m: string) => reports.push(m) }
  const moved = [{ name: 'persona', text: 'BBB', interpolate: undefined }]
  const movedAgain = [{ name: 'persona', text: 'CCC', interpolate: undefined }]

  const first = new CacheLedger(options)
  first.observe({ sessionId: 'S', sections: BASE_SECTIONS, ruleSetSha256: 'R1' })
  await first.drain()

  // Restart 1: the prompt moved, the rule set did not — an OUTSIDE change.
  const second = new CacheLedger(options)
  second.observe({ sessionId: 'S', sections: moved, ruleSetSha256: 'R1' })
  await second.drain()

  // Restart 2: the prompt moved AGAIN (a new text, so this is a fresh change and
  // not a silent no-op) and the rule set moved with it — this package reading a
  // new rule file.
  const third = new CacheLedger(options)
  third.observe({ sessionId: 'S', sections: movedAgain, ruleSetSha256: 'R2' })
  await third.drain()

  const records = await third.read('prefix')
  assert.equal(records.length, 3)
  assert.equal(records[0]?.first, true, 'the first run establishes the baseline')
  assert.equal(records[0]?.changed, false)

  // The point of the whole test: the post-restart line is a CHANGE.
  assert.equal(records[1]?.first, false, 'a restart does not make a known subject new again')
  assert.equal(records[1]?.changed, true, 'and a moved fingerprint is not filed as a baseline')
  assert.equal(records[1]?.restored, true, 'the line says its previous state came from an earlier run')
  assert.equal(records[1]?.ruleSetChanged, false, 'the rule set did NOT move, so something else wrote to the prompt')
  assert.equal(records[1]?.previousPromptSha256, records[0]?.promptSha256, 'and it names the hash it compared against')

  assert.equal(records[2]?.changed, true)
  assert.equal(records[2]?.restored, true)
  assert.equal(records[2]?.ruleSetChanged, true, 'here the rule set moved with it, so it was this package')

  // Section-level detail cannot survive a restart (the ledger stores no per-section
  // digests), so it must be ABSENT rather than reported as "0 sections differ".
  assert.equal(records[1]?.changedSections, undefined, 'no invented section list')
  assert.equal(records[1]?.changedSectionCount, undefined)

  assert.equal(reports.length, 2, 'both changes were reported to the host log')
  assert.match(String(reports[0]), /RULE SET DID NOT CHANGE/, 'the outside change is attributed correctly')
  assert.match(String(reports[0]), /first assembly after a restart/, 'and the missing detail is explained rather than silently absent')
  assert.match(String(reports[1]), /rule set changed too/, 'the rule revision is attributed correctly')
})

test('a subject restored from a restart is compared against the restored hash only once', async () => {
  // The restored state is consumed by the first assembly that reads it. If it
  // were left in place, every later assembly would compare against the
  // pre-restart hash instead of the one just computed, and a steady prompt would
  // report a change forever.
  const dir = tempDir()
  const options = { directory: dir, lines: 100, keep: 2, heartbeat: 0, alwaysRecordPrefix: false, report: () => undefined }

  const first = new CacheLedger(options)
  first.observe({ sessionId: 'S', sections: BASE_SECTIONS, ruleSetSha256: undefined })
  await first.drain()

  const second = new CacheLedger(options)
  const moved = [{ name: 'persona', text: 'MOVED', interpolate: undefined }]
  second.observe({ sessionId: 'S', sections: moved, ruleSetSha256: undefined })
  // The same prompt again IN THE SAME RUN must be silent, not another change.
  const again = second.observe({ sessionId: 'S', sections: moved, ruleSetSha256: undefined })
  await second.drain()

  assert.equal(again, undefined, 'the second identical assembly writes nothing')
  const records = await second.read('prefix')
  assert.equal(records.length, 2, 'exactly one baseline and one change')
  assert.equal(records[1]?.changed, true)
})

test('the subject memory is capped, so a host that opens sessions forever does not grow a map forever', () => {
  const dir = tempDir()
  const ledger = new CacheLedger({
    directory: dir,
    lines: 100,
    keep: 1,
    heartbeat: 0,
    alwaysRecordPrefix: false,
    report: () => undefined,
  })
  // More distinct subjects than the cap, each with its own fingerprint.
  for (let index = 0; index < PREFIX_SUBJECT_CAP + 10; index += 1) {
    // Each is a FIRST assembly for its subject, so each writes one line; the
    // point of this test is the memory, and the summary reports it.
    ledger.observe({ sessionId: 's' + String(index), sections: BASE_SECTIONS, ruleSetSha256: undefined })
  }
  const tracked = Number(/^.*?(\d+) subject/.exec(ledger.summary())?.[1])
  assert.ok(tracked <= PREFIX_SUBJECT_CAP, 'at most ' + String(PREFIX_SUBJECT_CAP) + ' subjects are tracked, saw ' + String(tracked))
})

test('the heartbeat is spaced by assemblies, not by assemblies under one fingerprint', () => {
  const dir = tempDir()
  const ledger = new CacheLedger({
    directory: dir,
    lines: 1000,
    keep: 1,
    heartbeat: 3,
    alwaysRecordPrefix: false,
    report: () => undefined,
  })
  const observe = (text: string, session: string): void => {
    ledger.observe({ sessionId: session, sections: [{ name: 'a', text }], ruleSetSha256: undefined })
  }
  // Four identical assemblies: the first writes the baseline, and the heartbeat
  // then fires on the assembly that is `heartbeat` assemblies later — the 4th,
  // not the 3rd, because the first line already stands for the 1st.
  observe('1', 'A')  // line 0: first
  observe('1', 'A')  // no line
  observe('1', 'A')  // no line
  observe('1', 'A')  // line 1: heartbeat, 3 assemblies since line 0
  // A change writes immediately and RESETS the heartbeat spacing. If the spacing
  // were derived from `repeat` — which restarts at 1 on a change — the very next
  // assembly would fire a second line here.
  observe('2', 'A')  // line 2: change
  observe('2', 'A')  // no line — and this is the assertion
  observe('2', 'A')  // no line
  observe('2', 'A')  // line 3: heartbeat
  // `read` awaits the queued writes, so the assertions below see the whole run.
  return ledger.read('prefix').then(records => {
    assert.deepEqual(
      records.map(record => ({ ordinal: record.ordinal, changed: record.changed, repeat: record.repeat })),
      [
        { ordinal: 0, changed: false, repeat: 1 },
        { ordinal: 1, changed: false, repeat: 4 },
        { ordinal: 2, changed: true, repeat: 1 },
        { ordinal: 3, changed: false, repeat: 4 },
      ],
      'four lines: first, heartbeat, change, heartbeat — not a line after every change',
    )
    assert.equal(records[1]!.assembliesSince, 3, 'the heartbeat names the distance it spans')
    assert.equal(records[3]!.assembliesSince, 3)
  })
})

// -----------------------------------------------------------------------------
// The wiring: the fingerprint reaches the ledger, and never gates
// -----------------------------------------------------------------------------

test('an unchanged prompt is recorded once and then silent, and a changed one names the section', async () => {
  const dir = tempDir()
  const artifacts = join(dir, 'artifacts')
  const ctx = new Context()
  const { exporter } = captureLines()
  ctx.logger.exporter(exporter as never)
  // heartbeat 0: only changes and first lines are written, so the silence of an
  // unchanged assembly is observable as an absence rather than as a heartbeat.
  new PromptPlan(ctx as never, { mode: 'observe', artifactDir: artifacts, observe: true, cacheDiag: true, cacheHeartbeat: 0 })

  const agent = { session: { id: 'session-A' } }
  await assembleWith(ctx, agent, BASE_SECTIONS)
  await assembleWith(ctx, agent, BASE_SECTIONS)
  await assembleWith(ctx, agent, BASE_SECTIONS)

  const records = await waitFor(artifacts, CACHE_ARTIFACT_NAMES.prefix, 1, 'the first line')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(records.length, 1, 'three identical assemblies write one line, not three')
  assert.equal(records[0]!.changed, false)
  assert.equal(records[0]!.first, true)
  assert.equal(records[0]!.sessionId, 'session-A')
  assert.equal(records[0]!.sectionCount, 2)
  assert.match(String(records[0]!.promptSha256), /^[0-9a-f]{64}$/)

  // Now move one section's text. The change is attributed to its name.
  await assembleWith(ctx, agent, [{ name: 'persona', text: 'MOVED' }, BASE_SECTIONS[1]!])
  const after = await waitFor(artifacts, CACHE_ARTIFACT_NAMES.prefix, 2, 'the change line')
  const change = after[1]!
  assert.equal(change.changed, true)
  assert.equal(change.ruleSetChanged, false, 'no rule set moved, which is what makes this "something else wrote"')
  assert.equal(change.changedSectionCount, 1)
  assert.equal(change.firstChangedIndex, 0)
  const changed = (change.changedSections as Record<string, unknown>[])[0]!
  assert.deepEqual(
    { kind: changed.kind, name: changed.name, from: changed.from, to: changed.to },
    { kind: 'text', name: 'persona', from: 0, to: 0 },
  )
  assert.match(String(changed.fromSha256), /^[0-9a-f]{64}$/, 'the changed section carries hashes, never text')
  assert.equal(JSON.stringify(change).includes('MOVED'), false, 'and the ledger never carries the section text itself')
})

test('a rule revision and an outside change are told apart by ruleSetChanged', async () => {
  const dir = tempDir()
  const rules = write(join(dir, 'prompt-plan.rules.yaml'), RULE_FILE)
  const artifacts = join(dir, 'artifacts')
  const ctx = new Context()
  const { lines, exporter } = captureLines()
  ctx.logger.exporter(exporter as never)
  const plugin = new PromptPlan(ctx as never, {
    mode: 'rewrite',
    rulesFile: rules,
    artifactDir: artifacts,
    observe: true,
    cacheDiag: true,
    cacheHeartbeat: 0,
  })

  const agent = { session: { id: 'session-A' } }
  ctx.emit('session/created', agent.session as never)
  await waitForLine(lines, /loaded 1 rule\(s\)/, 'the first pin')
  await assembleWith(ctx, agent, BASE_SECTIONS)

  // A NEW rule file, re-pinned for the session by the plugin's own public path:
  // this is the documented way a rule revision takes effect, and the revision is
  // the only thing that moved.
  write(join(dir, 'prompt-plan.rules.yaml'), RULE_FILE_V2)
  await plugin.reloadRules(ctx as never, { session: 'session-A' })
  await assembleWith(ctx, agent, BASE_SECTIONS)

  const records = await waitFor(artifacts, CACHE_ARTIFACT_NAMES.prefix, 2, 'the rule-revision line')
  const revision = records[1]!
  assert.equal(revision.changed, true)
  assert.equal(revision.ruleSetChanged, true, 'the rule set moved with the prompt')
  assert.notEqual(revision.ruleSetSha256, revision.previousRuleSetSha256)
})

test('a sessionless assembly is recorded as null, and each subject is compared against its own previous prompt', async () => {
  const dir = tempDir()
  const artifacts = join(dir, 'artifacts')
  const ctx = new Context()
  const { exporter } = captureLines()
  ctx.logger.exporter(exporter as never)
  new PromptPlan(ctx as never, { mode: 'observe', artifactDir: artifacts, observe: true, cacheDiag: true, cacheHeartbeat: 0, cacheRecordEveryAssembly: true })

  await assembleWith(ctx, {}, BASE_SECTIONS)
  await assembleWith(ctx, { session: { id: 'session-A' } }, BASE_SECTIONS)
  // session-A's SECOND assembly is identical TO ITS OWN first — which is what
  // "compared against its own previous" means; a single global fingerprint would
  // have called this a change because a sessionless assembly came between them.
  await assembleWith(ctx, { session: { id: 'session-A' } }, BASE_SECTIONS)

  const records = await waitFor(artifacts, CACHE_ARTIFACT_NAMES.prefix, 3, 'three lines')
  assert.equal(records[0]!.sessionId, null, 'an assembly with no subject is recorded as null, not omitted')
  assert.equal(records[1]!.changed, false, 'a new subject starts its own baseline rather than reporting a change')
  assert.equal(records[2]!.changed, false, 'and an unchanged assembly of a second subject is still unchanged')
  assert.equal(records[2]!.repeat, 2)
})

test('the diagnostics change nothing: the assembly returned is the one that would have been returned without them', async () => {
  const dir = tempDir()
  const withDiag = join(dir, 'with')
  const withoutDiag = join(dir, 'without')

  const run = async (artifacts: string, cacheDiag: boolean): Promise<unknown> => {
    const ctx = new Context()
    const { exporter } = captureLines()
    ctx.logger.exporter(exporter as never)
    new PromptPlan(ctx as never, { mode: 'observe', artifactDir: artifacts, observe: true, cacheDiag })
    const assembly = { sections: BASE_SECTIONS, contexts: ['c'], tools: ['t'], variables: { v: 1 } }
    return await ctx.waterfall('system-prompt/assemble', assembly, { agent: {}, scope: {} }, async () => assembly)
  }

  const plain = await run(withoutDiag, false) as Record<string, unknown>
  const diagnosed = await run(withDiag, true) as Record<string, unknown>
  assert.deepEqual(diagnosed.sections, plain.sections, 'the sections are untouched')
  assert.deepEqual(diagnosed.contexts, plain.contexts)
  assert.deepEqual(diagnosed.tools, plain.tools)
  assert.deepEqual(diagnosed.variables, plain.variables)
})

test('with the diagnostics OFF nothing is created, no listener is added, and the log says so', async () => {
  const dir = tempDir()
  const artifacts = join(dir, 'artifacts')
  const ctx = new Context()
  const { lines, exporter } = captureLines()
  ctx.logger.exporter(exporter as never)
  new PromptPlan(ctx as never, { mode: 'observe', artifactDir: artifacts, observe: true })

  const agent = { session: { id: 'session-A' } }
  await assembleWith(ctx, agent, BASE_SECTIONS)
  // Emit an event only the ledger's listener would consume.
  ctx.emit('session/event', agent.session as never, {
    type: 'assistant/message',
    seq: 1,
    time: Date.now(),
    data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 0 } },
  } as never)
  await new Promise(resolve => setTimeout(resolve, 100))

  assert.equal(existsSync(join(artifacts, CACHE_ARTIFACT_NAMES.prefix)), false, 'no prefix ledger')
  assert.equal(existsSync(join(artifacts, CACHE_ARTIFACT_NAMES.usage)), false, 'no usage ledger')
  assert.equal(existsSync(join(artifacts, CACHE_ARTIFACT_NAMES.note)), false, 'not even the note')
  const mount = lines.find(line => line.includes('cache diagnostics'))
  assert.ok(mount !== undefined, 'the mount line states which way it is')
  assert.match(mount, /cache diagnostics off/)
})

test('the usage ledger is written from the session event, with the hit rate the counts imply', async () => {
  const dir = tempDir()
  const artifacts = join(dir, 'artifacts')
  const ctx = new Context()
  const { exporter } = captureLines()
  ctx.logger.exporter(exporter as never)
  new PromptPlan(ctx as never, { mode: 'observe', artifactDir: artifacts, observe: true, cacheDiag: true })

  const session = { id: 'session-A' }
  ctx.emit('session/event', session as never, {
    type: 'assistant/message',
    seq: 9,
    time: Date.now(),
    data: { turn: 2, step: 1, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 0 } },
  } as never)

  const records = await waitFor(artifacts, CACHE_ARTIFACT_NAMES.usage, 1, 'one usage line')
  const record = records[0]!
  assert.equal(record.sessionId, 'session-A')
  assert.equal(record.turn, 2)
  assert.equal(record.step, 1)
  assert.equal(record.inputTokens, 100)
  assert.equal(record.outputTokens, 20)
  assert.equal(record.cacheReadTokens, 900)
  assert.equal(record.cacheWriteTokens, 0)
  assert.equal(record.cacheHitRate, 0.9)
  assert.equal(record.interrupted, false)
})

test('the ledger defaults are a small bounded file, and every cache field is off by default', () => {
  const defaults = resolvedConfig({})
  assert.equal(defaults.cacheDiag, false, 'the diagnostics are OFF unless asked for')
  assert.equal(defaults.cacheLedgerLines, 2000)
  assert.equal(defaults.cacheLedgerKeep, 4)
  assert.equal(defaults.cacheRecordEveryAssembly, false)
  // Worst case on disk for the prefix ledger, stated as the number the README
  // promises: 2000 lines x (1 live + 4 rotations) = 10000 lines.
  assert.equal(defaults.cacheLedgerLines * (defaults.cacheLedgerKeep + 1), 10000)

  // A hand-edited settings document that asks for a cap of zero gets a cap of
  // one, not an unbounded file: an unbounded diagnostic is the failure this
  // feature is required not to reproduce.
  const clamped = resolvedConfig({ cacheDiag: true, cacheLedgerLines: 0, cacheLedgerKeep: -5, cacheHeartbeat: -1 })
  assert.equal(clamped.cacheLedgerLines, 1)
  assert.equal(clamped.cacheLedgerKeep, 1)
  assert.equal(clamped.cacheHeartbeat, 0, 'a negative heartbeat means "no heartbeat", not a modulo by a negative number')
})

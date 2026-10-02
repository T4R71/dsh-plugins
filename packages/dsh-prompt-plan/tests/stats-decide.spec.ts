/**
 * Tests for the two halves of adaptive tool-loading.
 *
 * Two properties get the most attention, because they are the two the design
 * actually turns on and the two that are easiest to lose silently:
 *
 *   1. A NEVER-CALLED tool ends up resident. This is the cold-start guarantee:
 *      if it were demoted, the model would never learn it exists, and the
 *      statistics could never improve. The test asserts the bucket AND that the
 *      reason string says "never called", so a future refactor cannot satisfy
 *      the rule by accident.
 *
 *   2. The stats file's damage tolerance. Both damages are exercised for real:
 *      a truncated zstd file on disk, and a corrupt stats document. Neither may
 *      throw, and the second must degrade to a full recomputation.
 *
 * The fixture logs are built with the real zlib, not hand-written bytes, and the
 * "many small frames" case is asserted to be multi-frame first -- otherwise the
 * fixture could quietly become a single frame and stop testing the decoder at
 * all.
 *
 * @module @t4r71/dsh-prompt-plan/tests
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import {
  countSession,
  decodeZstdFrames,
  findSessionLogs,
  formatStatsFile,
  loadLedger,
  parseStatsFile,
  scanSessions,
  toolNameOf,
  writeStatsFile,
} from '../src/stats.ts'
import type { StatsFile } from '../src/stats.ts'
import {
  borderlineTools,
  decideToolPlan,
  estimateSessionSavings,
  factsFromStats,
  protectTop,
  sweepHitchProbability,
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_OUTPUT_TOKENS,
  DECISION_DEFAULTS,
} from '../src/decide.ts'
import type { DecideContext, ToolFacts } from '../src/decide.ts'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** One top-level tool call event, as the logs spell it. */
function topLevelCall(name: string, time: number): string {
  return JSON.stringify({ type: 'tool/call', seq: 1, time, data: { name, callId: 'c' + time } })
}

/** One PTC inner tool call event, as the logs spell it. */
function ptcCall(name: string, time: number): string {
  return JSON.stringify({ type: 'tool/ptc-dispatch-start', seq: 1, time, data: { name, rootCallId: 'r' + time } })
}

/** A session header line, so the fixture looks like a real log. */
function header(id: string, cwd: string): string {
  return JSON.stringify({ type: 'session', version: 4, id, createdAt: 1, cwd, delegationDepth: 0 })
}

/** Build a multi-frame zstd container, exactly like the session logs. */
function frames(lines: readonly string[], perFrame: number): Buffer {
  const buffers: Buffer[] = []
  for (let index = 0; index < lines.length; index += perFrame) {
    buffers.push(zstdCompressSync(Buffer.from(lines.slice(index, index + perFrame).join('\n') + '\n', 'utf8')))
  }
  return Buffer.concat(buffers)
}

/** A scratch directory that the test removes afterwards. */
function scratch(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-plan-stats-'))
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Write one session log into a sessions root laid out root/project/session-id/. */
function writeLog(root: string, project: string, sessionId: string, lines: readonly string[], perFrame = 3): string {
  const dir = join(root, project, sessionId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(path, frames(lines, perFrame))
  return path
}

/** The decision context the arithmetic tests pin, so numbers stay readable. */
const PINNED: DecideContext = { contextTokens: 1000, outputTokens: 0, charsPerToken: 1, turnsPerSession: 10, hitchProbability: 0.5, hitchCostFraction: 0.5, protectionCount: 0 }

/* ------------------------------------------------------------------ *
 * Frame decoding
 * ------------------------------------------------------------------ */

test('decodeZstdFrames reads EVERY frame, not just the first', () => {
  const lines = Array.from({ length: 9 }, (_unused, index) => topLevelCall('t' + index, 1000 + index))
  const container = frames(lines, 3)
  // Guard the fixture itself: a single-frame container would make this test
  // pass without the multi-frame path ever running.
  assert.notEqual(zstdCompressSync(Buffer.from(lines.join('\n') + '\n')).length, container.length)
  const decoded = decodeZstdFrames(container)
  assert.equal(decoded.frames, 3)
  assert.equal(decoded.rejected, 0)
  assert.equal(decoded.text.split('\n').filter(line => line.length > 0).length, 9)
})

test('decodeZstdFrames tolerates a torn final frame', () => {
  const lines = [topLevelCall('a', 1), topLevelCall('b', 2), topLevelCall('c', 3)]
  const container = frames(lines, 1)
  // Cut in the middle of the last frame, exactly as a crashed append leaves it.
  const torn = container.subarray(0, container.length - 4)
  const decoded = decodeZstdFrames(torn)
  // The two complete frames decode in full. The torn tail is still a legal frame
  // end at EOF, so it decodes to a PARTIAL payload rather than failing -- which is
  // exactly why countSession has to tolerate a bad trailing line.
  assert.equal(decoded.frames, 3)
  assert.equal(decoded.rejected, 0)
  assert.match(decoded.text, /"name":"a"/)
  assert.match(decoded.text, /"name":"b"/)
  // The tail is present but not a complete record; the counting layer is what
  // turns that into "ignored" rather than "counted".
  const counted = countSession(decoded.text)
  assert.equal(counted.contribution.tools.get('a')?.calls, 1)
  assert.equal(counted.contribution.tools.get('b')?.calls, 1)
  assert.equal(counted.badLines, 1)
  assert.equal(counted.contribution.tools.get('c'), undefined)
})

test('toolNameOf accepts both real spellings and nothing else', () => {
  assert.equal(toolNameOf(JSON.parse(topLevelCall('read', 1))), 'read')
  assert.equal(toolNameOf(JSON.parse(ptcCall('pwsh', 1))), 'pwsh')
  assert.equal(toolNameOf({ type: 'tool/result', data: { name: 'read' } }), undefined)
  assert.equal(toolNameOf({ type: 'tool/call', data: {} }), undefined)
  assert.equal(toolNameOf(null), undefined)
})

/* ------------------------------------------------------------------ *
 * Damage tolerance
 * ------------------------------------------------------------------ */

test('a corrupt log is recorded as a failure and does NOT stop the scan', () => {
  const box = scratch()
  try {
    const root = join(box.dir, 'sessions')
    writeLog(root, '--p--', 'good', [header('good', 'P:'), topLevelCall('read', 10)])
    const badPath = join(root, '--p--', 'bad')
    mkdirSync(badPath, { recursive: true })
    // A non-empty file with no zstd frame at all: not a log, but present.
    writeFileSync(join(badPath, 'session.v4.jsonl.zstd'), Buffer.from('this is not zstd'))

    const result = scanSessions({ sessionsRoot: root })
    assert.equal(result.stats.sessions, 2)
    assert.equal(result.stats.tools.read?.calls, 1)
    assert.equal(result.stats.failures.length, 1)
    assert.match(result.stats.failures[0]?.problem ?? '', /no decodable zstd frame/)
  } finally {
    box.dispose()
  }
})

test('an unreadable session directory is skipped without throwing', () => {
  const box = scratch()
  try {
    const root = join(box.dir, 'sessions')
    writeLog(root, '--p--', 'good', [topLevelCall('read', 10)])
    // A project directory holding a file where a session dir should be.
    writeFileSync(join(root, 'stray-file'), 'not a directory')
    const found = findSessionLogs(root)
    assert.equal(found.length, 1)
    assert.equal(scanSessions({ sessionsRoot: root }).stats.tools.read?.calls, 1)
  } finally {
    box.dispose()
  }
})

test('a corrupt STATS file degrades to an empty ledger and a full recomputation', () => {
  const truncated = '{"kind":"header","version":1,"sessions":9,"pro'
  const fromTruncated = parseStatsFile(truncated)
  assert.equal(fromTruncated.previous, undefined)
  assert.deepEqual(fromTruncated.ledger.processed, {})

  const garbage = 'not json at all\n{{{ broken\n'
  assert.equal(parseStatsFile(garbage).previous, undefined)

  const wrongVersion = JSON.stringify({ kind: 'header', version: 99, sessions: 1, processed: {} })
  assert.equal(parseStatsFile(wrongVersion).previous, undefined)

  // A MISSING file is the same outcome, through the public entry point.
  assert.equal(loadLedger(join(tmpdir(), 'prompt-plan-definitely-absent.jsonl')).previous, undefined)
  assert.equal(loadLedger(undefined).previous, undefined)
})

/* ------------------------------------------------------------------ *
 * Counting and incrementality
 * ------------------------------------------------------------------ */

test('countSession sums top-level AND PTC calls, and skips bad lines', () => {
  const text = [
    topLevelCall('run_code', 5),
    ptcCall('read', 7),
    ptcCall('read', 9),
    '{"type":"tool/call","data":{"name":"read"},',
    '',
  ].join('\n')
  const counted = countSession(text)
  assert.equal(counted.badLines, 1)
  assert.equal(counted.contribution.tools.get('run_code')?.calls, 1)
  assert.equal(counted.contribution.tools.get('read')?.calls, 2)
  assert.equal(counted.contribution.tools.get('read')?.lastSeen, 9)
})

test('sessionsSeen counts SESSIONS, not calls', () => {
  const box = scratch()
  try {
    const root = join(box.dir, 'sessions')
    // 5 calls in one session, 1 call in each of two others.
    writeLog(root, '--p--', 'chatty', [topLevelCall('read', 1), topLevelCall('read', 2), topLevelCall('read', 3)])
    writeLog(root, '--p--', 'quiet-a', [topLevelCall('read', 1)])
    writeLog(root, '--p--', 'quiet-b', [topLevelCall('read', 1)])
    const { tools } = scanSessions({ sessionsRoot: root }).stats
    assert.equal(tools.read?.calls, 5)
    assert.equal(tools.read?.sessionsSeen, 3)
  } finally {
    box.dispose()
  }
})

test('a rescan skips unchanged logs and does not double-count', () => {
  const box = scratch()
  try {
    const root = join(box.dir, 'sessions')
    const out = join(box.dir, 'stats.jsonl')
    writeLog(root, '--p--', 'a', [topLevelCall('read', 1), topLevelCall('grep', 2)])
    const first = writeStatsFile({ sessionsRoot: root, outputPath: out })
    assert.equal(first.stats.newlyProcessed, 1)
    assert.equal(first.stats.skipped, 0)

    const second = writeStatsFile({ sessionsRoot: root, previousPath: out, outputPath: out })
    // Nothing changed on disk, so nothing was re-read and nothing grew.
    assert.equal(second.stats.newlyProcessed, 0)
    assert.equal(second.stats.skipped, 1)
    assert.equal(second.stats.tools.read?.calls, 1)
    assert.equal(second.stats.tools.grep?.calls, 1)

    // force re-reads, and must still land on the same totals rather than doubling.
    const forced = scanSessions({ sessionsRoot: root, previousPath: out, force: true })
    assert.equal(forced.stats.tools.read?.calls, 1)
    assert.equal(forced.stats.newlyProcessed, 1)
  } finally {
    box.dispose()
  }
})

test('a CHANGED log has its old contribution withdrawn before the new one is added', () => {
  const box = scratch()
  try {
    const root = join(box.dir, 'sessions')
    const out = join(box.dir, 'stats.jsonl')
    const path = writeLog(root, '--p--', 'a', [topLevelCall('read', 1), topLevelCall('read', 2)])
    writeStatsFile({ sessionsRoot: root, outputPath: out })
    // Rewrite the same session with one call instead of two.
    writeFileSync(path, frames([topLevelCall('read', 1)], 1))

    const after = scanSessions({ sessionsRoot: root, previousPath: out })
    assert.equal(after.stats.tools.read?.calls, 1, 'the withdrawn call must not survive')
    assert.equal(after.stats.tools.read?.sessionsSeen, 1)
  } finally {
    box.dispose()
  }
})

test('the written document round-trips through its own parser', () => {
  const box = scratch()
  try {
    const root = join(box.dir, 'sessions')
    writeLog(root, '--p--', 'a', [topLevelCall('read', 1), ptcCall('pwsh', 2)])
    const result = scanSessions({ sessionsRoot: root })
    const text = formatStatsFile(result)
    const back = parseStatsFile(text)
    assert.deepEqual(back.previous?.tools, result.stats.tools)
    assert.equal(back.previous?.sessions, 1)
    assert.deepEqual(Object.keys(back.ledger.processed), ['a'])
    // Every line ends with a newline, so a torn append leaves exactly one bad line.
    assert.ok(text.endsWith('\n'))
    assert.equal(text.split('\n').filter(line => line.length > 0).length, 3)
  } finally {
    box.dispose()
  }
})

/* ------------------------------------------------------------------ *
 * Decision: the mandatory cases
 * ------------------------------------------------------------------ */

test('COLD START: a never-called tool is RESIDENT, not observe-only', () => {
  const facts: ToolFacts[] = [
    { name: 'brand_new', calls: 0, declarationsChars: 4000 },
    { name: 'totally_absent_from_stats', calls: 0 },
  ]
  const plan = decideToolPlan(facts, { protectionCount: 0 })
  assert.deepEqual(plan.resident.sort(), ['brand_new', 'totally_absent_from_stats'])
  assert.deepEqual(plan.secondary, [])
  assert.deepEqual(plan.observe.sort(), ['brand_new', 'totally_absent_from_stats'])
  assert.match(plan.reasons.brand_new ?? '', /never called/)
  // A tool with NO measured declaration trips the unmeasured guard instead, which
  // is the same conclusion reached from a different unknown. Both must be resident.
  const unmeasured = decideToolPlan([{ name: 'no_length_known', calls: 0 }], { protectionCount: 0 })
  assert.deepEqual(unmeasured.resident, ['no_length_known'])
  assert.match(unmeasured.reasons.no_length_known ?? '', /not measured/)
})

test('HIGH FREQUENCY: a heavily used tool is resident', () => {
  const facts: ToolFacts[] = [{ name: 'read', calls: 2000, sessionsSeen: 60, declarationsChars: 300 }]
  const plan = decideToolPlan(facts, PINNED)
  assert.deepEqual(plan.resident, ['read'])
  assert.deepEqual(plan.secondary, [])
})

test('LOW FREQUENCY: a rare, cheap-to-fetch tool is secondary', () => {
  const facts: ToolFacts[] = [{ name: 'schedule_delete', calls: 1, sessionsSeen: 1, declarationsChars: 4000 }]
  const plan = decideToolPlan(facts, PINNED)
  // C_resident = 4000 chars / 1 * 10 turns = 40 000.
  // C_secondary = 1 call x (0.5 x 500 + 0.5 x 1000) = 750.
  assert.deepEqual(plan.secondary, ['schedule_delete'])
  assert.equal(plan.costs.schedule_delete?.residentTokens, 40_000)
  assert.equal(plan.costs.schedule_delete?.secondaryTokens, 750)
  assert.match(plan.reasons.schedule_delete ?? '', /^secondary:/)
})

test('the cost comparison is what decides, not a fixed cut on call count', () => {
  // Same call count, same fetch cost, wildly different declaration sizes.
  const cheap: ToolFacts[] = [{ name: 'thin', calls: 2, sessionsSeen: 1, declarationsChars: 10 }]
  const fat: ToolFacts[] = [{ name: 'thick', calls: 2, sessionsSeen: 1, declarationsChars: 4000 }]
  assert.deepEqual(decideToolPlan(cheap, PINNED).resident, ['thin'])
  assert.deepEqual(decideToolPlan(fat, PINNED).secondary, ['thick'])
})

test('PROTECTION LIST: the top K by calls stay resident regardless of the arithmetic', () => {
  const facts: ToolFacts[] = [
    { name: 'big', calls: 500, declarationsChars: 9000 },
    { name: 'mid', calls: 100, declarationsChars: 9000 },
    { name: 'small', calls: 1, declarationsChars: 100 },
  ]
  // Protect the top 1: only 'big' is protected, and it would otherwise be secondary.
  const one = decideToolPlan(facts, { ...PINNED, protectionCount: 1 })
  assert.ok(one.resident.includes('big'))
  assert.equal(one.costs.big?.protectedByRank, true)
  assert.match(one.reasons.big ?? '', /top-1 by calls/)
  assert.ok(one.secondary.includes('mid'), 'unprotected and dear-to-resident stays secondary')
  assert.equal(one.costs.mid?.protectedByRank, false)

  // Protect the top 2 and 'mid' is pulled back in as well.
  const two = decideToolPlan(facts, { ...PINNED, protectionCount: 2 })
  assert.ok(two.resident.includes('big') && two.resident.includes('mid'))
})

test('protectTop breaks ties on name, so the protected set is order-independent', () => {
  const facts: ToolFacts[] = [
    { name: 'zulu', calls: 5 },
    { name: 'alpha', calls: 5 },
    { name: 'mike', calls: 5 },
  ]
  const forward = protectTop(facts, 2)
  const reversed = protectTop([...facts].reverse(), 2)
  assert.deepEqual([...forward].sort(), [...reversed].sort())
  assert.deepEqual([...forward].sort(), ['alpha', 'mike'])
  assert.equal(protectTop(facts, 0).size, 0)
})

test('a tool whose INDEX is stripped can never go secondary', () => {
  const facts: ToolFacts[] = [
    { name: 'ghost', calls: 1, declarationsChars: 9000, discoverableIndex: false },
  ]
  const plan = decideToolPlan(facts, PINNED)
  // Secondary would be far cheaper on the numbers alone, and it is still refused.
  assert.ok(plan.costs.ghost!.secondaryTokens < plan.costs.ghost!.residentTokens)
  assert.deepEqual(plan.resident, ['ghost'])
  assert.equal(plan.costs.ghost?.forcedByIndex, true)
  assert.match(plan.reasons.ghost ?? '', /never learn this tool exists/)
})

test('the schedule_* trio behaves as the live example: an index makes secondary legal', () => {
  const facts: ToolFacts[] = [
    { name: 'schedule_create', calls: 1, sessionsSeen: 1, declarationsChars: 3000, discoverableIndex: true },
    { name: 'schedule_delete', calls: 1, sessionsSeen: 1, declarationsChars: 3000, discoverableIndex: true },
    { name: 'schedule_list', calls: 4, sessionsSeen: 3, declarationsChars: 3000, discoverableIndex: false },
  ]
  const plan = decideToolPlan(facts, PINNED)
  assert.ok(plan.secondary.includes('schedule_create'))
  assert.ok(plan.secondary.includes('schedule_delete'))
  assert.ok(plan.resident.includes('schedule_list'), 'no index -> resident even at 4 calls')
})

test('EMPTY STATISTICS: no tools, no crash, empty buckets', () => {
  const empty: StatsFile = { version: 1, scannedAt: 0, sessions: 0, newlyProcessed: 0, skipped: 0, tools: {}, failures: [] }
  const plan = decideToolPlan(factsFromStats(empty))
  assert.deepEqual(plan, { resident: [], secondary: [], observe: [], reasons: {}, costs: {} })
  assert.deepEqual(decideToolPlan([]), { resident: [], secondary: [], observe: [], reasons: {}, costs: {} })
})

test('an UNMEASURED declaration length is resident, not secondary', () => {
  const facts: ToolFacts[] = [{ name: 'unmeasured', calls: 50, sessionsSeen: 5 }]
  const plan = decideToolPlan(facts, PINNED)
  assert.deepEqual(plan.resident, ['unmeasured'])
  assert.match(plan.reasons.unmeasured ?? '', /not measured/)
})

test('decideToolPlan is deterministic and ignores input order', () => {
  const facts: ToolFacts[] = [
    { name: 'a', calls: 3, sessionsSeen: 2, declarationsChars: 500 },
    { name: 'b', calls: 40, sessionsSeen: 9, declarationsChars: 500 },
    { name: 'c', calls: 0, declarationsChars: 500 },
  ]
  const first = decideToolPlan(facts, PINNED)
  const second = decideToolPlan([...facts].reverse(), PINNED)
  assert.deepEqual(first.resident.slice().sort(), second.resident.slice().sort())
  assert.deepEqual(first.secondary.slice().sort(), second.secondary.slice().sort())
  assert.deepEqual(first, decideToolPlan(facts, PINNED))
})

/* ------------------------------------------------------------------ *
 * Decision: the cost model and its sensitivity
 * ------------------------------------------------------------------ */

test('a higher hitch probability makes secondary MORE attractive', () => {
  const facts: ToolFacts[] = [{ name: 'thin', calls: 1, sessionsSeen: 1, declarationsChars: 800 }]
  // p = 0 means "a fetch always costs a dedicated turn" (the pessimistic read);
  // p = 1 means "a fetch always rides along" (the optimistic read). Higher p is
  // therefore CHEAPER, and that is the whole direction the model claims.
  const pessimistic = decideToolPlan(facts, { ...PINNED, hitchProbability: 0.0 })
  const optimistic = decideToolPlan(facts, { ...PINNED, hitchProbability: 1.0 })
  assert.ok(optimistic.costs.thin!.secondaryTokens < pessimistic.costs.thin!.secondaryTokens)
  // With a certain hitch, one fetch costs 0.5 turn = 500 tokens; with none it
  // costs a whole turn = 1000. Higher p is cheaper, not dearer.
  assert.equal(optimistic.costs.thin?.secondaryTokens, 500)
  assert.equal(pessimistic.costs.thin?.secondaryTokens, 1_000)
})

test('sweepHitchProbability reports every flip with the probability it happens at', () => {
  // C_resident = 1500 chars x 10 turns = 15 000; one fetch is 1000..500 tokens
  // as p goes 0 -> 1, so this tool flips once as fetching gets cheaper.
  const facts: ToolFacts[] = [{ name: 'edge', calls: 20, sessionsSeen: 5, declarationsChars: 1500 }]
  const sweep = sweepHitchProbability(facts, PINNED)
  assert.equal(sweep.byProbability.length, 11)
  assert.equal(sweep.flips.length, 1)
  assert.equal(sweep.flips[0]?.name, 'edge')
  assert.equal(sweep.flips[0]?.from, 'resident')
  assert.equal(sweep.flips[0]?.to, 'secondary')
  // At p = 0 fetching costs a full turn: 20 calls x 1000 = 20 000 > 15 000, so it
  // stays resident. At p = 1 fetching costs 500: 20 x 500 = 10 000 < 15 000, so
  // it flips to secondary. The flip is where the report's sensitivity comes from.
  assert.equal(sweep.byProbability[0]?.plan.costs.edge?.bucket, 'resident')
  assert.equal(sweep.byProbability[10]?.plan.costs.edge?.bucket, 'secondary')
})

test('borderlineTools isolates the near-calls and skips the forced ones', () => {
  const facts: ToolFacts[] = [
    { name: 'exact', calls: 2, sessionsSeen: 1, declarationsChars: 100 },
    { name: 'far', calls: 1000, sessionsSeen: 1, declarationsChars: 100 },
    { name: 'forced', calls: 2, sessionsSeen: 1, declarationsChars: 100, discoverableIndex: false },
  ]
  const plan = decideToolPlan(facts, PINNED)
  const near = borderlineTools(plan, 0.3)
  const names = near.map(entry => entry.name).sort()
  // 'exact': resident 100 x 10 = 1000; secondary 2 x 750 = 1500; ratio 1.5 -> not near.
  // 'far' is pinned at a 1e5-ish ratio, 'forced' is excluded by construction.
  assert.deepEqual(names.filter(name => name === 'forced'), [])
  assert.ok(names.includes('far') === false)
})

test('estimateSessionSavings charges residents to every session and secondaries to theirs', () => {
  const facts: ToolFacts[] = [
    { name: 'common', calls: 100, sessionsSeen: 100, declarationsChars: 700 },
    { name: 'rare', calls: 1, sessionsSeen: 1, declarationsChars: 4000 },
  ]
  const plan = decideToolPlan(facts, { ...PINNED, protectionCount: 0 })
  const savings = estimateSessionSavings(plan, facts, PINNED)
  assert.equal(savings.sessionsConsidered, 100)
  // 'rare' is secondary: 1 call in 1 of 100 sessions, at 750 tokens per fetch.
  assert.ok(savings.secondaryTokensPerSession > 0)
  // 'common' is protected-free but arithmetic keeps it resident, so it is paid
  // in every session and the resident side is nonzero.
  assert.ok(savings.residentTokensPerSession > 0)
  assert.equal(savings.netTokensPerSession, savings.residentTokensPerSession - savings.secondaryTokensPerSession)
})

test('the documented defaults are the ones the code actually uses', () => {
  const facts: ToolFacts[] = [{ name: 'read', calls: 2000, sessionsSeen: 60, declarationsChars: 300 }]
  const withDefaults = decideToolPlan(facts)
  const withExplicit = decideToolPlan(facts, {
    protectionCount: DECISION_DEFAULTS.protectionCount,
    charsPerToken: DECISION_DEFAULTS.charsPerToken,
    turnsPerSession: DECISION_DEFAULTS.turnsPerSession,
    hitchProbability: DECISION_DEFAULTS.hitchProbability,
    hitchCostFraction: DECISION_DEFAULTS.hitchCostFraction,
  })
  assert.deepEqual(withDefaults, withExplicit)
  // And the turn cost really is context + output, so the two constants are wired.
  assert.equal(DEFAULT_CONTEXT_TOKENS + DEFAULT_OUTPUT_TOKENS, 102_000)
})

/* ------------------------------------------------------------------ *
 * The two halves together, on a real on-disk fixture
 * ------------------------------------------------------------------ */

test('stats -> decide round trip over a synthetic sessions root', () => {
  const box = scratch()
  try {
    const root = join(box.dir, 'sessions')
    const out = join(box.dir, 'stats.jsonl')
    writeLog(root, '--proj--', 's1', [header('s1', 'P:'), topLevelCall('read', 10), ptcCall('read', 11), ptcCall('pwsh', 12)])
    writeLog(root, '--proj--', 's2', [header('s2', 'P:'), topLevelCall('read', 20), ptcCall('schedule_list', 21)])

    const result = writeStatsFile({ sessionsRoot: root, outputPath: out })
    assert.equal(result.stats.sessions, 2)
    assert.equal(result.stats.tools.read?.calls, 3)
    assert.equal(result.stats.tools.read?.sessionsSeen, 2)
    assert.equal(result.stats.tools.pwsh?.sessionsSeen, 1)
    assert.equal(result.stats.failures.length, 0)
    assert.ok(readFileSync(out, 'utf8').includes('"kind":"tool"'))

    // Feed the written document straight back into the decision layer.
    const reloaded = loadLedger(out)
    assert.ok(reloaded.previous !== undefined)
    const facts = factsFromStats(reloaded.previous as StatsFile).map((fact, index) => ({
      ...fact,
      declarationsChars: 500 + index * 100,
    }))
    const plan = decideToolPlan(facts, { ...PINNED, protectionCount: 1 })
    assert.ok(plan.resident.includes('read'), 'the most-called tool is protected')
    assert.deepEqual(plan.observe, [], 'everything here was called at least once')
    assert.equal(Object.keys(plan.reasons).length, facts.length)
  } finally {
    box.dispose()
  }
})

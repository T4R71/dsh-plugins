/**
 * Tests for the two things this revision is about: a line that names its session,
 * and a settings lookup that cannot fail silently.
 *
 * Both are stated as the requirement rather than as the implementation, so the
 * tests keep their meaning if the code moves:
 *
 *   1. every line the plugin appends to the three observation artifacts — and to
 *      the ":rules" companion — carries the session the assembly belonged to, and
 *      a session that went away is recorded as null rather than omitted, so
 *      "no subject" stays distinguishable from "line written before the field
 *      existed";
 *   2. the directory lookup reports WHY it has no directory, in a sentence that
 *      names what is missing, for each of the four ways it can fail — and the
 *      plugin turns the worst of them ("no directory AND no absolute path") into
 *      an error at mount plus an error on every refused load, instead of a
 *      cleared pin that nothing mentions.
 *
 * The second group is the regression test for the defect this replaces: the
 * previous lookup read a member the host does not have, answered undefined with
 * nothing logged, and rewrite mode then ran with no rules in force while every
 * observation line still said "rewrite".
 *
 * The wiring group drives a REAL cordis Context and the REAL plugin through the
 * real waterfall, and counts ordinals the way a reader does — by parsing the
 * artifact files — rather than by trusting an in-memory counter.
 *
 * @module @t4r71/dsh-prompt-plan/tests
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Logger } from '@deepseek-ai/cordis'
import PromptPlan from '../src/index.ts'
import { settingsDirectoryOf } from '../src/config.ts'
import { SESSION_ID_FIELD } from '../src/observe.ts'
import { describeUnresolvedRulePath, ruleFilePath } from '../src/rules.ts'

/** A fresh directory for one test. */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'prompt-plan-wire-'))
}

/** Write a file and return its path. */
function write(path: string, text: string): string {
  writeFileSync(path, text)
  return path
}

/** One rule document that strips a declaration, so rewrite mode has work to do. */
const RULE_FILE = [
  'version: 1',
  'rules:',
  '  - id: strip',
  '    match:',
  '      kind: exact',
  '      value: tools:sdk',
  '    action:',
  '      kind: transform',
  '      transform:',
  '        - op: stripToolDecls',
  '          names:',
  '            - schedule_create',
  '          dryRun: false',
].join('\n') + '\n'

/** The artifact file names, read here rather than imported so a rename fails this test. */
const SECTIONS = 'sections.jsonl'
const SECTIONS_TEXT = 'sections-text.jsonl'
const PURITY = 'purity.jsonl'

/** Parse a JSONL artifact, skipping any blank tail line. */
function linesOf(directory: string, name: string): Record<string, unknown>[] {
  const text = readFileSync(join(directory, name), 'utf8')
  return text.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
}

/** Capture the host log lines a plugin writes, through cordis's own exporter API. */
function captureLines(): { lines: string[]; exporter: { export: (message: unknown) => void } } {
  const lines: string[] = []
  const exporter = {
    // ERROR is 0 and INFO is 1, so the default exporter level would DROP the error
    // lines this file asserts on. 3 takes everything.
    levels: { default: 3 },
    export(message: unknown): void {
      lines.push(Logger.format(exporter as never, message as never))
    },
  }
  return { lines, exporter }
}

/** Wait until a captured line matches, or fail with the lines that did arrive. */
async function waitForLine(lines: readonly string[], pattern: RegExp, label: string): Promise<void> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (lines.some(line => pattern.test(line))) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(label + ': no line matched ' + String(pattern) + '; captured: ' + JSON.stringify(lines, null, 1))
}

/** Wait until the observer's queue has drained, by polling for the line count. */
async function waitForLines(directory: string, name: string, count: number, label: string): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + 8000
  let last: Record<string, unknown>[] = []
  while (Date.now() < deadline) {
    try {
      last = linesOf(directory, name)
      if (last.length >= count) return last
    } catch {
      // the file does not exist yet
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(label + ': wanted ' + String(count) + ' lines, have ' + String(last.length))
}

/**
 * Create a session and wait until its pin is INSTALLED, then assemble.
 *
 * The pin is loaded asynchronously off `session/created`, so an assembly that
 * runs immediately after the emit can outrun it and see an empty pin — which is
 * a real ordering fact of the plugin, not a test artefact, and the "loaded ...
 * for session" line is the plugin's own statement that the pin is in place.
 * @param ctx - the mounted plugin's context.
 * @param lines - the captured host log.
 * @param id - the session id.
 * @returns the agent object for the waterfall.
 */
async function session(ctx: Context, lines: readonly string[], id: string): Promise<{ session: { id: string } }> {
  const agent = { session: { id } }
  ctx.emit('session/created', agent.session as never)
  await waitForLine(lines, new RegExp('for session "' + id + '"'), 'the pin for ' + id)
  return agent
}

/** Drive the real waterfall once for one agent. */
async function assemble(ctx: Context, agent: unknown): Promise<void> {
  const assembly = {
    sections: [{ name: 'persona', text: 'x' }, { name: 'tools:sdk', text: 'interface ToolArgsMap {}' }],
    contexts: [],
    tools: [],
    variables: {},
  }
  await ctx.waterfall('system-prompt/assemble', assembly, { agent, scope: agent }, async () => assembly)
}

// -----------------------------------------------------------------------------
// The lookup reports its own failure
// -----------------------------------------------------------------------------

test('a settings service that reports a directory is read as one', () => {
  const lookup = settingsDirectoryOf({ describe: () => [{ ns: 'prompt-plan', directory: '/the/profile' }] }, 'prompt-plan')
  assert.deepEqual(lookup, { ok: true, directory: '/the/profile' })
})

test('a service with no directory member is reported as missing exactly that member', () => {
  // The host's REAL descriptor shape, transcribed from dsh-settings 0.2.0-rc.2:
  // there is no "directory" member, which is the defect this replaces.
  const descriptor = { autoGenerate: true, ns: 'prompt-plan', schema: {}, revision: 3, applies: [], value: {}, base: {}, user: {} }
  const lookup = settingsDirectoryOf({ describe: () => [descriptor] }, 'prompt-plan')
  assert.equal(lookup.ok, false)
  if (lookup.ok) throw new Error('unreachable')
  assert.match(lookup.problem, /carries no "directory" member/)
  // The sentence names what IS there, so a reader can see the field moved rather
  // than guess: the member list is the host's own.
  for (const member of ['autoGenerate', 'applies', 'revision', 'value']) {
    assert.ok(lookup.problem.includes(member), 'the member list names ' + member)
  }
})

test('each of the other three failures reports its own cause, and none of them says "missing member"', () => {
  const absent = settingsDirectoryOf(undefined, 'prompt-plan')
  assert.equal(absent.ok, false)
  if (absent.ok) throw new Error('unreachable')
  assert.match(absent.problem, /settings service is not mounted/)

  const wrongNs = settingsDirectoryOf({ describe: () => [{ ns: 'other', directory: '/x' }] }, 'prompt-plan')
  assert.equal(wrongNs.ok, false)
  if (wrongNs.ok) throw new Error('unreachable')
  assert.match(wrongNs.problem, /no entry with ns "prompt-plan"/)

  const refusing = settingsDirectoryOf({ describe: () => { throw new Error('the service said no') } }, 'prompt-plan')
  assert.equal(refusing.ok, false)
  if (refusing.ok) throw new Error('unreachable')
  assert.match(refusing.problem, /refused describe\(\)/)
  assert.match(refusing.problem, /the service said no/)

  const empty = settingsDirectoryOf({ describe: () => [{ ns: 'prompt-plan', directory: '' }] }, 'prompt-plan')
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error('unreachable')
  assert.match(empty.problem, /EMPTY "directory" member/)
})

test('the configuration-gap sentence names what is missing, what follows, and what to do', () => {
  const line = describeUnresolvedRulePath('the settings service entry for ns "prompt-plan" carries no "directory" member')
  assert.match(line, /CONFIGURATION MISSING/)
  assert.match(line, /what is missing: the settings service entry/)
  assert.match(line, /config\.rulesFile is empty/)
  assert.match(line, /returned UNCHANGED/)
  assert.match(line, /fix: set config\.rulesFile to an absolute path/)
})

test('the loader separates "nothing was looked for" from "the file was not there"', () => {
  // Nothing configured on either base: this is the state that used to clear the pin
  // in silence. The kind is what lets the caller word its line, so it is asserted.
  const unconfigured = ruleFilePath({ rulesFile: '', settingsDirectory: undefined })
  assert.equal(unconfigured, undefined, 'an empty rulesFile with no directory resolves to nothing')
})

// -----------------------------------------------------------------------------
// The wiring: every line names its session
// -----------------------------------------------------------------------------

test('every artifact line carries the session, and a sessionless assembly carries null', async () => {
  const dir = tempDir()
  const rules = write(join(dir, 'prompt-plan.rules.yaml'), RULE_FILE)
  const artifacts = join(dir, 'artifacts')

  const ctx = new Context()
  const { lines, exporter } = captureLines()
  ctx.logger.exporter(exporter as never)
  new PromptPlan(ctx as never, { mode: 'rewrite', rulesFile: rules, artifactDir: artifacts, observe: true, fullText: true })

  const agentA = await session(ctx, lines, 'session-A')
  await assemble(ctx, agentA)
  const agentB = await session(ctx, lines, 'session-B')
  await assemble(ctx, agentB)

  // Each assembly writes its own line PLUS a ":rules" companion into the SAME
  // file, so the wait is for four lines and the split is by mode, not by position.
  const all = await waitForLines(artifacts, SECTIONS, 4, 'two assemblies and their companions')
  const purity = await waitForLines(artifacts, PURITY, 2, 'two purity lines')
  const text = await waitForLines(artifacts, SECTIONS_TEXT, 2, 'two full-text lines')

  const isCompanion = (record: Record<string, unknown>): boolean => String(record.mode).endsWith(':rules')
  const sections = all.filter(record => !isCompanion(record))
  const companion = all.filter(isCompanion)

  assert.deepEqual(sections.map(record => record[SESSION_ID_FIELD]), ['session-A', 'session-B'], 'each assembly names its own session')
  assert.deepEqual(purity.map(record => record[SESSION_ID_FIELD]), ['session-A', 'session-B'], 'and so does its purity line')
  assert.deepEqual(text.map(record => record[SESSION_ID_FIELD]), ['session-A', 'session-B'], 'and so does its full-text line')

  // The COMPANION line, which the rule trace writes under its own mode suffix.
  assert.equal(companion.length, 2, 'each assembly with rules in force writes one companion line')
  assert.deepEqual(companion.map(record => record[SESSION_ID_FIELD]), ['session-A', 'session-B'], 'the companion names the session too')
  assert.deepEqual(
    companion.map(record => record.ordinal),
    sections.map(record => record.ordinal),
    'and shares its ordinal with the assembly it belongs to',
  )
})

test('a sessionless assembly records null, which is not the same as an absent member', async () => {
  const dir = tempDir()
  const rules = write(join(dir, 'prompt-plan.rules.yaml'), RULE_FILE)
  const artifacts = join(dir, 'artifacts')

  const ctx = new Context()
  const { exporter } = captureLines()
  ctx.logger.exporter(exporter as never)
  new PromptPlan(ctx as never, { mode: 'rewrite', rulesFile: rules, artifactDir: artifacts, observe: true })

  // No session/created, and a context with no subject at all: the field is still
  // WRITTEN, as null. Omission would be indistinguishable from an older line.
  await assemble(ctx, {})

  const sections = await waitForLines(artifacts, SECTIONS, 1, 'one assembly')
  assert.ok(SESSION_ID_FIELD in sections[0]!, 'the member is present even with no subject')
  assert.equal(sections[0]![SESSION_ID_FIELD], null)
})

test('the ordinal stays ONE counter across sessions, so it still identifies one assembly', async () => {
  const dir = tempDir()
  const rules = write(join(dir, 'prompt-plan.rules.yaml'), RULE_FILE)
  const artifacts = join(dir, 'artifacts')

  const ctx = new Context()
  const { lines, exporter } = captureLines()
  ctx.logger.exporter(exporter as never)
  new PromptPlan(ctx as never, { mode: 'rewrite', rulesFile: rules, artifactDir: artifacts, observe: true })

  const agentA = await session(ctx, lines, 'session-A')
  await assemble(ctx, agentA)
  const agentB = await session(ctx, lines, 'session-B')
  await assemble(ctx, agentB)
  await assemble(ctx, agentA)

  const sections = (await waitForLines(artifacts, SECTIONS, 3, 'three assemblies'))
    .filter(record => !String(record.mode).endsWith(':rules'))
  // Interleaved subjects, one unbroken counter: 0, 1, 2 — with A owning 0 and 2.
  assert.deepEqual(sections.map(record => record.ordinal), [0, 1, 2], 'the counter never restarts for a new session')
  assert.deepEqual(sections.map(record => record[SESSION_ID_FIELD]), ['session-A', 'session-B', 'session-A'], 'and the session is what tells them apart')
})

// -----------------------------------------------------------------------------
// The wiring: the gap is reported, and the pin is not cleared in silence
// -----------------------------------------------------------------------------

test('with no readable directory and no absolute path, mount says CONFIGURATION MISSING', async () => {
  const ctx = new Context()
  const { lines, exporter } = captureLines()
  ctx.logger.exporter(exporter as never)
  // A settings service that reports the host's real descriptor shape — no
  // "directory" — and no absolute rulesFile: the exact old silent state.
  ctx.provide('settings' as never, { describe: () => [{ ns: 'prompt-plan' }] } as never)
  new PromptPlan(ctx as never, { mode: 'rewrite', rulesFile: '', artifactDir: '', observe: true })

  await waitForLine(lines, /CONFIGURATION MISSING/, 'the mount-time gap report')
  const reported = lines.find(line => line.includes('CONFIGURATION MISSING')) ?? ''
  assert.match(reported, /carries no "directory" member/, 'and it names the member that is missing')
  assert.match(reported, /fix: set config\.rulesFile to an absolute path/, 'and what to do about it')
})

test('with no absolute path, an assembly reports the gap and is returned UNCHANGED', async () => {
  const dir = tempDir()
  const artifacts = join(dir, 'artifacts')

  const ctx = new Context()
  const { lines, exporter } = captureLines()
  ctx.logger.exporter(exporter as never)
  ctx.provide('settings' as never, { describe: () => [{ ns: 'prompt-plan' }] } as never)
  new PromptPlan(ctx as never, { mode: 'rewrite', rulesFile: '', artifactDir: artifacts, observe: true })

  // No pin can install — there is no readable rule file — so the wait is for the
  // LOAD attempt, which is what proves the assembly is not running early.
  const agent = { session: { id: 'session-A' } }
  ctx.emit('session/created', agent.session as never)
  await waitForLine(lines, /rewrite mode cannot read a rule file: CONFIGURATION MISSING/, 'the load-time gap report')
  await assemble(ctx, agent)
  // The degradation is still a degradation — the text is untouched — but it is no
  // longer SILENT, and no ":rules" line is written because no rules ran.
  const sections = await waitForLines(artifacts, SECTIONS, 1, 'one assembly')
  assert.ok(sections.every(record => !String(record.mode).endsWith(':rules')), 'no rule trace line, because no rule set was in force')
})

test('an absolute rulesFile still bypasses the lookup, and the gap is NOT reported', async () => {
  const dir = tempDir()
  const rules = write(join(dir, 'prompt-plan.rules.yaml'), RULE_FILE)
  const artifacts = join(dir, 'artifacts')

  const ctx = new Context()
  const { lines, exporter } = captureLines()
  ctx.logger.exporter(exporter as never)
  ctx.provide('settings' as never, { describe: () => [{ ns: 'prompt-plan' }] } as never)
  new PromptPlan(ctx as never, { mode: 'rewrite', rulesFile: rules, artifactDir: artifacts, observe: true })

  await waitForLine(lines, /prompt-plan: mounted;/, 'the mount line')
  assert.ok(!lines.some(line => line.includes('CONFIGURATION MISSING')), 'an absolute path is not a configuration gap')

  await session(ctx, lines, 'session-A')
  await assemble(ctx, { session: { id: 'session-A' } })
  const sections = await waitForLines(artifacts, SECTIONS, 2, 'the assembly and its companion')
  assert.ok(sections.some(record => String(record.mode).endsWith(':rules')), 'the rules DID run, so the trace line is there')
})

test('a genuinely missing rule file is still reported as missing, not as a configuration gap', async () => {
  const dir = tempDir()
  const artifacts = join(dir, 'artifacts')

  const ctx = new Context()
  const { lines, exporter } = captureLines()
  ctx.logger.exporter(exporter as never)
  new PromptPlan(ctx as never, { mode: 'rewrite', rulesFile: join(dir, 'absent.rules.yaml'), artifactDir: artifacts, observe: true })

  // No pin will install — the file is absent — so the wait is for the LOAD
  // attempt, which is what proves the assembly is not running early.
  const agent = { session: { id: 'session-A' } }
  ctx.emit('session/created', agent.session as never)
  await waitForLine(lines, /no rule file at .*absent\.rules\.yaml/, 'the missing-file report')
  await assemble(ctx, agent)

  await waitForLine(lines, /no rule file at .*absent\.rules\.yaml/, 'the missing-file warning')
  assert.ok(!lines.some(line => line.includes('CONFIGURATION MISSING')), 'a path WAS configured, so this is not the gap')
})

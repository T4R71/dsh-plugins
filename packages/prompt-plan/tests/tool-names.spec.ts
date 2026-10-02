/**
 * Tests for the dynamic tool-name seam — the list file, the fold, the pin.
 *
 * The claims here are the ones the wiring stands on, and each is stated as the
 * test rather than assumed:
 *
 *   1. the file format accepts exactly what the module documents and refuses
 *      everything else, with ZERO dynamic names as the fallback in every case;
 *   2. the fold can only ADD to a rule's own names, so an op that does not opt in
 *      is the very object it was before this module existed;
 *   3. two pins never share an op object, so one session cannot observe another's
 *      list through a shared mutable op;
 *   4. the mount-time pin and the per-session pin both happen, both log the
 *      effective names and their sources, and a session KEEPS what it was given
 *      after another session is created against a different file;
 *   5. the last one is the hard requirement: the prompt of a running session may
 *      not move when an unrelated session starts, because that is a prefix-cache
 *      break.
 *
 * The last group drives a REAL cordis Context and the REAL plugin class through
 * the real seam (ctx.waterfall('system-prompt/assemble', ...)), so it is the wiring
 * that is under test and not a mock of it. Log lines are captured through cordis's
 * own exporter API (ctx.logger.exporter), which is also what makes the "every load
 * prints the effective names and their source" requirement checkable.
 *
 * @module @t4r71/dsh-prompt-plan/tests
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context, Logger } from '@deepseek-ai/cordis'
import PromptPlan from '../src/index.ts'
import { validateRuleSet } from '../src/rules.ts'
import { compileRules } from '../src/rewrite.ts'
import type { CompiledRule } from '../src/rewrite.ts'
import {
  applyToolNames,
  describeToolNamesPin,
  loadToolNames,
  mergeToolNames,
  sessionKeyOf,
  toolNamesFilePath,
  toolNamesPathsOf,
  toolNamesSource,
  validateToolNames,
} from '../src/tool-names.ts'
import type { ToolNamesSource } from '../src/tool-names.ts'

/** A fresh directory for one test. */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'prompt-plan-names-'))
}

/** Write a file and return its path. */
function write(path: string, text: string): string {
  writeFileSync(path, text)
  return path
}

/** A hash stand-in: these tests do not care that it is not sha256. */
const fakeHash = (text: string): string => 'hash-' + String(text.length)

/** The documented file, as a producer writes it. */
const NAMES_FILE = [
  'version: 1',
  'note: written by the decision layer',
  'names:',
  '  - web_search',
  '  - schedule_list',
].join('\n') + '\n'

/** One rule document with a stripToolDecls op. */
function ruleDocument(options: {
  names?: readonly string[]
  namesFrom?: string
  dryRun?: boolean
}): unknown {
  const op: Record<string, unknown> = { op: 'stripToolDecls', dryRun: options.dryRun ?? false }
  if (options.names !== undefined) op.names = [...options.names]
  if (options.namesFrom !== undefined) op.namesFrom = options.namesFrom
  return {
    version: 1,
    rules: [{
      id: 'lazy',
      match: { kind: 'exact', value: 'tools:sdk' },
      action: { kind: 'transform', transform: [op] },
    }],
  }
}

/** A rule document whose op carries an explicit namesFrom and no static names. */
function namesFromOnlyDocument(namesFrom: string): unknown {
  return {
    version: 1,
    rules: [{
      id: 'lazy',
      match: { kind: 'exact', value: 'tools:sdk' },
      action: { kind: 'transform', transform: [{ op: 'stripToolDecls', namesFrom, dryRun: false }] },
    }],
  }
}

/** Compile one rule document through the real validator and compiler. */
function compile(document: unknown): CompiledRule[] {
  const ruleSet = validateRuleSet(document, 'test.rules.yaml')
  const compiled = compileRules(ruleSet.rules)
  assert.equal(compiled.ok, true)
  if (!compiled.ok) throw new Error('unreachable')
  return compiled.rules
}

/** The op of a compiled rule, when it is the strip op these tests build. */
function stripOp(rule: CompiledRule | undefined): { names: readonly string[]; namesFrom?: string } | undefined {
  const ops = rule?.action.kind === 'transform' ? rule.action.transform ?? [] : []
  const op = ops[0]
  if (op === undefined || op.op !== 'stripToolDecls') return undefined
  return op.namesFrom === undefined ? { names: op.names } : { names: op.names, namesFrom: op.namesFrom }
}

/** The tools:sdk rendering, in the renderer's own shape. */
function sdkText(tools: readonly string[]): string {
  return [
    'Use the SDK bindings below.',
    '',
    'interface ToolArgsMap {',
    ...tools.map(tool => '  /** ' + tool + ' does a thing. */\n  ' + tool + ': { a: string };'),
    '}',
    '',
    'interface ToolOutputMap {',
    ...tools.map(tool => '  ' + tool + ': { b: string };'),
    '}',
  ].join('\n')
}

/**
 * The member names a tools:sdk text still declares.
 *
 * De-duplicated: every tool has one member in EACH map, so the raw match list
 * carries each survivor twice, and the assertions below are about WHICH tools
 * survived rather than about how many times each is spelled.
 */
function members(text: string): string[] {
  return [...new Set([...text.matchAll(/^  ([A-Za-z_$][\w$]*): /gm)].map(match => match[1] ?? ''))]
}

/** One write of the names file, in the documented format. */
function namesFile(names: readonly string[]): string {
  return ['version: 1', 'names:', ...names.map(name => '  - ' + name)].join('\n') + '\n'
}

/** A rule file whose strip op names one static tool plus a names file. */
function ruleFile(names: readonly string[], namesFrom: string): string {
  return [
    'version: 1',
    'rules:',
    '  - id: lazy',
    '    match:',
    '      kind: exact',
    '      value: tools:sdk',
    '    action:',
    '      kind: transform',
    '      transform:',
    '        - op: stripToolDecls',
    // With no static names the KEY IS OMITTED rather than left empty: an empty
    // "names:" would parse as null and be refused, which is the validator doing
    // its job — an op that names nothing at all is not a rule.
    ...names.length === 0 ? [] : ['          names:', ...names.map(name => '            - ' + name)],
    '          namesFrom: ' + namesFrom,
    '          dryRun: false',
  ].join('\n') + '\n'
}

// -----------------------------------------------------------------------------
// The file format
// -----------------------------------------------------------------------------

test('the names file accepts the documented format', () => {
  const file = validateToolNames({
    version: 1,
    names: ['web_search', 'schedule_list'],
    note: 'produced by the decision layer',
  }, 'names.yaml')
  assert.deepEqual(file.names, ['web_search', 'schedule_list'])
  assert.equal(file.note, 'produced by the decision layer')
  assert.equal(file.version, 1)
})

test('an empty list is a valid file and means "nothing is added"', () => {
  const file = validateToolNames({ version: 1, names: [] }, 'names.yaml')
  assert.deepEqual(file.names, [])
})

test('a duplicate name is folded, and surrounding space is trimmed', () => {
  const file = validateToolNames({ version: 1, names: [' web_search', 'web_search', 'read'] }, 'names.yaml')
  assert.deepEqual(file.names, ['web_search', 'read'])
})

test('an unknown top-level key is ignored, because the producer owns the file', () => {
  const file = validateToolNames({
    version: 1,
    generatedAt: '2026-10-02T13:00:00+08:00',
    distribution: { web_search: 3 },
    names: ['web_search'],
  }, 'names.yaml')
  assert.deepEqual(file.names, ['web_search'])
})

test('every malformed shape is refused, so the fallback stays the resident one', () => {
  const cases: [string, unknown][] = [
    ['not a mapping', ['web_search']],
    ['a wrong version', { version: 2, names: ['web_search'] }],
    ['a missing version', { names: ['web_search'] }],
    ['names as a scalar', { version: 1, names: 'web_search' }],
    ['names as a mapping', { version: 1, names: { a: 'web_search' } }],
    ['a non-string entry', { version: 1, names: ['web_search', 7] }],
    ['an empty entry', { version: 1, names: ['web_search', '  '] }],
    ['a non-string note', { version: 1, names: [], note: 12 }],
  ]
  for (const [label, document] of cases) {
    assert.throws(() => validateToolNames(document, 'names.yaml'), Error, label + ': refused')
  }
})

// -----------------------------------------------------------------------------
// Where the file is looked for
// -----------------------------------------------------------------------------

test('a namesFrom path resolves against the rule file, then the settings directory, then cwd', () => {
  const rules = resolve('/profile/prompt-plan.rules.yaml')
  assert.equal(toolNamesFilePath({ namesFrom: 'names.yaml', rulesFile: rules, settingsDirectory: '/settings' }), resolve('/profile/names.yaml'))
  assert.equal(toolNamesFilePath({ namesFrom: 'names.yaml', rulesFile: undefined, settingsDirectory: '/settings' }), resolve('/settings/names.yaml'))
  assert.equal(toolNamesFilePath({ namesFrom: 'names.yaml', rulesFile: undefined, settingsDirectory: undefined }), resolve(process.cwd(), 'names.yaml'))
  const absolute = resolve('/elsewhere/names.yaml')
  assert.equal(toolNamesFilePath({ namesFrom: absolute, rulesFile: rules, settingsDirectory: '/settings' }), absolute)
})

// -----------------------------------------------------------------------------
// Reading the file off the disk
// -----------------------------------------------------------------------------

test('a real file is read, hashed, and reported with its note', async () => {
  const dir = tempDir()
  const path = write(join(dir, 'names.yaml'), NAMES_FILE)
  const load = await loadToolNames({ namesFrom: 'names.yaml', rulesFile: join(dir, 'prompt-plan.rules.yaml'), settingsDirectory: undefined, hash: fakeHash })
  assert.equal(load.ok, true)
  if (!load.ok) return
  assert.deepEqual(load.file.names, ['web_search', 'schedule_list'])
  assert.equal(load.file.path, path)
  assert.equal(load.file.sha256, fakeHash(NAMES_FILE))
  assert.equal(load.file.note, 'written by the decision layer')
})

test('a missing file is its own outcome, and contributes no names', async () => {
  const dir = tempDir()
  const load = await loadToolNames({ namesFrom: 'absent.yaml', rulesFile: join(dir, 'rules.yaml'), settingsDirectory: undefined, hash: fakeHash })
  assert.equal(load.ok, false)
  if (load.ok) return
  assert.equal(load.problem, 'MISSING')
  assert.deepEqual(toolNamesSource('absent.yaml', load).names, [])
})

test('a malformed file contributes no names either, and says why', async () => {
  const dir = tempDir()
  write(join(dir, 'names.yaml'), '- just\n- a sequence\n')
  const load = await loadToolNames({ namesFrom: 'names.yaml', rulesFile: join(dir, 'rules.yaml'), settingsDirectory: undefined, hash: fakeHash })
  assert.equal(load.ok, false)
  if (load.ok) return
  assert.match(load.problem, /mapping/)
  assert.deepEqual(toolNamesSource('names.yaml', load).names, [])
})

test('an empty list is read as a success with zero names, not as a failure', async () => {
  const dir = tempDir()
  write(join(dir, 'names.yaml'), 'version: 1\nnames: []\n')
  const load = await loadToolNames({ namesFrom: 'names.yaml', rulesFile: join(dir, 'rules.yaml'), settingsDirectory: undefined, hash: fakeHash })
  assert.equal(load.ok, true)
  if (!load.ok) return
  assert.deepEqual(load.file.names, [])
})

// -----------------------------------------------------------------------------
// The fold: union, isolation, reporting
// -----------------------------------------------------------------------------

test('the effective names are the union, static first', () => {
  assert.deepEqual(mergeToolNames(['a', 'b'], ['b', 'c']), ['a', 'b', 'c'])
  assert.deepEqual(mergeToolNames(['a'], []), ['a'])
  assert.deepEqual(mergeToolNames([], ['a']), ['a'])
})

test('an op that does not opt in keeps its own object and its own names', () => {
  const rules = compile(ruleDocument({ names: ['schedule_create'] }))
  const application = applyToolNames(rules, [])
  assert.equal(application.rules[0], rules[0], 'the rule is returned by reference')
  assert.deepEqual(stripOp(application.rules[0])?.names, ['schedule_create'])
  assert.deepEqual(application.ops, [], 'nothing opted in')
  assert.deepEqual(application.staticNames, ['schedule_create'], 'but the static name is still reported')
  assert.equal(toolNamesPathsOf(rules).length, 0)
})

test('an op that opts in is rebuilt with the union of both lists', () => {
  const rules = compile(ruleDocument({ names: ['schedule_create', 'schedule_delete'], namesFrom: 'names.yaml' }))
  assert.deepEqual(toolNamesPathsOf(rules), ['names.yaml'])
  const source: ToolNamesSource = { namesFrom: 'names.yaml', path: '/p/names.yaml', names: ['web_search', 'schedule_delete'], sha256: 'abc' }
  const application = applyToolNames(rules, [source])
  assert.notEqual(application.rules[0]?.action.transform?.[0], rules[0]?.action.transform?.[0], 'a fresh op object')
  assert.deepEqual(stripOp(application.rules[0])?.names, ['schedule_create', 'schedule_delete', 'web_search'])
  assert.deepEqual(application.ops, [{
    ruleId: 'lazy',
    namesFrom: 'names.yaml',
    staticNames: ['schedule_create', 'schedule_delete'],
    dynamicNames: ['web_search', 'schedule_delete'],
    effective: ['schedule_create', 'schedule_delete', 'web_search'],
  }])
})

test('an op with namesFrom and no names of its own still works', () => {
  const rules = compile(namesFromOnlyDocument('names.yaml'))
  const application = applyToolNames(rules, [{ namesFrom: 'names.yaml', path: '/p/names.yaml', names: ['web_search'] }])
  assert.deepEqual(stripOp(application.rules[0])?.names, ['web_search'])
})

test('an unresolvable source contributes nothing, and the op keeps its static names', () => {
  const rules = compile(ruleDocument({ names: ['schedule_create'], namesFrom: 'names.yaml' }))
  const application = applyToolNames(rules, [{ namesFrom: 'names.yaml', path: '/p/names.yaml', names: [], problem: 'MISSING' }])
  assert.deepEqual(stripOp(application.rules[0])?.names, ['schedule_create'])
})

test('two folds never share the rebuilt op, so one session cannot move another', () => {
  const rules = compile(ruleDocument({ names: ['schedule_create'], namesFrom: 'names.yaml' }))
  const first = applyToolNames(rules, [{ namesFrom: 'names.yaml', path: '/p/names.yaml', names: ['web_search'] }])
  const second = applyToolNames(rules, [{ namesFrom: 'names.yaml', path: '/p/names.yaml', names: ['grep_tool'] }])
  assert.notEqual(first.rules[0]?.action.transform?.[0], second.rules[0]?.action.transform?.[0])
  assert.deepEqual(stripOp(first.rules[0])?.names, ['schedule_create', 'web_search'])
  assert.deepEqual(stripOp(second.rules[0])?.names, ['schedule_create', 'grep_tool'])
})

test('a rule file without namesFrom compiles exactly as it did before the seam existed', () => {
  const rules = compile(ruleDocument({ names: ['schedule_create', 'schedule_delete', 'schedule_list'] }))
  const application = applyToolNames(rules, [{ namesFrom: 'ignored.yaml', path: '/p/ignored.yaml', names: ['web_search'] }])
  assert.deepEqual(stripOp(application.rules[0])?.names, ['schedule_create', 'schedule_delete', 'schedule_list'])
})

// -----------------------------------------------------------------------------
// The rule file's own validation of namesFrom
// -----------------------------------------------------------------------------

test('namesFrom may stand alone, and an op that names nothing is still refused', () => {
  const op = stripOp(compile(namesFromOnlyDocument('names.yaml'))[0])
  assert.deepEqual(op?.names, [])
  assert.equal(op?.namesFrom, 'names.yaml')

  assert.throws(() => validateRuleSet(ruleDocument({}), 'test.rules.yaml'), /names/)
  assert.throws(() => validateRuleSet(ruleDocument({ namesFrom: '   ' }), 'test.rules.yaml'), /namesFrom/)
  assert.throws(() => validateRuleSet(ruleDocument({ names: ['a'], namesFrom: 7 }), 'test.rules.yaml'), /namesFrom/)
})

// -----------------------------------------------------------------------------
// The log line
// -----------------------------------------------------------------------------

test('every pin line carries the effective names and where each half came from', () => {
  const rules = compile(ruleDocument({ names: ['schedule_create'], namesFrom: 'names.yaml' }))
  const source: ToolNamesSource = { namesFrom: 'names.yaml', path: 'C:/p/names.yaml', names: ['web_search'], sha256: 'abcdef0123456789' }
  const application = applyToolNames(rules, [source])

  const success = describeToolNamesPin('mount', application, [source])
  assert.equal(success.length, 1)
  assert.equal(success[0]?.level, 'info')
  assert.match(success[0]?.message ?? '', /effective \[schedule_create, web_search\] \(2 name\(s\)\)/)
  assert.match(success[0]?.message ?? '', /static \[schedule_create\] \(1\) from the rule file/)
  assert.match(success[0]?.message ?? '', /C:\/p\/names\.yaml \(sha256 abcdef012345/)

  // A DEGRADED pin is a DIFFERENT application, not the same one with a different
  // source: the fold is what decides the effective names, so the log line is only
  // honest when the two are built together, exactly as the plugin builds them.
  const degraded = applyToolNames(rules, [{ namesFrom: 'names.yaml', path: 'C:/p/names.yaml', names: [], problem: 'MISSING' }])

  const missing = describeToolNamesPin('session s1', degraded, [{ namesFrom: 'names.yaml', path: 'C:/p/names.yaml', names: [], problem: 'MISSING' }])
  assert.equal(missing[0]?.level, 'warn')
  assert.match(missing[0]?.message ?? '', /MISSING/)
  assert.match(missing[0]?.message ?? '', /conservative fallback/)
  assert.match(missing[0]?.message ?? '', /effective \[schedule_create\]/)

  const malformedSource: ToolNamesSource = { namesFrom: 'names.yaml', path: 'C:/p/names.yaml', names: [], problem: 'line 3: "names" must be a sequence' }
  const malformed = describeToolNamesPin('session s1', applyToolNames(rules, [malformedSource]), [malformedSource])
  assert.equal(malformed[0]?.level, 'error')
  assert.match(malformed[0]?.message ?? '', /must be a sequence/)

  const unresolved = describeToolNamesPin('mount', degraded, [])
  assert.equal(unresolved[0]?.level, 'error')
  assert.match(unresolved[0]?.message ?? '', /could not resolve/)
})

test('a pin with no namesFrom says so, and still prints what is in force', () => {
  const application = applyToolNames(compile(ruleDocument({ names: ['schedule_create', 'schedule_list'] })), [])
  const lines = describeToolNamesPin('mount', application, [])
  assert.equal(lines.length, 1)
  assert.equal(lines[0]?.level, 'info')
  assert.match(lines[0]?.message ?? '', /no stripToolDecls op declares "namesFrom"/)
  assert.match(lines[0]?.message ?? '', /effective \[schedule_create, schedule_list\] \(2 name\(s\)\)/)
})

// -----------------------------------------------------------------------------
// The pin key
// -----------------------------------------------------------------------------

test('the assembly subject is read from the context without requiring any member', () => {
  assert.equal(sessionKeyOf({ agent: { session: { id: 's1' } }, scope: {} }), 's1')
  assert.equal(sessionKeyOf({ agent: { session: 's2' }, scope: {} }), 's2')
  assert.equal(sessionKeyOf({ agent: {}, scope: { session: { id: 's3' } } }), 's3')
  assert.equal(sessionKeyOf({ scope: { id: 's4' } }), 's4')
  assert.equal(sessionKeyOf({ agent: {}, scope: {} }), undefined)
  assert.equal(sessionKeyOf({}), undefined)
  assert.equal(sessionKeyOf(null), undefined)
  assert.equal(sessionKeyOf('a string'), undefined, 'a context that is not an object has no subject to key a pin by')
})

// -----------------------------------------------------------------------------
// The wiring, against a real cordis context and the real plugin
// -----------------------------------------------------------------------------

/** Capture the host log lines a plugin writes, through cordis's own exporter API. */
function captureLines(): { lines: string[]; exporter: { export: (message: unknown) => void } } {
  const lines: string[] = []
  const exporter = {
    // cordis's default exporter level is INFO (1), and its levels run the other
    // way round from the severity names (ERROR 0, INFO 1, WARN 2, DEBUG 3), so a
    // warn line is DROPPED unless the exporter asks for it. 3 takes everything:
    // the degraded-pin tests assert on a warn line, and a capture that silently
    // filtered it would make them pass for the wrong reason.
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

/** Drive the real waterfall once and return the tools:sdk text it produced. */
async function assemble(ctx: Context, agent: unknown, tools: readonly string[]): Promise<string> {
  const text = sdkText(tools)
  const assembly = {
    sections: [{ name: 'persona', text: 'x' }, { name: 'tools:sdk', text }],
    contexts: [],
    tools: [],
    variables: {},
  }
  const produced = await ctx.waterfall('system-prompt/assemble', assembly, { agent, scope: agent }, async () => assembly) as { sections: { name: string; text: string }[] }
  return produced.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
}

test('mount pins, session/created pins, and the assembly strips the union of both lists', async () => {
  const dir = tempDir()
  write(join(dir, 'names.yaml'), namesFile(['web_search']))
  const rules = write(join(dir, 'prompt-plan.rules.yaml'), ruleFile(['schedule_create'], 'names.yaml'))

  const ctx = new Context()
  const { lines, exporter } = captureLines()
  ctx.logger.exporter(exporter as never)
  new PromptPlan(ctx as never, { mode: 'rewrite', rulesFile: rules, artifactDir: join(dir, 'artifacts'), observe: false })
  await waitForLine(lines, /tool names for mount:.*effective \[schedule_create, web_search\]/, 'the mount pin')

  const agent = { session: { id: 'session-A' } }
  ctx.emit('session/created', agent.session as never)
  await waitForLine(lines, /tool names for session "session-A":.*effective \[schedule_create, web_search\]/, 'the session pin')

  const text = await assemble(ctx, agent, ['read', 'schedule_create', 'web_search', 'schedule_list'])
  // schedule_create is the rule's static name, web_search came from the file, and
  // schedule_list is named by NEITHER: the union strips exactly the first two and
  // leaves the third alone, which is the whole of the compatibility claim.
  assert.deepEqual(members(text), ['read', 'schedule_list'], 'exactly the union is stripped, and nothing else')
  assert.ok(lines.some(line => /stripToolDecls \[lazy\]: removed; 2 tool\(s\)/.test(line)), 'and the op reports what it removed')
})

test('a session KEEPS the list it was created with, even after another session starts against a different file', async () => {
  const dir = tempDir()
  const names = join(dir, 'names.yaml')
  write(names, namesFile(['web_search']))
  const rules = write(join(dir, 'prompt-plan.rules.yaml'), ruleFile(['schedule_create'], 'names.yaml'))

  const ctx = new Context()
  const { lines, exporter } = captureLines()
  ctx.logger.exporter(exporter as never)
  new PromptPlan(ctx as never, { mode: 'rewrite', rulesFile: rules, artifactDir: join(dir, 'artifacts'), observe: false })
  await waitForLine(lines, /tool names for mount:/, 'the mount pin')

  const agentA = { session: { id: 'session-A' } }
  ctx.emit('session/created', agentA.session as never)
  await waitForLine(lines, /tool names for session "session-A":.*dynamic \[web_search\]/, 'pin A')

  // The decision layer rewrites the list, and a SECOND session is created.
  write(names, namesFile(['grep_tool']))
  const agentB = { session: { id: 'session-B' } }
  ctx.emit('session/created', agentB.session as never)
  await waitForLine(lines, /tool names for session "session-B":.*dynamic \[grep_tool\]/, 'pin B')

  const textA = await assemble(ctx, agentA, ['read', 'schedule_create', 'web_search', 'grep_tool'])
  assert.deepEqual(members(textA), ['read', 'grep_tool'], 'session A still strips what ITS list named, and not what B was given')

  const textB = await assemble(ctx, agentB, ['read', 'schedule_create', 'web_search', 'grep_tool'])
  assert.deepEqual(members(textB), ['read', 'web_search'], 'and session B strips what its own list named')
})

test('a missing names file degrades to the static names, and says so', async () => {
  const dir = tempDir()
  const rules = write(join(dir, 'prompt-plan.rules.yaml'), ruleFile(['schedule_create', 'schedule_delete'], 'absent.yaml'))

  const ctx = new Context()
  const { lines, exporter } = captureLines()
  ctx.logger.exporter(exporter as never)
  new PromptPlan(ctx as never, { mode: 'rewrite', rulesFile: rules, artifactDir: join(dir, 'artifacts'), observe: false })
  await waitForLine(lines, /tool names for mount:.*MISSING/, 'the degraded mount pin')

  const agent = { session: { id: 'session-A' } }
  ctx.emit('session/created', agent.session as never)
  await waitForLine(lines, /tool names for session "session-A":.*MISSING/, 'the degraded session pin')

  // The backward-compatibility claim, measured: the schedule_* strip still happens.
  const text = await assemble(ctx, agent, ['read', 'schedule_create', 'schedule_delete', 'web_search'])
  assert.deepEqual(members(text), ['read', 'web_search'], 'only the static names are stripped, and nothing extra')
})

test('a name that this assembly does not declare is reported, never fatal', async () => {
  const dir = tempDir()
  write(join(dir, 'names.yaml'), namesFile(['web_search', 'ghost_tool']))
  const rules = write(join(dir, 'prompt-plan.rules.yaml'), ruleFile([], 'names.yaml'))

  const ctx = new Context()
  const { lines, exporter } = captureLines()
  ctx.logger.exporter(exporter as never)
  new PromptPlan(ctx as never, { mode: 'rewrite', rulesFile: rules, artifactDir: join(dir, 'artifacts'), observe: false })
  await waitForLine(lines, /tool names for mount:/, 'the mount pin')
  const agent = { session: { id: 'session-A' } }
  ctx.emit('session/created', agent.session as never)
  await waitForLine(lines, /tool names for session "session-A"/, 'the session pin')

  const text = await assemble(ctx, agent, ['read', 'web_search'])
  assert.deepEqual(members(text), ['read'], 'the declared name is stripped')
  assert.ok(
    lines.some(line => /NOT DECLARED HERE \(requested, absent from this assembly\): ghost_tool/.test(line)),
    'the request that matched nothing is on the operator line',
  )
})

test('the rule file is re-read per session, and a rule change reaches only the NEXT session', async () => {
  const dir = tempDir()
  write(join(dir, 'names.yaml'), namesFile(['web_search']))
  const rules = join(dir, 'prompt-plan.rules.yaml')
  write(rules, ruleFile(['schedule_create'], 'names.yaml'))

  const ctx = new Context()
  const { lines, exporter } = captureLines()
  ctx.logger.exporter(exporter as never)
  new PromptPlan(ctx as never, { mode: 'rewrite', rulesFile: rules, artifactDir: join(dir, 'artifacts'), observe: false })
  await waitForLine(lines, /tool names for mount:.*effective \[schedule_create, web_search\]/, 'the mount pin')

  const agentA = { session: { id: 'session-A' } }
  ctx.emit('session/created', agentA.session as never)
  await waitForLine(lines, /loaded 1 rule\(s\).*for session "session-A"/, 'pin A')

  write(rules, ruleFile(['schedule_delete'], 'names.yaml'))
  const agentB = { session: { id: 'session-B' } }
  ctx.emit('session/created', agentB.session as never)
  await waitForLine(lines, /tool names for session "session-B":.*effective \[schedule_delete, web_search\]/, 'pin B')

  const textA = await assemble(ctx, agentA, ['read', 'schedule_create', 'schedule_delete'])
  assert.deepEqual(members(textA), ['read', 'schedule_delete'], 'session A kept the rule it was pinned to')
  const textB = await assemble(ctx, agentB, ['read', 'schedule_create', 'schedule_delete'])
  assert.deepEqual(members(textB), ['read', 'schedule_create'], 'session B got the edited rule')
})

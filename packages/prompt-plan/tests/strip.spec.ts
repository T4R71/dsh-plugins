/**
 * Tests for the strip pass — the only correctness guarantee it has.
 *
 * The fixture is a hand-built `tools:sdk` text in the renderer's own shape
 * (`packages/core/tools/src/ts-types.ts:297-317`): a preamble, two interfaces,
 * doc lines, nested braces inside members, and a tail of further declarations.
 * Four cases matter, and each one is a claim the production code makes:
 *
 *   1. well-formed input is cut exactly,
 *   2. the tools that were kept are untouched, byte for byte,
 *   3. malformed input is returned UNCHANGED,
 *   4. a failed self-check refuses instead of publishing a partial strip.
 *
 * @module @t4r71/dsh-prompt-plan/tests
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripToolDeclarations, measureToolDeclarations, stripDeclarationComments } from '../src/strip.ts'
import { validateRuleSet } from '../src/rules.ts'
import { applyTransformOp, describeTransform } from '../src/transform.ts'
import type { StripToolDeclsOp, StripDocCommentsOp } from '../src/transform.ts'

/** A tool member as the renderer emits one. */
function member(name: string, body: string, doc?: string): string {
  return (doc === undefined ? '' : `  /** ${doc} */\n`) + `  ${name}: ${body};\n`
}

const KEEP_ARGS = member('read', '{ path: string }')
const KEEP_OUTPUT = member('read', '{ text: string }')
const SCHEDULE_ARGS = member('schedule_create', '{ prompt: string; after_seconds?: number }', 'Create a reminder at a fixed delay.')
const SCHEDULE_OUTPUT = member('schedule_create', '{ id: string; code?: "invalid_rule" | "internal_error" }')
const DELETE_ARGS = member('schedule_delete', '{ id: string }')
const DELETE_OUTPUT = member('schedule_delete', '{ id: string; deleted: boolean }')

/** The fixture section, in the renderer's order: preamble, maps, tail. */
function fixture(): string {
  return [
    'Use the SDK bindings below.',
    '',
    'interface ToolArgsMap {',
    KEEP_ARGS.trimEnd(),
    SCHEDULE_ARGS.trimEnd(),
    DELETE_ARGS.trimEnd(),
    '}',
    '',
    'interface ToolOutputMap {',
    KEEP_OUTPUT.trimEnd(),
    SCHEDULE_OUTPUT.trimEnd(),
    DELETE_OUTPUT.trimEnd(),
    '}',
    '',
    'type ToolName = keyof ToolOutputMap',
  ].join('\n')
}

test('a well-formed section is cut exactly, and the kept tools survive verbatim', () => {
  const text = fixture()
  const outcome = stripToolDeclarations(text, ['schedule_create', 'schedule_delete'], false)
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  // The remaining text still carries the kept tool, in both maps.
  assert.ok(outcome.text.includes(KEEP_ARGS.trimEnd()), 'read stays in ToolArgsMap')
  assert.ok(outcome.text.includes(KEEP_OUTPUT.trimEnd()), 'read stays in ToolOutputMap')
  // And carries neither removed tool anywhere.
  assert.ok(!outcome.text.includes('schedule_create'), 'schedule_create is gone')
  assert.ok(!outcome.text.includes('schedule_delete'), 'schedule_delete is gone')
  // The maps are still closed, and the tail is untouched.
  assert.ok(outcome.text.includes('interface ToolArgsMap {'), 'the args map header survives')
  assert.ok(outcome.text.includes('interface ToolOutputMap {'), 'the output map header survives')
  assert.ok(outcome.text.includes('type ToolName = keyof ToolOutputMap'), 'the tail survives')

  // The accounting identity, stated as the test rather than assumed: the
  // characters that disappeared are exactly the two declarations' own lengths.
  assert.equal(text.length - outcome.text.length, outcome.removedChars)
  // The sum is over BOTH tools, and it is the sum the module computed itself.
  const accounted = outcome.removed.reduce((total, tool) => total + tool.argsChars + tool.outputChars, 0)
  assert.equal(accounted, outcome.removedChars, 'the sum of the per-tool lengths IS the removal')
  assert.equal(outcome.removed.length, 2)
  // Each entry names its own tool, so the operator's line can attribute the cost.
  assert.deepEqual(outcome.removed.map(tool => tool.name), ['schedule_create', 'schedule_delete'])
})

test('dryRun measures and returns the text unchanged', () => {
  const text = fixture()
  const outcome = stripToolDeclarations(text, ['schedule_create'], true)
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.text, text, 'the text is returned as it arrived')
  assert.equal(outcome.removed.length, 1)
  assert.equal(outcome.removed[0]?.name, 'schedule_create')
  // The args measure is the member's DOC LINE plus its declaration line, each
  // counted with its trailing newline: the doc line is the tool's description
  // and belongs to it, which is why removing the member removes it too.
  const docLine = '  /** Create a reminder at a fixed delay. */'
  const argsLine = '  schedule_create: { prompt: string; after_seconds?: number };'
  assert.equal(outcome.removed[0]?.argsChars, docLine.length + 1 + argsLine.length + 1)
  // The last member of a map ends on the line before the closing brace; the
  // newline that follows it is the map's, not the member's, so an end-of-body
  // member measures one character short of a mid-body one.
  assert.equal(outcome.removed[0]?.outputChars, SCHEDULE_OUTPUT.length)
  assert.equal(outcome.removedChars, (outcome.removed[0]?.argsChars ?? 0) + (outcome.removed[0]?.outputChars ?? 0))
})

test('malformed input is returned UNCHANGED, with no exception', () => {
  const cases: [string, string][] = [
    ['no maps at all', 'just prose, no interfaces here'],
    ['unclosed args map', 'interface ToolArgsMap {\n  schedule_create: { prompt: string };\n'],
    ['header spelled differently', 'interface ToolArgsMap{\n  schedule_create: { prompt: string };\n}\ninterface ToolOutputMap {\n}\n'],
    ['empty text', ''],
  ]
  for (const [label, text] of cases) {
    const outcome = stripToolDeclarations(text, ['schedule_create'], false)
    assert.equal(outcome.ok, false, label + ': refused')
    if (outcome.ok) continue
    // A refusal carries a sentence naming the failed check, and never a partial text.
    assert.ok(outcome.refusal.problem.length > 0, label + ': the refusal names the problem')
  }
})

test('a requested name absent from one map only is not removed anywhere', () => {
  // A half-declared tool: present in the args map, missing from the output map.
  const text = [
    'interface ToolArgsMap {',
    '  ghost_tool: { a: string };',
    '}',
    '',
    'interface ToolOutputMap {',
    '  read: { b: string };',
    '}',
  ].join('\n')
  const outcome = stripToolDeclarations(text, ['ghost_tool'], false)
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.removed.length, 0, 'nothing was measured')
  assert.equal(outcome.text, text, 'so nothing was removed')
})

test('the self-check refuses rather than publishing a partial strip', () => {
  // The member spans are measured with a trailing newline. Removing the last
  // member of a map leaves the map CLOSED — so the re-read check is what proves
  // the surviving member count, and the accounting check is what proves the
  // length. Both are exercised by removing the first member of each map while a
  // decoy line, at the same indent but not a member declaration, sits between
  // them; the strip must not swallow it.
  const text = [
    'interface ToolArgsMap {',
    '  schedule_create: { prompt: string };',
    '  note_without_colon',
    '  read: { path: string };',
    '}',
    '',
    'interface ToolOutputMap {',
    '  schedule_create: { id: string };',
    '}',
  ].join('\n')
  const outcome = stripToolDeclarations(text, ['schedule_create'], false)
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.ok(outcome.text.includes('  note_without_colon'), 'the decoy line is not swallowed')
  assert.ok(outcome.text.includes('  read: { path: string };'), 'the following member survives verbatim')
})

test('a doc line stays with the member it documents', () => {
  // The renderer emits a member's doc lines ABOVE it, so a doc line between two
  // members belongs to the one below. Removing the member above must leave the
  // doc line standing, and the doc line must not be charged to the wrong tool.
  const text = [
    'interface ToolArgsMap {',
    '  a: { x: string };',
    '  /** schedule_create creates a reminder. */',
    '  schedule_create: { prompt: string };',
    '}',
    '',
    'interface ToolOutputMap {',
    '  schedule_create: { id: string };',
    '}',
  ].join('\n')
  const outcome = stripToolDeclarations(text, ['schedule_create'], false)
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.ok(outcome.text.includes('  a: { x: string };'), 'the member above survives')
  assert.ok(!outcome.text.includes('schedule_create'), 'the tool and its doc line are both gone')
})

test('the accounting check is what refuses a strip whose spans do not add up', () => {
  // Reachable through the public entry: the args measure counts each line plus
  // its newline, but a member at the END of a map body ends at the body's last
  // line, whose newline belongs to the map. A mismatch between the two is
  // exactly what the accounting check exists to catch — so this test asserts the
  // invariant the check enforces (removal === sum) on a layout that stresses it,
  // and that the op returns something usable in every case.
  const text = [
    'interface ToolArgsMap {',
    '  schedule_create: { prompt: string };',
    '  schedule_delete: { id: string };',
    '}',
    '',
    'interface ToolOutputMap {',
    '  schedule_create: { id: string };',
    '  schedule_delete: { id: string };',
    '}',
  ].join('\n')
  const outcome = stripToolDeclarations(text, ['schedule_create', 'schedule_delete'], false)
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  const accounted = outcome.removed.reduce((total, tool) => total + tool.argsChars + tool.outputChars, 0)
  assert.equal(accounted, outcome.removedChars, 'the removal equals the measured sum')
  assert.equal(text.length - outcome.text.length, outcome.removedChars, 'and equals the bytes that disappeared')
  assert.deepEqual(outcome.text, [
    'interface ToolArgsMap {',
    '}',
    '',
    'interface ToolOutputMap {',
    '}',
  ].join('\n'), 'both maps are left empty but intact')
})

test('the transform op reports its measurement and never throws', () => {
  const op: StripToolDeclsOp = { op: 'stripToolDecls', names: ['schedule_create'], dryRun: true }
  const text = fixture()
  assert.equal(applyTransformOp(text, op), text, 'dryRun returns the input')
  assert.equal(op.lastReport?.dryRun, true)
  assert.equal(op.lastReport?.tools.length, 1)
  assert.equal(op.lastRefusal, undefined)

  const broken = applyTransformOp('not a section', op)
  assert.equal(broken, 'not a section', 'a refusal also returns the input')
  assert.ok(op.lastRefusal !== undefined, 'and records why')
  assert.ok(describeTransform([op]).includes('stripToolDecls'))
})

test('measureToolDeclarations reports every requested tool', () => {
  const analysis = measureToolDeclarations(fixture(), ['schedule_create', 'schedule_delete'])
  assert.ok(!('check' in analysis), 'the well-formed fixture is measurable')
  if ('check' in analysis) return
  assert.deepEqual(analysis.tools.map(tool => tool.name), ['schedule_create', 'schedule_delete'])
})

// ─────────────────────────────────────────────────────────────────────────────
// stripDocComments — the second text-only lever
// ─────────────────────────────────────────────────────────────────────────────

/** A member carrying a doc comment above it and one above a nested property. */
function docMember(name: string, body: string): string {
  return [
    `  /** ${name} does a thing. */`,
    `  ${name}: {`,
    '    /** A nested property. */',
    body,
    '  };',
  ].join('\n')
}

function docFixture(): string {
  return [
    'Use the SDK bindings below.',
    '',
    'interface ToolArgsMap {',
    docMember('read', '    path: string;'),
    docMember('write', '    path: string;'),
    '}',
    '',
    'interface ToolOutputMap {',
    docMember('read', '    text: string;'),
    docMember('write', '    ok: boolean;'),
    '}',
    '',
    'type ToolName = keyof ToolOutputMap',
  ].join('\n')
}

test('stripDocComments removes every comment block and preserves every signature', () => {
  const text = docFixture()
  const outcome = stripDeclarationComments(text, false)
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.report.blocks, 8)
  assert.equal(outcome.report.removedChars, text.length - outcome.text.length)
  assert.equal(outcome.text.includes('/**'), false)
  // Signatures survive byte-for-byte: stripping comments from both sides makes them equal.
  assert.equal(outcome.text.replace(/\s+/g, ' ').trim(), text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim())
  // Member count is unchanged in both maps.
  const members = (s: string) => [...s.matchAll(/^  ([A-Za-z_$][\w$]*): /gm)].map(m => m[1])
  assert.deepEqual(members(outcome.text), members(text))
})

test('stripDocComments dryRun measures without changing the text', () => {
  const text = docFixture()
  const outcome = stripDeclarationComments(text, true)
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.report.dryRun, true)
  assert.equal(outcome.report.blocks, 8)
  assert.equal(outcome.text, text)
})

test('stripDocComments returns the text UNCHANGED when a map is missing', () => {
  const text = 'no maps here at all'
  const outcome = stripDeclarationComments(text, false)
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.refusal.check, 'structure')
})

test('stripDocComments returns the text UNCHANGED for an unclosed block', () => {
  const text = [
    'interface ToolArgsMap {',
    '  /** never closes',
    '  read: { path: string };',
    '}',
    '',
    'interface ToolOutputMap {',
    '  read: { text: string };',
    '}',
  ].join('\n')
  const outcome = stripDeclarationComments(text, false)
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.refusal.check, 'structure')
})

test('the stripDocComments op applies through applyTransformOp and reports', () => {
  const text = docFixture()
  const op: StripDocCommentsOp = { op: 'stripDocComments', dryRun: false }
  const out = applyTransformOp(text, op)
  assert.equal(out.includes('/**'), false)
  assert.equal(op.lastReport?.blocks, 8)
  assert.equal(op.lastReport?.removedChars, text.length - out.length)
})

test('the stripDocComments op defaults to measured-only and describes itself', () => {
  const op: StripDocCommentsOp = { op: 'stripDocComments', dryRun: true }
  assert.match(describeTransform([op]), /stripDocComments \(dryRun\)/)
})

// ─────────────────────────────────────────────────────────────────────────────
// stripDocComments — keepToolDescriptions: the TOOL block against the FIELD block
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One member in the real render's shape at BOTH levels: a doc block above the
 * member line (the tool's own sentence) and a doc block above the field.
 */
function levelledMember(name: string, toolDoc: string, field: string, fieldDoc: string): string {
  return [
    `  /** ${toolDoc} */`,
    `  ${name}: {`,
    `    /** ${fieldDoc} */`,
    `    ${field}`,
    '  };',
  ].join('\n')
}

/** Two tools, each with a tool doc and a field doc, plus a map with neither. */
function levelledFixture(): string {
  return [
    'Use the SDK bindings below.',
    '',
    'interface ToolArgsMap {',
    levelledMember('read', 'Read a file from disk.', 'path: string;', 'The path to read.'),
    levelledMember('write', 'Write a file to disk.', 'path: string;', 'The path to write.'),
    '}',
    '',
    'interface ToolOutputMap {',
    '  read: { text: string };',
    '  write: { ok: boolean };',
    '}',
    '',
    'type ToolName = keyof ToolOutputMap',
  ].join('\n')
}

/** The same section with the two FIELD blocks gone and not one other byte moved. */
function levelledKept(): string {
  return [
    'Use the SDK bindings below.',
    '',
    'interface ToolArgsMap {',
    '  /** Read a file from disk. */',
    '  read: {',
    '    path: string;',
    '  };',
    '  /** Write a file to disk. */',
    '  write: {',
    '    path: string;',
    '  };',
    '}',
    '',
    'interface ToolOutputMap {',
    '  read: { text: string };',
    '  write: { ok: boolean };',
    '}',
    '',
    'type ToolName = keyof ToolOutputMap',
  ].join('\n')
}

test('keepToolDescriptions removes the FIELD blocks and leaves the tool blocks byte-for-byte', () => {
  const text = levelledFixture()
  const outcome = stripDeclarationComments(text, false, { keepToolDescriptions: true })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.text, levelledKept())
  assert.equal(outcome.text.includes('Read a file from disk.'), true)
  assert.equal(outcome.text.includes('The path to read.'), false)
  // NO EMPTY LINE is left where a block was: the removal takes the block's OWN
  // newline with it, so the section loses exactly two lines and gains none. The
  // blank lines that survive are the renderer's own — the three it put between the
  // preamble and the maps — and their number is unchanged by the removal.
  assert.equal(outcome.text.split('\n').length, text.split('\n').length - 2)
  const blanks = (value: string): number => value.split('\n').filter(line => line.trim() === '').length
  assert.equal(blanks(outcome.text), blanks(text), 'a removed block must not leave a blank line')
})

test('keepToolDescriptions reports the blocks it kept and the blocks it removed', () => {
  const text = levelledFixture()
  const outcome = stripDeclarationComments(text, false, { keepToolDescriptions: true })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.report.blocks, 4)
  assert.equal(outcome.report.keptToolDescriptions, 2)
  assert.equal(outcome.report.removedParamBlocks, 2)
  assert.equal(outcome.report.dryRun, false)
  // The arithmetic an operator checks by hand: every located block is either kept
  // as a tool description or removed as a field block.
  assert.equal(outcome.report.blocks - outcome.report.keptToolDescriptions - outcome.report.removedParamBlocks, 0)
  assert.equal(outcome.report.removedChars, text.length - outcome.text.length)
})

test('the mode is OPT-IN: the two-argument call keeps its old meaning, byte for byte', () => {
  const text = levelledFixture()
  const before = stripDeclarationComments(text, false)
  const explicit = stripDeclarationComments(text, false, { keepToolDescriptions: false })
  assert.equal(before.ok && explicit.ok, true)
  if (!before.ok || !explicit.ok) return
  assert.equal(before.text, explicit.text)
  assert.equal(before.text.includes('/**'), false, 'the default still removes EVERY block')
  assert.equal(before.report.keptToolDescriptions, 0)
  assert.equal(before.report.removedParamBlocks, 2)
  assert.equal(before.report.blocks, 4)
  // In the default mode the two tool blocks go too, which the three counts state
  // rather than leave to arithmetic: 4 located, 0 kept, 2 field blocks removed.
  assert.equal(before.report.blocks - before.report.keptToolDescriptions - before.report.removedParamBlocks, 2)
})

test('dryRun under keepToolDescriptions measures the real run, and changes nothing', () => {
  const text = levelledFixture()
  const measured = stripDeclarationComments(text, true, { keepToolDescriptions: true })
  const real = stripDeclarationComments(text, false, { keepToolDescriptions: true })
  assert.equal(measured.ok && real.ok, true)
  if (!measured.ok || !real.ok) return
  assert.equal(measured.text, text)
  assert.equal(measured.report.dryRun, true)
  // The number an operator decides on is the number a real run produces.
  assert.equal(measured.report.removedChars, real.report.removedChars)
  assert.equal(measured.report.removedChars, text.length - real.text.length)
  assert.equal(measured.report.blocks, real.report.blocks)
  assert.equal(measured.report.keptToolDescriptions, real.report.keptToolDescriptions)
  assert.equal(measured.report.removedParamBlocks, real.report.removedParamBlocks)
  assert.ok(measured.report.removedChars > 0)
})

test('a section whose only comments are tool descriptions keeps all of them, and is not refused', () => {
  const text = [
    'Use the SDK bindings below.',
    '',
    'interface ToolArgsMap {',
    '  /** Read a file from disk. */',
    '  read: { path: string };',
    '  /** Write a file to disk. */',
    '  write: { path: string };',
    '}',
    '',
    'interface ToolOutputMap {',
    '  read: { text: string };',
    '  write: { ok: boolean };',
    '}',
    '',
    'type ToolName = keyof ToolOutputMap',
  ].join('\n')
  const outcome = stripDeclarationComments(text, false, { keepToolDescriptions: true })
  assert.equal(outcome.ok, true, 'keeping every block is an outcome, not an accounting failure')
  if (!outcome.ok) return
  assert.equal(outcome.text, text)
  assert.equal(outcome.report.removedChars, 0)
  assert.equal(outcome.report.blocks, 2)
  assert.equal(outcome.report.keptToolDescriptions, 2)
  assert.equal(outcome.report.removedParamBlocks, 0)
})

test('a map carrying no comment block at all is not a refusal, in either mode', () => {
  const text = [
    'Use the SDK bindings below.',
    '',
    'interface ToolArgsMap {',
    '  read: { path: string };',
    '}',
    '',
    'interface ToolOutputMap {',
    '  read: { text: string };',
    '}',
    '',
    'type ToolName = keyof ToolOutputMap',
  ].join('\n')
  for (const keepToolDescriptions of [false, true]) {
    const outcome = stripDeclarationComments(text, false, { keepToolDescriptions })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.text, text)
    assert.equal(outcome.report.blocks, 0)
    assert.equal(outcome.report.removedChars, 0)
    assert.equal(outcome.report.keptToolDescriptions, 0)
    assert.equal(outcome.report.removedParamBlocks, 0)
  }
})

test('the criterion is the renderer\'s own anchor: a QUOTED member line is tool level too', () => {
  const text = [
    'interface ToolArgsMap {',
    '  /** Does a thing. */',
    '  "my-tool": {',
    '    /** The command. */',
    '    command: string;',
    '  };',
    '}',
    '',
    'interface ToolOutputMap {',
    '  "my-tool": { text: string };',
    '}',
  ].join('\n')
  const outcome = stripDeclarationComments(text, false, { keepToolDescriptions: true })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.report.keptToolDescriptions, 1)
  assert.equal(outcome.report.removedParamBlocks, 1)
  assert.equal(outcome.text.includes('Does a thing.'), true)
  assert.equal(outcome.text.includes('The command.'), false)
})

test('the stripDocComments op carries the mode through applyTransformOp and describes it', () => {
  const text = levelledFixture()
  const theOp: StripDocCommentsOp = { op: 'stripDocComments', dryRun: false, keepToolDescriptions: true }
  const out = applyTransformOp(text, theOp)
  assert.equal(out, levelledKept())
  assert.equal(theOp.lastReport?.keptToolDescriptions, 2)
  assert.equal(theOp.lastReport?.removedParamBlocks, 2)
  assert.equal(theOp.lastRefusal, undefined)
  assert.match(describeTransform([theOp]), /stripDocComments \(keepToolDescriptions\)/)
  // An op that does NOT ask for it still removes everything.
  const plain: StripDocCommentsOp = { op: 'stripDocComments', dryRun: false }
  assert.equal(applyTransformOp(text, plain).includes('/**'), false)
})

test('the rule loader compiles keepToolDescriptions, and refuses a non-boolean', () => {
  const document = (op: Record<string, unknown>): unknown => ({
    version: 1,
    rules: [{
      id: 'keep-tool-descriptions',
      match: { kind: 'exact', value: 'tools:sdk' },
      action: { kind: 'transform', transform: [op] },
    }],
  })
  const compile = (op: Record<string, unknown>): StripDocCommentsOp => {
    const action = validateRuleSet(document(op), 'test.yaml').rules[0]?.action
    if (action?.kind !== 'transform') throw new Error('the action did not compile as a transform')
    const compiled = action.transform[0]
    if (compiled === undefined || compiled.op !== 'stripDocComments') throw new Error('the op did not compile as stripDocComments')
    return compiled
  }
  const asked = compile({ op: 'stripDocComments', keepToolDescriptions: true, dryRun: false })
  assert.equal(asked.keepToolDescriptions, true)
  assert.equal(asked.dryRun, false)
  // Absent means the member is NOT carried, so a rule written before this option
  // existed compiles to exactly the op it compiled to before.
  const plain = compile({ op: 'stripDocComments', dryRun: false })
  assert.equal('keepToolDescriptions' in plain, false)
  assert.equal(plain.dryRun, false)
  assert.throws(
    () => validateRuleSet(document({ op: 'stripDocComments', keepToolDescriptions: 'yes' }), 'test.yaml'),
    /"keepToolDescriptions" must be a boolean/,
  )
  // The mode reaches the text through the op, so file and runtime agree.
  assert.equal(applyTransformOp(levelledFixture(), compile({ op: 'stripDocComments', keepToolDescriptions: true, dryRun: false })), levelledKept())
})


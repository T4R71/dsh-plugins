/**
 * Tests for the replaceText transform op — the in-line lever, and its safety
 * valve.
 *
 * What each group is here to prove, stated rather than assumed:
 *
 *   1. an ordinary replacement happens, in every line it should, and a
 *      non-global pattern never leaves a half-rewritten line;
 *   2. the `expect` count turns a rule that stopped fitting the text into a
 *      REFUSAL with the text returned verbatim — the whole reason this op exists,
 *      because the text it aims at belongs to the tool SDK and moves under it;
 *   3. `dryRun` measures the real count and changes nothing;
 *   4. a rule file that cannot be honoured is refused at LOAD time: an invalid
 *      pattern, a missing replacement, a non-integer expect, a flag set without
 *      "g";
 *   5. the dollar-sign semantics are pinned down, so the next author learns from
 *      the tests rather than from a quietly wrong prompt.
 *
 * The fixture is the real shape the op was built for: one tool description that
 * lives on a single line, inside the args map of the generated SDK.
 *
 * @module @t4r71/dsh-prompt-plan/tests
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateRuleSet, RuleFileError } from '../src/rules.ts'
import { applyTransformOp, describeTransform, TRANSFORM_OPS } from '../src/transform.ts'
import type { ReplaceTextOp, TransformOp } from '../src/transform.ts'

// ─────────────────────────────────────────────────────────────────────────────
// The fixture: a description that has to lose a clause, on one line
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the cut belongs in the fixture text.
 *
 * A marker, rather than a pattern that spells the tail out: every hand-written
 * attempt at "the second example and everything after it" also matched the first
 * example's own tail, which is exactly the silent mis-aim this op's `expect`
 * exists to catch. The marker cannot be confused with the prose around it, and it
 * carries no character that means anything to a regular expression — which is not
 * a detail: a marker with a '-' in it turned the pattern into a character range,
 * and the rule then replaced the wrong text with no complaint at all.
 */
const MARK = '<<<'
const PREFIX = 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" -> "List files in current directory".'
const SUFFIX = ' "git status" -> "Show working tree status"; "Get-Process" -> "List running processes".'
/** The description as the SDK renders it: one long line. */
const LONG_DESCRIPTION = PREFIX + MARK + SUFFIX
/**
 * The description the rule cuts it down to: the marker and its tail are gone, and
 * the sentence's own period and the comment's closing delimiter are put back by
 * the replacement.
 */
const SHORT_DESCRIPTION = PREFIX
/** The cut, spelled the way a rule file spells it: the sentence's period, the marker, then the tail. */
const CUT = '.' + MARK + '.*'

/** The tools:sdk shape, with the description line inside the args map. */
function fixture(description = LONG_DESCRIPTION): string {
  return [
    'Use the SDK bindings below.',
    '',
    'interface ToolArgsMap {',
    '  /** ' + description + ' */',
    '  "my-tool": { command: string };',
    '}',
    '',
    'interface ToolOutputMap {',
    '  "my-tool": { text: string };',
    '}',
    '',
    'type ToolName = keyof ToolOutputMap',
  ].join('\n')
}

/** Lines with trailing space removed, for comparisons that are about shape. */
function lines(text: string): string[] {
  return text.split('\n').map(line => line.trimEnd())
}

/** Build an op the way the rule loader does, with the two defaults made explicit. */
function op(options: {
  pattern?: string
  replacement?: string
  flags?: string
  dryRun?: boolean
  expect?: number
} = {}): ReplaceTextOp {
  const flags = options.flags ?? 'g'
  const built: ReplaceTextOp = {
    op: 'replaceText',
    pattern: new RegExp(options.pattern ?? 'EMPTY', flags),
    source: options.pattern ?? 'EMPTY',
    replacement: options.replacement ?? 'X',
    flags,
    dryRun: options.dryRun ?? false,
  }
  if (options.expect !== undefined) built.expect = options.expect
  return built
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. an ordinary replacement
// ─────────────────────────────────────────────────────────────────────────────

test('replaceText shortens one line and leaves every other line untouched', () => {
  const text = fixture()
  const theOp = op({ pattern: CUT, replacement: '. */', expect: 1 })
  const out = applyTransformOp(text, theOp)
  assert.deepEqual(lines(out), lines(fixture(SHORT_DESCRIPTION)))
  assert.equal(out.split('\n').length, text.split('\n').length)
  assert.equal(theOp.lastReport?.replacements, 1)
  assert.equal(theOp.lastReport?.dryRun, false)
  // The match is the marker plus everything after it, so the characters the line
  // lost are exactly the difference between the two descriptions, nothing else.
  assert.equal(theOp.lastReport?.removedChars, LONG_DESCRIPTION.length - SHORT_DESCRIPTION.length)
  assert.equal(theOp.lastRefusal, undefined)
})

test('removedChars goes negative when the replacement is longer than the match', () => {
  const text = fixture('Short.')
  const theOp = op({ pattern: 'Short\.', replacement: 'A considerably longer description.', expect: 1 })
  const out = applyTransformOp(text, theOp)
  assert.equal(out.includes('A considerably longer description.'), true)
  assert.equal(theOp.lastReport?.removedChars, 'Short.'.length - 'A considerably longer description.'.length)
  assert.ok((theOp.lastReport?.removedChars ?? 0) < 0)
})

test('an empty replacement is legal and deletes the matched text', () => {
  const text = fixture('Keep this. Drop that.')
  const theOp = op({ pattern: ' Drop that\.', replacement: '', expect: 1 })
  assert.equal(applyTransformOp(text, theOp), fixture('Keep this.'))
})

test('flags "gi" replaces every case variant, and only with "g"', () => {
  const text = 'ALPHA alpha Alpha'
  const insensitive = op({ pattern: 'alpha', replacement: 'x', flags: 'gi', expect: 3 })
  assert.equal(applyTransformOp(text, insensitive), 'x x x')
  const sensitive = op({ pattern: 'alpha', replacement: 'x', flags: 'g', expect: 1 })
  assert.equal(applyTransformOp(text, sensitive), 'ALPHA x Alpha')
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. the "g" requirement — a non-global run cannot leave a half-rewritten line
// ─────────────────────────────────────────────────────────────────────────────

test('a pattern without "g" is refused and returns the text verbatim', () => {
  const text = 'aa aa aa'
  const theOp = op({ pattern: 'aa', replacement: 'b', flags: '' })
  const out = applyTransformOp(text, theOp)
  assert.equal(out, text)
  assert.equal(theOp.lastRefusal?.check, 'flags')
  assert.match(theOp.lastRefusal?.problem ?? '', /must include "g"/)
  // The engine would have replaced ONE of the three; the op publishes none.
  assert.equal(text.replace(/aa/, 'b'), 'b aa aa')
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. expect — the safety valve
// ─────────────────────────────────────────────────────────────────────────────

test('expect passes when the rule still fits the text, and reports the count', () => {
  const theOp = op({ pattern: 'Examples:', replacement: 'Example:', expect: 1 })
  const out = applyTransformOp(fixture(), theOp)
  assert.equal(out.includes('Example: "ls"'), true)
  assert.equal(theOp.lastReport?.replacements, 1)
  assert.equal(theOp.lastRefusal, undefined)
})

test('expect refuses when the pattern is aimed at text upstream has already changed', () => {
  const theOp = op({ pattern: 'Examples:', replacement: 'Example:', expect: 1 })
  const changed = fixture('The upstream sentence no longer says that.')
  assert.equal(applyTransformOp(changed, theOp), changed)
  assert.equal(theOp.lastRefusal?.check, 'expect')
  assert.equal(theOp.lastRefusal?.problem, 'expected 1 replacement(s), found 0')
})

test('expect refuses when the pattern would catch MORE than the rule meant', () => {
  const text = 'null null null'
  const theOp = op({ pattern: 'null', replacement: 'nil', expect: 2 })
  assert.equal(applyTransformOp(text, theOp), text)
  assert.equal(theOp.lastRefusal?.problem, 'expected 2 replacement(s), found 3')
})

test('expect 0 is a real expectation: a pattern that must match nothing', () => {
  const text = 'nothing to see'
  const clean = op({ pattern: 'banned', replacement: 'x', expect: 0 })
  assert.equal(applyTransformOp(text, clean), text)
  assert.equal(clean.lastRefusal, undefined)
  assert.equal(clean.lastReport?.replacements, 0)

  const dirty = op({ pattern: 'banned', replacement: 'x', expect: 0 })
  const offended = 'banned: ' + text
  assert.equal(applyTransformOp(offended, dirty), offended)
  assert.equal(dirty.lastRefusal?.check, 'expect')
})

test('a refused run leaves lastReport as it was, so no stale count can be read off it', () => {
  const theOp = op({ pattern: 'zzz', replacement: 'y', expect: 4 })
  applyTransformOp(fixture(), theOp)
  assert.equal(theOp.lastReport, undefined)
  assert.equal(theOp.lastRefusal?.check, 'expect')
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. dryRun — measure the real count, change nothing
// ─────────────────────────────────────────────────────────────────────────────

test('dryRun reports the count a real run would make and returns the input', () => {
  const text = fixture()
  const theOp = op({ pattern: CUT, replacement: '. */', dryRun: true, expect: 1 })
  const out = applyTransformOp(text, theOp)
  assert.equal(out, text)
  assert.equal(theOp.lastReport?.dryRun, true)
  assert.equal(theOp.lastReport?.replacements, 1)
  // Measured, not zero: the number is what the replacement WOULD save.
  assert.equal(theOp.lastReport?.removedChars, LONG_DESCRIPTION.length - SHORT_DESCRIPTION.length)
  assert.equal(theOp.lastRefusal, undefined)
})

test('dryRun still refuses on an expect mismatch, because the measurement is the point', () => {
  const text = fixture()
  const theOp = op({ pattern: 'Examples:', replacement: 'Example:', dryRun: true, expect: 2 })
  assert.equal(applyTransformOp(text, theOp), text)
  assert.equal(theOp.lastRefusal?.problem, 'expected 2 replacement(s), found 1')
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. empty matches and shape failures
// ─────────────────────────────────────────────────────────────────────────────

test('a pattern that can match empty text is refused rather than inserting between characters', () => {
  // A HAND-BUILT op, which is the only route such a pattern can take: the rule
  // loader refuses an empty pattern string before it compiles one.
  for (const source of ['', 'x*', '(?:)']) {
    const built: ReplaceTextOp = {
      op: 'replaceText',
      pattern: new RegExp(source, 'g'),
      source,
      replacement: '-',
      flags: 'g',
      dryRun: false,
    }
    assert.equal(applyTransformOp('abc', built), 'abc')
    assert.equal(built.lastRefusal?.check, 'pattern')
    assert.match(built.lastRefusal?.problem ?? '', /matches empty text/)
    assert.equal(built.lastReport, undefined)
  }
})

test('a pattern that matches nothing replaces nothing and is not a refusal', () => {
  // Refused only when the operator wrote down an expectation.
  const theOp = op({ pattern: 'absent-from-this-text', replacement: 'x' })
  const text = fixture()
  assert.equal(applyTransformOp(text, theOp), text)
  assert.equal(theOp.lastReport?.replacements, 0)
  assert.equal(theOp.lastReport?.removedChars, 0)
  assert.equal(theOp.lastRefusal, undefined)
})

test('the pattern state does not leak between two applies of the same op', () => {
  const theOp = op({ pattern: 'a', replacement: 'b', expect: 3 })
  const text = 'a a a'
  assert.equal(applyTransformOp(text, theOp), 'b b b')
  // The SAME op object again: a lastIndex left behind by the first run would make
  // the second count differ, and one op object is shared across assemblies.
  assert.equal(applyTransformOp(text, theOp), 'b b b')
  assert.equal(theOp.lastReport?.replacements, 3)
  assert.equal(theOp.lastRefusal, undefined)
})

test('describeTransform names the pattern, the replacement, the expectation and the dry run', () => {
  const dry: TransformOp = op({ pattern: 'Examples:', replacement: 'Example:', dryRun: true, expect: 1 })
  assert.match(describeTransform([dry]), /replaceText \/Examples:\/g -> "Example:" expect 1 \(dryRun\)/)
  const live = describeTransform([op({ pattern: 'a/b', replacement: 'c"d' })])
  // The pattern is a regular-expression literal, the replacement is JSON-quoted:
  // both are escaped on the line an operator reads.
  assert.equal(live, 'transform [replaceText /a/b/g -> "c\\"d"]')
})

test('replaceText is part of the closed op set', () => {
  assert.ok(TRANSFORM_OPS.includes('replaceText'))
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. dollar signs — the semantics the report explains, pinned by tests
// ─────────────────────────────────────────────────────────────────────────────

test('$& inserts the match, $$ is one literal dollar sign', () => {
  const text = 'name: read;'
  assert.equal(applyTransformOp(text, op({ pattern: 'read', replacement: '$&_tool', expect: 1 })), 'name: read_tool;')
  assert.equal(applyTransformOp(text, op({ pattern: 'read', replacement: '$$read', expect: 1 })), 'name: $read;')
})

test('$1 is a back-reference only where the pattern has a group, and literal otherwise', () => {
  const text = '"ls" -> "List files in current directory"'
  // WITH a group: $1 and $2 are the captured texts, which is the whole reason raw
  // replacement-string syntax was chosen over escaping every dollar sign.
  assert.equal(
    applyTransformOp(text, op({ pattern: '"([^"]+)" -> "([^"]+)"', replacement: '$2 <- $1', expect: 1 })),
    'List files in current directory <- ls',
  )
  // WITHOUT a group: the engine leaves the two characters alone, so the dollars
  // survive literally — which is exactly the case that must not be relied on.
  assert.equal(
    applyTransformOp('cost is $1 here', op({ pattern: '\\$1', replacement: '<$1>', expect: 1 })),
    'cost is <$1> here',
  )
})

test('an unmatched $n is left literal, and $<name> needs named groups to mean anything', () => {
  assert.equal(applyTransformOp('abc', op({ pattern: 'b', replacement: '$9', expect: 1 })), 'a$9c')
  assert.equal(applyTransformOp('abc', op({ pattern: 'b', replacement: '<$<who>>', expect: 1 })), 'a<$<who>>c')
  assert.equal(applyTransformOp('abc', op({ pattern: 'b', replacement: 'x$', expect: 1 })), 'ax$c')
})

test('dollars copied out of English prose are a hazard the count cannot catch', () => {
  // The pattern matches either way, so `expect` is satisfied in both runs and the
  // count can never be the thing that reports the mistake. Only the literal check
  // does: the escaped spelling is what the report tells authors to write.
  const version = 'Requires $1.5 or newer.'
  const unescaped = op({ pattern: 'Requires ([^ ]+) or newer\.', replacement: 'Needs $1 to run.', expect: 1 })
  assert.equal(applyTransformOp(version, unescaped), 'Needs $1.5 to run.')
  // `$1` is NOT a back-reference here — the pattern has a group, so it is: this is
  // the run where the two spellings differ, and the difference is the whole point.
  assert.equal(applyTransformOp(version, op({ pattern: 'Requires ([^ ]+) or newer\.', replacement: 'Needs $$1.5 to run.', expect: 1 })), 'Needs $1.5 to run.')
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. the rule file — what the loader accepts, refuses, and compiles
// ─────────────────────────────────────────────────────────────────────────────

/** A rule document carrying one replaceText op. */
function document(op: Record<string, unknown>): unknown {
  return {
    version: 1,
    rules: [{
      id: 'trim-description',
      match: { kind: 'exact', value: 'tools:sdk' },
      action: { kind: 'transform', transform: [op] },
    }],
  }
}

/** The compiled op of a one-rule document, or a failure that names the reason. */
function compile(op: Record<string, unknown>): ReplaceTextOp {
  const ruleSet = validateRuleSet(document(op), 'test.yaml')
  const action = ruleSet.rules[0]?.action
  if (action?.kind !== 'transform') throw new Error('the action did not compile as a transform')
  const compiled = action.transform[0]
  if (compiled === undefined) throw new Error('the transform list is empty')
  if (compiled.op !== 'replaceText') throw new Error('the op did not compile as replaceText')
  return compiled
}

test('the loader compiles a replaceText op with the documented defaults', () => {
  const compiled = compile({ op: 'replaceText', pattern: 'Examples:', replacement: 'Example:' })
  assert.equal(compiled.source, 'Examples:')
  assert.equal(compiled.replacement, 'Example:')
  assert.equal(compiled.flags, 'g')
  assert.equal(compiled.dryRun, true)
  assert.equal(compiled.expect, undefined)
  assert.equal(compiled.source, compiled.pattern.source)
  assert.equal(compiled.pattern.global, true)
})

test('the loader carries flags, expect and dryRun through unchanged', () => {
  const compiled = compile({ op: 'replaceText', pattern: 'examples:', replacement: 'Example:', flags: 'gi', expect: 2, dryRun: false })
  assert.equal(compiled.flags, 'gi')
  assert.equal(compiled.expect, 2)
  assert.equal(compiled.dryRun, false)
  assert.equal(compiled.pattern.ignoreCase, true)
})

test('the loader refuses an invalid pattern at LOAD time, naming the rule and the file', () => {
  assert.throws(
    () => validateRuleSet(document({ op: 'replaceText', pattern: '(unclosed', replacement: 'x' }), 'test.yaml'),
    (error: unknown) => {
      assert.ok(error instanceof RuleFileError)
      assert.match(error.message, /^test\.yaml: rules\[0\]: action\.transform\[0\]: "pattern" is not a valid regular expression/)
      return true
    },
  )
})

test('the loader refuses a flag set without "g" instead of silently replacing once', () => {
  assert.throws(
    () => validateRuleSet(document({ op: 'replaceText', pattern: 'a', replacement: 'b', flags: 'i' }), 'test.yaml'),
    /"flags" must include "g"/,
  )
})

test('the loader refuses a missing replacement, an empty pattern, and a non-regex pattern', () => {
  assert.throws(() => validateRuleSet(document({ op: 'replaceText', pattern: 'a' }), 'test.yaml'), /"replacement" must be a string/)
  assert.throws(() => validateRuleSet(document({ op: 'replaceText', pattern: '', replacement: 'x' }), 'test.yaml'), /"pattern" must be a non-empty regular expression/)
  assert.throws(() => validateRuleSet(document({ op: 'replaceText', pattern: 42, replacement: 'x' }), 'test.yaml'), /"pattern" must be a non-empty regular expression/)
  // The refusal lists the op set, which is how an operator learns the op is not
  // spelled "replace".
  assert.throws(
    () => validateRuleSet(document({ op: 'replace', pattern: 'a', replacement: 'x' }), 'test.yaml'),
    /"op" must be one of dropLines, keepLines, keepBlocks, stripToolDecls, stripDocComments, replaceText/,
  )
})

test('the loader refuses an expect that is not a non-negative integer', () => {
  for (const expect of [-1, 1.5, 'one', true, null]) {
    assert.throws(
      () => validateRuleSet(document({ op: 'replaceText', pattern: 'a', replacement: 'b', expect }), 'test.yaml'),
      /"expect" must be a non-negative integer/,
      'expect ' + JSON.stringify(expect) + ' must be refused',
    )
  }
})

test('the loader refuses a non-boolean dryRun', () => {
  assert.throws(
    () => validateRuleSet(document({ op: 'replaceText', pattern: 'a', replacement: 'b', dryRun: 'yes' }), 'test.yaml'),
    /"dryRun" must be a boolean/,
  )
})

test('a compiled rule is applied by the op, so the file and the runtime agree', () => {
  const compiled = compile({ op: 'replaceText', pattern: CUT, replacement: '. */', expect: 1, dryRun: false })
  assert.deepEqual(lines(applyTransformOp(fixture(), compiled)), lines(fixture(SHORT_DESCRIPTION)))
  assert.equal(compiled.lastReport?.removedChars, LONG_DESCRIPTION.length - SHORT_DESCRIPTION.length)
})

/**
 * Tests for the empty-section guard on `replace`, and for its single opt-in.
 *
 * WHAT THE GUARD IS FOR. Several upstream sections are emptied ON PURPOSE by the
 * module that owns them: `tools:ptc-only` collapses to `""` whenever the
 * deployment is not in PTC mode (`dsh-tools`, `collapseSection`, whose own
 * comment reads "both renders empty: native calls do execute there, so the rule
 * is false"), `context:file-reference` is `""` whenever no `read` tool is
 * mounted, and `harness:identity` is `""` when the deployment turns it off.
 * `dsh-system-prompt` then drops every empty section. A `replace` rule used to
 * write into that empty text anyway, which put a statement into the prompt that
 * nothing in the running composition stood behind — measured on the live desktop
 * rule file: an empty `tools:ptc-only` came back carrying all 65 characters of a
 * Chinese assertion.
 *
 * The groups below are the four claims the guard makes, stated so a future
 * refactor has to keep meaning them:
 *
 *   1. an empty target is LEFT EMPTY, and the skip is visible in the trace
 *      rather than being a silent no-op;
 *   2. `allowEmpty: true` is the ONE way back in, for both forms of `replace`;
 *   3. a non-empty target is untouched by any of this — including the
 *      replace-with-empty-text case, which is a legal replacement and not a skip;
 *   4. the discipline this module has always had (a NEW section object, never the
 *      input array) holds on the skip path too, and so do the loader's refusals.
 *
 * @module @t4r71/dsh-prompt-plan/tests
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyAction } from '../src/actions.ts'
import type { Action } from '../src/actions.ts'
import { compileRules, applyRules } from '../src/rewrite.ts'
import type { CompiledRule, SourceRule } from '../src/rewrite.ts'
import { validateRuleSet, RuleFileError } from '../src/rules.ts'
import type { SectionRecord } from '../src/sections.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** The live example, verbatim: the section `tools:ptc-only` collapses to. */
const EMPTY_SECTION: SectionRecord = { name: 'tools:ptc-only', text: '' }

/** The text a Chinese `replace` rule tried to write into it, at its real length. */
const ASSERTION = '`run_code`是你唯一能直接调用的工具——一次点名任何其它工具的调用都会失败。要在程序内部去够到下面SDK声明的每一个工具。'

/** A `replace` action carrying `text`, with the members a test needs. */
function replaceText(text: string, allowEmpty?: boolean): Action {
  return { kind: 'replace', text, ...allowEmpty === undefined ? {} : { allowEmpty } }
}

/** Apply one action to one section and return the sections that took its place. */
function outcome(section: SectionRecord, action: Action, index = 0): ReturnType<typeof applyAction> {
  return applyAction(section, index, action, section.interpolate)
}

/** One compiled rule, built the way `applyRules` receives it. */
function ruleOf(id: string, value: string, action: Action): CompiledRule {
  return { id, match: value, describeMatch: `exact ${JSON.stringify(value)}`, diagnosticKey: value, test: name => name === value, action, required: false, all: true }
}

/** The trace entry of one rule id, or a failure that names what was there. */
function traceOf(result: { trace: readonly { id: string }[] }, id: string): (typeof result.trace)[number] {
  const found = result.trace.find(entry => entry.id === id)
  if (found === undefined) throw new Error('no trace entry for ' + id)
  return found
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. the empty target is left empty, and the skip is visible
// ─────────────────────────────────────────────────────────────────────────────

test('a replace aimed at an empty section leaves it empty and reports the skip', () => {
  const out = outcome(EMPTY_SECTION, replaceText(ASSERTION))
  assert.equal(out.sections.length, 1)
  assert.equal(out.sections[0]?.text, '')
  assert.equal(out.sections[0]?.name, 'tools:ptc-only')
  assert.equal(out.skippedEmpty, true)
})

test('the skip is VISIBLE in the trace, with a nonzero count and the rule named', () => {
  const rules = [ruleOf('zh-tools-ptc-only', 'tools:ptc-only', replaceText(ASSERTION))]
  const result = applyRules([EMPTY_SECTION], rules, 'record')
  assert.equal(result.ok, true)
  if (!result.ok) return
  const entry = traceOf(result, 'zh-tools-ptc-only')
  assert.equal(entry.skippedEmpty, 1)
  // The rule DID match — the skip is not the same fact as "matched nothing".
  assert.deepEqual(entry.matched, ['tools:ptc-only'])
  assert.equal(result.sections[0]?.text, '')
})

test('the trace says "not skipped" with a zero, so the two readings are both written', () => {
  // A rule that matched a NON-empty section and a rule that matched nothing at
  // all: neither is a skip, and both say so on their own line rather than by
  // omitting the field.
  const rules = [
    ruleOf('live', 'harness:identity', replaceText('replaced')),
    ruleOf('absent', 'no-such-section', replaceText('replaced')),
  ]
  const result = applyRules([{ name: 'harness:identity', text: 'old' }], rules, 'record')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(traceOf(result, 'live').skippedEmpty, 0)
  assert.equal(traceOf(result, 'absent').skippedEmpty, 0)
})

test('a rule whose ONLY match was held back does not report the pass as changed', () => {
  const rules = [ruleOf('zh-tools-ptc-only', 'tools:ptc-only', replaceText(ASSERTION))]
  const result = applyRules([EMPTY_SECTION], rules, 'record')
  assert.equal(result.ok, true)
  if (!result.ok) return
  // Nothing moved: the assembly is byte-identical, and `changed` says so.
  assert.equal(result.changed, false)
  assert.equal(result.sections[0]?.text, '')

  // And a rule that writes into a non-empty section still reports a change, so
  // the flag did not simply become false everywhere.
  const writing = applyRules([{ name: 'tools:ptc-only', text: 'x' }], rules, 'record')
  assert.equal(writing.ok, true)
  if (!writing.ok) return
  assert.equal(writing.changed, true)
})

test('one skipped match beside one live match still reports the change', () => {
  // `all: true` over a family where only some members are empty: the live member
  // is rewritten, the empty one is left alone, and the trace carries both facts.
  const action: Action = { kind: 'replace', text: 'X' }
  const rules: CompiledRule[] = [{ ...ruleOf('family', 'tool:ptc-only', action), test: name => name.startsWith('tool') }]
  const result = applyRules([{ name: 'tool:ptc-only', text: '' }, { name: 'tool:pwsh', text: 'old' }], rules, 'record')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.sections.map(section => section.text), ['', 'X'])
  assert.equal(traceOf(result, 'family').skippedEmpty, 1)
  assert.equal(result.changed, true)
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. allowEmpty is the one way back in — for BOTH forms of replace
// ─────────────────────────────────────────────────────────────────────────────

test('allowEmpty: true writes into the empty section, and the trace says the rule opted in', () => {
  const rules = [ruleOf('fill-it', 'tools:ptc-only', replaceText(ASSERTION, true))]
  const result = applyRules([EMPTY_SECTION], rules, 'record')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.sections[0]?.text, ASSERTION)
  assert.equal(traceOf(result, 'fill-it').skippedEmpty, 0)
  // The opt-in is visible as the rule's OWN declaration, not inferred from the
  // result — an observation window has to show intent, not just outcome.
  assert.match(traceOf(result, 'fill-it').action, /allowEmpty/)
})

test('a rule that did not opt in does NOT advertise the opt-in', () => {
  const rules = [ruleOf('quiet', 'tools:ptc-only', replaceText(ASSERTION))]
  const result = applyRules([EMPTY_SECTION], rules, 'record')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(/allowEmpty/.test(traceOf(result, 'quiet').action), false)
})

test('allowEmpty: true applies to the fragments form too, which is why the guard covers both', () => {
  const action: Action = { kind: 'replace', fragments: [{ text: 'fragment body' }], allowEmpty: true }
  const out = outcome(EMPTY_SECTION, action)
  assert.equal(out.skippedEmpty, undefined)
  assert.deepEqual(out.sections.map(section => section.name), ['tools:ptc-only~0~0'])
  assert.deepEqual(out.sections.map(section => section.text), ['fragment body'])
})

test('allowEmpty: false behaves exactly like the absent default', () => {
  const withFalse = outcome(EMPTY_SECTION, replaceText(ASSERTION, false))
  const withAbsent = outcome(EMPTY_SECTION, replaceText(ASSERTION))
  assert.equal(withFalse.sections[0]?.text, '')
  assert.equal(withFalse.skippedEmpty, true)
  assert.deepEqual(
    withFalse.sections.map(section => section.name + '=' + section.text),
    withAbsent.sections.map(section => section.name + '=' + section.text),
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. the guard covers the fragments form by DEFAULT
// ─────────────────────────────────────────────────────────────────────────────

test('a fragments replace does not rebuild an empty section, and says which sections it held back', () => {
  const rules: CompiledRule[] = [{
    ...ruleOf('move-it', 'mcp:server', { kind: 'replace', fragments: [{ text: 'moved' }], splice: true }),
    test: name => name.startsWith('mcp:'),
  }]
  const result = applyRules([{ name: 'mcp:server', text: '' }, { name: 'persona', text: 'p' }], rules, 'record')
  assert.equal(result.ok, true)
  if (!result.ok) return
  // The empty section is still there, under its own name, still empty; nothing
  // was appended to the tail either.
  assert.deepEqual(result.sections.map(section => section.name), ['mcp:server', 'persona'])
  assert.equal(result.sections[0]?.text, '')
  assert.equal(traceOf(result, 'move-it').skippedEmpty, 1)
  assert.equal(result.changed, false)
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. a non-empty section is untouched by the guard
// ─────────────────────────────────────────────────────────────────────────────

test('a non-empty section is replaced exactly as before, with no opt-in needed', () => {
  const out = outcome({ name: 'harness:identity', text: 'the old identity' }, replaceText('the new identity'))
  assert.equal(out.sections.length, 1)
  assert.equal(out.sections[0]?.text, 'the new identity')
  assert.equal(out.skippedEmpty, undefined)
})

test('replacing a NON-empty section WITH empty text deletes its text and is not a skip', () => {
  // The replacement text being empty is a legal, wanted outcome ("blank this
  // section out"); only an EMPTY TARGET is the guarded case. Conflating them
  // would make one of the two impossible to write.
  const out = outcome({ name: 'harness:identity', text: 'something' }, replaceText(''))
  assert.equal(out.sections[0]?.text, '')
  assert.equal(out.skippedEmpty, undefined)
})

test('the guard does not reach delete, prepend, append, wrap or transform', () => {
  // A `delete` of an empty section still removes it: that is what `delete` says,
  // and the guard is a statement about WRITING text, not about presence.
  assert.equal(outcome(EMPTY_SECTION, { kind: 'delete' }).sections.length, 0)

  // The three that keep the matched section still add their own around it.
  const prepended = outcome(EMPTY_SECTION, { kind: 'prepend', text: 'before' })
  assert.deepEqual(prepended.sections.map(section => section.name), ['tools:ptc-only~0~pre', 'tools:ptc-only'])
  assert.equal(prepended.sections[1]?.text, '')

  const appended = outcome(EMPTY_SECTION, { kind: 'append', text: 'after' })
  assert.deepEqual(appended.sections.map(section => section.name), ['tools:ptc-only', 'tools:ptc-only~0~post'])

  const wrapped = outcome(EMPTY_SECTION, { kind: 'wrap', prefix: '<', suffix: '>' })
  assert.deepEqual(wrapped.sections.map(section => section.name), ['tools:ptc-only~0~open', 'tools:ptc-only', 'tools:ptc-only~0~close'])

  // A transform over an empty text is a transform over the empty string: it runs,
  // keeps its own name and position, and is not a skip. (The op chosen is one that
  // leaves the empty text empty — `replaceText` deliberately refuses a pattern that
  // can match empty text, which is its own guard and not this one.)
  const transformed = outcome(EMPTY_SECTION, { kind: 'transform', transform: [{ op: 'dropLines', pattern: /x/, source: 'x' }] })
  assert.equal(transformed.sections[0]?.name, 'tools:ptc-only')
  assert.equal(transformed.sections[0]?.text, '')
  assert.equal(transformed.skippedEmpty, undefined)
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. the discipline holds on the skip path, and the loader knows the member
// ─────────────────────────────────────────────────────────────────────────────

test('the skip returns a NEW section object and never the input array', () => {
  const input = [EMPTY_SECTION]
  const out = outcome(EMPTY_SECTION, replaceText(ASSERTION))
  assert.notEqual(out.sections, input, 'the input array is never returned')
  assert.notEqual(out.sections[0], EMPTY_SECTION, 'a fresh object, not the matched one')
  assert.equal(input[0]?.text, '', 'the matched section was not edited in place')
  assert.deepEqual(out.sections[0], EMPTY_SECTION, 'and it carries the same name and text')
})

test('the skip keeps the members this package does not own', () => {
  const carried: SectionRecord = { name: 'tools:ptc-only', text: '', interpolate: false, 'x-other': { kept: true } }
  const out = outcome(carried, replaceText(ASSERTION))
  assert.equal(out.sections[0]?.['x-other'] !== undefined, true)
  assert.equal(out.sections[0]?.interpolate, false)
})

test('a text that is not a string is not an empty target, so the guard does not fire', () => {
  // This function is public, and `readSectionList` is what normally guarantees a
  // string. A caller reaching `applyAction` directly with something else gets the
  // action's text written — the behaviour before the guard existed — rather than a
  // TypeError out of the middle of a waterfall.
  const malformed = { name: 'tools:ptc-only', text: undefined as unknown as string }
  const out = applyAction(malformed, 0, replaceText(ASSERTION), undefined)
  assert.equal(out.skippedEmpty, undefined)
  assert.equal(out.sections[0]?.text, ASSERTION)
})

test('the skip survives the real pass: the compiled rules refuse a duplicate-name result', () => {
  // The output goes through the upstream invariant check like every other path,
  // so a guard that produced something malformed would be refused rather than
  // shipped. Here it is a plain one-section list and it passes.
  const rules = [ruleOf('zh-tools-ptc-only', 'tools:ptc-only', replaceText(ASSERTION))]
  const result = applyRules([EMPTY_SECTION], rules, 'refuse')
  assert.equal(result.ok, true)
})

/** Build a one-rule document the way the loader reads it. */
function document(action: Record<string, unknown>): unknown {
  return {
    version: 1,
    rules: [{ id: 'guard', match: { kind: 'exact', value: 'tools:ptc-only' }, action }],
  }
}

/** The compiled rule of a one-rule document, or a failure naming the reason. */
function compiledRule(action: Record<string, unknown>): SourceRule {
  const ruleSet = validateRuleSet(document(action), 'test.yaml')
  const rule = ruleSet.rules[0]
  if (rule === undefined) throw new Error('the document produced no rule')
  return rule
}

test('the loader carries allowEmpty through to the action, defaulting to absent', () => {
  assert.equal(compiledRule({ kind: 'replace', text: 'x' }).action.allowEmpty, undefined)
  assert.equal(compiledRule({ kind: 'replace', text: 'x', allowEmpty: true }).action.allowEmpty, true)
  assert.equal(compiledRule({ kind: 'replace', text: 'x', allowEmpty: false }).action.allowEmpty, false)
  // And a fragment action may carry it too.
  assert.equal(compiledRule({ kind: 'replace', fragments: [{ text: 'f' }], allowEmpty: true }).action.allowEmpty, true)
})

test('a compiled allowEmpty reaches the runtime through compileRules', () => {
  const compiled = compileRules([compiledRule({ kind: 'replace', text: ASSERTION, allowEmpty: true })])
  assert.equal(compiled.ok, true)
  if (!compiled.ok) return
  const result = applyRules([EMPTY_SECTION], compiled.rules, 'record')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.sections[0]?.text, ASSERTION)
})

test('the loader refuses a non-boolean allowEmpty, naming the rule and the file', () => {
  assert.throws(
    () => validateRuleSet(document({ kind: 'replace', text: 'x', allowEmpty: 'yes' }), 'test.yaml'),
    (error: unknown) => {
      assert.ok(error instanceof RuleFileError)
      assert.match(error.message, /^test\.yaml: rules\[0\]: "action\.allowEmpty" must be a boolean/)
      return true
    },
  )
})

test('the loader REFUSES allowEmpty on a kind that has no empty-section question', () => {
  for (const action of [
    { kind: 'delete', allowEmpty: true },
    { kind: 'prepend', text: 'x', allowEmpty: true },
    { kind: 'append', text: 'x', allowEmpty: true },
    { kind: 'wrap', prefix: '<', allowEmpty: true },
    { kind: 'transform', transform: [{ op: 'dropLines', pattern: 'x' }], allowEmpty: true },
  ]) {
    assert.throws(
      () => validateRuleSet(document(action), 'test.yaml'),
      /"action\.allowEmpty" is only meaningful on a "replace" action/,
      JSON.stringify(action.kind) + ' must refuse the switch rather than accept one that cannot fire',
    )
  }
})

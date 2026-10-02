/**
 * The rewrite pass itself: pure, total, and side-effect free.
 *
 * The waterfall contract this module answers to is narrow and unforgiving.
 * `system-prompt/assemble` is a waterfall whose returned value is authoritative
 * — `assemble` awaits it and returns it (`packages/core/system-prompt/src/index.ts:625-628`)
 * — so a listener that reads the sections and does not RETURN the value erases
 * the entire system prompt, its own change included. A listener that mutates a
 * section in place and returns the original array instead corrupts every other
 * holder of that reference. Both are the shape this module is written to make
 * impossible: it takes sections in, returns NEW arrays and NEW section objects
 * out, and never touches its input.
 *
 * It also knows what it must NOT touch. `assembly.variables`,
 * `assembly.contexts` and `assembly.tools` are returned by reference, unchanged.
 * That is not an oversight:
 *   - `variables.provider` and `variables.model` have live writers
 *     (`@deepseek-ai/dsh-agent`'s model selection), and `session-reference`
 *     reads both with `{ prepend: true }` at the outermost layer and PERSISTS
 *     what it read into the session's assembled routes, so a temporary or
 *     rewritten value written here would be recorded as fact.
 *   - `contexts` may be emptied wholesale after the waterfall by the runtime
 *     suppressor (`:629-634`, `contexts: runtimeContextSuppressed ? [] : …`); a
 *     rewrite there would be discarded silently.
 *   - `contexts` also carries `context.agent`, and other plugins assert on it;
 *     a plugin that drops it makes those assertions fire somewhere else.
 *
 * @module @t4r71/dsh-prompt-plan/rewrite
 */

import { applyAction } from './actions.ts'
import type { Action } from './actions.ts'
import { describeTransform } from './transform.ts'
import { compileMatcher, closestNames } from './naming.ts'
import type { Matcher } from './naming.ts'
import { checkSectionInvariants, describeInvariantFailures } from './sections.ts'
import type { SectionRecord } from './sections.ts'

/** One rule, compiled once per application. */
export interface CompiledRule {
  readonly id: string
  /** The matcher's own rendering, e.g. `regex /^tool[:_]/`. */
  readonly describeMatch: string
  /** The literal a diagnostic can measure a distance against; empty for a regex. */
  readonly diagnosticKey: string
  readonly test: (name: string) => boolean
  readonly action: Action
  readonly required: boolean
  readonly all: boolean
  readonly note?: string
}

/** What one rule did. */
export interface RuleTrace {
  readonly id: string
  readonly match: string
  readonly matched: readonly string[]
  readonly action: string
  readonly sectionsBefore: number
  readonly sectionsAfter: number
}

/** A refusal from the pass. */
export interface RewriteRefusal {
  readonly ruleId?: string
  readonly problem: string
}

/** The pass's result: either new sections, or the sentence explaining the refusal. */
export type RewriteOutcome =
  | { readonly ok: true; readonly sections: SectionRecord[]; readonly trace: readonly RuleTrace[]; readonly changed: boolean }
  | { readonly ok: false; readonly refusal: RewriteRefusal }

/**
 * Describe one rule's action for the trace and the error text.
 * @param action - the resolved action.
 * @returns a short human description.
 */
function describeAction(action: Action): string {
  switch (action.kind) {
    case 'replace':
      return action.fragments !== undefined && action.fragments.length > 0
        ? `replace with ${action.fragments.length} fragment(s)${action.splice === true ? ', spliced to the tail' : ''}`
        : `replace text (${(action.text ?? '').length} chars)`
    case 'delete':
      return 'delete'
    case 'prepend':
      return `prepend ${(action.text ?? '').length} chars`
    case 'append':
      return `append ${(action.text ?? '').length} chars`
    case 'wrap':
      return `wrap (prefix ${(action.prefix ?? '').length}, suffix ${(action.suffix ?? '').length})`
    case 'transform':
      return describeTransform(action.transform ?? [])
    default: {
      const exhaustive: never = action.kind
      return String(exhaustive)
    }
  }
}

/** One source rule, as the loader hands it over. */
export interface SourceRule {
  readonly id: string
  readonly match: Matcher
  readonly action: Action
  readonly required: boolean
  readonly all: boolean
  readonly note?: string
}

/** The outcome of compiling a rule list. */
export type CompileOutcome =
  | { readonly ok: true; readonly rules: CompiledRule[] }
  | { readonly ok: false; readonly problem: string }

/**
 * Compile a rule list once, refusing a matcher whose pattern does not compile.
 * @param rules - validated rules, in file order.
 * @returns the compiled list, or the sentence explaining the first failure.
 */
export function compileRules(rules: readonly SourceRule[]): CompileOutcome {
  const compiled: CompiledRule[] = []
  for (const rule of rules) {
    const matcher = compileMatcher(rule.match)
    if (!matcher.ok) return { ok: false, problem: `rule ${JSON.stringify(rule.id)}: ${matcher.problem}` }
    compiled.push({
      id: rule.id,
      describeMatch: matcher.describe,
      // Only the two literal kinds have a spelling worth measuring a distance
      // against; a regex has no single literal, so the "closest ten" hint falls
      // back to the nearest names seen at all.
      diagnosticKey: rule.match.kind === 'regex' ? '' : rule.match.value,
      test: matcher.test,
      action: rule.action,
      required: rule.required,
      all: rule.all,
      ...rule.note === undefined ? {} : { note: rule.note },
    })
  }
  return { ok: true, rules: compiled }
}

/**
 * Apply compiled rules to a section list.
 *
 * Rules are applied in file order, and each rule sees the output of the one
 * before it, so a rule may target a fragment a previous rule created — the
 * fragment names are deterministic (`fragmentName`), which is what makes that
 * safe to rely on. This is stated rather than implied because it is observable:
 * reordering the file can change the result.
 * @param sections - the incoming sections; never mutated.
 * @param rules - the compiled rules, in file order.
 * @param onUnmatched - whether an unmatched required rule refuses (`rewrite` mode) or is recorded (`observe` mode).
 * @returns the new sections plus a per-rule trace, or the refusal.
 */
export function applyRules(sections: readonly SectionRecord[], rules: readonly CompiledRule[], onUnmatched: 'refuse' | 'record'): RewriteOutcome {
  const names = sections.map(section => section.name)
  let current: SectionRecord[] = sections.map(section => ({ ...section }))
  const trace: RuleTrace[] = []
  let changed = false

  for (const rule of rules) {
    const matchedIndices: number[] = []
    for (let index = 0; index < current.length; index += 1) {
      const section = current[index]
      if (section !== undefined && rule.test(section.name)) {
        matchedIndices.push(index)
        if (!rule.all) break
      }
    }

    if (matchedIndices.length === 0) {
      if (rule.required && onUnmatched === 'refuse') {
        const nearest = closestNames(rule.diagnosticKey, names, 10)
        return {
          ok: false,
          refusal: {
            ruleId: rule.id,
            problem: [
              `rule ${JSON.stringify(rule.id)} (match ${rule.describeMatch}) matched no section in this assembly, and it is required.`,
              nearest.length === 0
                ? 'This assembly carries no sections at all.'
                : `The ${nearest.length} closest section names present: ${nearest.map(name => JSON.stringify(name)).join(', ')}.`,
              'If the section is only registered under some conditions, set "required: false" on this rule.',
            ].join(' '),
          },
        }
      }
      trace.push({
        id: rule.id,
        match: rule.describeMatch,
        matched: [],
        action: describeAction(rule.action),
        sectionsBefore: current.length,
        sectionsAfter: current.length,
      })
      continue
    }

    const before = current.length
    const matchedNames = matchedIndices.map(index => current[index]?.name ?? `#${index}`)
    const next: SectionRecord[] = []
    const spliced: SectionRecord[] = []
    const matchedSet = new Set(matchedIndices)
    for (let index = 0; index < current.length; index += 1) {
      const section = current[index]
      if (section === undefined) continue
      if (!matchedSet.has(index)) {
        next.push(section)
        continue
      }
      const outcome = applyAction(section, index, rule.action, section.interpolate)
      if (outcome.splice) spliced.push(...outcome.sections)
      else next.push(...outcome.sections)
    }
    current = [...next, ...spliced]
    changed = true

    trace.push({
      id: rule.id,
      match: rule.describeMatch,
      matched: matchedNames,
      action: describeAction(rule.action),
      sectionsBefore: before,
      sectionsAfter: current.length,
    })
  }

  // The upstream assertions, carried by this package because the desktop
  // composition does not mount the companion that owns them. Running them on
  // THIS package's output is the point: a rule that produces a duplicate name or
  // a non-string text is caught here, before the prompt reaches the model.
  const failures = checkSectionInvariants(current)
  if (failures.length > 0) {
    return {
      ok: false,
      refusal: {
        problem: `the rewritten section list violates the upstream assembly invariants: ${describeInvariantFailures(failures)}`,
      },
    }
  }

  return { ok: true, sections: current, trace, changed }
}

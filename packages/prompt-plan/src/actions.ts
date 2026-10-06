/**
 * Rule actions: what a matched section becomes.
 *
 * Every action produces a NEW section object. Nothing here edits a section in
 * place, and nothing here returns the input array — the caller owns the
 * expansion. That is the whole of this module's discipline.
 *
 * `splice: true` is the escape hatch that makes a scoped replacement possible
 * WITHOUT the upstream same-name mechanism: the standard replacement is a scoped
 * registration under the same name (a scoped section shadows a global one, see
 * `packages/core/system-prompt/src/index.ts:448-451` and `:576`), but a rule
 * file cannot register sections. A splice removes the matched section and
 * appends fragments under names the author chooses, which reaches the same
 * outcome from the rewrite side. It is opt-in per rule because it is the only
 * action that changes the number of sections.
 *
 * AN EMPTY SECTION IS NOT A PLACE TO WRITE, and `replace` therefore leaves it
 * alone by default. Sections are emptied ON PURPOSE upstream, by the module that
 * owns them: `tools:ptc-only` collapses to the empty string whenever the
 * deployment is not in PTC mode (`dsh-tools/lib/index.js`, `collapseSection`;
 * its own comment reads "both renders empty: native calls do execute there, so
 * the rule is false"), `context:file-reference` is empty whenever no `read` tool
 * is mounted, and `harness:identity` is empty when the deployment turns it off.
 * `dsh-system-prompt` then DROPS every empty section (`.filter((text) =>
 * text.length > 0)`), so an empty section is the upstream module saying "this
 * deployment does not want this section" — and filling it puts a statement into
 * the prompt that nothing in the running composition stands behind. A rule that
 * really does mean to fill an empty section says so with `allowEmpty: true`, so
 * the intent is written down instead of being the default.
 *
 * @module @t4r71/dsh-prompt-plan/actions
 */

import { SECTION_NAME_SEPARATOR } from './naming.ts'
import type { SectionRecord } from './sections.ts'
import { applyTransform } from './transform.ts'
import type { TransformOp } from './transform.ts'

/** The six actions one rule may name. */
export type ActionKind = 'replace' | 'delete' | 'prepend' | 'append' | 'wrap' | 'transform'

/** The closed set, for validation and for the settings page. */
export const ACTION_KINDS: readonly ActionKind[] = ['replace', 'delete', 'prepend', 'append', 'wrap', 'transform']

/** One fragment of an action's payload. */
export interface Fragment {
  /** The fragment's text. */
  readonly text: string
}

/** A resolved action, after schema validation. */
export interface Action {
  readonly kind: ActionKind
  /** `replace`/`prepend`/`append`/`wrap`: the text or fragments they use. */
  readonly text?: string
  readonly prefix?: string
  readonly suffix?: string
  readonly fragments?: readonly Fragment[]
  /**
   * `replace` only: write into the matched section even when its text is EMPTY.
   *
   * A policy member on the ACTION rather than on the rule, next to `splice` and
   * for the same reason: it is a statement about what THIS replacement does, and
   * it means nothing for `delete`, `prepend`, `append`, `wrap` or `transform` —
   * so the loader refuses it on those kinds instead of accepting a switch that
   * could never fire. Absent (the default) means the guard is on: an empty
   * section stays empty and the skip is recorded in the trace.
   */
  readonly allowEmpty?: boolean
  /**
   * `replace` only: remove the matched section and append the fragments AFTER
   * every section that survived, instead of leaving them at the matched position.
   */
  readonly splice?: boolean
  /**
   * `transform` only: the shape-preserving operations, applied in order to the
   * text THIS scope's assembly resolved. Never empty — a rule that names no
   * operation is refused by the loader rather than accepted as a no-op.
   */
  readonly transform?: readonly TransformOp[]
}

/**
 * Name the section a fragment becomes.
 *
 * Derived from the matched section's name rather than read from the rule so that
 * two rules cannot collide by accident, and so the fragment is recognisable in a
 * later observation as "this came from that". Duplicate registration upstream
 * throws (`PromptLayer`'s `NamedEntries`), so a collision here would be a boot
 * failure rather than a quiet override.
 * @param sourceName - the matched section's name.
 * @param sourceIndex - its position, so two rules on the same name differ.
 * @param part - the fragment's role (`pre`, `post`, or its 0-based number).
 * @returns the fragment's section name.
 */
export function fragmentName(sourceName: string, sourceIndex: number, part: string): string {
  return `${sourceName}${SECTION_NAME_SEPARATOR}${sourceIndex}${SECTION_NAME_SEPARATOR}${part}`
}

/** One action's outcome: the sections replacing the matched one, and whether they move to the tail. */
export interface ActionOutcome {
  /** The sections that take the matched section's place, in order. Empty for `delete`. */
  readonly sections: readonly SectionRecord[]
  /** Whether the caller must append {@link ActionOutcome.sections} at the end instead of in place. */
  readonly splice: boolean
  /**
   * The empty-section guard fired: the matched section's text was empty, the
   * action's text was not, and the rule did not opt in with `allowEmpty`.
   *
   * The caller does NOT branch on it — {@link ActionOutcome.sections} already
   * carries the right answer (the section, unchanged). It is here so that "this
   * rule matched and did nothing, on purpose" can be said out loud in the trace
   * instead of being indistinguishable from a rule that changed nothing because
   * its text happened to equal the section's.
   */
  readonly skippedEmpty?: boolean
}

/**
 * Apply one action to one matched section.
 * @param section - the matched section, by value.
 * @param index - its position in the assembly.
 * @param action - the resolved action.
 * @param interpolate - the matched section's `interpolate` flag, inherited by fragments.
 * @returns the sections that replace it.
 */
export function applyAction(section: SectionRecord, index: number, action: Action, interpolate: boolean | undefined): ActionOutcome {
  const inherit = interpolate === undefined ? {} : { interpolate }
  // A fragment keeps the matched section's unknown members (B2's expansion rule)
  // except name/text, which the action defines.
  const carried: Record<string, unknown> = { ...section }
  delete carried.name
  delete carried.text
  delete carried.interpolate

  const fragments = (names: readonly string[], texts: readonly string[]): SectionRecord[] =>
    names.map((name, offset) => ({
      ...carried,
      name,
      text: texts[offset] ?? '',
      ...inherit,
    }))

  switch (action.kind) {
    case 'replace': {
      // THE EMPTY-SECTION GUARD, and why it is FIRST and covers BOTH forms.
      //
      // The text form and the fragments form write into the same place, so a
      // guard that only covered the text form would leave the hole open one
      // spelling over: fragments replace the section with derived-named ones, so
      // the empty section's position would reappear carrying content the section
      // itself was emptied to suppress. `allowEmpty` is the one switch that turns
      // either form back on.
      //
      // The action's own text being empty is NOT a skip: the result is then the
      // section itself, so recording it would be noise rather than a finding.
      //
      // The test is deliberately `typeof … === 'string' && length === 0` rather
      // than a bare `length === 0`: this function is public, and a caller that
      // hands it a section whose `text` is not a string gets the old behaviour
      // (the action's text is written) instead of a TypeError. Only a REAL empty
      // string is the deployment's deliberate emptiness.
      const emptyTarget = typeof section.text === 'string' && section.text.length === 0
      const producesText = action.fragments !== undefined && action.fragments.length > 0
        || (action.text ?? '').length > 0
      if (!producesText || !emptyTarget || action.allowEmpty === true) {
        if (action.fragments !== undefined && action.fragments.length > 0) {
          const names = action.fragments.map((_fragment, offset) => fragmentName(section.name, index, String(offset)))
          const texts = action.fragments.map(fragment => fragment.text)
          return { sections: fragments(names, texts), splice: action.splice === true }
        }
        // `replace` without fragments replaces the TEXT. The name is kept only
        // when the rule is not spliced — a spliced replacement needs a name the
        // rule's overlay can shadow, and a same-name copy at a different position
        // would be two sections with one name, which upstream refuses.
        const text = action.text ?? ''
        return {
          sections: [{ ...carried, name: section.name, text, ...inherit }],
          splice: false,
        }
      }
      // The guard fired. The section comes back as a NEW object carrying the text
      // it already had — the module's discipline (never in place, never the input
      // array) holds on this path as much as on the writing ones.
      return {
        sections: [{ ...carried, name: section.name, text: '', ...inherit }],
        splice: false,
        skippedEmpty: true,
      }
    }
    case 'delete':
      return { sections: [], splice: false }
    case 'transform': {
      // THE POINT OF THIS ACTION: the text is taken from the section as THIS
      // assembly resolved it, transformed in place, and kept under the same name
      // at the same position. Nothing about the section's identity changes, so a
      // per-scope `text` function still produces a per-scope result.
      const source = typeof section.text === 'string' ? section.text : ''
      const transformed = applyTransform(source, action.transform ?? [])
      return {
        sections: [{ ...carried, name: section.name, text: transformed, ...inherit }],
        splice: false,
      }
    }
    case 'prepend':
      return {
        sections: [
          ...fragments([fragmentName(section.name, index, 'pre')], [action.text ?? '']),
          section,
        ],
        splice: false,
      }
    case 'append':
      return {
        sections: [
          section,
          ...fragments([fragmentName(section.name, index, 'post')], [action.text ?? '']),
        ],
        splice: false,
      }
    case 'wrap':
      return {
        sections: [
          ...fragments([fragmentName(section.name, index, 'open')], [action.prefix ?? '']),
          section,
          ...fragments([fragmentName(section.name, index, 'close')], [action.suffix ?? '']),
        ],
        splice: false,
      }
    default: {
      const exhaustive: never = action.kind
      throw new Error(`prompt-plan: unknown action ${JSON.stringify(exhaustive)}`)
    }
  }
}

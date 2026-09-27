/**
 * The model-facing text of the two access axes: ONE source for both the
 * runtime-context paragraph the model reads before it acts and the refusal a
 * fence returns when it acts anyway.
 *
 * Why one module: the paragraph and the refusal must state the same range. Two
 * hand-written copies drift, and the drift is invisible — the model would plan
 * against one boundary in its context and be denied by a different one. Both
 * callers therefore call {@link renderAxisRange} for the range sentence and
 * share {@link NO_BYPASS} and {@link WIDENING_EXIT} verbatim; neither string is
 * spelled anywhere else in this package.
 *
 * Both callers feed it only session-log facts plus the group definitions the
 * log's ids resolve against: the axis preset is the `dual-axis/scopes` fold (the
 * projection unit), the workspace root is the session header's `cwd`, and the
 * group library is the settings row's `groups` field. Nothing here reads ambient
 * state of its own, so the rendered text is reconstructable from the log and
 * that library.
 *
 * @module @t4r71/dsh-dual-axis/scope-prompt
 */

import type { AxisScope } from './axis.ts'
import type { EffectiveAxes, WriteNarrowing } from './groups.ts'
import { resolveScope } from './scope.ts'

/**
 * The sentence naming what is NOT a way around a refusal. Three facts, all of
 * which the model otherwise has to guess: the denial is the session's rule
 * rather than the calling tool's limitation; where each axis is enforced; and
 * that the two axes are layered differently.
 *
 * The layering is stated per axis because asserting it for the whole fence
 * would be false. `read-guard.ts` enforces the read axis and the allow/deny
 * path entries of the effective write range at the tool-dispatch layer, and the
 * write BASE tier a second time below it: `session-axes.ts` mirrors the
 * narrower of the two bases onto the session `sandbox/mode`, which the command
 * tools themselves run under. An effective write range based on `all` mirrors
 * to `danger-full-access`, so for that base there is no layer below the tool
 * layer at all.
 */
export const NO_BYPASS = 'This is not a limitation of the tool you called: switching to another tool, spawning a child '
  + 'process, writing a script, or calling a command tool does not make the path allowed — reaching it by any other '
  + 'route is still a violation of the session rule. The fence is also not one layer, but the layers differ per '
  + 'axis: the read axis, and the allow/deny PATH entries of the effective write range, are enforced at the tool '
  + 'layer, and bind only the tools that layer sees. The BASE tier of the effective write range — the narrower of '
  + 'the two axes\' bases — is enforced a second time below the tool layer: it is mirrored onto the session sandbox '
  + 'mode that the command tools themselves run under, so a "workspace" or "deny" base keeps holding for a shell '
  + 'command. An effective write range based on "all" mirrors to no sandbox restriction at all, so nothing below '
  + 'the tool layer holds it.'

/**
 * The sentence naming the only two compliant moves. Both are user-facing, so it
 * names where the user acts: the settings page row and the two composer
 * dropdowns are the two surfaces that write the same session axes.
 */
export const WIDENING_EXIT = 'The only compliant moves are: (1) complete the task inside the allowed range above, or '
  + '(2) ask the user to widen that axis for this session — the settings page lists the dual-axis row, and the two '
  + 'dropdowns above the composer switch the same two axes.'

/** Render one path list for the model; an empty list is stated, never left blank. */
function renderRoots(roots: readonly string[]): string {
  return roots.length === 0 ? '(none)' : JSON.stringify(roots)
}

/**
 * Render one axis as the concrete places it permits and forbids, with the
 * configured entries already resolved to canonical absolute roots.
 *
 * A model plans against directories, not at mode names: `workspace` alone
 * leaves it guessing whether the platform temp areas count, and `custom`
 * leaves it guessing which paths were added or removed. {@link resolveScope}
 * answers both, so this prints its result instead of the axis value.
 *
 * A `custom` axis whose entries cannot be resolved (a foreign or hand-edited
 * log carrying a relative path, which `ScopeConfigError` refuses) is stated as
 * permitting nothing rather than throwing: the paragraph must not fail the
 * whole assembly, and a range that cannot be evaluated must never read as a
 * wider one.
 * @param axis - the axis value in force.
 * @param workspaceRoot - the session workspace root a `workspace` and `custom` axis resolve against.
 * @returns the range sentence, e.g. `kind custom; allowed roots: ["C:\\ws"]; denied roots: ["C:\\ws\\secret"] (a denied path always wins)`.
 */
export function renderAxisRange(axis: AxisScope, workspaceRoot: string): string {
  let resolved: ReturnType<typeof resolveScope>
  try {
    resolved = resolveScope(axis, { workspaceRoot })
  } catch (error) {
    // Keep the try to one statement; only a malformed custom entry reaches here.
    const reason = error instanceof Error ? error.message : String(error)
    return `kind ${axis.kind}; the configured entries could not be resolved (${reason}), so no path is known to be allowed`
  }
  const allowed = resolved.unbounded
    ? 'every path on this host except the denied roots below'
    : renderRoots(resolved.allow)
  const denied = resolved.deny.length === 0
    ? renderRoots(resolved.deny)
    : `${renderRoots(resolved.deny)} (a denied path always wins)`
  return `kind ${axis.kind}; allowed roots: ${allowed}; denied roots: ${denied}`
}

/**
 * The sentence reporting what the write-never-exceeds-read invariant removed.
 *
 * Stated because the removal is otherwise invisible: a rule group that grants
 * write access to a directory the read axis does not cover grants nothing, and a
 * user who cannot see that concludes the rule was ignored. Empty when the
 * intersection removed nothing, so a session that narrowed nothing is not
 * warned about a narrowing that did not happen.
 * @param narrowing - what the resolution removed from the write axis.
 * @returns the sentence, or the empty string when nothing was removed.
 */
export function renderNarrowing(narrowing: WriteNarrowing): string {
  if (!narrowing.narrowed) return ''
  const parts: string[] = []
  if (narrowing.droppedRoots.length > 0) {
    parts.push(`the read axis removed ${renderRoots(narrowing.droppedRoots)} from it`)
  }
  if (narrowing.lostUnbounded) {
    parts.push('it was unbounded, and the read range is now its entire bound')
  }
  return 'The read axis narrowed this write range: ' + parts.join(', and ') + '. '
    + 'A write axis or rule group naming a path outside the read range grants nothing there — the write is '
    + 'refused, not silently allowed.'
}

/**
 * The runtime-context paragraph naming both axes as they stand for one session.
 *
 * The write member is the EFFECTIVE write range: the write axis with every
 * referenced group expanded, intersected with the read axis, and the intersection
 * is stated rather than left for the model to infer. A model that assumed the
 * write axis stood alone would plan writes the session refuses; one that assumed
 * the intersection without being told would refuse work the axes permit.
 * @param axes - the effective axis pair for the session.
 * @param workspaceRoot - the session's workspace root.
 * @returns the paragraph, ready to be contributed as one runtime-context entry.
 */
export function renderScopePrompt(axes: EffectiveAxes, workspaceRoot: string): string {
  const narrowing = renderNarrowing(axes.narrowing)
  return 'Current DSH file access axes for this session: '
    + `read — ${renderAxisRange(axes.read, workspaceRoot)}; `
    + `write — ${renderAxisRange(axes.write, workspaceRoot)}. `
    + 'A read outside the read axis is refused, and a modification outside the write axis is refused. The write '
    + 'range above is the write axis INTERSECTED with the read axis: a write is never permitted outside the read '
    + 'range, so a directory the read axis does not cover stays unwritable even when the write axis or one of its '
    + 'rule groups names it. '
    + (narrowing === '' ? '' : narrowing + ' ')
    + NO_BYPASS + ' ' + WIDENING_EXIT
}

/**
 * The notice stating that a session's axis preset could not be resolved, so no
 * path is known to be allowed.
 *
 * Rendered both into the prompt and into a refusal, from this one source: an
 * unresolvable reference — a rule group deleted while a session still references
 * it — must fail closed everywhere it is met, and must say which id is missing
 * rather than behaving like a group that allows nothing in particular.
 * @param problem - the resolution failure, naming the offending id.
 * @returns the model-facing notice.
 */
export function unresolvedAxesNotice(problem: string): string {
  return 'This session\'s file access axes could not be resolved, so no path is known to be allowed: ' + problem
    + '. The reference is refused rather than read as an empty rule group, because a rule that silently does '
    + 'nothing is worse than a refusal. ' + WIDENING_EXIT
}

/** What one refusal has to name. */
export interface ScopeRefusal {
  /** The refused path, as the model spelled it or as the caller resolved it. */
  readonly displayPath: string
  /** Which axis refused. */
  readonly axis: 'read' | 'write'
  /**
   * The refusing range's value. A write refusal carries the EFFECTIVE write
   * range, so the refusal states the boundary the session actually enforces
   * rather than the write axis it was derived from.
   */
  readonly scope: AxisScope
  /** The workspace root that axis resolves against. */
  readonly workspaceRoot: string
  /**
   * What the read axis removed from the write range, when the refusal is a
   * write. Stated on the refusal as well as in the prompt: the model is told why
   * the write axis it was given does not reach this path.
   */
  readonly narrowing?: WriteNarrowing
}

/**
 * The refusal a fence returns for one path, built from the same range sentence
 * the prompt uses.
 * @param input - the refused path, the axis that refused it, and the root it resolves against.
 * @returns the model-facing refusal text.
 */
export function scopeRefusal(input: ScopeRefusal): string {
  const narrowing = input.axis === 'write' && input.narrowing !== undefined
    ? renderNarrowing(input.narrowing)
    : ''
  return `Access denied: ${JSON.stringify(input.displayPath)} is outside this session's ${input.axis} axis. `
    + `${input.axis} axis in force — ${renderAxisRange(input.scope, input.workspaceRoot)}. `
    + (narrowing === '' ? '' : narrowing + ' ')
    + NO_BYPASS + ' ' + WIDENING_EXIT
}

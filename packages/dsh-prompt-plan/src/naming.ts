/**
 * The rule file's matching vocabulary: three match kinds, spelled explicitly in
 * every rule.
 *
 * WHY EXPLICIT, RATHER THAN INFERRED FROM THE PATTERN. The section names this
 * package targets come in two families. Ordinary sections are registered under
 * plain literals (`harness:identity`, `deployment:persona-prefix`). Template
 * sections are registered by tools that carry their own parameters, so their
 * names are built rather than written — `tool:workflow`, `tool:subagent`,
 * `mcp:<server>` — and a literal can never match them. Inferring which family a
 * key belongs to from its spelling ("does it contain a colon?") would be a guess
 * that breaks the moment a new tool spells its section differently. The rule
 * therefore SAYS which kind it is, and this module is the only place that
 * interprets the three spellings.
 *
 * NEITHER the section object NOR the assembly carries the rule file's names:
 * matching is over `section.name` as the registry registered it. Nothing here
 * consults array position, because placement is not on the wire either — the
 * assembled section has no `order` member.
 *
 * @module @t4r71/dsh-prompt-plan/naming
 */

/** Separator used when an action derives a fragment's section name. */
export const SECTION_NAME_SEPARATOR = '~'

/** The three match kinds a rule may declare. */
export type MatchKind = 'exact' | 'prefix' | 'regex'

/** The closed set, for validation and for the settings page. */
export const MATCH_KINDS: readonly MatchKind[] = ['exact', 'prefix', 'regex']

/** One rule's matcher, after validation. */
export interface Matcher {
  readonly kind: MatchKind
  /** The literal name, the prefix, or the regular-expression source. */
  readonly value: string
}

/** The outcome of compiling one matcher. */
export type MatcherCompile =
  | { readonly ok: true; readonly test: (name: string) => boolean; readonly describe: string }
  | { readonly ok: false; readonly problem: string }

/**
 * Compile one matcher into a predicate.
 *
 * `prefix` matches on the exact string prefix, NOT on a segment boundary: a rule
 * with `prefix: "tool"` matches `tool:workflow` and also `toolchest:whatever`.
 * That is deliberate — narrowing it to `:tool:` boundaries would silently stop
 * matching a section named exactly `tool`, and a rule that quietly stops
 * matching is the failure mode this package's `required` semantics exist to
 * prevent. Use `regex: "^tool[:_]"` when a boundary is what you mean.
 *
 * A `regex` matcher is compiled WITHOUT the global flag, so its `test` holds no
 * `lastIndex` state and is safe to call repeatedly against the same instance.
 * @param matcher - the validated matcher.
 * @returns the predicate, or the sentence explaining why the pattern is unusable.
 */
export function compileMatcher(matcher: Matcher): MatcherCompile {
  switch (matcher.kind) {
    case 'exact': {
      if (matcher.value.length === 0) {
        return { ok: false, problem: 'an exact matcher needs a non-empty section name' }
      }
      return { ok: true, test: name => name === matcher.value, describe: `exact ${JSON.stringify(matcher.value)}` }
    }
    case 'prefix': {
      if (matcher.value.length === 0) {
        return { ok: false, problem: 'a prefix matcher needs a non-empty prefix' }
      }
      return { ok: true, test: name => name.startsWith(matcher.value), describe: `prefix ${JSON.stringify(matcher.value)}` }
    }
    case 'regex': {
      if (matcher.value.length === 0) {
        return { ok: false, problem: 'a regex matcher needs a non-empty pattern' }
      }
      let pattern: RegExp
      try {
        pattern = new RegExp(matcher.value)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return { ok: false, problem: `regex ${JSON.stringify(matcher.value)} does not compile: ${reason}` }
      }
      return { ok: true, test: name => pattern.test(name), describe: `regex /${matcher.value}/` }
    }
    default: {
      const exhaustive: never = matcher.kind
      return { ok: false, problem: `unknown match kind ${JSON.stringify(exhaustive)}` }
    }
  }
}

/** Levenshtein edit distance, iterative, two rows — small inputs only (section names). */
function editDistance(left: string, right: string): number {
  if (left === right) return 0
  if (left.length === 0) return right.length
  if (right.length === 0) return left.length
  let previous = Array.from({ length: right.length + 1 }, (_unused, index) => index)
  for (let i = 1; i <= left.length; i += 1) {
    const current: number[] = [i]
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1)
      const insertion = (current[j - 1] ?? 0) + 1
      const deletion = (previous[j] ?? 0) + 1
      current.push(Math.min(substitution, insertion, deletion))
    }
    previous = current
  }
  return previous[right.length] ?? 0
}

/**
 * The section names closest to a key that matched nothing, nearest first.
 *
 * A section name is a long path-like literal, and a rule that does not match is
 * almost always a typo in one segment of it. Printing the distance-ordered
 * candidates turns that from a hunt through an artifact file into a one-line
 * fix. Ordering is (edit distance, then name) so two equally close candidates
 * come out in a stable, locale-independent order.
 * @param needle - the key that matched nothing.
 * @param names - the section names actually present in this assembly.
 * @param limit - how many to keep.
 * @returns at most `limit` names, nearest first; empty when there are none.
 */
export function closestNames(needle: string, names: readonly string[], limit: number): string[] {
  const unique = [...new Set(names)]
  unique.sort((left, right) => {
    const byDistance = editDistance(needle, left) - editDistance(needle, right)
    return byDistance !== 0 ? byDistance : (left < right ? -1 : left > right ? 1 : 0)
  })
  return unique.slice(0, limit)
}

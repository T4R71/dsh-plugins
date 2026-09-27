/**
 * The shared path-range ALGEBRA behind both access axes: one pure evaluation
 * from an {@link AxisScope} to the canonical allow and deny root sets the
 * fence consumes.
 *
 * This is the 0.1.7 port of 0.1.6's `@deepseek-ai/dsh-sandbox/scope`
 * (152 lines), reduced to what a fence needs and made source-agnostic:
 *
 * - `workspace` derives its roots from 0.1.7's own
 *   `writableRoots(policy)` (`@deepseek-ai/dsh-sandbox`, re-exported from
 *   `packages/sandbox/sandbox/src/roots.ts:52`), so the fence agrees with
 *   the Seatbelt profile and the write fence by construction.
 * - Containment itself is NOT evaluated here. 0.1.6 took the enforcement
 *   layer's `contains` predicate as a parameter; this port keeps that shape
 *   but narrows it to the SYNCHRONOUS lexical predicate the pure tests use,
 *   and the filesystem-identity fallback lives in the fence
 *   (`fs-fence.ts`), which is where the canonical target key exists.
 *
 * `resolveScope` returns the sets; the fence applies them with deny-wins
 * precedence through {@link scopeContains}.
 *
 * @module @t4r71/dsh-dual-axis/scope
 */

import { sep } from 'node:path'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { AxisBase, AxisScope } from './axis.ts'

/** The scope inputs that do not depend on the session: just its workspace root. */
export interface ScopePolicy {
  /** Absolute root `workspace` scopes derive from. */
  workspaceRoot: string
}

/**
 * One axis's evaluated range. Both sets hold canonical absolute paths; an
 * empty `allow` means "nothing is permitted" unless {@link unbounded} is set,
 * because the fence treats the allow-list as exhaustive.
 */
export interface ResolvedScope {
  /**
   * Whether this axis permits everything except {@link deny} — the `all` base.
   * A flag, NOT a root path: "no containing boundary" cannot be spelled as a
   * path. `canonicalPath('/')` resolves to the CURRENT DRIVE's root on Windows
   * (measured: `M:\` for a session on `M:`), which would silently restrict an
   * unbounded axis to one volume and deny every other drive — the exact
   * opposite of what the axis means. Representing it as a path also cannot
   * survive {@link scopeContains}'s identity comparisons, which are per-volume.
   */
  unbounded: boolean
  /** Roots this axis permits (the target must be one of them or lie beneath one); ignored when {@link unbounded}. */
  allow: readonly string[]
  /** Roots this axis forbids even when an allow root contains them — removal wins. */
  deny: readonly string[]
}

/** Thrown when a configured `custom` scope entry cannot name an absolute path. */
export class ScopeConfigError extends Error {
  constructor(
    /** Which custom entry was malformed (`allow` or `deny`). */
    readonly entry: 'allow' | 'deny',
    /** The offending value as configured. */
    readonly value: string,
  ) {
    super(`sandbox scope: \`${entry}\` entry ${JSON.stringify(value)} must be a non-empty absolute path`)
    this.name = 'ScopeConfigError'
  }
}

/** Canonicalize one configured custom entry, failing closed on anything that cannot name an absolute host path. */
function canonicalEntry(value: string, entry: 'allow' | 'deny'): string {
  // Absolute-ness is checked on the SPELLING before resolution, so a relative
  // entry fails loudly instead of silently resolving against process.cwd() and
  // granting a directory the user never named.
  if (value.trim().length === 0 || !isAbsoluteSpelling(value)) throw new ScopeConfigError(entry, value)
  return canonicalPath(value)
}

/**
 * Whether a configured path is spelled absolutely on this host. Both POSIX
 * (`/x`) and Windows (`C:\\x`, `\\\\server\\share`) spellings are accepted
 * because a policy may be authored for one world and resolved in another; the
 * canonical resolution that follows is what actually binds it to this host.
 * @param path - the configured path spelling.
 * @returns whether the spelling is absolute.
 */
export function isAbsoluteSpelling(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/**
 * Evaluate one axis against a workspace root. `deny` permits nothing;
 * `workspace` yields the shared writable roots; `all` is unbounded;
 * `custom` yields its base plus its own additions, with its removals listed
 * separately so the fence can apply them with precedence.
 *
 * A `custom` scope whose base is `all` stays unbounded: "everything except
 * these directories" is still everything-except, so its removals must survive
 * into {@link ResolvedScope.deny} rather than being flattened into an allow
 * list that could not express them.
 * @param scope - the axis value.
 * @param policy - the workspace root `workspace` and `custom` scopes resolve against.
 * @returns the evaluated range.
 * @throws {ScopeConfigError} when a `custom` entry is not a non-empty absolute path.
 */
export function resolveScope(scope: AxisScope, policy: ScopePolicy): ResolvedScope {
  if (scope.kind !== 'custom') return resolveBase(scope.kind, policy)
  const base = resolveBase(scope.base, policy)
  const allow = [...base.allow, ...scope.allow.map(entry => canonicalEntry(entry, 'allow'))]
  const deny = scope.deny.map(entry => canonicalEntry(entry, 'deny'))
  return { unbounded: base.unbounded, allow: dedupe(allow), deny: dedupe(deny) }
}

/** Evaluate a base (or closed) kind — the shared half of {@link resolveScope}. */
function resolveBase(base: AxisBase, policy: ScopePolicy): ResolvedScope {
  switch (base) {
    case 'deny': return { unbounded: false, allow: [], deny: [] }
    case 'workspace': {
      // `writableRoots` gates on the mode, so this asks it for the
      // workspace-write answer regardless of which axis is being evaluated: the
      // scope kind, not the policy's committed write mode, is the question here.
      const roots = writableRoots({ mode: 'workspace-write', workspaceRoot: policy.workspaceRoot })
      return { unbounded: false, allow: dedupe(roots), deny: [] }
    }
    case 'all': return { unbounded: true, allow: [], deny: [] }
  }
}

/** Stable-order dedupe: keeps the first spelling of each value. */
function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/**
 * Whether `target` is the root itself or lies beneath it, by canonical
 * spelling. Case-insensitive on Windows, matching that filesystem's
 * convention.
 * @param target - canonical target path.
 * @param root - canonical root path.
 * @param caseSensitive - whether lexical comparison preserves case; defaults to the host convention.
 * @returns whether the target is the root or a descendant of it.
 */
export function isLexicallyUnder(
  target: string,
  root: string,
  caseSensitive = process.platform !== 'win32',
): boolean {
  const comparableTarget = caseSensitive ? target : target.toLowerCase()
  const comparableRoot = caseSensitive ? root : root.toLowerCase()
  if (comparableTarget === comparableRoot) return true
  const prefix = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep
  return comparableTarget.startsWith(prefix)
}

/**
 * Whether `targetKey` is permitted by an evaluated scope. Removal wins over
 * addition: a deny root containing the target refuses it even when an allow
 * root — or an unbounded axis — would otherwise permit it.
 * @param scope - the evaluated scope.
 * @param targetKey - the target's canonical identity key (the resolved path).
 * @param contains - the containment predicate; defaults to {@link isLexicallyUnder}.
 * @returns whether the scope permits the target.
 */
export function scopeContains(
  scope: ResolvedScope,
  targetKey: string,
  contains: (path: string, root: string) => boolean = isLexicallyUnder,
): boolean {
  for (const root of scope.deny) {
    if (contains(targetKey, root)) return false
  }
  if (scope.unbounded) return true
  for (const root of scope.allow) {
    if (contains(targetKey, root)) return true
  }
  return false
}

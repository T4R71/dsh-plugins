/**
 * The read/write ACCESS AXES of the file sandbox: the per-axis vocabulary a
 * session selects and the lossless mapping onto the legacy single `mode`.
 *
 * This is the 0.1.7 port of the algebra upstream deleted. 0.1.6 shipped it as
 * `@deepseek-ai/dsh-sandbox/access` (152 lines) and
 * `@deepseek-ai/dsh-sandbox/scope` (152 lines); 0.1.7 has neither symbol nor
 * file, so the package carries its own copy and keeps the 0.1.6 semantics
 * verbatim: four kinds, `custom` = base + allow - deny with deny winning.
 *
 * One axis answers "which absolute paths may this execution touch". `deny`
 * permits nothing, `workspace` permits the calling session's workspace root
 * plus the platform temp areas, `all` is the whole host filesystem, and
 * `custom` names a BASE kind plus absolute path ADDITIONS and REMOVALS —
 * path lists, not patterns.
 *
 * `mode` REMAINS the write axis's persistence spelling. The session-format
 * whitelist pins its literal values, so this module keeps `mode` derivable
 * from the write scope in both directions instead of replacing it:
 * {@link scopeOfMode} and {@link modeOfScope} are the two halves of that
 * bijection, and `custom` maps onto the mode implied by its own base.
 *
 * @module @t4r71/dsh-dual-axis/axis
 */

import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'

/**
 * One axis's kind. `deny` touches nothing; `workspace` is the session's
 * workspace plus the platform temp areas; `all` is the host filesystem;
 * `custom` carries additions and removals over a `base`.
 */
export type AxisScopeKind = 'deny' | 'workspace' | 'all' | 'custom'

/** The comparison base a `custom` scope adds to and removes from. */
export type AxisBase = 'deny' | 'workspace' | 'all'

/**
 * One axis's complete value. The three closed kinds carry no payload;
 * `custom` carries the absolute paths its selection adds (`allow`) and the
 * absolute paths it removes even from the base (`deny`). Removal wins over
 * addition — see {@link scopeContains}.
 */
export type AxisScope =
  | { kind: Exclude<AxisScopeKind, 'custom'> }
  | {
    kind: 'custom'
    /** The scope the additions and removals are applied over. */
    base: AxisBase
    /**
     * Ids of the rule groups this axis references. The DEFINITION of an id is
     * read from the settings page at the moment of use, never stored here: a
     * session that copied a group's contents would keep enforcing the copy after
     * the group changed, and copies of one group drift apart.
     */
    groups?: readonly string[] | undefined
    /** Absolute paths added to the base. */
    allow: readonly string[]
    /** Absolute paths removed from (base ∪ allow). */
    deny: readonly string[]
  }

/** Every {@link AxisScopeKind}, for option advertisement and untrusted-value validation. */
export const AXIS_KINDS: readonly AxisScopeKind[] = ['deny', 'workspace', 'all', 'custom']

/** Every {@link AxisBase}, for option advertisement and untrusted-value validation. */
export const AXIS_BASES: readonly AxisBase[] = ['deny', 'workspace', 'all']

/** The default READ axis: every mode permitted reading before the axes existed, so the whole host. */
export const DEFAULT_READ_SCOPE: AxisScope = { kind: 'all' }

/** The default WRITE axis: the session workspace plus the platform temp areas. */
export const DEFAULT_WRITE_SCOPE: AxisScope = { kind: 'workspace' }

/**
 * Whether an untrusted runtime value names one of the three `SandboxMode` members.
 *
 * The TYPE says `SandboxMode`; the session LOG says whatever a past writer put
 * there. A replayed or foreign log can carry a mode this build never wrote, and
 * a fold that trusts it would take the whole projected axis cell down with it.
 * This guard is the boundary that turns 'the log claims a mode' into 'the log
 * claims a mode this build understands': callers read a false answer as 'names
 * no mode' and keep the axis value they already had.
 * @param value - the untrusted value from a session-log payload.
 * @returns true when the value is a `SandboxMode`.
 */
export function isSandboxMode(value: unknown): value is SandboxMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access'
}

/**
 * The write scope a legacy `mode` means.
 * @param mode - the sandbox mode.
 * @returns the equivalent write scope.
 */
export function scopeOfMode(mode: SandboxMode): AxisScope {
  switch (mode) {
    case 'read-only': return { kind: 'deny' }
    case 'workspace-write': return { kind: 'workspace' }
    case 'danger-full-access': return { kind: 'all' }
  }
}

/**
 * The mode an axis BASE implies — the shared half of {@link modeOfScope}. The
 * three-value mode set is closed, so every base spells exactly one mode.
 * @param base - the axis base to spell.
 * @returns the mode that base has always been persisted as.
 */
export function modeOfAxisBase(base: AxisBase): SandboxMode {
  switch (base) {
    case 'deny': return 'read-only'
    case 'workspace': return 'workspace-write'
    case 'all': return 'danger-full-access'
  }
}

/**
 * The legacy `mode` a write scope is spelled as. `custom` resolves through its
 * own base: the mode names the containment the fence must not exceed, while the
 * scope's additions and removals ride beside it.
 * @param scope - the write axis value.
 * @returns the mode that spells this scope's base.
 */
export function modeOfScope(scope: AxisScope): SandboxMode {
  return scope.kind === 'custom' ? modeOfAxisBase(scope.base) : modeOfAxisBase(scope.kind)
}

/** The axis pair actually in force, with both defaults filled in. */
export interface EffectiveScopes {
  /** The read axis in force. */
  read: AxisScope
  /** The write axis in force. */
  write: AxisScope
}

/**
 * Read the axis pair a resolved policy carries, falling back to the defaults.
 * The policy's `mode` is authoritative for the write axis's BASE: a policy
 * that carries no write axes writes exactly what its mode always meant, so
 * every pre-existing policy keeps its exact behavior.
 *
 * 0.1.7's `SandboxExecutionPolicy` has no `readScope` / `writeScope`
 * members (only `mode`, `workspaceRoot`, `sessionId?`), so the axes arrive
 * through the extra argument this package's own fence passes. The
 * `mode`-derived fallback keeps the function total for the upstream type.
 * @param policy - the resolved policy (supplies `mode`).
 * @param axes - the session's axis pair, when the caller holds one.
 * @returns both axes in force.
 */
export function effectiveScopes(
  policy: SandboxExecutionPolicy,
  axes?: Partial<EffectiveScopes>,
): EffectiveScopes {
  return {
    read: axes?.read ?? DEFAULT_READ_SCOPE,
    write: axes?.write ?? scopeOfMode(policy.mode),
  }
}

/**
 * Whether a policy's `mode` still spells its write scope's base — the
 * invariant every construction site must preserve. A custom write scope whose
 * base disagrees with `mode` would enforce containment the session never chose.
 * @param policy - the policy to check.
 * @param axes - the session's axis pair, when the caller holds one.
 * @returns true when the two agree.
 */
export function isModeConsistent(
  policy: SandboxExecutionPolicy,
  axes?: Partial<EffectiveScopes>,
): boolean {
  return policy.mode === modeOfScope(effectiveScopes(policy, axes).write)
}

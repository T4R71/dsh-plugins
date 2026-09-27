/**
 * The dual-axis settings surface: the 0.1.7 spelling of the section 0.1.6
 * registered through `ctx.settings.installSection`.
 *
 * 0.1.7 removed both `installSection` and `settings.register(ns, schema)`:
 * `SettingsForms.describe()` projects exactly the Config schemas of LOADED
 * Loader entries (`packages/settings/settings/src/index.ts:302-340`) and
 * `write()` refuses a namespace with no matching entry
 * (`:382-384`, `No configurable plugin entry`). The namespace IS the entry
 * id, so this package's own row id in `cordis.patch.yml` — `dual-axis` — is
 * the settings namespace. 0.1.6's separate `sandbox-axis` namespace name is
 * therefore retired.
 *
 * 0.1.7 also added the volatile gate: a field that is not beneath a
 * `.volatile()` node is neither projected into the form
 * (`packages/settings/settings/src/schema.ts:37-47`) nor writable
 * (`:74-78`), and an entry with no volatile field at all is refused outright
 * (`index.ts:385-386`). Both axes are marked volatile here.
 *
 * The schema is deliberately `z.any()` per axis, exactly as in 0.1.6:
 * schemastery's union types strip the `custom` branch's `base/allow/deny`
 * payload, which would silently degrade a configured custom axis into an axis
 * carrying no paths. Shape validation is {@link normalizeScope}'s job.
 *
 * @module @t4r71/dsh-dual-axis/config
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// The settings service arrives by declaration merging only for the type of
// `ctx.get('settings')`: this module reads that service when a session is
// created, never at mount, so it must not become a hard INJECT entry.
import type {} from '@deepseek-ai/dsh-settings'
import { AXIS_BASES, AXIS_KINDS, DEFAULT_READ_SCOPE, DEFAULT_WRITE_SCOPE } from './axis.ts'
import type { AxisBase, AxisScope, AxisScopeKind } from './axis.ts'
import type { RuleGroup } from './groups.ts'
import { isAbsoluteSpelling } from './scope.ts'

/**
 * This package's row id in `cordis.patch.yml`. It doubles as the 0.1.7
 * settings namespace (the Loader entry id) and, prefixed with the package
 * name, as the `plugins.row.config` slot entry key the client half uses.
 */
export const DUAL_AXIS_ROW_ID = 'dual-axis'

/**
 * The 0.1.6 settings namespace name, kept only so a migration can recognize
 * the retired spelling. Nothing registers under it in 0.1.7.
 */
export const RETIRED_SETTINGS_NAMESPACE = 'sandbox-axis'

/**
 * This row's composition config: the defaults a NEWLY CREATED session takes,
 * plus the group library its `defaultGroups` are drawn from.
 *
 * Every field here is a SEED. A session reads this row once, when it is created,
 * and owns its copy from then on; the decision paths (the fence and the prompt)
 * read the row only to resolve, by id, the definitions of the groups a session
 * already references ({@link groupLibraryValue}). Nothing here is consulted when
 * an existing session decides whether a path is allowed.
 *
 * Fields left empty fall back to the built-in defaults (read `all`, write
 * `workspace`, no groups), which are 0.1.6's `DEFAULT_READ_SCOPE` /
 * `DEFAULT_WRITE_SCOPE`.
 */
export interface Config {
  /** The read axis a new session starts from (default: `{ kind: 'all' }`). */
  read?: Volatile<AxisScope>
  /** The write axis a new session starts from (default: `{ kind: 'workspace' }`). */
  write?: Volatile<AxisScope>
  /** The group library: named rule fragments sessions reference by id (default: empty). */
  groups?: Volatile<RuleGroup[]>
  /** Which of {@link groups} a new session starts out referencing (default: empty). */
  defaultGroups?: Volatile<string[]>
}

/**
 * The composition config's schema. Both axes are `.volatile()` and
 * `z.any()` — see the module docstring for why each is required.
 *
 * Not annotated `z<Config>`: `.volatile()` widens the field's inferred type
 * to schemastery's `Volatile<>` accessor, which the plain `Config` interface
 * does not describe. The repo's own volatile Configs
 * (`packages/core/agent-default-model/src/index.ts:51-55`) are inferred the
 * same way, and {@link axesOf} re-establishes the declared shape.
 */
export const Config = z.object({
  read: z.any().volatile(),
  write: z.any().volatile(),
  // `z.any()` per group for the same reason the axes use it: schemastery's
  // object and union resolvers drop members they do not declare, which would
  // silently strip a group's `read`/`write` rule sets. Shape validation is
  // `parseLibrary` in `./groups.ts`.
  groups: z.array(z.any()).default([]).volatile(),
  defaultGroups: z.array(z.string()).default([]).volatile(),
})

/**
 * Collect one `custom` axis's path list: every entry must be a non-empty
 * absolute path.
 * @param label - the axis name used in the error message.
 * @param entry - the list name used in the error message (`allow` or `deny`).
 * @param value - the untrusted list value.
 * @returns the validated path list.
 * @throws When the value is not a string array, or holds a non-absolute path.
 */
export function pathList(label: string, entry: string, value: unknown): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`dual-axis: ${label} ${entry} must be an array of absolute path strings`)
  }
  for (const item of value as string[]) {
    if (item.length === 0 || !isAbsoluteSpelling(item)) {
      throw new Error(`dual-axis: ${label} ${entry} entry ${JSON.stringify(item)} must be an absolute path`)
    }
  }
  return [...(value as string[])]
}

/**
 * Coerce one axis value from a config document (which a human may have edited)
 * into a legal {@link AxisScope}, throwing rather than guessing.
 *
 * An unreadable axis must not become some other, wider or narrower grant:
 * throwing fails the row's mount or the settings write on the spot instead of
 * proceeding under an invented boundary. This is 0.1.6's `normalizeScope`,
 * unchanged.
 * @param label - the axis name used in error messages (`read` or `write`).
 * @param value - the untrusted axis value.
 * @returns the validated axis value.
 * @throws When the value is not one of the four kinds, or a custom entry is not absolute.
 */
export function normalizeScope(label: string, value: unknown): AxisScope {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`dual-axis: ${label} must be an access-axis object, received ${JSON.stringify(value)}`)
  }
  const candidate = value as { kind?: unknown; base?: unknown; groups?: unknown; allow?: unknown; deny?: unknown }
  if (typeof candidate.kind !== 'string' || !AXIS_KINDS.includes(candidate.kind as AxisScopeKind)) {
    throw new Error(`dual-axis: ${label} carries unknown kind ${JSON.stringify(candidate.kind)} (expected: ${AXIS_KINDS.join(', ')})`)
  }
  if (candidate.kind !== 'custom') return { kind: candidate.kind as Exclude<AxisScopeKind, 'custom'> }
  if (typeof candidate.base !== 'string' || !AXIS_BASES.includes(candidate.base as AxisBase)) {
    throw new Error(`dual-axis: ${label} custom base must be ${AXIS_BASES.join(', ')}, received ${JSON.stringify(candidate.base)}`)
  }
  return {
    kind: 'custom',
    base: candidate.base as AxisBase,
    groups: groupIds(label, candidate.groups),
    allow: pathList(label, 'allow', candidate.allow),
    deny: pathList(label, 'deny', candidate.deny),
  }
}

/**
 * Collect one `custom` axis's rule-group references. Only the speaker matters
 * here — an id is a name the settings page resolves, so this checks that the
 * list is a list of non-empty names and nothing more; whether the name exists is
 * decided at the moment of use ({@link resolveEffectiveAxes}), where a missing
 * one can be refused instead of quietly dropped.
 * @param label - the axis name used in the error message.
 * @param value - the untrusted `groups` value.
 * @returns the validated id list.
 * @throws When the value is not an array of non-empty strings.
 */
function groupIds(label: string, value: unknown): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`dual-axis: ${label} groups must be an array of non-empty rule-group ids`)
  }
  return [...new Set(value as string[])]
}

/**
 * Whether two axes describe the same boundary. Compared member by member
 * rather than by reference: every re-parse builds fresh axis objects, and a
 * custom axis's two path lists carry order as part of their value.
 * @param left - one axis.
 * @param right - another axis.
 * @returns whether both describe the same axis.
 */
export function sameScope(left: AxisScope, right: AxisScope): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind !== 'custom' || right.kind !== 'custom') return true
  const sameList = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index])
  // An axis written before groups existed carries no `groups` member; it
  // references none, which is exactly what an empty list means.
  return left.base === right.base
    && sameList(left.groups ?? [], right.groups ?? [])
    && sameList(left.allow, right.allow)
    && sameList(left.deny, right.deny)
}

/**
 * Read both axes out of one settings/config value.
 *
 * The parameter is UNTRUSTED on purpose: the same function serves the
 * composition layer's parsed Config, the settings service's projected
 * descriptor (an `unknown` on the wire between two packages), and a
 * hand-edited document, and none of those three is guaranteed to carry the
 * declared shape. Both axes therefore pass through {@link normalizeScope},
 * which is where an illegal value becomes a throw instead of an invented
 * boundary; a missing side falls back to the built-in default axis.
 * @param section - the section's current resolved value, whatever carries it.
 * @returns both axes.
 * @throws When either axis's shape is illegal.
 */
export function axesOf(section: unknown): { read: AxisScope; write: AxisScope } {
  const declared = section === null || typeof section !== 'object'
    ? {}
    : section as { read?: unknown; write?: unknown }
  return {
    read: normalizeScope('read', unwrapVolatile(declared.read) ?? DEFAULT_READ_SCOPE),
    write: normalizeScope('write', unwrapVolatile(declared.write) ?? DEFAULT_WRITE_SCOPE),
  }
}

/**
 * Unwrap one config field's value.
 *
 * A `.volatile()` field is handed to the plugin as a cordis `Volatile<T>`
 * **accessor**, not as `T`: the schema's `get()` re-reads the stored value on
 * every call so an edit applies without remounting the entry. Reading the
 * property directly therefore yields the accessor object, whose `kind` is
 * `undefined` — which {@link normalizeScope} correctly refuses, failing the
 * whole row at mount. The upstream volatile Config
 * (`packages/core/agent-default-model/src/index.ts:68-71`) unwraps the same way.
 *
 * A hand-written config document may also carry the plain value, so both
 * spellings are accepted.
 * @param value - the configured field, as the accessor, as a plain value, or as
 *   whatever an untrusted document put under the key.
 * @returns the underlying value, or `undefined` when this field is unset.
 */
function unwrapVolatile(value: unknown): unknown {
  if (value === undefined) return undefined
  if (typeof (value as Volatile<unknown>).get === 'function') {
    return (value as Volatile<unknown>).get()
  }
  return value
}

/**
 * This row's current value on the settings page, or `undefined` when no
 * settings service is mounted.
 *
 * This is the ONE read path to that row. It goes through `describe()` rather
 * than the config the plugin instance captured at mount because the loader does
 * not commit a later save back to that instance
 * (`vendor/loader/src/config/entry.ts:162-195`); `describe()` re-projects
 * `entry.fiber.config` and unwraps the volatile accessors on every call
 * (`packages/settings/settings/src/index.ts:319-323` +
 * `packages/settings/settings/src/schema.ts:11`), which is the same path the
 * settings page renders from. A save therefore applies without a restart.
 * @param ctx - host context; the service is looked up, never injected.
 * @returns the row's current value, or `undefined` when unavailable.
 */
export function declaredSection(ctx: Context): unknown {
  return ctx.get('settings')?.describe().find(row => row.ns === DUAL_AXIS_ROW_ID)?.value
}

/**
 * The group library a decision path may read, and the ONLY part of the settings
 * row one may read for a decision.
 *
 * The row's `read`, `write` and `defaultGroups` fields are seeds for
 * NEWLY CREATED sessions and carry no authority over an existing one; a
 * decision path that read them would let the settings page silently re-scope a
 * running session, which is the drift this package exists to prevent.
 * @param section - the row's current value, as {@link declaredSection} returns it.
 * @returns the untrusted `groups` value, for {@link resolveEffectiveAxes}.
 */
export function groupLibraryValue(section: unknown): unknown {
  return section === null || typeof section !== 'object'
    ? undefined
    : unwrapVolatile((section as { groups?: unknown }).groups)
}

/**
 * The group ids a newly created session starts out referencing.
 * @param section - the row's current value, as {@link declaredSection} returns it.
 * @returns the ids, deduplicated; empty when the row declares none.
 * @throws When a declared id is not a non-empty string.
 */
export function defaultGroupIds(section: unknown): readonly string[] {
  const value = section === null || typeof section !== 'object'
    ? undefined
    : unwrapVolatile((section as { defaultGroups?: unknown }).defaultGroups)
  return groupIds('defaultGroups', value)
}

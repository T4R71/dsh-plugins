/**
 * The composition config: the row's own schema, validated by the loader before
 * the plugin is constructed.
 *
 * `rulesFile`, `artifactDir` and `mode` are marked `.volatile()`. That is not
 * decoration: 0.1.7 refuses an entry with NO volatile field outright, and refuses
 * a write to any non-volatile path, so a field an operator is expected to change
 * without a restart has to be volatile. The PATH the settings service reports for
 * this row is also where the default rule file is looked for, which is the
 * mechanism that keeps the rule file in the profile directory rather than inside
 * the package.
 *
 * `z.any()` per field would be the loose option and is NOT taken: these three
 * are closed shapes and a wrong one must fail the row at mount rather than
 * surface as an odd file path later. The one field that is deliberately untyped
 * is none of them.
 *
 * THE SETTINGS DIRECTORY IS A REPORTED FACT, NOT A SILENT `undefined`. The
 * member this module reads off the settings service — `describe()[i].directory` —
 * DOES NOT EXIST on the host this package runs on; see
 * {@link SettingsDirectorySource} for the measurement. An earlier revision read
 * it anyway and answered `undefined`, which travelled unremarked through
 * `ruleFilePath` into a cleared pin, so rewrite mode ran with no rules in force
 * and said nothing that named the cause. {@link settingsDirectoryOf} now returns
 * the reason as its own sentence, and the caller reports it.
 *
 * @module @t4r71/dsh-prompt-plan/config
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** This package's row id in `cordis.patch.yml`; also its settings namespace. */
export const PROMPT_PLAN_ROW_ID = 'prompt-plan'

/** The two modes. */
export type PromptPlanMode = 'observe' | 'rewrite'

/** The mode values, closed. */
export const PROMPT_PLAN_MODES: readonly PromptPlanMode[] = ['observe', 'rewrite']

/** This row's composition config. */
export interface Config {
  /**
   * The rule file, absolute, or relative to this entry's settings directory.
   * Empty (the default) derives a path in that directory instead of requiring
   * one, so an installed package needs no configuration to find an operator's
   * rules. See `ruleFilePath` in `./rules.ts`.
   */
  rulesFile?: Volatile<string>
  /** `observe` writes artifacts and changes nothing; `rewrite` applies the rules. */
  mode?: Volatile<PromptPlanMode>
  /**
   * Where the observation artifacts go. Empty (the default) puts them in a
   * `prompt-plan-observations` directory beside the resolved rule file, which
   * means the profile directory again. An absolute path overrides it.
   */
  artifactDir?: Volatile<string>
  /**
   * Whether to also write the full-text artifact. Default `false`: it is orders
   * of magnitude larger, and the default baseline is built from hashes,
   * lengths and previews.
   */
  fullText?: Volatile<boolean>
  /** Whether to keep writing anything at all. Default `true`. */
  observe?: Volatile<boolean>
}

/**
 * The config schema.
 *
 * Not annotated `z<Config>`: `.volatile()` widens each field's inferred type to
 * schemastery's `Volatile<>` accessor, which the plain interface does not
 * describe. The repo's own volatile Configs are inferred the same way and
 * `configValue` re-establishes the declared shape.
 */
export const Config = z.object({
  rulesFile: z.string().default('').volatile(),
  mode: z.union(PROMPT_PLAN_MODES as unknown as [PromptPlanMode, ...PromptPlanMode[]]).default('observe').volatile(),
  artifactDir: z.string().default('').volatile(),
  fullText: z.boolean().default(false).volatile(),
  observe: z.boolean().default(true).volatile(),
})

/**
 * Unwrap one volatile field.
 *
 * A `.volatile()` field reaches the plugin as a `Volatile<T>` ACCESSOR, not as
 * `T`: reading the property yields the accessor object, whose members are wrong
 * for every one of these fields. A hand-written document may also carry the
 * plain value, so both spellings are accepted.
 * @param value - the configured field.
 * @returns the underlying value, or `undefined` when unset.
 */
function unwrap<T>(value: unknown): T | undefined {
  if (value === undefined) return undefined
  // Through `unknown`: `Volatile<T>` is a mapped type, so assigning it back to
  // `T` is not a narrowing the compiler can follow, and the accessor's `get()`
  // return type carries the same mapped shape.
  const accessor = value as { get?: () => unknown }
  if (typeof accessor.get === 'function') return accessor.get() as T
  return value as T
}

/** The config as this plugin uses it. */
export interface ResolvedConfig {
  readonly rulesFile: string
  readonly mode: PromptPlanMode
  readonly artifactDir: string
  readonly fullText: boolean
  readonly observe: boolean
}

/**
 * Read the row's config into the shape the plugin uses.
 * @param source - the captured Config, a settings descriptor's value, or any object.
 * @returns every field resolved, with the schema's defaults applied.
 */
export function resolvedConfig(source: unknown): ResolvedConfig {
  const record = source === null || typeof source !== 'object' ? {} : source as Record<string, unknown>
  const mode = unwrap<string>(record.mode)
  return {
    rulesFile: unwrap<string>(record.rulesFile) ?? '',
    // An unrecognised mode is refused by the schema at mount; this guard covers
    // a hand-edited settings document that reached the plugin unvalidated.
    mode: mode === 'rewrite' ? 'rewrite' : 'observe',
    artifactDir: unwrap<string>(record.artifactDir) ?? '',
    fullText: unwrap<boolean>(record.fullText) ?? false,
    observe: unwrap<boolean>(record.observe) ?? true,
  }
}

/**
 * The directory the settings service reports for a namespace, as a VALUE.
 *
 * `ok: false` carries a sentence naming exactly WHAT is missing, so a caller can
 * report a configuration gap instead of degrading into an undefined path. It is a
 * value and not an exception because a composition with no settings service is a
 * legitimate composition — the failure to avoid is the SILENT one.
 */
export type SettingsDirectoryLookup =
  | { readonly ok: true; readonly directory: string }
  | { readonly ok: false; readonly problem: string }

/**
 * The shape this module reads off the settings service.
 *
 * `directory` IS TYPED `unknown` ON PURPOSE, and that is the fix rather than a
 * loosening. MEASURED against the host this package runs on —
 * `@deepseek-ai/dsh-settings@0.2.0-rc.2`, both the copy extracted from
 * `M:\DSH-T4\resources\app.asar` and the identical one in this package's own
 * `node_modules` — `describe()` returns descriptors carrying exactly
 * `{ applies, autoGenerate, base, ns, revision, schema, secrets, user, value }`,
 * and the identifier `directory` occurs ZERO times in the whole package. An
 * earlier revision of this function read that member unconditionally through a
 * `directory?: string` type, so it answered `undefined` on every host it ever
 * ran on, with nothing in any log to say so: the plugin then reported an
 * unreadable rule file it had in fact never been told the path of. Typing it
 * `unknown` is what makes the absence REPORTABLE instead of invisible.
 */
export interface SettingsDirectorySource {
  /** The settings service, when mounted. */
  readonly describe: () => readonly { readonly ns?: unknown; readonly directory?: unknown }[]
}

/** The one member name this lookup reads, kept for the diagnostic sentence. */
const DIRECTORY_MEMBER = 'directory'

/** Render a service failure as one clause, whatever was thrown. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** List the members a descriptor actually carries, so a missing one is named against what IS there. */
function membersOf(row: object): string {
  const names = Object.keys(row).sort()
  return names.length === 0 ? '(no members)' : names.join(', ')
}

/**
 * Resolve the directory this row's settings live in.
 *
 * This is the one read that keeps the rule file and the artifacts out of the
 * package and inside the profile: the settings service is asked where the entry
 * was declared rather than the plugin guessing from `__dirname`. Every way that
 * read can fail is returned as its own sentence — no service, a refusing
 * `describe()`, no row for this namespace, or a row carrying no usable
 * `directory` — because the failure this replaced was an `undefined` that
 * travelled all the way to a cleared pin without ever saying why.
 * @param settings - the settings service, or `undefined`.
 * @param namespace - the row id.
 * @returns the directory, or the problem that prevented reading one.
 */
export function settingsDirectoryOf(settings: SettingsDirectorySource | undefined, namespace: string): SettingsDirectoryLookup {
  const ns = JSON.stringify(namespace)
  if (settings === undefined) {
    return { ok: false, problem: `the settings service is not mounted in this composition, so no directory was read for ns ${ns}` }
  }
  let rows: readonly { readonly ns?: unknown; readonly directory?: unknown }[]
  try {
    rows = settings.describe()
  } catch (error) {
    return { ok: false, problem: `the settings service refused describe() for ns ${ns}: ${reasonOf(error)}` }
  }
  if (!Array.isArray(rows)) {
    return { ok: false, problem: `the settings service describe() returned ${typeof rows} instead of an array for ns ${ns}` }
  }
  const row = rows.find(entry => entry !== null && typeof entry === 'object' && entry.ns === namespace)
  if (row === undefined) {
    return { ok: false, problem: `the settings service reports no entry with ns ${ns}, so there is no directory to read for it` }
  }
  const directory = row[DIRECTORY_MEMBER]
  if (typeof directory === 'string' && directory.length > 0) return { ok: true, directory }
  if (typeof directory === 'string') {
    return { ok: false, problem: `the settings service entry for ns ${ns} carries an EMPTY ${JSON.stringify(DIRECTORY_MEMBER)} member` }
  }
  return {
    ok: false,
    problem: `the settings service entry for ns ${ns} carries no ${JSON.stringify(DIRECTORY_MEMBER)} member (it reports ${membersOf(row)}), so a rule file path that is not absolute cannot be located`,
  }
}

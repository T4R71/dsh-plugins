/**
 * The rule file: where it lives, how it is found, and what a valid one is.
 *
 * WHERE IT LIVES, AND WHY. The rule file belongs to a PROFILE, not to this
 * package: an operator's prompt rules must survive a package upgrade and must
 * not be published with the package. That decision is already taken, so this
 * module never writes a rule file and never searches for one. The path comes
 * from configuration, and when it is not configured this module derives the
 * DEFAULT from the running deployment rather than from a constant:
 *
 *   <defaultRulesDirectory>/prompt-plan.rules.yaml
 *
 * where `<defaultRulesDirectory>` is the directory the settings service reports
 * for the `prompt-plan` Loader entry — that is, the profile directory this row
 * was declared in. Measured on this machine, the desktop profile directory is
 * `M:\\DSH-T4\\home\\profiles\\desktop`, so a freshly installed package lands on
 * `M:\\DSH-T4\\home\\profiles\\desktop\\prompt-plan.rules.yaml` with no
 * configuration at all. See README, "Where the rule file and the artifacts go".
 *
 * WHY `node:fs` RATHER THAN THE HOST'S FILE SERVICE. The rules file is read by
 * the plugin, not by a tool, and the dual-axis read fence sits on the TOOL
 * dispatch layer — `ctx.tools.guard` plus a `tools/pre-execute` listener
 * covering exactly the four read entry points `read`, `read_image`, `grep`,
 * `glob` (`@t4r71/dsh-dual-axis`, `src/read-guard.ts`, the `READ_TOOLS` table).
 * A plugin reading its own configuration through `node:fs` never enters that
 * layer, so this package's rule file is not subject to the session's read axis.
 * That is a fact about where the fence is mounted, not a claim that the fence is
 * absent.
 *
 * FORMAT. YAML, parsed by this package's own subset reader
 * ({@link parseYamlSubset}) because NO YAML LIBRARY IS RESOLVABLE in this
 * plugin's environment. Measured, with the exact commands and output in the
 * README:
 *   - `js-yaml` and `yaml` are absent from `M:\\dsh-plugins\\packages\\dual-axis\\node_modules`
 *     (a stand-in for this package's own install location),
 *   - absent from `C:\\Users\\TRI\\.dsh\\profiles\\desktop` and
 *     `C:\\Users\\TRI\\.dsh\\profiles\\web` (the two profile roots that load bundles),
 *   - present ONLY inside `M:\\dsh-plugins\\node_modules\\.pnpm`, which is a
 *     workspace store no installed profile resolves through.
 * `JSON` IS ALREADY A SUBSET OF THIS READER'S INPUT, so a rule file that is
 * pure JSON needs no second code path and no fallback flag: `parseYamlSubset`
 * accepts it as a flow mapping at the top level. Both spellings are shown in the
 * README's complete example.
 *
 * @module @t4r71/dsh-prompt-plan/rules
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { ACTION_KINDS } from './actions.ts'
import type { Action, ActionKind, Fragment } from './actions.ts'
import { MATCH_KINDS } from './naming.ts'
import type { MatchKind, Matcher } from './naming.ts'
import { parseYamlSubset, YamlSubsetError } from './yaml.ts'
import { TRANSFORM_OPS } from './transform.ts'
import type { TransformOp } from './transform.ts'

/** The default file name, inside the directory the profile configures. */
export const DEFAULT_RULE_FILE_NAME = 'prompt-plan.rules.yaml'

/** The format version this reader accepts. */
export const RULE_FILE_VERSION = 1

/** One rule, fully validated. */
export interface Rule {
  /** Stable id, used in every diagnostic. Unique across the file. */
  readonly id: string
  /** The matcher, with its kind spelled out. */
  readonly match: Matcher
  /** What to do with each matched section. */
  readonly action: Action
  /**
   * What an unmatched rule means. Default `true`: an unmatched required rule is
   * an error, because a rule that silently stopped matching is the failure this
   * package is most likely to suffer — template sections are conditionally
   * registered, and a section simply absent from this assembly is not evidence
   * that the rule was wrong. Set `false` for a rule aimed at a template section
   * that only some sessions carry.
   */
  readonly required: boolean
  /** Whether every matched section is rewritten, or only the first. Default true. */
  readonly all: boolean
  /** Free-text comment, carried into diagnostics. */
  readonly note?: string
}

/** The whole rule file, validated. */
export interface RuleSet {
  readonly version: number
  readonly rules: readonly Rule[]
  /** Where it was read from. */
  readonly path: string
  /** sha256 of the file's bytes, so an observation can name the exact rule set in force. */
  readonly sha256: string
}

/** A refusal: the sentence to show, and the file it concerns. */
export class RuleFileError extends Error {
  /** The file the sentence concerns. */
  readonly path: string
  /**
   * @param message - the sentence explaining what is wrong.
   * @param path - the rule file path.
   */
  constructor(message: string, path: string) {
    super(`${path}: ${message}`)
    this.name = 'RuleFileError'
    this.path = path
  }
}

/** Structural checks the validator shares between the file and one rule. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Require a non-empty string member. */
function requireString(source: Record<string, unknown>, key: string, where: string, path: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuleFileError(`${where}: "${key}" must be a non-empty string (received ${JSON.stringify(value)})`, path)
  }
  return value
}

/** Read the closed `match.kind` value. */
function requireMatchKind(source: Record<string, unknown>, where: string, path: string): MatchKind {
  const value = source.kind
  if (typeof value !== 'string' || !MATCH_KINDS.includes(value as MatchKind)) {
    throw new RuleFileError(`${where}: "match.kind" must be one of ${MATCH_KINDS.join(', ')} (received ${JSON.stringify(value)})`, path)
  }
  return value as MatchKind
}

/** Read the closed `action.kind` value. */
function requireActionKind(source: Record<string, unknown>, where: string, path: string): ActionKind {
  const value = source.kind
  if (typeof value !== 'string' || !ACTION_KINDS.includes(value as ActionKind)) {
    throw new RuleFileError(`${where}: "action.kind" must be one of ${ACTION_KINDS.join(', ')} (received ${JSON.stringify(value)})`, path)
  }
  return value as ActionKind
}

/** Read the `fragments` list of a `replace` action. */
function readFragments(source: Record<string, unknown>, where: string, path: string): readonly Fragment[] {
  const value = source.fragments
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new RuleFileError(`${where}: "action.fragments" must be a sequence`, path)
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new RuleFileError(`${where}: "action.fragments[${index}]" must be a mapping with a "text" member`, path)
    }
    return { text: requireString(entry, 'text', `${where}: action.fragments[${index}]`, path) }
  })
}

/**
 * Read one text member, refusing anything that is not a string.
 *
 * The reader is deliberately strict here even though the rule file's own YAML
 * could spell a text as a number or a boolean: `text: 2024` is far more likely to
 * be a mistake than a section that should read "2024", and this package's
 * posture is that a hand-edited file gets a sentence rather than a surprise.
 * @param source - the mapping that carries the member.
 * @param key - the member's name.
 * @param where - the diagnostic's subject.
 * @param path - the rule file, for the refusal.
 * @returns the member's text, or undefined when absent.
 */
function optionalText(source: Record<string, unknown>, key: string, where: string, path: string): string | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new RuleFileError(`${where}: "${key}" must be a string (received ${JSON.stringify(value)})`, path)
  }
  return value
}

/**
 * Compile one regular expression member, refusing a pattern that does not compile.
 * @param source - the mapping that carries the member.
 * @param key - the member's name, in the file's own spelling.
 * @param where - the diagnostic's subject.
 * @param path - the rule file, for the refusal.
 * @param flags - the flags to compile with; the reader's default `'u'` unless the
 * caller passes its own, which only `replaceText` does.
 * @returns the compiled pattern and its source text.
 */
function readPattern(source: Record<string, unknown>, key: string, where: string, path: string, flags = 'u'): { readonly pattern: RegExp; readonly source: string } {
  const text = source[key]
  if (typeof text !== 'string' || text.length === 0) {
    throw new RuleFileError(`${where}: "${key}" must be a non-empty regular expression`, path)
  }
  try {
    return { pattern: new RegExp(text, flags), source: text }
  } catch (error) {
    // THROWN AT LOAD TIME, on purpose: a pattern that does not compile is a rule
    // file defect, and the operator hears about it from the reader — with the file
    // and the rule named — rather than from a section that quietly kept its text.
    const reason = error instanceof Error ? error.message : String(error)
    throw new RuleFileError(`${where}: "${key}" is not a valid regular expression: ${reason}`, path)
  }
}

/**
 * Read the flags of a `replaceText` operation.
 *
 * `'g'` IS MANDATORY and is therefore both the default and a requirement: this op
 * exists to rewrite text in place, and a non-global `replace` stops after the
 * first match, leaving a half-rewritten line — the partial result every transform
 * here refuses to publish. A rule that spells the flags out keeps the right to
 * add `'i'`, `'s'`, `'m'`, `'u'`, `'y'`, `'d'` or `'v'`; it does not get to drop `'g'`.
 * @param raw - the operation's `flags` member, or undefined.
 * @param where - the diagnostic's subject.
 * @param path - the rule file, for the refusal.
 * @returns the flags to compile with.
 */
function readReplaceFlags(raw: unknown, where: string, path: string): string {
  if (raw === undefined) return 'g'
  if (typeof raw !== 'string') {
    throw new RuleFileError(`${where}: "flags" must be a string of regular-expression flags (received ${JSON.stringify(raw)})`, path)
  }
  if (!raw.includes('g')) {
    throw new RuleFileError(`${where}: "flags" must include "g", otherwise only the first match would be replaced (received ${JSON.stringify(raw)})`, path)
  }
  return raw
}

/** Read one transform operation. */
function readTransformOp(raw: unknown, where: string, path: string): TransformOp {
  if (!isRecord(raw)) throw new RuleFileError(`${where}: each transform operation must be a mapping with an "op" member`, path)
  const op = raw.op
  if (typeof op !== 'string' || !TRANSFORM_OPS.includes(op as TransformOp['op'])) {
    throw new RuleFileError(`${where}: "op" must be one of ${TRANSFORM_OPS.join(', ')} (received ${JSON.stringify(op)})`, path)
  }
  switch (op as TransformOp['op']) {
    case 'dropLines': {
      const { pattern, source } = readPattern(raw, 'pattern', where, path)
      const blank = raw.blank
      if (blank !== undefined && typeof blank !== 'boolean') {
        throw new RuleFileError(`${where}: "blank" must be a boolean`, path)
      }
      return { op: 'dropLines', pattern, source, ...blank === undefined ? {} : { blank } }
    }
    case 'keepLines': {
      const { pattern, source } = readPattern(raw, 'pattern', where, path)
      return { op: 'keepLines', pattern, source }
    }
    case 'stripToolDecls': {
      const names = raw.names
      const namesFrom = raw.namesFrom
      if (namesFrom !== undefined && (typeof namesFrom !== 'string' || namesFrom.trim().length === 0)) {
        throw new RuleFileError(`${where}: "namesFrom" must be a non-empty path (received ${JSON.stringify(namesFrom)})`, path)
      }
      // An op that points at an external list MAY leave "names" out entirely: it
      // then strips exactly what that list names, which is the shape a rule takes
      // when the whole decision belongs to the layer that produces the list. An op
      // with NEITHER is still refused — an operation that names nothing is a
      // no-op, and a no-op accepted silently is the failure this package refuses
      // everywhere else.
      if (names === undefined && namesFrom === undefined) {
        throw new RuleFileError(`${where}: a "stripToolDecls" operation needs a "names" sequence of non-empty strings, or a "namesFrom" path`, path)
      }
      if (names !== undefined && !Array.isArray(names)) {
        throw new RuleFileError(`${where}: a "stripToolDecls" operation needs a "names" sequence of non-empty strings`, path)
      }
      if (Array.isArray(names) && names.some(entry => typeof entry !== 'string' || entry.length === 0)) {
        throw new RuleFileError(`${where}: a "stripToolDecls" operation needs a "names" sequence of non-empty strings`, path)
      }
      const dryRun = raw.dryRun
      if (dryRun !== undefined && typeof dryRun !== 'boolean') {
        throw new RuleFileError(`${where}: "dryRun" must be a boolean`, path)
      }
      // The path is kept AS WRITTEN (trimmed): resolution against the rule file's
      // directory happens per pin, in tool-names.ts, so the rule stays portable
      // and the log line can quote the operator's own spelling.
      const dynamic = namesFrom === undefined ? {} : { namesFrom: namesFrom.trim() }
      // Default TRUE, and the default is the point: this operation edits the
      // generated SDK text every agent programs against, so the shipped rule is
      // a measurement until an operator has read it and turned it off.
      return { op: 'stripToolDecls', names: [...(names ?? [])] as readonly string[], dryRun: dryRun ?? true, ...dynamic }
    }
    case 'stripDocComments': {
      const dryRun = raw.dryRun
      if (dryRun !== undefined && typeof dryRun !== 'boolean') {
        throw new RuleFileError(`${where}: "dryRun" must be a boolean`, path)
      }
      // The second lever over the same text: with this true the op removes only
      // the blocks describing a FIELD, and leaves every tool's own description
      // where the renderer put it. Optional, and absent means the original
      // behaviour, so every rule file written before this member existed compiles
      // to exactly the op it compiled to before.
      const keepToolDescriptions = raw.keepToolDescriptions
      if (keepToolDescriptions !== undefined && typeof keepToolDescriptions !== 'boolean') {
        throw new RuleFileError(`${where}: "keepToolDescriptions" must be a boolean (received ${JSON.stringify(keepToolDescriptions)})`, path)
      }
      // Default TRUE, for the same reason stripToolDecls defaults true: this edits
      // the SDK text every agent programs against, so the shipped rule measures
      // until an operator has read the number and turned it off.
      return {
        op: 'stripDocComments',
        dryRun: dryRun ?? true,
        ...keepToolDescriptions === undefined ? {} : { keepToolDescriptions: keepToolDescriptions as boolean },
      }
    }
    case 'replaceText': {
      // The flags are read FIRST, because they are what the pattern compiles with:
      // a pattern that is valid under `'g'` and invalid under `'gu'` (a lone
      // surrogate, say) must be judged under the flags the rule actually asked for.
      const flags = readReplaceFlags(raw.flags, where, path)
      const { pattern, source } = readPattern(raw, 'pattern', where, path, flags)
      // An EMPTY replacement is legal and is the whole point of one use of this op
      // — shrinking a line by deleting a clause — so the member is required to be
      // PRESENT but is not required to be non-empty. An ABSENT one is refused:
      // "replace this with nothing" and "I forgot the replacement" must not be the
      // same rule file.
      const replacement = raw.replacement
      if (typeof replacement !== 'string') {
        throw new RuleFileError(`${where}: "replacement" must be a string (received ${JSON.stringify(replacement)})`, path)
      }
      const expect = raw.expect
      if (expect !== undefined && (!Number.isInteger(expect) || (expect as number) < 0)) {
        throw new RuleFileError(`${where}: "expect" must be a non-negative integer (received ${JSON.stringify(expect)})`, path)
      }
      const dryRun = raw.dryRun
      if (dryRun !== undefined && typeof dryRun !== 'boolean') {
        throw new RuleFileError(`${where}: "dryRun" must be a boolean`, path)
      }
      // Default TRUE, like the two strip ops: this op rewrites text a rule does not
      // own — a tool's own description — so a shipped rule measures until an
      // operator has read the count and turned the replacement on.
      return {
        op: 'replaceText',
        pattern,
        source,
        replacement,
        flags,
        dryRun: dryRun ?? true,
        ...expect === undefined ? {} : { expect: expect as number },
      }
    }
    case 'keepBlocks': {
      const header = readPattern(raw, 'headerPattern', where, path)
      const keep = readPattern(raw, 'keepPattern', where, path)
      const denyRaw = raw.denyPattern
      if (denyRaw !== undefined && (typeof denyRaw !== 'string' || denyRaw.length === 0)) {
        throw new RuleFileError(`${where}: "denyPattern" must be a non-empty regular expression`, path)
      }
      const deny = denyRaw === undefined ? undefined : readPattern(raw, 'denyPattern', where, path)
      return {
        op: 'keepBlocks',
        headerPattern: header.pattern,
        keepPattern: keep.pattern,
        headerSource: header.source,
        keepSource: keep.source,
        ...deny === undefined ? {} : { denyPattern: deny.pattern, denySource: deny.source },
      }
    }
    default: {
      const exhaustive: never = op as never
      throw new RuleFileError(`${where}: unknown transform operation ${JSON.stringify(exhaustive)}`, path)
    }
  }
}

/** Read the `transform` list of a `transform` action. */
function readTransform(source: Record<string, unknown>, where: string, path: string): readonly TransformOp[] {
  const value = source.transform
  if (!Array.isArray(value) || value.length === 0) {
    throw new RuleFileError(`${where}: a "transform" action needs a non-empty "transform" sequence of operations`, path)
  }
  return value.map((entry, index) => readTransformOp(entry, `${where}: action.transform[${index}]`, path))
}

/**
 * Read the `allowEmpty` member of a `replace` action.
 *
 * IT IS REFUSED ON EVERY OTHER KIND, deliberately. The member answers "is this
 * replacement allowed to write into a section whose text the deployment emptied
 * on purpose", and no other action has that question: `delete` needs no opt-in to
 * remove nothing, and `prepend`/`append`/`wrap` keep the matched section and add
 * sections of their own beside it. Accepting the switch on those kinds would ship
 * an operator a setting that can never fire — this package's rule file already
 * refuses `splice` outside `replace` for the same reason.
 * @param source - the action mapping.
 * @param where - the diagnostic's subject.
 * @param path - the rule file, for the refusal.
 * @returns the member's value, or undefined when absent.
 */
function readAllowEmpty(source: Record<string, unknown>, where: string, path: string): boolean | undefined {
  const value = source.allowEmpty
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new RuleFileError(`${where}: "action.allowEmpty" must be a boolean (received ${JSON.stringify(value)})`, path)
  }
  return value
}

/**
 * Refuse an `allowEmpty` on an action kind that has no empty-section question.
 *
 * The refusal exists so the operator hears about the switch instead of writing a
 * setting that silently does nothing — see {@link readAllowEmpty}.
 * @param action - the action the kind compiles to, when it is accepted.
 * @param source - the action mapping, read only for the member.
 * @param where - the diagnostic's subject.
 * @param path - the rule file, for the refusal.
 * @returns the action, unchanged.
 */
function assertNoAllowEmpty<T extends Action>(action: T, source: Record<string, unknown>, where: string, path: string): T {
  readAllowEmpty(source, where, path)
  if (source.allowEmpty !== undefined) {
    throw new RuleFileError(`${where}: "action.allowEmpty" is only meaningful on a "replace" action (this one is "${action.kind}")`, path)
  }
  return action
}

/** Read and validate one rule. */
function readRule(raw: unknown, index: number, path: string): Rule {
  const where = `rules[${index}]`
  if (!isRecord(raw)) throw new RuleFileError(`${where}: must be a mapping`, path)
  const id = requireString(raw, 'id', where, path)
  const match = raw.match
  if (!isRecord(match)) throw new RuleFileError(`${where}: "match" must be a mapping with "kind" and "value"`, path)
  const kind = requireMatchKind(match, where, path)
  const value = requireString(match, 'value', `${where}: match`, path)
  const actionRaw = raw.action
  if (!isRecord(actionRaw)) throw new RuleFileError(`${where}: "action" must be a mapping with "kind"`, path)
  const actionKind = requireActionKind(actionRaw, where, path)

  let action: Action
  const text = actionRaw.text
  if (text !== undefined && typeof text !== 'string') {
    throw new RuleFileError(`${where}: "action.text" must be a string`, path)
  }
  switch (actionKind) {
    case 'replace': {
      const fragments = readFragments(actionRaw, where, path)
      if (text === undefined && fragments.length === 0) {
        throw new RuleFileError(`${where}: a "replace" action needs "text", or a non-empty "fragments" sequence`, path)
      }
      if (text !== undefined && fragments.length > 0) {
        throw new RuleFileError(`${where}: a "replace" action takes "text" or "fragments", not both`, path)
      }
      const splice = actionRaw.splice
      if (splice !== undefined && typeof splice !== 'boolean') {
        throw new RuleFileError(`${where}: "action.splice" must be a boolean`, path)
      }
      if (splice === true && fragments.length === 0) {
        throw new RuleFileError(`${where}: "action.splice" is only meaningful with "fragments"`, path)
      }
      // The empty-section guard's single opt-in, read here so a rule file that
      // spells it can reach the action; absent means the guard is ON.
      const allowEmpty = readAllowEmpty(actionRaw, where, path)
      action = {
        kind: 'replace',
        ...text === undefined ? {} : { text },
        fragments,
        ...splice === undefined ? {} : { splice },
        ...allowEmpty === undefined ? {} : { allowEmpty },
      }
      break
    }
    case 'delete':
      action = assertNoAllowEmpty({ kind: 'delete' }, actionRaw, where, path)
      break
    case 'prepend':
    case 'append':
      action = assertNoAllowEmpty({ kind: actionKind, text: text ?? '' }, actionRaw, where, path)
      break
    case 'wrap': {
      const prefix = optionalText(actionRaw, 'prefix', `${where}: action`, path)
      const suffix = optionalText(actionRaw, 'suffix', `${where}: action`, path)
      if (prefix === undefined && suffix === undefined) {
        throw new RuleFileError(`${where}: a "wrap" action needs "prefix", "suffix", or both`, path)
      }
      action = assertNoAllowEmpty(
        { kind: 'wrap', ...prefix === undefined ? {} : { prefix }, ...suffix === undefined ? {} : { suffix } },
        actionRaw, where, path,
      )
      break
    }
    case 'transform': {
      if (text !== undefined) {
        throw new RuleFileError(`${where}: a "transform" action takes "transform" operations, not "text"`, path)
      }
      action = assertNoAllowEmpty({ kind: 'transform', transform: readTransform(actionRaw, where, path) }, actionRaw, where, path)
      break
    }
    default: {
      const exhaustive: never = actionKind
      throw new RuleFileError(`${where}: unknown action kind ${JSON.stringify(exhaustive)}`, path)
    }
  }

  const required = raw.required
  if (required !== undefined && typeof required !== 'boolean') {
    throw new RuleFileError(`${where}: "required" must be a boolean`, path)
  }
  const all = raw.all
  if (all !== undefined && typeof all !== 'boolean') {
    throw new RuleFileError(`${where}: "all" must be a boolean`, path)
  }
  const note = raw.note
  if (note !== undefined && typeof note !== 'string') {
    throw new RuleFileError(`${where}: "note" must be a string`, path)
  }

  return {
    id,
    match: { kind, value },
    action,
    // The default: a rule that does not say otherwise is REQUIRED, so a typo in
    // a section name is a loud failure rather than a silent no-op.
    required: required ?? true,
    all: all ?? true,
    ...note === undefined ? {} : { note },
  }
}

/**
 * Validate a parsed document into a rule set.
 * @param document - the parsed YAML/JSON value.
 * @param path - the file it came from, for every diagnostic.
 * @returns the validated rule set.
 * @throws {RuleFileError} on any schema violation.
 */
export function validateRuleSet(document: unknown, path: string): Omit<RuleSet, 'sha256'> {
  if (!isRecord(document)) {
    throw new RuleFileError('the document must be a mapping with "version" and "rules"', path)
  }
  const version = document.version
  if (version !== RULE_FILE_VERSION) {
    throw new RuleFileError(`"version" must be ${RULE_FILE_VERSION} (received ${JSON.stringify(version)})`, path)
  }
  const rawRules = document.rules
  if (!Array.isArray(rawRules)) {
    throw new RuleFileError('"rules" must be a sequence', path)
  }
  const rules = rawRules.map((raw, index) => readRule(raw, index, path))
  const seen = new Set<string>()
  for (const rule of rules) {
    if (seen.has(rule.id)) throw new RuleFileError(`two rules share the id ${JSON.stringify(rule.id)}`, path)
    seen.add(rule.id)
  }
  return { version, rules, path }
}

/** Where to look, and how to report a bad read. */
export interface LoadRuleFileOptions {
  /** The configured path, absolute, or empty to use the default below. */
  readonly rulesFile: string
  /** The directory the settings service reports for this row; `undefined` when unavailable. */
  readonly settingsDirectory: string | undefined
  /** sha256 of the file's bytes, injected so this module stays free of a crypto import. */
  readonly hash: (text: string) => string
}

/**
 * How a load failed, so the caller can word its own line without matching the
 * sentence. `unconfigured` is the one that is NOT an operator typo: there is no
 * path to look at, so a message that quotes a path has nothing to quote.
 */
export type RuleFileFailureKind = 'unconfigured' | 'missing' | 'unreadable' | 'malformed'

/** The outcome of loading a rule file. */
export type RuleFileLoad =
  | { readonly ok: true; readonly ruleSet: RuleSet }
  | { readonly ok: false; readonly path: string; readonly problem: string; readonly kind: RuleFileFailureKind }

/**
 * Resolve which file a configuration points at.
 *
 * An absolute configured path is used as written. A relative one is resolved
 * against the settings directory when there is one, and against the process cwd
 * otherwise — never silently against the package directory, which would make a
 * published package's own folder the place an operator's rules land.
 * @param options - the configuration and the settings directory.
 * @returns the absolute path, or `undefined` when there is nothing to resolve against.
 */
export function ruleFilePath(options: LoadRuleFileOptions): string | undefined {
  if (options.rulesFile.length > 0) {
    if (isAbsolute(options.rulesFile)) return options.rulesFile
    const base = options.settingsDirectory ?? process.cwd()
    return resolve(base, options.rulesFile)
  }
  if (options.settingsDirectory === undefined) return undefined
  return join(options.settingsDirectory, DEFAULT_RULE_FILE_NAME)
}

/**
 * The sentence for the ONE failure that is a configuration gap rather than a
 * disk fault: no path to read at all.
 *
 * It exists because the failure it replaces was invisible. When the settings
 * lookup silently answered `undefined`, `loadRuleFile` reported "no rules file
 * path is configured", the caller turned that into a cleared pin, and rewrite
 * mode then ran with no rules in force and nothing in the log naming the cause —
 * the observation window showed mode `rewrite` on every line and `:rules` on
 * none. The sentence therefore names the MISSING thing, says what follows from it,
 * and says what to do about it, so this state can only be reached loudly.
 * @param problem - what the settings lookup reported, verbatim.
 * @returns the line to log.
 */
export function describeUnresolvedRulePath(problem: string): string {
  return [
    'rewrite mode cannot read a rule file: CONFIGURATION MISSING.',
    `what is missing: ${problem}.`,
    `and no absolute path was configured either (config.rulesFile is empty), so there is nothing to read.`,
    `consequence: no rule set is in force for this subject and its pin is cleared, so every assembly it makes is returned UNCHANGED — this is a degradation, not a clean observation.`,
    `fix: set config.rulesFile to an absolute path, or make the settings service report a directory for this row.`,
  ].join(' ')
}

/**
 * Read and validate the rule file.
 *
 * A missing file and an unreadable file are DIFFERENT outcomes for the caller:
 * a missing file is the normal state of a fresh profile and observe mode runs
 * anyway, while an unreadable or malformed file is a configuration error that
 * must be reported loudly. Both are returned, not thrown, so the caller decides.
 * @param options - the configuration, the settings directory, and the hash function.
 * @returns the rule set, or the sentence explaining why there is none.
 */
export async function loadRuleFile(options: LoadRuleFileOptions): Promise<RuleFileLoad> {
  const path = ruleFilePath(options)
  if (path === undefined) {
    // NOT a missing file: nothing was ever looked for. The caller separates this
    // from `missing` by `kind` so it can name the configuration gap instead of
    // reporting a read that never happened.
    return { ok: false, path: '', problem: 'no rules file path is configured and no settings directory was readable to derive one from', kind: 'unconfigured' }
  }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return { ok: false, path, problem: 'MISSING', kind: 'missing' }
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, path, problem: `could not be read: ${reason}`, kind: 'unreadable' }
  }
  let document: unknown
  try {
    document = parseYamlSubset(text)
  } catch (error) {
    if (error instanceof YamlSubsetError) return { ok: false, path, problem: error.message, kind: 'malformed' }
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, path, problem: `could not be parsed: ${reason}`, kind: 'malformed' }
  }
  try {
    const ruleSet = validateRuleSet(document, path)
    return { ok: true, ruleSet: { ...ruleSet, sha256: options.hash(text) } }
  } catch (error) {
    if (error instanceof RuleFileError) {
      return { ok: false, path, problem: error.message.startsWith(path) ? error.message.slice(path.length + 2) : error.message, kind: 'malformed' }
    }
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, path, problem: reason, kind: 'malformed' }
  }
}

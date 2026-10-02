/**
 * The dynamic tool-name list: the file an external decision layer writes, the
 * format this reader accepts, and how one list is folded into a compiled rule set.
 *
 * WHY THIS EXISTS. `stripToolDecls` decides which tools' SDK declarations are
 * removed from the generated `tools:sdk` text. Its `names` were a compile-time
 * literal on the rule (`transform.ts`), so changing them meant editing the rule
 * file by hand — but WHICH tools may be declared lazily is a measurement (how
 * often a tool is actually called in this deployment), and a measurement belongs
 * to whatever produces it. This module is the seam: a small YAML/JSON file, read
 * once per session, that can only WIDEN what a rule already names.
 *
 * WHY THE PIN IS PER SESSION, AND WHY THAT IS THE HARD REQUIREMENT. The assembled
 * system prompt is the prefix of every request, and a KV-cache prefix is reused
 * only while its bytes are unchanged — the argument `transform.ts` makes about
 * the operations themselves. A list re-read per assembly would therefore be free
 * to change the prompt MID-SESSION and destroy that reuse, so the list is read
 * when a session is created and THE SESSION KEEPS WHAT IT WAS GIVEN for its whole
 * life: not "the newest list wins", but "your list". Two sessions alive at once
 * hold two pins, and neither can move the other's prompt. `index.ts` owns that
 * map; this module owns the format, the fallback, and the fold.
 *
 * THE FALLBACK IS ALWAYS "RESIDENT", AND THAT DIRECTION IS CHOSEN. A file that is
 * missing, unreadable, malformed, or that carries no names all resolve to ZERO
 * dynamic names. Zero dynamic names means every declaration the rule file does not
 * already name stays in the prompt: the conservative outcome, which costs tokens
 * and breaks nothing. The other direction — a stale or half-parsed list that
 * strips a declaration the model still needs — hides a tool that remains callable,
 * and that is the failure worth refusing.
 *
 * THE LIST CAN ONLY ADD TO A RULE'S OWN NAMES, NEVER REMOVE ONE. The effective
 * names of an op are the UNION of its static `names:` and the file's list, in
 * that order. So an op that does not say `namesFrom:` behaves exactly as it did
 * before this module existed, and an op that says it can never lose a name it
 * spells out. That is the backward-compatibility decision, stated here because it
 * carries the whole compatibility argument: the shipped `schedule_*` strip keeps
 * working when the file is absent, and an absent file cannot weaken it.
 *
 * THE FILE FORMAT, complete:
 *
 *   version: 1                     # required, must be 1
 *   names:                         # required, a sequence; may be empty
 *     - schedule_create
 *     - schedule_delete
 *   note: written by the decision layer at 2026-10-02T13:00:00+08:00   # optional
 *
 * Unknown top-level keys are IGNORED, unlike the rule file's own schema, because
 * this file belongs to a producer that is expected to grow members (a
 * `generatedAt`, a `model`, a distribution table). An unknown key cannot change
 * what is stripped, so refusing it would only couple this reader to a producer it
 * does not own. A malformed `names` entry still refuses the whole file: a list
 * that is half-readable is not a list, and the fallback for "not a list" is the
 * resident one.
 *
 * @module @t4r71/dsh-prompt-plan/tool-names
 */

import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { CompiledRule } from './rewrite.ts'
import { parseYamlSubset, YamlSubsetError } from './yaml.ts'

/** The format version this reader accepts. */
export const TOOL_NAMES_FILE_VERSION = 1

/** The directory-relative name an operator can use without inventing one. */
export const DEFAULT_TOOL_NAMES_FILE_NAME = 'prompt-plan.tool-names.yaml'

/** One names file, validated. */
export interface ToolNamesFile {
  /** The format version, as read. */
  readonly version: number
  /** The names, in file order, de-duplicated. */
  readonly names: readonly string[]
  /** Where it was read from. */
  readonly path: string
  /** sha256 of the file's bytes, so a log line can name the exact revision in force. */
  readonly sha256: string
  /** Free text the producer wrote, carried into the log line when present. */
  readonly note?: string
}

/** A refusal from the names-file reader, with the file it concerns. */
export class ToolNamesFileError extends Error {
  /** The file the sentence concerns. */
  readonly path: string
  /**
   * @param message - the sentence explaining what is wrong.
   * @param path - the names file path.
   */
  constructor(message: string, path: string) {
    super(`${path}: ${message}`)
    this.name = 'ToolNamesFileError'
    this.path = path
  }
}

/** Structural check shared with the rule-file validator's shape. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate a parsed names document.
 *
 * Strict about `version` and `names`, and deliberately not strict about
 * anything else — see the module doc for why the two postures differ.
 * @param document - the parsed YAML/JSON value.
 * @param path - the file it came from, for every diagnostic.
 * @returns the validated file, minus its hash.
 * @throws {ToolNamesFileError} on any schema violation.
 */
export function validateToolNames(document: unknown, path: string): Omit<ToolNamesFile, 'sha256'> {
  if (!isRecord(document)) {
    throw new ToolNamesFileError('the document must be a mapping with a "names" sequence', path)
  }
  const version = document.version
  if (version !== TOOL_NAMES_FILE_VERSION) {
    throw new ToolNamesFileError(`"version" must be ${TOOL_NAMES_FILE_VERSION} (received ${JSON.stringify(version)})`, path)
  }
  const raw = document.names
  if (!Array.isArray(raw)) {
    throw new ToolNamesFileError(`"names" must be a sequence of tool names (received ${JSON.stringify(raw)})`, path)
  }
  const names: string[] = []
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new ToolNamesFileError(`"names[${index}]" must be a non-empty string (received ${JSON.stringify(entry)})`, path)
    }
    const name = entry.trim()
    // De-duplicated rather than refused: a producer that emits the same name
    // twice means the same thing, and a duplicate cannot change the strip.
    if (!names.includes(name)) names.push(name)
  }
  const note = document.note
  if (note !== undefined && typeof note !== 'string') {
    throw new ToolNamesFileError(`"note" must be a string (received ${JSON.stringify(note)})`, path)
  }
  return {
    version: TOOL_NAMES_FILE_VERSION,
    names,
    path,
    ...note === undefined ? {} : { note },
  }
}

/** Where to look for a names file, and how to report a bad read. */
export interface LoadToolNamesOptions {
  /** The `namesFrom` value as written on the op: absolute, or relative to the rule file. */
  readonly namesFrom: string
  /** The RESOLVED rule file path, used as the base for a relative `namesFrom`. */
  readonly rulesFile: string | undefined
  /** The directory the settings service reports for this row; the second base. */
  readonly settingsDirectory: string | undefined
  /** sha256 of the file's bytes, injected so this module stays free of a crypto import. */
  readonly hash: (text: string) => string
}

/** The outcome of loading one names file. */
export type ToolNamesLoad =
  | { readonly ok: true; readonly file: ToolNamesFile }
  | { readonly ok: false; readonly path: string; readonly problem: string }

/**
 * Resolve the file a `namesFrom` value points at.
 *
 * A relative `namesFrom` resolves against the RULE FILE's directory, because the
 * two files are authored together and a rule file that moved must carry its list
 * with it. The settings directory is the second base, for a row configured with an
 * absolute `rulesFile` outside the profile; the process cwd is the last resort,
 * never the package directory — the same reasoning `rules.ts` gives for its own
 * paths.
 * @param options - the written value and the two base directories.
 * @returns the absolute path, or `undefined` when there is nothing to resolve against.
 */
export function toolNamesFilePath(options: Pick<LoadToolNamesOptions, 'namesFrom' | 'rulesFile' | 'settingsDirectory'>): string | undefined {
  if (isAbsolute(options.namesFrom)) return options.namesFrom
  if (options.rulesFile !== undefined) return resolve(dirname(options.rulesFile), options.namesFrom)
  if (options.settingsDirectory !== undefined) return resolve(options.settingsDirectory, options.namesFrom)
  return resolve(process.cwd(), options.namesFrom)
}

/**
 * Read and validate one names file.
 *
 * A missing file, an unreadable file and a malformed file are returned as three
 * DIFFERENT problems rather than thrown, because the caller logs them at different
 * levels and an operator fixes them differently. All three degrade the same way:
 * zero dynamic names.
 * @param options - the written path, the base directories, and the hash function.
 * @returns the names, or the sentence explaining why there are none.
 */
export async function loadToolNames(options: LoadToolNamesOptions): Promise<ToolNamesLoad> {
  const path = toolNamesFilePath(options)
  if (path === undefined) {
    return { ok: false, path: options.namesFrom, problem: 'no path could be resolved for it' }
  }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return { ok: false, path, problem: 'MISSING' }
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, path, problem: `could not be read: ${reason}` }
  }
  let document: unknown
  try {
    document = parseYamlSubset(text)
  } catch (error) {
    if (error instanceof YamlSubsetError) return { ok: false, path, problem: error.message }
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, path, problem: `could not be parsed: ${reason}` }
  }
  try {
    const file = validateToolNames(document, path)
    return { ok: true, file: { ...file, sha256: options.hash(text) } }
  } catch (error) {
    if (error instanceof ToolNamesFileError) {
      const message = error.message.startsWith(path) ? error.message.slice(path.length + 2) : error.message
      return { ok: false, path, problem: message }
    }
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, path, problem: reason }
  }
}

/**
 * What one `namesFrom` value resolved to, as the fold and the log line need it.
 *
 * `names` is EMPTY on every failure, which is the conservative fallback stated
 * once, at the type's own level: there is no path through this module on which a
 * failed read contributes a name.
 */
export interface ToolNamesSource {
  /** The `namesFrom` value exactly as written on the op. */
  readonly namesFrom: string
  /** The resolved absolute path, or the written value when nothing could be resolved. */
  readonly path: string
  /** The names the file carries; empty when the read failed or the list is empty. */
  readonly names: readonly string[]
  /** sha256 of the file, when it was read. */
  readonly sha256?: string
  /** Why the list is empty, when it is empty because of a failure rather than a choice. */
  readonly problem?: string
  /** The producer's own note, when the file carries one. */
  readonly note?: string
}

/** Turn a load outcome into the source the fold consumes. */
export function toolNamesSource(namesFrom: string, load: ToolNamesLoad): ToolNamesSource {
  if (load.ok) {
    return {
      namesFrom,
      path: load.file.path,
      names: load.file.names,
      sha256: load.file.sha256,
      ...load.file.note === undefined ? {} : { note: load.file.note },
    }
  }
  return { namesFrom, path: load.path, names: [], problem: load.problem }
}

/**
 * The union of a rule's own names and the dynamic list, order-preserving.
 *
 * Static names come first so the effective list reads as "what the rule says, plus
 * what the file added" — which is the order the log line prints and the order an
 * operator compares against the rule file.
 * @param staticNames - the op's own `names`.
 * @param dynamicNames - the names the file carries.
 * @returns a new list with no duplicates.
 */
export function mergeToolNames(staticNames: readonly string[], dynamicNames: readonly string[]): string[] {
  const merged: string[] = []
  for (const name of [...staticNames, ...dynamicNames]) {
    if (!merged.includes(name)) merged.push(name)
  }
  return merged
}

/** Every distinct `namesFrom` an op declares, in first-seen order. */
export function toolNamesPathsOf(rules: readonly CompiledRule[]): string[] {
  const paths: string[] = []
  for (const rule of rules) {
    if (rule.action.kind !== 'transform') continue
    for (const op of rule.action.transform ?? []) {
      if (op.op !== 'stripToolDecls' || op.namesFrom === undefined) continue
      if (!paths.includes(op.namesFrom)) paths.push(op.namesFrom)
    }
  }
  return paths
}

/** What one opted-in op ended up with. */
export interface ToolNamesOpResolution {
  /** The rule that owns the op. */
  readonly ruleId: string
  /** The op's `namesFrom`, as written. */
  readonly namesFrom: string
  /** The op's own names. */
  readonly staticNames: readonly string[]
  /** The names the file contributed. */
  readonly dynamicNames: readonly string[]
  /** What the op was compiled with: static ∪ dynamic, in that order. */
  readonly effective: readonly string[]
}

/** The fold's result: fresh rules, and what was decided. */
export interface ToolNamesApplication {
  /** The compiled rules to use. An op with no `namesFrom` is passed through by reference. */
  readonly rules: CompiledRule[]
  /** One entry per opted-in op, in rule order. */
  readonly ops: readonly ToolNamesOpResolution[]
  /** Every static `stripToolDecls` name seen, in first-seen order. */
  readonly staticNames: readonly string[]
}

/**
 * Fold the resolved sources into a compiled rule set.
 *
 * PURITY AND ISOLATION. An op that declares `namesFrom` is REBUILT as a fresh
 * object, never edited in place, for two reasons that are both load-bearing:
 *   - the op carries per-application state (`lastReport`, `lastRefusal`) that is
 *     written by `applyTransformOp` while an assembly runs, so two pins sharing
 *     one op would overwrite each other's measurement;
 *   - the op carries the names it was compiled with, and two sessions must never
 *     be able to observe each other's list through a shared object.
 * The caller compiles one rule set PER PIN, so the objects a pin passes through
 * untouched are already that pin's own — this function does not need to deep-copy
 * the rest, and the fresh-object rule above is what makes that safe rather than
 * merely true today.
 * @param rules - the compiled rules, as `compileRules` produced them.
 * @param sources - one entry per distinct `namesFrom`; a missing entry contributes nothing.
 * @returns fresh rules plus the resolutions the log line is built from.
 */
export function applyToolNames(rules: readonly CompiledRule[], sources: readonly ToolNamesSource[]): ToolNamesApplication {
  const byNamesFrom = new Map<string, ToolNamesSource>()
  for (const source of sources) byNamesFrom.set(source.namesFrom, source)
  const ops: ToolNamesOpResolution[] = []
  const staticNames: string[] = []
  const compiled: CompiledRule[] = []
  for (const rule of rules) {
    const action = rule.action
    if (action.kind !== 'transform') {
      compiled.push(rule)
      continue
    }
    let rebuilt = false
    const transform = (action.transform ?? []).map(op => {
      if (op.op !== 'stripToolDecls') return op
      for (const name of op.names) if (!staticNames.includes(name)) staticNames.push(name)
      if (op.namesFrom === undefined) return op
      const dynamicNames = byNamesFrom.get(op.namesFrom)?.names ?? []
      const effective = mergeToolNames(op.names, dynamicNames)
      ops.push({
        ruleId: rule.id,
        namesFrom: op.namesFrom,
        staticNames: [...op.names],
        dynamicNames: [...dynamicNames],
        effective,
      })
      rebuilt = true
      return { ...op, names: effective }
    })
    compiled.push(rebuilt ? { ...rule, action: { ...action, transform } } : rule)
  }
  return { rules: compiled, ops, staticNames }
}

/** One line the plugin logs, with the level it belongs at. */
export interface ToolNamesLogLine {
  /** Which logger method the line belongs to. */
  readonly level: 'info' | 'warn' | 'error'
  /** The message, with the plugin's own `prompt-plan: ` prefix. */
  readonly message: string
}

/** Render a name list for a log line. */
function list(names: readonly string[]): string {
  return `[${names.join(', ')}]`
}

/**
 * Describe one pin, as the lines an operator reads.
 *
 * This is the whole of the "what is in force" evidence: every line carries the
 * EFFECTIVE names, where the static half came from, and where the dynamic half came
 * from — or the sentence saying why there is no dynamic half. A pin that opted in
 * and could not read its file is a warning, a malformed file is an error, and a
 * successfully read list is information; all three still state the effective list,
 * because "the fallback is in force" is a fact an operator has to be able to read
 * off the log rather than infer from the absence of a line.
 * @param where - the pin's subject, e.g. `session "abc"` or `mount`.
 * @param application - the fold's result.
 * @param sources - the resolved sources, for the paths and sha256s.
 * @returns one line per reported fact.
 */
export function describeToolNamesPin(where: string, application: ToolNamesApplication, sources: readonly ToolNamesSource[]): ToolNamesLogLine[] {
  if (application.ops.length === 0) {
    return [{
      level: 'info',
      message: `prompt-plan: tool names for ${where}: no stripToolDecls op declares "namesFrom", so only the rule file's static names apply; effective ${list(application.staticNames)} (${application.staticNames.length} name(s))`,
    }]
  }
  const byNamesFrom = new Map<string, ToolNamesSource>()
  for (const source of sources) byNamesFrom.set(source.namesFrom, source)
  const lines: ToolNamesLogLine[] = []
  for (const op of application.ops) {
    const source = byNamesFrom.get(op.namesFrom)
    const head = `prompt-plan: tool names for ${where}: rule ${JSON.stringify(op.ruleId)} `
    const tail = `; static ${list(op.staticNames)} (${op.staticNames.length}) from the rule file; effective ${list(op.effective)} (${op.effective.length} name(s))`
    if (source === undefined) {
      lines.push({ level: 'error', message: head + `could not resolve "namesFrom: ${op.namesFrom}"; the dynamic list is EMPTY and nothing beyond the static names is stripped` + tail })
      continue
    }
    if (source.problem !== undefined) {
      const missing = source.problem === 'MISSING'
      lines.push({
        level: missing ? 'warn' : 'error',
        message: head + `opted in with "namesFrom: ${op.namesFrom}" -> ${source.path}, which is ${source.problem}; the dynamic list is EMPTY (conservative fallback: nothing beyond the static names is stripped)` + tail,
      })
      continue
    }
    const provenance = source.note === undefined ? '' : `; note ${JSON.stringify(source.note)}`
    lines.push({
      level: 'info',
      message: head + `opted in with "namesFrom: ${op.namesFrom}" -> ${source.path} (sha256 ${(source.sha256 ?? '').slice(0, 12)}, ${op.dynamicNames.length} name(s)${provenance}); dynamic ${list(op.dynamicNames)}` + tail,
    })
  }
  return lines
}

/** The id a session-like value exposes, when it exposes one. */
function sessionIdOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const session = record.session
  if (typeof session === 'string' && session.length > 0) return session
  if (session !== null && typeof session === 'object') {
    const id = (session as Record<string, unknown>).id
    if (typeof id === 'string' && id.length > 0) return id
  }
  // A caller that passes the session itself, or an object whose own id IS the
  // assembly subject. Both are stable per assembly, which is all a pin needs.
  const own = record.id
  return typeof own === 'string' && own.length > 0 ? own : undefined
}

/**
 * The pin key of one assembly.
 *
 * `assembleContextFor` in `@deepseek-ai/dsh-agent` builds the context as
 * `{ agent, scope: agent, signal }` (`packages/core/agent/src/dispatch.ts:174-176`),
 * so the agent — and through it the session — is on the wire even though
 * `AssembleContext` declares only `scope` and `signal`. This reads it WITHOUT
 * requiring any member to exist: an assembly that carries no subject returns
 * `undefined`, and the caller then uses the mount-time pin, which is just as
 * stable. Missing the key must never mean "re-read the file", because that is the
 * mid-session prompt change the pin exists to prevent.
 * @param context - the waterfall's per-assembly context.
 * @returns the session id when one is reachable, else undefined.
 */
export function sessionKeyOf(context: unknown): string | undefined {
  if (context === null || typeof context !== 'object') return undefined
  const record = context as Record<string, unknown>
  return sessionIdOf(record.agent) ?? sessionIdOf(record.scope)
}

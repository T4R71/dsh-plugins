/**
 * Section-name-matched system-prompt rewriting, as one host plugin.
 *
 * TWO MODES, ONE SEAM.
 *
 * The seam is `system-prompt/assemble`, a cordis waterfall over the assembled
 * prompt. This plugin registers ONE listener with `{ global: true }` and no
 * `prepend`, which means it runs after every listener that did not prepend —
 * including upstream's own invariant companion, whose listener is
 * `{ global: true, prepend: true }` (`packages/core/system-prompt/src/invariant.ts:47-51`)
 * and therefore sits INSIDE this one. That ordering is the shape upstream
 * already uses for a read-only observer, so it is the accepted one.
 *
 *   observe  `await next()`, write what arrived, and RETURN THE SAME OBJECT,
 *            unchanged. Nothing is added, removed, reordered or retexted.
 *   rewrite  `await next()`, apply the rule file to the RETURNED sections, and
 *            return a NEW assembly built from new section objects.
 *
 * THE THREE RULES THIS LISTENER OBEYS, and why each is not optional:
 *
 *   B1 — return the value. `assemble` awaits this waterfall and returns it
 *   verbatim (`packages/core/system-prompt/src/index.ts:625-628`), so failing to
 *   return `next()`'s value does not "skip a step": it deletes the whole system
 *   prompt. Observe mode returns the very same reference for this reason.
 *
 *   B2 — expand, never mutate in place. The section objects are shared with the
 *   assembly the registry built and with any snapshot another listener kept.
 *   Rewrite mode therefore builds fresh objects and a fresh array; observe mode
 *   builds nothing at all.
 *
 *   B3/B5 — leave `variables`, `contexts` and `tools` alone. `variables` has live
 *   writers and a persistent reader that records what it reads; `contexts` is
 *   emptied wholesale after the waterfall when the runtime suppressor is on, and
 *   is asserted on by name elsewhere. A rewrite there is either discarded or
 *   corrupting, so this plugin returns all three by reference.
 *
 * `complete: true` IS NOT REWRITABLE THROUGH THIS SEAM, and this plugin says so
 * instead of pretending otherwise. `assemble` snapshots a complete section
 * BEFORE running the waterfall and restores it after, collapsing the sections to
 * that one element (`:601-611`, `:629-634`). The mark never reaches a listener,
 * so the only available test is the restore's OUTPUT SHAPE — a sections array
 * shorter than two. `detectCompleteShape` in `./sections.ts` carries the test
 * and, next to it, the exact limits of that test.
 *
 * @module @t4r71/dsh-prompt-plan
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { CacheLedger, CACHE_ARTIFACT_NAMES, describeUsage, ruleSetHashOf } from './cache.ts'
import { Config as ConfigSchema, PROMPT_PLAN_ROW_ID, settingsDirectoryOf } from './config.ts'
import type { Config, ResolvedConfig } from './config.ts'
import { resolvedConfig } from './config.ts'
import { sha256 } from './digest.ts'
import { Observer, PURITY_CRITERIA } from './observe.ts'
import { compileRules, applyRules } from './rewrite.ts'
import type { CompiledRule, RuleTrace } from './rewrite.ts'
import { detectCompleteShape, detectCompleteRegistry } from './sections.ts'
import { logStripReports } from './strip-report.ts'
import { completeRefusal, completeRegistrationRefusal, readSectionList } from './sections.ts'
import type { SectionRecord } from './sections.ts'
import { describeUnresolvedRulePath, loadRuleFile, ruleFilePath } from './rules.ts'
import type { RuleSet } from './rules.ts'
import {
  applyToolNames,
  describeToolNamesPin,
  loadToolNames,
  sessionKeyOf,
  toolNamesPathsOf,
  toolNamesSource,
} from './tool-names.ts'
import type { ToolNamesApplication, ToolNamesLogLine, ToolNamesSource } from './tool-names.ts'

export * from './actions.ts'
export * from './cache.ts'
export * from './config.ts'
export * from './digest.ts'
export * from './naming.ts'
export * from './observe.ts'
export * from './rewrite.ts'
export * from './rules.ts'
export * from './sections.ts'
export * from './strip.ts'
export * from './tool-names.ts'
export * from './transform.ts'
export * from './yaml.ts'

/** The name of the artifact directory created beside the resolved rule file. */
export const DEFAULT_ARTIFACT_DIRECTORY = 'prompt-plan-observations'

/** How many nearest names a mismatch diagnostic lists. */
export const NEAREST_NAME_LIMIT = 10

/**
 * One pin: the rules ONE subject keeps for its whole life.
 *
 * A pin is the unit this plugin reasons in, and it exists because of a hard
 * requirement rather than a taste. The assembled system prompt is the prefix of
 * every request, and a KV-cache prefix is reused only while its bytes are
 * unchanged, so a rule set that could change between two turns of the same session
 * is a rule set that costs a full cache miss. A pin is therefore taken ONCE per
 * subject — at mount for the fallback and for every session that already exists,
 * and at `session/created` for that session — and never re-taken: editing the rule
 * file or the tool-name list changes the NEXT session, never the running one.
 */
export interface RulePin {
  /** The compiled rules, every `namesFrom` op already folded into concrete names. */
  readonly rules: readonly CompiledRule[]
  /** The rule set the rules came from, so an observation can name the exact revision. */
  readonly ruleSet: RuleSet
  /** What the tool-name fold decided, kept for the log line and for tests. */
  readonly names: ToolNamesApplication
}

/**
 * Where this plugin's two file-facing paths resolve to.
 *
 * Kept as a small value type so the mount-time log line and the observer agree
 * by construction rather than by two spellings of the same join.
 */
export interface Paths {
  /** The rule file, or `undefined` when nothing could be resolved. */
  readonly rulesFile: string | undefined
  /** The artifact directory. */
  readonly artifactDir: string
}

/**
 * Resolve both paths from the config and the settings service.
 * @param config - the resolved config.
 * @param settingsDirectory - the directory this row's settings were declared in, if known.
 * @returns the two paths the plugin will use.
 */
export function resolvePaths(config: ResolvedConfig, settingsDirectory: string | undefined): Paths {
  const rulesFile = ruleFilePath({ rulesFile: config.rulesFile, settingsDirectory, hash: sha256 })
  if (config.artifactDir.length > 0) {
    return { rulesFile, artifactDir: config.artifactDir }
  }
  // Beside the rule file, which is in the profile directory: the operator's
  // decision is that rules and observation products stay on the profile side,
  // away from the package.
  const base = rulesFile === undefined
    ? settingsDirectory
    : join(rulesFile, '..')
  return {
    rulesFile,
    artifactDir: base === undefined ? join(process.cwd(), DEFAULT_ARTIFACT_DIRECTORY) : join(base, DEFAULT_ARTIFACT_DIRECTORY),
  }
}

/**
 * Write one pin's lines to the host log.
 *
 * The lines are built by `describeToolNamesPin`, which is pure, so the wording is
 * testable without a cordis context and the handler stays a handler — the same
 * split `strip-report.ts` makes for its own line.
 * @param logger - the host logger.
 * @param lines - the lines the pure describer produced.
 */
function logToolNamesPin(logger: {
  info: (message: string, ...args: unknown[]) => void
  warn: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
}, lines: readonly ToolNamesLogLine[]): void {
  for (const line of lines) logger[line.level]('%s', line.message)
}

/**
 * The session id a `session/event` listener was handed.
 *
 * Read structurally and defensively: the id is a branded string on the session
 * (`Session.id`, `dsh-session/lib/types/index.d.ts:123`), but this is a
 * diagnostic attribution and an unreadable session must yield `null` — the
 * ledger's own "no subject" — rather than an exception inside the event feed.
 * @param session - the session the event carried.
 * @returns its id, or undefined when one cannot be read.
 */
function subjectIdOf(session: unknown): string | undefined {
  if (session === null || typeof session !== 'object') return undefined
  const id = (session as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** The plugin class. */
export class PromptPlan {
  /**
   * Nothing is injected, and the listener still needs only the seam.
   *
   * The complete-section test reads the `systemPrompt` service, but it does so
   * OPTIONALLY through {@link systemPrompt}: a cordis service cursor reachable
   * from a context whose fiber did not inject it. Declaring it as an injection
   * would make this plugin fail to load in a composition that has no prompt
   * registry at all — and in such a composition the seam it listens on never
   * fires either, so refusing to load would be a worse failure than a missing
   * test. {@link detectCompleteRegistry} reports "not reachable" as its own
   * outcome, which the handler logs as a warning rather than as a clean result.
   */
  static inject = [] as const

  /**
   * The prompt registry this listener is bound to, when it is reachable.
   *
   * Filled in the constructor from the mounting context, NOT declared as an
   * injected field: this is a LOOKUP whose absence is survivable, not a
   * dependency. `undefined` means the complete-section test could not run; it
   * never means "no complete section is registered", and the handler logs the
   * two differently for exactly that reason.
   */
  private presetRegistry: unknown

  /** This row's composition config schema, validated by the loader before construction. */
  static Config = ConfigSchema

  private resolved: ResolvedConfig
  private observer: Observer | undefined
  /**
   * The cache-stability ledgers, or undefined when `config.cacheDiag` is false.
   *
   * Undefined is the DEFAULT and it is not a degenerate case: with no ledger
   * there is no second listener on `session/event` and no second artifact
   * directory, so a deployment that is not chasing a cache problem pays nothing
   * for this feature existing.
   */
  private ledger: CacheLedger | undefined
  /**
   * The pin an assembly uses when it carries no session, and the revision every
   * session that already existed at mount was given.
   *
   * Written ONCE, by the mount-time load, and never by a `session/created` event:
   * if a new session could move the fallback, a session that never got a pin of its
   * own would see its prompt change when an unrelated session started.
   */
  private fallback: RulePin | undefined
  /**
   * One pin per session id. A session's own pin is the ONLY thing its assemblies
   * ever read, so a second session — or a re-read after the rule file changed —
   * cannot move the first session's prompt.
   */
  private readonly pins = new Map<string, RulePin>()
  /**
   * The directory this row's settings were declared in, read ONCE at mount.
   *
   * Kept rather than re-read because it is also the base the default artifact
   * directory is derived from: re-reading it in {@link reloadRules} could resolve
   * a rule file in a different directory than the artifacts are being written to,
   * which is a silent split an operator would have no way to notice.
   */
  private readonly settingsDirectory: string | undefined

  /**
   * Why `settingsDirectory` is undefined, when it is.
   *
   * Kept beside the directory rather than folded into it because the two answer
   * different questions and both end up in a log line: "what directory" and "why
   * not". Undefined exactly when there IS a directory, so a non-undefined value
   * here is always a real configuration gap.
   */
  private readonly settingsDirectoryProblem: string | undefined

  /**
   * The RESOLVED rule file path, kept from mount.
   *
   * Kept for the same reason `settingsDirectory` is: it is the base a relative
   * `namesFrom` resolves against, and re-deriving it per pin could resolve a
   * tool-name list beside a different rule file than the one being loaded.
   */
  private readonly rulesFilePath: string | undefined

  /**
   * @param ctx - host context.
   * @param config - the config captured at mount.
   */
  constructor(ctx: Context, config: Config) {
    this.resolved = resolvedConfig(config)
    try {
      // The service accessor is typed by CLASS, and this package does not import
      // the registry's class (it is a peer dependency resolved by the host, and
      // the plugin is built to run without it). The name-keyed form is what the
      // accessor accepts at runtime — measured: `ctx.get('systemPrompt')` returns
      // the registry instance with its `layers`, while `ctx.get(SystemPrompt)`
      // returns a different object for the same service. The cast is the price of
      // a lookup by name, and it is deliberate that a failure here is survivable.
      // See the class doc for why this is not an injected dependency.
      this.presetRegistry = ctx.get('systemPrompt' as never)
      if (this.presetRegistry === undefined) {
        ctx.logger?.debug('prompt-plan: the systemPrompt service was not resolvable at mount; it will be looked up per assembly for the complete:true test')
      }
    } catch {
      // A cordis context refuses an unavailable service by throwing. That is a
      // legitimate composition — a host with no prompt registry — and it is not
      // an error to propagate into a waterfall.
      this.presetRegistry = undefined
    }
    // The lookup REPORTS; it cannot silently answer undefined. When it fails, the
    // reason is kept and printed, and every later step that depends on the
    // directory says what it lost — see reloadRules below.
    const lookup = settingsDirectoryOf(
      ctx.get('settings') as { describe: () => readonly { ns?: unknown; directory?: unknown }[] } | undefined,
      PROMPT_PLAN_ROW_ID,
    )
    this.settingsDirectory = lookup.ok ? lookup.directory : undefined
    this.settingsDirectoryProblem = lookup.ok ? undefined : lookup.problem
    if (this.settingsDirectoryProblem !== undefined && this.resolved.mode === 'rewrite' && this.resolved.rulesFile.length === 0) {
      // Both bases are gone AND there is nothing absolute to read: the rule file
      // cannot be found by any route. This is the exact state that used to run
      // silently, so it is reported at the moment it is known, not only later when
      // a load fails on it.
      ctx.logger?.error('prompt-plan: %s', describeUnresolvedRulePath(this.settingsDirectoryProblem))
    }
    const paths = resolvePaths(this.resolved, this.settingsDirectory)
    this.rulesFilePath = paths.rulesFile
    this.observer = new Observer({
      directory: paths.artifactDir,
      mode: this.resolved.mode,
      // The three caps are passed here and nowhere else: the Observer is the only
      // thing that rotates, and it rotates inside its own write queue. Not passing
      // them would leave the observation logs unbounded, which is the 842 MB this
      // revision exists to prevent.
      lines: {
        sections: this.resolved.observationLines,
        sectionsText: this.resolved.observationTextLines,
        purity: this.resolved.observationPurityLines,
      },
      keep: this.resolved.observationKeep,
      report: (record) => {
        ctx.logger?.error(
          'prompt-plan: PURITY VIOLATION at assembly %s — %s',
          String(record.ordinal),
          record.failures.join('; '),
        )
      },
    })
    // The cache ledgers, in the same directory as the observation artifacts:
    // the two are read together, and a second directory would be a second place
    // an operator has to know about. Installed ONLY when asked for.
    this.ledger = this.resolved.cacheDiag
      ? new CacheLedger({
          directory: paths.artifactDir,
          lines: this.resolved.cacheLedgerLines,
          keep: this.resolved.cacheLedgerKeep,
          heartbeat: this.resolved.cacheHeartbeat,
          alwaysRecordPrefix: this.resolved.cacheRecordEveryAssembly,
          report: (message) => { ctx.logger?.warn('%s', message) },
        })
      : undefined
    // The mount line. It carries the purity criterion in force, so a host log
    // and the purity.jsonl lines written beside it can be tied to one revision of
    // the criterion without inspecting the installed package.
    ctx.logger?.info(
      'prompt-plan: mounted; mode %s; purity criteria %s; rule file %s; artifacts %s; settings dir %s; settings dir problem %s',
      this.resolved.mode,
      String(PURITY_CRITERIA),
      paths.rulesFile ?? '(unresolved)',
      paths.artifactDir,
      this.settingsDirectory ?? '(unresolved)',
      this.settingsDirectoryProblem ?? '(none — the directory was read)',
    )
    // The cache line, and its silence when the feature is off: a reader of the
    // log must be able to tell "the diagnostics are not running" from "they are
    // running and found nothing", and only a line in one case and none in the
    // other does that without inference. The line carries the CAPS, so the bound
    // this feature promises is on the record rather than only in the README.
    ctx.logger?.info(
      'prompt-plan: cache diagnostics %s%s',
      this.ledger === undefined ? 'off (config.cacheDiag is false)' : 'on',
      this.ledger === undefined ? '' : `; ledgers ${CACHE_ARTIFACT_NAMES.prefix} and ${CACHE_ARTIFACT_NAMES.usage} in the artifact directory, ${this.ledger.summary()}`,
    )
    // THE PIN, and when it is taken.
    //
    // Rewrite mode pins at mount and at every `session/created`, and at no other
    // moment. The alternative — reading the rule file and the tool-name list per
    // assembly — is refused for the two reasons `reloadRules` states: a syscall in
    // front of every model turn, and a prompt that is free to change mid-session.
    if (this.resolved.mode === 'rewrite') {
      // The LISTENER first and the existing sessions second, so a session created
      // in between is heard rather than missed: registering is synchronous and the
      // list is taken immediately after. `dsh-permission-presets` pins its own
      // per-session state in exactly this order
      // (`packages/interaction/permission-presets/src/index.ts:511-516`).
      ctx.on('session/created', (session) => { void this.pinSession(ctx, session) })
      ctx.on('session/disposed', (session) => { this.pins.delete(String(session.id)) })
      void this.pinMount(ctx)
    }

    // The seam. `global` because the assembly may be dispatched for an agent
    // scope this context is not under, and a rewriter bound to the wrong scope
    // would silently stop applying. No `prepend`: upstream's invariant companion
    // prepends, and running after it is the documented ordering.
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const produced = await next()
      // The cast is the seam's price: `handle` is written against `unknown` so
      // that it cannot smuggle a wrong shape past the reader, and this is the
      // single place where the value re-enters the typed waterfall. `handle`
      // either returns `produced` itself or a fresh object built from it.
      //
      // The WHOLE context is passed through: `context.scope` is the only handle on
      // the registry layer this assembly merges (the complete-section test reads
      // that layer), and `context.agent` is what the per-session pin is keyed by.
      // Both are read defensively inside `handle`, so a context carrying neither
      // still yields a correct assembly under the mount-time pin.
      return await this.handle(ctx, assembly, produced, context) as typeof produced
    }, { global: true })

    // The second seam, and the reason it is a second one: THIS listener's
    // waterfall context never carries token accounting. `assemble` is called
    // before the request is dispatched, so no usage exists yet, and the adapter's
    // report arrives later as an `assistant/message` session event. That event is
    // the only place a per-request ledger can be built from, and
    // `SessionEventMap['assistant/message'].usage` is exactly the adapter's own
    // four counts — see `describeUsage` in `./cache.ts`.
    //
    // Registered only when the ledger is on, so a deployment that did not ask
    // for the diagnostic adds no listener to the event feed.
    if (this.ledger !== undefined) {
      ctx.on('session/event', (session, event) => {
        try {
          const described = describeUsage(event)
          if (described === undefined) return
          this.ledger?.observeUsage({
            sessionId: subjectIdOf(session),
            turn: described.turn,
            step: described.step,
            usage: described.usage,
            interrupted: described.interrupted,
          })
        } catch {
          // A listener that throws here would be an error in the middle of the
          // session event feed, in front of every other observer. The accounting
          // is diagnostic; it never gets to fail a turn.
        }
      })
    }

    // A clean shutdown must not lose a queued artifact write. The waterfall
    // handler never awaits the disk (that would put filesystem latency in front
    // of every model turn), so the drain happens here.
    ctx.effect(() => () => { void this.observer?.drain() }, 'prompt-plan: drain observation artifacts')
    ctx.effect(() => () => { void this.ledger?.drain() }, 'prompt-plan: drain the cache ledgers')
  }

  /**
   * Re-read the rule file — and resolve the dynamic tool-name list into it — for
   * ONE pin.
   *
   * Called at mount (the fallback, plus every session that already exists) and once
   * per `session/created` (that session). Deliberately NOT called per assembly, for
   * the two reasons that are the whole design:
   *   - a per-assembly stat would put a syscall in front of every model turn; and
   *   - a per-assembly read would let the prompt change MID-SESSION, which is the
   *     prefix-cache break the per-session pin exists to prevent.
   * @param ctx - host context, for logging.
   * @param options - the session this load pins; absent pins the fallback instead.
   * @returns whether a usable rule set is in force afterwards.
   */
  async reloadRules(ctx: Context, options: { readonly session?: string } = {}): Promise<boolean> {
    const where = options.session === undefined ? 'mount' : `session ${JSON.stringify(options.session)}`
    const load = await loadRuleFile({
      rulesFile: this.resolved.rulesFile,
      settingsDirectory: this.settingsDirectory,
      hash: sha256,
    })
    if (!load.ok) {
      this.clearPin(options.session)
      if (load.kind === 'unconfigured') {
        // The gap is in the CONFIGURATION, not on the disk, so the line names the
        // missing thing rather than a path it never had. Logged at error level even
        // in observe mode: an observation window that silently rewrote nothing
        // because it never found the rules is exactly the false clean bill this
        // replaces.
        ctx.logger?.error('prompt-plan: %s', describeUnresolvedRulePath(this.settingsDirectoryProblem ?? 'the settings service reported no directory for this row'))
      } else if (load.kind === 'missing') {
        ctx.logger?.warn('prompt-plan: no rule file at %s; rewrite mode will refuse every assembly until one exists', load.path)
      } else {
        ctx.logger?.error('prompt-plan: the rule file at %s %s', load.path, load.problem)
      }
      return false
    }
    const compiled = compileRules(load.ruleSet.rules)
    if (!compiled.ok) {
      this.clearPin(options.session)
      ctx.logger?.error('prompt-plan: %s', compiled.problem)
      return false
    }
    const { application, sources } = await this.resolveToolNames(compiled.rules)
    const pin: RulePin = { rules: application.rules, ruleSet: load.ruleSet, names: application }
    this.installPin(options.session, pin)
    ctx.logger?.info(
      'prompt-plan: loaded %s rule(s) from %s (sha256 %s) for %s',
      String(load.ruleSet.rules.length),
      load.ruleSet.path,
      load.ruleSet.sha256.slice(0, 12),
      where,
    )
    // The names this pin actually carries, and where each half came from, on EVERY
    // load and in EVERY outcome: "the conservative fallback is in force" has to be
    // readable off the log rather than inferred from a line that did not appear.
    if (ctx.logger !== undefined) logToolNamesPin(ctx.logger, describeToolNamesPin(where, application, sources))
    return true
  }

  /**
   * Resolve every `namesFrom` the rules declare, once per pin.
   *
   * One read per DISTINCT path, and the reads happen here rather than in the
   * waterfall: a pin is built once and nothing downstream touches the disk. A failed
   * read contributes no names and is carried to the log line as its own fact — see
   * `tool-names.ts` for the fallback's direction and why it is that direction.
   * @param rules - the compiled rules of the pin being built.
   * @returns the folded rules, plus the sources the log line is written from.
   */
  private async resolveToolNames(rules: readonly CompiledRule[]): Promise<{ application: ToolNamesApplication; sources: ToolNamesSource[] }> {
    const sources: ToolNamesSource[] = []
    for (const namesFrom of toolNamesPathsOf(rules)) {
      sources.push(toolNamesSource(namesFrom, await loadToolNames({
        namesFrom,
        rulesFile: this.rulesFilePath,
        settingsDirectory: this.settingsDirectory,
        hash: sha256,
      })))
    }
    return { application: applyToolNames(rules, sources), sources }
  }

  /** Install one pin under its subject. */
  private installPin(session: string | undefined, pin: RulePin): void {
    if (session === undefined) this.fallback = pin
    else this.pins.set(session, pin)
  }

  /**
   * Drop one subject's pin, so a refused load cannot leave the previous revision
   * silently in force for it: "no usable rule set" and "the old rule set" are
   * different facts and the handler reports them differently.
   */
  private clearPin(session: string | undefined): void {
    if (session === undefined) this.fallback = undefined
    else this.pins.delete(session)
  }

  /**
   * The pin one assembly runs under.
   *
   * A session that was never pinned — an assembly with no subject at all, or one
   * whose session was created before this plugin mounted — uses the fallback, which
   * is taken at mount and never re-taken. That is deliberately NOT the newest pin:
   * reaching for the newest would change a running session's prompt the moment
   * another session started, which is exactly the cache break the map prevents.
   * @param session - the assembly's subject, when it has one.
   * @returns the pin, or undefined when nothing usable is loaded.
   */
  private pinFor(session: string | undefined): RulePin | undefined {
    if (session === undefined) return this.fallback
    return this.pins.get(session) ?? this.fallback
  }

  /**
   * The session store, when this composition has one.
   *
   * An optional lookup rather than an injection, for the same reason the prompt
   * registry is one: a composition without a session store has no sessions to pin,
   * and refusing to load over that would be a worse failure than the missing pin.
   * @param ctx - the mounting context.
   * @returns the store's `list`, or undefined.
   */
  private sessionsOf(ctx: Context): { list: () => readonly { id: unknown }[] } | undefined {
    try {
      const service = ctx.get('sessions' as never) as { list?: unknown } | undefined
      if (service === null || typeof service !== 'object' || typeof service.list !== 'function') return undefined
      return service as { list: () => readonly { id: unknown }[] }
    } catch {
      return undefined
    }
  }

  /**
   * Pin at mount: the fallback, plus every session that already exists.
   *
   * A session that existed before this row mounted has already had prompts
   * assembled; pinning it now means the revision THIS process read applies from its
   * next assembly on, which is the one change mounting always made. After that the
   * session is never re-pinned — that is what "the session keeps what it was given"
   * means in practice.
   * @param ctx - host context, for logging.
   */
  private async pinMount(ctx: Context): Promise<void> {
    if (!await this.reloadRules(ctx)) return
    const pin = this.fallback
    if (pin === undefined) return
    const sessions = this.sessionsOf(ctx)
    if (sessions === undefined) {
      ctx.logger?.warn('prompt-plan: the sessions service is not resolvable at mount; a session created before this row mounted will run under the mount-time pin')
      return
    }
    let pinned = 0
    for (const session of sessions.list()) {
      this.pins.set(String(session.id), pin)
      pinned += 1
    }
    ctx.logger?.info('prompt-plan: pinned the mount-time rule set for %s existing session(s)', String(pinned))
  }

  /**
   * Pin one session, once, at its creation.
   *
   * The work is real (a rule-file read, plus a read per names file) and it happens
   * exactly once per session, which is the whole point: no session ever pays a
   * filesystem cost per turn, and no session's prompt can move after this returns.
   * @param ctx - host context, for logging.
   * @param session - the session just announced.
   */
  private async pinSession(ctx: Context, session: { readonly id: unknown }): Promise<void> {
    const id = String(session.id)
    try {
      await this.reloadRules(ctx, { session: id })
    } catch (error) {
      // A pin that cannot be taken is survivable and must not surface as an
      // unhandled rejection: the session then runs under the mount-time fallback,
      // which is a stable revision rather than a moving one.
      const reason = error instanceof Error ? error.message : String(error)
      ctx.logger?.error('prompt-plan: could not pin the rules for session %s (%s); it will run under the mount-time pin', id, reason)
    }
  }

  /**
   * The waterfall handler.
   *
   * Total by construction: every branch returns an assembly. A branch that could
   * not decide returns the value it was handed rather than nothing, because
   * returning nothing is the failure B1 names.
   * @param ctx - host context, for logging.
   * @param incoming - the assembly as it entered the waterfall.
   * @param produced - what the inner chain returned; the authoritative value.
   * @returns the assembly to use.
   */
  private async handle(ctx: Context, incoming: unknown, produced: unknown, context: unknown): Promise<unknown> {
    // The assembly's scope and its subject, read without requiring either: see
    // `sessionKeyOf` in `./tool-names.ts` for what the context actually carries at
    // runtime and why a missing key must never mean "read the disk again".
    const scope = context === null || typeof context !== 'object' ? undefined : (context as { scope?: unknown }).scope
    const session = sessionKeyOf(context)
    const read = readSectionList(produced)
    if (!read.ok) {
      ctx.logger?.error('prompt-plan: refusing to rewrite an assembly it cannot read — %s', read.problem)
      return produced
    }
    const before = read.sections
    const incomingRead = readSectionList(incoming)
    const incomingShape = detectCompleteShape(incomingRead.ok ? incomingRead.sections : [])

    // THE TEST THAT MATTERS, and the one the original code did not have.
    //
    // `detectCompleteShape` fires on "fewer than two sections", which is the shape
    // the post-waterfall restore leaves. It cannot fire on the case that actually
    // breaks a rewrite: a `complete: true` section registered in the assembly's
    // scope makes `assemble` REPLACE the returned sections with that one section
    // AFTER this listener returns (packages/core/system-prompt/src/index.ts:629-634),
    // so the listener sees — and correctly reports — a normal multi-section
    // assembly, and its own output is discarded with no error at all. Measured:
    // 17 sections in, 17 out, rewrite applied, final prompt = the one persona
    // section. The register is therefore read from the REGISTRY, which is the only
    // place the mark exists once the assembly has been built.
    const registry = detectCompleteRegistry(this.registryOf(ctx), scope)
    if (!registry.ok) {
      // Not the same as "no complete section": say which one it is, so nobody
      // reads a silent probe failure as a clean bill of health.
      ctx.logger?.warn('prompt-plan: could not test for a complete:true section — %s; the rewrite proceeds, and its output will be discarded if one is registered', registry.problem)
    } else if (registry.registrations.length > 0) {
      ctx.logger?.error('prompt-plan: %s', completeRegistrationRefusal(registry.registrations, this.resolved.mode))
      if (this.resolved.mode === 'rewrite') return produced
    }

    if (this.resolved.mode === 'rewrite') {
      const verdict = detectCompleteShape(before)
      if (verdict.detected) {
        ctx.logger?.error('prompt-plan: %s', completeRefusal(verdict, this.resolved.mode))
        return produced
      }
    }

    const pin = this.pinFor(session)
    const outcome = this.resolved.mode === 'rewrite'
      ? this.rewrite(ctx, before, pin, session)
      : { sections: before, trace: [] as readonly RuleTrace[] }

    this.record(
      before,
      outcome.sections,
      produced === incoming,
      detectCompleteShape(outcome.sections).detected || incomingShape.detected,
      outcome.trace,
      this.resolved.mode === 'rewrite' ? pin?.ruleSet : undefined,
      session,
    )
    // The cache fingerprint, taken on what THIS handler is about to return — the
    // value the model will actually be sent, after every other listener has run.
    // Deliberately after `this.record`: the observation artifacts describe what
    // reached the seam, and this describes what left it.
    //
    // It never gates. A changed prefix is already a changed prefix by the time it
    // is visible here, so refusing the assembly would cost a turn and save
    // nothing; the ledger and the log line are the whole output of this call.
    if (this.ledger !== undefined) {
      const ruleSet = pin?.ruleSet
      this.ledger.observe({
        sessionId: session,
        sections: outcome.sections,
        ruleSetSha256: ruleSetHashOf(this.resolved.mode === 'rewrite' ? ruleSet : undefined),
      })
    }
    if (outcome.sections === before) return produced
    return { ...(produced as Record<string, unknown>), sections: outcome.sections }
  }

  /**
   * Apply the rules ONE PIN carries, refusing rather than guessing when no usable
   * rule set was in force for this assembly's subject.
   *
   * The pin is passed IN rather than read off the instance, because a pin belongs to
   * a subject: two sessions assembling at the same moment must each run their own,
   * and `this.fallback` is only what an assembly without a subject is given.
   * @param ctx - host context, for logging.
   * @param sections - the assembly's sections.
   * @param pin - the pin this assembly runs under.
   * @param session - the assembly's subject, for the refusal's wording.
   * @returns the new sections and the trace, or the input unchanged.
   */
  private rewrite(ctx: Context, sections: readonly SectionRecord[], pin: RulePin | undefined, session: string | undefined): { sections: readonly SectionRecord[]; trace: readonly RuleTrace[] } {
    const where = session === undefined ? 'an assembly with no session' : `session ${JSON.stringify(session)}`
    if (pin === undefined || pin.rules.length === 0) {
      ctx.logger?.error(
        'prompt-plan: rewrite mode is on but no usable rule set is loaded for %s (rules %s); the assembly is returned unchanged',
        where,
        pin === undefined ? 'absent or malformed' : 'empty',
      )
      return { sections, trace: [] }
    }
    const result = applyRules(sections, pin.rules, 'refuse')
    if (!result.ok) {
      ctx.logger?.error('prompt-plan: %s', result.refusal.problem)
      return { sections, trace: [] }
    }
    // A strip op reports what it measured, and reports a refusal too: an op that
    // found nothing to remove and an op that declined to remove anything are
    // different facts, and only the second one is a problem worth a warning.
    if (ctx.logger !== undefined) logStripReports(ctx.logger, pin.rules)
    return { sections: result.sections, trace: result.trace }
  }

  /**
   * The prompt registry, looked up lazily when the mount-time lookup failed.
   *
   * The mount-time lookup is an optimisation, not the contract: a Loader row is
   * constructed while the tree is still being composed, so the registry may not
   * be resolvable yet. MEASURED: in the headless composition the constructor's
   * `ctx.get('systemPrompt')` returned `undefined`, the value was cached, and the
   * complete-section test therefore never ran — a silent no-op of exactly the
   * kind this change exists to remove. The lookup is retried until it succeeds
   * once, and the result is cached from then on.
   * @param ctx - the listener's context.
   * @returns the registry, or undefined when this composition has none.
   */
  private registryOf(ctx: Context): unknown {
    if (this.presetRegistry !== undefined) return this.presetRegistry
    try {
      this.presetRegistry = ctx.get('systemPrompt' as never)
    } catch {
      return undefined
    }
    if (this.presetRegistry === undefined) {
      ctx.logger?.warn('prompt-plan: the systemPrompt service is still not resolvable; the complete:true test cannot run for this assembly')
    }
    return this.presetRegistry
  }

  /** Hand one assembly's evidence to the observer, without awaiting the disk. */
  private record(
    before: readonly SectionRecord[],
    after: readonly SectionRecord[],
    sameReference: boolean,
    completeShape: boolean,
    trace: readonly RuleTrace[],
    ruleSet: RuleSet | undefined,
    sessionId: string | undefined,
  ): void {
    if (!this.resolved.observe || this.observer === undefined) return
    const rendered = trace.map(entry =>
      `${entry.id} [${entry.match}] -> ${entry.action}; matched ${entry.matched.length === 0 ? '(none)' : entry.matched.map(name => JSON.stringify(name)).join(', ')}; sections ${entry.sectionsBefore} -> ${entry.sectionsAfter}${entry.skippedEmpty === 0 ? '' : `; SKIPPED ${String(entry.skippedEmpty)} empty section(s) — the replacement was not written (set "action.allowEmpty: true" on this rule to write into an empty section)`}`)
    void this.observer.record(
      before,
      after,
      sameReference,
      completeShape,
      this.resolved.fullText,
      ruleSet === undefined ? undefined : { path: ruleSet.path, sha256: ruleSet.sha256 },
      rendered,
      sessionId,
    ).catch((error: unknown) => {
      // An artifact write that fails must never fail the turn: the prompt is
      // already correct, and losing an observation line is not worth an error
      // in front of the model.
      void error
    })
  }
}

export default PromptPlan

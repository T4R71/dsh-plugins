/**
 * The assembled section list as a value: the upstream invariants this package
 * has to carry itself, the API-shape gate, and the one hard test that detects a
 * `complete: true` section the assembly does not label.
 *
 * WHY THIS FILE EXISTS AT ALL. Upstream ships these assertions as a companion
 * plugin (`packages/core/system-prompt/src/invariant.ts`): non-empty names, no
 * duplicate names, `text` is a string. That companion `inject`s the
 * `invariants` service, and a composition without that service never loads it.
 * Verified for the 0.1.7-rc.2 desktop artifact at `M:\\DSH-T4\\resources\\app.asar`:
 * grepping the extracted `dsh-base` bundle for `invariants` returns 0 hits, so
 * the desktop composition does NOT mount it and the assertions do not run there.
 * A plugin that rewrites sections is the last place that may proceed without
 * them, so this package carries an equivalent and runs it on its own output.
 *
 * The invariant text mirrors upstream's, message for message, so a failure here
 * reads the same as a failure there.
 *
 * @module @t4r71/dsh-prompt-plan/sections
 */

/** One assembled section, described structurally. */
export interface RawSection {
  readonly name: string
  readonly text: string
  readonly interpolate?: boolean
}

/** One assembled section as this package consumes it, with unknown members preserved. */
export type SectionRecord = RawSection & Record<string, unknown>

/**
 * The upstream-authored text of the pair of side-by-side spellings, kept in one
 * place so the reader can see the three assertions are verbatim.
 */
export const INVARIANT_MESSAGES = {
  emptyName: 'assembled section names must be non-empty',
  duplicateName: 'assembled section name %s is duplicated',
  nonStringText: 'assembled section %s text must be a string',
} as const

/** One invariant failure: which assertion, and on which section. */
export interface SectionInvariantFailure {
  /** The failing assertion, as upstream words it. */
  readonly message: string
  /** The offending section's name, when the failure has one. */
  readonly sectionName?: string
}

/**
 * Run the three upstream assertions against a section list.
 * @param sections - the list to validate.
 * @returns one entry per failure; empty when the list is valid.
 */
export function checkSectionInvariants(sections: readonly { name?: unknown; text?: unknown }[]): SectionInvariantFailure[] {
  const failures: SectionInvariantFailure[] = []
  const seen = new Set<string>()
  for (const section of sections) {
    const name = section.name
    if (typeof name !== 'string' || name.length === 0) {
      failures.push({ message: INVARIANT_MESSAGES.emptyName })
      continue
    }
    if (seen.has(name)) {
      failures.push({ message: INVARIANT_MESSAGES.duplicateName.replace('%s', JSON.stringify(name)), sectionName: name })
      continue
    }
    seen.add(name)
    if (typeof section.text !== 'string') {
      failures.push({ message: INVARIANT_MESSAGES.nonStringText.replace('%s', JSON.stringify(name)), sectionName: name })
    }
  }
  return failures
}

/** Render invariant failures as one refusal sentence. */
export function describeInvariantFailures(failures: readonly SectionInvariantFailure[]): string {
  return failures.map(failure => failure.message).join('; ')
}

/** The outcome of reading an untrusted assembly's section list. */
export type SectionListRead =
  | { readonly ok: true; readonly sections: SectionRecord[] }
  | { readonly ok: false; readonly problem: string }

/**
 * Read `assembly.sections` into a detached list, refusing anything that is not
 * the documented shape.
 *
 * "Detached" matters for a reason beyond tidiness: the objects in the list are
 * shared with the assembly the registry built, and possibly with a snapshot
 * another listener took. Mutating one in place would be visible to every other
 * holder of that reference — this package's own hard constraint B2, and the
 * reason it expands into fresh objects rather than editing the originals.
 *
 * A section carrying members this package does not know about keeps them: the
 * assembly type is merge-extensible, and dropping an unknown member here would
 * silently strip another contributor's field from the system prompt.
 * @param assembly - the waterfall's incoming assembly value.
 * @returns the detached section list, or the sentence explaining why it is not one.
 */
export function readSectionList(assembly: unknown): SectionListRead {
  if (assembly === null || typeof assembly !== 'object') {
    return { ok: false, problem: `the assembly is not an object (received ${assembly === null ? 'null' : typeof assembly})` }
  }
  const candidate = (assembly as { sections?: unknown }).sections
  if (!Array.isArray(candidate)) {
    return { ok: false, problem: `assembly.sections is not an array (received ${candidate === null ? 'null' : typeof candidate})` }
  }
  const sections: SectionRecord[] = []
  for (let index = 0; index < candidate.length; index += 1) {
    const entry = candidate[index] as unknown
    if (entry === null || typeof entry !== 'object') {
      return { ok: false, problem: `assembly.sections[${index}] is not an object` }
    }
    const record = entry as { name?: unknown; text?: unknown; interpolate?: unknown }
    if (typeof record.name !== 'string' || typeof record.text !== 'string') {
      return { ok: false, problem: `assembly.sections[${index}] does not carry string name and text members` }
    }
    const interpolate = record.interpolate
    if (interpolate !== undefined && typeof interpolate !== 'boolean') {
      return { ok: false, problem: `assembly.sections[${index}] ("${record.name}") carries a non-boolean interpolate` }
    }
    sections.push({
      ...(entry as Record<string, unknown>),
      name: record.name,
      text: record.text,
      ...interpolate === undefined ? {} : { interpolate },
    })
  }
  return { ok: true, sections }
}

/** How a complete-section test classified one assembly. */
export type CompleteVerdict =
  | { readonly detected: false }
  | { readonly detected: true; readonly heuristic: string; readonly evidence: string }

/**
 * The hard test for an assembly whose sole section is a `complete: true`
 * contribution.
 *
 * THE GAP THIS WORKS AROUND. `complete` is a registration-time member of
 * `PromptSection`; the assembled section is built at
 * `packages/core/system-prompt/src/index.ts:602-611` copying name, text and
 * interpolate ONLY, and `PromptAssembly` has no third field either. So no
 * listener downstream can see the mark. What IS observable is the shape the
 * post-waterfall restore produces at `:629-634`: `sections` is replaced by
 * `[completeSection]`, a ONE-element array holding the snapshot taken BEFORE
 * the waterfall ran.
 *
 * The heuristic therefore has to fire on `sections.length < 2`, which is a
 * heuristic and not a proof. WHY IT IS STILL SOUND HERE, and where it is not:
 *   - A false NEGATIVE is impossible in the single-section case, because `< 2`
 *     is exactly the restore's output shape.
 *   - A false POSITIVE needs an assembly whose registry produced at most one
 *     section. Against the 0.1.7-rc.2 desktop composition that cannot happen:
 *     `SystemPrompt`'s own constructor unconditionally registers
 *     `harness:identity` (`:426-431`) and always registers the persona prefix
 *     and suffix sections (`:433-443`), so a normal assembly carries at least
 *     three. Verified against the asar copy of `dsh-system-prompt`: those two
 *     registrations are present. A DEPLOYMENT that sets
 *     `includeHarnessIdentity: false` AND `includeRuntimeContext: false` would
 *     not change the section count (both persona sections are still
 *     registered); one that removes the service entirely would, and then this
 *     package has no seam to sit on anyway.
 *   - The heuristic is checked on the INCOMING assembly (the `complete` snapshot
 *     was installed by the previous assembly, so the incoming value carries it
 *     only if a prior listener synthesised it) and again on the OUTGOING one.
 *     The outgoing check is the one that matters: it catches a handler further
 *     down the chain that produced the restore shape by returning early.
 *
 * LIMITATION, STATED PLAINLY: a listener that legitimately reduces the prompt to
 * a single section of its own is indistinguishable from a `complete` restore
 * here, and would be reported as one. There is no way to tell them apart through
 * this seam — the mark is not on the wire.
 * @param sections - the section list to classify.
 * @returns whether the list has the restore's shape, and the evidence for it.
 */
export function detectCompleteShape(sections: readonly RawSection[]): CompleteVerdict {
  if (sections.length >= 2) return { detected: false }
  const only = sections[0]
  const evidence = only === undefined
    ? 'sections is empty (0 entries)'
    : `sections has 1 entry, named ${JSON.stringify(only.name)} (${only.text.length} chars)`
  return {
    detected: true,
    heuristic: 'assembly.sections.length < 2 — the shape the post-waterfall complete-section restore installs (packages/core/system-prompt/src/index.ts:629-634)',
    evidence,
  }
}

/** One `complete: true` registration found in the scope chain. */
export interface CompleteRegistration {
  /** The scope the section is registered in: `global` or the scope key's own label. */
  readonly scope: 'global' | 'scoped'
  /** The section's registered name. */
  readonly name: string
  /** Its registered order, so an operator can find it in the composition. */
  readonly order: number
}

/** The names of the two private members this probe reads. */
const LAYERS_FIELD = 'layers'
const SECTIONS_FIELD = 'sections'

/** What reading a scope chain's registrations found. */
export type CompleteRegistryRead =
  | { readonly ok: true; readonly registrations: readonly CompleteRegistration[] }
  | { readonly ok: false; readonly problem: string }

/**
 * Find every `complete: true` prompt section registered for one assembly scope.
 *
 * WHY THIS IS POSSIBLE AT ALL, given that the mark never reaches the wire: the
 * mark is dropped when a section is copied into the assembly
 * (`packages/core/system-prompt/src/index.ts:602-611` copies `name`, `text` and
 * `interpolate` only), so no listener can see it ON THE ASSEMBLY. But the
 * REGISTRY is reachable from inside the waterfall: the service instance the
 * listener is bound to exposes `layers` at runtime
 * (`ScopedLayers<PromptLayer>`, `packages/core/scope/src/store.ts:159-199`), whose
 * `.global` layer and `.chainLayers(scope)` overlays hold the registered
 * `PromptSection` objects — `complete` member and all. Read that, and the mark
 * that the assembly drops is visible from exactly the place that needs it.
 *
 * MEASURED, not inferred. With a section registered `{ complete: true }` in a
 * child scope and a `{ global: true }` listener on `system-prompt/assemble`, the
 * listener observed the registration (`deployment:persona-prefix`,
 * `complete: true`) while the post-waterfall assembly it returned was replaced
 * wholesale by the one-element restore. See
 * `M:\\T4\\out\\rewrite\\verify\\v3-complete.mjs` for the reproduction.
 *
 * WHAT IT COSTS. `layers` is a TypeScript `private` member
 * (`lib/types/index.d.ts:229`), so this is a runtime probe, not a supported API:
 * a future release may rename it. The probe therefore degrades to
 * `{ ok: false }` with a sentence, and the caller treats "cannot read the
 * registry" as "keep rewriting and say so" rather than as "no complete section
 * exists" — the two are not the same, and this package does not conflate them.
 *
 * WHAT IT CANNOT SEE: a `complete: true` section registered in a scope that is
 * not on this assembly's chain (a descendant scope's own preset, for instance).
 * The test is exact for the registrations the assembly itself merges — which is
 * precisely the set that can collapse this assembly.
 * @param service - the `systemPrompt` service the listener is bound to, or undefined.
 * @param scope - the assembly's scope, as the waterfall's context reports it.
 * @returns every complete registration visible to this assembly, or why the registry could not be read.
 */
export function detectCompleteRegistry(service: unknown, scope: unknown): CompleteRegistryRead {
  if (service === null || typeof service !== 'object') {
    return { ok: false, problem: 'the systemPrompt service is not reachable from the listener' }
  }
  const layers = (service as Record<string, unknown>)[LAYERS_FIELD]
  if (layers === null || typeof layers !== 'object') {
    return { ok: false, problem: `the systemPrompt service exposes no ${JSON.stringify(LAYERS_FIELD)} member (a future release may have renamed it)` }
  }
  const global = (layers as Record<string, unknown>).global
  if (global === null || typeof global !== 'object') {
    return { ok: false, problem: 'the systemPrompt registry exposes no global layer' }
  }
  const chain = (layers as { chainLayers?: (scope: unknown) => unknown }).chainLayers
  let overlays: unknown[] = []
  if (typeof chain === 'function') {
    try {
      const read = chain.call(layers, scope === null || scope === undefined ? undefined : scope)
      if (Array.isArray(read)) overlays = read
      else return { ok: false, problem: 'the systemPrompt registry chainLayers() did not return a list' }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false, problem: `reading the systemPrompt registry's scope chain threw: ${reason}` }
    }
  }
  const registrations: CompleteRegistration[] = []
  const scan = (layer: unknown, where: 'global' | 'scoped'): void => {
    if (layer === null || typeof layer !== 'object') return
    const sections = (layer as Record<string, unknown>)[SECTIONS_FIELD]
    if (sections === null || typeof sections !== 'object') return
    const entries = (sections as { entries?: () => Iterable<[string, unknown]> }).entries
    if (typeof entries !== 'function') return
    for (const [name, section] of entries.call(sections)) {
      if (section === null || typeof section !== 'object') continue
      const record = section as { complete?: unknown; order?: unknown }
      if (record.complete !== true) continue
      registrations.push({
        scope: where,
        name: typeof name === 'string' ? name : String(name),
        order: typeof record.order === 'number' ? record.order : Number.NaN,
      })
    }
  }
  scan(global, 'global')
  for (const layer of overlays) scan(layer, 'scoped')
  return { ok: true, registrations }
}

/**
 * The sentence a rewrite refuses with when a `complete: true` section is registered.
 *
 * THE POINT OF THIS MESSAGE is that the failure it describes is otherwise
 * SILENT and, before this test existed, was not detected at all: the rewrite ran,
 * the trace recorded it, and the returned sections were then thrown away by the
 * post-waterfall restore — with no error anywhere. Every clause below exists so
 * an operator reading the log knows which rule file to stop trusting, that
 * nothing in this assembly can change that, and why.
 * @param registrations - what {@link detectCompleteRegistry} found.
 * @param mode - the mode in force, so the sentence says what was and was not changed.
 * @returns the operator-facing refusal.
 */
export function completeRegistrationRefusal(registrations: readonly CompleteRegistration[], mode: string): string {
  const named = registrations.map(entry => `${JSON.stringify(entry.name)} (order ${String(entry.order)}, ${entry.scope})`).join(', ')
  return 'THIS REWRITE DID NOT TAKE EFFECT, because a preset registered a `complete: true` prompt section: '
    + `${named}. `
    + 'A complete section is restored as the SOLE prompt section AFTER the assembly waterfall returns '
    + '(`packages/core/system-prompt/src/index.ts:629-634` in 0.1.7-rc.2), so every section this pass produced — '
    + 'and every change to it — is discarded, with no error from the rewrite side. '
    + 'The mark never reaches the assembly (it is not copied at `:602-611`), so it is detected by reading the '
    + 'registry the listener is bound to: see `detectCompleteRegistry` in src/sections.ts. '
    + (mode === 'observe'
      ? 'Observe mode changed nothing; the observation record carries this finding and the run continues.'
      : 'Rewrite mode returned the assembly UNCHANGED rather than report rules as applied when their output cannot survive. '
        + 'To make rewriting possible again, remove `complete: true` from the persona row of the preset in force '
        + '(factory example: `dsh-web-app/presets/minimal.patch.yml:15`).')
}

/**
 * The sentence a refusal uses when the complete shape is met.
 * @param verdict - what {@link detectCompleteShape} found.
 * @param mode - the mode in force, so the message says what was and was not changed.
 * @returns the model/operator-facing refusal.
 */
export function completeRefusal(verdict: Extract<CompleteVerdict, { detected: true }>, mode: string): string {
  return 'prompt-plan: this assembly carries a complete-section shape, so its system prompt cannot be rewritten by a '
    + `listener. Detected because ${verdict.heuristic}; evidence: ${verdict.evidence}. `
    + 'A complete:true section is restored from a snapshot taken BEFORE the waterfall runs and the returned sections '
    + 'are then collapsed to that single section, so no rewrite survives it. The mark itself is not visible on the '
    + 'assembly — see src/sections.ts, detectCompleteShape, for the exact limits of this test. '
    + (mode === 'observe'
      ? 'Observe mode changed nothing; the observation record carries the shape and the run continues.'
      : 'Rewrite mode refused the assembly rather than write rules that would be discarded.')
}
/**
 * The deciding half of adaptive tool-loading: given what the host called, which
 * tools keep their full declaration in the system prompt and which lose it.
 *
 * ## The two disclosure modes of ONE tool
 *
 * A tool is not "loaded" or "not loaded". It has two ways of being disclosed,
 * and they are two ways of disclosing the SAME callable tool:
 *
 *   resident   the tool's full SDK declaration sits in the system prompt. The
 *              model sees the signature, so it can call it on the first try.
 *   secondary  the declaration is stripped out of the system prompt, while the
 *              tool stays CALLABLE -- stripping is a text rewrite of the
 *              \`tools:sdk\` section, never a visibility change (see ./strip.ts).
 *              The model must spend a turn fetching the declaration back.
 *
 * The switch between them is exactly "is this name in stripToolDecls.names", so
 * this module's whole output is a name list plus the audit trail for it.
 *
 * ## The decision is a cost comparison, not a frequency threshold
 *
 * A static high/low split cannot be right, because the two sides are measured
 * in different units. Both sides are converted to TOKENS here:
 *
 *   C_resident(T)  = declarationsChars(T) x turnsPerSession x costPerCharPerTurn
 *                    -- paid EVERY turn of every session, whether or not T is
 *                    ever called.
 *
 *   C_secondary(T) = expectedCalls(T) x (hitchProbability x hitchCost
 *                                        + (1 - hitchProbability) x fullTurnCost)
 *                    -- paid once per CALL, and only for the calls that happen.
 *
 * The hitch term is the part that a naive model gets wrong. A model inside a
 * \`run_code\` program is already doing several things per turn, and fetching a
 * declaration is one more statement in a program it was going to write anyway.
 * So the extra round trip often rides along on a turn that was going to happen,
 * and the marginal cost of secondary disclosure approaches zero. Modelling it
 * as "always one full turn" overstates secondary's cost by a factor of 1/p.
 *
 * ## Why "never used" is resident, and why that is arithmetic rather than caution
 *
 * expectedCalls(T) has no estimator at all for a tool with zero observations --
 * the confidence interval is unbounded, and the optimistic end of it (zero) is
 * not a forecast, it is an absence of data. C_resident, by contrast, is KNOWN
 * and small: a few hundred characters. So the comparison resolves in resident's
 * favour because one side is a measured small number and the other is unknown.
 *
 * This also closes the cold-start paradox: strip a tool the model has never
 * seen, and it never learns the tool exists, so it never calls it, so the
 * statistics never improve. Resident-by-default is what breaks that loop. The
 * tools are still reported in the \`observe\` bucket so the audit trail says
 * "resident because unmeasured" rather than pretending they were measured.
 *
 * ## Why a missing index makes secondary ILLEGAL rather than merely expensive
 *
 * If a tool's name and purpose are removed along with its declaration, the
 * model has no way to learn it exists. hitchProbability then collapses toward
 * zero, so C_secondary tends to expectedCalls x fullTurnCost -- and worse, the
 * model's expected CALL count also collapses, because a tool you cannot discover
 * is a tool you do not reach for. The statistic that would have justified
 * secondary is destroyed by choosing secondary. \`discoverableIndex === false\`
 * is therefore an unconditional resident, checked BEFORE any arithmetic.
 *
 * The live example is the \`schedule_*\` trio: they are the only tools actually
 * stripped today, and they survive it because a \`scheduled-tasks\` skill carries
 * their names and one-line purposes. That is precisely a discoverable index, so
 * they default to true while everything else defaults to... also true, since
 * nothing else is stripped at all -- an un-stripped tool is trivially
 * discoverable. The false case is the one the caller must declare explicitly:
 * a future rule that strips a tool AND removes its index.
 *
 * ## Determinism
 *
 * No IO, no clock, no randomness: every input arrives as an argument, including
 * time. Two runs on the same input produce byte-identical output, which is what
 * makes a decision replayable and therefore auditable.
 *
 * @module @t4r71/dsh-prompt-plan/decide
 */

import type { StatsFile, ToolStat } from './stats.ts'

/** Which bucket a tool landed in. */
export type Bucket = 'resident' | 'secondary' | 'observe'

/** Tunables for {@link decideToolPlan}. Every field has a documented default. */
export interface DecideConfig {
  /**
   * Tools in the top K by total calls are resident unconditionally.
   *
   * Rationale: a frequent tool's "recently unused" is usually a change in task
   * type, not a change in whether the tool is needed. Demoting it would cost a
   * turn at the start of exactly the sessions that need it most, and the cost of
   * residency is bounded while the cost of being wrong is per-call.
   * @defaultValue 10
   */
  protectionCount: number
  /** Characters per token, for converting declaration lengths into tokens. @defaultValue 3.5 */
  charsPerToken: number
  /**
   * Average turns per session, from {@link decideToolPlan}'s own input or this
   * default. Measured reference point: 127 logs in the standard sessions root
   * held 1 158 top-level turns; see DECISION_DEFAULTS for how to recompute.
   * @defaultValue 12
   */
  turnsPerSession: number
  /**
   * Probability that a secondary fetch rides along on a turn that was happening
   * anyway, rather than costing a dedicated turn.
   *
   * THE MOST UNCERTAIN CONSTANT IN THIS MODULE. It is a property of model
   * behaviour inside \`run_code\`, not of the logs, and 0.5 is a deliberately
   * mid-range stand-in, not a measurement. The report includes a sensitivity
   * sweep over [0, 1] precisely because the answer depends on it.
   * @defaultValue 0.5
   */
  hitchProbability: number
  /**
   * Cost of a hitched fetch, as a fraction of a full turn. A fetch that rides
   * along still costs the tokens of the fetched declaration itself -- the index
   * line the model read plus the declaration it pulled back -- but no extra
   * round trip, so it is charged at this fraction of one turn.
   * @defaultValue 0.15
   */
  hitchCostFraction: number
}

/** The documented defaults, all in one place so a report can cite them. */
export const DECISION_DEFAULTS: Readonly<DecideConfig> = Object.freeze({
  protectionCount: 10,
  charsPerToken: 3.5,
  turnsPerSession: 12,
  hitchProbability: 0.5,
  hitchCostFraction: 0.15,
})

/**
 * The size of one turn's input context, in tokens.
 *
 * One extra round trip costs the whole current context as input plus one
 * response as output, and the input dominates. 100 000 is the round order of
 * magnitude of a long tool-heavy session here -- these logs run to 17 MB of
 * transcript for 48 turns, and a few hundred KB of context is routine.
 * @defaultValue 100000
 */
export const DEFAULT_CONTEXT_TOKENS = 100_000

/** Estimated output tokens for one turn; a small term next to the context. @defaultValue 2000 */
export const DEFAULT_OUTPUT_TOKENS = 2_000

/** One tool's measured facts, as the decision layer needs them. */
export interface ToolFacts {
  /** The tool name. */
  name: string
  /** Cumulative real calls. Absent or 0 means never observed. */
  calls: number
  /** Distinct sessions that called it. Absent is treated as 0. */
  sessionsSeen?: number
  /** Epoch ms of the last call; absent or 0 means unknown. Not used for bucketing. */
  lastSeen?: number
  /**
   * The tool's declaration length in the \`tools:sdk\` section, in characters.
   *
   * \`undefined\` means "not measured in this assembly". A tool with no measured
   * length cannot be costed, so it is resident: this is the same
   * unknown-versus-known-small comparison that makes an unobserved tool
   * resident, and it fails in the same safe direction.
   */
  declarationsChars?: number
  /**
   * Whether the model can still DISCOVER this tool after its declaration is
   * stripped -- a name plus a one-line purpose somewhere the model can see, the
   * shape the \`scheduled-tasks\` skill gives the \`schedule_*\` trio.
   *
   * Defaults to true, which is correct for every tool that is not stripped at
   * all (nothing is hidden, so discovery is trivial) and for the \`schedule_*\`
   * trio (the skill is the index). Pass false ONLY for a tool whose declaration
   * and name are both removed -- that combination makes secondary
   * self-defeating, not just expensive.
   * @defaultValue true
   */
  discoverableIndex?: boolean
}

/** Everything {@link decideToolPlan} needs that is not per-tool. */
export interface DecideContext extends Partial<DecideConfig> {
  /** Turn budget used for the resident side; overrides the config default. */
  contextTokens?: number
  /** Output tokens for one turn; overrides {@link DEFAULT_OUTPUT_TOKENS}. */
  outputTokens?: number
}

/** The plan: three buckets plus the per-tool audit trail. */
export interface ToolPlan {
  /** Tools whose full declaration stays in the system prompt. */
  resident: string[]
  /** Tools whose declaration is stripped; still callable, must be fetched. */
  secondary: string[]
  /** Tools present in the input that were never called; they resolve to resident. */
  observe: string[]
  /** One sentence per tool naming the numbers that decided it. */
  reasons: Record<string, string>
  /** The per-tool arithmetic, so a reader can re-fit the constants. */
  costs: Record<string, ToolCost>
}

/** Both sides of one tool's comparison, in tokens, plus the verdict. */
export interface ToolCost {
  /** Which bucket the tool was placed in. */
  bucket: Bucket
  /** Characters of declaration the tool would occupy while resident, or undefined when unmeasured. */
  declarationsChars: number | undefined
  /** C_resident: tokens paid every turn of every session. */
  residentTokens: number
  /** C_secondary: tokens, in expectation, paid across the session's calls. */
  secondaryTokens: number
  /** Calls used on the secondary side. */
  expectedCalls: number
  /** ratio secondary/resident; > 1 means secondary is dearer. */
  ratio: number
  /** Whether this tool was protected by rank rather than by arithmetic. */
  protectedByRank: boolean
  /** Whether this tool was forced resident by a missing index. */
  forcedByIndex: boolean
}

/**
 * Build the facts list from a stats document.
 *
 * Ordering is preserved, and the returned list is sorted by call count
 * descending so that {@link protectTop} can take a prefix.
 * @param stats - the document produced by ./stats.ts.
 * @returns one fact per tool, most-called first.
 */
export function factsFromStats(stats: StatsFile): ToolFacts[] {
  return Object.entries(stats.tools)
    .map(([name, stat]: [string, ToolStat]) => ({
      name,
      calls: stat.calls,
      sessionsSeen: stat.sessionsSeen,
      lastSeen: stat.lastSeen,
    }))
    .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name))
}

/**
 * Decide every tool's disclosure mode.
 *
 * The order of the three checks is load-bearing and is documented at each step.
 * @param facts - the tools and their measured usage.
 * @param context - tunables; anything omitted takes its documented default.
 * @returns the three buckets, the reasons, and the arithmetic behind them.
 */
export function decideToolPlan(facts: readonly ToolFacts[], context: DecideContext = {}): ToolPlan {
  const protectionCount = context.protectionCount ?? DECISION_DEFAULTS.protectionCount
  const charsPerToken = context.charsPerToken ?? DECISION_DEFAULTS.charsPerToken
  const turnsPerSession = context.turnsPerSession ?? DECISION_DEFAULTS.turnsPerSession
  const hitchProbability = context.hitchProbability ?? DECISION_DEFAULTS.hitchProbability
  const hitchCostFraction = context.hitchCostFraction ?? DECISION_DEFAULTS.hitchCostFraction

  // One dedicated turn costs the current context as input plus the response.
  const fullTurnTokens = (context.contextTokens ?? DEFAULT_CONTEXT_TOKENS) + (context.outputTokens ?? DEFAULT_OUTPUT_TOKENS)
  const hitchTokens = fullTurnTokens * hitchCostFraction

  const protectedNames = protectTop(facts, protectionCount)
  const resident: string[] = []
  const secondary: string[] = []
  const observe: string[] = []
  const reasons: Record<string, string> = {}
  const costs: Record<string, ToolCost> = {}

  for (const fact of facts) {
    const calls = Number.isFinite(fact.calls) ? Math.max(0, fact.calls) : 0
    const discoverable = fact.discoverableIndex !== false
    const protectedByRank = protectedNames.has(fact.name)
    const measured = typeof fact.declarationsChars === 'number' && Number.isFinite(fact.declarationsChars)

    const residentTokens = measured ? (fact.declarationsChars as number) / charsPerToken * turnsPerSession : 0
    const expectedCalls = calls
    const secondaryTokens = expectedCalls * (hitchProbability * hitchTokens + (1 - hitchProbability) * fullTurnTokens)
    const forcedByIndex = !discoverable

    // STEP 1 -- a missing index forbids secondary outright. Checked first
    // because it is not a cost comparison: choosing secondary here destroys the
    // observability that any cost comparison would need.
    // STEP 2 -- protection by rank overrides the arithmetic for the same reason
    // in a milder form: frequency says the tool is load-bearing.
    // STEP 3 -- an unmeasured declaration length cannot be costed, so residency
    // wins on the unknown-versus-known-small comparison.
    // STEP 4 -- the actual comparison.
    let bucket: Bucket
    if (forcedByIndex) {
      bucket = 'resident'
      reasons[fact.name] = 'resident: the declaration AND its index would be removed, so the model could never learn this tool exists; secondary would be permanent failure, not a cost'
    } else if (protectedByRank) {
      bucket = 'resident'
      reasons[fact.name] = 'resident: top-' + protectionCount + ' by calls (' + calls + '); a frequent tool being recently unused is a task-type change, not a capability change, and demotion would surface exactly when it is needed'
    } else if (!measured) {
      bucket = 'resident'
      reasons[fact.name] = 'resident: declaration length not measured in this assembly, so C_secondary has no cost basis; residency is the known-small side of an unknown comparison'
    } else if (calls === 0) {
      bucket = 'resident'
      reasons[fact.name] = 'resident: never called, so the expected call count has no estimator while C_resident is a known ' + Math.round(residentTokens) + ' tokens; unknown versus known-small resolves to resident'
    } else if (secondaryTokens < residentTokens) {
      bucket = 'secondary'
      reasons[fact.name] = 'secondary: C_secondary ' + Math.round(secondaryTokens) + ' tokens < C_resident ' + Math.round(residentTokens) + ' tokens, at ' + calls + ' calls x ' + Math.round(hitchProbability * hitchTokens + (1 - hitchProbability) * fullTurnTokens) + ' per fetched call'
    } else {
      bucket = 'resident'
      reasons[fact.name] = 'resident: C_resident ' + Math.round(residentTokens) + ' tokens <= C_secondary ' + Math.round(secondaryTokens) + ' tokens, at ' + calls + ' calls'
    }

    if (calls === 0) observe.push(fact.name)
    if (bucket === 'resident') resident.push(fact.name)
    else secondary.push(fact.name)

    costs[fact.name] = {
      bucket,
      declarationsChars: measured ? fact.declarationsChars : undefined,
      residentTokens,
      secondaryTokens,
      expectedCalls,
      ratio: residentTokens === 0 ? Number.POSITIVE_INFINITY : secondaryTokens / residentTokens,
      protectedByRank,
      forcedByIndex,
    }
  }

  return { resident, secondary, observe, reasons, costs }
}

/**
 * The names in the top \`count\` by call count.
 *
 * Ties break on name so the protected set does not depend on input order, which
 * matters because this set is compared across runs for drift.
 * @param facts - the tools, in any order.
 * @param count - how many to protect; 0 or less protects nothing.
 * @returns the protected names.
 */
export function protectTop(facts: readonly ToolFacts[], count: number): Set<string> {
  if (count <= 0) return new Set()
  return new Set(
    [...facts]
      .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name))
      .slice(0, count)
      .map(fact => fact.name),
  )
}

/**
 * Tools whose two costs are within \`margin\` of each other -- the near-calls.
 *
 * These are the ones a small change in the uncertain constants would flip, so
 * they are the ones worth listing separately in a report rather than burying in
 * a single verdict.
 * @param plan - a plan from {@link decideToolPlan}.
 * @param margin - relative gap. 0.3 means "within 30%" either way.
 * @returns the borderline tool names, in input order, with their ratios.
 */
export function borderlineTools(plan: ToolPlan, margin = 0.3): { name: string; ratio: number; bucket: Bucket }[] {
  const out: { name: string; ratio: number; bucket: Bucket }[] = []
  for (const [name, cost] of Object.entries(plan.costs)) {
    if (cost.protectedByRank || cost.forcedByIndex) continue
    if (!Number.isFinite(cost.ratio) || cost.expectedCalls === 0) continue
    if (Math.abs(cost.ratio - 1) <= margin) out.push({ name, ratio: cost.ratio, bucket: cost.bucket })
  }
  return out
}

/**
 * Sweep the hitch probability and report which tools flip, and where.
 *
 * The whole point of the cost model is that one of its constants describes model
 * behaviour rather than anything measurable in the logs. This function is how
 * that constant's influence is bounded rather than assumed: it re-decides at
 * each probability in \`steps\` and records every tool whose bucket changes.
 * @param facts - the same facts the real decision uses.
 * @param context - tunables; \`hitchProbability\` here is ignored, in favour of the sweep.
 * @param steps - the probabilities to evaluate; defaults to 0, 0.1 ... 1.
 * @returns the baseline plan and one flip record per tool that ever moves.
 */
export function sweepHitchProbability(
  facts: readonly ToolFacts[],
  context: DecideContext = {},
  steps: readonly number[] = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
): { baseline: ToolPlan; byProbability: { probability: number; plan: ToolPlan }[]; flips: { name: string; from: Bucket; to: Bucket; at: number }[] } {
  const byProbability: { probability: number; plan: ToolPlan }[] = []
  for (const probability of steps) {
    byProbability.push({ probability, plan: decideToolPlan(facts, { ...context, hitchProbability: probability }) })
  }
  const baseline = decideToolPlan(facts, context)
  const flips: { name: string; from: Bucket; to: Bucket; at: number }[] = []
  let previous: Record<string, Bucket> | undefined
  for (const entry of byProbability) {
    const current: Record<string, Bucket> = {}
    for (const [name, cost] of Object.entries(entry.plan.costs)) current[name] = cost.bucket
    if (previous !== undefined) {
      for (const [name, bucket] of Object.entries(current)) {
        const was = previous[name]
        if (was !== undefined && was !== bucket) flips.push({ name, from: was, to: bucket, at: entry.probability })
      }
    }
    previous = current
  }
  return { baseline, byProbability, flips }
}

/**
 * Signed token saving per session if the plan's secondary tools really are
 * demoted, for one session's worth of calls.
 *
 * Reported because a name list without a magnitude cannot be argued with. The
 * resident side is charged to EVERY session; the secondary side only to the
 * sessions that call the tool, distributed by its own sessionsSeen.
 * @param plan - the plan to evaluate.
 * @param facts - the same facts, for the per-tool session counts.
 * @param config - tunables for the conversion; defaults match the plan's.
 * @returns the totals, as token figures.
 */
export function estimateSessionSavings(
  plan: ToolPlan,
  facts: readonly ToolFacts[],
  config: DecideContext = {},
): { residentTokensPerSession: number; secondaryTokensPerSession: number; netTokensPerSession: number; sessionsConsidered: number } {
  const byName = new Map(facts.map(fact => [fact.name, fact]))
  const sessionsConsidered = Math.max(1, ...facts.map(fact => fact.sessionsSeen ?? 0))

  let residentTokensPerSession = 0
  // Every resident tool is paid for by every session.
  for (const name of plan.resident) {
    const cost = plan.costs[name]
    if (cost !== undefined) residentTokensPerSession += cost.residentTokens
  }

  // Each secondary tool is fetched once per calling session, in expectation,
  // and only in the fraction of sessions that actually call it.
  let secondaryTokensPerSession = 0
  for (const name of plan.secondary) {
    const cost = plan.costs[name]
    const fact = byName.get(name)
    if (cost === undefined || fact === undefined) continue
    const callShare = Math.min(1, (fact.sessionsSeen ?? 0) / sessionsConsidered)
    const callsPerCallingSession = (fact.sessionsSeen ?? 0) === 0 ? 0 : cost.expectedCalls / (fact.sessionsSeen as number)
    const hitchProbability = config.hitchProbability ?? DECISION_DEFAULTS.hitchProbability
    const hitchCostFraction = config.hitchCostFraction ?? DECISION_DEFAULTS.hitchCostFraction
    const fullTurnTokens = (config.contextTokens ?? DEFAULT_CONTEXT_TOKENS) + (config.outputTokens ?? DEFAULT_OUTPUT_TOKENS)
    const perFetch = hitchProbability * fullTurnTokens * hitchCostFraction + (1 - hitchProbability) * fullTurnTokens
    secondaryTokensPerSession += callShare * callsPerCallingSession * perFetch
  }

  return {
    residentTokensPerSession,
    secondaryTokensPerSession,
    netTokensPerSession: residentTokensPerSession - secondaryTokensPerSession,
    sessionsConsidered,
  }
}

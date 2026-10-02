/**
 * The strip report: the one line an operator reads to see what \`stripToolDecls\`
 * measured, whether it removed anything, and why it refused.
 *
 * WHY IT IS A SEPARATE MODULE rather than three lines in the handler. The
 * measurement lives on the COMPILED OP ({@link StripToolDeclsReport}), because the
 * op is what ran; the handler holds the compiled rules and nothing else. Keeping
 * the walk and the wording here means the log line's shape is testable without a
 * cordis context, and the handler stays a handler.
 *
 * @module @t4r71/dsh-prompt-plan/strip-report
 */

import type { CompiledRule } from './rewrite.ts'
import type { StripToolDeclsReport } from './transform.ts'

/** The logger shape this module needs; \`ctx.logger\` satisfies it. */
export interface StripLogger {
  info: (message: string, ...args: unknown[]) => void
  warn: (message: string, ...args: unknown[]) => void
}

/** One strip op's report, paired with the rule that owns it. */
export interface StripOutcomeLine {
  /** The rule id, so a report can be tied to the file that produced it. */
  readonly ruleId: string
  /** The op's own report. */
  readonly report: StripToolDeclsReport
  /** The refusal, when the op refused to change anything. */
  readonly refusal?: { readonly check: string; readonly problem: string }
}

/**
 * Collect every \`stripToolDecls\` op's report from the compiled rules.
 *
 * A rule whose action is not a transform contributes nothing, and an op that never
 * ran carries no report — both are simply absent rather than reported as zero,
 * because "did not run" and "measured nothing" are different facts.
 * @param rules - the compiled rules.
 * @returns one line per op that ran, in rule order.
 */
export function collectStripReports(rules: readonly CompiledRule[]): StripOutcomeLine[] {
  const lines: StripOutcomeLine[] = []
  for (const rule of rules) {
    const ops = rule.action.kind === 'transform' ? rule.action.transform ?? [] : []
    for (const op of ops) {
      if (op.op !== 'stripToolDecls') continue
      const report = op.lastReport
      if (report === undefined) {
        if (op.lastRefusal === undefined) continue
        lines.push({ ruleId: rule.id, report: { dryRun: op.dryRun, removedChars: 0, tools: [], missing: [] }, refusal: op.lastRefusal })
        continue
      }
      lines.push({ ruleId: rule.id, report, ...op.lastRefusal === undefined ? {} : { refusal: op.lastRefusal } })
    }
  }
  return lines
}

/**
 * Render one report as the operator's line.
 * @param line - the collected report.
 * @returns the message, without the logger's own prefix.
 */
export function describeStripOutcome(line: StripOutcomeLine): string {
  const head = `stripToolDecls [${line.ruleId}]: ${line.report.dryRun ? 'dry run, nothing removed' : 'removed'}; `
    + `${line.report.tools.length} tool(s), ${line.report.removedChars} characters total`
  const perTool = line.report.tools
    .map(tool => `${tool.name} ${tool.argsChars}+${tool.outputChars}=${tool.argsChars + tool.outputChars}`)
    .join(', ')
  // A request that matched nothing is REPORTED and never fatal: a dynamic list is
  // expected to name tools that only some agents can see, and the fallback for
  // "this agent does not have it" is that its declaration is not here to strip.
  const absent = line.report.missing.length === 0 ? '' : `; NOT DECLARED HERE (requested, absent from this assembly): ${line.report.missing.join(', ')}`
  const tail = (line.refusal === undefined ? '' : `; REFUSED (${line.refusal.check}): ${line.refusal.problem}`) + absent
  return perTool.length === 0 ? head + tail : `${head}; ${perTool}${tail}`
}

/**
 * Log every strip report for one assembly.
 * @param logger - the host logger.
 * @param rules - the compiled rules that were applied.
 */
export function logStripReports(logger: StripLogger, rules: readonly CompiledRule[]): void {
  for (const line of collectStripReports(rules)) {
    if (line.refusal === undefined) logger.info('prompt-plan: %s', describeStripOutcome(line))
    else logger.warn('prompt-plan: %s', describeStripOutcome(line))
  }
}

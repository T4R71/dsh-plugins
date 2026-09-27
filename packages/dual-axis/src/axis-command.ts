/**
 * The dual-axis bundle's command registration: the one write path the two
 * composer dropdowns reach the host through.
 *
 * The name is NOT permission. @deepseek-ai/dsh-permission-presets registers
 * /permission on the global command layer, and the registry's NamedEntries
 * throws on a duplicate global name, so reusing it would fail this plugin's
 * load. The preset picker keeps /permission; this command owns the axes.
 *
 * Registration rides ctx.inject(['commands'], …) rather than the plugin's
 * static inject: a profile without a command registry composes this bundle
 * for its fence and prompt, and an unconditional ctx.commands access would fail
 * that load.
 *
 * The write is a WHOLE-DOCUMENT settings write and therefore asynchronous, so
 * the handler is too. A lost revision race settles as an ordinary command
 * error carrying the conflict's own sentence: the dispatching surface renders
 * it beside the picker, and nothing is reported as applied that was not stored.
 *
 * @module @t4r71/dsh-dual-axis/axis-command
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AxisScope, EffectiveScopes } from './axis.ts'
import { parseAxisEntry } from './axis-entry.ts'
import { SessionAxesConflictError } from './session-store.ts'

/** The registered command name, without its leading slash. */
export const AXIS_COMMAND_NAME = 'axis'

/** The advertised input hint and the tail of every refusal sentence. */
const USAGE = 'Usage: /' + AXIS_COMMAND_NAME + ' <read|write>:<deny|workspace|all|custom:base=…,groups=…,allow=…,deny=…>'

/** What the registration needs from its owner. */
export interface AxisCommandOptions {
  /**
   * The session's standing axis pair, read from the session axis store — the one
   * source every other consumer reads. Supplies the axis a one-axis entry does
   * not name.
   * @param session - the session the invocation belongs to.
   * @returns the pair in force, with both defaults filled in.
   */
  readonly current: (session: Session) => EffectiveScopes
  /**
   * The rule-group ids the settings page currently defines. Read at the moment
   * of the invocation so a group created since startup is selectable, and used
   * only to REFUSE an unknown id: an existing id is recorded verbatim and
   * expanded at the moment of use, never here.
   * @returns the defined ids.
   */
  readonly knownGroups: () => ReadonlySet<string>
  /**
   * Store one session's new pair. Supplied by the composing plugin, which owns
   * the store; the command layer never reaches the settings document itself.
   * @param session - the session to write.
   * @param axes - the complete new pair.
   */
  readonly write: (session: Session, axes: EffectiveScopes) => Promise<void>
}

/**
 * Render one axis value for the settlement sentence.
 * @param scope - the axis value.
 * @returns its kind, with a custom value's base and list sizes.
 */
function describeScope(scope: AxisScope): string {
  if (scope.kind !== 'custom') return scope.kind
  return 'custom(base=' + scope.base + ', +' + String(scope.allow.length) + ', -' + String(scope.deny.length) + ')'
}

/**
 * Register the axis command for every composed command adapter.
 * @param ctx - host context; the registration is owned by this context's fiber.
 * @param options - the standing-pair reader, the group-id reader, and the write path.
 */
export function registerAxisCommand(ctx: Context, options: AxisCommandOptions): void {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: CommandDefinitionId('@t4r71/dsh-dual-axis'),
      name: AXIS_COMMAND_NAME,
      description: 'Switch one file-sandbox access axis (read or write)',
      input: { hint: '<read|write>:<deny|workspace|all|custom:base=…,groups=…,allow=…,deny=…>' },
      handler: async ({ agent, rawInput }: CommandInvocation): Promise<CommandResult> => {
        // A refused entry writes NOTHING: an unknown group id must not reach the
        // store, where it would fail every later access closed.
        const parsed = parseAxisEntry(rawInput, options.current(agent.session), options.knownGroups())
        if (!parsed.ok) return { kind: 'error', text: parsed.problem + '. ' + USAGE }
        try {
          await options.write(agent.session, parsed.axes)
        } catch (error) {
          // Every other failure is reported verbatim too: a silent success here
          // would leave the picker showing a range the fence does not enforce.
          const detail = error instanceof SessionAxesConflictError
            ? error.message
            : 'the axis was not stored: ' + (error instanceof Error ? error.message : String(error))
          return { kind: 'error', text: detail + '. ' + USAGE }
        }
        return {
          kind: 'success',
          text: 'read ' + describeScope(parsed.axes.read) + ' | write ' + describeScope(parsed.axes.write),
        }
      },
    })
  })
}

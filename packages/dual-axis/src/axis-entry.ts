/**
 * The dual-axis command's argument grammar: one client-composed entry string
 * into one access axis.
 *
 * The grammar is owned by the browser half's pickers, which emit exactly two
 * forms — <axis>:<deny|workspace|all> for the three closed values, and
 * <axis>:custom:base=<deny|workspace|all>[,groups=<id>|<id>][,allow=<absolute path>][,deny=<absolute path>]
 * from the path editor, where a repeated key carries several entries.
 *
 * A `groups` entry records the IDS ONLY, checked against the ids the settings
 * page currently defines and then stored verbatim. The group's rules are never
 * expanded into the entry: expansion happens at the moment of use, so editing a
 * group reaches every session that references it without a restart.
 *
 * The caller supplies the session's standing pair so a one-axis entry returns
 * the complete new pair; the axis the entry does not name keeps its value.
 *
 * @module @t4r71/dsh-dual-axis/axis-entry
 */

import { isAbsoluteSpelling } from './scope.ts'
import type { AxisBase, AxisScope, EffectiveScopes } from './axis.ts'

/** The two axis names an entry string may start with. */
export const AXIS_ENTRY_NAMES: readonly string[] = ['read', 'write']

/** A parsed entry, or the sentence explaining why it is not one. */
export type AxisEntryParse =
  | { readonly ok: true; readonly axes: EffectiveScopes }
  | { readonly ok: false; readonly problem: string }

/** One custom-scope parse, narrowed before it reaches the pair. */
type CustomParse =
  | { readonly ok: true; readonly scope: AxisScope }
  | { readonly ok: false; readonly problem: string }

/** The separator between rule-group ids in one `groups` entry. */
export const GROUP_ID_SEPARATOR = '|'

/**
 * Whether a spelling names an access axis.
 * @param value - the text before the first colon.
 * @returns whether it is read or write.
 */
function isAxisName(value: string): boolean {
  return AXIS_ENTRY_NAMES.includes(value)
}

/**
 * Whether a spelling names a custom base.
 * @param value - the candidate base.
 * @returns whether it is one of the three bases.
 */
function isAxisBase(value: string): value is AxisBase {
  return value === 'deny' || value === 'workspace' || value === 'all'
}

/**
 * Parse the base=…,groups=…,allow=…,deny=… fragment that follows <axis>:custom:.
 * @param fragment - everything after the second colon.
 * @param knownGroups - the rule-group ids the settings page currently defines.
 * @returns the custom scope, or the sentence explaining which entry failed.
 */
function parseCustomFragment(fragment: string, knownGroups: ReadonlySet<string>): CustomParse {
  const entries = fragment.split(',')
  const head = entries[0]
  if (head === undefined || !head.startsWith('base=')) {
    return { ok: false, problem: 'a custom axis must begin with base=<deny|workspace|all>' }
  }
  const base = head.slice('base='.length)
  if (!isAxisBase(base)) {
    return { ok: false, problem: '"' + base + '" is not a custom base; expected deny, workspace, or all' }
  }
  const groups: string[] = []
  const allow: string[] = []
  const deny: string[] = []
  for (let index = 1; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry === undefined) continue
    const separator = entry.indexOf('=')
    if (separator < 0) {
      return { ok: false, problem: '"' + entry + '" is not a key=value entry; expected groups=<id>|<id>, allow=<absolute path>, or deny=<absolute path>' }
    }
    const key = entry.slice(0, separator)
    const value = entry.slice(separator + 1)
    if (key !== 'groups' && key !== 'allow' && key !== 'deny') {
      return { ok: false, problem: '"' + key + '" is not a custom key; expected groups, allow, or deny' }
    }
    if (key === 'groups') {
      // An id the settings page does not define is refused here rather than
      // recorded: the session would otherwise reference a group that can never
      // resolve, and every path would be refused for a reason a round away.
      for (const id of value.split(GROUP_ID_SEPARATOR)) {
        if (id.length === 0) {
          return { ok: false, problem: 'groups entry ' + JSON.stringify(value) + ' carries an empty rule-group id' }
        }
        if (!knownGroups.has(id)) {
          return { ok: false, problem: '"' + id + '" is not a rule group the settings page defines' }
        }
        if (!groups.includes(id)) groups.push(id)
      }
      continue
    }
    if (!isAbsoluteSpelling(value)) {
      return { ok: false, problem: key + ' entry ' + JSON.stringify(value) + ' must be a non-empty absolute path' }
    }
    // A repeated key is several entries, in the order the editor emitted them.
    if (key === 'allow') allow.push(value)
    else deny.push(value)
  }
  return {
    ok: true,
    scope: {
      kind: 'custom',
      base,
      groups: Object.freeze(groups),
      allow: Object.freeze(allow),
      deny: Object.freeze(deny),
    },
  }
}

/**
 * Read one client-composed axis entry into the complete axis pair it selects.
 * @param rawInput - the command invocation's verbatim input; the commands
 *   registry passes the text after the command name including the separating
 *   space, so this trims first.
 * @param current - the session's standing pair; the axis the entry does not
 *   name keeps its value from here.
 * @param knownGroups - the rule-group ids the settings page currently defines;
 *   a `groups` entry naming anything else is refused.
 * @returns the new pair, or the sentence explaining why the entry was refused.
 */
export function parseAxisEntry(
  rawInput: string,
  current: EffectiveScopes,
  knownGroups: ReadonlySet<string> = new Set(),
): AxisEntryParse {
  const input = rawInput.trim()
  if (input === '') {
    return { ok: false, problem: 'an axis switch requires <read|write>:<deny|workspace|all|custom:base=…,groups=…,allow=…,deny=…>' }
  }
  const headEnd = input.indexOf(':')
  if (headEnd < 0) {
    return { ok: false, problem: '"' + input + '" names no axis; expected <read|write>:<value>' }
  }
  const axisName = input.slice(0, headEnd)
  if (!isAxisName(axisName)) {
    return { ok: false, problem: '"' + axisName + '" is not an axis; expected read or write' }
  }
  const tail = input.slice(headEnd + 1)
  const kindEnd = tail.indexOf(':')
  const kind = kindEnd < 0 ? tail : tail.slice(0, kindEnd)
  const rest = kindEnd < 0 ? '' : tail.slice(kindEnd + 1)

  let scope: AxisScope
  if (kind === 'custom') {
    if (rest === '') {
      return { ok: false, problem: 'custom needs its base and path lists: custom:base=<deny|workspace|all>[,groups=<id>|<id>][,allow=<absolute path>][,deny=<absolute path>]' }
    }
    const parsed = parseCustomFragment(rest, knownGroups)
    if (!parsed.ok) return parsed
    scope = parsed.scope
  } else if (isAxisBase(kind)) {
    if (rest !== '') {
      return { ok: false, problem: '"' + kind + '" takes no further arguments' }
    }
    scope = { kind }
  } else {
    return { ok: false, problem: '"' + kind + '" is not an axis value; expected deny, workspace, all, or custom' }
  }

  return {
    ok: true,
    axes: axisName === 'read'
      ? { read: scope, write: current.write }
      : { read: current.read, write: scope },
  }
}

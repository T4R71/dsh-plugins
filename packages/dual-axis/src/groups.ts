/**
 * RULE GROUPS and THE ONE resolution from a session's axis preset to the ranges
 * actually in force.
 *
 * A rule group is a named fragment of path rules owned by the settings page
 * (`dual-axis`'s `groups` Config field). A session references groups BY ID and
 * never stores their content: ten sessions selecting one group must not become
 * ten copies of it, because copies drift. Resolving an id against the CURRENT
 * library is therefore the only place a group's rules enter a decision, and
 * editing a group takes effect on every session referencing it without a
 * restart.
 *
 * This module is that place, for both axes and for both invariants that ride on
 * them:
 *
 * - **deny wins over allow**, with session-level entries and every selected
 *   group merged into ONE allow list and ONE deny list first
 *   ({@link resolveEffectiveAxes}), so a group's removal cannot be overridden by
 *   a session-level addition.
 * - **write never exceeds read**: the effective write range is the write axis's
 *   range INTERSECTED with the read axis's range. A write outside the read range
 *   would let an agent overwrite a file it cannot read back, so the intersection
 *   is computed here — in the resolution — and never in a user interface.
 *
 * Both the fence and the model-facing prompt call {@link resolveEffectiveAxes},
 * so the range the model is told about and the range it is held to are the same
 * computation over the same inputs: the session's own preset (read and write
 * axes, their own additions and removals, and the group ids they selected) plus
 * the current definitions of those ids. The settings page's `read` / `write`
 * defaults and its `defaultGroups` seed are NOT among those inputs: they are
 * read once, when a session is created.
 *
 * A reference to an id the library does not define is refused, never treated as
 * an empty group: "I excluded it and nothing happened" is the worst failure this
 * surface can have.
 *
 * @module @t4r71/dsh-dual-axis/groups
 */

import { sep } from 'node:path'

import type { AxisScope, EffectiveScopes } from './axis.ts'
import { pathList } from './config.ts'
import { isEvaluableAxis, isLexicallyUnder, resolveScope, scopeContains } from './scope.ts'
import type { ResolvedScope, ScopePolicy } from './scope.ts'

/** One group's rules for one axis. Either list may be absent. */
export interface RuleGroupAxis {
  /** Absolute roots this group adds to the base. */
  readonly allow?: readonly string[]
  /** Absolute roots this group removes even from the base — removal wins. */
  readonly deny?: readonly string[]
}

/**
 * A named rule fragment. `id` is what a session stores; `name` is for humans
 * only and may change freely. A group may carry rules for one axis, the other,
 * or both.
 */
export interface RuleGroup {
  /** Stable identity a session references; renaming it changes every reference. */
  readonly id: string
  /** The human-readable name; carries no semantics. */
  readonly name: string
  /** The rules this group contributes to the read axis. */
  readonly read?: RuleGroupAxis
  /** The rules this group contributes to the write axis. */
  readonly write?: RuleGroupAxis
}

/**
 * What the write-never-exceeds-read invariant removed from the write axis.
 *
 * Reported rather than applied silently: a group that only grants write access
 * to a directory the read axis does not cover grants nothing at all, and a user
 * who configured it must be able to see that instead of concluding the rule was
 * ignored.
 *
 * This value is the ONE answer to "what did the intersection remove", and it is
 * published verbatim to the client half inside the session's stored record
 * (`./session-store.ts`). A browser cannot re-derive it: the path algebra below
 * canonicalizes every root with `realpath` and derives a `workspace` base from
 * `os.tmpdir()`, neither of which exists there. Publishing the resolution's own
 * result is therefore what keeps a surface from claiming a narrowing the fence
 * does not enforce, or missing one it does.
 */
export interface WriteNarrowing {
  /** Whether the read axis makes the effective write range strictly smaller. */
  readonly narrowed: boolean
  /**
   * Absolute roots the write axis permitted and the effective range does not.
   * Holds both the write roots the read axis does not cover and the read roots
   * the write range newly excludes; empty when {@link lostUnbounded} alone
   * carries the loss, because an unbounded write axis has no root list to lose.
   */
  readonly droppedRoots: readonly string[]
  /** Whether an unbounded write axis became bounded, which no root list can state. */
  readonly lostUnbounded: boolean
}

/**
 * The pair actually in force, with every selected group expanded and the write
 * axis already intersected with the read axis. Both members are plain
 * {@link AxisScope} values carrying no group ids, so every consumer resolves
 * them with the same {@link resolveScope} it used before groups existed.
 */
export interface EffectiveAxes {
  /** The read range in force. */
  readonly read: AxisScope
  /** The write range in force, never wider than {@link read}. */
  readonly write: AxisScope
  /** What the intersection removed from the write axis. */
  readonly narrowing: WriteNarrowing
}

/**
 * A resolved pair, or the sentence explaining why it could not be resolved.
 * Resolution failure is a value rather than a throw because every caller has a
 * different fail-closed rendering for it: the fence refuses the access, the
 * prompt states that no path is known to be allowed, and `/axis` returns an
 * error without writing an event.
 */
export type EffectiveAxesResolution =
  | { readonly ok: true; readonly axes: EffectiveAxes }
  | { readonly ok: false; readonly problem: string }

/** The narrowing that removed nothing. Exported: it is the stored record's absent value. */
export const NO_NARROWING: WriteNarrowing = { narrowed: false, droppedRoots: [], lostUnbounded: false }

/**
 * Read one stored narrowing report, or throw naming the member that is
 * unreadable.
 *
 * An absent member is the legal "nothing was ever published for this record"
 * state and yields {@link NO_NARROWING}: that is exactly what the fence enforced
 * before this member existed, so the surface shows no narrowing rather than
 * inventing one. Anything PRESENT must be well formed — a report whose root list
 * cannot be read would otherwise be displayed as "nothing was removed".
 * @param value - the untrusted `narrowing` member of a stored record.
 * @returns the validated report.
 * @throws When the member is present and not a well-formed report.
 */
export function parseNarrowing(value: unknown): WriteNarrowing {
  if (value === undefined) return NO_NARROWING
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('dual-axis: a stored narrowing report must be an object')
  }
  const candidate = value as { narrowed?: unknown; droppedRoots?: unknown; lostUnbounded?: unknown }
  if (typeof candidate.narrowed !== 'boolean' || typeof candidate.lostUnbounded !== 'boolean') {
    throw new Error('dual-axis: a stored narrowing report needs boolean narrowed and lostUnbounded')
  }
  return {
    narrowed: candidate.narrowed,
    droppedRoots: pathList('stored narrowing', 'droppedRoots', candidate.droppedRoots),
    lostUnbounded: candidate.lostUnbounded,
  }
}

/** One parsed library, keyed by id, or the sentence explaining why it is unusable. */
type LibraryParse =
  | { readonly ok: true; readonly byId: ReadonlyMap<string, RuleGroup> }
  | { readonly ok: false; readonly problem: string }

/**
 * Parse one group's rules for one axis.
 * @param label - the group and axis, as the error message should name them.
 * @param value - the untrusted `read` or `write` member.
 * @returns the validated rules, or `undefined` when the member is absent.
 * @throws When the member is neither absent nor an object of absolute path lists.
 */
function axisRules(label: string, value: unknown): RuleGroupAxis | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') {
    throw new Error(`dual-axis: ${label} must be an object carrying allow and/or deny`)
  }
  const candidate = value as { allow?: unknown; deny?: unknown }
  return {
    allow: pathList(label, 'allow', candidate.allow),
    deny: pathList(label, 'deny', candidate.deny),
  }
}

/**
 * Read one group entry out of the library.
 * @param index - the entry's position, used in error messages.
 * @param value - the untrusted entry.
 * @returns the validated group.
 * @throws When the entry carries no usable id.
 */
function groupAt(index: number, value: unknown): RuleGroup {
  if (value === null || typeof value !== 'object') {
    throw new Error(`dual-axis: rule group #${String(index)} must be an object`)
  }
  const candidate = value as { id?: unknown; name?: unknown; read?: unknown; write?: unknown }
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    throw new Error(`dual-axis: rule group #${String(index)} needs a non-empty string id`)
  }
  const label = 'rule group ' + JSON.stringify(candidate.id)
  const read = candidate.read === undefined ? undefined : axisRules(label + ' read', candidate.read)
  const write = candidate.write === undefined ? undefined : axisRules(label + ' write', candidate.write)
  return {
    id: candidate.id,
    // The name is presentation only; an unnamed group is named by its id rather
    // than refused, because the id is the part every reference depends on.
    name: typeof candidate.name === 'string' && candidate.name.length > 0 ? candidate.name : candidate.id,
    ...read === undefined ? {} : { read },
    ...write === undefined ? {} : { write },
  }
}

/**
 * Parse the settings page's group library. An unset or null library is the
 * legal "no groups configured" state; anything else must be a well-formed
 * library, because a half-read library would silently drop a removal.
 * @param value - the untrusted `groups` Config value.
 * @returns the parsed library by id, or the sentence explaining why it is unusable.
 */
function parseLibrary(value: unknown): LibraryParse {
  if (value === undefined || value === null) return { ok: true, byId: new Map() }
  if (!Array.isArray(value)) return { ok: false, problem: 'the rule-group library must be an array of groups' }
  const byId = new Map<string, RuleGroup>()
  try {
    for (let index = 0; index < value.length; index += 1) {
      const group = groupAt(index, (value as unknown[])[index])
      if (byId.has(group.id)) {
        return { ok: false, problem: 'the rule-group library defines ' + JSON.stringify(group.id) + ' more than once' }
      }
      byId.set(group.id, group)
    }
  } catch (error) {
    // Only the validators above throw here; their message is the whole report.
    return { ok: false, problem: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, byId }
}

/**
 * The group ids a preset references, in first-seen order and without repeats.
 * Callers use this to skip reading the settings page at all for the sessions
 * that reference no groups.
 * @param preset - the session's own axis preset.
 * @returns the referenced ids.
 */
export function referencedGroupIds(preset: EffectiveScopes): readonly string[] {
  const ids: string[] = []
  for (const axis of [preset.read, preset.write]) {
    if (axis.kind !== 'custom') continue
    for (const id of axis.groups ?? []) if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * The ids the settings page's library defines, for validating one command entry
 * before it is recorded.
 *
 * An unusable library yields no ids: every `groups` entry is then refused by
 * name, which is the same fail-closed answer the decision path gives.
 * @param library - the settings page's current `groups` value, untrusted.
 * @returns the defined ids.
 */
export function ruleGroupIds(library: unknown): ReadonlySet<string> {
  const parsed = parseLibrary(library)
  return parsed.ok ? new Set(parsed.byId.keys()) : new Set()
}

/**
 * Expand one axis: its own additions and removals first, then those of every
 * group it references, merged into one allow list and one deny list. The result
 * carries no group ids — expansion is the resolution, and a resolved value that
 * still referenced groups could be expanded a second time.
 * @param axis - the axis preset.
 * @param side - which of a group's two rule sets applies.
 * @param byId - the parsed library.
 * @returns the expanded axis.
 */
function expandAxis(axis: AxisScope, side: 'read' | 'write', byId: ReadonlyMap<string, RuleGroup>): AxisScope {
  if (axis.kind !== 'custom') return axis
  const ids = axis.groups ?? []
  if (ids.length === 0) return axis
  const allow = [...axis.allow]
  const deny = [...axis.deny]
  for (const id of ids) {
    const rules = byId.get(id)?.[side]
    if (rules === undefined) continue
    allow.push(...rules.allow ?? [])
    deny.push(...rules.deny ?? [])
  }
  return {
    kind: 'custom',
    base: axis.base,
    allow: [...new Set(allow)],
    deny: [...new Set(deny)],
  }
}

/**
 * Attach the group ids a NEW session starts out referencing to the axes that are
 * `custom`, leaving every other axis exactly as declared.
 *
 * The rule is judged per axis, and only an axis whose OWN kind is `custom` can
 * carry a reference: checking the settings row instead (a tick that is not
 * tied to an axis) promoted `read: all` to `read: { kind: 'custom', base: 'all' }`
 * even though no axis was ever set to custom. An axis of one of the three closed
 * kinds has nowhere to put an id and is seeded verbatim — promoting it would
 * report a custom scope the settings page never showed.
 *
 * A group may carry rules for either axis or both, and the session selected it
 * once, so the same list goes on both `custom` axes; the group's `read` rules
 * then apply where they exist and its `write` rules where they exist. Two axes
 * are therefore independent: one may take the references while the other keeps
 * its closed kind.
 * @param axes - the pair a new session is seeded with.
 * @param ids - the settings page's `defaultGroups`.
 * @returns the pair carrying those references.
 */
export function seedGroupReferences(axes: EffectiveScopes, ids: readonly string[]): EffectiveScopes {
  if (ids.length === 0) return axes
  const attach = (axis: AxisScope): AxisScope => axis.kind === 'custom'
    ? { ...axis, groups: [...new Set([...(axis.groups ?? []), ...ids])] }
    : axis
  return { read: attach(axes.read), write: attach(axes.write) }
}

/**
 * The intersection of two evaluated ranges, as an evaluated range. Exact for
 * canonical directory roots: two roots are either nested — the deeper one is
 * their intersection — or disjoint, and a union of directories intersected with
 * a union of directories is the union of those pairwise intersections.
 * @param left - one evaluated range.
 * @param right - the other evaluated range.
 * @returns the range permitting exactly what both permit.
 */
export function intersectResolved(left: ResolvedScope, right: ResolvedScope): ResolvedScope {
  const deny = [...new Set([...left.deny, ...right.deny])]
  if (left.unbounded && right.unbounded) return { unbounded: true, allow: [], deny }
  if (left.unbounded) return { unbounded: false, allow: [...right.allow], deny }
  if (right.unbounded) return { unbounded: false, allow: [...left.allow], deny }
  const allow: string[] = []
  for (const one of left.allow) {
    for (const other of right.allow) {
      if (isLexicallyUnder(one, other) && !allow.includes(one)) allow.push(one)
      else if (isLexicallyUnder(other, one) && !allow.includes(other)) allow.push(other)
    }
  }
  return { unbounded: false, allow, deny }
}

/**
 * Spell an evaluated range as an axis value that evaluates back to it. The
 * `deny` base plus the roots themselves is the exact spelling: a `workspace`
 * base would re-add the platform temp areas this range may never have had.
 * @param resolved - the evaluated range.
 * @returns the equivalent axis value.
 */
export function scopeOfResolved(resolved: ResolvedScope): AxisScope {
  return resolved.unbounded
    ? { kind: 'custom', base: 'all', allow: [], deny: [...resolved.deny] }
    : { kind: 'custom', base: 'deny', allow: [...resolved.allow], deny: [...resolved.deny] }
}

/**
 * Whether two evaluated ranges permit exactly the same paths.
 *
 * A range permits a REGION, not a pair of lists: the union of the subtrees its
 * allow roots name, minus the union of the subtrees its deny roots name. Two
 * spellings of one region permit exactly the same paths, and both directions of
 * that happen here:
 *
 * - a removal no allow root reaches is inert — `deny ["C:\\out"]` beside a write
 *   root at `C:\\ws` removes nothing, so the two ranges are the same one;
 * - an allow root a removal sits ABOVE is removed whole — `allow ["C:\\ws\\a"],
 *   deny ["C:\\ws"]` permits nothing at all, however much its allow list reads
 *   like it permits `C:\\ws\\a`.
 *
 * The second case is the one a list-shaped comparison gets wrong in the
 * direction that matters. It asks whether this range's ALLOW LIST reaches the
 * removal, which is the wrong question the moment the removal lies above the
 * list: two ranges that differ exactly there were called equal, and the caller
 * below kept an UNINTERSECTED write axis on that answer — one permitting a path
 * the read axis refuses, while the same misjudgement reported a narrowing for a
 * write root the write axis's own removal had already taken away.
 *
 * So the comparison is made where the answer cannot be misread: on POINTS, with
 * {@link scopeContains} — the fence's own predicate — deciding each one.
 * @param left - one evaluated range.
 * @param right - the other.
 * @returns whether the two permit the same paths.
 */
function sameRange(left: ResolvedScope, right: ResolvedScope): boolean {
  // An unbounded range permits whatever its own removals leave, and no union of
  // bounded roots reaches all of it, while a bounded range reaches nothing
  // outside its own roots. The two are therefore never the same region, not even
  // when the bounded one is empty.
  if (left.unbounded !== right.unbounded) return false
  return exactDiff(left, right).length === 0 && exactDiff(right, left).length === 0
}

/**
 * The witness for "this range permits at least one path the other does not" —
 * empty exactly when there is none.
 *
 * A region is a union of subtrees with holes cut into it, and every such region
 * holds either one of the roots the two ranges name or a path strictly below one
 * of them that no deeper root covers. That is {@link boundaryPoints}, so a
 * difference between two regions always shows at one of those points — the
 * answer is never "no difference" for want of a point to look at. Each answer is
 * the fence's own {@link scopeContains}, so a witness is a path one range
 * provably permits and the other provably refuses; a caller reading the empty
 * answer as "so the write axis may be kept un-intersected" is never told that
 * wrongly, and the worst outcome of the comparison is an intersection carried
 * out where it changed nothing.
 * @param left - the range whose extra permissions are asked about.
 * @param right - the range it is measured against.
 * @returns the path justifying the answer, or an empty list.
 */
function exactDiff(left: ResolvedScope, right: ResolvedScope): readonly string[] {
  for (const point of boundaryPoints(left, right)) {
    if (scopeContains(left, point, isLexicallyUnder) && !scopeContains(right, point, isLexicallyUnder)) return [point]
  }
  return []
}

/**
 * The points a comparison of two regions has to look at: every root either range
 * names, and one child of each.
 *
 * A root decides the boundary (a path is under it or is not) and the child
 * stands for the whole part of that subtree no deeper root carves off, so
 * between them they represent every region the roots can tell apart.
 * @param left - one evaluated range.
 * @param right - the other.
 * @returns the representative points of every region the two can carve out.
 */
function boundaryPoints(left: ResolvedScope, right: ResolvedScope): readonly string[] {
  const roots = [...new Set([...left.allow, ...left.deny, ...right.allow, ...right.deny])]
  const points: string[] = [...roots]
  for (const root of roots) points.push(freshChild(root, roots))
  return points
}

/**
 * One path strictly under `root` that no root strictly under `root` covers.
 *
 * The name is chosen against the first path component every deeper root names
 * after `root`, which is what makes the point a representative of the "everything
 * else below this root" region rather than a path some deeper root already
 * removed. Such a name always exists: a finite root set can never exhaust the
 * names left over.
 * @param root - the root to descend from.
 * @param roots - every root either range names.
 * @returns the representative path.
 */
function freshChild(root: string, roots: readonly string[]): string {
  const taken = new Set<string>()
  for (const other of roots) {
    if (other === root || !isLexicallyUnder(other, root)) continue
    const rest = other.length > root.length ? other.slice(root.length).replace(/^[\\/]+/, '') : ''
    const name = rest.split(/[\\/]/)[0]
    if (name !== undefined && name.length > 0) taken.add(name.toLowerCase())
  }
  let name = 'dual-axis'
  while (taken.has(name)) name += '-'
  return root + sep + name
}

/**
 * What the intersection removed: every root the write axis permitted that the
 * effective range does not.
 *
 * Both halves ask the same two questions of the root they are about — did the
 * write axis itself reach it, and does the effective range reach it now — because
 * a removal the write axis had already carried is not something the read axis
 * did. Counting a root the write axis denied itself (`allow ["C:\\dead"], deny
 * ["C:\\dead"]`) reported a narrowing of that root on a session where the read
 * axis removed nothing, and the model read a sentence about work it had never
 * been able to do. `after` is a subset of `before` by construction, so a root
 * `before` does not reach is one `after` does not reach either, and the two
 * answers cannot disagree about it.
 * @param before - the write axis's own range.
 * @param after - the effective write range.
 * @returns the narrowing report.
 */
function narrowingOf(before: ResolvedScope, after: ResolvedScope): WriteNarrowing {
  const lostUnbounded = before.unbounded && !after.unbounded
  const dropped = (root: string): boolean =>
    scopeContains(before, root, isLexicallyUnder) && !scopeContains(after, root, isLexicallyUnder)
  const droppedRoots = [...before.allow, ...after.deny].filter(dropped)
  const unique = [...new Set(droppedRoots)]
  return { narrowed: lostUnbounded || unique.length > 0, droppedRoots: unique, lostUnbounded }
}

/**
 * Expand one axis against the library, reporting the ids it references and the
 * library does not define.
 * @param axis - the axis preset.
 * @param side - which of a group's two rule sets applies.
 * @param byId - the parsed library.
 * @param missing - collects the undefined ids, in reference order.
 * @returns the expanded axis.
 */
function expandChecked(
  axis: AxisScope,
  side: 'read' | 'write',
  byId: ReadonlyMap<string, RuleGroup>,
  missing: string[],
): AxisScope {
  if (axis.kind === 'custom') {
    for (const id of axis.groups ?? []) if (!byId.has(id) && !missing.includes(id)) missing.push(id)
  }
  return expandAxis(axis, side, byId)
}

/** The sentence naming the ids a preset references and the library does not define. */
function missingGroupsProblem(ids: readonly string[]): string {
  return 'this session references rule group(s) ' + ids.map(id => JSON.stringify(id)).join(', ')
    + ' that the rule-group library does not define'
}

/**
 * THE resolution: one session's axis preset plus the current group library into
 * the read and write ranges actually in force.
 *
 * The write member of the result is the intersection of the write axis's range
 * with the read axis's. The write axis keeps its own spelling whenever the
 * intersection changed nothing, so a session that references no groups and needs
 * no narrowing is described and enforced exactly as before groups existed.
 *
 * An unresolvable reference or an unusable library returns `ok: false` and no
 * axes: the caller refuses, because resolving a missing id to an empty group
 * would silently drop rules the user configured.
 * @param preset - the session's own axis preset, group ids included.
 * @param library - the settings page's current `groups` value, untrusted.
 * @param policy - the workspace root a `workspace` base resolves against.
 * @returns the effective pair, or the sentence explaining why there is none.
 */
export function resolveEffectiveAxes(
  preset: EffectiveScopes,
  library: unknown,
  policy: ScopePolicy,
): EffectiveAxesResolution {
  const parsed = parseLibrary(library)
  if (!parsed.ok) return { ok: false, problem: parsed.problem }

  const missing: string[] = []
  const read = expandChecked(preset.read, 'read', parsed.byId, missing)
  const write = expandChecked(preset.write, 'write', parsed.byId, missing)
  if (missing.length > 0) return { ok: false, problem: missingGroupsProblem(missing) }

  let readRange: ResolvedScope
  let writeRange: ResolvedScope
  try {
    readRange = resolveScope(read, policy)
    writeRange = resolveScope(write, policy)
  } catch (error) {
    // Only a custom entry that cannot name an absolute path reaches here, and a
    // range that cannot be evaluated must never be read as a wider one.
    return { ok: false, problem: error instanceof Error ? error.message : String(error) }
  }

  const intersected = intersectResolved(writeRange, readRange)
  if (sameRange(writeRange, intersected)) {
    return { ok: true, axes: { read, write, narrowing: NO_NARROWING } }
  }
  return {
    ok: true,
    axes: { read, write: scopeOfResolved(intersected), narrowing: narrowingOf(writeRange, intersected) },
  }
}

/**
 * The narrower of two bases, in the containment order `deny` ⊂ `workspace` ⊂
 * `all`.
 *
 * This is the tier the write-never-exceeds-read invariant can express to the
 * layer BELOW the tool layer. That layer is a single closed sandbox mode
 * mirrored from the write axis onto the session's `sandbox/mode`, and it cannot
 * spell a path list; the narrower base is the largest tier both axes contain, so
 * mirroring it keeps the operating-system confinement inside the intersection
 * instead of leaving it at the write axis's own, wider base.
 *
 * An axis whose own entries cannot be evaluated — a `custom` spelling that
 * names no absolute path — ranks at `deny`. Resolution answers such a pair with
 * `ok: false` and the tool layer then refuses everything, so ranking it by its
 * declared base would let the mirror WIDEN exactly where the fence above it
 * closed: measured on `read = custom(all, allow ["relative/oops"])` beside
 * `write = workspace`, the pair resolves to nothing while the mirror produced
 * `workspace-write`. The failure path is the one place the operator needs the
 * two layers to agree, so it fails closed to the narrowest tier there is.
 * @param left - one axis.
 * @param right - the other.
 * @returns the narrower base.
 */
export function narrowerBase(left: AxisScope, right: AxisScope): 'deny' | 'workspace' | 'all' {
  const rank = (scope: AxisScope): number => {
    if (!isEvaluableAxis(scope)) return 0
    const base = scope.kind === 'custom' ? scope.base : scope.kind
    return ['deny', 'workspace', 'all'].indexOf(base)
  }
  return rank(left) <= rank(right) ? baseOf(left) : baseOf(right)
}

/**
 * One axis's own tier, as the mirror spells it. Only meaningful for an axis
 * {@link narrowerBase} ranked by its base; an unevaluable one is reported as
 * `deny`, which is also the tier that comparison gives it.
 * @param scope - the axis value.
 * @returns the base the axis declares, or `deny` when it cannot be evaluated.
 */
function baseOf(scope: AxisScope): 'deny' | 'workspace' | 'all' {
  if (!isEvaluableAxis(scope)) return 'deny'
  return scope.kind === 'custom' ? scope.base : scope.kind as 'deny' | 'workspace' | 'all'
}

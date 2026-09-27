/**
 * The tree's connector geometry, shared by every tree this panel draws.
 *
 * A tree drawn with box-drawing characters is a SCHEDULING problem before it is
 * a drawing problem. Each row needs two facts that a row cannot know about
 * itself:
 *
 * - for every ancestor level, whether that ancestor still has a later sibling —
 *   that level draws a continuing `│`, and the last sibling's level draws a blank;
 * - for its own level, whether IT has a later sibling — that decides `├─` (the line
 *   continues downward) against `└─` (the corner that closes the level).
 *
 * The first fact is derived by walking up: the nearest preceding row shallower
 * than the current one IS the enclosing ancestor, so the walk needs no parent
 * pointers and cannot disagree with the flattened order. The second fact is
 * handed in by the caller, which knows each node's siblings.
 *
 * Pure data in, pure data out: no React, no DOM, no clock.
 */

/** One visible row's identity and place in the flattened render order. */
export interface LayoutNode {
  /** Identity of the node, unique across the tree. */
  readonly id: string
  /** Nesting depth; the roots sit at 0. */
  readonly level: number
}

/** Per-level line geometry of one row. */
export interface RowConnectors {
  /**
   * One entry per ancestor level ABOVE this row's own level, indexed by that
   * ancestor's level: `'|'` while the ancestor still has a later sibling, `' '`
   * once it is the last of its level. The row's own level is not in here — that
   * is {@link branch}.
   */
  readonly trunk: readonly (0 | 1)[]
  /**
   * The row's own level's mark: 1 when it has a later sibling (the `├─` of a branch
   * that continues downward), 0 when it is the last of its level (the `└─` corner).
   * Ignored for a root, which has no branch above it.
   */
  readonly branch: 0 | 1
}

/** The three characters the connector column is built from. */
const ELBOW = '└'
const TEE = '├'
const PIPE = '│'

/** How wide one ancestor level occupies in the leader: one glyph plus two spaces. */
const LEVEL_STRIDE = 3

/**
 * The connector leader drawn before one row's glyph.
 * @param trunk - ancestor levels, outermost first; each true keeps its `│`.
 * @param branch - true when the row has a later sibling, false for the last of its level.
 * @param isRoot - true for a root row, which draws its ancestor levels only.
 * @returns the leader string, spaces included, ready to render in a monospace cell.
 */
export function rowLeader(trunk: readonly boolean[], branch: boolean, isRoot: boolean): string {
  const pipes = trunk.map(continues => (continues ? PIPE : ' ') + '  ').join('')
  if (isRoot) return pipes
  return pipes + (branch ? TEE : ELBOW) + '─ '
}

/** Per-ancestor continuation flags of every row, keyed by row id. */
export interface TrunkSchedule {
  /** Ancestor continuation flags of one row, outermost first; empty for a root. */
  readonly of: (id: string) => readonly boolean[]
}

/**
 * Resolve, for every row, which of its enclosing ancestors still has a later
 * sibling.
 * @param rows - the visible rows, in render order.
 * @returns a lookup keyed by row id.
 */
export function trunkSchedule(rows: readonly LayoutNode[]): TrunkSchedule {
  const levels = rows.map(row => row.level)
  const resolved = new Map<string, readonly boolean[]>()
  for (const [index, row] of rows.entries()) {
    const trunk: boolean[] = []
    let cursor = index
    let depth = row.level
    while (depth > 0) {
      let ancestor = cursor - 1
      while (ancestor >= 0 && (levels[ancestor] ?? 0) >= depth) ancestor--
      /* v8 ignore next -- the flattened order always places a shallower row above a deeper one */
      if (ancestor < 0) break
      depth = levels[ancestor] ?? 0
      trunk.push(continuesBeyond(rows, levels, ancestor))
      cursor = ancestor
    }
    resolved.set(row.id, trunk.reverse())
  }
  return { of: id => resolved.get(id) ?? [] }
}

/**
 * Whether the row at `index` has a later row at its own level before its parent's
 * level resumes — that is, whether its branch line keeps going down.
 */
function continuesBeyond(
  rows: readonly LayoutNode[],
  levels: readonly number[],
  index: number,
): boolean {
  const level = levels[index] ?? 0
  for (let next = index + 1; next < rows.length; next++) {
    const candidate = levels[next] ?? 0
    if (candidate === level) return true
    if (candidate < level) return false
  }
  return false
}

/** The leader's rendered width for one row, so a hanging second line can align under the title. */
export function leaderWidth(connectors: RowConnectors, isRoot: boolean): number {
  return connectors.trunk.length * LEVEL_STRIDE + (isRoot ? 0 : LEVEL_STRIDE)
}

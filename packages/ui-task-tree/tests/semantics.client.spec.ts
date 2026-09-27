import { describe, expect, it } from 'vitest'
import { lifeOf, deathReason, kindOf, subtitleOf, answerOf, type TreeNode } from '../src/client/semantics.ts'
import { buildOutline, defaultCollapsed, isNote, countsLabel, tallyTree, tallyRows } from '../src/client/list.ts'

const node = (p: Partial<TreeNode>): TreeNode => ({ id: 'n', title: 'n', status: 'pending', ...p })

/** 造一棵有分叉、死亡、问答与合流的树。 */
const tree = (): TreeNode[] => [node({
  id: 'root', title: '计划', status: 'completed',
  children: [
    node({ id: 'a', title: '路线A', status: 'completed' }),
    node({ id: 'b', title: '路线B', status: 'blocked', detail: '死因：走不通', children: [node({ id: 'b1', title: 'B的实现' })] }),
    node({ id: 'q', title: '用户问答', status: 'completed', detail: '答：用方案乙' }),
    node({ id: 'm', title: '合流', status: 'completed', detail: '归并：两条线汇合' }),
  ],
})]

describe('lifeOf', () => {
  it('calls a completed node done', () => {
    expect(lifeOf(node({ status: 'completed' }), false)).toBe('done')
  })
  it('calls a blocked node dead', () => {
    expect(lifeOf(node({ status: 'blocked' }), false)).toBe('dead')
  })
  it('calls a node with a death note dead even while pending', () => {
    expect(lifeOf(node({ detail: '死因：不划算' }), false)).toBe('dead')
  })
  it('calls a pending node orphan once an ancestor died', () => {
    expect(lifeOf(node({}), true)).toBe('orphan')
  })
})

describe('deathReason', () => {
  it('reads the note after the prefix', () => {
    expect(deathReason(node({ detail: '死因：证书校验失败' }))).toBe('证书校验失败')
  })
  it('falls back to plain detail', () => {
    expect(deathReason(node({ detail: '这条路没走通' }))).toBe('这条路没走通')
  })
  it('never returns empty', () => {
    expect(deathReason(node({}))).toBe('未记录原因')
  })
})

describe('kindOf / subtitleOf / answerOf', () => {
  it('reads a note kind from the prefix', () => {
    expect(kindOf(node({ detail: '注：补充' }), 'alive')).toBe('note')
    expect(kindOf(node({ detail: '答：可以' }), 'done')).toBe('note')
  })
  it('reads merge and result kinds', () => {
    expect(kindOf(node({ detail: '归并：汇合' }), 'done')).toBe('merge')
    expect(kindOf(node({ detail: '结：完成' }), 'done')).toBe('result')
  })
  it('treats a completed leaf as a result', () => {
    expect(kindOf(node({ status: 'completed' }), 'done')).toBe('result')
  })
  it('keeps plain detail as the subtitle', () => {
    expect(subtitleOf(node({ detail: '普通说明' }))).toBe('普通说明')
  })
  it('does not repeat the death reason or the answer as a subtitle', () => {
    expect(subtitleOf(node({ detail: '死因：挂了' }))).toBe('')
    expect(subtitleOf(node({ detail: '答：好' }))).toBe('')
  })
  it('exposes the answer only for an answered question', () => {
    expect(answerOf(node({ detail: '答：好' }))).toBe('好')
    expect(answerOf(node({ detail: '注：补充' }))).toBe('')
  })
})

describe('buildOutline', () => {
  /** id 到行的查表。 */
  const rowsById = (collapsed: ReadonlySet<string> = new Set()): Record<string, ReturnType<typeof buildOutline>[number]> => {
    const out: Record<string, ReturnType<typeof buildOutline>[number]> = {}
    for (const r of buildOutline(tree(), collapsed)) out[r.id] = r
    return out
  }
  it('walks depth first and keeps the declared order', () => {
    expect(buildOutline(tree(), new Set()).map((r) => r.id))
      .toEqual(['root', 'a', 'b', 'b1', 'q', 'm'])
  })
  it('reports each row own depth', () => {
    const d = Object.fromEntries(buildOutline(tree(), new Set()).map((r) => [r.id, r.depth]))
    expect(d).toEqual({ root: 0, a: 1, b: 1, b1: 2, q: 1, m: 1 })
  })
  it('links a row to its next sibling, and stops at the last one', () => {
    const rows = rowsById()
    expect(rows['a']!.link).toBe(true)
    expect(rows['b']!.link).toBe(true)
    expect(rows['q']!.link).toBe(true)
    expect(rows['m']!.link).toBe(false)
    expect(rows['b1']!.link).toBe(false)
  })
  it('carries the death reason for a dead row', () => {
    expect(rowsById()['b']!.reason).toBe('走不通')
  })
  it('does not invent a reason for a row orphaned by an ancestor', () => {
    const b1 = rowsById()['b1']!
    expect(b1.life).toBe('orphan')
    expect(b1.reason).toBeUndefined()
  })
  it('hides a collapsed subtree and keeps the parent row', () => {
    const ids = buildOutline(tree(), new Set(['b'])).map((r) => r.id)
    expect(ids).toEqual(['root', 'a', 'b', 'q', 'm'])
  })
  it('marks a collapsed row so the caret can point the right way', () => {
    const rows = rowsById(new Set(['root']))
    expect(rows['root']!.collapsed).toBe(true)
    expect(rows['root']!.hasChildren).toBe(true)
    expect(buildOutline(tree(), new Set(['root'])).length).toBe(1)
  })
  it('carries the answer and the owner onto the row', () => {
    const one: TreeNode[] = [node({ id: 'x', title: 'x', status: 'pending', assignedTo: 'impl', detail: '答：好' })]
    const r = buildOutline(one, new Set())[0]!
    expect(r.answer).toBe('好')
    expect(r.assignedTo).toBe('impl')
  })
})

describe('defaultCollapsed', () => {
  it('collapses a dead branch that has children', () => {
    expect(defaultCollapsed(tree()).has('b')).toBe(true)
  })
  it('leaves a live branch open', () => {
    expect(defaultCollapsed(tree()).has('root')).toBe(false)
  })
  it('collapses the internal stages of an agent from depth three on', () => {
    const deep: TreeNode[] = [node({ id: 'l0', title: 'l0', status: 'in_progress', children: [
      node({ id: 'l1', title: 'l1', status: 'in_progress', children: [
        node({ id: 'l2', title: 'l2', status: 'in_progress', children: [
          node({ id: 'l3', title: 'l3', status: 'in_progress', children: [node({ id: 'l4', title: 'l4' })] }),
        ] }),
      ] }),
    ] })]
    const c = defaultCollapsed(deep)
    expect(c.has('l0')).toBe(false)
    expect(c.has('l1')).toBe(false)
    expect(c.has('l2')).toBe(false)
    expect(c.has('l3')).toBe(true)
  })
  it('never collapses a leaf', () => {
    for (const id of defaultCollapsed(tree())) {
      expect(id).not.toBe('a')
    }
  })
})

describe('counts', () => {
  it('counts the whole tree by the four states', () => {
    expect(tallyTree(tree())).toEqual({ pending: 1, in_progress: 0, completed: 4, blocked: 1 })
  })
  it('counts rows the way the outline shows them', () => {
    expect(tallyRows(buildOutline(tree(), new Set()))).toEqual(tallyTree(tree()))
  })
  it('counts only what is not collapsed', () => {
    expect(tallyRows(buildOutline(tree(), new Set(['b']))).completed).toBe(4)
  })
  it('labels the counts by mark, hiding zeros', () => {
    expect(countsLabel({ pending: 0, in_progress: 1, completed: 3, blocked: 1 }))
      .toBe('\u2717 1   \u25cf 1   \u2713 3')
    expect(countsLabel({ pending: 0, in_progress: 0, completed: 0, blocked: 0 })).toBe('')
  })
  it('marks a user question so the view can draw the question mark', () => {
    const rows = buildOutline(tree(), new Set())
    expect(rows.filter(isNote).map((r) => r.id)).toEqual(['q'])
  })
})

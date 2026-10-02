import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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
    assert.strictEqual(lifeOf(node({ status: 'completed' }), false), 'done')
  })
  it('calls a blocked node dead', () => {
    assert.strictEqual(lifeOf(node({ status: 'blocked' }), false), 'dead')
  })
  it('calls a node with a death note dead even while pending', () => {
    assert.strictEqual(lifeOf(node({ detail: '死因：不划算' }), false), 'dead')
  })
  it('calls a pending node orphan once an ancestor died', () => {
    assert.strictEqual(lifeOf(node({}), true), 'orphan')
  })
})

describe('deathReason', () => {
  it('reads the note after the prefix', () => {
    assert.strictEqual(deathReason(node({ detail: '死因：证书校验失败' })), '证书校验失败')
  })
  it('falls back to plain detail', () => {
    assert.strictEqual(deathReason(node({ detail: '这条路没走通' })), '这条路没走通')
  })
  it('never returns empty', () => {
    assert.strictEqual(deathReason(node({})), '未记录原因')
  })
})

describe('kindOf / subtitleOf / answerOf', () => {
  it('reads a note kind from the prefix', () => {
    assert.strictEqual(kindOf(node({ detail: '注：补充' }), 'alive'), 'note')
    assert.strictEqual(kindOf(node({ detail: '答：可以' }), 'done'), 'note')
  })
  it('reads merge and result kinds', () => {
    assert.strictEqual(kindOf(node({ detail: '归并：汇合' }), 'done'), 'merge')
    assert.strictEqual(kindOf(node({ detail: '结：完成' }), 'done'), 'result')
  })
  it('treats a completed leaf as a result', () => {
    assert.strictEqual(kindOf(node({ status: 'completed' }), 'done'), 'result')
  })
  it('keeps plain detail as the subtitle', () => {
    assert.strictEqual(subtitleOf(node({ detail: '普通说明' })), '普通说明')
  })
  it('does not repeat the death reason or the answer as a subtitle', () => {
    assert.strictEqual(subtitleOf(node({ detail: '死因：挂了' })), '')
    assert.strictEqual(subtitleOf(node({ detail: '答：好' })), '')
  })
  it('exposes the answer only for an answered question', () => {
    assert.strictEqual(answerOf(node({ detail: '答：好' })), '好')
    assert.strictEqual(answerOf(node({ detail: '注：补充' })), '')
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
    assert.deepStrictEqual(buildOutline(tree(), new Set()).map((r) => r.id),
      ['root', 'a', 'b', 'b1', 'q', 'm'])
  })
  it('reports each row own depth', () => {
    const d = Object.fromEntries(buildOutline(tree(), new Set()).map((r) => [r.id, r.depth]))
    assert.deepStrictEqual(d, { root: 0, a: 1, b: 1, b1: 2, q: 1, m: 1 })
  })
  it('links a row to its next sibling, and stops at the last one', () => {
    const rows = rowsById()
    assert.strictEqual(rows['a']!.link, true)
    assert.strictEqual(rows['b']!.link, true)
    assert.strictEqual(rows['q']!.link, true)
    assert.strictEqual(rows['m']!.link, false)
    assert.strictEqual(rows['b1']!.link, false)
  })
  it('carries the death reason for a dead row', () => {
    assert.strictEqual(rowsById()['b']!.reason, '走不通')
  })
  it('never shows one text as both the death reason and the subtitle', () => {
    // 真机那一次的形状：detail 既不带「死因：」也不带「答：」，而 subtitleOf 与 deathReason
    // 都会把整条正文返回 —— 界面上于是同时画出「因为：X」与副标题「X」。
    const dead = buildOutline([node({ id: 'd', title: 'd', status: 'blocked', detail: '状态：未收到回报（被强停）' })], new Set())[0]!
    assert.strictEqual(dead.reason, '状态：未收到回报（被强停）')
    assert.strictEqual(dead.detail, undefined, '同一段文本不许再当一次副标题')
  })
  it('keeps the subtitle of a normal prefix on a live row', () => {
    const rows = buildOutline([
      node({ id: 'n1', title: 'n1', status: 'in_progress', detail: '注：补充' }),
      node({ id: 'n2', title: 'n2', status: 'completed', detail: '归并：汇合' }),
      node({ id: 'n3', title: 'n3', status: 'completed', detail: '结：完成' }),
    ], new Set())
    assert.strictEqual(rows[0]!.detail, '补充')
    assert.strictEqual(rows[1]!.detail, '汇合')
    assert.strictEqual(rows[2]!.detail, '完成')
    assert.strictEqual(rows[0]!.reason, undefined, '活着的一行没有死因这一栏')
  })
  it('keeps the death note and the answer out of the subtitle', () => {
    const dead = buildOutline([node({ id: 'd', title: 'd', status: 'blocked', detail: '死因：走不通' })], new Set())[0]!
    assert.strictEqual(dead.reason, '走不通')
    assert.strictEqual(dead.detail, undefined)
    const asked = buildOutline([node({ id: 'q', title: 'q', status: 'completed', detail: '答：用方案乙' })], new Set())[0]!
    assert.strictEqual(asked.answer, '用方案乙')
    assert.strictEqual(asked.detail, undefined)
  })
  it('does not invent a reason for a row orphaned by an ancestor', () => {
    const b1 = rowsById()['b1']!
    assert.strictEqual(b1.life, 'orphan')
    assert.strictEqual(b1.reason, undefined)
  })
  it('hides a collapsed subtree and keeps the parent row', () => {
    const ids = buildOutline(tree(), new Set(['b'])).map((r) => r.id)
    assert.deepStrictEqual(ids, ['root', 'a', 'b', 'q', 'm'])
  })
  it('marks a collapsed row so the caret can point the right way', () => {
    const rows = rowsById(new Set(['root']))
    assert.strictEqual(rows['root']!.collapsed, true)
    assert.strictEqual(rows['root']!.hasChildren, true)
    assert.strictEqual(buildOutline(tree(), new Set(['root'])).length, 1)
  })
  it('carries the answer and the owner onto the row', () => {
    const one: TreeNode[] = [node({ id: 'x', title: 'x', status: 'pending', assignedTo: 'impl', detail: '答：好' })]
    const r = buildOutline(one, new Set())[0]!
    assert.strictEqual(r.answer, '好')
    assert.strictEqual(r.assignedTo, 'impl')
  })
})

describe('defaultCollapsed', () => {
  it('collapses a dead branch that has children', () => {
    assert.strictEqual(defaultCollapsed(tree()).has('b'), true)
  })
  it('leaves an unfinished branch open', () => {
    const open: TreeNode[] = [node({ id: 'p', title: 'p', status: 'in_progress', children: [node({ id: 'c', title: 'c' })] })]
    assert.strictEqual(defaultCollapsed(open).has('p'), false)
  })
  it('collapses a finished branch that still has children', () => {
    assert.strictEqual(defaultCollapsed(tree()).has('root'), true)
  })
  it('keeps the finished row itself and folds only what hangs under it', () => {
    const rows = buildOutline(tree(), defaultCollapsed(tree()))
    assert.deepStrictEqual(rows.map((r) => r.id), ['root'])
    assert.strictEqual(rows[0]!.collapsed, true)
    assert.strictEqual(rows[0]!.hasChildren, true)
  })
  it('folds a finished branch at any depth, and leaves its unfinished parent alone', () => {
    const deep: TreeNode[] = [node({ id: 'p', title: 'p', status: 'in_progress', children: [
      node({ id: 'c', title: 'c', status: 'completed', children: [node({ id: 'g', title: 'g', status: 'pending' })] }),
    ] })]
    const c = defaultCollapsed(deep)
    assert.strictEqual(c.has('p'), false)
    assert.strictEqual(c.has('c'), true)
    assert.deepStrictEqual(buildOutline(deep, c).map((r) => r.id), ['p', 'c'])
  })
  it('never folds a finished leaf: there is nothing under it', () => {
    const c = defaultCollapsed(tree())
    assert.strictEqual(c.has('q'), false)
    assert.strictEqual(c.has('m'), false)
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
    assert.strictEqual(c.has('l0'), false)
    assert.strictEqual(c.has('l1'), false)
    assert.strictEqual(c.has('l2'), false)
    assert.strictEqual(c.has('l3'), true)
  })
  it('never collapses a leaf', () => {
    for (const id of defaultCollapsed(tree())) {
      assert.notStrictEqual(id, 'a')
    }
  })
})

describe('counts', () => {
  it('counts the whole tree by the four states', () => {
    assert.deepStrictEqual(tallyTree(tree()), { pending: 1, in_progress: 0, completed: 4, blocked: 1 })
  })
  it('counts rows the way the outline shows them', () => {
    assert.deepStrictEqual(tallyRows(buildOutline(tree(), new Set())), tallyTree(tree()))
  })
  it('counts only what is not collapsed', () => {
    assert.strictEqual(tallyRows(buildOutline(tree(), new Set(['b']))).completed, 4)
  })
  it('labels the counts by mark, hiding zeros', () => {
    assert.strictEqual(countsLabel({ pending: 0, in_progress: 1, completed: 3, blocked: 1 }),
      '\u2717 1   \u25cf 1   \u2713 3')
    assert.strictEqual(countsLabel({ pending: 0, in_progress: 0, completed: 0, blocked: 0 }), '')
  })
  it('marks a user question so the view can draw the question mark', () => {
    const rows = buildOutline(tree(), new Set())
    assert.deepStrictEqual(rows.filter(isNote).map((r) => r.id), ['q'])
  })
})

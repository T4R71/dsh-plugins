/**
 * team-tree 的单测。
 *
 * 这里全部是**纯函数**测试：`projectClaims` / `readTeamTree` 不碰 ctx，也不碰文档，
 * 所以它们能被直接钉死。挂载路径（ctx.set）由真机验证覆盖，不在单测里造假的 ctx
 * ——那只会测到我自己的 mock。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { projectClaims, readTeamTree } from '../src/index.ts'
import type { MemberRow } from '../src/index.ts'

/** 一行 teammate。 */
const member = (over: Partial<MemberRow> & { name: string }): MemberRow => ({
  id: over.id ?? 'agent-' + over.name,
  name: over.name,
  role: over.role ?? 'teammate',
  status: over.status ?? 'running',
  ...(over.description === undefined ? {} : { description: over.description }),
})

describe('team-tree: 认领投影', () => {
  it('把 assignedTo 对应到 roster 行，按树的遍历顺序', () => {
    const tree = [
      { id: 'n1', title: '自己干的活' },
      { id: 'n2', title: '派给 alice', assignedTo: 'agent-alice', children: [
        { id: 'n2a', title: 'alice 的阶段' },
      ] },
      { id: 'n3', title: '派给 bob', assignedTo: 'agent-bob' },
    ]
    const members = [member({ name: 'alice' }), member({ name: 'bob', status: 'inactive' })]
    const claims = projectClaims(tree, members)
    assert.deepStrictEqual(claims.map(c => c.nodeId), ['n2', 'n3'])
    assert.strictEqual(claims[0].member.name, 'alice')
    assert.strictEqual(claims[1].member.status, 'inactive')
  })

  it('没派过活的节点不产生认领——它由主代理自己推进', () => {
    const tree = [{ id: 'solo', title: '独占的一条线' }]
    assert.deepStrictEqual(projectClaims(tree, [member({ name: 'alice' })]), [])
  })

  it('嵌套深处的派发也被收集到，不是只看顶层', () => {
    const tree = [
      { id: 'a', title: 'A', assignedTo: 'agent-alice', children: [
        { id: 'b', title: 'B', assignedTo: 'agent-bob' },
      ] },
    ]
    const members = [member({ name: 'alice' }), member({ name: 'bob' })]
    assert.deepStrictEqual(projectClaims(tree, members).map(c => c.nodeId), ['a', 'b'])
  })

  it('roster 里已经没有的 teammate 不产生认领，也不抛错', () => {
    // 一个被回收的 teammate 不该让整棵树炸掉——树比 roster 活得久。
    const tree = [{ id: 'gone', title: '派给一个已经不在的', assignedTo: 'agent-ghost' }]
    assert.deepStrictEqual(projectClaims(tree, [member({ name: 'alice' })]), [])
  })

  it('assignedTo 是空串时不算认领', () => {
    const tree = [{ id: 'blank', title: '空', assignedTo: '' }]
    assert.deepStrictEqual(projectClaims(tree, [member({ name: 'alice' })]), [])
  })
})

describe('team-tree: 状态投影的语义', () => {
  it('inactive 绝不被说成 completed——那是两个不同的事实', () => {
    // DSH 自己的措辞：inactive 只说明没有 turn 在跑，不说明做完了。
    // 本包只投影运行时状态，工作状态仍归显式的 task step。
    const members = [member({ name: 'alice', status: 'inactive' })]
    const view = readTeamTree(
      { read: () => [{ id: 'n', title: 'T', assignedTo: 'agent-alice' }] },
      { listMembers: () => members },
      {},
      'sess',
    )
    assert.strictEqual(view.byName['alice'], 'inactive')
    assert.notStrictEqual(view.byName['alice'], 'completed')
    // 树上那个节点的字段里根本没有 completed —— 本包不写工作状态
    assert.ok(!('completed' in view.claims[0].member))
  })

  it('四个运行时状态原样透传，不合并成一个布尔', () => {
    const members = [
      member({ name: 'a', status: 'running' }),
      member({ name: 'b', status: 'inactive' }),
      member({ name: 'c', status: 'provisioning' }),
      member({ name: 'd', status: 'failed' }),
    ]
    const view = readTeamTree(
      { read: () => [] },
      { listMembers: () => members },
      {},
      'sess',
    )
    assert.deepStrictEqual(view.byName, {
      a: 'running', b: 'inactive', c: 'provisioning', d: 'failed',
    })
  })

  it('lead 也在 byName 里——它同样在跑，渲染层需要查得到', () => {
    const members = [member({ name: 'lead', role: 'lead', status: 'running' })]
    const view = readTeamTree({ read: () => [] }, { listMembers: () => members }, {}, 'sess')
    assert.strictEqual(view.byName['lead'], 'running')
  })

  it('空 roster + 空树 = 空视图，不是错误', () => {
    const view = readTeamTree({ read: () => [] }, { listMembers: () => [] }, {}, 'sess')
    assert.deepStrictEqual(view.claims, [])
    assert.deepStrictEqual(view.byName, {})
  })
})

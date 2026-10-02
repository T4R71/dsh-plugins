/**
 * 任务树在配置文档里那一层的取值测试。
 *
 * 钉住四件事：文档里**别的**命名空间不会被当成本包的树；只有按会话 id 分区的那一条记录
 * 才算数；读不懂的取值**不抛出去**（把面板带崩），而是各自落到「没有记录」或「读不到
 * 文档」；以及三态本身 —— 没有记录与读不到文档必须能分辨，旧实现把两者都变成 return null。
 *
 * 这条通道的另一半（宿主怎么写这份文档、怎么写不进去就重试）在
 * \`packages/plan-tree/tests/plan-tree.spec.ts\` 里钉。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  PLAN_TREE_FIELD, PLAN_TREE_NAMESPACE,
  planTreeOf, planTreesOf, planTreesSectionOf, planTreeView,
} from '../src/client/plan-tree-data.ts'

/** 一行命名空间视图，只带读取面真的会用到的两个成员。 */
const row = (ns: string, value: unknown) => ({ ns, value })

/** 一棵最小的树，两个节点一条边。 */
const TREE = [
  { id: 'root', title: '计划', status: 'in_progress', children: [{ id: 'a', title: 'A', status: 'pending' }] },
]

/** 一份文档：只有本包的命名空间。 */
const doc = (trees: unknown) => [row(PLAN_TREE_NAMESPACE, { [PLAN_TREE_FIELD]: trees })]

test('the namespace and field names are the ones the host writes', () => {
  assert.equal(PLAN_TREE_NAMESPACE, 'plan-tree-sessions')
  assert.equal(PLAN_TREE_FIELD, 'trees')
})

test('the section is found by namespace, and only there', () => {
  // 别人命名空间里恰好也有一个 trees 字段：不算数。
  assert.deepEqual(
    planTreesOf([row('something-else', { [PLAN_TREE_FIELD]: { s1: TREE } })], PLAN_TREE_NAMESPACE, PLAN_TREE_FIELD),
    { kind: 'unreadable' },
  )
  assert.deepEqual(
    planTreesOf(doc({ s1: TREE }), PLAN_TREE_NAMESPACE, PLAN_TREE_FIELD),
    { kind: 'parsed', records: { s1: TREE } },
  )
})

test('a namespaces row that is missing or unreadable is unreadable, not empty', () => {
  // 镜像还没有答案、命名空间没被组合进来、行本身不是对象：三种都推不出「没有计划」。
  assert.deepEqual(planTreesOf(undefined, PLAN_TREE_NAMESPACE, PLAN_TREE_FIELD), { kind: 'unreadable' })
  assert.deepEqual(planTreesOf([], PLAN_TREE_NAMESPACE, PLAN_TREE_FIELD), { kind: 'unreadable' })
  assert.deepEqual(planTreesOf([row(PLAN_TREE_NAMESPACE, null)], PLAN_TREE_NAMESPACE, PLAN_TREE_FIELD), { kind: 'unreadable' })
  assert.deepEqual(planTreesOf([row(PLAN_TREE_NAMESPACE, 'nope')], PLAN_TREE_NAMESPACE, PLAN_TREE_FIELD), { kind: 'unreadable' })
})

test('an empty field is EMPTY: the document really says no session declared a plan', () => {
  assert.deepEqual(planTreesOf(doc({}), PLAN_TREE_NAMESPACE, PLAN_TREE_FIELD), { kind: 'parsed', records: {} })
})

test('a field that is not an object at all is unreadable', () => {
  assert.deepEqual(planTreesSectionOf(undefined), { kind: 'unreadable' })
  assert.deepEqual(planTreesSectionOf(null), { kind: 'unreadable' })
  assert.deepEqual(planTreesSectionOf([TREE]), { kind: 'unreadable' })
  assert.deepEqual(planTreesSectionOf('nope'), { kind: 'unreadable' })
})

test('a session reads its own tree and nobody else\'s', () => {
  const section = planTreesSectionOf({ s1: TREE, s2: [{ id: 'b', title: 'B', status: 'completed' }] })
  assert.deepEqual(planTreeOf(section, 's1'), TREE)
  assert.deepEqual(planTreeOf(section, 's2'), [{ id: 'b', title: 'B', status: 'completed' }])
  assert.equal(planTreeOf(section, 's3'), undefined)
})

test('an unreadable record is dropped, and the others survive', () => {
  const section = planTreesSectionOf({
    good: TREE,
    wrongStatus: [{ id: 'x', title: 'X', status: 'done' }],
    noTitle: [{ id: 'x', status: 'pending' }],
    blankId: [{ id: '', title: 'X', status: 'pending' }],
    notArray: 'nope',
    nested: [{ id: 'x', title: 'X', status: 'pending', children: [{ id: 'y', title: 'Y', status: 'nope' }] }],
  })
  assert.deepEqual(section, { kind: 'parsed', records: { good: TREE } })
})

test('optional members survive the read, and none is invented', () => {
  const section = planTreesSectionOf({
    s1: [{
      id: 'a', title: 'A', status: 'completed',
      detail: '答：好', task: 'do it', assignedTo: 'worker-a', dependsOn: ['b'],
    }],
    s2: [{ id: 'b', title: 'B', status: 'pending', dependsOn: ['a', 7] }],
  })
  assert.deepEqual(planTreeOf(section, 's1'), [{
    id: 'a', title: 'A', status: 'completed',
    detail: '答：好', task: 'do it', assignedTo: 'worker-a', dependsOn: ['b'],
  }])
  // dependsOn 里混进非字符串：整条 dependsOn 不成立，节点其余部分照旧。
  assert.deepEqual(planTreeOf(section, 's2'), [{ id: 'b', title: 'B', status: 'pending' }])
})

test('an empty children array reads as a leaf, so the tree has one spelling for it', () => {
  const section = planTreesSectionOf({ s1: [{ id: 'a', title: 'A', status: 'pending', children: [] }] })
  assert.deepEqual(planTreeOf(section, 's1'), [{ id: 'a', title: 'A', status: 'pending' }])
})

/* ------------------------------ 面板看到的三态 ------------------------------ */

test('a readable document with a record for this session is the record state', () => {
  assert.deepEqual(planTreeView(doc({ s1: TREE }), 's1'), { state: 'record', roots: TREE })
})

test('a readable document with no record for this session is the EMPTY state', () => {
  // 有文档、有命名空间、这条会话没有记录：宿主那边也确实没有树，显示空态是实话。
  assert.deepEqual(planTreeView(doc({}), 's1'), { state: 'empty' })
  assert.deepEqual(planTreeView(doc({ other: TREE }), 's1'), { state: 'empty' })
  // 记录存在但读不动，同样是「没有可显示的东西」而不是「无从得知」。
  assert.deepEqual(planTreeView(doc({ s1: [{ id: 'a', title: 'A', status: 'nope' }] }), 's1'), { state: 'empty' })
})

test('nothing to read at all is its own state, not a claim about the plan', () => {
  // 命名空间缺席、字段读不动、镜像还没有答案：三种都不能声称「这条会话没有计划」。
  // 旧实现在这几种情况下直接 return null，与「还没有计划」显示成同一个空白。
  assert.deepEqual(planTreeView(undefined, 's1'), { state: 'unreadable' })
  assert.deepEqual(planTreeView([], 's1'), { state: 'unreadable' })
  assert.deepEqual(planTreeView([row(PLAN_TREE_NAMESPACE, { [PLAN_TREE_FIELD]: 'nope' })], 's1'), { state: 'unreadable' })
})

test('no session selected reads as empty, and never throws', () => {
  assert.deepEqual(planTreeView(doc({ s1: TREE }), undefined), { state: 'empty' })
})

test('the record state is reached with no cast: the roots ARE the stored nodes', () => {
  const view = planTreeView(doc({ s1: TREE }), 's1')
  assert.equal(view.state, 'record')
  if (view.state !== 'record') throw new Error('expected the record state')
  assert.equal(view.roots.length, 1)
  assert.equal(view.roots[0]?.children?.[0]?.id, 'a')
})
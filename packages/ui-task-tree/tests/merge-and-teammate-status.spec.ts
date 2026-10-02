/**
 * 两件新活的钉子：读取侧合并、以及行尾的队友状态。
 *
 * 都打在**纯函数**上，不碰 React、不碰 store：
 *   合并  —— `mergedTreeOf`（`src/client/plan-tree-data.ts`），语义照抄宿主 `readMerged`；
 *   状态  —— `ownerStatusOf` / `ownerBadgesOf`（`src/client/teammate-status.ts`），
 *            状态公式逐字照抄宿主那行 `TeamMemberRow`。
 *
 * 三个边界（子会话没有树 / 嵌套不铺平 / 深度用尽）与四个状态词（含 inactive ≠ completed）
 * 各有一个用例，谁把语义改回去都会在这里响。
 *
 * 第三组钉的是**兜底**（`ownerBadgesWithFallback`）：直连子代理不写名册，
 * 投影里查不到它那一行时行尾改成 `(节点 id · running|inactive)`；roster 认得的那条路
 * 逐字不变，投影整个缺席时照旧显示 `@childId`（不编状态）。
 *
 * 还有一条**改名**的钉子：拼进来的子树按来源会话 id 整棵改名，于是合并结果里 id 全局唯一。
 * 真实现场是父子两边各有一条 `ask-1`，撞成同一个 React key —— 面板上同一行被画了好几遍。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  mergedTreeOf, planTreesSectionOf,
  type PlanNode,
} from '../src/client/plan-tree-data.ts'
import {
  ownerBadgesOf, ownerBadgesWithFallback, ownerStatusOf,
  type TeamMemberLike, type TreeNodeLike,
} from '../src/client/teammate-status.ts'
import { buildOutline, type OwnerIndex } from '../src/client/list.ts'

/** 一棵树写短一点：只给 id，标题与状态随便。 */
const node = (id: string, extra: Partial<PlanNode> = {}): PlanNode =>
  ({ id, title: id, status: 'pending', ...extra })

/* ------------------------------ 读取侧合并 ------------------------------ */

test('a dispatched child session\'s own tree is grafted under the node that names it', () => {
  const section = planTreesSectionOf({
    lead: [node('fold-work', { assignedTo: 'sub-1' })],
    'sub-1': [node('read', { status: 'in_progress' })],
  })
  // 拼进来的节点带来源会话前缀；assignedTo 是**会话 id**，原样不动。
  assert.deepEqual(mergedTreeOf(section, 'lead', 2), [{
    id: 'fold-work', title: 'fold-work', status: 'pending',
    assignedTo: 'sub-1',
    children: [{ id: 'sub-1:read', title: 'read', status: 'in_progress' }],
  }])
})

test('a child session with NO tree of its own leaves the node exactly as it was', () => {
  const section = planTreesSectionOf({
    lead: [node('fold-work', { assignedTo: 'never-wrote-one' })],
  })
  // 「子代理没留下树」不是错误：读不到就是没有，节点原样留着，也不抛。
  assert.deepEqual(mergedTreeOf(section, 'lead', 2), [node('fold-work', { assignedTo: 'never-wrote-one' })])
})

test('an empty or missing assignedTo is left alone too', () => {
  const section = planTreesSectionOf({ lead: [node('a', { assignedTo: '' }), node('b')] })
  assert.deepEqual(mergedTreeOf(section, 'lead', 2), [node('a', { assignedTo: '' }), node('b')])
})

test('a nested subtree is NOT flattened: the child\'s own nesting comes over as-is', () => {
  const section = planTreesSectionOf({
    lead: [node('outer', { assignedTo: 'sub-1' })],
    // 子会话自己的树里已经有嵌套（c1 带着 c2）。拼过来必须原样保留，
    // 铺平会把 c2 提到与 c1 平级 —— 第一版 readMerged 就是这么错的。
    'sub-1': [node('c1', { children: [node('c2')] })],
  })
  // 改名跟着子树一起下去：c2 是子会话树里**自己的**嵌套，同样带 sub-1 前缀。
  assert.deepEqual(mergedTreeOf(section, 'lead', 2), [{
    id: 'outer', title: 'outer', status: 'pending', assignedTo: 'sub-1',
    children: [{
      id: 'sub-1:c1', title: 'c1', status: 'pending',
      children: [{ id: 'sub-1:c2', title: 'c2', status: 'pending' }],
    }],
  }])
})

test('an exhausted depth stops grafting and leaves the node as it was', () => {
  const section = planTreesSectionOf({
    lead: [node('outer', { assignedTo: 'sub-1' })],
    'sub-1': [node('c1')],
  })
  // depth 0：一层都不拼。
  assert.deepEqual(mergedTreeOf(section, 'lead', 0), [node('outer', { assignedTo: 'sub-1' })])
})

test('depth reaches one more level on a node that was already nested', () => {
  const section = planTreesSectionOf({
    lead: [node('outer', { assignedTo: 'sub-1' })],
    'sub-1': [node('c1', { assignedTo: 'sub-2' })],
    'sub-2': [node('c2')],
  })
  // depth 2：outer 拼进 sub-1，c1 再拼进 sub-2 —— 正好三层（主代理 → 子代理 → 孙代理）。
  // 孙会话那棵树用**孙会话自己的 id** 做前缀，不层层套娃（不是 'sub-1:sub-2:c2'）。
  assert.deepEqual(mergedTreeOf(section, 'lead', 2), [{
    id: 'outer', title: 'outer', status: 'pending', assignedTo: 'sub-1',
    children: [{
      id: 'sub-1:c1', title: 'c1', status: 'pending', assignedTo: 'sub-2',
      children: [{ id: 'sub-2:c2', title: 'c2', status: 'pending' }],
    }],
  }])
  // depth 1：只拼一层，c1 停在原地（它自己已经是拼进来的，id 仍带 sub-1 前缀）。
  assert.deepEqual(mergedTreeOf(section, 'lead', 1), [{
    id: 'outer', title: 'outer', status: 'pending', assignedTo: 'sub-1',
    children: [{ id: 'sub-1:c1', title: 'c1', status: 'pending', assignedTo: 'sub-2' }],
  }])
})

test('a grafted node\'s dependsOn is namespaced with the same prefix, and the lead\'s is not', () => {
  const section = planTreesSectionOf({
    lead: [node('outer', { assignedTo: 'sub-1', dependsOn: ['sibling'] })],
    // 子会话树里 b 依赖同树的兄弟 a；a 自己又派发了 sub-2。
    'sub-1': [node('b', { dependsOn: ['a'] }), node('a', { assignedTo: 'sub-2' })],
    'sub-2': [node('c')],
  })
  assert.deepEqual(mergedTreeOf(section, 'lead', 2), [{
    id: 'outer', title: 'outer', status: 'pending', assignedTo: 'sub-1', dependsOn: ['sibling'],
    children: [
      { id: 'sub-1:b', title: 'b', status: 'pending', dependsOn: ['sub-1:a'] },
      {
        id: 'sub-1:a', title: 'a', status: 'pending', assignedTo: 'sub-2',
        children: [{ id: 'sub-2:c', title: 'c', status: 'pending' }],
      },
    ],
  }])
})

test('REGRESSION: two sessions that both wrote an \'ask-1\' merge into globally unique ids', () => {
  // 真实现场：父会话自己有一条 `ask-1`（carryDecisions 搬上来的），被派发的子会话
  // 也自己写了一条 `ask-1`。两条都是设计要的，**一条都不许删** —— 撞车的是 id 本身：
  // `TaskListView` 用 `key={row.id}`，键一重复 React 协调就错乱，多出来的行留在页面上。
  const child = 'd83b7f75-4a5f-4a0e-9d1b-4d4c0f2a77e1'
  const section = planTreesSectionOf({
    lead: [
      node('live', { status: 'completed', assignedTo: child }),
      node('ask-1', { status: 'completed', title: '验证探针提问', detail: '答：好' }),
    ],
    [child]: [
      node('ask-1', { status: 'completed', title: '[子代理 recon-live] 验证探针提问', detail: '答：好' }),
    ],
  })
  const merged = mergedTreeOf(section, 'lead', 2)
  assert.ok(merged !== undefined)

  // 把合并结果摊平，收集所有 id —— 就是 TaskListView 拿来当 key 的那串值。
  const ids: string[] = []
  const visit = (nodes: readonly PlanNode[]): void => {
    for (const n of nodes) {
      ids.push(n.id)
      visit(n.children ?? [])
    }
  }
  visit(merged)

  // 1) 全局唯一。这一条红，就是面板上「同一行被画好几遍」回来。
  assert.equal(new Set(ids).size, ids.length)
  // 2) 三条都在：改名不是删一条，是给拼进来的那条换命名空间。
  assert.deepEqual([...ids].sort(), ['ask-1', `${child}:ask-1`, 'live'].sort())
  // 3) 拼进来的那条带上来源会话前缀；父会话自己那条**逐字未改**。
  assert.equal(merged[0]?.id, 'live')
  assert.equal(merged[0]?.children?.[0]?.id, `${child}:ask-1`)
  assert.equal(merged[1]?.id, 'ask-1')
  // 4) 除了 id 换了命名空间，节点内容一个字节没动（问号图标看的是 detail 前缀，不是 id）。
  assert.equal(merged[0]?.children?.[0]?.title, '[子代理 recon-live] 验证探针提问')
  assert.equal(merged[0]?.children?.[0]?.detail, '答：好')
})

test('a session with no record reads as undefined, and an unreadable document never throws', () => {
  assert.equal(mergedTreeOf(planTreesSectionOf({ other: [node('x')] }), 'lead', 2), undefined)
  assert.equal(mergedTreeOf({ kind: 'unreadable' }, 'lead', 2), undefined)
})

test('merging does NOT mutate the tree it was given', () => {
  const lead = [node('outer', { assignedTo: 'sub-1', children: [node('own')] })]
  const section = planTreesSectionOf({ lead, 'sub-1': [node('c1')] })
  const before = JSON.stringify(section)
  const merged = mergedTreeOf(section, 'lead', 2)
  // 入参一个字节都没变 —— 合并是只读投影，绝不回写。
  assert.equal(JSON.stringify(section), before)
  // 而且拿到的是一份**自有**的值：改它不会碰到文档那一份。
  assert.notEqual(merged, section.kind === 'parsed' ? section.records['lead'] : undefined)
  const first = merged?.[0]
  assert.equal(first?.children?.length, 2)
  assert.deepEqual(first?.children?.map(kid => kid.id), ['own', 'sub-1:c1'])
  assert.equal(lead[0]?.children?.length, 1)
})

/* ------------------------------ 行尾队友状态 ------------------------------ */

/** 一行 roster。 */
const member = (over: Partial<TeamMemberLike> = {}): TeamMemberLike =>
  ({ id: 'sub-1', name: 'recon-1', role: 'teammate', phase: 'active', ...over })

test('the four status words map one-to-one, and inactive is NOT completed', () => {
  // active + 当刻在跑 → running
  assert.equal(ownerStatusOf(member(), true, undefined), 'running')
  // active + 不在跑 → inactive。这一条是重点：**inactive 不是 completed**。
  assert.equal(ownerStatusOf(member(), false, undefined), 'inactive')
  assert.notEqual(ownerStatusOf(member(), false, undefined), 'completed')
  // 没基线时退回会话列表那一行的 running（宿主写的是 `running ?? summaryRunning`）。
  assert.equal(ownerStatusOf(member(), undefined, true), 'running')
  assert.equal(ownerStatusOf(member(), undefined, false), 'inactive')
  // 两边都没有 → inactive，不是 completed，也不是 running。
  assert.equal(ownerStatusOf(member(), undefined, undefined), 'inactive')
  // phase 不是 active 时，逐字用 phase。
  assert.equal(ownerStatusOf(member({ phase: 'provisioning' }), true, true), 'provisioning')
  assert.equal(ownerStatusOf(member({ phase: 'failed' }), true, true), 'failed')
})

test('the index is keyed by member id, and the lead is in it like anyone else', () => {
  const badges = ownerBadgesOf({
    members: [
      { id: 'root', name: 'lead', role: 'lead', phase: 'active' },
      member(),
    ],
  }, { root: true, 'sub-1': false }, {})
  assert.deepEqual(badges, {
    root: { name: 'lead', status: 'running' },
    'sub-1': { name: 'recon-1', status: 'inactive' },
  })
  // lead 也在字典里：它同样是一个「正在跑的东西」。
  assert.equal(badges['root']?.name, 'lead')
})

test('a member id that is not in the roster simply has no badge, and no badge is invented', () => {
  const badges = ownerBadgesOf({ members: [member()] }, {}, {})
  assert.equal(badges['nobody'], undefined)
  assert.equal(Object.keys(badges).length, 1)
})

test('an absent roster, or a roster of junk, yields an EMPTY index rather than a made-up status', () => {
  assert.deepEqual(ownerBadgesOf(undefined, {}, {}), {})
  assert.deepEqual(ownerBadgesOf({ members: [null, 'nope', { id: 'x' }] } as never, {}, {}), {})
})

/* ---------------- 直连子代理：名册里没有这一行时的兜底 ---------------- */

/** 树上一行（只给兜底要用的三个字段）。 */
const row = (id: string, extra: Partial<TreeNodeLike> = {}): TreeNodeLike => ({ id, ...extra })

test('a direct child that no roster row names shows the NODE id with the session status', () => {
  // 直连通道（ctx.subagents.startContinuable）不写名册：投影在，但查不到这一行。
  const badges = ownerBadgesWithFallback(
    { members: [member()] },
    [row('v-b', { assignedTo: 'direct-1' })],
    { 'direct-1': true },
    {},
  )
  // 名字取**节点 id**（不是子会话 id），状态取会话状态表。
  assert.deepEqual(badges['direct-1'], { name: 'v-b', status: 'running' })
  // 名册认得的那一行照旧：名字来自投影，状态来自会话状态表。
  assert.deepEqual(badges['sub-1'], { name: 'recon-1', status: 'inactive' })
})

test('with neither table carrying the child the fallback is inactive — not completed, and never a roster phase', () => {
  const badges = ownerBadgesWithFallback({ members: [member()] }, [row('v-b', { assignedTo: 'direct-1' })], {}, {})
  assert.equal(badges['direct-1']?.status, 'inactive')
  assert.notEqual(badges['direct-1']?.status, 'completed')
  // provisioning / failed 是**名册**才有的 phase：这条路编不出来。
  assert.notEqual(badges['direct-1']?.status, 'provisioning')
  assert.notEqual(badges['direct-1']?.status, 'failed')
})

test('the fallback reads the two tables exactly like ownerStatusOf does', () => {
  const status = (running: boolean | undefined, summaryRunning: boolean | undefined): string | undefined =>
    ownerBadgesWithFallback(
      { members: [] },
      [row('n', { assignedTo: 'c' })],
      running === undefined ? {} : { c: running },
      summaryRunning === undefined ? {} : { c: summaryRunning },
    )['c']?.status
  // 同一条公式，逐组对齐（合成员 phase 恒为 active）。
  const live: TeamMemberLike = { id: 'c', name: 'n', role: 'teammate', phase: 'active' }
  for (const [running, summary] of [
    [true, undefined], [undefined, true], [false, undefined],
    [true, false], [undefined, false], [undefined, undefined],
  ] as const) {
    assert.equal(status(running, summary), ownerStatusOf(live, running, summary))
  }
  assert.equal(status(true, undefined), 'running')
  assert.equal(status(undefined, true), 'running')
  assert.equal(status(undefined, undefined), 'inactive')
  // 会话状态表的基线优先：它是 false 时，不去看会话列表那一行。
  assert.equal(status(false, true), 'inactive')
})

test('a nested node counts too — a grandchild the child session itself dispatched gets its own fallback', () => {
  const badges = ownerBadgesWithFallback(
    { members: [] },
    [row('outer', { assignedTo: 'direct-1', children: [row('direct-1:c1', { assignedTo: 'direct-2' })] })],
    { 'direct-1': true, 'direct-2': false },
    {},
  )
  assert.deepEqual(badges['direct-1'], { name: 'outer', status: 'running' })
  assert.deepEqual(badges['direct-2'], { name: 'direct-1:c1', status: 'inactive' })
})

test('REGRESSION: a node whose assignedTo IS in the roster keeps the roster badge, byte for byte', () => {
  const roster = {
    members: [{ id: 'root', name: 'lead', role: 'lead', phase: 'active' }, member()] as TeamMemberLike[],
  }
  const runningById = { root: true, 'sub-1': false }
  const before = ownerBadgesOf(roster, runningById, {})
  const after = ownerBadgesWithFallback(roster, [row('any-node', { assignedTo: 'sub-1' })], runningById, {})
  // 树上有这个节点，但名册认得它 —— 名字仍是 recon-1，不是节点 id。
  assert.deepEqual(after, before)
})

test('an ABSENT projection invents nothing: those rows keep falling back to @childId', () => {
  const tree = [row('v-b', { assignedTo: 'direct-1' })]
  // 「这份 profile 没装 Agent Teams」与「名册里没这个人」是两件事：缺席时一条都不补。
  assert.deepEqual(ownerBadgesWithFallback(undefined, tree, { 'direct-1': true }, {}), {})
  // 投影形状烂掉（members 不是数组）同样算缺席。
  assert.deepEqual(ownerBadgesWithFallback({ members: null } as never, tree, { 'direct-1': true }, {}), {})
})

test('a PRESENT roster that parsed to zero rows still falls back — the row is looked up and not found', () => {
  const tree = [row('v-b', { assignedTo: 'direct-1' })]
  const empty = ownerBadgesWithFallback({ members: [] }, tree, { 'direct-1': true }, {})
  assert.deepEqual(empty['direct-1'], { name: 'v-b', status: 'running' })
  const junk = ownerBadgesWithFallback({ members: [null, 'nope', { id: 'x' }] } as never, tree, { 'direct-1': true }, {})
  assert.deepEqual(junk['direct-1'], { name: 'v-b', status: 'running' })
})

test('rows with no assignedTo, or with an empty one, are left alone', () => {
  const badges = ownerBadgesWithFallback(
    { members: [member()] },
    [row('a'), row('b', { assignedTo: '' })],
    { '': true },
    {},
  )
  assert.deepEqual(badges, { 'sub-1': { name: 'recon-1', status: 'inactive' } })
})

test('through buildOutline the row carries that badge: the view draws (v-b · running) instead of @direct-1', () => {
  const tree = [{ id: 'v-b', title: 'v-b', status: 'in_progress' as const, assignedTo: 'direct-1' }]
  const owners: OwnerIndex = ownerBadgesWithFallback({ members: [] }, tree, { 'direct-1': true }, {})
  const rows = buildOutline(tree, new Set<string>(), owners)
  // 视图对 owner 的渲染逐字是 '(' + name + ' · ' + status + ')' —— 这一行因此是 (v-b · running)。
  assert.deepEqual(rows[0]?.owner, { name: 'v-b', status: 'running' })
  // 投影缺席：没有 owner，assignedTo 原样留着 —— 视图照旧画 @direct-1。
  const absent: OwnerIndex = ownerBadgesWithFallback(undefined, tree, { 'direct-1': true }, {})
  const bare = buildOutline(tree, new Set<string>(), absent)
  assert.equal(bare[0]?.owner, undefined)
  assert.equal(bare[0]?.assignedTo, 'direct-1')
})

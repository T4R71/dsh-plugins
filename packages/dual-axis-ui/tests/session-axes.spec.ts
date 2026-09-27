/**
 * 会话轴在配置文档里那一层的取值测试。
 *
 * 钉住四件事：文档里**别的**命名空间（尤其是设置页那一行 `dual-axis`）不会被当成本
 * 会话的轴；只有按会话 id 分区的那一条记录才算数；读不懂的取值一律返回 undefined 而不是
 * 抛出去把输入条带崩；以及**没有记录时显示的是种子**（设置页那一行 + 父会话记录算出来的
 * 那一对），不是内置默认对。
 *
 * 最后一条的跨包那一半在宿主的 `tests/seed-parity.spec.ts`：那里把两侧喂同一组输入、
 * 断言输出逐字相等。这里钉的是本半边自己的分支。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  DUAL_AXIS_ROW_NAMESPACE, SESSION_AXES_FALLBACK, SESSION_AXES_FIELD, SESSION_AXES_NAMESPACE,
  sessionAxesOf, sessionAxesRowValue, sessionAxesSectionValue, sessionAxesView,
} from '../src/client/permission/session-axes-data.ts'

/** 一行命名空间视图，只带读取面真的会用到的两个成员。 */
const row = (ns: string, value: unknown) => ({ ns, value })

const PAIR = { read: { kind: 'deny' }, write: { kind: 'workspace' } }

/**
 * 设置页那一行：一条自定义读轴、一条闭合写轴，外加一个默认组。
 *
 * 读轴不是内置默认的「读 all」，断开种子与默认对 —— 否则断言分不出「显示了种子」与
 * 「显示了默认对」。写轴刻意留成闭合取值（workspace）：它必须原样出现，不挂组、也不
 * 被提升成自定义，这正是逐轴判定的那一半。
 */
const ROW = { read: { kind: 'custom', base: 'deny' }, write: { kind: 'workspace' }, defaultGroups: ['A'] }

/** {@link ROW} 算出来的种子：只有自定义那条读轴带上组 A，写轴按声明原样。 */
const ROW_SEED = {
  read: { kind: 'custom', base: 'deny', groups: ['A'], allow: [], deny: [] },
  write: { kind: 'workspace' },
}

/** 一份文档：设置页那一行 + 会话轴那一节。 */
const doc = (axes: unknown, settingsRow: unknown = ROW) => [
  row(DUAL_AXIS_ROW_NAMESPACE, settingsRow),
  row(SESSION_AXES_NAMESPACE, { axes }),
]

test('the namespace and field names are the ones the host writes', () => {
  assert.equal(SESSION_AXES_NAMESPACE, 'dual-axis-sessions')
  assert.equal(SESSION_AXES_FIELD, 'axes')
  // 设置页那一行是另一节：它的 read/write/defaultGroups 是新会话的种子。
  assert.notEqual(SESSION_AXES_NAMESPACE, DUAL_AXIS_ROW_NAMESPACE)
  assert.equal(DUAL_AXIS_ROW_NAMESPACE, 'dual-axis')
})

test('the section is found by namespace, and only there', () => {
  const rows = [row(DUAL_AXIS_ROW_NAMESPACE, { read: { kind: 'all' }, write: { kind: 'all' } }), row(SESSION_AXES_NAMESPACE, { axes: { s1: PAIR } })]
  assert.deepEqual(sessionAxesSectionValue(rows), { axes: { s1: PAIR } })
  assert.equal(sessionAxesSectionValue(undefined), undefined)
  assert.equal(sessionAxesSectionValue([row(DUAL_AXIS_ROW_NAMESPACE, {})]), undefined)
})

test('the settings row is read from its own namespace, and only there', () => {
  const rows = doc({ s1: PAIR })
  assert.deepEqual(sessionAxesRowValue(rows), ROW)
  assert.equal(sessionAxesRowValue(undefined), undefined)
  assert.equal(sessionAxesRowValue([row(SESSION_AXES_NAMESPACE, { axes: {} })]), undefined)
})

test('a session reads its own record and nobody else\'s', () => {
  const value = { axes: { s1: { read: { kind: 'deny' }, write: { kind: 'deny' } }, s2: PAIR } }
  assert.deepEqual(sessionAxesOf(value, 's2'), PAIR)
  assert.equal(sessionAxesOf(value, 's3'), undefined)
  assert.equal(sessionAxesOf(value, undefined), undefined)
})

test('the settings row\'s own read/write is never mistaken for a session axis', () => {
  // 把那一行的取值当成文档喂进来：里面没有 `axes` 字段，于是取不到任何会话的轴。
  const rowValue = { read: { kind: 'all' }, write: { kind: 'all' }, groups: [], defaultGroups: [] }
  assert.equal(sessionAxesOf(rowValue, 's1'), undefined)
})

test('an unreadable document yields undefined instead of throwing', () => {
  assert.equal(sessionAxesOf(null, 's1'), undefined)
  assert.equal(sessionAxesOf([], 's1'), undefined)
  assert.equal(sessionAxesOf({ axes: [] }, 's1'), undefined)
  assert.equal(sessionAxesOf({ axes: { s1: null } }, 's1'), undefined)
  assert.equal(sessionAxesOf({ axes: { s1: 'nope' } }, 's1'), undefined)
  assert.equal(sessionAxesOf({ axes: { s1: { read: { kind: 'deny' } } } }, 's1'), undefined)
  assert.equal(sessionAxesOf({ axes: { s1: { write: { kind: 'deny' } } } }, 's1'), undefined)
})

test('a custom axis keeps its base, its paths and its group ids', () => {
  const custom = {
    read: { kind: 'custom', base: 'workspace', groups: ['g1', 'g2'], allow: ['D:\\x'], deny: [] },
    write: { kind: 'custom', base: 'deny', allow: [], deny: [] },
  }
  assert.deepEqual(sessionAxesOf({ axes: { s1: custom } }, 's1'), custom)
})

/* --------------------------- 没有记录时显示什么 --------------------------- */

test('a session with no record shows the SEED, not the built-in pair', () => {
  // 记录缺席时宿主执行的是这条会话的种子（设置页那一行算出来的那一对），所以界面必须
  // 显示同一个值。显示内置默认对就是「界面显示 A、宿主执行 B」：设置页默认是「禁止读」
  // 时，那一轮仍会被当成「全盘读」。
  assert.deepEqual(
    sessionAxesView(doc({ other: PAIR }), 's1'),
    { state: 'default', axes: ROW_SEED },
  )
  // 这一条断言是上面那一条的意义所在：种子与默认对确实不同。
  assert.notDeepEqual(ROW_SEED, SESSION_AXES_FALLBACK)
})

test('a session with no record follows the settings row as it changes', () => {
  // 这条会话没有记录 —— 空会话就是这种状态（宿主只在会话被用过、或用户手动改过轴之后
  // 才落记录，见宿主包的 \`@t4r71/dsh-dual-axis/content\`）。于是它的两个下拉
  // 每次求值都从设置页那一行**当刻**的值现算，于是"人工改设置页多半秒后按 Ctrl+N"这种
  // 常见动作里，下拉跟着设置页走而不是停在旧值上。
  const before = { read: { kind: 'all' }, write: { kind: 'workspace' } }
  const after = { read: { kind: 'deny' }, write: { kind: 'deny' } }
  const noRecords = { axes: {} }

  assert.deepEqual(
    sessionAxesView([row(DUAL_AXIS_ROW_NAMESPACE, before), row(SESSION_AXES_NAMESPACE, noRecords)], 's1'),
    { state: 'default', axes: { read: { kind: 'all' }, write: { kind: 'workspace' } } },
  )
  // 同一份文档结构，只把设置页那一行换掉 —— 没有记录的那条会话立刻显示新值。
  assert.deepEqual(
    sessionAxesView([row(DUAL_AXIS_ROW_NAMESPACE, after), row(SESSION_AXES_NAMESPACE, noRecords)], 's1'),
    { state: 'default', axes: { read: { kind: 'deny' }, write: { kind: 'deny' } } },
  )
  // 一旦这条会话有了记录，设置页再怎么改都与它无关：记录赢。
  assert.deepEqual(
    sessionAxesView([
      row(DUAL_AXIS_ROW_NAMESPACE, after),
      row(SESSION_AXES_NAMESPACE, { axes: { s1: { read: { kind: 'all' }, write: { kind: 'workspace' } } } }),
    ], 's1'),
    { state: 'record', axes: { read: { kind: 'all' }, write: { kind: 'workspace' } } },
  )
})

test('a record still wins over the seed', () => {
  assert.deepEqual(
    sessionAxesView(doc({ s1: PAIR }), 's1'),
    { state: 'record', axes: PAIR },
  )
  // 别人的记录不算数：本会话仍然按种子显示。
  assert.deepEqual(
    sessionAxesView(doc({ s2: PAIR }), 's1'),
    { state: 'default', axes: ROW_SEED },
  )
})

test('a subagent child seeds from its parent record, not from the settings row', () => {
  // 宿主 inheritedAxes 读的是父会话当刻的记录；客户端读的是同一份文档里的同一个 id。
  // 父会话那一对两条轴都是闭合取值，所以默认加载清单对它们一条也不生效：逐轴判定。
  const parent = { read: { kind: 'deny' }, write: { kind: 'workspace' } }
  assert.deepEqual(
    sessionAxesView(doc({ p1: parent }), 'c1', 'p1'),
    { state: 'default', axes: parent },
  )
  // 父会话的记录里有一条自定义轴时，组仍然只挂到那条轴上。
  const customParent = { read: { kind: 'custom', base: 'deny' }, write: { kind: 'workspace' } }
  assert.deepEqual(
    sessionAxesView(doc({ p1: customParent }), 'c1', 'p1'),
    {
      state: 'default',
      axes: {
        read: { kind: 'custom', base: 'deny', groups: ['A'], allow: [], deny: [] },
        write: { kind: 'workspace' },
      },
    },
  )
  // 父会话自己也没有记录时退回设置页那一行 —— 与宿主同一条分支。
  assert.deepEqual(sessionAxesView(doc({}), 'c1', 'p1'), { state: 'default', axes: ROW_SEED })
  // 父会话有记录时，父会话自己的那一条仍然照读。
  assert.deepEqual(sessionAxesView(doc({ p1: parent }), 'p1'), { state: 'record', axes: parent })
})

test('with no settings row to seed from, the built-in pair is what is left', () => {
  // 组合里没装设置页那一行（或宿主压根没服务那一节）时，宿主退回它挂载时那一份配置，
  // 也就是内置默认对；界面同理。这不是「没有记录就显示默认对」，而是种子就是默认对。
  assert.deepEqual(
    sessionAxesView([row(SESSION_AXES_NAMESPACE, { axes: {} })], 's1'),
    { state: 'default', axes: SESSION_AXES_FALLBACK },
  )
})

test('an unreadable settings row falls back to the pair the host falls back to', () => {
  // 宿主 seedPair 在同一种输入上答 DEFAULT_AXES（它整份读不懂），界面必须一致。
  for (const broken of [
    { read: { kind: 'wide' }, write: { kind: 'deny' } },
    { read: { kind: 'custom', base: 'all', allow: ['relative'], deny: [] }, write: { kind: 'deny' } },
    { read: { kind: 'deny' }, write: { kind: 'deny' }, defaultGroups: 'A' },
    { read: null, write: { kind: 'deny' } },
  ]) {
    assert.deepEqual(
      sessionAxesView(doc({}, broken), 's1'),
      { state: 'default', axes: SESSION_AXES_FALLBACK },
      JSON.stringify(broken),
    )
  }
  // 兜底那一对就是宿主 DEFAULT_AXES 的字面量（读 all、写 workspace）。
  assert.deepEqual(SESSION_AXES_FALLBACK, { read: { kind: 'all' }, write: { kind: 'workspace' } })
})

test('nothing to read at all is its own state, not a claim about the axis', () => {
  const rows = doc({ s1: PAIR })
  // 没有选中会话，或镜像还没有交出任何文档：这两种情形下都无法声称与宿主一致。
  assert.deepEqual(sessionAxesView(rows, undefined), { state: 'unknown' })
  assert.deepEqual(sessionAxesView(undefined, 's1'), { state: 'unknown' })
})

test('an unreadable record reads as no record, and never throws', () => {
  assert.deepEqual(
    sessionAxesView(doc({ s1: { read: { kind: 'deny' } } }), 's1'),
    { state: 'default', axes: ROW_SEED },
  )
  assert.deepEqual(
    sessionAxesView([row(DUAL_AXIS_ROW_NAMESPACE, ROW), row(SESSION_AXES_NAMESPACE, null)], 's1'),
    { state: 'default', axes: ROW_SEED },
  )
})

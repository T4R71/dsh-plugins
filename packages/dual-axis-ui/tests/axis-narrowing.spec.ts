/**
 * 客户端半边的收窄取值与文案测试。
 *
 * 收窄结论**不是**这里算的：它由宿主的一次解算（\`resolveEffectiveAxes\`）产出、
 * 随这条会话的记录一起发布。本半边只做两件事 —— 把那个成员读出来（读不懂就当作没有，
 * 绝不把一份读不出来的报告渲染成「什么也没被削」），以及把它拼成文案。跨包那一半在宿主的
 * \`tests/narrowing.spec.ts\`：那里断言记录里存下的就是解算自己的答案。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  DUAL_AXIS_ROW_NAMESPACE, SESSION_AXES_NAMESPACE,
  narrowingOf, sessionAxesOf, sessionAxesView,
} from '../src/client/permission/session-axes-data.ts'
import { narrowingNotice } from '../src/client/permission/presentation.ts'
import type { NarrowingKey } from '../src/client/permission/presentation.ts'
import { accessEn, accessZh } from '../src/client/permission/locales.ts'

/** 一份宿主会发布的收窄结论。 */
const REPORT = {
  narrowed: true,
  droppedRoots: ['M:\\T4\\out\\narrowing-out'],
  lostUnbounded: false,
}

/** 一行命名空间视图。 */
const row = (ns: string, value: unknown) => ({ ns, value })

/** 词典座位：把键原样交回，好断言用的是哪几个键、参数是什么。 */
const t = (key: string, params?: Record<string, string>) =>
  params === undefined ? key : key + ' ' + JSON.stringify(params)

/* ------------------------------ 读取那一层 ------------------------------ */

test('a published report is read, and the roots are kept verbatim', () => {
  assert.deepEqual(narrowingOf(REPORT), REPORT)
  // 宿主解算出来的拼写（已规范化）原样带出来 —— 界面不重新拼根路径。
  assert.deepEqual(narrowingOf({ ...REPORT, lostUnbounded: true }), { ...REPORT, lostUnbounded: true })
  assert.deepEqual(narrowingOf({ ...REPORT, droppedRoots: [] }), { ...REPORT, droppedRoots: [] })
})

test('no report, and a report that removed nothing, are the same absence', () => {
  assert.equal(narrowingOf(undefined), undefined, '这个成员存在之前的记录')
  assert.equal(narrowingOf({ narrowed: false, droppedRoots: [], lostUnbounded: false }), undefined)
  assert.equal(narrowingOf(null), undefined)
})

test('an unreadable report reads as no report, never as "nothing was removed"', () => {
  for (const broken of [
    'nope', 1, [], true,
    { narrowed: 'yes', droppedRoots: [], lostUnbounded: false },
    { narrowed: true, lostUnbounded: false },
    { narrowed: true, lostUnbounded: false, droppedRoots: 'M:\\x' },
    { narrowed: true, lostUnbounded: false, droppedRoots: [7] },
  ]) {
    // 把一份读不出来的报告渲染成「没被削」正是最坏的那一种错，所以这里一律当作没有。
    assert.equal(narrowingOf(broken), undefined, JSON.stringify(broken))
  }
})

test('a record carries the narrowing to the two dropdowns', () => {
  const record = { read: { kind: 'workspace' }, write: { kind: 'custom', base: 'deny', allow: [], deny: [] }, narrowing: REPORT }
  assert.deepEqual(sessionAxesOf({ axes: { s1: record } }, 's1'), record)
  // 它与两条轴**平级**，不是某一条轴取值的成员：界面按记录读它，只在写轴那一格渲染。
  // 读错层级就会「宿主说削了、界面一个字都没有」——这条断言钉的就是这个。
  assert.deepEqual(
    Object.keys(sessionAxesOf({ axes: { s1: record } }, 's1') ?? {}),
    ['read', 'write', 'narrowing'],
  )
  assert.equal(
    (sessionAxesOf({ axes: { s1: record } }, 's1')?.write as { narrowing?: unknown }).narrowing,
    undefined,
    'the report is not a member of the write axis value',
  )
  // 成员缺席时只是没有它：轴的读取一字不变（旧记录照样能显示）。
  assert.deepEqual(
    sessionAxesOf({ axes: { s1: { read: { kind: 'deny' }, write: { kind: 'deny' } } } }, 's1'),
    { read: { kind: 'deny' }, write: { kind: 'deny' } },
  )
  // 记录里的坏报告不会把整条记录读坏：轴还在，收窄当作没有。
  const broken = sessionAxesOf({ axes: { s1: { ...record, narrowing: { narrowed: 'yes' } } } }, 's1')
  assert.deepEqual(broken, { read: record.read, write: record.write })
  // 三态里也一样。
  assert.deepEqual(
    sessionAxesView([row(DUAL_AXIS_ROW_NAMESPACE, {}), row(SESSION_AXES_NAMESPACE, { axes: { s1: record } })], 's1'),
    { state: 'record', axes: record },
  )
})

/* -------------------------------- 文案 -------------------------------- */

/** 把 {@link t} 拼出来的「键 + JSON 参数」拆回参数，断言与转义层数无关。 */
function paramsOf(rendered: string): Record<string, string> {
  const brace = rendered.indexOf('{')
  assert.notEqual(brace, -1, rendered)
  return JSON.parse(rendered.slice(brace)) as Record<string, string>
}

test('the notice names the invariant and the roots the read axis removed', () => {
  const notice = narrowingNotice(REPORT, t)
  assert.ok(notice !== undefined)
  if (notice === undefined) return
  assert.equal(notice.title, 'narrowing.title')
  assert.equal(paramsOf(notice.removed)['roots'], REPORT.droppedRoots[0], 'the root reaches the copy verbatim')
  assert.equal(notice.lostUnbounded, '', 'a loss a root list can state is not also described as an unbounded one')
  assert.equal(notice.marked, true, 'the trigger carries its corner mark while this stands')
  assert.equal(
    notice.marker,
    'narrowing.marker ' + JSON.stringify({ title: 'narrowing.title', removed: notice.removed }),
    'the marker sentence interpolates the notice built here, parameters included',
  )
})

test('the marker sentence is complete copy, never a leftover placeholder', () => {
  // 这一条钉的是曾经真的发生过的一种错法：调用方只给 `key => t(key)`，参数被丢掉，
  // 于是界面上留下的是一句带 {roots} 的原文。这里用真词典渲染，断言一个占位符都不剩。
  const t = (key: NarrowingKey | string, params?: Record<string, string>) => {
    const value = accessZh[key as keyof typeof accessZh]
    assert.equal(typeof value, 'string', 'missing dictionary key: ' + key)
    let text = value
    for (const [name, replacement] of Object.entries(params ?? {})) text = text.replace('{' + name + '}', replacement)
    return text
  }
  const notice = narrowingNotice(REPORT, t)
  assert.ok(notice !== undefined)
  if (notice === undefined) return
  const rendered = t('narrowing.marker', { title: notice.title, removed: notice.removed })
  const marker = notice.marker
  for (const text of [notice.title, notice.removed, notice.lostUnbounded, rendered, marker]) {
    assert.ok(!text.includes('{'), text)
  }
  assert.ok(marker.includes(REPORT.droppedRoots[0] as string), marker)
})

test('an unbounded write axis says so instead of printing an empty root list', () => {
  const notice = narrowingNotice({ narrowed: true, droppedRoots: [], lostUnbounded: true }, t)
  assert.equal(notice?.lostUnbounded, 'narrowing.lostUnbounded')
  assert.equal(notice?.removed, 'narrowing.removed {"roots":"narrowing.none"}', 'the empty list is stated, not left blank')
})

test('nothing to show when nothing was removed', () => {
  assert.equal(narrowingNotice(undefined, t), undefined)
  assert.equal(narrowingNotice({ narrowed: false, droppedRoots: [], lostUnbounded: false }, t), undefined)
})

test('every sentence of the notice is owned by the locale dictionaries', () => {
  const keys = ['narrowing.title', 'narrowing.body', 'narrowing.removed', 'narrowing.none', 'narrowing.lostUnbounded', 'narrowing.marker'] as const
  for (const key of keys) {
    assert.equal(typeof accessZh[key], 'string', key)
    assert.equal(typeof accessEn[key], 'string', key)
    assert.notEqual(accessZh[key], '', key)
  }
  const notice = narrowingNotice(REPORT, (key, params) => {
    // 走真词典：键拼错时这里就是 undefined，测试当场红。
    const value = accessZh[key as keyof typeof accessZh]
    assert.equal(typeof value, 'string', key)
    let text = value
    for (const [name, replacement] of Object.entries(params ?? {})) text = text.replace('{' + name + '}', replacement)
    return text
  })
  assert.ok(notice !== undefined)
  if (notice === undefined) return
  assert.ok(notice.removed.includes(REPORT.droppedRoots[0] as string), notice.removed)
  assert.ok(!notice.removed.includes('{'), 'no placeholder is left unsubstituted')
  assert.ok(!notice.title.includes('{'))
})

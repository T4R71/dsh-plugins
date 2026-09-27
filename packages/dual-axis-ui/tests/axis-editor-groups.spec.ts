/**
 * 会话侧 `custom` 编辑器的规则组行为测试。
 *
 * 三件必须钉住的事：编辑器初值就是**这条会话的预设**（含它引用的组 id，打开再
 * 应用不改动它）；提交出去的 `groups=<id>|<id>` 与宿主解析器逐字对齐；设置页已经
 * 不定义的 id 留在列表里并保持勾选，免得一次「打开再应用」静默删掉一条引用。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  GROUP_ID_SEPARATOR, customFragment, draftOfAxisState, emptyDraft, fragmentWidensAccess,
  groupChoicesOf, groupOptionsOf, initialDraft,
} from '../src/client/permission/axis-editor.ts'

const problemOf = (key: string): string => key

test('a session whose read axis is deny opens the editor on deny, not on the deployment default', () => {
  assert.deepEqual(initialDraft('read', { kind: 'deny' }, { kind: 'all' }), {
    kind: 'custom', base: 'deny', groups: [], allow: '', deny: '',
  })
})

test('the deployment value covers only an axis this session has not set', () => {
  assert.deepEqual(initialDraft('read', undefined, { kind: 'workspace' }), {
    kind: 'custom', base: 'workspace', groups: [], allow: '', deny: '',
  })
  // 两条都没有：退回该轴的部署默认值（读 all、写 workspace），并以同一个取值作底座，
  // 于是「兜底打开再直接应用」落地的正是那条默认值本身。
  assert.deepEqual(initialDraft('read', undefined, undefined), {
    kind: 'all', base: 'all', groups: [], allow: '', deny: '',
  })
  assert.deepEqual(initialDraft('write', undefined, undefined), {
    kind: 'workspace', base: 'workspace', groups: [], allow: '', deny: '',
  })
})

test('the current-value reader keeps a closed kind as-is for the dropdown label', () => {
  assert.deepEqual(draftOfAxisState('read', { kind: 'deny' }), {
    kind: 'deny', base: 'deny', groups: [], allow: '', deny: '',
  })
})

test('the draft carries the groups the session already references', () => {
  const draft = draftOfAxisState('write', {
    kind: 'custom', base: 'all', groups: ['a', 'b'], allow: ['D:\\x'], deny: [],
  })
  assert.deepEqual(draft.groups, ['a', 'b'])
  const parsed = customFragment(draft, problemOf)
  assert.deepEqual(parsed, { ok: true, fragment: 'base=all,groups=a|b,allow=D:\\x' })
})

test('an axis with no groups of its own opens with an empty selection', () => {
  assert.deepEqual(emptyDraft('workspace').groups, [])
  assert.deepEqual(draftOfAxisState('read', { kind: 'custom', base: 'workspace', allow: [], deny: [] }).groups, [])
})

test('the group separator is the one the host parses', () => {
  assert.equal(GROUP_ID_SEPARATOR, '|')
})

test('an id the host would split is refused instead of emitted', () => {
  const draft = { ...emptyDraft('read'), base: 'all' as const, groups: ['a|b'] }
  assert.deepEqual(customFragment(draft, problemOf), { ok: false, problem: 'groupUnsupported' })
  const comma = { ...emptyDraft('read'), base: 'all' as const, groups: ['a,b'] }
  assert.deepEqual(customFragment(comma, problemOf), { ok: false, problem: 'groupUnsupported' })
  const equals = { ...emptyDraft('read'), base: 'all' as const, groups: ['a=b'] }
  assert.deepEqual(customFragment(equals, problemOf), { ok: false, problem: 'groupUnsupported' })
})

test('selecting a group goes through the widening gate, because only the host knows what it grants', () => {
  assert.equal(fragmentWidensAccess('base=workspace,groups=a'), true)
  assert.equal(fragmentWidensAccess('base=workspace'), false)
})

test('reading the settings library skips entries no session could reference', () => {
  assert.deepEqual(groupOptionsOf([
    { id: 'a', name: 'A', write: { allow: ['/x'] } },
    { id: '', name: 'blank' },
    { id: 'a', name: 'again' },
    3,
    { id: 'b' },
  ]), [
    { id: 'a', name: 'A', read: false, write: true },
    { id: 'b', name: 'b', read: false, write: false },
  ])
  assert.deepEqual(groupOptionsOf(undefined), [])
})

test('a referenced id the settings page no longer defines stays listed and checked', () => {
  const choices = groupChoicesOf([{ id: 'a', name: 'A', read: true, write: true }], ['a', 'gone'])
  assert.deepEqual(choices, [
    { id: 'a', name: 'A', coverage: 'both', missing: false, checked: true },
    { id: 'gone', name: 'gone', coverage: 'none', missing: true, checked: true },
  ])
})

test('an unselected group is listed unchecked, and the selection can be emptied', () => {
  const choices = groupChoicesOf([{ id: 'a', name: 'A', read: true, write: false }], [])
  assert.deepEqual(choices, [{ id: 'a', name: 'A', coverage: 'read', missing: false, checked: false }])
})

/**
 * 规则组纯函数层的行为测试。
 *
 * 这些用例钉的是**边界**而不是实现：一个组可以只覆盖一根轴；坏取值在写入之前
 * 就被挡住（宿主把一份读不懂的库变成每一次判定都响亮失败）；默认加载清单跟着
 * 草稿行走，于是改 id 不会把它丢在旧 id 上。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  defaultGroupIdsOf, emptyGroupDraft, groupDraftsOf, groupLibraryOf, jsonDefaultGroupIds,
  jsonGroupLibrary, nextGroupId, sameGroupLibrary,
  type GroupProblemText, type RuleGroupDraft,
} from '../src/client/row/groups.ts'

const LABELS: Record<string, string> = {
  idEmpty: 'empty id',
  idDuplicate: 'duplicate id {id}',
  notAbsolute: 'not absolute {path}',
}
const problemOf: GroupProblemText = (key, params) => {
  let text = LABELS[key] ?? key
  for (const [name, value] of Object.entries(params)) text = text.replace('{' + name + '}', value)
  return text
}

const draft = (patch: Partial<RuleGroupDraft>): RuleGroupDraft => ({
  id: 'g1',
  name: 'Group one',
  read: { allow: '', deny: '' },
  write: { allow: '', deny: '' },
  default: false,
  ...patch,
})

test('a group may carry rules for one axis only', () => {
  const parsed = groupLibraryOf([draft({ write: { allow: 'D:\\work\\a', deny: '' } })], problemOf)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.ok ? parsed.value : [], [
    { id: 'g1', name: 'Group one', write: { allow: ['D:\\work\\a'], deny: [] } },
  ])
})

test('a group with both sides empty keeps neither side', () => {
  const parsed = groupLibraryOf([draft({})], problemOf)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.ok ? parsed.value[0] : undefined, { id: 'g1', name: 'Group one' })
})

test('an empty name falls back to the id, because the id is what references depend on', () => {
  const parsed = groupLibraryOf([draft({ name: '  ' })], problemOf)
  assert.equal(parsed.ok && parsed.value[0]?.name, 'g1')
})

test('an empty or duplicate id blocks the save', () => {
  assert.deepEqual(groupLibraryOf([draft({ id: ' ' })], problemOf), { ok: false, problem: 'empty id' })
  assert.deepEqual(
    groupLibraryOf([draft({}), draft({ name: 'other' })], problemOf),
    { ok: false, problem: 'duplicate id g1' },
  )
})

test('a relative path blocks the save before the host ever reads the library', () => {
  const parsed = groupLibraryOf([draft({ read: { allow: 'relative/x', deny: '' } })], problemOf)
  assert.deepEqual(parsed, { ok: false, problem: 'not absolute relative/x' })
})

test('the default-loading flag follows its own group through an id rename', () => {
  const drafts = [draft({ default: true, id: 'renamed' })]
  assert.deepEqual(defaultGroupIdsOf(drafts), ['renamed'])
})

test('reading the library is lenient so the page can still render junk to fix it', () => {
  const drafts = groupDraftsOf(
    [{ id: 'a', name: 'A', read: { allow: ['/x'] } }, 7, { name: 'no id' }],
    ['a', 5],
  )
  assert.equal(drafts.length, 3)
  assert.deepEqual(drafts[0], {
    id: 'a', name: 'A', read: { allow: '/x', deny: '' }, write: { allow: '', deny: '' }, default: true,
  })
  assert.equal(drafts[1]?.id, '')
  assert.equal(drafts[2]?.id, '')
  assert.equal(drafts[2]?.default, false)
})

test('a new group gets an id nothing else uses', () => {
  assert.equal(nextGroupId([]), 'g1')
  assert.equal(nextGroupId([draft({ id: 'g1' }), draft({ id: 'g2' })]), 'g3')
  assert.deepEqual(emptyGroupDraft([]), {
    id: 'g1', name: '', read: { allow: '', deny: '' }, write: { allow: '', deny: '' }, default: false,
  })
})

test('two libraries compare by definition, not by identity', () => {
  const left = groupLibraryOf([draft({ read: { allow: '/a', deny: '/b' } })], problemOf)
  const right = groupLibraryOf([draft({ read: { allow: '/a', deny: '/b' } })], problemOf)
  const other = groupLibraryOf([draft({ read: { allow: '/a', deny: '/c' } })], problemOf)
  assert.ok(left.ok && right.ok && other.ok)
  assert.equal(left.ok && right.ok && sameGroupLibrary(left.value, right.value), true)
  assert.equal(left.ok && other.ok && sameGroupLibrary(left.value, other.value), false)
})

test('the JSON written to the document carries mutable arrays', () => {
  const library = jsonGroupLibrary([{ id: 'g1', name: 'G', read: { allow: ['/a'], deny: [] } }])
  assert.deepEqual(library, [{ id: 'g1', name: 'G', read: { allow: ['/a'], deny: [] } }])
  assert.deepEqual(jsonDefaultGroupIds(['g1']), ['g1'])
  assert.equal(Object.isFrozen(library), false)
})

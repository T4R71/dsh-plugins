/**
 * The two things a submission needs in order to be honest about its outcome:
 * the value it MEANT to store, and a comparison that decides whether the stored
 * record is that value.
 *
 * The host answers `/axis` with whether the line resolved to a registered
 * command, not whether that command wrote anything
 * (`packages/api/session-controller/src/client/sessions/session.ts:387-391`),
 * so `draftScope` + `sameStoredAxis` are what let the interface tell a stored
 * change from a refused one. The trigger cannot: a `custom` axis renders the
 * same word whatever base or groups it carries, which is why the read-back — not
 * the label — is what decides a submission's outcome.
 *
 * Run with:
 *   node --import tsx/esm --test tests/axis-submit.spec.ts
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { draftScope, emptyDraft, sameStoredAxis } from '../src/client/permission/axis-editor.ts'
import { accessEn, accessZh } from '../src/client/permission/locales.ts'
import { axisValueName } from '../src/client/permission/presentation.ts'

/** 一份带组与路径的 custom 草稿。 */
const draft = {
  kind: 'custom' as const,
  base: 'all' as const,
  groups: ['B', 'A', 'B'],
  allow: 'M:\\T4\\out\\group-c\n',
  deny: '',
}

test('a draft submits the scope the host will store: deduped ids, ordered paths', () => {
  // 宿主 normalizeScope 的 groupIds 去重、pathList 保序，这里必须与它同形，
  // 否则提交后的核对会把一次成功的写入判成失败。
  assert.deepEqual(draftScope(draft), {
    kind: 'custom',
    base: 'all',
    groups: ['B', 'A'],
    allow: ['M:\\T4\\out\\group-c'],
    deny: [],
  })
})

test('the stored scope is compared by value, list order included', () => {
  const stored = draftScope(draft)
  assert.equal(sameStoredAxis(stored, { ...stored, groups: ['B', 'A'] }), true)
  // 顺序是取值的一部分：勾选顺序就是这条轴引用的顺序。
  assert.equal(sameStoredAxis(stored, { ...stored, groups: ['A', 'B'] }), false)
  assert.equal(sameStoredAxis(stored, { ...stored, groups: ['B'] }), false)
  assert.equal(sameStoredAxis(stored, { ...stored, allow: [] }), false)
  assert.equal(sameStoredAxis(stored, { ...stored, base: 'workspace' }), false)
})

test('a closed value compares without any custom detail', () => {
  assert.equal(sameStoredAxis({ kind: 'all' }, { kind: 'all' }), true)
  assert.equal(sameStoredAxis({ kind: 'all' }, { kind: 'deny' }), false)
  // 一条 closed 取值落在文档里也不带底座与路径；多出来的成员不参与比较。
  assert.equal(sameStoredAxis({ kind: 'all' }, { kind: 'all', groups: ['A'], allow: [] }), true)
  assert.equal(sameStoredAxis({ kind: 'custom', base: 'all', allow: [], deny: [] }, { kind: 'all' }), false)
})

test('a scope that was never read is not equal to one that was', () => {
  assert.equal(sameStoredAxis(undefined, undefined), true)
  assert.equal(sameStoredAxis(undefined, { kind: 'all' }), false)
  assert.equal(sameStoredAxis({ kind: 'all' }, undefined), false)
})

/* ------------------------- 触发器上那一格文案 ------------------------- */

/** 一个把 {name} 之类占位符代进去的词典座位。 */
function t(key: keyof typeof accessZh, params: Record<string, string | number> = {}): string {
  const template: string = accessZh[key]
  return template.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
}

test('a custom axis says only that it is custom, on both axes', () => {
  const readName = axisValueName('custom', 'read', t)
  const writeName = axisValueName('custom', 'write', t)
  // 完整的触发器文案（readLabel/writeLabel 里的那一格）：
  assert.equal(t('readLabel', { name: readName }), '读取权限，当前：自定义')
  assert.equal(t('writeLabel', { name: writeName }), '写入权限，当前：自定义')
  // 判据：括号里的明细不上触发器。这条函数连那条轴的底座与组都拿不到，所以「勾一个组
  // 再应用」在标签上看不出变化是结构性的 —— 回执由提交后的回读给出，见 stored()。
  assert.equal(/[（(]/u.test(readName), false)
})

test('the custom word comes from the dictionary, not from this module', () => {
  // 换一份词典座位就换一个词：英文部署读到的必须是 "Custom"，而不是中文硬编码。
  assert.equal(axisValueName('custom', 'read', key => accessEn[key]), 'Custom')
  assert.equal(axisValueName('custom', 'write', key => accessEn[key]), 'Custom')
  assert.equal(axisValueName(undefined, 'read', key => accessEn[key]), 'Not set')
})

test('an axis with nothing to show says so instead of borrowing a value', () => {
  assert.equal(axisValueName(undefined, 'read', t), '未设置')
  assert.equal(axisValueName(undefined, 'write', t), '未设置')
})

test('the three closed values keep their own labels', () => {
  assert.equal(axisValueName('deny', 'read', t), '禁止读')
  assert.equal(axisValueName('workspace', 'write', t), '工作区写')
  assert.equal(axisValueName('all', 'read', t), '全盘读')
})

test('the copy the trigger and the failure message need exists in both dictionaries', () => {
  for (const key of ['axis.custom', 'axis.unknown', 'editor.notStored'] as const) {
    assert.equal(typeof accessZh[key], 'string')
    assert.equal(typeof accessEn[key], 'string')
  }
})

/**
 * 双轴访问模式组合包的浏览器半边：General 设置页上这一行自己的配置。
 * 宿主半边在 `@t4r71/dsh-dual-axis`（注册设置节、新会话钉轴），这一半只负责改那份设置。
 *
 * 页面只表达一件事 —— 新会话从哪两条轴开始：读轴与写轴，每条都能选
 * deny / workspace / all / custom，选 custom 时再给底座与两个绝对路径列表
 * （放行、排除，排除优先），再加上组库与「新对话默认加载哪些组」。取值只写进
 * 宿主注册的 `dual-axis` 设置节（节名就是这一行在条目树里的行 id），页面上不另存一份。
 *
 * 0.1.7 起，设置页的表单由**页面下发**：这一行不再自持 `ctx.settingsScope`
 * （该服务已整块删除），而是消费 `props.form` —— owner 渲染时算好的
 * `{ state: ConfigFormSnapshot, mutate }`。state 里的 `value` / `user` / `writable`
 * 与 0.1.6 的 scope 快照同义，因此草稿层原样保留；写入从逐字段的
 * `set` / `unset` 改成一次 `mutate`，两条轴共用同一个 revision fence。
 *
 * @module @t4r71/dsh-dual-axis-ui/client
 */

import { createElement, useState, type ChangeEvent, type ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 类型导入：拉入 ctx.slots / ctx.locale 的 Context 合并、'settings.general.item'
// 的 SlotMap 条目，以及 owner props 上的 form 字段。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
// 类型导入：拉入 'plugins.row.config' 的 SlotMap 条目与它的 owner props 契约。
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  AXIS_BASES, AXIS_KINDS, axisValueOf, describeAxis, draftOf, scopeOf, sameAxis,
  type AxisBase, type AxisDraft, type AxisKind, type AxisText, type AxisValue,
} from './axes.ts'
import {
  defaultGroupIdsOf, emptyGroupDraft, groupDraftsOf, groupLibraryOf, jsonDefaultGroupIds,
  jsonGroupLibrary, sameGroupLibrary,
  type GroupAxisDraft, type GroupProblemKey, type GroupProblemText, type RuleGroupDraft,
} from './groups.ts'
import { DUAL_AXIS_LOCALE_NS, en, zh, type DualAxisLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 本包配置页自己的词典命名空间。 */
    'sandbox-axis': DualAxisLocaleKey
  }
}

/** 设置节里的未信任取值，读取时由 {@link draftOf} / {@link groupDraftsOf} 收窄。 */
export interface DualAxisSection {
  /** 新会话起步的读轴。 */
  read?: unknown
  /** 新会话起步的写轴。 */
  write?: unknown
  /** 组库：会话按 id 引用的具名规则片段。 */
  groups?: unknown
  /** 新会话默认加载哪些组。 */
  defaultGroups?: unknown
}

/** 两条轴的字段名。逐个处理而不是复制两段代码：加一条轴不会漏掉另一条。 */
const AXES = ['read', 'write'] as const

/** 一条轴的字段名。 */
export type AxisField = typeof AXES[number]

/**
 * 这一行在组合包 `cordis.patch.yml` 里的行 id。
 *
 * 宿主半边 `@t4r71/dsh-dual-axis` 的补丁里那一行就叫 `dual-axis`
 * （`packages/bundle/dual-axis/cordis.patch.yml:11`）。**这个 id 不能自造**：
 * 插件页是拿它去条目树里查那一条 entry 的。
 */
export const DUAL_AXIS_ROW_ID = 'dual-axis'

/**
 * 承载这一行的组合包包名。
 *
 * 配置页的键由**组合包的包名**与行 id 拼成（`rowConfigKey(bundle, rowId)`，
 * ui-plugin-manager/src/client/config-ledger.ts:36-38），而不是由本包的包名拼成：
 * `dual-axis` 这一行写在 `@t4r71/dsh-dual-axis` 的 `cordis.patch.yml` 里，
 * 所以插件页拿那个组合包的名字去查键。写成别的名字（例如插件的发布 scope）
 * 拼出来的键永远匹配不上，页面于是**静默地**不渲染这一行。
 */
export const DUAL_AXIS_BUNDLE = '@t4r71/dsh-dual-axis'

/** 这一行的配置页在插件页上注册的键：`<组合包名>#<行 id>`。 */
export const DUAL_AXIS_ROW_KEY = `${DUAL_AXIS_BUNDLE}#${DUAL_AXIS_ROW_ID}`

/** 这份配置行需要的服务：page 由 ui-settings-general 的 General 分栏声明。 */
export const inject = ['slots', 'locale']

/**
 * 页面在这一行的渲染点下发的表单面：当前快照与一次原子提交。
 *
 * 成员取自 ui-plugin-manager 发布的 owner props 契约
 * （\`slot-contract.ts:23-28,125-130\`），不在这里重抄一份字段表
 * —— 上游改了 owner props，这里跟着改，而不是悄悄漂移成第二份定义。
 */
export type DualAxisRowForm = NonNullable<PluginConfigViewProps['form']>

/** 表单快照：与 0.1.6 的 \`SettingsScopeSnapshot\` 同名同义（value / user / status / writable）。 */
export type DualAxisRowSnapshot = ConfigFormSnapshot<DualAxisSection>

/** 表单面的写动作与快照，供组件内取用。 */
export type DualAxisRowMutate = ConfigForm<DualAxisSection>['mutate']

/**
 * 配置行的完整 props。页面把这一行当作 \`plugins.row.config\` 的一个 entry 渲染，
 * owner props 因此就是那份契约里的 \`PluginConfigViewProps\`：表单随它一起来。
 */
export type DualAxisRowProps =
  PropsRuntime<'plugins.row.config'>
  & PropsLocale<typeof DUAL_AXIS_LOCALE_NS>

/** 一条待提交的写动作：按设置文档里的路径寻址，取值已经是文档接受的那份 JSON。 */
type PlannedWrite =
  | { kind: 'set'; path: readonly string[]; value: AxisJson | GroupsJson | string[] }
  | { kind: 'clear'; path: readonly string[] }

/** 一条轴在页面上的状态。 */
interface AxisRow {
  /** 当前草稿。 */
  draft: AxisDraft
  /** 这一条轴是否已经落在用户层里（含点了「恢复默认」但还没保存）。 */
  overridden: boolean
}

/** 规则组库摊平之后的取值。 */
type GroupsJson = ReturnType<typeof jsonGroupLibrary>

/**
 * 这一行的翻译座位：本包词典的键域，外加模板参数。
 *
 * 不写成 `DualAxisRowProps['t']`：那个类型的键域还含共用词表，比本包词典宽，
 * 于是"只认本包键"的那几个 `t` 反而不能被传进来。
 */
type RowTranslate = (key: DualAxisLocaleKey, params?: Record<string, unknown>) => string

/** 一条规则草稿读不懂时用的词典键。 */
const GROUP_PROBLEM_KEYS: Record<GroupProblemKey, DualAxisLocaleKey> = {
  idEmpty: 'groupsProblemIdEmpty',
  idDuplicate: 'groupsProblemIdDuplicate',
  notAbsolute: 'groupsProblemNotAbsolute',
}

/**
 * 把规则组的说明键转成当前语言的文案。
 *
 * 说明里的「哪一侧、哪个列表」也是界面文案，所以在这里一并换成本地化词，而不是把
 * `read` / `allow` 这类字段名直接塞进句子给人看。
 * @param t - 这一行的翻译座位。
 * @returns 说明键与参数到文案的回调。
 */
function problemText(t: RowTranslate): GroupProblemText {
  return (key, params) => {
    const side = params['side']
    const entry = params['entry']
    return t(GROUP_PROBLEM_KEYS[key], {
      ...params,
      ...side === undefined ? {} : { side: t(side === 'read' ? 'groupSideRead' : 'groupSideWrite') },
      ...entry === undefined ? {} : { entry: t(entry === 'allow' ? 'entryAllow' : 'entryDeny') },
    })
  }
}

/** 词典交给 {@link describeAxis} 的文案表。 */
function textOf(t: (key: DualAxisLocaleKey) => string): AxisText {
  const kindLabels: Record<AxisKind, DualAxisLocaleKey> = {
    deny: 'kindDeny', workspace: 'kindWorkspace', all: 'kindAll', custom: 'kindCustom',
  }
  const baseLabels: Record<AxisBase, DualAxisLocaleKey> = {
    deny: 'baseDeny', workspace: 'baseWorkspace', all: 'baseAll',
  }
  return {
    kind: kind => t(kindLabels[kind]),
    base: base => t(baseLabels[base]),
    custom: (base, paths) => t('customTemplate').replace('{base}', base).replace('{paths}', paths),
  }
}

/** 一条轴的中文/英文标题键。 */
function titleKey(field: AxisField): DualAxisLocaleKey {
  return field === 'read' ? 'titleRead' : 'titleWrite'
}

/** 一条轴的说明键。 */
function hintKey(field: AxisField): DualAxisLocaleKey {
  return field === 'read' ? 'hintRead' : 'hintWrite'
}

/**
 * 组合层声明的兜底轴：设置节里缺一条轴时，页面按这一条显示。
 * @param field - 轴字段名。
 * @returns 该字段的兜底轴值。
 */
export function fallbackOf(field: AxisField): AxisValue {
  return field === 'read' ? { kind: 'all' } : { kind: 'workspace' }
}

/**
 * 去掉一份草稿表里的某个字段。用展开重写而不是 `delete`：后者在 TS 里是对动态
 * 键的删除，lint 明确禁止，而这里本来就只是要一份少了该字段的新表。
 * @param drafts - 当前草稿表。
 * @param field - 要去掉的轴字段名。
 * @returns 少了该字段的新表。
 */
function omitKey(drafts: Partial<Record<AxisField, AxisDraft>>, field: AxisField): Partial<Record<AxisField, AxisDraft>> {
  const { [field]: _dropped, ...rest } = drafts
  return rest
}

/** 一条轴摊平之后的取值：设置文档接受的那份 JSON。 */
type AxisJson = { kind: AxisKind; base?: AxisBase; allow?: string[]; deny?: string[] }

/**
 * 把一条轴值摊成设置文档接受的那份 JSON。
 *
 * `AxisValue` 的两个路径列表是 `readonly string[]`，而设置文档的取值是
 * `JsonValue`（可变数组）：传只读数组会被线上格式挡住，所以写入前摊平一层。
 * @param axis - 一条轴值。
 * @returns 同一份取值的可变副本。
 */
function jsonAxis(axis: AxisValue): AxisJson {
  if (axis.kind !== 'custom') return { kind: axis.kind }
  return { kind: 'custom', base: axis.base, allow: [...axis.allow], deny: [...axis.deny] }
}

/** 用户层里是否写着这个字段；presence 就是「已自定义」的判据。 */
function overriddenIn(user: unknown, field: AxisField): boolean {
  return typeof user === 'object' && user !== null && field in user
}

/**
 * 两份 id 清单是否相同。默认加载清单的顺序就是文档顺序，所以逐位比较。
 * @param left - 一份 id 清单。
 * @param right - 另一份 id 清单。
 * @returns 两者是否逐位相同。
 */
function sameIdList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/**
 * 跟踪两条轴与规则组库的草稿、把草稿写回设置节。
 *
 * 保存是一次全有或全无的提交：任何一份草稿还不是合法取值，这次保存就不发出任何
 * 写入 —— 一次只落一半的保存会留下"读轴改了、写轴没改"这种没人要求的中间状态，
 * 而它恰恰是权限配置里最不该出现的状态。规则组库与默认加载清单写在同一节里，
 * 于是它们也共用同一个 revision fence，不会出现「组建好了但没人默认加载」这种半落。
 * 0.1.7 的 `form.mutate` 收一串 op 并共用一个 fence，因此这一条契约由一次调用
 * 本身保证，不再靠调用方连发两次写入去凑。
 * @param form - 页面下发的表单面：当前快照与一次原子提交。
 * @param t - 这一行的翻译座位，规则组的说明文案按当前语言取。
 * @returns 两条轴与组库的状态，以及编辑、保存、放弃动作。
 */
function useDrafts(form: DualAxisRowForm, t: RowTranslate): {
  rows: Record<AxisField, AxisRow>
  groups: RuleGroupDraft[]
  groupProblem: string
  edit: (field: AxisField, draft: AxisDraft) => void
  editGroups: (drafts: RuleGroupDraft[]) => void
  reset: (field: AxisField) => void
  save: () => void
  discard: () => void
  dirty: boolean
  saving: boolean
  failed: boolean
  invalid: string
} {
  const [drafts, setDrafts] = useState<Partial<Record<AxisField, AxisDraft>>>({})
  const [resetting, setResetting] = useState<readonly AxisField[]>([])
  const [groupDraft, setGroupDraft] = useState<RuleGroupDraft[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const value = form.state.value ?? {}
  const user = form.state.user
  const rows = {} as Record<AxisField, AxisRow>
  for (const field of AXES) {
    rows[field] = {
      draft: drafts[field] ?? draftOf(value[field], fallbackOf(field)),
      overridden: overriddenIn(user, field) || resetting.includes(field),
    }
  }
  // 组库没有「恢复默认」这种动作：它是用户自己建的东西，清空就是删掉每一项。
  // 没被编辑过时直接照文档渲染，编辑过之后由草稿接管。
  const storedGroups = groupDraftsOf(value.groups, value.defaultGroups)
  const groups = groupDraft ?? storedGroups
  // 只有用户动过的草稿才在这里报问题：文档里那份坏取值不该挡住两条轴的保存。
  const groupValidation = groupDraft === null ? undefined : groupLibraryOf(groupDraft, problemText(t))

  /** 这次保存要执行的写动作，或第一条挡住保存的说明。 */
  const plan = (): { writes: PlannedWrite[] } | { problem: string } => {
    const writes: PlannedWrite[] = []
    for (const field of AXES) {
      if (resetting.includes(field)) {
        if (overriddenIn(user, field)) writes.push({ kind: 'clear', path: [field] })
        continue
      }
      const parsed = scopeOf(rows[field].draft)
      if (!parsed.ok) return { problem: parsed.problem }
      const stored = draftOf(value[field], fallbackOf(field))
      const saved = scopeOf(stored)
      if (saved.ok && sameAxis(saved.value, parsed.value)) continue
      writes.push({ kind: 'set', path: [field], value: jsonAxis(parsed.value) })
    }
    if (groupDraft === null) return { writes }
    const library = groupLibraryOf(groupDraft, problemText(t))
    if (!library.ok) return { problem: library.problem }
    // 文档里那份读不懂时把草稿整份写下去：那是要让用户看见并修掉的坏取值，
    // 不能与「没改过」混为一谈。
    const stored = groupLibraryOf(storedGroups, problemText(t))
    const libraryChanged = !(stored.ok && sameGroupLibrary(stored.value, library.value))
    const defaultsChanged = !sameIdList(defaultGroupIdsOf(storedGroups), defaultGroupIdsOf(groupDraft))
    if (libraryChanged) {
      writes.push({ kind: 'set', path: ['groups'], value: jsonGroupLibrary(library.value) })
    }
    if (libraryChanged || defaultsChanged) {
      writes.push({
        kind: 'set',
        path: ['defaultGroups'],
        value: jsonDefaultGroupIds(defaultGroupIdsOf(groupDraft)),
      })
    }
    return { writes }
  }

  const validation = plan()
  const invalid = 'problem' in validation ? validation.problem : ''

  const save = (): void => {
    const planned = plan()
    if ('problem' in planned || planned.writes.length === 0) return
    const ops = planned.writes.map(write => write.kind === 'clear'
      ? { op: 'unset' as const, path: [...write.path] }
      : { op: 'set' as const, path: [...write.path], value: write.value })
    setSaving(true)
    setFailed(false)
    void (async () => {
      let landed = false
      try {
        landed = await form.mutate(ops)
      } catch {
        landed = false
      }
      setSaving(false)
      setFailed(!landed)
      if (landed) { setDrafts({}); setResetting([]); setGroupDraft(null) }
    })()
  }

  return {
    rows,
    groups,
    groupProblem: groupValidation !== undefined && !groupValidation.ok ? groupValidation.problem : '',
    edit: (field, draft) => { setDrafts(current => ({ ...current, [field]: draft })) },
    editGroups: (next) => { setGroupDraft(next) },
    reset: (field) => {
      setResetting(current => current.includes(field) ? current : [...current, field])
      setDrafts(current => omitKey(current, field))
    },
    save,
    discard: () => { setDrafts({}); setResetting([]); setGroupDraft(null); setFailed(false) },
    dirty: Object.keys(drafts).length > 0 || resetting.length > 0 || groupDraft !== null,
    saving,
    failed,
    invalid,
  }
}

/**
 * 一条轴的一组控件：取值下拉，custom 时再加底座与两个路径文本框。
 * @param props - 这一条轴的字段名、草稿、禁用状态、翻译与编辑回调。
 * @returns 这一条轴的控件。
 */
function AxisFields(props: {
  readonly field: AxisField
  readonly row: AxisRow
  readonly disabled: boolean
  readonly t: (key: DualAxisLocaleKey) => string
  readonly onEdit: (draft: AxisDraft) => void
  readonly onReset: () => void
}): ReactNode {
  const { draft } = props.row
  const t = props.t
  const title = t(titleKey(props.field))
  const edit = (patch: Partial<AxisDraft>): void => { props.onEdit({ ...draft, ...patch }) }
  return createElement('div', { 'data-dsh-axis': props.field, style: { display: 'grid', gap: '6px' } },
    createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
      createElement('span', { style: { fontWeight: 600, minWidth: '5rem' } }, title),
      createElement('label', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        createElement('span', { style: { fontSize: '12px' } }, t('kindLabel')),
        createElement('select', {
          'data-dsh-axis-kind': props.field,
          'aria-label': title + ' ' + t('kindLabel'),
          value: draft.kind,
          disabled: props.disabled,
          onChange: (event: ChangeEvent<HTMLSelectElement>) => { edit({ kind: event.target.value as AxisKind }) },
        }, AXIS_KINDS.map(kind => createElement('option', { key: kind, value: kind }, t(
          kind === 'deny' ? 'kindDeny' : kind === 'workspace' ? 'kindWorkspace' : kind === 'all' ? 'kindAll' : 'kindCustom',
        ))))),
      props.row.overridden
        ? createElement('span', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center', fontSize: '12px', opacity: 0.7 } },
          t('overridden'),
          createElement('button', {
            type: 'button',
            'data-dsh-axis-reset': props.field,
            disabled: props.disabled,
            style: { fontSize: '12px', cursor: 'pointer' },
            onClick: props.onReset,
          }, t('reset')))
        : null),
    createElement('div', { style: { opacity: 0.7, fontSize: '12px' } }, t(hintKey(props.field))),
    draft.kind !== 'custom' ? null : createElement('div', { style: { display: 'grid', gap: '6px', paddingLeft: '1rem' } },
      createElement('label', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        createElement('span', { style: { fontSize: '12px', minWidth: '3rem' } }, t('baseLabel')),
        createElement('select', {
          'data-dsh-axis-base': props.field,
          'aria-label': title + ' ' + t('baseLabel'),
          value: draft.base,
          disabled: props.disabled,
          onChange: (event: ChangeEvent<HTMLSelectElement>) => { edit({ base: event.target.value as AxisBase }) },
        }, AXIS_BASES.map(base => createElement('option', { key: base, value: base }, t(
          base === 'deny' ? 'baseDeny' : base === 'workspace' ? 'baseWorkspace' : 'baseAll',
        ))))),
      createElement('label', { style: { display: 'grid', gap: '2px' } },
        createElement('span', { style: { fontSize: '12px' } }, t('allowLabel')),
        createElement('textarea', {
          'data-dsh-axis-allow': props.field,
          'aria-label': title + ' ' + t('allowLabel'),
          rows: 3,
          spellCheck: false,
          value: draft.allow,
          disabled: props.disabled,
          style: { fontFamily: 'monospace', width: '100%' },
          onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { edit({ allow: event.target.value }) },
        })),
      createElement('label', { style: { display: 'grid', gap: '2px' } },
        createElement('span', { style: { fontSize: '12px' } }, t('denyLabel')),
        createElement('textarea', {
          'data-dsh-axis-deny': props.field,
          'aria-label': title + ' ' + t('denyLabel'),
          rows: 3,
          spellCheck: false,
          value: draft.deny,
          disabled: props.disabled,
          style: { fontFamily: 'monospace', width: '100%' },
          onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { edit({ deny: event.target.value }) },
        }))),
    draft.problem === '' ? null : createElement('div', { style: { fontSize: '12px', opacity: 0.85 } }, draft.problem),
  )
}

/**
 * 配置行本体：两条轴各一组控件，加一个保存、一个放弃、以及每条轴自己的
 * 「恢复默认」。
 * @param props - 页面在 \`plugins.row.config\` 渲染点下发的 \`view\` 与表单面，加当前语言的翻译。
 * @returns 摘要行，或带控件的表单。
 */
export function DualAxisRow(props: DualAxisRowProps): ReactNode {
  const t = props.t
  const form = props.form
  // 宿主没装 \`@t4r71/dsh-dual-axis\`、或那个设置节没有被服务时，页面不下发表单：
  // 这一行没有可改的值。页面自己把这种行渲染成缺失描述的兜底，这里只回一句说明。
  // 命名空间名不给死字面量：这一行的设置节就是它在条目树里的行 id（插件页用
  // `formFor(openRow.rowId)` 取表单），文案跟着同一个常量走。
  if (form === undefined) return createElement('div', null, t('unavailable', { ns: DUAL_AXIS_ROW_ID }))
  return createElement(DualAxisForm, { view: props.view, form, t })
}

/** {@link DualAxisForm} 的 props：页面下发的 view、表单面与翻译。 */
interface DualAxisFormProps {
  /** 页面要的视图：摘要行还是整页表单。 */
  readonly view: 'summary' | 'page'
  /** 页面下发的表单面：当前快照与一次原子提交。 */
  readonly form: DualAxisRowForm
  /** 当前语言的翻译。 */
  readonly t: (key: DualAxisLocaleKey) => string
}

/**
 * 一个规则组的控件：id、名字、默认加载勾选、删除，以及读侧与写侧各两个路径框。
 *
 * 两侧各自可空 —— 一个组可以只给读侧、只给写侧或两者都给（规格 §「组的规则可只
 * 覆盖一根轴」）。两侧都空的组是合法的：内容随时可改，先建出来再填是正常用法。
 * 四个路径框用 \`data-dsh-group-side\`、\`data-dsh-group-entry\` 与 \`data-dsh-group-index\`
 * 三件套定位，而不是四组写死的属性名：两侧的结构本来就是同一份。
 * @param props - 组在这份草稿里的位置、草稿本身、禁用状态、翻译与编辑回调。
 * @returns 这一个组的控件。
 */
function GroupFields(props: GroupFieldsProps): ReactNode {
  const draft = props.draft
  const t = props.t
  const index = props.index
  const ordinal = String(index + 1)
  /** 改这个组的某一侧规则。 */
  const editSide = (which: 'read' | 'write', patch: Partial<GroupAxisDraft>): void => {
    props.onEdit(which === 'read'
      ? { read: { ...draft.read, ...patch } }
      : { write: { ...draft.write, ...patch } })
  }
  /** 这个组的一条轴的两个路径框。 */
  const side = (which: 'read' | 'write'): ReactNode => {
    const rules = which === 'read' ? draft.read : draft.write
    const sideName = t(which === 'read' ? 'groupSideRead' : 'groupSideWrite')
    const area = (entry: 'allow' | 'deny'): ReactNode => createElement('label',
      { style: { display: 'grid', gap: '2px' } },
      createElement('span', { style: { fontSize: '12px' } }, t(entry === 'allow' ? 'allowLabel' : 'denyLabel')),
      createElement('textarea', {
        'data-dsh-group-side': which,
        'data-dsh-group-entry': entry,
        'data-dsh-group-index': index,
        'aria-label': sideName + ' ' + t(entry === 'allow' ? 'allowLabel' : 'denyLabel'),
        rows: 2,
        spellCheck: false,
        value: rules[entry],
        disabled: props.disabled,
        style: { fontFamily: 'monospace', width: '100%' },
        onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { editSide(which, { [entry]: event.target.value }) },
      }))
    return createElement('div', { style: { display: 'grid', gap: '4px', paddingLeft: '0.5rem' } },
      createElement('div', { style: { fontSize: '12px', fontWeight: 600 } }, sideName),
      area('allow'),
      area('deny'))
  }
  return createElement('div', {
    'data-dsh-group': index,
    style: {
      display: 'grid',
      gap: '6px',
      padding: '8px',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: '8px',
    },
  },
    createElement('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
      createElement('label', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
        createElement('span', { style: { fontSize: '12px' } }, t('groupIdLabel')),
        createElement('input', {
          type: 'text',
          'data-dsh-group-id': index,
          'aria-label': t('groupIdLabel') + ' ' + ordinal,
          value: draft.id,
          disabled: props.disabled,
          spellCheck: false,
          style: { fontFamily: 'monospace', width: '10rem' },
          onChange: (event: ChangeEvent<HTMLInputElement>) => { props.onEdit({ id: event.target.value }) },
        })),
      createElement('label', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
        createElement('span', { style: { fontSize: '12px' } }, t('groupNameLabel')),
        createElement('input', {
          type: 'text',
          'data-dsh-group-name': index,
          'aria-label': t('groupNameLabel') + ' ' + ordinal,
          value: draft.name,
          disabled: props.disabled,
          onChange: (event: ChangeEvent<HTMLInputElement>) => { props.onEdit({ name: event.target.value }) },
        })),
      createElement('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px' } },
        createElement('input', {
          type: 'checkbox',
          'data-dsh-group-default': index,
          checked: draft.default,
          disabled: props.disabled,
          onChange: (event: ChangeEvent<HTMLInputElement>) => { props.onEdit({ default: event.target.checked }) },
        }),
        t('groupDefaultLoad')),
      createElement('button', {
        type: 'button',
        'data-dsh-group-remove': index,
        disabled: props.disabled,
        style: { fontSize: '12px', cursor: 'pointer' },
        onClick: props.onRemove,
      }, t('groupsRemove'))),
    createElement('div', { style: { fontSize: '12px', opacity: 0.7 } }, t('groupAxesHint')),
    side('read'),
    side('write'),
  )
}

/** {@link GroupFields} 的 props。 */
interface GroupFieldsProps {
  /** 这个组在组库里的位置；四个路径框上的 \`data-dsh-group-index\` 就是它。 */
  readonly index: number
  /** 这个组的草稿。 */
  readonly draft: RuleGroupDraft
  /** 设置文档不可写、或正在保存时为真。 */
  readonly disabled: boolean
  /** 这一行的翻译座位。 */
  readonly t: RowTranslate
  /** 改这个组的某个成员。 */
  readonly onEdit: (patch: Partial<RuleGroupDraft>) => void
  /** 从这个组库里删掉这个组。 */
  readonly onRemove: () => void
}
/**
 * 拿到表单面之后的表单本体。页面只在 \`view === 'page'\` 时给出 form，因此
 * \`summary\` 分支读的是设置文档里已生效的轴值，与 \`page\` 分支同一份快照。
 * @param props - 视图、表单面与翻译。
 * @returns 一句话摘要，或带控件的表单。
 */
function DualAxisForm(props: DualAxisFormProps): ReactNode {
  const form = props.form
  const t = props.t
  const drafts = useDrafts(form, t)
  const text = textOf(t)
  const stored = form.state.value ?? {}
  // 摘要行读的是已生效的轴值本身，不是可编辑草稿：草稿把路径拆成了多行文本，
  // 那是控件的形状，不是这条轴的形状。
  const summary = AXES
    .map(field => `${t(titleKey(field))}: ${describeAxis(axisValueOf(stored[field]) ?? fallbackOf(field), text)}`)
    .join(' · ')
  if (props.view === 'summary') return summary
  if (form.state.status === 'loading') return createElement('div', null, t('loading'))
  const disabled = !form.state.writable || drafts.saving
  return createElement('div', { style: { display: 'grid', gap: '12px', maxWidth: '760px' } },
    createElement('div', null, summary),
    createElement('div', { style: { fontSize: '12px', opacity: 0.7 } }, t('live')),
    ...AXES.map(field => createElement(AxisFields, {
      key: field,
      field,
      row: drafts.rows[field],
      disabled,
      t,
      onEdit: (draft: AxisDraft) => { drafts.edit(field, draft) },
      onReset: () => { drafts.reset(field) },
    })),
    createElement('div', { 'data-dsh-groups': '', style: { display: 'grid', gap: '8px' } },
      createElement('div', { style: { fontWeight: 600 } }, t('groupsTitle')),
      createElement('div', { style: { fontSize: '12px', opacity: 0.7 } }, t('groupsHint')),
      drafts.groups.length === 0
        ? createElement('div', { style: { fontSize: '12px', opacity: 0.7 } }, t('groupsEmpty'))
        : null,
      ...drafts.groups.map((group, index) => createElement(GroupFields, {
        key: String(index),
        index,
        draft: group,
        disabled,
        t,
        onEdit: (patch: Partial<RuleGroupDraft>) => {
          drafts.editGroups(drafts.groups.map((current, at) => at === index ? { ...current, ...patch } : current))
        },
        onRemove: () => { drafts.editGroups(drafts.groups.filter((_current, at) => at !== index)) },
      })),
      createElement('button', {
        type: 'button',
        'data-dsh-group-add': '',
        disabled,
        style: { justifySelf: 'start', fontSize: '12px', cursor: 'pointer' },
        onClick: () => { drafts.editGroups([...drafts.groups, emptyGroupDraft(drafts.groups)]) },
      }, t('groupsAdd')),
      drafts.groupProblem === ''
        ? null
        : createElement('div', { role: 'alert', style: { fontSize: '12px' } }, drafts.groupProblem),
      createElement('div', { style: { fontSize: '12px', opacity: 0.7 } }, t('groupsDefaultHint')),
      createElement('div', { style: { fontSize: '12px', opacity: 0.7 } }, t('groupsDefaultHintCustom'))),
    createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
      createElement('button', {
        type: 'button',
        'data-dsh-axis-save': '',
        disabled: disabled || !drafts.dirty || drafts.invalid !== '',
        onClick: drafts.save,
      }, t(drafts.saving ? 'saving' : 'save')),
      createElement('button', {
        type: 'button',
        disabled: !drafts.dirty || drafts.saving,
        onClick: drafts.discard,
      }, t('discard')),
      drafts.failed ? createElement('span', { style: { fontSize: '12px' } }, t('failed')) : null,
      drafts.invalid !== '' ? createElement('span', { style: { fontSize: '12px' } }, drafts.invalid) : null,
      !form.state.writable ? createElement('span', { style: { fontSize: '12px' } }, t('readOnly')) : null),
  )
}

/**
 * 挂载配置行：注册词典，再把这一行注册到插件页的 \`plugins.row.config\`。
 * 表单由页面下发，这里不再自持任何 scope。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(DUAL_AXIS_LOCALE_NS, { zh, en }), 'dual-axis: dictionaries')
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config',
    key: DUAL_AXIS_ROW_KEY,
    locale: DUAL_AXIS_LOCALE_NS,
  }, DualAxisRow))
}
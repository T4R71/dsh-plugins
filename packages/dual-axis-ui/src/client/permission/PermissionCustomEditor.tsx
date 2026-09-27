/**
 * 一条轴的 `custom` 路径编辑器：底座下拉加两个绝对路径列表。
 *
 * 这个编辑器是让 `custom` 成为一条完整策略语句的东西。另外三个取值本身各自就是
 * 完整语句 —— 选中即提交 —— 而 `custom` 必须带底座，宿主的解析器宁可拒绝一条裸的
 * `write:custom` 也不肯替用户猜一个。所以下拉里选中 `custom` 时不直接提交，而是展开
 * 这个编辑器，由它提交完整的 `axis:custom:base=…,allow=…,deny=…` 参数。
 *
 * 两个路径框都是一行一条绝对路径。全局设置文档里存的是列表，而这个界面没有路径
 * 选择器，所以文本是诚实的载体；一条相对路径会挡住提交并说明原因，而不是被解析到
 * 某个用户从没指定过的目录上去。
 *
 * 提交要过一次风险确认：`base=all` 或带额外放行路径的 `custom` 都会放大该轴的
 * 访问范围，所以「应用」先落到确认框，只有勾选并确认才真的写下去。不放大权限的
 * 草稿（例如在 `workspace` 底座上只加排除路径）不过闸，免得确认变成噪音。
 *
 * @module @deepseek-ai/dsh-client-ui-permission-presets/client/PermissionCustomEditor
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NarrowingNotice, PermissionAxis } from './presentation.ts'
import type { PermissionAccessKey } from './locales.ts'
import type { PermissionSelectProps } from './PermissionSelect.tsx'
import {
  AXIS_BASES, customFragment, draftScope, fragmentWidensAccess, groupChoicesOf, initialDraft,
  type AxisBase, type AxisDraft, type AxisEditorScope, type AxisEditorValue, type GroupChoice,
  type RuleGroupOption,
} from './axis-editor.ts'
import css from './PermissionSelect.module.css'

// 起始取值的形状与初值规则住在纯函数层：它们不碰 React，因此能被直接测到。
export type { AxisEditorValue } from './axis-editor.ts'

/** 一条轴的路径编辑器的 props。 */
export interface PermissionCustomEditorProps {
  /** 这条编辑器写哪条轴；两个下拉没有可见标题，所以文案自己说明轴名。 */
  axis: PermissionAxis
  /** 该轴在当前会话里的取值，编辑器以它为初值；会话还没有这条轴时为 undefined。 */
  current: AxisEditorValue | undefined
  /** 该轴在部署设置里的取值；会话没有这条轴（{@link current} 缺席）时用它。 */
  global: AxisEditorValue | undefined
  /**
   * 写轴被读轴收窄的结论，由宿主解算后发布（见 {@link NarrowingNotice}）。
   * 只有写轴有：不变量讲的就是写范围。undefined 表示这条会话当刻没有被收窄。
   */
  notice: NarrowingNotice | undefined
  /** 设置页当前定义的规则组；编辑器在渲染时调它，取的就是当刻那一份。 */
  groups: () => readonly RuleGroupOption[]
  /** 输入框是否被锁住（只读会话，或没有活绑定）。 */
  locked: boolean
  /** 该轴是否已有一次提交在飞。 */
  busy: boolean
  /**
   * 提交完整的轴参数；宿主结清**并且文档里真的出现这条取值**之后兑现。
   * 
   * 第二个参数是这份草稿落成记录之后的形状（{@link draftScope}）。它不是给宿主看的
   * —— 宿主只收那一个参数串 —— 而是给提交路径核对用的：宿主对自己没写的改动也会回
   * 「命令执行了」，只有拿写入后的记录比对才能分辨「写进去了」与「被拒了没写」。
   */
  onSubmit: (args: string, expected: AxisEditorScope) => Promise<boolean>
  /** 不提交就关掉编辑器。 */
  onDismiss: () => void
  t: PermissionSelectProps['t']
}

/** 一句拒绝说明对应的词典键。 */
type ProblemKey =
  | 'editor.problemBase'
  | 'editor.problemPath'
  | 'editor.problemComma'
  | 'editor.problemGroupId'

/** 该轴在该取值下的词典键前缀（读轴写轴各一套文案）。 */
function axisKeys(axis: PermissionAxis): {
  title: PermissionAccessKey
  base: PermissionAccessKey
  allow: PermissionAccessKey
  deny: PermissionAccessKey
} {
  return axis === 'read'
    ? { title: 'editor.readTitle', base: 'editor.readBase', allow: 'editor.readAllow', deny: 'editor.readDeny' }
    : { title: 'editor.writeTitle', base: 'editor.writeBase', allow: 'editor.writeAllow', deny: 'editor.writeDeny' }
}

/** 一个底座取值对应的词典键。 */
function baseOptionKey(base: AxisBase): PermissionAccessKey {
  return base === 'deny' ? 'editor.baseDeny' : base === 'workspace' ? 'editor.baseWorkspace' : 'editor.baseAll'
}

/**
 * 渲染一条轴的 `custom` 路径编辑器。
 *
 * 草稿从会话当前值起步，**任何取值都算**：这条会话的轴是这个界面表达的对象，
 * 编辑器打开时显示别的值（例如部署默认）就会与它旁边那个下拉自相矛盾。只有
 * 会话值缺席时才退到该轴的部署默认值。一次失败的提交保留草稿并显示一句可读的话，
 * 而不是抛出去，所以被拒的审批留下的是一个还能用的编辑器。
 * @param props - 轴、起始值、写入口与词典座位。
 * @returns 底座下拉、两个路径框与提交行。
 */
export function PermissionCustomEditor({
  axis, current, global, notice, groups, locked, busy, onSubmit, onDismiss, t,
}: PermissionCustomEditorProps): ReactNode {
  const keys = axisKeys(axis)
  // 会话自己的轴是唯一优先的初值：这个界面表达的就是这条会话。部署设置只在
  // 会话还没有这条轴时兜底，部署默认值再兜底。
  const [draft, setDraft] = useState<AxisDraft>(() => initialDraft(axis, current, global))
  // 上一次提交为什么没落地。'none' 是常态；两者分开是因为它们对用户的意义不同：
  // 'refused' = 命令跑完了，但设置文档里没有出现这次改动（宿主拒绝了它，或者写入丢了），
  // 'failed' = 这次提交根本没走完（没有活绑定、传输失败）。
  const [failure, setFailure] = useState<'none' | 'refused' | 'failed'>('none')
  const [sending, setSending] = useState(false)
  // 待确认的完整参数串与它落成记录后的形状。非 null 就是「这份草稿放大了权限，等人
  // 确认」，此时并不提交。
  const [gate, setGate] = useState<{ args: string; expected: AxisEditorScope } | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const parsed = customFragment(draft, key => t(problemFor(key)))
  const problem = parsed.ok ? '' : parsed.problem
  // 设置页定义的组 + 这条会话引用了但设置页已经不定义的 id：后者缺席就等于
  // 「打开编辑器再应用」会静默删掉一条引用，所以它照样列出来并保持勾选。
  const choices = groupChoicesOf(groups(), draft.groups)
  const edit = (patch: Partial<AxisDraft>): void => { setDraft(state => ({ ...state, ...patch })) }
  const toggleGroup = (id: string, checked: boolean): void => {
    edit({ groups: checked ? [...draft.groups, id] : draft.groups.filter(current => current !== id) })
  }
  const disabled = locked || busy || sending || gate !== null

  /**
   * 真正提交一份已经完整的参数串。
   *
   * 只有文档里真的出现了这次取值才关掉编辑器：宿主对自己**没有**写入的命令同样会回
   * 一句「命令执行了」（它只回答命令有没有被解析到，见 `PermissionSelectInjected.select`），
   * 所以一次被拒的写入在旧实现里与成功一模一样 —— 编辑器关掉、下拉回到原值、设置文档
   * 没变、界面上一个字都没有。
   */
  const send = (args: string, expected: AxisEditorScope): void => {
    setSending(true)
    setFailure('none')
    void onSubmit(args, expected)
      .then((landed) => {
        setSending(false)
        if (landed) onDismiss()
        else setFailure('refused')
      })
      .catch(() => {
        setSending(false)
        setFailure('failed')
      })
  }

  const submit = (): void => {
    if (!parsed.ok) return
    setFailure('none')
    const entry = `${axis}:custom:${parsed.fragment}`
    const expected = draftScope(draft)
    // 放大权限的草稿先过确认闸；其余草稿（例如只加排除路径）直接提交。
    if (fragmentWidensAccess(parsed.fragment)) {
      setAcknowledged(false)
      setGate({ args: entry, expected })
      return
    }
    send(entry, expected)
  }

  return (
    <div className={css.editor} data-dsh-axis-editor={axis}>
      <div className={css.editorTitle}>{t(keys.title)}</div>
      {notice === undefined ? null : (
        <div className={css.narrowing} data-dsh-axis-narrowing={axis} role="status">
          <div className={css.narrowingTitle} data-dsh-narrowing-title>{notice.title}</div>
          <div className={css.narrowingBody}>{t('narrowing.body')}</div>
          <div className={css.narrowingRoots} data-dsh-narrowing-roots>{notice.removed}</div>
          {notice.lostUnbounded === '' ? null : (
            <div className={css.narrowingBody}>{notice.lostUnbounded}</div>
          )}
        </div>
      )}
      <label className={css.editorRow}>
        <span className={css.editorLabel}>{t('editor.base')}</span>
        <select
          className={css.editorSelect}
          data-dsh-axis-base={axis}
          aria-label={t(keys.base)}
          value={draft.base}
          disabled={disabled}
          onChange={(event) => { edit({ base: event.target.value as AxisBase }) }}
        >
          {AXIS_BASES.map(base => (
            <option key={base} value={base}>{t(baseOptionKey(base))}</option>
          ))}
        </select>
      </label>
      <label className={css.editorField}>
        <span className={css.editorLabel}>{t('editor.allow')}</span>
        <textarea
          className={css.editorArea}
          data-dsh-axis-allow={axis}
          aria-label={t(keys.allow)}
          rows={3}
          spellCheck={false}
          value={draft.allow}
          disabled={disabled}
          onChange={(event) => { edit({ allow: event.target.value }) }}
        />
      </label>
      <label className={css.editorField}>
        <span className={css.editorLabel}>{t('editor.deny')}</span>
        <textarea
          className={css.editorArea}
          data-dsh-axis-deny={axis}
          aria-label={t(keys.deny)}
          rows={3}
          spellCheck={false}
          value={draft.deny}
          disabled={disabled}
          onChange={(event) => { edit({ deny: event.target.value }) }}
        />
      </label>
      <div className={css.editorField} data-dsh-axis-groups={axis}>
        <span className={css.editorLabel}>{t('editor.groups')}</span>
        {choices.length === 0 ? (
          <div className={css.editorHint}>{t('editor.groupsEmpty')}</div>
        ) : (
          <div className={css.groupList}>
            {choices.map(choice => (
              <label key={choice.id} className={css.groupRow} data-dsh-group-choice={choice.id}>
                <input
                  type="checkbox"
                  data-dsh-group-check={choice.id}
                  checked={choice.checked}
                  disabled={disabled}
                  onChange={(event) => { toggleGroup(choice.id, event.target.checked) }}
                />
                <span className={css.groupName}>{choice.name}</span>
                {choice.name === choice.id ? null : <span className={css.groupId}>{choice.id}</span>}
                <span className={css.groupCoverage}>{coverageLabel(choice, t)}</span>
                {!choice.missing ? null : <span className={css.groupMissing}>{t('editor.groupMissing')}</span>}
              </label>
            ))}
          </div>
        )}
      </div>
      <div className={css.editorHint}>{t('editor.hint')}</div>
      {problem === '' ? null : <div className={css.editorProblem} role="alert">{problem}</div>}
      {failure === 'none' ? null : (
        <div className={css.editorProblem} role="alert">
          {t(failure === 'refused' ? 'editor.notStored' : 'editor.failed')}
        </div>
      )}
      <div className={css.editorActions}>
        <button
          type="button"
          className={css.editorSubmit}
          data-dsh-axis-submit={axis}
          disabled={disabled || problem !== ''}
          onClick={submit}
        >{t(sending ? 'editor.sending' : 'editor.submit')}</button>
        <button
          type="button"
          className={css.editorCancel}
          disabled={sending}
          onClick={onDismiss}
        >{t('editor.cancel')}</button>
      </div>
      {gate === null ? null : (
        <RiskConfirmation
          open
          title={t('confirm.title')}
          description={t('confirm.description')}
          acknowledgeLabel={t('confirm.acknowledge')}
          cancelLabel={t('confirm.cancel')}
          closeLabel={t('close')}
          confirmLabel={t('confirm.enable')}
          acknowledged={acknowledged}
          disabled={locked}
          onAcknowledgedChange={setAcknowledged}
          onCancel={() => { setAcknowledged(false); setGate(null) }}
          onConfirm={() => {
            const pending = gate
            setGate(null)
            setAcknowledged(false)
            if (pending !== null) send(pending.args, pending.expected)
          }}
        />
      )}
    </div>
  )
}

/**
 * 一个组覆盖哪些轴的说明文案。
 *
 * 选择器两个并排、没有可见标题，所以「这个组对这根轴什么也不做」必须明说：写侧组
 * 出现在读轴的选择器里不报错，但它对读轴一条规则也不贡献。
 * @param choice - 多选列表里的一行。
 * @param t - 词典座位。
 * @returns 一句话说明。
 */
function coverageLabel(choice: GroupChoice, t: PermissionSelectProps['t']): string {
  if (choice.missing) return t('editor.groupMissing')
  if (choice.coverage === 'both') return t('editor.groupBoth')
  if (choice.coverage === 'read') return t('editor.groupRead')
  if (choice.coverage === 'write') return t('editor.groupWrite')
  return t('editor.groupNone')
}

/** 一句拒绝说明对应的词典键。 */
function problemFor(key: 'baseUnknown' | 'notAbsolute' | 'commaUnsupported' | 'groupUnsupported'): ProblemKey {
  if (key === 'baseUnknown') return 'editor.problemBase'
  if (key === 'notAbsolute') return 'editor.problemPath'
  if (key === 'commaUnsupported') return 'editor.problemComma'
  return 'editor.problemGroupId'
}

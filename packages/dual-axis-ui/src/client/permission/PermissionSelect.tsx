import { useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutlineMedium, Menu, RiskConfirmation, SHIELD_OUTLINE_PATH,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { PermissionAxis, PermissionAxisValue } from './presentation.ts'
import type { PermissionCatalogState } from './catalog.ts'
// Type-only: pulls the conversation-owned permission slot declaration and the
// session-scope standard props (sessionId) into this package's Client face.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PERMISSION_ACCESS_NS } from './locales.ts'
import { axisLabel, axisValueName, axisValueOf, narrowingNotice } from './presentation.ts'
import type { DualAxisAxisWire, DualAxisNarrowingWire } from './presentation.ts'
import type { SessionAxesView } from './session-axes-data.ts'
import { widensAccess, type RuleGroupOption } from './axis-editor.ts'
import {
  PermissionCustomEditor, type AxisEditorValue,
} from './PermissionCustomEditor.tsx'
import css from './PermissionSelect.module.css'

/* Shield glyphs (design set 1556) over the ui-primitives shield contour, one
   mark per axis VALUE: crossed-off shield = denied, shield + check = the
   session workspace, shield + exclamation = the whole host, shield + path
   list = custom paths. currentColor so the trigger and menu rows tint them
   with their own text color. */

/** Every value an axis offers when the Host catalog advertises none of the four. */
const AXIS_FALLBACK_VALUES: readonly PermissionAxisValue[] = ['deny', 'workspace', 'all', 'custom']

/**
 * Glyph key: one of the four values, or `unknown` for an axis this build cannot
 * name (no stored record, or a kind a newer host wrote).
 */
type PermissionGlyphKey = PermissionAxisValue | 'unknown'

const permissionGlyphs = new Map<PermissionGlyphKey, ReactNode>([
  ['deny', (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d={SHIELD_OUTLINE_PATH} stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      <path d="M5.4 5.4L10.6 10.6M10.6 5.4L5.4 10.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )],
  ['workspace', (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d={SHIELD_OUTLINE_PATH} stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      <path d="M12.1654 5.7552L8.9447 9.41475C8.73044 9.65816 8.53628 9.8804 8.35774 10.0423C8.1713 10.2114 7.94235 10.3717 7.64016 10.4254C7.48207 10.4535 7.32 10.4552 7.16151 10.4294C6.85843 10.3801 6.62728 10.2223 6.43836 10.0559C6.25752 9.89653 6.06037 9.67732 5.84264 9.43705L4.72925 8.20897L5.63557 7.38707L6.74897 8.61594C6.98603 8.87755 7.12974 9.03533 7.24673 9.13839C7.31033 9.19443 7.34485 9.21476 7.35823 9.22122C7.38068 9.22484 7.40352 9.22515 7.42593 9.22122C7.40522 9.22502 7.42893 9.23294 7.53583 9.136C7.65132 9.03126 7.79316 8.87139 8.02643 8.60638L11.2479 4.94763L12.1654 5.7552Z" fill="currentColor" />
    </svg>
  )],
  ['all', (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d={SHIELD_OUTLINE_PATH} stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      <path d="M9.10094 4.5V8.75939H7.59888V4.5H9.10094Z" fill="currentColor" />
      <path d="M9.10094 9.8114V11.5H7.59888V9.8114H9.10094Z" fill="currentColor" />
    </svg>
  )],
  ['custom', (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d={SHIELD_OUTLINE_PATH} stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      <path d="M6.4 5.2H11.6M6.4 7.6H11.6M6.4 10H9.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )],
  ['unknown', (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d={SHIELD_OUTLINE_PATH} stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      <path d="M5.6 6.6C5.6 5.6 6.15 5 7.05 5C7.95 5 8.5 5.5 8.5 6.3C8.5 7.4 7.05 7.4 7.05 8.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      <path d="M7.05 10.3V10.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )],
])

/**
 * Glyph for one axis value. An absent value gets the `unknown` glyph rather
 * than nothing: the seat still has to read as an axis control.
 * @param value - the axis value, or `undefined` when none can be named.
 * @returns the glyph node.
 */
function permissionGlyph(value: PermissionAxisValue | undefined): ReactNode {
  return permissionGlyphs.get(value ?? 'unknown')
}

/** Locale key naming one axis's dropdown. */
const AXIS_LABEL_KEY: Record<PermissionAxis, 'readLabel' | 'writeLabel'> = {
  read: 'readLabel',
  write: 'writeLabel',
}

/** Business face injected by the permission package's slot registration. */
export interface PermissionSelectInjected {
  hooks: {
    /** One process catalog shared with the slash popup (axis values + defaults). */
    permissionCatalog: HostObservable<PermissionCatalogState>
  }
  /**
   * Submit one axis switch for the current session. Each dropdown writes only
   * its own axis. The three closed values are complete statements and go
   * straight through; `custom` is not one — it is assembled by the path editor,
   * which is why this surface never sends a bare `<axis>:custom`.
   *
   * `expected` is the value the submission MEANS, and it is what makes a refused
   * write visible: the host's `Session.command` answers whether the line resolved
   * to a registered command, not whether that command succeeded
   * (`packages/api/session-controller/src/client/sessions/session.ts:387-391` —
   * `matched: result.value !== undefined`), so a `/axis` entry the host refuses
   * settles as a perfectly ordinary admission. The implementation therefore reads
   * the stored pair back out of the settings document and answers `false` when it
   * never becomes `expected`.
   * @param axis - which axis the entry writes.
   * @param args - the complete entry string after the command name.
   * @param expected - the axis value this entry is meant to store.
   * @returns whether the stored pair now carries `expected` on `axis`.
   */
  select: (axis: PermissionAxis, args: string, expected: DualAxisAxisWire) => Promise<boolean>
  /**
   * The deployment default for one axis, read from the dual-axis settings
   * section — the pair a NEW session starts from. Only a conversation that has
   * no value of its own for that axis opens the editor on it; a live session's
   * own axes are what the editor opens on. Undefined when the deployment serves
   * no such section or keeps preferences process-local; the editor's own
   * deployment fallback (read `all`, write `workspace`) covers that case
   * without an error and without widening the write axis.
   * @param axis - which axis's deployment default to read.
   * @returns the deployment value, or undefined when there is none.
   */
  global: (axis: PermissionAxis) => PermissionAxisEditorSource | undefined
  /**
   * 设置页当前定义的规则组，编辑器多选列表的来源。
   *
   * 与 {@link global} 不同的是这里每次都取**当刻**的库：编辑器只把库读成一份勾选
   * 列表，用户勾了什么存在它自己的草稿里，所以设置页新增或改名一个组只是多出/改掉
   * 一行，不会替掉已经勾好的清单。
   * @returns 每个可用的组一项；设置页没有定义任何组时是空列表。
   */
  groupLibrary: () => readonly RuleGroupOption[]
  /**
   * 这条会话当刻的那一对轴，从配置文档镜像里按会话 id 读。
   *
   * 与 {@link groupLibrary} 同一条读路径（共享的 describe 镜像），但它是**订阅式**的：
   * 宿主改完轴会发 `settings/document-updated`，镜像重读，组件跟着重渲染。
   */
  sessionAxes: SessionAxesInjected
}

/** 会话轴取值面：一个订阅式 hook 加一个同步取值函数。 */
export interface SessionAxesInjected {
  /**
  * React hook：当前会话该显示的那一对轴，以及那份取值的来源。
  *
  * 返回的永远是三态。没有记录时**不是** undefined 而是 `{ state: 'default' }`：
  * 那种情形下宿主执行的正是这条会话的**种子**（设置页那一行，子代理子会话则是父会话
  * 当刻的记录），界面按同一份计算显示同一个值 —— 显示内置默认对就会「界面显示 A、
  * 宿主执行 B」，设置页默认是「禁止读」时那一轮仍会被当成「全盘读」。只有连文档都读
  * 不到时才是 `{ state: 'unknown' }`，由两个下拉如实显示「未设置」。
  * @param sessionId - 当前会话 id。
  * @returns 三态取值。
  */
  useAxes: (sessionId: string | undefined) => SessionAxesView
  /**
  * 同一个值的同步读取，供非 React 调用方（编辑器初值、提交后的核对）使用。
  * @param sessionId - 当前会话 id。
  * @returns 三态取值。
  */
  axesOf: (sessionId: string | undefined) => SessionAxesView
}

/** One axis's value as the editor reads it: the kind plus the custom detail. */
export type PermissionAxisEditorSource = AxisEditorValue

/** Complete props derived from the conversation slot, injected hooks, and locale. */
export type PermissionSelectProps =
  PropsRuntime<'conversation.input.permission'>
  & InjectFace<PermissionSelectInjected>
  & PropsLocale<typeof PERMISSION_ACCESS_NS>

/** One axis dropdown: its current value, its offered values, and its own seats. */
interface AxisPickerProps {
  /** Which axis this dropdown writes. */
  axis: PermissionAxis
  /**
  * The axis's current value, or `undefined` when none can be claimed.
  *
  * `undefined` is a first-class state, not a failure: it covers a session whose
  * axis kind this build does not recognize, and a session whose axes cannot be
  * read at all. The dropdown renders either way and says "未设置".
  */
  current: PermissionAxisValue | undefined
  /** The axis's current value WITH its custom detail, so the editor can open on it. */
  currentState: PermissionAxisEditorSource | undefined
  /**
   * What the read axis removed from this session's write range, as the host's own
   * resolution reported it. Absent when the intersection removed nothing.
   *
   * Passed to both seats and rendered by the write one only: it is a property of
   * the write range rather than of either axis value.
   */
  narrowing: DualAxisNarrowingWire | undefined
  /** Every value this axis offers, in the catalog's display order. */
  values: readonly PermissionAxisValue[]
  /** Whether the composer is locked (a read-only session, or no live binding). */
  locked: boolean
  t: PermissionSelectProps['t']
  select: PermissionSelectInjected['select']
  /** This axis's deployment default, the editor's fallback when the session has none. */
  global: (axis: PermissionAxis) => PermissionAxisEditorSource | undefined
  /**
   * 设置页定义的规则组，编辑器多选列表的来源。
   *
   * 传的是读取回调而不是取好的一份：编辑器在**它自己渲染时**取库，于是展开编辑器
   * 那一刻读到的就是设置文档当刻那份。若在父组件渲染时取好再当数据传下去，用户在
   * 设置页删掉一个组之后回到会话，展开的编辑器读到的仍是父组件上一次渲染时的旧库。
   */
  groups: () => readonly RuleGroupOption[]
  /**
   * This axis's optimistic pick, so a settle on one axis never clears the other.
   * Also the flag the parent uses to keep both seats from double-submitting.
   */
  pending: PermissionAxisValue | null
  onPending: (value: PermissionAxisValue | null) => void
}

/**
 * Render one axis dropdown. The two dropdowns keep independent open, busy and
 * confirmation state, so a switch on one axis never disturbs the other's
 * displayed value.
 *
 * Picking `deny` or `workspace` applies directly: neither one widens access.
 * Picking `all` opens the risk confirmation first — it hands the whole host to
 * that axis — and only an acknowledged confirmation submits. Picking `custom`
 * opens {@link PermissionCustomEditor} instead of submitting: `custom` alone is
 * not a policy statement, and the host refuses it rather than guessing a base.
 * The editor runs the same gate on its own submission when that submission
 * widens access, so both routes to a widened axis pass one acknowledgement.
 *
 * The gate is per axis on purpose: the confirmation names the axis it is about,
 * which is the only thing that tells two side-by-side dropdowns apart.
 * @param props - the axis, its values, the locale seat, and the write path.
 * @returns the dropdown trigger and its menu, plus the editor while it is open.
 */
function AxisPicker({
  axis, current, currentState, narrowing, values, locked, t, select, global, groups, pending, onPending,
}: AxisPickerProps) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  // 这条轴自己的待确认取值。两条轴各持一份，于是「哪条轴在等确认」永远不含糊；
  // 确认框的文案由 axis 决定，不会把读轴的确认说成写轴的。
  const [gate, setGate] = useState<PermissionAxisValue | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const shown = pending ?? current
  // 触发器上那一格只写取值本身：「自定义」就是「自定义」，底座与组数不上去 —— 那段明细
  // 在编辑器里看得到，触发器放不下。没有可取的值时说「未设置」，而不是把整块藏掉。
  const shownName = axisValueName(shown, axis, key => t(key))
  // 写轴被读轴收窄的结论，由宿主解算后随这条会话的记录一起发布，位置与两条轴平级
  // （它讲的是**写范围**，不是某一条轴取值的一部分）。只有写轴这一格渲染它：读轴自己的
  // 取值就是它当刻执行的范围，无从被收窄。
  // 传的是 t 本身而不是 `key => t(key)`：通知里的每一句都带参数（{roots} / {title}），
  // 把参数丢掉会让界面上留着一个没替换的占位符，而不是一句人话。
  const notice = axis === 'write' ? narrowingNotice(narrowing, t) : undefined
  // 触发器上那一格**只写取值本身**，收窄不上文字：多一个角标（下面那个 mark），
  // 明细在编辑器里。撑长触发器会把「全盘写」读成另一个档。
  const label = t(AXIS_LABEL_KEY[axis], { name: shownName })
  const marker = notice?.marker ?? null
  const items: MenuEntry[] = values.map(value => ({
    id: value,
    label: axisLabel(value, axis, key => t(key)),
    icon: permissionGlyph(value),
  }))

  /**
   * 真正写下去：乐观取值 → 提交 → 无论成败都收回乐观取值。
   *
   * 乐观取值是给人看的即时反馈，不是结论：`landed` 为假时它被收回，触发器于是回到
   * 当刻真的生效的那个取值，而不是停在一个宿主并没有接受的取值上。
   */
  const settle = (value: PermissionAxisValue, args: string): Promise<boolean> => {
    onPending(value)
    return select(axis, args, { kind: value })
      .catch(() => false)
      .then((landed) => {
        onPending(null)
        return landed
      })
  }

  /**
   * 一次取值改动。放开权限的取值先挂起等确认，其余直接写。
   * @param value - 轴取值。
   * @param args - 交给宿主 `/permission` 的完整参数串。
   * @returns 宿主结清后的结果；挂起期间返回的是确认后的结果。
   */
  const request = (value: PermissionAxisValue, args: string): Promise<boolean> => {
    if (!widensAccess(value)) return settle(value, args)
    setAcknowledged(false)
    setGate(value)
    // 挂起：确认框结清时才走 settle，见 confirm()。
    return Promise.resolve(false)
  }

  /** 确认框点了「启用」：提交这次已经过用户明示同意的改动。 */
  const confirm = (): void => {
    const value = gate
    if (value === null) return
    setGate(null)
    setAcknowledged(false)
    void settle(value, `${axis}:${value}`)
  }

  const choose = (id: string): void => {
    setOpen(false)
    const picked = values.find(value => value === id)
    if (picked === undefined) return
    if (picked === 'custom') {
      // Already running custom paths: reopening the editor is how they get
      // adjusted, so this is not treated as re-picking the displayed value.
      setEditing(true)
      return
    }
    if (picked === shown) return
    // 放开的取值要过确认闸；其余两个取值是完整策略语句且不放大权限，直接写。
    void request(picked, `${axis}:${picked}`)
  }

  return (
    <span className={css.seat}>
      <Menu
        open={open}
        items={items}
        selectedId={shown}
        onSelect={choose}
        onClose={() => { setOpen(false) }}
        side="top"
        portal
        anchor={(
          <button
            type="button"
            className={css.trigger}
            aria-label={label}
            aria-expanded={editing}
            disabled={locked || pending !== null}
            onClick={() => { setOpen(!open) }}
          >
            <span className={css.triggerIcon} aria-hidden>{permissionGlyph(shown)}</span>
            <span className={css.triggerLabel}>{shownName}</span>
            {marker === null ? null : (
              <span
                className={css.narrowingMark}
                data-dsh-narrowing-mark={axis}
                title={marker}
                aria-label={marker}
                role="img"
              />
            )}
            <span className={clsx(css.chevron, open && css.chevronOpen)} aria-hidden>
              <IconChevronDownOutlineMedium />
            </span>
          </button>
        )}
      />
      {editing ? (
        <PermissionCustomEditor
          axis={axis}
          current={currentState}
          global={global(axis)}
          notice={notice}
          groups={groups}
          locked={locked}
          busy={pending !== null}
          onSubmit={(args, expected) => {
            onPending('custom')
            return select(axis, args, expected).finally(() => { onPending(null) })
          }}
          onDismiss={() => { setEditing(false) }}
          t={t}
        />
      ) : null}
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
          onConfirm={confirm}
        />
      )}
    </span>
  )
}

export function PermissionSelect({
  locked, select, global, groupLibrary, sessionAxes, usePermissionCatalog, t, sessionId,
}: PermissionSelectProps) {
  const catalog = usePermissionCatalog(state => state.value)
  // 轴来自配置文档镜像（订阅式）：宿主写完轴会发 settings/document-updated，镜像重读，
  // 这里跟着重渲染。三态取值 —— 文档里没有这条会话的记录时是 `default`，**不是**缺席。
  const view = sessionAxes.useAxes(sessionId)
  const [pending, setPending] = useState<{
    read: PermissionAxisValue | null
    write: PermissionAxisValue | null
  }>({ read: null, write: null })

  // 只等目录：那是本控件另一条与轴无关的能力（过程级预设目录）。轴那一侧**不再**是返回
  // null 的理由 —— 「这条会话在新存储里没有记录」曾经整块藏掉两个下拉，读起来就是功能没了。
  if (catalog === null) return null

  // The catalog supplies the selectable set; the values themselves come from the
  // dual-axis host half's per-session record in the settings document, which is
  // this session's own axis pair. 0.1.7's `permissions` projection carries one
  // whole preset NAME (such as `workspace-write`) instead, which is not an axis
  // value and cannot label a dropdown.
  const axisValues: PermissionAxisValue[] = catalog.options
    .map(option => option.value)
    .filter((value): value is PermissionAxisValue =>
      value === 'deny' || value === 'workspace' || value === 'all' || value === 'custom')
  /**
   * One seat's props. Never returns nothing: an axis this build cannot name is a
   * seat showing "未设置", because a permission control that disappears reads as
   * a removed feature, and the person looking at it has no way to tell the two
   * apart.
   * @param axis - which axis this seat edits.
   * @returns that seat's props.
   */
  const seat = (axis: PermissionAxis): AxisPickerProps => {
    const scope = view.state === 'unknown' ? undefined : view.axes[axis]
    // An unrecognized kind is a broken deployment, not a value to guess at — the
    // seat still renders, saying it has no value rather than showing a wrong one.
    const current = scope === undefined ? undefined : axisValueOf(scope.kind)
    return {
      axis,
      current,
      narrowing: view.state === 'unknown' ? undefined : view.axes.narrowing,
      // The same object the host publishes, so a custom editor opens on this
      // session's real base and path lists. It is the fallback pair when this
      // session has no record (the pair the host is enforcing), and undefined
      // only when there was no document to read at all.
      currentState: scope,
      values: axisValues.length > 0 ? axisValues : AXIS_FALLBACK_VALUES,
      locked,
      t,
      select,
      global,
      // 把读取回调交下去，由编辑器在渲染时取当刻的库；用户勾了什么在编辑器自己的
      // 草稿里，所以库变了只影响列出来的行，不影响这份草稿。
      groups: groupLibrary,
      pending: pending[axis],
      onPending: (value: PermissionAxisValue | null) => {
        setPending(state => ({ ...state, [axis]: value }))
      },
    }
  }

  return (
    <div className={css.axes}>
      <AxisPicker {...seat('read')} />
      <AxisPicker {...seat('write')} />
    </div>
  )
}

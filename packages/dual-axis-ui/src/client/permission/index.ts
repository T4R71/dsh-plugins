/**
 * Permission plugin, browser half. The `/permission` slash popup stays the
 * PRESET picker (a full bundle switch), while the composer control is two
 * independent axis dropdowns — read and write — each carrying one of
 * `deny / workspace / all / custom`, and each displaying its own current
 * value (no preset name is shown). Options read the process catalog (preset
 * contract: id, label, optional detail/badge). The composer's axes read the
 * session `permissions` projection for their CURRENT kinds and the same
 * catalog for the values each axis offers, and submit `/permission
 * <axis>:<value>`. A pick is applied directly: the
 * full-access/full-permission acknowledgement step is gone, because a visible
 * selection is already an explicit one. The General-settings row separately
 * writes the default preset for sessions created later through the host
 * Settings API.
 */
import { useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions, SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  PermissionCatalog, PermissionSelection,
} from '@deepseek-ai/dsh-permission-presets/client'
import type { PermissionAxis } from './presentation.ts'
// Direct dependency: catalog settlements are fenced by the actual connection
// generation rather than by a parallel domain counter.
import type {} from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings slot types (this package registers a General row).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face
// (the settings invalidation rides the allowlist) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { CommandUiContract, SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { ClientSessionContext } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { PermissionCatalogDirectory } from './catalog.ts'
import { PermissionSelect } from './PermissionSelect.tsx'
import type { PermissionSelectInjected, PermissionAxisEditorSource } from './PermissionSelect.tsx'
import { PermissionRow } from './PermissionRow.tsx'
import type { PermissionRowInjected } from './PermissionRow.tsx'
import {
  accessEn, accessZh, en, PERMISSION_ACCESS_NS, zh,
} from './locales.ts'
import { displayPermissionPreset } from './presentation.ts'
import { PermissionPresetSettingsController } from './settings-store.ts'
import { groupOptionsOf, sameStoredAxis } from './axis-editor.ts'
import type { AxisEditorScope } from './axis-editor.ts'
import { SessionAxesDirectory } from './session-axes.ts'
import { sessionAxesView } from './session-axes-data.ts'

export type { AxisLabelKey, PermissionPresetLabelKey } from './presentation.ts'
export type { PermissionRowInjected, PermissionRowProps } from './PermissionRow.tsx'
export type { PermissionCatalogState } from './catalog.ts'
export type {
  PermissionSelectInjected, PermissionSelectProps, PermissionAxisEditorSource,
} from './PermissionSelect.tsx'
export type {
  PermissionDefaultOption, PermissionSettingsState,
} from './settings-store.ts'

/**
 * 双轴组合包在宿主上注册的设置节名（`@t4r71/dsh-dual-axis`）。
 *
 * 0.1.7 的设置命名空间就是 Loader entry id（`packages/settings/settings/src/index.ts`
 * 的 `describe()` 按已装载 entry 投影），而宿主那一行在 `cordis.patch.yml` 里就叫
 * `dual-axis`（`packages/bundle/dual-axis/src/config.ts` 的 `DUAL_AXIS_ROW_ID`）。
 * 0.1.6 的 `sandbox-axis` 已经退役：写它取不到任何值，于是这张表单永远返回
 * undefined，编辑器的部署兜底静默退化成编译期默认。
 *
 * 这一节持有「新会话从哪两条轴开始」。两个下拉的路径编辑器只在**会话还没有这条轴**
 * 时以它为初值；对话级的选择永远优先。
 */
export const DUAL_AXIS_SETTINGS_NAMESPACE = 'dual-axis'

/** 提交之后最多等多久，等这次取值出现在设置文档里。 */
export const AXIS_CONFIRM_TIMEOUT_MS = 3_000

/** 上面那段等待的轮询间隔。 */
export const AXIS_CONFIRM_POLL_MS = 100

/**
 * 双轴设置节的取值形状。两条轴都当作未信任输入读：文档可能被人手改过，也可能由
 * 别的写入方改过，所以这里只声明"是个对象"，真正的收窄在
 * {@link PermissionSelect} 的 `globalOf` 里按 `kind` 判定；读不懂就当作没有部署值，
 * 由编辑器用该轴的部署默认值兜底。
 */
export interface DualAxisSection {
  /** 新会话起步的读轴。 */
  read?: unknown
  /** 新会话起步的写轴。 */
  write?: unknown
  /** 组库：会话按 id 引用的具名规则片段。多选列表只读它。 */
  groups?: unknown
  /** 新会话默认加载哪些组；判定路径不读它，界面这边也不读。 */
  defaultGroups?: unknown
}

/** Required services (cordis fiber inject). */
export const inject = [
  'commandUi', 'connection', 'sessions', 'slots', 'locale', 'remote',
  'remote.permissionPresets', 'remote.settings',
  'configForms',
]

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Current-session preset picker and read/write axis copy. */
    'permission.access': keyof typeof accessEn
  }
}

/** Read one session's current permissions projection value (undefined = capability absent). */
function selectionOf(session: SessionFace | undefined): PermissionSelection | undefined {
  return session?.projections.faceOf('permissions').getSnapshot() as PermissionSelection | undefined
}

/**
 * Join the process catalog with one Session's current value. Options carry no
 * acknowledgement gate, so a pick is applied directly. A built-in preset's
 * label is localized from this package's dictionary: the host catalog names
 * those entries by their machine value (`read-only`), and showing that kebab
 * key to a person is a regression, not a design. A deployment's own preset name
 * is not recognized by the dictionary and is displayed verbatim.
 * @param catalog - the current Host's complete preset catalog.
 * @param currentValue - the session's current preset identity.
 * @param t - this package's locale seat.
 * @returns the option rows the shared popup shell renders.
 */
function optionsOf(
  catalog: PermissionCatalog,
  currentValue: string,
  t: TranslateNS<typeof PERMISSION_ACCESS_NS>,
): SelectOption[] {
  return catalog.options
    .map(option => ({
      id: option.value,
      // The three product presets come back from the Host catalog named by their
      // machine value, so this dictionary owns their labels; a deployment's own
      // preset name is unknown to it and `displayPermissionPreset` shows it verbatim.
      // `option.name` is the fallback, NOT a kebab-to-title formatter: the product
      // contract is that a deployment's own preset name reaches the surface verbatim
      // (`custom-mode` stays `custom-mode`), and only the three built-in machine
      // values are replaced by this package's localized labels.
      label: displayPermissionPreset(option.value, option.value === option.name ? option.value : option.name, key => t(key as keyof typeof accessZh)),
      ...(option.description !== undefined ? { detail: option.description } : {}),
      ...(option.value === currentValue ? { active: true } : {}),
    }))
}

/**
 * Client plugin body: register the /permission popup picker over the
 * permissions projection.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const command = ctx.get('commandUi') as CommandUiContract
  // 显式标注 `ISessions`，不依赖 `ctx.sessions` 的环境类型合并：那个名字有两份互相冲突的
  // 增补 —— `dsh-session` 声明 `SessionStore`（宿主侧），本包声明 `ISessions`（客户端），
  // 谁生效取决于当前程序加载了哪些包。客户端插件一律按 `dsh-api-session-controller/client`
  // 的 `ISessions` 取用（`ui-commands` 与 `ui-conversation` 的同一惯例）。
  // `as unknown as` 是必要的：两份增补互不重叠（`SessionStore` 没有 `retain`/`using`/
  // `binding` 等），所以直接断言会被 TS 拒掉。本文件 `:108` 的 `commandUi` 同款处理。
  const sessions = ctx.sessions as unknown as ISessions
  ctx.effect(
    () => ctx.locale.register(PERMISSION_ACCESS_NS, { zh: accessZh, en: accessEn }),
    'ui-permission: current-session dictionaries',
  )
  const t = ctx.locale.bind(PERMISSION_ACCESS_NS)
  const sessionFor = (session: ClientSessionContext): SessionFace | undefined =>
    sessions.binding(session.sessionId)?.session
  /**
   * 一次 `/axis` 调用被宿主**接受**（命令解析得到、handler 跑完）。
   *
   * 注意它不说明这次改动有没有写进去：`Session.command` 把结果收成 `matched`
   * （`packages/api/session-controller/src/client/sessions/session.ts:387-391`，`matched: result.value !== undefined`），丢掉了 handler 自己的 `kind`/`text`。
   * handler 返回 `{ kind: 'error' }` 的命令同样得到 `matched: true`。写入是否生效因此只能
   * 由 {@link select} 回读文档来判断。
   */
  const submit = async (sessionId: SessionId, args: string): Promise<void> => {
    const live = sessions.binding(sessionId)?.session
    if (live === undefined) throw new Error('this session is not materialized yet')
    // 双轴走自己的 /axis 命令：上游的 /permission 只认预设名，读不懂每轴语法。
    const result = await live.command('/axis ' + args)
    if (!result.ok) {
      throw new Error(`permission switch failed: ${result.error.code}: ${result.error.message}`)
    }
    if (!result.value.matched) throw new Error('the host offers no /axis command')
  }

  /**
   * 等这条会话在设置文档里真的变成 `expected`。
   *
   * 宿主写完轴是整份文档的异步写，写完才发 `settings/document-updated`，镜像再重读，
   * 所以这里给的是一个有上界的等待而不是一次即时读。等到就是成功；等不到回答 `false`
   * —— 那正是「命令执行了但没写进去」，界面据此把失败说出来，而不是关掉编辑器假装成功。
   * @param sessionId - 提交所属的会话。
   * @param axis - 这次写的哪条轴。
   * @param expected - 这次提交应当落成的取值。
   * @returns 文档里是否出现了这次取值。
   */
  const stored = async (
    sessionId: SessionId,
    axis: PermissionAxis,
    expected: AxisEditorScope,
  ): Promise<boolean> => {
    const deadline = Date.now() + AXIS_CONFIRM_TIMEOUT_MS
    for (;;) {
      const view = sessionAxes.axesOf(sessionId)
      // 'default' 不算数：那说明宿主还没有为这条会话写下任何记录，这次改动没落地。
      if (view.state === 'record' && sameStoredAxis(view.axes[axis], expected)) return true
      if (Date.now() >= deadline) return false
      await new Promise<void>(resolve => { setTimeout(resolve, AXIS_CONFIRM_POLL_MS) })
    }
  }

  const catalog = new PermissionCatalogDirectory(ctx)
  ctx.effect(() => () => { catalog.dispose() }, 'ui-permission: process catalog directory')
  ctx.effect(
    // Only an invalidation makes displayed options stale; publishing the result
    // of a read a displayed picker waits for must leave it open with its failure
    // and retry state intact.
    () => catalog.invalidations.subscribe(() => { command.dismiss('permission') }),
    'ui-permission: dismiss stale slash choices',
  )

  ctx.effect(() => ctx.locale.register('settings.permission', { zh, en }), 'ui-permission: settings row dictionaries')

  // 共享的 ConfigForm 镜像在文档提交与重连之后更新。
  const controller = new PermissionPresetSettingsController(
    ctx.configForms.describe(), ctx, catalog)
  const load = (): Promise<void> => controller.load()
  const select = (preset: string): Promise<void> => controller.select(preset)
  const injected = (): PermissionRowInjected => ({
    hooks: { permission: controller.store },
    load,
    select,
  })

  ctx.effect(() => () => { controller.dispose() }, 'ui-permission: settings row directory')

  // 会话轴：宿主把它们存进自有的设置命名空间 `dual-axis-sessions`，客户端从共享的
  // describe 镜像里按会话 id 读。镜像已经订阅了 settings/document-updated，所以宿主写完轴
  // 之后两个下拉会自己跟上，不需要轮询、也不需要重开会话。
  //
  // 记录缺席时显示的**不是**内置默认对，而是这条会话的种子：子代理子会话取父会话当刻的
  // 记录，其余取设置页那一行。父会话 id 只能从会话目录的血缘里取（宿主 `inheritedAxes`
  // 读的是同一条血缘的另一份投影），所以这里把它作为一条纯读取交给目录。
  const parentOf = (sessionId: string): string | undefined =>
    sessions.subagentAddress(sessionId as SessionId)?.parentSessionId
  const sessionAxes = new SessionAxesDirectory(ctx.configForms.describe(), parentOf)
  ctx.effect(() => () => { sessionAxes.dispose() }, 'ui-permission: session axes directory')

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'permission',
    order: -20,
    locale: 'settings.permission',
    inject: injected,
  }, PermissionRow))

  // 输入框上方两个下拉写的两条轴：一条会话当前值，一条部署设置里的默认值。
  //
  // 编辑器以**会话当前值**为初值 —— 这个界面表达的就是这条会话的轴，打开时显示别的
  // 值会与它旁边那个下拉自相矛盾。部署默认只在会话还没有这条轴时兜底，理由是这一节
  // 就是这份部署对两条访问轴的既有表态，对话级选择是在它之上追加而不是从空白重打。
  // 设置节缺席（没有双轴组合包、或非宿主持久化）时 `global()` 返回 undefined，
  // 编辑器再退回该轴自己的部署默认值（读 `all`、写 `workspace`），既不报错也不放大权限。
  //
  // 读的是 ConfigForm 的同步快照，不订阅：初值只在编辑器展开的那一刻取一次，之后的编辑
  // 由用户自己的草稿支配，全局文档在编辑途中变化不应该把用户打了一半的内容替掉。
  // `get()` 在宿主没服务这一节时返回一张值恒为 undefined 的表单，于是下面照样退回兜底
  // 默认值，既不报错也不放大权限；这里不用 `whileServed` —— 那只用于按需注册设置页。
  const globalForm = ctx.configForms.get<DualAxisSection>(DUAL_AXIS_SETTINGS_NAMESPACE)
  const globalAxes = (): DualAxisSection => globalForm.getSnapshot().value ?? {}
  const globalOf = (axis: PermissionAxis): PermissionAxisEditorSource | undefined => {
    const value: unknown = globalAxes()[axis]
    if (typeof value !== 'object' || value === null) return undefined
    const candidate = value as { kind?: unknown }
    return typeof candidate.kind === 'string' ? candidate as PermissionAxisEditorSource : undefined
  }

  ctx.slots.inject('conversation.input.permission', () => ctx.slots.register({
    name: 'conversation.input.permission',
    locale: PERMISSION_ACCESS_NS,
    inject: (sessionId: SessionId): PermissionSelectInjected => ({
      hooks: { permissionCatalog: catalog.store },
      // 三条闭合取值本身是完整语句，原样提交；`custom` 的完整参数由路径编辑器
      // 拼好（`axis:custom:base=…,allow=…,deny=…`）后经这里写入同一条对话。
      // 轴名只在签名里保留：参数串已由编辑器按该轴拼好，这里不再校验一次。
      select: async (axis: PermissionAxis, args: string, expected: AxisEditorScope) => {
        await submit(sessionId, args)
        return await stored(sessionId, axis, expected)
      },
      global: (axis: PermissionAxis) => globalOf(axis),
      // 同一个设置节，同一份快照：判定路径按 id 现取组定义，界面这边取的是同一批
      // 定义，于是「选择器里能选到的组」与「宿主认得的组」永远是同一份清单。
      groupLibrary: () => groupOptionsOf(globalAxes().groups),
      // 这条会话自己的轴来自另一个命名空间（dual-axis-sessions），按 session id 分区；
      // 与上面那一节的区别正是「种子」与「这条会话当刻的取值」。
      sessionAxes: {
        useAxes: (sessionId: string | undefined) => {
          const snapshot = useSyncExternalStore(sessionAxes.subscribe, sessionAxes.getSnapshot)
          return sessionAxesView(
            snapshot.view?.namespaces,
            sessionId,
            sessionId === undefined ? undefined : parentOf(sessionId),
          )
        },
        axesOf: sessionId => sessionAxes.axesOf(sessionId),
      },
    }),
  }, PermissionSelect))

  ctx.effect(() => command.decorate({
    name: 'permission',
    // The Session's current value alone decides availability. A missing catalog
    // surfaces through `options()`, which keeps the picker's own retry entry
    // reachable after a failed read instead of hiding the command.
    available: session => selectionOf(sessionFor(session)) !== undefined,
    ui: {
      kind: 'popupSelect',
      options: async (session) => {
        const selection = selectionOf(sessionFor(session))
        if (selection === undefined) throw new Error('permission presets are not available on this host')
        return optionsOf(await catalog.load(), selection.currentValue, t)
      },
      onSelect: (option, session) => submit(session.sessionId, option.id).then(() => undefined),
    },
  }), 'ui-permission: /permission decoration')
}

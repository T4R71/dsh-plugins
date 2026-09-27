/**
 * 双轴访问模式组合包（宿主半边）：把文件沙箱的两条访问轴 —— 读轴与写轴，
 * 每条都取 deny | workspace | all | custom，custom 形如
 * `{ kind: 'custom', base, allow[], deny[] }`，语义是 allow = base ∪ allow − deny
 * 且 deny 优先 —— 作为一份可安装、可配置的组合层暴露出去。
 *
 * 这一层持有两件事：新会话从哪两条轴开始（本行的 Loader entry Config，见
 * `./config.ts`），以及这两条轴在一条会话里怎么存、怎么读
 * （`./session-store.ts`，本包自有的设置命名空间 `dual-axis-sessions`，按会话 id
 * 分区）。它把前者下发到后者的时机是 `ctx.on('session/created')`：0.1.7 里
 * `packages/interaction/permission-presets/src/index.ts:245` 用同一个钩子钉
 * 权限预设，本包在它之后注册，因此新会话先拿到预设的 mode，再被本包写上一对轴。
 * 那一对轴按会话来源分两种：顶层会话取设置页那一行当刻的值，子代理子会话取
 * **父会话当刻生效的那一对**（见 `./session-store.ts` 的 `inheritedAxes`）。
 * 同一个种子也是**记录缺席时那条会话被修复成的取值**（`seedAxesFor`），修复由
 * 三处活读路径上的 `store.ensure` 触发，见该方法的说明。
 *
 * 为什么轴不在会话日志里（0.1.7 上游删改所致，逐条依据见 README）：
 * - 轴代数由 `./axis.ts` 与 `./scope.ts` 自带（0.1.7 全删）。
 * - 会话内的载体由本包自己声明的事件类型承担在 0.1.7 里**不成立**：该类型不在
 *   `KNOWN_SESSION_EVENT_TYPES` 里，而 `Session.append` 的信封硬编码、不接
 *   `ignorable`，于是写过的会话会被 `validateStoredEvents` 整份拒收、冷启动后
 *   打不开。轴因此搬到 `./session-store.ts`；日志里只保留写轴基准档经
 *   `sandbox/mode` 的那一次镜像（`./session-axes.ts`）。
 * - 读路径围栏由 `./fs-fence.ts` 自己实现（0.1.7 的 fs-sandbox 只围栏写）。
 * - 设置节由本行的 Config + `.volatile()` 承载（0.1.7 删了 `installSection`
 *   与任意命名空间注册，ns 就是 entry id）。
 *
 * 客户端半边在 `@t4r71/dsh-dual-axis-ui`：本包不声明 `dsh.client`。
 *
 * @module @t4r71/dsh-dual-axis
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
// The system-prompt service and the `agent` member of its assembly context both
// arrive by declaration merging; without these two the context registration
// below has no `ctx.systemPrompt` to type against.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
// The settings service arrives by declaration merging too, and only for the
// type of `ctx.get('settings')`: this package reads that service when the hook
// runs, never at mount, so it must not become a hard INJECT entry.
import type {} from '@deepseek-ai/dsh-settings'
import {
  Config as ConfigSchema,
  axesOf,
  declaredSection,
  defaultGroupIds,
  groupLibraryValue,
} from './config.ts'
import type { Config } from './config.ts'
import type { EffectiveScopes } from './axis.ts'
import { referencedGroupIds, resolveEffectiveAxes, ruleGroupIds } from './groups.ts'
import type { EffectiveAxesResolution } from './groups.ts'
import { CONTENT_EVENT_TYPES, hasContent } from './content.ts'
import { mirrorWriteMode } from './session-axes.ts'
import { seedAxesFor, sessionAxesStore } from './session-store.ts'
import type { SessionAxesStore } from './session-store.ts'
import { registerAxisCommand } from './axis-command.ts'
import { renderScopePrompt, unresolvedAxesNotice } from './scope-prompt.ts'

export {
  DUAL_AXIS_ROW_ID,
  RETIRED_SETTINGS_NAMESPACE,
  Config,
  axesOf,
  declaredSection,
  defaultGroupIds,
  groupLibraryValue,
  normalizeScope,
  sameScope,
} from './config.ts'
export type { Config as DualAxisConfig } from './config.ts'
export {
  intersectResolved,
  narrowerBase,
  referencedGroupIds,
  resolveEffectiveAxes,
  ruleGroupIds,
  scopeOfResolved,
  seedGroupReferences,
} from './groups.ts'
export type {
  EffectiveAxes,
  EffectiveAxesResolution,
  RuleGroup,
  RuleGroupAxis,
  WriteNarrowing,
} from './groups.ts'
export { mirrorWriteMode } from './session-axes.ts'
export {
  AXES_WRITE_ATTEMPTS,
  AXES_WRITE_BACKOFF_MS,
  Config as SessionAxesConfig,
  DEFAULT_AXES,
  SESSION_AXES_FIELD,
  SESSION_AXES_NAMESPACE,
  SessionAxesConflictError,
  SessionAxesStore,
  parseSessionAxesField,
  parseSessionAxesRecord,
  seedAxesFor,
  seedPair,
  sessionAxesStore,
} from './session-store.ts'
export type {
  SessionAxesField,
  SessionAxesRecord,
  SessionAxesStoreOptions,
  SessionAxesSweep,
  SessionAxesWriter,
} from './session-store.ts'
export { AXIS_COMMAND_NAME, registerAxisCommand } from './axis-command.ts'
export { parseAxisEntry } from './axis-entry.ts'
export type { AxisEntryParse } from './axis-entry.ts'
export {
  AXIS_BASES,
  AXIS_KINDS,
  DEFAULT_READ_SCOPE,
  DEFAULT_WRITE_SCOPE,
  effectiveScopes,
  isModeConsistent,
  isSandboxMode,
  modeOfAxisBase,
  modeOfScope,
  scopeOfMode,
} from './axis.ts'
export type { AxisBase, AxisScope, AxisScopeKind, EffectiveScopes as EffectiveScopesType } from './axis.ts'
export { ScopeConfigError, isAbsoluteSpelling, isLexicallyUnder, resolveScope, scopeContains } from './scope.ts'
export type { ResolvedScope, ScopePolicy } from './scope.ts'
export { DualAxisFileSystem, readAxisRefusal } from './fs-fence.ts'
export type { ReadAxes } from './fs-fence.ts'
export { NO_BYPASS, WIDENING_EXIT, renderAxisRange, renderScopePrompt, scopeRefusal } from './scope-prompt.ts'
export type { ScopeRefusal } from './scope-prompt.ts'


/**
 * {@link DualAxis.inject} 声明的依赖清单。
 *
 * `sessions` 是构造期就要用的：挂载时补齐挂载前就已存在的会话。cordis 里访问
 * 未声明的服务会直接抛 `cannot get property "..." without inject`，挂载当场失败。
 * 会话投影不再需要 —— 轴不再由会话事件喂（`./session-store.ts`）。
 */
const INJECT = ['sessions'] as const

/**
 * 双轴访问模式组合层。
 *
 * 挂载时做四件事：自检行里声明的轴形状、在会话创建钩子上给新会话钉一对轴、
 * 按需回收已经消失的会话的记录、把写轴基准档镜像进日志。改完配置只管之后的
 * 会话；已经在跑的会话保持它存储里那一对轴。子代理子会话不取设置页的值，
 * 取它的父会话当刻那一对。
 */
export class DualAxis {
  /**
   * 这一行需要的能力：会话表（补齐挂载前的会话）。依赖是静态字段，Cordis 的
   * loader 只从插件的 `inject` 属性读它 —— 函数形态导出同名常量不会被采用。
   */
  static inject = INJECT

  /** 本行的组合配置 schema，由 loader 在挂载前校验。 */
  static Config = ConfigSchema

  /**
   * 本行的组合配置，挂载那一刻的那一份。
   *
   * 两条轴都是 `.volatile()` 字段，取值是 schema 的 accessor；但这份 accessor
   * 是**构造期**解析出来的，0.1.7 的 loader 不把后来的设置改动提交回来，所以它
   * 只作 {@link declaredAxes} 取不到设置服务时的兜底，不再是新会话的取值来源。
   */
  private readonly config: Config

  /** 轴的权威存储：本包自有的设置命名空间，按会话 id 分区。 */
  private readonly store: SessionAxesStore

  /**
   * @param ctx - 宿主上下文，本层读会话表、注册会话钩子、写轴存储都经它。
   * @param config - 本行的组合配置（挂载那一刻的值）。
   */
  constructor(ctx: Context, config: Config) {
    this.config = config
    // 组合层先自检一次：行里声明的轴形状不对时挂载当场失败，而不是等某条新会话
    // 创建时才带着一条读不懂的轴去执行。这里也把 accessor 解包一次，让非法配置在装载期暴露。
    axesOf(config)
    this.store = sessionAxesStore(ctx)

    // 模型动手之前就该看到的边界。system-prompt 的 context 槽每次组装都重新求值，
    // 所以同一条会话里改轴之后的下一次请求看到的已经是新范围。
    //
    // 顺序取 SANDBOX_POLICY + 1：本体 sandbox-policy 在同一槽位注册它那句只报 mode 的
    // 段落（packages/sandbox/sandbox-policy/src/index.ts 的 systemPrompt.context），
    // 语境排序只按 order，同 order 时按注册顺序，而本行的装载顺序由组合决定。+1 让本段
    // 确定地紧跟在本体那段之后，形成一段连续的边界描述，而不是插在它前面。
    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'sandbox:dual-axis',
        order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY') + 1,
        text: (context) => {
          const session = context.agent?.session
          if (session === undefined) return ''
          const workspaceRoot = session.header.cwd
          if (workspaceRoot === undefined) return ''
          // 输入三处：按会话 id 存在本包存储里的轴预设、会话头里的 cwd，以及按预设引用的
          // id **当刻**取到的组定义。设置页那一行的 read/write/defaultGroups 不在这里 ——
          // 它们只经 `seedFor` 成为种子，判定路径不读。
          // `ensure` 而不是 `getOr`：记录缺席时它交回的**就是那份种子**（与 `pin` 写下的
          // 同一份计算），并把它交给那次修复写，于是新会话的第一轮提示词按设置页那一对走，
          // 而不是按内置默认对走；记录落地之后一切照旧读记录。
          const resolved = this.resolveFor(ctx, session, workspaceRoot)
          // 解算不了就把「没有一条路径可读」如实说出来，而不是退回一个更宽或更窄的范围。
          return resolved.ok
            ? renderScopePrompt(resolved.axes, workspaceRoot)
            : unresolvedAxesNotice(resolved.problem)
        },
      })
    })

    // 本行不做自动生成的设置页：这一行的表单是客户端半边自己画的那一行
    // （plugins.row.config 槽）。同一个设置服务也承载会话轴存储那一节，所以这里
    // 显式关掉自动页，免得 ns 上多出一张没人写的表单。
    ctx.inject(['settings'], (scope: Context) => {
      scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber))
    })

    const pin = (session: Session): void => { this.pin(ctx, session) }
    ctx.on('session/created', pin)
    // 挂载前就已存在的会话：0.1.7 里 permission-presets 同样补钉（见其 :248-250）。
    for (const session of ctx.sessions.list()) pin(session)
    // 一条会话**第一次有内容**的那一刻就是它被用过的那一刻，这里补钉一次。
    // 只靠活读路径上的 `ensure` 会漏掉一整类回合：一次不调用任何工具的回合里，
    // 提示词组装发生在人的消息落进日志之前（实测 system/message 在 seq 7、人的
    // user/message 在 seq 8），而读围栏只在工具派发时才跑，于是那一轮跑完这条会话
    // 仍然没有记录，设置页此后一改就会把它带着走 —— 与「用过的会话不再跟设置页」
    // 相反。判据与 `ensure` 用的是同一个 `hasContent`，所以两条路径不会各说各话。
    ctx.on('session/event', (session: Session, event: { type: string }) => {
      if (!CONTENT_EVENT_TYPES.has(event.type)) return
      const header = session.header
      if (header === undefined) return
      // 有记录就什么都不做：这条会话已经冻结，这一步只是那一次的补写。
      if (this.store.get(String(header.id)) !== undefined) return
      pin(session)
    })
    this.sweepSchedule(ctx)

    // 会话内改轴的那条写路径：输入框上方两个下拉经 /axis 到这里。
    // 用 ctx.inject 而不是 static inject：没有命令注册表的组合里本包仍要提供围栏与提示词。
    registerAxisCommand(ctx, {
      // 记录缺席时 `ensure` 交回的是这条会话的**种子**（设置页那一行 + 父会话记录），
      // 与提示词、围栏走的是同一个 `seedFor`，同时把这条会话排进修复写。
      current: session => this.store.ensure(String(session.header.id), () => this.seedFor(ctx, session), hasContent(session)),
      // 组库按 id 现取：设置页刚建的组不必重启就能被 /axis 选中。
      knownGroups: () => ruleGroupIds(groupLibraryValue(declaredSection(ctx))),
      // 写入是整份文档的异步写，并且同时把写轴基准档镜像进日志：两者一次完成，
      // 于是「存储里的轴」和「日志里的 mode」不会各说各话。
      write: async (session, axes) => {
        await this.store.set(String(session.header.id), axes)
        mirrorWriteMode(session, axes)
        // 这条命令是组引用改动唯一的写路径。轴的写入本身不带收窄结论，所以这里立刻
        // 把当前解算发布一次：界面上的收窄提示不必等到下一次触达才跟上。写失败与轴的
        // 写入无关（轴已经落盘），由存储自己记日志并在下一次触达时重试。
        const workspaceRoot = session.header.cwd
        if (workspaceRoot !== undefined) {
          // 解算不了（引用了设置页没有定义的组）时命令本身已经成功了 —— 那条轴确实
          // 写进了记录，响亮失败发生在提示词与围栏那一侧。这里不重复报一遍。
          this.resolveFor(ctx, session, workspaceRoot)
        }
      },
    })
  }

  /**
   * 给一条会话钉上它该有的两条轴。
   *
   * 取值来源按会话来源分叉：子代理子会话继承父会话当刻那一对，其余会话取设置页
   * 那一行当刻的值。这条会话在存储里已经有记录时**一律不写**：那条记录就是这条会话
   * 自己的轴，设置页此后再改与它无关，而每一次重钉都会把用户在下拉里选过的值按设置页
   * 覆盖回去。
   *
   * **没有内容**的会话同样**不写**：不是「已经有记录」，而是「还不该有记录」。
   * 工作区选择器在同一个工作区里开新对话时复用同一条会话 id（`docs` 与 README 里
   * 记着这条实测），所以创建即冻结等于把一条还没人用过的会话按当天的设置页钉死；
   * 这条会话此后每次读取都由 `ensure` 现算种子，设置页改一行它就跟着改，直到它真的
   * 被用过。落记录的两个时机因此是：**这一条会话被用过**（`hasContent`），或者
   * **用户经 `/axis` 手动改过它的轴**（那条写路径无条件落，见 `registerAxisCommand`）。
   * @param ctx - 宿主上下文，用于读这条会话与它父会话的轴。
   * @param session - 目标会话。
   */
  private pin(ctx: Context, session: Session): void {
    // 会话表在会话发布之前就可能把它列出来（记录先入表、头随后补），而这一对轴是按
    // 会话 id 分区的：头还不在时没有 key 可写，等 `session/created` 那次调用。
    const header = session.header
    if (header === undefined) return
    const id = String(header.id)
    const standing = this.store.get(id)
    if (standing !== undefined) {
      // 已有记录：把写轴基准档重新镜像一次，日志里那条已知事件的语义就是「这条会话
      // 此刻的写基准档」，热重载之后它必须还在。
      mirrorWriteMode(session, standing)
      return
    }
    // 还没被用过的会话保持无记录：它的轴由每一次活读路径上的 `store.ensure` 从设置页
    // 那一行现算，因此设置页一改它就跟着改。`session/created` 在这里什么都不写，
    // 这是这条规则的全部内容 —— 有内容的会话走下面同一条写路径。
    if (!hasContent(session)) return
    // 种子与「记录缺席时的修复写」是同一份计算（`./session-store.ts` 的 `seedAxesFor`），
    // 于是「新会话拿到的轴」与「旧会话被修复成的轴」永远只可能有一个答案。
    // 写失败必须响亮：一次被吞掉的写会让这条会话在存储里没有记录，于是它的轴退回默认对，
    // 而界面上下拉会如实显示那一对（不再是整块消失）。写是异步的（设置文档整份重写），
    // 所以这里只能把失败报给日志；下一次会话创建钩子、以及这条会话的每一次活读路径
    // （提示词 / 围栏 / `/axis`）上的 `store.ensure` 都会重试同一套取值。
    void this.store.set(id, this.seedFor(ctx, session)).catch((error: unknown) => {
      ctx.logger?.error('dual-axis: could not store the axes of session "%s"', id)
      ctx.logger?.error(error)
    })
  }

  /**
   * 一条会话该有的那一对轴 —— 新会话的种子，也是记录缺席时被修复成的取值。
   *
   * `pin` 与三处活读路径上的 `store.ensure` 走的是这同一个方法，所以「新建时写下的」
   * 与「后来补写的」不可能算出两个答案；没有设置服务的组合里用本行自己的 Config 兜底。
   * @param ctx - 宿主上下文。
   * @param session - 目标会话。
   * @returns 这一对轴。
   */
  private seedFor(ctx: Context, session: Session): EffectiveScopes {
    return seedAxesFor(ctx, session, {
      axes: this.declaredAxes(ctx),
      groups: this.declaredDefaultGroups(ctx),
    })
  }

  /**
   * 这条会话当刻生效的那一对轴 —— 记录缺席时现算种子，有记录时读记录；两条轴都按
   * 引用的 id **当刻**取组定义，再求写轴 ∩ 读轴。
   *
   * 提示词、围栏与客户端显示走的是这**同一处**：解算结果里的 `narrowing` 被原样发布进
   * 这条会话的记录（{@link SessionAxesStore.refreshNarrowing}），于是界面上说「被削掉了
   * 这些根」与实际执行的围栏不会有第二个答案 —— 浏览器半边既算不出 `workspace` 底座
   * （要 `os.tmpdir()`），也算不出根路径的规范拼写（要 `realpath`）。
   * @param ctx - 宿主上下文。
   * @param session - 目标会话。
   * @param workspaceRoot - 这条会话的工作区根，`workspace` 与 `custom` 底座对它的解析。
   * @returns 生效的一对轴，或解算不出来的原因。
   */
  private resolveFor(
    ctx: Context,
    session: Session,
    workspaceRoot: string,
  ): EffectiveAxesResolution {
    const id = String(session.header.id)
    const preset = this.store.ensure(id, () => this.seedFor(ctx, session), hasContent(session))
    // 只有预设里真的引用了组时才去读设置页那一行 —— 与改动前逐字相同的那条短路。
    const library = referencedGroupIds(preset).length === 0
      ? undefined
      : groupLibraryValue(declaredSection(ctx))
    const resolved = resolveEffectiveAxes(preset, library, { workspaceRoot })
    if (resolved.ok) this.store.refreshNarrowing(id, resolved.axes.narrowing)
    return resolved
  }

  /**
   * 按需回收：存储里那些 id 已经不在持久化会话表里的记录。
   *
   * 起停各扫一次、此后每 {@link SWEEP_INTERVAL_MS} 一次，都是后台任务：清扫失败只记
   * 日志，绝不影响会话创建或判定路径。判据（为什么不是 `session/disposed`）见
   * {@link SessionAxesStore.sweep}。
   * @param ctx - 宿主上下文。
   */
  /**
   * 把每一条在册会话的收窄结论重新解算并发一次。
   *
   * 为什么需要这一步：收窄结论是解算的产物，而解算的输入里就有**组定义**，改一个组的
   * 规则只改设置文档、不碰任何一条会话。少了这一次重发，界面上那句「读轴削掉了这些根」
   * 就要等到这条会话下一次被触达（下一轮提示词、下一次工具调用、下一次改轴）才跟上，
   * 而人在设置页改完组之后回到对话里看下拉时，两者都还没发生。
   *
   * 判定路径不受影响：围栏与提示词一直是按 id **现取**组定义的，这里重发的只是那份
   * 已经解算出来的结论。没有记录的会话跳过 —— 它的轴本来就每次现算，落一份反而会冻住。
   * @param ctx - 宿主上下文。
   */
  private republishNarrowing(ctx: Context): void {
    for (const session of ctx.sessions.list()) {
      const header = session.header
      if (header === undefined || header.cwd === undefined) continue
      if (this.store.get(String(header.id)) === undefined) continue
      this.resolveFor(ctx, session, header.cwd)
    }
  }

  private sweepSchedule(ctx: Context): void {
    const sweep = (): void => {
      void this.store.sweep()
        .then((result) => {
          if (result !== undefined && result.removed.length > 0) {
            ctx.logger?.info(
              'dual-axis: dropped the axis records of %s deleted session(s)',
              String(result.removed.length),
            )
          }
        })
        .catch((error: unknown) => {
          ctx.logger?.warn('dual-axis: the session axis sweep failed; every record is kept')
          ctx.logger?.warn(error)
        })
    }
    const republish = (): void => { this.republishNarrowing(ctx) }
    ctx.effect(() => {
      const first = setTimeout(sweep, SWEEP_FIRST_DELAY_MS)
      const repeating = setInterval(sweep, SWEEP_INTERVAL_MS)
      // 收窄结论用更短的间隔重发：它是界面上的一句话，改完组的人会立刻回来读它，而回收
      // 记录只是清理。两侧都只写「真的变了」的那一条记录，所以空闲时一次写都不多发。
      const firstRepublish = setTimeout(republish, NARROWING_REFRESH_MS)
      const republishing = setInterval(republish, NARROWING_REFRESH_MS)
      return () => {
        clearTimeout(first)
        clearInterval(repeating)
        clearTimeout(firstRepublish)
        clearInterval(republishing)
      }
    }, 'dual-axis: session axis sweep')
  }

  /**
   * 设置页那一行当刻声明的两条轴。
   *
   * 走 `ctx.settings.describe()` 而不是构造期捕获的 `this.config`：设置页保存写的
   * 是 Loader entry 的 config 文档，而 `this.config` 是挂载那一刻解析出来的
   * volatile accessor 快照。0.1.7 的 loader 不把新值提交回插件实例持有的那一份
   * （`vendor/loader/src/config/entry.ts:162-195`），所以同一进程内保存后，读
   * `this.config` 拿到的仍是旧值，必须重启才生效。`describe()` 每次都从
   * `entry.fiber.config` 重新投影并解 volatile
   * （`packages/settings/settings/src/index.ts:319-323` +
   * `packages/settings/settings/src/schema.ts:10-17`），与设置页摘要显示用的是
   * 同一条读路径，因此这里读到的就是文件里那份值。
   *
   * `settings` 不在场的组合（本包可在没有设置服务的宿主里单独装载）退回构造期
   * 那一份，也就是没有设置页可保存时的唯一取值。
   * @param ctx - 宿主上下文。
   * @returns 两条轴。
   */
  private declaredAxes(ctx: Context): EffectiveScopes {
    const value = declaredSection(ctx)
    return axesOf(value === undefined ? this.config : value)
  }

  /**
   * 设置页声明「新会话默认加载」的组 id。
   *
   * 只被 {@link pin} 用来播种新会话，判定路径一概不读它 —— 与 read/write 两个默认值同理，
   * 它描述的是一条**将要建立**的会话，不是任何已经有记录的会话。
   * @param ctx - 宿主上下文。
   * @returns 声明的组 id；没有设置服务时为空。
   */
  private declaredDefaultGroups(ctx: Context): readonly string[] {
    const value = declaredSection(ctx)
    return value === undefined ? defaultGroupIds(this.config) : defaultGroupIds(value)
  }
}

/** 首次清扫的延迟：等 loader 把每个入口都激活、持久化后端也装好。 */
export const SWEEP_FIRST_DELAY_MS = 15_000

/** 之后每次清扫的间隔。 */
export const SWEEP_INTERVAL_MS = 30_000

/**
 * 两次重发收窄结论之间的毫秒数 —— 界面上那句「读轴削掉了这些根」跟随组定义的最坏延迟。
 *
 * 比回收记录的间隔短：回收只是清理，而这句话是给人读的判断，而它唯一的其他更新时机是
 * 这条会话被触达（下一轮提示词、下一次工具调用、下一次改轴）—— 人在设置页改完组之后回到
 * 对话里看下拉时，这三件事都还没发生。重发本身只在结论真的变了时才写文档。
 */
export const NARROWING_REFRESH_MS = 10_000

/**
 * 子代理子会话继承父会话当刻那一对轴 —— 定义搬到了 `./session-store.ts`，
 * 因为「记录缺席时的修复写」要用同一份计算。此处再导出，保持本包既有的公开面。
 */
export { inheritedAxes } from './session-store.ts'

export default DualAxis

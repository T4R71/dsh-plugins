/**
 * 读轴围栏，作为独立入口 `@t4r71/dsh-dual-axis/read-guard`。
 *
 * 为什么读轴需要这一层：0.1.7 的文件系统读路径根本不带会话（`dsh-fs-sandbox` 的读方法只有
 * target 与 signal，只有 writeText / editText 收 per-call policy），所以本包的
 * `DualAxisFileSystem` 即使挂上去，也永远拿不到要判的那条会话的轴，只能退回部署默认。
 * 工具派发层是唯一同时拿得到「这次要动的路径」与「当前会话」的地方：
 *
 *  1. `tools/pre-execute`：异步 waterfall，拿得到 `exec.agent.session` 与 `exec.arguments`，
 *     用 `ctx.fs.resolve` 解析真实身份再做包含判定，返回 `{ kind: 'deny', reason }` 短路，
 *     模型收到的是一条 `Error: <reason>` 的工具结果。
 *  2. `ctx.tools.guard(fn)`：单调同步兜底，在全部 pre-execute 监听器之后、工具体之前运行，
 *     只能把调用判得更严。同步因此只有词法判定，只对 deny 列表判否 —— 显式排除的目录，
 *     身份判定只会把它判得更严，不会判松，所以词法命中 deny 即拒不会误伤。
 *
 * 两轴的执行分工，与 0.1.7 已有的执行点不重叠：
 *  - 读轴：没有任何既有执行点，本模块全量执行（deny 优先，再有界 allow）。
 *  - 写轴：三档封闭取值已由本体沙箱按 `sandbox/mode` 执行（镜像的是两根轴 base 里更窄
 *    的那个，见 `./groups.ts` 的 `narrowerBase`），本模块执行**交集本身的完整范围** ——
 *    交集由读轴带来的那部分收窄是路径级的，那条 mode 事件装不下，只有本层能让它对它看得
 *    见的工具成真。
 *
 * 判定路径的输入只有三样：这条会话按 id 存在本包存储里的轴预设（base + 自己追加的
 * allow/deny + 选中的组 id）、按那些 id 现取的组定义，以及这次调用的目标路径。设置页那一行
 * 的 read/write 默认值与 defaultGroups 是**种子**，本模块一概不读（`./config.ts` 的
 * `groupLibraryValue` 是唯一的读取出口）。轴读的是 `./session-store.ts` 的存储，
 * 不是会话投影 —— 轴已经不在会话日志里。
 *
 * @module @t4r71/dsh-dual-axis/read-guard
 */
import { resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools'
import type { AxisScope, EffectiveScopes } from './axis.ts'
import { declaredSection, groupLibraryValue } from './config.ts'
import { hasContent } from './content.ts'
import { referencedGroupIds, resolveEffectiveAxes } from './groups.ts'
import type { EffectiveAxes, WriteNarrowing } from './groups.ts'
import { seedAxesFor, sessionAxesStore } from './session-store.ts'
import { isLexicallyUnder, resolveScope } from './scope.ts'
import type { ResolvedScope } from './scope.ts'
import { scopeRefusal, unresolvedAxesNotice } from './scope-prompt.ts'

/** 插件名，loader 诊断用。 */
export const name = 'dual-axis-read-guard'

/** 构造期就要用的服务：缺一个就装载失败，而不是运行期静默放行。 */
export const inject = ['fs', 'tools'] as const

/** 读入口：参数里的目标路径会被当成读取对象检查。 */
const READ_TOOLS: Readonly<Record<string, string>> = {
  read: 'file_path',
  read_image: 'file_path',
  grep: 'path',
  glob: 'path',
}

/**
 * 写入口：只补写轴排除表。写的基础档位由本体沙箱按 mode 执行，重复执行它会与本体
 * 对临时区、平台可写根的既有让步打架。
 */
const WRITE_TOOLS: Readonly<Record<string, string>> = {
  write: 'file_path',
  edit: 'file_path',
  str_replace_editor: 'path',
}

/** 插件配置。 */
export interface Config {
  /** 关闭后本插件完全不注册。 */
  enabled?: boolean
  /** 被检查的读入口工具名。 */
  readTools?: string[]
  /** 被检查的写入口工具名。 */
  writeTools?: string[]
}

/** 装载期校验的配置。 */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  readTools: z.array(z.string()).default(Object.keys(READ_TOOLS)),
  writeTools: z.array(z.string()).default(Object.keys(WRITE_TOOLS)),
})

/**
 * 一条会话自己的轴预设：读本包自有的会话轴存储（`./session-store.ts`），
 * 存储里没有这条会话时用这条会话的**种子**（设置页那一行 + 父会话当刻的记录）——
 * 与新会话被钉下的、以及记录缺席时被补写的都是同一份计算。预设里带着组 id，组体不在这里
 * —— 组定义按 id 现取，见 {@link boundaryOf}。
 * @param ctx - 插件上下文，承载设置服务（存储的读路径）。
 * @param session - 发起这次调用的会话。
 * @returns 该会话的轴预设。
 */
function presetOf(ctx: Context, session: Session): EffectiveScopes {
  // `ensure` 而不是 `getOr`：记录缺席时它交回的是这份种子（不是内置默认对）。有内容的
  // 会话另外被排进一次修复写，于是「没有记录」不会永久停在那里；没有内容的会话不排写，
  // 它的种子每次现算，设置页改一行它就跟着改（见 `./content.ts`）。修复写是后台的、
  // 失败的只记日志，所以这条同步判定路径既不会等它，也不会因为它失败而改变判定。
  return sessionAxesStore(ctx).ensure(
    String(session.header.id),
    () => seedAxesFor(ctx, session),
    hasContent(session),
  )
}

/** 一次判定的边界：解算出来的实际生效范围，或说明为什么没有。 */
type Boundary =
  | { readonly ok: true; readonly axes: EffectiveAxes }
  | { readonly ok: false; readonly problem: string }

/**
 * 一次判定的实际生效范围：会话预设 + 按 id 现取的组定义 → 展开 → 写轴 ∩ 读轴。
 *
 * 组定义只在预设真的引用了组时才去读设置页：引用不到组的会话（绝大多数）因此每次判定
 * 都不碰设置服务，而引用到的会话每次判定都读当刻那一份，改一个组立刻作用于所有引用它的
 * 会话，不需要重启也不需要重开会话。
 *
 * 解算失败（引用了库中不存在的组 id、组库本身读不懂）返回 `ok: false`，由调用方拒绝这次
 * 访问：既不能当成空组放行，也不能抛出去把工具派发整条链打断。
 * @param ctx - 插件上下文，承载轴存储与设置服务。
 * @param session - 发起这次调用的会话。
 * @param root - 这条会话的工作区根，`workspace` 基档按它解析。
 * @returns 实际生效的那一对轴，或失败原因。
 */
function boundaryOf(ctx: Context, session: Session, root: string): Boundary {
  const preset = presetOf(ctx, session)
  const library = referencedGroupIds(preset).length === 0
    ? undefined
    : groupLibraryValue(declaredSection(ctx))
  const resolved = resolveEffectiveAxes(preset, library, { workspaceRoot: root })
  return resolved.ok ? { ok: true, axes: resolved.axes } : { ok: false, problem: resolved.problem }
}

/**
 * 从一次调用的参数里取出目标路径拼写。
 * @param tool - 工具名。
 * @param args - 工具参数。
 * @param table - 被检查的工具表。
 * @param allowed - 配置里启用的工具名集合。
 * @returns 目标路径拼写，表外工具或字段缺失时为 undefined（=不检查）。
 */
function spelledPath(
  tool: string,
  args: unknown,
  table: Readonly<Record<string, string>>,
  allowed: ReadonlySet<string>,
): string | undefined {
  if (!allowed.has(tool)) return undefined
  const field = table[tool]
  if (field === undefined) return undefined
  if (args === null || typeof args !== 'object') return undefined
  const value = (args as Record<string, unknown>)[field]
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  return value
}

/**
 * 异步包含判定：词法快路径命中的直接用，拼写不同时回落到 provider 自己的 `ctx.fs.contains`
 * —— 它按真实文件系统身份比较，认 Windows 8.3 别名与大小写。
 * @param ctx - 插件上下文。
 * @param targetKey - 目标的规范化身份键。
 * @param root - 参与比较的根。
 * @returns 目标是否落在根之下。
 */
async function contained(ctx: Context, targetKey: string, root: string): Promise<boolean> {
  if (isLexicallyUnder(targetKey, root)) return true
  const rootTarget = await ctx.fs.resolve(root)
  const target = await ctx.fs.resolve(targetKey)
  return ctx.fs.contains(rootTarget, target)
}

/**
 * deny 优先于 allow，unbounded 只是「没有上界」，不豁免 deny —— 与 scopeContains 同序。
 * @param ctx - 插件上下文。
 * @param scope - 已解析的轴取值。
 * @param targetKey - 目标的规范化身份键。
 * @returns 该轴是否放行这个目标。
 */
async function permitted(ctx: Context, scope: ResolvedScope, targetKey: string): Promise<boolean> {
  for (const root of scope.deny) {
    if (await contained(ctx, targetKey, root)) return false
  }
  if (scope.unbounded) return true
  for (const root of scope.allow) {
    if (await contained(ctx, targetKey, root)) return true
  }
  return false
}

/**
 * The refusal one dispatch returns for one target. The text itself lives in
 * `./scope-prompt.ts` and is the SAME source the runtime-context paragraph
 * renders from, so the range the model read before it acted and the range it is
 * denied by cannot disagree.
 * @param target - the refused target, with the axis that refused it.
 * @param displayPath - the path as the model should see it.
 * @param scope - the refusing axis's value.
 * @param narrowing - what the read axis removed from the write range, for a write refusal.
 * @returns the model-facing refusal text.
 */
function refusal(
  target: Target,
  displayPath: string,
  scope: AxisScope,
  narrowing?: WriteNarrowing,
): string {
  return scopeRefusal({
    displayPath,
    axis: target.axis,
    scope,
    workspaceRoot: target.root,
    ...narrowing === undefined ? {} : { narrowing },
  })
}

/** 一次调用的目标：取哪根轴、拼写是什么、落在哪条会话的哪个工作区根下。 */
interface Target {
  readonly axis: 'read' | 'write'
  readonly spelled: string
  readonly session: Session
  readonly root: string
}

/**
 * 取出这次调用的目标，表外工具返回 undefined。
 * @param execution - 一次工具执行。
 * @param readAllowed - 启用的读入口。
 * @param writeAllowed - 启用的写入口。
 * @returns 目标，或 undefined。
 */
function targetOf(
  execution: Readonly<ToolExecution>,
  readAllowed: ReadonlySet<string>,
  writeAllowed: ReadonlySet<string>,
): Target | undefined {
  const session = execution.agent?.session
  if (session === undefined) return undefined
  const root = session.header.cwd
  if (root === undefined) return undefined
  const read = spelledPath(execution.name, execution.arguments, READ_TOOLS, readAllowed)
  if (read !== undefined) return { axis: 'read', spelled: read, session, root }
  const write = spelledPath(execution.name, execution.arguments, WRITE_TOOLS, writeAllowed)
  if (write !== undefined) return { axis: 'write', spelled: write, session, root }
  return undefined
}

/**
 * 注册两层的轴围栏。
 * @param ctx - 插件上下文；两个注册都挂在它上面，随它一起卸载。
 * @param config - 装载期已校验的配置。
 */
async function apply(ctx: Context, config: Config = {}): Promise<void> {
  // cordis 把任何非 async、非箭头函数都当构造器用 new 调（vendor/cordis/src/utils.ts:79-89），
  // 而本行的 config 可能缺席，所以这里既做成 async，又在这里兜底而不是指望 schema 默认值。
  const enabled = config.enabled ?? true
  if (!enabled) return
  const readAllowed = new Set(config.readTools ?? Object.keys(READ_TOOLS))
  const writeAllowed = new Set(config.writeTools ?? Object.keys(WRITE_TOOLS))

  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    const target = targetOf(exec, readAllowed, writeAllowed)
    if (target === undefined) return next()
    const boundary = boundaryOf(ctx, target.session, target.root)
    if (!boundary.ok) return { kind: 'deny', reason: unresolvedAxesNotice(boundary.problem) }
    const axis = boundary.axes[target.axis]
    const scope = resolveScope(axis, { workspaceRoot: target.root })
    // 两轴都按各自的完整范围判：写轴的 base 档另有一层镜像在下面，但读轴带来的路径级收窄
    // 只有本层能执行，所以这里不再只判排除表。
    if (scope.unbounded && scope.deny.length === 0) return next()
    const resolved = await ctx.fs.resolve(target.spelled, { cwd: target.root, signal: exec.signal })
    if (await permitted(ctx, scope, resolved.targetKey)) return next()
    return {
      kind: 'deny',
      reason: refusal(target, resolved.displayPath, axis, boundary.axes.narrowing),
    }
  })

  const guard: ToolGuard = (execution) => {
    const target = targetOf(execution, readAllowed, writeAllowed)
    if (target === undefined) return undefined
    const boundary = boundaryOf(ctx, target.session, target.root)
    if (!boundary.ok) return unresolvedAxesNotice(boundary.problem)
    const axis = boundary.axes[target.axis]
    const scope = resolveScope(axis, { workspaceRoot: target.root })
    if (scope.deny.length === 0) return undefined
    const targetKey = resolvePath(target.root, target.spelled)
    for (const denyRoot of scope.deny) {
      if (isLexicallyUnder(targetKey, denyRoot)) {
        return refusal(target, target.spelled, axis, boundary.axes.narrowing)
      }
    }
    return undefined
  }
  ctx.tools.guard(guard)
}

/**
 * 默认导出必须自带 inject / Config / name：Loader.unwrapExports 返回 exports.default 并丢掉
 * 兄弟具名导出（vendor/loader/src/index.ts:201-208），而 registry 只读 plugin.inject
 * （vendor/cordis/src/registry.ts:330）—— 挂不上就会不等服务先激活，首次读 ctx.tools 抛错。
 */
export default Object.assign(apply, { inject, Config })

// `name` 只能 defineProperty：Function.name 是 configurable 但 not writable，
// Object.assign 走 [[Set]] 会当场抛 TypeError。
Object.defineProperty(apply, 'name', { value: name, configurable: true })

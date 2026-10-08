/**
 * 预设表：预设名 → persona + 工具围栏 + **内核 preset 名**。
 *
 * **0.2.0-rc.2 起，逐次派发支持预设名了。** `SubagentStartRequest` 多了一个
 * `preset?: string` 槽（宿主 `packages/subagent/subagent/src/types.ts` 的
 * `readonly preset?: string`），宿主据此把**显式声明的**那一支 preset 装进孩子的
 * 创建窗口 —— 在同一刻派出的两个子代理因此可以拿到两个不同的工具面。这跟本包原先
 * 「只能靠 persona + toolFilter 在父的面上做减法」是两件事：
 *
 * - `persona` / `toolFilter` 是**减法**：父已经有的面，孩子在里面挑一部分。
 * - `preset` 是**面本身**：它带着自己那一组 plugin 行与自己的工具表进来，
 *   所以是唯一能**加上**父从来没有过的工具的那个槽。
 *
 * 本包仍然自建这张表，理由变了：表要负责把**身份名**（`recon` / `impl` / …）映射成
 * 派发时真正生效的那些槽，其中 `PresetSpec.preset` 是那一格 —— 它在表里**可选**，
 * **省略即取角色名本身**（`presets.<角色>` 的键就是默认的面名）。
 *
 * 一次派发最终走哪条通道交身份，由 {@link chooseIdentityChannel} 在派发那一刻问名册决定：
 * 名册在册 ⇒ 只交 `preset`（**不交 persona** —— 两条身份段同名同层会让宿主当场抛）；
 * 名册缺席、或角色不在册 ⇒ 退回老的 persona + toolFilter 平铺，并在返回值里留一行降级痕迹。
 *
 * 内置的 `tool-subagent`（`dsh-tool-subagent/lib/index.js`）也在自己的行配置上开了
 * `preset` 一格，但它一行只能给一套；本包把它提到**逐次可选的预设名**上，这是
 * 「收成一个 `task`」与「多个 `tool-subagent` 行」的唯一实质差别。
 *
 * @module @t4r71/dsh-task/presets
 */

/** `task` 那一行的 Config 里唯一的字段：预设名 → 规格。 */
export const PRESETS_FIELD = 'presets'

/**
 * 一个身份：这一支代理的人格段，以及它能用哪些工具。
 *
 * 「全局规则段 + 身份段」里的**后半段**就是 `persona`：全局规则段由本行配置的
 * `defaultRules` 供给、对所有代理相同（见 `index.ts` 的 `GLOBAL_RULES_SECTION`），
 * 而人格与工具面逐个身份不同——中枢是 `lead`，四处走的角色是 `recon` / `impl` / `verify`。
 */
export interface PresetSpec {
  /** 这个身份的身份段（人格）。省略表示不加人格——只靠全局规则段。 */
  readonly persona?: string
  /** 只保留这些全局工具。与 `deny` 至少给一个，两者都给时按上游语义取交集。 */
  readonly allow?: readonly string[]
  /** 去掉这些全局工具。 */
  readonly deny?: readonly string[]
  /** 这一支子代理的深度上限。省略表示交给运行时解析。 */
  readonly maxDepth?: number
  /**
   * 要从**继承来的**系统提示词里丢掉的 section 名。
   *
   * 为什么需要它：子代理经 `composeFrom` 继承父的整层 section，其中 `persona` 那一段
   * 因为同名覆盖**本来就已经被换掉**（实测：带 preset 时子代理看到的是 preset 的 persona，
   * 不是父的），但其余二十多个 section 一律照抄。这一项给出丢掉其中若干的能力。
   *
   * **不含身份与工具说明的默认值**：丢掉 `tools:ptc-only`（"run_code 是唯一能直接调用的工具"）
   * 会让子代理不知道该怎么用工具。要丢什么是使用者的判断，这里不替他设默认。
   *
   * 这里不必手写 `tool:<工具名>` —— `deny` 里列掉的工具，其说明段由
   * {@link toolSectionsForFilter} 自动并入。
   */
  readonly drop?: readonly string[]
  /**
   * 这一支的模型路由与思考强度，逐字段覆盖从父继承来的那一份。
   *
   * 为什么值得有：角色与档位本来就是配一对的 —— 侦察要的是跑得动的便宜档，
   * 校验要的是想得深的贵档，而这三档现在只能全局设一次。写在预设表上，
   * 每个身份自己钉住自己的档，模型点名派活时就带过去了。
   *
   * **为什么只收这四个、不收 `subagentDepth`**：深度由 runtime 按父子关系盖章
   * （`resolveChildAgentOptions` 会覆盖它），配置层写它只会得到一个看着生效、
   * 实则被吃掉的值 —— 那比不提供更坏。
   *
   * 省略的整体不出现在查表结果里（`resolvePreset` 不物化空对象），于是省略这一项时
   * 派发请求与加它之前逐字段一致。
   */
  readonly agentOptions?: PresetAgentOptions
  /**
   * 内核侧的 preset 名：孩子**显式声明**要装哪一支工具面。
   *
   * 与 `toolFilter` 是**两件不同的事**，不是同一条路的不同写法：
   * - `toolFilter` 在父的面里做减法（`tools.restrict` 是纯减法，只删不加）；
   * - `preset` 换掉整个面 —— 它带着那一支自己的 plugin 行与工具表进来，所以
   *   这一格是**唯一能让孩子拿到父从来没有过的工具**的通道。
   *
   * **省略即取角色名自己**（`presets.<角色>` 里那个键）：写 `presets: { recon: {} }`
   * 与写 `presets: { recon: { preset: 'recon' } }` 是同一个意思。要让孩子装一支**别名的**
   * 面（角色叫 `recon`、面叫 `recon-face`）才需要显式给出这一格。
   *
   * 这一格只是**意图**：真交不交得出去由派发那一刻的名册决定（{@link chooseIdentityChannel}）。
   * 名册缺席、或这个名字不在册，派发**不抛错** —— 它退回 persona + toolFilter 的老路，
   * 并在返回值里留一行降级痕迹。理由：rosterless 部署（承载面在 host 平面上）本来就不需要
   * 声明，把一次笔误升级成一次派发失败反而挡住了那些部署唯一走得通的路；
   * 而宿主侧对**已声明**的未知 id 是直接抛的（`agent-preset/not-found`），
   * 所以「声明了却不在册」这件事必须在到达宿主之前就被本包接住。
   *
   * 名字在内核 `agentPresetRegistry` 里真的注册过时才生效（`list()` 里查得到，
   * 且那一行没有被 `broken` 标掉）。
   */
  readonly preset?: string
}

/**
 * 预设表上那格 `agentOptions` 的形状。
 *
 * 与宿主 `AgentOptions`（`@deepseek-ai/dsh-subagent`）的前四个字段逐字对齐，
 * 但**不 import 那份类型**：那是宿主运行时的依赖，本包只通过嵌套的 node_modules 才够得到它，
 * 声明文件生成会以 TS2883 拒绝（与 Config 那个 `Dict` 的处理同源）。
 * `reasoningEffort` 在这里是普通 `string`，理由见 `index.ts` 的 `PresetSpecField`。
 */
export interface PresetAgentOptions {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
}

/**
 * 查表结果，形状与 `SubagentStartRequest` 的可选成员逐字对应。
 *
 * **两条通道都收 `agentOptions`**，它不是选通道的依据：内核对
 * `resolveChildAgentOptions(parent, request.agentOptions, childDepth, childPresetAgentOptions(parent, request.preset))`
 * （`subagent/src/continuation.ts:121-126`）一次算三样 —— 请求体里那一格照旧读，
 * 预设自己声明的档位由 `agentOptionsFor(declaredPreset ?? composedPreset(parent))` 现查
 * （`subagent/src/child-agent.ts:107-111`）。
 * 层序是「父 → requested → preset 声明」（`child-agent.ts:151-169`），preset 最强 ——
 * 也就是说走预设时 `agentOptions` 不但传得进去，还优先于调用方那一格。
 * 所以这里**不存在**因为身份通道而丢档位的情况，也没有对应的降级。
 */
export interface ResolvedPreset {
  readonly persona?: string
  readonly toolFilter?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }
  readonly maxDepth?: number
  readonly drop?: readonly string[]
  readonly agentOptions?: PresetAgentOptions
  /**
   * 解析出来的面容器：内核 preset 名。
   *
   * 与 `PresetSpec.preset` 不同，这里**不会缺席**（只要身份名解析出来了）——
   * `resolvePreset` 把「没写」补成生效的角色名自己。真交不交得出去另说：
   * 派发那一刻由 {@link chooseIdentityChannel} 问名册，问不到就走
   * `persona` + `toolFilter` 那条老路。
   */
  readonly preset?: string
}

/**
 * 名册服务的最小面：**只读地问一次「这个名字在不在册」**。
 *
 * 与 `UserQuestionsSurface`（`index.ts`）同一种写法：本包**不 import**
 * `@deepseek-ai/dsh-agent-preset-registry`。那是宿主的运行时依赖，写进本包的
 * public 类型面会让声明文件生成报 TS2883（同一个理由见 {@link PresetAgentOptions}）；
 * 而且 rosterless 部署（把预设树整块省掉的那些）根本没有这个服务 ——
 * 编译期硬依赖会让本包在那些部署里装不上。
 *
 * 本包**机会式**消费它：拿得到就按名字走 preset 通道，拿不到就降级。
 * 但降级必须**显式留痕**，不许静默 —— 静默失效的面正是本项要消灭的东西。
 */
export interface AgentPresetRosterPort {
  /**
   * 名册里现有的每一支。
   *
   * 实现见内核 `agent-preset-registry/src/index.ts` 的 `list()`：**纯读**，
   * 每一行现算 `diagnostic` 并挂 `broken`（装载失败被记进那一行的字符串里，不是抛出来）。
   *
   * **调用时机有一条硬约束**（内核那份 JSDoc 写着的）：`diagnostic` 在行还在等
   * Host 服务时会 `await this.owner.loader.await()`，所以调用方**不能跑在某个 Host 行自己的
   * 激活过程里** —— 那会等自己，形成死锁。本包只在一件事上调用它：**派发那一刻**
   * （工具执行期、或结算之后的自动放行），两者都在行激活之外，正是这份 JSDoc 允许的位置。
   * @returns 名册快照；至少含 `id`。
   */
  list(): Promise<readonly { readonly id: string; readonly broken?: string }[]>
}

/** 交身份的两条通道。 */
export type IdentityChannel =
  | {
      /** 名册在册：把孩子**整支面**交给宿主，`preset` 是唯一要传的那个槽。 */
      readonly kind: 'preset'
      /** 真正要交给宿主的 preset id。 */
      readonly id: string
    }
  | {
      /** 名册那条路走不通：退回 `persona` + `toolFilter` 的减法。 */
      readonly kind: 'fallback'
      /** 为什么退。 */
      readonly reason: 'roster-absent' | 'not-in-roster' | 'roster-entry-broken'
      /** 给人看的一行原因（含真实报错或可用名字），进返回值留痕。 */
      readonly detail: string
    }

/**
 * 决定这次派发走哪条通道交身份。
 *
 * **为什么是「问名册」而不是「直接交出去试试」**：宿主对**已声明**的未知 id 是直接抛的
 * （`child-agent.ts` 的 `retain()` → `agent-preset/not-found`），而「无 roster 却声明了
 * preset」更狠 —— 当场抛 `child preset "X" was declared but no agent-preset roster is
 * composed`。两条都不会静默退化，但都会把一次**配置笔误**升级成一次**派发失败**，
 * 而 rosterless 部署里「声明的名字问不到」是**常态而非错误**。所以判断必须在这里做：
 * 名册问得到且名字在册才走 preset，否则退回减法。
 *
 * `roster.list()` 自己抛也归 `roster-absent`：拿不到名册与没有名册，对本函数是同一件事。
 * @param roster - 名册服务；`undefined` 表示这个部署没装。
 * @param wanted - 想交出去的名字；`undefined` 表示这次派发**没有任何身份**（纯减法）。
 * @returns 选定的通道；`wanted` 缺席时返回 `undefined`（无身份可言，也就无降级可言）。
 */
export async function chooseIdentityChannel(
  roster: AgentPresetRosterPort | undefined,
  wanted: string | undefined,
): Promise<IdentityChannel | undefined> {
  if (wanted === undefined) return undefined
  if (roster === undefined) {
    return {
      kind: 'fallback',
      reason: 'roster-absent',
      detail: `preset "${wanted}" was declared but no agent-preset roster is loaded; falling back to persona + toolFilter`,
    }
  }
  let known: readonly { readonly id: string; readonly broken?: string }[]
  try {
    known = await roster.list()
  } catch (error) {
    return {
      kind: 'fallback',
      reason: 'roster-absent',
      detail: `agent-preset roster could not be read (${String(error)}); falling back to persona + toolFilter`,
    }
  }
  const entry = known.find(item => item.id === wanted)
  if (entry === undefined) {
    const available = known.map(item => item.id).sort()
    return {
      kind: 'fallback',
      reason: 'not-in-roster',
      detail: `preset "${wanted}" is not in the agent-preset roster (available: ${available.length > 0 ? available.join(', ') : '(none)'}); falling back to persona + toolFilter`,
    }
  }
  // `broken` 那一行**装不起来**（内核 `list()` 里现算出来的诊断）：交出去只会让孩子
  // 在装配时炸掉，而且是在孩子自己的作用域里炸 —— 比在这里退回减法难查得多。
  if (entry.broken !== undefined) {
    return {
      kind: 'fallback',
      reason: 'roster-entry-broken',
      detail: `preset "${wanted}" is registered but broken (${entry.broken}); falling back to persona + toolFilter`,
    }
  }
  return { kind: 'preset', id: entry.id }
}

/** 工具说明段的名字前缀。各工具插件把自己的说明注册成 `${TOOL_SECTION_PREFIX}${工具名}`。 */
export const TOOL_SECTION_PREFIX = 'tool:'

/**
 * 把工具围栏翻译成要从提示词里丢掉的工具说明段名。
 *
 * 为什么需要它：说明段由各工具插件在**全局层**注册，而 `toolFilter` 只在**这个孩子的作用域**里
 * 收紧工具表 —— 两者是两套机制。宿主自己会处理一部分（实测 recon 的 `tool:write` / `tool:edit`
 * 长度归 0），但不是全部（同为 deny 的 `tool:pwsh` 照样 259 字符）。与其指望每个工具插件都自觉，
 * 不如由本函数统一算出来交给 `drop`。
 *
 * 只覆盖 `deny`。`allow` 给不出「剩下还有哪些工具」——那要一份全量工具名清单，而
 * 派发这一刻还没有：本包能拿到的调用点只有 `ctx.tools` 的 `register`/`restrict`，
 * 没有一个「列出已注册工具名」的接口。
 *
 * `allow` 那一半由 {@link allowToolSectionFilter} 换一条路解决：不靠名字清单，
 * 改在**装配时**现算 —— 那会儿 `assembly.tools` 里就是这份清单。
 * @param filter - 预设解析出来的工具围栏。
 * @returns 段名列表；没有 `deny` 时为空。
 */
export function toolSectionsForFilter(
  filter: ResolvedPreset['toolFilter'],
): readonly string[] {
  const deny = filter?.deny
  if (deny === undefined) return []
  return deny
    .map(name => name.trim())
    .filter(name => name.length > 0)
    .map(name => `${TOOL_SECTION_PREFIX}${name}`)
}

/** 装配时能看到的那些字段。只需要工具名，其余一概不碰。 */
export interface AssemblyToolListing {
  /** 本次装配时该代理可见的工具（`SystemPrompt.assemble` 返回的 `tools`）。 */
  readonly tools?: readonly { readonly name: string }[]
}

/**
 * 按 `allow` 白名单决定某个工具说明段要不要留。
 *
 * 为什么不是一张丢弃名单（`drop` 那条路）：`drop` 是 persona 里的一段**静态文本**，
 * 在派发那一刻就得定下来，而那时根本不知道这世上还有哪些工具。改成往段里存一个
 * **函数**，每次装配现算就没有这个问题 —— 而且多装配安全：第一装配时 `assembly.tools`
 * 还不全（装配本身收完才生成它），那种情况下本函数**一律保留**，宁可多留一段也不误删。
 *
 * 只可能丢 `tool:` 前缀的段：`tools:sdk`（整块 SDK 文档，本就按代理重算）与
 * `tools:ptc-only`（「run_code 是唯一能直接调用的工具」这句是自指，对受限代理反而是
 * 唯一正确的使用说明）都不在 `tool:` 命名空间里，天然碰不到。
 *
 * 空文本的段在渲染时会被丢掉（`renderPrompt` 的 `.filter((text) => text.length > 0)`），
 * 所以返回 `''` 就是「这一段不出现」，不需要真的把注册摘掉 —— `SystemPrompt` 也没有
 * 摘注册的接口。
 * @param allow - 白名单里的工具名。
 * @param sectionName - 段的完整名字（只处理 `tool:` 前缀的那些）。
 * @param assembly - 本次装配的返回值，用来判断清单是否已经可用。
 * @param originalText - 该段原本的文本。
 * @returns 该段的文本，或空串表示丢弃。
 */
export function allowToolSectionFilter(
  allow: readonly string[],
  sectionName: string,
  assembly: AssemblyToolListing,
  originalText: string,
): string {
  if (!sectionName.startsWith(TOOL_SECTION_PREFIX)) return originalText
  const listed = assembly.tools
  // 工具清单还没生成（例如导入期的那次装配）：不误删，一律保留。
  if (!Array.isArray(listed) || listed.length === 0) return originalText
  const toolName = sectionName.slice(TOOL_SECTION_PREFIX.length)
  return allow.includes(toolName) ? originalText : ''
}

/** 预设名不在表里。**不静默退化成「继承父」**——那会让一次笔误变成一次权限提升。 */
export class UnknownPresetError extends Error {
  /** 表里现有的名字，供模型自己纠正。 */
  readonly known: readonly string[]
  /**
   * @param name - 模型给的预设名。
   * @param known - 表里现有的名字（已排序）。
   */
  constructor(name: string, known: readonly string[]) {
    super(`unknown preset "${name}"; configured presets: ${known.length > 0 ? known.join(', ') : '(none)'}`)
    this.name = 'UnknownPresetError'
    this.known = known
  }
}

/** 预设表里两个围栏都给了空数组——几乎总是「配置被物化成空」的 bug，照上游的判据直接拒。 */
export class EmptyPresetFilterError extends Error {
  /** @param name - 出问题的预设名。 */
  constructor(name: string) {
    super(`preset "${name}" declares an empty tool filter: pass a non-empty allow and/or deny, or omit both to inherit the parent's tools`)
    this.name = 'EmptyPresetFilterError'
  }
}

/**
 * 把一个预设名解析成 start request 的可选成员，外加那一格**生效的 preset 名**。
 *
 * `undefined` 走的是 `fallback`（默认 `'lead'`）——**不再是「继承父代理」**：实测过一次
 * 无 preset 的派发，子会话的首段逐字是父的 persona（含"总纲（用户至上）"与已废弃的
 * `plan_write`），而父的人格对一支只干一件事的子代理毫无意义。身份必须显式：
 * 没点名就按中枢那一支走。
 *
 * `fallback` 本身也不在表里时返回 `{}`（真·继承父）——那是配置残缺，不是本函数的兜底设计。
 * 查不到**显式给的**名字一律抛 {@link UnknownPresetError}。这唯一一条「返回 `{}`」的路
 * 是 `preset` 唯一会缺席的场合：没有身份名，也就没有预设名可言。
 * @param presets - 本行 Config 里的身份表。
 * @param name - 模型给的身份名，或 undefined。
 * @param fallback - 没给名字时用的身份名。
 * @returns 平铺进 `SubagentStartRequest` 的成员。
 */
export function resolvePreset(
  presets: Readonly<Record<string, PresetSpec>>,
  name: string | undefined,
  fallback?: string,
): ResolvedPreset {
  // 默认身份缺席时返回 {}（真·继承父）而不是抛：抛出来的话，一张还没配 lead 的表
  // 会让**每一次**不带 preset 的派发都失败，包括那些本来就不需要身份的。
  const target = name ?? fallback
  if (target === undefined) return {}
  const spec = Object.hasOwn(presets, target) ? presets[target] : undefined
  if (spec === undefined) {
    // 走到这里要么是模型点了名（name 有值），要么是默认身份缺席；后者已经在上面返回。
    if (name === undefined) return {}
    throw new UnknownPresetError(name, Object.keys(presets).sort())
  }
  const allow = spec.allow ?? []
  const deny = spec.deny ?? []
  if (spec.allow !== undefined || spec.deny !== undefined) {
    if (allow.length === 0 && deny.length === 0) throw new EmptyPresetFilterError(target)
  }
  const toolFilter = spec.allow === undefined && spec.deny === undefined
    ? undefined
    : {
        ...spec.allow !== undefined ? { allow: [...allow] } : {},
        ...spec.deny !== undefined ? { deny: [...deny] } : {},
      }
  return {
    ...spec.persona !== undefined ? { persona: spec.persona } : {},
    ...toolFilter !== undefined ? { toolFilter } : {},
    ...spec.maxDepth !== undefined ? { maxDepth: spec.maxDepth } : {},
    ...spec.drop !== undefined && spec.drop.length > 0 ? { drop: [...spec.drop] } : {},
    // 省略时**不带这个键**（不物化成 `{}`）：宿主那侧是「逐字段覆盖」，
    // 多出一个空对象虽然当前无害，但会让「省略 = 继承父的路由」与「显式给空 = ???」
    // 在输出里长得一样 —— 本文件已经因为物化栽过一次（见 EmptyPresetFilterError 的来由）。
    ...spec.agentOptions !== undefined ? { agentOptions: { ...spec.agentOptions } } : {},
    // 省略时**取生效的角色键自己**（`target`），不物化成 `''`：物化空串会被宿主当成一个
    // preset id 去查表，然后当场抛 not-found。取 `target` 而不是按老写法省略这个键，
    // 是因为「没写这一格」的语义是**用角色名当预设名**，不是「不要身份」——
    // 要不要真交出去由派发那刻的 {@link chooseIdentityChannel} 问名册决定。
    preset: spec.preset ?? target,
  }
}

/**
 * 丢弃指令的定界符。它被拼在 persona 文本的**最前头**，随子代理的身份一起旅行。
 *
 * 为什么要塞进 persona：`applyChildComposition`（dsh-subagent/lib/index.js）里，
 * 父能同步交给子代理的只有 `persona` 与 `toolFilter` 两个槽（`agentOptions` 只装
 * provider/model/reasoningEffort），而 `persona` 正是那个 section 的文本。
 * 换句话说，**这是唯一一条没有竞态的通道** —— 记在别处都要等 `startContinuable`
 * 返回 childId 之后才写得上，而子代理的第一次装配可能就发生在那之前。
 *
 * 代价：监听器缺席时这段指令会**原样出现在提示词里**。这是刻意的 —— 看得见，
 * 好过一条静默失效的规则。
 */
export const DROP_DIRECTIVE_OPEN = '<!--t4r71:drop='

/** 丢弃指令的收尾。 */
export const DROP_DIRECTIVE_CLOSE = '-->'

/**
 * 把丢弃列表编进 persona 文本。
 * @param drop - 要丢掉的 section 名。
 * @param persona - 原始 persona 文本。
 * @returns 前置了指令的 persona 文本。
 */
export function encodeDropDirective(drop: readonly string[], persona: string): string {
  // 幂等：先剥掉 persona 上可能已经带着的那一层指令。两条派发通道各算一次 drop，
  // 而队友那条的 persona 是从直连逻辑**流过来**的，不剥就会叠成两层
  // （实测症状：`<!--t4r71:drop=tool:task,tool:task-->` 之后又跟一层）。
  const existing = decodeDropDirective(persona)
  const base = existing === undefined ? persona : existing.text
  const names = [...drop, ...existing?.drop ?? []]
    .map(name => name.trim())
    .filter(name => name.length > 0 && !name.includes(','))
    .filter((name, index, all) => all.indexOf(name) === index)
  if (names.length === 0) return base
  return `${DROP_DIRECTIVE_OPEN}${names.join(',')}${DROP_DIRECTIVE_CLOSE}${base.length > 0 ? '\n' + base : ''}`
}

/**
 * 从 persona 文本里解出丢弃列表，并剥掉指令本身。
 *
 * 没带指令时返回 `undefined`（而不是一个空的 drop 列表）—— 调用方据此走"原样返回"的
 * 快路径，连新对象都不必造。
 * @param text - persona section 的文本。
 * @returns 丢弃列表与剥净的文本，或 undefined。
 */
export function decodeDropDirective(text: string): { readonly drop: readonly string[]; readonly text: string } | undefined {
  if (!text.startsWith(DROP_DIRECTIVE_OPEN)) return undefined
  const end = text.indexOf(DROP_DIRECTIVE_CLOSE, DROP_DIRECTIVE_OPEN.length)
  if (end < 0) return undefined
  const drop = text.slice(DROP_DIRECTIVE_OPEN.length, end).split(',').map(name => name.trim()).filter(name => name.length > 0)
  const rest = text.slice(end + DROP_DIRECTIVE_CLOSE.length)
  return { drop, text: rest.startsWith('\n') ? rest.slice(1) : rest }
}

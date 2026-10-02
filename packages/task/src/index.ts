/**
 * 一等 `task` 工具：任务树与在树上干活的子代理，收在同一个入口。
 *
 * 它取代九件工具：delegation 五件套（`subagent` / `subagent_fork` / `list_agents` /
 * `send_message` / `interrupt_agent`）与任务树四件套（`plan_write` / `plan_step` /
 * `plan_ask` / `plan_dispatch`）。实测字符账见
 * `M:\T4\out\stage2\E1-字符账（修正版）.md` §9：本工具的块长 **2,383**，取代 15,014。
 * （2,383 是 2026-09-29 改 `result` 描述之后的当时值；改前为 2,354，E1 §9 记的就是那个。
 * 此后 `result` 的描述又改过（删掉 `wait` 参数并把结算语义写成实话），**E1 §9 的 2,383 已过期，
 * 本注释不重算它**——要一个当前数字就重新量一次块长，别拿旧数当现值。）
 *
 * ## 状态在哪
 *
 * 任务树**不写任何会话事件**。它住在 `@t4r71/dsh-plan-tree` 的独立 Loader 行
 * `plan-tree-sessions` 的 volatile settings 字段 `trees` 里（会话 id → 树）。
 * 本工具**不自己开第二份存储**：它通过 `taskTree` 服务拿同一个 store，否则两半会各说各话。
 * 为什么不写事件：`plan/declared` 与 `plan/step` 不在 0.1.7 的 `KNOWN_SESSION_EVENT_TYPES` 里，
 * 持久化读路径对白名单外且非 `ignorable` 的事件会**拒绝解释整个 log**，而 `Session.append`
 * 的信封里根本没有 `ignorable` 这个键。写入侧毫无警告，读取侧整份日志作废。
 * 已由协调者一手复现：`M:\T4\out\stage2\evidence\verify-log-safety\README.md`。
 *
 * ## 派发怎么走：一律直连子代理
 *
 * 逐次派发**不支持预设名**（`SubagentStartRequest` 没有 `preset` 槽），所以预设名是本包
 * 自建的一张表（见 `./presets.ts`）。
 *
 * **唯一的路是 `ctx.subagents`**（Agent Teams 已于 2026-10-02 整条摘掉）：派发配方逐字对齐内置 `tool-subagent`
 * （`dsh-tool-subagent/lib/index.js:509-532`）：`parent` 取 `exec.agent`，`persona` / `toolFilter` /
 * `maxDepth` 平铺进 request，再包成 `{ provider, label, request, signal }` 交给
 * `ctx.subagents.startContinuable()`。没有 Agent Teams 的组合也走这条路。
 *
 * ## 结算不在这里等
 *
 * 子代理的结算是运行时**推**进来的：`createSettlementMessage`
 * （`dsh-subagent/lib/index.js:633-654`）把摘要与收尾文本做成一条
 * `source.kind === 'subagent-settled'` 的 user message，父代理在**下一轮**自然看到它。
 * 工具执行期内这条消息**看不到**——所以本工具不提供任何等待语义：`result` 只回读已经落进
 * 本会话的东西，看不到就返回 `running`，把判断交回给模型。曾有过一个 `wait` 参数，真机实测
 * 永远等不到（轮询到 120000ms 执行期限），已整个删除，见
 * `M:\T4\out\stage2\S22-dispatch与wait修正.md`。
 *
 * ## 子代理的状态从哪来：派生，不是散文
 *
 * 树按会话 id 隔离：`bind` 写的那个节点只在**父会话**的树里，子代理自己的树里没有它，
 * 所以子代理**做不到**用 `task` 的 `step` 改自己那个节点（实测报
 * `task-tree: no node with id "..." in this session's tree`）。
 *
 * 旧版让子代理在结语末尾手写一行 `状态：完成`，父侧再把这行**散文**解析回来。这条协议
 * 2026-10-02 真机翻过车：`guard` 把结语换成只保留尾部 K 字符的信封时那一行被吃掉，
 * 于是**两个实际已经干完的子代理在树上显示成 failed**。根因就是「状态靠散文声明」。
 *
 * 现在改成**从宿主回传的结束原因派生**：运行时写的摘要句（`source.summary`）由
 * `settlementSummary` 的固定模板生成，模板与 `stopReason` 一一对应（见
 * {@link readStopReason}），插件按模板反推出一个**类型化的中止原因**，再派生出节点状态
 * （{@link settlementPatch}）。成败判据因此不再依赖子代理写了什么，也不依赖信封保留了哪些字符。
 *
 * 子代理照常写它的完整结语（`## 结论 / ## 证据 / ## 判不了`）—— 那是产出物，必须有；
 * 它只是**不再背「写状态行」这个负担**，也不必再让那一行躲过信封的长度限制。
 *
 * ## 明确不做
 *
 * **不做 git worktree / 每子代理 cwd 隔离**：`SubagentStartRequest` 没有 cwd 槽，唯一能配 cwd 的
 * 后端能力全 false，沙箱按会话 header 的 cwd 授予。子代理与父**共享同一份检出**，schema 里也
 * 因此不出现 `cwd` / `worktree`。
 *
 * @module @t4r71/dsh-task
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
// 服务面的类型来自这个模块的 `declare module '@deepseek-ai/cordis'` 增补：
// 没有这条 import，`ctx.subagents` 在 Context 上不存在（模块增补不会被自动加载）。
import type { SubagentInterruptAuthority, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Dict } from '@deepseek-ai/cosmokit'
import { allowToolSectionFilter, decodeDropDirective, encodeDropDirective, resolvePreset, toolSectionsForFilter } from './presets.ts'
import type { PresetAgentOptions, PresetSpec } from './presets.ts'

export { PRESETS_FIELD, resolvePreset, UnknownPresetError, EmptyPresetFilterError } from './presets.ts'
export type { PresetSpec, ResolvedPreset } from './presets.ts'
import type { AssemblyToolListing, ResolvedPreset } from './presets.ts'
// 账本那一半（类型、校验、原子读-改-写）在 `./session-store.ts` 里，构建时被**内联进**本入口：
// 它不是另一个 Loader 行，也没有自己的插件入口 —— 账本是本包自己的一个 JSON 文件，
// 由 `task` 这一行直接读写（`createTaskRuns`），这样工具面与自动放行不可能各开一份存储。
import {
  createTaskRuns,
  fillRunPrompt,
  ledgerPathFor,
  normalizeRunNodes,
  patchRunNode,
  runNodeWith,
  type RunNodeRecord,
  type RunRecord,
  type RunSpecNode,
  type TaskRunsService,
} from './session-store.ts'

/**
 * 决策节点的 id 前缀。`ask` 写下的每一个问题都带这个前缀，
 * 于是「哪些节点是决策」是一个可机读的事实，而不是靠标题措辞去猜。
 */
const DECISION_PREFIX = 'ask-'

/**
 * 决策段落在提示词里的位置。
 *
 * 取 **10300**（2026-10-02 由 650 后置而来）：大于宿主 `SECTION_ORDERS` 里的最大值
 * `DEPLOYMENT_PERSONA_SUFFIX`(10200)，于是这一段排到**所有静态段之后**。
 *
 * 为什么后置：本段的 `text` 是函数、**每次装配都重新求值**，是当前系统提示词里
 * 变动最频繁的动态段。原位置 650 把它插在 `harness:identity`(-1000) 与 `PTC_ONLY`(800)
 * 之间，一次变化就让其后约 32KB 的前缀缓存全部失效；挪到队尾后失效面只剩队尾的
 * 3KB 左右。位置只影响段顺序，不影响文本内容。
 *
 * **必须是字面数字**：`getSectionOrder()` 只认 `SECTION_ORDERS` 里已有的名字，
 * 杜撰一个会拿到 `undefined`，而 `section()` 对非有限 order 直接抛错。
 * 10300 不与表内任何一项重名、也不与值冲突（表内最大 10200）。
 */
const DECISION_SECTION_ORDER = 10300

/**
 * 全局规则段在提示词里的位置。
 *
 * 取 **-500**：`harness:identity` 是 -1000、`deployment:persona-prefix` 是 0。
 * 夹在两者之间，于是顺序正是操作者要的那句「先有全局规则段，后面接上身份段」：
 * 「harness 是谁」→「对谁都成立的规则」→「你这个身份是谁」→（500 起）政策与工具说明。
 *
 * 这一版之前取过 100（落在 persona 之后），真机装配一读就看出顺序反了：
 * 身份在前、规则在后，与分层意图不符。
 * **必须是字面数字**：`getSectionOrder()` 只认 `SECTION_ORDERS` 里已有的名字，
 * `100` 不在表里，杜撰一个名字会拿到 `undefined`，而 `section()` 对非有限 order 直接抛错。
 */
const GLOBAL_RULES_ORDER = -500

/** 全局规则段的 section 名。本包自有，不与宿主的任何段重名。 */
const GLOBAL_RULES_SECTION = 'task:global-rules'

/**
 * 没给 `preset` 的派发用哪个身份。
 *
 * **不再是「继承父代理」**：那条路会让子代理拿到父那 1977 字符的 persona —— 实测到过一次
 * （子会话 3872e115 的 system-prompt 首段逐字是父的「总纲（用户至上）/身份层（persona）」，
 * 其中还写着已被本工具取代的 `plan_write`）。身份必须显式，默认取中枢那一支。
 */
const DEFAULT_PRESET = 'lead'

/**
 * persona 那一段的 section 名。
 *
 * 名字由 `applyChildComposition` 定死（dsh-subagent/lib/index.js），父改不了；
 * 丢弃指令就藏在这一段的文本里 —— 那是父能同步交给子代理的唯一自由通道。
 */
const PERSONA_SECTION_NAME = 'deployment:persona-prefix'

/**
 * 问答节点在 `detail` 上的语义前缀。
 *
 * 这个字符串**不是本包发明的**：ui-task-tree 的 `src/client/semantics.ts` 里有成文约定 ——
 * `答：<用户的回答>` 标记用户问答节点，`kindOf()` 据此返回 `'note'`，渲染层再画那个
 * `?` 图标（`StatusGlyph.tsx` 的 `QuestionGlyph`）。裸写答案既拿不到图标，也识别不出回答。
 *
 * 面板不给节点加独立字段（宿主的 `plan_write` 用 `additionalProperties: false` 校验，
 * 多一个字段直接拒），所以呈现语义**只能**由 detail 承载。
 */
const ANSWER_PREFIX = '答：'

/**
 * 面向模型的提问工具名。
 *
 * 子代理那一支在**自己的作用域**里用它遮蔽宿主继承来的同名工具：工具表按作用域分层，
 * 本层注册覆盖继承来的那份（`dsh-tools/lib/index.js` 的 `view(scope)`），
 * 所以遮蔽不需要动宿主一行代码。
 */
const ASK_TOOL_NAME = 'ask_user_question'

/**
 * 委派层数上限。**数的是层数，不是索引**：主代理是第 1 层，它派出去的孩子是第 2 层，
 * 孩子再派是第 3 层，到第 3 层为止不再往下。
 *
 * 为什么由本工具自己守（而不是只靠 `maxDepth` 槽）：宿主那一槽按**派发链**算，
 * 本工具按会话 header 的 `delegationDepth` 算，两者不总是同一个答案；自己守一道，
 * 「三层」这个约束就不取决于走哪条路。
 */
const MAX_DELEGATION_DEPTH = 3

/**
 * 决策段读合并视图时往下拼几层。
 *
 * 取委派层数上限：中枢 → 子代理 → 孙代理 就是这个插件允许的最深一条链，
 * 第 3 层再派会被 `assertCanDelegate` 直接拒掉，所以「看得见所有人问过的决策」
 * 与「不为不存在的层白读」是同一个数，跟着上限走而不是另抄一个 3。
 */
const DECISION_MERGE_DEPTH = MAX_DELEGATION_DEPTH

/**
/**
 * 角色名（**实际生效的 preset 键**）→ 中文显示名。
 *
 * 只影响**给人看的两处**：树节点标题与提问卡片前缀（两者都取自 `installAskProxy` 的 label）。
 * 不碰 tool 名、preset 键名与 agent name —— 那些是程序对号入座用的键，
 * 跟着显示名一起改会把预设解析弄坏。
 *
 * **查表的键必须是 `resolvePreset` 采纳的那个键，不是调用方自由填的 label**：
 * 实测 seq=2057 有一次点名 `preset:"impl"` 而 `label:"验证"`，于是面板显示「验证」、
 * 实际跑的却是 impl 身份 —— 显示层说的与实际生效的身份对不上，比不显示更坏。
 * 所以 `dispatchTo` 一律把**生效键**（`spec.preset ?? DEFAULT_PRESET`）交给
 * {@link roleLabel}，label 只当回退显示名，不再参与身份显示。
 *
 * 刻意**不给 scout 映射**：它与 recon 都译成「侦察」的话，树上看不出到底是哪个预设，
 * 而 scout 是注释里标注的临时身份。查不到的名字一律原样留着，正好把这两者分得开。
 */
const ROLE_LABELS: Readonly<Record<string, string>> = {
  recon: '侦察',
  impl: '实现',
  verify: '验证',
  lead: '中枢',
}

/**
 * 把角色名翻成中文显示名；查不到的**原样返回**。
 *
 * 入参按契约是**实际生效的 preset 键**（见 {@link ROLE_LABELS}）。只在调用方
 * 真的没点名 preset 时才轮得到 label 当回退显示名 —— 那种情况下没有生效键可显示，
 * 退回调用方自己的措辞比编一个角色名诚实。
 * @param key - 生效的 preset 键（或没有 preset 时的 label 回退）。
 * @returns 中文显示名，或原样。
 */
function roleLabel(key: string): string {
  return ROLE_LABELS[key] ?? key
}

/**
 * 节点指令段的稳定锚点。测试按它断言「这一段确实追加了」；改文案时别动它。
 */
const NODE_BRIEF_ANCHOR = '【节点状态】'

/**
 * **只在 run 链路**（{@link dispatchRunNode} 派出的节点）追加的那一句：要求子代理把给下游用的
 * 结论写简略。
 *
 * 它解决的是「上游写多长」而不是「下游收到多少」：注入那一侧给的是**结算正文全文**
 * （单条上限 20000 字），所以真正的浪费只能从源头掐 —— 上游复述过程、贴长日志，下游就得
 * 整段读完。用户的裁决就一句「改提示词啊」，所以这里加的是提示词，不是新的截断。
 *
 * `dispatch` 动作的简报**逐字不变**：那条路没有下游，这一句对它没有任何意义，
 * 而既有语义与断言都钉在它的逐字文本上。
 */
const CONCISE_CONCLUSION_LINE = '结语里给下游用的**结论**尽量简略（建议 ≤500 字）：只写结论与关键证据，不要复述过程、不要贴长日志。'

/**
 * 结语必须按固定小节开头的那一段。**这是第 6 项的替代方案，替代 JSON 模式。**
 *
 * 为什么不是 JSON 模式：`LlmCallConfig` 无输出格式字段（`dsh-llm/lib/typert.host.js:340-341`），
 * 且本包只能走连续型子代理（本文件 1432 行的 `startContinuable`），而
 * `ContinuableStartSpec.request` 在类型上就把 `outputSchema` 排除了
 * （`dsh-subagent/lib/typert.host.js:346-348`）。零 LLM 能力能做到的只有**约定**。
 *
 * 本节与信封是哪两件事能对上的：结语进父会话时会被 guard 插件换成**信封**
 * （`packages/guard/src/envelope.ts`），信封只显示这几个小节的**头几行**，其余落盘。
 * 所以小节名与顺序**两侧逐字一致**，改一边必须改另一边；不写小节不会丢内容
 * （全文永远落盘、信封给路径与 sha256），只是父代理看不到你的提要。
 */
const ENVELOPE_SECTIONS_LINE = '结语请以固定小节的**一级标题**开头，顺序照写：'
  + '`## 结论`（一句到三句，说清做成了什么或卡在哪）、'
  + '`## 证据`（file:line 或实测数字，一行一条）、'
  + '`## 判不了`（没做或没跑成的，写清缺哪份前提）。'
  + '父代理只会看到每个小节的**前几行**，全文会落到磁盘上并附 sha256 ——'
  + '所以把最重要的放前面，不必为了省字数牺牲内容。'

/**
 * 派发简报后面追加的节点指令：把「你自己那个节点」的存在与收尾责任交给子代理。
 *
 * 为什么必须有这一段：`step` 与「节点」此前在 `task` 的描述里出现 **0 次** ——
 * 从来没有任何地方告诉子代理「你要更新自己的节点状态」。现场后果是实测到的：
 * 派出去的子代理活干完了，树上它自己的节点**始终停在 pending**，而用户不展开子代理
 * 的上下文，**面板是唯一的信息出口**，于是面板上什么都看不到。
 *
 * 为什么是**通报**而不是让它自己调 `step`：树按会话 id 隔离，`bind` 写的那个节点落在
 * **父会话**的树里，子代理自己的树里根本没有它 —— 实测那一调用只会抛
 * `task-tree: no node with id "..." in this session's tree`。
 *
 * **2026-10-02 起这一段不再要求任何状态行**：节点状态由插件从宿主回传的结束原因**派生**
 * （见 {@link settlementPatch}），所以子代理只要照常写下它的完整结语即可。旧文案要求的那一行
 * 既是它的额外负担，又正是 2026-10-02 那场事故的引信 —— `guard` 的信封只保留结语尾部
 * K 字符，那一行被吃掉，父侧就再也认不出结局，于是**两个已经干完的子代理在树上显示成 failed**。
 * 把要求撤掉，协议里就再没有「必须躲过截断才作数」的东西。
 * @param prompt - 调用者给的原始简报，一个字都不改，原样排在最前。
 * @param bind - 绑定的节点 id；**省略时原样返回**，绝不编造一个节点出来。
 * @param concise - 是否追加「结论要简略」那一句（{@link CONCISE_CONCLUSION_LINE}）。
 *   只有 run 链路给 true。
 * @returns 追加了节点指令的简报。
 */
function withNodeBrief(prompt: string, bind: string | undefined, concise = false): string {
  if (bind === undefined) return prompt
  const brief = NODE_BRIEF_ANCHOR
    + `你绑定的节点是 \`${bind}\`（in_progress 已由插件写入，不必再设）。`
    + '**不要写状态行**（旧版要求的末尾 `状态：完成` / `状态：失败` 已经取消）：'
    + '你那一步成没成，插件按运行时回传的结束原因自己判，不用你报，你也报不准（正常结束不等于活干对了）。'
    + (concise ? CONCISE_CONCLUSION_LINE : '')
    + ENVELOPE_SECTIONS_LINE
    + '结论摘要进节点的 detail（上限 200 字，超出截断），那是用户在面板上唯一看得到的内容，写清楚。'
    + '不要用 task 工具的 step 去写这个节点 —— 也写不成：树按会话隔离，你自己的树里没有它，'
    + '那一次调用只会报 no node with id。'
  return prompt.length === 0 ? brief : prompt + '\n\n' + brief
}

/** 本插件的 Loader 行 id，同时也是本行 Config 的设置命名空间。 */
export const name = 'task'

/**
 * 本插件硬依赖的服务面。
 *
 * `'agents'` **必须在里面**：{@link advanceRuns} 要拿「当刻活着的父 Agent」才能派后继，
 * 而 cordis 对未声明 `inject` 的服务**读一下就抛** `cannot get property "agents" without inject`。
 * 这一句当初漏了，代价很实在：自动放行在那一步抛错，被「绝不抛」的 catch 吞成一行宿主日志，
 * 表现出来只是「B 没被派出去」—— 真机实测，见 2026-10-01 的那次 task run（A 结算后 B 停在 pending）。
 *
 * `settings` **不在**里面：账本已改成插件自己的 JSON 文件，不再经过宿主设置服务。
 */
export const inject = ['tools', 'subagents', 'userQuestions', 'systemPrompt', 'agents']

/**
 * 本行的组合配置。
 *
 * `presets` **不是** volatile：它是给人编辑的，应当出现在设置页上。
 * **本行没有任何 volatile 字段**：`volatile` 的语义是「列出可热改字段」而不是隐藏，
 * 所以它只适合小开关，不适合账本那种大对象 —— 历史上账本曾住在 `runs` 这一个 volatile
 * 字段上，设置页于是把整份账本 JSON 投影成一个可以手滑清空的输入框。
 *
 * 现在账本是**本包自己的一个 JSON 文件**，位置由 {@link ledgerPathFor} 决议
 * （`runsFile` 配置 → 环境变量 → `ctx.baseUrl` → `DSH_PROFILE_DIR`/`DSH_HOME` → cwd），
 * 既不进设置文档、也不需要任何 Loader 行。本行只留一个 `runsFile` 让人挪动它。
 */
export interface ResolvedConfig {
  readonly provider: string
  /** 全局规则段：每一个代理共享的一段规则；空串表示没有这一段。省略即没有。 */
  readonly defaultRules?: string
  /** 身份名 → 身份段（人格） + 工具围栏 + 深度上限 + 丢弃清单。 */
  readonly presets: Readonly<Record<string, PresetSpec>>
  /**
   * 后端账本文件的位置；空串走 `ledgerPathFor` 的默认位置。
   *
   * 两格都标成可选是**实情**而不是宽容：schema 里它们各有默认值（空串），所以「没写」
   * 与「写空串」在解析之后是同一件事，代码里两处也都按 `?? ''` 读。这样单测可以直接
   * 只给真正要考的那几格，不必抄一遍默认值 —— 抄出来的默认值一旦哪天变了，测试还会
   * 静默绿着。
   */
  readonly runsFile?: string
}

/**
 * 本行 Config 的 schema。
 *
 * 与 `packages/dual-axis/src/session-store.ts:116` 同一处理：`z.dict` 的推导输出里出现
 * `Dict`（来自 `@deepseek-ai/cosmokit`），而本包只通过嵌套的 node_modules 才够得到它，
 * 声明文件生成会以 TS2883 拒绝。此处**不标注**、原样导出推导类型，改为把 cosmokit 提成
 * devDependency（见 `package.json`），让那条 import 有本包自己的解析路径。
 */
/**
 * 上面那行 Config schema 里 `presets` 一个条目的输出形态。
 *
 * 与 {@link PresetSpec} 是同一件事的两种写法：这里全部**可变、非 readonly**——schema 的输出
 * 里 `allow` / `deny` 是 `string[]`，readonly 版本过不了 `z<...>` 的赋值检查。
 */
export interface PresetSpecField {
  persona?: string
  allow?: string[]
  deny?: string[]
  maxDepth?: number
  agentOptions?: PresetAgentOptionsField
}

/**
 * 上面那行 Config schema 里 `agentOptions` 一个条目的输出形态。
 *
 * `reasoningEffort` 在这里收 `z.string()` 而不是宿主的 `ReasoningEffortId`：
 * 那是 `@deepseek-ai/dsh-llm` 的 branded 类型，而本包**不该**为了一格配置去依赖 llm 包
 * （它连 devDependency 都不是，引进来要么新增一条运行时解析路径、要么在声明文件里
 * 暴露一个够不到的名字）。收成普通字符串之后，校验交给下游 —— 真给了宿主不认的值，
 * 那一层会自己拒，报错位置比这里更准。
 *
 * 少了这一格 schema 不会报错，只会把配置表里写下的 agentOptions 悄悄吃掉
 * （schema 输出形态与 {@link ResolvedPreset} 必须逐字段对齐）。
 */
export interface PresetAgentOptionsField {
  provider?: string
  model?: string
  reasoningEffort?: string
  maxTokens?: number
}

export const Config: z<{ provider: string; defaultRules?: string; presets: Dict<PresetSpecField>; runsFile?: string }> = z.object({
  /** `ctx.subagents` 里的 provider 名，必填——`startContinuable` 的第一个参数就是它。 */
  provider: z.string().required(),
  /**
   * 全局规则段：**每一个**代理共享的一段规则（中枢、子代理、孙代理都一样）。
   *
   * 它在根作用域注册一次，order 取 {@link GLOBAL_RULES_ORDER}——排在
   * `harness:identity`(-1000) 之后、`deployment:persona-prefix`(0) 之前，于是每个代理的
   * 提示词都是「harness 身份 → 全局规则 → 各自身份 → 政策 → 工具说明」。
   * 空串（默认）表示这一段不存在，行为与加这一项之前一字不差。
   */
  defaultRules: z.string().default(''),
  /** 预设名 → persona + 工具围栏 + 深度上限。 */
  presets: z.dict(z.object({
    persona: z.string(),
    // `.default(undefined)` 不是装饰：schemastery 会把**省略的**数组物化成 `[]`，
    // 而 `resolvePreset` 把「两个围栏都空」判为配置事故（EmptyPresetFilterError）。
    // 两者叠加的后果是：`presets.ts` 文档承诺的出路——「omit both to inherit the
    // parent's tools」——通过真实配置管线**根本走不通**，一个只想继承全部工具的
    // preset（本文件的 `lead`）会在派发时 100% 抛错。
    //
    // 已实测（task/_probe-schema.ts）：`.default(undefined)` 让省略保持缺席（`{}`），
    // 而**显式**写的 `allow: []` 仍原样保留为 `[]`、照旧触发护栏。
    // 于是「不限」与「一个都不许」这两种相反的意图各自可表达，fail-closed 不丢。
    // 这里必须放宽类型：schema 的 `.default` 签名只收 T 或 T 的元素，`undefined` 不在内，
    // 而本行要的恰恰就是「默认值是不存在」。运行时语义与 `undefined` 一致（已实测），
    // 所以这个 cast 只骗类型系统，不改变任何行为。
    allow: z.array(z.string()).default(undefined as unknown as string[]),
    deny: z.array(z.string()).default(undefined as unknown as string[]),
    maxDepth: z.natural(),
    // `.default(undefined)` 与上面两个围栏同一个道理，**实测过**（task/_probe-agentoptions.ts）：
    // schemastery 会把省略的嵌套对象物化成 `{}`，而不是让它缺席。物化之后
    // `resolvePreset` 会平铺出一个空对象，宿主那侧虽然暂时无害，但「省略 = 继承父的路由」
    // 与「显式给空」在输出里就分不出来了 —— 本文件已经因为物化栽过一次（见上面 allow/deny）。
    // 加上它之后：省略保持 `undefined`（`hasOwn` 为 false），显式写的照旧原样解析。
    agentOptions: z.object({
      provider: z.string(),
      model: z.string(),
      reasoningEffort: z.string(),
      maxTokens: z.natural(),
    }).default(undefined as unknown as PresetAgentOptionsField),
  })).default({}),
  /**
   * 后端账本（自动放行流水线）落盘的文件位置。空串（默认）走 {@link ledgerPathFor}
   * 的完整决议链：本格 → 环境变量 `DSH_TASK_RUNS_FILE` → `ctx.baseUrl` 指向的目录 →
   * `DSH_PROFILE_DIR`/`DSH_HOME` → `process.cwd()`。
   *
   * 它不是 volatile：账本**不住在设置文档里**，给它一个 volatile 路径只会把整份账本
   * 投影到设置页的表单上 —— 那正是这条存储路径当初要避开的事。这一格只是给人一个
   * 挪动文件的机会（以及给测试一个不碰真实 profile 的入口）。
   */
  runsFile: z.string().default(''),
})

/** 提问服务回答里的一条。 */
interface UserQuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** 本工具用到的那一小片 user-questions 服务。 */
interface UserQuestionsSurface {
  /**
   * 让人类回答一个问题。
   * @param request - 问题列表、可选的提问者、以及取消信号。
   * @returns 每问一条的回答。
   */
  ask(request: {
    questions: readonly {
      id: string
      question: string
      header?: string
      options?: readonly { label: string; description?: string }[]
      multiSelect?: boolean
    }[]
    agent?: Agent
    signal?: AbortSignal
  }): Promise<{ answers: readonly UserQuestionAnswerItem[] }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * 可选的提问服务：没有人类应答者的组合里它缺席，`ask` 动作因此**明确报错**，
     * 而不是返回一个模型会读成「已问过」的空答案。
     */
    userQuestions?: UserQuestionsSurface
  }
}

/** 任务树的读取面。**这是本工具对 plan-tree 的唯一依赖**，形状刻意收窄成四个方法。 */
export interface TaskTreePort {
  /** 读出这条会话当刻的树（没有则空数组）。 */
  read(sessionId: string): readonly TaskNode[]
  /**
   * 读出这条会话的树，并把每个派发出去的节点（`assignedTo`）所对应的子会话
   * 自己写的那棵树，拼到该节点下面。
   *
   * 子代理照常写自己的树，对本调用一无所知；连接点是 `bind` 已经记下的
   * `assignedTo`，所以派发时不需要额外传任何东西。
   */
  readMerged?(sessionId: string, maxDepth?: number): readonly TaskNode[]
  /** 按扁平列表写入节点；`replace` 为真时整树替换。 */
  write(sessionId: string, nodes: readonly FlatNode[], replace: boolean): Promise<void>
  /** 移动一个节点的状态与说明。 */
  step(sessionId: string, nodeId: string, patch: { status?: TaskNodeStatus; detail?: string }): Promise<void>
  /** 记录某次派发落在哪个节点上（写 childId，供收到结果时回填）。 */
  bind(sessionId: string, nodeId: string, childId: string): Promise<void>
}

/** 树里的一个节点（store 里是嵌套形态）。 */
export interface TaskNode {
  readonly id: string
  readonly title: string
  readonly detail?: string
  readonly status: TaskNodeStatus
  readonly assignedTo?: string
  readonly children?: readonly TaskNode[]
}

/** 节点状态机。`completed` 只由**显式调用**或子代理自己回传的状态行置位，绝不从「它结算了」这件事推断。 */
export type TaskNodeStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

/** 模型输入的扁平节点。**嵌套只来自 `parent`**，不来自把节点装进另一个节点。 */
export interface FlatNode {
  readonly id: string
  readonly parent?: string
  readonly title: string
  readonly detail?: string
}

/**
 * run 的节点写进树时用的标题：`[角色] 简报首行`。
 *
 * detail 是给人看的**短句**，所以依赖写在那里，整段 prompt 一个字都不进树。
 * @param node - 归一后的节点。
 * @returns 树节点。
 */
function runTreeNode(node: RunSpecNode): FlatNode {
  // 与派发侧同一条规矩（见 {@link ROLE_LABELS}）：先看**生效的 preset 键**，没有 preset 时才
  // 退回 label 当显示名。反过来（label 优先）会让 label 写「验证」的 impl 节点被画成「验证」，
  // 而它实际跑的是 impl 身份 —— 那正是这次要消掉的错配。
  const role = node.preset ?? node.label
  const title = (role === undefined ? '' : '[' + roleLabel(role) + '] ') + singleLine(firstLineOf(node.prompt))
  return {
    id: node.id,
    title: truncate(title === '' ? node.id : title, 120),
    detail: node.needs.length === 0 ? '起点：无依赖，立即派发' : '等待依赖：' + node.needs.join('、'),
  }
}

/**
 * 取一段文本的第一行（不是整段）。
 * @param text - 任意文本。
 * @returns 第一行，去两端空白。
 */
function firstLineOf(text: string): string {
  const at = text.indexOf('\n')
  return (at < 0 ? text : text.slice(0, at)).trim()
}

/**
 * 自动放行用的取消信号：**永不取消**。
 *
 * `startContinuable` 的 `signal` 是必填的（`ContinuableStartSpec.signal: AbortSignal`），
 * 而自动放行没有调用者、也就没有调用方的取消信号 —— 这条流水线本来就该在后台自己跑完。
 * 拿一个共享的、没有任何人 abort 的 signal 表达「不因调用方取消而取消」，绝不编一个假的。
 */
const AUTO_DISPATCH_SIGNAL = new AbortController().signal

/**
 * plan / dispatch 的节点每项都要有 title。
 *
 * 为什么不在 schema 里标 `required`：`nodes` 现在被两个动作共用，
 * run 的节点形状是 `{ id, prompt, needs? }` —— 把 title 标成必填，run 就根本传不成。
 * 于是这条必填下沉到这里，按动作报清楚。
 * @param action - 动作名，只用于报错。
 * @param nodes - 模型给的节点列表。
 * @throws 当某一项缺 title。
 */
function assertTitledNodes(action: string, nodes: readonly { readonly id: string; readonly title?: string }[]): void {
  for (const node of nodes) {
    if (typeof node.title !== 'string' || node.title === '') {
      throw new Error('task ' + action + ': node "' + node.id + '" needs a `title` — that is what the panel shows')
    }
  }
}
/**
 * 把 `task` 注册进工具面，并把 `taskTree` 服务接上。
 *
 * 树的存储**不在本包**：`taskTree` 缺席时树类动作必须**明确报错**，而不是静默成功。
 *
 * **配置来自第二个形参**，不是 `ctx.config`：cordis 插件的 `apply(ctx, config)` 才是约定
 * （本仓 `packages/idle-guard/src/index.ts:151`、`packages/guard/src/index.ts:499` 都是这个签名）。
 * 写成 `apply(ctx)` 再读 `ctx.config` 会永远拿到 undefined，而 TypeScript 不会报错——
 * 属于那种「编译通过、运行时静默用默认值」的缺陷。
 * @param ctx - 宿主上下文。
 * @param config - 本行解析后的组合配置。
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  const tree = (): TaskTreePort => {
    const port = ctx.get('taskTree') as TaskTreePort | undefined
    if (port === undefined) {
      throw new Error('task: the `taskTree` service is unavailable — load @t4r71/dsh-plan-tree, whose `plan-tree-sessions` namespace owns the tree')
    }
    return port
  }

  /**
   * 后端账本那个服务。**它就是本包自己的一个 JSON 文件**，没有 Loader 行、没有设置命名空间、
   * 也不经过 `ctx.get('settings')`：{@link createTaskRuns} 由本行直接调用，读写都在本进程里。
   *
   * 文件位置在装载期就定下来（{@link ledgerPathFor}）：`runsFile` 配置 → 环境变量
   * `DSH_TASK_RUNS_FILE` → `ctx.baseUrl` → `DSH_PROFILE_DIR`/`DSH_HOME` → cwd。
   * 决议**只做字符串/URL 运算、绝不抛**，解析不出来的那一档直接跳过。
   *
   * 服务本身缺席不了（构造函数不发 IO）；真的写不进去时由 `store` 抛错 —— 与 {@link tree}
   * 同一条纪律：**明确报错**，绝不静默成功 —— `run` 声明的是「后端记得住这条依赖图」，
   * 记不住就等于骗调用方。
   * @returns 账本服务。
   */
  // `ctx.baseUrl` 也参与决议：账本默认落在**装载本插件的那份配置**所在目录下，
  // 而不是随启动方式变的 cwd（见 session-store 的 ledgerPathFor）。配置与
  // 环境变量仍然优先 —— 前者是显式指定，后者是测试与排障的入口。
  const runLedgerFile = ledgerPathFor(config.runsFile ?? '', ctx.baseUrl)
  const runs = (): TaskRunsService => createTaskRuns(ctx, runLedgerFile)

  /**
   * 把这条会话记录过的决策渲染成一段提示词。
   *
   * 这是「决策在压缩时重放」的落点。决策**不放在对话里**——对话会被压缩掉——
   * 而是放在任务树里，再由本函数在**每一次**装配时重新读出来。于是无论上下文
   * 被压缩过几轮，用户拍过的板都还在。
   * @param sid - 会话 id。
   * @returns 提示词片段；没有决策时返回空串（空 section 会被 renderPrompt 丢掉）。
   */
  /**
   * 去掉问答节点 detail 上的 `答：` 前缀。
   *
   * 那个前缀是给**面板**看的（它据此画 `?`）；提示词里要的是答案本身，
   * 带着一个中文冒号既啰嗦又像是模型该照抄的格式。
   * @param detail - 节点 detail。
   * @returns 剥掉前缀的答案文本。
   */
  const stripAnswerPrefix = (detail: string): string =>
    detail.startsWith(ANSWER_PREFIX) ? detail.slice(ANSWER_PREFIX.length) : detail

  const renderDecisions = (sid: string): string => {
    let nodes: readonly TaskNode[] = []
    // 树服务缺席时**静默返回空**，而不是把整个装配炸掉：这个函数跑在每次模型步的
    // 前头，为一段可选提示词让整轮对话失败是不划算的。
    try {
      const port = tree()
      // 读的是**合并视图**，不是本会话自己那棵树。
      //
      // 决策由**提问者自己**记在自己的树上（子代理把 `ask-N` 写进它的会话），父侧靠
      // `readMerged` 顺着派发时 bind 记下的 `assignedTo` 把它拼上来。这正是
      // 「中枢被压缩之后照样看得见下面所有人问过的决策」的**全部**实现：没有任何一次
      // 写入把问答搬进中枢的树，看得见全靠这次合并读取。
      //
      // 深度取委派层数上限（中枢 → 子代理 → 孙代理）：再深不存在。
      // 端口没提供合并面时退回本会话那棵树（老行为），而不是让整段提示词消失。
      nodes = port.readMerged !== undefined ? port.readMerged(sid, DECISION_MERGE_DEPTH) : port.read(sid)
    } catch { return '' }
    // 必须铺平：合并视图把子会话那棵树**挂**在派发节点的 `children` 上，
    // 只扫顶层的话，子代理问过的决策一条都看不见。
    const decisions = flattenNodes(nodes).filter(node => node.id.startsWith(DECISION_PREFIX) && node.detail !== undefined)
    if (decisions.length === 0) return ''
    return [
      '## 已裁定的事（用户已经拍过板）',
      '',
      '以下是本次会话里用户**已经明确回答过**的问题。不要再问一遍，也不要另起炉灶推翻它们。',
      '',
      ...decisions.map(node => `- ${node.title} → **${stripAnswerPrefix(node.detail ?? '')}**`),
    ].join('\n')
  }

  // 决策段落。`text` 是**函数**，每次装配重新求值（dsh-system-prompt/lib/index.js:
  // `text: typeof section.text === "function" ? section.text(context) : section.text`），
  // 而 `context` 由 `assembleContextFor` 造出来，里面带着 `agent`
  // （dsh-agent/lib/index.js: `return { agent, scope: agent, ... }`）——
  // 会话身份就是从那里拿到的。
  //
  // 没有用「记一条决策就重新注册一次 section」的写法：`PromptLayer.sections` 是
  // `NamedEntries`，**同名重复注册会直接抛错**，那条路根本走不通。
  ctx.systemPrompt.section({
    name: 'task:decisions',
    order: DECISION_SECTION_ORDER,
    text: (context: { agent?: { session?: { id?: string } } }): string => {
      const sid = context?.agent?.session?.id
      return sid === undefined ? '' : renderDecisions(sid)
    },
  })

  /**
   * 全局规则段：**每一个**代理共享的一段规则，注册在根作用域。
   *
   * 位置由 order 决定（见 GLOBAL_RULES_ORDER）：harness:identity(-1000) 之后、persona(0) 之前。
   * 根作用域注册意味着中枢、子代理、孙代理全都拿到它，而 defaultRules 为空串时
   * 这一段是空的，renderPrompt 会把它丢掉 —— 加这一项之前的行为一字不变。
   *
   * 为什么注册在根作用域而不是逐个子代理装：逐子代理装的版本**漏掉中枢自己**，而
   * 「不管是中枢还是其他特定代理」要的恰恰是同一段规则对谁都成立。
   */
  // `?? ''`：这一项是后加的，缺席等价于「没有全局规则段」。少了它，任何按旧形状
  // 组装配置的调用点都会在装载期读到 undefined.length。
  const globalRules = config.defaultRules ?? ''
  if (globalRules.length > 0) {
    ctx.systemPrompt.section({
      name: GLOBAL_RULES_SECTION,
      order: GLOBAL_RULES_ORDER,
      text: globalRules,
    })
  }

  /**
   * 中枢自己的身份段**不由本插件注册** —— 那一段走宿主既有的通道，本插件只读不写。
   *
   * 为什么不能注册：`deployment:persona-prefix` 这个名字在 SystemPrompt 的构造函数里
   * 就已经全局注册过一份（dsh-system-prompt/lib/index.js:220），而 PromptLayer.sections
   * 是 NamedEntries —— **同一层内同名注册直接抛错**，错误原文还写着「for a per-agent
   * override, register through that agent's `agent.ctx` instead」。
   *
   * 2026-09-30 实测过一次：本插件在根作用域注册这一段，整个插件装载失败 ——
   * task 工具与 task:decisions 段一起从装配里消失，而宿主自己的 persona 一字未变。
   *
   * 于是中枢身份的供给方式是：profile 的 persona 行写身份段，本插件的 defaultRules
   * 供全局规则段，两者合成「[全局规则][身份]」—— 与子代理那条路的形状一致，
   * 只是来源不同（子代理的身份来自 presets.<名>.persona）。
   */

  /**
   * 「丢弃继承段」的执行点。
   *
   * 子代理经 `composeFrom` 继承父的整层 section；这一支监听器在装配的**返回路上**
   * 把指令点名的那些段去掉，并顺手把指令本身从 persona 文本里剥掉。
   *
   * 三条纪律照抄 prompt-plan 的实测结论：
   *   - **必须返回 `next()` 的值**：`assemble` 拿这个返回值当整个系统提示词，
   *     不返回不是"跳过一步"，是把提示词删了。
   *   - **造新对象，绝不原地改**：section 对象与注册表里那份、以及别的监听器
   *     留下的快照是共享的。
   *   - 没有指令时**原样返回同一个引用**，连新对象都不造 —— 这是绝大多数装配的路径。
   */
  // 参数**不写注解**、返回值用 `as typeof produced` 收口 —— 这正是 prompt-plan 在同一个缝上
  // 已经跑通的写法。自己写 `(a: unknown, c: unknown, next: () => Promise<unknown>)` 会让
  // cordis 的 `Scoped<SystemPrompt>` 签名拒绝这个 handler（实测 TS2345）。
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const produced = await next()
    const read = produced as unknown as { sections?: readonly { name: string; text: string }[] } | undefined
    const sections = read?.sections
    if (!Array.isArray(sections)) return produced
    const at = sections.findIndex((section) => section.name === PERSONA_SECTION_NAME)
    if (at < 0) return produced
    const decoded = decodeDropDirective(sections[at].text)
    if (decoded === undefined) return produced
    const drop = new Set(decoded.drop)
    const rewritten = {
      ...read,
      sections: sections
        .map((section) => section.name === PERSONA_SECTION_NAME ? { ...section, text: decoded.text } : section)
        // persona 自己永远不丢：丢它就等于把身份抹了，那不是这一项要做的事。
        .filter((section) => section.name === PERSONA_SECTION_NAME || !drop.has(section.name))
        // `allow` 型身份的工具说明段过滤。这里做而不是在派发时注册，是因为只有到这一步
        // 才有完整的段表：当时根本不知道世上存在哪些工具，注册一个空集只会永远为空。
        .map((section) => {
          const allow = shadowsOf(_context)
          if (allow === undefined) return section
          const text = allowToolSectionFilter(allow, section.name, produced as AssemblyToolListing, section.text)
          return text === section.text ? section : { ...section, text }
        }),
    }
    return rewritten as unknown as typeof produced
  }, { global: true })

  /**
   * 「过程记录要求」（{@link PROCESS_NUDGE}）：只发给**本插件派出去的子代理**，
   * 中枢自己与别的会话一个字都不加。
   *
   * 三条纪律，与上面那条丢弃指令监听器同源：
   *   - **必须返回 `next()` 的值**：`assemble` 拿这个返回值当整个系统提示词；
   *   - **造新对象，绝不原地改**：段数组与段对象是共享的；
   *   - **不适用时原样返回同一个引用**，连新对象都不造 —— 这是绝大多数装配的路径，
   *     也是「中枢自己的提示词一个字都不许变」这句话的落点。
   *
   * 判身份用的是派发那一刻登记的 childId 集合（{@link dispatchedChildren}）：
   * 集合外的一切会话（中枢自己、宿主自己的子代理、别的插件的会话）都拿不到这一段。
   *
   * 参数同样**不写注解**、返回值用 `as typeof produced` 收口 —— 与上面那条监听器同一个缝、
   * 同一套写法（自己写窄类型会被 `Scoped<SystemPrompt>` 的签名拒掉，实测 TS2345）。
   */
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const produced = await next()
    const agent = (context as { agent?: { session?: { id?: unknown } } } | undefined)?.agent
    const sid = agent?.session?.id === undefined ? '' : String(agent.session.id)
    if (sid === '' || !dispatchedChildren.has(sid)) return produced
    const read = produced as unknown as { sections?: readonly unknown[] } | undefined
    if (read === undefined || !Array.isArray(read.sections)) return produced
    return {
      ...read,
      sections: [...read.sections, { name: PROCESS_NUDGE_SECTION, order: PROCESS_NUDGE_ORDER, text: PROCESS_NUDGE }],
    } as unknown as typeof produced
  }, { global: true })

  /**
   * 给 `allow` 型身份盖一层「按白名单过滤工具说明段」的影子段。
   *
   * 为什么必须是**函数文本**而不是一条丢弃名单：`drop` 是 persona 里的静态文本，派发那一刻
   * 就得定稿，而那时拿不到全量工具名 —— 本包能用到的只有 `ctx.tools` 的 `register`/`restrict`，
   * 没有「列出已注册工具名」的接口。改成往每一个 `tool:` 段上盖同名影子段，装配时现读
   * `assembly.tools`（`SystemPrompt.assemble` 的返回值，见其 352 行）即可，而且多装配安全。
   *
   * 段**不注册**在这里：这里只知道白名单，不知道世上存在哪些工具，注册一个空集会永远为空。
   * 真正的按名覆盖发生在 `system-prompt/assemble` 拦截器里 —— 那时已经有完整段表。
   * @param agent - 要盖影子的代理。
   * @param allow - 该身份的白名单工具名。
   */
  const installAllowShadow = (agent: Agent, allow: readonly string[]): void => {
    shadows.set(agent, allow)
  }

  /**
   * 谁盖了影子、白名单是什么。键是代理对象本身 —— 作用域没有可外读的标识，
   * 而 `system-prompt/assemble` 的 context 里带着的就是这个 `agent`。弱引用不必要：
   * 代理活着的期间这条记录才有用，且每条只占一个名字数组。
   */
  const shadows = new WeakMap<Agent, readonly string[]>()

  /**
   * 直连通道的 `allow` 白名单，按 label 待装。
   *
   * 为什么按 label：创建时没有名字可依，而 `agent/created` 回调里能读到代理的 label。
   * 登记早于创建，消费即删，一次性的语义与提问根那张表一致。
   */
  const pendingAllow = new Map<string, readonly string[]>()

  /**
   * 从当次装配的 context 里取该代理的白名单；没盖过影子就是 `undefined`（走快路径）。
   * @param context - `system-prompt/assemble` 的第二个参数。
   * @returns 白名单工具名，或 undefined。
   */
  const shadowsOf = (context: unknown): readonly string[] | undefined => {
    const agent = (context as { agent?: Agent } | undefined)?.agent
    return agent === undefined ? undefined : shadows.get(agent)
  }
  /**
   * 子代理提问的**透传通道**：问题出现在人的界面上，原始问答落在**子代理自己的树**里，
   * 中枢靠决策段读合并视图看得见（不再有任何一次「搬进中枢的树」的写入）。
   *
   * ## 为什么必须自己做
   *
   * 宿主把「人类交互」锁死在根代理上：`ctx.userQuestions.ask({ agent })` 一旦带上一个
   * **被拥有的**子代理，`assertLiveRoot` 直接抛 `DELEGATED_CALLER`
   * （dsh-user-questions/lib/index.js:531-535：human interaction is unavailable while the
   * calling agent is owned by another live agent）；而 legacy 那条不带 agent 的路，waterfall
   * 落在子代理自己的作用域里，那里没有任何应答者 —— 应答者由 GUI 客户端按会话注册
   * （dsh-client-ui-user-questions/lib/client.js:1927），于是抛 `NO_PROVIDER`。
   * 结论：子代理问不出话不是配置问题，是宿主刻意堵死的边界。
   *
   * ## 怎么绕开，又不改宿主
   *
   * 在子代理**自己的作用域**里遮蔽 `ask_user_question`，执行时改以**根代理**为作用域发起
   * 同一次 `ask`：`assertLiveRoot(root)` 通过（root 正是 `agents.roots()` 的成员），
   * waterfall 落在根会话的客户端上（卡片就地弹在人的界面上，与中枢自己提问同一条路），
   * 答案原路 resolve 后作为工具结果回到**子代理**手里。
   *
   * ## 记录去哪
   *
   * 与 `task` 的 `ask` 动作同构：问题先落进**子代理自己的树**（`ask-N` 节点），回答回来后
   * 把 `答：…` 写进同一节点的 detail。节点标题带 `[<label>] ` 前缀 —— 去掉「搬进父会话树」
   * 那条路之后，全树只剩这一份，认人的信息就必须长在它自己身上。
   *
   * **只有这一份**：子代理结算时**不再**把问答搬进父会话的树（曾有过一个 `carryDecisions`，
   * 同一个决策因此在面板上被记了两份、显示两遍）。中枢之所以压缩之后照样看得见下面问过的
   * 决策，靠的是决策段 `task:decisions` 读**合并视图**（`readMerged`），不是靠复制写入。
   */
  /** 待装透传工具的直连子代理：childId → 它的提问根与名字。 */
  const pendingAskRoots = new Map<string, { readonly root: Agent; readonly label: string }>()
  /** 已经装过的子代理 → 它的提问根。孙代理沿这条链上溯。 */
  const childRoots = new WeakMap<Agent, Agent>()

  /**
   * 一个代理的**提问根**：人类应答者所在的那一支。
   * @param agent - 待上溯的代理。
   * @returns 根代理；判不出来时 undefined（那时不装透传工具，子代理退回宿主那支的现状行为）。
   */
  const rootAgentOf = (agent: Agent): Agent | undefined => {
    const roots = ctx.agents?.roots?.() ?? []
    if (roots.includes(agent)) return agent
    return childRoots.get(agent)
  }

  /**
   * 在子代理自己的作用域里遮蔽 `ask_user_question`。
   *
   * 注册时机与身份装回同一条缝（`agent/created` 的串行窗口）：晚于孩子第一次装配就等于没装。
   * @param agent - 刚创建的子代理。
   * @param root - 它的提问根（人类应答者所在的那一支）。
   * @param label - 认人的名字，写进卡片标题与树节点。
   */
  const installAskProxy = (agent: Agent, root: Agent, label: string): void => {
    const childSid = String(agent.id)
    agent.ctx.tools.register(defineTool({
      name: ASK_TOOL_NAME,
      description: '问用户问题并等待回答。卡片落在队长会话界面，前缀是「[' + label + ']」，用户在那里作答；答案作为本工具的结果返回给你，同时这个问题会记为你自己任务树里的一个 ask-N 决策节点。凡是有事需要用户拍板，必须用本工具提问：绝对不要把问题写进结语或最终答复里等用户回答——那样用户看不到，等于你没问。拿到答案后按答案决定去留：只是填空或确认，就照原样继续做，不要重复问；要求换方向、改范围或推翻已定方案，就立刻停手，不再写任何文件，把已完成的部分、当前状态、证据和这条原始问答逐字写进结果，回报中枢等重派。',
      parameters: {
        questions: {
          type: 'array',
          required: true,
          description: '要向用户提出的问题。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true, description: '本问题的稳定 id，答案里会带回它。' },
              question: { type: 'string', required: true, description: '问题本身，用面向用户的说法。' },
              header: { type: 'string', description: '本问题的短标题。卡片会自动加上你的名字前缀。' },
              options: {
                type: 'array',
                description: '建议答案。',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    label: { type: 'string', required: true, description: '选项短标签。' },
                    description: { type: 'string', description: '一句话说明取舍或影响。' },
                  },
                },
              },
              multi_select: { type: 'boolean', description: '用户是否可多选。' },
            },
          },
        },
        timeout: { type: 'number', description: '等待秒数。省略或传 -1 = 一直等：卡片留在用户屏幕上，直到用户回答或本次调用被取消。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            answers: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true, description: '这条答案对应的问题 id。' },
                  selected: { type: 'array', required: true, items: { type: 'string' }, description: '被选中的选项标签。' },
                  custom: { type: 'string', description: '可选的自由文本答案。' },
                },
              },
            },
            pending: { type: 'boolean', description: '等待超时、用户尚未回答时为 true。' },
            message: { type: 'string', description: '本次调用没拿到答案的原因。' },
            note: { type: 'string', description: '问答的复述，供写入最终结果。' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const asked = args.questions as readonly {
          readonly id: string
          readonly question: string
          readonly header?: string
          readonly options?: readonly { readonly label: string; readonly description?: string }[]
          readonly multi_select?: boolean
        }[]
        const title = asked.map(item => item.header ?? item.question).join(' / ')
        // 先写树、再问：顺序与 `task` 的 `ask` 动作一致 —— 先问后写的话，一旦写失败，
        // 用户已经答过的话就只剩对话里那一份，压缩之后就没了。
        let nodeId: string | undefined
        try {
          const existing = tree().read(childSid)
          nodeId = DECISION_PREFIX + String(existing.filter(node => node.id.startsWith(DECISION_PREFIX)).length + 1)
          // 标题带角色前缀：这条节点是全树**唯一**一份，父会话树里不再有带名字的副本，
          // 不带前缀就再也看不出「这是谁问的」。前缀与提问卡片的 header 取自同一个 label。
          await tree().write(childSid, [{ id: nodeId, title: '[' + label + '] ' + title }], false)
        } catch (error) {
          nodeId = undefined
          ctx.logger?.warn?.('task: sub-agent ' + childSid + ' could not record its question in its own tree: ' + String(error))
        }
        const questions = ctx.get('userQuestions')
        if (questions === undefined) {
          throw new Error('ask_user_question: the `userQuestions` service is unavailable in this composition — the question was never shown')
        }
        const request = {
          questions: asked.map(item => ({
            id: item.id,
            question: item.question,
            header: item.header === undefined ? '[' + label + ']' : '[' + label + '] ' + item.header,
            ...item.options === undefined ? {} : {
              options: item.options.map(option => ({
                label: option.label,
                ...option.description === undefined ? {} : { description: option.description },
              })),
            },
            ...item.multi_select === undefined ? {} : { multiSelect: item.multi_select },
          })),
          agent: root,
          signal: exec.signal,
        }
        const timeoutSeconds = args.timeout
        let handle: ReturnType<typeof setTimeout> | undefined
        const expiry = timeoutSeconds === undefined || timeoutSeconds < 1
          ? undefined
          : new Promise<undefined>(resolve => { handle = setTimeout(() => { resolve(undefined) }, timeoutSeconds * 1000) })
        let result: { readonly answers: readonly UserQuestionAnswerItem[] } | undefined
        try {
          result = expiry === undefined
            ? await questions.ask(request)
            : await Promise.race([questions.ask(request), expiry])
        } finally {
          if (handle !== undefined) clearTimeout(handle)
        }
        if (result === undefined) {
          return {
            answers: [],
            pending: true,
            message: 'No answer arrived before the timeout. The card may still be on the user\'s screen, but this call is over — ask again if you still need it.',
          }
        }
        const answers = result.answers.map(item => ({
          id: item.id,
          selected: [...item.selected],
          ...item.custom === undefined ? {} : { custom: item.custom },
        }))
        const answerText = answers
          .map(item => [...item.selected, ...item.custom === undefined ? [] : [item.custom]].join(', '))
          .join(' | ')
        if (nodeId !== undefined) {
          try {
            await tree().step(childSid, nodeId, { status: 'completed', detail: ANSWER_PREFIX + answerText })
          } catch (error) {
            ctx.logger?.warn?.('task: sub-agent ' + childSid + ' could not write the answer back into its tree: ' + String(error))
          }
        }
        return {
          answers,
          note: '回报中枢时携带这条原始问答：' + title + ' → ' + answerText,
        }
      },
    }))
  }

  ctx.on('agent/created', ({ agent }) => {
    // 只认白名单与提问根这两件事（键都是会话 id）。
    //
    // 键用会话 id：`dsh-subagent` 建子代理时走的是
    // `agents.create({ sessionId: childId, parentAgent: parent, ... })`
    // （dsh-subagent/lib/index.js:1082），而 `agent/created` 的载荷就是这个 agent、
    // 它自带的 `id` 正是那个 sessionId（dsh-agent/lib/index.js:573 用 `agent.id` 查注册表）。
    // 所以 childId 是这两侧唯一的对得上号的东西，label 不是。
    // 直连子代理的提问透传：与白名单同一条缝、同一个键（会话 id）。
    const ask = pendingAskRoots.get(String(agent.id))
    if (ask !== undefined) {
      pendingAskRoots.delete(String(agent.id))
      childRoots.set(agent, ask.root)
      try {
        installAskProxy(agent, ask.root, ask.label)
      } catch (error) {
        ctx.logger?.warn?.('task: sub-agent ' + String(agent.id) + ' started without its direct-to-user question tool: ' + String(error))
      }
    }
    const direct = pendingAllow.get(String(agent.id))
    if (direct !== undefined) {
      pendingAllow.delete(String(agent.id))
      try {
        installAllowShadow(agent, direct)
      } catch (error) {
        ctx.logger?.warn?.('task: child ' + String(agent.id) + ' started without its allow-list prompt filter: ' + String(error))
      }
    }
  }, { global: true })

  /**
   * 子代理结算时，把它**在结语里回传的那一行状态**落到父树节点上。
   *
   * 为什么不指望子代理自己调 `step`：树按会话 id 隔离，`bind` 写的节点在**父会话**的树里，
   * 子代理自己的树里没有它 —— 实测那一调用只会抛
   * `task-tree: no node with id "..." in this session's tree`。所以通道只有回传：
   * 派发简报（{@link withNodeBrief}）要求它在结语末尾单独一行输出 `状态：完成` / `状态：失败`，
   * 这里从父会话自己的历史里把那条结算消息读回来、解析、落树。
   *
   * 监听器**必须自己吞掉一切异常**：一次解析或写树失败不许把会话事件分发炸掉。
   * 宿主**没有**任何机器可读的失败字段（`source` 里没有 stopReason，只有一行人读摘要句，
   * 见 `createSettlementMessage`，dsh-subagent/lib/index.js:633-654），所以摘要句只做补充说明：
   * **绝不**凭它把节点判成 completed。这一版起它只剩一个用途 —— 认出「被强停」，
   * 补成 `（被强停）` 这一个短标记（见 {@link STOPPED_HINT}），整句摘要不再进 detail。
   */
  ctx.on('session/event', async (session, event) => {
    let childId = ''
    try {
      if (event.type !== 'user/message') return
      const source = (event.data as unknown as { source?: { kind?: string; senderSessionId?: string; summary?: string } }).source
      if (source?.kind !== 'subagent-settled') return
      childId = String(source.senderSessionId ?? '')
      if (childId === '') return
      const sid = String(session.id)
      // 结算正文不在事件里，是运行时**投**进父会话历史的。复用 settledNotice 那一份解析 ——
      // 它读的是 `exec.agent.session.deriveMessages()`，所以这里把会话本身裹进那个形状，
      // 而不是重写第二份「从历史里找结算消息」的代码。
      const body = typeof session.deriveMessages === 'function'
        ? settledNotice({ agent: { session } }, childId)
        : undefined
      if (body === undefined) {
        // 「读不到结算正文」**不是**「子代理没回报」：一次历史读失败不许被写成一条结论
        // （与 `isKnownChild` 同一条纪律）。什么都不写，留一句日志。
        ctx.logger?.warn?.('task: the settlement notice of child ' + childId + ' is not readable in session ' + sid + '; its node keeps its status')
        return
      }
      const port = tree()
      const bound = flattenNodes(port.read(sid)).filter(node => node.assignedTo === childId)
      if (bound.length === 0) {
        ctx.logger?.warn?.('task: no node in session ' + sid + ' is bound to child ' + childId + '; nothing to settle')
        return
      }
      const patch = settlementPatch(readNodeReplay(body), source.summary)
      let applied = false
      for (const node of bound) {
        // 已经 completed 的节点是既成事实：一条晚到的失败（或「没收到回报」）不许把它盖回去。
        if (node.status === 'completed') continue
        applied = true
        await port.step(sid, node.id, patch)
      }
      // 树写完之后才是自动放行：账本按**同一次结算的结局**推进，再去看它解锁了谁。
      // 一条都没写（全部已是 completed）时按既成事实算 completed —— 一条晚到的失败
      // 不许把账本里已完成的那一步改回去。
      const outcome: 'completed' | 'failed' = !applied || patch.status === 'completed' ? 'completed' : 'failed'
      // 结算正文（上面那次 `settledNotice` 的产物）一并交出去：它会被写进账本，
      // 从此下游取结论不必再回到会话历史里翻 —— 历史会被压缩，账本不会。
      await advanceRuns(sid, childId, outcome, body)
    } catch (error) {
      ctx.logger?.warn?.('task: settling the node of child "' + childId + '" failed: ' + String(error))
    }
  }, { global: true })

  /**
   * 派发收尾：绑节点、推进状态、给出返回值。两条派发通道共用。
   * @param exec - 工具执行上下文。
   * @param bind - 节点 id，省略时不碰树。
   * @param childId - 子会话 id。
   * @returns 工具返回值。
   */
  const settleDispatch = async (exec: { agent?: Agent }, bind: string | undefined, childId: string): Promise<{ task_id: string; node?: string; status: string }> => {
    if (bind !== undefined) {
      await tree().bind(sessionId(exec), bind, childId)
      // 补上参数描述已经承诺、代码里却从未发生的状态迁移。
      // 声明写的是「it moves to in_progress」，但 plan-tree 的 bind 只写 assignedTo，
      // 从不碰 status（plan-tree/src/task-tree.ts 的 patchAssignedTo 逐行可查）。
      // 后果：派完孩子节点仍是 pending，还得再调一次 step 才动 —— 正是这次要消掉的那次调用。
      // 孩子已经开始干这个节点了，节点就该是 in_progress，这是事实不是推断。
      await tree().step(sessionId(exec), bind, { status: 'in_progress' })
    }
    // `bind` 省略时**必须整个省掉 `node` 这个键**，不能把它写成 undefined：
    // 工具返回值要过运行时的无损 JSON 序列化器，而它拒收任何 undefined 字段，
    // 于是「不传 bind」这个头号动作会当场炸成
    // `tool "task" returned invalid output: value is not lossless JSON`
    // （真机实测，`e2e\runs\verify-presets` 三个预设三次全同）。
    // 「键缺省」与「键为 undefined」在协议上是两种东西，只有前者是无损的。
    return {
      task_id: childId,
      ...bind === undefined ? {} : { node: bind },
      status: 'running',
    }
  }

  /**
   * 一次派发：**工具路径与自动放行路径共用这一份**。
   *
   * 它就是从 `case 'dispatch'` 里原样抽出来的那段（提问根登记、节点简报），
   * 所以两条路的行为不可能各说各话 —— 「只有本工具派出的子代理才会被装上提问工具」
   * 这句话对自动放行同样成立。
   *
   * 层数闸门（{@link assertCanDelegate}）在这里再守一道：自动放行没有模型在旁边看，
   * 静默越层比抛错危险得多。
   * @param parent - 派发的父 Agent（必须是当刻活着的 Agent 本身）。
   * @param spec - 简报、身份、标签与要绑的节点。
   * @param signal - 调用方的取消信号；自动放行给的是永不取消的那一个。
   * @returns 工具返回值形态的结果（`settleDispatch` 的产出）。
   */
  const dispatchTo = async (
    parent: Agent,
    spec: {
      readonly prompt: string
      readonly preset?: string
      readonly label?: string
      readonly bind?: string
      readonly concise?: boolean
    },
    signal: AbortSignal,
  ): Promise<{ task_id: string; node?: string; status: string; result?: string }> => {
    assertCanDelegate(parent)
    const preset = resolvePreset(config.presets, spec.preset, DEFAULT_PRESET)
    // **实际生效的 preset 键**：显示层（树标题 / 提问卡片前缀 / label 之外的）一律以它为准，
    // 不以调用方自由填的 `spec.label` 为准 —— 两者不一致时，label 只是个活名，身份是这一支。
    // 与 `resolvePreset` 同一处取值，所以「显示的身份」与「真正跑的身份」不可能再分叉。
    const effectiveKey = spec.preset ?? DEFAULT_PRESET
    // 丢弃指令随 persona 一起旅行。`drop` 给了就必须拼，哪怕 persona 本身是空的 ——
    // "只丢段、不加人格"是合法用法。
    // 注意：这里必须用 encodeDropDirective 的返回值当 persona，**不能再叠一次**
    // preset.persona —— 指令文本只能有一份，否则解码只剥掉最前面那条。
    // 丢弃列表 = 手写的 drop + deny 掉的那些工具的说明段。
    // 只走直连一条路：这份 persona 由下面 request 的那个槽携带。
    const drops = [...preset.drop ?? [], ...toolSectionsForFilter(preset.toolFilter)]
    const persona = drops.length > 0
      ? encodeDropDirective(drops, preset.persona ?? '')
      : preset.persona
    // 派发**只有直连一条路**（Agent Teams 已于 2026-10-02 整条摘掉）：
    // persona / toolFilter / maxDepth / agentOptions 四个槽由下面的 request 一次交齐。
    const maxDepth = ctx.subagents.resolveMaxDepth(preset.maxDepth)
    const request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'> = {
      ...spec.label !== undefined ? { label: spec.label } : {},
      prompt: [{ type: 'text', text: withNodeBrief(spec.prompt, spec.bind, spec.concise === true) }],
      parent,
      ...persona !== undefined ? { persona } : {},
      ...preset.toolFilter !== undefined ? { toolFilter: preset.toolFilter } : {},
      ...maxDepth !== undefined ? { maxDepth } : {},
      // 角色固定的档位走这里。宿主那侧是**逐字段覆盖**父的
      // `provider/model/reasoningEffort/maxTokens`，所以只写 `reasoningEffort` 时
      // 路由（provider/model）原样继承父的 —— 最安全的用法，本包不替调用方加默认。
      ...preset.agentOptions !== undefined ? { agentOptions: narrowAgentOptions(preset.agentOptions) } : {},
    }
    const allowTools = preset.toolFilter?.allow
    const started = await ctx.subagents.startContinuable({
      provider: config.provider,
      // 显示名走中文，键用**实际生效的 preset 键**：点名 impl 而 label 写「验证」时，
      // 面板必须显示「实现」—— 显示层只有对上真正跑的身份才有意义。
      // 没点名 preset 时（走 DEFAULT_PRESET）照样显示生效的那一支，不用 label 冒充身份。
      label: roleLabel(effectiveKey),
      request,
      signal,
    })
    // 白名单按 childId 落表。为什么要等这一步：`agent/created` 是**串行**的，
    // 而 `agents.create({ sessionId: childId, ... })` 用的就是这个 id ——
    // 本次 `await` 返回后到孩子第一次装配之间，还有一整个事件分发的间隙，
    // 所以这里登记赶得上；反过来说，登记必须**先于**任何 `await` 之外的让出。
    if (allowTools !== undefined && allowTools.length > 0) {
      pendingAllow.set(String(started.childId), [...allowTools])
    }
    // 「本插件派出的子代理」这一集合也在这里落：与上面两条登记同一个窗口、同一条纪律
    // （`await` 返回后到孩子第一次装配之间还有一整个事件分发的间隙），供给 `system-prompt/assemble`
    // 里那段**建议**判身份用 —— 只有本插件派出去的孩子才会看到它。
    dispatchedChildren.add(String(started.childId))
    // 提问根同样按 childId 落表：`agent/created` 是串行的，这次的登记赶得上孩子的第一次装配。
    const askRoot = rootAgentOf(parent)
    if (askRoot !== undefined) {
      pendingAskRoots.set(String(started.childId), { root: askRoot, label: roleLabel(effectiveKey) })
    }
    return await settleDispatch({ agent: parent }, spec.bind, started.childId)
  }
  /**
   * 本插件**派出过**的子会话（childId = 它自己的 session id）。
   *
   * 用途只有一个：`system-prompt/assemble` 里那段「过程记录要求」只发给它们 ——
   * 中枢自己的提示词、以及没被本插件派出的会话**一个字都不加**。
   *
   * 只在进程内存里、重启即失效：重启之后那些子会话本来就不在了，集合留着只会是一堆死 id。
   * 登记点与 `pendingAllow` / `pendingAskRoots` 完全相同（派发那一刻），因为那两处已经把
   * 「`await` 返回后到孩子第一次装配之间还有一整个事件分发的间隙」这件事验证过了。
   */
  const dispatchedChildren = new Set<string>()

  /**
   * 「已派出、但账本没记住」的进程内登记表：键 `sid\u0000runId\u0000nodeId` → childId。
   *
   * 为什么必须存在：{@link TaskRunsService.commit} 的契约是**绝不抛** —— 全部写盘尝试被拒时
   * 返回 false。那一刻孩子**已经在跑**了，账本里却还是 pending；下一次评估（任何结算、
   * 或一次 `retry`）就会再派一个：多跑一份同样的活，还多占一个孩子名额。
   *
   * 为什么只在内存里、**重启即失效**：重启之后运行时不跨进程续会话，原来那个孩子确实不在了，
   * 这时「重派」是正确的恢复；而在同一个进程里孩子还活着，重派就是纯粹的浪费。
   */
  const inflightDispatches = new Map<string, string>()

  /**
   * 往节点写一行事实（可选带一次状态迁移）。**绝不抛**：调用点全在派发/续跑链路里，
   * 一次树写失败不许把「孩子已经在跑」这个结论改写成失败。
   * @param sid - 父会话 id。
   * @param nodeId - 节点 id。
   * @param detail - 要写的单行文本。
   * @param status - 顺带要置的树状态；省略即只改 detail。
   */
  const writeNodeFact = async (sid: string, nodeId: string, detail: string, status?: TaskNodeStatus): Promise<void> => {
    try {
      await tree().step(sid, nodeId, { ...status === undefined ? {} : { status }, detail })
    } catch (error) {
      ctx.logger?.warn?.('task: could not write the detail of node "' + nodeId + '": ' + String(error))
    }
  }

  /**
   * 把「这一步为什么**没做成**」同时写进账本与节点 detail。
   *
   * 两处都要写，因为它们**各缺一半**：
   *   - 树上的 detail 是面板看得见的那一份，但它会被下一次结算覆盖，也不进账本；
   *   - 账本上的 note 留得住、重启之后还在，但面板不画它。
   * 曾经只有前者（派发失败）或两者都没有（取不到上游结论），现场表现一律是「节点一直 pending」，
   * 与「依赖还没满足」长得一模一样 —— 这条链上已经栽过两次。
   *
   * 写树失败**不抛**：这一次不派发的结论已经由账本那一半保住了，一次树写失败不该把
   * `session/event` 监听器炸掉（调用点就在那里）。
   * @param ledger - 账本服务句柄。
   * @param sid - 父会话 id。
   * @param runId - 这条节点属于哪条 run。
   * @param nodeId - 节点 id。
   * @param detail - 单行的原因（含前缀），账本与树写的是**同一句**。
   */
  const recordNodeNote = async (ledger: TaskRunsService, sid: string, runId: string, nodeId: string, detail: string): Promise<void> => {
    await ledger.commit(sid, list => patchRunNode(list, runId, nodeId, record => runNodeWith(record, 'pending', undefined, detail)))
    try {
      await tree().step(sid, nodeId, { detail })
    } catch (writeError) {
      ctx.logger?.warn?.('task run "' + runId + '": could not record the reason on node "' + nodeId + '": ' + String(writeError))
    }
  }

  /**
   * 派发**成功**之后，把上一次留在树 detail 上的阻塞/失败原因换成一行事实。
   *
   * 为什么要有它：节点被阻塞（`结论缺失：`）或派发失败（`派发失败：`）之后，那一句会一直挂在
   * detail 上；等它**真的**跑起来时，面板与 `task list scope=tree` 上留着的那句就成了假话 ——
   * 正是这条链上反复出现的那类「陈旧原因」。
   *
   * 边界：只有那两种前缀才动（其它 detail 是调用方自己写的，也会在结算时被结论覆盖）；
   * 任何失败都只进日志 —— 这一步跑在派发**成功之后**，一次树写失败绝不能反过来把账本回滚成
   * pending（那样账本会说谎：孩子已经在干了）。
   * @param sid - 父会话 id。
   * @param node - 刚派出去的那个节点。
   * @param hadUpstream - 这个节点有没有上游结论（有 needs 就有）。
   */
  const clearStaleDetail = async (sid: string, node: RunNodeRecord, hadUpstream: boolean): Promise<void> => {
    try {
      const port = tree()
      const current = flattenNodes(port.read(sid)).find(candidate => candidate.id === node.id)?.detail
      if (current === undefined) return
      if (!current.startsWith(AUTO_DISPATCH_MISSING_PREFIX) && !current.startsWith(AUTO_DISPATCH_FAILED_PREFIX)) return
      await port.step(sid, node.id, { detail: hadUpstream ? DISPATCHED_DETAIL_WITH_UPSTREAM : DISPATCHED_DETAIL })
    } catch (error) {
      ctx.logger?.warn?.('task run: could not refresh the detail of node "' + node.id + '": ' + String(error))
    }
  }

  /**
   * 派一个 run 节点：**先取齐上游结论**（见 {@link upstreamSection}），再分发子代理、
   * 账本置 `dispatched` 并记下 childId；没做成一律回滚成 `pending` 并留痕。
   *
   * 三档结局，各有各的留痕：
   *   - **取不到上游结论**：以 `结论缺失：` 开头的单行进 detail 与账本 note；
   *     fail-closed —— 宁可停在这里让中枢看见，也不派一个「以为上游什么都没说」的子代理。
   *   - **派发抛错**：以 `派发失败：` 开头的那一句，两处同样都要有；
   *     失败不吞、不改判，中枢看得见并可以再 retry。
   *   - **派发成功**：note 清空，`dispatched` + childId，并把树上那条陈旧的阻塞/失败 detail
   *     换成一行事实（见 {@link clearStaleDetail}）—— 陈旧原因不会留在跑起来的那一步上。
   *
   * 简报的拼装走 {@link upstreamSection}：框架里的 `{{dep}}` 槽位就地填上那个依赖的结论，
   * 没被槽位覆盖的依赖再用【上游结论】块追加；两条路共用同一份取数结果。
   *
   * 回滚是**记账回滚**：`dispatchTo` 抛错时孩子根本没起来（两条通道都是「抛错即没建成」），
   * 所以节点回到 pending 是当刻的事实，而不是掩盖失败 —— 失败本身进日志。
   *
   * 被阻塞的节点不是死锁：{@link advanceRuns} 在**任何**一次结算之后都会重跑一遍，
   * 于是「上游正文后来才可读」这种情况下一轮就会被重新评估（仍取不到就再写一遍同样的原因）。
   * @param parent - 派发的父 Agent。
   * @param sid - 父会话 id。
   * @param run - 这条节点属于哪条 run（上游结论要按它的节点表找 childId）。
   * @param node - 要派的节点。
   * @returns 子会话 id；没派出去时为 undefined。
   */
  const dispatchRunNode = async (parent: Agent, sid: string, run: RunRecord, node: RunNodeRecord): Promise<string | undefined> => {
    // 账本服务**在起孩子之前**拿到手：服务缺席时这一步就抛，绝不留下一个派出去、
    // 却永远记不进账本的节点。回滚与记账用的是同一个句柄。
    const ledger = runs()
    // **先查「已派出、账本未确认」的内存表**：命中说明这个 (会话, run, 节点) 上一次
    // 已经真派出去了，只是账本那一次写入没落地。这里**绝不新派**，只补一次账本写入。
    // 这张表**只在进程内存里**，重启即失效 —— 这是刻意的：重启之后原来那个孩子确实不在了
    // （运行时不跨进程续会话），重派才是正确的恢复；而在同一个进程里，孩子还活着，重派就是重复干活。
    const memoKey = dispatchMemoKey(sid, run.id, node.id)
    const inflightChild = inflightDispatches.get(memoKey)
    if (inflightChild !== undefined) {
      const stored = (await ledger.list(sid))
        .find(item => item.id === run.id)?.nodes.find(item => item.id === node.id)
      if (stored === undefined || stored.status === 'pending') {
        const written = await ledger.commit(sid, list => patchRunNode(list, run.id, node.id, record => runNodeWith(record, 'dispatched', inflightChild)))
        if (!written) return undefined
        inflightDispatches.delete(memoKey)
        await writeNodeFact(sid, node.id, node.needs.length > 0 ? DISPATCHED_DETAIL_WITH_UPSTREAM : DISPATCHED_DETAIL)
        return inflightChild
      }
      // 账本里这一格已经不是 pending：表项完成使命（或已被别的路径补上），清掉。
      // 仍然**不新派** —— 这一格已经有主了。
      inflightDispatches.delete(memoKey)
      return undefined
    }
    // 上游结论先取齐：它是**派发的前置条件**，不是尽力而为的附加物。
    // 顺序严格按 `node.needs` 的声明顺序（`upstreamSection` 自己不排序）。
    const upstream = upstreamSection({ agent: parent }, new Map(run.nodes.map(item => [item.id, item])), node)
    if ('missing' in upstream) {
      const detail = AUTO_DISPATCH_MISSING_PREFIX + singleLine(upstream.missing)
      ctx.logger?.warn?.('task run "' + run.id + '": node "' + node.id + '" stays pending: ' + detail)
      await recordNodeNote(ledger, sid, run.id, node.id, detail)
      return undefined
    }
    // 框架（槽位已填）在前、没被槽位覆盖的那些依赖的【上游结论】块在后。
    // 全部被槽位吃掉时 `text` 是空串，这里就一个字都不追加。
    const prompt = composeBrief(upstream)
    try {
      const started = await dispatchTo(parent, {
        prompt,
        ...node.preset === undefined ? {} : { preset: node.preset },
        ...node.label === undefined ? {} : { label: node.label },
        bind: node.id,
        // run 链路才有的那一句：结语里给下游用的结论要简略。
        concise: true,
      }, AUTO_DISPATCH_SIGNAL)
      // 派发成功时 note 照例清空：陈旧的原因不该留在已经跑起来的那一步上。
      const recorded = await ledger.commit(sid, list => patchRunNode(list, run.id, node.id, record => runNodeWith(record, 'dispatched', started.task_id, started.result)))
      if (!recorded) {
        // **孩子已经起来了，账本却没记住** —— 这一刻绝不许回滚成 pending：
        // 那会让下一次评估（任何结算、或一次 retry）**再派一个**，多跑一份同样的活。
        // 改成：把「已派出、账本未确认」记进进程内存表，写一行事实到树。
        inflightDispatches.set(dispatchMemoKey(sid, run.id, node.id), started.task_id)
        ctx.logger?.warn?.('task run "' + run.id + '": node "' + node.id + '" was dispatched as child '
          + started.task_id + ' but the ledger did not record it; this process will not dispatch it again')
        await writeNodeFact(sid, node.id, INFLIGHT_DETAIL_PREFIX + started.task_id)
        return started.task_id
      }
      await clearStaleDetail(sid, node, node.needs.length > 0)
      return started.task_id
    } catch (error) {
      // 派发失败**必须留痕**：记账回滚成 pending 是对的（孩子根本没起来），但只在宿主日志里
      // 写一行就等于没有 —— 面板上看不出任何区别，「节点一直 pending」会被当成「依赖没满足」。
      // 实测吃过这个亏：`ctx.agents` 没进 inject 时，自动放行整条链在第一步就抛，
      // 而现场只看得到「B 不动」。现在这一句同时进日志、账本 note 与节点 detail。
      const detail = AUTO_DISPATCH_FAILED_PREFIX + singleLine(String(error))
      ctx.logger?.warn?.('task run "' + run.id + '": dispatching node "' + node.id + '" failed; it stays pending: ' + String(error))
      await recordNodeNote(ledger, sid, run.id, node.id, detail)
      return undefined
    }
  }

  /**
   * 续跑：把一个**已经派出过**的节点交回**它原来那个孩子**接着干（不新派）。
   *
   * 与 {@link dispatchRunNode} 的分工：那个函数负责「还没有孩子」的节点（起孩子 + 记账），
   * 这个函数负责「已经有孩子、但没干成」的节点（唤醒 + 记账）。两者共用同一份简报拼装
   * （{@link upstreamSection} + {@link composeBrief}），所以续跑拿到的说明与首次派发逐字同形。
   *
   * 阻塞语义照旧：上游结论取不到就**一个字都不发**，原因写进树 detail 与账本 note，
   * 并把该节点原样留在它当时的状态上 —— 这里**绝不**把它改成 `pending`，
   * 那会让下一轮 `releaseRun` 给它**新派一个孩子**，正是「续跑」要避免的事。
   * @param parent - 当刻活着的父 Agent（`sendMessage` 要的是 Agent 本身，不是 id）。
   * @param sid - 父会话 id。
   * @param run - 节点所属的 run。
   * @param node - 要续跑的节点（调用方已保证它有 childId 且不是 completed）。
   * @param signal - 调用方的取消信号。
   * @returns 唤醒成功时是 `{ childId }`；上游结论取不到时是 `{ blocked }`（单行原因）。
   */
  const resumeNode = async (
    parent: Agent,
    sid: string,
    run: RunRecord,
    node: RunNodeRecord,
    signal: AbortSignal,
  ): Promise<{ readonly childId: string } | { readonly blocked: string }> => {
    const ledger = runs()
    const childId = node.childId ?? ''
    const upstream = upstreamSection({ agent: parent }, new Map(run.nodes.map(item => [item.id, item])), node)
    if ('missing' in upstream) {
      const detail = AUTO_DISPATCH_MISSING_PREFIX + singleLine(upstream.missing)
      ctx.logger?.warn?.('task run "' + run.id + '": node "' + node.id + '" cannot resume: ' + detail)
      // 只写 note 与 detail，**status / childId / conclusion 一个都不动**（见上面的理由）。
      await ledger.commit(sid, list => patchRunNode(list, run.id, node.id, record => runNodeWith(record, record.status, record.childId, detail, record.conclusion)))
      await writeNodeFact(sid, node.id, detail)
      return { blocked: detail }
    }
    // 唤醒用的是**同一个 childId**：绝不经过任何创建通道（`startContinuable`）。
    await ctx.subagents.sendMessage(parent, childId as SessionId, [{ type: 'text', text: composeBrief(upstream) + '\n\n' + RESUME_NOTE }], { signal })
    // 账本：重新置成 dispatched（childId 保持、note 清空、conclusion 不动）。
    const recorded = await ledger.commit(sid, list => patchRunNode(list, run.id, node.id, record => runNodeWith(record, 'dispatched', record.childId, undefined, record.conclusion)))
    if (!recorded) {
      // 孩子已经被唤醒了，所以**不改判**：只记一条日志。下一轮评估里这个节点仍是它原来的状态，
      // 中枢看得见、也能再 resume 一次 —— 这条路上没有额外成本，不值得为它再立一张内存表。
      ctx.logger?.warn?.('task run "' + run.id + '": node "' + node.id + '" was resumed as child '
        + childId + ' but the ledger did not record it')
    }
    // 树：状态置 in_progress（它确实又开工了），detail 写一行事实。
    await writeNodeFact(sid, node.id, RESUME_DETAIL_PREFIX + childId, 'in_progress')
    return { childId }
  }

  /**
   * 把一条 run 里**现在就能派**的节点逐个派出去。
   *
   * 挑人规则只有一条：`pending` 且 `needs` 全部 `completed`。两条路共用它 ——
   *   - {@link advanceRuns}：某次结算之后**自动**跑一遍（行为与抽出来之前逐字一致）；
   *   - `run` 动作的 `retry: true`：中枢**显式**要求重评估一次既有 run 的待办。
   * 于是「谁能被放行」这件事只有一个实现，两条路的判断不可能各说各话。
   *
   * 失败与阻塞的留痕不在这里做：{@link dispatchRunNode} 自己会把原因写进树 detail 与账本 note。
   * @param parent - 当刻活着的父 Agent。
   * @param sid - 父会话 id。
   * @param run - 要评估的 run。
   * @returns 真的派出去的节点 id，顺序 = run 里节点的声明顺序。
   */
  const releaseRun = async (parent: Agent, sid: string, run: RunRecord): Promise<string[]> => {
    const byId = new Map(run.nodes.map(node => [node.id, node]))
    const dispatched: string[] = []
    for (const node of run.nodes) {
      if (node.status !== 'pending') continue
      if (!node.needs.every(need => byId.get(need)?.status === 'completed')) continue
      const childId = await dispatchRunNode(parent, sid, run, node)
      if (childId !== undefined) dispatched.push(node.id)
    }
    return dispatched
  }

  /**
   * 自动放行：一次结算之后，把结局记进账本，再派发它解锁的后继。
   *
   * 三条纪律，一条都不能松：
   *   - **失败只停这一支**：某节点落 failed 时这里什么都不做，它的下游因为
   *     `needs` 永远不满足而天然停住；**与它平行的分支照常推进**（每个节点各看各的 needs）。
   *   - **不通知中枢**：这条路只写树、只写账本，绝不 `followup` / `inject` /
   *     发任何 `subagent-settled` —— 中枢的回合不因为自动派发而动一下。
   *   - **绝不抛**：调用点在 `session/event` 监听器里。
   *
   * 结局取自树写入的同一份判定（`settlementPatch`），不另算一遍：
   * 账本里 `dispatched` 的那一条按这次结算的 status 落 `completed`/`failed`。
   *
   * `conclusion` 的写法有**两档**，都是为了与历史那条回退路径口径一致：
   *   - 节点正从 `dispatched` 落终态 ⇒ 连 status 带结论一起写（首次判终态）；
   *   - 节点**已经是终态**（同一个 childId 又结算了一次，例如 `send` 续跑）⇒ **只覆盖结论文本**，
   *     status / childId / note 一个字都不动 —— 「已判终态的不许被晚到的结算改写」这条纪律
   *     指的是**状态**，而结论文本必须取最新那一份，否则账本给的与历史给的就对不上了。
   * @param sid - 父会话 id。
   * @param childId - 刚结算的子会话 id。
   * @param outcome - 这次结算的结局。
   * @param conclusion - 这次结算的正文；省略即不写这一格（老调用点行为不变）。
   */
  const advanceRuns = async (sid: string, childId: string, outcome: 'completed' | 'failed', conclusion?: string): Promise<void> => {
    // 绝大多数结算与 run 无关：先读一眼，这条会话没有账本就一个字都不做。
    // 读不动（文件损坏、权限不对）时 `list` 降级成空表并记一条日志 —— 于是这里同样收手，
    // 但日志留得下：静默什么都不做会让「自动放行没有发生」无从诊断。
    // 这条路**绝不抛**（与 `run` 动作相反：那边必须报错），因为调用点在 `session/event` 监听器里。
    const ledger = runs()
    if ((await ledger.list(sid)).length === 0) return
    const recorded = await ledger.commit(sid, (list) => {
      let changed = false
      const next = list.map((run) => {
        let touched = false
        const nodes = run.nodes.map((node) => {
          // 认领这次结算的只有「这个孩子」名下的节点；别的节点（含 pending 的）一个字不动。
          if (node.childId !== childId) return node
          const text = conclusion === undefined ? undefined : capUpstream(conclusion)
          // ① 已经派出去、正等它回来：这次结算就是它的终态，status 与结论一起落。
          if (node.status === 'dispatched') {
            touched = true
            return runNodeWith(node, outcome, node.childId, undefined, text)
          }
          // ② 已经是终态：同一个孩子又结算了一次（`send` 续跑）。**只覆盖结论文本** ——
          // status / childId / note 原样带过去（note 走同一条归一化，已归一的再走一次不变）。
          // 这一档存在的唯一理由：历史回退路径取的是**最新**那条通知，账本必须与它一致。
          if (text === undefined || text === node.conclusion) return node
          touched = true
          return runNodeWith(node, node.status, node.childId, node.note, text)
        })
        if (!touched) return run
        changed = true
        return { ...run, nodes }
      })
      return changed ? next : undefined
    })
    if (!recorded) return
    // 派发需要一个**当刻活着的父 Agent**；拿不到就停在这里并记日志，绝不瞎编一个。
    const parent = ctx.agents?.get(sid as SessionId)
    if (parent === undefined) {
      ctx.logger?.warn?.('task: session ' + sid + ' has a run ledger but no live agent; nothing is dispatched automatically')
      return
    }
    for (const run of await ledger.list(sid)) {
      await releaseRun(parent, sid, run)
    }
  }
  ctx.tools.register(defineTool({
    name: 'task',
    description: '`task` 统一编排：掌管任务树与执行它的子代理。子代理异步结算：结算通知会在你下一轮以一条 `subagent-settled` 消息出现；`result` 只读已经到达的东西，从不等待。派活一律走 `run`：先声明 `nodes`（建树），起点立刻派出，后继由插件自动放行——**没有**「不建节点就派活」的直达通道。走这条路派出的子代理才会被装上「直接问用户」的提问工具。子代理缺前提或需要用户拍板时，必须直接问用户（用提问工具），不要自己硬猜。答案要求换方向、改范围或推翻已定方案时，子代理应停手回报，由中枢另派干净上下文的代理接手。派活时用中文角色名做 label（侦察/实现/验证），树与提问卡片按它显示。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['plan', 'step', 'ask', 'run', 'send', 'interrupt', 'list', 'result'],
        description: 'plan 写节点；step 推进一个节点；ask 问用户；run 声明一条依赖流水线并派出子代理——起点立刻派出，后继在前置全部完成时由插件自动派出，它不会给你发消息；run 的两个补充入口：retry=true 只重评估既有 run 的待办节点（还没派出去的那些），resume=<节点 id> 把已派出但没干成的节点交回它原来那个孩子接着干（不新派）；send 继续它；interrupt 停它；list 读树或子代理；result 读某个子代理的结果。',
      },
      nodes: {
        type: 'array',
        items: {
          type: 'object',
          // 这一行是必须的：defineTool 的参数 DSL 拒绝隐式 additionalProperties，
          // 漏了会直接抛 JsonSchemaError（实测于 2026-09-29）。
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: '节点 id，树内唯一。' },
            parent: { type: 'string', description: 'plan/run：上级节点 id；根节点省略。' },
            title: { type: 'string', description: 'plan/run：一句话说明这活是什么。run 的节点省略时由插件从 prompt 首行生成；plan 的节点每项必填。' },
            detail: { type: 'string', description: 'plan/run：什么算干完，或卡在哪里。' },
            prompt: { type: 'string', description: 'run：这个节点要干的活，原样交给子代理。run 的节点只要求 id 与 prompt。' },
            needs: { type: 'array', items: { type: 'string' }, description: 'run：前置节点 id，全部 completed 之后本节点由插件自动派出。依赖只驱动后端，不写进树。' },
            preset: { type: 'string', description: 'run：这个节点的身份名，决定它的 persona 与工具过滤，覆盖顶层 preset。省略则拿 lead 身份——绝不继承你的 persona；未知名字直接报错，不回落。' },
            label: { type: 'string', description: 'run：这个节点在面板上的短标签。' },
          },
        },
        description: 'plan/run：要写的节点，扁平——嵌套只靠 parent。run：这条流水线的节点，每项形如 { id, prompt, needs?, preset?, name?, label? }，needs 指向同一份 nodes 里的 id。',
      },
      replace: { type: 'boolean', description: 'plan/run：整树替换而非合并。默认 false；不在本列表里的节点会被丢弃。' },
      node: { type: 'string', description: 'step：要推进的节点 id。' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'], description: 'step：新状态。子代理结算时由插件自己算——主判据是**子代理在结语末尾自己回传的那一行状态**（报完成 → completed，报失败 → failed，见 `withNodeBrief` 写进简报的那两行）；没回传、或格式认不出，一律落 failed 并记「未收到回报」，绝不因为「孩子结算了」就判成成功。宿主那侧没有任何机器可读的失败字段（只有一行人读摘要句），所以那句摘要只剩一个用途：认出「被强停」时补一个短标记，**永不**据此把节点判成 completed。' },
      detail: { type: 'string', description: 'step：替换节点的 detail。' },
      question: { type: 'string', description: 'ask：问用户的问题。' },
      options: { type: 'array', items: { type: 'string' }, description: 'ask：建议答案。' },
      prompt: { type: 'string', description: 'run 的每个节点一项（该节点自己要干的活，原样交给子代理）/ send：子代理收到的简报。' },
      preset: { type: 'string', description: 'run（顶层默认给全条流水线，节点项给该节点，节点项优先）：身份名，决定子代理的 persona 与工具过滤。省略则拿 lead 身份——绝不继承你的 persona；未知名字直接报错，不回落。' },
      label: { type: 'string', description: 'run：短标签，显示在面板上的活名。' },
      bind: { type: 'string', description: '已不从这条工具面接受：节点与 childId 的绑定由插件在派发时自己登记。' },
      run: { type: 'string', description: 'run：这条流水线的 run id，会话内唯一。同一个 run 的起点（needs 为空的那些）会在本次调用里并行派出。三个词的分工：声明新流水线（默认）、`retry=true` 重评估**已存在**那条 run 的待办节点、`resume=<节点 id>` 把**已派出但没干成**的节点交回它原来那个孩子接着干。后两种都要求 run 已经存在。' },
      resume: { type: 'string', description: 'run：要**续跑**的节点 id —— 把这个节点交给它原来那个孩子接着干（不新派）。要求该 run 已存在、节点在该 run 里、账本上有 childId、且状态不是 completed。上游结论取不到时不发（fail-closed，原因写进 detail 与账本）。与 retry 互斥：retry 管还没派出去的，resume 管已派出没干成的。' },
      retry: { type: 'boolean', description: 'run：只重评估既有 run 的待办节点（pending 且依赖已满足者），把被阻塞或派发失败的节点再试一次。不写树、不重声明、不重置任何已派出/已完成的状态；没有待办时返回空 dispatched，不报错。省略即老行为（声明一条新 run）。' },
      task_id: { type: 'string', description: 'send/interrupt/result：子会话 id。result 三种答复：结算通知已落进本会话 → completed；这个 id 不是你的孩子 → unknown；孩子存在但通知未到 → running。' },
      scope: { type: 'string', enum: ['tree', 'children', 'descendants'], description: 'list：tree（默认）读树，children 读直接子代理（默认最新 10 个），descendants 读下面所有子代理。' },
      limit: { type: 'number', description: 'list(scope=children)：最多返回几个孩子，默认 10，取最新的；返回值里带 total/truncated。' },
      merge: { type: 'number', description: 'list(scope=tree)：往下拼几层子代理自己写的树，拼在各自 bind 的节点下。0 或省略只读本会话自己的树。子代理始终写自己的树，拼接靠 bind 已记下的 assignedTo。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', description: '本次动到的子会话 id（若有）。' },
          node: { type: 'string', description: '本次动到的节点 id（若有）。' },
          status: { type: 'string', required: true, description: 'pending | in_progress | completed | failed | running | inactive | unknown' },
          result: { type: 'string', description: '子代理的结算通知：如何结束，加上它的收尾文本。' },
          tree: { type: 'string', description: '渲染成可读文本的任务树。' },
          run: { type: 'string', description: 'run：本次声明的 run id。' },
          dispatched: { type: 'array', items: { type: 'string' }, description: 'run：本次调用里已经派出去的节点 id（起点们）。后继由插件在前置完成时自动派出，不会出现在这个列表里。' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: 'task ' + String(value.status) }],
    },
    async execute(args, exec) {
      switch (args.action) {
        case 'run': {
          const parent = requireAgent(exec)
          if (args.run === undefined || args.run === '') throw new Error('task run requires `run` (the id of this run)')
          // 三者分工互斥，先判同时给：`retry` 管**还没派出去**的待办，`resume` 管**已派出但没干成**的节点。
          if (args.retry === true && args.resume !== undefined) {
            throw new Error('task run: retry 与 resume 不能同时给 —— retry 重评估还没派出去的待办节点，resume 把某个已派出但没干成的节点交回它原来那个孩子接着干')
          }
          // **续跑分流同样必须在写树与 store 之前**：它既不声明新 run，也不碰树上的节点集合。
          if (args.resume !== undefined) {
            if (args.nodes !== undefined && args.nodes.length > 0) {
              throw new Error('task run: resume 只续跑既有节点，不接受 `nodes` —— 要改节点就换一个 run id 重新声明')
            }
            const sid = sessionId(exec)
            const known = await runs().list(sid)
            const existing = known.find(item => item.id === args.run)
            if (existing === undefined) {
              throw new Error('task run: resume 需要一条已存在的 run，这条会话里没有 "' + args.run + '"（已知: ' + known.map(item => item.id).join(', ') + '）')
            }
            const target = existing.nodes.find(item => item.id === args.resume)
            if (target === undefined) {
              throw new Error('task run: 这条 run 里没有节点 "' + args.resume + '"（已知节点: ' + existing.nodes.map(item => item.id).join(', ') + '）')
            }
            if (target.childId === undefined || target.childId === '') {
              throw new Error('task run: 节点 "' + target.id + '" 账本上没有 childId —— 它从来没有被派出去过，放行它请用 retry')
            }
            if (target.status === 'completed') {
              throw new Error('task run: 节点 "' + target.id + '" 已经 completed —— 要重做请换一个节点 id，或换一条 run 重新声明')
            }
            const resumed = await resumeNode(parent, sid, existing, target, exec.signal)
            if ('blocked' in resumed) {
              // 取不到上游结论 ⇒ 一个字都没发（fail-closed），把原因如实回给调用方。
              return { status: 'pending', run: existing.id, node: target.id, result: resumed.blocked }
            }
            return { status: 'running', task_id: resumed.childId, node: target.id }
          }
          // **重评估分流必须在写树与 store 之前**：retry 的语义是「既有 run 的待办重跑一遍」，
          // 它绝不能声明、也绝不能重置任何东西。
          if (args.retry === true) {
            if (args.nodes !== undefined && args.nodes.length > 0) {
              throw new Error('task run: retry 只重评估既有 run 的待办节点，不接受 `nodes` —— 要改节点就换一个 run id 重新声明')
            }
            const sid = sessionId(exec)
            const known = await runs().list(sid)
            const existing = known.find(item => item.id === args.run)
            if (existing === undefined) {
              throw new Error('task run: retry 需要一条已存在的 run，这条会话里没有 "' + args.run + '"（已知: ' + known.map(item => item.id).join(', ') + '）')
            }
            // 不 store（`store` 是追加，会造出同 id 的重复 run，而 patchRunNode 会打到同 id 的每一条）、
            // 不 write（树上的节点一个都不动）、不重置任何状态 —— 只把**现在就能派**的那些派出去。
            return { status: 'running', run: existing.id, dispatched: await releaseRun(parent, sid, existing) }
          }
          if (args.nodes === undefined || args.nodes.length === 0) throw new Error('task run requires a non-empty `nodes` list')
          // 校验在前：needs 点名不存在的节点、id 重复、依赖成环都在这里拒掉。
          // 成环的图**必须报错**：那样的图里没有一个节点是起点，静默接受等于声明一条永远不动的流水线。
          const nodes = normalizeRunNodes(args.nodes as readonly Record<string, unknown>[], args.run)
          const sid = sessionId(exec)
          // 账本服务**在写树之前**拿到手：服务缺席时这一步就抛，绝不先写下一棵
          // 永远不会被放行的树。依赖校验（上面那次 normalize）同样早于写树。
          const ledger = runs()
          // 树只被写 title/detail：**依赖不进树**（判据是用户那句「树是树，后端是后端」）。
          // 顺序是硬约束：bind 要求节点已存在，所以树必须先落，起点才派得出去。
          await tree().write(sid, nodes.map(runTreeNode), false)
          const run: RunRecord = { id: args.run, createdAt: Date.now(), nodes }
          await ledger.store(sid, run)
          // 起点（needs 为空）立刻派出，一个 run 里可以有多个起点，并行。
          const dispatched: string[] = []
          for (const node of run.nodes) {
            if (node.needs.length > 0) continue
            const childId = await dispatchRunNode(parent, sid, run, node)
            if (childId !== undefined) dispatched.push(node.id)
          }
          // **不通知中枢**：这一次调用只写了树与后端账本，没有任何一条消息投进中枢的会话。
          return { status: 'running', run: run.id, dispatched }
        }
        case 'plan': {
          if (args.nodes === undefined || args.nodes.length === 0) throw new Error('task plan requires a non-empty `nodes` list')
          assertTitledNodes('plan', args.nodes as readonly { readonly id: string; readonly title?: string }[])
          await tree().write(sessionId(exec), args.nodes as readonly FlatNode[], args.replace === true)
          return { status: 'pending' }
        }
        case 'step': {
          if (args.node === undefined) throw new Error('task step requires `node`')
          await tree().step(sessionId(exec), args.node, {
            ...args.status !== undefined ? { status: args.status as TaskNodeStatus } : {},
            ...args.detail !== undefined ? { detail: args.detail } : {},
          })
          return { node: args.node, status: args.status ?? 'unknown' }
        }
        case 'list': {
          const scope = args.scope ?? 'tree'
          if (scope === 'tree') {
            // merge 省略或为 0 时走老的 read()，行为一字不变。
            // merge >= 1 时递归拼入子代理自己的树，深度就是合并几层委派。
            const depth = args.merge ?? 0
            const port = tree()
            const nodes = depth >= 1 && port.readMerged !== undefined
              ? port.readMerged(sessionId(exec), depth)
              : port.read(sessionId(exec))
            return { status: 'unknown', tree: renderTree(nodes) }
          }
          const parentId = sessionId(exec)
          // descendants **原样不动**：它只有 807 字符（tree 那档的量级），
          // 而 children 在长会话里是无上限的（38 个孩子 ≈ 5,098 字符），
          // 所以上限只加在 children 这一档上。
          if (scope === 'descendants') {
            const rows = await ctx.subagents.listDescendants(parentId, exec.signal)
            return { status: 'unknown', result: JSON.stringify(rows) }
          }
          const rows = await ctx.subagents.listChildren(parentId, exec.signal)
          // 目录序是**父目录事件序**（append = 创建序，最旧在前，
          // dsh-subagent/lib/types/list-children.d.ts:23）。所以「最新」在**数组末尾**；
          // 这里按 createdAt 降序排（稳定排序，同刻不换相对序），
          // 既不依赖宿主顺序，也保证与它一致。
          const ordered = rows
            .map((row, index) => ({ row, index }))
            .sort((a, b) => b.row.createdAt - a.row.createdAt || a.index - b.index)
            .map(entry => entry.row)
          const limit = args.limit ?? CHILDREN_LIMIT_DEFAULT
          const shown = ordered.slice(0, limit).map(row => ({
            id: row.id,
            // label 只用于辨认；中枢接着要 `task result/send/interrupt` 时用的是 id，
            // 所以 id **必须完整**（精确匹配，没有前缀匹配）。
            ...row.label === undefined ? {} : { label: row.label },
            // mode 决定这个孩子能不能续跑（continuable）——直接决定中枢下一步是
            // `send` / `run resume` 还是只能重新派一个，所以留。
            // createdAt 答不出判据里的任何一条，删。
            mode: row.mode,
          }))
          // 中枢**只读这一个返回值**就要知道「有没有更多」：total = 全部孩子数，
          // truncated = 是否被截；被截时附一句怎么拿更多。
          return {
            status: 'unknown',
            result: JSON.stringify({
              total: rows.length,
              shown: shown.length,
              truncated: rows.length > shown.length,
              ...rows.length > shown.length
                ? { hint: childrenTruncationHint(rows.length, shown.length) }
                : {},
              children: shown,
            }),
          }
        }
        case 'result': {
          if (args.task_id === undefined) throw new Error('task result requires `task_id`')
          // 运行时**没有** result(childId) 这个方法：结果是由运行时自己做成一条
          // `subagent-settled` 用户消息投进父会话的（`createSettlementMessage`，
          // dsh-subagent/lib/index.js:633-654；投递见同文件 :1254-1264 的 notifySettlement）。
          // 所以本动作是**从父会话自己的历史里回读**，而不是向运行时索取。
          //
          // 顺序是**先回读、再判存在**，两步合起来才分得清三件事：
          // completed（结算通知已经落进本会话）、unknown（这个 id 根本不是本会话的孩子——
          // 打错一个字符就是这种）、running（其余全部）。`running` 因此有两种成因，
          // 而且在本工具的执行期里**分不开**：孩子还在跑，或者它已经结算、那条通知要等到
          // 父代理的下一轮才出现。模型看到 `running` 应当去做别的事，而不是原地重问。
          // 先回读是必须的：孩子结算之后可能已经离开活动目录面，从目录判存在会把它误判成 unknown。
          const settled = settledNotice(exec, args.task_id)
          if (settled !== undefined) return { task_id: args.task_id, status: 'completed', result: settled }
          const parentId = sessionId(exec)
          if (!await isKnownChild(ctx, parentId, args.task_id, exec.signal)) {
            return { task_id: args.task_id, status: 'unknown' }
          }
          // 这里**没有等待**，而且不能有：结算在工具执行期内不可见（真机实测
          // `e2e\runs\verify-wait3` —— 轮询到 120000ms 执行期限仍是空手；另一路独立
          // 实测 1500 次 × 25ms = 37.5 秒同样拿不到，而那条消息在程序结束之后确实出现在
          // 父上下文里）。所以 running 就是「现在看不到」，交回给模型，不替它等。
          return { task_id: args.task_id, status: 'running' }
        }
        case 'send': {
          const sender = requireAgent(exec)
          if (args.task_id === undefined) throw new Error('task send requires `task_id`')
          if (args.prompt === undefined) throw new Error('task send requires `prompt`')
          // sender 必须是**当刻活着的 Agent 本身**：服务从它推出持久的发送者归属
          // （dsh-subagent/lib/index.js:2886-2896）。传 id 字符串或父会话都不行。
          const target = args.task_id as SessionId
          const inboxId = await ctx.subagents.sendMessage(
            sender,
            target,
            [{ type: 'text', text: args.prompt }],
            { signal: exec.signal },
          )
          return { task_id: args.task_id, status: 'running', result: JSON.stringify({ inboxId }) }
        }
        case 'interrupt': {
          if (args.task_id === undefined) throw new Error('task interrupt requires `task_id`')
          // authority 是「人类父级地址」或**当刻活着的祖先 Agent**；不属于目标的 authority 会抛
          // UNAUTHORIZED（dsh-subagent/lib/index.js:2914-2930）。该调用是**发出即返回**：
          // 目标可能继续跑到它自己观察到取消信号为止，所以返回 running 是诚实的。
          const authority: SubagentInterruptAuthority = { kind: 'ancestor', agent: requireAgent(exec) }
          ctx.subagents.interrupt(args.task_id as SessionId, authority)
          return { task_id: args.task_id, status: 'running' }
        }
        case 'ask': {
          if (args.question === undefined) throw new Error('task ask requires `question`')
          const questions = ctx.get('userQuestions')
          if (questions === undefined) {
            throw new Error('task ask: the `userQuestions` service is unavailable — this composition has no human answerer, so the question was never shown')
          }
          // 树是决策的**唯一**落点，所以它缺席时这里必须报错，而不是问完就把答案丢在对话里。
          // 对话会被压缩掉，答案不会自己留下；静默降级等于这条机制不存在。
          const sid = sessionId(exec)
          // 先把问题写进树，再问。顺序不能反：先问后写的话，一旦写失败，用户已经
          // 答过的话就只剩下对话里那一份，压缩之后就没了 —— 那正是这套机制要防的事。
          const nodeId = `${DECISION_PREFIX}${tree().read(sid).filter(node => node.id.startsWith(DECISION_PREFIX)).length + 1}`
          // `replace: false` —— 决策节点是**追加**到现有树上的，绝不能把树换掉。
          await tree().write(sid, [{ id: nodeId, title: args.question }], false)
          // 服务身份与调用形状对齐内置的提问工具（dsh-tool-ask-user/lib/index.js:96-111）：
          // 参数在服务侧是 camelCase 的 multiSelect，在工具侧是 snake_case 的 multi_select。
          const asked = await questions.ask({
            questions: [{
              id: 'task-ask',
              question: args.question,
              ...args.options !== undefined ? { options: args.options.map(label => ({ label })) } : {},
            }],
            ...exec.agent !== undefined ? { agent: exec.agent } : {},
            signal: exec.signal,
          })
          const answer = asked.answers[0]
          const decision = answer === undefined
            ? '(no answer)'
            : [...answer.selected, ...answer.custom === undefined ? [] : [answer.custom]].join(', ')
          // 把答案钉回节点。这条 detail 就是之后每次装配都会重读的决策本体。
          await tree().step(sid, nodeId, { status: 'completed', detail: ANSWER_PREFIX + decision })
          return { node: nodeId, status: 'completed', result: decision }
        }
        // `dispatch` **不再对中枢暴露**：`action.enum` 里没有它，模型连合法调用都构造不出来
        // （参数层先一步报 `"action" must be one of [...]`，有测试钉住）。这个分支只留一个
        // 清楚的解释，防的是「靠 SDK / 旧缓存 / 别处拼出来的调用」静默落空 —— 它**不派任何活**，
        // 绝不退化成一条没人知道的旧路。实现层的派发路径原样保留，`run` 走的就是它。
        //
        // 为什么撤掉：`dispatch` 的 `bind` 是可选的，于是它是一条「不必先建节点就能派活」的
        // 直达通道。中枢一直在用它，计划树因此可以被搞空。`run` 必须声明 `nodes`，派发即建树，
        // 树在结构上就不可能为空。用户裁决：「dispatch 这个工具，正常应该直接不暴露给你的」。
        case 'dispatch' as string:
          throw new Error(
            'task: action "dispatch" 已不对中枢暴露（enum 里没有它），也不会派活 ——'
            + '派活请改用 action "run"：它必须声明 `nodes`，声明即建树，起点立刻派出，'
            + '后继在前置全部完成时由插件自动派出；续跑既有节点用 resume，重评估待办用 retry。',
          )
        default:
          throw new Error(`task: unknown action "${String(args.action)}"`)
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Task', kind: 'other', rawInput: args }),
  }))
}

/**
 * 取当刻活着的调用者 Agent；缺席即抛。
 *
 * `exec.agent` 是 `sendMessage` 的 `sender` 与 `interrupt` 的 `authority` **唯一**的合法身份：
 * 上游明写 sender 是「exact live Agent」，authority 是「human parent address or exact live ancestor Agent」
 * （`dsh-subagent/lib/index.js:2888`、`:2925`）。传 id 字符串不行。
 * @param exec - 工具执行上下文。
 * @returns 调用者 Agent 本身。
 */
function requireAgent(exec: { agent?: Agent }): Agent {
  if (exec.agent === undefined) throw new Error('task requires a calling agent (exec.agent was undefined)')
  return exec.agent
}

/**
 * 调用方那条会话的 id。派发之外的所有动作都按会话分区。
 *
 * `Session.id` 是 0.1.7 的 `Branded<'SessionId'>`（`dsh-session/lib/types/types.d.ts:5`），
 * 而子代理服务的三个入参都要这个牌子。裸 `string` 过不了类型检查，所以在这里断言一次，
 * 而不是在每个调用点各断言一次。
 * @param exec - 工具执行上下文。
 * @returns 会话 id。
 */
function sessionId(exec: { agent?: { session?: { id: string } } }): SessionId {
  const id = exec.agent?.session?.id
  if (id === undefined) throw new Error('task requires a calling session (exec.agent.session was undefined)')
  return id as SessionId
}

/**
 * 一个 Agent 的委派深度（主代理是 0）。
 *
 * 读的是**会话 header** 而不是运行时 `AgentOptions`：header 里的那份是持久且单调的
 * （`childSessionMeta` 把它写进创建元数据，冷启动之后依然作数），
 * `delegationDepthOf`（dsh-subagent/lib/types/depth.js）取的正是两者的最大值。
 * @param agent - 待判定的 Agent。
 * @returns 非负整数深度；读不到按 0（顶层）算。
 */
function delegationDepthOf(agent: Agent): number {
  const header = (agent.session as { header?: { delegationDepth?: number } } | undefined)?.header
  const depth = header?.delegationDepth
  return depth !== undefined && Number.isSafeInteger(depth) && depth >= 0 ? depth : 0
}

/**
 * 派发前的层数闸门：到第 {@link MAX_DELEGATION_DEPTH} 层就不再往下。
 *
 * 抛错而不是静默放行：深处再派一次会造出一棵渲染层根本画不出来的树，
 * 而「静默拒绝」会让模型以为活已经派出去了。
 * @param agent - 当刻要派发的 Agent。
 */
function assertCanDelegate(agent: Agent): void {
  const childDepth = delegationDepthOf(agent) + 1
  if (childDepth >= MAX_DELEGATION_DEPTH) {
    throw new Error(
      `task dispatch: delegation depth ${childDepth} would exceed the ${MAX_DELEGATION_DEPTH}-level limit `
      + `(this agent is already at depth ${childDepth - 1}); do this step yourself or hand it to a peer`,
    )
  }
}

/**
 * 「已派出、账本未确认」登记表的键。
 *
 * 三段都要带上：会话把不同会话的 run 隔开，run id 把同会话里不同流水线隔开，
 * 节点 id 才是最后那一个格子。少一段就会出现「A 流水线的登记把 B 流水线的节点挡住」。
 * 分隔符用 NUL：它不可能出现在会话 id / run id / 节点 id 里，拼不出歧义。
 * @param sid - 父会话 id。
 * @param runId - run id。
 * @param nodeId - 节点 id。
 * @returns 登记键。
 */
function dispatchMemoKey(sid: string, runId: string, nodeId: string): string {
  return sid + '\u0000' + runId + '\u0000' + nodeId
}

/**
 * `task list scope=children` 默认返回多少个孩子。
 *
 * 这一档**唯一没有上限**：每个孩子一个 36 位 UUID，长会话里 38 个孩子就是 5,098
 * 字符，而中枢会把 list 反复调。取最新而不是最旧，是因为中枢问「有哪些孩子」时
 * 想找的几乎总是刚刚派出去的那些。
 */
const CHILDREN_LIMIT_DEFAULT = 10

/**
 * 被截断时给中枢的一句话：它只看这一个返回值，所以「还有更多」必须写在值里。
 *
 * @param total - 目录里的孩子总数。
 * @param shown - 本次返回的孩子数。
 * @returns 提示语，说明总数、显示数与怎么拿更多。
 */
function childrenTruncationHint(total: number, shown: number): string {
  return `共 ${total} 个孩子，此处显示最新 ${shown} 个；要更多请传 limit。`
}

/**
 * 把一棵（可能嵌套的）树铺平成一列，顺序是先序：父在前、它的孩子紧随其后。
 *
 * 合并视图把被派发的子会话那棵树**挂**在派发节点的 `children` 上
 * （`readMerged`，见 `packages/plan-tree/src/task-tree.ts` 的 `deepen`），于是
 * 「哪些节点是决策」这种全树问题必须先铺平 —— 只扫顶层会漏掉所有子代理问过的话。
 * @param nodes - 顶层节点列表。
 * @returns 铺平后的节点列表（原来那些节点本身，没有复制）。
 */
function flattenNodes(nodes: readonly TaskNode[]): readonly TaskNode[] {
  const flat: TaskNode[] = []
  const walk = (list: readonly TaskNode[]): void => {
    for (const node of list) {
      flat.push(node)
      walk(node.children ?? [])
    }
  }
  walk(nodes)
  return flat
}

/**
 * 把树渲染成人能读的缩进文本。**只用于工具结果**，不是权威形态（权威形态是 store 里的嵌套数组）。
 * @param nodes - 根节点。
 * @returns 每行一个节点的文本。
 */
function renderTree(nodes: readonly TaskNode[]): string {
  const lines: string[] = []
  const walk = (list: readonly TaskNode[], depth: number): void => {
    for (const node of list) {
      lines.push(`${'  '.repeat(depth)}- [${node.status}] ${node.id}: ${node.title}${node.assignedTo === undefined ? '' : ` (child ${node.assignedTo})`}`)
      // detail 也要露出来：`派发失败：` 与 `结论缺失：` 都写在它上面，而这里是面板之外
      // 唯一读得到树的地方 —— 这条链上前两次栽跟头都栽在「看不见原因」上。
      // **只给非 completed 的节点**加这一行：已完成节点的 detail 是收尾摘要，
      // 全树都印出来会把这棵树的形状淹掉（那是刷屏，不是信息）。
      // 折叠成单行、按 detail 原本的 200 上限截断 —— 与面板上看到的是同一句。
      if (node.status !== 'completed' && node.detail !== undefined && node.detail !== '') {
        lines.push(`${'  '.repeat(depth + 1)}detail: ${truncate(singleLine(node.detail), DETAIL_MAX)}`)
      }
      walk(node.children ?? [], depth + 1)
    }
  }
  walk(nodes, 0)
  return lines.length === 0 ? '(empty tree)' : lines.join('\n')
}

/**
 * 这个 id 是不是**本会话的孩子**（直接子或更深的后代）。
 *
 * 只用于把「孩子还在跑」与「根本没有这个 id」分开：`listChildren` / `listDescendants`
 * 读的是父会话自己的持久目录（`dsh-subagent/lib/types/index.d.ts:218`、`:234`），子代理
 * 离开活动面之后**仍在**目录里，所以结算过的孩子不会被它判成不存在。
 *
 * 任何失败都当**查询不可用**处理（返回 true），绝不把一次目录读失败说成「没有这个孩子」：
 * 后者会让模型以为自己派发失败，而真相是这次查询没做成。
 * @param ctx - 宿主上下文（借 `ctx.subagents` 的目录面）。
 * @param parentId - 调用方那条会话的 id。
 * @param childId - 待判定的 id。
 * @param signal - 取消信号，原样转发给目录读。
 * @returns 孩子存在（或无法判定）时为 true。
 */
async function isKnownChild(ctx: Context, parentId: SessionId, childId: string, signal: AbortSignal): Promise<boolean> {
  try {
    const children = await ctx.subagents.listChildren(parentId, signal)
    if (children.some(entry => String(entry.id) === childId)) return true
    const descendants = await ctx.subagents.listDescendants(parentId, signal)
    return descendants.some(entry => String(entry.id) === childId)
  } catch {
    return true
  }
}

/**
 * 从父会话自己的历史里回读某次结算的正文。
 *
 * 结果不是「取」来的，是运行时**投**进来的：`createSettlementMessage`
 * （`dsh-subagent/lib/index.js:633-654`）把摘要与子代理的收尾文本做成一条
 * `source.kind === 'subagent-settled'` 的 user message，`senderSessionId` 就是子会话 id。
 * 因此本函数只做一件事：倒着扫父会话的派生历史，找出那条通知。
 * @param exec - 工具执行上下文（借 `exec.agent.session`）。
 * @param childId - 派发时返回的子会话 id。
 * @returns 那条通知的正文，或 undefined（还没结算）。
 */
function settledNotice(exec: { agent?: { session?: { deriveMessages(): readonly unknown[] } } }, childId: string): string | undefined {
  const messages = exec.agent?.session?.deriveMessages() ?? []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { source?: { kind?: string; senderSessionId?: string }; content?: readonly { type?: string; text?: string }[] } | undefined
    if (message?.source?.kind !== 'subagent-settled') continue
    if (message.source.senderSessionId !== childId) continue
    const text = (message.content ?? []).flatMap((block) => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n')
    return text.length > 0 ? text : undefined
  }
  return undefined
}

/**
 * 子代理回传状态用的那一行。**全角冒号**，与派发简报（{@link withNodeBrief}）里的文案逐字一致 ——
 * 改这里就得同时改那边，否则子代理报的那一行永远匹配不上。
 */
const STATUS_LINE = /^\s*状态\s*[:：]\s*(完成|失败)\s*$/u

/** 报完成时 detail 的抬头。 */
const STATUS_DONE = '状态：完成'
/** 报失败时 detail 的抬头。 */
const STATUS_FAILED = '状态：失败'
/** 没收到状态回报时 detail 的抬头 —— 这是**失败**，不是「还不知道」。 */
const STATUS_SILENT = '状态：未收到回报'

/**
 * 被强停时追加在 {@link STATUS_SILENT} 后面的短标记 —— **失败档唯一允许的补充**。
 *
 * 为什么只留这一个：detail 里每一段都必须答得出「现在什么状态 / 下一步做什么 / 出问题没有 /
 * 细节去哪拿」之一。抬头已经答了状态；再说一句同义的「没收到状态回报」是重复，
 * 照抄宿主整句摘要（真机实测那一句是
 * `Background subagent <36 位 uuid> was stopped before it finished.`，约 100 字符）
 * 则一条都答不出 —— 那一整句里真正有信号的只有「被强停」四个字。
 */
const STOPPED_MARK = '（被强停）'

/**
 * 从宿主摘要句里认「被强停」。
 *
 * **这是文本匹配，不是结构化判定。** 已核实宿主这侧没有能用的结构化字段：
 * `subagent-settled` 事件的 `source` 只有 `{ kind, form, summary, senderSessionId }`
 * （`SubagentSettledMessageSource`），`stopReason` 留在 `createSettlementMessage` 内部的
 * `terminal` 上，插件取不到；目录面（`ctx.subagents.listChildren`）的行也只有
 * `activity` 与 `mode`，同样没有停止原因。
 *
 * 于是按宿主 `settlementSummary`（`dsh-subagent/lib/types/continuation-messages.js`）里
 * aborted 那一档的文案 `... was stopped before it finished.` 做**宽松关键词**认，
 * 顺带认几个同义词；不去逐字匹配整句，宿主换个说法只会让标记消失（少一个补充），
 * **绝不会**因为认错而给出一条假结论。认的对象是自己这句 `source.summary`，不是子代理的正文。
 */
const STOPPED_HINT = /stopped|aborted|cancell?ed|interrupted/iu

/**
 * detail 的上限。上限按**整条 detail** 算，不是只截摘要 ——
 * 否则 `状态：完成｜` 那一段会把 200 撑破。
 */
const DETAIL_MAX = 200

/** 子代理自己报的那条状态。 */
interface NodeReplay {
  /** 报的是完成还是失败。 */
  readonly status: 'completed' | 'failed'
  /** 状态行之后的第一条非空行；没有就是空串。 */
  readonly summary: string
}

/**
 * 从结算正文里读回子代理自己报的状态行。
 *
 * **倒着扫**：子代理可能在正文里引用过这个格式（讲协议、举例），压过它最后真正报的那行就错了 ——
 * 所以取**最后**一条匹配的行，也就是最近的一条。
 * @param body - 结算正文（`settledNotice` 拼出来的那一份）。
 * @returns 状态与摘要；一行都没匹配上时为 undefined（没报）。
 */
function readNodeReplay(body: string): NodeReplay | undefined {
  const lines = body.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const matched = STATUS_LINE.exec(lines[index] ?? '')
    if (matched === null) continue
    return {
      status: matched[1] === '完成' ? 'completed' : 'failed',
      summary: firstLineAfter(lines, index),
    }
  }
  return undefined
}

/**
 * 状态行之后的第一条非空行。**只往后看**：往前看会捡到宿主那句摘要句或子代理自己的正文。
 * @param lines - 正文各行。
 * @param index - 状态行在 `lines` 里的下标。
 * @returns 折叠成单行的摘要，或空串。
 */
function firstLineAfter(lines: readonly string[], index: number): string {
  for (let cursor = index + 1; cursor < lines.length; cursor++) {
    const candidate = singleLine(lines[cursor] ?? '')
    if (candidate !== '') return candidate
  }
  return ''
}

/**
 * 自动派发失败时写进节点 detail 的前缀。
 *
 * 为什么要有它：派发失败会被回滚成 `pending`（孩子确实没起来，这是事实），于是现场
 * 与「依赖还没满足」长得一模一样。这个前缀把那两者分开，而且连原因一起写出来 ——
 * 「看不到原因」正是这条链上我已经栽过两次的坑。
 */
const AUTO_DISPATCH_FAILED_PREFIX = '派发失败：'

/**
 * 给被派出的子代理看的那一段**过程记录要求**。**逐字冻结**：中枢 2026-10-01 定稿（v3）。
 * （v2 → v3 只删掉末尾那句「写在你自己树里的节点会被合并…」—— 用户判定它是废话；
 * 语气仍是强制的，用户原话「提示词就该是强制的」，被否掉的是**门禁机制**，不是措辞。）
 * 测试按它逐字断言，改一个字都得先问过。
 *
 * 语气是命令式的，但**没有任何配套拦截**：不做规划不会被拦、不会被判失败，也不会有配置项
 * 或闸门。措辞强制、执行不拦 —— 这两件事互不矛盾，正是这一版要的形态。
 */
const PROCESS_NUDGE = '【过程记录（必须）】多步的活：**开工第一步必须**用 `task plan` 在**你自己的任务树**里写下阶段计划（分几段、每段做什么由你自己定）；**每完成一段必须**用 `task step` 推进到 completed，并在 detail 里写下这一段的结论。阶段之间**可以并行**，不要求先后顺序。'

/**
 * 这一段在段表里的名字（去重与排障用）。
 */
const PROCESS_NUDGE_SECTION = 'task:process-nudge'

/**
 * 这一段的目标档位 —— **必须是字面数字**：`getSectionOrder()` 只认 `SECTION_ORDERS` 里已有的
 * 名字，杜撰一个会拿到 `undefined`，而 `section()` 对非有限 order 直接抛错。
 *
 * 取 **640**：紧邻 {@link DECISION_SECTION_ORDER}（650），两者是同一类东西 ——「给被派出子代理的
 * 任务上下文」，都排在身份与全局规则之后、工具说明之前。640 在 650 之前，于是读到的顺序是
 * 「过程记录要求 → 已裁定的事」。
 *
 * 实际落点：`system-prompt/assemble` 的产物里每个 section **不带 order**
 * （prompt-plan 在同一个缝上的实测结论：an assembled section carries no `order` member），
 * 段表顺序在装配那一刻就已定好，所以这一段的实际位置是**段表末尾**；
 * 这个常量记录的是它的目标档位，以及为什么取这个数。
 */
const PROCESS_NUDGE_ORDER = 640

/**
 * 放行被阻塞时写进节点 detail 与账本 note 的前缀。
 *
 * 为什么要有它：取不到上游结论的节点**保持 pending、不派发**（fail-closed），于是现场
 * 与「依赖还没满足」长得一模一样。这个前缀把那两者分开，并把**是哪个依赖**说清楚。
 */
const AUTO_DISPATCH_MISSING_PREFIX = '结论缺失：'

/**
 * 上游结论段的稳定锚点 —— 只用于**没被槽位吃掉**的那些依赖（见 {@link upstreamSection}）。
 *
 * 拼装口径（2026-10-01 用户拍板，定稿）：**槽位优先、追加兜底**。
 *   1. 节点自己的 prompt 就是**框架**：`{{chain-a}}` 这样的槽位被**就地**换成那个依赖的
 *      结论文本全文（不带前言/标题/围栏/前后缀），同一个依赖出现多次就每一处都换；
 *   2. 没被任何槽位覆盖的依赖，按 `needs` 声明顺序，用这一段（锚点 + 引导语 + 每依赖一个
 *      小标题 + 正文）追加到框架之后；
 *   3. 全部依赖都被槽位吃掉 ⇒ **一个块都不追加**；没有任何 needs ⇒ 一个字都不加。
 *
 * 两条路的正文来自**同一份取数结果**（{@link settledNotice} 从父会话历史里倒着扫出来的
 * 结算正文），所以「槽位填的」与「追加的」不可能给出不一样的内容。
 */
const UPSTREAM_ANCHOR = '【上游结论】'

/** 锚点后面那一句：把这一段是什么、以及「直接拿来用」说清楚。 */
const UPSTREAM_LEAD = '以下是你依赖的节点已完成的收尾结论，按 needs 声明顺序给出，直接拿来用，不要重新采集。'

/**
 * 上游结论超限时该条末尾的记号。
 *
 * 它对**槽位**也照用：截断与取数是两回事，槽位换的是「那一条结论的文本」，
 * 而单条上限（{@link UPSTREAM_MAX}）由这一层统一守住，两条路都跑不掉。
 */
const UPSTREAM_TRUNCATED = '…（上游结论已截断，原文 '

/**
 * 派发**成功**时，把陈旧的阻塞/失败原因换成的那一行事实。
 *
 * 只在这两种前缀还留在树 detail 上时才写（见 `dispatchRunNode`）：别的 detail 一个字不动，
 * 那是调用方自己写的东西，也会在结算时被结论覆盖。
 */
const DISPATCHED_DETAIL = '已派发'

/** 同上，但这个节点**有**上游结论（槽位或追加段至少命中一条）。 */
const DISPATCHED_DETAIL_WITH_UPSTREAM = '已派发：上游结论已注入'

/**
 * 「孩子已经在跑、账本那次写入却没落地」时写进树 detail 的前缀（后面接 childId）。
 *
 * 它与 `派发失败：` 是**相反**的两件事：那一句说「孩子没起来」，这一句说「孩子起来了，
 * 只是账本没记住」。混在一起正是这条链上最容易再派一个的坑。
 */
/**
 * 把预设表上的 `agentOptions` 窄化成宿主 `SubagentStartRequest.agentOptions` 认的形状。
 *
 * 为什么要这一步：`reasoningEffort` 在宿主那是 branded 类型 `ReasoningEffortId`
 * （`@deepseek-ai/dsh-llm`），而本包的 schema 收的是普通字符串。两条路可选 ——
 * import 那份类型，或者在这里做一次 `as`。选了后者，理由是**不新增依赖**：
 * `@deepseek-ai/dsh-llm` 既不在 dependencies 也不在 peer/devDependencies 里；
 * 为了一格配置把它拉进来，就要多一条运行时解析路径（本包里除这一个类型名之外
 * 一概用不到），或者让声明文件里出现一个本包够不到的名字 —— 正是 Config 那个
 * `Dict` 已经踩过的坑（见 `PresetSpecField` 上方的说明）。
 *
 * `as` 骗的只是类型系统：宿主侧真给了它不认的值，那一层自己会拒，报错位置比这里更准，
 * 所以这里**不做值校验**——维护一份会漂移的枚举副本，不如让唯一的那份说了算。
 * @param options - 预设表里声明的那一格。
 * @returns 原样字段，只是类型上对上了宿主的槽。
 */
function narrowAgentOptions(options: PresetAgentOptions): NonNullable<SubagentStartRequest['agentOptions']> {
  return options as NonNullable<SubagentStartRequest['agentOptions']>
}

const INFLIGHT_DETAIL_PREFIX = '已派发但账本未确认：child '

/**
 * 续跑时写在节点 detail 上的前缀（后面接 childId）。
 */
const RESUME_DETAIL_PREFIX = '已续跑：child '

/**
 * 续跑简报末尾追加的那一段。
 *
 * 为什么必须重申状态行：续跑的成因就是「上一轮没有给出可判定的结语状态行」（被判成
 * `状态：未收到回报`，节点落 failed）。不重申一遍，孩子很可能**再犯同一次**，
 * 于是这次续跑白跑。摘要那一句也一起重申 —— 它同样要在状态行之后单独一行。
 */
const RESUME_NOTE = '以上是你这一步的完整简报（与首次派发那一份逐字同形）。你上一轮没有把它做完：请接着做完，并在最终结语的末尾单独一行**原样**输出 `状态：完成`（或 `状态：失败`），这一行之后**再另起一行**写一句结论摘要。'

/**
 * 单条上游结论的上限（字符数）。
 *
 * 取值刻意**大**：下游要的是上游的结论**全文**，不是再来一次摘要 —— 树上 detail 的 200 字
 * 上限与这里无关（那是给人扫一眼的，这是给下一个子代理干活用的，上限不同是因为用途不同）。
 * 超过这个数才截断，并在该条末尾注明原文多少字，让读到的模型知道自己拿到的是残本。
 */
const UPSTREAM_MAX = 20000

/**
 * 单个依赖的结论文本：超过 {@link UPSTREAM_MAX} 才截断，并在末尾注明原文多少字。
 * @param body - 会话历史里的结算正文。
 * @returns 可直接放进简报的文本。
 */
/**
 * 把「框架（槽位已填）+ 没被槽位覆盖的那些依赖的【上游结论】块」拼成最终简报正文。
 *
 * 首次派发与**续跑**共用这一份：两条路给出的简报必须逐字同形，否则「接着干」的那个孩子
 * 会拿到一份与自己上一轮不同的说明。
 * @param upstream - {@link upstreamSection} 的产物。
 * @returns 简报正文（两者都空时就是空串）。
 */
function composeBrief(upstream: { readonly prompt: string; readonly text: string }): string {
  if (upstream.text === '') return upstream.prompt
  return upstream.prompt === '' ? upstream.text : upstream.prompt + '\n\n' + upstream.text
}

/**
 * 单个依赖的结论文本：超过 {@link UPSTREAM_MAX} 才截断，并在末尾注明原文多少字。
 * @param body - 会话历史里的结算正文。
 * @returns 可直接放进简报的文本。
 */
function capUpstream(body: string): string {
  return body.length <= UPSTREAM_MAX ? body : body.slice(0, UPSTREAM_MAX) + UPSTREAM_TRUNCATED + String(body.length) + ' 字）'
}

/**
 * 取齐一个节点**全部依赖的结算正文**，按「槽位优先、追加兜底」拼进它的简报。
 *
 * 四个不可动摇的点：
 *   - **来源是结算正文**，优先取账本里那一份（节点结算时写下的 `conclusion`），账本没有
 *     才退回会话历史（{@link settledNotice} 倒着扫出来的那一条）—— 历史会被压缩，账本不会，
 *     所以「依赖完成了、下游却永久阻塞」不再由「上下文被压缩」这种无关的事触发。
 *     两条路的正文是同一份（写入点就是监听器里已经取到的那份 body），都**不是**树 detail
 *     那 200 字 —— 摘要会丢掉下游要用的细节，而那正是这次要消掉的浪费。
 *   - **顺序就是 `node.needs` 的声明顺序**：这里不排序、不按 run 里的声明顺序、不去重，
 *     调用方写什么顺序就按什么顺序给。
 *   - **取不到就是取不到**：某个依赖没有 `childId`、或它的结算正文在历史里读不到，
 *     一律返回 `missing`，由调用方**拒绝派发**（fail-closed）。绝不退化成「这一段没了，
 *     照样派」—— 那会让下游在缺前提的情况下开工，而它自己不知道。**取齐之后才开始替换**：
 *     槽位绝不会拿到半份结论，也不会因为后面的依赖取不到而留下一个填了一半的框架。
 *   - **槽位优先、追加兜底**：`{{dep}}` 就地换成那一条的正文；没被任何槽位覆盖的依赖
 *     才进【上游结论】块。全被覆盖就没有块，一个 needs 都没有就一个字都不加。
 * @param exec - 读历史用的执行上下文（父 Agent 的会话历史）。
 * @param byId - 同一条 run 的节点表（按 id），用来找每个依赖的 `childId`。
 * @param node - 要派的那个节点。
 * @returns 全部取到时是 `{ prompt, text }`：`prompt` 是槽位已填好的框架，`text` 是
 *   没被槽位覆盖的依赖那一段（可能是空串 —— 调用方据此不追加）；任何一条取不到时是
 *   `{ missing }`，内容是单行的原因。
 */
function upstreamSection(
  exec: { agent?: { session?: { deriveMessages(): readonly unknown[] } } },
  byId: ReadonlyMap<string, RunNodeRecord>,
  node: RunNodeRecord,
): { readonly prompt: string; readonly text: string } | { readonly missing: string } {
  if (node.needs.length === 0) return { prompt: node.prompt, text: '' }
  const bodies = new Map<string, string>()
  for (const need of node.needs) {
    const dep = byId.get(need)
    // **账本优先**：结论在结算那一刻就被写进了 `conclusion`，那一份不会被上下文压缩碰掉，
    // 而且写的时候已经按同一个 20000 上限截断过 —— 所以这里**原样使用、不再二次截断**
    // （再截一次会在记号后面再叠一个记号，而且「账本里的」与「下游拿到的」就不再逐字相同）。
    const stored = dep?.conclusion
    if (stored !== undefined && stored !== '') {
      bodies.set(need, stored)
      continue
    }
    // 账本里没有这一格（本次改动之前完成的旧节点）才退回历史，口径与改动前完全一样。
    const childId = dep?.childId
    if (childId === undefined || childId === '') {
      return { missing: '依赖 ' + need + ' 在账本里没有 childId，取不到它的结算正文' }
    }
    const body = settledNotice(exec, childId)
    if (body === undefined) {
      return { missing: '依赖 ' + need + '（child ' + childId + '）的结算正文在父会话历史里读不到' }
    }
    bodies.set(need, capUpstream(body))
  }
  const filled = fillRunPrompt(node.prompt, bodies)
  // 追加段只收**没被任何槽位覆盖**的依赖，顺序仍是 needs 的声明顺序。
  const uncovered = node.needs.filter(need => !filled.filled.includes(need))
  if (uncovered.length === 0) return { prompt: filled.prompt, text: '' }
  const parts: string[] = []
  for (const need of uncovered) {
    parts.push('—— 节点 ' + need + '（child ' + String(byId.get(need)?.childId ?? '') + '）——')
    parts.push(bodies.get(need) ?? '')
  }
  return { prompt: filled.prompt, text: UPSTREAM_ANCHOR + UPSTREAM_LEAD + '\n' + parts.join('\n') }
}

/**
 * 把任意文本压成**一行**：换行与连续空白折叠成一个空格，两端去白。
 * @param text - 任意文本。
 * @returns 单行文本。
 */
function singleLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * 截到上限。超出时末位换成省略号，于是返回值长度**一定** ≤ 上限。
 * @param text - 原文本。
 * @param max - 上限（字符数）。
 * @returns 截断后的文本。
 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…'
}

/**
 * 摘要句里是不是写着「被强停」。
 * @param summary - 已折成单行的宿主摘要句。
 * @returns 写着被强停时为 true。
 */
function wasStopped(summary: string): boolean {
  return STOPPED_HINT.test(summary)
}

/**
 * 算出要写进节点的 status 与 detail。
 *
 * 三档：报完成、报失败、没收到回报（没报 / 格式不对 / 被强停都算这一档）。
 * 最后一档落 **failed**，绝不因为「孩子结算了」而写成成功 —— 宿主那句摘要句
 * （`source.summary`）只做补充说明，取不到就当取不到，不是错误。
 *
 * 三档的 detail 都是「一条结论 + 至多一段短补充」：抬头说状态，补充只在真的多带一个信号时才出现
 * —— 报完成/报失败档是子代理自己报的那条摘要，没收到回报档只有 {@link STOPPED_MARK} 这一个短标记。
 * @param replay - 子代理回传的状态；没报时为 undefined。
 * @param hostSummary - 运行时写在 `source.summary` 上的那一行摘要句。
 * @returns 写树用的补丁。
 */
function settlementPatch(replay: NodeReplay | undefined, hostSummary: string | undefined): { status: TaskNodeStatus; detail: string } {
  if (replay !== undefined) {
    const head = replay.status === 'completed' ? STATUS_DONE : STATUS_FAILED
    return { status: replay.status, detail: truncate(replay.summary === '' ? head : head + '｜' + replay.summary, DETAIL_MAX) }
  }
  const summary = singleLine(hostSummary ?? '')
  // 宿主整句摘要不进 detail —— 它答不出那四条里的任何一条。摘要句到这里只剩一个用途：
  // 认出「被强停」（正常结算却没报状态 vs 被强停，是它唯一携带的独立信号）。
  const detail = STATUS_SILENT + (wasStopped(summary) ? STOPPED_MARK : '')
  return { status: 'failed', detail: truncate(detail, DETAIL_MAX) }
}

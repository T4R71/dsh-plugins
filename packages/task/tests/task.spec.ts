/**
 * `task` 工具的单测。
 *
 * 覆盖三件在别处测不到的事：
 * 1. **schema 能被 DSL 编译**。`defineTool` 在注册时就把参数 DSL 编成 JSON Schema，
 *    编不过会抛 `JsonSchemaError`——嵌套对象漏写 `additionalProperties` 就是这样被抓住的
 *    （2026-09-29 实测过）。这条测试等于把那个坑钉住。
 * 2. **每个动作的必填校验**。缺参数必须抛，不许当成默认值静默继续。
 * 3. **树服务缺席时必须报错**，而不是把树类动作做成静默成功。
 *
 * 它不碰真机、不碰子代理运行时：`ctx` 是本文件里的假上下文。
 */
import assert from 'node:assert/strict'
import { allowToolSectionFilter, decodeDropDirective, encodeDropDirective, toolSectionsForFilter } from '../src/presets.ts'
import { it } from 'node:test'
import { apply, Config as TaskRowConfig, inject, type ResolvedConfig } from '../src/index.ts'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync as readFileSyncNode, writeFileSync as writeFileSyncNode } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RUN_NOTE_MAX, TASK_RUNS_FILE_ENV, TASK_RUNS_FILE_NAME, ledgerPathFor, runNodeWith, type RunNodeRecord } from '../src/session-store.ts'
import { defineTool, type InferArgs, type ParameterJsonSchema, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
// 隔离那一半的测试要真的建 git 仓：起线/复用/写穿检测都是 git 层面的行为，
// 用假件替掉就等于把要测的东西替掉了。
import { git, gitWithIdentity, worktreeMatches, worktreePathFor } from '../src/worktree.ts'

/** 模型入参的推导类型；假调用者不是 `ToolRunContext`，所以下面把 exec 放宽成 unknown。 */
type TaskArgs = InferArgs<ParameterSchemaSpec>

/** 抓取注册进工具面的定义。 */
interface Captured {
  readonly name: string
  readonly execute: (args: TaskArgs, exec: unknown) => Promise<Record<string, unknown>>
  readonly parameters: ParameterJsonSchema
}

/** 会话历史里的一条，只写 `settledNotice` 真会读的那几个键。 */
interface FakeMessage {
  readonly source: { readonly kind: string; readonly senderSessionId: string }
  readonly content: readonly { readonly type: string; readonly text: string }[]
}


/**
 * 造一条运行时投进父会话的结算通知（形状见 `createSettlementMessage`，
 * dsh-subagent/lib/index.js:633-654）。
 * @param childId - 子会话 id，也就是通知里的 `senderSessionId`。
 * @param text - 通知正文。
 * @returns 一条足量的假消息。
 */
function fakeSettle(childId: string, text: string): FakeMessage {
  return { source: { kind: 'subagent-settled', senderSessionId: childId }, content: [{ type: 'text', text }] }
}

/**
 * 注册期是否抛了错，以及抛的什么。
 * @param parameters - 交给 `defineTool` 的参数 DSL。
 * @returns 抛出的错误，没抛则为 undefined。
 */
function validationFailure(parameters: ParameterSchemaSpec): unknown {
  try {
    defineTool({
      name: 'probe',
      description: 'probe',
      parameters,
      output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
      execute: async () => ({}),
    })
    return undefined
  } catch (error) {
    return error
  }
}

/**
 * 用裸对象调用工具并取回结果对象。
 *
 * 之所以断言入参而不是窄化参数类型：这里要测的正是**参数层之外**的分支（未知动作的
 * `default`），模型走不到那里——运行时的 `defineTool` 先在 DSL 校验里拒掉非法 action。
 * @param definition - 抓到的工具定义。
 * @param args - 裸输入。
 * @param exec - 假调用者。
 * @returns 工具返回的规范值。
 */
async function run(
  definition: Captured,
  args: Record<string, unknown>,
  exec: unknown,
): Promise<Record<string, unknown>> {
  return definition.execute(args as TaskArgs, exec)
}

/** 定死的父会话 id：下面所有断言的 `sess-1` 就是它。 */
const SESSION = 'sess-1'

/**
 * 每个 harness 用**自己的账本文件**：在系统临时目录下开一个私有目录，路径经
 * `DSH_TASK_RUNS_FILE` 交给 apply。
 *
 * 为什么不用假服务：账本现在是真的文件 I/O（读-改-写 + 原子替换），把这些换成内存假件
 * 就等于不测真正落盘的那一半。文件路径可注入，所以测试既不碰真实 profile，
 * 又能把「宿主重启之后账本仍在」证成 —— 同一个路径再开一个 harness 就是重启。
 * @returns 一个尚未写过的账本文件路径。
 */
function freshLedgerFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'task-runs-spec-')), 'task-runs.json')
}

/**
 * 读账本文件里某条会话的 run 列表。**直接读那个文件**，断言的是真的落了盘。
 * @param file - 账本文件路径。
 * @param sid - 会话 id。
 * @returns run 列表；文件不存在或读不动时是空表。
 */
function ledgerRuns(file: string, sid: string = SESSION): Record<string, unknown>[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSyncNode(file, 'utf8'))
  } catch {
    return []
  }
  const sessions = (parsed as { sessions?: unknown } | undefined)?.sessions
  const list = isPlainRecord(sessions) ? sessions[sid] : undefined
  return Array.isArray(list) ? list as Record<string, unknown>[] : []
}

/**
 * 账本文件里某条 run 的某个节点。
 * @param file - 账本文件路径。
 * @param nodeId - 节点 id。
 * @param runId - run id。
 * @returns 节点记录；找不到为 undefined。
 */
function ledgerNode(file: string, nodeId: string, runId = 'r1'): Record<string, unknown> | undefined {
  const run = ledgerRuns(file).find(item => item.id === runId)
  const nodes = run === undefined ? undefined : run.nodes
  return Array.isArray(nodes) ? (nodes as Record<string, unknown>[]).find(node => node.id === nodeId) : undefined
}

/** 一个值是不是纯数据对象。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 断言某个路径**不存在**：证明「一个字节都没写」。
 *
 * 与 ledgerRuns(file).length === 0 不是一回事 —— 后者对「文件在、里面是空的」也成立，
 * 而这里要钉的是连文件都没被创建。
 * @param file - 账本文件路径。
 * @returns 不存在为 true。
 */
function ledgerFileAbsent(file: string): boolean {
  try {
    readFileSyncNode(file, 'utf8')
    return false
  } catch (error) {
    return (error as { code?: string }).code === 'ENOENT'
  }
}

/**
 * 一个只够 `apply` 跑起来的假上下文。
 * @param options - 是否提供 `taskTree` 服务、目录里有哪些孩子、账本落在哪份内存设置文档里
 *   （或直接给一个 `taskRuns` 服务）、父 Agent 是谁。
 * @returns 被注册的工具定义、调用记录、目录查询记录，以及可变的会话历史。
 */
function harness(options: { tree?: boolean; children?: readonly (string | { readonly id: string; readonly createdAt: number; readonly mode: 'one-shot' | 'continuable' | 'unknown'; readonly label?: string })[]; answers?: { id: string; selected: string[] }[]; presets?: Record<string, { persona?: string; allow?: string[]; deny?: string[]; maxDepth?: number; drop?: string[]; agentOptions?: { provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number } }>; defaultRules?: string; runsFile?: string; worktreesFile?: string; worktreeGoal?: string; worktreeVerify?: string; worktreeMergeVerify?: string; worktreePrepare?: string; worktreeAuto?: boolean; parentAgent?: Record<string, unknown>; descendants?: readonly { readonly id: string; readonly activity?: 'running' | 'inactive'; readonly kind?: 'child' | 'diagnostic'; readonly reason?: 'corrupt' | 'unsupported' | 'unavailable' }[]; descendantsThrow?: boolean; sessionStore?: readonly string[]; sessionStoreService?: boolean; beforeStart?: () => void } = {}): {
  tool: Captured
  calls: string[]
  listed: string[]
  messages: FakeMessage[]
  treeNodes: Record<string, unknown>[]
  nodesOf: (sid: string) => Record<string, unknown>[]
  treeCalls: string[]
  sections: { name: string; order: number; text: unknown }[]
  listeners: { event: string; handler: (...args: never[]) => unknown }[]
  notified: string[]
  starts: unknown[]
  sent: { agent: unknown; target: unknown; content: unknown; options: unknown }[]
  runsFile: string
  worktreesFile: string
} {
  const calls: string[] = []
  const listed: string[] = []
  const messages: FakeMessage[] = []
  const children = options.children ?? []
  const treeNodes: Record<string, unknown>[] = []
  // 树按**会话**分区：决策由提问者自己记在自己的树上，父侧看不见那份存储，
  // 全靠 `readMerged` 顺着 `assignedTo` 拼上来。一个所有会话共享的数组
  // 会让「子代理树里有、父会话树里没有」根本无法断言。
  const trees = new Map<string, Record<string, unknown>[]>([[SESSION, treeNodes]])
  /**
   * 某条会话当刻的树；没写过就是一棵空树（与 plan-tree 的 `read` 同语义）。
   * @param sid - 会话 id。
   * @returns 那棵树的可变数组。
   */
  const nodesOf = (sid: string): Record<string, unknown>[] => {
    const existing = trees.get(sid)
    if (existing !== undefined) return existing
    const fresh: Record<string, unknown>[] = []
    trees.set(sid, fresh)
    return fresh
  }
  /**
   * 合并视图的假件，语义照抄 plan-tree 的 `readMerged`：把每个被派发的节点
   * （`assignedTo`）对应的子会话那棵树**整体挂**在它的 children 下面，内部嵌套原样带过来。
   * 只读：没派过活、没留下树、或深度用尽时保持原样。
   * @param nodes - 顶层节点。
   * @param depth - 还能往下拼几层。
   * @returns 合并后的节点列表。
   */
  const mergedOf = (nodes: readonly Record<string, unknown>[], depth: number): Record<string, unknown>[] =>
    nodes.map((node) => {
      const own = Array.isArray(node.children) ? mergedOf(node.children as Record<string, unknown>[], depth) : []
      const child = typeof node.assignedTo === 'string' ? node.assignedTo : undefined
      const sub = depth <= 0 || child === undefined ? undefined : trees.get(child)
      if (sub === undefined) return own.length === 0 ? node : { ...node, children: own }
      return { ...node, children: [...own, ...mergedOf(sub, depth - 1)] }
    })
  const treeCalls: string[] = []
  const sections: { name: string; order: number; text: unknown }[] = []
  const listeners: { event: string; handler: (...args: never[]) => unknown }[] = []
  // 「自动放行不通知中枢」的计数点：假 ctx 上任何一条会惊动中转的通路都在这里记一笔。
  const notified: string[] = []
  // 每次 startContinuable 的入参：自动派发的简报要从这里看。
  const starts: unknown[] = []
  // 每次 sendMessage 的入参：`resume` 必须走**这条路**（唤醒原来那个孩子），绝不能走创建通道。
  const sent: { agent: unknown; target: unknown; content: unknown; options: unknown }[] = []
  // 每次派发一个新的子会话 id：自动放行按 childId 对号入座，
  // 恒定 id 会让「B 是被新派出去的」根本看不出来。第一次仍是 child-1（老断言不动）。
  let dispatches = 0
  let captured: Captured | undefined
  // 账本**是真的文件 I/O**：被考的是 `createTaskRuns` 连着读-改-写与原子替换那一整套，
  // 唯一被换成假的只有它够的那一侧（没有任何一侧是假的 —— 文件是真的，路径是我们给的）。
  // `options.runsFile` 换一个共享路径，就是「宿主重启之后账本仍在」的最小模型。
  const runsFile = options.runsFile ?? freshLedgerFile()
  const ctx = {
    tools: { register: (definition: Captured) => { captured = definition; return () => {} } },
    get: (key: string) => {
      calls.push(`get:${key}`)
      if (key === 'taskTree' && options.tree === true) {
        // 有状态的假树。`ask` 现在是 read→write→step 三步走，一个只会返回 [] 的
        // 空桩会让「决策真的记进去了吗」根本无法断言。
        return {
          read: (sid: string) => nodesOf(sid),
          readMerged: (sid: string, maxDepth = 1) => mergedOf(nodesOf(sid), maxDepth),
          write: async (sid: string, nodes: readonly Record<string, unknown>[], replace: boolean) => {
            treeCalls.push(`write:${sid}:${replace}`)
            const list = nodesOf(sid)
            if (replace) list.length = 0
            for (const node of nodes) list.push({ ...node })
          },
          step: async (sid: string, id: string, patch: Record<string, unknown>) => {
            treeCalls.push(`step:${id}`)
            const target = nodesOf(sid).find(node => node.id === id)
            if (target !== undefined) Object.assign(target, patch)
          },
          // 语义照 plan-tree 的 bind：只把 childId 写到节点的 assignedTo 上，不碰 status。
          // 结算监听器就是靠这个对号入座找到节点的；假件不写，自动放行那条链根本走不通。
          bind: async (sid: string, id: string, childId: string) => {
            const target = nodesOf(sid).find(node => node.id === id)
            if (target !== undefined) target.assignedTo = childId
          },
        }
      }
      // `userQuestions` 必须从 `get` 里给：插件取它用的是 `ctx.get('userQuestions')`。
      // 它此前只作为 ctx 的属性存在，于是**成功的 ask 路径从来没有被覆盖过** ——
      // 每次跑到 ask 都在第一道服务检查上就抛了。
      if (key === 'userQuestions') {
        return { ask: async () => ({ answers: options.answers ?? [{ id: 'task-ask', selected: ['yes'] }] }) }
      }
      // `sessions` 是诊断行那一格判活要用的：目录行**不带** activity 时（`mode:'unknown'` 的
      // 僵尸、或这个孩子自己的目录读不动），`childPresence` 自己问一次会话存储
      // （`SessionStore.get`：活着才有）。默认假件是「目录里的孩子都还活着」；要演
      // `mode:'unknown'` 的僵尸（目录里有、存储里已经没有）显式给 `sessionStore: []`，
      // 要演连这个服务都没有的组合给 `sessionStoreService: false`。
      if (key === 'sessions') {
        if (options.sessionStoreService === false) return undefined
        const live = new Set(options.sessionStore ?? children.map(entry => typeof entry === 'string' ? entry : entry.id))
        return { get: (id: string) => live.has(id) ? { id } : undefined }
      }
      return undefined
    },
    // 自动放行要 `ctx.agents.get(sid)` 拿当刻活着的父 Agent；宿主自己也是这么拿的
    // （dsh-subagent/lib/index.js:1257）。不给就跳过并记日志 —— 那条路也测了。
    //
    // `roots()` 是**提问根**那条路要的：直连派发后靠它认出「孩子的提问该落到哪张卡上」
    // （`rootAgentOf`）。不认根就不装遮蔽版提问工具 —— 宿主里不给它确实是这种后果，
    // 所以这里给的是与宿主同形的答案：被派发的这一支就是根。
    agents: { get: () => options.parentAgent, roots: () => (options.parentAgent === undefined ? [] : [options.parentAgent]) },
    // 「不通知中枢」的另一个计数点：插件若改走 `ctx.inject` 那条路会被记下来。
    inject: () => { notified.push('inject'); return undefined },
    subagents: {
      resolveMaxDepth: () => undefined,
      startContinuable: async (spec: unknown) => {
        // 派发**之前**的那条缝：测试在这里制造「孩子起来了、账本却写不进去」的窗口。
        options.beforeStart?.()
        starts.push(spec)
        return { childId: 'child-' + String(++dispatches) }
      },
      sendMessage: async (agent: unknown, target: unknown, content: unknown, options_: unknown) => {
        sent.push({ agent, target, content, options: options_ })
        return 'inbox-1'
      },
      interrupt: () => {},
      // 目录面按 `parentId` 记一笔：`isKnownChild` 是**按调用方会话**查的，
      // 测试要能证明确实查了这条会话，而不是随便查了一个空表。
      listChildren: async (parentId: string, _signal?: AbortSignal) => {
        listed.push(`children:${parentId}`)
        // 行既可以直接给字符串（老断言用的最小形状），也可以给完整行
        // （`id` + `createdAt` + `mode`）——上限、排序、剪字段全靠完整行才测得出来。
        return children.map(entry => typeof entry === 'string'
          ? { id: entry, createdAt: 0, mode: 'one-shot' as const }
          : entry)
      },
      // 行形状照运行时（`dsh-subagent/lib/types/list-children.js:146-152`）：目录行 + kind +
      // activity + hasChildren + parentId + depth。**默认 activity = running** —— 假件里的孩子
      // 都是「刚派出去、还在内存里」这一档；要演宿主重启之后留下的僵尸，显式给 `descendants` 行。
      listDescendants: async (parentId: string, _signal?: AbortSignal) => {
        listed.push(`descendants:${parentId}`)
        // 判活那一格拿不到时（诊断行）不许被当成死 —— 这里也能演。
        if (options.descendantsThrow === true) throw new Error('subagent listing requires the session store (load @deepseek-ai/dsh-session)')
        const rows: readonly { readonly id: string; readonly activity?: 'running' | 'inactive'; readonly kind?: 'child' | 'diagnostic'; readonly reason?: 'corrupt' | 'unsupported' | 'unavailable' }[] = options.descendants
          ?? children.map(entry => ({ id: typeof entry === 'string' ? entry : entry.id, activity: 'running' as const }))
        return rows.map(row => row.kind === 'diagnostic'
          ? { id: row.id, kind: 'diagnostic' as const, parentId, depth: 1, reason: row.reason ?? ('unavailable' as const) }
          : { id: row.id, kind: 'child' as const, activity: row.activity ?? 'running', mode: 'one-shot' as const, parentId, depth: 1, hasChildren: false })
      },
    },
    userQuestions: { ask: async () => ({ answers: [{ id: 'task-ask', selected: ['yes'] }] }) },
  on: (event: string, handler: (...args: never[]) => unknown) => {
    listeners.push({ event, handler })
    return () => {}
  },
  systemPrompt: {
    section: (registered: { name: string; order: number; text: unknown }) => {
      sections.push(registered)
      return () => {}
    },
    // 中枢身份那一段要与宿主全局注册同名同段，所以取 order 得走这个方法。
    getSectionOrder: () => 0,
  },
  }
  // worktree 账本**也在临时目录里**：它和 run 账本同一条纪律 —— 测试绝不碰真实 profile。
  // 不隔离的话，同一台机器上别的 harness（甚至真实的插件进程）会互相看见彼此的线。
  const worktreesFile = options.worktreesFile ?? join(mkdtempSync(join(tmpdir(), 'task-wt-spec-')), 'task-worktrees.json')
  const config: ResolvedConfig = {
    provider: 'default',
    defaultRules: options.defaultRules ?? '',
    presets: options.presets ?? {},
    runsFile,
    worktreesFile,
    worktreeGoal: options.worktreeGoal ?? '',
    worktreeVerify: options.worktreeVerify ?? '',
    worktreeMergeVerify: options.worktreeMergeVerify ?? '',
    worktreePrepare: options.worktreePrepare ?? '',
    // **默认关**：这些用例测的是别的功能，而「默认自动起隔离线」会把它们全部卷进
    // 「要有一个干净的 git 仓」这件与它们无关的前提里。要测隔离的用例显式打开它。
    // 默认值本身由「注册期的参数 DSL」那一带的配置断言钉住（zod 的 default 是 true）。
    worktreeAuto: options.worktreeAuto ?? false,
  }
  apply(ctx as never, config)
  assert.ok(captured !== undefined, 'apply must register exactly one tool')
  return { tool: captured, calls, listed, messages, treeNodes, nodesOf, treeCalls, sections, listeners, notified, starts, sent, runsFile, worktreesFile }
}

/**
 * 一个带 session、取消信号与（可选的）待认领列表的假调用者。
 * @param messages - 可变的会话历史；直接改这个数组等于运行时投了一条消息进来。
 * @param signal - 取消信号，省略即测试自带的 200ms 兜底。
 * @param inbox - 待认领列表（`nextStep` / `nextTurn`）。结算通知在这一段里**已经在父代理手上了**，
 *   只是 `deriveMessages()` 还看不见它 —— `steer`/`inject` 进 next-step、`followup` 进 next-turn
 *   （`dsh-agent-loop/lib/index.js:806-814`），下一次步界才认领进历史。
 * @returns 假调用者。
 */
function makeCaller(
  messages: FakeMessage[] = [],
  signal: AbortSignal = AbortSignal.timeout(200),
  inbox?: { readonly nextStep?: readonly FakeMessage[]; readonly nextTurn?: readonly FakeMessage[] },
): unknown {
  return {
    agent: {
      session: { id: SESSION, deriveMessages: () => messages },
      ...inbox === undefined ? {} : { inbox },
    },
    signal,
  }
}

/** 一个带 session 的假调用者。 */
const caller = makeCaller()

it('注册期的参数 DSL 能编译，且编出来的动作全集就是那十个——dispatch 已收口掉', () => {
  const { tool } = harness()
  assert.strictEqual(tool.name, 'task')
  // `defineTool` 在注册时把参数 DSL 编成 JSON Schema 写进定义（实测：`defineTool` 返回的
  // `parameters` 顶层是 `{type:'object',properties:{...},required:['action']}`）。
  const properties = tool.parameters.properties as { action?: { enum?: readonly string[] } }
  assert.deepStrictEqual(
    properties.action?.enum,
    ['plan', 'step', 'ask', 'commit', 'run', 'send', 'interrupt', 'list', 'result', 'worktree'],
  )
})

it('嵌套对象漏写 additionalProperties 会被 DSL 拒——注册期的坑钉在这里', () => {
  // 裸转：这个写法在类型上就过不了（`ObjectValueSchemaSpec.additionalProperties` 是必填），
  // 这里要测的正是「声明层拦不住时，注册期还拦不拦」。
  const missingAdditionalProperties = {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string', required: true } },
      },
    },
  } as unknown as ParameterSchemaSpec
  const failure = validationFailure(missingAdditionalProperties)
  assert.ok(failure instanceof Error, 'nested object without additionalProperties must be rejected')
  assert.match(failure.message, /additionalProperties/)
  // 补上这一行就编得过。
  assert.strictEqual(validationFailure({
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', required: true } },
      },
    },
  }), undefined)
})

it('缺必填参数一律抛错，不许静默继续', async () => {
  const { tool } = harness({ tree: true })
  const cases: readonly [Record<string, unknown>, RegExp][] = [
    [{ action: 'plan' }, /non-empty `nodes`/],
    [{ action: 'plan', nodes: [] }, /non-empty `nodes`/],
    [{ action: 'step' }, /requires `node`/],
    [{ action: 'result' }, /requires `task_id`/],
    [{ action: 'send', task_id: 'c' }, /requires `prompt`/],
    [{ action: 'send', prompt: 'x' }, /requires `task_id`/],
    [{ action: 'interrupt' }, /requires `task_id`/],
    [{ action: 'ask' }, /requires `question`/],
  ]
  for (const [args, pattern] of cases) {
    await assert.rejects(() => run(tool, args, caller), pattern, JSON.stringify(args))
  }
})

it('未知动作在参数层就被拒，报错把合法动作全集列出来', async () => {
  const { tool } = harness()
  // 模型传不合法 action 时，`defineTool` 的 DSL 校验先抛 ToolArgsError（实测：2026-02-14），
  // 报错里带合法集合；`execute` 的 `default` 分支对模型不可达。
  await assert.rejects(
    () => run(tool, { action: 'nope' }, caller),
    /invalid arguments: "action" must be one of \["plan","step","ask","commit","run","send","interrupt","list","result","worktree"\]/,
  )
  // `dispatch` 现在是**未知动作**：它连参数层都过不去，报错里也不该再出现它。
  await assert.rejects(
    () => run(tool, { action: 'dispatch', prompt: 'go' }, caller),
    /invalid arguments: "action" must be one of \["plan","step","ask","commit","run","send","interrupt","list","result","worktree"\]/,
  )
})

it('taskTree 服务缺席时，树类动作必须报错而不是静默成功', async () => {
  const { tool } = harness({ tree: false })
  await assert.rejects(
    () => run(tool, { action: 'plan', nodes: [{ id: 'a', title: 'A' }] }, caller),
    /taskTree` service is unavailable/,
  )
  await assert.rejects(() => run(tool, { action: 'list' }, caller), /taskTree` service is unavailable/)
})

it('run 没有调用者 Agent 时抛错——它没有可用的授权身份', async () => {
  // 派发那条路要的是**当刻活着的 Agent 本身**（`startContinuable` 的 parent、
  // 提问根、send 的 sender 都只认它）。所以派发路径入口处就把它取出来，缺席即抛。
  // dispatch 撤掉之后这条路只剩一个入口，但这道闸门照旧必须在。
  const { tool } = harness({ tree: true })
  await assert.rejects(
    () => run(tool, { action: 'run', run: 'r1', nodes: [{ id: 'n1', prompt: 'go' }] }, {}),
    /calling agent/,
  )
})

it('run 把节点 preset 的 persona 与 toolFilter 平铺进 request，并包成 startContinuable 的形状；派不出去的节点不产出 node 键', async () => {
  // 这一条原先走 `dispatch`（不 bind ⇒ 简报不带节点段）。迁移后的判断：
  // 被考的四个槽（persona / toolFilter / maxDepth / parent）与**无关入口**，只与
  // 「派发那一刻交给 `startContinuable` 的那个 request」有关，所以整条搬去 run 的路径上，
  // 又因为 run **只**从节点派发（没有 bind 这个概念），"不 bind 就不追加节点段" 这半条
  // 没有落点了 —— 它改由 "派不出去的节点不产出 node 键" 这半条接住：返回值里
  // 只该有 run / dispatched，`node` 与 `task_id` 这两个键在 `run` 上根本不存在。
  const seen: unknown[] = []
  let captured: Captured | undefined
  const ctx = {
    tools: { register: (d: Captured) => { captured = d; return () => {} } },
    // run 必须先写树（bind 要求节点已存在），所以这条路一定要有树服务；
    // 这里用一个不记事的空桩，断言全在 startContinuable 的那个 request 上。
    get: (key: string) => key === 'taskTree'
      ? { read: () => [], write: async () => {}, step: async () => {}, bind: async () => {} }
      : undefined,
    subagents: {
      resolveMaxDepth: () => 3,
      startContinuable: async (spec: unknown) => { seen.push(spec); return { childId: 'child-9' } },
    },
    userQuestions: { ask: async () => ({ answers: [] }) },
  systemPrompt: { section: () => () => {} },
  on: () => () => {},
  }
  apply(ctx as never, { provider: 'default', presets: { reader: { persona: 'P', allow: ['read'] } } })
  const result = await run(captured as Captured, {
    action: 'run',
    run: 'r1',
    nodes: [{ id: 'n1', prompt: 'go', preset: 'reader', label: 'L' }],
  }, caller)
  // run 的返回值形状：只有 run 与 dispatched，**没有** node / task_id 这两个键。
  assert.strictEqual('node' in result, false, 'run has no node key — the binding is registered by the plugin itself')
  assert.strictEqual('task_id' in result, false, 'run has no task_id key either')
  assert.deepStrictEqual(result, { status: 'running', run: 'r1', dispatched: ['n1'] })
  const spec = seen[0] as { provider: string; request: Record<string, unknown> }
  assert.strictEqual(spec.provider, 'default')
  assert.strictEqual(spec.request.persona, 'P')
  assert.deepStrictEqual(spec.request.toolFilter, { allow: ['read'] })
  assert.strictEqual(spec.request.maxDepth, 3)
  assert.strictEqual((spec.request.parent as { session?: { id?: string } })?.session?.id, 'sess-1')
})

/**
 * per-角色的 `agentOptions`：角色固定自己的思考强度或模型路由。
 *
 * 这一组钉的是**直连通道**。名册通道塞不进这个槽（见下一条），
 * 所以「声明了它」这件事必须真的走到直连、并且在返回值里说清楚。
 */
it('run 把节点 preset 的 agentOptions 放进 request——角色自己钉住档位', async () => {
  const seen: unknown[] = []
  let captured: Captured | undefined
  const ctx = {
    tools: { register: (d: Captured) => { captured = d; return () => {} } },
    get: (key: string) => key === 'taskTree'
      ? { read: () => [], write: async () => {}, step: async () => {}, bind: async () => {} }
      : undefined,
    subagents: {
      resolveMaxDepth: () => 3,
      startContinuable: async (spec: unknown) => { seen.push(spec); return { childId: 'child-9' } },
    },
    userQuestions: { ask: async () => ({ answers: [] }) },
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
  }
  apply(ctx as never, {
    provider: 'default',
    presets: { recon: { persona: 'R', agentOptions: { reasoningEffort: 'low', maxTokens: 4096 } } },
  })
  // 迁移的判断：agentOptions 的落点就是派发请求本身（只有直连一条通道，`startContinuable`
  // 那个 request）。入口从 dispatch 换成 run 之后，同一个槽由节点上的 preset 携带。
  await run(captured as Captured, { action: 'run', run: 'r1', nodes: [{ id: 'n1', prompt: 'go', preset: 'recon' }] }, caller)
  const spec = seen[0] as { request: Record<string, unknown> }
  // 四个字段原样透传；宿主侧是逐字段覆盖父的那一份，只给 effort 时路由继承父。
  assert.deepStrictEqual(spec.request.agentOptions, { reasoningEffort: 'low', maxTokens: 4096 })
  assert.strictEqual(spec.request.persona, 'R', 'agentOptions 不许挤掉身份本身')
})

it('run 的节点 preset 没声明 agentOptions 时 request 里没有这个键——省略就是继承父的路由', async () => {
  const seen: unknown[] = []
  let captured: Captured | undefined
  const ctx = {
    tools: { register: (d: Captured) => { captured = d; return () => {} } },
    get: (key: string) => key === 'taskTree'
      ? { read: () => [], write: async () => {}, step: async () => {}, bind: async () => {} }
      : undefined,
    subagents: {
      resolveMaxDepth: () => 3,
      startContinuable: async (spec: unknown) => { seen.push(spec); return { childId: 'child-9' } },
    },
    userQuestions: { ask: async () => ({ answers: [] }) },
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
  }
  apply(ctx as never, { provider: 'default', presets: { recon: { persona: 'R' } } })
  await run(captured as Captured, { action: 'run', run: 'r1', nodes: [{ id: 'n1', prompt: 'go', preset: 'recon' }] }, caller)
  const spec = seen[0] as { request: Record<string, unknown> }
  // 全等之外还要单独钉 hasOwn：物化出来的 `{}` 会让「省略」与「显式给空」长得一样。
  assert.strictEqual(Object.hasOwn(spec.request, 'agentOptions'), false,
    '省略 agentOptions 必须让这个键缺席，派发请求与改动前逐字段一致')
})

it('归一：run 声明 nodes 时先写树再派活，一次调用完成建节点+派活+绑定', async () => {
  // 这条原先钉的是 2026-09-30 的改动（dispatch 自己也能写节点）。dispatch 撤掉之后，
  // 「建节点 + 派活 + 绑定」成了 run 的**唯一**形态，所以这条迁移是收紧而不是放宽：
  // 顺序仍是硬约束——bind 要求节点已存在，所以 write 必须早于 startContinuable；
  // 下面的 order 数组就是那个顺序的一手证据。
  const order: string[] = []
  let captured: Captured | undefined
  const ctx = {
    tools: { register: (d: Captured) => { captured = d; return () => {} } },
    get: (key: string) => {
      if (key !== 'taskTree') return undefined
      return {
        read: () => [],
        write: async (_s: string, nodes: readonly unknown[], replace: boolean) => {
          order.push(`write:${nodes.length}:${String(replace)}`)
        },
        step: async (_s: string, nodeId: string, patch: { status?: string }) => {
          order.push(`step:${nodeId}:${String(patch.status)}`)
        },
        bind: async (_s: string, nodeId: string, childId: string) => {
          order.push(`bind:${nodeId}:${childId}`)
        },
      }
    },
    subagents: {
      resolveMaxDepth: () => undefined,
      startContinuable: async () => { order.push('start'); return { childId: 'child-7' } },
    },
    userQuestions: { ask: async () => ({ answers: [] }) },
  systemPrompt: { section: () => () => {} },
  on: () => () => {},
  }
  apply(ctx as never, { provider: 'default', presets: { reader: { persona: 'P' } } })
  const result = await run(captured as Captured, {
    action: 'run',
    run: 'r1',
    nodes: [{ id: 'n1', title: 'do the thing', prompt: 'go', preset: 'reader' }],
  }, caller)
  // 一次调用同时落了树、起了孩子、绑上了节点。
  assert.deepStrictEqual(
    order,
    ['write:1:false', 'start', 'bind:n1:child-7', 'step:n1:in_progress'],
    'write must precede bind, and bind must be followed by the in_progress promotion',
  )
  // run 的返回值不报节点：绑给自己派出去的孩子这件事由插件登记，中枢只看 dispatched。
  assert.deepStrictEqual(result, { status: 'running', run: 'r1', dispatched: ['n1'] })
})

it('派发把节点推成 in_progress——参数描述承诺的迁移必须真发生', async () => {
  // 这条钉的是一个既有 bug：声明写「it moves to in_progress」，而 plan-tree 的 bind
  // 只写 assignedTo、从不碰 status，于是派完节点仍是 pending，还得多调一次 step。
  // 现在 `settleDispatch` 在 bind 之后补一次 step —— 两条派发通道共用它。
  // 2026-09-30 起它还顺带钉「直连通道的简报也追加了节点指令」。
  //
  // 本用例测的是**既有节点上的那条收尾顺序**（bind → step），不是"谁写的节点"：
  // run 只从它自己声明的节点派发，所以这里的节点表声明在 run 上，观察点一字未动。
  const order: string[] = []
  let started: { request?: { prompt?: readonly { text?: string }[] } } | undefined
  let captured: Captured | undefined
  const ctx = {
    tools: { register: (d: Captured) => { captured = d; return () => {} } },
    get: (key: string) => {
      if (key !== 'taskTree') return undefined
      return {
        read: () => [],
        write: async () => { order.push('write') },
        step: async (_s: string, nodeId: string, patch: { status?: string }) => {
          order.push(`step:${nodeId}:${String(patch.status)}`)
        },
        bind: async (_s: string, nodeId: string, childId: string) => {
          order.push(`bind:${nodeId}:${childId}`)
        },
      }
    },
    subagents: {
      resolveMaxDepth: () => undefined,
      startContinuable: async (spec: unknown) => { order.push('start'); started = spec as typeof started; return { childId: 'child-5' } },
    },
    userQuestions: { ask: async () => ({ answers: [] }) },
  systemPrompt: { section: () => () => {} },
  on: () => () => {},
  }
  apply(ctx as never, { provider: 'default', presets: {} })
  await run(captured as Captured, { action: 'run', run: 'r1', nodes: [{ id: 'existing-1', prompt: 'go' }] }, caller)
  assert.deepStrictEqual(order, ['write', 'start', 'bind:existing-1:child-5', 'step:existing-1:in_progress'])
  // 直连通道（`ctx.subagents.startContinuable` 那条）同样追加了节点指令。
  const brief = started?.request?.prompt?.[0]?.text ?? ''
  assert.ok(brief.startsWith('go'), 'original brief must stay first')
  assert.ok(brief.includes('【节点状态】'), 'direct channel must carry the node brief')
  assert.ok(brief.includes('existing-1'), 'the brief must name the bound node')
})

it('run 不给 nodes 时当场抛，一个字节都不写树——「不建节点就派活」的直达通道已经不存在', async () => {
  // 迁移的判断：原用例钉的是「省略 nodes 时一个字都不写树」——dispatch 的 bind 是可选的，
  // 于是它真能一次都不碰树就把活派出去。那正是这次要消掉的东西：run 没有 nodes 连
  // 走都走不动。这条用例因此从"允许"翻成"拒绝"，而且拒绝必须**发生在写树之前**。
  const order: string[] = []
  let captured: Captured | undefined
  const ctx = {
    tools: { register: (d: Captured) => { captured = d; return () => {} } },
    get: (key: string) => {
      if (key !== 'taskTree') return undefined
      return {
        read: () => [],
        write: async () => { order.push('write') },
        step: async () => {},
        bind: async () => { order.push('bind') },
      }
    },
    subagents: {
      resolveMaxDepth: () => undefined,
      startContinuable: async () => { order.push('start'); return { childId: 'child-8' } },
    },
    userQuestions: { ask: async () => ({ answers: [] }) },
  systemPrompt: { section: () => () => {} },
  on: () => () => {},
  }
  apply(ctx as never, { provider: 'default', presets: {} })
  await assert.rejects(
    () => run(captured as Captured, { action: 'run', run: 'r1' }, caller),
    /requires a non-empty `nodes` list/,
  )
  await assert.rejects(
    () => run(captured as Captured, { action: 'run', run: 'r1', nodes: [] }, caller),
    /requires a non-empty `nodes` list/,
  )
  assert.deepStrictEqual(order, [], '声明期就拒掉：树、账本、子代理一个都不许动')
})

it('run 写树时`replace` 恒为 false——整树替换不是这条路要的东西', async () => {
  // 迁移的判断：这条原先钉的是「dispatch 把 replace 透传下去」。run **没有** replace 参数，
  // 而且它写树必须早于派活、节点又必须已经存在，整树替换会把同一份节点表里的兄弟节点
  // 连同别的流水线一起抹掉。所以这条从"透传"翻成"钉死它只能是 false"。
  const seen: string[] = []
  let captured: Captured | undefined
  const ctx = {
    tools: { register: (d: Captured) => { captured = d; return () => {} } },
    get: (key: string) => {
      if (key !== 'taskTree') return undefined
      return {
        read: () => [],
        write: async (_s: string, _n: readonly unknown[], replace: boolean) => { seen.push(String(replace)) },
        step: async () => {},
        bind: async () => {},
      }
    },
    subagents: {
      resolveMaxDepth: () => undefined,
      startContinuable: async () => ({ childId: 'child-9' }),
    },
    userQuestions: { ask: async () => ({ answers: [] }) },
  systemPrompt: { section: () => () => {} },
  on: () => () => {},
  }
  apply(ctx as never, { provider: 'default', presets: {} })
  await run(captured as Captured, {
    action: 'run', run: 'r1',
    nodes: [{ id: 'only', title: 'only node', prompt: 'go' }],
  }, caller)
  assert.deepStrictEqual(seen, ['false'], 'run 只追加节点，绝不整树替换')
})

it('run 的节点点名查不到的预设名时抛错，绝不静默继承父的身份', async () => {
  // 迁移的判断：这条与入口无关，考的是 `resolvePreset` 的 fail-closed —— 节点自己
  // 带着身份名，所以从 dispatch 的顶层 preset 搬到 run 的**节点 preset** 上，判据一字不变。
  // 报错走 `UnknownPresetError`（type 是构造函数名，message 里带 preset 名与已知清单）。
  const h = harness({ tree: true })
  const result = await run(h.tool, { action: 'run', run: 'r1', nodes: [{ id: 'n1', prompt: 'go', preset: 'ghost' }] }, caller)
  // run **不抛**：一个节点派不出去只停它自己那一支（与 `dispatchRunNode` 的 catch 一致），
  // 所以这条断言搬到了"结果的三个可观测面上"，判据一字没松：
  //   ① 这个起点没被算作已派出；
  //   ② 树上留下一条失败原因（面板上看得到）；
  //   ③ 账本里它仍是 pending —— 不能因为"报了个错"就当成派出去了。
  assert.deepStrictEqual(result, { status: 'running', run: 'r1', dispatched: [] })
  const node = h.treeNodes.find(item => item.id === 'n1')
  assert.equal(node?.assignedTo, undefined, '派不出去的节点不许被绑上孩子')
  assert.match(String(node?.detail), /UnknownPresetError/, '失败原因必须留在树上：' + String(node?.detail))
  assert.equal(String(node?.detail).includes('ghost'), true, '原因里必须点出那个查不到的身份名：' + String(node?.detail))
  const recorded = ledgerNode(h.runsFile, 'n1') as { status?: string; note?: string } | undefined
  assert.strictEqual(recorded?.status, 'pending', '派不出去就留在 pending：不许当成"派过了"')
  assert.match(String(recorded?.note), /UnknownPresetError/, '账本 note 也要留痕')
})
/**
 * 结果是不是能走无损 JSON 往返：`JSON.parse(JSON.stringify(x))` 必须与原值逐字段相等。
 *
 * 这条判据存在的理由是一次真机事故：工具返回值要过运行时的无损序列化器，而它拒收任何
 * `undefined` 字段，于是 `dispatch` 不传 `bind` 时返回的 `node: undefined` 让整个
 * 头号动作炸成 `tool "task" returned invalid output: value is not lossless JSON`
 * ——**纯函数单测当时全绿**，因为原来那条断言正是把 `node: undefined` 钉成了期望值。
 * 所以这里断言的是「过一遍序列化」，不是「某个字段等于 undefined」。
 * @param value - 工具返回值。
 * @returns 无损往返后与原值相等时为 true。
 */
function isLossless(value: unknown): boolean {
  const parsed: unknown = JSON.parse(JSON.stringify(value))
  try {
    assert.deepStrictEqual(parsed, value)
    return true
  } catch {
    return false
  }
}

/**
 * 值里是不是嵌着 `undefined`——序列化器拒收的正是这个，`deepStrictEqual` 反而不在乎。
 * @param value - 任意返回值。
 * @returns 出现 `undefined`（对象属性或数组元素）时为 true。
 */
function hasUndefined(value: unknown): boolean {
  if (value === undefined) return true
  if (Array.isArray(value)) return value.some(hasUndefined)
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(hasUndefined)
  }
  return false
}

/**
 * `result` 每一种答复各自带的**判定依据**，逐字钉在这里 —— 契约一改，这几行先红。
 *
 * 它是**工具契约的一部分**（不是日志）：调用方只看得见返回值，凭什么下这个 status 必须写在里面，
 * 否则 «running»（还在跑）与 «inactive»（已经不在了）在模型眼里就是两个没有理由的字。
 *
 * **每一种依据各占一行**：目录行读到 activity 的、行里没有这一格而改问会话存储的、根本
 * 一处读数都没有的 —— 三者不许共用一句文案（`(subagent catalog activity=running)` 这种
 * 句子一旦被没读过 activity 的分支复用，工具就开始替一次**没发生的读数**作证）。
 */
const EVIDENCE = {
  /** 通知已经认领进会话历史。 */
  noticeInHistory: 'settlement notice read from this session history',
  /** 通知已经投进父代理的收件箱、还没被这一轮认领。 */
  noticeInInbox: 'settlement notice is already delivered to this agent and not yet claimed into the visible history',
  /** 目录行自带 activity，读到孩子还在本代宿主的内存里。 */
  residentByActivity: 'no settlement notice yet and the child is resident in this host (subagent catalog activity=running)',
  /** 目录行不带 activity（诊断行），改问会话存储：这条 id 还有一条活着的会话。 */
  residentByStore: 'no settlement notice yet and the child is resident in this host (a live session for it is still present; this catalog row carries no activity of its own)',
  /** 目录行自带 activity，读到孩子已经不在本代宿主里了 —— 僵尸那一格。 */
  absentByActivity: 'no settlement notice and the child is not resident in this host (subagent catalog activity=inactive): it will do no further work and no result will arrive on its own',
  /** 诊断行 + 会话存储里已经没有它的活会话 —— `mode:'unknown'` 的僵尸走这一格。 */
  absentByStore: 'no settlement notice and the child is not resident in this host (no live session for it is left; this catalog row carries no activity of its own): it will do no further work and no result will arrive on its own',
  /** 目录查不动（fail-open：倒向「还可能在跑」，绝不说它死了）。 */
  catalogUnreadable: 'no settlement notice yet and the child catalog could not be read, so whether the child is still resident is unknown',
  /** 目录读到了，但一处活性读数都没有（会话存储服务缺席 / 行与目录都没给这一格）。 */
  noLivenessReading: 'no settlement notice yet and no liveness reading for the child could be obtained, so whether it is still resident is unknown',
  /** 这个 id 根本不是本会话的孩子。 */
  noCatalogRow: 'no subagent catalog row for this id under this session',
} as const

it('result 对根本不存在的孩子返回 unknown，而不是 running', async () => {
  const { tool, listed } = harness({ children: [] })
  const result = await run(tool, { action: 'result', task_id: 'no-such-child-0000' }, makeCaller())
  assert.deepStrictEqual(result, { task_id: 'no-such-child-0000', status: 'unknown', evidence: EVIDENCE.noCatalogRow })
  // 目录是**按调用方那条会话**查的：查错会话就等于没查。
  assert.strictEqual(listed[0], 'children:sess-1')
})

it('result 对已知但还没结算的孩子仍返回 running', async () => {
  const { tool, listed } = harness({ children: ['child-1'] })
  const result = await run(tool, { action: 'result', task_id: 'child-1' }, makeCaller())
  assert.deepStrictEqual(result, { task_id: 'child-1', status: 'running', evidence: EVIDENCE.residentByActivity })
  assert.strictEqual(listed.includes('children:sess-1'), true, 'the catalog must actually be read')
})

it('result 只回读，绝不等：结算已经落进会话就报 completed，没落就当场报 running', async () => {
  const { tool } = harness({ children: ['child-1'] })
  // 信号**永不中止**：这样如果实现里还藏着任何等待，这条测试会挂住，不会假通过。
  const never = new AbortController()
  const history: FakeMessage[] = []
  const started = await run(tool, { action: 'result', task_id: 'child-1' }, makeCaller(history, never.signal))
  assert.deepStrictEqual(started, { task_id: 'child-1', status: 'running', evidence: EVIDENCE.residentByActivity })
  // 把运行时本该投进来的那条通知放进历史，再问一次——这一次必须报 completed。
  history.push(fakeSettle('child-1', 'settled: done'))
  const settled = await run(tool, { action: 'result', task_id: 'child-1' }, makeCaller(history, never.signal))
  assert.deepStrictEqual(settled, { task_id: 'child-1', status: 'completed', result: 'settled: done', evidence: EVIDENCE.noticeInHistory })
})

it('返回值里没有 `undefined` 字段，且无损往返不丢字段——真机炸点钉在这里（run 与 result 两条路都过）', async () => {
  // `children` 给一个已知孩子、但会话历史里没有它的结算通知 ⇒ result 报 running。
  const { tool } = harness({ children: ['child-1'], tree: true })
  // 这条钉的是真机上炸掉的那个形状：工具返回值要过运行时的无损序列化器，它拒收任何
  // `undefined` 字段。旧事故的出点（`node: undefined`）已经从工具面上消失，但**判据本身**
  // 与入口无关，所以迁移的判断是：把这条从"那个具体调用形状"提升成"对工具面上每条
  // 会返回对象的路径都成立" —— 这里跑两条分支形状完全不同的：run（返回值带 dispatched
  // 数组）与 result（返回值带 task_id）。
  const launched = await run(tool, { action: 'run', run: 'r1', nodes: [{ id: 'n1', prompt: 'go' }] }, makeCaller())
  assert.deepStrictEqual(launched, { status: 'running', run: 'r1', dispatched: ['n1'] })
  const settled = await run(tool, { action: 'result', task_id: 'child-1' }, makeCaller())
  assert.deepStrictEqual(settled, { task_id: 'child-1', status: 'running', evidence: EVIDENCE.residentByActivity })
  // 下面两行是这条测试的要点：走序列化，而不是断言某个字段等于 undefined。
  for (const value of [launched, settled]) {
    assert.strictEqual(hasUndefined(value), false, 'a returned value must carry no undefined')
    assert.strictEqual(isLossless(value), true, 'the returned value must survive a lossless JSON round-trip')
  }
})

/**
 * **宿主重启之后死掉的孩子**：目录里还在（那是父会话日志里的持久事件，重启不丢），
 * 本代宿主的内存里已经没有它了。
 *
 * 这就是那个 bug 的现场：结算通知由 `notifySettlement` 在内存里现场造，而且**要求父 Agent
 * 当刻活着**（`dsh-subagent/lib/index.js:1254-1258`）—— 重启之后这条路再也不会跑，于是
 * 「通知永远不来」+「孩子在目录里永远都在」，老代码只能落到最后那一行 `running`，
 * 而那是个**永远不会兑现的承诺**。
 *
 * 判据不能只要「目录里有」：还得问它**还在不在这代宿主里**，而行自带的 `activity`
 * 就是这件事（`list-children.js:149`：`sessions.get(id) === undefined ? 'inactive' : 'running'`）。
 */
it('result 对「目录里在、本代宿主内存里没有了」的孩子回 inactive，绝不回 running', async () => {
  const { tool, listed } = harness({
    children: ['child-1'],
    descendants: [{ id: 'child-1', activity: 'inactive' }],
  })
  const result = await run(tool, { action: 'result', task_id: 'child-1' }, makeCaller())
  assert.notStrictEqual(result.status, 'running', '孩子不在了就一个字都不许说它还在跑：' + JSON.stringify(result))
  assert.deepStrictEqual(result, { task_id: 'child-1', status: 'inactive', evidence: EVIDENCE.absentByActivity })
  // 判活必须真的去问过目录（两个面都问了），而不是凭别的什么猜出来的。
  assert.deepStrictEqual(listed, ['children:sess-1', 'descendants:sess-1'])
  assert.strictEqual(hasUndefined(result), false)
  assert.strictEqual(isLossless(result), true)
})

it('result 对还在内存里的孩子仍回 running —— 与僵尸那一格只差 activity', async () => {
  const { tool } = harness({ children: ['child-1'], descendants: [{ id: 'child-1', activity: 'running' }] })
  const result = await run(tool, { action: 'result', task_id: 'child-1' }, makeCaller())
  assert.deepStrictEqual(result, { task_id: 'child-1', status: 'running', evidence: EVIDENCE.residentByActivity })
})

it('result 在诊断行上改问会话存储：还在就回 running，且不许谎报一个没读过的 activity', async () => {
  const { tool, calls } = harness({ children: ['child-1'], descendants: [{ id: 'child-1', kind: 'diagnostic' }] })
  const result = await run(tool, { action: 'result', task_id: 'child-1' }, makeCaller())
  assert.deepStrictEqual(result, { task_id: 'child-1', status: 'running', evidence: EVIDENCE.residentByStore })
  // 判据必须真去问过会话存储，而不是凭目录里有这个名字就断定它还活着。
  assert.ok(calls.includes('get:sessions'), 'the session store must actually be asked')
  // 诊断行**不带** activity：这一格的文案不许出现任何 activity 读数（那会是一句没观察到的陈述）。
  assert.ok(!EVIDENCE.residentByStore.includes('activity='), 'a diagnostic row must not claim an activity reading')
})

/**
 * **`mode:'unknown'` 的僵尸**：目录里记着这个孩子，但它那一行的 mode 运行时认不出，
 * 于是 `listDescendants` 只给一条诊断行（`list-children.js:142-143` 的 `reason:'unsupported'`）。
 * 那一格**不带 activity**，而「一行 activity 都没有 ⇒ 倒向 running」的老路子会让宿主重启
 * 之后留下的它永远回 running —— 同一个 bug 在这一格上的残留。
 *
 * 诊断行没有现成读数，但判活还有一条**同源**依据：这条 id 在本进程的会话存储里还有没有一条
 * 活着的会话（运行时算 activity 用的是同一个式子，`list-children.js:149`）。这一格现在
 * 跟着一起判死。
 */
it('result 对 mode:unknown 的僵尸孩子（诊断行 + 存储里已经没有它）回 inactive', async () => {
  const { tool } = harness({
    children: ['child-1'],
    descendants: [{ id: 'child-1', kind: 'diagnostic', reason: 'unsupported' }],
    sessionStore: [],
  })
  const result = await run(tool, { action: 'result', task_id: 'child-1' }, makeCaller())
  assert.notStrictEqual(result.status, 'running', '存储里已经没有它的活会话了，不许再说它还在跑：' + JSON.stringify(result))
  assert.deepStrictEqual(result, { task_id: 'child-1', status: 'inactive', evidence: EVIDENCE.absentByStore })
})

it('result 连会话存储都问不到时什么都不说：回 running，而不是说孩子死了', async () => {
  const { tool } = harness({
    children: ['child-1'],
    descendants: [{ id: 'child-1', kind: 'diagnostic' }],
    sessionStoreService: false,
  })
  const result = await run(tool, { action: 'result', task_id: 'child-1' }, makeCaller())
  assert.deepStrictEqual(result, { task_id: 'child-1', status: 'running', evidence: EVIDENCE.noLivenessReading })
})

it('result 对「目录里在、descendants 里却没有它的行」的孩子同样不许凭空说它还在跑', async () => {
  // 目标版本（`dsh-subagent@0.2.0-rc.2`）给不出这种形状（每个走过的目录项都落一行），
  // 但另一个修订会丢掉解析不出的候选行 —— 这一格同样是「一处读数都没有」，不许凭空断言。
  const { tool } = harness({ children: ['child-1'], descendants: [] })
  const result = await run(tool, { action: 'result', task_id: 'child-1' }, makeCaller())
  assert.deepStrictEqual(result, { task_id: 'child-1', status: 'running', evidence: EVIDENCE.noLivenessReading })
})

it('result 查不动目录时 fail-open 回 running —— 一次查询失败不许被说成孩子死了', async () => {
  const { tool } = harness({ children: ['child-1'], descendantsThrow: true })
  const result = await run(tool, { action: 'result', task_id: 'child-1' }, makeCaller())
  assert.deepStrictEqual(result, { task_id: 'child-1', status: 'running', evidence: EVIDENCE.catalogUnreadable })
})

/**
 * **刚结算、通知还没被认领**的那段窗口：孩子先离开 sessions（宿主在通知之前就 `dispose` 了它，
 * `dsh-subagent/lib/index.js:1239` → `:1248`），通知先落进父代理的收件箱、下一次步界才进历史。
 * 这一段里 `activity` 已经是 `inactive` —— 只按 liveness 判，就会把一个**正常结算**的孩子
 * 说成僵尸。所以「有通知」必须是**两个落点**：会话历史 + 当刻收件箱。
 */
it('结算通知已投进收件箱、还没认领进历史时按 completed，不许把刚结算的孩子说成不在了', async () => {
  const { tool } = harness({ children: ['child-1'], descendants: [{ id: 'child-1', activity: 'inactive' }] })
  const inbox = { nextStep: [fakeSettle('child-1', 'settled: via inbox')] }
  const result = await run(tool, { action: 'result', task_id: 'child-1' }, makeCaller([], AbortSignal.timeout(200), inbox))
  assert.deepStrictEqual(result, {
    task_id: 'child-1',
    status: 'completed',
    result: 'settled: via inbox',
    evidence: EVIDENCE.noticeInInbox,
  })
})

it('收件箱里是别的孩子的通知时不算数（对号入座，不许张冠李戴）', async () => {
  const { tool } = harness({ children: ['child-1'], descendants: [{ id: 'child-1', activity: 'inactive' }] })
  const inbox = { nextTurn: [fakeSettle('child-9', 'settled: 别人的')] }
  const result = await run(tool, { action: 'result', task_id: 'child-1' }, makeCaller([], AbortSignal.timeout(200), inbox))
  assert.deepStrictEqual(result, { task_id: 'child-1', status: 'inactive', evidence: EVIDENCE.absentByActivity })
})

/**
 * `list scope=children` 的上限：目录序是父事件序（最旧在前），所以「最新」在数组末尾。
 * 这一条同时钉死三件事：默认只给 10 个、给的是**最新**那 10 个、总数写在返回值里。
 */
it('list scope=children 默认只回最新 10 个，并在返回值里报出总数', async () => {
  const rows = Array.from({ length: 14 }, (_, i) => ({
    id: `child-${String(i)}`,
    createdAt: 100 + i,
    mode: 'one-shot' as const,
  }))
  const { tool } = harness({ children: rows })
  const result = await run(tool, { action: 'list', scope: 'children' }, caller)
  const payload = JSON.parse(result.result as string) as {
    total: number; shown: number; truncated: boolean; hint?: string; children: { id: string; mode: string; createdAt?: number }[]
  }
  assert.strictEqual(payload.total, 14, 'total 必须是目录里的全部孩子数')
  assert.strictEqual(payload.shown, 10)
  assert.strictEqual(payload.truncated, true)
  assert.deepStrictEqual(payload.children.map(c => c.id),
    Array.from({ length: 10 }, (_, i) => `child-${String(13 - i)}`),
    '要最新的：目录序最旧在前，必须倒过来取')
  assert.strictEqual(typeof payload.hint, 'string', '被截断时必须给中枢一句怎么拿更多')
  assert.strictEqual(hasUndefined(payload), false)
})

it('list scope=children 传 limit 时按它截，且 createdAt 被剪掉', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `child-${String(i)}`,
    createdAt: 100 + i,
    mode: 'continuable' as const,
    label: `第${String(i)}个`,
  }))
  const { tool } = harness({ children: rows })
  const result = await run(tool, { action: 'list', scope: 'children', limit: 2 }, caller)
  const payload = JSON.parse(result.result as string) as {
    total: number; shown: number; truncated: boolean; children: Record<string, unknown>[]
  }
  assert.strictEqual(payload.total, 5)
  assert.strictEqual(payload.shown, 2)
  assert.strictEqual(payload.truncated, true)
  assert.deepStrictEqual(payload.children, [
    { id: 'child-4', label: '第4个', mode: 'continuable' },
    { id: 'child-3', label: '第3个', mode: 'continuable' },
  ], 'id 必须完整（精确匹配），label/mode 留、createdAt 删')
})

it('list scope=children 没被截时不报 truncated，也不给 hint', async () => {
  const { tool } = harness({ children: ['child-1'] })
  const result = await run(tool, { action: 'list', scope: 'children' }, caller)
  const payload = JSON.parse(result.result as string) as { total: number; truncated: boolean; hint?: string }
  assert.strictEqual(payload.total, 1)
  assert.strictEqual(payload.truncated, false)
  assert.strictEqual(payload.hint, undefined)
})

it('list scope=descendants 的返回一字未改（仍是一段裸数组）', async () => {
  const { tool } = harness({ children: [] })
  const result = await run(tool, { action: 'list', scope: 'descendants' }, caller)
  assert.deepStrictEqual(JSON.parse(result.result as string), [])
})

/**
 * `ask` 的记账语义：问题进树、答案钉成决策。
 *
 * 这一条钉的是"决策不靠对话活着"。对话会被压缩掉，写在对话里的答案会随之消失；
 * 写在树里的 `detail` 不会。所以顺序也不许反——先写节点再发问，写失败就整个失败，
 * 而不是把用户已经答过的话丢在对话里。
 */
it('ask 先把问题写进树，再把答案钉成决策', async () => {
  const { tool, treeNodes, treeCalls } = harness({ tree: true })
  const result = await run(tool, { action: 'ask', question: '折叠要哪种？', options: ['A', 'B'] }, caller)
  assert.deepStrictEqual(result, { node: 'ask-1', status: 'completed', result: 'yes' })
  assert.deepStrictEqual(treeNodes, [{ id: 'ask-1', title: '折叠要哪种？', status: 'completed', detail: '答：yes' }],
    'detail 必须带 `答：` 前缀 —— 面板靠它画 `?`，裸答案既没图标也识别不出回答')
  // 必须是追加，不是整树替换 —— 决策节点写进别人的树里会把树毁掉。
  assert.deepStrictEqual(treeCalls, ['write:sess-1:false', 'step:ask-1'])
})

it('决策节点按 ask- 前缀累加编号，不会互相覆盖', async () => {
  const { tool, treeNodes } = harness({ tree: true })
  await run(tool, { action: 'ask', question: '第一问' }, caller)
  await run(tool, { action: 'ask', question: '第二问' }, caller)
  assert.deepStrictEqual(treeNodes.map(node => node.id), ['ask-1', 'ask-2'])
})

/**
 * 决策段落 —— "压缩时重放"的落点，但**两次压缩之间逐字节恒定**。
 *
 * `text` 仍然是**函数**（每次装配都被求值，见 dsh-system-prompt），但求值结果是一份
 * 按会话记住的**快照**：段文本每轮都变会让核心侧整段 replace 系统提示词节点 0，
 * 把整条前缀缓存从第 0 个 token 起打掉（dsh-src 的 runtime-context.ts:98）。
 * 快照只在压缩结束时作废。
 */
it('决策段是函数形态，但两次压缩之间取到的是同一份快照', async () => {
  const { sections, treeNodes, listeners } = harness({ tree: true })
  /** 把一次「压缩结束」派发给所有监听器 —— 快照的失效点。 */
  const invalidate = (): void => {
    for (const entry of listeners) {
      if (entry.event !== 'session/event') continue
      (entry.handler as unknown as (session: unknown, event: unknown) => void)({ id: SESSION }, { type: 'compaction/end', data: {} })
    }
  }
  const section = sections.find(entry => entry.name === 'task:decisions')
  assert.ok(section !== undefined, 'apply 必须注册决策段落')
  assert.strictEqual(typeof section.text, 'function', 'text 仍是函数：装配缝的契约没变')
  const render = section.text as (context: unknown) => string
  const context = { agent: { session: { id: SESSION } } }
  // 没有决策时是空串：空 section 会被 renderPrompt 丢掉，不白占提示词。
  assert.strictEqual(render(context), '')

  // 第一次装配之后新落的决策**不进**这一轮的系统段 —— 这正是快照的语义。
  treeNodes.push({ id: 'ask-1', title: '折叠要哪种？', detail: '答：默认折叠可展开' })
  assert.strictEqual(render(context), '', '快照已经算过（空串），就得一直是空串')

  // 压缩结束 → 快照作废 → 重新读树，这一次才看得见。
  invalidate()
  const text = render(context)
  assert.match(text, /折叠要哪种？/)
  assert.match(text, /默认折叠可展开/)
  // 前缀是给面板的，提示词里要干净的答案。
  assert.ok(!text.includes('答：'), '前缀不该漏进提示词')
  // 拿不到会话身份时返回空串，而不是抛出 —— 它在每次模型步的前头跑。
  assert.strictEqual(render({}), '')
})

/**
 * 快照的失效点必须是 `compaction/end`。
 *
 * 挂在别的压缩事件上（`start`/`summary`）会在压缩真正落地**之前**就把缓存丢掉，
 * 反而提前触发一次系统提示词改写；挂在太晚的地方则会让一份陈旧快照被永久钉死。
 */
it('快照只在 compaction/end 上作废：start / summary 都不动它', async () => {
  const { sections, treeNodes, listeners } = harness({ tree: true })
  const render = sections.find(entry => entry.name === 'task:decisions')?.text as (context: unknown) => string
  const context = { agent: { session: { id: SESSION } } }
  const fire = (type: string): void => {
    for (const entry of listeners) {
      if (entry.event !== 'session/event') continue
      (entry.handler as unknown as (session: unknown, event: unknown) => void)({ id: SESSION }, { type, data: {} })
    }
  }
  assert.strictEqual(render(context), '')
  treeNodes.push({ id: 'ask-1', title: '折叠要哪种？', detail: '答：A' })
  fire('compaction/start')
  assert.strictEqual(render(context), '', '压缩还没落地，快照不许被提前丢掉')
  fire('compaction/summary')
  assert.strictEqual(render(context), '', 'summary 之后替换面才落，仍然太早')
  fire('compaction/end')
  assert.match(render(context), /折叠要哪种？/, '压缩结束才重新读树')
})

/**
 * 快照跟着会话走，会话回收时一并丢掉，不许只增不减。
 */
it('会话被回收时快照一并丢掉，表不会无限增长', async () => {
  const { sections, treeNodes, listeners } = harness({ tree: true })
  const render = sections.find(entry => entry.name === 'task:decisions')?.text as (context: unknown) => string
  const context = { agent: { session: { id: SESSION } } }
  assert.strictEqual(render(context), '')
  treeNodes.push({ id: 'ask-1', title: '折叠要哪种？', detail: '答：A' })
  for (const entry of listeners) {
    if (entry.event !== 'session/disposed') continue
    (entry.handler as unknown as (session: unknown) => void)({ id: SESSION })
  }
  assert.match(render(context), /折叠要哪种？/, '丢了快照就得重新算，于是能看见新决策')
})

it('树缺席时 ask 直接报错，绝不问完再把答案丢在对话里', async () => {
  const { tool } = harness({ tree: false })
  await assert.rejects(() => run(tool, { action: 'ask', question: 'x' }, caller), /taskTree` service is unavailable/)
})

/**
 * 决策只存在一份 —— 这是去掉「搬运」之后**唯一**的守卫。
 *
 * 决策由提问者自己记在**自己的**树上；父会话既没有它的存储，也没有任何一次
 * 「搬进来」的写入。中枢还能看见它，靠的只能是决策段读**合并视图**。
 * 把 `renderDecisions` 改回读本会话那棵树，这一条立刻变红。
 */
it('决策段读合并视图：父会话树里一条 ask- 都没有，子代理树里的决策照样进段落', () => {
  const { sections, treeNodes, nodesOf } = harness({ tree: true })
  // 父会话只有派发节点；决策在子代理自己那棵树里。
  treeNodes.push({ id: 'F', title: '现场验证', status: 'in_progress', assignedTo: 'child-1' })
  nodesOf('child-1').push({ id: 'ask-1', title: '[侦察] 验证探针提问', status: 'completed', detail: '答：只留一份' })
  const section = sections.find(entry => entry.name === 'task:decisions')
  assert.ok(section !== undefined, 'apply 必须注册决策段落')
  const render = section.text as (context: unknown) => string
  const text = render({ agent: { session: { id: SESSION } } })
  assert.equal(treeNodes.filter(node => String(node.id).startsWith('ask-')).length, 0,
    '父会话自己的树里不许有 ask- 节点 —— 决策只存在提问者自己那一份')
  assert.match(text, /\[侦察\] 验证探针提问/, '被压缩过也看得见：合并视图必须把它拼上来')
  assert.match(text, /只留一份/, '答案必须进段落')
  assert.ok(!text.includes('答：'), '前缀不该漏进提示词')
})

it('合并深度 3 = 委派硬上限：中枢→子代理→孙代理，孙代理问过的话中枢照样看得见', () => {
  const { sections, treeNodes, nodesOf } = harness({ tree: true })
  treeNodes.push({ id: 'F', title: '现场验证', status: 'in_progress', assignedTo: 'child-1' })
  nodesOf('child-1').push({ id: 'M', title: '子代理的活', status: 'in_progress', assignedTo: 'child-2' })
  nodesOf('child-2').push({ id: 'ask-1', title: '[验证] 孙代理的问题', status: 'completed', detail: '答：B' })
  const render = sections.find(entry => entry.name === 'task:decisions')?.text as (context: unknown) => string
  const text = render({ agent: { session: { id: SESSION } } })
  assert.match(text, /孙代理的问题/, '第三层的话中枢也要看得见（深度 3 就是为它取的）')
  assert.match(text, /\*\*B\*\*/)
})

it('结算不再往父会话的树搬 ask- 节点：那条搬运监听器整个不存在了', () => {
  const { treeNodes, nodesOf, listeners } = harness({ tree: true })
  treeNodes.push({ id: 'F', title: '现场验证', status: 'in_progress', assignedTo: 'child-1' })
  nodesOf('child-1').push({ id: 'ask-1', title: '[侦察] 验证探针提问', status: 'completed', detail: '答：只留一份' })
  const before = JSON.stringify(treeNodes)
  for (const entry of listeners) {
    if (entry.event !== 'session/event') continue
    const handler = entry.handler as unknown as (session: unknown, event: unknown) => void
    handler({ id: SESSION }, { type: 'user/message', data: { source: { kind: 'subagent-settled', senderSessionId: 'child-1' } } })
  }
  assert.equal(JSON.stringify(treeNodes), before, '结算不许往父会话树里新增任何节点')
  assert.equal(treeNodes.filter(node => String(node.id).startsWith('ask-')).length, 0)
})

it('ask 动作是提问者自己问的：它写下的节点标题不带角色前缀', async () => {
  const { tool, treeNodes } = harness({ tree: true })
  await run(tool, { action: 'ask', question: '折叠要哪种？' }, caller)
  assert.equal(treeNodes[0]?.title, '折叠要哪种？', '本会话自己问的不加 [<label>] 前缀')
})

/**
 * `drop` 必须编进 persona，而不是记在某个"派发之后再写"的地方。
 *
 * 这一条钉的是**没有竞态**：子代理的第一次装配可能发生在 \`startContinuable\` 返回之后、
 * 父把 childId 记下来之前。只有随身份一起走的通道才躲得开那个窗口。
 */
it('run 把节点预设的 drop 编进 persona，随身份一起走', async () => {
  const seen: unknown[] = []
  let captured: Captured | undefined
  const ctx = {
    tools: { register: (d: Captured) => { captured = d; return () => {} } },
    get: (key: string) => key === 'taskTree'
      ? { read: () => [], write: async () => {}, step: async () => {}, bind: async () => {} }
      : undefined,
    subagents: { resolveMaxDepth: () => 3, startContinuable: async (spec: unknown) => { seen.push(spec); return { childId: 'child-9' } } },
    userQuestions: { ask: async () => ({ answers: [] }) },
    systemPrompt: { section: () => () => {} },
  on: () => () => {},
  }
  apply(ctx as never, { provider: 'default', presets: { scout: { persona: 'P', drop: ['plan:policy'] } } })
  await run(captured as Captured, { action: 'run', run: 'r1', nodes: [{ id: 'n1', prompt: 'go', preset: 'scout' }] }, makeCaller())
  const persona = (seen[0] as { request: { persona: string } }).request.persona
  assert.deepStrictEqual(decodeDropDirective(persona), { drop: ['plan:policy'], text: 'P' })
})

it('装配期真的丢掉点名的段，并剥掉指令本身', async () => {
  const { listeners } = harness({ tree: true })
  const entry = listeners.find(item => item.event === 'system-prompt/assemble')
  assert.ok(entry !== undefined, '必须挂上装配缝的监听器')
  const invoke = entry.handler as unknown as (
    incoming: unknown, context: unknown, next: () => Promise<unknown>,
  ) => Promise<{ sections: { name: string; text: string }[] }>
  const produced = {
    sections: [
      { name: 'harness:identity', text: 'I' },
      { name: 'deployment:persona-prefix', text: encodeDropDirective(['plan:policy'], 'P') },
      { name: 'plan:policy', text: 'POLICY' },
      { name: 'tools:ptc-only', text: 'T' },
    ],
  }
  const after = await invoke({}, {}, async () => produced)
  assert.deepStrictEqual(after.sections.map(section => section.name),
    ['harness:identity', 'deployment:persona-prefix', 'tools:ptc-only'])
  assert.strictEqual(after.sections[1]?.text, 'P', '指令本身必须被剥掉，不能留在提示词里')
  // 没指令时必须是**同一个引用**：这是绝大多数装配走的那条路。
  const plain = { sections: [{ name: 'deployment:persona-prefix', text: 'P' }] }
  assert.strictEqual(await invoke({}, {}, async () => plain), plain)
})

it('丢弃列表点到自己时也不丢 persona —— 丢身份不是这一项要做的事', async () => {
  const { listeners } = harness({ tree: true })
  const entry = listeners.find(item => item.event === 'system-prompt/assemble')
  const invoke = entry!.handler as unknown as (a: unknown, c: unknown, n: () => Promise<unknown>) => Promise<{ sections: { name: string; text: string }[] }>
  const produced = { sections: [{ name: 'deployment:persona-prefix', text: encodeDropDirective(['deployment:persona-prefix'], 'P') }] }
  const after = await invoke({}, {}, async () => produced)
  assert.deepStrictEqual(after.sections.map(section => section.name), ['deployment:persona-prefix'])
  assert.strictEqual(after.sections[0]?.text, 'P')
})



it('无 preset 的派发节点走 lead 身份，绝不继承父的 persona —— 这条钉的是实测到的那个缺陷', async () => {
  // 缺陷现场：子会话 3872e115 的 system-prompt 首段逐字是父的 persona
  // （# 总纲（用户至上） / ## 身份层（persona）/ ## 覆盖声明，还写着已废弃的 plan_write），
  // 根因就是「没给 preset ⇒ 不覆盖 persona ⇒ composeFrom 把父那一层继承下去」。
  const seen: unknown[] = []
  let captured: Captured | undefined
  const ctx = {
    tools: { register: (d: Captured) => { captured = d; return () => {} } },
    get: (key: string) => key === 'taskTree'
      ? { read: () => [], write: async () => {}, step: async () => {}, bind: async () => {} }
      : undefined,
    subagents: {
      resolveMaxDepth: () => undefined,
      startContinuable: async (spec: unknown) => { seen.push(spec); return { childId: 'child-x' } },
    },
    userQuestions: { ask: async () => ({ answers: [] }) },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
    on: () => () => {},
  }
  apply(ctx as never, { provider: 'default', defaultRules: 'RULES', runsFile: '', presets: { lead: { persona: '你是中枢。' }, recon: { persona: '你是侦察。' } } })
  // 节点的 preset 已迁移成预设名数组，未知名字现在在注册期就抛。
  await run(captured as Captured, { action: 'run', run: 'r1', nodes: [{ id: 'n1', prompt: 'go' }] }, caller)
  const spec = seen[0] as { request: Record<string, unknown> }
  assert.strictEqual(spec.request.persona, '你是中枢。')
})

it('节点显式给了身份名就按身份走，与默认那支互不干扰', async () => {
  const seen: unknown[] = []
  let captured: Captured | undefined
  const ctx = {
    tools: { register: (d: Captured) => { captured = d; return () => {} } },
    get: (key: string) => key === 'taskTree'
      ? { read: () => [], write: async () => {}, step: async () => {}, bind: async () => {} }
      : undefined,
    subagents: {
      resolveMaxDepth: () => undefined,
      startContinuable: async (spec: unknown) => { seen.push(spec); return { childId: 'child-y' } },
    },
    userQuestions: { ask: async () => ({ answers: [] }) },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
    on: () => () => {},
  }
  apply(ctx as never, { provider: 'default', presets: { lead: { persona: '你是中枢。' }, recon: { persona: '你是侦察。', deny: ['edit', 'write'] } } })
  await run(captured as Captured, { action: 'run', run: 'r1', nodes: [{ id: 'n1', prompt: 'go', preset: 'recon' }] }, caller)
  const spec = seen[0] as { request: Record<string, unknown> }
  // persona 前缀会挂一层丢弃指令：deny 掉的工具，其说明段不该留在这一支的提示词里。
  assert.deepStrictEqual(
    decodeDropDirective(String(spec.request.persona)),
    { drop: ['tool:edit', 'tool:write'], text: '你是侦察。' },
  )
  assert.deepStrictEqual(spec.request.toolFilter, { deny: ['edit', 'write'] })
})

it('全局规则段注册在根作用域，order 夹在 harness 身份(-1000) 与 persona(0) 之间', () => {
  const { sections } = harness({ defaultRules: 'RULES' })
  const rules = sections.find(s => s.name === 'task:global-rules')
  assert.ok(rules !== undefined, 'defaultRules 非空时必须注册这一段')
  assert.strictEqual(rules.text, 'RULES')
  // harness:identity 是 -1000、deployment:persona-prefix 是 0（dsh-system-prompt 的
  // SECTION_ORDERS 逐字如此），全局规则段必须夹在两者之间 —— 这三个数是宿主的事实，
  // 不是本测试的假上下文能给的，所以直接钉区间而不是钉某个数。
  // 操作者的原话是「首先我要有一个全局规则段。然后在后面接上身份段」——
  // 所以规则段必须排在 persona(0) **之前**，夹在 harness:identity(-1000) 与它之间。
  assert.ok(rules.order > -1000, '必须排在 harness 身份之后')
  assert.ok(rules.order < 0, '必须排在 persona 之前 —— 规则在前、身份在后')
})

it('defaultRules 为空串时不注册那一段 —— 行为与加这一项之前一字不差', () => {
  const { sections } = harness({ defaultRules: '', presets: { lead: { persona: 'p' } } })
  assert.strictEqual(sections.some(s => s.name === 'task:global-rules'), false)
})

it('中枢身份段**不由本插件注册**：同名同段在根作用域会撞上宿主的全局注册，那是装载期抛错', () => {
  // 实测过：注册它会 throw「prompt section "deployment:persona-prefix" is already
  // registered」，插件整个装载失败，task 工具与 task:decisions 段一起从装配里消失。
  const { sections } = harness({ defaultRules: 'RULES', presets: { lead: { persona: '你是中枢。' } } })
  assert.strictEqual(sections.some(s => s.name === 'deployment:persona-prefix'), false)
})

it('身份表里没有 lead 时什么都不做 —— 宿主 profile 那行继续生效', () => {
it('deny 派生成 tool:<名>：段名规律就是前缀加工具名，不含 deny 时为空', () => {
  assert.deepStrictEqual(toolSectionsForFilter({ deny: ['edit', 'write', 'pwsh'] }), ['tool:edit', 'tool:write', 'tool:pwsh'])
  assert.deepStrictEqual(toolSectionsForFilter(undefined), [], '没有围栏就没有可丢的')
  assert.deepStrictEqual(toolSectionsForFilter({ allow: ['read'] }), [], 'allow 不由这条函数管')
})

it('allow 白名单按段名过滤工具说明段：只认 tool: 命名空间，且清单未生成时一律保留', () => {
  const listed = { tools: [{ name: 'read' }, { name: 'grep' }, { name: 'pwsh' }] }
  const allow = ['read', 'grep']
  assert.strictEqual(allowToolSectionFilter(allow, 'tool:read', listed, 'READ 说明'), 'READ 说明', '白名单内的段必须原样保留')
  assert.strictEqual(allowToolSectionFilter(allow, 'tool:pwsh', listed, 'PWSH 说明'), '', '白名单外的段必须丢')
  // 组段（tools:sdk / tools:ptc-only）不在 tool: 命名空间里，天然碰不到 ——
  // sdk 那块本就按代理重算，而 ptc-only 那句自指对受限代理反而是唯一正确的说明。
  assert.strictEqual(allowToolSectionFilter(allow, 'tools:sdk', listed, 'SDK'), 'SDK')
  assert.strictEqual(allowToolSectionFilter(allow, 'tools:ptc-only', listed, 'PTC'), 'PTC')
  // 同一个引用返回（没变化就不造新对象）：上层据此走快路径。
  assert.strictEqual(allowToolSectionFilter(allow, 'tool:read', listed, 'READ 说明'), 'READ 说明')
  // 清单还没生成时**不误删** —— 第一装配就发生在清单生成之前，那时宁可多留。
  assert.strictEqual(allowToolSectionFilter(allow, 'tool:pwsh', {}, 'PWSH 说明'), 'PWSH 说明')
  assert.strictEqual(allowToolSectionFilter(allow, 'tool:pwsh', { tools: [] }, 'PWSH 说明'), 'PWSH 说明')
})

  const { sections } = harness({ defaultRules: 'RULES', presets: { recon: { persona: 'r' } } })
  assert.strictEqual(sections.some(s => s.name === 'deployment:persona-prefix'), false)
})


/**
 * 触发 apply 注册的某条会话事件监听器，并把它返回的 Promise 等完。
 *
 * `task.spec.ts` 的 harness 只把 `ctx.on` 的每一次注册收进 `listeners`（`ask-proxy.spec.ts`
 * 里那个 `fire` 是那边自己的），这里补一个同语义的小工具 —— **必须 await**：
 * 监听器是 async 的，写树落在它的微任务之后，同步断言看不到。
 * @param listeners - `harness()` 收下来的注册表。
 * @param event - 事件名。
 * @param args - 事件实参。
 * @returns 监听器全部跑完。
 */
async function fireEvent(
  listeners: readonly { event: string; handler: (...args: never[]) => unknown }[],
  event: string,
  ...args: unknown[]
): Promise<void> {
  for (const entry of listeners) {
    if (entry.event !== event) continue
    await (entry.handler as unknown as (...params: unknown[]) => unknown)(...args)
  }
}

/**
 * 造一个「父会话」：结算正文不在事件里，监听器只能从 `deriveMessages()` 回读。
 * @param sid - 会话 id。
 * @param messages - 该会话的历史。
 * @returns 假会话。
 */
function fakeSession(sid: string, messages: readonly FakeMessage[]): { id: string; deriveMessages: () => readonly FakeMessage[] } {
  return { id: sid, deriveMessages: () => messages }
}

/**
 * 造一条结算事件。
 *
 * 形状照抄宿主 `createSettlementMessage`（dsh-subagent/lib/index.js:633-654）的 `source`：
 * **没有**任何机器可读的失败字段，`summary` 只是一行人读摘要句。
 * @param childId - 子会话 id。
 * @param summary - 宿主摘要句；省略时事件里不带这个键。
 * @returns 事件对象。
 */
function settledEvent(childId: string, summary?: string): { type: string; data: { source: Record<string, string> } } {
  return {
    type: 'user/message',
    data: {
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        senderSessionId: childId,
        ...summary === undefined ? {} : { summary },
      },
    },
  }
}

/**
 * 拼一条与宿主同形的结算正文：摘要句 + 「Its closing message:」+ 子代理的收尾文本。
 * @param summary - 宿主摘要句。
 * @param closing - 子代理收尾文本的段落。
 * @returns 正文。
 */
function settlementBody(summary: string, ...closing: string[]): string {
  const head = closing.length === 0 ? ['It left no closing message.'] : ['Its closing message:', ...closing]
  return [summary, ...head].join('\n')
}

/**
 * 宿主 `settlementSummary` 的六条模板，**逐字**抄自
 * `dsh-subagent/lib/types/continuation-messages.js:57-78`。
 *
 * 夹具必须用**真句子**：判据只认这几条整句（`readStopReason`），手拼的「A 结算了。」
 * 一类假摘要一律落到 `unknown` —— 那正是本次要钉的降级方向，不是可以随手糊过去的东西。
 * @param childId - 子会话 id，会进 `subject` 那一格。
 * @param stop - 宿主那五档结束原因，外加兜底档。
 * @returns 宿主会写进父会话第一行的那句话。
 */
function hostSummary(childId: string, stop: 'completed' | 'aborted' | 'max-tokens' | 'refusal' | 'error' | 'abnormal' = 'completed'): string {
  const subject = `Background subagent ${childId}`
  switch (stop) {
    case 'aborted': return `${subject} was stopped before it finished.`
    case 'max-tokens': return `${subject} ran out of room before it finished.`
    case 'refusal': return `${subject} declined the task.`
    case 'error': return `${subject} failed before it finished.`
    case 'abnormal': return `${subject} ended abnormally (wind-down) before it finished.`
    default: return `${subject} finished and will do no further work unless you send it more.`
  }
}

it('结算监听：结语里**没有**状态行、宿主说正常结束 → 节点 completed，detail 写明未判定对错', async () => {
  const { listeners, treeNodes } = harness({ tree: true })
  treeNodes.push({ id: 'impl', title: '实现', status: 'in_progress', assignedTo: 'child-1' })
  // 结语里一个字的状态标记都没有 —— 正是 2026-10-02 那次事故的形状（状态行被信封吃掉）。
  // 旧判据在这一份结算上落 failed；新判据只看宿主那句模板，于是它是对的。
  const session = fakeSession(SESSION, [fakeSettle('child-1', settlementBody(
    hostSummary('child-1', 'completed'),
    '活干完了。',
    '改动落在 src/index.ts 与 tests/task.spec.ts。',
  ))])
  await fireEvent(listeners, 'session/event', session, settledEvent('child-1'))
  assert.equal(treeNodes.length, 1, '结算只许改现有节点，不许新增')
  assert.equal(treeNodes[0]?.status, 'completed')
  assert.equal(treeNodes[0]?.detail, '状态：正常结束（仅指最后一轮正常结束，未判定对错）')
})

it('结算监听：宿主说「被强停」→ 节点 failed，detail 只带真实原因，uuid 与整句都不进树', async () => {
  const { listeners, treeNodes } = harness({ tree: true })
  // 真机那一次的形状：真 uuid 既是子会话 id，也是宿主那句摘要里的 subject。
  const uuid = 'd4da863e-6584-4828-b2d4-6f4a0f1c9a11'
  treeNodes.push({ id: 'impl', title: '实现', status: 'in_progress', assignedTo: uuid })
  const session = fakeSession(SESSION, [fakeSettle(uuid, settlementBody(hostSummary(uuid, 'aborted'), '我还在改。'))])
  await fireEvent(listeners, 'session/event', session, settledEvent(uuid))
  assert.equal(treeNodes[0]?.status, 'failed')
  assert.equal(treeNodes[0]?.detail, '状态：失败｜被强停')
  const detail = String(treeNodes[0]?.detail)
  assert.ok(!detail.includes(uuid), 'uuid 不进 detail')
  assert.ok(!detail.includes('Background subagent'), '宿主那句样板话不进 detail')
  assert.ok(!detail.includes('\n'), 'detail 必须是纯单行')
})

it('结算监听：另外四条失败档逐档落 failed，各自记真实原因', async () => {
  const cases: readonly (readonly [Parameters<typeof hostSummary>[1], string])[] = [
    ['max-tokens', '状态：失败｜上下文用尽'],
    ['refusal', '状态：失败｜拒绝执行'],
    ['error', '状态：失败｜出错'],
    ['abnormal', '状态：失败｜异常结束'],
  ]
  for (const [stop, detail] of cases) {
    const { listeners, treeNodes } = harness({ tree: true })
    treeNodes.push({ id: 'impl', title: '实现', status: 'in_progress', assignedTo: 'child-1' })
    const session = fakeSession(SESSION, [fakeSettle('child-1', settlementBody(hostSummary('child-1', stop), '没干完。'))])
    await fireEvent(listeners, 'session/event', session, settledEvent('child-1'))
    assert.equal(treeNodes[0]?.status, 'failed', stop)
    assert.equal(treeNodes[0]?.detail, detail, stop)
  }
})

it('结算监听：子代理自己在结语里写的状态行**不作数** —— 判定只看宿主那句', async () => {
  // 反向那一次：结语里写着 `状态：完成`，宿主却说它出错 ⇒ 必须落 failed。
  // 这一条钉的正是「撤掉 /^状态：(完成|失败)$/ 这个主判据」：散文再像也不算数。
  const { listeners, treeNodes } = harness({ tree: true })
  treeNodes.push({ id: 'impl', title: '实现', status: 'in_progress', assignedTo: 'child-1' })
  const session = fakeSession(SESSION, [fakeSettle('child-1', settlementBody(
    hostSummary('child-1', 'error'),
    '状态：完成',
    '看起来像干完了，其实没有。',
  ))])
  await fireEvent(listeners, 'session/event', session, settledEvent('child-1'))
  assert.equal(treeNodes[0]?.status, 'failed', '结语里的状态行一个字都不作数')
  assert.equal(treeNodes[0]?.detail, '状态：失败｜出错')
})

it('结算监听：宿主改了文案（一条模板都不匹配）→ 一个状态都不置，账本也不推进', async () => {
  const ledger = freshLedgerFile()
  const history: FakeMessage[] = []
  const h = harness({ tree: true, runsFile: ledger, parentAgent: { session: { id: SESSION, deriveMessages: () => history } } })
  await startRun(h.tool, [
    { id: 'A', prompt: '第一步' },
    { id: 'B', prompt: '第二步', needs: ['A'] },
  ])
  assert.equal(h.treeNodes.find(node => node.id === 'A')?.status, 'in_progress', '派发之后 A 是 in_progress')
  // 宿主换了个说法：模板头还在，句尾不认识了 —— 这就是「宿主改文案」那一次降级。
  history.push(fakeSettle('child-1', settlementBody('Background subagent child-1 wrapped up somehow.', '干完了。')))
  await fireEvent(h.listeners, 'session/event', fakeSession(SESSION, history), settledEvent('child-1'))
  assert.equal(h.treeNodes.find(node => node.id === 'A')?.status, 'in_progress', '认不出 ≠ 失败，认不出 ≠ 完成：状态一个都不置')
  assert.equal(h.treeNodes.find(node => node.id === 'A')?.detail, '状态：未判定｜认不出宿主的结束原因模板')
  assert.equal(ledgerNode(ledger, 'A', 'r1')?.status, 'dispatched', '账本那一步留在 dispatched')
  assert.equal(h.treeNodes.find(node => node.id === 'B')?.assignedTo, undefined, '下游一个孩子都不该起')

  // 连模板头都没有的那一句（例如子代理自己的正文）同样一个字都不猜。
  const second = harness({ tree: true })
  second.treeNodes.push({ id: 'impl', title: '实现', status: 'in_progress', assignedTo: 'child-1' })
  const session = fakeSession(SESSION, [fakeSettle('child-1', settlementBody('child-1 was stopped before it finished.', '我还在改。'))])
  await fireEvent(second.listeners, 'session/event', session, settledEvent('child-1'))
  assert.equal(second.treeNodes[0]?.status, 'in_progress', '没有模板头 ⇒ 一个字都不猜')
  assert.equal(second.treeNodes[0]?.detail, '状态：未判定｜认不出宿主的结束原因模板')
})

it('结算监听：正文首行不是模板时退回 source.summary —— 两条来源都只做整句比对', async () => {
  const { listeners, treeNodes } = harness({ tree: true })
  treeNodes.push({ id: 'impl', title: '实现', status: 'in_progress', assignedTo: 'child-1' })
  // 正文首行是一句谁都不认识的话（模拟宿主改了正文布局），事件里那一份仍是原句。
  const session = fakeSession(SESSION, [fakeSettle('child-1', settlementBody('（这一行不是宿主写的那句）', '干完了。'))])
  await fireEvent(listeners, 'session/event', session, settledEvent('child-1', hostSummary('child-1', 'completed')))
  assert.equal(treeNodes[0]?.status, 'completed')
  assert.equal(treeNodes[0]?.detail, '状态：正常结束（仅指最后一轮正常结束，未判定对错）')
})

it('结算监听：detail 是插件写的那一行，宿主整句与结语全文都不进树', async () => {
  const { listeners, treeNodes } = harness({ tree: true })
  treeNodes.push({ id: 'impl', title: '实现', status: 'in_progress', assignedTo: 'child-1' })
  const long = '很长的结语'.repeat(80)
  const session = fakeSession(SESSION, [fakeSettle('child-1', settlementBody(hostSummary('child-1', 'max-tokens'), long))])
  await fireEvent(listeners, 'session/event', session, settledEvent('child-1'))
  const detail = String(treeNodes[0]?.detail)
  assert.equal(treeNodes[0]?.status, 'failed')
  assert.equal(detail, '状态：失败｜上下文用尽')
  assert.ok(detail.length <= 200, 'detail 上限 200 字，实际 ' + detail.length)
  assert.ok(!detail.includes('\n'), 'detail 必须是纯单行')
  assert.ok(!detail.includes('Background subagent'), '宿主那句样板话不进 detail')
  assert.ok(!detail.includes('很长的结语'), '结语全文不进 detail')
})

it('结算监听：已经 completed 的节点不被晚到的 failed 改写', async () => {
  const { listeners, treeNodes, treeCalls } = harness({ tree: true })
  treeNodes.push({ id: 'impl', title: '实现', status: 'completed', detail: '状态：正常结束（仅指最后一轮正常结束，未判定对错）', assignedTo: 'child-1' })
  const session = fakeSession(SESSION, [fakeSettle('child-1', settlementBody(hostSummary('child-1', 'max-tokens'), '上下文用尽。'))])
  await fireEvent(listeners, 'session/event', session, settledEvent('child-1'))
  assert.equal(treeNodes[0]?.status, 'completed', '既成事实不许被一条晚到的 failed 盖回去')
  assert.equal(treeNodes[0]?.detail, '状态：正常结束（仅指最后一轮正常结束，未判定对错）')
  assert.deepStrictEqual(treeCalls.filter(call => call.startsWith('step:')), [], '被挡下的那次连写都不该发生')
})

it('结算监听：结语里抄了一句别档的宿主模板也不作数 —— 判据只看正文首行', async () => {
  const { listeners, treeNodes } = harness({ tree: true })
  treeNodes.push({ id: 'impl', title: '实现', status: 'in_progress', assignedTo: 'child-1' })
  const session = fakeSession(SESSION, [fakeSettle('child-1', settlementBody(
    hostSummary('child-1', 'completed'),
    '看，宿主这次说的是这句：',
    hostSummary('child-1', 'error'),
    '（上面那行只是引用）',
  ))])
  await fireEvent(listeners, 'session/event', session, settledEvent('child-1'))
  assert.equal(treeNodes[0]?.status, 'completed', '只有正文首行算数')
  assert.equal(treeNodes[0]?.detail, '状态：正常结束（仅指最后一轮正常结束，未判定对错）')
})

it('结算监听：结算正文读不到时一个字都不写 —— 一次历史读失败不是一次判定', async () => {
  const { listeners, treeNodes, treeCalls } = harness({ tree: true })
  treeNodes.push({ id: 'impl', title: '实现', status: 'in_progress', assignedTo: 'child-1' })
  // 老测试里那种只有 id 的假会话：deriveMessages 根本不存在，正文无从读起。
  await fireEvent(listeners, 'session/event', { id: SESSION }, settledEvent('child-1'))
  assert.equal(treeNodes[0]?.status, 'in_progress', '读不到正文时保持原状，不编造结论')
  assert.equal(treeNodes[0]?.detail, undefined)
  assert.deepStrictEqual(treeCalls.filter(call => call.startsWith('step:')), [])
})

it('结算监听：树里没有绑给这个孩子的节点时只记日志，不碰任何节点', async () => {
  const { listeners, treeNodes, treeCalls } = harness({ tree: true })
  treeNodes.push({ id: 'other', title: '别人的活', status: 'in_progress', assignedTo: 'child-9' })
  const session = fakeSession(SESSION, [fakeSettle('child-1', settlementBody(hostSummary('child-1', 'completed'), '干完了。'))])
  await fireEvent(listeners, 'session/event', session, settledEvent('child-1'))
  assert.equal(treeNodes[0]?.status, 'in_progress')
  assert.deepStrictEqual(treeCalls.filter(call => call.startsWith('step:')), [])
})

it('派发简报：明令禁止写状态行，并说清判定来自宿主那句模板', async () => {
  let captured: Captured | undefined
  let brief = ''
  const ctx = {
    tools: { register: (d: Captured) => { captured = d; return () => {} } },
    get: (key: string) => key === 'taskTree'
      ? { read: () => [], write: async () => {}, step: async () => {}, bind: async () => {} }
      : undefined,
    subagents: {
      resolveMaxDepth: () => undefined,
      startContinuable: async (spec: { request?: { prompt?: readonly { text?: string }[] } }) => {
        brief = spec.request?.prompt?.[0]?.text ?? ''
        return { childId: 'child-1' }
      },
    },
    userQuestions: { ask: async () => ({ answers: [] }) },
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
  }
  apply(ctx as never, { provider: 'default', presets: {} })
  await run(captured as Captured, { action: 'run', run: 'r1', nodes: [{ id: 'impl', prompt: 'go' }] }, caller)
  assert.ok(brief.includes('【节点状态】'), '锚点不许动')
  assert.ok(brief.includes('impl'), '必须点名被绑定的节点')
  assert.ok(brief.includes('不要在结语里写'), '必须明令禁止状态行：' + brief)
  assert.ok(brief.includes('由插件按**宿主的结算模板**判'), '必须说清判定从哪来：' + brief)
  // 旧文案要求子代理自己调 step 置状态 —— 实测做不到：树按会话隔离，它自己的树里没有这个节点。
  assert.ok(brief.includes('不要用 task 工具的 step 去写这个节点'), '必须明确叫停那条做不到的写法')
  // 旧文案还要求它把摘要写进 detail —— 现在 detail 是插件写的判定结论，那一句必须消失。
  assert.equal(brief.includes('摘要进节点的 detail'), false, 'detail 不再来自结语：' + brief)
})


/* ==========================================================================
 * 第二阶段：自动放行流水线
 *
 * 这一族用例钉的是四件事，每一件都对应一条用户拍板的语义：
 *   1. 依赖只驱动后端 —— 节点写进树时只有 id/title/detail，needs 一个字都不进树；
 *   2. 自动放行 —— 前置全部 completed 之后，后继由插件自己派出（不必再调 dispatch）；
 *   3. 失败只停这一支 —— failed 的下游保持 pending，与它平行的分支照常推进；
 *   4. 不通知中枢 —— 这条路上没有任何一条消息进中枢的会话。
 * 另有两条记账纪律：账本必须真的落盘（换一个 harness 仍读得到），
 * 以及读不动/写不动时降级或报错，绝不静默假装成功。
 * ========================================================================== */

/**
 * 跑一条 run 的省事写法：把节点表交给 task 的 run 动作。
 * @param tool - 抓到的工具定义。
 * @param nodes - run 的节点表。
 * @param runId - run id。
 * @returns 工具返回值。
 */
async function startRun(tool: Captured, nodes: readonly Record<string, unknown>[], runId = 'r1'): Promise<Record<string, unknown>> {
  return run(tool, { action: 'run', run: runId, nodes }, caller)
}


it('task run：起点立刻派出，依赖未满足的节点先躺着 —— 树只被写 id/title/detail', async () => {
  const ledger = freshLedgerFile()
  const h = harness({ tree: true, runsFile: ledger, parentAgent: { session: { id: SESSION } } })
  const result = await startRun(h.tool, [
    { id: 'A', prompt: '第一步：把 A 干完', label: '实现' },
    { id: 'B', prompt: '第二步：接着 B', needs: ['A'] },
  ])
  assert.deepStrictEqual(result, { status: 'running', run: 'r1', dispatched: ['A'] })
  const a = h.treeNodes.find(node => node.id === 'A')
  const b = h.treeNodes.find(node => node.id === 'B')
  assert.equal(a?.assignedTo, 'child-1', '起点 A 立刻派出去了')
  assert.equal(b?.assignedTo, undefined, '依赖没满足的 B 不该被派出')
  // 「树是树，后端是后端」：树上只有这三个键，needs 一条都不许漏进去。
  assert.deepStrictEqual(Object.keys(b ?? {}).sort(), ['detail', 'id', 'title'])
  assert.equal(b?.detail, '等待依赖：A', '依赖写在 detail 这句给人看的短句里')
  assert.equal(a?.title, '[实现] 第一步：把 A 干完')
  // 账本里两个节点都在：A 已派出、B 还没。

  assert.equal(ledgerNode(h.runsFile, 'A')?.status, 'dispatched')
  assert.equal(ledgerNode(h.runsFile, 'A')?.childId, 'child-1')
  assert.equal(ledgerNode(h.runsFile, 'B')?.status, 'pending')
  assert.equal(ledgerNode(h.runsFile, 'B')?.childId, undefined)
  assert.deepStrictEqual(ledgerNode(h.runsFile, 'B')?.needs, ['A'])
})

it('依赖门：A 结算 completed 之后，B 被自动派出（不需要任何人再调 dispatch）', async () => {
  const ledger = freshLedgerFile()
  // 父 Agent 的会话历史与事件里那份是**同一个会话**：自动放行要从它里面读上游结论，
  // 读不到就不派发（fail-closed）。所以这里给的假父 Agent 必须带得出这份历史。
  const history = [fakeSettle('child-1', settlementBody(
    hostSummary('child-1', 'completed'),
    'A 干完了。',
  ))]
  const h = harness({ tree: true, runsFile: ledger, parentAgent: { session: { id: SESSION, deriveMessages: () => history } } })
  await startRun(h.tool, [
    { id: 'A', prompt: '第一步' },
    { id: 'B', prompt: '第二步', needs: ['A'] },
  ])
  const session = fakeSession(SESSION, history)
  await fireEvent(h.listeners, 'session/event', session, settledEvent('child-1'))
  const b = h.treeNodes.find(node => node.id === 'B')
  assert.equal(b?.assignedTo, 'child-2', 'B 应当被自动派出，而且是新起的一个孩子')
  assert.equal(b?.status, 'in_progress')
  assert.equal(ledgerNode(h.runsFile, 'A')?.status, 'completed')
  assert.equal(ledgerNode(h.runsFile, 'B')?.status, 'dispatched')
  assert.equal(ledgerNode(h.runsFile, 'B')?.childId, 'child-2')
  // 自动派出去的那个孩子拿到的简报，与工具那条路逐字同形：节点指令在里面，节点名是 B。
  const brief = String((h.starts[1] as { request?: { prompt?: readonly { text?: string }[] } } | undefined)?.request?.prompt?.[0]?.text ?? '')
  assert.ok(brief.includes('【节点状态】'), '自动派发也必须带上节点指令')
  assert.ok(brief.includes('B'), '简报必须点名被绑定的节点')
})

it('自动放行不通知中枢：不起 followup、不 inject、也不往会话历史里写一个字', async () => {
  const ledger = freshLedgerFile()
  const centre: string[] = []
  const parent = { session: { id: SESSION }, followup: () => { centre.push('followup'); return Promise.resolve() } }
  // 上游结论从**父 Agent 自己的会话历史**里读（fail-closed）：假父 Agent 得带得出它。
  const history = [fakeSettle('child-1', settlementBody(
    hostSummary('child-1', 'completed'),
    'A 干完了。',
  ))]
  const h = harness({ tree: true, runsFile: ledger, parentAgent: { ...parent, session: { id: SESSION, deriveMessages: () => history } } })
  await startRun(h.tool, [
    { id: 'A', prompt: '第一步' },
    { id: 'B', prompt: '第二步', needs: ['A'] },
  ])
  await fireEvent(h.listeners, 'session/event', fakeSession(SESSION, history), settledEvent('child-1'))
  assert.equal(h.treeNodes.find(node => node.id === 'B')?.assignedTo, 'child-2', '先确认这一次自动放行真的发生了')
  assert.deepStrictEqual(centre, [], '自动派发不许碰中枢的 followup')
  assert.deepStrictEqual(h.notified, [], '自动派发不许走 ctx.inject，也不许有任何别的惊动中枢的通路')
  assert.equal(history.length, 1, '会话历史里只该有那条结算通知本身')
})

it('失败只停这一支：A 落 failed 后 B 保持 pending，与它平行的 C 照常', async () => {
  const ledger = freshLedgerFile()
  const h = harness({ tree: true, runsFile: ledger, parentAgent: { session: { id: SESSION } } })
  const result = await startRun(h.tool, [
    { id: 'A', prompt: '会失败的那一支' },
    { id: 'B', prompt: 'A 的下游', needs: ['A'] },
    { id: 'C', prompt: '平行的那一支' },
  ])
  assert.deepStrictEqual(result.dispatched, ['A', 'C'], '两个起点都要在声明时立刻派出')
  const session = fakeSession(SESSION, [fakeSettle('child-1', settlementBody(
    hostSummary('child-1', 'error'),
    'A 这一支走不通。',
  ))])
  await fireEvent(h.listeners, 'session/event', session, settledEvent('child-1'))
  const b = h.treeNodes.find(node => node.id === 'B')
  const c = h.treeNodes.find(node => node.id === 'C')
  assert.equal(ledgerNode(h.runsFile, 'A')?.status, 'failed')
  assert.equal(b?.assignedTo, undefined, '失败的下游一个孩子都不该起')
  assert.equal(ledgerNode(h.runsFile, 'B')?.status, 'pending', 'B 保持 pending：不是 failed，更不是 dispatched')
  assert.equal(ledgerNode(h.runsFile, 'B')?.childId, undefined)
  assert.equal(c?.assignedTo, 'child-2', '平行分支不受影响')
  assert.equal(ledgerNode(h.runsFile, 'C')?.status, 'dispatched')
  assert.equal(h.starts.length, 2, '整场只该有两次派发：A 与 C')
})

it('账本落盘：run 写进账本文件本身；换一个 harness（= 重启）仍读得到并照样放行', async () => {
  const ledger = freshLedgerFile()
  const h1 = harness({ tree: true, runsFile: ledger, parentAgent: { session: { id: SESSION } } })
  await startRun(h1.tool, [
    { id: 'A', prompt: '第一步' },
    { id: 'B', prompt: '第二步', needs: ['A'] },
  ])
  assert.ok(existsSync(ledger), '账本必须真的落盘：那个文件得存在')
  assert.ok(ledgerRuns(h1.runsFile).length > 0, '账本文件里得真的有这条 run')
  assert.ok(ledgerRuns(h1.runsFile).length === 1, '一条 run 只写一份，重写不会叠出两份')
  assert.equal(ledgerNode(h1.runsFile, 'A')?.prompt, '第一步', '每一步的活也住在账本里，树上看不到')
  assert.equal(ledgerNode(h1.runsFile, 'A')?.status, 'dispatched')
  assert.equal(ledgerNode(h1.runsFile, 'B')?.status, 'pending', 'h1 里 B 还没被放行')

  // 「重启」：全新的 harness —— 全新的 ctx、全新的树、全新的内存。
  // 只有那份设置值活着，所以 h2 若还能放行 B，就只可能来自落盘的那份账本。
  // 重启之后同样要能读到上游结论：父 Agent 的会话历史里带着那条结算通知。
  const history = [fakeSettle('child-1', settlementBody(
    hostSummary('child-1', 'completed'),
    'A 干完了。',
  ))]
  const h2 = harness({ tree: true, runsFile: ledger, parentAgent: { session: { id: SESSION, deriveMessages: () => history } } })
  h2.treeNodes.push({ id: 'A', title: '第一步', status: 'in_progress', assignedTo: 'child-1' })
  h2.treeNodes.push({ id: 'B', title: '第二步', detail: '等待依赖：A', status: 'pending' })
  const session = fakeSession(SESSION, history)
  await fireEvent(h2.listeners, 'session/event', session, settledEvent('child-1'))
  // h2 是新的 harness，它自己的子会话计数从头开始 —— 这里要的是它派出的**第一个**孩子。
  assert.equal(h2.starts.length, 1, '重启之后确实发生了一次派发')
  assert.equal(h2.treeNodes.find(node => node.id === 'B')?.assignedTo, 'child-1', '重启之后账本仍然驱动放行')
  assert.equal(ledgerNode(h2.runsFile, 'B')?.status, 'dispatched')
  assert.equal(ledgerNode(h2.runsFile, 'B')?.childId, 'child-1')
})

it('task run：needs 成环直接报错，且一个字都不落（树与账本都不动）', async () => {
  const ledger = freshLedgerFile()
  const h = harness({ tree: true, runsFile: ledger, parentAgent: { session: { id: SESSION } } })
  await assert.rejects(
    () => startRun(h.tool, [
      { id: 'A', prompt: 'a', needs: ['B'] },
      { id: 'B', prompt: 'b', needs: ['A'] },
    ]),
    /cycle/,
  )
  assert.deepStrictEqual(h.treeCalls, [], '成环的 run 连写树都不该发生')
  assert.ok(ledgerFileAbsent(ledger), '成环的 run 一个字节都不该进账本（连文件都不该被建）')
})

it('task run：needs 点到不存在的节点时，报错点名是哪个 id', async () => {
  const ledger = freshLedgerFile()
  const h = harness({ tree: true, runsFile: ledger, parentAgent: { session: { id: SESSION } } })
  await assert.rejects(
    () => startRun(h.tool, [{ id: 'A', prompt: 'a', needs: ['ghost'] }]),
    /needs "ghost", which is not a node of this run/,
  )
  assert.deepStrictEqual(h.treeCalls, [])
})


it('task run：账本文件写不进去时明确报错 —— 记一条永远不会被放行的流水线等于骗调用方', async () => {
  // 把账本路径指到一个**目录**上：写它必然失败（EISDIR / EPERM），
  // 这是「文件系统这一侧真的坏了」的最小模型，不需要去改权限。
  // 父路径是个**文件**：在它下面建任何东西都是 ENOTDIR，稳定且不用改权限。
  const blocker = join(mkdtempSync(join(tmpdir(), 'task-runs-bad-')), 'blocker.txt')
  writeFileSyncNode(blocker, 'x', 'utf8')
  const ledger = join(blocker, 'task-runs.json')
  const h = harness({ tree: true, runsFile: ledger, parentAgent: { session: { id: SESSION } } })
  await assert.rejects(
    () => startRun(h.tool, [{ id: 'A', prompt: 'a' }]),
    /is not writable/,
  )
  // 报错发生在写树之后：节点先落树（调用方看得见这条流水线），随后「记不住」当场抛，
  // 而不是先宣称成功再悄悄丢掉。
  assert.deepStrictEqual(h.treeCalls, [`write:${SESSION}:false`])
})

it('账本落的是**文件**，不是 task 行的设置字段：文件真的被建出来了，且内容是可解析的 JSON', async () => {
  // 这一条钉的是存储路径本身。历史上的两版都失败过：
  //   1) 放在 task 行的 volatile 字段上 —— 设置页会把整份账本投影成可手滑清空的输入框；
  //   2) 放在单独的 Loader 行上 —— 那一行在这个宿主里没装载成功，而 Loader 只把错误写进
  //      没人读得到的 logger，于是账本**静默地记不住**。
  // 现在它只是一个文件：没有行、没有 schema 投影、写路径上没有第三方。
  const ledger = freshLedgerFile()
  const h = harness({ tree: true, runsFile: ledger, parentAgent: { session: { id: SESSION } } })
  await startRun(h.tool, [{ id: 'A', prompt: '第一步' }])
  assert.ok(existsSync(ledger), '账本文件必须被真的建出来')
  const parsed = JSON.parse(readFileSyncNode(ledger, 'utf8')) as { version?: number; sessions?: Record<string, unknown[]> }
  assert.equal(parsed.version, 1, '文件带版本号，将来改形状时有据可依')
  assert.strictEqual(parsed.sessions?.[SESSION]?.length, 1)
  // 原子写：临时文件不许留在盘上。
  const siblings = readdirSync(join(ledger, '..')).filter(name => name.includes('.tmp'))
  assert.deepStrictEqual(siblings, [], '原子写的临时文件必须已经被 rename 掉')
})

it('账本默认路径：task 行没给 runsFile 时，落在 DSH_PROFILE_DIR 下、文件名固定', async () => {
  // 这一条不需要真写盘，只钉路径决议本身 —— 它决定「重启之后去哪儿把账本读回来」。
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = 'M:\\some\\profile'
  try {
    assert.ok(ledgerPathFor('').endsWith('\\' + TASK_RUNS_FILE_NAME) || ledgerPathFor('').endsWith('/' + TASK_RUNS_FILE_NAME))
    assert.ok(ledgerPathFor('').includes('some'), '基准目录来自 DSH_PROFILE_DIR')
    assert.equal(ledgerPathFor('D:\\custom\\ledger.json'), 'D:\\custom\\ledger.json', '显式给路径时原样用')
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  }
})

it('账本路径不是 volatile：它只用来挪文件，绝不进设置页的可热改字段', () => {
  // 这一条钉的是存储路径选择的**理由**。历史上有过两版都不行：
  //   1) 账本放在 task 行的 volatile 字段上 —— volatile 的语义是「列出可热改字段」而不是隐藏，
  //      于是设置页会把整份账本 JSON 投影成一个可手滑清空的输入框；
  //   2) 放到单独的 Loader 行上 —— 那一行在这个宿主里没装载成功，而 Loader 只把错误写进没人
  //      读得到的 logger，账本于是**静默地记不住**。
  // 现在账本是一个文件，task 行上只留一个可选的文件位置，而且**不是** volatile。
  assert.deepStrictEqual(Object.keys(TaskRowConfig.dict ?? {}).sort(),
    ['defaultRules', 'presets', 'probeEnabled', 'provider', 'runsFile', 'worktreeAuto', 'worktreeGoal', 'worktreeMergeVerify', 'worktreePrepare', 'worktreeVerify', 'worktreesFile'],
    'task 行就这几格：账本本体不在配置里，只有位置开关与几个默认值（隔离那一半 + 探头那一档）')
  assert.notStrictEqual(TaskRowConfig.dict?.runsFile?.meta.volatile, true,
    'runsFile 绝不能是 volatile：那会让它出现在设置页的可热改字段里')
  assert.strictEqual(TASK_RUNS_FILE_NAME, 'task-runs.json', '默认文件名固定，便于排障时找得到')
})

it('通道那一格已经从配置里摘掉：Agent Teams 不在了，就没有「走哪条通道」这个开关', () => {
  // 摘掉而不是留一个单值枚举：单值开关是死配置，留着只会让人以为还有第二条路。
  assert.strictEqual(TaskRowConfig.dict?.pipelineChannel, undefined, '配置里不许再有 pipelineChannel')
})
it('inject 里必须有 agents：少了它，自动放行会在取父 Agent 那一步抛错、被 catch 吞成一行日志', () => {
  // 这一条是真的踩出来的（2026-10-01 真机 task run）：A 结算后 B 停在 pending，
  // 账本里 A 已经是 completed —— 因为 advanceRuns 在 `ctx.agents.get(sid)` 上抛了
  // `cannot get property "agents" without inject`，而那条路「绝不抛」，异常只进宿主日志，
  // 谁也看不见。cordis 的规矩是：没声明 inject 的服务，**读一下就抛**。
  assert.ok(inject.includes('agents'), 'agents 必须在 inject 里，否则自动放行永远走不通')
  // 这些是插件真的会无条件用的服务面（settings 已不再需要：账本走自己的文件）。
  for (const service of ['tools', 'subagents', 'systemPrompt']) {
    assert.ok(inject.includes(service), service + ' 也必须在 inject 里')
  }
  assert.ok(!inject.includes('settings'), 'settings 不该再在 inject 里：账本不再经过设置服务')
})


/* ==========================================================================
 * 第三阶段：上游结论传递（2026-10-01）
 *
 * 用户拍板的语义，逐条钉在这里：
 *   1. 下游简报带上游的**结算正文全文**（会话历史里那一份），按 needs 的声明顺序拼接；
 *      单条上限 20000 字，超了才截断并注明原文多少字 —— 不许另设更小的上限；
 *   2. 取不到上游结论 ⇒ **不派发**（fail-closed），节点保持 pending，原因同时进树 detail
 *      与账本 note；下一次机会来自 advanceRuns（别的节点一结算就重跑一遍）；
 *   3. 派发失败**不退回直连**，原因同样两处都留；派发成功则把陈旧原因清掉；
 *   4. 账本默认路径优先 ctx.baseUrl；`task list scope=tree` 带出非 completed 节点的 detail。
 * ========================================================================== */

/**
 * 直接改账本文件里的某个节点。
 *
 * 用它造出**只能由外部事实产生**的状态（例如「依赖已完成、但没有 childId」）：
 * fail-closed 那条路正是为这种情况写的，而它走不到任何正常写入路径上。
 * 值为 `undefined` 表示删掉那个键。
 * @param file - 账本文件路径。
 * @param runId - run id。
 * @param nodeId - 节点 id。
 * @param patch - 要改的键。
 */
function patchLedgerNode(file: string, runId: string, nodeId: string, patch: Record<string, unknown>): void {
  const doc = JSON.parse(readFileSyncNode(file, 'utf8')) as {
    sessions?: Record<string, { id: string; nodes: Record<string, unknown>[] }[]>
  }
  const run = doc.sessions?.[SESSION]?.find(item => item.id === runId)
  const node = run?.nodes.find(item => item.id === nodeId)
  if (node === undefined) throw new Error('ledger node not found: ' + runId + '/' + nodeId)
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete node[key]
    else node[key] = value
  }
  writeFileSyncNode(file, JSON.stringify(doc, null, 1), 'utf8')
}

/**
 * 取一次派发真正交给子代理的简报文本（两条通道收到的都是 `request.prompt[0].text`）。
 * @param start - `startContinuable` 收到的那个 spec。
 * @returns 简报文本；没有就是空串。
 */
function briefOf(start: unknown): string {
  const blocks = (start as { request?: { prompt?: readonly { text?: string }[] } } | undefined)?.request?.prompt ?? []
  return blocks[0]?.text ?? ''
}

it('上游结论注入下游简报：按 needs 声明顺序给出**结算正文全文**，不是树 detail 那 200 字', async () => {
  const ledger = freshLedgerFile()
  const history: FakeMessage[] = []
  // 父 Agent 的会话历史与事件里那份是**同一份**：结算正文只能从历史里读。
  const parent = { session: { id: SESSION, deriveMessages: () => history } }
  const h = harness({ tree: true, runsFile: ledger, parentAgent: parent })
  await startRun(h.tool, [
    { id: 'A', prompt: 'A 的活' },
    { id: 'B', prompt: 'B 的活' },
    { id: 'C', prompt: 'C 的活', needs: ['B', 'A'] },
  ])
  assert.deepStrictEqual(
    h.treeNodes.filter(node => node.assignedTo !== undefined).map(node => `${node.id}=${String(node.assignedTo)}`),
    ['A=child-1', 'B=child-2'],
    '两个起点各自拿到一个孩子；C 还在等',
  )
  // needs 的声明顺序是 **B、A**，与 run 里的声明顺序（A、B）相反 ——
  // 于是「按 needs 顺序」与「按 run 顺序」这两种实现在下面那条断言上会分开。
  // 尾标记刻意放在 200 字之外：它进不了树 detail，只可能来自历史全文。
  const tailA = '甲尾标记-只有全文里才有'
  const tailB = '乙尾标记-只有全文里才有'
  history.push(fakeSettle('child-1', settlementBody(hostSummary('child-1', 'completed'), 'A 的结论：' + '甲'.repeat(300) + tailA)))
  history.push(fakeSettle('child-2', settlementBody(hostSummary('child-2', 'completed'), 'B 的结论：' + '乙'.repeat(300) + tailB)))
  const session = fakeSession(SESSION, history)
  await fireEvent(h.listeners, 'session/event', session, settledEvent('child-1'))
  await fireEvent(h.listeners, 'session/event', session, settledEvent('child-2'))
  assert.equal(h.treeNodes.find(node => node.id === 'C')?.assignedTo, 'child-3', '依赖齐了，C 被自动派出')

  const detailA = String(h.treeNodes.find(node => node.id === 'A')?.detail)
  assert.ok(detailA.length <= 200 && !detailA.includes(tailA), '树 detail 只有 200 字，尾标记不在里面：' + detailA.length)
  const brief = briefOf(h.starts[2])
  assert.ok(brief.includes(tailA) && brief.includes(tailB), '注入的必须是历史里的全文（尾标记在 200 字之外）')
  assert.ok(brief.includes('【上游结论】以下是你依赖的节点已完成的收尾结论，按 needs 声明顺序给出，直接拿来用，不要重新采集。'))
  assert.ok(brief.includes('—— 节点 B（child child-2）——'), brief)
  assert.ok(brief.includes('—— 节点 A（child child-1）——'), brief)
  assert.ok(
    brief.indexOf('—— 节点 B（child child-2）——') < brief.indexOf('—— 节点 A（child child-1）——'),
    '顺序 = needs 的声明顺序（B 在 A 前），不是 run 里的声明顺序',
  )
  assert.ok(brief.indexOf('C 的活') < brief.indexOf('【上游结论】'), '上游段排在节点自己的简报之后')
  assert.ok(brief.indexOf('【上游结论】') < brief.indexOf('【节点状态】'), '上游段排在节点指令段之前')
  // 没有 needs 的起点：一个字都不加（简报与改动前逐字一致）。
  assert.ok(!briefOf(h.starts[0]).includes('【上游结论】'), briefOf(h.starts[0]))
  assert.ok(!briefOf(h.starts[1]).includes('【上游结论】'), briefOf(h.starts[1]))
})

it('上游结论单条超过 20000 字才截断，并在末尾注明原文多少字；没超的原样全给', async () => {
  const ledger = freshLedgerFile()
  const history: FakeMessage[] = []
  const parent = { session: { id: SESSION, deriveMessages: () => history } }
  const h = harness({ tree: true, runsFile: ledger, parentAgent: parent })
  await startRun(h.tool, [
    { id: 'A', prompt: 'A 的活' },
    { id: 'B', prompt: 'B 的活' },
    { id: 'C', prompt: 'C 的活', needs: ['A', 'B'] },
  ])
  const tail = '超出上限的那一段'
  const bodyA = settlementBody(hostSummary('child-1', 'completed'), '巨'.repeat(21000) + tail)
  const bodyB = settlementBody(hostSummary('child-2', 'completed'), '小'.repeat(1000))
  assert.ok(bodyA.length > 20000 && bodyB.length < 20000, '这一条要的正是「一条超限、一条没超」')
  history.push(fakeSettle('child-1', bodyA))
  history.push(fakeSettle('child-2', bodyB))
  const session = fakeSession(SESSION, history)
  await fireEvent(h.listeners, 'session/event', session, settledEvent('child-1'))
  await fireEvent(h.listeners, 'session/event', session, settledEvent('child-2'))
  const brief = briefOf(h.starts[2])
  // 前 20000 字一字不少，紧跟注明原文多少字 —— 上限就是 20000，不是更小的数。
  assert.ok(brief.includes(bodyA.slice(0, 20000) + '…（上游结论已截断，原文 ' + String(bodyA.length) + ' 字）'))
  assert.ok(!brief.includes(tail), '超出上限的那一段不许进简报')
  assert.ok(brief.includes(bodyB), '没超上限的那一条原样全给')
  assert.ok(!brief.includes('（上游结论已截断，原文 ' + String(bodyB.length) + ' 字）'), '没超限就不许标注')
})

it('取不到上游结论 ⇒ 阻塞：不派发、留在 pending，detail 与账本 note 是同一句「结论缺失：」；下一次结算会重新评估', async () => {
  const ledger = freshLedgerFile()
  const history: FakeMessage[] = []
  const parent = { session: { id: SESSION, deriveMessages: () => history } }
  const h = harness({ tree: true, runsFile: ledger, parentAgent: parent })
  // r1 只负责**触发** advanceRuns：它那两个起点各结算一次。
  await startRun(h.tool, [{ id: 'A', prompt: 'a' }, { id: 'D', prompt: 'd' }], 'r1')
  // r2 里 P 是 Q 的依赖：Q 要等 P 完成之后才会被评估。
  await startRun(h.tool, [{ id: 'P', prompt: 'p' }, { id: 'Q', prompt: 'q', needs: ['P'] }], 'r2')
  assert.deepStrictEqual(
    h.treeNodes.filter(node => node.assignedTo !== undefined).map(node => `${node.id}=${String(node.assignedTo)}`),
    ['A=child-1', 'D=child-2', 'P=child-3'],
  )
  // 「依赖已完成、但账本上没有它的 childId」——取不到上游正文的最小模型。
  patchLedgerNode(ledger, 'r2', 'P', { status: 'completed', childId: undefined })
  history.push(fakeSettle('child-1', settlementBody(hostSummary('child-1', 'completed'), 'A 干完了。')))
  history.push(fakeSettle('child-2', settlementBody(hostSummary('child-2', 'completed'), 'D 干完了。')))
  history.push(fakeSettle('child-3', settlementBody(hostSummary('child-3', 'completed'), 'P 的结论：只此一份。')))
  const session = fakeSession(SESSION, history)
  await fireEvent(h.listeners, 'session/event', session, settledEvent('child-1'))

  const q = h.treeNodes.find(node => node.id === 'Q')
  assert.equal(h.starts.length, 3, '阻塞就不许派发：整场只该有 A / D / P 三次')
  assert.equal(q?.assignedTo, undefined, 'Q 一个孩子都不该有')
  assert.ok(String(q?.detail).startsWith('结论缺失：'), String(q?.detail))
  assert.ok(String(q?.detail).includes('P'), '要说清是哪个依赖：' + String(q?.detail))
  const blocked = ledgerNode(ledger, 'Q', 'r2')
  assert.equal(blocked?.status, 'pending')
  assert.equal(blocked?.childId, undefined)
  assert.equal(blocked?.note, q?.detail, '账本 note 与树 detail 是**同一句**原因')

  // **不是死锁**：上游正文后来可读了，任何一次别的结算都会让 advanceRuns 重跑一遍 ——
  // 那一遍里 Q 的依赖已经齐了、正文也读得到，于是它被派出去。
  patchLedgerNode(ledger, 'r2', 'P', { childId: 'child-3' })
  await fireEvent(h.listeners, 'session/event', session, settledEvent('child-2'))
  assert.equal(h.treeNodes.find(node => node.id === 'Q')?.assignedTo, 'child-4', '重新评估之后 Q 派得出去')
  assert.equal(h.treeNodes.find(node => node.id === 'Q')?.detail, '已派发：上游结论已注入',
    '派发成功要把陈旧的「结论缺失：」换成一行事实')
  const released = ledgerNode(ledger, 'Q', 'r2')
  assert.equal(released?.status, 'dispatched')
  assert.equal(released?.childId, 'child-4')
  assert.equal(released?.note, undefined, '派发成功要把陈旧原因清掉')
})


it('账本 note：有值才写、折成单行、截到 300 字；不传就是清空（派发成功不许留陈旧原因）', () => {
  const base: RunNodeRecord = { id: 'A', prompt: 'a', needs: [], status: 'pending' }
  assert.equal('note' in base, false)
  const blocked = runNodeWith(base, 'pending', undefined, '结论缺失：依赖 P 在账本里没有 childId，取不到它的结算正文')
  assert.ok(String(blocked.note).startsWith('结论缺失：'))
  const messy = runNodeWith(base, 'pending', undefined, '派发失败：第一行\n第二行\t还有制表符 ' + 'x'.repeat(500))
  assert.equal(String(messy.note).includes('\n'), false, 'note 折成单行')
  assert.ok(String(messy.note).length <= RUN_NOTE_MAX, 'note 上限 ' + String(RUN_NOTE_MAX) + ' 字，实际 ' + String(String(messy.note).length))
  const dispatched = runNodeWith(messy, 'dispatched', 'child-1')
  assert.equal(dispatched.status, 'dispatched')
  assert.equal(dispatched.childId, 'child-1')
  assert.equal('note' in dispatched, false, '派发成功要把陈旧原因整个去掉')
})

it('账本默认路径优先 ctx.baseUrl 指向的目录（file: URL），其次才是 DSH_PROFILE_DIR；解析不出一律退回、不抛', () => {
  const prevProfile = process.env.DSH_PROFILE_DIR
  const prevEnv = process.env[TASK_RUNS_FILE_ENV]
  process.env.DSH_PROFILE_DIR = 'M:\\some\\profile'
  delete process.env[TASK_RUNS_FILE_ENV]
  try {
    const base = 'file:///M:/DSH-T4/home/profiles/desktop/'
    assert.equal(
      ledgerPathFor('', base),
      'M:\\DSH-T4\\home\\profiles\\desktop\\' + TASK_RUNS_FILE_NAME,
      'baseUrl 的目录就是账本的基准目录',
    )
    assert.equal(
      ledgerPathFor('', 'file:///M:/DSH-T4/home/profiles/desktop'),
      'M:\\DSH-T4\\home\\profiles\\desktop\\' + TASK_RUNS_FILE_NAME,
      '末尾带不带斜杠都指同一个目录',
    )
    // 解析不出来的 baseUrl 一律退回下一条 —— 绝不抛。
    assert.equal(ledgerPathFor('', 'not a url'), 'M:\\some\\profile\\' + TASK_RUNS_FILE_NAME)
    assert.equal(ledgerPathFor('', 'https://example.com/x/'), 'M:\\some\\profile\\' + TASK_RUNS_FILE_NAME)
    assert.equal(ledgerPathFor('', 'M:\\some\\profile'), 'M:\\some\\profile\\' + TASK_RUNS_FILE_NAME)
    assert.equal(ledgerPathFor('', undefined), 'M:\\some\\profile\\' + TASK_RUNS_FILE_NAME)
    // 前两条（显式配置、环境变量）仍然优先于 baseUrl。
    assert.equal(ledgerPathFor('D:\\custom\\ledger.json', base), 'D:\\custom\\ledger.json')
    process.env[TASK_RUNS_FILE_ENV] = 'D:\\env\\ledger.json'
    assert.equal(ledgerPathFor('', base), 'D:\\env\\ledger.json')
  } finally {
    if (prevProfile === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = prevProfile
    if (prevEnv === undefined) delete process.env[TASK_RUNS_FILE_ENV]
    else process.env[TASK_RUNS_FILE_ENV] = prevEnv
  }
})

it('task list scope=tree 带出非 completed 节点的 detail —— 「派发失败/结论缺失」在面板之外也读得到', async () => {
  const h = harness({ tree: true })
  h.treeNodes.push({ id: 'a', title: 'A', status: 'failed', detail: '派发失败：UnknownPresetError: unknown preset "no-such-preset"', assignedTo: undefined })
  h.treeNodes.push({ id: 'b', title: 'B', status: 'completed', detail: '状态：正常结束（仅指最后一轮正常结束，未判定对错）', assignedTo: undefined })
  h.treeNodes.push({ id: 'c', title: 'C', status: 'pending', detail: '等待依赖：A\n下一行也要折起来', assignedTo: undefined })
  h.treeNodes.push({ id: 'd', title: 'D', status: 'in_progress', detail: '结'.repeat(500), assignedTo: undefined })
  const result = await run(h.tool, { action: 'list' }, caller)
  const tree = String(result.tree)
  assert.ok(tree.includes('- [failed] a: A'), tree)
  assert.ok(tree.includes('  detail: 派发失败：UnknownPresetError: unknown preset "no-such-preset"'), tree)
  assert.ok(!tree.includes('仅指最后一轮正常结束'), 'completed 节点不带 detail 行，避免刷屏：' + tree)
  assert.ok(tree.includes('detail: 等待依赖：A 下一行也要折起来'), 'detail 折成单行：' + tree)
  const detailLine = tree.split('\n').find(line => line.trimStart().startsWith('detail: 结')) ?? ''
  assert.ok(detailLine.trimStart().length <= 'detail: '.length + 200, 'detail 行按 200 上限截断：' + String(detailLine.length))
})


/* ==========================================================================
 * 第四阶段：中枢写框架、插件填槽位（2026-10-01 定稿口径）
 *
 *   - `{{<nodeId>}}` 就地换成那个依赖的结论文本全文（同一依赖多处出现就每处都换）；
 *   - 没被任何槽位覆盖的依赖，按 needs 声明顺序用【上游结论】块追加；全被吃掉就不追加；
 *   - 槽位在**声明期**校验：不在本 run 里 / 不是本节点 needs 成员 —— 一律当场抛；
 *   - 「结论要简略」那一句只进 run 链路的简报，`dispatch` 动作逐字不变。
 * ========================================================================== */

it('槽位：{{A}} 就地换成结论文本全文，同一依赖出现多次每一处都换；没被覆盖的依赖照旧追加成块', async () => {
  const ledger = freshLedgerFile()
  const history: FakeMessage[] = []
  const parent = { session: { id: SESSION, deriveMessages: () => history } }
  const h = harness({ tree: true, runsFile: ledger, parentAgent: parent })
  await startRun(h.tool, [
    { id: 'A', prompt: 'A 的活' },
    { id: 'B', prompt: 'B 的活' },
    { id: 'C', prompt: '框架开头\nA 的资料：{{A}}\n再贴一次 A：{{A}}\n框架结尾', needs: ['A', 'B'] },
  ])
  const bodyA = settlementBody(hostSummary('child-1', 'completed'), 'A 的结论正文：甲。')
  const bodyB = settlementBody(hostSummary('child-2', 'completed'), 'B 的结论正文：乙。')
  history.push(fakeSettle('child-1', bodyA))
  history.push(fakeSettle('child-2', bodyB))
  const session = fakeSession(SESSION, history)
  await fireEvent(h.listeners, 'session/event', session, settledEvent('child-1'))
  await fireEvent(h.listeners, 'session/event', session, settledEvent('child-2'))
  const brief = briefOf(h.starts[2])
  // 就地替换：两处都换成**正文全文**（连那一份结算正文里的一字一句都在），不带任何前言/标题。
  assert.ok(
    brief.includes('框架开头\nA 的资料：' + bodyA + '\n再贴一次 A：' + bodyA + '\n框架结尾'),
    brief,
  )
  assert.equal(brief.includes('{{A}}'), false, '槽位必须被吃掉：' + brief)
  // A 被槽位吃掉 ⇒ 追加块里不许再有 A；B 没被覆盖 ⇒ 照旧追加，而且是 needs 的顺序。
  assert.ok(brief.includes('—— 节点 B（child child-2）——'), brief)
  assert.equal(brief.includes('—— 节点 A（child child-1）——'), false, '被槽位覆盖的依赖不进追加块')
  assert.ok(brief.indexOf('框架结尾') < brief.indexOf('【上游结论】'), '追加块在框架之后')
  assert.ok(brief.indexOf('【上游结论】') < brief.indexOf('【节点状态】'), '追加块在节点指令段之前')
})

it('全部依赖都被槽位吃掉 ⇒ 一个块都不追加（简报 = 框架原文 + 节点状态段）', async () => {
  const ledger = freshLedgerFile()
  const history: FakeMessage[] = []
  const parent = { session: { id: SESSION, deriveMessages: () => history } }
  const h = harness({ tree: true, runsFile: ledger, parentAgent: parent })
  await startRun(h.tool, [
    { id: 'A', prompt: 'A 的活' },
    { id: 'B', prompt: '只用槽位：{{A}}', needs: ['A'] },
  ])
  const bodyA = settlementBody(hostSummary('child-1', 'completed'), 'A 的结论正文：甲。')
  history.push(fakeSettle('child-1', bodyA))
  await fireEvent(h.listeners, 'session/event', fakeSession(SESSION, history), settledEvent('child-1'))
  const brief = briefOf(h.starts[1])
  assert.ok(brief.includes('只用槽位：' + bodyA), brief)
  assert.equal(brief.includes('【上游结论】'), false, '全被槽位吃掉时不许再追加块：' + brief)
  assert.ok(brief.includes('【节点状态】'), '节点指令段照常在')
})

it('槽位的声明期校验：不属于本节点 needs / 不在本次 run 里 —— 两种都当场抛，且一个字都不落', async () => {
  const ledger = freshLedgerFile()
  const h = harness({ tree: true, runsFile: ledger, parentAgent: { session: { id: SESSION } } })
  // ① 在本 run 里、但不是**这个节点**的 needs 成员。
  await assert.rejects(
    () => startRun(h.tool, [{ id: 'A', prompt: 'a' }, { id: 'B', prompt: '用了 {{A}} 但没写 needs' }]),
    /task run: node "B" 的 prompt 引用了 \{\{A\}\}，但 A 不是它的 needs 成员（本节点 needs: ）/,
  )
  // ② 根本不在本次 run 里（打错一个字符就是这种）。
  await assert.rejects(
    () => startRun(h.tool, [{ id: 'A', prompt: 'a {{ghost}}' }]),
    /task run: node "A" 的 prompt 引用了 \{\{ghost\}\}，但 ghost 不在本次 run 里（已知节点: A）/,
  )
  assert.deepStrictEqual(h.treeCalls, [], '声明期就拒掉：连写树都不该发生')
  assert.ok(ledgerFileAbsent(ledger), '声明期就拒掉：一个字节都不该进账本')
  // ③ 不算槽位的写法原样保留，不报错：括号内有空白、或者干脆是空的。
  const ok = await startRun(h.tool, [{ id: 'A', prompt: '{{ A }} 与 {{}} 都不是槽位' }], 'r-ok')
  assert.deepStrictEqual(ok.dispatched, ['A'])
  const brief = briefOf(h.starts[0])
  assert.ok(brief.includes('{{ A }} 与 {{}} 都不是槽位'), '不是槽位的写法必须原样留在简报里：' + brief)
})

it('「结论要简略」那一句只进 run 链路的简报：位置在禁写状态行那句之后、结语那段之前；resume 那条路逐字不变', async () => {
  const ledger = freshLedgerFile()
  const history: FakeMessage[] = []
  const parent = { session: { id: SESSION, deriveMessages: () => history } }
  const h = harness({ tree: true, runsFile: ledger, parentAgent: parent })
  await startRun(h.tool, [
    { id: 'A', prompt: '第一步' },
    { id: 'B', prompt: '第二步', needs: ['A'] },
  ])
  const concise = '结语里给下游用的**结论**尽量简略（建议 ≤500 字）：只写结论与关键证据，不要复述过程、不要贴长日志。'
  assert.ok(briefOf(h.starts[0]).includes(concise), 'run 链路的起点也要带这一句')
  history.push(fakeSettle('child-1', settlementBody(hostSummary('child-1', 'completed'), 'A 干完了。')))
  await fireEvent(h.listeners, 'session/event', fakeSession(SESSION, history), settledEvent('child-1'))
  const brief = briefOf(h.starts[1])
  assert.ok(brief.includes(concise), brief)
  assert.ok(brief.indexOf('写在结语里的状态一个字都不作数。') < brief.indexOf(concise), '必须排在禁写状态行那句之后')
  assert.ok(brief.indexOf('【节点状态】') < brief.indexOf(concise), '必须在节点指令段之内')
  assert.ok(brief.indexOf(concise) < brief.indexOf('结语会被完整保存'), '必须排在结语那段之前')
  // `run` 的另一条类入口：`resume` 把**已派出但没干成**的节点交回**它原来那个孩子**接着干。
  //
  // 这一条钉的是「那一句只属于 run 的**首次派发**」。resume 不走 `withNodeBrief`
  // （`resumeNode` 只送 `composeBrief(upstream) + RESUME_NOTE`，见 src/index.ts:1471），
  // 所以那一句、连同节点指令段，在它的简报里**一个字都不该出现**。
  // 交付的节点必须是**还没完成**的那一个：A 已经结算成 completed，resume 它会当场抛。
  await run(h.tool, { action: 'run', run: 'r1', resume: 'B' }, makeCaller())
  const last = h.sent[h.sent.length - 1] as { content?: readonly { text?: string }[] }
  const resumed = last.content?.[0]?.text ?? ''
  assert.ok(resumed.includes('第二步'), '简报本体照常送出：' + resumed)
  assert.equal(resumed.includes('建议 ≤500 字'), false, 'resume 的简报不许出现这一句：' + resumed)
  assert.equal(resumed.includes(concise), false, 'resume 的简报不许出现这一句：' + resumed)
  assert.equal(resumed.includes('【节点状态】'), false, 'resume 不走 withNodeBrief，节点指令段不许出现：' + resumed)
})

/**
 * 本次收口改动是**有风险**的：枚举里删掉了 `dispatch`，派活这件事整个挪到了 `run` 上。
 * 所以必须有一条用例**真跑一次 `run`**，证明孩子真的被派出去了 —— 而不是只断言
 * 「参数形状对」（那种断言在派活整条链路断掉时照样是绿的，等于没测）。
 *
 * 「被派出去」这里落在三件可观测的事实上，缺一不可：
 *   ① 启动请求确实进了 `ctx.subagents.startContinuable`（真机就是这条路把孩子生出来的），
 *      而且带上的是本次那个节点：`parent` 是当刻活着的 Agent、identity 挂在 label 上、
 *      简报在 `request.prompt` 里、节点状态指令也拼了进去；
 *   ② 工具返回值把这一批算作已派出；
 *   ③ 节点**已经建成**（写进会话的树）**且被推成 `in_progress`** —— 孩子已经在干它了。
 */
it('run 真的能派活：启动请求进了 startContinuable，节点建成并被推成 in_progress', async () => {
  const ledger = freshLedgerFile()
  const parent = { session: { id: SESSION } }
  const h = harness({ tree: true, runsFile: ledger, parentAgent: parent })

  const result = await run(h.tool, {
    action: 'run',
    run: 'r1',
    nodes: [{ id: 'A', prompt: '把 A 干完', label: '实现' }],
  }, makeCaller([]))

  // ① 孩子真的起来了：启动请求进了那条唯一的孩子创建通道。
  assert.equal(h.starts.length, 1, '必须真的走了一次 startContinuable')
  const spec = h.starts[0] as { label?: string; request?: { parent?: unknown; prompt?: readonly { text?: string }[] } }
  // 宿主侧用的是 agent.agent（带 deriveMessages 的那个），所以这里钉身份而不是钉引用。
  assert.equal((spec.request?.parent as { session?: { id?: string } })?.session?.id, SESSION,
    'request.parent 必须是当刻活着的那条会话的 Agent 本身')
  // 显示名由**生效的身份键**决定（没点名 preset ⇒ lead），不是调用方自由填的 label：
  // 面板上那个名字只有对上真正跑的身份才有意义。
  assert.equal(spec.label, '中枢', '身份显示名要挂在这条通道上')
  const brief = spec.request?.prompt?.[0]?.text ?? ''
  assert.ok(brief.startsWith('把 A 干完'), '简报本体原样在最前面：' + brief)
  assert.ok(brief.includes('【节点状态】'), '节点状态指令必须一起送出去：' + brief)

  // ② 返回值把这一批算作已派出。
  assert.deepStrictEqual(result, { status: 'running', run: 'r1', dispatched: ['A'] })

  // ③ 节点建成、且已经是 in_progress（孩子开始干了，它不是还躺在 pending 上）。
  const node = h.treeNodes.find(item => item.id === 'A')
  assert.ok(node !== undefined, 'run 声明的节点必须真的写进了树')
  assert.strictEqual(node?.assignedTo, 'child-1', '节点要绑到这次派出去的那个孩子上')
  assert.strictEqual(node?.status, 'in_progress', '派完就是 in_progress —— 参数描述承诺的迁移必须真发生')
  assert.ok(h.treeCalls.includes('write:sess-1:false'), '先写树再派活：' + JSON.stringify(h.treeCalls))

  // 账本也落了：重启之后这条 run 还在，节点是 dispatched 而不是 pending。
  const recorded = ledgerNode(ledger, 'A') as { status?: string; childId?: string } | undefined
  assert.strictEqual(recorded?.status, 'dispatched')
  assert.strictEqual(recorded?.childId, 'child-1')
})

it('派发失败留下的 detail：把原因修好、重新评估并成功派发之后被换成一行「已派发」', async () => {
  const ledger = freshLedgerFile()
  const history: FakeMessage[] = []
  const parent = { session: { id: SESSION, deriveMessages: () => history } }
  const h = harness({ tree: true, runsFile: ledger, parentAgent: parent })
  // r1 只负责触发 advanceRuns；r2 的 P 起步就派不出去（preset 不存在）。
  await startRun(h.tool, [{ id: 'X', prompt: 'x' }], 'r1')
  const first = await startRun(h.tool, [{ id: 'P', prompt: 'p', preset: 'no-such-preset' }], 'r2')
  assert.deepStrictEqual(first.dispatched, [], '起步就派不出去')
  const failedDetail = String(h.treeNodes.find(node => node.id === 'P')?.detail)
  assert.ok(failedDetail.startsWith('派发失败：'), failedDetail)
  assert.ok(String(ledgerNode(ledger, 'P', 'r2')?.note).startsWith('派发失败：'))
  // 把那个坏 preset 从账本里去掉（= 现场把它修好了）：下一次结算就会重新评估这个 pending 节点。
  patchLedgerNode(ledger, 'r2', 'P', { preset: undefined })
  history.push(fakeSettle('child-1', settlementBody(hostSummary('child-1', 'completed'), 'X 干完了。')))
  await fireEvent(h.listeners, 'session/event', fakeSession(SESSION, history), settledEvent('child-1'))
  const p = h.treeNodes.find(node => node.id === 'P')
  assert.equal(p?.assignedTo, 'child-2', '修好之后被派出去')
  assert.equal(p?.detail, '已派发', '这个节点没有上游结论 ⇒ 只写「已派发」')
  assert.equal(ledgerNode(ledger, 'P', 'r2')?.note, undefined, '账本里的陈旧原因同样清掉')
})


/* ==========================================================================
 * 第五阶段：结论落账本（抗压缩）+ 显式重试入口（2026-10-01 第二轮拍板）
 *
 *   A) 结算正文在**结算那一刻**写进账本节点的 `conclusion`；注入侧优先用它，
 *      账本没有（改动前完成的旧节点）才退回会话历史。历史被压缩不再造成下游永久阻塞。
 *   B) `task(action='run', run='<已存在的 id>', retry=true)`：只重评估既有 run 的待办，
 *      不写树、不重声明、不重置任何状态。
 * ========================================================================== */

it('结论落账本：结算后账本节点带着结算正文；把会话历史清空之后下游照样拿得到，不阻塞', async () => {
  const ledger = freshLedgerFile()
  const history: FakeMessage[] = []
  const parent = { session: { id: SESSION, deriveMessages: () => history } }
  const h = harness({ tree: true, runsFile: ledger, parentAgent: parent })
  // B 依赖 A 与 C：A 先结算时 B 还被 C 挡着，于是「历史被清空」这件事发生在 B 被评估**之前**。
  await startRun(h.tool, [
    { id: 'A', prompt: 'A 的活' },
    { id: 'C', prompt: 'C 的活' },
    { id: 'B', prompt: 'B 的活', needs: ['A', 'C'] },
  ], 'r1')
  const bodyA = settlementBody(hostSummary('child-1', 'completed'), 'A 的结论正文：甲。')
  const bodyC = settlementBody(hostSummary('child-2', 'completed'), 'C 的结论正文：丙。')
  history.push(fakeSettle('child-1', bodyA))
  await fireEvent(h.listeners, 'session/event', fakeSession(SESSION, history), settledEvent('child-1'))
  assert.equal(ledgerNode(ledger, 'A', 'r1')?.conclusion, bodyA, '结算正文必须落进账本，逐字一致')
  assert.equal(ledgerNode(ledger, 'A', 'r1')?.status, 'completed')
  assert.equal(h.treeNodes.find(node => node.id === 'B')?.assignedTo, undefined, 'C 还没完成，B 还得等')

  // 模拟「上下文被压缩」：历史里那条 child-1 的结算通知**整个消失**。
  history.length = 0
  history.push(fakeSettle('child-2', bodyC))
  await fireEvent(h.listeners, 'session/event', fakeSession(SESSION, history), settledEvent('child-2'))

  assert.equal(history.some(message => message.source.senderSessionId === 'child-1'), false,
    '历史里已经没有 child-1 的结算通知了 —— 下面那份只可能来自账本')
  assert.equal(h.treeNodes.find(node => node.id === 'B')?.assignedTo, 'child-3', '历史没了也照样放行')
  const brief = briefOf(h.starts[2])
  assert.ok(brief.includes(bodyA), 'A 的结论来自账本：' + brief)
  assert.ok(brief.includes(bodyC), 'C 的结论来自账本')
  assert.ok(brief.includes('—— 节点 A（child child-1）——'), '排版没变：仍是这一套小标题')
  assert.ok(brief.includes('—— 节点 C（child child-2）——'))
  assert.ok(brief.indexOf('—— 节点 A（child child-1）——') < brief.indexOf('—— 节点 C（child child-2）——'),
    '顺序仍是 needs 的声明顺序')
})

it('结论落账本的上限：>20000 字截断并注明，且「账本里的」与「下游拿到的」逐字相同、只截一次', async () => {
  const ledger = freshLedgerFile()
  const history: FakeMessage[] = []
  const parent = { session: { id: SESSION, deriveMessages: () => history } }
  const h = harness({ tree: true, runsFile: ledger, parentAgent: parent })
  await startRun(h.tool, [{ id: 'A', prompt: 'A 的活' }, { id: 'B', prompt: 'B 的活', needs: ['A'] }], 'r1')
  const bodyA = settlementBody(hostSummary('child-1', 'completed'), '巨'.repeat(21000) + '超出上限的那一段')
  assert.ok(bodyA.length > 20000)
  history.push(fakeSettle('child-1', bodyA))
  await fireEvent(h.listeners, 'session/event', fakeSession(SESSION, history), settledEvent('child-1'))
  const stored = String(ledgerNode(ledger, 'A', 'r1')?.conclusion)
  assert.ok(stored.startsWith(bodyA.slice(0, 20000)), '前 20000 字一字不少')
  assert.ok(stored.endsWith('…（上游结论已截断，原文 ' + String(bodyA.length) + ' 字）'), stored.slice(-60))
  const brief = briefOf(h.starts[1])
  assert.ok(brief.includes(stored), '账本里的那一份与下游拿到的逐字相同')
  assert.equal((brief.match(/（上游结论已截断，原文 /gu) ?? []).length, 1, '只许有一个截断记号，不许叠第二层')
})

it('兼容：账本里没有 conclusion 的旧节点，注入侧退回会话历史', async () => {
  const ledger = freshLedgerFile()
  const history: FakeMessage[] = []
  const parent = { session: { id: SESSION, deriveMessages: () => history } }
  const h = harness({ tree: true, runsFile: ledger, parentAgent: parent })
  await startRun(h.tool, [{ id: 'A', prompt: 'a' }, { id: 'B', prompt: 'b', needs: ['A'] }], 'r1')
  // 造一个「本次改动之前完成的节点」：completed + 有 childId，但账本里**没有** conclusion。
  patchLedgerNode(ledger, 'r1', 'A', { status: 'completed' })
  await startRun(h.tool, [{ id: 'X', prompt: 'x' }], 'r2')
  const bodyA = settlementBody(hostSummary('child-1', 'completed'), 'A 的结论正文：甲。')
  history.push(fakeSettle('child-1', bodyA))
  history.push(fakeSettle('child-2', settlementBody(hostSummary('child-1', 'completed'), 'X 干完了。')))
  await fireEvent(h.listeners, 'session/event', fakeSession(SESSION, history), settledEvent('child-2'))
  assert.equal(ledgerNode(ledger, 'A', 'r1')?.conclusion, undefined, '这个旧节点账本里确实没有结论')
  assert.equal(h.treeNodes.find(node => node.id === 'B')?.assignedTo, 'child-3', '退回历史之后照样放行')
  assert.ok(briefOf(h.starts[2]).includes(bodyA), '旧节点走的是历史那一条路')
})

it('retry：阻塞 → 把原因修好 → 重评估派出；全程不写树、不重声明（账本里没有重复 run）', async () => {
  const ledger = freshLedgerFile()
  const parent = { session: { id: SESSION, deriveMessages: () => [] } }
  const h = harness({ tree: true, runsFile: ledger, parentAgent: parent })
  await startRun(h.tool, [{ id: 'P', prompt: 'p' }, { id: 'Q', prompt: '用 {{P}}', needs: ['P'] }], 'r1')
  // 「依赖完成了、但账本里既没有 childId 也没有结论」——取不到上游正文的最小模型。
  patchLedgerNode(ledger, 'r1', 'P', { status: 'completed', childId: undefined })
  const before = h.treeCalls.length
  const blocked = await run(h.tool, { action: 'run', run: 'r1', retry: true }, caller)
  assert.deepStrictEqual(blocked, { status: 'running', run: 'r1', dispatched: [] },
    '取不到结论 ⇒ 这一轮派不出去，但 retry 本身不报错')
  assert.deepStrictEqual(h.treeCalls.slice(before).filter(call => call.startsWith('write:')), [],
    'retry 绝不写树（不重声明）：' + JSON.stringify(h.treeCalls.slice(before)))
  assert.ok(String(h.treeNodes.find(node => node.id === 'Q')?.detail).startsWith('结论缺失：'))
  assert.ok(String(ledgerNode(ledger, 'Q', 'r1')?.note).startsWith('结论缺失：'))

  // 把结论直接补进账本（= 现场把阻塞的原因修好了）：这一次 Q 的上游只可能来自账本 ——
  // 这个 harness 的父会话历史是空的，`settledNotice` 一个字都取不到。
  patchLedgerNode(ledger, 'r1', 'P', { conclusion: 'P 的结论正文：修好了。' })
  const after = h.treeCalls.length
  const retried = await run(h.tool, { action: 'run', run: 'r1', retry: true }, caller)
  assert.deepStrictEqual(retried, { status: 'running', run: 'r1', dispatched: ['Q'] })
  const q = h.treeNodes.find(node => node.id === 'Q')
  assert.equal(q?.assignedTo, 'child-2', '重评估之后 Q 被派出去了')
  assert.equal(q?.detail, '已派发：上游结论已注入', '陈旧的「结论缺失：」被换成一行事实')
  assert.ok(briefOf(h.starts[1]).includes('P 的结论正文：修好了。'), briefOf(h.starts[1]))
  assert.deepStrictEqual(h.treeCalls.slice(after).filter(call => call.startsWith('write:')), [],
    'retry 绝不写树：' + JSON.stringify(h.treeCalls.slice(after)))
  assert.equal(ledgerRuns(ledger).length, 1, 'retry 绝不 store：账本里不许出现同 id 的第二条 run')
  assert.equal(ledgerNode(ledger, 'P', 'r1')?.status, 'completed', '已判终态的节点一个都不许被重置')
  assert.equal(ledgerNode(ledger, 'Q', 'r1')?.status, 'dispatched')
})

it('retry 的三条边界：run 不存在 ⇒ 抛；retry+nodes ⇒ 抛（中枢自定）；没有待办 ⇒ 空 dispatched 且不抛', async () => {
  const ledger = freshLedgerFile()
  const h = harness({ tree: true, runsFile: ledger, parentAgent: { session: { id: SESSION } } })
  await startRun(h.tool, [{ id: 'A', prompt: 'a' }], 'r1')
  const before = h.treeCalls.length
  await assert.rejects(
    () => run(h.tool, { action: 'run', run: 'ghost', retry: true }, caller),
    /task run: retry 需要一条已存在的 run，这条会话里没有 "ghost"（已知: r1）/, 
  )
  await assert.rejects(
    () => run(h.tool, { action: 'run', run: 'r1', retry: true, nodes: [{ id: 'Z', prompt: 'z' }] }, caller),
    /retry 只重评估既有 run 的待办节点，不接受 `nodes`/,
  )
  // 这条入口必须**在 schema 里真的可传**：模型拿不到这个参数的话，上面那些行为一行也跑不到。
  const properties = h.tool.parameters.properties as { retry?: { type?: string } }
  assert.equal(properties.retry?.type, 'boolean', 'retry 必须是 boolean 参数')
  const idle = await run(h.tool, { action: 'run', run: 'r1', retry: true }, caller)
  assert.deepStrictEqual(idle, { status: 'running', run: 'r1', dispatched: [] },
    '没有待办就不报错，只回一个空的 dispatched')
  assert.deepStrictEqual(h.treeCalls.slice(before), [], '这三次调用一个字节都不许写树：' + JSON.stringify(h.treeCalls.slice(before)))
  assert.equal(ledgerRuns(ledger).length, 1, '账本里仍然只有那一条 run')
  assert.equal(ledgerNode(ledger, 'A', 'r1')?.status, 'dispatched', '已派出的节点不许被 retry 重置')
})


/* ==========================================================================
 * 第六阶段：重复派发的窗口（H1）、结论两条来源对齐（H4）、续跑入口（R）
 *
 *   H1：`commit` 契约是**绝不抛**（写不动就返回 false）。孩子已经起来、账本没记住时，
 *       **绝不回滚成 pending**（那会再派一个，白吃名册格），改为进程内登记 + 补账本。
 *   H4：同一个 childId 的第二条结算只**覆盖结论文本**，status 一个字不动。
 *   R：`resume=<节点 id>` 把已派出没干成的节点交回**它原来那个孩子**接着干。
 * ========================================================================== */

it('H1：孩子起来了、账本却没记住 ⇒ 不回滚、不再派第二个；内存表命中只补账本，补上就清表', async () => {
  const ledger = freshLedgerFile()
  let started = 0
  let snapshot = ''
  const h = harness({
    tree: true,
    runsFile: ledger,
    parentAgent: { session: { id: SESSION } },
    // 第 2 次派发（= B）的那一刻把账本清空：于是紧接着那次 `commit` 读不到这条 run，
    // `patchRunNode` 无从下手、commit 如实返回 false —— 正是「写盘没落地」的可观测模型。
    beforeStart: () => {
      started += 1
      if (started === 2) {
        snapshot = readFileSyncNode(ledger, 'utf8')
        writeFileSyncNode(ledger, '{}', 'utf8')
      }
    },
  })
  await startRun(h.tool, [{ id: 'A', prompt: 'a' }, { id: 'B', prompt: 'b', needs: ['A'] }], 'r1')
  // 让 B 可派：A 直接标 completed（结论也一并给上，免得又要去历史里找 —— 那条路另有用例）。
  patchLedgerNode(ledger, 'r1', 'A', { status: 'completed', conclusion: 'A 的结论正文：甲。' })
  const first = await run(h.tool, { action: 'run', run: 'r1', retry: true }, caller)
  assert.deepStrictEqual(first.dispatched, ['B'], '孩子确实起来了，就按派出算（绝不假装没派）')
  assert.equal(h.starts.length, 2, '到此刻为止只起过两个孩子：A 与 B')

  // 把账本恢复成「那次写入没落地」的样子：B 仍是 pending、没有 childId。
  writeFileSyncNode(ledger, snapshot, 'utf8')
  assert.equal(ledgerNode(ledger, 'B', 'r1')?.status, 'pending', '账本那一次写入确实没落地')
  assert.equal(ledgerNode(ledger, 'B', 'r1')?.childId, undefined)
  assert.equal(h.treeNodes.find(node => node.id === 'B')?.detail, '已派发但账本未确认：child child-2',
    '树 detail 必须说清「孩子已经起来了」')

  // 内存表命中：只补账本，**绝不再派**。
  const second = await run(h.tool, { action: 'run', run: 'r1', retry: true }, caller)
  assert.deepStrictEqual(second.dispatched, ['B'])
  assert.equal(h.starts.length, 2, '绝不新派第二个孩子')
  assert.equal(ledgerNode(ledger, 'B', 'r1')?.status, 'dispatched', '补记成功')
  assert.equal(ledgerNode(ledger, 'B', 'r1')?.childId, 'child-2', '补记的是**原来那个**孩子')
  assert.equal(h.treeNodes.find(node => node.id === 'B')?.detail, '已派发：上游结论已注入',
    '账本补上之后那行事实也要改成「已派发」')

  // 表项必须已经清掉：把 B 手工退回 pending 再评估，走的应当是**正常派发**（新孩子），
  // 而不是去重试一个早该作废的表项（那样会一直补记同一个旧 childId）。
  patchLedgerNode(ledger, 'r1', 'B', { status: 'pending', childId: undefined })
  const third = await run(h.tool, { action: 'run', run: 'r1', retry: true }, caller)
  assert.deepStrictEqual(third.dispatched, ['B'])
  assert.equal(h.starts.length, 3, '表项已清 ⇒ 这是一个普通的待办节点')
  assert.equal(ledgerNode(ledger, 'B', 'r1')?.childId, 'child-3', '新派出去的是新孩子')
})

it('H4：同一个 childId 的第二条结算 ⇒ 只覆盖账本结论，status 一个字不变（completed 与 failed 都算）', async () => {
  const ledger = freshLedgerFile()
  const history: FakeMessage[] = []
  const parent = { session: { id: SESSION, deriveMessages: () => history } }
  const h = harness({ tree: true, runsFile: ledger, parentAgent: parent })
  await startRun(h.tool, [{ id: 'A', prompt: 'a' }, { id: 'C', prompt: 'c' }], 'r1')
  const firstA = settlementBody(hostSummary('child-1', 'completed'), 'A 的结论：第一版。')
  const firstC = settlementBody(hostSummary('child-2', 'error'), 'C 的结论：第一版。')
  history.push(fakeSettle('child-1', firstA))
  history.push(fakeSettle('child-2', firstC))
  const session = fakeSession(SESSION, history)
  await fireEvent(h.listeners, 'session/event', session, settledEvent('child-1'))
  await fireEvent(h.listeners, 'session/event', session, settledEvent('child-2'))
  assert.equal(ledgerNode(ledger, 'A', 'r1')?.conclusion, firstA)
  assert.equal(ledgerNode(ledger, 'A', 'r1')?.status, 'completed')
  assert.equal(ledgerNode(ledger, 'C', 'r1')?.conclusion, firstC)
  assert.equal(ledgerNode(ledger, 'C', 'r1')?.status, 'failed')

  // 第二条通知（现实里来自 `send` 续跑之后那个孩子又结算了一次）：结论必须换成最新那一份 ——
  // 历史回退路径（settledNotice 倒着扫）取的就是最新那条，两条路的口径必须对齐。
  const secondA = settlementBody(hostSummary('child-1', 'completed'), 'A 的结论：第二版。')
  const secondC = settlementBody(hostSummary('child-2', 'error'), 'C 的结论：第二版。')
  history.push(fakeSettle('child-1', secondA))
  history.push(fakeSettle('child-2', secondC))
  await fireEvent(h.listeners, 'session/event', session, settledEvent('child-1'))
  await fireEvent(h.listeners, 'session/event', session, settledEvent('child-2'))
  assert.equal(ledgerNode(ledger, 'A', 'r1')?.conclusion, secondA, '账本结论取最新那一份')
  assert.equal(ledgerNode(ledger, 'A', 'r1')?.status, 'completed', '终态不许被晚到的结算改写')
  assert.equal(ledgerNode(ledger, 'A', 'r1')?.childId, 'child-1', 'childId 也不许动')
  assert.equal(ledgerNode(ledger, 'C', 'r1')?.conclusion, secondC, 'failed 那一支同样只换结论')
  assert.equal(ledgerNode(ledger, 'C', 'r1')?.status, 'failed')
})

it('resume：把节点交回它原来那个孩子接着干 —— 不新派、账本重新置 dispatched、note 清空、结论不动', async () => {
  const ledger = freshLedgerFile()
  const h = harness({ tree: true, runsFile: ledger, parentAgent: { session: { id: SESSION } } })
  await startRun(h.tool, [{ id: 'A', prompt: 'A 的活' }, { id: 'B', prompt: 'B 的活', needs: ['A'] }], 'r1')
  // 造出「B 已经派出过、但没干成」的状态：账本上有 childId、note 里留着上次的原因。
  patchLedgerNode(ledger, 'r1', 'A', { status: 'completed', conclusion: 'A 的结论正文：甲。' })
  patchLedgerNode(ledger, 'r1', 'B', { status: 'failed', childId: 'child-9', note: '陈旧的失败原因' })
  const resumed = await run(h.tool, { action: 'run', run: 'r1', resume: 'B' }, caller)
  assert.deepStrictEqual(resumed, { status: 'running', task_id: 'child-9', node: 'B' })
  assert.equal(h.starts.length, 1, 'resume 绝不新派：创建通道一次都没再被调用')
  assert.equal(h.sent.length, 1, '唤醒走的正是 sendMessage')
  const wake = h.sent[0]
  assert.equal(wake?.target, 'child-9', '唤醒的是**它原来那个**孩子')
  const wakeBlocks = wake?.content as readonly { readonly text?: string }[] | undefined
  const text = String(wakeBlocks?.[0]?.text ?? '')
  assert.ok(text.includes('不要在结语里写'), '续跑文案必须重申「不要写状态行」：' + text)
  assert.ok(text.includes('A 的结论正文：甲。'), '简报按同一套拼装重填了上游结论：' + text)
  assert.ok(text.includes('B 的活'), '框架原文还在')
  const stored = ledgerNode(ledger, 'B', 'r1')
  assert.equal(stored?.status, 'dispatched', '账本重新置成 dispatched')
  assert.equal(stored?.childId, 'child-9', 'childId 保持')
  assert.equal(stored?.note, undefined, 'note 清空')
  assert.equal(stored?.conclusion, undefined, '结论本来就没有，不许被无中生有')
  assert.equal(h.treeNodes.find(node => node.id === 'B')?.status, 'in_progress', '树状态置 in_progress')
  assert.equal(h.treeNodes.find(node => node.id === 'B')?.detail, '已续跑：child child-9')

  // 上游结论取不到 ⇒ **一个字都不发**，只留痕。把 A 的结论拿掉，并把历史留空。
  patchLedgerNode(ledger, 'r1', 'A', { conclusion: undefined, childId: undefined })
  const blocked = await run(h.tool, { action: 'run', run: 'r1', resume: 'B' }, caller)
  assert.equal(h.sent.length, 1, '取不到上游结论 ⇒ 绝不发消息')
  assert.equal(blocked.status, 'pending')
  assert.equal(blocked.node, 'B')
  assert.ok(String(blocked.result).startsWith('结论缺失：'), String(blocked.result))
  assert.ok(String(h.treeNodes.find(node => node.id === 'B')?.detail).startsWith('结论缺失：'))
  assert.ok(String(ledgerNode(ledger, 'B', 'r1')?.note).startsWith('结论缺失：'))
  assert.equal(ledgerNode(ledger, 'B', 'r1')?.status, 'dispatched', '阻塞**绝不**把它改回 pending（那会变成新派一个）')
})

it('resume 的五条边界：run 不存在 / 节点不在 run 里 / 没 childId / 已 completed / 与 retry 或 nodes 同给 —— 全部抛且不发消息', async () => {
  const ledger = freshLedgerFile()
  const h = harness({ tree: true, runsFile: ledger, parentAgent: { session: { id: SESSION } } })
  await startRun(h.tool, [{ id: 'A', prompt: 'a' }, { id: 'B', prompt: 'b', needs: ['A'] }], 'r1')
  const before = h.treeCalls.length
  await assert.rejects(
    () => run(h.tool, { action: 'run', run: 'ghost', resume: 'B' }, caller),
    /task run: resume 需要一条已存在的 run，这条会话里没有 "ghost"（已知: r1）/,
  )
  await assert.rejects(
    () => run(h.tool, { action: 'run', run: 'r1', resume: 'ghost' }, caller),
    /task run: 这条 run 里没有节点 "ghost"（已知节点: A, B）/,
  )
  await assert.rejects(
    () => run(h.tool, { action: 'run', run: 'r1', resume: 'B' }, caller),
    /task run: 节点 "B" 账本上没有 childId —— 它从来没有被派出去过，放行它请用 retry/,
  )
  patchLedgerNode(ledger, 'r1', 'B', { childId: 'child-7', status: 'completed' })
  await assert.rejects(
    () => run(h.tool, { action: 'run', run: 'r1', resume: 'B' }, caller),
    /task run: 节点 "B" 已经 completed/,
  )
  await assert.rejects(
    () => run(h.tool, { action: 'run', run: 'r1', resume: 'B', retry: true }, caller),
    /task run: retry 与 resume 不能同时给/,
  )
  await assert.rejects(
    () => run(h.tool, { action: 'run', run: 'r1', resume: 'B', nodes: [{ id: 'Z', prompt: 'z' }] }, caller),
    /task run: resume 只续跑既有节点，不接受 `nodes`/,
  )
  assert.equal(h.sent.length, 0, '一次都不许发消息')
  assert.deepStrictEqual(h.treeCalls.slice(before), [], '一次都不许写树：' + JSON.stringify(h.treeCalls.slice(before)))
  assert.equal(ledgerRuns(ledger).length, 1, '账本里仍然只有那一条 run')
})

it('工具面只留直连：没有 channel / name 参数，resume 也不提名册', () => {
  const { tool } = harness()
  const properties = tool.parameters.properties as Record<string, unknown>
  const nodeItems = (properties.nodes as { items?: { properties?: Record<string, unknown> } }).items?.properties ?? {}
  // Agent Teams 摘掉之后这两格没有落点了：通道只有直连一条，名字只有 label 一个槽。
  assert.equal(nodeItems.channel, undefined, 'run 节点不许再有 channel 参数')
  assert.equal(nodeItems.name, undefined, 'run 节点不许再有 name 参数')
  assert.equal(properties.channel, undefined, 'dispatch 不许再有 channel 参数')
  assert.equal(properties.name, undefined, 'dispatch 不许再有 name 参数')
  assert.equal((properties.label as { type?: string } | undefined)?.type, 'string', 'label 留着：它是面板上的活名')
  const resume = properties.resume as { description?: string } | undefined
  assert.equal(String(resume?.description).includes('名册'), false, 'resume 描述里不许再提名册')
})

it('resume 必须在 schema 里真的可传：它是 string 参数', () => {
  const { tool } = harness()
  const properties = tool.parameters.properties as { resume?: { type?: string } }
  assert.equal(properties.resume?.type, 'string', 'resume 必须是 string 参数（节点 id）')
})

/**
 * 一个能接住 `agent/created` 的假子代理：只为断言「遮蔽版提问工具真的装上了」。
 * @param id - 子会话 id（= `agent.id`，登记表用的就是这个键）。
 * @returns 假 Agent 与它作用域里注册过的工具。
 */
function fakeChildAgent(id: string): { agent: Record<string, unknown>; tools: Record<string, unknown>[] } {
  const tools: Record<string, unknown>[] = []
  return {
    tools,
    agent: {
      id,
      session: { id },
      ctx: {
        tools: { register: (definition: Record<string, unknown>) => { tools.push(definition); return () => {} } },
        systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
      },
    },
  }
}

it('直连派发：流水线起点立刻出去，提问透传照旧装上', async () => {
  const ledger = freshLedgerFile()
  const parent = { id: 'lead-1', session: { id: SESSION, header: { delegationDepth: 0 } } }
  const h = harness({ tree: true, runsFile: ledger, parentAgent: parent })
  const result = await run(
    h.tool,
    { action: 'run', run: 'r1', nodes: [{ id: 'A', prompt: 'a' }] },
    { agent: parent, signal: AbortSignal.timeout(200) },
  )
  assert.deepStrictEqual(result.dispatched, ['A'])
  assert.equal(h.starts.length, 1, '派发只走 ctx.subagents.startContinuable')
  assert.equal(h.treeNodes.find(node => node.id === 'A')?.assignedTo, 'child-1')
  // 提问透传与白名单是**同一条缝**（agent/created 里按 childId 查表）。
  const child = fakeChildAgent('child-1')
  await fireEvent(h.listeners, 'agent/created', { agent: child.agent })
  assert.ok(child.tools.some(tool => tool.name === 'ask_user_question'),
    '遮蔽版提问工具必须照旧装上，实际装了：' + JSON.stringify(child.tools.map(tool => tool.name)))
})


/**
 * 跑一遍 `system-prompt/assemble`，拿回装配结果 —— 假件照真实形状给：
 * `next()` 交出 `{ sections, tools }`，`context` 里带着 `agent`
 * （宿主 `assembleContextFor` 造出来的正是 `{ agent, scope, ... }`）。
 *
 * 同时把 `produced` 原对象也交回来：**「一个字都不许变」这句话只能靠引用相等来断言**
 * （监听器不适用时必须原样返回 `next()` 的那个引用，而不是造一个等值的新对象）。
 * @param listeners - apply 注册的监听器表。
 * @param sid - 这次装配属于哪条会话。
 * @returns 原对象与装配结果。
 */
async function assembleFor(
  listeners: readonly { event: string; handler: (...args: never[]) => unknown }[],
  sid: string,
): Promise<{ produced: Record<string, unknown>; result: Record<string, unknown> }> {
  const produced = { sections: [{ name: 'harness:identity', text: '你是中枢。' }], tools: [] as unknown[] }
  const context = { agent: { session: { id: sid } } }
  const entries = listeners.filter(item => item.event === 'system-prompt/assemble')
  assert.ok(entries.length > 0, 'apply 必须订阅 system-prompt/assemble')
  // 按**注册顺序**串成瀑布：每个监听器的 `next()` 落到下一个，最后落到 produced。
  // 只调第一个是不够的 —— 真实宿主走的是整条链，后面注册的监听器（这一段提醒就是）
  // 正是靠前面的 `next()` 才被调到。
  const step = (index: number): (() => Promise<unknown>) => async () => {
    const entry = entries[index]
    if (entry === undefined) return produced
    const handler = entry.handler as unknown as (assembly: unknown, ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>
    return await handler(undefined, context, step(index + 1))
  }
  const result = await step(0)()
  return { produced, result: result as Record<string, unknown> }
}

it('过程记录提醒（2026-10-01 冻结 v3）：只进「本插件派出的子代理」的提示词，中枢自己与别的会话逐字不变', async () => {
  const ledger = freshLedgerFile()
  const h = harness({ tree: true, runsFile: ledger, parentAgent: { session: { id: SESSION } } })
  await startRun(h.tool, [{ id: 'A', prompt: 'a' }])   // A 是起点，立刻派出 → child-1

  // ① 被本插件派出去的孩子：段表末尾多出那一段提醒，原有段一个字没动。
  const child = await assembleFor(h.listeners, 'child-1')
  const sections = child.result.sections as readonly { name?: string; text?: string }[]
  assert.equal(sections.length, 2, '只追加、不替换：' + JSON.stringify(sections.map(section => section.name)))
  assert.equal(sections[0]?.name, 'harness:identity', '原有段还在原位')
  assert.equal(sections[0]?.text, '你是中枢。', '原有段的文本一个字不许变')
  const reminder = sections[1]
  assert.equal(reminder?.name, 'task:process-nudge')
  const text = String(reminder?.text ?? '')
  // **逐字**：中枢 2026-10-01 冻结的那一段（v3，强制语气、只留三个要求 + 并行许可）。
  // 改一个字这条就会红 —— 这正是它存在的意义。
  // **逐字**：中枢 2026-10-01 冻结的那一段仍在最前，后面**原样追加**一句常驻的隔离纪律。
  // 追加而不是改写：那一段是按「每轮常驻成本」量过的，改它等于把量过的账作废。
  assert.equal(text, '【过程记录（必须）】多步的活：**开工第一步必须**用 `task plan` 在**你自己的任务树**里写下阶段计划（分几段、每段做什么由你自己定）；**每完成一段必须**用 `task step` 推进到 completed，并在 detail 里写下这一段的结论。阶段之间**可以并行**，不要求先后顺序。'
    + '改代码的派发**默认自动**开隔离检出（重试复用同一条线；只读的活传 worktree: "-" 关掉）：提交走 task commit 并如实记录验证方式，合回后跑整套检查、过了才统一提交主线。')
  // 要点逐条点名（文案冻结之后只能用**子串**断言，但每一条都是用户点名要的）。
  assert.ok(text.includes('必须'), '要点：语气是强制的：' + text)
  assert.ok(text.startsWith('【过程记录（必须）】'), '锚点必须逐字在：' + text)
  assert.ok(text.includes('可以并行'), '要点：阶段之间可以并行：' + text)
  assert.ok(text.includes('你自己的任务树'), '要说清写在哪棵树上：' + text)
  assert.ok(text.includes('task plan') && text.includes('task step'), '要点到具体调用形态：' + text)

  // ② 中枢自己：**同一个引用**原样返回 —— 「一个字都不许变」的落点。
  const lead = await assembleFor(h.listeners, SESSION)
  assert.strictEqual(lead.result, lead.produced, '中枢自己的装配必须原样返回 next() 的那个引用')
  assert.equal(JSON.stringify(lead.produced).includes('【阶段建议】'), false, '中枢的提示词里不许出现这一段')

  // ③ 没被本插件派出的会话（宿主自己的子代理 / 别的插件的会话）：同样一个字都不变。
  const stranger = await assembleFor(h.listeners, 'sess-other')
  assert.strictEqual(stranger.result, stranger.produced, '没被派出的会话必须原样返回同一个引用')
  assert.equal(JSON.stringify(stranger.produced).includes('【阶段建议】'), false)
})

/**
 * 造一个**干净的**临时 git 仓，专供「隔离线」那几条用例当会话 cwd。
 *
 * 干净是刻意的：`createWorktree` 对脏检出是**拒绝**。不建出真仓的话，
 * 「默认自动隔离」这件事根本无从断言 —— 起线第一步就是 `git worktree add`。
 * @returns 仓库根目录的绝对路径。
 */
async function repoForLines(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), 'task-line-repo-'))
  await git(repo, ['init', '--quiet'])
  writeFileSyncNode(join(repo, 'README.md'), '# seed\n', 'utf8')
  await git(repo, ['add', '-A'])
  await gitWithIdentity(repo, ['commit', '--no-verify', '-m', 'seed'])
  return repo
}

/**
 * worktree 账本里在飞的线名（排序）。
 * @param file - 账本文件路径。
 * @returns 线名；文件不存在或读不动时是空表。
 */
function lineNames(file: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSyncNode(file, 'utf8'))
  } catch {
    return []
  }
  const items = (parsed as { worktrees?: unknown } | undefined)?.worktrees
  return isPlainRecord(items) ? Object.keys(items).sort() : []
}

/**
 * worktree 账本里某条线的**完整记录**：线名之外的那些字段（比如它是以哪个仓为底）只能从这里读。
 * @param file - 账本文件路径。
 * @param name - 线名。
 * @returns 记录；文件不存在、读不动、没有这条线时是空对象。
 */
function lineRecord(file: string, name: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSyncNode(file, 'utf8')) as { worktrees?: unknown }
    const items = parsed.worktrees
    const record = isPlainRecord(items) ? items[name] : undefined
    return isPlainRecord(record) ? record : {}
  } catch {
    return {}
  }
}

/**
 * 一个**不在任何 git 仓里**的临时目录 —— 本会话 cwd 的真实处境就是它。
 *
 * 前提不成立时当场断言失败，而不是让用例悄悄测到别的东西：TMP 万一整个落在某个仓里，
 * 这条用例测的就不再是「cwd 不是仓」了，那时候红掉比绿掉诚实。
 * @returns 目录的绝对路径。
 */
async function nonRepoDir(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'task-outside-repo-'))
  const top = await git(dir, ['rev-parse', '--show-toplevel'])
  assert.notEqual(top.code, 0, 'precondition: ' + dir + ' 必须不在任何 git 仓里')
  return dir
}

/**
 * 一次**必须失败**的调用的报错对象。
 * @param body - 要跑的调用。
 * @returns 它抛出来的那个错误。
 */
async function failureOf(body: () => Promise<unknown>): Promise<Error> {
  try {
    await body()
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('expected the call to fail, but it resolved')
}

/**
 * 一个把**会话 cwd** 指到某个仓里的假调用者。
 *
 * 会话 cwd 走的是会话 header（`childSessionMeta` 写的就是它），所以这里照真实形状给：
 * `agent.session.header.cwd`。不加这一格的话起线会退回宿主进程的 cwd ——
 * 那是本仓的源码目录，测试会真的在开发者自己的检出上建 worktree。
 * @param repo - 这次会话在哪个仓里干活。
 * @returns 假的 exec。
 */
function callerIn(repo: string): unknown {
  return { agent: { session: { id: SESSION, header: { cwd: repo } } }, signal: AbortSignal.timeout(2000) }
}

it('默认自动：改代码的派发**不给** worktree 也会自己开一条线，简报里带线名与检出路径', async () => {
  const repo = await repoForLines()
  const h = harness({ tree: true, runsFile: freshLedgerFile(), worktreeAuto: true, worktreePrepare: '' })
  // `dispatch` 已收口到 `run`：这条纪律的入口就是 run（声明即建树，起点立刻派出）。
  await run(h.tool, { action: 'run', run: 'a', nodes: [{ id: 'A', prompt: 'go' }] }, callerIn(repo))
  const names = lineNames(h.worktreesFile)
  assert.equal(names.length, 1, '默认档必须自己开出一条线：' + JSON.stringify(names))
  // 线名 = auto-<可读键>-<会话+键的短哈希>：可读的那半给人看，哈希那半保证不撞。
  assert.match(names[0] as string, /^auto-a-[0-9a-f]{8}$/)
  assert.equal(await worktreeMatches(worktreePathFor(repo, names[0] as string), 'wt/' + names[0]), true)
  const brief = briefOf(h.starts[0])
  assert.ok(brief.startsWith('【隔离检出（重要）】'), '简报必须以隔离前言开头：' + brief)
  assert.ok(brief.includes('线名：`' + names[0] + '`'), brief)
  assert.ok(brief.includes(worktreePathFor(repo, names[0] as string)), '检出绝对路径要逐字给出：' + brief)
  assert.ok(brief.includes('go'), '孩子自己的活还在：' + brief)
})

it('显式关闸：worktree: "-" 的派发不建线，一个字节都不写', async () => {
  const repo = await repoForLines()
  const h = harness({ tree: true, runsFile: freshLedgerFile(), worktreeAuto: true, worktreePrepare: '' })
  await run(h.tool, { action: 'run', run: 'a', nodes: [{ id: 'A', prompt: 'go' }], worktree: '-' }, callerIn(repo))
  assert.deepStrictEqual(lineNames(h.worktreesFile), [])
  assert.equal(ledgerFileAbsent(h.worktreesFile), true, '关闸档连账本文件都不该创建')
  assert.equal(h.starts.length, 1, '关闸只关隔离，不关派发')
  assert.ok(!briefOf(h.starts[0]).includes('【隔离检出'), briefOf(h.starts[0]))
})

it('worktreeAuto=false：退回老行为（这一格是显式关掉的，默认是开的）', async () => {
  const repo = await repoForLines()
  const h = harness({ tree: true, runsFile: freshLedgerFile(), worktreePrepare: '' })
  await run(h.tool, { action: 'run', run: 'a', nodes: [{ id: 'A', prompt: 'go' }] }, callerIn(repo))
  assert.deepStrictEqual(lineNames(h.worktreesFile), [])
  assert.ok(!briefOf(h.starts[0]).includes('【隔离检出'), briefOf(h.starts[0]))
})

it('schema 默认值：worktreeAuto 默认 true —— 纪律是默认开的，关掉要显式写', async () => {
  const dict = TaskRowConfig.dict ?? {}
  assert.equal((dict.worktreeAuto as { meta?: { default?: unknown } } | undefined)?.meta?.default, true,
    'worktreeAuto 的默认值必须是 true，否则「默认就走隔离线」只是句口号')
})

it('同名 = 同一条线：第二次同名的派发接着用那条线，不重建、也不撞「分支已存在」', async () => {
  const repo = await repoForLines()
  const h = harness({ tree: true, runsFile: freshLedgerFile(), worktreePrepare: '' })
  await run(h.tool, { action: 'run', run: 'r1', nodes: [{ id: 'A', prompt: 'go' }], worktree: 'line-1' }, callerIn(repo))
  await run(h.tool, { action: 'run', run: 'r2', nodes: [{ id: 'B', prompt: 'go again' }], worktree: 'line-1' }, callerIn(repo))
  assert.deepStrictEqual(lineNames(h.worktreesFile), ['line-1'])
  assert.equal(await worktreeMatches(worktreePathFor(repo, 'line-1'), 'wt/line-1'), true)
  assert.equal(h.starts.length, 2, '两次都真的派出去了')
  assert.ok(briefOf(h.starts[1]).includes('线名：`line-1`'), briefOf(h.starts[1]))
})

it('起线失败就拒派：脏主检出时默认档当场抛，并在报错里给出关闸写法', async () => {
  const repo = await repoForLines()
  writeFileSyncNode(join(repo, 'README.md'), '# dirty\n', 'utf8')
  const h = harness({ tree: true, runsFile: freshLedgerFile(), worktreeAuto: true, worktreePrepare: '' })
  await assert.rejects(
    () => run(h.tool, { action: 'run', run: 'a', nodes: [{ id: 'A', prompt: 'go' }] }, callerIn(repo)),
    /worktree: "-"/,
  )
  assert.equal(h.starts.length, 0, '线起不来 ⇒ 一个孩子都不许派出去（绝不降级成在主检出上跑）')
})

it('run：默认档给整条流水线开一条线，账本里记着这条 run 住在哪条线上', async () => {
  const repo = await repoForLines()
  const ledger = freshLedgerFile()
  const h = harness({ tree: true, runsFile: ledger, worktreeAuto: true, worktreePrepare: '' })
  await run(h.tool, { action: 'run', run: 'r1', nodes: [{ id: 'A', prompt: 'a' }] }, callerIn(repo))
  const names = lineNames(h.worktreesFile)
  assert.equal(names.length, 1, JSON.stringify(names))
  assert.match(names[0] as string, /^auto-r1-[0-9a-f]{8}$/)
  assert.equal(ledgerRuns(ledger)[0]?.worktree, names[0], 'run 必须自带线名：自动放行的后继靠它找回同一份代码')
  assert.ok(briefOf(h.starts[0]).includes('线名：`' + names[0] + '`'), briefOf(h.starts[0]))
})

it('worktreeRepo 没声明：仓根照旧从**本会话 cwd** 归一出来 —— 子目录也要归一到仓根', async () => {
  const repo = await repoForLines()
  // cwd 给的是仓里的**子目录**：这正好证明归一那一跳还在（--show-toplevel），
  // 而不是把 cwd 原样当成仓根拿去建线。
  const sub = join(repo, 'nested')
  mkdirSync(sub)
  const h = harness({ tree: true, runsFile: freshLedgerFile(), worktreeAuto: true, worktreePrepare: '' })
  await run(h.tool, { action: 'run', run: 'a', nodes: [{ id: 'A', prompt: 'go' }] }, callerIn(sub))
  const names = lineNames(h.worktreesFile)
  assert.equal(names.length, 1, JSON.stringify(names))
  const line = names[0] as string
  assert.equal(await worktreeMatches(worktreePathFor(repo, line), 'wt/' + line), true,
    '没声明 worktreeRepo 时，仓根照旧从会话 cwd 归一出来（老行为一个字都不改）')
  assert.equal(resolve(String(lineRecord(h.worktreesFile, line).repo)), resolve(repo),
    '账本里记的仓根必须就是会话 cwd 所在的那个仓')
})

it('worktreeRepo：显式声明以哪个仓为底 —— 会话 cwd 根本不在仓里时，这条线照样起得来', async () => {
  const repo = await repoForLines()
  const outside = await nonRepoDir()
  const h = harness({ tree: true, runsFile: freshLedgerFile(), worktreeAuto: true, worktreePrepare: '' })
  await run(h.tool, { action: 'run', run: 'a', nodes: [{ id: 'A', prompt: 'go' }], worktreeRepo: repo }, callerIn(outside))
  const names = lineNames(h.worktreesFile)
  assert.equal(names.length, 1, JSON.stringify(names))
  const line = names[0] as string
  assert.match(line, /^auto-a-[0-9a-f]{8}$/)
  assert.equal(await worktreeMatches(worktreePathFor(repo, line), 'wt/' + line), true,
    '这条线必须建在 worktreeRepo 声明的那个仓上')
  assert.equal(existsSync(worktreePathFor(outside, line)), false,
    '一条线只该建在声明的仓旁边，不许拿会话 cwd 再去算一份')
  assert.equal(resolve(String(lineRecord(h.worktreesFile, line).repo)), resolve(repo),
    '账本里记的仓根必须是声明的那个仓')
  assert.ok(briefOf(h.starts[0]).includes(worktreePathFor(repo, line)), briefOf(h.starts[0]))
})

it('worktreeRepo 缺席、会话 cwd 又不在仓里：当场拒，报错点名这个参数并写出本会话 cwd 到底是什么', async () => {
  const outside = await nonRepoDir()
  const h = harness({ tree: true, runsFile: freshLedgerFile(), worktreeAuto: true, worktreePrepare: '' })
  const failure = await failureOf(() => run(h.tool, { action: 'run', run: 'a', nodes: [{ id: 'A', prompt: 'go' }] }, callerIn(outside)))
  assert.ok(failure.message.includes('请在这条 run 的派发里补上 `worktreeRepo: "<仓库路径>"`'),
    '报错要指名道姓地说清该补哪一格：' + failure.message)
  assert.ok(failure.message.includes('**本会话的 cwd** `' + outside + '` 不在任何 git 仓库里'),
    '报错要把本会话的 cwd 到底是什么写出来：' + failure.message)
  // git 的原文一个字都不许丢：这一条钉的是「没声明的老路径没被改坏」。
  assert.ok(failure.message.includes(' is not inside a git worktree (git rev-parse --show-toplevel failed:'),
    '原来那句就地保留：' + failure.message)
  assert.equal(h.starts.length, 0, '线起不来 ⇒ 一个孩子都不许派出去')
})

it('worktreeRepo：声明的路径不是仓时当场拒，报错同样点名这个参数', async () => {
  const repo = await repoForLines()
  const outside = await nonRepoDir()
  const h = harness({ tree: true, runsFile: freshLedgerFile(), worktreeAuto: true, worktreePrepare: '' })
  const failure = await failureOf(() => run(h.tool,
    { action: 'run', run: 'a', nodes: [{ id: 'A', prompt: 'go' }], worktreeRepo: outside }, callerIn(repo)))
  assert.ok(failure.message.includes('`worktreeRepo` 声明的 `' + outside + '` 不是一个 git 工作区'),
    '声明的仓不对时也要把参数名点出来，别只丢 git 原文：' + failure.message)
  assert.deepStrictEqual(lineNames(h.worktreesFile), [], '起线没成功就不该留下任何线')
  assert.equal(h.starts.length, 0, '线起不来 ⇒ 一个孩子都不许派出去')
})

it('commit：点名一条不存在的线当场抛，并把在飞的线列出来', async () => {
  const h = harness({ tree: true, runsFile: freshLedgerFile() })
  await assert.rejects(
    () => run(h.tool, { action: 'commit', line: 'nope', units: ['u'] }, makeCaller()),
    /no isolated line named "nope"/,
  )
})


/**
 * 本轮功能的三块单测：`qa_thread`、提问卡片正文的**逐字**纪律、`task` 的回显。
 *
 * 为什么单独一个文件而不是往既有的三份里塞：既有的 harness 都只**抓最后一个**
 * 注册进工具面的定义（`captured = definition`），而本包现在注册**两个**工具
 * （`qa_thread` 与 `task`）。往它们里加点东西就得先改它们的抓取逻辑 ——
 * 那是「为了新代码去动既有测试」，本轮的纪律不许。所以这里自带一个按名字抓取的 harness。
 *
 * 钉住四件事：
 * 1. `qa_thread` 真的存在、两个参数都必填、派发走的是 `preset: 'explain'`；
 * 2. 问答线程的简报里必须带**用户原话**、背景、以及「一轮一轮用卡片接着问」的指示；
 * 3. 卡片正文**逐字**是模型写的那一句 —— 插件不再往里拼任何历史（曾经拼过一段
 *    「【此前问答】」；那条路已按用户决定撤掉，回看改走子会话里官方提问行的「回顾」）；
 * 4. `task` 的回显把存在的字段排出来、缺席的跳过，且只产出 text 块。
 *
 * ctx 与 Agent 都是本文件里的假件，不碰真机。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { apply, type ResolvedConfig } from '../src/index.ts'

/**
 * 每个 harness 用**自己的账本文件**：在系统临时目录下开一个私有目录，两个路径都经
 * `apply` 的配置交给它（`runsFile` 与 `worktreesFile`）。
 *
 * 为什么必须给：`runsFile: ''` 会走 `ledgerPathFor` 的回退链
 * （配置 → `DSH_TASK_RUNS_FILE` → `ctx.baseUrl` → `DSH_PROFILE_DIR`/`DSH_HOME` → cwd），
 * 而本文件的 ctx 是假件、没有 `baseUrl` —— 于是测试直接写进**用户正在用的真机 profile
 * 账本** `DSH_PROFILE_DIR/task-runs.json`。单跑只是往那个真文件里叠垃圾记录；与其它
 * spec 并发跑时多个进程抢写同一个文件，`session-store` 的原子替换当场抛 `could not be written`。
 * 写法与 `task.spec.ts:110` 的 `freshLedgerFile()` 同源。
 * @returns 一个尚未写过的私有目录里的两个账本路径。
 */
function freshLedgerFiles(): { runsFile: string; worktreesFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'qa-thread-spec-'))
  return { runsFile: join(dir, 'task-runs.json'), worktreesFile: join(dir, 'task-worktrees.json') }
}

/** 抓取注册进工具面的定义。 */
interface Captured {
  readonly name: string
  readonly description?: string
  readonly parameters: {
    readonly properties: Record<string, unknown>
    readonly required?: readonly string[]
  }
  readonly output?: {
    readonly schema?: { readonly properties?: Record<string, unknown> }
    readonly render: (args: unknown, value: unknown) => readonly { readonly type: string; readonly text?: string }[]
  }
  readonly execute: (args: any, exec: any) => Promise<any>
}

/**
 * 从简报里切出一段（段头到下一个段头之间）。
 *
 * 分段是这次改动的要害，所以断言必须**按段落做**：整篇里 `includes` 一次会把
 * 「这一段有」与「另一段也有」混成同一个真值 —— 比如 `答：` 前缀只该在决策那一段被剥掉，
 * 树那一段照原样印 detail，整篇搜就等于什么都没钉住。
 * @param brief - 简报全文。
 * @param heading - 段头（如 `【已裁定的事】`）。
 * @returns 段正文（不含段头那行）；没有这一段时回 null。
 */
function section(brief: string, heading: string): string | null {
  const start = brief.indexOf('\n' + heading + '\n')
  if (start === -1) return null
  const from = start + heading.length + 2
  const rest = brief.slice(from)
  const next = rest.search(/\n【[^】]+】\n/)
  return (next === -1 ? rest : rest.slice(0, next)).replace(/\n+$/, '')
}

/**
 * 一个只够跑通这几条链路的假上下文。
 * @param options - 用户给出的答案、tree 是否可读、tree 服务是否在场。
 * @returns 按名字取工具、造孩子、触发事件的手段，以及可断言的树与提问记录。
 */
function harness(options: {
  readonly answers?: readonly { readonly id: string; readonly selected: readonly string[] }[]
  readonly treeThrows?: boolean
  /** 传 true 时 `ctx.get('taskTree')` 回 undefined —— 树服务**整个缺席**，不是读它时抛。 */
  readonly treeAbsent?: boolean
} = {}) {
  const store = new Map<string, Record<string, any>[]>()
  const nodesOf = (sid: string): Record<string, any>[] => {
    const existing = store.get(sid)
    if (existing !== undefined) return existing
    const fresh: Record<string, any>[] = []
    store.set(sid, fresh)
    return fresh
  }
  const readTree = (sid: string): Record<string, any>[] => {
    if (options.treeThrows === true) throw new Error('tree port is down')
    return nodesOf(sid)
  }
  const port = {
    read: readTree,
    // 合并视图那一路也摆上：`buildDecisions` 与简报里的树段**优先**走它（`readMerged`
    // 缺了才退回 `read`）。不给它的话，这里测到的就不是真机上跑的那条分支。
    readMerged: (sid: string, _maxDepth?: number) => readTree(sid),
    write: async (sid: string, nodes: readonly Record<string, any>[], replace: boolean) => {
      const list = nodesOf(sid)
      if (replace) list.length = 0
      for (const node of nodes) list.push({ ...node })
    },
    step: async (sid: string, id: string, patch: Record<string, unknown>) => {
      const target = nodesOf(sid).find(node => node.id === id)
      if (target !== undefined) Object.assign(target, patch)
    },
    bind: async () => {},
  }
  const listeners: { event: string; handler: (...args: any[]) => unknown }[] = []
  const askCalls: any[] = []
  const warns: string[] = []
  const childTools = new Map<string, Captured[]>()
  const registered = new Map<string, Captured>()
  const starts: any[] = []
  let seq = 0
  const rootAgent: any = { id: 'sess-1', session: { id: 'sess-1', header: { delegationDepth: 0 } } }
  const ctx = {
    agents: { roots: () => [rootAgent] },
    tools: { register: (definition: Captured) => { registered.set(definition.name, definition); return () => {} } },
    get: (key: string) => {
      if (key === 'taskTree') return options.treeAbsent === true ? undefined : port
      if (key === 'userQuestions') {
        return { ask: async (request: any) => { askCalls.push(request); return { answers: options.answers ?? [{ id: 'q1', selected: ['A'] }] } } }
      }
      return undefined
    },
    subagents: {
      resolveMaxDepth: () => undefined,
      startContinuable: async (spec: any) => { starts.push(spec); return { childId: 'child-' + String(++seq) } },
      sendMessage: async () => 'inbox-1',
      interrupt: () => {},
      listChildren: async () => [],
      listDescendants: async () => [],
    },
    logger: { warn: (line: string) => { warns.push(line) } },
    on: (event: string, handler: (...args: any[]) => unknown) => { listeners.push({ event, handler }); return () => {} },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
  }
  apply(ctx as never, {
    provider: 'default',
    defaultRules: 'RULES',
    ...freshLedgerFiles(),
    // 三个身份都要在表里：`explain` 是这一轮新增的，缺了会在 `resolvePreset` 那一步
    // 撞 UnknownPresetError（那正是它该撞的）。
    presets: { recon: { persona: 'R' }, lead: { persona: 'L' }, explain: { persona: 'E', deny: ['edit', 'write', 'task'], maxDepth: 1 } },
  } as unknown as ResolvedConfig)

  const createChild = (id: string): any => {
    const tools: Captured[] = []
    childTools.set(id, tools)
    return {
      id,
      session: { id },
      ctx: {
        tools: { register: (definition: Captured) => { tools.push(definition); return () => {} } },
        systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
      },
    }
  }
  const fire = (event: string, ...args: any[]): void => {
    for (const listener of listeners) if (listener.event === event) listener.handler(...args)
  }
  /** 跑这个孩子作用域里那个遮蔽版提问工具。 */
  const asked = async (child: any, question: string): Promise<any> => {
    const tool = (childTools.get(String(child.id)) ?? []).find(candidate => candidate.name === 'ask_user_question')
    assert.ok(tool !== undefined, '子代理作用域里必须出现遮蔽版 ask_user_question')
    return (tool as Captured).execute({ questions: [{ id: 'q1', question }] }, { agent: child, callId: 'sub-call' })
  }
  return {
    tool: (name: string) => registered.get(name) as Captured,
    rootAgent, createChild, fire, nodesOf, askCalls, asked, starts, warns,
  }
}

it('qa_thread 注册了：只有 question 必填，且描述里写清了触发纪律', () => {
  const h = harness()
  const tool = h.tool('qa_thread')
  assert.ok(tool !== undefined, 'qa_thread 必须注册进工具面')
  const properties = tool.parameters.properties
  // 必填落在**顶层 `required` 数组**上，不是逐属性的 `required: true`（实测：
  // `qa_thread` 编出来的是 `required: ["question"]`）。
  // 这条与既有那份断言的角度不同：它读的是 `parameters.required` 这一个数组。
  const required = (tool.parameters as unknown as { required?: readonly string[] }).required ?? []
  assert.ok(required.includes('question'), 'question 必填')
  // **契约变更**：`background` 从必填改成可选。这条断言是**反向**的，钉住的正是新契约 ——
  // 事实（已裁定的事／任务树现状）由插件在派发那一刻自动抓，调用方只交「想法」，
  // 而想法可以一个字都没有。它若仍必填，主对话就还得每次手写一段，这个活白干。
  assert.equal(required.includes('background'), false, 'background 可选（事实由插件自己抓）')
  assert.equal(required.includes('label'), false, 'label 可选')
  assert.deepStrictEqual(Object.keys(properties).sort(), ['background', 'label', 'question'])
  const text = String(tool.description)
  assert.match(text, /用户要求解释/, '描述要写清「什么时候该用」')
  assert.match(text, /独立新方向/, '描述要写清「什么时候该用」的另一半')
  assert.match(text, /不要为它开线程/, '描述要写清「什么时候不该用」')
  assert.match(text, /提问卡片/, '描述要说清它对用户的出口是提问卡片')
  assert.match(text, /结论会自动回到主对话/, '描述要说清结论怎么回来')
  assert.match(text, /事实由插件自动抓/, '描述要说清事实不用调用方写')
})

it('qa_thread 派发：preset 是 explain、label 默认「问答」、简报里带用户原话与想法与卡片指示', async () => {
  const h = harness()
  const result = await h.tool('qa_thread').execute(
    { question: '这个插件为什么要做成一个 task 工具？', background: '当前在改 packages/task。' },
    { agent: h.rootAgent, callId: 'c1' },
  )
  assert.equal(h.starts.length, 1, '派发只走 ctx.subagents.startContinuable')
  assert.equal(h.starts[0].label, '问答', '身份名走 ROLE_LABELS（explain → 问答）')
  const brief = String(h.starts[0].request.prompt[0].text)
  assert.match(brief, /这个插件为什么要做成一个 task 工具？/, '用户原话必须原样进简报')
  assert.match(brief, /【主对话交底的想法】/, '想法那一段要自报家门，好与事实分段分开')
  assert.match(brief, /当前在改 packages\/task。/, '想法必须进简报')
  assert.match(brief, /问答线程/, '简报要交代这条线程是干什么的')
  assert.match(brief, /只能用提问卡片/, '简报要交代跟用户说话的唯一出口')
  assert.match(brief, /就这些/, '简报要交代停手条件')
  assert.equal(brief.includes('【背景】'), false, '旧段名已换成「主对话交底的想法」，不留旧锚点')
  assert.equal(result.status, 'running')
  assert.equal(typeof result.task_id, 'string')
  // 回执的每个键都必须在 output.schema 里报备，否则调用方看到的是 `returned invalid output`。
  const declared = Object.keys(h.tool('qa_thread').output?.schema?.properties ?? {})
  for (const key of Object.keys(result)) assert.ok(declared.includes(key), '未声明的回执键：' + key)
})

it('qa_thread 不传 background 也能派发：简报里没有「想法」那一段，但自动事实段照旧', async () => {
  const h = harness()
  // 先往主对话那棵树上摆一条决策，好让自动事实那一段真的有话可说。
  await h.tool('task').execute(
    { action: 'plan', nodes: [{ id: 'ask-1', title: '[中枢] 用不用 pnpm？', detail: '答：不用 pnpm' }] },
    { agent: h.rootAgent, callId: 'c0' },
  )
  const result = await h.tool('qa_thread').execute({ question: '为什么不用 pnpm？' }, { agent: h.rootAgent, callId: 'c1' })
  assert.equal(h.starts.length, 1, '只给 question 必须照样派出去')
  assert.equal(result.status, 'running')
  const brief = String(h.starts[0].request.prompt[0].text)
  assert.match(brief, /为什么不用 pnpm？/, '用户原话照旧进简报')
  assert.equal(brief.includes('【主对话交底的想法】'), false, 'background 空 → 想法那一段整段省略')
  assert.match(brief, /【已裁定的事】/, '没有 background 时自动事实段仍要出现')
  assert.match(brief, /用不用 pnpm？/, '已裁定的事来自树')
  assert.match(brief, /【去哪里找事实】/, '要交代事实从哪来')
  assert.match(brief, /【任务树现状】/, '树的现状也要进简报')
  const decisions = section(brief, '【已裁定的事】')
  assert.ok(decisions !== null, '决策那一段要在')
  assert.equal(decisions.includes('答：'), false, '答案要剥掉 `答：` 前缀，别把面板记号当内容')
  assert.match(decisions, /用不用 pnpm？ → \*\*不用 pnpm\*\*/, '答案本身要在')
})

it('自动事实来自树：假树预置的决策节点连同它的答案一起进简报', async () => {
  const h = harness()
  h.nodesOf('sess-1').push(
    { id: 'ask-1', title: '[中枢] 要不要给 explain 放开 task？', detail: '答：不给，task 进 deny', status: 'completed' },
    { id: 'B1', title: '实现自动事实注入', detail: '还差测试', status: 'in_progress' },
    { id: 'B2', title: '补构建', status: 'pending' },
  )
  await h.tool('qa_thread').execute({ question: 'q', background: 'b' }, { agent: h.rootAgent, callId: 'c1' })
  const brief = String(h.starts[0].request.prompt[0].text)
  const decisions = section(brief, '【已裁定的事】')
  assert.ok(decisions !== null, '决策那一段要在')
  assert.match(decisions, /要不要给 explain 放开 task？ → \*\*不给，task 进 deny\*\*/, '决策与答案要成对出现')
  const treeText = section(brief, '【任务树现状】')
  assert.ok(treeText !== null, '树那一段要在')
  assert.match(treeText, /B1: 实现自动事实注入/, '树上的节点要露出来')
  assert.match(treeText, /B2: 补构建/, '未干的节点也要露出来')
  assert.match(treeText, /detail: 还差测试/, '非 completed 节点的 detail 要露出来')
  assert.equal(brief.includes('## 已裁定的事（用户已经拍过板）'), false, 'Markdown 标题要剥掉，简报自带段头')
})

it('树服务缺席 / 读树抛异常：简报照常产出（只缺那两段），派发不被炸掉', async () => {
  for (const options of [{ treeAbsent: true }, { treeThrows: true }] as const) {
    const h = harness(options)
    const result = await h.tool('qa_thread').execute({ question: 'Q', background: 'B' }, { agent: h.rootAgent, callId: 'c1' })
    assert.equal(h.starts.length, 1, '树读不动也必须把线程派出去')
    assert.equal(result.status, 'running')
    const brief = String(h.starts[0].request.prompt[0].text)
    assert.match(brief, /Q/, '用户原话照旧')
    assert.match(brief, /B/, '想法照旧')
    assert.match(brief, /【去哪里找事实】/, '固定那一段照旧')
    assert.match(brief, /【你跟用户的往来方式】/, '往来方式照旧')
    assert.equal(brief.includes('【已裁定的事】'), false, '抓不到就整段省略，不写「（无）」')
    assert.equal(brief.includes('【任务树现状】'), false, '任务树那一段同样整段省略')
    assert.equal(brief.includes('(empty tree)'), false, '空树不许把渲染器的占位串漏进简报')
  }
})

it('树很大时截断，且如实标注被截掉了多少行', async () => {
  const h = harness()
  for (let i = 0; i < 60; i++) {
    h.nodesOf('sess-1').push({ id: 'N' + String(i), title: '节点 ' + String(i), status: 'pending' })
  }
  await h.tool('qa_thread').execute({ question: 'q', background: 'b' }, { agent: h.rootAgent, callId: 'c1' })
  const brief = String(h.starts[0].request.prompt[0].text)
  const treeSection = brief.slice(brief.indexOf('【任务树现状】'), brief.indexOf('【去哪里找事实】'))
  const lines = treeSection.trimEnd().split('\n')
  // 40 行正文 + 1 行段头 + 1 行截断说明。
  assert.equal(lines.length, 42, '正文行数必须真的被限住，而不是「顺便提一句」')
  assert.match(treeSection, /N0: 节点 0/, '留下的是前 40 行')
  assert.equal(treeSection.includes('N59:'), false, '被截掉的那一段不许还在')
  assert.match(treeSection, /另有 20 行未列/, '截断了多少行要如实写出来')
  assert.match(treeSection, /只列了前 40 行/, '说明里要写清上限')
})

it('qa_thread 的 label 可覆盖：给了就进派发请求；身份名照旧是「问答」', async () => {
  const h = harness()
  await h.tool('qa_thread').execute(
    { question: 'q', background: 'b', label: '折叠方案' },
    { agent: h.rootAgent, callId: 'c1' },
  )
  // 两件不同的事，别混：`label` 是面板上的活名（走 request.label），
  // 而 startContinuable 的顶层 `label` 是**生效身份**的显示名（explain → 问答）。
  assert.equal(h.starts[0].request.label, '折叠方案')
  assert.equal(h.starts[0].label, '问答', '身份显示名永远跟着生效键走，不被调用方的活名顶掉')
})

it('qa_thread 缺 question 一律抛错；缺 background 不抛（那才是新契约）', async () => {
  const h = harness()
  await assert.rejects(
    () => h.tool('qa_thread').execute({ background: 'b' }, { agent: h.rootAgent, callId: 'c1' }),
    /question/,
  )
  // **契约变更**：原先这一行断言「只传 question 会被 `/background/` 拒掉」。现在事实由
  // 插件自己抓，`background` 只剩「想法」这一件可省的事，所以只传 question **必须派出去**。
  // 保留的仍是它原本要钉的那条**纪律**：参数不全时不许派发 —— 只是「不全」的定义
  // 从「缺两参之一」收窄成「缺 question 这一参」（缺了它这条线程根本不知道要答什么）。
  const ok = await h.tool('qa_thread').execute({ question: 'q' }, { agent: h.rootAgent, callId: 'c2' })
  assert.equal(ok.status, 'running', '只给 question 应当成功派发')
  assert.equal(h.starts.length, 1, '两条调用里只有合法的那一条派出了孩子')
})

it('问答线程：卡片正文逐字是模型那一句 —— 连问几轮，插件一个字都不往里拼', async () => {
  const h = harness({ answers: [{ id: 'q1', selected: ['A'] }] })
  await h.tool('qa_thread').execute({ question: '第一问', background: 'b' }, { agent: h.rootAgent, callId: 'c1' })
  const child = h.createChild('child-1')
  h.fire('agent/created', { agent: child })

  await h.asked(child, '第一问的正文')
  assert.equal(h.askCalls[0].questions[0].question, '第一问的正文', '正文逐字不变')
  assert.equal(h.nodesOf('child-1')[0]!.title, '[问答] 第一问的正文', '树节点标题带角色前缀')
  // 卡片前缀与树标题取自**同一个** label（`roleLabel(effectiveKey)`）：ROLE_LABELS
  // 里加了 `explain` 这一格，两处就一起生效，不需要另写一行代码。
  assert.equal(h.askCalls[0].questions[0].header, '[问答]', '卡片前缀跟着 ROLE_LABELS 走')

  // 第二轮：第一轮已经问完答完，历史上**确实**有材料可拼了 —— 而正文依旧一个字不加。
  // 回看前几轮改走子会话里官方提问行的「回顾」（官方只读问答面板），不再挤进卡片正文。
  await h.asked(child, '第二问的正文')
  assert.equal(h.askCalls[1].questions[0].question, '第二问的正文', '第二轮正文也逐字不变')
  assert.equal(h.nodesOf('child-1').length, 2, '两轮问答都照旧记进那条线程自己的树')
  assert.equal(h.nodesOf('child-1')[0]?.detail, '答：A', '答案照旧写回同一节点的 detail')
})

it('问答线程：多轮累积也不攒正文 —— 每一轮的正文都只有那一轮自己那一句', async () => {
  const h = harness()
  await h.tool('qa_thread').execute({ question: 'Q', background: 'b' }, { agent: h.rootAgent, callId: 'c1' })
  const child = h.createChild('child-1')
  h.fire('agent/created', { agent: child })
  await h.asked(child, '问一')
  await h.asked(child, '问二')
  await h.asked(child, '问三')
  assert.deepStrictEqual(
    h.askCalls.map(call => call.questions[0].question),
    ['问一', '问二', '问三'],
    '三轮三句，谁也不带前几轮',
  )
  for (const call of h.askCalls) {
    assert.equal(String(call.questions[0].question).includes('【此前问答】'), false, '正文里不许再出现历史锚点')
  }
})

it('提问透传不分身份：问答线程与普通子代理的正文纪律是同一条', async () => {
  const h = harness()
  await h.tool('task').execute(
    { action: 'run', run: 'r1', nodes: [{ id: 'n1', prompt: 'go', preset: 'recon' }] },
    { agent: h.rootAgent, callId: 'c1' },
  )
  const child = h.createChild('child-1')
  h.fire('agent/created', { agent: child })
  await h.asked(child, '问一')
  await h.asked(child, '问二')
  assert.equal(h.askCalls[1].questions[0].question, '问二', '侦察线程的正文一个字都不许被改动')
  assert.equal(h.askCalls[1].questions[0].header, '[侦察]')
})

it('树读不动不许让提问失败：照原样提问、答案照常回来、并留一条写树失败的日志', async () => {
  const h = harness({ treeThrows: true })
  await h.tool('qa_thread').execute({ question: 'Q', background: 'b' }, { agent: h.rootAgent, callId: 'c1' })
  const child = h.createChild('child-1')
  h.fire('agent/created', { agent: child })
  const result = await h.asked(child, '照常问')
  assert.equal(h.askCalls.length, 1, '提问必须照样发出去')
  assert.equal(h.askCalls[0].questions[0].question, '照常问', '写不进树时正文依旧逐字不变')
  assert.equal(result.answers[0].selected[0], 'A', '答案照常回来')
  assert.equal(
    h.warns.some(line => line.includes('could not record its question in its own tree')),
    true,
    '写树降级要留日志',
  )
})

it('task 的回显：存在的字段排成多行、缺席的跳过，且只产出 text 块', () => {
  const h = harness()
  const render = h.tool('task').output!.render
  const blocks = render({ action: 'result' }, {
    task_id: 'child-7',
    status: 'completed',
    result: '它说完了',
    evidence: 'settlement notice read from this session history',
  })
  assert.equal(blocks.length, 1, '合成一个块，不散成好几个')
  assert.equal(blocks[0]!.type, 'text', '只允许 text 成员')
  const text = String(blocks[0]!.text)
  assert.match(text, /^status: completed$/m)
  assert.match(text, /^task_id: child-7$/m)
  assert.match(text, /^result: 它说完了$/m)
  assert.match(text, /^evidence: settlement notice read from this session history$/m)
  assert.equal(text.includes('node:'), false, '缺席的键不许占一行')
  assert.equal(text.includes('undefined'), false, '缺席的键不许被写成 undefined')
})

it('task 的回显：数组一行一项、空数组跳过、false 与 0 照原样出现', () => {
  const h = harness()
  const render = h.tool('task').output!.render
  const text = String(render({}, {
    status: 'running',
    run: 'r1',
    dispatched: ['A', 'B'],
    worktrees: [],
    merged: false,
    files: 0,
  })[0]!.text)
  assert.match(text, /^dispatched:$/m)
  assert.match(text, /^  - A$/m)
  assert.match(text, /^  - B$/m)
  assert.match(text, /^merged: false$/m)
  assert.match(text, /^files: 0$/m)
  assert.equal(text.includes('worktrees'), false, '空数组跳过')
})

/**
 * 一段决策正文的**条**数（`- ` 起头的一行算一条）。
 * @param section - 【已裁定的事】那一段的正文。
 * @returns 条数。
 */
function bullets(section: string): string[] {
  return section.split('\n').filter(line => line.startsWith('- '))
}

it('已裁定的事：单条标题被压成一行且带留痕，答案一字不动', async () => {
  const h = harness()
  // 标题 400 字符、中间夹两个换行 —— 真机上决策节点的 title 就是提问卡片正文，
  // 主对话往里写的是一大段说理（实测 27 条里 9 条是多行、单条最长 695 字符）。
  const longTitle = '先说一段很长的背景。'.repeat(20) + '\n第二段说理。\n第三段再说一句。'
  const answer = '先别做：放一放。'
  await h.tool('task').execute(
    { action: 'plan', nodes: [{ id: 'ask-1', title: longTitle, detail: '答：' + answer }] },
    { agent: h.rootAgent, callId: 'c0' },
  )
  await h.tool('qa_thread').execute({ question: 'q' }, { agent: h.rootAgent, callId: 'c1' })
  const brief = String(h.starts[0].request.prompt[0].text)
  const decisions = section(brief, '【已裁定的事】')
  assert.ok(decisions !== null, '决策那一段要在')
  const items = bullets(decisions)
  assert.equal(items.length, 1, '一条决策仍然只占一条')
  const line = items[0] as string
  assert.equal(line.includes('\n'), false, '标题里的换行必须被折叠掉 —— 这条是「压成单行」')
  assert.match(line, /…/, '被截的标题要留省略号')
  assert.match(line, /标题已截到 160 字符（原文 \d+ 字符）/, '截了多少要如实写出来')
  assert.match(line, /原文 3 行/, '原文是几行也要写出来')
  assert.ok(line.includes('→ **' + answer + '**'), '答案必须完整保留，一个字不动')
})

it('已裁定的事：整段超上限就截，并如实写出总条数与未列条数', async () => {
  const h = harness()
  const total = 25
  for (let i = 1; i <= total; i++) {
    await h.tool('task').execute(
      { action: 'plan', nodes: [{ id: 'ask-' + String(i), title: '第' + String(i) + '件事怎么定？', detail: '答：定' + String(i) }] },
      { agent: h.rootAgent, callId: 'c' + String(i) },
    )
  }
  await h.tool('qa_thread').execute({ question: 'q' }, { agent: h.rootAgent, callId: 'c9' })
  const decisions = section(String(h.starts[0].request.prompt[0].text), '【已裁定的事】')
  assert.ok(decisions !== null, '决策那一段要在')
  const items = bullets(decisions)
  // 20 条正文 + 1 行截断说明（说明行本身不以 `- ` 起头，故单独断言）。
  assert.equal(items.length, 20, '正文条数必须真的被限住，而不是「顺便提一句」')
  assert.match(decisions, /第1件事怎么定？ → \*\*定1\*\*/, '留下的是前 20 条，首条要在')
  assert.equal(decisions.includes('第21件事'), false, '被截掉的那一段不许还在')
  assert.match(decisions, /决策共 25 条，只列了前 20 条，另有 5 条未列/, '截断了多少条要如实写出来')
})

it('已裁定的事：短决策逐字原样，看不出任何加工痕迹', async () => {
  const h = harness()
  await h.tool('task').execute(
    { action: 'plan', nodes: [{ id: 'ask-1', title: '[中枢] 用不用 pnpm？', detail: '答：不用 pnpm' }] },
    { agent: h.rootAgent, callId: 'c0' },
  )
  await h.tool('qa_thread').execute({ question: 'q' }, { agent: h.rootAgent, callId: 'c1' })
  const decisions = section(String(h.starts[0].request.prompt[0].text), '【已裁定的事】')
  assert.ok(decisions !== null, '决策那一段要在')
  const items = bullets(decisions)
  assert.deepStrictEqual(items, ['- [中枢] 用不用 pnpm？ → **不用 pnpm**'], '没超限的条目必须逐字原样')
  assert.equal(decisions.includes('…'), false, '没被截就不许出现省略号')
  assert.equal(decisions.includes('已截到'), false, '没被截就不许出现留痕')
  assert.equal(decisions.includes('未列'), false, '没超条数就不许出现截断说明')
})

it('已裁定的事：问题是超长的、答案也长 —— 红线是答案一个字都不许少', async () => {
  const h = harness()
  const longTitle = '这是主对话写的一大段说理，'.repeat(30)
  // 答案同样长（133 字符是实测最长答案的量级），专门用来钉「只截标题不截答案」。
  const answer = '我仍然有一些补充想法：'
    + '第一，这个机制真正的目的是让我在指定方案时能问一些问题了解情况，'
    + '或者我根本就不懂、你得给我解答，那这样会导致主对话参杂无关内容，上下文腐化变快、成本也高；'
    + '第二，主对话思考的时候不适合打断，我要的是实时响应的对话；'
    + '第三，我可能需要多线程讨论，几条线之间谁也不碰谁，谁也不等谁。'
  await h.tool('task').execute(
    { action: 'plan', nodes: [{ id: 'ask-1', title: longTitle, detail: '答：' + answer }] },
    { agent: h.rootAgent, callId: 'c0' },
  )
  await h.tool('qa_thread').execute({ question: 'q' }, { agent: h.rootAgent, callId: 'c1' })
  const brief = String(h.starts[0].request.prompt[0].text)
  const decisions = section(brief, '【已裁定的事】')
  assert.ok(decisions !== null, '决策那一段要在')
  const items = bullets(decisions)
  assert.equal(items.length, 1, '答案再长也不许被拆成第二条')
  const line = items[0] as string
  // 红线：答案逐字完整 —— 用不依赖标题被压多短的写法钉死。
  assert.ok(line.includes('→ **' + answer + '**'), '答案必须逐字完整（这是这一段的唯一用途）')
  assert.ok(answer.length > 100, '这条测试的意义就在答案够长，别把它写短了')
  // 标题那一头确实被压了：留在答案前面的那段不含整条原问题。
  assert.equal(line.includes(longTitle), false, '超长标题不该整段留在简报里')
  assert.match(line, /…/, '标题那头要留省略号')
})

it('task 的回显：一个字段都没有时也有话说（不是空块）', () => {
  const h = harness()
  const blocks = h.tool('task').output!.render({}, {})
  assert.equal(blocks.length, 1)
  assert.equal(String(blocks[0]!.text), '(no fields)')
})

it('task 回显覆盖的键都在 output.schema 里声明过——多一个未声明的键会让整份回执被判非法', () => {
  const h = harness()
  const declared = Object.keys(h.tool('task').output?.schema?.properties ?? {})
  // 回显里点过名的那些键，逐个回到 schema 里查。
  const rendered = String(h.tool('task').output!.render({}, {
    status: 'x', node: 'n', task_id: 't', run: 'r', result: 'z', tree: 'T',
    branch: 'b', path: 'p', hash: 'h', files: 1, uncommitted: 2, verification: 'v',
    merged: true, worktrees: ['w'], dispatched: ['d'], output: 'O',
    presetFallback: 'F', evidence: 'E',
  })[0]!.text)
  for (const key of declared) {
    if (key === 'result') continue
    assert.ok(rendered.includes(key + ':'), 'schema 里声明的键「' + key + '」应该出现在回显里')
  }
  for (const line of rendered.split('\n')) {
    if (!line.includes(': ')) continue
    assert.ok(declared.includes(line.split(': ')[0] as string), '回显里出现了未声明的键：' + line)
  }
})

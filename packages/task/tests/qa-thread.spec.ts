/**
 * 本轮新增功能的三块单测：`qa_thread`、问答线程的历史自动回显、`task` 的回显。
 *
 * 为什么单独一个文件而不是往既有的三份里塞：既有的 harness 都只**抓最后一个**
 * 注册进工具面的定义（`captured = definition`），而本包现在注册**两个**工具
 * （`qa_thread` 与 `task`）。往它们里加点东西就得先改它们的抓取逻辑 ——
 * 那是「为了新代码去动既有测试」，本轮的纪律不许。所以这里自带一个按名字抓取的 harness。
 *
 * 钉住四件事：
 * 1. `qa_thread` 真的存在、两个参数都必填、派发走的是 `preset: 'explain'`；
 * 2. 问答线程的简报里必须带**用户原话**、背景、以及「一轮一轮用卡片接着问」的指示；
 * 3. 历史回显**只**对问答线程启用（普通子代理逐字不变），且材料是插件从树上读的，
 *    没有历史时一个字都不加；
 * 4. `task` 的回显把存在的字段排出来、缺席的跳过，且只产出 text 块。
 *
 * ctx 与 Agent 都是本文件里的假件，不碰真机。
 */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { apply, type ResolvedConfig } from '../src/index.ts'

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
 * 一个只够跑通这三条链路的假上下文。
 * @param options - 用户给出的答案、tree 是否可读。
 * @returns 按名字取工具、造孩子、触发事件的手段，以及可断言的树与提问记录。
 */
function harness(options: {
  readonly answers?: readonly { readonly id: string; readonly selected: readonly string[] }[]
  readonly treeThrows?: boolean
} = {}) {
  const store = new Map<string, Record<string, any>[]>()
  const nodesOf = (sid: string): Record<string, any>[] => {
    const existing = store.get(sid)
    if (existing !== undefined) return existing
    const fresh: Record<string, any>[] = []
    store.set(sid, fresh)
    return fresh
  }
  const port = {
    read: (sid: string) => {
      if (options.treeThrows === true) throw new Error('tree port is down')
      return nodesOf(sid)
    },
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
      if (key === 'taskTree') return port
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
    runsFile: '',
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

it('qa_thread 注册了：两个参数都必填，且描述里写清了触发纪律', () => {
  const h = harness()
  const tool = h.tool('qa_thread')
  assert.ok(tool !== undefined, 'qa_thread 必须注册进工具面')
  const properties = tool.parameters.properties
  // 必填落在**顶层 `required` 数组**上，不是逐属性的 `required: true`（实测：
  // `qa_thread` 编出来的是 `required: ["question","background"]`）。
  // 这条与既有那份断言的角度不同：它读的是 `parameters.required` 这一个数组。
  const required = (tool.parameters as unknown as { required?: readonly string[] }).required ?? []
  assert.ok(required.includes('question'), 'question 必填')
  assert.ok(required.includes('background'), 'background 必填')
  assert.equal(required.includes('label'), false, 'label 可选')
  assert.deepStrictEqual(Object.keys(properties).sort(), ['background', 'label', 'question'])
  const text = String(tool.description)
  assert.match(text, /用户要求解释/, '描述要写清「什么时候该用」')
  assert.match(text, /独立新方向/, '描述要写清「什么时候该用」的另一半')
  assert.match(text, /不要为它开线程/, '描述要写清「什么时候不该用」')
  assert.match(text, /提问卡片/, '描述要说清它对用户的出口是提问卡片')
  assert.match(text, /结论会自动回到主对话/, '描述要说清结论怎么回来')
})

it('qa_thread 派发：preset 是 explain、label 默认「问答」、简报里带用户原话与背景与卡片指示', async () => {
  const h = harness()
  const result = await h.tool('qa_thread').execute(
    { question: '这个插件为什么要做成一个 task 工具？', background: '当前在改 packages/task。' },
    { agent: h.rootAgent, callId: 'c1' },
  )
  assert.equal(h.starts.length, 1, '派发只走 ctx.subagents.startContinuable')
  assert.equal(h.starts[0].label, '问答', '身份名走 ROLE_LABELS（explain → 问答）')
  const brief = String(h.starts[0].request.prompt[0].text)
  assert.match(brief, /这个插件为什么要做成一个 task 工具？/, '用户原话必须原样进简报')
  assert.match(brief, /当前在改 packages\/task。/, '背景必须进简报')
  assert.match(brief, /问答线程/, '简报要交代这条线程是干什么的')
  assert.match(brief, /只能用提问卡片/, '简报要交代跟用户说话的唯一出口')
  assert.match(brief, /就这些/, '简报要交代停手条件')
  assert.equal(result.status, 'running')
  assert.equal(typeof result.task_id, 'string')
  // 回执的每个键都必须在 output.schema 里报备，否则调用方看到的是 `returned invalid output`。
  const declared = Object.keys(h.tool('qa_thread').output?.schema?.properties ?? {})
  for (const key of Object.keys(result)) assert.ok(declared.includes(key), '未声明的回执键：' + key)
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

it('qa_thread 缺 question 或缺 background 一律抛错，一个孩子都不派', async () => {
  const h = harness()
  await assert.rejects(
    () => h.tool('qa_thread').execute({ background: 'b' }, { agent: h.rootAgent, callId: 'c1' }),
    /question/,
  )
  await assert.rejects(
    () => h.tool('qa_thread').execute({ question: 'q' }, { agent: h.rootAgent, callId: 'c1' }),
    /background/,
  )
  assert.equal(h.starts.length, 0, '参数不全时不许派发')
})

it('问答线程：第二轮起卡片正文前面出现插件拼的【此前问答】，内容是第一轮的原问原答', async () => {
  const h = harness({ answers: [{ id: 'q1', selected: ['A'] }] })
  await h.tool('qa_thread').execute({ question: '第一问', background: 'b' }, { agent: h.rootAgent, callId: 'c1' })
  const child = h.createChild('child-1')
  h.fire('agent/created', { agent: child })

  // 第一轮：树上还没有任何问完答完的决策，所以**一个字都不加**。
  await h.asked(child, '第一问的正文')
  assert.equal(h.askCalls[0].questions[0].question, '第一问的正文', '没有历史时正文逐字不变')
  assert.equal(h.nodesOf('child-1')[0].title, '[问答] 第一问的正文', '树节点标题带角色前缀')
  // 卡片前缀与树标题取自**同一个** label（`roleLabel(effectiveKey)`）：ROLE_LABELS
  // 里加了 `explain` 这一格，两处就一起生效，不需要另写一行代码。
  assert.equal(h.askCalls[0].questions[0].header, '[问答]', '卡片前缀跟着 ROLE_LABELS 走')

  // 第二轮：第一轮已经问完答完，历史块必须出现在**本次第一个问题**的正文前。
  await h.asked(child, '第二问的正文')
  const second = String(h.askCalls[1].questions[0].question)
  assert.match(second, /^【此前问答】\n/, '历史块的锚点必须在最前')
  assert.match(second, /第 1 轮 —— 问：第一问的正文 ｜ 答：A/, '一行一轮，问与答都取原样')
  assert.match(second, /【本轮】\n\n第二问的正文$/, '块尾有分隔，然后才是本轮问题')
})

it('问答线程：多轮累积，第三轮看得见前两轮（每轮一行）', async () => {
  const h = harness()
  await h.tool('qa_thread').execute({ question: 'Q', background: 'b' }, { agent: h.rootAgent, callId: 'c1' })
  const child = h.createChild('child-1')
  h.fire('agent/created', { agent: child })
  await h.asked(child, '问一')
  await h.asked(child, '问二')
  await h.asked(child, '问三')
  const third = String(h.askCalls[2].questions[0].question)
  assert.match(third, /第 1 轮 —— 问：问一 ｜ 答：A/)
  assert.match(third, /第 2 轮 —— 问：问二 ｜ 答：A/)
  assert.equal(third.includes('第 3 轮'), false, '本轮自己还没答，不许当成历史写进去')
})

it('历史回显只对问答线程启用：普通子代理的提问行为逐字不变', async () => {
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

it('读树失败不许让提问失败：历史读不动时照原样提问并留一条日志', async () => {
  const h = harness({ treeThrows: true })
  await h.tool('qa_thread').execute({ question: 'Q', background: 'b' }, { agent: h.rootAgent, callId: 'c1' })
  const child = h.createChild('child-1')
  h.fire('agent/created', { agent: child })
  const result = await h.asked(child, '照常问')
  assert.equal(h.askCalls.length, 1, '提问必须照样发出去')
  assert.equal(h.askCalls[0].questions[0].question, '照常问', '读不到历史时正文逐字不变')
  assert.equal(result.answers[0].selected[0], 'A', '答案照常回来')
  assert.equal(h.warns.some(line => line.includes('could not read back the earlier Q&A')), true, '降级要留日志')
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
  assert.equal(blocks[0].type, 'text', '只允许 text 成员')
  const text = String(blocks[0].text)
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
  })[0].text)
  assert.match(text, /^dispatched:$/m)
  assert.match(text, /^  - A$/m)
  assert.match(text, /^  - B$/m)
  assert.match(text, /^merged: false$/m)
  assert.match(text, /^files: 0$/m)
  assert.equal(text.includes('worktrees'), false, '空数组跳过')
})

it('task 的回显：一个字段都没有时也有话说（不是空块）', () => {
  const h = harness()
  const blocks = h.tool('task').output!.render({}, {})
  assert.equal(blocks.length, 1)
  assert.equal(String(blocks[0].text), '(no fields)')
})

it('task 回显覆盖的键都在 output.schema 里声明过——多一个未声明的键会让整份回执被判非法', () => {
  const h = harness()
  const declared = Object.keys(h.tool('task').output?.schema?.properties ?? {})
  // 回显里点过名的那些键，逐个回到 schema 里查。
  const rendered = String(h.tool('task').output!.render({}, {
    status: 'x', node: 'n', task_id: 't', run: 'r', result: 'z', tree: 'T',
    branch: 'b', path: 'p', hash: 'h', files: 1, uncommitted: 2, verification: 'v',
    merged: true, worktrees: ['w'], dispatched: ['d'], probe: 'P', output: 'O',
    presetFallback: 'F', evidence: 'E',
  })[0].text)
  for (const key of declared) {
    if (key === 'result') continue
    assert.ok(rendered.includes(key + ':'), 'schema 里声明的键「' + key + '」应该出现在回显里')
  }
  for (const line of rendered.split('\n')) {
    if (!line.includes(': ')) continue
    assert.ok(declared.includes(line.split(': ')[0] as string), '回显里出现了未声明的键：' + line)
  }
})

/**
 * 子代理提问透传的单测。
 *
 * 钉住四件事（都是宿主明令禁止、只能由本插件绕开的行为）：
 * 1. 子代理拿到的是**遮蔽版** `ask_user_question`（注册在它自己的作用域里）；
 * 2. 那次 `ask` 的作用域是**根代理** —— 换成子代理自己就会撞宿主的 `DELEGATED_CALLER`；
 * 3. 问题先落进**子代理自己的树**（`ask-N` 节点，标题带 `[<label>] ` 前缀），回答回来写成 `答：…`；
 * 4. 结算**不再**把问答搬进父会话的树 —— 同一个决策只存在子代理自己那一份，
 *    中枢靠决策段读**合并视图**（`readMerged`）看见它。
 *
 * ctx 与 Agent 都是本文件里的假件，不碰真机。
 */
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { it } from 'node:test'
import { apply, type ResolvedConfig } from '../src/index.ts'

/** 抓取注册进某个工具面的定义。 */
interface Captured {
  readonly name: string
  readonly execute: (args: any, exec: any) => Promise<any>
}

/**
 * 一个只够跑通透传链路的假上下文。
 * @param options - 用户给出的答案、是否挂一支假队伍。
 * @returns 任务工具、根代理、造孩子与触发事件的手段，以及可断言的树与提问记录。
 */
function harness(options: { readonly answers?: readonly { readonly id: string; readonly selected: readonly string[] }[]; readonly teams?: boolean } = {}) {
  const store = new Map<string, Record<string, any>[]>()
  const nodesOf = (sid: string): Record<string, any>[] => {
    const existing = store.get(sid)
    if (existing !== undefined) return existing
    const fresh: Record<string, any>[] = []
    store.set(sid, fresh)
    return fresh
  }
  const port = {
    read: (sid: string) => nodesOf(sid),
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
  const childTools = new Map<string, Captured[]>()
  const membership = new Map<unknown, any>()
  let taskTool: Captured | undefined
  let seq = 0
  const rootAgent: any = { id: 'sess-1', session: { id: 'sess-1' } }
  const teams = options.teams === true
    ? {
        listMembers: () => [],
        spawnTeammate: async () => ({ member: { id: 'member-1' } }),
        tryMembership: (agent: unknown) => membership.get(agent),
      }
    : undefined
  const ctx = {
    agents: { roots: () => [rootAgent] },
    tools: { register: (definition: Captured) => { taskTool = definition; return () => {} } },
    get: (key: string) => {
      if (key === 'taskTree') return port
      if (key === 'userQuestions') {
        return { ask: async (request: any) => { askCalls.push(request); return { answers: options.answers ?? [{ id: 'q1', selected: ['A'] }] } } }
      }
      if (key === 'agentTeams') return teams
      return undefined
    },
    subagents: {
      resolveMaxDepth: () => undefined,
      startContinuable: async () => ({ childId: 'child-' + String(++seq) }),
      sendMessage: async () => 'inbox-1',
      interrupt: () => {},
      listChildren: async () => [],
      listDescendants: async () => [],
    },
    on: (event: string, handler: (...args: any[]) => unknown) => { listeners.push({ event, handler }); return () => {} },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
  }
  // scout 与 lead 也登记进来：中文映射表的用例要能真的派出去，
  // 而不是在 resolvePreset 那一步就撞 UnknownPresetError。
  apply(ctx as never, { provider: 'default', defaultRules: 'RULES', runsFile: '', presets: { recon: { persona: 'P' }, scout: { persona: 'P' }, lead: { persona: 'P' } } } as unknown as ResolvedConfig)

  const createChild = (id: string, label?: string): any => {
    const tools: Captured[] = []
    childTools.set(id, tools)
    const agent: any = {
      id,
      label,
      session: { id },
      ctx: {
        tools: { register: (definition: Captured) => { tools.push(definition); return () => {} } },
        systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
      },
    }
    if (teams !== undefined) membership.set(agent, { role: 'teammate', root: rootAgent, name: label ?? id })
    return agent
  }
  const fire = (event: string, ...args: any[]): void => {
    for (const listener of listeners) if (listener.event === event) listener.handler(...args)
  }
  const asked = async (child: any, question: string): Promise<any> => {
    const tool = (childTools.get(String(child.id)) ?? []).find(candidate => candidate.name === 'ask_user_question')
    assert.ok(tool !== undefined, '子代理作用域里必须出现遮蔽版 ask_user_question')
    return (tool as Captured).execute({ questions: [{ id: 'q1', question }] }, { agent: child, callId: 'sub-call' })
  }
  return {
    taskTool: () => taskTool as Captured,
    rootAgent,
    membership,
    createChild,
    fire,
    nodesOf,
    askCalls,
    asked,
    toolsOf: (id: string) => childTools.get(id) ?? [],
  }
}

it('直连子代理：提问以中枢为作用域发出，问答先落进它自己的树', async () => {
  const h = harness()
  await h.taskTool().execute({ action: 'dispatch', prompt: 'go', preset: 'recon', label: 'recon' }, { agent: h.rootAgent, callId: 'call-1' })
  const child = h.createChild('child-1')
  h.fire('agent/created', { agent: child })
  const result = await h.asked(child, '走 A 还是 B？')
  assert.equal(h.askCalls.length, 1)
  assert.equal(h.askCalls[0].agent, h.rootAgent, '必须以根代理为作用域，否则宿主会抛 DELEGATED_CALLER')
  assert.equal(h.askCalls[0].questions[0].header, '[侦察]', '卡片标题要带子代理名字（中文显示名）')
  const nodes = h.nodesOf('child-1')
  assert.equal(nodes.length, 1)
  const first = nodes[0] as Record<string, unknown>
  assert.equal(first.id, 'ask-1')
  assert.equal(first.title, '[侦察] 走 A 还是 B？', '子代理自己那条节点也要认得出是谁问的')
  assert.equal(first.status, 'completed')
  assert.equal(first.detail, '答：A')
  assert.match(String(result.note), /走 A 还是 B？/)
})

it('结算不再往中枢的树搬问答：中枢树里一条 ask- 节点都不新增', async () => {
  const h = harness()
  await h.taskTool().execute({ action: 'dispatch', prompt: 'go', preset: 'recon', label: 'recon' }, { agent: h.rootAgent, callId: 'call-1' })
  const child = h.createChild('child-1')
  h.fire('agent/created', { agent: child })
  await h.asked(child, '走 A 还是 B？')
  // 结算通知照常投进来：`session/event` 上那条搬运监听器已经整个删掉了，
  // 所以这里断言的是**没有**任何新增 —— 那份副本正是「同一个决策显示两遍」的来源。
  h.fire('session/event', { id: 'sess-1' }, { type: 'user/message', data: { source: { kind: 'subagent-settled', senderSessionId: 'child-1' } } })
  await sleep(10)
  assert.equal(h.nodesOf('sess-1').length, 0, '中枢的树里不许出现副本')
  const nodes = h.nodesOf('child-1')
  assert.equal(nodes.length, 1, '决策只存在子代理自己那棵树里')
  const first = nodes[0] as Record<string, unknown>
  assert.equal(first.id, 'ask-1')
  assert.equal(first.title, '[侦察] 走 A 还是 B？')
  assert.equal(first.status, 'completed')
  assert.equal(first.detail, '答：A')
})

it('孙代理那一层各留自己那份：中间层与中枢都不新增节点，问答留在孙代理的树上', async () => {
  const h = harness()
  await h.taskTool().execute({ action: 'dispatch', prompt: 'go', preset: 'recon', label: 'recon' }, { agent: h.rootAgent, callId: 'call-1' })
  const child = h.createChild('child-1')
  h.fire('agent/created', { agent: child })
  await h.taskTool().execute({ action: 'dispatch', prompt: 'deeper', preset: 'recon', label: 'recon' }, { agent: child, callId: 'call-2' })
  const grand = h.createChild('child-2')
  h.fire('agent/created', { agent: grand })
  await h.asked(grand, '孙代理的问题')
  h.fire('session/event', { id: 'child-1' }, { type: 'user/message', data: { source: { kind: 'subagent-settled', senderSessionId: 'child-2' } } })
  await sleep(10)
  assert.equal(h.nodesOf('child-1').length, 0, '父代理自己的树里不许出现孙代理的副本')
  h.fire('session/event', { id: 'sess-1' }, { type: 'user/message', data: { source: { kind: 'subagent-settled', senderSessionId: 'child-1' } } })
  await sleep(10)
  assert.equal(h.nodesOf('sess-1').length, 0, '中枢的树里同样一条都不新增')
  const nodes = h.nodesOf('child-2')
  assert.equal(nodes.length, 1, '孙代理的问答留在它自己的树上')
  const first = nodes[0] as Record<string, unknown>
  assert.equal(first.title, '[侦察] 孙代理的问题')
  assert.equal(first.detail, '答：A')
})

it('队友也拿到遮蔽版提问工具，作用域是队长（Lead）', async () => {
  const h = harness({ teams: true })
  h.membership.set(h.rootAgent, { role: 'lead', root: h.rootAgent, name: 'lead' })
  await h.taskTool().execute({ action: 'dispatch', prompt: 'go', preset: 'recon', label: 'recon' }, { agent: h.rootAgent, callId: 'call-1' })
  const member = h.createChild('member-1', 'recon')
  h.fire('agent/created', { agent: member })
  await h.asked(member, 'A 还是 B？')
  assert.equal(h.askCalls.length, 1)
  assert.equal(h.askCalls[0].agent, h.rootAgent)
  assert.equal(h.askCalls[0].questions[0].header, '[侦察]', '队友名册名 recon 也要显示成中文')
  assert.equal(h.nodesOf('member-1')[0]?.detail, '答：A')
})

it('角色名按映射显示成中文：preset 名与名册名都翻，卡片前缀与树标题一致', async () => {
  const h = harness()
  await h.taskTool().execute({ action: 'dispatch', prompt: 'go', preset: 'recon', label: 'recon' }, { agent: h.rootAgent, callId: 'call-1' })
  const child = h.createChild('child-1')
  h.fire('agent/created', { agent: child })
  await h.asked(child, '问题')
  assert.equal(h.askCalls[0].questions[0].header, '[侦察]', 'recon 必须显示成「侦察」')
  assert.equal(h.nodesOf('child-1')[0]?.title, '[侦察] 问题', '子代理自己那条节点带角色前缀，与卡片 header 一致')
})

it('映射表里没有的名字原样保留——scout 不翻成中文，才认得出是哪个预设', async () => {
  const h = harness()
  await h.taskTool().execute({ action: 'dispatch', prompt: 'go', preset: 'scout', label: 'scout' }, { agent: h.rootAgent, callId: 'call-1' })
  const child = h.createChild('child-1')
  h.fire('agent/created', { agent: child })
  await h.asked(child, '问题')
  assert.equal(h.askCalls[0].questions[0].header, '[scout]', 'scout 不在映射表里，必须原样保留')
})

it('中枢自己的 label 也翻成中文（lead → 中枢）', async () => {
  const h = harness()
  await h.taskTool().execute({ action: 'dispatch', prompt: 'go', preset: 'lead', label: 'lead' }, { agent: h.rootAgent, callId: 'call-1' })
  const child = h.createChild('child-1')
  h.fire('agent/created', { agent: child })
  await h.asked(child, '问题')
  assert.equal(h.askCalls[0].questions[0].header, '[中枢]', 'lead 必须显示成「中枢」')
})

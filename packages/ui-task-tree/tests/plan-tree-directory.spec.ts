/**
 * 任务树目录的取数测试：HTTP 批量端点 → 本地去重快照 → `useSyncExternalStore`。
 *
 * 钉住四件事：宿主那条路由答什么、本目录就读到什么；**读不到**与**确实为空**必须分得开
 * （前者是本进程没有答案，后者是宿主明说「这条会话还没有计划」，把前者画成后者就是这个
 * 包最不能犯的错）；轮询重拉但内容一字未变时**不换快照对象**（否则每次轮询都会把面板
 * 整棵重画，折叠状态与滚动位置跟着抖）；以及 dispose 之后不再有请求、不再有发布。
 *
 * 替身是 `fetch`，不是 describe 镜像：取数通道换了，这一层钉的东西也跟着换。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { PLAN_TREE_ROUTE, PlanTreeDirectory } from '../src/client/plan-tree.ts'

/** 一棵最小的树。 */
const TREE = [{ id: 'root', title: '计划', status: 'pending' }]

/** 一次被替身记下来的请求。 */
interface Call {
  url: string
  init: RequestInit | undefined
}

/** 宿主那条路由的替身：按脚本答，并把每次请求记下来。 */
class FakeRoute {
  readonly calls: Call[] = []
  /** 在飞的取数（`refresh()` 的返回值就是它）：测试用它把「请求在飞」与「已落地」分开。 */
  readonly pending = new Set<Promise<unknown>>()
  private handler: (call: Call) => Promise<Response> | Response

  /** @param handler - 每次请求的答案。 */
  constructor(handler: (call: Call) => Promise<Response> | Response) {
    this.handler = handler
  }

  /** 换一份答案（模拟宿主那边树变了）。 */
  answer(handler: (call: Call) => Promise<Response> | Response): void {
    this.handler = handler
  }

  /** 交给目录用的 fetch。 */
  readonly fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = { url: String(input), init }
    this.calls.push(call)
    const started = Promise.resolve(this.handler(call)).finally(() => { this.pending.delete(started) })
    this.pending.add(started)
    return started
  }
}

/** 一条 200 回答，body 是给 `json()` 用的对象。 */
const ok = (body: unknown): Response => ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as unknown as Response

/** 一条失败回答（只有状态码有意义）。 */
const bad = (status: number): Response => ({ ok: false, status, json: () => Promise.reject(new Error('no body')) }) as unknown as Response

/** 等到没有在飞的取数为止。 */
async function settle(route: FakeRoute): Promise<void> {
  while (route.pending.size > 0) await Promise.all([...route.pending])
}

/** 等几拍事件循环（轮询与在飞请求都靠它推进）。 */
async function ticks(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await new Promise<void>(resolve => { setImmediate(resolve) })
}

test('the batch endpoint is read once, and a session reads its own tree and nobody else\'s', async () => {
  const route = new FakeRoute(() => ok({ trees: { s1: TREE, s2: [{ id: 'b', title: 'B', status: 'completed' }] } }))
  const directory = new PlanTreeDirectory(PLAN_TREE_ROUTE, route.fetch)
  await settle(route)

  assert.deepEqual(directory.treeOf('s1'), { state: 'record', roots: TREE })
  assert.deepEqual(directory.treeOf('s2'), { state: 'record', roots: [{ id: 'b', title: 'B', status: 'completed' }] })
  // 字典拿到了，只是这条会话不在里面：宿主那边确实没有树，显示空态是实话。
  assert.deepEqual(directory.treeOf('s3'), { state: 'empty' })
  // 一条请求取全：面板要同时看见多条会话的树才能做合并，逐条问既猜不准又慢。
  assert.equal(route.calls.length, 1)
  assert.equal(route.calls[0]?.url, PLAN_TREE_ROUTE)
  assert.equal(route.calls[0]?.url.includes('://'), false)
  assert.equal(route.calls[0]?.init?.method, 'GET')
  directory.dispose()
})

test('the merged reader grafts a dispatched sub-session\'s tree from the SAME answer', async () => {
  const child = [{ id: 'c1', title: '子步骤', status: 'pending' }]
  const route = new FakeRoute(() => ok({ trees: { s1: [{ id: 'root', title: '计划', status: 'pending', assignedTo: 'kid' }], kid: child } }))
  const directory = new PlanTreeDirectory(PLAN_TREE_ROUTE, route.fetch)
  await settle(route)

  const view = directory.mergedTreeOf('s1', 2)
  assert.equal(view.state, 'record')
  if (view.state !== 'record') throw new Error('expected the record state')
  assert.deepEqual(view.roots[0]?.children, [{ id: 'kid:c1', title: '子步骤', status: 'pending' }])
  assert.equal(route.calls.length, 1)
  directory.dispose()
})

test('a failing endpoint reads as unreadable, never as empty', async () => {
  for (const status of [404, 500, 405]) {
    const route = new FakeRoute(() => bad(status))
    const directory = new PlanTreeDirectory(PLAN_TREE_ROUTE, route.fetch)
    await settle(route)
    assert.deepEqual(directory.treeOf('s1'), { state: 'unreadable' }, String(status))
    assert.deepEqual(directory.mergedTreeOf('s1', 2), { state: 'unreadable' }, String(status))
    directory.dispose()
  }

  // 网络层直接抛（掉线、跨源被拦）：同样是「不知道」。
  const throwing = new FakeRoute(() => { throw new Error('network down') })
  const offline = new PlanTreeDirectory(PLAN_TREE_ROUTE, throwing.fetch)
  await settle(throwing)
  assert.deepEqual(offline.treeOf('s1'), { state: 'unreadable' })
  offline.dispose()

  // 答了 200 但根本不是 JSON：也读不动，不能当空。
  const garbage = new FakeRoute(() => ({ ok: true, status: 200, json: () => Promise.reject(new Error('not json')) }) as unknown as Response)
  const broken = new PlanTreeDirectory(PLAN_TREE_ROUTE, garbage.fetch)
  await settle(garbage)
  assert.deepEqual(broken.treeOf('s1'), { state: 'unreadable' })
  broken.dispose()
})

test('an empty result is EMPTY: the host really says no session declared a plan', async () => {
  const route = new FakeRoute(() => ok({ trees: {} }))
  const directory = new PlanTreeDirectory(PLAN_TREE_ROUTE, route.fetch)
  await settle(route)
  assert.deepEqual(directory.treeOf('s1'), { state: 'empty' })
  assert.deepEqual(directory.mergedTreeOf('s1', 2), { state: 'empty' })
  directory.dispose()

  // 形状不对的答案不是「空」：宿主没有说「没有计划」，只说了一些读不懂的东西。
  const wrongShape = new FakeRoute(() => ok({ tree: null }))
  const unusable = new PlanTreeDirectory(PLAN_TREE_ROUTE, wrongShape.fetch)
  await settle(wrongShape)
  assert.deepEqual(unusable.treeOf('s1'), { state: 'unreadable' })
  unusable.dispose()
})

test('a re-read that changed nothing does NOT replace the snapshot', async () => {
  const route = new FakeRoute(() => ok({ trees: { s1: TREE } }))
  const directory = new PlanTreeDirectory(PLAN_TREE_ROUTE, route.fetch)
  await settle(route)
  const held = directory.getSnapshot()

  let notified = 0
  const off = directory.subscribe(() => { notified += 1 })
  // 宿主每次重答都是新对象、内容一字未变：本目录必须原地不动，否则每次轮询都会把面板
  // 整棵重画（折叠状态、滚动位置都跟着抖）。
  await directory.refresh()
  assert.equal(notified, 0)
  assert.equal(directory.getSnapshot(), held)

  // 真变了才发布。
  route.answer(() => ok({ trees: { s1: [...TREE, { id: 'b', title: 'B', status: 'pending' }] } }))
  await directory.refresh()
  assert.equal(notified, 1)
  assert.notEqual(directory.getSnapshot(), held)
  assert.deepEqual(directory.treeOf('s1'), { state: 'record', roots: [...TREE, { id: 'b', title: 'B', status: 'pending' }] })

  // 读数从「有」变成「读不到」也要发布：那是关于计划的断言被撤回了。
  route.answer(() => bad(500))
  await directory.refresh()
  assert.equal(notified, 2)
  assert.deepEqual(directory.treeOf('s1'), { state: 'unreadable' })
  off()
  directory.dispose()
})

test('the directory polls the route on a cycle', async () => {
  const route = new FakeRoute(() => ok({ trees: { s1: TREE } }))
  // 周期调到 20ms：这个用例要证的是「定时器真的排上了、而且会一轮轮接着排」，
  // 不是「默认周期是 1500ms」。用真实时钟等一个短周期，比用 setImmediate 假装推得动
  // 一个 1.5 秒的定时器诚实。
  const directory = new PlanTreeDirectory(PLAN_TREE_ROUTE, route.fetch, 20)
  await settle(route)
  assert.equal(route.calls.length, 1)
  await new Promise<void>(resolve => { setTimeout(resolve, 90) })
  await settle(route)
  assert.ok(route.calls.length >= 2, 'expected at least one poll, got ' + String(route.calls.length))
  directory.dispose()
})

test('dispose stops the polling; later answers do not enter the directory', async () => {
  let answer: () => Response = () => ok({ trees: {} })
  const route = new FakeRoute(() => answer())
  const directory = new PlanTreeDirectory(PLAN_TREE_ROUTE, route.fetch)
  await settle(route)
  assert.deepEqual(directory.treeOf('s1'), { state: 'empty' })

  let notified = 0
  directory.subscribe(() => { notified += 1 })
  directory.dispose()
  answer = () => ok({ trees: { s1: TREE } })
  const before = route.calls.length
  await directory.refresh()
  await ticks(8)
  await settle(route)
  assert.equal(route.calls.length, before)
  assert.equal(notified, 0)
  assert.equal(directory.treeOf('s1').state, 'empty')
})

test('a directory with no session id still READS the batch route — the id is a read-time question', async () => {
  // 这条端点是批量的：一次回答全部会话。装配目录的时候还不知道要看哪一条会话
  // （外壳还没开页），但那不该成为「一个请求都不发」的理由 —— 真那么做，第一次渲染
  // 必然读到 unreadable，而轮询要再等一整个周期才补上。
  const route = new FakeRoute(() => ok({ trees: { s1: TREE } }))
  const directory = new PlanTreeDirectory(PLAN_TREE_ROUTE, route.fetch)
  await settle(route)
  assert.equal(route.calls.length, 1)
  assert.equal(route.calls[0]?.url, PLAN_TREE_ROUTE)
  // 字典拿到了：有会话的那条读作 record，没会话的调用方读作 empty。
  assert.deepEqual(directory.treeOf('s1'), { state: 'record', roots: TREE })
  assert.deepEqual(directory.treeOf(undefined), { state: 'empty' })
  directory.dispose()
})

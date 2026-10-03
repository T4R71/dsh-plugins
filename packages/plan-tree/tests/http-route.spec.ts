import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DatabaseSync } from 'node:sqlite'
import type { PlanNode } from '../src/types.ts'
import type { DatabaseOpener, SqliteDatabase } from '../src/session-store.ts'
import { planTreeStore, setPlanTreeDatabase } from '../src/session-store.ts'
import { PLAN_TREE_ROUTE, handlePlanTreeRequest } from '../src/http-route.ts'
import type { HttpResponse, WebServerRoute } from '../src/http-route.ts'

import * as planTree from '../src/index.ts'

/**
 * Drives the REAL route over a REAL store through a fake of the one service the
 * route needs.
 *
 * The fake is a fake of the `webServer` service only: it keeps the service's
 * two real contracts that matter here — `register` stores the route and returns
 * a disposer, and a duplicate (kind, path) is refused — and it hands the
 * handler requests and a response recorder. Everything behind the handler (the
 * store, the SQLite rows, the tools) is the production code path.
 */

/** One recorded response, as the handler left it. */
interface Recorded {
  status: number
  headers: Record<string, string>
  body: string | undefined
}

/** The response surface the handler is allowed to use, recorded instead of sent. */
class RecordingResponse implements HttpResponse {
  statusCode = 0
  readonly headers = new Map<string, string>()
  body: string | undefined

  setHeader(name: string, value: string): void {
    this.headers.set(name, value)
  }

  end(body?: unknown): void {
    this.body = body === undefined ? undefined : String(body)
  }
}

/** A stand-in for `@deepseek-ai/dsh-host-webserver`, narrowed to `register`. */
class FakeWebServer {
  readonly routes = new Map<string, WebServerRoute>()

  register(route: WebServerRoute): () => void {
    const key = route.kind + ' ' + route.path
    if (this.routes.has(key)) {
      throw new Error('webserver: duplicate ' + route.kind + ' route "' + route.path + '"')
    }
    this.routes.set(key, route)
    return () => { this.routes.delete(key) }
  }

  /** The one route this plugin claims, or a failure naming what is registered. */
  route(): WebServerRoute {
    const route = this.routes.get('exact ' + PLAN_TREE_ROUTE)
    if (route === undefined) {
      throw new Error('no exact route at ' + PLAN_TREE_ROUTE + '; registered: ' + [...this.routes.keys()].join(', '))
    }
    return route
  }

  /** Run one request through the registered handler. */
  async request(method: string, url: string): Promise<Recorded> {
    const res = new RecordingResponse()
    await this.route().handler({ method, url }, res)
    return { status: res.statusCode, headers: Object.fromEntries(res.headers), body: res.body }
  }
}

/** Parse a recorded JSON body. */
function json(recorded: Recorded): Record<string, unknown> {
  assert.notStrictEqual(recorded.body, undefined, 'the response carried no body')
  return JSON.parse(recorded.body!) as Record<string, unknown>
}

/** An in-memory SQLite handle, so each test gets a database that dies with it. */
function memoryDatabase(): SqliteDatabase {
  return new DatabaseSync(':memory:') as unknown as SqliteDatabase
}

/**
 * An opener that hands back a database already carrying rows, the way another
 * writer (or an older, buggier one) would have left them.
 */
function seededOpener(rows: readonly (readonly [string, string])[]): DatabaseOpener {
  return () => {
    const database = new DatabaseSync(':memory:') as unknown as SqliteDatabase
    database.exec(
      'CREATE TABLE IF NOT EXISTS plan_tree_sessions '
      + '(session_id TEXT PRIMARY KEY, tree TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    )
    const insert = database.prepare(
      'INSERT INTO plan_tree_sessions (session_id, tree, updated_at) VALUES (?, ?, ?)',
    )
    for (const [id, tree] of rows) insert.run(id, tree, Date.now())
    return database
  }
}

function agentWithSession(id = 'planner'): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown, agent: Agent) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('http-call-' + String(++callCounter)),
    name,
    arguments: args,
    agent,
  })
}

/**
 * Wait for the injected route to appear.
 *
 * `ctx.inject` registers the route from a child fiber, which cordis starts
 * asynchronously; the service it waits on is provided before the plugin mounts,
 * so the wait is for the loader, not for a dependency.
 */
async function waitForRoute(server: FakeWebServer): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (server.routes.size > 0) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('the plugin never registered a route')
}

interface Options {
  exposeTools?: boolean
  seeded?: readonly (readonly [string, string])[]
  withWebServer?: boolean
  server?: FakeWebServer
}

async function setup(options: Options = {}): Promise<{ ctx: Context; server: FakeWebServer }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  setPlanTreeDatabase({
    file: ':memory:',
    open: options.seeded === undefined ? memoryDatabase : seededOpener(options.seeded),
  })
  const server = options.server ?? new FakeWebServer()
  if (options.withWebServer !== false) ctx.provide('webServer', server as never)
  await ctx.plugin(planTree, options.exposeTools === undefined ? {} : { exposeTools: options.exposeTools })
  if (options.withWebServer !== false) await waitForRoute(server)
  return { ctx, server }
}

describe('the plan tree HTTP route: registration', () => {
  it('claims exactly the one exact path, and nothing else', async () => {
    const { server } = await setup()
    assert.deepStrictEqual([...server.routes.keys()], ['exact ' + PLAN_TREE_ROUTE])
    assert.strictEqual(PLAN_TREE_ROUTE, '/t4/plan-tree')
    assert.strictEqual(typeof server.route().handler, 'function')
  })

  it('is registered even when the four model-facing tools are OFF', async () => {
    // The panel is not a tool caller: a deployment that mounted the sibling
    // `task` tool in place of the four still needs its sidebar to show the tree.
    const { server } = await setup({ exposeTools: false })
    assert.strictEqual(server.routes.size, 1)
    assert.strictEqual(server.route().path, PLAN_TREE_ROUTE)
  })

  it('loads in a composition with NO webserver, and its tools still work', async () => {
    const { ctx } = await setup({ withWebServer: false })
    const agent = agentWithSession('no-webserver')
    const result = await call(ctx, 'plan_write', { nodes: [{ id: 'a', title: 'A', status: 'pending' }] }, agent)
    assert.strictEqual(result.isError, false)
    assert.deepStrictEqual(planTreeStore(ctx).get('no-webserver'), [{ id: 'a', title: 'A', status: 'pending' }])
  })
})

describe('the plan tree HTTP route: reading trees', () => {
  it('answers a bare GET with EVERY session\'s tree, keyed by session id', async () => {
    const { ctx, server } = await setup()
    await call(ctx, 'plan_write', { nodes: [{ id: 'a', title: 'A', status: 'pending' }] }, agentWithSession('sess-a'))
    await call(ctx, 'plan_write', { nodes: [{ id: 'b', title: 'B', status: 'in_progress' }] }, agentWithSession('sess-b'))

    const recorded = await server.request('GET', PLAN_TREE_ROUTE)
    assert.strictEqual(recorded.status, 200)
    assert.strictEqual(recorded.headers['content-type'], 'application/json; charset=utf-8')
    // Polled by the panel: a cached answer would freeze the tree on screen.
    assert.strictEqual(recorded.headers['cache-control'], 'no-store')
    const trees = json(recorded)['trees'] as Record<string, PlanNode[]>
    assert.deepStrictEqual(Object.keys(trees).sort(), ['sess-a', 'sess-b'])
    assert.deepStrictEqual(trees['sess-a'], [{ id: 'a', title: 'A', status: 'pending' }])
    assert.deepStrictEqual(trees['sess-b'], [{ id: 'b', title: 'B', status: 'in_progress' }])
  })

  it('serves the SAME store the four tools write — never a second one', async () => {
    const { ctx, server } = await setup()
    const agent = agentWithSession('one-store')
    await call(ctx, 'plan_write', {
      nodes: [{ id: 'root', title: 'Root', status: 'in_progress', children: [{ id: 'kid', title: 'Kid', status: 'pending' }] }],
    }, agent)

    const stored = planTreeStore(ctx).get('one-store')
    const trees = json(await server.request('GET', PLAN_TREE_ROUTE))['trees'] as Record<string, PlanNode[]>
    // Identity of CONTENT across the two read paths is the whole point: the
    // panel's answer must be the tree the tools are walking.
    assert.deepStrictEqual(trees['one-store'], stored)
    assert.strictEqual(trees['one-store']?.[0]?.children?.[0]?.id, 'kid')

    // A write that lands AFTER the mount is visible to the next read, which is
    // what rules out a snapshot taken once at registration time.
    await call(ctx, 'plan_step', { id: 'kid', status: 'completed' }, agent)
    const again = json(await server.request('GET', PLAN_TREE_ROUTE))['trees'] as Record<string, PlanNode[]>
    assert.strictEqual(again['one-store']?.[0]?.children?.[0]?.status, 'completed')
  })

  it('answers ?session=<id> with that one tree, and an unknown id with null', async () => {
    const { ctx, server } = await setup()
    await call(ctx, 'plan_write', { nodes: [{ id: 'a', title: 'A', status: 'pending' }] }, agentWithSession('mine'))

    const mine = await server.request('GET', PLAN_TREE_ROUTE + '?session=mine')
    assert.strictEqual(mine.status, 200)
    assert.deepStrictEqual(json(mine), { tree: [{ id: 'a', title: 'A', status: 'pending' }] })

    // A session that never planned anything is the ORDINARY case, not a missing
    // resource: the panel's word for it is `empty`, and it reads it from null.
    const unknown = await server.request('GET', PLAN_TREE_ROUTE + '?session=never-planned')
    assert.strictEqual(unknown.status, 200)
    assert.deepStrictEqual(json(unknown), { tree: null })
  })

  it('drops an unreadable row instead of failing the whole batch', async () => {
    const good = JSON.stringify([{ id: 'ok', title: 'Ok', status: 'pending' }])
    const { server } = await setup({ seeded: [['good', good], ['bad', 'not json at all'], ['worse', '{"not":"an array"}']] })

    const recorded = await server.request('GET', PLAN_TREE_ROUTE)
    assert.strictEqual(recorded.status, 200)
    const trees = json(recorded)['trees'] as Record<string, PlanNode[]>
    assert.deepStrictEqual(Object.keys(trees), ['good'])
    assert.deepStrictEqual(trees['good'], [{ id: 'ok', title: 'Ok', status: 'pending' }])

    // The single-session read agrees: a damaged row reads as "no tree", and the
    // neighbours are untouched by it.
    assert.deepStrictEqual(json(await server.request('GET', PLAN_TREE_ROUTE + '?session=bad')), { tree: null })
    assert.deepStrictEqual(json(await server.request('GET', PLAN_TREE_ROUTE + '?session=good')), {
      tree: [{ id: 'ok', title: 'Ok', status: 'pending' }],
    })
  })
})

describe('the plan tree HTTP route: refusals', () => {
  it('refuses a blank session id rather than widening it into the whole database', async () => {
    const { ctx, server } = await setup()
    await call(ctx, 'plan_write', { nodes: [{ id: 'a', title: 'A', status: 'pending' }] }, agentWithSession('present'))

    for (const target of ['?session=', '?session=%20']) {
      const recorded = await server.request('GET', PLAN_TREE_ROUTE + target)
      assert.strictEqual(recorded.status, 400)
      const body = json(recorded)
      assert.strictEqual(typeof body['error'], 'string')
      // The refusal must not leak the trees it refused to answer with.
      assert.strictEqual(body['trees'], undefined)
      assert.strictEqual(body['tree'], undefined)
    }
  })

  it('refuses two session parameters instead of picking one', async () => {
    const { server } = await setup()
    const recorded = await server.request('GET', PLAN_TREE_ROUTE + '?session=a&session=b')
    assert.strictEqual(recorded.status, 400)
    assert.match(String(json(recorded)['error']), /at most one session parameter/)
  })

  it('refuses every method but GET and HEAD, and says which are allowed', async () => {
    const { server } = await setup()
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const recorded = await server.request(method, PLAN_TREE_ROUTE)
      assert.strictEqual(recorded.status, 405, method + ' should be refused')
      assert.strictEqual(recorded.headers['allow'], 'GET, HEAD')
      assert.match(String(json(recorded)['error']), /read-only, use GET/)
    }
  })

  it('answers HEAD like GET, because that is what HEAD means', async () => {
    const { ctx, server } = await setup()
    await call(ctx, 'plan_write', { nodes: [{ id: 'a', title: 'A', status: 'pending' }] }, agentWithSession('head'))

    const head = await server.request('HEAD', PLAN_TREE_ROUTE + '?session=head')
    const get = await server.request('GET', PLAN_TREE_ROUTE + '?session=head')
    assert.strictEqual(head.status, 200)
    assert.deepStrictEqual(head.headers, get.headers)
    assert.deepStrictEqual(json(head), json(get))
  })

  it('reports a read failure as 500 with an error frame, not a stack', async () => {
    // The handler's failure contract, exercised through the handler itself: the
    // production store reads only its own in-memory map, so this frame is the
    // contract a future read path (or a closed handle) relies on.
    const broken = {
      get(): never { throw new Error('the database handle is gone') },
      records(): never { throw new Error('the database handle is gone') },
    }
    for (const target of [PLAN_TREE_ROUTE, PLAN_TREE_ROUTE + '?session=x']) {
      const res = new RecordingResponse()
      handlePlanTreeRequest(broken as never, { method: 'GET', url: target }, res)
      assert.strictEqual(res.statusCode, 500)
      const body = JSON.parse(String(res.body)) as Record<string, unknown>
      assert.match(String(body['error']), /reading the plan tree store failed: the database handle is gone/)
      assert.strictEqual(String(body['error']).includes('\n    at '), false, 'the frame carries no stack')
    }
  })
})

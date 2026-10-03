/**
 * The plan tree's read-only HTTP face.
 *
 * The tree lives in SQLite (see ./session-store.ts) and the panel runs in the
 * browser, so something has to carry it across that boundary. A settings mirror
 * used to: the tree was a field of this package's own settings document, and the
 * panel read the shared describe() mirror. That made the profile document grow
 * with every session and every step (5496 lines / 311 KB when it was dropped),
 * which is why the tree moved to SQLite; this route is the replacement read
 * path. The panel fetches JSON from the SAME origin that served it, so its
 * session cookie rides along with no extra wiring.
 *
 * Three properties are deliberate and worth stating:
 *
 *  1. READ ONLY. The browser is not a writer of the plan. plan_write, plan_step,
 *     plan_dispatch and plan_ask are the only writers, and they run in the host,
 *     where the owning session is known. Every method but GET/HEAD is refused
 *     with 405.
 *  2. The webServer service does no authentication of its own: the 401/403 table
 *     belongs to the connection service and covers only that service's own
 *     routes, so a route registered here is reachable by anything that can reach
 *     the loopback listener (see docs/briefs/http-bridge.md). Read-only is
 *     therefore the WHOLE safety story of this route, not a second lock behind an
 *     authentication that this listener does not have.
 *  3. The batch answer is the panel's primary read. One request returns EVERY
 *     session's tree, because the panel merges a dispatched sub-session's tree
 *     into the node that carries its assignedTo id: a per-session-only route
 *     would make it issue one request per level of the tree, and miss whatever it
 *     did not know to ask for.
 *
 * @module @t4r71/dsh-plan-tree/http-route
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PlanNode } from './types.ts'
import type { PlanTreeStore } from './session-store.ts'

/**
 * The one path this plugin claims on the browser's HTTP carrier.
 *
 * Namespaced under /t4/ so it cannot collide with a harness path today or later:
 * the harness owns / and /api/*, and the next API version is expected to land
 * there, not under this prefix.
 */
export const PLAN_TREE_ROUTE = '/t4/plan-tree'

/**
 * What the handler needs from a request.
 *
 * Declared structurally, and narrowed to two fields: this is exactly what
 * node:http's IncomingMessage offers, and it keeps this module free of a
 * dependency on the harness's web-server package — which sits ABOVE plan-tree
 * and would invert the layering (the same reason TeamsDispatchSurface exists in
 * ./index.ts).
 */
export interface HttpRequest {
  /** The request method; node:http always sets it on a server request. */
  readonly method?: string | undefined
  /** The request target — path AND query, e.g. /t4/plan-tree?session=abc. */
  readonly url?: string | undefined
}

/** What the handler may do to a response: status, headers, body — nothing else. */
export interface HttpResponse {
  /** The status code line; assign it before the first write. */
  statusCode: number
  /** Set one response header. */
  setHeader(name: string, value: string): unknown
  /** Finish the response, optionally with a body. */
  end(body?: unknown): unknown
}

/** One route as the webServer service takes it. */
export interface WebServerRoute {
  /** exact matches the whole pathname; prefix owns a path segment. */
  readonly kind: 'exact' | 'prefix'
  /** The pathname this route claims; a duplicate (kind, path) pair is refused. */
  readonly path: string
  /** The owner of the response lifecycle. */
  readonly handler: (req: HttpRequest, res: HttpResponse) => void | Promise<void>
}

/** The narrow slice of the OPTIONAL webServer service this module uses. */
export interface WebServerSurface {
  /**
   * Claim one route.
   * @param route - kind, path, and the owning handler.
   * @returns the disposer releasing the route.
   */
  register(route: WebServerRoute): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Optional browser HTTP carrier (@deepseek-ai/dsh-host-webserver). Absent in
     * a composition with no browser listener — an Electron-only or headless
     * deployment — where registerPlanTreeRoute is simply never reached.
     */
    webServer?: WebServerSurface
  }
}

/** One frame of this route's answer. Which member appears decides the meaning. */
export type PlanTreeHttpBody =
  /** ?session=<id>: that session's tree, or null when it has none yet. */
  | { tree: PlanNode[] | null }
  /** No session: every stored tree, keyed by session id. */
  | { trees: Record<string, PlanNode[]> }
  /** Anything refused: one human-readable sentence. */
  | { error: string }

/**
 * Answer one request.
 *
 * Kept as a free function over (store, req, res) rather than a closure built
 * inside the registration, so the whole route semantics can be exercised without
 * a webserver, a socket, or a plugin load.
 * @param store - the session store to read; never written to.
 * @param req - the request.
 * @param res - the response.
 */
export function handlePlanTreeRequest(store: PlanTreeStore, req: HttpRequest, res: HttpResponse): void {
  // HEAD is admitted and answered exactly like GET: node drops the body of a
  // HEAD response, so the two share one code path and one set of headers. A
  // GET-only route would answer a HEAD with 405, which is not what the method
  // means.
  const method = (req.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    send(res, 405, {
      error: 'plan-tree: ' + method + ' is not allowed on ' + PLAN_TREE_ROUTE
        + '; this route is read-only, use GET',
    }, { allow: 'GET, HEAD' })
    return
  }

  let params: URLSearchParams
  try {
    params = new URL(req.url ?? PLAN_TREE_ROUTE, 'http://plan-tree.invalid').searchParams
  } catch {
    // A target node:http would not have handed us, but the base-URL parse is the
    // only thing here that can throw on hostile input, so it is fenced.
    send(res, 400, { error: 'plan-tree: the request target is not a valid URL' })
    return
  }

  const sessions = params.getAll('session')
  if (sessions.length > 1) {
    send(res, 400, {
      error: 'plan-tree: ' + PLAN_TREE_ROUTE + ' takes at most one session parameter (got '
        + String(sessions.length) + ')',
    })
    return
  }
  const session = sessions.at(0)

  if (session !== undefined) {
    // Present but blank is refused rather than read as "no session": a caller
    // that meant the batch read must say nothing at all, and one that meant a
    // session must name it. Answering the whole database to ?session= would
    // silently widen a single-session read into every session's plan.
    if (session.trim() === '') {
      send(res, 400, { error: 'plan-tree: the session parameter must be a non-empty session id' })
      return
    }
    try {
      // An unknown session is null, not a 404: "this session has not declared a
      // plan yet" is the ordinary state of most sessions, not a missing
      // resource, and the panel's existing vocabulary for it is empty.
      send(res, 200, { tree: (store.get(session) ?? null) as PlanNode[] | null })
    } catch (error: unknown) {
      send(res, 500, { error: describeReadFailure(error) })
    }
    return
  }

  try {
    // records() hands back the parsed map, freshly built. A row another writer
    // left unreadable was already dropped when the store opened, so one damaged
    // row costs one session rather than the whole response — the same contract
    // the panel applies to the records it reads.
    send(res, 200, { trees: store.records() as Record<string, PlanNode[]> })
  } catch (error: unknown) {
    send(res, 500, { error: describeReadFailure(error) })
  }
}

/**
 * Write one JSON answer.
 * @param res - the response.
 * @param status - the status code.
 * @param body - the frame to serialize.
 * @param headers - extra headers, by lowercase name.
 */
function send(
  res: HttpResponse,
  status: number,
  body: PlanTreeHttpBody,
  headers: Record<string, string> = {},
): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  // The panel polls this route, and a cached answer would freeze the tree at
  // whatever it said first — the one failure mode that looks like a broken panel
  // rather than a stale plan.
  res.setHeader('cache-control', 'no-store')
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  res.end(JSON.stringify(body))
}

/**
 * Render a read failure for the client.
 * @param error - the thrown value.
 * @returns a sentence naming the failure, never a stack.
 */
function describeReadFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return 'plan-tree: reading the plan tree store failed: ' + detail
}

/**
 * Claim {@link PLAN_TREE_ROUTE} on the webServer service of an injected context.
 *
 * The context handed in MUST already carry the service (that is what
 * ctx.inject(['webServer'], ...) guarantees); reaching it from a context that
 * does not throws, which is cordis's own diagnostic for an undeclared
 * dependency, and is exactly why this function is called from inside an inject
 * callback rather than from apply() directly: the webserver may load after or
 * before this plugin.
 * @param ctx - a context carrying the webServer service.
 * @param store - the store to serve; the SAME one the tools read and write.
 * @returns the disposer releasing the route.
 */
export function registerPlanTreeRoute(ctx: Context, store: PlanTreeStore): () => void {
  if (ctx.webServer === undefined) {
    throw new Error(
      'plan-tree: registerPlanTreeRoute needs a context that carries the webServer service; '
      + 'call it from ctx.inject([\'webServer\'], (webCtx) => ...)',
    )
  }
  return ctx.webServer.register({
    kind: 'exact',
    path: PLAN_TREE_ROUTE,
    handler: (req, res) => { handlePlanTreeRequest(store, req, res) },
  })
}

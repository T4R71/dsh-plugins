/**
 * Plan tree: a logged, projected plan the model declares once and then walks
 * step by step.
 *
 * Two model-facing tools and one projection unit:
 * - `plan_write` declares the WHOLE tree (a single `plan/declared` snapshot).
 *   It is called once for a piece of work, not rewritten per step.
 * - `plan_step` updates ONE node's status (a single `plan/step` event),
 *   addressed by the node's tree-unique id.
 * - The `planTree` unit folds both into the current tree and publishes it to
 *   client carriers through its wire view.
 *
 * The fold is last-write-wins on the declaration and a structural update on a
 * step: the returned tree is a new object only when the addressed node was
 * actually found, so a `plan/step` naming an unknown id costs nothing
 * downstream (the `Object.is` rule of the projection framework).
 *
 * @module @t4r71/dsh-plan-tree
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PlanNode, PlanStatus } from './types.ts'
// Type-only: resolves the required ctx.sessionProjections service declaration.
import type {} from '@deepseek-ai/dsh-session-projection'
// The `planTree` projection-key declaration lives in src/types.ts (its one
// home); this re-export projects the type face onto the package root AND keeps
// the module edge in the emitted index.d.ts, so aggregate programs consuming
// the declarations still receive the SessionProjectionMap merge.
export type * from './types.ts'

/**
 * The narrow slice of the OPTIONAL Agent Teams service `plan_dispatch` uses.
 *
 * Declared structurally HERE, not imported from
 * `@deepseek-ai/dsh-experimental-agent-team`: that package sits ABOVE
 * plan-tree, so a real (value or type) dependency would invert the layering,
 * and the repo's source-level `paths` facade would pull its whole source tree
 * into this package's `rootDir` program. A soft dependency means knowing only
 * the shape actually called.
 */
interface TeamsDispatchSurface {
  /** Create one shared task; returns at least its durable identity. */
  createTask(
    caller: Agent,
    request: { readonly subject: string; readonly description: string },
  ): Promise<{ readonly id: unknown }>
  /** Queue one durable peer message for `target`. */
  sendMessage(
    caller: Agent,
    request: { readonly target: string; readonly content: ContentBlock[]; readonly signal: AbortSignal },
  ): Promise<unknown>
  /**
   * Mutate one shared task. Only the compensating `delete` is called, which is
   * why the request is narrowed to that one action: a dispatch that fails after
   * its task was created must not leave an orphan behind, and deleting is the
   * only compensation this tool needs.
   */
  updateTask?(
    caller: Agent,
    request: { readonly taskId: unknown; readonly expectedRevision: number; readonly action: 'delete' },
  ): Promise<unknown>
}

/**
 * One question as `plan_ask` submits it. Structural for the same reason
 * {@link TeamsDispatchSurface} is: `@deepseek-ai/dsh-interaction-user-questions`
 * sits ABOVE plan-tree, so importing it would invert the layering and pull its
 * source tree into this package's program.
 */
interface UserQuestionItem {
  /** Stable caller-provided id, echoed back in the answer. */
  id: string
  /** The question to display. */
  question: string
  /** Optional supporting detail rendered with the question. */
  detail?: string
  /** Optional choices the UI renders as a menu. */
  options?: { label: string; description?: string }[]
}

/** One answered question, as the answerer returns it. */
interface UserQuestionAnswerItem {
  /** The answered question id. */
  id: string
  /** Selected option labels. */
  selected: string[]
  /** Optional free-text "Other" answer. */
  custom?: string
}

/** The narrow slice of the OPTIONAL user-questions service `plan_ask` uses. */
interface UserQuestionsSurface {
  /** Ask the scoped answerer waterfall and wait for the human's answer. */
  ask(request: {
    questions: UserQuestionItem[]
    agent?: Agent
    signal?: AbortSignal
  }): Promise<{ answers: UserQuestionAnswerItem[] }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Optional Agent Teams service. Absent in a composition that does not
     * mount the Teams plugin — `plan_dispatch` then degrades to a pure plan
     * transition rather than failing.
     */
    agentTeams?: TeamsDispatchSurface
    /**
     * Optional user-questions service. Absent in a composition with no human
     * answerer — `plan_ask` then keeps its node `blocked` and reports the
     * question as undelivered rather than pretending it was answered.
     */
    userQuestions?: UserQuestionsSurface
  }
}

export const name = 'plan-tree'
// `systemPrompt` is required because this plugin contributes the plan-tree USAGE
// POLICY as a prompt section: without the declaration, reading
// `ctx.systemPrompt` throws "cannot get property without inject" and the whole
// plugin fails to mount. The section and the tools belong together — a tool
// with no usage guidance is present but never chosen.
export const inject = ['tools', 'sessionProjections', 'systemPrompt']

/** The valid {@link PlanStatus} values, as a runtime set for input narrowing. */
const STATUSES = ['pending', 'in_progress', 'completed', 'blocked'] as const

/** Wire payload schema of the `planTree` projection (whole tree or pre-declaration null). */
const planTreeSchema: ZodType<PlanNode[] | null> = zod.union([
  zod.array(zod.lazy(() => planNodeSchema)),
  zod.null(),
])

const planNodeSchema: ZodType<PlanNode> = zod.object({
  id: zod.string(),
  title: zod.string(),
  status: zod.union([
    zod.literal('pending'),
    zod.literal('in_progress'),
    zod.literal('completed'),
    zod.literal('blocked'),
  ]),
  detail: zod.string().optional(),
  task: zod.string().optional(),
  assignedTo: zod.string().optional(),
  answer: zod.string().optional(),
  dependsOn: zod.array(zod.string()).optional(),
  children: zod.array(zod.lazy(() => planNodeSchema)).optional(),
})

/**
 * Fold one `plan/step` into a node: replace its status, and its assignment or
 * answer only when the step carries one.
 *
 * The three states of an optional field are all meaningful and all reachable:
 * ABSENT leaves the node's existing value standing (so an `in_progress` step
 * cannot lose an earlier dispatch's assignment, and a status change cannot lose
 * the answer `plan_ask` recorded); a non-empty STRING sets it; an empty STRING
 * clears it (how a caller releases an assignee). A field that could be set but
 * never cleared would be a one-way door.
 * @param node - the addressed node.
 * @param step - the step's status plus its optional assignment and answer.
 * @returns the updated node.
 */
function applyStep(
  node: PlanNode,
  step: { status: PlanStatus; assignedTo?: string; answer?: string },
): PlanNode {
  const next: PlanNode = { ...node, status: step.status }
  // Each field is independent, so `plan_ask`'s answer survives a dispatch and
  // vice versa. A blank value is stored as absence rather than as the empty
  // string: the panel and `plan_dispatch` both read "no assignee" from the
  // field being missing, and an empty string would render as a nameless owner.
  if (step.assignedTo !== undefined) {
    if (step.assignedTo === '') delete next.assignedTo
    else next.assignedTo = step.assignedTo
  }
  if (step.answer !== undefined) {
    if (step.answer === '') delete next.answer
    else next.answer = step.answer
  }
  return next
}

/**
 * Replace one node's status (and assignment/answer, when the step carries
 * them), rebuilding only the spine from the root to that node. A tree without
 * the id is returned by REFERENCE, which is what keeps an unmatched
 * `plan/step` free.
 * @param nodes - the tree to update.
 * @param id - the addressed node's tree-unique id.
 * @param step - the status to write, plus an optional assignment and answer.
 * @returns a new tree, or the same reference when no node carries `id`.
 */
function setStatus(
  nodes: readonly PlanNode[],
  id: string,
  step: { status: PlanStatus; assignedTo?: string; answer?: string },
): PlanNode[] | null {
  const next = nodes.map((node) => {
    if (node.id === id) return applyStep(node, step)
    if (node.children === undefined) return node
    const children = setStatus(node.children, id, step)
    if (children === null) return node
    return { ...node, children }
  })
  // Changed iff some entry is a new object: identity is the change signal the
  // projection framework's `Object.is` rule reads, so this is the exact test.
  return next.some((node, index) => node !== nodes[index]) ? next : null
}

/**
 * Find one node by its tree-unique id, depth-first in declaration order.
 * @param nodes - the tree to search.
 * @param id - the addressed node's tree-unique id.
 * @returns the node, or `undefined` when the tree does not carry it.
 */
function findNode(nodes: readonly PlanNode[], id: string): PlanNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node
    if (node.children === undefined) continue
    const found = findNode(node.children, id)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Append one node at the END of the ROOT level, without touching any other
 * node.
 *
 * The tree is not restated, and this is deliberately NOT a `plan/declared`
 * snapshot. A whole-tree declaration means "the plan is settled, here it is"
 * and REPLACES everything; re-sending one to add a single node would make
 * every reader re-derive the entire tree, and — worse — a snapshot captured
 * from a stale read would silently drop work declared in between. Appending
 * only states the ONE new fact, so concurrent writers cannot clobber each
 * other's nodes.
 *
 * The node lands at the root level because `plan_ask` names no parent: a
 * question raised mid-work is a top-level decision waiting on the human, not
 * a sub-step of whatever node happened to be in progress.
 * @param nodes - the current tree.
 * @param node - the node to append.
 * @returns a new tree with `node` last.
 */
function appendNode(nodes: readonly PlanNode[], node: PlanNode): PlanNode[] {
  return [...nodes, node]
}

/**
 * Canonicalize the model-supplied tree: trimmed non-empty ids and titles, an
 * `in_progress` count left entirely to the model, and duplicate ids rejected.
 * Ids are unique across the whole tree because `plan_step` addresses a node by
 * id alone.
 * @param raw - the model-supplied nodes, already schema-checked.
 * @param seen - ids collected so far across the whole tree.
 * @returns the canonical tree.
 */
function toPlanNodes(raw: readonly RawNode[], seen: Set<string>): PlanNode[] {
  const nodes: PlanNode[] = []
  for (const item of raw) {
    const id = item.id.trim()
    const title = item.title.trim()
    if (id === '') throw new Error('invalid plan node: `id` must be a non-empty string')
    if (title === '') throw new Error(`invalid plan node ${JSON.stringify(id)}: \`title\` must be a non-empty string`)
    if (seen.has(id)) throw new Error(`invalid plan: duplicate node id ${JSON.stringify(id)}`)
    seen.add(id)
    const node: PlanNode = { id, title, status: item.status as PlanStatus }
    if (item.detail !== undefined) {
      const detail = item.detail.trim()
      if (detail !== '') node.detail = detail
    }
    if (item.task !== undefined) {
      // Same normalization as `detail`: a blank prompt is the ABSENCE of one,
      // so `plan_dispatch` still refuses the node instead of handing a
      // subagent an empty task.
      const task = item.task.trim()
      if (task !== '') node.task = task
    }
    if (item.assignedTo !== undefined) {
      const assignedTo = item.assignedTo.trim()
      if (assignedTo !== '') node.assignedTo = assignedTo
    }
    if (item.dependsOn !== undefined && item.dependsOn.length > 0) {
      // Trimmed, de-duplicated, self-edges dropped: a node waiting on itself
      // is a typo the panel would draw as a zero-length arc, and duplicates
      // would draw the same edge twice.
      const deps = [...new Set(item.dependsOn.map(dep => dep.trim()))]
        .filter(dep => dep !== '' && dep !== id)
      if (deps.length > 0) node.dependsOn = deps
    }
    if (item.children !== undefined && item.children.length > 0) {
      node.children = toPlanNodes(item.children, seen)
    }
    nodes.push(node)
  }
  return nodes
}

/** The model-supplied node shape before canonicalization. */
interface RawNode {
  id: string
  title: string
  status: string
  detail?: string
  task?: string
  assignedTo?: string
  dependsOn?: string[]
  children?: RawNode[]
}

/**
 * Collect every id in a canonicalized tree, for dependency-reference checking.
 * @param nodes - the tree to walk.
 * @param into - the set to fill.
 */
function collectIds(nodes: readonly PlanNode[], into: Set<string>): void {
  for (const node of nodes) {
    into.add(node.id)
    if (node.children !== undefined) collectIds(node.children, into)
  }
}

/**
 * Reject a dependency naming an id the tree does not carry. An edge into
 * nothing would draw as a dangling stub, and — worse — read as a scheduling
 * fence that will never open. Caught at declaration, where the mistake is,
 * rather than in every reader of the projection.
 * @param nodes - the canonicalized tree.
 */
function assertDependenciesResolve(nodes: readonly PlanNode[]): void {
  const ids = new Set<string>()
  collectIds(nodes, ids)
  const walk = (level: readonly PlanNode[]): void => {
    for (const node of level) {
      for (const dep of node.dependsOn ?? []) {
        if (!ids.has(dep)) {
          throw new Error(
            `invalid plan: node ${JSON.stringify(node.id)} depends on unknown node ${JSON.stringify(dep)}`,
          )
        }
      }
      if (node.children !== undefined) walk(node.children)
    }
  }
  walk(nodes)
}

/** Count nodes per status over the whole tree. */
function countStatuses(nodes: readonly PlanNode[]): Record<PlanStatus, number> {
  const counts: Record<PlanStatus, number> = { pending: 0, in_progress: 0, completed: 0, blocked: 0 }
  const walk = (level: readonly PlanNode[]): void => {
    for (const node of level) {
      counts[node.status]++
      if (node.children !== undefined) walk(node.children)
    }
  }
  walk(nodes)
  return counts
}

/** Total node count of a tree. */
function totalNodes(nodes: readonly PlanNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + (node.children === undefined ? 0 : totalNodes(node.children)), 0)
}

/**
 * The usage policy for the plan tree, contributed as a prompt section.
 *
 * Three things have to be true for a model to actually use this, and a tool
 * schema alone establishes none of them: it must know the tree is EXPECTED for
 * multi-step work (not merely available), it must know a node's `task` is what
 * a dispatch delivers, and it must know that dispatch is how a step reaches a
 * teammate — otherwise it delegates with a bare `subagent` call and the plan
 * goes stale, showing work nobody is doing.
 */
const PLAN_TREE_POLICY =
  'For any task with more than a couple of steps, declare a plan with `plan_write` '
  + 'BEFORE starting work, then keep it current with `plan_step` as you go. The plan '
  + 'tree is the user\'s view of what is happening: it is rendered live in the '
  + 'sidebar, so a stale tree is worse than none. Do not restate the whole tree to '
  + 'change one node — that is what `plan_step` is for. '
  + 'A node carries its own `task` prompt (plus optional `dependsOn` and `assignedTo`); '
  + '`plan_dispatch` hands that prompt to a teammate and marks the node `in_progress` '
  + 'in one step, so the plan and the delegation never disagree. Prefer `plan_dispatch` '
  + 'over a bare `subagent` call whenever the work corresponds to a plan node — that is '
  + 'what keeps the tree honest about who is doing what. '
  + 'When a decision is genuinely the user\'s to make, use `plan_ask` rather than '
  + 'guessing: the question becomes a `blocked` node that stays visible beside the '
  + 'steps it shaped, and the answer is written back onto it. '

const PLAN_WRITE_DESCRIPTION =
  'Declare the plan for the current work as a tree. Call this ONCE, when the plan '
  + 'is settled — it REPLACES any previous tree (there are no partial writes, no '
  + 'per-node edits). Every node needs a unique `id` (unique across the whole '
  + 'tree, because plan_step addresses a node by id) and a short imperative '
  + '`title`; nest sub-steps under `children`. After declaring, use plan_step to '
  + 'move each node through its lifecycle — do not rewrite the tree. Statuses: '
  + '`pending` (not started), `in_progress` (being worked on now), `completed` '
  + '(finished), `blocked` (cannot proceed). Skip this tool for trivial '
  + 'single-step tasks. '
  // Re-declaring is destructive and used to look identical to a fresh
  // declaration, so the warning is stated where the model chooses to call it,
  // not only in the result it may not read carefully.
  + 'CAUTION: re-declaring mid-work DESTROYS what the previous tree carried — '
  + 'any node you do not re-list disappears (including a parent\'s `children` if '
  + 'you re-list the parent without them), and re-listing a finished node as '
  + '`pending` rolls its progress back. To change ONE step, use plan_step instead.'

const PLAN_STEP_DESCRIPTION =
  'Update ONE plan node\'s status as the work proceeds. Send only the node\'s `id` '
  + 'and its new `status` — the tree itself is not restated. Call it the moment a '
  + 'step starts (`in_progress`) and the moment it finishes (`completed`), and use '
  + '`blocked` when a step cannot proceed. An id that is not in the current tree '
  + 'is rejected: declare the plan with plan_write first. Use `assignedTo` to name '
  + 'who is doing the step, and note that omitting it leaves any existing '
  + 'assignment standing — pass an empty string to clear one.'

const PLAN_DISPATCH_DESCRIPTION =
  'Hand ONE plan node\'s `task` prompt to a teammate and mark that node '
  + '`in_progress` in the same step. The prompt comes from the node declared by '
  + 'plan_write, or from this call\'s `task` argument when it overrides it. Pass '
  + '`teammate` to deliver it. If no Team service is available (or no `teammate` '
  + 'was given) the step still moves to `in_progress` but NOTHING is dispatched '
  + 'and NO assignee is recorded; the result says so explicitly with '
  + '`dispatched: false`, in which case dispatch the prompt another way or do the '
  + 'work yourself.'

const PLAN_ASK_DESCRIPTION =
  'Ask the user a question that the work is genuinely waiting on, and record it '
  + 'IN the plan: the question becomes a new node (marked `blocked`, with the '
  + 'question as its detail) and the human\'s answer is written onto that node. '
  + 'Use this instead of guessing when a decision is the user\'s to make — the '
  + 'question then stays visible in the plan beside the steps it shaped. When no '
  + 'human answerer is available the node stays `blocked` and the result says the '
  + 'question was never delivered, so you must not treat it as answered.'

/**
 * How many levels of `children` the declared PARAMETER schema spells out.
 *
 * The tool-parameter subset this repo enforces is a closed keyword set with NO
 * `$ref`, and it rejects a cycle ("is circular"), so a truly self-referential
 * schema is impossible. Arbitrary depth is therefore expressed by BOUNDED
 * LITERAL NESTING: {@link nodeParameters} is the level-2 shape, and every
 * deeper level repeats the full node inline. Validation itself runs on an
 * explicit frame stack rather than the JavaScript call stack, so the depth of
 * the literal is the only limit and the compiler's own recursion is what this
 * constant has to stay inside.
 */
const MAX_NODE_SCHEMA_DEPTH = 6

/**
 * One node shape as the parameter DSL sees it, with the SAME property shapes
 * at every level. `children` is optional because the deepest literal omits it;
 * declaring it optional here — rather than modelling the exact depth — keeps
 * `InferArgs` able to walk the recursion without the compiler trying to expand
 * six distinct literal levels.
 */
interface NodeParameterShape {
  type: 'object'
  additionalProperties: false
  properties: {
    id: { type: 'string'; required: true; description: string }
    title: { type: 'string'; required: true; description: string }
    status: { type: 'string'; required: true; enum: readonly string[]; description: string }
    detail: { type: 'string'; description: string }
    task: { type: 'string'; description: string }
    assignedTo: { type: 'string'; description: string }
    dependsOn: { type: 'array'; items: { type: 'string' }; description: string }
    children?: { type: 'array'; items: NodeParameterShape; description: string }
  }
}

/** One node shape at `depth`, with `MAX_NODE_SCHEMA_DEPTH - depth` levels of `children` left below it. */
function nodeShape(depth: number): NodeParameterShape {
  const leaf = depth >= MAX_NODE_SCHEMA_DEPTH
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', required: true, description: 'Unique within the whole tree; plan_step addresses nodes by this value.' },
      title: { type: 'string', required: true, description: 'What this step is — a short imperative line.' },
      status: {
        type: 'string',
        required: true,
        enum: [...STATUSES],
        description: 'pending (not started) | in_progress (now) | completed (done) | blocked (cannot proceed).',
      },
      detail: { type: 'string', description: 'Optional longer explanation of the step.' },
      task: {
        type: 'string',
        description: 'Prompt to hand a subagent when this node is dispatched by plan_dispatch.',
      },
      assignedTo: {
        type: 'string',
        description: 'Name of the teammate doing this node. Normally written by plan_dispatch; declare it to pre-assign.',
      },
      dependsOn: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ids of nodes this one waits on (advisory: drawn as a dependency edge in the panel, never enforced by plan_step). Each id must exist somewhere in the same tree.',
      },
      // Omitted at the depth limit rather than declared empty: an empty
      // `items` would accept ANY JSON item, which is strictly worse than
      // refusing a seventh level outright.
      ...(leaf ? {} : {
        children: {
          type: 'array' as const,
          items: nodeShape(depth + 1),
          description: 'Nested sub-steps, in display order.',
        },
      }),
    },
  }
}

/** One node as the tools' parameter schema declares it, recursively (bounded literal nesting). */
const nodeParameters = nodeShape(1)

/**
 * Register the `planTree` unit on `ctx.sessionProjections`, the four
 * model-facing tools on `ctx.tools`, and the usage policy that tells a model
 * when to reach for them.
 * @param ctx - registrant context carrying the tool and session-projection registries.
 */
export function apply(ctx: Context): void {
  // Usage policy ships WITH the tool, which is the master convention here (see
  // `tool-workflow`): guidance lives in the tool plugin as a prompt section, not
  // in the deployment persona. Without this section the tools exist and are
  // never chosen — a model has no way to learn from a bare schema that a plan
  // tree is expected for multi-step work, or that dispatching a step is how it
  // hands work to a teammate.
  //
  // `PLAN_POLICY` sits with the other policy sections (500) rather than among
  // the per-tool sections (1000+): this states WHEN the plan is required, which
  // is a workflow rule the model must weigh before picking any tool, and it has
  // to be read before `plan_write`'s own description rather than after it.
  ctx.systemPrompt.section({
    name: 'plan:tree',
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
    text: PLAN_TREE_POLICY,
  })

  // The declared tree with every folded step applied. Only `plan/declared`
  // and `plan/step` are this unit's; every other event returns the same state
  // reference, which is the framework's zero-work signal.
  ctx.sessionProjections.register<'planTree', PlanNode[] | null>({
    key: 'planTree',
    stateSchema: planTreeSchema,
    init: () => null,
    apply: (state, event) => {
      if (event.type === 'plan/declared') return event.data.plan
      if (event.type === 'plan/step') {
        if (state === null) return state
        return setStatus(state, event.data.id, event.data) ?? state
      }
      return state
    },
    wire: { viewSchema: planTreeSchema, view: state => state },
    stateVersion: 1,
  })

  ctx.tools.register(defineTool({
    name: 'plan_write',
    description: PLAN_WRITE_DESCRIPTION,
    parameters: {
      nodes: {
        type: 'array',
        required: true,
        description: 'The COMPLETE plan tree, replacing any previous tree.',
        items: nodeParameters,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          counts: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              pending: { type: 'integer', required: true },
              inProgress: { type: 'integer', required: true },
              completed: { type: 'integer', required: true },
              blocked: { type: 'integer', required: true },
            },
          },
          dropped: { type: 'array', items: { type: 'string' }, description: 'Ids the previous tree carried and this declaration does not.' },
          regressed: { type: 'array', items: { type: 'string' }, description: 'Ids that were completed before this declaration and are not now.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Plan declared: ${value.total} step${value.total === 1 ? '' : 's'} `
          + `(${value.counts.pending} pending, ${value.counts.inProgress} in progress, `
          + `${value.counts.completed} completed, ${value.counts.blocked} blocked). `
          + 'Use plan_step to update each step\'s status as you work.'
          + (value.dropped === undefined || value.dropped.length === 0
            ? ''
            : ` WARNING: this REPLACED the tree and dropped ${value.dropped.length} node(s) not `
              + `re-listed: ${value.dropped.join(', ')}.`)
          + (value.regressed === undefined || value.regressed.length === 0
            ? ''
            : ` WARNING: it also reset progress on ${value.regressed.join(', ')}, which were completed.`),
      }],
    },
    execute(args, exec) {
      const nodes = toPlanNodes(args.nodes, new Set<string>())
      assertDependenciesResolve(nodes)
      if (!exec.agent) {
        // The tree is per-agent-session state; a non-agent caller (no owning
        // session) has nowhere to write it. Reject rather than silently no-op.
        throw new Error('plan_write requires an owning agent session')
      }
      // A declaration REPLACES the tree (last-write-wins). Report what that
      // destroys, because the caller cannot otherwise tell: re-declaring a
      // parent WITHOUT its `children` drops the subtree, and re-listing a node
      // as `pending` silently rolls back progress a `plan_step` recorded. The
      // tool used to answer only with counts, so a destructive overwrite looked
      // exactly like a fresh declaration.
      const before = ctx.sessionProjections.stateOf(exec.agent.session, 'planTree') ?? null
      const dropped: string[] = []
      const regressed: string[] = []
      if (before !== null) {
        const afterIds = new Set<string>()
        collectIds(nodes, afterIds)
        const beforeIds = new Set<string>()
        collectIds(before, beforeIds)
        for (const id of beforeIds) if (!afterIds.has(id)) dropped.push(id)
        const beforeStatus = new Map<string, PlanStatus>()
        const walkStatuses = (list: readonly PlanNode[]): void => {
          for (const node of list) {
            beforeStatus.set(node.id, node.status)
            if (node.children !== undefined) walkStatuses(node.children)
          }
        }
        walkStatuses(before)
        const walkAfter = (list: readonly PlanNode[]): void => {
          for (const node of list) {
            const was = beforeStatus.get(node.id)
            if (was === 'completed' && node.status !== 'completed') regressed.push(node.id)
            if (node.children !== undefined) walkAfter(node.children)
          }
        }
        walkAfter(nodes)
      }
      exec.agent.session.append('plan/declared', { plan: nodes })
      const counts = countStatuses(nodes)
      return Promise.resolve({
        total: totalNodes(nodes),
        counts: {
          pending: counts.pending,
          inProgress: counts.in_progress,
          completed: counts.completed,
          blocked: counts.blocked,
        },
        ...(dropped.length === 0 ? {} : { dropped }),
        ...(regressed.length === 0 ? {} : { regressed }),
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Declare plan', kind: 'other', rawInput: args.nodes }),
  }))

  ctx.tools.register(defineTool({
    name: 'plan_step',
    description: PLAN_STEP_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: 'The id of the node to update, as declared by plan_write.' },
      status: {
        type: 'string',
        required: true,
        enum: [...STATUSES],
        description: 'pending (not started) | in_progress (now) | completed (done) | blocked (cannot proceed).',
      },
      // Declared so a caller CAN set them. Without these two the parameter
      // validator raises no violation for an undeclared property, so
      // `plan_step { id, status, assignedTo }` returned SUCCESS while the
      // assignment was dropped on the floor (the tool built its event from
      // `args.status` alone). A field the event type carries must be reachable
      // from the tool surface, or the caller is told it worked when it did not.
      //
      // NOTE: the parameter ROOT is an implicit open object (see
      // ParameterSchemaSpec), so it cannot carry `additionalProperties: false`
      // — a misspelled argument is therefore still accepted and ignored by the
      // framework. Declaring every real field is the most this tool can do.
      assignedTo: {
        type: 'string',
        description: 'Name of the teammate now doing this step. Omit to leave any existing assignment standing; pass an empty string to clear it.',
      },
      answer: {
        type: 'string',
        description: 'The human\'s answer to this step\'s question. Omit to leave any existing answer standing; pass an empty string to clear it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: [...STATUSES] },
          counts: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              pending: { type: 'integer', required: true },
              inProgress: { type: 'integer', required: true },
              completed: { type: 'integer', required: true },
              blocked: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Step ${JSON.stringify(value.id)} is now ${value.status}. `
          + `(${value.counts.completed}/${value.counts.completed + value.counts.inProgress
            + value.counts.pending + value.counts.blocked} done.)`,
      }],
    },
    execute(args, exec) {
      const id = args.id.trim()
      if (id === '') throw new Error('invalid plan step: `id` must be a non-empty string')
      if (!(STATUSES as readonly string[]).includes(args.status)) {
        throw new Error(`invalid plan step: \`status\` must be one of ${STATUSES.join(', ')} (got ${JSON.stringify(args.status)})`)
      }
      if (!exec.agent) {
        throw new Error('plan_step requires an owning agent session')
      }
      const session = exec.agent.session
      // Read the folded tree back so an id the current plan does not carry is
      // rejected here instead of being logged as a silent no-op.
      const tree = ctx.sessionProjections.stateOf(session, 'planTree')
      if (tree === undefined) throw new Error('plan_step requires the planTree session projection')
      if (tree === null) {
        throw new Error('plan_step found no plan: declare one with plan_write first')
      }
      // Both optional fields are read from the arguments. An OMITTED field
      // leaves the node's existing value standing (see `applyStep`), while a
      // BLANK one clears it — that is how a caller releases an assignment or
      // retracts an answer, and it is the only way: without it the field could
      // be written but never removed.
      const assignedTo = args.assignedTo === undefined ? undefined : args.assignedTo.trim()
      const answer = args.answer === undefined ? undefined : args.answer.trim()
      const step: { status: PlanStatus; assignedTo?: string; answer?: string } = { status: args.status }
      if (assignedTo !== undefined) step.assignedTo = assignedTo
      if (answer !== undefined) step.answer = answer
      if (setStatus(tree, id, step) === null) {
        throw new Error(`plan_step found no node with id ${JSON.stringify(id)} in the current plan`)
      }
      session.append('plan/step', { id, status: args.status, ...assignedTo === undefined ? {} : { assignedTo }, ...answer === undefined ? {} : { answer } })
      const updated = ctx.sessionProjections.stateOf(session, 'planTree') ?? tree
      const counts = countStatuses(updated)
      return Promise.resolve({
        id,
        status: args.status,
        counts: {
          pending: counts.pending,
          inProgress: counts.in_progress,
          completed: counts.completed,
          blocked: counts.blocked,
        },
      })
    },
    presentCall: args => ({ card: 'generic', title: `Plan step: ${args.id}`, kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'plan_dispatch',
    description: PLAN_DISPATCH_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: 'The plan node to dispatch.' },
      task: { type: 'string', description: 'Override the node task prompt.' },
      teammate: { type: 'string', description: 'Teammate name to hand the task to.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: [...STATUSES] },
          dispatched: { type: 'boolean', required: true },
          taskId: { type: 'string' },
          dispatchedTo: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.dispatched
          ? `Step ${JSON.stringify(value.id)} is now ${value.status}; dispatched to `
            + `${JSON.stringify(value.dispatchedTo ?? '')} as task ${JSON.stringify(value.taskId ?? '')}.`
          : `Step ${JSON.stringify(value.id)} is now ${value.status}. ${value.note ?? ''}`,
      }],
    },
    async execute(args, exec) {
      const id = args.id.trim()
      if (id === '') throw new Error('invalid plan dispatch: `id` must be a non-empty string')
      if (!exec.agent) {
        throw new Error('plan_dispatch requires an owning agent session')
      }
      const session = exec.agent.session
      const tree = ctx.sessionProjections.stateOf(session, 'planTree')
      if (tree === undefined) throw new Error('plan_dispatch requires the planTree session projection')
      if (tree === null) {
        throw new Error('plan_dispatch found no plan: declare one with plan_write first')
      }
      const target = findNode(tree, id)
      if (target === undefined) {
        throw new Error(`plan_dispatch found no node with id ${JSON.stringify(id)} in the current plan`)
      }
      const override = args.task?.trim()
      const prompt = override !== undefined && override !== '' ? override : target.task
      if (prompt === undefined) {
        throw new Error(
          `plan_dispatch found no task for node ${JSON.stringify(id)}: `
          + 'declare it with plan_write or pass `task`',
        )
      }

      // Optional sibling service: plan-tree must stay independently composable
      // and must not depend on agent-team, so a missing service degrades the
      // DISPATCH only — the plan transition below still happens.
      const teammate = args.teammate?.trim()
      const teams = ctx.get('agentTeams')
      if (teams === undefined || teammate === undefined || teammate === '') {
        // Nothing was handed to anyone, so NO assignment is recorded: a node
        // marked `in_progress` with no assignee reads as "someone is on it and
        // the panel just cannot say who", which is exactly the wrong story.
        // The status still moves — the caller asked to start this step, and the
        // prompt is reported back so it can be dispatched another way.
        session.append('plan/step', { id, status: 'in_progress' })
        return {
          id,
          status: 'in_progress' as const,
          dispatched: false as const,
          note: teammate === undefined || teammate === ''
            ? 'No `teammate` was given, so the step was marked in_progress but the prompt was '
              + 'handed to nobody. Pass `teammate` to dispatch it, or do the work yourself.'
            : `No Team service is mounted in this composition, so ${JSON.stringify(teammate)} could `
              + 'not be reached. The step is marked in_progress with NO assignee; dispatch it '
              + 'another way or do the work yourself.',
        }
      }

      const created = await teams.createTask(exec.agent, {
        subject: target.title,
        description: prompt,
      })
      try {
        await teams.sendMessage(exec.agent, {
          target: teammate,
          content: [{ type: 'text', text: prompt }],
          signal: exec.signal,
        })
      } catch (error: unknown) {
        // Compensate: the task was created but never handed over, so leaving it
        // would put a task on the board that no teammate was ever told about —
        // and the plan step below does NOT run, so nothing points at it either.
        // Best-effort: if the compensation itself fails, the original error is
        // still the one worth reporting, so it is rethrown either way.
        await teams.updateTask?.(
          exec.agent,
          { taskId: created.id, expectedRevision: 1, action: 'delete' },
        ).catch(() => undefined)
        throw error
      }
      // The assignment rides the SAME step event as the status change: one
      // atomic transition the projection folds, so the panel never shows an
      // `in_progress` node with nobody on it.
      session.append('plan/step', { id, status: 'in_progress', assignedTo: teammate })
      return {
        id,
        status: 'in_progress' as const,
        dispatched: true as const,
        taskId: String(created.id),
        dispatchedTo: teammate,
      }
    },
    presentCall: args => ({ card: 'generic', title: `Dispatch: ${args.id}`, kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'plan_ask',
    description: PLAN_ASK_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: 'Unique id for the question\'s plan node; must not already exist in the tree.' },
      question: { type: 'string', required: true, description: 'The question to put to the user.' },
      title: { type: 'string', description: 'Short node title; defaults to the question itself.' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional answers the user can pick from; they may still answer freely in their own words.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          question: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: [...STATUSES] },
          answer: { type: 'string' },
          delivered: { type: 'boolean', required: true },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.delivered
          ? `Asked ${JSON.stringify(value.id)}: ${value.question} — the user answered: `
            + `${value.answer ?? '(no text)'}. The node is now ${value.status}.`
          : `Could NOT ask the user ${JSON.stringify(value.id)}: ${value.question} `
            + `The node ${JSON.stringify(value.id)} stays \`blocked\`. ${value.note ?? ''}`.trim(),
      }],
    },
    async execute(args, exec) {
      const id = args.id.trim()
      if (id === '') throw new Error('invalid plan ask: `id` must be a non-empty string')
      const question = args.question.trim()
      if (question === '') throw new Error('invalid plan ask: `question` must be a non-empty string')
      if (!exec.agent) {
        throw new Error('plan_ask requires an owning agent session')
      }
      const session = exec.agent.session
      const tree = ctx.sessionProjections.stateOf(session, 'planTree')
      if (tree === undefined) throw new Error('plan_ask requires the planTree session projection')
      if (tree === null) {
        throw new Error('plan_ask found no plan: declare one with plan_write first')
      }
      if (findNode(tree, id) !== undefined) {
        throw new Error(`plan_ask found an existing node with id ${JSON.stringify(id)} in the current plan`)
      }

      // The question becomes a node BEFORE it is asked, so the plan records
      // what the work is waiting on even if the user never answers (a
      // disconnected UI, a cancelled turn). `blocked` is the honest status:
      // this node is the reason the tree cannot advance.
      const title = args.title?.trim()
      const node: PlanNode = {
        id,
        title: title === undefined || title === '' ? question : title,
        status: 'blocked',
        detail: question,
      }
      // Appended as ONE new node rather than re-declaring the whole tree: see
      // `appendNode` for why a `plan/declared` snapshot here would be wrong.
      session.append('plan/declared', { plan: appendNode(tree, node) })

      // Optional sibling service: plan-tree stays independently composable, so
      // a missing answerer degrades the ASK only — the node above already
      // records the question.
      const asked = ctx.get('userQuestions')
      if (asked === undefined) {
        return {
          id,
          question,
          status: 'blocked' as const,
          delivered: false,
          note: 'No user-questions service is mounted in this composition, so the question '
            + 'was never shown to the user. Ask it in your final response instead.',
        }
      }

      const labels = (args.options ?? []).map(label => label.trim()).filter(label => label !== '')
      let answer: UserQuestionAnswerItem | undefined
      try {
        const replies = await asked.ask({
          questions: [{
            id,
            question,
            ...(labels.length === 0 ? {} : { options: labels.map(label => ({ label })) }),
          }],
          agent: exec.agent,
          signal: exec.signal,
        })
        answer = replies.answers.find(entry => entry.id === id)
      } catch (cause) {
        // A question that reached no human is NOT an answered one. The node
        // stays `blocked` and the failure is reported, because silently
        // returning a status the caller reads as success would let the model
        // proceed on an answer that does not exist.
        return {
          id,
          question,
          status: 'blocked' as const,
          delivered: false,
          note: `The question could not be delivered to the user (${describeAskFailure(cause)}). `
            + 'It is recorded as a blocked node; ask it in your final response instead.',
        }
      }

      if (answer === undefined) {
        return {
          id,
          question,
          status: 'blocked' as const,
          delivered: false,
          note: `The answerer returned no entry for question ${JSON.stringify(id)}. `
            + 'The node stays `blocked`; the question was not answered.',
        }
      }

      const text = formatAnswer(answer)
      // The answer rides the SAME step event as the status change, so the
      // panel never shows a completed question node with its answer missing.
      session.append('plan/step', { id, status: 'completed', answer: text })
      return { id, question, status: 'completed' as const, answer: text, delivered: true }
    },
    presentCall: args => ({ card: 'generic', title: `Ask: ${args.id}`, kind: 'other', rawInput: args }),
  }))
}

/**
 * Render one answer as the node's `answer` text: the selected labels, with any
 * free-text "Other" appended. Both halves matter — a user who picked an option
 * AND typed a caveat gave an answer neither half states alone.
 * @param answer - the answered question.
 * @returns the answer text.
 */
function formatAnswer(answer: UserQuestionAnswerItem): string {
  const selected = answer.selected.join(', ')
  const custom = answer.custom?.trim() ?? ''
  if (custom === '') return selected
  if (selected === '') return custom
  return `${selected} — ${custom}`
}

/**
 * Describe why an ask did not reach a human, in terms a model can act on.
 * @param cause - the thrown value.
 * @returns a short human-readable reason.
 */
function describeAskFailure(cause: unknown): string {
  const code = cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
    ? cause.code
    : undefined
  if (code === 'NO_PROVIDER') return 'no answerer is available to receive it'
  if (code === 'CALLER_NOT_LIVE') return 'the calling agent is not the live instance the answerer admits'
  if (code === 'DELEGATED_CALLER') return 'the calling agent has no reachable live root to bubble the question to'
  if (code === 'ASK_ABORTED') return 'the turn was cancelled before the user answered'
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Task tree host half: one `sessionProjections` unit under the `taskTree`
 * key, plus the `task_tree_write` tool a producer declares the array with.
 *
 * The fold is a pass-through. `taskTree/declared` carries a whole array, the
 * unit stores that exact reference, and the wire view returns it unchanged.
 * Every other event returns the same state reference, which is the projection
 * framework's zero-work signal, so an unrelated event costs one comparison.
 *
 * @module @t4r71/dsh-task-tree-host
 */

import type { Context } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TaskTreeNode } from './types.ts'
// Type-only: resolves the required ctx.sessionProjections service declaration.
import type {} from '@deepseek-ai/dsh-session-projection'
// The `taskTree` projection-key declaration lives in src/types.ts (its one
// home); this re-export keeps the module edge in the emitted index.d.ts so
// aggregate programs consuming the declarations still receive the
// SessionProjectionMap merge.
export type * from './types.ts'

export const name = 'task-tree-host'
export const inject = ['tools', 'sessionProjections']

/** Wire payload schema of the `taskTree` projection (whole array or pre-declaration null). */
const taskTreeSchema: ZodType<TaskTreeNode[] | null> = zod.union([
  zod.array(zod.lazy(() => taskNodeSchema)),
  zod.null(),
])

const taskNodeSchema: ZodType<TaskTreeNode> = zod.object({
  id: zod.string(),
  title: zod.string(),
  children: zod.array(zod.lazy(() => taskNodeSchema)).optional(),
}).catchall(zod.unknown())

/**
 * Count every entry in the array, nested ones included.
 * @param nodes - the array to count.
 * @returns the total entry count.
 */
function countNodes(nodes: readonly TaskTreeNode[]): number {
  let total = 0
  for (const node of nodes) {
    total += 1
    if (node.children !== undefined) total += countNodes(node.children)
  }
  return total
}

/**
 * How many levels of `children` the declared PARAMETER schema spells out.
 *
 * The tool-parameter subset this repo enforces is a closed keyword set with no
 * `$ref` and rejects a cycle, so a self-referential schema is impossible;
 * arbitrary depth is expressed by BOUNDED LITERAL NESTING, the same idiom the
 * plan tree uses. Validation itself walks an explicit frame stack, so the
 * depth of this literal is the only limit.
 */
const MAX_NODE_SCHEMA_DEPTH = 6

/** One entry as the parameter DSL sees it, with the SAME property shapes at every level. */
interface NodeParameterShape {
  type: 'object'
  additionalProperties: false
  properties: {
    id: { type: 'string'; required: true; description: string }
    title: { type: 'string'; required: true; description: string }
    children?: { type: 'array'; items: NodeParameterShape; description: string }
  }
}

/** One entry shape at `depth`, with `MAX_NODE_SCHEMA_DEPTH - depth` levels of `children` left below it. */
function nodeShape(depth: number): NodeParameterShape {
  const leaf = depth >= MAX_NODE_SCHEMA_DEPTH
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', required: true, description: 'Stable identity, unique within the whole array.' },
      title: { type: 'string', required: true, description: 'Short label of the entry.' },
      // Omitted at the depth limit rather than declared empty: an empty
      // `items` would accept ANY JSON item, which is strictly worse than
      // refusing a seventh level outright.
      ...(leaf ? {} : {
        children: {
          type: 'array' as const,
          items: nodeShape(depth + 1),
          description: 'Optional nested entries, in producer order.',
        },
      }),
    },
  }
}

/** One entry as the tool parameter schema declares it, recursively (bounded literal nesting). */
const nodeParameters = nodeShape(1)

/** One model-supplied entry, as the argument validator hands it over. */
interface RawNode {
  id: string
  title: string
  children?: readonly RawNode[] | undefined
}

/**
 * Copy the model-supplied entries into transported entries, recursing into
 * `children`. Blank ids and titles are rejected here rather than being
 * transported: the panel cannot render an entry with no label, so accepting
 * one would put an untitled row in front of a human.
 * @param raw - the schema-checked entries.
 * @returns the transported array.
 */
function toNodes(raw: readonly RawNode[]): TaskTreeNode[] {
  return raw.map((item) => {
    const id = item.id.trim()
    const title = item.title.trim()
    if (id === '') throw new Error('invalid task-tree node: `id` must be a non-empty string')
    if (title === '') throw new Error('invalid task-tree node ' + JSON.stringify(id) + ': `title` must be a non-empty string')
    const node: TaskTreeNode = { id, title }
    if (item.children !== undefined) node.children = toNodes(item.children)
    return node
  })
}
/**
 * Mount the `taskTree` projection unit and the `task_tree_write` tool.
 * @param ctx - the plugin context, requiring `tools` and `sessionProjections`.
 */
export function apply(ctx: Context): void {
  // The declared array, transported verbatim. Only `taskTree/declared` is this
  // unit's; every other event returns the same state reference.
  ctx.sessionProjections.register<'taskTree', TaskTreeNode[] | null>({
    key: 'taskTree',
    stateSchema: taskTreeSchema,
    init: () => null,
    apply: (state, event) => {
      if (event.type === 'taskTree/declared') return event.data.nodes
      return state
    },
    wire: { viewSchema: taskTreeSchema, view: state => state },
    stateVersion: 1,
  })

  ctx.tools.register(defineTool({
    name: 'task_tree_write',
    description: 'Declare the whole task tree for this session. The array replaces any previous tree; the host transports it verbatim.',
    parameters: {
      nodes: {
        type: 'array',
        required: true,
        description: 'The COMPLETE task-tree array, replacing any previous tree.',
        items: nodeParameters,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: 'Task tree declared: ' + String(value.total) + ' node(s).' }],
    },
    execute(args, exec) {
      if (!exec.agent) {
        // The tree is per-agent-session state; a non-agent caller (no owning
        // session) has nowhere to write it. Reject rather than silently no-op.
        throw new Error('task_tree_write requires an owning agent session')
      }
      const nodes = toNodes(args.nodes as readonly RawNode[])
      exec.agent.session.append('taskTree/declared', { nodes })
      return Promise.resolve({ total: countNodes(nodes) })
    },
    presentCall: args => ({ card: 'generic', title: 'Declare task tree', kind: 'other', rawInput: args.nodes }),
  }))
}
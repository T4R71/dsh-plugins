/**
 * 浏览器半边：把 task-tree 注册成一个右侧边栏标签页类型。
 *
 * 照 ui-plan-tree 的两阶段公开路径：类型进 sidebarRightTabs，正文进 keyed 席位
 * sidebar.right.pane.tab、标题进 sidebar.right.pane.tab.title —— 都在本包 id 下。
 *
 * 面板读的是**宿主自己那条只读 HTTP 路由**（`GET /t4/plan-tree`，见
 * `@t4r71/dsh-plan-tree/http-route`），不是设置文档的镜像、也不是会话投影：树存在宿主
 * 的 SQLite 里，随会话日志和 profile 文档一起消失过。所以本包仍然没有 Remote、没有任何
 * 宿主行为 —— 它一个服务都不多要，只拿浏览器本来就有 `fetch`。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { TASK_TREE_ID, taskTreeDefinition } from './definition.tsx'
import { PLAN_TREE_ROUTE, PlanTreeDirectory } from './plan-tree.ts'
import { TaskTreePanel, TaskTreeTitle } from './TaskTreePanel.tsx'
import { en, zh } from './locales.ts'

export type { TaskTreeKey } from './locales.ts'
export type { TaskTreePanelInjected, TaskTreePanelProps } from './TaskTreePanel.tsx'
export type { PlanNode, PlanStatus, PlanTreesSection } from './plan-tree-data.ts'
export type { PlanTreeMergedReader, PlanTreeReader, PlanTreeSnapshot, PlanTreeView } from './plan-tree.ts'
export type {
  OwnerBadge, OwnerBadgeIndex, OwnerStatus, TeamMemberLike, TeamProjectionLike, TreeNodeLike,
} from './teammate-status.ts'
export type { OutlineRow, OwnerIndex, RowOwner } from './list.ts'
export { mergedTreeOf, planTreeOf, planTreesOf, planTreesSectionOf } from './plan-tree-data.ts'
export {
  PLAN_TREE_FIELD, PLAN_TREE_NAMESPACE, PLAN_TREE_ROUTE, POLL_INTERVAL_MS, PlanTreeDirectory,
} from './plan-tree.ts'
export { fallbackOwnerOf, ownerBadgesOf, ownerBadgesWithFallback, ownerStatusOf } from './teammate-status.ts'

/** 本包的文案命名空间。 */
const NS = 'taskTree'

/** 需要的浏览器服务：标签页注册表、keyed 席位、文案。取数不再要任何服务。 */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * 客户端插件主体：注册类型、字典、正文与标题。
 * @param ctx - 客户端根上下文
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  // 任务树目录：轮询宿主那条只读路由，按会话 id 给三态读数。生命周期属于插件，所以建在
  // 这里、在 effect 的 disposer 里停掉轮询与可见性订阅，而不是建在面板组件里（组件每次
  // 重挂载都会多起一个定时器）。
  //
  // 会话 id 此刻还不知道（要等外壳开页）—— 但这**不影响取数**：那条端点一次回答全部
  // 会话，目录挂了就开始轮询，不拿当前会话当闸门。要看哪一条会话是**渲染时**的事，
  // 由面板把 props 里的 sessionId 传给 treeOf / mergedTreeOf。
  const directory = new PlanTreeDirectory(PLAN_TREE_ROUTE)
  ctx.effect(() => () => { directory.dispose() }, 'ui-task-tree: plan tree directory')
  ctx.effect(() => ctx.sidebarRightTabs.register(taskTreeDefinition(t)), 'ui-task-tree: type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-task-tree: dictionaries')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TASK_TREE_ID, locale: NS, inject: () => ({ directory }) },
    TaskTreePanel,
  )), 'ui-task-tree: tab body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: TASK_TREE_ID },
    TaskTreeTitle,
  )), 'ui-task-tree: tab title')
}

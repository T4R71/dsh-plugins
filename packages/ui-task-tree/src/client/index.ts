/**
 * 浏览器半边：把 task-tree 注册成一个右侧边栏标签页类型。
 *
 * 照 ui-plan-tree 的两阶段公开路径：类型进 sidebarRightTabs，正文进 keyed 席位
 * sidebar.right.pane.tab、标题进 sidebar.right.pane.tab.title —— 都在本包 id 下。
 *
 * 面板读的是**设置文档的镜像**（\`ctx.configForms.describe()\` 里宿主的
 * \`plan-tree-sessions\` 命名空间），不是会话投影：树不再随会话日志下发。所以本包
 * 仍然没有 Remote、没有宿主行为 —— 它只多要一个 \`configForms\` 服务。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
// Type-only: 拉入 ctx.configForms 的 Context 合并与镜像快照类型。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { TASK_TREE_ID, taskTreeDefinition } from './definition.tsx'
import { PlanTreeDirectory } from './plan-tree.ts'
import { TaskTreePanel, TaskTreeTitle } from './TaskTreePanel.tsx'
import { en, zh } from './locales.ts'

export type { TaskTreeKey } from './locales.ts'
export type { TaskTreePanelInjected, TaskTreePanelProps } from './TaskTreePanel.tsx'
export type { PlanNode, PlanStatus, PlanTreesSection } from './plan-tree-data.ts'
export type { PlanTreeMergedReader, PlanTreeReader, PlanTreeView } from './plan-tree.ts'
export type {
  OwnerBadge, OwnerBadgeIndex, OwnerStatus, TeamMemberLike, TeamProjectionLike, TreeNodeLike,
} from './teammate-status.ts'
export type { OutlineRow, OwnerIndex, RowOwner } from './list.ts'
export { mergedTreeOf, planTreeOf, planTreesOf, planTreesSectionOf } from './plan-tree-data.ts'
export { PLAN_TREE_FIELD, PLAN_TREE_NAMESPACE, PlanTreeDirectory, planTreeView } from './plan-tree.ts'
export { fallbackOwnerOf, ownerBadgesOf, ownerBadgesWithFallback, ownerStatusOf } from './teammate-status.ts'

/** 本包的文案命名空间。 */
const NS = 'taskTree'

/** 需要的浏览器服务：标签页注册表、keyed 席位、文案、配置文档镜像。 */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'configForms']

/**
 * 客户端插件主体：注册类型、字典、正文与标题。
 * @param ctx - 客户端根上下文
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  // 任务树目录：订阅共享的 describe 镜像，按会话 id 给三态读数。生命周期属于插件，
  // 所以建在这里、在 effect 的 disposer 里摘订阅，而不是建在面板组件里。
  const directory = new PlanTreeDirectory(ctx.configForms.describe())
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

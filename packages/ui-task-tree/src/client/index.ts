/**
 * 浏览器半边：把 task-tree 注册成一个右侧边栏标签页类型。
 *
 * 照 ui-plan-tree 的两阶段公开路径：类型进 sidebarRightTabs，正文进 keyed 席位
 * sidebar.right.pane.tab、标题进 sidebar.right.pane.tab.title —— 都在本包 id 下。
 * 面板读 planTree 会话投影，所以本包没有 Remote、没有 store、没有宿主行为。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { TASK_TREE_ID, taskTreeDefinition } from './definition.tsx'
import { TaskTreePanel, TaskTreeTitle } from './TaskTreePanel.tsx'
import { en, zh } from './locales.ts'

export type { TaskTreeKey } from './locales.ts'
export type { TaskTreePanelProps } from './TaskTreePanel.tsx'

/** 本包的文案命名空间。 */
const NS = 'taskTree'

/** 需要的浏览器服务：标签页注册表、keyed 席位、文案。 */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * 客户端插件主体：注册类型、字典、正文与标题。
 * @param ctx - 客户端根上下文
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(taskTreeDefinition(t)), 'ui-task-tree: type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-task-tree: dictionaries')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TASK_TREE_ID, locale: NS },
    TaskTreePanel,
  )), 'ui-task-tree: tab body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: TASK_TREE_ID },
    TaskTreeTitle,
  )), 'ui-task-tree: tab title')
}
/**
 * Browser half: register `plan-tree` as a right-Sidebar tab type.
 *
 * The public two-stage path, unmodified: the type into `ctx.sidebarRightTabs`,
 * the body into the keyed `sidebar.right.pane.tab` seat and the chip title into
 * the keyed `sidebar.right.pane.tab.title` seat, both under the type's `id`.
 *
 * The panel reads the `planTree` session projection, so this package owns no
 * Remote, no store, and no host-side behavior of its own.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { PLAN_TREE_ID, planTreeDefinition } from './definition.tsx'
import { PlanTreePanel, PlanTreeTitle } from './PlanTreePanel.tsx'
import { en, zh } from './locales.ts'

export type { PlanTreeKey } from './locales.ts'
export type { PlanTreePanelProps } from './PlanTreePanel.tsx'

/** This package's copy namespace. */
const NS = 'planTree'

/** Required browser services: the tab registry, the keyed seats, and copy. */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * Client plugin body: register the type, its dictionaries, its body, and its chip title.
 * @param ctx - client root context carrying the registry, the slots, and copy.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(planTreeDefinition(t)), 'ui-plan-tree: plan-tree type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-plan-tree: dictionaries')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: PLAN_TREE_ID, locale: NS },
    PlanTreePanel,
  )), 'ui-plan-tree: plan-tree tab body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: PLAN_TREE_ID },
    PlanTreeTitle,
  )), 'ui-plan-tree: plan-tree tab title')
}

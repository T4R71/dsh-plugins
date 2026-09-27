/**
 * Stage one of this package's registration: what the `plan-tree` tab type IS.
 *
 * The type is a page, not a viewer: it claims no address. The guide page offers
 * it as an entry box, and the panel itself reads the `planTree` and `agentTeam`
 * session projections — nothing in `ui-sidebar-right` knows this package exists.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type {} from './locales.ts'
import { IconPlanOutline14, type IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** The tab kind this package owns. */
export const PLAN_TREE_KIND = 'plan-tree'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const PLAN_TREE_ID = '@t4r71/dsh-ui-plan-tree'

/** The guide capsule's plan glyph at the capsule's glyph size. */
function PlanTreeGlyph({ size, className }: IconProps) {
  return <IconPlanOutline14 size={size} className={className} />
}

/**
 * The plan tree type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function planTreeDefinition(t: TranslateNS<'planTree'>): SidebarRightTabDefinition {
  return {
    id: PLAN_TREE_ID,
    kind: PLAN_TREE_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      id: 'plan-tree',
      order: 20,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: PlanTreeGlyph,
    }],
  }
}

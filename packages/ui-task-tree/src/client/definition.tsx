/**
 * 第一阶段注册：task-tree 这个标签页类型是什么。
 *
 * 它是个页，不是查看器：不认领地址。面板自己读 planTree 投影，
 * ui-sidebar-right 完全不知道本包存在。
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type {} from './locales.ts'
import { IconPlanOutline14, type IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** 本包拥有的标签页种类。 */
export const TASK_TREE_KIND = 'task-tree'

/** 本实现在该类型系统里的身份，也是正文席位的 key。 */
export const TASK_TREE_ID = '@t4r71/dsh-ui-task-tree'

/** 引导胶囊上的图形。 */
function TaskTreeGlyph({ size, className }: IconProps) {
  return <IconPlanOutline14 size={size} className={className} />
}

/**
 * 本类型的注册定义。
 * @param t - 命名空间绑定的翻译函数
 * @returns 待注册的定义
 */
export function taskTreeDefinition(t: TranslateNS<'taskTree'>): SidebarRightTabDefinition {
  return {
    id: TASK_TREE_ID,
    kind: TASK_TREE_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      id: TASK_TREE_KIND,
      order: 30,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: TaskTreeGlyph,
    }],
  }
}
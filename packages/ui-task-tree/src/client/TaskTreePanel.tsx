/**
 * 任务树面板：右侧边栏的一页，只有一种呈现 —— 层级大纲。
 *
 * 读数来自宿主的 planTree 投影（与已停用的 ui-plan-tree 同一份数据）。
 * 折叠状态在浏览器这一侧，不影响宿主：折叠只是「这一段先不画」。
 */
import { useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@t4r71/dsh-plan-tree/client'
import { defaultCollapsed } from './list.ts'
import { TaskListView } from './TaskListView.tsx'
import type { TreeNode } from './semantics.ts'
import css from './TaskTreePanel.module.css'

/** 面板的组合属性：会话标准套件 + 本包文案席位。 */
export type TaskTreePanelProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'taskTree'>

/**
 * 右侧边栏的「任务树」页。
 * @param props - 会话标准套件 + 本包文案席位
 * @returns 面板；没有投影时什么都不画
 */
export function TaskTreePanel({ useProjection, t }: TaskTreePanelProps): ReactNode {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string> | null>(null)
  const raw = useProjection('planTree')
  if (raw === undefined) return null
  const roots = (raw ?? []) as unknown as TreeNode[]
  // 默认把走不通的分支和代理内部阶段收起来，需要时再点开。
  const effective = collapsed ?? defaultCollapsed(roots)
  const toggle = (id: string): void => {
    setCollapsed((cur) => {
      const next = new Set(cur ?? defaultCollapsed(roots))
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  return (
    <div className={css.root} data-task-tree='outline'>
      <div className={css.summary}>
        <span className={css.summaryTitle}>{t('type.label')}</span>
      </div>
      <div className={css.scroll}>
        <TaskListView roots={roots} collapsed={effective} onToggle={toggle} t={t} />
      </div>
    </div>
  )
}

/** 标签页胶囊上的标题。 */
export function TaskTreeTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return <span className={css.tabTitle}>{tab.title}</span>
}

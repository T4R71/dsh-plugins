/**
 * 任务树面板：右侧边栏的一页，只有一种呈现 —— 层级大纲。
 *
 * 读数来自宿主那条只读 HTTP 路由（\`GET /t4/plan-tree\`）：目录实例在 \`index.ts\` 里
 * 建成，经席位注入到这里（见 \`./plan-tree.ts\`）。这棵树既不在会话日志里（宿主曾用两个
 * 不在 0.1.7 白名单里的事件类型承载它，持久化读路径会因此拒绝解释整个 log），也不在
 * 设置文档里了（那份镜像会把整棵树复制进 profile，文档随会话一路长）。
 *
 * 折叠状态在浏览器这一侧，不影响宿主：折叠只是「这一段先不画」。
 *
 * 树本身是**合并后**的：被派发的子会话自己写的那棵树，按 `assignedTo` 拼在对应节点下
 * （`directory.mergedTreeOf`，语义照抄宿主 `readMerged`）。合并只发生在读取侧，
 * 一个字节都不写回 —— 子代理对自己被拼进父树这件事一无所知。
 *
 * 行尾还会带一个队友标记 `(名字 · 状态)`：roster 投影认得出来的行，名字取自投影；
 * 投影在、但查不到这一行的（直连子代理不写名册）改用**节点 id** 当名字，状态仍取会话状态表
 * （同一条公式，见 `teammate-status.ts`）。投影**整个缺席**时才退回 `@childId`。
 */
import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { defaultCollapsed, type OwnerIndex } from './list.ts'
import type { PlanTreeDirectory } from './plan-tree.ts'
import { TaskListView } from './TaskListView.tsx'
import type { TreeNode } from './semantics.ts'
import {
  ownerBadgesWithFallback,
  type TeamProjectionLike,
} from './teammate-status.ts'
import css from './TaskTreePanel.module.css'

/**
 * 注入面：本包在 \`index.ts\` 里按席位 inject 下发的目录实例。
 *
 * 目录**不在组件里**建：它轮询宿主那条路由并做本地去重，生命周期属于插件而不是某一次
 * 渲染，建在组件里会在每次重挂载时多起一个定时器（而且 \`ctx\` 不是席位属性）。
 */
/**
 * 读取侧合并还要往下拼几层。
 *
 * 2 = 主代理 → 子代理 → 孙代理：一层给「主代理派给子代理」，一层给「子代理再派给孙代理」。
 * 宿主那侧 `readMerged` 的默认值是 1（只拼一层）。
 */
const MERGE_DEPTH = 2

export interface TaskTreePanelInjected {
  /** 任务树目录：稳定快照 + 按会话取数的三态读取。 */
  directory: PlanTreeDirectory
}

/** 面板的组合属性：会话标准套件 + 注入面 + 本包文案席位。 */
export type TaskTreePanelProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & TaskTreePanelInjected
  & PropsLocale<'taskTree'>

/**
 * 右侧边栏的「任务树」页。
 *
 * 取数失败不再静默：\`mergedTreeOf\` 给三态（有记录 / 没有记录 / 取不到），后两者画出
 * 不同的空态文案。旧的「取不到投影就 return null」分支把「读不到宿主的计划存储」与
 * 「这条会话还没有计划」显示成同一个空白 —— 前者是「不知道」，后者是「确实没有」，
 * 把前者画成后者就是拿不知道冒充事实。
 *
 * @param props - 会话标准套件 + 注入目录 + 本包文案席位
 * @returns 面板
 */
export function TaskTreePanel({ directory, sessionId, useSession, useSessions, useSessionStatus, t }: TaskTreePanelProps): ReactNode {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string> | null>(null)
  // 订阅本地快照的替换：这一行是重渲染的唯一来源，读数本身始终是同步纯读取，
  // 所以「哪一次发布要重画」与「这一刻读到什么」不会出现两个答案。
  useSyncExternalStore(directory.subscribe, directory.getSnapshot)
  // 主代理会话 —— 取法与宿主那行一字不差：子代理页里显示的是**主代理那个团队**。
  const leadSessionId = useSession(snapshot => snapshot.subagent?.address.parentSessionId) ?? sessionId
  // `agentTeam` 是宿主 `@deepseek-ai/dsh-experimental-agent-team` 声明的投影键（`stateVersion: 4`）。
  // 本包不依赖那个包（依赖方向会反过来），所以只取它的**形状**：投影值本来就是 wire JSON，
  // `teammate-status.ts` 会逐字段校验，编不出一个不存在的团队成员。
  const team = useSessions(
    state => (state.projectionsBySession[leadSessionId]?.values as Record<string, unknown> | undefined)?.['agentTeam'],
  ) as TeamProjectionLike | undefined
  // 一次性取整张表，再折成纯字典；**不**按行调 hook（每行一个订阅会随树的大小线性增长）。
  const statuses = useSessionStatus(state => state)
  const summaryRunning = useSessions(state => state.byId)
  // 合并后的树；深度 2 = 主代理 → 子代理 → 孙代理三层。先取树，行尾标记要按树上的节点
  // 补兜底（直连子代理不写名册，roster 里查不到它那一行）。
  const view = directory.mergedTreeOf(sessionId, MERGE_DEPTH)
  const roots = ((view.state === 'record' ? view.roots : []) as unknown as TreeNode[])
  const owners: OwnerIndex = useMemo(() => {
    const runningById: Record<string, boolean | undefined> = {}
    for (const [id, status] of statuses) runningById[id] = status.running
    const summaryRunningById: Record<string, boolean | undefined> = {}
    for (const [id, summary] of Object.entries(summaryRunning)) summaryRunningById[id] = summary.running
    return ownerBadgesWithFallback(team, roots, runningById, summaryRunningById)
  }, [team, statuses, summaryRunning, roots])
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
        {view.state === 'unreadable'
          ? <p className={css.message} data-task-tree-state='unreadable'>{t('view.unreadable')}</p>
          : <TaskListView roots={roots} collapsed={effective} onToggle={toggle} t={t} owners={owners} />}
      </div>
    </div>
  )
}

/** 标签页胶囊上的标题。 */
export function TaskTreeTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return <span className={css.tabTitle}>{tab.title}</span>
}

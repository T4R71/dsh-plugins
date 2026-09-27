/**
 * `planTree` namespace dictionaries, and the namespace's declaration.
 *
 * The copy is a summary line and a handful of row words: the panel shows a
 * plan the host already folded, so every string here is a label rather than a
 * state the browser owns.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'planTree'>` or `PropsLocale<'planTree'>` needs only this file,
 * whichever entry a program loads first.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plan-tree type name, guide entry, summary line, and row states. */
    planTree: PlanTreeKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'type.label': '计划树',
  'guide.title': '计划树',
  'guide.description': '查看本会话声明的计划与每一步的状态',
  'summary.done': '{done}/{total} 已完成',
  'summary.active': '{active} 进行中',
  'summary.blocked': '{blocked} 受阻',
  'summary.pending': '{pending} 待处理',
  'summary.empty': '尚无任务',
  'summary.both': '计划 {plan} 步 · 任务 {board} 条',
  'section.plan': '声明的计划',
  'empty.title': '还没有任务',
  'empty.hint': '主代理声明计划后，步骤会出现在这里。',
  'status.pending': '待处理',
  'status.in_progress': '进行中',
  'status.completed': '已完成',
  'status.blocked': '受阻',
  'expand': '展开子步骤',
  'collapse': '收起子步骤',
  'row.assignee': '执行者：{name}',
  'row.waitingOn': '等待：',
  'row.writeScopes': '改动范围：',
} satisfies Record<string, string>

/** Plan-tree dictionary key union. */
export type PlanTreeKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'type.label': 'Plan tree',
  'guide.title': 'Plan tree',
  'guide.description': 'View this session\'s declared plan and each step\'s status',
  'summary.done': '{done}/{total} completed',
  'summary.active': '{active} in progress',
  'summary.blocked': '{blocked} blocked',
  'summary.pending': '{pending} pending',
  'summary.empty': 'No tasks yet',
  'summary.both': '{plan} steps · {board} tasks',
  'section.plan': 'Declared plan',
  'empty.title': 'No tasks yet',
  'empty.hint': 'Steps appear here once the lead declares a plan.',
  'status.pending': 'Pending',
  'status.in_progress': 'In progress',
  'status.completed': 'Completed',
  'status.blocked': 'Blocked',
  'expand': 'Expand sub-steps',
  'collapse': 'Collapse sub-steps',
  'row.assignee': 'Assignee: {name}',
  'row.waitingOn': 'Waiting on: ',
  'row.writeScopes': 'Write scopes: ',
} satisfies Record<PlanTreeKey, string>

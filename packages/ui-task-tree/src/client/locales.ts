/**
 * taskTree 命名空间的中英文字典。
 *
 * 文案只有类型名、行内前缀和两种空态 —— 树的内容全部来自宿主写下的那份设置文档
 * （镜像经 `ctx.configForms.describe()` 到达本包），浏览器不拥有树的任何状态。
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 任务树：类型名、行内前缀与空状态。 */
    taskTree: TaskTreeKey
  }
}

/** 简体中文字典与键集事实源。 */
export const zh = {
  'type.label': '任务树',
  'guide.title': '任务树',
  'guide.description': '看任务怎么推进：谁在做、谁卡住了、走不通的为什么走不通',

  'view.totals': '总计',

  'row.answer': '答：',
  'row.because': '因为：',
  'row.expand': '展开这一支',
  'row.collapse': '收起这一支',
  'row.question': '需要用户补充信息',

  'empty.title': '还没有任务树',
  'empty.hint': '主代理声明计划后，这里会长出树',
  // 与上面那条是两件事：那不是「还没有计划」，是本进程读不到承载计划的那份文档。
  // 旧实现在这种情况下直接 return null，谁也不知道空白是哪一种。
  'view.unreadable': '读不到计划存储：这份 profile 里没有装宿主的计划行。',
} satisfies Record<string, string>

/** 键集联合类型。 */
export type TaskTreeKey = keyof typeof zh

/** 英文字典，键集受中文约束。 */
export const en = {
  'type.label': 'Task tree',
  'guide.title': 'Task tree',
  'guide.description': 'Watch a task advance: who is working, who is stuck, and why a route failed',

  'view.totals': 'Total',

  'row.answer': 'A: ',
  'row.because': 'why: ',
  'row.expand': 'Expand this branch',
  'row.collapse': 'Collapse this branch',
  'row.question': 'Needs user input',

  'empty.title': 'No task tree yet',
  'empty.hint': 'The tree appears once the lead declares a plan',
  'view.unreadable': 'The plan store is unreadable: this profile does not mount the host plan row.',
} satisfies Record<TaskTreeKey, string>
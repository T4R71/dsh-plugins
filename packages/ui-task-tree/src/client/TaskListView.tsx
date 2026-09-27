/**
 * 大纲视图：一行一个节点，层级由缩进表达。
 *
 * 为什么只有一种呈现：按状态/执行者/层级重排会把同一个父节点的孩子拆散，
 * 读者得先在脑子里重建父子关系才看得懂 —— 那份分类没增加信息，只增加了噪音。
 * 所以固定为深度优先、保序、缩进，配合圆形状态符号。
 *
 * 视觉规则：
 *   圆形符号    四态 + 问号，见 StatusGlyph（与 todo list 同一套图元）
 *   缩进        第几层缩几格，父子关系只由缩进表达，不画拄角
 *   同层虚线    同级兄弟之间一根淡淡的竖向虚线，提示这几行是一批
 *   没有树干    不做竖线贯穿、不做直角拐角
 */
import type { ReactNode } from 'react'
import type { TreeNode } from './semantics.ts'
import { buildOutline, countsLabel, tallyTree, type OutlineRow } from './list.ts'
import { EntryGlyph } from './StatusGlyph.tsx'
import type { TaskTreeKey } from './locales.ts'
import css from './TaskListView.module.css'

/** 翻译函数（键集受本包命名空间约束）。 */
type Translate = (key: TaskTreeKey, params?: Record<string, string | number>) => string

/** 每层缩进的像素数。 */
const INDENT = 14

/** 视图需要的东西。 */
export interface TaskListViewProps {
  roots: readonly TreeNode[]
  collapsed: ReadonlySet<string>
  onToggle: (id: string) => void
  t: Translate
}

/** 取样式表里的类名，取不到就空串。 */
function cls(name: string): string {
  return (css as unknown as Record<string, string>)[name] ?? ''
}

/**
 * 展开/折叠按钮。没有子节点时占一个等宽空位，左边才对得齐。
 * @param props.row - 这一行
 * @param props.onToggle - 点一下切折叠
 * @param props.t - 翻译函数
 */
function Disclosure({ row, onToggle, t }: { row: OutlineRow; onToggle: (id: string) => void; t: Translate }): ReactNode {
  if (!row.hasChildren) return <span className={css.caretSpace} />
  return (
    <button
      type='button'
      className={css.caret}
      aria-expanded={!row.collapsed}
      title={row.collapsed ? t('row.expand') : t('row.collapse')}
      onClick={() => { onToggle(row.id) }}
    >
      <svg
        width={9} height={9} viewBox='0 0 9 9' fill='none' aria-hidden='true'
        className={row.collapsed ? css.caretIcon : css.caretIconOpen}
      >
        <path d='M3 1.2L6.3 4.5L3 7.8' stroke='currentColor' strokeWidth='1.4' strokeLinecap='round' strokeLinejoin='round' />
      </svg>
    </button>
  )
}

/**
 * 行正文：标题 + 执行者，下面按需挂原因/回答/补充。
 * @param props.row - 这一行
 * @param props.t - 翻译函数
 */
function Body({ row, t }: { row: OutlineRow; t: Translate }): ReactNode {
  return (
    <span className={css.body}>
      <span className={css.line}>
        <span className={css.title}>{row.title}</span>
        {row.assignedTo !== undefined ? <span className={css.owner}>{'@' + row.assignedTo}</span> : null}
      </span>
      {row.reason !== undefined
        ? <span className={css.sub}><span className={css.subKey}>{t('row.because')}</span>{row.reason}</span>
        : null}
      {row.answer !== undefined
        ? <span className={css.sub}><span className={css.subKey}>{t('row.answer')}</span>{row.answer}</span>
        : null}
      {row.detail !== undefined ? <span className={css.sub}>{row.detail}</span> : null}
    </span>
  )
}

/**
 * 一行。
 * @param props.row - 这一行
 * @param props.onToggle - 点一下切折叠
 * @param props.t - 翻译函数
 */
function Row({ row, onToggle, t }: { row: OutlineRow; onToggle: (id: string) => void; t: Translate }): ReactNode {
  const classes = [css.row, cls('life_' + row.life), cls('kind_' + row.kind)].join(' ')
  return (
    <div
      className={classes}
      style={{ paddingLeft: 4 + row.depth * INDENT }}
      data-task-tree-node={row.id}
      data-task-tree-life={row.life}
      data-task-tree-depth={row.depth}
    >
      <span className={row.link ? css.linkCell + ' ' + css.linkOn : css.linkCell} aria-hidden='true' />
      <Disclosure row={row} onToggle={onToggle} t={t} />
      <span className={css.glyphCell} title={row.kind === 'note' ? t('row.question') : undefined}>
        <EntryGlyph kind={row.kind} status={row.status} />
      </span>
      <Body row={row} t={t} />
    </div>
  )
}

/**
 * 大纲视图。
 * @param props - 根节点、折叠集合、切换回调与翻译函数
 * @returns 顶部总览 + 一路缩进下去的行
 */
export function TaskListView({ roots, collapsed, onToggle, t }: TaskListViewProps): ReactNode {
  const rows = buildOutline(roots, collapsed)
  if (rows.length === 0) {
    return (
      <div className={css.empty}>
        <p className={css.emptyTitle}>{t('empty.title')}</p>
        <p className={css.emptyHint}>{t('empty.hint')}</p>
      </div>
    )
  }
  return (
    <div className={css.outline} data-task-tree-outline>
      <div className={css.totals} data-task-tree-totals>
        <span className={css.totalsLabel}>{t('view.totals')}</span>
        <span className={css.totalsValue}>{countsLabel(tallyTree(roots))}</span>
      </div>
      {rows.map((row) => <Row key={row.id} row={row} onToggle={onToggle} t={t} />)}
    </div>
  )
}

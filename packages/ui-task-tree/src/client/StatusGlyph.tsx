/**
 * 状态符号：照搬 todo list 那一套 14×14 圆形图元。
 *
 * 五个符号共用同一个画板（14×14，r=6.4，线宽 1.2），所以行高一致、视觉成组：
 *   待办     虚线空心圆（figma dash 2.4 2.4）
 *   进行中   渐变圆环，CSS 让它转起来 —— 这就是「动态指示」
 *   完成     圆环 + 勾
 *   阻塞     圆环 + 叉（红）
 *   待补充   圆环 + 问号（琥珀）—— 表示这一步需要用户补信息
 *
 * 图元与配色照 todo 面板的做法（同一套 --dsw-alias-state-* 语义色），
 * 所以两个面板的状态语言是一致的。
 */
import { useId } from 'react'
import type { ReactNode } from 'react'
import css from './StatusGlyph.module.css'

/** 圆环的半径与线宽，四个符号共用。 */
const R = 6.4
const W = 1.2

/** 完成：圆环 + 对勾。 */
function CompletedGlyph(): ReactNode {
  return (
    <svg width={14} height={14} viewBox='0 0 14 14' fill='none' aria-hidden='true' className={cssOf('completed')}>
      <circle cx='7' cy='7' r={R} stroke='currentColor' strokeWidth={W} />
      <path d='M10.9631 5.71411L7.70154 8.97571C7.48011 9.19714 7.27736 9.40099 7.09229 9.54993C6.89742 9.70669 6.66314 9.85279 6.3634 9.90027C6.2049 9.92534 6.04339 9.92534 5.88489 9.90027C5.58515 9.85279 5.35087 9.70669 5.15601 9.54993C4.97093 9.40099 4.76818 9.19714 4.54675 8.97571L3.03516 7.46411L3.96313 6.53613L5.47473 8.04773C5.7169 8.28989 5.86196 8.43389 5.97888 8.52795C6.08597 8.61409 6.10875 8.60701 6.08997 8.604C6.11259 8.60758 6.13571 8.60758 6.15833 8.604C6.13954 8.60701 6.16232 8.61409 6.26941 8.52795C6.38633 8.43389 6.53139 8.28989 6.77356 8.04773L10.0352 4.78613L10.9631 5.71411Z' fill='currentColor' />
    </svg>
  )
}

/** 进行中：圆环用渐变描边（实 → 透明），CSS 让它旋转。 */
function ProgressGlyph(): ReactNode {
  const gradientId = useId()
  return (
    <svg width={14} height={14} viewBox='0 0 14 14' fill='none' aria-hidden='true' className={cssOf('progress')}>
      <defs>
        <linearGradient id={gradientId} x1='2.5' y1='12' x2='10.5' y2='3.5' gradientUnits='userSpaceOnUse'>
          <stop stopColor='currentColor' />
          <stop offset='1' stopColor='currentColor' stopOpacity='0' />
        </linearGradient>
      </defs>
      <circle cx='7' cy='7' r={R} stroke={'url(#' + gradientId + ')'} strokeWidth={W} />
    </svg>
  )
}

/** 待办：虚线空心圆。 */
function PendingGlyph(): ReactNode {
  return (
    <svg width={14} height={14} viewBox='0 0 14 14' fill='none' aria-hidden='true' className={cssOf('pending')}>
      <circle cx='7' cy='7' r={R} stroke='currentColor' strokeWidth={W} strokeDasharray='2.4 2.4' />
    </svg>
  )
}

/** 走不通：圆环 + 叉。todo 没有这一态，按同一套画板补一个。 */
function BlockedGlyph(): ReactNode {
  return (
    <svg width={14} height={14} viewBox='0 0 14 14' fill='none' aria-hidden='true' className={cssOf('blocked')}>
      <circle cx='7' cy='7' r={R} stroke='currentColor' strokeWidth={W} />
      <path d='M5.1 5.1L8.9 8.9M8.9 5.1L5.1 8.9' stroke='currentColor' strokeWidth={W} strokeLinecap='round' />
    </svg>
  )
}

/**
 * 需要用户补充信息：圆环 + 问号。同一套画板，所以和另外四个是一家人。
 * 问号用文字排出来（path 画字太脆），但要压进圆环里，所以调小字号、居中。
 */
function QuestionGlyph(): ReactNode {
  return (
    <svg width={14} height={14} viewBox='0 0 14 14' fill='none' aria-hidden='true' className={cssOf('question')}>
      <circle cx='7' cy='7' r={R} stroke='currentColor' strokeWidth={W} />
      <text
        x='7' y='7'
        textAnchor='middle' dominantBaseline='central'
        fontSize='7.5' fontWeight='700' fill='currentColor'
      >?</text>
    </svg>
  )
}

/** 类名取自样式表，键名与状态同名。 */
function cssOf(status: string): string {
  return ((css as unknown as Record<string, string>)['glyph_' + status]) ?? ''
}
/**
 * 按状态给出圆形符号。
 * @param props.status - 宿主的四种状态之一
 * @returns 14×14 的 SVG
 */
export function StatusGlyph({ status }: { status: string }): ReactNode {
  if (status === 'completed') return <CompletedGlyph />
  if (status === 'in_progress') return <ProgressGlyph />
  if (status === 'blocked') return <BlockedGlyph />
  return <PendingGlyph />
}

/**
 * 一行该画哪个符号：用户问答用问号圆环，其余按状态。
 * 问号是第五个符号，不是额外挂件 —— 它和另外四个同族同尺寸。
 * @param props.props - 行的种类与状态
 * @returns 14×14 的 SVG
 */
export function EntryGlyph({ kind, status }: { kind: string; status: string }): ReactNode {
  return kind === 'note' ? <QuestionGlyph /> : <StatusGlyph status={status} />
}

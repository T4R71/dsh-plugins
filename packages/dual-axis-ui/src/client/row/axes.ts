/**
 * 双轴配置页的纯函数层：把设置节里的一条轴收成可编辑的草稿、把草稿收成一条
 * 轴值、把一条轴渲染成一句话。这里不碰 React、不碰 DOM，也不碰宿主 —— 界面
 * 半边每次挂载与每次保存都走这几个函数，因此"页面上能改的形状"与"宿主接受
 * 的形状"只有这一份定义。
 *
 * @module @t4r71/dsh-dual-axis-ui/client/axes
 */

/** 四种轴取值，与宿主 `dsh-sandbox` 的 `AxisScopeKind` 同一套字面量。 */
export type AxisKind = 'deny' | 'workspace' | 'all' | 'custom'

/** `custom` 可叠加的三个底座。 */
export type AxisBase = 'deny' | 'workspace' | 'all'

/** 一条轴值；`custom` 时带底座与两个路径列表。 */
export type AxisValue =
  | { kind: Exclude<AxisKind, 'custom'> }
  | { kind: 'custom'; base: AxisBase; allow: readonly string[]; deny: readonly string[] }

/** 界面上的四条轴取值，顺序即下拉顺序：从最窄到最宽，custom 排在最后。 */
export const AXIS_KINDS: readonly AxisKind[] = ['deny', 'workspace', 'all', 'custom']

/** 界面上的三个底座，顺序即下拉顺序。 */
export const AXIS_BASES: readonly AxisBase[] = ['deny', 'workspace', 'all']

/**
 * 一条轴在界面上的草稿：四条取值都收在同一种形状里，切到 custom 时已经打好的
 * 路径不会因为来回切换取值而丢失（切回非 custom 时它们只是不再参与保存）。
 */
export interface AxisDraft {
  /** 选中的轴取值。 */
  kind: AxisKind
  /** custom 的底座；非 custom 时保留上一次的选择。 */
  base: AxisBase
  /** 额外允许的绝对路径，每行一条。 */
  allow: string
  /** 排除的绝对路径，每行一条；与底座取并后再减去它们。 */
  deny: string
  /** 一个默认值或一份已保存的值读取失败时的说明；空串表示这份草稿可用。 */
  problem: string
}

/**
 * 一条绝对路径写法（POSIX 或 Windows）。与宿主半边的同名校验同一条规则：相对
 * 路径只能相对宿主进程的 cwd 解析，不可能是写配置的人想说的位置。
 * @param value - 待检查的路径写法。
 * @returns 该写法是否为绝对路径。
 */
export function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/**
 * 把一个未信任的值收成一条轴值。
 * @param value - 设置节里的取值，或 `undefined`。
 * @returns 一条轴值；形状不对时返回 undefined，由调用方决定用什么兜底。
 */
export function axisValueOf(value: unknown): AxisValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { kind?: unknown; base?: unknown; allow?: unknown; deny?: unknown }
  if (typeof candidate.kind !== 'string' || !AXIS_KINDS.includes(candidate.kind as AxisKind)) return undefined
  if (candidate.kind !== 'custom') return { kind: candidate.kind as Exclude<AxisKind, 'custom'> }
  if (typeof candidate.base !== 'string' || !AXIS_BASES.includes(candidate.base as AxisBase)) return undefined
  return {
    kind: 'custom',
    base: candidate.base as AxisBase,
    allow: stringList(candidate.allow),
    deny: stringList(candidate.deny),
  }
}

/**
 * 把一份字符串列表读出来；不是数组的取值读成空列表。
 * @param value - 待读取的值。
 * @returns 其中的字符串成员。
 */
function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * 把一条轴值收成界面草稿。
 * @param value - 设置节里的取值。
 * @param fallback - 取值缺失或读不懂时使用的兜底轴（组合层声明的默认值）。
 * @returns 一份可编辑的草稿。
 */
export function draftOf(value: unknown, fallback: AxisValue): AxisDraft {
  const axis = axisValueOf(value) ?? fallback
  return draftOfAxis(axis, axisValueOf(value) === undefined && value !== undefined
    ? '宿主给出的这条轴读不懂，已退回组合默认值'
    : '')
}

/**
 * 把一条已经收好的轴值转成草稿。
 * @param axis - 一条轴值。
 * @param problem - 直接带上的说明；不传即没有内容可说明。
 * @returns 一份可编辑的草稿。
 */
export function draftOfAxis(axis: AxisValue, problem = ''): AxisDraft {
  const kind = axis.kind
  return {
    kind,
    base: kind === 'custom' ? axis.base : 'workspace',
    allow: kind === 'custom' ? axis.allow.join('\n') : '',
    deny: kind === 'custom' ? axis.deny.join('\n') : '',
    problem,
  }
}

/**
 * 把草稿收成一条可以写回设置的轴值。非 custom 的草稿只带取值本身 —— 界面上
 * 留着的历史路径不会被写进另一条取值里，否则切一次取值就等于做了一次没人要求
 * 的授权。
 * @param draft - 界面上的草稿。
 * @returns 一条轴值，或一条说明这份草稿为什么还不能保存的话。
 */
export function scopeOf(draft: AxisDraft): { ok: true; value: AxisValue } | { ok: false; problem: string } {
  if (!AXIS_KINDS.includes(draft.kind)) return { ok: false, problem: `未知的取值 ${draft.kind}` }
  if (draft.kind !== 'custom') return { ok: true, value: { kind: draft.kind } }
  if (!AXIS_BASES.includes(draft.base)) return { ok: false, problem: `未知的底座 ${draft.base}` }
  const allow = pathLines(draft.allow)
  const deny = pathLines(draft.deny)
  for (const [entry, paths] of [['allow', allow], ['deny', deny]] as const) {
    const bad = paths.find(path => !isAbsolutePath(path))
    if (bad !== undefined) return { ok: false, problem: `${entry} 里的 ${JSON.stringify(bad)} 不是绝对路径` }
  }
  return { ok: true, value: { kind: 'custom', base: draft.base, allow, deny } }
}

/**
 * 把一个多行文本框读成路径列表：忽略空行与首尾空白。
 * @param text - 文本框里的原文。
 * @returns 其中每一行作为一条路径。
 */
export function pathLines(text: string): string[] {
  return text.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')
}

/**
 * 两条轴是否描述同一个边界。逐成员比较：custom 的两个路径列表连顺序都是它取值
 * 的一部分，而每次重解析都会新建轴对象。
 * @param left - 一条轴。
 * @param right - 另一条轴。
 * @returns 两者是否描述同一条轴。
 */
export function sameAxis(left: AxisValue, right: AxisValue): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind !== 'custom' || right.kind !== 'custom') return true
  const sameList = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index])
  return left.base === right.base && sameList(left.allow, right.allow) && sameList(left.deny, right.deny)
}

/** 一条轴的一句话说明所用的文案表：由调用方按当前语言传入。 */
export interface AxisText {
  /** 一条取值的中文/英文名字。 */
  kind: (kind: AxisKind) => string
  /** 底座的名字。 */
  base: (base: AxisBase) => string
  /** 模板：`{paths}` 会被替换成路径列表。 */
  custom: (base: string, paths: string) => string
}

/**
 * 把一条轴渲染成一句话，供配置页的摘要行与草稿预览使用。
 * @param axis - 一条轴值。
 * @param text - 当前语言的文案表。
 * @returns 一句话说明。
 */
export function describeAxis(axis: AxisValue, text: AxisText): string {
  if (axis.kind !== 'custom') return text.kind(axis.kind)
  const paths: string[] = []
  if (axis.allow.length > 0) paths.push(`+${axis.allow.join(', ')}`)
  if (axis.deny.length > 0) paths.push(`-${axis.deny.join(', ')}`)
  return text.custom(text.base(axis.base), paths.length === 0 ? '—' : paths.join(' '))
}

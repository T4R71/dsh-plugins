/**
 * 输入框上方两个访问轴下拉的 `custom` 路径编辑器：把一条轴收成可编辑的草稿、
 * 把草稿收成宿主 `/permission` 命令接受的参数串，并给出全局初值与兜底默认值。
 *
 * 这里不碰 React、不碰 DOM、也不碰宿主 —— 界面半边每次展开编辑器与每次提交都走
 * 这几个函数，因此"界面上能编的形状"与"宿主解析器接受的形状"只有这一份定义。
 * 宿主的语法在 `dsh-dual-axis` 的 `parseAxisEntry` / `parseCustomFragment`：
 * `<axis>:<kind>[:base=<deny|workspace|all>,groups=<id>|<id>,allow=<绝对路径>,deny=<绝对路径>]`，
 * `allow` / `deny` 重复 key 表示多条、逗号分隔，路径必须是绝对路径；`groups` 只写
 * **组 id**，组体由宿主在判定时按 id 现取。
 *
 * @module @deepseek-ai/dsh-client-ui-permission-presets/client/axis-editor
 */

import type { PermissionAxis, PermissionAxisValue } from './presentation.ts'

/** `custom` 可叠加的三个底座，与宿主 `AxisBase` 同一套字面量。 */
export const AXIS_BASES = ['deny', 'workspace', 'all'] as const

/** 一个底座取值。 */
export type AxisBase = typeof AXIS_BASES[number]

/** 两个下拉里那个「整台主机」的取值；它就是要过二次确认闸的那一个。 */
const ALL_AXIS = 'all'

/**
 * 一条轴在编辑器里的草稿。四个取值共用同一种形状：切到 `custom` 再切回来时，
 * 已经打好的路径不会丢，只是不再参与提交。
 */
export interface AxisDraft {
  /** 当前选中的轴取值。 */
  kind: PermissionAxisValue
  /** `custom` 的底座；非 `custom` 时保留上一次的选择。 */
  base: AxisBase
  /**
   * 这条对话预设里引用的规则组 id。
   *
   * 存的是 **id 而不是组体**：组的内容永远只有设置页那一份，判定时按 id 现取
   * （规格 §「为什么对话里绝不能存组体」）。顺序即提交顺序。
   */
  groups: readonly string[]
  /** 额外放行的绝对路径，每行一条。 */
  allow: string
  /** 额外禁止的绝对路径，每行一条；与底座取并后再减去它们，禁止优先。 */
  deny: string
}

/**
 * 设置页定义的一个规则组，编辑器多选用的那一份。
 *
 * `read` / `write` 是这个组覆盖了哪几根轴：写侧组出现在读轴的选择器里不会报错，
 * 但它对这条读轴什么也不做，所以界面要如实标出来。
 */
export interface RuleGroupOption {
  /** 会话引用的稳定标识。 */
  readonly id: string
  /** 人读的名字；设置页留空时宿主用 id 顶上。 */
  readonly name: string
  /** 这个组是否带读侧规则。 */
  readonly read: boolean
  /** 这个组是否带写侧规则。 */
  readonly write: boolean
}

/** 多选列表里的一行：设置页定义的组，或一个已经引用不到定义的 id。 */
export interface GroupChoice {
  /** 组 id。 */
  readonly id: string
  /** 显示名；引用不到的 id 用 id 本身。 */
  readonly name: string
  /** 这个组覆盖哪些轴；引用不到的 id 是 `none`。 */
  readonly coverage: 'both' | 'read' | 'write' | 'none'
  /** 设置页当前是否定义了这个 id。 */
  readonly missing: boolean
  /** 这一行是否被勾选。 */
  readonly checked: boolean
}

/**
 * 把设置节的 `groups` 读成多选用的组清单。
 *
 * 读取是宽容的：读不懂的成员跳过，不抛 —— 这个清单只是给人选的东西，坏取值由宿主
 * 的 `parseLibrary` 在判定时响亮失败，界面不该因为一个坏成员就整块打不开。
 * @param value - 设置节里的 `groups`，未信任。
 * @returns 每个可用的组一项，顺序与文档一致，id 去重。
 */
export function groupOptionsOf(value: unknown): readonly RuleGroupOption[] {
  if (!Array.isArray(value)) return []
  const options: RuleGroupOption[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const candidate = entry as { id?: unknown; name?: unknown; read?: unknown; write?: unknown }
    if (typeof candidate.id !== 'string' || candidate.id === '' || seen.has(candidate.id)) continue
    seen.add(candidate.id)
    options.push({
      id: candidate.id,
      name: typeof candidate.name === 'string' && candidate.name !== '' ? candidate.name : candidate.id,
      read: candidate.read !== undefined && candidate.read !== null,
      write: candidate.write !== undefined && candidate.write !== null,
    })
  }
  return options
}

/**
 * 多选列表的完整内容：设置页定义的组，加上这条对话已经引用、但设置页不再定义的 id。
 *
 * 后一类必须留在列表里并保持勾选：它们缺席就等于「打开编辑器再应用」会**静默**把
 * 引用删掉，而宿主正是靠这些引用响亮失败的（规格 §「引用不到的组 id → 响亮失败」）。
 * 取消勾选仍然允许 —— 移除一个引用属于收窄，永远允许。
 * @param library - 设置页当前定义的组。
 * @param selected - 这条对话预设里引用的 id。
 * @returns 列表的每一行。
 */
export function groupChoicesOf(
  library: readonly RuleGroupOption[],
  selected: readonly string[],
): readonly GroupChoice[] {
  const choices: GroupChoice[] = library.map(option => ({
    id: option.id,
    name: option.name,
    coverage: option.read && option.write ? 'both' : option.read ? 'read' : option.write ? 'write' : 'none',
    missing: false,
    checked: selected.includes(option.id),
  }))
  for (const id of selected) {
    if (library.some(option => option.id === id)) continue
    choices.push({ id, name: id, coverage: 'none', missing: true, checked: true })
  }
  return choices
}

/**
 * 编辑器里一条轴的起始取值：会话当前值，或部署设置值。
 *
 * 两条都是**未信任输入**：会话那条来自宿主投影，部署那条来自设置文档。读不懂的
 * 成员由 {@link initialDraft} 逐项兜底，界面不会因为一个坏取值打不开。
 */
export interface AxisEditorValue {
  /** 轴取值。 */
  kind: string
  /** `custom` 时的底座。 */
  base?: string
  /** `custom` 时这条预设引用的规则组 id。 */
  groups?: readonly string[]
  /** `custom` 时额外放行的绝对路径。 */
  allow?: readonly string[]
  /** `custom` 时额外禁止的绝对路径。 */
  deny?: readonly string[]
}

/**
 * 某一轴拿不到任何配置时使用的兜底轴：读轴 `all`、写轴 `workspace`，
 * 即 `dsh-sandbox` 的 `DEFAULT_READ_SCOPE` / `DEFAULT_WRITE_SCOPE`。
 *
 * 这两条是**部署默认值**，不是"兜底给全盘权限"：读轴 `all`、写轴 `workspace`
 * 正是 `dsh-sandbox` 里那两条默认轴，所以拿不到全局配置时也不会把写权限放大。
 * @param axis - 轴名。
 * @returns 该轴的兜底取值。
 */
export function fallbackAxis(axis: PermissionAxis): Exclude<PermissionAxisValue, 'custom'> {
  return axis === 'read' ? 'all' : 'workspace'
}

/**
 * 一条空白草稿：以给定取值起步，并以该取值本身为底座。
 *
 * 底座取"这条轴当前的取值"而不是写死的 `workspace`：拿不到任何全局配置时，读轴的
 * 兜底是 `all`，于是编辑器的底座也必须是 `all` —— 若写死 `workspace`，兜底打开的
 * 编辑器会静默把读轴收窄成会话工作区，与那条兜底值本身矛盾。
 * @param kind - 起步取值，同时用作底座。
 * @returns 一份可编辑的草稿。
 */
export function emptyDraft(kind: PermissionAxisValue): AxisDraft {
  const base = (AXIS_BASES as readonly string[]).includes(kind) ? kind as AxisBase : 'workspace'
  return { kind, base, groups: [], allow: '', deny: '' }
}

/** 一条 `groups` 项里分隔组 id 的字符；与宿主 `GROUP_ID_SEPARATOR` 同一个字符。 */
export const GROUP_ID_SEPARATOR = '|'

/**
 * 一条轴的起始草稿：**这条会话自己的轴**优先，它缺席时才退到部署设置值，再没有
 * 才用该轴的部署默认值。它永远不会空着打开，也永远不抛 —— 兜底就是这个函数的
 * 全部意义。
 *
 * 「会话优先」不是顺序偏好而是这个界面的定义：编辑器表达的就是这条会话，打开时
 * 显示别的值会与它旁边那个下拉自相矛盾。会话读轴是 `deny` 时初值必须是 `deny`，
 * 不是部署默认的 `all`。
 * @param axis - 正在编辑的轴。
 * @param current - 这条会话在该轴上的取值，宿主投影还没有这条轴时为 undefined。
 * @param global - 部署设置在该轴上的取值，只在会话没有取值时兜底。
 * @returns 一份不用重打任何东西就能提交的草稿。
 */
export function initialDraft(
  axis: PermissionAxis,
  current: AxisEditorValue | undefined,
  global: AxisEditorValue | undefined,
): AxisDraft {
  const source = current ?? global
  // 会话与部署设置都没有这条轴：退回该轴的部署默认值（读 all、写 workspace），并以
  // 同一个取值作底座，这样"兜底打开再直接应用"落地的正是那条默认值本身。
  if (source === undefined) return emptyDraft(fallbackAxis(axis))
  if (source.kind !== 'custom') {
    // 一条非 custom 的轴已经声明了"往什么之上加"：`deny` 加在空集上、
    // `workspace` 加在会话工作区上、`all` 加在整台主机上。以它为底座打开，
    // 编辑器的第一次提交就与这条会话当前的轴表达同一件事。
    const base = (AXIS_BASES as readonly string[]).includes(source.kind) ? source.kind as AxisBase : 'workspace'
    return { kind: 'custom', base, groups: [], allow: '', deny: '' }
  }
  const base = (AXIS_BASES as readonly string[]).includes(source.base ?? '')
    ? source.base as AxisBase
    : 'workspace'
  return {
    kind: 'custom',
    base,
    // 组 id 原样带进来：这条会话引用了哪些组是它自己预设的一部分，打开编辑器不该
    // 把它们丢掉（那是静默改预设），也不该替它补上任何一条。
    groups: [...(source.groups ?? [])],
    allow: (source.allow ?? []).join('\n'),
    deny: (source.deny ?? []).join('\n'),
  }
}

/** 一条绝对路径写法（POSIX 或 Windows）。与宿主的 `isAbsoluteSpelling` 同一条规则。 */
const POSIX_ABSOLUTE = /^\//u
/** Windows 盘符或 UNC 写法。 */
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/u

/**
 * 一个写法是否为绝对路径。相对路径只能相对宿主进程的 cwd 解析，永远不是写这份配置
 * 的人想说的位置，所以与宿主一样在这里就拒绝，而不是留给宿主报一句难读的错。
 * @param value - 待检查的路径写法。
 * @returns 该写法是否为绝对路径。
 */
export function isAbsolutePath(value: string): boolean {
  return POSIX_ABSOLUTE.test(value) || WINDOWS_ABSOLUTE.test(value)
}

/**
 * 把一个多行文本框读成路径列表：去掉空行与首尾空白。
 * @param text - 文本框里的原文。
 * @returns 其中每一行作为一条路径。
 */
export function pathLines(text: string): string[] {
  return text.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')
}

/** 一份草稿收成参数串的结果：成功给出片段，失败给出一句可读的说明。 */
export type DraftParse =
  | { ok: true; fragment: string }
  | { ok: false; problem: string }

/**
 * 把一份 `custom` 草稿收成宿主解析器接受的参数片段
 * （`base=<…>,groups=<id>|<id>,allow=<…>,deny=<…>`，`allow` / `deny` 每条重复一次 key）。
 *
 * 路径里的逗号、以及组 id 里的三类分隔符都会被宿主的解析器当成别的东西，因此它们
 * 在这里就拒绝，而不是拼出一条宿主读成另一个意思的命令行。
 * @param draft - 编辑器里的草稿。
 * @param problemOf - 生成本地化说明的回调。
 * @returns 参数片段，或一句说明这份草稿为什么还不能提交的话。
 */
export function customFragment(
  draft: AxisDraft,
  problemOf: (key: 'baseUnknown' | 'notAbsolute' | 'commaUnsupported' | 'groupUnsupported') => string,
): DraftParse {
  if (!(AXIS_BASES as readonly string[]).includes(draft.base)) {
    return { ok: false, problem: problemOf('baseUnknown') }
  }
  // 组 id 由设置页定义，宿主只校验它非空。含分隔符的 id 会让一条 groups 项被拆成别的
  // 东西（竖线拆 id、逗号拆 key、等号拆 key 与 value），所以在这里就拒绝。
  for (const id of draft.groups) {
    if (id === '' || id.includes(GROUP_ID_SEPARATOR) || id.includes(',') || id.includes('=')) {
      return { ok: false, problem: problemOf('groupUnsupported') }
    }
  }
  const entries: string[] = []
  // `base=` 必须排在最前（宿主 parseCustomFragment 的第一项就是它）；组写在两个路径
  // 列表之前，于是同一次提交的命令行读起来是「底座 + 组 + 这条对话自己追加的路径」。
  if (draft.groups.length > 0) entries.push('groups=' + draft.groups.join(GROUP_ID_SEPARATOR))
  const lists: ReadonlyArray<readonly [string, string]> = [['allow', draft.allow], ['deny', draft.deny]]
  for (const [key, text] of lists) {
    for (const path of pathLines(text)) {
      if (!isAbsolutePath(path)) return { ok: false, problem: problemOf('notAbsolute') }
      if (path.includes(',')) return { ok: false, problem: problemOf('commaUnsupported') }
      entries.push(`${key}=${path}`)
    }
  }
  return { ok: true, fragment: ['base=' + draft.base, ...entries].join(',') }
}

/**
 * 一份 `custom` 草稿提交出去之后，宿主文档里应当出现的那条轴值。
 *
 * 与 {@link customFragment} 同一份草稿、同一套取值：片段是发给宿主的那句话，这里是
 * 那句话落成记录之后的形状。两者一起用才有意义 —— 宿主对自己没写的改动同样会回一句
 * 「命令执行了」（`Session.command` 的 `matched` 只说明命令被解析到，见
 * `packages/api/session-controller/src/client/sessions/session.ts:387-391`），所以界面
 * 只能拿写入之后的记录来核对这次提交到底有没有生效。
 *
 * 组 id 去重，因为宿主 `normalizeScope` 的 `groupIds` 也去重；路径列表保持顺序，
 * 因为宿主的 `pathList` 保序。
 * @param draft - 编辑器里的草稿。
 * @returns 宿主文档里那条轴的形状。
 */
export function draftScope(draft: AxisDraft): AxisEditorScope {
  return {
    kind: 'custom',
    base: draft.base,
    groups: [...new Set(draft.groups)],
    allow: pathLines(draft.allow),
    deny: pathLines(draft.deny),
  }
}

/**
 * 宿主文档里一条轴值的形状（`dual-axis-sessions` 的记录成员）。
 *
 * 只有这里真的会读的成员：`groups` 是这条轴引用的组 id，`allow` / `deny` 是它自己
 * 追加与排除的绝对路径。
 */
export interface AxisEditorScope {
  /** 轴取值。 */
  readonly kind: string
  /** `custom` 的底座。 */
  readonly base?: string
  /** `custom` 引用的规则组 id。 */
  readonly groups?: readonly string[]
  /** `custom` 额外放行的绝对路径。 */
  readonly allow?: readonly string[]
  /** `custom` 额外排除的绝对路径。 */
  readonly deny?: readonly string[]
}

/**
 * 两条轴值是不是同一件事 —— 按值比，不按引用比。
 *
 * 比较的是宿主写进文档之后的那份形状：`groups` / `allow` / `deny` 只有一条轴真的是
 * `custom` 时才参与比较（`deny` / `workspace` / `all` 都不带这些成员），列表按顺序比，
 * 因为顺序是取值的一部分（提交顺序就是用户勾选的顺序）。
 * @param left - 一条轴值。
 * @param right - 另一条轴值。
 * @returns 两者是否描述同一条轴。
 */
export function sameStoredAxis(
  left: AxisEditorScope | undefined,
  right: AxisEditorScope | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  if (left.kind !== right.kind) return false
  if (left.kind !== 'custom' || right.kind !== 'custom') return true
  const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => {
    const one = a ?? []
    const other = b ?? []
    return one.length === other.length && one.every((value, index) => value === other[index])
  }
  return left.base === right.base
    && sameList(left.groups, right.groups)
    && sameList(left.allow, right.allow)
    && sameList(left.deny, right.deny)
}

/**
 * 把一个 `custom` 取值收成编辑器草稿（当前值显示用）。
 * @param axis - 该取值所属的轴。
 * @param value - 轴值，可能是 `custom` 并带底座与两个列表。
 * @returns 一份可编辑的草稿。
 */
export function draftOfAxisState(
  axis: PermissionAxis,
  value: {
    kind: PermissionAxisValue
    base?: string
    groups?: readonly string[]
    allow?: readonly string[]
    deny?: readonly string[]
  },
): AxisDraft {
  void axis
  if (value.kind !== 'custom') return emptyDraft(value.kind)
  const base = (AXIS_BASES as readonly string[]).includes(value.base ?? '')
    ? value.base as AxisBase
    : 'workspace'
  return {
    kind: 'custom',
    base,
    groups: [...(value.groups ?? [])],
    allow: (value.allow ?? []).join('\n'),
    deny: (value.deny ?? []).join('\n'),
  }
}

/**
 * 一条轴取值是否会**放开**权限：只有 `all`（整台主机）与带额外放行路径的 `custom`
 * 会，`deny` / `workspace` 和空清单的 `custom` 不会。
 *
 * 这个判定就是发布版二次确认闸的开关。它按**取值本身**算，不按界面动作算：同一条
 * `write:all`，无论从下拉选出还是从编辑器拼出，都要过一次同样的确认。
 * @param value - 轴取值。
 * @returns 该取值是否会放大访问范围。
 */
export function widensAccess(value: PermissionAxisValue): boolean {
  return value === ALL_AXIS
}

/**
 * 一条 `custom` 提交片段是否会放开权限：底座是 `all`，或带了任何额外放行路径。
 * 排除清单不收窄判定 —— `base=all,deny=/x` 仍然是整台主机减去一条路径。
 * @param fragment - `customFragment` 产出的片段。
 * @returns 该片段是否会放大访问范围。
 */
export function fragmentWidensAccess(fragment: string): boolean {
  const entries = fragment.split(',')
  if (entries[0] === `base=${ALL_AXIS}`) return true
  // 一个组是否真的放行了路径取决于它此刻的定义（宿主判定时现取），界面这边拿不到
  // 那个答案。所以只要引用了组就过一次确认：这个闸宁可多问一次，不能漏掉一次
  // 「加进一个带放行路径的组」。
  if (entries.some(entry => entry.startsWith('groups='))) return true
  return entries.some(entry => entry.startsWith('allow='))
}

/**
 * 把一条轴值读成一行摘要（当前值显示用），例如 `自定义：基于 工作区，+3 −1`。
 * @param value - 轴值。
 * @param text - 文案表。
 * @returns 一行说明。
 */
export function axisSummary(
  value: { kind: PermissionAxisValue; base?: string; allow?: readonly string[]; deny?: readonly string[] },
  text: { custom: (base: string, allow: number, deny: number) => string; base: (base: string) => string },
): string | undefined {
  if (value.kind !== 'custom') return undefined
  return text.custom(text.base(value.base ?? 'workspace'), (value.allow ?? []).length, (value.deny ?? []).length)
}

/**
 * 双轴配置页的规则组纯函数层：把设置节里的 `groups` / `defaultGroups` 收成可编辑
 * 草稿、把草稿收成宿主解析器接受的组库。这里不碰 React、不碰 DOM、也不碰宿主 ——
 * 界面每次挂载与每次保存都走这几个函数，因此「页面上能编的形状」与「宿主
 * `parseLibrary` 接受的形状」只有这一份定义。
 *
 * 组体只在设置页这一份：会话按 id 引用它，判定时现取（规格 §「为什么对话里绝不能
 * 存组体」）。所以这里的编辑结果写回的是**定义**，不是任何一条会话。
 *
 * @module @t4r71/dsh-dual-axis-ui/client/row/groups
 */

import { isAbsolutePath, pathLines } from './axes.ts'

/** 一个组在一条轴上的规则草稿：两个多行文本，每行一条绝对路径。 */
export interface GroupAxisDraft {
  /** 额外放行的绝对路径，每行一条。 */
  readonly allow: string
  /** 排除的绝对路径，每行一条；与放行同时命中时排除优先。 */
  readonly deny: string
}

/**
 * 一个规则组在界面上的草稿。
 *
 * `default` 是 {@link defaultGroups} 的界面形式：勾上的组会被新建的对话默认加载。
 * 它跟着草稿行走，所以改一个组的 id 不会把「默认加载」这件事丢在旧 id 上。
 */
export interface RuleGroupDraft {
  /** 稳定标识：会话按它引用这个组。 */
  readonly id: string
  /** 人读的名字；可以为空，宿主会用 id 顶上。 */
  readonly name: string
  /** 这个组给读轴的规则。 */
  readonly read: GroupAxisDraft
  /** 这个组给写轴的规则。 */
  readonly write: GroupAxisDraft
  /** 新对话是否默认加载这个组。 */
  readonly default: boolean
}

/** 一条轴在设置文档里的规则取值；两侧都空即这一侧整个缺席。 */
export interface RuleGroupAxisValue {
  /** 该轴额外放行的绝对路径。 */
  readonly allow: readonly string[]
  /** 该轴排除的绝对路径。 */
  readonly deny: readonly string[]
}

/** 写回设置文档的规则组取值，与宿主 `RuleGroup` 同一形状。 */
export interface RuleGroupValue {
  /** 稳定标识。 */
  readonly id: string
  /** 人读的名字。 */
  readonly name: string
  /** 读侧规则；两侧都不填时为 undefined（这个组不覆盖读轴）。 */
  readonly read?: RuleGroupAxisValue
  /** 写侧规则；两侧都不填时为 undefined（这个组不覆盖写轴）。 */
  readonly write?: RuleGroupAxisValue
}

/** 一条规则在界面上读不懂时用的说明键。 */
export type GroupProblemKey = 'idEmpty' | 'idDuplicate' | 'notAbsolute'

/**
 * 生成一个说明键对应的文案；由调用方按当前语言取用（界面文案不在这里出现）。
 * @param key - 说明键。
 * @param params - 填进文案里的具名参数。
 * @returns 一句话说明。
 */
export type GroupProblemText = (key: GroupProblemKey, params: Record<string, string>) => string

/**
 * 把一个未信任的取值读成一份文本草稿：不是数组时读成空串（界面上不显示任何路径）。
 * @param value - 设置文档里那条轴的 `allow` 或 `deny`。
 * @returns 每行一条的文本。
 */
function textOfPaths(value: unknown): string {
  return (Array.isArray(value) ? value : [])
    .filter((item): item is string => typeof item === 'string')
    .join('\n')
}

/**
 * 把一份未信任的组取值读成界面草稿。
 * @param value - 组库里的一项。
 * @param isDefault - 这个 id 是否在 `defaultGroups` 里。
 * @returns 该组的草稿；id 不是一个字符串时用空串，让用户在界面上看见并改它。
 */
function draftOfGroup(value: unknown, isDefault: boolean): RuleGroupDraft {
  const candidate = (typeof value === 'object' && value !== null ? value : {}) as {
    id?: unknown
    name?: unknown
    read?: unknown
    write?: unknown
  }
  const side = (rules: unknown): GroupAxisDraft => {
    const rules_ = (typeof rules === 'object' && rules !== null ? rules : {}) as { allow?: unknown; deny?: unknown }
    return { allow: textOfPaths(rules_.allow), deny: textOfPaths(rules_.deny) }
  }
  return {
    id: typeof candidate.id === 'string' ? candidate.id : '',
    name: typeof candidate.name === 'string' ? candidate.name : '',
    read: side(candidate.read),
    write: side(candidate.write),
    default: isDefault,
  }
}

/**
 * 把设置文档里的组库与默认加载清单读成界面草稿。
 *
 * 读取是**宽容**的：这个函数的产物要能渲染出来让人修，所以读不懂的成员按空值处理，
 * 而不是抛出去让整页打不开。挡住保存的是 {@link groupLibraryOf}，那里才拒绝坏取值。
 * @param groups - 设置文档里的 `groups`，未信任。
 * @param defaultGroups - 设置文档里的 `defaultGroups`，未信任。
 * @returns 每个组一份草稿，顺序与文档一致。
 */
export function groupDraftsOf(groups: unknown, defaultGroups: unknown): RuleGroupDraft[] {
  if (!Array.isArray(groups)) return []
  const defaults = Array.isArray(defaultGroups)
    ? defaultGroups.filter((item): item is string => typeof item === 'string')
    : []
  return groups.map(entry => {
    const id = (typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined)
    return draftOfGroup(entry, typeof id === 'string' && defaults.includes(id))
  })
}

/**
 * 一条草稿的某一侧：两个列表都空即这一侧缺席。
 * @param side - 该侧的草稿。
 * @returns 该侧的取值，或 undefined。
 */
function axisValueOf(side: GroupAxisDraft): RuleGroupAxisValue | undefined {
  const allow = pathLines(side.allow)
  const deny = pathLines(side.deny)
  if (allow.length === 0 && deny.length === 0) return undefined
  return { allow, deny }
}

/**
 * 把一份组草稿收成可以写回设置的组库。
 *
 * 校验与宿主 `parseLibrary` / `groupAt` 逐条对齐：id 非空且唯一，每条路径必须是
 * 绝对路径。宿主在库读不懂时会让**每一次判定**都响亮失败，所以这里必须在写入之前
 * 就挡住坏取值，而不是把一份宿主读不懂的库保存下去。
 * @param drafts - 界面上的草稿。
 * @param problemOf - 把说明键转成当前语言文案的回调。
 * @returns 组库取值，或一句说明这份草稿为什么还不能保存的话。
 */
export function groupLibraryOf(
  drafts: readonly RuleGroupDraft[],
  problemOf: GroupProblemText,
): { ok: true; value: RuleGroupValue[] } | { ok: false; problem: string } {
  const seen = new Set<string>()
  const value: RuleGroupValue[] = []
  for (const draft of drafts) {
    const id = draft.id.trim()
    if (id === '') return { ok: false, problem: problemOf('idEmpty', {}) }
    if (seen.has(id)) return { ok: false, problem: problemOf('idDuplicate', { id }) }
    seen.add(id)
    const sides: ReadonlyArray<readonly ['read' | 'write', GroupAxisDraft]> = [['read', draft.read], ['write', draft.write]]
    for (const [side, rules] of sides) {
      for (const [entry, text] of [['allow', rules.allow], ['deny', rules.deny]] as const) {
        const bad = pathLines(text).find(path => !isAbsolutePath(path))
        if (bad !== undefined) {
          return { ok: false, problem: problemOf('notAbsolute', { id, side, entry, path: bad }) }
        }
      }
    }
    const read = axisValueOf(draft.read)
    const write = axisValueOf(draft.write)
    value.push({
      id,
      name: draft.name.trim() === '' ? id : draft.name,
      ...read === undefined ? {} : { read },
      ...write === undefined ? {} : { write },
    })
  }
  return { ok: true, value }
}

/**
 * 草稿里被勾上「新对话默认加载」的组 id。
 *
 * 只在 {@link groupLibraryOf} 通过之后取用：那时 id 非空且唯一，所以这份清单本身
 * 也是合法的 `defaultGroups`。
 * @param drafts - 界面上的草稿。
 * @returns 勾选顺序即文档顺序的 id 清单。
 */
export function defaultGroupIdsOf(drafts: readonly RuleGroupDraft[]): string[] {
  return drafts.filter(draft => draft.default).map(draft => draft.id.trim())
}

/**
 * 给新加的一个组起一个还没有被占用的 id。
 *
 * 默认名 `g1`、`g2`…：id 是会话引用的东西，先给出一个能用的，再由人改。
 * @param drafts - 当前已有的草稿。
 * @returns 一个没有被占用的 id。
 */
export function nextGroupId(drafts: readonly RuleGroupDraft[]): string {
  const taken = new Set(drafts.map(draft => draft.id.trim()))
  for (let index = 1;; index += 1) {
    const candidate = `g${String(index)}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * 一个空组的草稿：id 未被占用、名字留空（保存时用 id 顶上）、两侧规则都空、
 * 默认不加载。空组是合法的 —— 组的内容随时可改，先建出来再填是正常用法。
 * @param drafts - 当前已有的草稿。
 * @returns 一份可以加进列表的草稿。
 */
export function emptyGroupDraft(drafts: readonly RuleGroupDraft[]): RuleGroupDraft {
  const id = nextGroupId(drafts)
  return {
    id,
    name: '',
    read: { allow: '', deny: '' },
    write: { allow: '', deny: '' },
    default: false,
  }
}

/**
 * 两份组库是否描述同一份定义。
 *
 * 与轴的 `sameAxis` 同一个用法：保存时比对「现在的草稿」与「文档里已生效的值」，
 * 相同就不发写入。逐成员比较而不是引用比较，因为每次重解析都会新建对象。
 * @param left - 一份组库取值。
 * @param right - 另一份组库取值。
 * @returns 两者是否描述同一份组库。
 */
export function sameGroupLibrary(
  left: readonly RuleGroupValue[],
  right: readonly RuleGroupValue[],
): boolean {
  const list = (value: readonly string[] | undefined): string => (value ?? []).join('\u0000')
  const side = (value: RuleGroupAxisValue | undefined): string =>
    value === undefined ? '' : list(value.allow) + '\u0001' + list(value.deny)
  if (left.length !== right.length) return false
  return left.every((group, index) => {
    const other = right[index]
    if (other === undefined) return false
    return group.id === other.id && group.name === other.name
      && side(group.read) === side(other.read) && side(group.write) === side(other.write)
  })
}

/**
 * 把一份已经收好的组库摊成设置文档接受的 JSON。
 *
 * 取值里的列表是 `readonly string[]`，而文档取值是可变的 JSON 数组：传只读数组会被
 * 线上格式挡住，所以写入前摊平一层（与轴的 `jsonAxis` 同因）。
 * @param library - 一份校验过的组库。
 * @returns 同一份取值的可变副本。
 */
export function jsonGroupLibrary(library: readonly RuleGroupValue[]): Array<{
  id: string
  name: string
  read?: { allow: string[]; deny: string[] }
  write?: { allow: string[]; deny: string[] }
}> {
  const side = (value: RuleGroupAxisValue | undefined): { allow: string[]; deny: string[] } | undefined =>
    value === undefined ? undefined : { allow: [...value.allow], deny: [...value.deny] }
  return library.map(group => {
    const read = side(group.read)
    const write = side(group.write)
    return {
      id: group.id,
      name: group.name,
      ...read === undefined ? {} : { read },
      ...write === undefined ? {} : { write },
    }
  })
}

/**
 * 默认加载清单的 JSON 形式（可变数组）。
 * @param ids - 被勾选的组 id。
 * @returns 同一份清单的可变副本。
 */
export function jsonDefaultGroupIds(ids: readonly string[]): string[] {
  return [...ids]
}

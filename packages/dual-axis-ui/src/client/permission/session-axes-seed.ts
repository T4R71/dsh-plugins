/**
 * 记录缺席时两个下拉该显示的那一对轴：宿主 `seedPair` 的逐字镜像。
 *
 * 宿主那一份在 `@t4r71/dsh-dual-axis` 的 `src/session-store.ts`，是
 * `seedAxesFor` 的纯核：设置页那一行（`read` / `write` / `defaultGroups`），
 * 加上子代理子会话从**父会话当刻的记录**继承来的那一对，折成「这条会话在新存储里
 * 还没有记录时被钉下、也被判定路径执行的那一对」。记录落地之前，活读路径（模型提示词、
 * 读围栏、`/axis` 的兜底）交回的就是它，所以界面必须显示同一个值 —— 显示别的就是
 * 「界面显示 A、宿主执行 B」：设置页默认若是「禁止读」，那一轮仍然被当成「全盘读」。
 *
 * 为什么另起一个模块：它必须能在**零依赖**的程序里被直接加载，好让宿主包的
 * `tests/seed-parity.spec.ts` 把两侧喂同一组输入、断言输出逐字相等（这是防止两份
 * 实现以后各自漂移的唯一手段）。因此本文件不 import 任何东西，下面每一步都与宿主那
 * 一份一一对应：取值集合、校验顺序、键的插入顺序、连报错条件都一致。
 *
 * 与 `./session-axes-data.ts` 的分工：那边负责「文档里有没有这条会话的记录」，
 * 这边只负责「没有记录时那一对该是什么」。
 *
 * @module @deepseek-ai/dsh-client-ui-permission-presets/client/session-axes-seed
 */

/** 一条轴在文档里的拼写：闭合取值只有 `kind`。 */
export interface SeededAxis {
  /** 四种取值之一：`deny` / `workspace` / `all` / `custom`。 */
  readonly kind: string
  /** `custom` 的比较底座。 */
  readonly base?: string
  /** `custom` 引用的规则组 id。 */
  readonly groups?: readonly string[]
  /** `custom` 在底座之上追加的绝对路径。 */
  readonly allow?: readonly string[]
  /** `custom` 从（底座 ∪ allow）里排除的绝对路径。 */
  readonly deny?: readonly string[]
}

/** 一条会话的一对轴。 */
export interface SeededAxes {
  /** 读轴。 */
  readonly read: SeededAxis
  /** 写轴。 */
  readonly write: SeededAxis
}

/** 四种取值，校验顺序与宿主的 `AXIS_KINDS` 相同。 */
const AXIS_KINDS: readonly string[] = ['deny', 'workspace', 'all', 'custom']

/** 三个底座，校验顺序与宿主的 `AXIS_BASES` 相同。 */
const AXIS_BASES: readonly string[] = ['deny', 'workspace', 'all']

/**
 * 读不懂任何输入时的那一对：宿主 `DEFAULT_AXES` 的同一对取值
 * （`packages/bundle/dual-axis/src/axis.ts` 的 `DEFAULT_READ_SCOPE` /
 * `DEFAULT_WRITE_SCOPE`）。
 *
 * 它**不再**是「会话没有记录」时的答案 —— 那是 {@link sessionAxesSeed} 算出来的
 * 种子。这一对只在设置页那一行整个读不懂时出现，而宿主在那同一种情形下交回的也正是
 * 它（`seedPair` 的 catch 与 `ensure` 的 catch 都答 `DEFAULT_AXES`）。
 */
export const SESSION_AXES_FALLBACK: SeededAxes = Object.freeze({
  read: Object.freeze({ kind: 'all' }),
  write: Object.freeze({ kind: 'workspace' }),
})

/**
 * 一条配置字段是「普通对象」还是别的东西。数组也算对象，与宿主一致：数组随后会在
 * `kind` 那一关被拒，判定因此仍然落在同一处。
 * @param value - 待判定的取值。
 * @returns 是否是非 null 的 object。
 */
function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 解开一个 `.volatile()` 字段的 accessor。文档走的是 JSON，正常只会拿到普通值；
 * 保留这一步是为了与宿主逐字同形 —— 包括宿主在 `null` 上取属性会抛这一点，两侧因此
 * 在同一个输入上落到同一条兜底。
 * @param value - 字段取值。
 * @returns 底层取值。
 */
function unwrapVolatile(value: unknown): unknown {
  if (value === undefined) return undefined
  const accessor = value as { get?: unknown }
  return typeof accessor.get === 'function' ? (accessor.get as () => unknown)() : value
}

/**
 * 一条轴的路径表（`allow` / `deny`）。宿主 `pathList` 的镜像：必须是绝对路径，
 * 顺序即取值的一部分。
 * @param label - 报错里的轴名。
 * @param entry - 报错里的表名（`allow` 或 `deny`）。
 * @param value - 未信任的列表取值。
 * @returns 校验过的列表。
 * @throws 不是字符串数组，或含非绝对路径条目时。
 */
function pathList(label: string, entry: string, value: unknown): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`dual-axis: ${label} ${entry} must be an array of absolute path strings`)
  }
  for (const item of value as string[]) {
    if (item.length === 0 || !isAbsoluteSpelling(item)) {
      throw new Error(`dual-axis: ${label} ${entry} entry ${JSON.stringify(item)} must be an absolute path`)
    }
  }
  return [...(value as string[])]
}

/**
 * 一条轴引用的组 id。宿主 `groupIds` 的镜像：只查「是非空字符串的名字」，
 * 按首次出现去重；这个名字在库里存不存在是判定时的事。
 * @param label - 报错里的轴名。
 * @param value - 未信任的 `groups` 取值。
 * @returns 去重后的 id 列表。
 * @throws 不是非空字符串数组时。
 */
function groupIds(label: string, value: unknown): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`dual-axis: ${label} groups must be an array of non-empty rule-group ids`)
  }
  return [...new Set(value as string[])]
}

/**
 * 一个配置路径在拼写上是否绝对。宿主 `isAbsoluteSpelling` 的镜像：POSIX 与
 * Windows 两种拼法都收，真正绑定到本机的是随后的规范化。
 * @param path - 配置里的路径拼写。
 * @returns 是否绝对。
 */
function isAbsoluteSpelling(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/**
 * 一条轴取值从文档（人手可能改过）收窄成合法的轴。宿主 `normalizeScope` 的镜像：
 * 读不懂就抛，绝不猜一个更宽或更窄的边界。
 * @param label - 报错里的轴名（`read` 或 `write`）。
 * @param value - 未信任的轴取值。
 * @returns 合法的轴取值。
 * @throws 不是四种取值之一，或 custom 的底座/路径不合法时。
 */
function normalizeAxis(label: string, value: unknown): SeededAxis {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`dual-axis: ${label} must be an access-axis object, received ${JSON.stringify(value)}`)
  }
  const candidate = value as { kind?: unknown; base?: unknown; groups?: unknown; allow?: unknown; deny?: unknown }
  if (typeof candidate.kind !== 'string' || !AXIS_KINDS.includes(candidate.kind)) {
    throw new Error(`dual-axis: ${label} carries unknown kind ${JSON.stringify(candidate.kind)} (expected: ${AXIS_KINDS.join(', ')})`)
  }
  if (candidate.kind !== 'custom') return { kind: candidate.kind }
  if (typeof candidate.base !== 'string' || !AXIS_BASES.includes(candidate.base)) {
    throw new Error(`dual-axis: ${label} custom base must be ${AXIS_BASES.join(', ')}, received ${JSON.stringify(candidate.base)}`)
  }
  return {
    kind: 'custom',
    base: candidate.base,
    groups: groupIds(label, candidate.groups),
    allow: pathList(label, 'allow', candidate.allow),
    deny: pathList(label, 'deny', candidate.deny),
  }
}

/**
 * 设置页那一行折成一对轴。宿主 `axesOf` 的镜像：两侧缺席时各退回内置默认轴。
 * @param row - 那一行的取值，未信任。
 * @returns 那一行声明的两条轴。
 * @throws 任一条轴读不懂时。
 */
function axesOfRow(row: unknown): SeededAxes {
  const declared = isObjectLike(row) ? row : {}
  return {
    read: normalizeAxis('read', unwrapVolatile(declared.read) ?? { kind: 'all' }),
    write: normalizeAxis('write', unwrapVolatile(declared.write) ?? { kind: 'workspace' }),
  }
}

/**
 * 重新收窄另一处读出来的一对轴。宿主 `pairOf` 的镜像：宿主写下的那一对本就是收窄过的，
 * 而客户端从文档里读到的父会话记录是原始字节，两侧必须过同一道校验才谈得上逐字相等。
 * @param pair - 未信任的一对轴。
 * @returns 收窄后的一对轴。
 * @throws 任一成员不是合法轴取值时。
 */
function pairOf(pair: SeededAxes): SeededAxes {
  return { read: normalizeAxis('read', pair.read), write: normalizeAxis('write', pair.write) }
}

/**
 * 设置页那一行声明的 `defaultGroups`。宿主 `defaultGroupIds` 的镜像。
 * @param row - 那一行的取值，未信任。
 * @returns 去重后的组 id；没声明时为空。
 * @throws 声明了非法的组 id 时。
 */
function defaultGroupIds(row: unknown): readonly string[] {
  const value = isObjectLike(row) ? unwrapVolatile(row.defaultGroups) : undefined
  return groupIds('defaultGroups', value)
}

/**
 * 把新会话默认加载的组 id 挂到**自己就是 `custom` 的那条轴**上，其余轴按声明原样留下。
 * 宿主 `seedGroupReferences` 的镜像。
 *
 * 逐轴独立判断：只有 kind 本身就是 `custom` 的轴才带得住引用。判在设置页那一行上
 * （一个并不绑定到轴的勾选框）会把 `read: all` 提升成 `read: { kind: 'custom', base: 'all' }`，
 * 而两条轴谁都没被选成自定义。闭合成取值没有地方放 id，原样播种 —— 提升会报出一条
 * 设置页从没显示过的自定义范围。两条轴因此互不影响：一条挂组，另一条保持闭合取值。
 * @param axes - 被播种的那一对轴。
 * @param ids - 设置页那一行的 `defaultGroups`。
 * @returns 带上这些引用的那一对轴。
 */
function seedGroupReferences(axes: SeededAxes, ids: readonly string[]): SeededAxes {
  if (ids.length === 0) return axes
  const attach = (axis: SeededAxis): SeededAxis => axis.kind === 'custom'
    ? { ...axis, groups: [...new Set([...(axis.groups ?? []), ...ids])] }
    : axis
  return { read: attach(axes.read), write: attach(axes.write) }
}

/**
 * 记录缺席时该显示的那一对轴 —— 与宿主 `seedPair` 同一份计算、同一个兜底。
 *
 * 永不抛：设置页那一行读不懂、父会话记录读不懂，一律答
 * {@link SESSION_AXES_FALLBACK}，与宿主在同一种输入上的答案相同。
 * @param row - 设置页那一行（`dual-axis` 命名空间）的取值，未信任。
 * @param inherited - 子代理子会话从父会话记录继承来的那一对，或 `undefined`。
 * @returns 这条会话此刻被钉下、也被被执行的那一对轴。
 */
export function sessionAxesSeed(row: unknown, inherited: SeededAxes | undefined): SeededAxes {
  try {
    return seedGroupReferences(
      inherited === undefined ? axesOfRow(row) : pairOf(inherited),
      defaultGroupIds(row),
    )
  } catch {
    return SESSION_AXES_FALLBACK
  }
}

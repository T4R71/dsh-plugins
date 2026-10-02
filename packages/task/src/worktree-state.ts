/**
 * 一个可选的隔离检出（git worktree）的**账本**。
 *
 * 它是 `task` 自己的一个 JSON 文件 —— 与 {@link ledgerPathFor} 的 run 账本同一条纪律：
 * 没有 Loader 行、没有设置命名空间、写路径上没有第三方。存在这里的东西只有两类：
 *   - **在飞的 worktree**（名字 → 检出路径 / 分支 / 基线 / 中枢声明的验证命令）；
 *   - **这条线的写穿检测用的主检出快照**（起线那一刻的 `git status --porcelain`）。
 *
 * 为什么必须落盘而不是只放在内存里：子代理是**异步结算**的，宿主重启之后那条线还在
 * worktree 里跑着，而「这条线在哪个 worktree、哪个分支、验证命令是什么」必须还找得回来。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** 账本文件名（相对基准目录）。 */
export const WORKTREES_FILE_NAME = 'task-worktrees.json'

/** 覆盖账本位置的环境变量。只给测试与排障用。 */
export const WORKTREES_FILE_ENV = 'DSH_TASK_WORKTREES_FILE'

/**
 * 账本文件的落点。
 *
 * 决议顺序与 `session-store.ts` 的 {@link ledgerPathFor} 逐条同源，只是换一个文件名：
 * 显式配置 → 环境变量 → 另一个账本文件所在目录 → `DSH_PROFILE_DIR`/`DSH_HOME` → cwd。
 *
 * `siblingOf` 是这一版**新增**的一档：worktree 账本与 run 账本必须**住在一起**，
 * 否则「重启之后去哪儿把状态读回来」会因为配置文件位置不同而分成两处。
 * @param configured - 配置里的 `worktreesFile`（可为空串）。
 * @param siblingOf - run 账本文件的位置（可能是相对路径）。
 * @returns 账本文件的路径。
 */
export function worktreesPathFor(configured: string, siblingOf?: string): string {
  const explicit = configured.trim()
  if (explicit !== '') return explicit
  const env = (process.env[WORKTREES_FILE_ENV] ?? '').trim()
  if (env !== '') return env
  if (siblingOf !== undefined && siblingOf.trim() !== '') {
    const from = resolve(siblingOf)
    const at = from.lastIndexOf(sep)
    return at < 0 ? WORKTREES_FILE_NAME : from.slice(0, at) + sep + WORKTREES_FILE_NAME
  }
  const base = (process.env.DSH_PROFILE_DIR ?? process.env.DSH_HOME ?? '').trim()
  return base === '' ? WORKTREES_FILE_NAME : join(base, WORKTREES_FILE_NAME)
}

/** 一个值是不是纯数据对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 一段文本：非空字符串才保留（两侧去白）。 */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : value
}

/**
 * 起线**之前**在主检出上拍到的一张快照。
 *
 * 它的唯一用途是**写穿检测**：结算时再拍一张，两张不一样就说明子代理在主检出上动了手。
 * 存的是 `git status --porcelain` 的**原文**（不是解析后的列表）——原文里每一项都带着两份路径
 * （改名/复制的旧名与新名），自己解析一遍只会多一处出错的地方；真要列出被人动的路径时再拆。
 */
export interface MainSnapshot {
  /** 起线那一刻 `git status --porcelain` 的原文（干净时是空串）。 */
  readonly porcelain: string
}

/**
 * 这条线**起线时那次依赖断言**的结局。
 *
 * 为什么必须落盘：一条线可能被**重试**（同名再来一次），那时要不要重跑一遍
 * `pnpm install --frozen-lockfile` 只能看这里 —— 通过过的那条可以跳过（省下一次全量安装），
 * 而**失败过的**那条绝不能跳：跳过就等于把「依赖集合与主线一致」这句话变成了一个谎。
 */
export interface WorktreePrepared {
  /** 跑的命令（空串 = 这条线不装依赖，断言不成立但显式声明了）。 */
  readonly command: string
  /** 通过没有。 */
  readonly ok: boolean
  /** 记下来的时刻（毫秒）。 */
  readonly at: number
}

/** 一条在飞的隔离线。 */
export interface WorktreeRecord {
  /** 线名（`dispatch worktree:` 给的那个名字），全会话唯一。 */
  readonly name: string
  /** 主检出（那个仓库的 root）绝对路径。 */
  readonly repo: string
  /** 这条线的检出绝对路径（`<repo>-wt-<名>`）。 */
  readonly path: string
  /** 这条线的分支名（`wt/<名>`）。 */
  readonly branch: string
  /** 分叉点（`git worktree add` 用的那个 commit-ish）。 */
  readonly base: string
  /** 建线时刻（毫秒）。 */
  readonly createdAt: number
  /**
   * **中枢在派发时声明**的验证命令。
   *
   * 为什么由中枢声明、而不是让子代理临时给：子代理可以随手传一条 `true` 骗过验证，
   * 中枢声明的才作数。子代理能做的只有**追加**额外的检查，不能省略这一条。
   *
   * 省略时这条线**没有验证命令** —— `task commit` 会明确拒绝，绝不默认放行。
   */
  readonly verify?: string
  /**
   * **中枢在派发时声明**的、合回之后要跑的整套检查。省略即这条线不能合回（fail-closed）。
   *
   * 它与 {@link verify} 是两件事：那条是「这一步的功能有没有做对」，这条是
   * 「合到一起之后整个仓还立不立得住」—— 单功能全绿而合并之后炸，正是这套流程要防的事。
   */
  readonly mergeVerify?: string
  /** 起线时中枢写的那句线意图（这条线在干什么、别碰哪些文件）；写进简报。 */
  readonly goal?: string
  /** 验证命令的工作目录（相对检出根）；省略即在检出根跑。 */
  readonly verifyCwd?: string
  /** 起线那一刻主检出的快照（写穿检测的基准）。 */
  readonly main: MainSnapshot
  /**
   * 这条线的依赖断言结局（{@link WorktreePrepared}）。省略 = **还没断言过** ——
   * 复用这条线时按「没断言过」处理，重跑一遍，绝不默认放行。
   */
  readonly prepared?: WorktreePrepared
  /**
   * 落在这条线上的**子会话 id**（一条线可能有多个：run 的起点与自动放行的后继）。
   *
   * 为什么必须记：`dispatch` 那条通道**不写 run 账本**（它没有 run），
   * 于是「这个结算的孩子属于哪条线」除了这里没有第二个地方能查到。
   * 省略 = 还没有孩子落到这条线上。
   */
  readonly children?: readonly string[]
}

/** 整份账本。 */
export type WorktreesField = Record<string, WorktreeRecord>

/**
 * 读回一份节点记录（不可信输入）。
 * @param value - 不可信的记录。
 * @returns 校验后的记录，或 undefined。
 */
function parseRecord(value: unknown): WorktreeRecord | undefined {
  if (!isRecord(value)) return undefined
  const name = text(value.name)
  const repo = text(value.repo)
  const path = text(value.path)
  const branch = text(value.branch)
  const base = text(value.base)
  if (name === undefined || repo === undefined || path === undefined || branch === undefined || base === undefined) return undefined
  const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : 0
  const main = isRecord(value.main) && typeof value.main.porcelain === 'string' ? { porcelain: value.main.porcelain } : { porcelain: '' }
  // children 必须**读回来**：整份账本是读完-改-写回去的，不认这一格的话，
  // 下一次起线或收线都会把「谁在这条线上」抹掉 —— 结算时就认不出这条线了。
  const children = Array.isArray(value.children) ? value.children.filter((id): id is string => typeof id === 'string' && id !== '') : []
  // prepared 同样必须读回来：整份账本是读完-改-写回去的，不认这一格的话，
  // 下一次任何一条记账都会把「这条线的依赖断言过没过」抹成「没断言过」。
  const prepared = isRecord(value.prepared)
    ? { command: typeof value.prepared.command === 'string' ? value.prepared.command : '', ok: value.prepared.ok === true, at: typeof value.prepared.at === 'number' && Number.isFinite(value.prepared.at) ? value.prepared.at : 0 }
    : undefined
  return {
    name, repo, path, branch, base, createdAt, main,
    ...prepared === undefined ? {} : { prepared },
    ...text(value.verify) === undefined ? {} : { verify: value.verify as string },
    ...text(value.mergeVerify) === undefined ? {} : { mergeVerify: value.mergeVerify as string },
    ...text(value.goal) === undefined ? {} : { goal: value.goal as string },
    ...text(value.verifyCwd) === undefined ? {} : { verifyCwd: value.verifyCwd as string },
    ...children.length === 0 ? {} : { children },
  }
}

/**
 * 把任意路径定成一个**绝对**路径（相对路径按基准目录解析）。
 * @param path - 待定路径。
 * @param base - 相对路径的基准目录。
 * @returns 绝对路径。
 */
export function toAbsolute(path: string, base: string): string {
  return isAbsolute(path) ? path : resolve(base, path)
}

/** worktree 账本的读写面。 */
export interface WorktreeStore {
  /** 账本文件的位置（报错文案里带上它，排障不必猜）。 */
  readonly path: string
  /**
   * 读回全部在飞的线。**降级不抛**：文件不存在/读不动就是空表。
   * @returns 名字 → 记录。
   */
  read(): Promise<WorktreesField>
  /**
   * 记下一条线。**名字已存在时覆盖**（同一名字重新起线 = 这条线被重建）。
   * @param record - 要记的线。
   */
  put(record: WorktreeRecord): Promise<void>
  /** 抹掉一条线（收线之后）。 */
  drop(name: string): Promise<void>
}

/**
 * 造一份 worktree 账本。
 * @param filePath - 落盘位置。
 * @returns 账本读写面。
 */
export function createWorktreeStore(filePath: string): WorktreeStore {
  /**
   * 读整份。读不动一律退化成空表 —— 与 run 账本同一条理由：读不到的后果是
   * 「这次不认得这条线」，不是把调用方炸掉。
   * @returns 账本。
   */
  const read = async (): Promise<WorktreesField> => {
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch {
      return {}
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return {}
    }
    const items = isRecord(parsed) ? parsed.worktrees : undefined
    if (!isRecord(items)) return {}
    const field: Record<string, WorktreeRecord> = {}
    for (const [name, value] of Object.entries(items)) {
      const record = parseRecord(value)
      if (record !== undefined) field[name] = record
    }
    return field
  }

  /**
   * 整份原子写回（临时文件 + rename）：写到一半崩掉不许留下半份账本。
   * @param field - 要落盘的那一份。
   */
  const writeWhole = async (field: WorktreesField): Promise<void> => {
    await mkdir(dirname(filePath), { recursive: true })
    const temporary = filePath + '.' + String(process.pid) + '.' + String(Date.now()) + '.tmp'
    await writeFile(temporary, JSON.stringify({ version: 1, worktrees: field }, null, 1), 'utf8')
    await rename(temporary, filePath)
  }

  return {
    path: filePath,
    read,
    put: async (record: WorktreeRecord): Promise<void> => {
      const current = await read()
      await writeWhole({ ...current, [record.name]: record })
    },
    drop: async (name: string): Promise<void> => {
      const current = await read()
      if (!(name in current)) return
      const next = { ...current }
      delete next[name]
      await writeWhole(next)
    },
  }
}

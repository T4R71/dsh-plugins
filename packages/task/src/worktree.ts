/**
 * 并行修改的**隔离检出**（git worktree）、**按功能验证后提交**，以及**合回与统一提交**。
 *
 * 这个模块只管四件事，别的一概不碰：
 *   1. **起线**：给一条并行的线建一个独立的 git worktree + 分支（{@link createWorktree}）——
 *      **同名再来一次就是「接回那条线」**（{@link worktreeMatches} 认得出它还在不在，
 *      检出没了就把同名的分支接回来），绝不把同名当成错误：重试与续跑都要走这条路；
 *   2. **分支内提交**：跑中枢声明的机械验证、并把结果如实记进提交信息；判断档同样作数。
 *      本动作是**记录员不是守门员**（{@link commitFeature}）；
 *   3. **合回与统一提交**：合并后跑整套检查，通过才把这条线的成果合成一个提交落到主线（{@link mergeWorktree}）；
 *   4. **收线**：删掉已经合回（或明确放弃）的 worktree（{@link dropWorktree}）。
 *
 * ## 隔离强度：指示 + 事后检测，**不是物理阻止**
 *
 * 已核实的一手事实（别重查）：
 *   - 子会话的 cwd **就是父会话的 cwd**（`dsh-subagent/lib/index.js` 的 `childSessionMeta()`
 *     写 `{cwd: parentHeader.cwd}`），`SubagentStartRequest` **没有 cwd 槽**，
 *     `resolveChildCwd` 里的 `configured` 是插件装载时校验一次的静态配置 ——
 *     **无法按次派发指定 cwd**；
 *   - `tool/call` 不是拦截钩子（它是 `session.append("tool/call", ...)`，写在派发**之后**），
 *     **没有改写工具参数的挂点**。
 *
 * 于是本模块能给的只有两样：**指示**（{@link isolationPreamble} —— 简报开头那段隔离前言是
 * 代码里的常量，不让中枢手写）与**事后检测**（{@link detectLeak}：对比主检出起线前后两次
 * `git status --porcelain`，变了就大声报警）。**绝不假装能物理拦住。**
 * 将来要做硬隔离，路径是扩展我们自己的 `dual-axis`，给子会话下独立的文件轴。
 *
 * ## 提交语义（用户 2026-10-02 拍板的完整模型）
 *
 * 四个环节，缺一不可：
 *   ① **自动进分支**：改代码的派发默认就进隔离线，不是中枢每次记得加参数；
 *   ② **分支内按功能分区提交**：一次提交 = 一个**验证通过**的功能单元，一条线多个提交；
 *   ③ **合回 + 合并后的整体验证**：跑的是**整套**检查，不是单功能那条；不通过则主线一个字节不动；
 *   ④ **通过才统一提交**：分支上是多个按功能的提交，主线拿到的是**一个**整合提交。
 *
 * 三条不许松的口径：
 *   - 验证命令由**中枢在派发时声明**、按线存下来，`commit` / `merge` 跑的都是**存下来的那条** ——
 *     子代理可以随手传 `true` 骗过验证，中枢声明的才作数；
 *   - 验证非 0 ⇒ **一个字节都不提交**，把命令的真实输出交回去；
 *   - 空改动（与基线无差异）⇒ **不造空提交**。
 *
 * @module @t4r71/dsh-task/worktree
 */

import { execFile } from 'node:child_process'
import { copyFile, lstat, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** 跑一条命令的结局。 */
export interface CommandOutcome {
  /** 退出码；进程被信号杀掉、或根本没跑起来时为 -1。 */
  readonly code: number
  /** 标准输出。 */
  readonly stdout: string
  /** 标准错误。 */
  readonly stderr: string
  /** 命令没跑成时的原因（可执行文件不存在等）；跑成了就是 undefined。 */
  readonly failure?: string
}

/** 单条命令的默认执行期限（毫秒）。git 操作与验证都在这之内。 */
export const COMMAND_TIMEOUT_MS = 120000

/** 整体验证（合回之后那一整套）的默认执行期限：它比单条命令长得多。 */
export const VERIFY_TIMEOUT_MS = 600000

/** 命令输出交回调用方时的截断上限（字符）。 */
export const OUTPUT_MAX = 2000

/**
 * 跑一条命令。**绝不抛** —— 失败也是一种结局，由调用方判。
 * @param file - 可执行文件。
 * @param args - 参数数组。
 * @param cwd - 工作目录。
 * @param timeoutMs - 执行期限。
 * @returns 结局。
 */
export function runCommand(file: string, args: readonly string[], cwd: string, timeoutMs: number = COMMAND_TIMEOUT_MS): Promise<CommandOutcome> {
  return new Promise<CommandOutcome>((settle) => {
    execFile(file, [...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      const out = String(stdout ?? '')
      const err = String(stderr ?? '')
      if (error === null) {
        settle({ code: 0, stdout: out, stderr: err })
        return
      }
      const raw = (error as { code?: unknown }).code
      // 进程跑起来了、只是退出码非 0：`code` 是数字。跑不起来（ENOENT 等）时是字符串或 undefined ——
      // 那**不是**「验证失败」，是「这条命令根本没执行」，两者必须分得开。
      if (typeof raw === 'number') {
        settle({ code: raw, stdout: out, stderr: err })
        return
      }
      settle({ code: -1, stdout: out, stderr: err, failure: String(error.message ?? error) })
    })
  })
}

/**
 * 跑**一整行 shell 文本**。
 *
 * 为什么这里非走 shell 不可：验证命令是中枢写下来的一行字（`npx tsc -b`、`pnpm test`），
 * 不是 argv。用 argv 形式就得自己切词，切错了会静默跑成另一条命令 —— 那比拒绝更坏。
 * @param command - 一整行命令。
 * @param cwd - 工作目录。
 * @param timeoutMs - 执行期限。
 * @returns 结局。
 */
export function runShellLine(command: string, cwd: string, timeoutMs: number = COMMAND_TIMEOUT_MS): Promise<CommandOutcome> {
  return process.platform === 'win32'
    ? runCommand('cmd.exe', ['/d', '/s', '/c', command], cwd, timeoutMs)
    : runCommand('/bin/sh', ['-c', command], cwd, timeoutMs)
}

/**
 * 一条 `git` 调用的身份前缀。
 *
 * `-c user.name` / `-c user.email` **每次都给**：提交身份绝不依赖全局 git config ——
 * 那台机器上如果没配 `user.email`，`git commit` 会直接失败，而现场表现只是
 * 「自动提交没发生」，看不出是身份问题。
 */
const GIT_IDENTITY: readonly string[] = ['-c', 'user.name=dsh', '-c', 'user.email=dsh@local']

/**
 * 在某个目录里跑 git。
 * @param cwd - 工作目录。
 * @param args - git 的参数（不含 `git` 本身）。
 * @param timeoutMs - 执行期限。
 * @returns 结局。
 */
export function git(cwd: string, args: readonly string[], timeoutMs: number = COMMAND_TIMEOUT_MS): Promise<CommandOutcome> {
  return runCommand('git', ['-C', cwd, ...args], cwd, timeoutMs)
}

/**
 * 带提交身份的 git 调用（commit / merge 走这一条）。
 * @param cwd - 工作目录。
 * @param args - git 的参数。
 * @param timeoutMs - 执行期限。
 * @returns 结局。
 */
export function gitWithIdentity(cwd: string, args: readonly string[], timeoutMs: number = COMMAND_TIMEOUT_MS): Promise<CommandOutcome> {
  return runCommand('git', ['-C', cwd, ...GIT_IDENTITY, ...args], cwd, timeoutMs)
}

/**
 * 主检出根目录的**绝对**路径与它的 git 公共目录。
 *
 * 为什么需要一个显式的 \`repo\`：子会话的 cwd 是主检出，而主检出**可能就是**一个 worktree
 * （本任务自己的工作环境就是这样）—— 那时 \`--git-common-dir\` 指向的是共同的 git 目录，
 * 从它算出来的才是「所有 worktree 的公共上级」，而不是「再套一层」。
 */
export interface RepoLayout {
  /** 工作区的绝对路径（\`git rev-parse --show-toplevel\`）。 */
  readonly root: string
  /** git 公共目录的绝对路径（\`--git-common-dir\`）。 */
  readonly commonDir: string
}

/**
 * 读出一个工作区的形状。
 * @param cwd - 任意一个位于该仓库里的目录。
 * @returns 工作区根与 git 公共目录。
 * @throws 不是 git 仓库、或 git 读不出顶部目录时。
 */
export async function readRepoLayout(cwd: string): Promise<RepoLayout> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) {
    throw new Error('task worktree: ' + cwd + ' is not inside a git worktree (git rev-parse --show-toplevel failed: '
      + (top.failure ?? top.stderr.trim()) + ')')
  }
  const root = resolve(top.stdout.trim())
  const common = await git(root, ['rev-parse', '--absolute-git-dir'])
  return { root, commonDir: common.code === 0 ? resolve(common.stdout.trim()) : join(root, '.git') }
}

/**
 * 一条线装依赖的结局。
 *
 * `ok` 与 `ran` 是**两件事**：没跑（命令为空）与跑了通过不是一回事，
 * 而「跑了但失败」正是这条线**不许开工**的那一档。
 */
export interface PrepareOutcome {
  /** 装依赖的命令跑了、且通过。 */
  readonly ok: boolean
  /** 是否真的跑了（命令为空时没跑）。 */
  readonly ran: boolean
  /** 跑的命令。 */
  readonly command: string
  /** 真实输出（截断）。 */
  readonly output: string
}

/**
 * 起线**之后**把依赖装起来，并借此**断言这条线拿到的依赖集合与主线一致**。
 *
 * 为什么这件事非做不可、而且不能只看「装成功了没有」：实测踩过一次 ——
 * 主检出里有一个 `packages/dsh-prompt-plan` **junction** 被误提交进了版本库，
 * 在主线它被解析成同一个包（无害），进 worktree 却被 git 固化成**真实的重复目录**，
 * 于是 pnpm 看到 11 个工作区项目、而锁文件只有 10 个 importer ——
 * `--frozen-lockfile` 当场失败。**一个在主线完全无害的东西，进了 worktree 就变成炸弹。**
 *
 * 所以默认命令是 `pnpm install --frozen-lockfile`，而且**绝不静默降级**成
 * `--no-frozen-lockfile`：那会装上与主线不同的版本，
 * 「合回验证通过、上了主线才炸」正是这套流程要防的事。
 *
 * 失败时**返回而不抛**：由调用方决定怎么报（起线已经成功，那条线还在盘上）。
 * @param path - 检出路径。
 * @param command - 装依赖的命令；空串表示不装（跳过，`ran` 为 false）。
 * @returns 结局。
 */
export async function prepareWorktree(path: string, command: string): Promise<PrepareOutcome> {
  const line = command.trim()
  if (line === '') return { ok: true, ran: false, command: '', output: '' }
  const outcome = await runShellLine(line, path, VERIFY_TIMEOUT_MS)
  return {
    ok: outcome.failure === undefined && outcome.code === 0,
    ran: true,
    command: line,
    output: tail(trimmedOutput(outcome), OUTPUT_MAX),
  }
}

/**
 * 主检出与这条线之间，**同名路径的类型**对不对得上。
 *
 * 判据只有一条：主检出里是 **symlink/junction** 的东西，在 worktree 里也必须还是 symlink ——
 * 被 git 固化成真目录就是那次事故的形状（误提交的 junction 在检出里长成了真副本）。
 * 只查**被跟踪的顶层目录**，不做全树遍历：这是「有没有那类固化」的判据，不是完整性校验。
 * @param repo - 主检出。
 * @param path - 这条线的检出。
 * @returns 被固化的路径（相对仓库根）；一个都没有时是空数组。
 */
export async function findMaterializedLinks(repo: string, path: string): Promise<readonly string[]> {
  const tracked = await git(repo, ['ls-files', '-s', '--', 'packages', 'apps'])
  if (tracked.code !== 0) return []
  const materialized: string[] = []
  const seen = new Set<string>()
  for (const line of lines(tracked.stdout)) {
    const file = line.split('\t').pop() ?? ''
    const parts = file.split('/')
    if (parts.length < 2) continue
    const top = parts[0] + '/' + parts[1]
    if (seen.has(top)) continue
    seen.add(top)
    const source = await lstatKind(join(repo, top.split('/').join(sep)))
    const copy = await lstatKind(join(path, top.split('/').join(sep)))
    // 主检出是链接、检出里却是真目录（或反过来）—— 两种都算被固化/被改写。
    if (source === 'link' && copy === 'dir') materialized.push(top)
  }
  return materialized
}

/** 一个路径是文件、目录、链接还是没有；**不跟随链接**。 */
async function lstatKind(target: string): Promise<'link' | 'dir' | 'file' | 'none'> {
  try {
    const info = await lstat(target)
    if (info.isSymbolicLink()) return 'link'
    return info.isDirectory() ? 'dir' : 'file'
  } catch {
    return 'none'
  }
}

/**
 * 这条线用的检出路径：父目录下 `<主检出目录名>-wt-<线名>`。
 *
 * 放在**同级**而不是检出里面，理由有两条：检出里的任何东西都会被那条线自己的
 * \`git add -A\` 扫进去；而嵌套 worktree 在 Windows 上还会惹出一串路径长度问题。
 * @param repo - 主检出的绝对路径。
 * @param name - 线名。
 * @returns 检出绝对路径。
 */
export function worktreePathFor(repo: string, name: string): string {
  const root = resolve(repo)
  return join(dirname(root), basename(root) + '-wt-' + name)
}

/**
 * 这条线用的分支名。
 * @param name - 线名。
 * @returns \`wt/<名>\`。
 */
export function worktreeBranchFor(name: string): string {
  return 'wt/' + name
}

/**
 * 线名必须是一个**能做目录名与分支名**的东西。
 *
 * fail-closed：宁可当场拒掉，也不许一个带空格或 \`..\` 的名字拼出路径来 ——
 * 那正是「计算出来的路径」最容易出事的地方。
 */
const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * 校验线名。
 * @param name - 调用方给的名字。
 * @throws 名字不合法时。
 */
export function assertWorktreeName(name: string): void {
  if (!NAME_SHAPE.test(name)) {
    throw new Error('task: invalid worktree name "' + name
      + '" — use letters, digits, dot, dash or underscore, starting with a letter or digit (it becomes both a directory name and a branch name)')
  }
}

/**
 * 主检出**干净**才能起隔离线。
 *
 * 为什么：\`git worktree add\` 从**已提交状态**分叉，主检出里那些在飞的改动不会跟着过去；
 * 而它们**可能就是别人正在写的另一条线**。脏着起线会让两条线互相看不见对方的改动，
 * 于是「谁覆盖了谁」无从追溯。所以这里不是提示，是拒绝。
 *
 * 唯一被容忍的是**未跟踪的忽略项**：\`git status --porcelain\` 默认不列被 \`.gitignore\`
 * 盖住的东西（\`node_modules/\`、\`lib/\` 都在里面），所以这条检查对构建产物天然无感。
 * 未跟踪但**没被忽略**的文件（比如一份还没 \`git add\` 的新源码）算脏 —— 它确实是一条线的在飞改动。
 * @param repo - 主检出路径。
 * @returns 当刻的 porcelain 原文（空串表示干净）。
 * @throws 检查本身失败（那也是个明确的结局，不许当成「干净」）。
 */
export async function statusPorcelain(repo: string): Promise<string> {
  const status = await git(repo, ['-c', 'core.quotePath=false', 'status', '--porcelain'])
  if (status.failure !== undefined || status.code !== 0) {
    throw new Error('task worktree: could not read `git status --porcelain` of ' + repo + ' ('
      + (status.failure ?? status.stderr.trim()) + ') — refusing to act on a checkout I cannot verify')
  }
  return status.stdout
}

/** {@link createWorktree} 的入参。 */
export interface CreateWorktreeSpec {
  /** 主检出路径（仓库 root）。 */
  readonly repo: string
  /** 线名。 */
  readonly name: string
  /** 分叉点，省略即 \`HEAD\`。 */
  readonly base?: string
  /**
   * 中枢声明的**分支内机械**验证命令。省略即这一档没有 —— 提交仍可走判断档
   * （\`verifiedBy\`），但两档都没有时 \`task commit\` 会明确拒绝。
   */
  readonly verify?: string
  /**
   * 中枢声明的**合回之后**的整套检查命令。省略即不能合回（fail-closed）。
   */
  readonly mergeVerify?: string
  /**
   * 中枢自己写的一段**线意图**（这条线在干什么、要改哪些文件）。
   *
   * 它进简报：子代理在别的检出里干活，看不见中枢那边发生过什么，
   * 一句话的意图能让「该不该动这个文件」这类判断有据可依。
   */
  readonly goal?: string
}

/** 起线的结局。 */
export interface CreatedWorktree {
  /** 检出绝对路径。 */
  readonly path: string
  /** 分支名。 */
  readonly branch: string
  /**
   * 实际用的分叉点，**已经解析成一个 commit hash**。
   *
   * 新建时是 {@link CreateWorktreeSpec.base} 解析出来的那个提交；**接回同名的既有分支**
   * 时是那条分支与主线的 merge-base —— 那正是合回与 `rev-list base..branch` 要的那个点。
   * 不留符号名（`HEAD`、分支名）的原因见下面 `rev-parse` 那一处的注释。
   */
  readonly base: string
  /**
   * 这条线是**接回**来的（分支早就在、检出没了），不是新建的。
   *
   * 判据只有「同名分支已存在」这一条，而它是「**同名 = 同一条线**」这句承诺的落点：
   * 检出被人手动删掉、或收线收了一半时，分支上已经提交的成果仍在，
   * 接回来才不丢；不接的话第二次同名会撞 `branch already exists` 而永远派不出去。
   */
  readonly reused: boolean
  /** 起线那一刻主检出的 porcelain 原文（写穿检测的基准）。 */
  readonly mainPorcelain: string
  /** 从主检出复制过去的那些被 gitignore 的文件。 */
  readonly copied: readonly string[]
  /** 没找到、因而没复制过去的那些（人看得见缺了什么）。 */
  readonly missing: readonly string[]
}

/**
 * 起一条隔离线。
 *
 * 四步，一步都不许省：
 *   1. 主检出必须**干净**（{@link statusPorcelain}），脏则拒绝并说明原因 ——
 *      绝不偷偷提交别人的在飞改动；
 *   2. \`git worktree add <repo>-wt-<名> -b wt/<名> <base>\`；
 *   3. 把被 gitignore、因而**不会随 worktree 出现**的那几个文件复制进去
 *      （\`pnpm-lock.yaml\`、\`pnpm-workspace.yaml\` 等），否则那条线连装依赖都做不了；
 *   4. 在返回里带上**主检出的快照**，供结算时做写穿检测。
 * @param spec - 起线参数。
 * @returns 起线结果。
 * @throws 脏检出、名字非法、\`git worktree add\` 失败时。
 */
export async function createWorktree(spec: CreateWorktreeSpec): Promise<CreatedWorktree> {
  assertWorktreeName(spec.name)
  const repo = resolve(spec.repo)
  const porcelain = await statusPorcelain(repo)
  if (porcelain.trim() !== '') {
    throw new Error('task worktree: the main checkout ' + repo + ' has uncommitted changes, so an isolated line would fork from a state that is not on disk:\n'
      + firstLines(porcelain, 10)
      + '\ncommit or stash them first — this refuses rather than sweeping someone else in-flight work into a commit')
  }
  const path = worktreePathFor(repo, spec.name)
  const branch = worktreeBranchFor(spec.name)
  const base = spec.base ?? 'HEAD'
  const added = await git(repo, ['worktree', 'add', path, '-b', branch, base])
  let reused = false
  let forked = base
  if (added.code !== 0) {
    // **同名 = 同一条线**：检出没了而分支还在时，不许把它当成「名字冲突」报掉了事 ——
    // 那会把分支上已有的成果变成一条再也接不回来的线，而且这个结局是**永久的**：
    // 之后每一次同名的派发都会撞同一个错。
    //
    // 接回之前先 `worktree prune`：检出目录被人手动删掉时，git 里那条注册还在，
    // 不清掉的话接回来的那条会以「已登记」失败。
    await git(repo, ['worktree', 'prune'])
    const branchExists = await git(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch])
    if (branchExists.code !== 0) {
      throw new Error('task worktree: `git worktree add ' + path + ' -b ' + branch + ' ' + base + '` failed (exit '
        + String(added.code) + '): ' + (added.failure ?? (added.stderr.trim() || added.stdout.trim())))
    }
    const attached = await git(repo, ['worktree', 'add', path, branch])
    if (attached.code !== 0) {
      throw new Error('task worktree: branch ' + branch + ' already exists but could not be checked out at ' + path + ': '
        + (attached.failure ?? (attached.stderr.trim() || attached.stdout.trim())))
    }
    // 分叉点取**这条分支与主线的 merge-base**，不是主线的 HEAD：主线可能已经往前走了
    // 好几个提交，把 HEAD 当分叉点会让合回时的 `base..branch` 少算（或算错）一批提交。
    const fork = await git(repo, ['merge-base', branch, base])
    forked = fork.code === 0 && fork.stdout.trim() !== '' ? fork.stdout.trim() : base
    reused = true
  }
  // **把分叉点定成一个 commit hash**，不留符号名。理由很硬：这个值会跟着账本走，
  // 而它在两个**不同的检出**里被用 —— `finalizeReport` 在线的检出里跑（那里的 HEAD 是
  // 线的 HEAD），`mergeWorktree` 在主检出里跑（那里的 HEAD 是主线的）。存一个 `HEAD`
  // 下去，同一个字符串在两处指的不是同一个提交，`base..HEAD` 会静默算成空集。
  const resolved = await git(repo, ['rev-parse', '--verify', '--quiet', forked + '^{commit}'])
  const point = resolved.code === 0 && resolved.stdout.trim() !== '' ? resolved.stdout.trim() : forked
  const copied = await copyIgnoredFiles(repo, path)
  return { path, branch, base: point, reused, mainPorcelain: porcelain, copied: copied.copied, missing: copied.missing }
}

/**
 * 这个路径**还是不是**那条线：检出在、根目录对得上、HEAD 正落在预期的分支上。
 *
 * 三个判据缺一不可：只看目录在不在的话，一个被换成别的东西的同名目录（或另一条线的检出）
 * 会被当成「这条线还在」，于是孩子被派到一个**不是它该去的地方**。
 * @param path - 这条线的检出路径。
 * @param branch - 这条线的分支名。
 * @returns 三条都成立为 true。
 */
export async function worktreeMatches(path: string, branch: string): Promise<boolean> {
  const top = await git(path, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0 || top.stdout.trim() === '') return false
  if (!samePath(resolve(top.stdout.trim()), resolve(path))) return false
  const head = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return head.code === 0 && head.stdout.trim() === branch
}

/**
 * 两个路径是不是同一个地方。
 *
 * Windows 上大小写不敏感（盘符大小写、目录名大小写都可能与 git 输出的不一样），
 * 逐字比较会把「同一条线」误判成「不是这条线」，于是白白重建一次检出。
 * @param left - 一个绝对路径。
 * @param right - 另一个绝对路径。
 * @returns 同一个地方为 true。
 */
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * 被 gitignore 盖住、但那条线真的需要的那几个文件。
 *
 * 只**点名列**这几个：镜像一整个 \`.gitignore\` 意味着把 \`node_modules/\`、\`lib/\` 也一起复制，
 * 那是几百兆的无用功；而这几份是「工作区能不能装起来」的前提。
 */
export const COPIED_FILES: readonly string[] = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']

/**
 * 把上面那几个文件从主检出复制过去；没找到的如实列出来（不是错误，是信息）。
 * @param repo - 主检出。
 * @param path - 新检出。
 * @returns 复制成功与缺席的两张清单。
 */
async function copyIgnoredFiles(repo: string, path: string): Promise<{ copied: readonly string[]; missing: readonly string[] }> {
  const copied: string[] = []
  const missing: string[] = []
  for (const relative of COPIED_FILES) {
    try {
      await copyFile(join(repo, relative.split('/').join(sep)), join(path, relative.split('/').join(sep)))
      copied.push(relative)
    } catch {
      missing.push(relative)
    }
  }
  return { copied, missing }
}

/**
 * 简报**开头**的那一段隔离前言。
 *
 * 它是**代码里的常量**，不是让中枢手写的一句话：中枢每派一条隔离线都要重新写一遍
 * 「别碰主检出」，写漏一次那条线就跑在主检出上，而原因只是「忘了一句话」。
 *
 * 顺序也是刻意的：绝对路径在前（它要照着抄），纪律在后，最后才是「收工前不要自己合并」——
 * 合并由中枢决定，子代理自己合回会让写穿检测失去意义。
 * 线名也在里面，而且是**逐字给出**的：同一个仓里可能同时有好几条在飞的线，
 * `task commit` 要靠它点名自己那条，让子代理去猜名字是最没必要的一种失败。
 * @param spec - 这条线的名字、路径、分支与主检出路径。
 * @returns 前言文本。
 */
export function isolationPreamble(spec: { readonly name: string; readonly path: string; readonly branch: string; readonly repo: string }): string {
  return '【隔离检出（重要）】你在一个**独立检出**里干活，不是主检出：\n'
    + '- 线名：`' + spec.name + '`（提交时写 `task commit line=' + spec.name + ' …`）\n'
    + '- 检出（你的工作目录）：`' + spec.path + '`\n'
    + '- 分支：`' + spec.branch + '`（从主检出的已提交状态分叉；收工前**不要**自己合并、不要 push）\n'
    + '- **禁止碰主检出 `' + spec.repo + '`**：不要 cd 过去、不要在那里读写任何文件、不要在那里跑 git 写操作。\n'
    + '- 本次会话的 cwd 仍然是主检出 —— 插件改不了它。所以**每一处路径都写全**，用上面那个检出开头的绝对路径，不要用相对路径。\n'
    + '- 每做完一批改动就调一次 `task commit`（见下），不要攒到最后；收工前不要自己 `git add` / `git commit`，全部走 `task commit`。'
}

/**
 * 简报里接在隔离前言**之后**的那一段：这条线的工作方式。
 * @param name - 这条线的名字（提交时要点名它）。
 * @param verify - 中枢声明的分支内验证命令；省略即这条线没有。
 * @param mergeVerify - 中枢声明的合回后整套检查；只在有它时才提一句。
 * @returns 说明文本。
 */
export function worktreeWorkflowNote(name: string, verify?: string, mergeVerify?: string): string {
  return '【收工方式】**每做完一批改动就调一次 `task commit`，不要攒到最后。**\n'
    + '- 用法：`task commit line=' + name + ' node=<你的节点 id> units=<单元1>,<单元2>`（一个提交可以汇总**多个**工作单元，粒度自己判断）。\n'
    + '- 提交前它会跑**中枢声明**的机械验证命令'
    + (verify === undefined ? '（这条线**没有**声明机械验证命令）' : '：`' + verify + '`')
    + '，把退出码与输出摘要**记进提交信息**；你也可以用 `extraCheck=` **追加**检查，但不能省略它。\n'
    + '- 判断档同样作数：有些改动的质量没法用一个命令判定，那就用 `verifiedBy=<中枢或验证代理的会话 id> note=<依据>` 说明这次是靠检查确认的。两档可以并存。\n'
    + '- **机械验证没过不会自动拦住你**（默认 `onFail: record`，如实把它记进提交信息）；要拦就显式 `onFail: block`。\n'
    + '- 收工时**没验证过**的改动一律不提交：不要偷偷 `git add -A` 把它们封进历史，如实说明它们是什么。\n'
    + '- 收工时若有未提交的改动，如实说明它们是什么、为什么没提交。\n'
    + '- **不要自己合回主线、不要 push**：合回与合并后的整体验证由中枢发起（'
    + (mergeVerify === undefined ? '这条线还没声明整体检查命令' : '整体检查：`' + mergeVerify + '`')
    + '）。'
}

/** `task commit` 的**工作单元**：一个提交可以汇总多个 —— 粒度由判断决定，不是 1:1。 */
export interface WorkUnit {
  /** 单元名（一句话说清这个单元干了什么）。 */
  readonly name: string
  /** 这个单元落在哪些路径上；可选，只是记录。 */
  readonly paths?: readonly string[]
}

/**
 * 机械验证的结局：命令跑了、退出码是什么、输出摘要是什么。
 *
 * 它**被记进提交信息**，所以事后 `git log` 就能看出「这次提交是怎么被验证的」。
 */
export interface MachineCheck {
  /** 跑的命令。 */
  readonly command: string
  /** 退出码；命令没跑起来时为 -1。 */
  readonly code: number
  /** 命令跑起来了没有。 */
  readonly ran: boolean
  /** 通过的判据只有一个：真的跑起来了、且退出码是 0。 */
  readonly passed: boolean
  /** 输出摘要（截断，单行化后放进提交信息）。 */
  readonly summary: string
  /** 完整输出（截断），只回给调用方。 */
  readonly output: string
}

/** 验证成不成立的那一档：机械、判断，或者两档都有。 */
export type VerificationKind = 'machine' | 'judgement' | 'both' | 'none'

/** {@link commitFeature} 的入参。 */
export interface CommitFeatureSpec {
  /** 线名（只用于提示语）。 */
  readonly name: string
  /** 检出路径。 */
  readonly path: string
  /** 落进提交信息的节点 id。 */
  readonly node: string
  /** **中枢在派发时声明**的机械验证命令；省略即这一档没有。 */
  readonly verify?: string
  /** 验证命令的工作目录（相对检出根）；省略即在检出根跑。 */
  readonly verifyCwd?: string
  /** 子代理追加的机械检查（一整行命令）；可选，**只加不减**。 */
  readonly extraCheck?: string
  /** 这次提交汇总的**工作单元**（一个或多个）。 */
  readonly units: readonly WorkUnit[]
  /**
   * 判断档的验证者：中枢，或某个验证代理的会话 id。
   *
   * **判断档与机械档同等作数**：有些改动的质量就是没法用一个命令判定。
   */
  readonly verifiedBy?: string
  /** 判断档的依据（一句话）。与 {@link verifiedBy} 一起出现才有意义。 */
  readonly note?: string
  /**
   * 机械验证**未通过**时怎么办：
   *   - \`record\`（默认）：照样提交，把「未通过」如实写进信息与返回值；
   *   - \`block\`：一个字节都不提交，把真实输出交回去。
   * 默认取 \`record\`：本动作是**记录员不是守门员**，门禁在中枢手里（它可以要求 amend / reset）。
   */
  readonly onFail?: 'record' | 'block'
}

/** 一次提交的结局。 */
export interface CommitOutcome {
  /** 提交真的发生时为 true。 */
  readonly committed: boolean
  /** 人读的一段说明（工具返回值里原样给出）。 */
  readonly note: string
  /** 真的提交了时的短 hash。 */
  readonly hash?: string
  /** 这条线相对基线的改动文件数（已提交 + 未提交）。 */
  readonly files?: number
  /** 工作区里还有多少文件没提交。 */
  readonly uncommitted?: number
  /** 这次提交是怎么被验证的。 */
  readonly verification: VerificationKind
  /** 机械验证的命令与退出码（没跑机械档时缺席）。 */
  readonly machine?: MachineCheck4Json
  /** 机械验证没过、或整体没通过时，命令的真实输出（截断）。 */
  readonly output?: string
}

/** 机械验证里可以进**无损 JSON** 的那几个字段（`output` 是给人读的，不进工具返回值）。 */
export interface MachineCheck4Json {
  /** 跑的命令。 */
  readonly command: string
  /** 退出码。 */
  readonly code: number
  /** 通过与否。 */
  readonly passed: boolean
  /** 输出摘要。 */
  readonly summary: string
}

/**
 * 提交一个（或多个）工作单元。**这是记录员，不是守门员。**
 *
 * 它做两件事：**真的提交**，以及**如实记录这次提交是怎么被验证的** ——
 * 机械档（命令真跑，退出码与输出摘要进提交信息）与判断档（`verifiedBy` + `note`）
 * 都作数，可以只有其一。判不判得过由**中枢**复核（它可以要求重做、amend、reset），
 * 门禁不在这个插件里。
 *
 * 四条仍然要守的口径：
 *   - 工作区与已提交状态**无差异** ⇒ 不造空提交；
 *   - 中枢声明的机械验证命令**真跑**，结果如实记录；未通过时按 {@link CommitFeatureSpec.onFail} 决定；
 *   - 机械档与判断档**都没有** ⇒ 明确拒绝提交（那是「没人验证过」，不是「用判断验证过」）；
 *   - 提交身份由 {@link GIT_IDENTITY} 钉住，不依赖全局 git config。
 * @param spec - 提交参数。
 * @returns 结局。
 */
export async function commitFeature(spec: CommitFeatureSpec): Promise<CommitOutcome> {
  const units = spec.units.filter(unit => unit.name.trim() !== '')
  const judged = spec.verifiedBy !== undefined && spec.verifiedBy.trim() !== ''
  const machineCommand = spec.verify !== undefined && spec.verify.trim() !== '' ? spec.verify : undefined
  // 一档验证都没有 ⇒ 拒绝。**注意这里判的是「没人验证过」，不是「机械验证没过」** ——
  // 后者走 onFail，两回事。
  if (!judged && machineCommand === undefined) {
    return {
      committed: false,
      verification: 'none',
      note: 'task commit: 这次提交没有任何一档验证 —— 既没有中枢声明的机械验证命令，也没有 `verifiedBy` 记下的判断档。请中枢在派发时声明 `verify: "<命令>"`，或用 `verifiedBy: <中枢|验证代理会话 id> note: "<依据>"` 说明它是靠判断确认的。',
    }
  }
  if (units.length === 0) {
    return { committed: false, verification: 'none', note: 'task commit: `units` 为空 —— 提交要先说清它汇总了哪些工作单元（`units: <单元1>,<单元2>`）。' }
  }
  // ① 有没有东西可提。**先看有没有改动**：空改动时连验证都不必跑，
  // 更不许造一个空提交（那会把「这条线干了什么」这句话变假）。
  const porcelain = await git(spec.path, ['status', '--porcelain'])
  if (porcelain.code !== 0) {
    return { committed: false, verification: 'none', note: 'task commit: could not read `git status --porcelain` in ' + spec.path + ': ' + (porcelain.failure ?? porcelain.stderr.trim()) }
  }
  if (porcelain.stdout.trim() === '') {
    return { committed: false, verification: 'none', note: 'task commit: 无改动 — the isolated line has no changes against its committed state; nothing to verify and nothing to commit.', files: 0, uncommitted: 0 }
  }
  const dirty = countPorcelain(porcelain.stdout)
  // ② 机械档：中枢声明的命令**真跑**，退出码与输出摘要如实记下来。
  let machine: MachineCheck | undefined
  if (machineCommand !== undefined || (spec.extraCheck !== undefined && spec.extraCheck.trim() !== '')) {
    const command = machineCommand ?? (spec.extraCheck as string)
    const cwd = spec.verifyCwd === undefined || spec.verifyCwd.trim() === '' ? spec.path : resolve(spec.path, spec.verifyCwd)
    const ran = await runShellLine(command, cwd)
    machine = {
      command,
      code: ran.failure === undefined ? ran.code : -1,
      ran: ran.failure === undefined,
      passed: ran.failure === undefined && ran.code === 0,
      summary: summarize(trimmedOutput(ran)),
      output: tail(trimmedOutput(ran), OUTPUT_MAX),
    }
    // 追加检查也跑，但**只加不减**：任何一条没过都算机械档没过。
    if (machine.passed && spec.extraCheck !== undefined && spec.extraCheck.trim() !== '' && spec.extraCheck !== command) {
      const extra = await runShellLine(spec.extraCheck, cwd)
      if (extra.failure !== undefined || extra.code !== 0) {
        machine = {
          command: spec.extraCheck,
          code: extra.failure === undefined ? extra.code : -1,
          ran: extra.failure === undefined,
          passed: false,
          summary: summarize(trimmedOutput(extra)),
          output: tail(trimmedOutput(extra), OUTPUT_MAX),
        }
      }
    }
  }
  const verification: VerificationKind = machine === undefined ? 'judgement' : (judged ? 'both' : 'machine')
  // ③ 机械档没过时要不要拦，由调用方定。默认 `record`：本动作是记录员不是守门员。
  const onFail = spec.onFail ?? 'record'
  if (machine !== undefined && !machine.passed && onFail === 'block') {
    return {
      committed: false,
      verification,
      note: 'task commit: 机械验证未通过（`' + machine.command + '` 退出码 ' + String(machine.code) + '），按 `onFail: block` **未提交任何改动**；未验证的改动留在工作区。',
      output: machine.output,
      machine: toJson(machine),
      files: dirty,
      uncommitted: dirty,
    }
  }
  // ④ 提交。提交信息里**必须看得出这次是怎么被验证的**。
  const message = commitMessage(spec.node, units, machine, spec.verifiedBy, spec.note)
  const added = await git(spec.path, ['add', '-A'])
  if (added.code !== 0) {
    return { committed: false, verification, note: 'task commit: `git add -A` failed: ' + (added.failure ?? added.stderr.trim()), ...machine === undefined ? {} : { machine: toJson(machine) } }
  }
  const committed = await gitWithIdentity(spec.path, ['commit', '--no-verify', '-m', message])
  if (committed.code !== 0) {
    return { committed: false, verification, note: 'task commit: `git commit` failed: ' + (committed.failure ?? (committed.stderr.trim() || committed.stdout.trim())), ...machine === undefined ? {} : { machine: toJson(machine) } }
  }
  const hash = await git(spec.path, ['rev-parse', '--short', 'HEAD'])
  const failed = machine !== undefined && !machine.passed
  return {
    committed: true,
    verification,
    note: 'task commit: 已提交 ' + String(units.length) + ' 个工作单元（' + verificationNote(verification, machine, failed, spec.verifiedBy) + '）',
    hash: hash.code === 0 ? hash.stdout.trim() : '',
    files: dirty,
    uncommitted: 0,
    ...machine === undefined ? {} : { machine: toJson(machine) },
    // 机械档没过却仍提交（`onFail: record`）：真实输出照样交回去，让人看得见为什么没过。
    ...failed && machine !== undefined ? { output: machine.output } : {},
  }
}

/**
 * 提交信息的正文：单元清单 + **这次是怎么被验证的**。
 *
 * 目的很具体：事后 `git log` 一眼就能判断这次提交值不值得信 ——
 * `verify: <命令> (exit 0)` / `verify: <命令> (exit 3, NOT passed)` / `verified by: hub — <依据>`。
 * @param node - 节点 id。
 * @param units - 工作单元。
 * @param machine - 机械验证结局。
 * @param verifiedBy - 判断档的验证者。
 * @param note - 判断档的依据。
 * @returns 提交信息（多行）。
 */
export function commitMessage(node: string, units: readonly WorkUnit[], machine: MachineCheck | undefined, verifiedBy?: string, note?: string): string {
  const head = node + ': ' + units.map(unit => unit.name).join(' + ')
  const body: string[] = ['', 'units:']
  for (const unit of units) {
    body.push('- ' + unit.name + (unit.paths === undefined || unit.paths.length === 0 ? '' : ' [' + unit.paths.join(', ') + ']'))
  }
  body.push('', 'verification:')
  if (machine !== undefined) {
    body.push('- verify: ' + JSON.stringify(machine.command) + ' (exit ' + String(machine.code) + (machine.passed ? ', passed' : ', NOT passed') + ')')
    if (machine.summary !== '') body.push('  ' + machine.summary)
  }
  if (verifiedBy !== undefined && verifiedBy.trim() !== '') {
    body.push('- verified by: ' + verifiedBy.trim() + (note === undefined || note.trim() === '' ? '' : ' — ' + singleLineText(note)))
  }
  if (machine === undefined && (verifiedBy === undefined || verifiedBy.trim() === '')) body.push('- (none)')
  return [head, ...body].join('\n')
}

/** 一句话说清这次提交的验证档位。 */
function verificationNote(kind: VerificationKind, machine: MachineCheck | undefined, failed: boolean, verifiedBy?: string): string {
  const parts: string[] = []
  if (machine !== undefined) parts.push('机械验证 ' + JSON.stringify(machine.command) + (failed ? ' **未通过**（已如实记入提交信息）' : ' 退出 0'))
  if (kind === 'judgement' || kind === 'both') parts.push('判断档：' + String(verifiedBy))
  return parts.length === 0 ? '无验证记录' : parts.join('；')
}

/** 机械档的产物里能进无损 JSON 的那几个字段。 */
function toJson(machine: MachineCheck): MachineCheck4Json {
  return { command: machine.command, code: machine.code, passed: machine.passed, summary: machine.summary }
}

/** 把命令输出压成**一行**、截短，供提交信息与返回值使用。 */
function summarize(text: string): string {
  return truncateText(singleLineText(text), 160)
}

/** 换行与连续空白折叠成一个空格。 */
function singleLineText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** 截到上限（超出时末位换成省略号）。 */
function truncateText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…'
}

/** 收工时的收尾报告。 */
export interface FinalizeReport {
  /** 人读的一段说明。 */
  readonly note: string
  /** 相对基线改动的文件数（已提交 + 未提交）。 */
  readonly files: number
  /** 还留在工作区、**没有**被提交的文件数。 */
  readonly uncommitted: number
  /** 这条线上已经产生的提交数。 */
  readonly commits: number
  /** 最近一次提交的短 hash；一个提交都没有时是 undefined。 */
  readonly hash?: string
}

/**
 * 结算时对一条隔离线做的收尾报告。
 *
 * **它不提交任何东西** —— 这正是用户纠正过的那一条：收工还剩未提交的改动，说明那些改动
 * **没被验证过**，把它们封进历史是要避免的事。这里只如实数出来：改了几个文件、
 * 还有几个没提交、这条线有几个提交。
 * @param path - 检出路径。
 * @param base - 分叉点。
 * @returns 报告；读不出 git 状态时如实说读不出。
 */
export async function finalizeReport(path: string, base: string): Promise<FinalizeReport> {
  const porcelain = await git(path, ['status', '--porcelain'])
  if (porcelain.code !== 0) {
    return { note: 'worktree 状态读不到：' + (porcelain.failure ?? porcelain.stderr.trim()), files: 0, uncommitted: 0, commits: 0 }
  }
  const uncommitted = countPorcelain(porcelain.stdout)
  const againstBase = await git(path, ['diff', '--name-only', base])
  const files = againstBase.code === 0 ? countLines(againstBase.stdout) : uncommitted
  const count = await git(path, ['rev-list', '--count', base + '..HEAD'])
  const commits = count.code === 0 ? Number.parseInt(count.stdout.trim(), 10) || 0 : 0
  const head = await git(path, ['rev-parse', '--short', 'HEAD'])
  return {
    note: commits === 0 && uncommitted === 0
      ? '无改动：这条线相对基线没有任何改动，没有造空提交。'
      : '共 ' + String(files) + ' 个文件改动，'
        + (commits === 0 ? '0 个提交 —— 没有任何一个功能单元通过验证。' : String(commits) + ' 个提交')
        + (uncommitted === 0 ? '' : '；' + String(uncommitted) + ' 个文件是**未验证的改动**，未提交（留在工作区）。'),
    files,
    uncommitted,
    commits,
    ...commits === 0 || head.code !== 0 ? {} : { hash: head.stdout.trim() },
  }
}

/**
 * 主检出有没有被这条线写穿。
 *
 * 判据只有一条：起线时拍下的 porcelain 原文与当刻的原文**逐字相同**就是没动。
 * 只做字符比较，不做语义比较 —— 这一层是**检测**，报的是「此处发生了变化」这个事实，
 * 判断「这算不算事故」交给看到报警的中枢。
 * @param repo - 主检出路径。
 * @param before - 起线那一刻的 porcelain 原文。
 * @returns 没被写穿时 `{ leaked: false }`；被写穿时为 true 加上被人动的路径。
 */
export async function detectLeak(repo: string, before: string): Promise<{ readonly leaked: boolean; readonly paths: readonly string[]; readonly detail?: string }> {
  // 与 {@link statusPorcelain} 用**同一套参数**：两份原文要能逐字对上，
  // 参数不同（比如一边把非 ASCII 路径转义、一边不转）会造出假的「写穿」。
  const now = await git(repo, ['-c', 'core.quotePath=false', 'status', '--porcelain'])
  if (now.code !== 0) {
    return { leaked: false, paths: [], detail: '主检出的 `git status` 读不到（' + (now.failure ?? now.stderr.trim()) + '），写穿检测**没做成**' }
  }
  if (now.stdout === before) return { leaked: false, paths: [] }
  return { leaked: true, paths: changedPaths(before, now.stdout) }
}

/**
 * 两份 porcelain 之间**新增或变了**的那些路径。
 *
 * 特意不去解析 git 的状态字母：这一层要回答的是「哪几个文件被动了」，
 * 而那正是两份原文里对不上的行 —— 逐行做差集就够了，差集不依赖任何解析规则。
 * **不能先 trim 再切**：porcelain 的一行是 `XY <路径>`，未暂存的改动那一行
 * **以空格开头**（` M a.txt`），先 trim 就把状态位吃掉一位，切出来的路径会少掉开头
 * 那个字符（实测踩过：`README.md` 变成 `EADME.md`）。
 * @param before - 起线时的原文。
 * @param after - 当刻的原文。
 * @returns 变化了的路径（去重、保序）。
 */
export function changedPaths(before: string, after: string): readonly string[] {
  const was = new Set(rawLines(before))
  const paths: string[] = []
  for (const line of rawLines(after)) {
    if (was.has(line)) continue
    // porcelain 的一行：`XY <路径>`（改名时是 `XY <旧> -> <新>`）。
    // 只取路径那一段：前三个字符是状态与空格。
    const path = line.slice(Math.min(3, line.length)).trim()
    const shown = path.includes(' -> ') ? path.split(' -> ').pop() ?? path : path
    if (shown !== '' && !paths.includes(shown)) paths.push(shown)
  }
  return paths
}

/** {@link mergeWorktree} 的入参。 */
export interface MergeWorktreeSpec {
  /** 线名。 */
  readonly name: string
  /** 主检出路径。 */
  readonly repo: string
  /** 这条线的检出路径。 */
  readonly path: string
  /** 这条线的分支名。 */
  readonly branch: string
  /** 这条线的分叉点（主线要落在这个状态之上）。 */
  readonly base: string
  /** 合回后要跑的**整套**检查命令。省略即拒绝合回。 */
  readonly verify?: string
  /**
   * 主线起点跑的那条命令，用来把工作区装起来。
   * 省略即默认 \`pnpm install --frozen-lockfile\`；给空串表示「不装」。
   */
  readonly prepare?: string
  /** 落进整合提交信息里的一句话（通常是中枢、这条线在做什么）。 */
  readonly title?: string
}

/** 合回与统一提交的结局。 */
export interface MergeOutcome {
  /** 这条线已经合回、且统一提交已经落在主线上。 */
  readonly merged: boolean
  /** 人读的一段说明。 */
  readonly note: string
  /** 主线上的最终 commit hash（成功时）。 */
  readonly hash?: string
  /** 被汇总进去的功能单元（分支上那串提交的标题，最新的在前）。 */
  readonly features?: readonly string[]
  /** 验证没通过时，命令的真实输出（截断）。 */
  readonly output?: string
  /** 已经清掉的集成 worktree 路径。 */
  readonly integration?: string
}

/**
 * 把一条线合回主线，跑**合并之后**的整体验证，通过才统一提交。
 *
 * 落点选的是**临时集成 worktree**，不是主检出。三条理由，一条比一条硬：
 *   1. 整体验证（整套测试）会在检出里留下产物与缓存；在主检出跑就等于把垃圾留在主线上；
 *   2. 失败时主线必须**一个字节都没动** —— 在集成 worktree 里做，这件事天然成立；
 *   3. 主线自己可能也在忙（另一条线正从它分叉），碰它就等于把两条线搅在一起。
 *
 * 七步：
 *   1. 主检出必须干净（同样的拒绝语义）；
 *   2. \`git worktree add --detach <临时路径> <base>\`；
 *   3. 把 gitignore 的那几个文件复制进去；
 *   4. 装依赖（{@link MergeWorktreeSpec.prepare}，默认 \`pnpm install --frozen-lockfile\`）；
 *   5. \`git merge --squash <分支>\` + \`git commit\` —— **一个**整合提交，信息汇总各功能单元；
 *   6. 在集成 worktree 里跑**整套**检查；
 *   7. 通过 ⇒ 主线快进/合并到那个集成提交（主线原子地前进一次）；
 *      不通过 ⇒ 删掉临时 worktree，**主线一个字节不动**，把真实输出交回去。
 * @param spec - 合回参数。
 * @returns 结局。
 */
export async function mergeWorktree(spec: MergeWorktreeSpec): Promise<MergeOutcome> {
  if (spec.verify === undefined || spec.verify.trim() === '') {
    return {
      merged: false,
      note: 'task worktree merge: this line declares no whole-suite check, so nothing could be verified after the merge. Declare it at dispatch time (`task dispatch worktree: ' + spec.name
        + ' mergeVerify: "<command>"`) — refusing to put unverified work on the main line.',
    }
  }
  const repo = resolve(spec.repo)
  const porcelain = await statusPorcelain(repo)
  if (porcelain.trim() !== '') {
    return { merged: false, note: 'task worktree merge: the main checkout ' + repo + ' has uncommitted changes, so the merge has no single state to land on:\n' + firstLines(porcelain, 10) }
  }
  // 这条线在不在，分支上有没有东西 —— 校验在前，绝不先动主线再发现没事可做。
  const exists = await git(repo, ['rev-parse', '--verify', '--quiet', spec.branch])
  if (exists.code !== 0) {
    return { merged: false, note: 'task worktree merge: branch ' + spec.branch + ' does not exist in ' + repo }
  }
  const commits = await git(repo, ['rev-list', '--count', spec.base + '..' + spec.branch])
  if (commits.code === 0 && (Number.parseInt(commits.stdout.trim(), 10) || 0) === 0) {
    return { merged: false, note: 'task worktree merge: 无改动 — ' + spec.branch + ' has no commits against ' + spec.base + '; nothing to merge and no empty commit is made.' }
  }
  const integration = worktreePathFor(repo, spec.name + '-merge')
  const added = await git(repo, ['worktree', 'add', '--detach', integration, spec.base])
  if (added.code !== 0) {
    return { merged: false, note: 'task worktree merge: could not create the integration worktree at ' + integration + ': ' + (added.failure ?? added.stderr.trim()) }
  }
  // 从这里起：任何一条出口都必须自己清理那个临时 worktree（主线才不用管这类残留）。
  const cleanup = async (): Promise<void> => {
    await git(repo, ['worktree', 'remove', '--force', integration])
    await rm(integration, { recursive: true, force: true }).catch(() => undefined)
  }
  await copyIgnoredFiles(repo, integration)
  const prepare = spec.prepare === undefined ? 'pnpm install --frozen-lockfile' : spec.prepare.trim()
  if (prepare !== '') {
    const prepared = await runShellLine(prepare, integration, VERIFY_TIMEOUT_MS)
    if (prepared.failure !== undefined || prepared.code !== 0) {
      await cleanup()
      return {
        merged: false,
        note: 'task worktree merge: the integration worktree could not be prepared (`' + prepare + '` exit ' + String(prepared.code) + '); 主线一个字节都没动。',
        output: tail(trimmedOutput(prepared), OUTPUT_MAX),
      }
    }
  }
  // 分支上那串提交的标题：整合提交的信息就是它们的汇总（最新的在前）。
  const subjects = await git(repo, ['log', '--format=%s', '--reverse', spec.base + '..' + spec.branch])
  const features = subjects.code === 0 ? lines(subjects.stdout) : []
  const squash = await git(integration, ['merge', '--squash', spec.branch])
  if (squash.code !== 0) {
    await cleanup()
    return {
      merged: false,
      note: 'task worktree merge: `git merge --squash ' + spec.branch + '` hit a conflict; 主线一个字节都没动，分支保留。',
      output: tail(trimmedOutput(squash), OUTPUT_MAX),
    }
  }
  const message = mergeMessage(spec.name, spec.title, features)
  const committed = await gitWithIdentity(integration, ['commit', '--no-verify', '-m', message])
  if (committed.code !== 0) {
    await cleanup()
    return { merged: false, note: 'task worktree merge: the integration commit failed: ' + (committed.failure ?? (committed.stderr.trim() || committed.stdout.trim())), output: tail(trimmedOutput(committed), OUTPUT_MAX) }
  }
  // **合并之后的整体验证**：跑的是整套检查，不是单功能那条。
  const verified = await runShellLine(spec.verify, integration, VERIFY_TIMEOUT_MS)
  if (verified.failure !== undefined || verified.code !== 0) {
    await cleanup()
    return {
      merged: false,
      note: 'task worktree merge: **合回后的整体验证没过**，主线一个字节都没动，分支 ' + spec.branch + ' 保留。验证命令 `' + spec.verify + '` 退出码 '
        + (verified.failure === undefined ? String(verified.code) : 'N/A — 命令没跑起来') + '。',
      output: tail(trimmedOutput(verified), OUTPUT_MAX),
      features,
    }
  }
  // 通过 ⇒ 把主线推到那个整合提交。`-C <repo> merge --ff-only <集成 head>`：
  // 集成提交在集成 worktree 里已经造好，主线只需要原子地前进一次。
  const head = await git(integration, ['rev-parse', 'HEAD'])
  if (head.code !== 0) {
    await cleanup()
    return { merged: false, note: 'task worktree merge: the integration commit has no readable HEAD: ' + (head.failure ?? head.stderr.trim()) }
  }
  const fastForward = await git(repo, ['merge', '--ff-only', head.stdout.trim()])
  const hash = fastForward.code === 0 ? head.stdout.trim().slice(0, 12) : ''
  if (fastForward.code !== 0) {
    // 主线在集成期间前进了（另一条线合了进来）：**不改判、不强推**，如实报告。
    await cleanup()
    return {
      merged: false,
      note: 'task worktree merge: 整体验证通过，但主线在集成期间前进了，`--ff-only` 拒绝落下（主线保持原样，分支保留）。请把这条线重新走一次（它现在要基于新主线重建）。',
      output: tail(trimmedOutput(fastForward), OUTPUT_MAX),
      features,
    }
  }
  await cleanup()
  return {
    merged: true,
    note: 'task worktree merge: 已合回并统一提交到主线（' + String(features.length) + ' 个功能单元 → 1 个整合提交）。',
    hash,
    features,
    integration,
  }
}

/**
 * 整合提交的信息：抬头 + 汇总各功能单元 + 一句「这是从哪条线来的」。
 * @param name - 线名。
 * @param title - 中枢给的一句话。
 * @param features - 分支上那串提交的标题（按时间正序）。
 * @returns 提交信息。
 */
export function mergeMessage(name: string, title: string | undefined, features: readonly string[]): string {
  const head = title === undefined || title.trim() === '' ? 'merge ' + name : title.trim()
  const body = features.length === 0 ? [] : ['', 'Squashed from branch wt/' + name + ':', ...features.map(line => '- ' + line)]
  return [head, 'merged from wt/' + name + ' (verified after merge)', ...body].join('\n')
}

/** 收线的结局。 */
export interface DropOutcome {
  /** 这条线已经从在飞清单里消失。 */
  readonly dropped: boolean
  /** 人读的一段说明。 */
  readonly note: string
}

/**
 * 收一条线：删掉它的 worktree 与分支。
 *
 * **只在已经合回、或明确放弃时做。** 默认会先检查这条线有没有未合回的成果：
 * 分支上还有主线没有的提交、或检出里还有未提交的改动时，除非显式 \`force\`，否则拒绝 ——
 * 「删掉一个还有人没看到过改动的目录」是不可挽回的。
 * @param spec - 收线参数。
 * @returns 结局。
 */
export async function dropWorktree(spec: { readonly repo: string; readonly name: string; readonly path: string; readonly branch: string; readonly base: string; readonly force?: boolean }): Promise<DropOutcome> {
  const repo = resolve(spec.repo)
  if (spec.force !== true) {
    const unmerged = await git(repo, ['rev-list', '--count', 'HEAD..' + spec.branch])
    const dirty = await git(spec.path, ['status', '--porcelain'])
    const ahead = unmerged.code === 0 ? Number.parseInt(unmerged.stdout.trim(), 10) || 0 : 0
    const dirtyCount = dirty.code === 0 ? countPorcelain(dirty.stdout) : 0
    // 「合回过了没有」**不能**用 `rev-list HEAD..branch` 判：合回走的是 `merge --squash`，
    // 主线拿到的是一个**新造的**提交，分支上原来那两个提交于是永远不是它的祖先 ——
    // 只看提交图的话，合回之后收线**永远**要加 `force`，而那正是最该被守住的一次删除。
    // 所以判据换成**内容**：分支相对基线的每一个改动，主线 HEAD 里是不是已经有同一份内容。
    const alreadyIn = await contentOnMain(repo, spec.base, spec.branch)
    if (dirtyCount > 0 || (ahead > 0 && !alreadyIn)) {
      return {
        dropped: false,
        note: 'task worktree drop: 拒绝收线 —— ' + spec.branch + ' 上有 ' + String(dirtyCount) + ' 个未提交的改动'
          + (ahead > 0 && !alreadyIn ? '、且有 ' + String(ahead) + ' 个提交的内容还没进主线' : '')
          + '。先合回（`task worktree merge`），或明确放弃时加 `force: true`。',
      }
    }
  }
  const removed = await git(repo, ['worktree', 'remove', '--force', spec.path])
  if (removed.code !== 0) {
    const pruned = await git(repo, ['worktree', 'prune'])
    if (pruned.code !== 0) {
      return { dropped: false, note: 'task worktree drop: could not remove ' + spec.path + ': ' + (removed.failure ?? removed.stderr.trim()) }
    }
  }
  // 分支只在已经合回时才删得掉（`-d` 而不是 `-D`）：这是最后一道防手滑。
  const branch = await git(repo, ['branch', '-D', spec.branch])
  return {
    dropped: true,
    note: 'task worktree drop: 已收线 ' + spec.name + '（删掉 ' + spec.path + ' 与分支 ' + spec.branch + (branch.code === 0 ? '' : '；分支没删掉：' + (branch.failure ?? branch.stderr.trim())) + '）',
  }
}

/**
 * 这条线相对基线的改动，主检出 HEAD 里是不是**已经有同一份内容**了。
 *
 * 逐**文件**比 blob，不比提交：合回走的是 `merge --squash`，主线拿到的是一个新造的提交，
 * 提交层面永远对不上（见 {@link dropWorktree} 的注释），而「这些文件的内容主线已经吃下了」
 * 才是收线时真正要问的那句话。
 *
 * 一个改动文件都没有（空线）时返回 true —— 没有内容可丢。
 * @param repo - 主检出。
 * @param base - 这条线的分叉点。
 * @param branch - 这条线的分支。
 * @returns 分支上的每个改动主线都已吃下时为 true。
 */
async function contentOnMain(repo: string, base: string, branch: string): Promise<boolean> {
  const changed = await git(repo, ['diff', '--name-only', base, branch])
  if (changed.code !== 0) return false
  for (const file of lines(changed.stdout)) {
    const onBranch = await git(repo, ['rev-parse', '--verify', '--quiet', branch + ':' + file])
    const onMain = await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD:' + file])
    // 一边有、一边没有 ⇒ 这份改动没进主线（新增的文件主线里没有正是这样）。
    if (onBranch.code !== onMain.code) return false
    if (onBranch.code === 0 && onBranch.stdout.trim() !== onMain.stdout.trim()) return false
  }
  return true
}

/** 把一段文本按行拆开、去掉行尾的 \r，**不动行首**（porcelain 的状态位就在行首）。 */
function rawLines(text: string): readonly string[] {
  return text.split('\n').map(line => line.replace(/\r$/u, '')).filter(line => line !== '')
}

/** 把一段文本按行拆开、去掉空行。 */
function lines(text: string): readonly string[] {
  return text.split('\n').map(line => line.replace(/\r$/u, '').trim()).filter(line => line !== '')
}

/** 数一份 porcelain 里有几个文件。 */
function countPorcelain(porcelain: string): number {
  return lines(porcelain).length
}

/** 数一段输出里有几行非空行。 */
function countLines(text: string): number {
  return lines(text).length
}

/** 取一段命令输出（stdout 优先，空则用 stderr）。 */
function trimmedOutput(outcome: CommandOutcome): string {
  const out = outcome.stdout.trim()
  if (out !== '') return out
  return outcome.stderr.trim() === '' ? (outcome.failure ?? '') : outcome.stderr.trim()
}

/** 取末尾若干字符（验证命令的报错通常在尾巴上）。 */
function tail(text: string, max: number): string {
  return text.length <= max ? text : '…（前面已截断）' + text.slice(text.length - max)
}

/** 取开头若干行，供报错里带上下文。 */
function firstLines(text: string, count: number): string {
  const all = lines(text)
  return all.slice(0, count).map(line => '  ' + line).join('\n')
    + (all.length > count ? '\n  …（共 ' + String(all.length) + ' 项）' : '')
}

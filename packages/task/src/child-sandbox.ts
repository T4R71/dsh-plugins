/**
 * 把一个子代理**真的关进它自己的副本**。
 *
 * ## 为什么需要这一格
 *
 * 子代理的**工具层**围栏与**命令行层**围栏吃的是两份不同的东西：
 *
 * - 工具层每次调用现读轴的路径清单（`packages/dual-axis` 的 `read-guard`），所以外部改一格就立刻收窄；
 * - 命令行层吃的是**会话头里的 cwd**：`packages/sandbox/sandbox-policy/src/index.ts:168`
 *   `workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot)`。
 *
 * 而宿主给子会话开的头里，cwd 是**写死的父 cwd**
 * （`packages/subagent/subagent/src/child-agent.ts:144-147`），`SubagentStartRequest`
 * 九槽里也没有 cwd（`subagent/src/types.ts:145-201`）。于是无论写轴收得多窄，
 * 命令行都能写到会话 cwd 覆盖的整片地方 —— 2026-10-02 实测过：把子会话写轴收成
 * `custom{base:deny,allow:[副本,scratch]}` 之后，它用写文件工具改真仓**当场被拒**，
 * 换命令行**照样改成功**（`M:\DSH-T4\scratch\FENCE-DESIGN.md` Q2 那三条原始输出）。
 *
 * ## 这一格做的两件事（缺一不可）
 *
 * 1. **子会话的 cwd 就是副本**：走宿主公开的 `ctx.agents.create({ meta: { cwd } })`
 *    （`packages/core/agent/src/index.ts:79-84` 的 `CreateAgentOptions.meta.cwd`）。
 *    进程内 driver 那一条 `childSessionMeta` 只是**它自己**选的策略，不是唯一可能。
 *    于是 `sandboxPolicy.resolve()` 取到的 workspace root 就是副本。
 * 2. **子会话自己的日志里落下 `sandbox/mode`**：命令行的档位只认这条事件
 *    （`sandbox-policy/src/index.ts:164-171` 的 `overrideOf`）。不落它，档位就停在
 *    部署默认（本部署 `defaultPreset: danger-full-access`），cwd 对了也没用。
 *    谁写这件事宿主给了两种合法写法：它自己在委派边界写
 *    （`subagent/src/child-agent.ts:267-280` 的 `appendDelegatedPolicyOverrides`），
 *    dual-axis 在 `/axis` 写路径上写（`session-axes.ts:55-56`）。本格取第三种：
 *    **创建这个孩子的这一格自己写** —— 与把 cwd 交给同一个调用的那一格在同一个位置，
 *    「谁定边界谁写档位」，两件事不可能各说各话。
 *
 * ## 实测（2026-10-02，一次性 headless 进程内跑真代码）
 *
 * 副本 `…\default-workspace\dsh-fence-copy`，子会话 `session-9ec48940-…`：
 * `childCwd` 逐字等于副本；`write` 写真仓 → `[sandbox: file access denied under workspace-write mode]`；
 * `pwsh` 执行 `Set-Content M:\dsh-plugins\_fence-probe-run.txt` → **OS 报**
 * `Access to the path ... is denied.`、`Test-Path` 回来 `False`。两层同一个边界。
 *
 * @module @t4r71/dsh-task/child-sandbox
 */

import { isAbsolute, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'

/**
 * `ctx.agents` 上本格用到的那一格。
 *
 * 有意**不 import `CreateAgentOptions`**：本包只通过嵌套的 node_modules 才够得到
 * `@deepseek-ai/dsh-agent` 的**类型**入口，跨包引它的具体形状会在声明文件生成时
 * 变成一条够不到的名称（与 `presets.ts` 里 `agentOptions` 的处理同源）。
 * 这里描述的是**本次调用的实际形状**；宿主那侧的真实类型更严，由调用点负责对齐。
 */
export interface ChildAgentRegistry {
  /**
   * 建一个子 agent。
   * @param options - 会话 id、父 agent、会话元数据（含 cwd）、逐 agent 选项、创建窗口内的 setup。
   * @returns 该 agent 的句柄：`agent` 是唯一能拆它的持有者凭证。
   */
  create(options: {
    readonly sessionId: string
    readonly parentAgent?: Agent
    readonly meta?: {
      readonly cwd?: string
      readonly parentSession?: string
      readonly isSeeded?: boolean
      readonly origin?: 'subagent'
      readonly delegationDepth?: number
    }
    readonly agentOptions?: {
      readonly provider?: string
      readonly model?: string
      readonly subagentDepth?: number
    }
    readonly setup?: (childCtx: unknown, child: Agent) => void
  }): Promise<{ readonly agent: Agent; readonly dispose: () => Promise<void> }>
}

/** 一次「开一个被关住的子代理」的输入。 */
export interface FencedChildSpec {
  /** `ctx.agents`。 */
  readonly registry: ChildAgentRegistry
  /** 派活的父 agent。 */
  readonly parent: Agent
  /** 子会话 id（由调用方生成，调用方也拿它去对账）。 */
  readonly sessionId: string
  /** 这个孩子的工作目录 = 它命令行的可写边界。**必须是绝对路径**。 */
  readonly cwd: string
  /**
   * 落到子会话日志里的档位，默认 `workspace-write`。
   *
   * 只有 `workspace-write` 会把 `session.header.cwd` 当边界用；`danger-full-access`
   * 等于没围栏，`read-only` 会连自己的副本都写不了（「镜像只认 base」那条实测见
   * `M:\DSH-T4\scratch\FENCE-DESIGN.md` 的模式表）。
   */
  readonly mode?: string
  /**
   * 这个孩子的递归预算。
   *
   * 省略时**不写这一格**，由宿主的运行时按父子关系盖章 —— 本格不替调用方瞎猜一个深度。
   */
  readonly delegationDepth?: number
}

/** 一个被关住的子代理。 */
export interface FencedChild {
  /** 子会话 id。 */
  readonly sessionId: string
  /** 子会话的 cwd —— **逐字等于** {@link FencedChildSpec.cwd} 解析后的绝对路径。 */
  readonly cwd: string
  /**
   * 孩子的 `Agent`。
   *
   * 有意收成 `unknown`：本包不需要它的任何一格（驱动由子代理运行时负责），
   * 而写宽了等于替宿主承诺一份本包没验证过的接口。
   */
  readonly agent: unknown
}

/** 被关住的子代理默认跑哪一档。 */
export const DEFAULT_FENCED_MODE = 'workspace-write'

/**
 * 副本路径的那道闸。
 *
 * 相对路径在这里**当场拒**，理由是实测出来的一条：命令行层的边界就是
 * `session.header.cwd` 本身，一个相对路径会在解析点上取决于宿主进程的 cwd ——
 * 那正好是「围栏看起来生效、实际围着别处」最省事的成因。
 * @param cwd - 调用方给的副本路径。
 * @returns 解析后的绝对路径。
 * @throws 空串、或不是绝对路径时。
 */
export function absoluteCopyCwd(cwd: string): string {
  const given = cwd.trim()
  if (given === '') throw new Error('task: the isolated copy directory must not be blank')
  if (!isAbsolute(given)) {
    throw new Error('task: the isolated copy directory must be an absolute path, got "' + given
      + '" - a relative one resolves against the host process cwd, which is the very thing this fence replaces')
  }
  return resolve(given)
}

/**
 * 开一个**工作目录＝副本**的子代理，并把它的档位钉在副本上。
 *
 * 两件事在**一个**调用里完成，因为它们是同一条边界的两半：cwd 那一半由 `meta.cwd`
 * 交给宿主的会话创建，档位那一半由本格在**这个孩子的创建窗口内**（`setup`：此时会话
 * 已存在、还没发布、更没有跑过任何命令）写进它自己的日志。分开做的话，中间那一瞬
 * 就是一个「cwd 在副本里、档位还是部署默认」的孩子。
 *
 * @param spec - 见 {@link FencedChildSpec}。
 * @returns 这个孩子的会话身份与 cwd。
 */
export async function fenceChildSession(spec: FencedChildSpec): Promise<FencedChild> {
  const cwd = absoluteCopyCwd(spec.cwd)
  const parentOptions = agentOptionsOf(spec.parent)
  const handle = await spec.registry.create({
    sessionId: spec.sessionId,
    parentAgent: spec.parent,
    meta: {
      cwd,
      parentSession: String(spec.parent.id),
      isSeeded: false,
      origin: 'subagent',
      ...spec.delegationDepth === undefined ? {} : { delegationDepth: spec.delegationDepth },
    },
    agentOptions: {
      ...parentOptions,
      ...spec.delegationDepth === undefined ? {} : { subagentDepth: spec.delegationDepth },
    },
    setup: (_childCtx, child) => {
      appendPolicy(child, spec.mode ?? DEFAULT_FENCED_MODE)
    },
  })
  return { sessionId: spec.sessionId, cwd, agent: handle.agent }
}

/**
 * 把一条会话的策略事件写进它的日志。
 *
 * 为什么用 `as` 而不是 import 那个类型：`sandbox/mode` 的事件声明在
 * `@deepseek-ai/dsh-sandbox-policy`（`session-mode.ts:24-39` 的 module augmentation）里，
 * 而本包的依赖表里没有那个包 —— 为了一格事件去加一条新的解析路径，代价大于收益，
 * 且宿主的读侧本来就把它当**字符串**收（`SandboxMode` 是一串字面量的联合）。
 * 收窄在调用方那一格（{@link FencedChildSpec.mode} 的文档写着只能给哪三个值）。
 * @param child - 这个孩子。
 * @param mode - 要钉住的档位。
 */
function appendPolicy(child: Agent, mode: string): void {
  const session = child.session as unknown as {
    append(type: string, data: Record<string, unknown>): unknown
  }
  // 两件的次序是有意的：先钉档位再钉审批策略 —— 与宿主自己的委派边界同形
  // （`subagent/src/child-agent.ts:271-279`），读日志的人不必分两套顺序去认。
  session.append('sandbox/mode', { mode })
  // 被委派的孩子**不许**再问人：它的权限本来就是派活那一刻定死的，
  // 批准提示在这条路上只会变成一次必定被拒的暂停。
  session.append('approval/policy', { policy: 'never' })
}

/**
 * 从父 agent 身上取下**路由**（provider / model）。
 *
 * 逐字段抄父的：本格不替调用方选模型。少写 `reasoningEffort` / `maxTokens` 是刻意的 ——
 * 那是一对出厂值，省略即「跟着上游解析」，写死一个等于把父的档位也一起搬走。
 * @param parent - 派活的父 agent。
 * @returns 给 `agents.create` 的 agentOptions。
 */
function agentOptionsOf(parent: Agent): { readonly provider?: string; readonly model?: string } {
  const options = (parent as unknown as { readonly options?: { readonly provider?: string; readonly model?: string } }).options
  return {
    ...options?.provider === undefined ? {} : { provider: options.provider },
    ...options?.model === undefined ? {} : { model: options.model },
  }
}

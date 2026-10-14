/**
 * 「把子代理关进它自己的副本」那一格的单测。
 *
 * 这一支钉的是**调用的形状**，不是沙箱本身的行为（沙箱行为要真机才作数，见
 * `src/child-sandbox.ts` 头部记的那次实测）。两件事必须逐字对上，错一件围栏就是假的：
 *
 * 1. `meta.cwd` 必须是**解析后的绝对路径**，且与调用方给的是同一个地方；
 * 2. 策略事件必须落在**这个孩子自己的会话**上（`sandbox/mode` + `approval/policy`），
 *    而且必须在**创建窗口内**（`setup`）—— 出了那个窗口，孩子就有机会先跑一条命令。
 *
 * 这里测的是**这一格本身**：`task` 工具上那个调用它的 `probe` 档已经删掉了
 * （2026-10-14），围栏照旧可用 —— 调用方直接在代码里调 `fenceChildSession` 即可。
 *
 * ctx 与 Agent 都是假件：本支不碰真机、不启沙箱、不建真会话。
 */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { sep } from 'node:path'
import { absoluteCopyCwd, DEFAULT_FENCED_MODE, fenceChildSession } from '../src/child-sandbox.ts'

/**
 * 一次 `fenceChildSession` 调用里被交给宿主的那份 options。
 * @param cwd - 调用方给的副本路径。
 * @returns 记录下来的调用，以及那次调用里孩子的策略事件。
 */
async function fenced(cwd: string) {
  const calls: any[] = []
  const appended: { type: string; data: unknown }[] = []
  const child: any = {
    id: 'child-1',
    session: {
      id: 'child-1',
      seq: 3,
      append: (type: string, data: unknown) => {
        appended.push({ type, data })
        return undefined
      },
      snapshotEvents: () => [],
    },
  }
  const registry = {
    create: async (options: any) => {
      calls.push(options)
      // 宿主的顺序是「会话先存在、再跑 setup」——假件照抄这个顺序，
      // 否则「策略是在创建窗口内写的」这条断言就测不出真假。
      options.setup?.({}, child)
      return { agent: child, dispose: async () => {} }
    },
  }
  const parent: any = { id: 'sess-1', options: { provider: 'p', model: 'm' } }
  const result = await fenceChildSession({ registry, parent, sessionId: 'child-1', cwd })
  return { calls, appended, result, parent }
}

it('绝对路径闸：空串与相对路径当场拒，绝对路径解析后原样返回', () => {
  assert.throws(() => absoluteCopyCwd('   '), /must not be blank/)
  assert.throws(() => absoluteCopyCwd('relative/copy'), /must be an absolute path/)
  assert.throws(() => absoluteCopyCwd('.' + sep + 'x'), /must be an absolute path/)
  const abs = process.cwd()
  assert.equal(absoluteCopyCwd(abs), abs)
  // 带冗余分隔符与 `.` 的相对写法在绝对路径上也要被规范化成同一个地方。
  assert.equal(absoluteCopyCwd(abs + sep + '.'), abs)
})

it('交给宿主的 options：cwd 落进 meta、路由逐字段抄父、isSeeded=false', async () => {
  const cwd = process.cwd()
  const { calls, result } = await fenced(cwd)
  assert.equal(calls.length, 1)
  const options = calls[0]
  assert.equal(options.meta.cwd, cwd, 'meta.cwd 就是命令行层的边界，必须是解析后的副本路径')
  assert.equal(options.meta.parentSession, 'sess-1')
  assert.equal(options.meta.origin, 'subagent')
  assert.equal(options.meta.isSeeded, false, '新开的子会话不是从父日志切出来的那一种')
  assert.equal(options.agentOptions.provider, 'p')
  assert.equal(options.agentOptions.model, 'm')
  assert.equal('delegationDepth' in options.meta, false, '没给深度就不许替调用方瞎猜一个')
  assert.equal('subagentDepth' in options.agentOptions, false)
  assert.equal(result.cwd, cwd)
  assert.equal(result.sessionId, 'child-1')
})

it('策略写在创建窗口内：先钉档位再钉审批策略，都落在这个孩子自己的日志上', async () => {
  const { appended } = await fenced(process.cwd())
  assert.deepStrictEqual(appended, [
    { type: 'sandbox/mode', data: { mode: DEFAULT_FENCED_MODE } },
    { type: 'approval/policy', data: { policy: 'never' } },
  ])
})

it('显式给的档位覆盖默认；给了深度就两处都写', async () => {
  const appended: { type: string; data: unknown }[] = []
  const child: any = { id: 'child-2', session: { id: 'child-2', append: (t: string, d: unknown) => { appended.push({ type: t, data: d }) } } }
  const calls: any[] = []
  const registry = { create: async (options: any) => { calls.push(options); options.setup?.({}, child); return { agent: child, dispose: async () => {} } } }
  await fenceChildSession({
    registry,
    parent: { id: 'sess-1', options: {} } as never,
    sessionId: 'child-2',
    cwd: process.cwd(),
    mode: 'read-only',
    delegationDepth: 2,
  })
  assert.deepStrictEqual(appended[0], { type: 'sandbox/mode', data: { mode: 'read-only' } })
  assert.equal(calls[0].meta.delegationDepth, 2)
  assert.equal(calls[0].agentOptions.subagentDepth, 2)
  assert.equal('provider' in calls[0].agentOptions, false, '父没有路由就不写路由，别填一个空的')
})


/**
 * 预设表的单测。
 *
 * 这一支**不碰 DSH 运行时**：`resolvePreset` 是纯函数，所以本包的测试能在包一落进仓、
 * `pnpm install` 跑完的当下就执行，不必等真机或 mock。
 *
 * 断言的侧重是「**不许静默退化**」：查不到名字必须是错误，而不是悄悄继承父的工具面。
 */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  EmptyPresetFilterError,
  resolvePreset,
  UnknownPresetError,
  type PresetSpec,
} from '../src/presets.ts'
import { Config } from '../src/index.ts'
import { DROP_DIRECTIVE_OPEN, decodeDropDirective, encodeDropDirective } from '../src/presets.ts'

const TABLE: Readonly<Record<string, PresetSpec>> = {
  reader: { persona: 'You only read.', allow: ['read', 'grep', 'glob'] },
  builder: { allow: ['read', 'edit', 'write'], deny: ['pwsh'], maxDepth: 2 },
  plain: {},
}

it('省略预设名返回空对象——这是唯一允许的退化，且是模型显式选择的结果', () => {
  assert.deepStrictEqual(resolvePreset(TABLE, undefined), {})
})

it('查不到的预设名抛错，并把现有名字排序后列出来', () => {
  assert.throws(() => resolvePreset(TABLE, 'reader2'), (error: unknown) => {
    assert.ok(error instanceof UnknownPresetError)
    assert.deepStrictEqual([...error.known], ['builder', 'plain', 'reader'])
    assert.match(error.message, /unknown preset "reader2"/)
    assert.match(error.message, /builder, plain, reader/)
    return true
  })
})

it('空表也要给出可读的报错，而不是空字符串', () => {
  assert.throws(() => resolvePreset({}, 'x'), (error: unknown) => {
    assert.match((error as Error).message, /configured presets: \(none\)/)
    return true
  })
})

it('原型链上的名字不算预设——查表走 Object.hasOwn', () => {
  // 不这条的话，preset: 'toString' 会命中原型上的函数，把一个配置笔误变成一次身份继承。
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    assert.throws(() => resolvePreset(TABLE, name), UnknownPresetError, name)
  }
})

it('persona 与 maxDepth 原样透传', () => {
  assert.deepStrictEqual(resolvePreset(TABLE, 'reader').persona, 'You only read.')
  assert.deepStrictEqual(resolvePreset(TABLE, 'builder').maxDepth, 2)
})

it('allow 与 deny 同时给定时两者都进 toolFilter', () => {
  assert.deepStrictEqual(resolvePreset(TABLE, 'builder').toolFilter, {
    allow: ['read', 'edit', 'write'],
    deny: ['pwsh'],
  })
})

it('两个围栏都省略时不出 toolFilter——继承父的工具面', () => {
  const resolved = resolvePreset(TABLE, 'plain')
  assert.strictEqual('toolFilter' in resolved, false)
  assert.strictEqual('persona' in resolved, false)
})

it('显式给空围栏是配置 bug，直接拒——照上游 tools.restrict 的判据', () => {
  assert.throws(() => resolvePreset({ empty: { allow: [] } }, 'empty'), EmptyPresetFilterError)
  assert.throws(() => resolvePreset({ empty: { deny: [] } }, 'empty'), EmptyPresetFilterError)
  // 但「两个都没给」与「给了空数组」是两件事：前者合法，后者是 bug。
  assert.deepStrictEqual(resolvePreset({ ok: {} }, 'ok'), {})
})

it('返回的数组是副本——调用方改不动配置表', () => {
  const resolved = resolvePreset(TABLE, 'reader')
  assert.notStrictEqual(resolved.toolFilter?.allow, TABLE.reader?.allow)
  assert.deepStrictEqual([...resolved.toolFilter?.allow ?? []], ['read', 'grep', 'glob'])
})

/**
 * 回归：schemastery 会把**省略的**数组成员物化成 `[]`。
 *
 * 曾经的后果是一条**文档承诺的出路走不通**：`resolvePreset` 把「两个围栏都空」
 * 判为配置事故并抛 `EmptyPresetFilterError`，而 `z.array(z.string())` 让
 * 「省略」与「显式空数组」在 schema 输出里长得一模一样 —— 于是一个只想
 * 「继承父的全部工具」的 preset（本机 profile 的 `impl` 与 `lead`）
 * 每次派发都 100% 抛错，逼得人只能去枚举全部工具名。
 *
 * 修法是给两个字段 `.default(undefined)`，让省略保持缺席。这两条一起钉住：
 * 一条证明「省略 = 继承」真的通，一条证明「显式空 = fail closed」没有被顺手放开。
 */
it('省略 allow/deny 的 preset 真的能继承全部工具——物化曾让这条路 100% 抛错', () => {
  const parsed = Config({ provider: 'spawn', presets: { lead: { persona: 'x', maxDepth: 3 } } })
  const spec = parsed.presets['lead'] as { allow?: unknown; deny?: unknown }
  // 先钉住 schema 本身：省略必须保持缺席，而不是变成 []
  assert.strictEqual(spec.allow, undefined)
  assert.strictEqual(spec.deny, undefined)
  // 再钉住解析结果：没有 toolFilter，就是继承父的全部工具
  assert.deepStrictEqual(resolvePreset(parsed.presets, 'lead'), { persona: 'x', maxDepth: 3 })
})

it('显式 allow: [] 仍然 fail closed——修 schema 没有顺手放开这条护栏', () => {
  // 「一个工具都不许用」与「不限」是两种相反的意图。物化让它们在输出里无法区分，
  // 所以显式空数组必须继续报错，否则前者会被静默解释成后者——那是权限提升。
  const parsed = Config({ provider: 'spawn', presets: { none: { persona: 'x', allow: [], maxDepth: 1 } } })
  assert.throws(() => resolvePreset(parsed.presets, 'none'), EmptyPresetFilterError)
})

/**
 * 丢弃指令的编解码。
 *
 * 这段指令要**随 persona 一起旅行**：\`applyChildComposition\` 只给父两个同步槽
 * （\`persona\` / \`toolFilter\`），记在任何别处都要等 \`startContinuable\` 返回 childId
 * 之后才写得上，而子代理的第一次装配可能就发生在那之前。所以往返必须无损。
 */
it('丢弃指令编解码往返：指令前置，剥净后逐字是原文', () => {
  const persona = 'You are a reconnaissance agent.\nRead, search and report.'
  const encoded = encodeDropDirective(['plan:policy', 'team:policy'], persona)
  assert.ok(encoded.startsWith(DROP_DIRECTIVE_OPEN), '指令必须在最前头')
  assert.deepStrictEqual(decodeDropDirective(encoded), {
    drop: ['plan:policy', 'team:policy'],
    text: persona,
  })
})

it('没带指令时解码返回 undefined —— 快路径要靠它，而不是靠一个空数组', () => {
  assert.strictEqual(decodeDropDirective('plain persona'), undefined)
  assert.strictEqual(decodeDropDirective(''), undefined)
})

it('空 drop 列表不编指令；空名与含逗号的名被剔除（逗号是分隔符，混进去会把列表撕开）', () => {
  assert.strictEqual(encodeDropDirective([], 'P'), 'P')
  assert.strictEqual(encodeDropDirective(['  ', ''], 'P'), 'P')
  assert.deepStrictEqual(decodeDropDirective(encodeDropDirective([' a ', '', 'b,c'], 'P'))?.drop, ['a'])
})

it('persona 为空也能只丢段 —— 编码结果是纯指令', () => {
  const encoded = encodeDropDirective(['plan:policy'], '')
  assert.deepStrictEqual(decodeDropDirective(encoded), { drop: ['plan:policy'], text: '' })
})

/**
 * per-角色的 `agentOptions`：让每个身份自己钉住思考强度或模型路由。
 *
 * 这一项与前面那些围栏一样，**省略必须保持缺席**：宿主侧是逐字段覆盖父的那一份，
 * 只有「真的没给」时才轮到继承。所以下面第二条用全等断言把「不多出这个键」钉死 ——
 * 物化出来的空对象会让「省略」与「显式给空」在输出里长得一样。
 */
it('resolvePreset 平铺 agentOptions——四个字段原样进结果', () => {
  const resolved = resolvePreset(
    { recon: { agentOptions: { reasoningEffort: 'low', maxTokens: 4096 } } },
    'recon',
  )
  assert.deepStrictEqual(resolved.agentOptions, { reasoningEffort: 'low', maxTokens: 4096 })
  // 只给 effort 时路由不动 —— 那正是本项最安全的用法（宿主逐字段覆盖，provider/model 继承父）。
  assert.deepStrictEqual(
    resolvePreset({ verify: { agentOptions: { reasoningEffort: 'high' } } }, 'verify').agentOptions,
    { reasoningEffort: 'high' },
  )
})

it('没声明 agentOptions 时结果里没有这个键——省略就是继承父的路由', () => {
  assert.deepStrictEqual(resolvePreset(TABLE, 'reader'), {
    persona: 'You only read.',
    toolFilter: { allow: ['read', 'grep', 'glob'] },
  })
  assert.deepStrictEqual(resolvePreset({ plain: {} }, 'plain'), {})
})

it('Config schema 收下 agentOptions，且省略时不物化', () => {
  const parsed = Config({
    provider: 'spawn',
    presets: {
      recon: { persona: 'r', agentOptions: { reasoningEffort: 'low', model: 'm-1', maxTokens: 2048 } },
      impl: { persona: 'i' },
    },
  })
  // ① 写了的原样解析出来（schema 少这一格的话，配置表里的话会被悄悄吃掉）。
  assert.deepStrictEqual(parsed.presets['recon']?.agentOptions, {
    reasoningEffort: 'low',
    model: 'm-1',
    maxTokens: 2048,
  })
  // ② 省略的保持缺席：既不在 schema 输出里，也不在解析结果里。
  assert.strictEqual(parsed.presets['impl']?.agentOptions, undefined)
  assert.deepStrictEqual(resolvePreset(parsed.presets, 'impl'), { persona: 'i' })
})

it('resolvePreset 透传 drop', () => {
  assert.deepStrictEqual(resolvePreset({ scout: { drop: ['plan:policy'] } }, 'scout'), { drop: ['plan:policy'] })
  // 空数组不产生字段：空 drop 与"没写 drop"是同一件事。
  assert.deepStrictEqual(resolvePreset({ scout: { drop: [] } }, 'scout'), {})
})

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
  chooseIdentityChannel,
  EmptyPresetFilterError,
  intersectToolFilterWithFace,
  resolvePreset,
  UnknownPresetError,
  type AgentPresetRosterPort,
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
  assert.deepStrictEqual(resolvePreset({ ok: {} }, 'ok'), { preset: 'ok' })
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
  assert.deepStrictEqual(resolvePreset(parsed.presets, 'lead'), { persona: 'x', maxDepth: 3, preset: 'lead' })
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
    preset: 'reader',
  })
  assert.deepStrictEqual(resolvePreset({ plain: {} }, 'plain'), { preset: 'plain' })
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
  assert.deepStrictEqual(resolvePreset(parsed.presets, 'impl'), { persona: 'i', preset: 'impl' })
})

it('resolvePreset 透传 drop', () => {
  assert.deepStrictEqual(resolvePreset({ scout: { drop: ['plan:policy'] } }, 'scout'),
    { drop: ['plan:policy'], preset: 'scout' })
  // 空数组不产生字段：空 drop 与"没写 drop"是同一件事。
  assert.deepStrictEqual(resolvePreset({ scout: { drop: [] } }, 'scout'), { preset: 'scout' })
})

/**
 * 内核 `preset` 那一格（0.2.0-rc.2 起逐次派发支持）。
 *
 * 这一格与 `toolFilter` 是**两件不同的事**：`toolFilter` 在父的面里做减法，
 * `preset` 换掉整个面（孩子因此能拿到父从来没有过的工具）。测试要钉住的正是这个区别 ——
 * 两者同时写时必须**各自都进结果**，不能互相吞掉。
 */
it('resolvePreset 透传内核 preset 名', () => {
  assert.deepStrictEqual(
    resolvePreset({ recon: { preset: 'recon', persona: 'r' } }, 'recon'),
    { persona: 'r', preset: 'recon' },
  )
})
it('省略 preset 时取角色键自己——「没写这一格」是「用角色名当预设名」，不是「不要身份」', () => {
  // 与 agentOptions 的判据不同：那一格省略就是真·缺席（继承父的路由），
  // 这一格省略必须**填上角色键**。理由在派发那刻：`preset` 到底交不交得出去由
  // `chooseIdentityChannel` 问名册决定，而「要不要问」这件事本身需要一个名字 ——
  // 省略成 `''` 会被宿主当成一个 id 去查表然后当场抛，省略成「键不存在」则等于
  // 悄悄退回 persona + toolFilter，把 rosterless 与「本来就不打算用预设」混成一种。
  const resolved = resolvePreset({ lead: { persona: 'l' } }, 'lead')
  assert.deepStrictEqual(resolved, { persona: 'l', preset: 'lead' })
})

it('表里写了 preset 时以它为准，不取角色键——角色名与预设名本来就是两件事', () => {
  assert.strictEqual(resolvePreset({ lead: { preset: 'central' } }, 'lead').preset, 'central')
})

it('name 与 fallback 都给不出来时 preset 才缺席——那是唯一没有身份可言的场合', () => {
  const resolved = resolvePreset({ lead: {} }, undefined)
  assert.deepStrictEqual(resolved, {})
  assert.strictEqual(Object.hasOwn(resolved, 'preset'), false)
})

it('preset 与 toolFilter 可以同时给出，互不吞掉', () => {
  // 声明选面、围栏收窄面，是两个正交的动作。
  assert.deepStrictEqual(
    resolvePreset({ impl: { preset: 'impl', deny: ['task'] } }, 'impl'),
    { preset: 'impl', toolFilter: { deny: ['task'] } },
  )
})

it('Config schema 收下 preset，且省略时不物化', () => {
  const parsed = Config({
    provider: 'spawn',
    presets: {
      recon: { persona: 'r', preset: 'recon-face' },
      impl: { persona: 'i' },
    },
  })
  // ① schema 少这一格的话，配置表里写下的 preset 会被悄悄吃掉，孩子静默继承父的面。
  assert.strictEqual(parsed.presets['recon']?.preset, 'recon-face')
  assert.deepStrictEqual(resolvePreset(parsed.presets, 'recon'), { persona: 'r', preset: 'recon-face' })
  // ② 省略的保持缺席，而不是被物化成空串；解析时按角色键补上。
  assert.strictEqual(parsed.presets['impl']?.preset, undefined)
  assert.deepStrictEqual(resolvePreset(parsed.presets, 'impl'), { persona: 'i', preset: 'impl' })
})

/**
 * 交身份的两条通道，四条出口逐条钉住。
 *
 * 这一族是**纯函数**测试：`chooseIdentityChannel` 不碰宿主，只问一次名册。
 * 关键判据是「**问不到就退回减法，并且把原因说清楚**」——
 * 降级本身合法（rosterless 是正常部署），静默降级才是要消灭的东西。
 */
it('名册在册 → 走 preset 通道，交出去的是名册里那一行的 id', async () => {
  const roster: AgentPresetRosterPort = { list: async () => [{ id: 'lead' }, { id: 'recon' }] }
  assert.deepStrictEqual(await chooseIdentityChannel(roster, 'recon'), { kind: 'preset', id: 'recon' })
})

it('没有名册服务 → 退回减法，原因是 roster-absent', async () => {
  const channel = await chooseIdentityChannel(undefined, 'recon')
  assert.equal(channel?.kind, 'fallback')
  assert.equal(channel?.kind === 'fallback' ? channel.reason : undefined, 'roster-absent')
  assert.match(channel?.kind === 'fallback' ? channel.detail : '', /recon.*no agent-preset roster/s)
})

it('名字不在册 → 退回减法，并把册子里有的名字列出来（available）', async () => {
  const roster: AgentPresetRosterPort = { list: async () => [{ id: 'lead' }] }
  const channel = await chooseIdentityChannel(roster, 'recon')
  assert.equal(channel?.kind === 'fallback' ? channel.reason : undefined, 'not-in-roster')
  assert.match(channel?.kind === 'fallback' ? channel.detail : '', /available: lead\b/)
})

it('册子是空的也要给得出「(none)」——不能只留一个空括号', async () => {
  const channel = await chooseIdentityChannel({ list: async () => [] }, 'recon')
  assert.match(channel?.kind === 'fallback' ? channel.detail : '', /available: \(none\)/)
})

it('名册读不动（list 抛）→ 与没有名册同等对待，原因也是 roster-absent', async () => {
  const roster: AgentPresetRosterPort = {
    list: async () => { throw new Error('registry exploded') },
  }
  const channel = await chooseIdentityChannel(roster, 'recon')
  assert.equal(channel?.kind === 'fallback' ? channel.reason : undefined, 'roster-absent')
  assert.match(channel?.kind === 'fallback' ? channel.detail : '', /registry exploded/)
})

it('那一行是 broken 的 → 同样退回减法：交出去只会让孩子在装配时炸', async () => {
  const roster: AgentPresetRosterPort = { list: async () => [{ id: 'recon', broken: 'plugin "x" is missing' }] }
  const channel = await chooseIdentityChannel(roster, 'recon')
  assert.equal(channel?.kind === 'fallback' ? channel.reason : undefined, 'roster-entry-broken')
  assert.match(channel?.kind === 'fallback' ? channel.detail : '', /plugin "x" is missing/)
})

it('没有任何身份名时返回 undefined——没有身份，也就没有降级可言', async () => {
  // 这一格与上面那些「降级」不是一回事：`resolvePreset` 返回 `{}` 那条路里
  // 本来就没有身份要交，留痕会变成一次假警报。
  assert.strictEqual(await chooseIdentityChannel({ list: async () => [] }, undefined), undefined)
  assert.strictEqual(await chooseIdentityChannel(undefined, undefined), undefined)
})

// ── 围栏 × 父面 求交集 ────────────────────────────────────────────────────────
// 隐患：`tools.restrict()` 对未知名字**整体抛**（`dsh-tools/lib/index.js:2906-2908`），
// 而宿主在 `applyChildComposition` 里拿降级通道交出去的 toolFilter 直接调它
// （`dsh-subagent/lib/index.js:522`）。这几条钉住求交集的判据与两条不对称。

it('围栏 × 父面：父面上有的名字原样留下，没有的剔掉并如实登记', () => {
  const face = new Set(['read', 'grep'])
  const result = intersectToolFilterWithFace({ allow: ['read', 'pwsh'], deny: ['grep', 'ops_bash'] }, name => face.has(name))
  assert.deepStrictEqual(result.filter, { allow: ['read'], deny: ['grep'] })
  // 按声明顺序：先 allow 那半、后 deny 那半。
  assert.deepStrictEqual(result.dropped, ['pwsh', 'ops_bash'])
})

it('围栏 × 父面：问不出来（没有那个接口）时一个名字都不剔——判据缺席不等于名字不在', () => {
  assert.deepStrictEqual(
    intersectToolFilterWithFace({ deny: ['ops_bash'] }, undefined),
    { filter: { deny: ['ops_bash'] }, dropped: [] },
  )
  // 连围栏都没有：既不交也不剔。
  assert.deepStrictEqual(intersectToolFilterWithFace(undefined, () => true), { dropped: [] })
})

it('围栏 × 父面：deny 剔空则不交（它什么都不删），allow 剔空照交（fail-closed 那一侧）', () => {
  // deny 空了还交出去，只会白白向 provider 要一次 `toolFilter` 能力
  // （`dsh-subagent/lib/index.js:3188`）。
  assert.deepStrictEqual(intersectToolFilterWithFace({ deny: ['ops_bash'] }, () => false), { dropped: ['ops_bash'] })
  // allow 空了是「一个都不留」：放宽成「继承父的全部工具」会让一次笔误变成一次权限提升。
  assert.deepStrictEqual(
    intersectToolFilterWithFace({ allow: ['ops_bash'] }, () => false),
    { filter: { allow: [] }, dropped: ['ops_bash'] },
  )
  // 两半都声明、只有 deny 被剔空：剩下的那一半照旧交。
  assert.deepStrictEqual(
    intersectToolFilterWithFace({ allow: ['read'], deny: ['ops_bash'] }, name => name === 'read'),
    { filter: { allow: ['read'] }, dropped: ['ops_bash'] },
  )
})

it('围栏 × 父面：run_code 是 restrict 专门拒收的保留名，在父面上也照样剔', () => {
  // 它不是「未知名字」那一类，而是同一个函数里的另一条当场抛（`dsh-tools/lib/index.js:2905`）：
  // 名字写对了也照样让整次派发失败，所以连同未知名字一起拦在派发之前。
  const result = intersectToolFilterWithFace({ deny: ['run_code'] }, () => true)
  assert.deepStrictEqual(result, { dropped: ['run_code'] })
})

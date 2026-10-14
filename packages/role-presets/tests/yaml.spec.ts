/**
 * `src/yaml.ts` 的单测。
 *
 * 这一支只碰**纯函数** `parseYaml`：不 import `src/index.ts`（它加载时就会写救援日志、
 * 还需要 cordis 上下文），所以测试能在没有 DSH 运行时的机器上直接跑。
 *
 * 断言的侧重是**不许静默退化**：`!!js <表达式>` 一旦被收成字符串，字符串是真值，
 * 于是 `disabled: !!js ...` 全部等价于 `disabled: true` —— 整组工具静默失效且不报错。
 * 所以这一份测试的核心钉子就是「`!!js` 必须求出**布尔值**」。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { parseYaml, type YamlValue } from '../src/yaml.ts'

/** 本机是不是 win32；真实角色文件里的 `!!js` 表达式就是按它分流的。 */
const WIN = process.platform === 'win32'

/**
 * 断言一个值是非数组的映射，并把它收窄成映射类型。
 * @param value - 待收窄的值。
 * @returns 同一个值的映射视图。
 */
function asMap(value: YamlValue | undefined): { [key: string]: YamlValue } {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `期望映射，实际 ${JSON.stringify(value)}`,
  )
  return value as { [key: string]: YamlValue }
}

/**
 * 断言一个值是序列，并把它收窄成数组类型。
 * @param value - 待收窄的值。
 * @returns 同一个值的数组视图。
 */
function asList(value: YamlValue | undefined): YamlValue[] {
  assert.ok(Array.isArray(value), `期望序列，实际 ${JSON.stringify(value)}`)
  return value
}

/**
 * 在行列表里按 `id` 找一行。
 * @param list - 行列表。
 * @param id - 目标行的 id。
 * @returns 那一行的映射视图。
 */
function row(list: YamlValue[], id: string): { [key: string]: YamlValue } {
  for (const entry of list) {
    const map = asMap(entry)
    if (map['id'] === id) return map
  }
  assert.fail(`行列表里没有 id=${id}`)
}

// ── !!js：必须真求值 ────────────────────────────────────────────────────────

it("!!js 真求值：process.platform === 'win32' 得到布尔值，不是字符串", () => {
  const doc = asMap(parseYaml("disabled: !!js process.platform === 'win32'\n"))
  // 先钉类型再钉值：收成字符串的话这里就红了（而字符串是真值，`disabled` 会被静默当成 true）。
  assert.strictEqual(typeof doc['disabled'], 'boolean', `实际 ${JSON.stringify(doc['disabled'])}`)
  assert.strictEqual(doc['disabled'], WIN)
})

it("!!js 真求值：process.platform !== 'win32' 得到布尔值 false（win32 上）", () => {
  const doc = asMap(parseYaml("disabled: !!js process.platform !== 'win32'\n"))
  assert.strictEqual(typeof doc['disabled'], 'boolean', `实际 ${JSON.stringify(doc['disabled'])}`)
  assert.strictEqual(doc['disabled'], !WIN)
  if (WIN) assert.strictEqual(doc['disabled'], false)
})

it('!!js false 得到布尔 false —— 字符串 "false" 是真值，这一条正是静默失效的来源', () => {
  const doc = asMap(parseYaml('disabled: !!js false\n'))
  assert.strictEqual(doc['disabled'], false)
  assert.strictEqual(typeof doc['disabled'], 'boolean')
})

it('语法错的 !!js 表达式退回原表达式字符串，且不抛', () => {
  // `((( ` 在求值期是 SyntaxError；退回字符串是为了让使用者看得见原表达式，
  // 而不是静默变成一个真值。
  const doc = asMap(parseYaml('x: !!js (((\n'))
  assert.strictEqual(doc['x'], '(((')
  assert.strictEqual(typeof doc['x'], 'string')
})

it('运行期出错的 !!js 表达式同样退回原表达式字符串，且不抛', () => {
  const doc = asMap(parseYaml('x: !!js thisNameIsNotDefinedAnywhere()\n'))
  assert.strictEqual(doc['x'], 'thisNameIsNotDefinedAnywhere()')
})

it('!!js 表达式里的冒号与引号不干扰键分隔与注释剥离', () => {
  // 表达式里的 `'x:y'` 含冒号、后面还有一段行尾注释：两者都不该把这一行拆坏。
  const doc = asMap(parseYaml("a: !!js 'x:y'.length # 尾注释\n"))
  assert.strictEqual(doc['a'], 3)
  assert.strictEqual(typeof doc['a'], 'number')
})

// ── 其它自定义标签 ──────────────────────────────────────────────────────────

it('其它自定义标签按标量语义收：!!str 5 是字符串 "5"', () => {
  const doc = asMap(parseYaml('a: !!str 5\n'))
  assert.strictEqual(doc['a'], '5')
  assert.strictEqual(typeof doc['a'], 'string')
})

it('带标签的空值收成 null', () => {
  const doc = asMap(parseYaml('a: !!str\n'))
  assert.strictEqual(doc['a'], null)
})

// ── 块标量 ──────────────────────────────────────────────────────────────────

it('块标量三者差异：|- 不留末尾换行、| 留一个、>- 折叠成一行', () => {
  const doc = asMap(parseYaml('x: |-\n  one\n  two\ny: |\n  one\n  two\nz: >-\n  one\n  two\n'))
  assert.strictEqual(doc['x'], 'one\ntwo')
  assert.strictEqual(doc['y'], 'one\ntwo\n')
  assert.strictEqual(doc['z'], 'one two')
})

it('块标量保留块内相对缩进，并且不为块内空行留尾', () => {
  const doc = asMap(parseYaml('x: |-\n  a\n    b\n\n  c\n'))
  assert.strictEqual(doc['x'], 'a\n  b\n\nc')
})

// ── 注释 ────────────────────────────────────────────────────────────────────

it('`#` 只在行首或前面是空白时才是注释', () => {
  const doc = asMap(
    parseYaml(['# 整行注释', 'a: value # 尾注释', 'b: a#b', 'c: "x #y"', "d: 'x #y'", ''].join('\n')),
  )
  assert.strictEqual(doc['a'], 'value')
  assert.strictEqual(doc['b'], 'a#b')
  assert.strictEqual(doc['c'], 'x #y')
  assert.strictEqual(doc['d'], 'x #y')
  assert.ok(!Object.hasOwn(doc, '# 整行注释'))
})

it('纯注释行不占位置：注释行夹在块序列中间也不打断它', () => {
  const list = asList(parseYaml(['# 头', '- a', '  # 夹在中间', '- b', ''].join('\n')))
  assert.deepStrictEqual(list, ['a', 'b'])
})

// ── 流式集合 ────────────────────────────────────────────────────────────────

it('流式集合：[] / {} / ["a","b"]', () => {
  const doc = asMap(parseYaml('a: []\nb: {}\nc: ["a","b"]\n'))
  assert.deepStrictEqual(doc['a'], [])
  assert.deepStrictEqual(doc['b'], {})
  assert.deepStrictEqual(doc['c'], ['a', 'b'])
})

// ── 键分隔冒号 ──────────────────────────────────────────────────────────────

it('键分隔冒号只认「冒号后是空白或行尾」：带冒号的裸标量不被误判成键', () => {
  // `cordis:group` 里冒号后面是 `g`，不是键分隔；在序列里它就该是一个字符串。
  const list = asList(parseYaml('- cordis:group\n- a:b\n'))
  assert.deepStrictEqual(list, ['cordis:group', 'a:b'])
})

it('值里的无空白冒号原样保留（http:// 一类的 URL）', () => {
  const doc = asMap(parseYaml('url: http://example.com/a\n'))
  assert.strictEqual(doc['url'], 'http://example.com/a')
})

it('冒号后是行尾算键分隔：`k:` 是键，值为 null', () => {
  const doc = asMap(parseYaml('k:\n'))
  assert.deepStrictEqual(doc, { k: null })
})

// ── 真实角色文件 ────────────────────────────────────────────────────────────

/** 角色目录的父目录，与 `src/index.ts` 的默认值同源。 */
const PRESET_ROOT = join(homedir(), '.dsh', '.agent-presets')

it('真实文件 role-impl/agent.cordis.yml：shell 组的 disabled 是布尔值而非字符串', (t) => {
  const file = join(PRESET_ROOT, 'role-impl', 'agent.cordis.yml')
  if (!existsSync(file)) {
    console.log(`[yaml.spec] 跳过 role-impl 断言：${file} 不存在（这台机器上没有这个角色）`)
    t.skip(`${file} 不存在`)
    return
  }
  const list = asList(parseYaml(readFileSync(file, 'utf8')))
  const group = asList(row(list, 'shell')['config'])

  // 三个 shell 行的 disabled 表达式互为反相：win32 上 bash 关、pwsh 开。
  const expectations: ReadonlyArray<readonly [string, boolean]> = [
    ['terminal-bash', WIN],
    ['terminal-pwsh', !WIN],
    ['tool-pwsh', !WIN],
  ]
  for (const [id, expected] of expectations) {
    const value = row(group, id)['disabled']
    assert.strictEqual(
      typeof value,
      'boolean',
      `${id}.disabled 必须是布尔，实际 ${JSON.stringify(value)} —— 收成字符串就是真值，这一行被静默当成 disabled:true`,
    )
    assert.strictEqual(value, expected, `${id}.disabled`)
  }

  // persona 行也要在：这是走 preset 通道时唯一的身份来源。
  assert.match(String(asMap(row(list, 'persona')['config'])['prefix']), /你是实施子代理。/)
})

it('真实文件 role-recon/agent.cordis.yml：解析出的行列表结构正确', (t) => {
  const file = join(PRESET_ROOT, 'role-recon', 'agent.cordis.yml')
  if (!existsSync(file)) {
    console.log(`[yaml.spec] 跳过 role-recon 断言：${file} 不存在（这台机器上没有这个角色）`)
    t.skip(`${file} 不存在`)
    return
  }
  const list = asList(parseYaml(readFileSync(file, 'utf8')))
  assert.deepStrictEqual(
    list.map(entry => asMap(entry)['id']),
    ['persona', 'skill-filesystem', 'tool-skill', 'tool-fs', 'tool-fs-search'],
  )
  assert.match(String(asMap(row(list, 'persona')['config'])['prefix']), /你是侦察子代理。/)
  assert.strictEqual(
    asMap(row(list, 'tool-fs-search')['config'])['sampleOverCapGlobResults'],
    false,
    'sampleOverCapGlobResults 是必填项，缺了整条预设会静默挂载失败',
  )
  // 侦察这一份没有 shell 组，也就不该有任何 !!js 求值结果。
  assert.ok(list.every(entry => asMap(entry)['disabled'] === undefined))
})

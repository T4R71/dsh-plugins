/**
 * 一份**只够读 agent.cordis.yml 与 preset.yml** 的最小 YAML 读取器。
 *
 * 为什么不用 js-yaml：本仓库是 pnpm 工作区，js-yaml@4.3.2 确实躺在
 * node_modules/.pnpm 里，但它没有被任何包链接过（任何 packages 下的子包都没有
 * 链接到它）。把它写进 dependencies 就必须跑一次 pnpm install —— 那会改写
 * M:\dsh-plugins 的 pnpm-lock.yaml 与 node_modules。为三个格式固定的文件付这个
 * 代价不划算，所以这里自带实现，零依赖。
 *
 * 支持的范围（正好覆盖这三个文件用到的语法）：
 *   - 块序列       `- id: x`
 *   - 块映射       缩进 + `key: value`
 *   - 嵌套         缩进更深即上一层某个 key 的值
 *   - 块标量       `|-` / `|` / `>-` / `>`（|- 不保留末尾换行，| 保留一个）
 *   - 引号标量     '...' 与 "..."（含 \\' 与 \\" 转义）
 *   - 行内流式     [] 与 {} 的空写法，以及 ["a", "b"] 这类简单标量列表
 *   - 注释         `#`（不在引号内的才当注释）
 *   - 自定义标签   `!!js <表达式>` → **在本进程内真求值**，拿到的是表达式的值
 *                  （布尔/数字/字符串），不是表达式文本；求值出错才退回原表达式
 *                  字符串。为什么必须真求值：字符串是**真值**，收成字符串会让每
 *                  一行 `disabled: !!js ...` 被静默当成 `disabled: true` —— 实测
 *                  role-impl 的整个 shell 组因此零贡献且不报任何错。
 *                  见 parseScalar 的 jsTag 分支与 tests/yaml.spec.ts，两边都不许
 *                  改回去（真求值换回字符串，那份 spec 立刻 5 条红）。
 *   - 其他标量     null / true / false / 数字 / 裸字符串
 *
 * 不支持（本包用不到，遇到就按字面量当字符串，不抛）：锚点、别名、多文档、
 * 复杂键、流式集合的嵌套展开。
 */

/** 读到的任意 YAML 值。 */
export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue }

/** 一行源文本：原文、缩进宽度、去掉缩进与注释后的正文。 */
interface Line {
  /** 1 起的行号，用于报错。 */
  readonly no: number
  /** 缩进空格数（tab 按 1 计，与本文件约定一致即可）。 */
  readonly indent: number
  /** 去掉缩进、去掉行尾注释、去掉行尾空白后的正文；空行与纯注释行为空串。 */
  readonly body: string
}

/**
 * 去掉一行里的注释部分，但不动引号里的 `#`。
 * @param text - 去掉缩进后的正文。
 * @returns 去掉注释并裁掉行尾空白的正文。
 */
function stripComment(text: string): string {
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    // `#` 只有在行首或前面是空白时才是注释开始（`a#b` 是普通字符）。
    if (ch === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) {
      return text.slice(0, i).replace(/\s+$/, '')
    }
  }
  return text.replace(/\s+$/, '')
}

/**
 * 把源文本切成有意义的行为数组。
 * @param source - 整个文件的文本。
 * @returns 行数组，顺序不变；空行与纯注释行的 body 为空串。
 */
function toLines(source: string): Line[] {
  const out: Line[] = []
  const raw = source.split(/\r?\n/)
  for (let i = 0; i < raw.length; i++) {
    const text = raw[i] ?? ''
    let indent = 0
    while (indent < text.length && (text[indent] === ' ' || text[indent] === '\t')) indent++
    const body = stripComment(text.slice(indent))
    out.push({ no: i + 1, indent, body })
  }
  return out
}

/** 块标量指示符：|- | |+ >- > >+ 。 */
const BLOCK_SCALAR = /^[|>][+-]?\d*$/

/**
 * 解析一个引号标量或裸标量。
 * @param text - 已去掉注释的标量文本。
 * @returns 解析后的值。
 */
function parseScalar(text: string): YamlValue {
  const s = text.trim()
  if (s === '') return null
  // 自定义标签 `!!js <表达式>`：**必须求值**，不能按字符串收。
  //
  // cordis 的 YAML loader 用 js-yaml 注册了 `new Type('!!js', { kind: 'scalar' })`，
  // 所以 `disabled: !!js process.platform !== 'win32'` 在它手里是**布尔值**。
  // 但本包是自己 parse 之后把 JS 值直接交给 loader —— loader 不会再求值一次。
  // 收成字符串的后果是静默的：字符串是**真值**，于是那一行被当成 `disabled: true`。
  // （实测：role-impl 的 shell 组整组失效，`terminal-pwsh` 与 `tool-pwsh` 都被误禁用，
  //  两个角色的工具面因此逐字相同。）
  const jsTag = /^!!js\s+([\s\S]*)$/.exec(s)
  if (jsTag !== null) {
    const expr = (jsTag[1] ?? '').trim()
    if (expr === '') return null
    try {
      // 表达式来自角色自己的配置文件（与 cordis.yml 同一信任级），故在本进程内求值。
      return new Function(`return (${expr})`)() as YamlValue
    } catch {
      // 求值失败退回字符串：宁可让使用者看见原表达式，也不要静默变成真值。
      return expr
    }
  }
  // 其它自定义标签（`!!str` 一类）：按标量语义收下。
  const tagged = /^!![A-Za-z_][\w:.-]*\s*([\s\S]*)$/.exec(s)
  if (tagged !== null) {
    const rest = (tagged[1] ?? '').trim()
    if (rest === '') return null
    if (rest.startsWith("'") || rest.startsWith('"')) return String(parseScalar(rest) ?? '')
    if (rest === 'true') return true
    if (rest === 'false') return false
    if (rest === 'null' || rest === '~') return null
    return rest
  }
  if (s.startsWith("'")) {
    // 单引号：内部 '' 表示一个 '。
    const inner = s.replace(/^'/, '').replace(/'$/, '')
    return inner.replace(/''/g, "'")
  }
  if (s.startsWith('"')) {
    const inner = s.replace(/^"/, '').replace(/"$/, '')
    return inner.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  // 空流式集合。
  if (s === '[]') return []
  if (s === '{}') return {}
  // 简单流式列表：["a", "b"] / [a, b]
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (inner === '') return []
    return splitFlow(inner).map(part => parseScalar(part))
  }
  // 简单流式映射：{a: 1, b: 2}
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim()
    if (inner === '') return {}
    const map: { [key: string]: YamlValue } = {}
    for (const part of splitFlow(inner)) {
      const at = part.indexOf(':')
      if (at < 0) continue
      map[unquoteKey(part.slice(0, at))] = parseScalar(part.slice(at + 1))
    }
    return map
  }
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~') return null
  if (/^[+-]?\d+$/.test(s)) return Number(s)
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s)
  return s
}

/**
 * 按顶层逗号切分流式集合的内层文本，尊重引号与嵌套括号。
 * @param inner - 花括号/方括号内层的文本。
 * @returns 各元素的原文。
 */
function splitFlow(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (quote !== null) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) { parts.push(inner.slice(start, i)); start = i + 1 }
  }
  parts.push(inner.slice(start))
  return parts.map(p => p.trim()).filter(p => p !== '')
}

/**
 * 去掉映射键两端可能存在的引号。
 * @param key - 原文键。
 * @returns 去掉引号的键名。
 */
function unquoteKey(key: string): string {
  const s = key.trim()
  if (s.length >= 2 && ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')))) {
    return String(parseScalar(s) ?? '')
  }
  return s
}

/**
 * 找出一行里作为「键值分隔」的那个冒号。
 *
 * 只认「冒号后面是空白或行尾」的位置，这样 `process.platform !== 'win32'`
 * 与 `cordis:group` 里的冒号都不会被误判成键分隔。
 * @param body - 已去掉注释的正文。
 * @returns 冒号下标；没有键分隔时返回 -1。
 */
function findKeyColon(body: string): number {
  let quote: string | null = null
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quote !== null) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === ':' && (i === body.length - 1 || body[i + 1] === ' ' || body[i + 1] === '\t')) return i
  }
  return -1
}

/** 解析过程中的游标。 */
class Parser {
  private readonly lines: Line[]
  private i = 0

  /**
   * @param lines - 已切好的行数组。
   */
  constructor(lines: Line[]) {
    this.lines = lines
  }

  /** 跳过空行与注释行。 */
  private skipBlank(): void {
    while (this.i < this.lines.length && (this.lines[this.i] as Line).body === '') this.i++
  }

  /** 当前行；越界返回 undefined。 */
  private peek(): Line | undefined {
    return this.lines[this.i]
  }

  /**
   * 读一个块标量（`|-`、`|`、`>-`、`>`）的值。
   * @param headerIndent - 指示符所在行的缩进。
   * @param indicator - 指示符原文。
   * @returns 标量文本。
   */
  private readBlockScalar(headerIndent: number, indicator: string): string {
    const collected: string[] = []
    let blockIndent = -1
    while (this.i < this.lines.length) {
      const line = this.lines[this.i] as Line
      const raw = line.body
      if (raw === '') {
        // 块内的空行先留着，最后再决定怎么裁。
        collected.push('')
        this.i++
        continue
      }
      if (line.indent <= headerIndent) break
      if (blockIndent < 0) blockIndent = line.indent
      collected.push(' '.repeat(Math.max(0, line.indent - blockIndent)) + raw)
      this.i++
    }
    while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()
    const text = collected.join('\n')
    const folded = indicator.startsWith('>')
    const body = folded ? text.replace(/\n/g, ' ') : text
    const chomp = indicator.includes('-') ? '' : '\n'
    return body + chomp
  }

  /**
   * 解析一个块节点，锚点取**下一行自己的缩进**。
   *
   * 不收调用方给的缩进：调用方只知道「值应当比键更深」，而真正的块起点是下一行，
   * 它可能比那个下界深好几格（`config:` 在 2，它下面的 `prefix:` 在 4）。
   * @returns 解析出的值。
   */
  parseNode(): YamlValue {
    this.skipBlank()
    const first = this.peek()
    if (first === undefined) return null
    // 锚点一律取**下一行自己的缩进**，不取调用方给的 indent：调用方只知道
    // 「值应当比键更深」，而真正的块起点是下一行，它可能比那个下界深好几格
    // （`config:` 在 2，`prefix:` 在 4）。
    if (first.body.startsWith('- ') || first.body === '-') return this.parseSequence(first.indent)
    return this.parseMapping(first.indent)
  }

  /**
   * 解析一个块序列。
   * @param indent - `-` 所在列的缩进。
   * @returns 元素数组。
   */
  private parseSequence(indent: number): YamlValue[] {
    const items: YamlValue[] = []
    for (;;) {
      this.skipBlank()
      const line = this.peek()
      if (line === undefined || line.indent !== indent) break
      if (!(line.body === '-' || line.body.startsWith('- '))) break
      const rest = line.body === '-' ? '' : line.body.slice(2).trim()
      const restIndent = line.indent + (line.body.length - rest.length)
      this.i++
      if (rest === '') {
        // `-` 独占一行：值是下面缩进更深的块。
        items.push(this.parseNode())
        continue
      }
      const colon = findKeyColon(rest)
      if (colon < 0) {
        // 标量元素。
        items.push(parseScalar(rest))
        continue
      }
      // `- key: ...`：先起一个映射，随后的同名缩进行都并进这个映射。
      const item: { [key: string]: YamlValue } = {}
      this.consumeKeyValue(item, rest, colon, restIndent)
      this.fillMapping(item, restIndent)
      items.push(item)
    }
    return items
  }

  /**
   * 解析一个块映射。
   * @param indent - 键所在列的缩进。
   * @returns 映射对象。
   */
  private parseMapping(indent: number): YamlValue {
    const map: { [key: string]: YamlValue } = {}
    this.fillMapping(map, indent)
    return map
  }

  /**
   * 把同缩进的后续 `key: value` 行并进给定映射。
   * @param map - 目标映射。
   * @param indent - 键所在列的缩进。
   */
  private fillMapping(map: { [key: string]: YamlValue }, indent: number): void {
    for (;;) {
      this.skipBlank()
      const line = this.peek()
      if (line === undefined) break
      if (line.indent !== indent) break
      if (line.body.startsWith('- ') || line.body === '-') break
      const colon = findKeyColon(line.body)
      if (colon < 0) break
      this.i++
      this.consumeKeyValue(map, line.body, colon, indent)
    }
  }

  /**
   * 收下一个 `key: value`（值可能在同一行，也可能是下面更深的块）。
   * @param map - 目标映射。
   * @param body - 含键的正文。
   * @param colon - 键分隔冒号的下标。
   * @param indent - 键所在列的缩进。
   */
  private consumeKeyValue(
    map: { [key: string]: YamlValue },
    body: string,
    colon: number,
    indent: number,
  ): void {
    const key = unquoteKey(body.slice(0, colon))
    const value = body.slice(colon + 1).trim()
    if (value === '') {
      map[key] = this.parseNode()
      return
    }
    if (BLOCK_SCALAR.test(value)) {
      map[key] = this.readBlockScalar(indent, value)
      return
    }
    map[key] = parseScalar(value)
  }
}

/**
 * 解析一份 YAML 文本。
 * @param source - 文件内容。
 * @returns 顶层值（这三个文件都是数组）。空文件返回 null。
 */
export function parseYaml(source: string): YamlValue {
  const lines = toLines(source)
  const firstIndex = lines.findIndex(l => l.body !== '')
  if (firstIndex < 0) return null
  return new Parser(lines).parseNode()
}

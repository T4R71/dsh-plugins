/**
 * A small, self-contained YAML reader for the rule file's own grammar.
 *
 * WHY THIS EXISTS. The rules file is authored by hand, and YAML is what a human
 * hand-authors. But this package must not depend on a YAML library: measured on
 * this machine, `js-yaml` and `yaml` are BOTH unresolvable from every place
 * this plugin runs — see `src/rules.ts` and the README for the probe and its
 * output. Declaring `js-yaml` as a dependency would therefore mean either a
 * third-party runtime dependency inside the host process, or a rule file whose
 * format depends on an install that may not have happened.
 *
 * So the rule file's YAML is parsed by this module instead. It is NOT a YAML
 * implementation and does not claim to be: it accepts exactly the constructs the
 * documented rule-file schema uses, and REFUSES everything else by name rather
 * than guessing. A hand-edited file that strays outside the subset gets a
 * sentence naming the line, not a silently different rule set.
 *
 * SUPPORTED — and this list is exhaustive:
 *   - block mappings, nested by indentation (2 spaces per level, spaces only)
 *   - block sequences (`- ` items), including sequences of mappings
 *   - flow sequences `[a, b]` and flow mappings `{a: b}` on one line
 *   - plain scalars, single-quoted scalars, double-quoted scalars
 *   - block scalars `|`, `|-`, `|+`, `>`, `>-`, `>+`, with the chomping and

 *     indentation indicators in either order (`|6-`, `|4-`), READ AS LITERAL
 *     TEXT: blank lines and `#`-starting lines inside a body are content, not
 *     layout and not comments. A header outside that grammar is REFUSED by name
 *     (`|++`, `|2-3`, `|0`, `|22`) rather than parsed as an empty body.
 *   - comment lines (`#`) anywhere a line break is allowed
 *   - `true`/`false`/`null`/`~` and integers/floats as scalars
 *
 * NOT SUPPORTED, each refused with its own message: tabs for indentation,
 * anchors and aliases (`&`, `*`), tags (`!`), merge keys, multi-document
 * streams (`---`), flow collections spanning lines, and duplicate keys.
 *
 * @module @t4r71/dsh-prompt-plan/yaml
 */

/** A parse failure: the sentence to show, and the 1-based line it points at. */
export class YamlSubsetError extends Error {
  /** 1-based source line the failure is attributed to. */
  readonly line: number
  /**
   * @param message - the sentence explaining what is not supported or is malformed.
   * @param line - 1-based source line.
   */
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`)
    this.name = 'YamlSubsetError'
    this.line = line
  }
}

/** One physical line with its indentation and content resolved. */
interface Line {
  readonly number: number
  readonly indent: number
  readonly content: string
}

/**
 * One RAW physical line: its number and its text exactly as written.
 *
 * The raw list exists for exactly one reason, and it is the reason this module
 * was rewritten: a BLOCK SCALAR is literal text. Blank lines inside it are
 * content, and a line beginning with `#` inside it is content too — neither is
 * "an empty line" or "a comment", because the block scalar's header turned the
 * region into a string. {@link significantLines} necessarily erases both, so a
 * block-scalar body can never be read back out of the significant list; it is
 * read out of this one instead. Measured before the fix: a 1977-character
 * persona round-tripped through a block scalar came back 1924 characters long,
 * with no error.
 *
 * `text` is `null` only for a line that is empty or comment-only at top level —
 * that is, a line the significant pass drops. A line inside a block scalar is
 * never consulted here; the block reader takes raw text verbatim.
 */
interface RawLine {
  readonly number: number
  readonly text: string | null
}

/**
 * A line that is empty or nothing but whitespace.
 *
 * NOT "empty or a comment". An earlier revision wrote `/^\s*(?:#.*)?$/` here,
 * which also matches a comment line — and the raw list therefore recorded every
 * `#`-starting line as "no text", so a block scalar above it read the line as a
 * blank. That is exactly the silent loss this module was rewritten to remove,
 * reproduced once more while building it. A comment line now keeps its text in
 * the raw list and is dropped only from the significant one.
 */
const BLANK_LINE = /^\s*$/

/**
 * Measure every line of the file: which are significant, and the raw text of all.
 *
 * A `#` starts a comment only when it is at the start of the content or follows
 * whitespace; a `#` inside a plain scalar is part of it, matching YAML's own
 * rule and keeping section names like `tool:pty#1` intact. That rule is why a
 * block scalar's `#` lines cannot be recovered from this pass: to the pass they
 * are comments, indistinguishable from a comment that follows the block.
 * @param source - the whole file.
 * @returns the significant lines in order, and the raw lines in order.
 */
function significantLines(source: string): Lines {
  const lines: Line[] = []
  const raw = source.split(/\r\n|\n|\r/)
  const rawLines: RawLine[] = []
  for (let index = 0; index < raw.length; index += 1) {
    const text = raw[index] ?? ''
    if (BLANK_LINE.test(text)) {
      rawLines.push({ number: index + 1, text: null })
      continue
    }
    const indentMatch = /^[ ]*/.exec(text)
    const indent = indentMatch === null ? 0 : indentMatch[0].length
    const afterIndent = text.slice(indent)
    if (afterIndent.startsWith('\t')) {
      throw new YamlSubsetError('tab indentation is not supported; use spaces', index + 1)
    }
    // The RAW text is kept for every non-blank line, comment or not: a comment
    // line here may be literal content of a block scalar above it. An earlier
    // revision stored `text: null` for comment-only lines, and every
    // `#`-starting line inside a block scalar was therefore read as a blank line
    // — a silent 53-character loss on the 1977-character persona, reproduced
    // while building this. The significant view strips the comment; the raw view
    // does not.
    rawLines.push({ number: index + 1, text })
    const content = stripComment(afterIndent)
    if (content.trim().length === 0) continue
    lines.push({ number: index + 1, indent, content })
  }
  return { lines, raw: rawLines }
}

/** Both views of one document: the significant lines and the untouched raw lines. */
interface Lines {
  readonly lines: Line[]
  readonly raw: readonly RawLine[]
}

/** Remove a trailing comment from one line's content, respecting quotes. */
function stripComment(text: string): string {
  let quote: '"' | "'" | undefined
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quote === '"') {
      if (character === '\\') index += 1
      else if (character === '"') quote = undefined
      continue
    }
    if (quote === "'") {
      if (character === "'") {
        if (text[index + 1] === "'") index += 1
        else quote = undefined
      }
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '#' && (index === 0 || /\s/.test(text[index - 1] ?? ''))) {
      return text.slice(0, index)
    }
  }
  return text
}

/** Split `key: value` at the top-level colon, respecting quotes and flow collections. */
function splitKey(content: string, line: number): { key: string; rest: string } | undefined {
  let depth = 0
  let quote: '"' | "'" | undefined
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    if (quote === '"') {
      if (character === '\\') index += 1
      else if (character === '"') quote = undefined
      continue
    }
    if (quote === "'") {
      if (character === "'") {
        if (content[index + 1] === "'") index += 1
        else quote = undefined
      }
      continue
    }
    if (character === '"' || character === "'") { quote = character; continue }
    if (character === '[' || character === '{') { depth += 1; continue }
    if (character === ']' || character === '}') { depth -= 1; continue }
    if (character === ':' && depth === 0) {
      const next = content[index + 1]
      if (next !== undefined && !/\s/.test(next)) {
        throw new YamlSubsetError(`a mapping key must be followed by ": " (found ${JSON.stringify(content.slice(0, index + 2))})`, line)
      }
      return { key: unquote(content.slice(0, index).trim(), line), rest: content.slice(index + 1).trim() }
    }
  }
  return undefined
}

/** Reject the YAML constructs this subset deliberately does not implement. */
function refuseUnsupported(value: string, line: number): void {
  if (value.startsWith('&')) throw new YamlSubsetError('anchors ("&") are not supported', line)
  if (value.startsWith('*')) throw new YamlSubsetError('aliases ("*") are not supported', line)
  if (value.startsWith('!')) throw new YamlSubsetError('tags ("!") are not supported', line)
  if (value === '<<') throw new YamlSubsetError('merge keys ("<<") are not supported', line)
}

/** Unquote a scalar if it is quoted; otherwise return it as written. */
function unquote(value: string, line: number): string {
  // An opening quote with no matching close is MALFORMED, not a plain scalar.
  // The old code only looked at a quoted value when both ends were quotes, so
  // `a: "x` parsed as the literal three-character string `"x` — accepted,
  // wrong, and silent. Measured while building this; refused now.
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) {
      throw new YamlSubsetError('unterminated double-quoted scalar', line)
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new YamlSubsetError('unterminated single-quoted scalar', line)
    }
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new YamlSubsetError(`unterminated or malformed double-quoted scalar: ${reason}`, line)
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/** Interpret a plain scalar: booleans, null, numbers, or the string itself. */
function scalar(value: string): unknown {
  if (value === '' || value === '~' || value === 'null') return null
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10)
  if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value)
  return value
}

/** The indicator and chomping a block-scalar header spells out. */
interface BlockHeader {
  /** The style indicator: literal (`|`) or folded (`>`). */
  readonly indicator: '|' | '>'
  /** The chomping indicator, defaulted to `clip` when the header omits one. */
  readonly chomp: 'strip' | 'clip' | 'keep'
}

/**
 * Classify a mapping value that begins with `|` or `>`.
 *
 * The header grammar accepted here is exactly
 * `[|>] [chomp] [indent] | [|>] [indent] [chomp]` with `chomp` one of `+ -`,
 * `indent` a single digit 1-9, and each appearing at most once — the standard
 * spelling, including `|6-` and `|4-`.
 *
 * Everything else that begins with an indicator character is REFUSED unless it
 * cannot be a header at all (it contains a character outside the header
 * alphabet, which makes it an ordinary plain scalar in YAML too, e.g. `|x`).
 * The refusal matters more than the acceptance: a header this reader did not
 * understand used to parse as an EMPTY body and silently drop the text under it.
 * `|++`, `|2-3`, `|0`, `|-` with a stray character are all named errors now.
 * @param value - the mapping value, trimmed.
 * @param line - the source line, for the diagnostic.
 * @returns the header, or `plain` when this is an ordinary scalar.
 * @throws {YamlSubsetError} when the value looks like a header but is not one this reader implements.
 */
function blockHeaderKind(value: string, line: number): BlockHeader | 'plain' {
  const indicator = value[0]
  if (indicator !== '|' && indicator !== '>') return 'plain'
  const rest = value.slice(1)
  // NOTE the character class order: `[+-0-9]` would be the RANGE "+".."0" — it
  // matches "," "." "/" and NOT the digits 1-9, so `|2-` and `|6-` fell
  // through to "plain" and their bodies were then read as document structure.
  // Measured while building this. `[0-9+-]` is the set that was meant.
  if (!/^[0-9+-]*$/.test(rest)) return 'plain'
  const chomp = rest.includes('-') ? 'strip' : rest.includes('+') ? 'keep' : 'clip'
  const digits = [...rest].filter(character => character >= '0' && character <= '9')
  const signs = [...rest].filter(character => character === '+' || character === '-')
  if (signs.length > 1 || digits.length > 1) {
    throw new YamlSubsetError(`unsupported block scalar header ${JSON.stringify(value)}: at most one chomping indicator ("+" or "-") and one indentation indicator are allowed`, line)
  }
  const digit = digits[0]
  if (digit === '0') {
    throw new YamlSubsetError('an explicit block scalar indentation indicator must be 1-9 ("0" is not an indentation level)', line)
  }
  if (digit !== undefined && rest.indexOf(digit) < rest.length - 1 && signs.length === 0 && rest.length > 1) {
    throw new YamlSubsetError(`unsupported block scalar header ${JSON.stringify(value)}`, line)
  }
  if (rest.length > 2) {
    throw new YamlSubsetError(`unsupported block scalar header ${JSON.stringify(value)}`, line)
  }
  return { indicator, chomp }
}

/**
 * Fold a block scalar body (`>`) into its value.
 *
 * YAML's folding rules, implemented exactly for the shapes this reader accepts:
 * a line break between two lines of the same indentation becomes a SPACE; a
 * blank line becomes a NEWLINE, and each further blank line adds one more (so
 * `a\n\n\nb` folds to `a\n\nb`); a line that is MORE indented than the body
 * block keeps its break, because that is how YAML spells a literal line inside a
 * folded scalar. Truly empty lines carry no content and therefore take no part
 * in deciding "more indented".
 * @param body - the body's lines, already de-indented by the block indentation.
 * @returns the folded text, without the trailing chomping decision.
 */
function foldBlockBody(body: readonly string[]): string {
  let result = ''
  let pendingBreaks = 0
  let hasContent = false
  for (const line of body) {
    if (line.length === 0) {
      pendingBreaks += 1
      continue
    }
    if (pendingBreaks === 0) {
      if (hasContent) result += ' '
    } else if (pendingBreaks === 1) {
      result += '\n'
    } else {
      result += '\n'.repeat(pendingBreaks - 1)
    }
    pendingBreaks = 0
    result += line
    hasContent = true
  }
  // A trailing run of blank lines is kept, and the chomping indicator decides
  // what happens to it: \`clip\` and \`strip\` remove it, \`keep\` turns it into breaks.
  if (pendingBreaks > 0 && hasContent) result += '\n'.repeat(pendingBreaks)
  return result
}

/** Parser state: the significant lines, the cursor into them, and the raw lines. */
class Parser {
  /** Index into {@link lines} of the line the parser will look at next. */
  private cursor = 0
  /**
   * NOTE ON HOW THE TWO LINE VIEWS ARE KEPT APART. There is deliberately no
   * field tracking "where the raw list has got to": an earlier revision kept one
   * and failed, because a Cordis proxy on this service handed one method a
   * different receiver than another, so "the same field" read as two different
   * values inside a single call chain. A block scalar's body is located by
   * looking the HEADER's own raw index up, from scratch, every time, and the
   * significant cursor is then advanced past exactly the lines that body took.
   */

  /**
   * @param lines - the significant lines of the document.
   * @param raw - every physical line, for block-scalar bodies.
   */
  // Not `readonly`: `sequence` rewrites the line list in place when a
  // `- key: value` dash line is re-framed as the first key of a nested mapping.
  constructor(private lines: Line[], private readonly raw: readonly RawLine[]) {}

  /** @returns the next line, or undefined at end of input. */
  peek(): Line | undefined {
    return this.lines[this.cursor]
  }

  /**
   * @param number - a source line number.
   * @returns its index in the raw list, or -1 when the list carries no such line.
   */
  private rawIndexOf(number: number): number {
    // Raw line numbers are 1-based positions in this very list, so this is an
    // identity check with a guard: a mismatch can only mean the number came from
    // a different list.
    const at = number - 1
    return this.raw[at]?.number === number ? at : -1
  }

  /** Consume and return the next line. */
  take(): Line {
    const line = this.lines[this.cursor]
    if (line === undefined) throw new YamlSubsetError('unexpected end of document', this.lastLine())
    this.cursor += 1
    return line
  }

  /** @returns the last consumed line's number, for end-of-input messages. */
  private lastLine(): number {
    return this.lines[this.lines.length - 1]?.number ?? 1
  }

  /**
   * Parse one node at the given indentation.
   * @param indent - the indentation the node's content must sit at.
   * @returns the parsed value.
   */
  node(indent: number): unknown {
    const line = this.peek()
    if (line === undefined) return null
    if (line.indent < indent) return null
    if (line.content === '-' || line.content.startsWith('- ')) return this.sequence(line.indent)
    if (splitKey(line.content, line.number) !== undefined) return this.mapping(line.indent)
    // A bare scalar document (the rule file's top level is always a mapping, but
    // a nested value may legitimately be a single line).
    this.take()
    return this.value(line.content, line.number)
  }

  /** Parse a block sequence whose items sit at `indent`. */
  private sequence(indent: number): unknown[] {
    const items: unknown[] = []
    for (;;) {
      const line = this.peek()
      if (line === undefined || line.indent !== indent) break
      if (!(line.content === '-' || line.content.startsWith('- '))) break
      const rest = line.content === '-' ? '' : line.content.slice(2).trim()
      if (rest.length === 0) {
        this.take()
        items.push(this.node(indent + 1))
        continue
      }
      // `- key: value` opens a mapping whose first key sits on the dash line.
      // The dash line is REWRITTEN IN PLACE into that first key and left for
      // `mapping` to consume as usual, which keeps the cursor meaningful; an
      // earlier revision took the line first and then rewound the cursor, and on
      // a Cordis proxy that rewind did not stick (measured), so the first key of
      // every `- key: value` item was silently dropped — `id` vanished from
      // every rule in the file.
      if (splitKey(rest, line.number) !== undefined) {
        const inner = indent + (line.content.length - line.content.slice(2).trimStart().length)
        const at = this.cursor
        this.lines = [
          ...this.lines.slice(0, at),
          { number: line.number, indent: inner, content: rest },
          ...this.lines.slice(at + 1),
        ]
        items.push(this.mapping(inner))
        continue
      }
      this.take()
      items.push(this.value(rest, line.number))
    }
    return items
  }
  /** Parse a block mapping whose keys sit at `indent`. */
  private mapping(indent: number): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (;;) {
      const line = this.peek()
      if (line === undefined || line.indent !== indent) break
      const split = splitKey(line.content, line.number)
      if (split === undefined) break
      this.take()
      // The merge key is refused on the KEY side too: `refuseUnsupported` only
      // sees the value, so `<<: other` used to parse as an ordinary key named
      // `<<` — which is not a merge, and not what the author wrote.
      if (split.key === '<<') throw new YamlSubsetError('merge keys ("<<") are not supported', line.number)
      refuseUnsupported(split.rest, line.number)
      if (Object.hasOwn(result, split.key)) {
        throw new YamlSubsetError(`duplicate mapping key ${JSON.stringify(split.key)}`, line.number)
      }
      if (split.rest.length === 0) {
        result[split.key] = this.node(indent + 1)
        continue
      }
      if (split.rest.startsWith('|') || split.rest.startsWith('>')) {
        const kind = blockHeaderKind(split.rest, line.number)
        if (kind === 'plain') {
          // `|foo` / `>foo`: a plain scalar that merely begins with the
          // indicator character. YAML reads it as a string; so does this reader,
          // and the value falls through to `value` below.
        } else {
          result[split.key] = this.blockScalar(split.rest, indent, line.number)
          continue
        }
      }
      result[split.key] = this.value(split.rest, line.number)
    }
    return result
  }

  /**
   * Read a block scalar body introduced by `header` at mapping indentation `indent`.
   *
   * THE BODY IS READ FROM THE RAW LINE LIST, NEVER FROM THE SIGNIFICANT ONE.
   * That is the whole fix: the significant pass has already deleted every blank
   * line and every `#`-starting line, so a body read from it loses exactly those
   * bytes and says nothing. Here every physical line from the header to the
   * first line that ends the block is literal content:
   *
   *   - a blank line is a newline in the content, never a terminator;
   *   - a line beginning with `#` is content, not a comment;
   *   - only a NON-BLANK line whose indentation is shallower than the body's ends
   *     the block.
   *
   * Trailing blank lines belong to the scalar and are resolved by the chomping
   * indicator, not discarded by the reader.
   *
   * KNOWN LIMIT, stated rather than hidden: a comment line at or beyond the body
   * indentation is kept as content (correct), and a comment line SHALLOWER than
   * the body is ALSO kept as content. Strict YAML would end the block at the
   * latter and drop the comment. Keeping it is the conservative direction — this
   * reader preserves text rather than silently dropping it — and the case cannot
   * arise in a rule file whose block scalars are the last member of their
   * mapping, which is how every documented example writes them.
   * @param header - the header token, already matched by the caller.
   * @param indent - the mapping indentation the header sits at.
   * @param headerLine - the header's source line. It is how the body is located
   *   in the raw list, and the fallback attribution when the body is empty.
   * @returns the scalar's value, chomped.
   */
  private blockScalar(header: string, indent: number, headerLine: number): string {
    const folded = header.startsWith('>')
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip'
    const explicit = /^[|>]([+-]?)(\d?)$/.exec(header)
    const declared = explicit === null || explicit[2] === '' || explicit[2] === undefined ? undefined : Number(explicit[2])
    let bodyIndent = declared === undefined ? -1 : indent + declared
    const body: string[] = []
    // Locate the header in the raw list from scratch — see {@link rawCursor}.
    const headerAt = this.rawIndexOf(headerLine)
    if (headerAt < 0) throw new YamlSubsetError(`internal: no raw line carries the block scalar header at source line ${String(headerLine)}`, headerLine)
    let index = headerAt + 1
    let last = headerAt
    while (index < this.raw.length) {
      const raw = this.raw[index]
      if (raw === undefined) break
      const text = raw.text ?? ''
      if (text.trim().length === 0) {
        // Blank, or comment-only. Before the first content line it decides
        // nothing (auto-detection ignores leading empty lines), so it is held
        // back; afterwards it is content.
        if (bodyIndent < 0) {
          index += 1
          continue
        }
        body.push('')
        last = index
        index += 1
        continue
      }
      const leading = /^[ ]*/.exec(text)?.[0].length ?? 0
      if (bodyIndent < 0) {
        if (leading <= indent) break
        bodyIndent = leading
      } else if (leading < bodyIndent) {
        break
      }
      body.push(text.slice(bodyIndent))
      last = index
      index += 1
    }
    // Everything up to and including `last` was taken from the raw list. The
    // significant cursor must now move past every significant line the body
    // consumed: a body line beginning with `#` IS in the significant list (the
    // pass stripped it to a comment and kept it as a line), so leaving the cursor
    // inside the body would re-parse the body as document structure.
    const bodyEnd = (this.raw[last]?.number ?? headerLine) + 1
    while (this.peek() !== undefined && (this.peek()?.number ?? 0) < bodyEnd) this.cursor += 1
    const joined = folded ? foldBlockBody(body) : body.join('\n')
    if (chomp === 'strip') return joined.replace(/\n+$/, '')
    if (chomp === 'keep') return joined + '\n'
    return joined.length === 0 ? '' : joined + '\n'
  }
  /** Parse an inline value: a flow collection, or a plain scalar. */
  private value(text: string, line: number): unknown {
    refuseUnsupported(text, line)
    if (text.startsWith('[') || text.startsWith('{')) return parseFlow(text, line)
    return scalar(unquote(text, line))
  }
}

/**
 * Parse a one-line flow collection.
 * @param text - the text beginning with `[` or `{`.
 * @param line - the source line, for errors.
 * @returns the parsed array or object.
 */
function parseFlow(text: string, line: number): unknown {
  let index = 0

  /** Skip inline whitespace. */
  const skip = (): void => { while (index < text.length && /\s/.test(text[index] ?? '')) index += 1 }

  /** Read one value at the cursor. */
  const readValue = (): unknown => {
    skip()
    const character = text[index]
    if (character === '[' || character === '{') {
      const open = character
      const close = open === '[' ? ']' : '}'
      index += 1
      if (open === '[') {
        const items: unknown[] = []
        skip()
        if (text[index] === close) { index += 1; return items }
        for (;;) {
          items.push(readValue())
          skip()
          if (text[index] === ',') { index += 1; continue }
          if (text[index] === close) { index += 1; return items }
          throw new YamlSubsetError(`flow sequence is missing "," or "${close}"`, line)
        }
      }
      const entries: Record<string, unknown> = {}
      skip()
      if (text[index] === close) { index += 1; return entries }
      for (;;) {
        skip()
        const start = index
        let quote: string | undefined
        while (index < text.length) {
          const current = text[index]
          if (quote !== undefined) {
            if (current === '\\' && quote === '"') { index += 2; continue }
            if (current === quote) quote = undefined
            index += 1
            continue
          }
          if (current === '"' || current === "'") { quote = current; index += 1; continue }
          if (current === ':') break
          index += 1
        }
        if (text[index] !== ':') throw new YamlSubsetError('flow mapping entry is missing ":"', line)
        const key = unquote(text.slice(start, index).trim(), line)
        index += 1
        entries[key] = readValue()
        skip()
        if (text[index] === ',') { index += 1; continue }
        if (text[index] === close) { index += 1; return entries }
        throw new YamlSubsetError(`flow mapping is missing "," or "${close}"`, line)
      }
    }
    if (character === '"' || character === "'") {
      const quote = character
      const start = index
      index += 1
      while (index < text.length) {
        const current = text[index]
        if (quote === '"' && current === '\\') { index += 2; continue }
        if (current === quote) {
          if (quote === "'" && text[index + 1] === "'") { index += 2; continue }
          index += 1
          return scalar(unquote(text.slice(start, index), line))
        }
        index += 1
      }
      throw new YamlSubsetError('unterminated quoted scalar in a flow collection', line)
    }
    const start = index
    while (index < text.length && text[index] !== ',' && text[index] !== ']' && text[index] !== '}') index += 1
    return scalar(text.slice(start, index).trim())
  }

  const result = readValue()
  skip()
  if (index !== text.length) {
    throw new YamlSubsetError(`trailing text after a flow collection: ${JSON.stringify(text.slice(index))}`, line)
  }
  return result
}

/**
 * Parse the rule file's YAML subset.
 * @param source - the file's text.
 * @returns the parsed document.
 * @throws {YamlSubsetError} when the document uses an unsupported construct or is malformed.
 */
export function parseYamlSubset(source: string): unknown {
  const { lines, raw } = significantLines(source)
  if (lines.length === 0) return null
  const first = lines[0]
  if (first === undefined) return null
  if (first.indent !== 0) throw new YamlSubsetError('the document must start at column 0', first.number)
  const parser = new Parser(lines, raw)
  const value = parser.node(0)
  const leftover = parser.peek()
  if (leftover !== undefined) {
    throw new YamlSubsetError(`unexpected content at indentation ${leftover.indent}: ${JSON.stringify(leftover.content)}`, leftover.number)
  }
  return value
}

/**
 * Strip whole tool declarations out of the `tools:sdk` prompt section, while
 * leaving the tools CALLABLE.
 *
 * ## Why this is safe, and where the danger actually is
 *
 * The sandbox's `tools` binding comes from `registry.schemas(exec.agent)`
 * (`packages/core/tools/src/index.ts:1240-1242`), which is the view of VISIBLE
 * tools. The `tools:sdk` section is a separate rendering of the same view
 * (`renderToolsSdk`, `packages/core/tools/src/ts-types.ts:297-317`). Removing
 * TEXT from one section therefore leaves `await tools.<name>(args)` working,
 * because the binding never reads this text.
 *
 * The mirror image is the trap: anything that touches VISIBILITY — disable,
 * deny, `tools.restrict`, a tool filter — removes the binding too, and the model
 * then gets `TypeError: tools.<name> is not a function`. This module only ever
 * rewrites text, and it never consults or mutates the registry.
 *
 * ## The two declarations of one tool, and how each is found
 *
 * `renderToolsSdk` emits, for every tool in lexicographic order:
 *
 *   interface ToolArgsMap {          <- and ToolOutputMap, same shape
 *     <doc lines, one per description line>
 *     <name>: <type>;                <- exactly this tool's member
 *   }
 *
 * A tool has exactly TWO members in the section, one in each map. The anchor is
 * the member DECLARATION line — `^  <name>:` with exactly the renderer's two
 * spaces of indent — and a member runs to the next line at that same indent, or
 * to the map's closing brace. Doc lines and nested braces travel with the member
 * being removed, because they belong to whatever follows them.
 *
 * ## The refusal discipline
 *
 * Three independent checks, and any failure returns the input text UNCHANGED:
 *
 *   1. Structure — every `{ `/`(`/`[` outside a string or comment is paired, and
 *      the map bodies are found by brace matching rather than by a regex.
 *   2. Accounting — the characters removed must equal, exactly, the sum of the
 *      per-tool lengths measured before the removal.
 *   3. Re-read — the remainder must still brace-balance and must still carry the
 *      same number of members per map, minus the ones removed.
 *
 * A partial strip is worse than no strip: it would publish a `tools:sdk` text
 * that declares half a tool. So the failure mode is always "return the whole
 * text as it was", never "strip what could be stripped".
 *
 * @module @t4r71/dsh-prompt-plan/strip
 */

/** The section this module operates on. */
export const TOOLS_SDK_SECTION = 'tools:sdk'

/** The map names the renderer emits, in the order it emits them. */
export const SDK_MAPS = ['ToolArgsMap', 'ToolOutputMap'] as const

/** One tool's removal, as measured before the removal. */
export interface StrippedTool {
  /** The tool name, as written in the map. */
  readonly name: string
  /** Declaration lines removed from `ToolArgsMap`, including its doc lines. */
  readonly argsChars: number
  /** Declaration lines removed from `ToolOutputMap`. */
  readonly outputChars: number
}

/** A refusal, with the sentence naming what could not be established. */
export interface StripRefusal {
  /** Which check refused. */
  readonly check: 'structure' | 'accounting' | 'reread'
  /** One sentence, for the log line. */
  readonly problem: string
}

/** What one strip produced. */
export type StripOutcome =
  | { readonly ok: true; readonly text: string; readonly removed: readonly StrippedTool[]; readonly removedChars: number; readonly missing: readonly string[] }
  | { readonly ok: false; readonly refusal: StripRefusal }

/** One located map body inside the section text. */
interface MapBody {
  /** The line index of the `interface <name> {` line. */
  readonly headerLine: number
  /** The line index of the body's first line; equals the closing brace when empty. */
  readonly firstBodyLine: number
  /** The line index of the closing brace line. */
  readonly closingLine: number
}

/** A member's line span, inclusive on both ends. */
interface MemberSpan {
  readonly name: string
  readonly startLine: number
  readonly endLine: number
  readonly chars: number
}

/**
 * Whether one line's braces and brackets nest, ignoring strings and comments.
 *
 * A line-oriented scanner rather than a regex, because the generated TypeScript
 * carries string literals (`"ToolCallError"`, doc prose with braces) that a
 * regex cannot tell from structure. Line comments and block comments are tracked
 * across lines by the caller through {@link ScanState}.
 */
interface ScanState {
  /** Carets accumulated across lines while inside a `/* … *​/` comment. */
  inBlockComment: boolean
}

/**
 * Scan one line's structural characters.
 * @param line - the line's text.
 * @param state - the carried block-comment flag; mutated.
 * @returns the net nesting delta of the line, and whether it ended inside a string.
 */
function scanLine(line: string, state: ScanState): { delta: number; openString: boolean } {
  let delta = 0
  let quote = ''
  let index = 0
  while (index < line.length) {
    const char = line[index] ?? ''
    if (state.inBlockComment) {
      if (char === '*' && line[index + 1] === '/') {
        state.inBlockComment = false
        index += 2
        continue
      }
      index += 1
      continue
    }
    if (quote !== '') {
      if (char === '\\') {
        index += 2
        continue
      }
      if (char === quote) quote = ''
      index += 1
      continue
    }
    if (char === '/' && line[index + 1] === '*') {
      state.inBlockComment = true
      index += 2
      continue
    }
    if (char === '/' && line[index + 1] === '/') break
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      index += 1
      continue
    }
    if (char === '{' || char === '(' || char === '[') delta += 1
    else if (char === '}' || char === ')' || char === ']') delta -= 1
    index += 1
  }
  return { delta, openString: quote !== '' }
}

/** The whole text's brace balance, as a structural sanity check. */
function balanced(text: string): boolean {
  const state: ScanState = { inBlockComment: false }
  let depth = 0
  for (const line of text.split('\n')) {
    const scanned = scanLine(line, state)
    depth += scanned.delta
    if (depth < 0) return false
  }
  return depth === 0 && !state.inBlockComment
}

/**
 * Locate one map's body by brace matching, from its `interface` header line.
 *
 * The header is matched on the exact line the renderer emits
 * (``interface ToolArgsMap {``), so a section that does not carry the
 * renderer's shape is refused instead of being mis-parsed.
 * @param lines - the section text's lines.
 * @param mapName - the map's interface name.
 * @returns the body's line span, or the sentence explaining why it is not there.
 */
function locateMap(lines: readonly string[], mapName: string): MapBody | string {
  const header = `interface ${mapName} {`
  const headerIndex = lines.findIndex(line => line === header)
  if (headerIndex < 0) return `no line equal to ${JSON.stringify(header)}`
  const state: ScanState = { inBlockComment: false }
  let depth = 0
  for (let index = headerIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const scanned = scanLine(line, state)
    if (scanned.openString) return `line ${index + 1} ends inside a string literal`
    depth += scanned.delta
    if (index === headerIndex) continue
    if (depth === 0) {
      if (line.trim() !== '}') return `the ${mapName} body closes on line ${index + 1}, which is not a lone brace`
      return { headerLine: headerIndex, firstBodyLine: headerIndex + 1, closingLine: index }
    }
  }
  return `the ${mapName} body never closes`
}

/**
 * The renderer's MEMBER anchor: a member declaration line is `<name>:` at exactly
 * two spaces of indent, which is the shape `renderToolsSdk` emits for a tool.
 *
 * It is ONE constant rather than two literals because it is now read in two
 * places — {@link membersOf} finds members by it, and the tool-description test
 * below classifies a comment block by it — and two copies of an anchor are an
 * invitation for the two to drift apart.
 */
const MEMBER_LINE = /^  ([^\s:]+):/

/**
 * Whether the next non-blank line at or after `from` is a member declaration.
 *
 * This is the whole tool-description test: the renderer puts a tool's doc block
 * directly above its member line, and a field's doc block directly above a
 * deeper-indented field line, so "what follows the block" separates the two
 * without a second, invented rule.
 * @param lines - the section text's lines.
 * @param from - the first line that may carry the following declaration.
 * @returns true when the following non-blank line is `  <name>:`.
 */
function nextNonBlankIsMember(lines: readonly string[], from: number): boolean {
  let index = from
  while (index < lines.length && (lines[index] ?? '').trim().length === 0) index += 1
  return MEMBER_LINE.test(lines[index] ?? '')
}

/**
 * One map's member ranges, keyed by the member name on the declaration line.
 *
 * The anchor is the renderer's own indentation: a member line is `  <name>:`, at
 * exactly two spaces. Anything deeper belongs to the member above it — which is
 * why the scan is over lines and ranges, not over a regular expression.
 * @param lines - the section text's lines.
 * @param body - the located map body.
 * @returns one span per member, in file order, with its name.
 */
function membersOf(lines: readonly string[], body: MapBody): MemberSpan[] {
  const spans: MemberSpan[] = []
  const pattern = MEMBER_LINE
  let index = body.firstBodyLine
  while (index < body.closingLine) {
    const line = lines[index] ?? ''
    const matched = pattern.exec(line)
    // A non-member line before the first member can only be a doc line of the
    // member that follows it, so it is skipped without being claimed.
    if (matched === null) {
      index += 1
      continue
    }
    const name = matched[1] ?? ''
    // The member's DOC LINES sit above it and belong to it: the renderer emits
    // one doc line per description line of the tool. They are claimed here, by
    // walking back over contiguous doc/blank lines that no earlier member owns.
    let start = index
    while (start - 1 >= body.firstBodyLine) {
      const above = lines[start - 1] ?? ''
      if (above.trimStart().startsWith('/**') || above.trimStart().startsWith('*') || above.trimStart().startsWith('*/')) {
        start -= 1
        continue
      }
      break
    }
    // The member runs until its own TYPE closes. It is NOT enough to stop at the
    // next line that is not two-space indented: a member's type spans many lines
    // and carries nested braces of its own —
    //
    //   schedule_create: {
    //     /** … */
    //     at?: string | {
    //       date: string;
    //     };
    //   };
    //
    // — so the end is found by brace DEPTH, relative to the member's declaration
    // line. A blank line is never emitted inside a body, so one means malformed
    // input and is refused rather than guessed through.
    const depthState: ScanState = { inBlockComment: false }
    let depth = 0
    let end = index
    while (end < body.closingLine) {
      const candidate = lines[end] ?? ''
      if (end > index && candidate.length === 0) {
        return spans
      }
      const scanned = scanLine(candidate, depthState)
      if (scanned.openString) return spans
      depth += scanned.delta
      end += 1
      if (depth === 0) break
    }
    // A member whose type never closes would swallow the rest of the map; the
    // caller's re-read check catches the result, but refusing here keeps the
    // span list honest.
    if (depth !== 0) return spans
    spans.push({ name, startLine: start, endLine: end - 1, chars: 0 })
    index = end
  }
  return spans
}

/** Sum the character weight of one span, counting its trailing newline. */
function spanChars(lines: readonly string[], span: MemberSpan): number {
  let total = 0
  for (let index = span.startLine; index <= span.endLine; index += 1) {
    total += (lines[index] ?? '').length + 1
  }
  return total
}

/** What one strip attempt measured, whether or not it was applied. */
export interface StripAnalysis {
  /** One entry per tool found in BOTH maps, with its two declaration lengths. */
  readonly tools: readonly StrippedTool[]
  /**
   * Names requested that were absent from one or both maps. Absent is not an
   * error — a tool that is not visible in this assembly is simply not there.
   */
  readonly missing: readonly string[]
}

/**
 * Measure — and, unless `dryRun`, remove — the named tools' declarations.
 *
 * Total: every path returns, and every failure returns `ok: false` with the
 * sentence naming the failed check. The caller decides what to do with a
 * refusal; upstream (`applyTransformOp`) treats it as "return the text as it
 * was".
 * @param text - the `tools:sdk` section text for this scope.
 * @param names - the tool names whose declarations are to be removed.
 * @param dryRun - measure only; the returned text is then the input text.
 * @returns the outcome, or the refusal naming the failed check.
 */
export function stripToolDeclarations(text: string, names: readonly string[], dryRun: boolean): StripOutcome {
  try {
    if (names.length === 0) return { ok: true, text, removed: [], removedChars: 0, missing: [] }
    const lines = text.split('\n')
    const bodies: MapBody[] = []
    for (const mapName of SDK_MAPS) {
      const located = locateMap(lines, mapName)
      if (typeof located === 'string') return { ok: false, refusal: { check: 'structure', problem: `the ${mapName} interface could not be located: ${located}` } }
      bodies.push(located)
    }
    const argsBody = bodies[0] as MapBody
    const outputBody = bodies[1] as MapBody
    const argsMembers = membersOf(lines, argsBody)
    const outputMembers = membersOf(lines, outputBody)

    // Every requested name is looked up in BOTH maps. A name in one map only is
    // a shape this module refuses to guess about: removing half a tool is the
    // failure it exists to prevent.
    const tools: StrippedTool[] = []
    const missing: string[] = []
    const argsSpans: MemberSpan[] = []
    const outputSpans: MemberSpan[] = []
    for (const name of names) {
      const argsSpan = argsMembers.find(span => span.name === name)
      const outputSpan = outputMembers.find(span => span.name === name)
      if (argsSpan === undefined || outputSpan === undefined) {
        // Absent is NOT an error, and it is NOT silence either: the name is
        // carried out to the caller's report so a request that matched nothing
        // can be read off the operator's line. A dynamic list is expected to name
        // tools only some agents can see, so this is the normal case rather than
        // a fault — which is why it is a field and not a refusal.
        if (!missing.includes(name)) missing.push(name)
        continue
      }
      tools.push({
        name,
        argsChars: spanChars(lines, argsSpan),
        outputChars: spanChars(lines, outputSpan),
      })
      argsSpans.push(argsSpan)
      outputSpans.push(outputSpan)
    }
    const removedChars = tools.reduce((total, tool) => total + tool.argsChars + tool.outputChars, 0)

    if (dryRun) return { ok: true, text, removed: tools, removedChars, missing }

    const drop = new Set<number>()
    for (const span of [...argsSpans, ...outputSpans]) {
      for (let index = span.startLine; index <= span.endLine; index += 1) drop.add(index)
    }
    const kept = lines.filter((_line, index) => !drop.has(index))
    const stripped = kept.join('\n')

    // CHECK 2 — accounting. The removal is line-based, so the characters that
    // disappeared must be exactly the sum measured above. A difference means the
    // span arithmetic and the filter disagree, which is not a state to publish.
    const measured = text.length - stripped.length
    if (measured !== removedChars) {
      return { ok: false, refusal: { check: 'accounting', problem: `removal changed ${measured} characters but the per-tool sum is ${removedChars}` } }
    }

    // CHECK 3 — re-read. The remainder must still parse structurally, and each
    // map must still carry exactly the members it had minus the ones removed.
    if (!balanced(stripped)) {
      return { ok: false, refusal: { check: 'reread', problem: 'the stripped text no longer brace-balances' } }
    }
    const keptLines = stripped.split('\n')
    for (const [position, mapName] of SDK_MAPS.entries()) {
      const before = position === 0 ? argsMembers.length : outputMembers.length
      const removed = position === 0 ? argsSpans.length : outputSpans.length
      const relocated = locateMap(keptLines, mapName)
      if (typeof relocated === 'string') {
        return { ok: false, refusal: { check: 'reread', problem: `after stripping, the ${mapName} interface could not be re-located: ${relocated}` } }
      }
      const after = membersOf(keptLines, relocated).length
      if (after !== before - removed) {
        return { ok: false, refusal: { check: 'reread', problem: `after stripping, ${mapName} carries ${after} members where ${before - removed} were expected` } }
      }
    }
    // A name that was requested and measured must be gone from the text; a
    // remainder that still spells it as a member means the span was wrong.
    for (const tool of tools) {
      if (keptLines.some(line => line === `  ${tool.name}:` || line.startsWith(`  ${tool.name}: `))) {
        return { ok: false, refusal: { check: 'reread', problem: `${tool.name} still appears as a member of the stripped text` } }
      }
    }
    return { ok: true, text: stripped, removed: tools, removedChars, missing }
  } catch (error: unknown) {
    // The backstop, and the reason this module never throws into the waterfall:
    // the system prompt must assemble even when this pass is broken.
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, refusal: { check: 'structure', problem: `unexpected failure while stripping: ${reason}` } }
  }
}

/**
 * Measure the named tools without removing anything.
 * @param text - the `tools:sdk` section text.
 * @param names - the tool names to measure.
 * @returns the per-tool declaration lengths and the names that were absent.
 */
export function measureToolDeclarations(text: string, names: readonly string[]): StripAnalysis | StripRefusal {
  const outcome = stripToolDeclarations(text, names, true)
  if (!outcome.ok) return outcome.refusal
  return { tools: outcome.removed, missing: outcome.missing }
}

// ─────────────────────────────────────────────────────────────────────────────
// stripDocComments — the second text-only lever over the same section
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove every JSDoc comment block inside the two `tools` declaration maps,
 * keeping every type signature byte-for-byte.
 *
 * ## Why this is safe in exactly the same sense as `stripToolDeclarations`
 *
 * The sandbox's `tools` binding comes from the registry's VISIBLE-tool view; the
 * `tools:sdk` section is a separate RENDERING of that view. Comments live only in
 * the rendering. Nothing here consults or mutates the registry, so
 * `await tools.<name>(args)` keeps working — measured after the change.
 *
 * ## The refusal discipline
 *
 * A partial comment strip would publish half a declaration, so every failure
 * returns the input text UNCHANGED: structure (maps unlocatable, an unclosed
 * block), accounting (blocks located but nothing disappeared), reread (no brace
 * balance, or a changed member count).
 *
 * ## The two levels, and why the difference matters
 *
 * A tool's doc block is the only sentence saying WHAT A TOOL IS FOR; a field's doc
 * block only annotates something already named `path`, `dryRun`, `expect`. On the
 * real render the first is 21 blocks and the second is 95, so removing both throws
 * away the half a reader cannot reconstruct from the signature. {@link
 * DocStripOptions.keepToolDescriptions} therefore removes the FIELD blocks and
 * leaves the tool blocks exactly where the renderer put them.
 *
 * The two levels are told apart by the renderer's OWN anchor (see
 * {@link MEMBER_LINE}) rather than by a second rule: a block belongs to a tool
 * when the next non-blank line under it is a member declaration at exactly two
 * spaces of indent. A block whose next line is indented deeper — a FIELD of a
 * member — is a field block.
 *
 * @module @t4r71/dsh-prompt-plan/strip-doc-comments
 */

/**
 * What one comment strip measured, and what it removed.
 *
 * The four counts close an arithmetic an operator can check by hand:
 * `blocks - keptToolDescriptions - removedParamBlocks` is the number of TOOL
 * blocks that went, which is 0 in keep mode and `blocks - removedParamBlocks` in
 * the default mode.
 */
export interface DocStripReport {
  /**
   * Characters the pass removed — or, under `dryRun`, the characters it WOULD
   * remove. Measured in both modes by building the stripped text and measuring it,
   * because the number is the thing an operator decides on.
   */
  readonly removedChars: number
  /** Comment blocks located inside the two maps, kept or removed. */
  readonly blocks: number
  /** Blocks kept because they describe a TOOL. Always `0` unless `keepToolDescriptions`. */
  readonly keptToolDescriptions: number
  /** Blocks removed that describe a FIELD of a member rather than a tool. */
  readonly removedParamBlocks: number
  /** True when the pass only measured; the returned text is then the input text. */
  readonly dryRun: boolean
}

/** How {@link stripDeclarationComments} chooses between the two levels. */
export interface DocStripOptions {
  /**
   * Keep the block that describes a TOOL and remove only the blocks that describe
   * its FIELDS.
   *
   * A "tool" block is one whose next non-blank line is a member declaration at the
   * renderer's two spaces of indent (`^  <name>:`); everything else — a deeper
   * indent, or a field line such as `    id: string;` — is a field block. The test
   * is applied to both maps alike, with no special case for either.
   *
   * Default `false`: every block goes, byte for byte as before this option
   * existed.
   */
  readonly keepToolDescriptions?: boolean
}

/** The outcome of one comment strip. */
export type DocStripOutcome =
  | { readonly ok: true; readonly text: string; readonly report: DocStripReport }
  | { readonly ok: false; readonly refusal: StripRefusal }

/**
 * Measure — and, unless `dryRun`, remove — the comment blocks inside the maps.
 *
 * The DRY RUN is judged by the same three checks and reports the numbers a real
 * run would produce, because a measurement taken over a strip that would have
 * been REFUSED is a number an operator could act on, and that is the one thing
 * this module must never hand out. `removedChars` is therefore the real
 * measurement in both modes, and the returned text is the input text whenever
 * `dryRun`.
 * @param text - the `tools:sdk` section text.
 * @param dryRun - measure only; the returned text is then the input text.
 * @param options - {@link DocStripOptions}; omitted is "remove every block".
 * @returns the outcome, or the refusal naming the failed check.
 */
export function stripDeclarationComments(text: string, dryRun: boolean, options: DocStripOptions = {}): DocStripOutcome {
  try {
    const keepToolDescriptions = options.keepToolDescriptions === true
    const lines = text.split('\n')
    const bodies: MapBody[] = []
    for (const mapName of SDK_MAPS) {
      const located = locateMap(lines, mapName)
      if (typeof located === 'string') return { ok: false, refusal: { check: 'structure', problem: 'the ' + mapName + ' interface could not be located: ' + located } }
      bodies.push(located)
    }
    const inside = new Set<number>()
    for (const body of bodies) {
      for (let index = body.firstBodyLine; index < body.closingLine; index += 1) inside.add(index)
    }
    const drop = new Set<number>()
    let blocks = 0
    let keptToolDescriptions = 0
    let removedParamBlocks = 0
    let index = 0
    while (index < lines.length) {
      const line = lines[index] ?? ''
      if (!inside.has(index) || !line.includes('/*')) { index += 1; continue }
      const start = line.indexOf('/*')
      const onLine = line.indexOf('*/', start + 2)
      if (onLine !== -1) {
        const before = line.slice(0, start)
        const after = line.slice(onLine + 2)
        const ownLine = before.trim().length === 0 && after.trim().length === 0
        // TOOL LEVEL or FIELD LEVEL. A block that owns its line is classified by
        // what FOLLOWS it; a block that shares its line is classified by what is
        // left of that line once the block is gone — the same "next non-blank
        // content" question, asked of the only text that can answer it.
        const toolLevel = ownLine ? nextNonBlankIsMember(lines, index + 1) : MEMBER_LINE.test(before + after)
        blocks += 1
        if (keepToolDescriptions && toolLevel) {
          // KEPT means untouched: no rewrite, no drop, no reflow.
          keptToolDescriptions += 1
          index += 1
          continue
        }
        if (!toolLevel) removedParamBlocks += 1
        if (ownLine) drop.add(index)
        else lines[index] = (before + after).replace(/\s+$/, '')
        index += 1
        continue
      }
      let end = index
      while (end < lines.length && !(lines[end] ?? '').includes('*/')) end += 1
      if (end >= lines.length) return { ok: false, refusal: { check: 'structure', problem: 'a comment block opened at line ' + (index + 1) + ' never closes' } }
      for (let at = index; at <= end; at += 1) {
        if (!inside.has(at)) return { ok: false, refusal: { check: 'structure', problem: 'comment block at line ' + (index + 1) + ' leaves the declaration maps' } }
      }
      const toolLevel = nextNonBlankIsMember(lines, end + 1)
      blocks += 1
      if (keepToolDescriptions && toolLevel) {
        keptToolDescriptions += 1
      } else {
        if (!toolLevel) removedParamBlocks += 1
        // The block's OWN LINES go, newlines included: the drop is a filter over
        // the line array, never a blanking in place, so a removed block cannot
        // leave an empty line behind.
        for (let at = index; at <= end; at += 1) drop.add(at)
      }
      index = end + 1
    }
    // The removal is measured BEFORE the dry run returns, and by the same
    // arithmetic in both modes: the number an operator reads must be the number a
    // real run would produce.
    const stripped = lines.filter((_line, at) => !drop.has(at)).join('\n')
    const removedChars = text.length - stripped.length
    // CHECK 2 — accounting. Every block this mode DECIDED to remove must have
    // taken characters with it; keeping every block is a legitimate outcome (a
    // section whose only comments are tool descriptions), so the count that must
    // not be zero is the removal count, not the block count.
    const forRemoval = blocks - keptToolDescriptions
    if (removedChars <= 0 && forRemoval > 0) {
      return { ok: false, refusal: { check: 'accounting', problem: forRemoval + ' comment block(s) were located for removal but no characters disappeared' } }
    }
    if (!balanced(stripped)) {
      return { ok: false, refusal: { check: 'reread', problem: 'the comment-stripped text no longer brace-balances' } }
    }
    const keptLines = stripped.split('\n')
    for (const [position, mapName] of SDK_MAPS.entries()) {
      const relocated = locateMap(keptLines, mapName)
      if (typeof relocated === 'string') {
        return { ok: false, refusal: { check: 'reread', problem: 'after stripping comments, the ' + mapName + ' interface could not be re-located: ' + relocated } }
      }
      const beforeCount = membersOf(lines, bodies[position] as MapBody).length
      const afterCount = membersOf(keptLines, relocated).length
      if (afterCount !== beforeCount) {
        return { ok: false, refusal: { check: 'reread', problem: 'after stripping comments, ' + mapName + ' carries ' + afterCount + ' members where ' + beforeCount + ' were expected' } }
      }
    }
    const report: DocStripReport = { dryRun, removedChars, blocks, keptToolDescriptions, removedParamBlocks }
    // A dry run returns the INPUT text — never a middle ground, and never the
    // measured remainder: nothing was removed, and the report above says what
    // would have been.
    return { ok: true, text: dryRun ? text : stripped, report }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, refusal: { check: 'structure', problem: 'unexpected failure while stripping comments: ' + reason } }
  }
}

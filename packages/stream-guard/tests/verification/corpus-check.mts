/**
 * 终局语料复核：用**最终落盘**的 src/prefix.ts 对真实会话语料重跑。
 *
 * 要回答两件事：
 *   1. 误报 = 0 ？—— 健康 reasoning 块是否一个都不触发；
 *   2. 真死循环仍被抓住？—— 上一轮基线 17 个块是否仍然触发。
 *
 * 三个已知陷阱（本文件严格执行）：
 *   (1) 会话日志是**多帧 zstd**：按 magic 切帧、每帧 zstdDecompressSync，不是 inflateSync。
 *   (2) **绝不逐字符**喂 PrefixGuard —— 逐字符 O(n²)，实测 622 秒被中断。统一 64 字符分块。
 *   (3) reasoning 块路径 = e.type === 'assistant/message'
 *       && e.data.message.content[].type === 'reasoning' 的 .text。
 *
 * 本文件做两层验证：
 *   A. 真值层 —— 直接用 src/prefix.ts 的 PrefixGuard 跑全部块（64 字符分块）。
 *   B. 独立复核层 —— 按规则规格（`README.md` 实现说明 + `src/prefix.ts`）独立重写一遍
 *      clause 扫描器，与 A 的 (触发与否, 触发偏移, 计数) 逐块对齐；同时产出**每个接头**的
 *      偏移 / 表项 / 原文，作为人工判定真死循环 vs 误报的证据。
 *
 * 跑法：npx tsx packages/guard/stream-guard/tests/verification/corpus-check.mts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import {
  PrefixGuard,
  PREFIX_TOLERANCE,
  PREFIX_COUNT_LIMIT,
  LETME_MAX,
  INTENT_PREFIXES,
  FILLER_WORDS,
} from '../src/prefix.ts'

const ROOT = join(process.env['USERPROFILE'] ?? '', '.dsh', 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 语料是**活的**：本次任务自身就在往里写会话。两次连续运行之间块数就会变
 * （实测 2234 → 2244 → 2258），所以必须能冻结快照，否则数字不可复现。
 *
 * 设 CORPUS_SNAPSHOT=<目录> 时，从该目录读（可用 Robocopy 复制一份语料）；
 * 未设时读活语料，并打印每个文件的 sha256/mtime 作为复现锚点。
 */
const SNAPSHOT = process.env['CORPUS_SNAPSHOT']
const READ_ROOT = SNAPSHOT ?? ROOT

/** 陷阱 (2)：分块大小。绝不是 1。 */
const CHUNK = 64

// ================================================================ 语料解码（陷阱 1）

function walk(dir: string, d = 0, out: string[] = []): string[] {
  if (d > 4) return out
  let es
  try { es = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of es) {
    const f = join(dir, e.name)
    if (e.isDirectory()) walk(f, d + 1, out)
    else if (e.name.endsWith('.jsonl.zstd')) out.push(f)
  }
  return out
}

/** 找全部 zstd magic 偏移，逐帧解压再拼接。 */
function decode(file: string): { text: string; frames: number } {
  const buf = readFileSync(file)
  const offs: number[] = []
  let at = buf.indexOf(MAGIC)
  while (at !== -1) { offs.push(at); at = buf.indexOf(MAGIC, at + 4) }
  offs.push(buf.length)
  let text = ''
  let frames = 0
  for (let i = 0; i < offs.length - 1; i += 1) {
    try {
      text += zstdDecompressSync(buf.subarray(offs[i], offs[i + 1]!)).toString('utf8')
      frames += 1
    } catch { /* 尾帧可能被截断 */ }
  }
  return { text, frames }
}

// ================================================================ 块抽取（陷阱 3）

interface Block { file: string; mtime: string; idx: number; text: string }

const files = walk(READ_ROOT).sort()
const reasoning: Block[] = []
const textBlocks: Block[] = []
let totalFrames = 0
let rawLines = 0
let skipped = 0

for (const file of files) {
  const { text, frames } = decode(file)
  totalFrames += frames
  const mtime = statSync(file).mtime.toISOString().slice(0, 16)
  for (const line of text.split('\n')) {
    rawLines += 1
    let e: { type?: string; data?: { message?: { content?: { type?: string; text?: string }[] } } }
    try { e = JSON.parse(line) } catch { skipped += 1; continue }
    if (e.type !== 'assistant/message') continue
    for (const b of e.data?.message?.content ?? []) {
      if (typeof b.text !== 'string') continue
      // 陷阱 (3)：就这一条路径。
      if (b.type === 'reasoning') reasoning.push({ file, mtime, idx: reasoning.length, text: b.text })
      else if (b.type === 'text') textBlocks.push({ file, mtime, idx: textBlocks.length, text: b.text })
    }
  }
}

// ================================================================ 工具

const charLen = (s: string): number => Array.from(s).length
const nonEmptyLines = (s: string): string[] => s.split('\n').filter((l) => l.trim() !== '')
const lineIndexOf = (s: string, offset: number): number => {
  let n = 0
  for (let i = 0, e = Math.min(offset, s.length); i < e; i += 1) if (s[i] === '\n') n += 1
  return n
}
const WS = /\s/
const TERMINATORS = new Set(['.', '!', '?', '。', '！', '？', '；', ';'])
const TRAIL = /[.:;!?。：；！？，,、]+$/

// ================================================================ A 层：真值（64 字符分块喂 PrefixGuard）

interface Trace {
  fired: boolean
  triggerOffset: number
  count: number
  opener: string
  chunkFeeds: number
  jointFeedMarks: number[]   // 每次 openings 增加时「已喂总长」
}

function traceGuard(text: string): Trace {
  const g = new PrefixGuard()
  let fed = 0
  let prev = g.openings
  const marks: number[] = []
  for (let i = 0; i < text.length; i += CHUNK) {
    const delta = text.slice(i, i + CHUNK)
    fed += delta.length
    const v = g.feed(delta)
    const now = g.openings
    if (now > prev) marks.push(fed)
    prev = now
    if (v !== null) {
      return { fired: true, triggerOffset: v.charsSeen, count: v.count, opener: v.opener, chunkFeeds: Math.ceil(text.length / CHUNK), jointFeedMarks: marks }
    }
  }
  return { fired: false, triggerOffset: -1, count: 0, opener: '', chunkFeeds: Math.ceil(text.length / CHUNK), jointFeedMarks: marks }
}

// ================================================================ B 层：独立重写（照 DESIGN §2）

interface Joint {
  at: number          // 接头起始偏移
  next: number        // 消费到
  table: 'A' | 'B'
  opener: string
  clause: string      // 判定所用的整个子句
  line: number
}

function matchPrefixA(text: string, head: number, contentEnd: number): string | null {
  let best: string | null = null
  for (const p of INTENT_PREFIXES) {
    if (head + p.length > contentEnd) continue
    if (text.slice(head, head + p.length).toLowerCase() !== p) continue
    if (/[a-z']$/i.test(p)) {
      const after = text[head + p.length]
      if (after !== undefined && /[a-z0-9]/i.test(after)) continue
    }
    if (best === null || p.length > best.length) best = text.slice(head, head + p.length)
  }
  return best
}

/** DESIGN §2 的扫描器，作用在「已冻结」的整段文本上（流式的 wait 退化为「取到结尾」）。 */
function scanClauses(text: string, limit = PREFIX_COUNT_LIMIT, tolerance = PREFIX_TOLERANCE) {
  const joints: Joint[] = []
  let pos = 0
  let count = 0
  let gap = 0
  let triggerOffset = -1
  let gapChars = 0
  const gapTexts: string[] = []
  let pending = ''

  while (pos < text.length) {
    // 子句开头？
    let clauseStart = false
    if (pos === 0) clauseStart = true
    else {
      let i = pos - 1
      while (i >= 0 && WS.test(text[i]!)) { if (text[i] === '\n') { clauseStart = true; break } i -= 1 }
      if (!clauseStart) clauseStart = i < 0 || TERMINATORS.has(text[i]!)
    }
    if (clauseStart) {
      let end = -1
      for (let i = pos; i < text.length; i += 1) {
        if (text[i] === '\n' || TERMINATORS.has(text[i]!)) { end = i + 1; break }
      }
      if (end < 0) end = text.length // 冻结文本：末尾未终止的子句直接取到结尾
      const contentEnd = end - 1
      const clause = text.slice(pos, end)
      const trimmed = clause.trim()
      let hit: Joint | null = null
      let head = pos
      while (head < contentEnd && WS.test(text[head]!)) head += 1
      if (head < contentEnd && charLen(trimmed) <= LETME_MAX) {
        const opener = matchPrefixA(text, head, contentEnd)
        if (opener !== null) hit = { at: head, next: head + opener.length, table: 'A', opener, clause: trimmed, line: lineIndexOf(text, head) }
      }
      if (hit === null) {
        const body = trimmed.replace(TRAIL, '')
        if (body !== '' && FILLER_WORDS.includes(body.toLowerCase())) {
          hit = { at: pos, next: end, table: 'B', opener: body, clause: trimmed, line: lineIndexOf(text, pos) }
        }
      }
      if (hit !== null) {
        joints.push(hit)
        if (gapChars > 0) gapTexts.push(pending.slice(-160))
        gapChars = 0
        pending = ''
        count += 1
        gap = 0
        pos = hit.next
        if (count >= limit) { triggerOffset = pos; break }
        continue
      }
    }
    const ch = text[pos]!
    if (WS.test(ch)) {
      let n = pos
      while (n < text.length && WS.test(text[n]!)) n += 1
      pending += text.slice(pos, n)
      pos = n
      continue
    }
    gap += 1
    gapChars += 1
    pending += ch
    if (gap > tolerance) { count = 0; gap = 0; gapChars = 0; pending = '' }
    const cp = text.codePointAt(pos)!
    pos += cp > 0xffff ? 2 : 1
  }
  return { joints, triggerOffset, gapTexts, finalCount: count }
}

// ================================================================ 自指性判定
//
// 语料是活的，而**本次任务自身**就在往语料里写：M-ds-guard / --M-Codex-- 下
// 2026-09-23 的会话，是我们在开发、测试、讨论这条 prefix 规则时产生的。
// 这些会话里模型会**引用/书写填充词本身**（`好。执行。` 测试夹具、代码块里列
// 填充词、讨论「接头」「容差」）—— 正是 DESIGN §3.4 记录的误报形态。
// 若把这类会话计入，得到的「误报」是自指伪影，不能代表规则在真实工作负载上的表现。
//
// 因此按**会话级**切分：该会话的任一文本提及 guard 内部词汇 → 自研究会话。
const SELF_REF = /stream-guard|PrefixGuard|PREFIX_TOLERANCE|PREFIX_COUNT_LIMIT|LETME_MAX|FILLER_WORDS|DESIGN-prefix|zz-final-corpus|prefix\.ts|settledReasoning|cycleFloor|takeSafe|接头|reasoning 块/
const selfRefFiles = new Set<string>()
for (const f of files) {
  if (SELF_REF.test(decode(f).text)) selfRefFiles.add(f)
}
const isSelfRef = (b: Block): boolean => selfRefFiles.has(b.file)

console.log('==================== 终局语料复核 ====================')
console.log(`语料根目录   ${ROOT}`)
console.log(`实际读取     ${READ_ROOT}${SNAPSHOT ? '   [冻结快照]' : '   [活语料 —— 会随新会话增长]'}`)
console.log(`会话文件     ${files.length} 个，解码出 ${totalFrames} 个 zstd 帧，原始行 ${rawLines}（JSON 解析失败 ${skipped}）`)
console.log(`分块大小     ${CHUNK} 字符（禁止逐字符：O(n²)）`)
console.log(`参数         TOLERANCE=${PREFIX_TOLERANCE}  COUNT_LIMIT=${PREFIX_COUNT_LIMIT}  LETME_MAX=${LETME_MAX}`)
console.log(`词表 A(接头) ${INTENT_PREFIXES.length} 条  词表 B(填充词) ${FILLER_WORDS.length} 条`)
const rLines = reasoning.reduce((a, b) => a + nonEmptyLines(b.text).length, 0)
console.log(`语料规模     reasoning 块 ${reasoning.length} 个 / 非空行 ${rLines} / ${charLen(reasoning.map((b) => b.text).join(''))} 字符`)
console.log(`             text 块 ${textBlocks.length} 个 / 非空行 ${textBlocks.reduce((a, b) => a + nonEmptyLines(b.text).length, 0)}`)

// 语料是活的（新会话不断写入），所以打完指纹让结论可复现。
// 只打印，不落盘 —— 超出本任务写入范围的文件一律不建。
console.log(`\n---------------- 语料指纹（可复现锚点）----------------`)
for (const f of files) {
  const st = statSync(f)
  const sha = createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16)
  console.log(`  ${String(st.size).padStart(9)}  ${sha}  ${st.mtime.toISOString().slice(0, 19)}  ${f.replace(READ_ROOT + '\\', '')}`)
}

// ================================================================ A 层结果 + A/B 对齐

const rHits: { b: Block; t: Trace; s: ReturnType<typeof scanClauses> }[] = []
let disagreeFire = 0
let disagreeOffset = 0
let disagreeCount = 0
const disagreeSamples: string[] = []

for (const b of reasoning) {
  const t = traceGuard(b.text)
  const s = scanClauses(b.text)
  const sFired = s.triggerOffset >= 0
  if (t.fired !== sFired) {
    disagreeFire += 1
    disagreeSamples.push(`  块 #${b.idx}: guard=${t.fired ? `fire@${t.triggerOffset}` : 'silent'}  scan=${sFired ? `fire@${s.triggerOffset}` : 'silent'}`)
  } else if (t.fired && (t.triggerOffset !== s.triggerOffset || t.count !== s.finalCount)) {
    disagreeOffset += 1
    if (t.count !== s.finalCount) disagreeCount += 1
    if (disagreeSamples.length < 6) {
      disagreeSamples.push(`  块 #${b.idx}: guard offset=${t.triggerOffset} count=${t.count} | scan offset=${s.triggerOffset} count=${s.finalCount}`)
    }
  }
  if (t.fired) rHits.push({ b, t, s })
}

const tHits: { b: Block; t: Trace }[] = []
for (const b of textBlocks) {
  const t = traceGuard(b.text)
  if (t.fired) tHits.push({ b, t })
}

console.log(`\n==================== A 层：PrefixGuard（64 字符分块）====================`)
console.log(`reasoning 通道：触发 ${rHits.length} / ${reasoning.length}   触发率 ${((rHits.length / Math.max(1, reasoning.length)) * 100).toFixed(3)}%`)
console.log(`text 通道：     触发 ${tHits.length} / ${textBlocks.length}`)

// ---- 关键切分：把自研究会话单独拎出来 ----
const rSelf = rHits.filter((h) => isSelfRef(h.b))
const rReal = rHits.filter((h) => !isSelfRef(h.b))
const selfBlocks = reasoning.filter(isSelfRef)
const realBlocks = reasoning.filter((b) => !isSelfRef(b))

console.log(`\n==================== 自指性切分 ====================`)
console.log(`  自研究会话（会话全文提及 guard 内部词汇）${selfRefFiles.size} / ${files.length} 个文件`)
for (const f of [...selfRefFiles].sort()) console.log(`      ${f.replace(READ_ROOT + '\\', '')}`)
console.log(`\n  自研究会话里的 reasoning 块   ${selfBlocks.length}`)
console.log(`  这些块中触发                  ${rSelf.length}   <-- 自指伪影：模型在写/引用填充词本身`)
console.log(`\n  非自研究会话 reasoning 块     ${realBlocks.length}`)
console.log(`  这些块中触发                  ${rReal.length}   <-- 这才是真实工作负载上的触发`)
console.log(`\n  上一轮基线 17（2159 块）`)
console.log(`  本次真实负载触发 ${rReal.length}`)
console.log(`  → ${rReal.length === 17 ? '与基线完全一致' : `与基线差 ${rReal.length - 17}`}`)

console.log(`\n==================== A/B 交叉核对（独立重写 vs 真值）====================`)
console.log(`  触发与否不一致   ${disagreeFire} 块`)
console.log(`  触发偏移/计数不一致 ${disagreeOffset} 块`)
for (const d of disagreeSamples) console.log(d)
console.log(`\n  注：B 层把「冻结文本」的末尾未终止子句直接取到结尾，而 PrefixGuard 在
  真流式下可能对该子句 'wait'。因此**触发与否**必须一致（这是硬指标）；
  触发偏移在同一块内也应一致。任何不一致都说明实现与 DESIGN §2 有出入。`)
console.log(`  → ${disagreeFire === 0 && disagreeOffset === 0 ? '两层完全一致，证据可信' : '存在分歧，见下'}`)

// ================================================================ 证据：逐个触发块

console.log(`\n==================== 触发块证据（${rHits.length} 个，逐个）====================`)

interface Row {
  n: number
  block: Block
  trig: Trace
  joints: Joint[]
  gaps: string[]
  spreadLines: number
  trigLine: number
  totalLines: number
  jointClauseChars: number
  jointLineSet: Set<number>
}

const rows: Row[] = []
rHits.forEach(({ b, t, s }, i) => {
  rows.push({
    n: i + 1,
    block: b,
    trig: t,
    joints: s.joints,
    gaps: s.gapTexts,
    spreadLines: new Set(s.joints.map((j) => j.line)).size,
    trigLine: lineIndexOf(b.text, t.triggerOffset),
    totalLines: b.text.split('\n').length,
    jointClauseChars: s.joints.reduce((a, j) => a + charLen(j.clause), 0),
    jointLineSet: new Set(s.joints.map((j) => j.line)),
  })
})

for (const r of rows) {
  const text = r.block.text
  const lines = text.split('\n')
  const ne = nonEmptyLines(text)
  console.log(`\n---- 触发块 ${r.n} / ${rows.length} ----`)
  console.log(`  文件        ${r.block.file.replace(READ_ROOT + '\\', '')}`)
  console.log(`  文件 mtime  ${r.block.mtime}     语料块序号 #${r.block.idx}`)
  console.log(`  规模        ${charLen(text)} 字符 / 原始行 ${r.totalLines} / 非空行 ${ne.length}`)
  console.log(`  分块喂入    ${r.trig.chunkFeeds} 次 × ${CHUNK} 字符`)
  console.log(`  触发        ${r.trig.triggerOffset} 字符处（第 ${r.trigLine} 行），第 ${r.trig.count} 个接头 "${r.trig.opener}"  [独立复核一致]`)
  console.log(`  5 个接头    跨 ${r.spreadLines} 个物理行；接头子句合计 ${r.jointClauseChars} 字符 / 块共 ${charLen(text)} 字符`)
  console.log(`  接头明细（表/偏移/行/子句原文）：`)
  for (const j of r.joints) {
    console.log(`      ${j.table}  @${String(j.at).padStart(6)}  L${String(j.line).padStart(5)}  ${JSON.stringify(j.clause.slice(0, 70))}`)
  }
  if (r.gaps.length > 0) {
    console.log(`  接头之间夹的内容（gap，非空白计 ≤20）：`)
    for (const g of r.gaps) console.log(`      ${JSON.stringify(g.replace(/\s+/g, ' ').trim().slice(0, 120))}`)
  } else {
    console.log(`  接头之间夹的内容：无（5 个接头相邻）`)
  }
  console.log(`  触发点前后原文：`)
  for (let k = Math.max(0, r.trigLine - 6); k <= Math.min(lines.length - 1, r.trigLine + 4); k += 1) {
    const s = lines[k]!
    if (s.trim() === '') continue
    const mark = k === r.trigLine ? '>>' : '  '
    console.log(`   ${mark} L${String(k).padStart(5)} ${JSON.stringify(s.trim().slice(0, 100))}`)
  }
  console.log(`  该块开头 5 个非空行（判断这个块到底在干什么 —— 是真回路，还是在写关于回路的测试/文档）：`)
  let shownHead = 0
  for (const s of lines) {
    if (s.trim() === '') continue
    console.log(`      ${JSON.stringify(s.trim().slice(0, 140))}`)
    if (++shownHead >= 5) break
  }
  console.log(`  触发点宽上下文 L${Math.max(0, r.trigLine - 40)}..L${Math.min(lines.length - 1, r.trigLine + 12)}：`)
  for (let k = Math.max(0, r.trigLine - 40); k <= Math.min(lines.length - 1, r.trigLine + 12); k += 1) {
    const s = lines[k]!
    if (s.trim() === '') continue
    const mark = k === r.trigLine ? '>>' : '  '
    console.log(`   ${mark} L${String(k).padStart(5)} ${JSON.stringify(s.slice(0, 168))}`)
  }
}

// ================================================================ 触发块分类判据

/**
 * DESIGN §3.7 的口径：**物理行**级的接头占比（`115071 字符块 = 10190 非空行 /
 * 10082 接头 = 98.9%`）。这是设计文档自己给出的证据指标，用来把本次的触发块
 * 和基线那 17 个放进同一个population 比较。
 */
function isJointLine(raw: string): boolean {
  const s = raw.trim()
  if (s === '') return false
  const body = s.replace(TRAIL, '')
  if (FILLER_WORDS.includes(body.toLowerCase())) return true
  if (charLen(s) > LETME_MAX) return false
  const lower = s.toLowerCase()
  return INTENT_PREFIXES.some((p) => {
    if (!lower.startsWith(p)) return false
    if (/[a-z']$/i.test(p)) {
      const after = lower[p.length]
      if (after !== undefined && /[a-z0-9]/i.test(after)) return false
    }
    return true
  })
}

function jointLineShare(text: string): { joints: number; lines: number; share: number } {
  const ne = nonEmptyLines(text)
  const j = ne.filter(isJointLine).length
  return { joints: j, lines: ne.length, share: (j / Math.max(1, ne.length)) * 100 }
}

console.log(`\n==================== 触发块分类判据 ====================`)
console.log(`  判据 1  接头是否集中在极少物理行（= 在引用/书写一段回路文本，而非真的在推进回路）`)
console.log(`  判据 2  触发点之后块是否继续产出大量实质内容（真死循环不会）`)
console.log(`  判据 3  5 个接头子句合计字符 / 块总字符（真死循环里这个占比极高）`)
console.log(`  [自]    该块所在会话是自研究会话（在写/讨论这条规则本身）`)
console.log(`  §3.7 占比 = 物理行级接头占比（DESIGN §3.7 原始口径，基线 17 块为 36.7%–98.9%）\n`)
console.log(`   # [自] 跨行数  接头子句占比  §3.7占比  触发后非空行  触发后字符  触发后接头  文件`)
for (const r of rows) {
  const after = r.block.text.slice(r.trig.triggerOffset)
  const afterLines = nonEmptyLines(after)
  const afterJoints = scanClauses(after).joints.length
  const share = ((r.jointClauseChars / Math.max(1, charLen(r.block.text))) * 100).toFixed(3)
  const jl = jointLineShare(r.block.text)
  const tag = isSelfRef(r.block) ? ' 自 ' : '    '
  console.log(`  ${String(r.n).padStart(3)} ${tag} ${String(r.spreadLines).padStart(6)}  ${share.padStart(10)}%  ${jl.share.toFixed(1).padStart(7)}%  ${String(afterLines.length).padStart(12)}  ${String(charLen(after)).padStart(10)}  ${String(afterJoints).padStart(10)}  ${r.block.file.split('\\').slice(-2)[0]}`)
}
console.log(`\n  真实负载（非自研会话）触发块 —— 与基线 17 块同口径对比：`)
for (const r of rows) {
  if (isSelfRef(r.block)) continue
  const jl = jointLineShare(r.block.text)
  console.log(`    #${r.n}  ${String(jl.joints).padStart(5)} 接头行 / ${String(jl.lines).padStart(5)} 非空行 = ${jl.share.toFixed(1).padStart(5)}%   触发于第 ${r.trigLine} 行   ${r.block.file.split('\\').slice(-2)[0]}`)
}
const selfRows = rows.filter((r) => isSelfRef(r.block))
console.log(`  自研会话触发块（自指伪影）：${selfRows.length} 个 → #${selfRows.map((r) => r.n).join(', #')}`)

// ---- 按文件列出触发块，便于按 mtime 切「基线时代」语料做 apples-to-apples 复现 ----
console.log(`\n==================== 每文件触发块（按 mtime）====================`)
const byFile = new Map<string, { mtime: string; blocks: number; triggers: number; ne: number }>()
for (const b of reasoning) {
  const e = byFile.get(b.file) ?? { mtime: statSync(b.file).mtime.toISOString().slice(0, 16), blocks: 0, triggers: 0, ne: 0 }
  e.blocks += 1
  e.ne += nonEmptyLines(b.text).length
  if (rHits.some((h) => h.b === b)) e.triggers += 1
  byFile.set(b.file, e)
}
console.log(`  mtime             块   非空行  触发  文件`)
for (const [f, e] of [...byFile].sort((a, b) => a[1].mtime.localeCompare(b[1].mtime))) {
  console.log(`  ${e.mtime}  ${String(e.blocks).padStart(5)} ${String(e.ne).padStart(7)} ${String(e.triggers).padStart(5)}  ${f.replace(READ_ROOT + '\\', '')}`)
}
const cutoff = process.env['CORPUS_CUTOFF']
if (cutoff !== undefined) {
  let eraBlocks = 0
  let eraTrig = 0
  for (const b of reasoning) {
    if (statSync(b.file).mtime.toISOString().slice(0, 16) >= cutoff) continue
    eraBlocks += 1
    if (rHits.some((h) => h.b === b)) eraTrig += 1
  }
  console.log(`\n  CORPUS_CUTOFF=${cutoff} 时代语料：${eraBlocks} 块 → 触发 ${eraTrig} 块（基线 17）`)
}

// ================================================================ text 通道

console.log(`\n==================== text 通道触发块（${tHits.length}）====================`)
for (const { b, t } of tHits) {
  console.log(`  #${b.idx}  ${b.file.replace(READ_ROOT + '\\', '')}`)
  console.log(`        ${charLen(b.text)} 字符 / 非空行 ${nonEmptyLines(b.text).length}  触发于 ${t.triggerOffset} 字符 "${t.opener}"`)
}

// ================================================================ 合成对照

console.log(`\n==================== 真死循环合成对照（同一最终文件）====================`)

const SYNTH: [string, string, boolean][] = [
  ['经典 let me 循环', Array.from({ length: 60 }, (_, i) => `Let me ${['check', 'look', 'verify', 'read'][i % 4]}.`).join('\n'), true],
  ['短前缀纯重复', Array.from({ length: 60 }, () => 'Let me write.').join('\n'), true],
  ['填充词刷屏', Array.from({ length: 60 }, () => 'Writing.').join('\n'), true],
  ['措辞漂移（§4 原文）', Array.from({ length: 60 }, () => 'Let me write.\nWriting.\nProducing.\nOK.\nLet me just do it.').join('\n'), true],
  ['词表外内容夹中间', Array.from({ length: 120 }, (_, i) => (i % 2 === 0 ? 'Let me write.' : 'Xy.')).join('\n'), true],
  ['中文接头循环', Array.from({ length: 60 }, (_, i) => `让我${['看看', '检查', '确认'][i % 3]}。`).join('\n'), true],
  ['中文填充词循环', Array.from({ length: 60 }, () => '好。执行。').join(''), true],
  ['无换行空格分隔', 'Let me check. Let me look. Let me verify. Let me read. Let me write. ', true],
  ['健康长句（§4）', 'Let me check the config number 3 before I continue.\n'.repeat(40), false],
  ['健康长句 187 字符（§3.5）', 'Let me also check the harness identity is suppressed in the output path before continuing.\n'.repeat(20), false],
  ['健康推理夹偶发接头', Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? `Let me check thing ${i}.` : `Thing ${i} resolves to ${i * 13} because the reducer is associative.`)).join('\n'), false],
  ['纯正文', Array.from({ length: 40 }, (_, i) => `Paragraph ${i} explains a distinct point about the transfer protocol.`).join('\n'), false],
  ['Markdown 表格', Array.from({ length: 40 }, (_, i) => `| row ${i} | value ${i * 7} |`).join('\n'), false],
  ['代码清单', Array.from({ length: 40 }, (_, i) => `const value${i} = compute(${i})`).join('\n'), false],
]

let synthMiss = 0
let synthFp = 0
for (const [name, text, expect] of SYNTH) {
  const t = traceGuard(text)
  const ok = t.fired === expect
  if (!ok && expect) synthMiss += 1
  if (!ok && !expect) synthFp += 1
  const dur = t.fired ? `count=${t.count} @${t.triggerOffset} "${t.opener}"` : '静默'
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(26)} ${dur}${expect ? '' : '（期望静默）'}`)
}
console.log(`\n  合成对照：真死循环漏报 ${synthMiss} / 8，健康文本误报 ${synthFp} / 6`)

// ================================================================ 分片无关性

console.log(`\n==================== 分片无关性（真实触发块，delta ∈ {1,3,7,64,1000}）====================`)
for (const r of rows.slice(0, 4)) {
  const cells: string[] = []
  for (const d of [1, 3, 7, 64, 1000]) {
    const g = new PrefixGuard()
    let off = -1
    for (let i = 0; i < r.block.text.length; i += d) {
      const v = g.feed(r.block.text.slice(i, i + d))
      if (v !== null) { off = v.charsSeen; break }
    }
    cells.push(`d=${String(d).padStart(4)}:${off}`)
  }
  const allSame = new Set(cells.map((c) => c.split(':')[1])).size === 1
  console.log(`  块 #${r.n} (${charLen(r.block.text)} 字符)  ${cells.join('  ')}  ${allSame ? '一致' : '<<< 不一致'}`)
}

const rNonFired = reasoning.filter((b) => !rHits.some((h) => h.b === b)).slice(0, 3)
console.log(`  （不触发块抽样）`)
for (const b of rNonFired) {
  const cells: string[] = []
  for (const d of [1, 3, 7, 64, 1000]) {
    const g = new PrefixGuard()
    let fired = false
    for (let i = 0; i < b.text.length; i += d) if (g.feed(b.text.slice(i, i + d)) !== null) { fired = true; break }
    cells.push(`d=${d}:${fired ? 'FIRES' : 'silent'}`)
  }
  console.log(`  块 #${b.idx} (${charLen(b.text)} 字符)  ${cells.join('  ')}`)
}

console.log(`\n==================== 与上一轮基线（行级模拟）逐块对比 ====================`)
/**
 * 上一轮基线的 17 来自 zz-v8.mts 的**行级模拟**（每行判一次接头、gap 按
 * `len(line)+1` 累计），不是真 PrefixGuard。两种机制不同，块数必然不同。
 * 真正要回答的是：**基线标出的那些死循环块，最终实现是否仍然抓住**（不漏报）。
 * 所以这里原样复刻基线的行级判定，再与真值逐块比对。
 */
const BASE_WORDS = [
  'ok', 'go', 'now', 'write', 'emit', 'here', 'final', 'writing', 'producing', 'emitting',
  '好', '现在', '写', '输出', '生成', '写入', '接下去', '执行',
]
const BASE_LETME = /^let me ([a-z]+)( it| them| that)?[.!]?$/i
const BASE_PFX = [
  'let us', "let's", "i'll", 'i will', 'i need to', 'i should', 'i want to',
  'i am going to', "i'm going to", 'now let me', 'now i', 'next i', 'then i',
  '让我', '我先', '我需要', '接下来', '现在我',
]

function baselineJointOf(raw: string): string | null {
  const s = raw.trim()
  if (s === '' || charLen(s) > 60) return null
  const bare = s.replace(TRAIL, '').toLowerCase()
  if (BASE_WORDS.includes(bare)) return `W:${bare}`
  if (charLen(s) <= LETME_MAX && BASE_LETME.test(s)) return 'L:letme'
  if (charLen(s) > LETME_MAX) return null
  const lower = s.toLowerCase()
  let best: string | null = null
  for (const p of BASE_PFX) {
    if (!lower.startsWith(p)) continue
    const after = lower[p.length]
    if (/[a-z']$/.test(p) && after !== undefined && /[a-z0-9]/i.test(after)) continue
    if (best === null || p.length > best.length) best = p
  }
  return best === null ? null : `P:${best}`
}

function baselineFires(text: string): boolean {
  const lines = text.split('\n')
  let count = 0
  let gap = 0
  for (const l of lines) {
    const s = l.trim()
    if (s === '') continue
    if (baselineJointOf(l) !== null) {
      count += 1
      gap = 0
      if (count >= PREFIX_COUNT_LIMIT) return true
      continue
    }
    gap += charLen(s) + 1
    if (gap > PREFIX_TOLERANCE) { count = 0; gap = 0 }
  }
  return false
}

const baseSet = new Set<Block>()
for (const b of reasoning) if (baselineFires(b.text)) baseSet.add(b)
const guardSet = new Set(rHits.map((h) => h.b))
const onlyBase = [...baseSet].filter((b) => !guardSet.has(b))
const onlyGuard = [...guardSet].filter((b) => !baseSet.has(b))

console.log(`  行级模拟（基线口径）触发   ${baseSet.size} 块`)
console.log(`  真 PrefixGuard 触发        ${guardSet.size} 块`)
console.log(`  两者都触发                 ${baseSet.size - onlyBase.length} 块`)
console.log(`\n  【关键】基线触发但最终实现**漏掉**的块：${onlyBase.length}`)
for (const b of onlyBase) {
  const jl = jointLineShare(b.text)
  console.log(`    #${b.idx}  ${charLen(b.text)} 字符 / ${jl.lines} 非空行 / §3.7 占比 ${jl.share.toFixed(1)}%  ${b.file.split('\\').slice(-2)[0]}`)
}
console.log(`\n  最终实现新增触发（基线没有）的块：${onlyGuard.length}`)
for (const b of onlyGuard) {
  const jl = jointLineShare(b.text)
  const tag = isSelfRef(b) ? '[自研]' : '      '
  console.log(`    #${b.idx} ${tag} ${charLen(b.text)} 字符 / ${jl.lines} 非空行 / §3.7 占比 ${jl.share.toFixed(1)}%  ${b.file.split('\\').slice(-2)[0]}`)
}
const baseSelf = [...baseSet].filter(isSelfRef).length
console.log(`\n  基线 19 块的自指构成：自研 ${baseSelf} / 真实负载 ${baseSet.size - baseSelf}`)
const realHitInBase = rReal.filter((h) => baseSet.has(h.b)).length
console.log(`  真实负载触发 ${rReal.length} 块，其中也被基线行级模拟抓到 ${realHitInBase} 块`)
console.log(`  → 真实负载上的**基线与最终实现交集** = ${realHitInBase}；这就是「真死循环仍被抓住」的可核对数字`)

// ================================================================ 判定

console.log(`\n==================== 判定 ====================`)
console.log(`  最终 prefix.ts    packages/guard/stream-guard/src/prefix.ts`)
console.log(`  分块               ${CHUNK} 字符（陷阱 2）`)
console.log(`\n  [1] 真死循环仍被抓住？`)
console.log(`      合成真死循环漏报   ${synthMiss} / 8   ${synthMiss === 0 ? '全部抓住' : '有漏报'}`)
console.log(`      真实负载触发块     ${rReal.length}（上一轮基线 17）`)
console.log(`      → ${rReal.length === 17 ? '与基线一致，真死循环仍被抓住' : `与基线不同（差 ${rReal.length - 17}），见分类判据`}`)
console.log(`\n  [2] 误报 = 0？`)
console.log(`      合成健康文本误报   ${synthFp} / 6   ${synthFp === 0 ? '合成层面 0' : '有误报'}`)
console.log(`      真实语料总触发     ${rHits.length}`)
console.log(`        其中自研会话     ${rSelf.length}   <-- 自指伪影（模型在写/引用填充词本身）`)
console.log(`        其中非自研会话   ${rReal.length}   <-- 真实负载`)
console.log(`      → 真实负载上是否 0 误报，取决于上面 ${rReal.length} 个块能否全部人工确认为真死循环`)
console.log(`\n  [3] 其他`)
console.log(`      text 通道触发块    ${tHits.length}`)
console.log(`      A/B 触发分歧       ${disagreeFire}（硬指标，必须 0）`)
console.log(`      A/B 偏移/计数分歧  ${disagreeOffset}`)

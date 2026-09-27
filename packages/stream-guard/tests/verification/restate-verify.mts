/**
 * restate-verify.mts — INDEPENDENT verification of the cross-channel "restate" claim.
 *
 * Written by teammate corpus-verifier. Deliberately does NOT reuse the Lead's
 * restate-scan.mts implementation; the decode path was independently re-derived and
 * cross-checked, but the scoring is written from scratch so the numbers are not
 * a rerun of the same code.
 *
 * CLAIM UNDER TEST
 *   restate = 8-gram overlap between an assistant message's reasoning text and its
 *   visible text channel. Claimed histogram over 1444 messages with reasoning >= 1500 chars:
 *     0-5%: 1423 | 5-10%: 10 | 10-15%: 3 | 95-100%: 8 | ZERO in 15%-95%.
 *
 * RUN
 *   npx tsx packages/guard/stream-guard/tests/verification/restate-verify.mts
 *   ... --snapshot <dir>   (freeze corpus)
 *   ... --json <out.json>
 *
 * Format (independently verified): v3 session logs are MULTI-FRAME zstd. Split on the
 * 4-byte magic 28 b5 2f fd, zstdDecompressSync EACH frame separately, concatenate.
 * Assistant messages: e.type === 'assistant/message', content at .data.message.content[].
 * Read-only (only optional --json report is written).
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'

const argv = process.argv.slice(2)
const arg = (name: string, dflt: string): string => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : dflt
}
const N = Number(arg('--n', '8'))
const MIN_REASONING = Number(arg('--min-reasoning', '1500'))
const JSON_OUT = arg('--json', '')
const SNAPSHOT = process.env['CORPUS_SNAPSHOT'] ?? ''
const DSH_HOME = process.env['DSH_HOME'] ?? join(process.env['USERPROFILE'] ?? '', '.dsh')
const READ_ROOT = SNAPSHOT !== '' ? SNAPSHOT : join(DSH_HOME, 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

console.log('# restate-verify (independent)')
console.log('DSH_HOME      =', DSH_HOME)
console.log('READ_ROOT     =', READ_ROOT)
console.log('N (shingle)   =', N)
console.log('MIN_REASONING =', MIN_REASONING)
console.log('')

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
function decode(file: string): { text: string; frames: number; failed: number } {
  const buf = readFileSync(file)
  const offs: number[] = []
  let at = buf.indexOf(MAGIC)
  while (at !== -1) { offs.push(at); at = buf.indexOf(MAGIC, at + 4) }
  offs.push(buf.length)
  let text = '', frames = 0, failed = 0
  for (let i = 0; i < offs.length - 1; i += 1) {
    try { text += zstdDecompressSync(buf.subarray(offs[i], offs[i + 1])).toString('utf8'); frames += 1 }
    catch { failed += 1 }
  }
  return { text, frames, failed }
}

interface Msg {
  file: string; sessionId: string; cwd: string; origin: string
  delegationDepth: number; parentSession: string; slug: string
  time: number; reasoning: string; text: string
  nReasonBlocks: number; nTextBlocks: number
}
interface FileInfo {
  file: string; slug: string; sessionId: string; cwd: string; origin: string
  delegationDepth: number; parentSession: string
  bytes: number; frames: number; failedFrames: number; decodedChars: number
  mtime: string; sha256: string; lines: number
  nAssistantMsgs: number; nReasonMsgs: number; selfProduced: boolean; selfHits: string[]
}

const SELF_TOKENS = ['stream-guard', 'restate', '8-gram', 'PLAN-two-layer']
const files = walk(READ_ROOT).sort()
const msgs: Msg[] = []
const infos: FileInfo[] = []
let rawLines = 0, parseFails = 0

for (const file of files) {
  const buf = readFileSync(file)
  const { text, frames, failed } = decode(file)
  const st = statSync(file)
  const slug = file.slice(READ_ROOT.length + 1).split(sep)[0] ?? ''
  let sessionId = '', cwd = '', origin = '', parentSession = ''
  let delegationDepth = -1, lines = 0, nAssistantMsgs = 0, nReasonMsgs = 0
  const hits = new Set<string>()
  for (const tk of SELF_TOKENS) if (text.toLowerCase().includes(tk.toLowerCase())) hits.add(tk)

  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    rawLines += 1; lines += 1
    let e: any
    try { e = JSON.parse(t) } catch { parseFails += 1; continue }
    if (e?.type === 'session') {
      sessionId = String(e.id ?? ''); cwd = String(e.cwd ?? '')
      origin = String(e.origin ?? ''); parentSession = String(e.parentSession ?? '')
      delegationDepth = typeof e.delegationDepth === 'number' ? e.delegationDepth : 0
      continue
    }
    if (e?.type !== 'assistant/message') continue
    nAssistantMsgs += 1
    const blocks: any[] = e?.data?.message?.content ?? []
    const rb = blocks.filter((b) => b?.type === 'reasoning' && typeof b.text === 'string')
    const tb = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string')
    if (rb.length > 0) nReasonMsgs += 1
    msgs.push({
      file, sessionId, cwd, origin, delegationDepth, parentSession, slug,
      time: typeof e?.time === 'number' ? e.time : 0,
      reasoning: rb.map((b) => b.text as string).join('\n'),
      text: tb.map((b) => b.text as string).join('\n'),
      nReasonBlocks: rb.length, nTextBlocks: tb.length,
    })
  }
  infos.push({
    file, slug, sessionId, cwd, origin, delegationDepth, parentSession,
    bytes: buf.length, frames, failedFrames: failed, decodedChars: text.length,
    mtime: st.mtime.toISOString(), sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16),
    lines, nAssistantMsgs, nReasonMsgs, selfProduced: hits.size > 0, selfHits: [...hits],
  })
}

function charShingles(s: string, n: number): Set<string> {
  const out = new Set<string>(); for (let i = 0; i + n <= s.length; i += 1) out.add(s.slice(i, i + n)); return out
}
function normShingles(s: string, n: number): Set<string> {
  return charShingles(s.toLowerCase().replace(/\s+/g, ' ').trim(), n)
}
function wordShingles(s: string, n: number): Set<string> {
  const toks = (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  const out = new Set<string>(); for (let i = 0; i + n <= toks.length; i += 1) out.add(toks.slice(i, i + n).join(' ')); return out
}

type FormName = 'char-raw' | 'char-norm' | 'word-norm'
const FORMS: FormName[] = ['char-raw', 'char-norm', 'word-norm']
interface Score {
  msg: Msg; rChars: number; tChars: number
  cR: number; cT: number; jac: number; aSize: number; bSize: number; inter: number
}
function buildSet(form: FormName, s: string): Set<string> {
  return form === 'char-raw' ? charShingles(s, N) : form === 'char-norm' ? normShingles(s, N) : wordShingles(s, N)
}
function scoreAll(form: FormName, minReasoning: number): Score[] {
  const out: Score[] = []
  for (const m of msgs) {
    if (m.reasoning.length < minReasoning) continue
    const A = buildSet(form, m.reasoning), B = buildSet(form, m.text)
    let inter = 0
    const [small, big] = A.size <= B.size ? [A, B] : [B, A]
    for (const x of small) if (big.has(x)) inter += 1
    const union = A.size + B.size - inter
    out.push({
      msg: m, rChars: m.reasoning.length, tChars: m.text.length,
      cR: A.size > 0 ? inter / A.size : 0, cT: B.size > 0 ? inter / B.size : 0,
      jac: union > 0 ? inter / union : 0, aSize: A.size, bSize: B.size, inter,
    })
  }
  return out
}
const fmt = (x: number, d = 2): string => x.toFixed(d)
function histogram(scores: Score[], key: 'cR' | 'cT' | 'jac'): number[] {
  const bins = new Array(20).fill(0)
  for (const s of scores) { let v = s[key]; if (v >= 1) v = 0.999999; bins[Math.floor(v * 20)]! += 1 }
  return bins
}
function printHist(name: string, scores: Score[], key: 'cR' | 'cT' | 'jac'): number[] {
  const bins = histogram(scores, key)
  console.log('## histogram ' + name + '  (n=' + scores.length + ')')
  for (let i = 0; i < 20; i += 1) {
    console.log('  ' + String(i * 5).padStart(2) + '-' + String(i * 5 + 5).padStart(3) + '%  ' + String(bins[i]).padStart(5))
  }
  const zero = bins.map((c, i) => (c === 0 ? i * 5 : -1)).filter((x) => x >= 0)
  console.log('  zero bins (lo%): ' + JSON.stringify(zero))
  return bins
}

console.log('## corpus inventory')
console.log('files                 =', infos.length)
console.log('raw JSON lines        =', rawLines)
console.log('JSON parse failures   =', parseFails)
console.log('total decoded chars   =', infos.reduce((a, f) => a + f.decodedChars, 0))
console.log('total frames          =', infos.reduce((a, f) => a + f.frames, 0))
console.log('failed frames         =', infos.reduce((a, f) => a + f.failedFrames, 0))
const bySlug: Record<string, number> = {}
for (const f of infos) bySlug[f.slug] = (bySlug[f.slug] ?? 0) + 1
console.log('files by slug         =', JSON.stringify(bySlug))
console.log('assistant messages    =', msgs.length)
console.log('  with >=1 reasoning block =', msgs.filter((m) => m.nReasonBlocks > 0).length)
console.log('  with >=1 text block      =', msgs.filter((m) => m.nTextBlocks > 0).length)
console.log('  with both channels       =', msgs.filter((m) => m.nReasonBlocks > 0 && m.nTextBlocks > 0).length)
console.log('  reasoning chars >= ' + MIN_REASONING + ' =', msgs.filter((m) => m.reasoning.length >= MIN_REASONING).length)
console.log('  reasoning chars >= ' + MIN_REASONING + ' AND text non-empty =',
  msgs.filter((m) => m.reasoning.length >= MIN_REASONING && m.text.length > 0).length)

const allForms: Record<string, { scores: Score[]; hist: number[]; gap: any }> = {}
for (const form of FORMS) {
  const scores = scoreAll(form, MIN_REASONING)
  console.log('')
  console.log('================================================================')
  console.log('# FORM ' + form + '  (n=' + scores.length + ')')
  console.log('================================================================')
  printHist('containment |A n B|/|A|  [A=reasoning]', scores, 'cR')
  console.log('')
  printHist('containment |A n B|/|B|  [B=visible text]', scores, 'cT')
  console.log('')
  const h = printHist('Jaccard |A n B|/|A u B|', scores, 'jac')

  const inBand = scores.filter((s) => s.cR > 0.15 && s.cR < 0.95).sort((a, b) => a.cR - b.cR)
  const below = scores.filter((s) => s.cR <= 0.15)
  const above = scores.filter((s) => s.cR >= 0.95)
  const maxBelow = below.reduce((a, s) => Math.max(a, s.cR), 0)
  const minAbove = above.reduce((a, s) => Math.min(a, s.cR), 1)
  console.log('')
  console.log('## gap analysis (primary metric cR = |A n B|/|A|)')
  console.log('  max cR in [0,15%]      = ' + fmt(maxBelow * 100, 4) + '%')
  console.log('  min cR in [95%,100%]   = ' + fmt(minAbove * 100, 4) + '%')
  console.log('  count in (15%,95%)     = ' + inBand.length)
  for (const s of inBand) {
    console.log('    IN-BAND cR=' + fmt(s.cR * 100, 3) + '% cT=' + fmt(s.cT * 100, 3) + '% jac=' + fmt(s.jac * 100, 3) +
      '% rLen=' + s.rChars + ' tLen=' + s.tChars + ' sess=' + s.msg.sessionId + ' t=' + new Date(s.msg.time).toISOString())
  }
  allForms[form] = { scores, hist: h, gap: { maxBelow, minAbove, inBand: inBand.length } }
}

const primary = allForms['char-raw']!.scores
console.log('')
console.log('================================================================')
console.log('# >90% SAMPLES on char-raw cR (reasoning-side containment)')
console.log('================================================================')
const high = primary.filter((s) => s.cR > 0.90).sort((a, b) => b.cR - a.cR)
for (const s of high) {
  const info = infos.find((i) => i.file === s.msg.file)!
  console.log(JSON.stringify({
    cR_pct: +fmt(s.cR * 100, 4), cT_pct: +fmt(s.cT * 100, 4), jac_pct: +fmt(s.jac * 100, 4),
    reasoningChars: s.rChars, textChars: s.tChars, deltaChars: s.rChars - s.tChars,
    reasonShingles: s.aSize, textShingles: s.bSize, inter: s.inter,
    sessionId: s.msg.sessionId, slug: s.msg.slug, cwd: s.msg.cwd, origin: s.msg.origin,
    delegationDepth: s.msg.delegationDepth, parentSession: s.msg.parentSession,
    fileMtime: info.mtime, file: s.msg.file,
    selfProduced: info.selfProduced, selfHits: info.selfHits,
    msgTime: new Date(s.msg.time).toISOString(),
  }))
}
console.log('count >90% =', high.length, ' count >=95% =', primary.filter((s) => s.cR >= 0.95).length)
console.log('count reasoning==text exactly (char) =', primary.filter((s) => s.msg.reasoning === s.msg.text).length)
console.log('count text channel EMPTY =', primary.filter((s) => s.msg.text.length === 0).length)

console.log('')
console.log('## top 20 cR overall (char-raw)')
for (const s of [...primary].sort((a, b) => b.cR - a.cR).slice(0, 20)) {
  const info = infos.find((i) => i.file === s.msg.file)!
  console.log('  cR=' + fmt(s.cR * 100, 3) + '% cT=' + fmt(s.cT * 100, 3) + '% rLen=' + s.rChars + ' tLen=' + s.tChars +
    ' sess=' + s.msg.sessionId + ' slug=' + s.msg.slug + ' mtime=' + info.mtime + ' self=' + info.selfProduced)
}

console.log('')
console.log('================================================================')
console.log('# CONTAMINATION CHECK (self-produced sessions)')
console.log('================================================================')
const selfFiles = infos.filter((f) => f.selfProduced)
console.log('sessions mentioning any of ' + JSON.stringify(SELF_TOKENS) + ' =', selfFiles.length, '/', infos.length)
for (const f of selfFiles) {
  console.log('  ' + f.sessionId + ' slug=' + f.slug + ' origin=' + f.origin + ' depth=' + f.delegationDepth +
    ' cwd=' + JSON.stringify(f.cwd) + ' mtime=' + f.mtime + ' hits=' + JSON.stringify(f.selfHits) +
    ' assistantMsgs=' + f.nAssistantMsgs)
}
const nonSelf = primary.filter((s) => !infos.find((i) => i.file === s.msg.file)!.selfProduced)
console.log('')
console.log('## histogram EXCLUDING self-produced sessions (char-raw cR)')
printHist('char-raw cR non-self', nonSelf, 'cR')
const nsHigh = nonSelf.filter((s) => s.cR >= 0.95)
console.log('  non-self >=95% count =', nsHigh.length)
for (const s of nsHigh) {
  const info = infos.find((i) => i.file === s.msg.file)!
  console.log('   ' + s.msg.sessionId + ' cR=' + fmt(s.cR * 100, 3) + '% rLen=' + s.rChars + ' tLen=' + s.tChars + ' cwd=' + JSON.stringify(s.msg.cwd) + ' mtime=' + info.mtime)
}

console.log('')
console.log('## file anchors (sha256 first16 / mtime / size)')
for (const f of infos) {
  console.log('  ' + f.sha256 + ' ' + f.mtime + ' ' + String(f.bytes).padStart(9) + ' frames=' + f.frames +
    ' amsg=' + f.nAssistantMsgs + ' rmsg=' + f.nReasonMsgs + ' self=' + (f.selfProduced ? 'Y' : 'n') + ' ' + f.file)
}

if (JSON_OUT !== '') {
  const payload = {
    n: N, minReasoning: MIN_REASONING, root: READ_ROOT,
    files: infos, totalMsgs: msgs.length,
    forms: Object.fromEntries(FORMS.map((f) => [f, {
      hist: histogram(allForms[f]!.scores, 'cR'), gap: allForms[f]!.gap,
      scores: allForms[f]!.scores.map((s) => ({ sessionId: s.msg.sessionId, time: s.msg.time, rChars: s.rChars, tChars: s.tChars, cR: s.cR, cT: s.cT, jac: s.jac })),
    }])),
  }
  writeFileSync(JSON_OUT, JSON.stringify(payload, null, 1))
  console.log('\n# json written to ' + JSON_OUT)
}

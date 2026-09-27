/**
 * Cross-channel restate scan - LEAD-run reproduction of the two-layer design's core claim.
 *
 * Verifies: over assistant messages with reasoning >= 1500 chars, the 8-gram Jaccard overlap
 * between the reasoning channel and the visible text channel is bimodal - almost everything
 * below 5%, a handful at exactly 100%, nothing in between.
 *
 * Also reports the two-sided metric the design uses (echoR = share of reasoning 8-grams echoed
 * by text; coverT = share of text 8-grams present in reasoning) and the self-reference
 * classification that decides which catastrophic samples are independent evidence.
 *
 * Run: node packages/guard/stream-guard/tests/verification/restate-scan.mts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = join(process.env['USERPROFILE'] ?? '', '.dsh', 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const M = 8

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

/** v3 logs are MULTI-FRAME zstd: split on magic, decompress each frame, concatenate. */
function decode(file: string): string {
  const buf = readFileSync(file)
  const offs: number[] = []
  let at = buf.indexOf(MAGIC)
  while (at !== -1) { offs.push(at); at = buf.indexOf(MAGIC, at + 4) }
  offs.push(buf.length)
  let text = ''
  for (let i = 0; i < offs.length - 1; i += 1) {
    try { text += zstdDecompressSync(buf.subarray(offs[i], offs[i + 1])).toString('utf8') } catch { /* truncated tail frame */ }
  }
  return text
}

function gramSet(s: string): Set<string> {
  const g = new Set<string>()
  const a = Array.from(s)
  for (let i = 0; i + M <= a.length; i++) g.add(a.slice(i, i + M).join(''))
  return g
}

/** Two-sided overlap. echoR is the discriminating statistic; coverT guards the floor. */
function overlap(reasoning: string, text: string) {
  const A = gramSet(reasoning)
  const B = gramSet(text)
  if (!A.size || !B.size) return { jac: 0, echoR: 0, coverT: 0 }
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return { jac: inter / (A.size + B.size - inter), echoR: inter / A.size, coverT: inter / B.size }
}

const SELF_PROBE = ['stream-guard', 'PrefixGuard', 'FILLER_WORDS', 'LETME_MAX', 'CYCLE_MIN_SPAN', 'src/filler.ts', 'src/prefix.ts', 'src/cycle.ts']

interface Row { key: string; lenR: number; lenT: number; selfHits: number; jac: number; echoR: number; coverT: number }
const rows: Row[] = []
const mtimes = new Map<string, string>()
for (const f of walk(ROOT)) {
  const key = f.split(/[\\/]/).slice(-2)[0] ?? ''
  let text: string
  try { text = decode(f) } catch { continue }
  const selfHits = SELF_PROBE.filter(p => text.includes(p)).length
  mtimes.set(key, statSync(f).mtime.toISOString().slice(0, 16))
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e?.type !== 'assistant/message') continue
    const content = e?.data?.message?.content
    if (!Array.isArray(content)) continue
    let reasoning = '', tx = ''
    for (const b of content) {
      if (b?.type === 'reasoning') reasoning += b.text ?? ''
      else if (b?.type === 'text') tx += b.text ?? ''
    }
    if (reasoning.length < 1500) continue
    rows.push({ key, lenR: reasoning.length, lenT: tx.length, selfHits, ...overlap(reasoning, tx) })
  }
}

console.log('messages with reasoning >= 1500 chars:', rows.length)
const bins = new Array(20).fill(0)
for (const r of rows) bins[Math.min(19, Math.floor(r.jac * 100 / 5))]++
console.log('')
console.log('=== 8-gram Jaccard histogram ===')
for (let i = 0; i < 20; i++) if (bins[i]) console.log(String(i * 5).padStart(3) + '-' + String(i * 5 + 5).padStart(3) + '% :', bins[i])

console.log('')
console.log('=== catastrophic (echoR >= 0.9), classified by self-reference ===')
for (const r of rows.filter(r => r.echoR >= 0.9).sort((a, b) => b.lenT - a.lenT)) {
  const independent = r.selfHits < 3
  console.log((independent ? 'INDEPENDENT  ' : 'SELF-STUDY   ') + 'lenR=' + r.lenR, 'lenT=' + r.lenT,
    'echoR=' + r.echoR.toFixed(3), 'coverT=' + r.coverT.toFixed(3), r.key, mtimes.get(r.key) ?? '')
}
const indep = rows.filter(r => r.echoR >= 0.9 && r.selfHits < 3).length
const selfy = rows.filter(r => r.echoR >= 0.9 && r.selfHits >= 3).length
console.log('')
console.log('independent catastrophic samples:', indep, ' self-study:', selfy)

// Read-only. Fenced code blocks are stripped before scoring, and only MASSIVE
// repetition counts: a code sample legitimately repeats a construct a few times,
// a degenerating model repeats a sentence hundreds or thousands of times.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
const ROOT = 'C:/Users/TRI/.dsh/sessions'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function walk(d: string, dep = 0, out: string[] = []): string[] {
  if (dep > 3) return out
  let es; try { es = readdirSync(d, { withFileTypes: true }) } catch { return out }
  for (const e of es) { const f = join(d, e.name); if (e.isDirectory()) walk(f, dep + 1, out); else if (e.name.endsWith('.jsonl.zstd')) out.push(f) }
  return out
}
function decode(file: string): string {
  const b = readFileSync(file); const o: number[] = []; let at = b.indexOf(MAGIC)
  while (at !== -1) { o.push(at); at = b.indexOf(MAGIC, at + 4) } o.push(b.length)
  let t = ''
  for (let i = 0; i < o.length - 1; i++) { try { t += zstdDecompressSync(b.subarray(o[i], o[i + 1])).toString('utf8') } catch {} }
  return t
}
const FENCE = String.fromCharCode(96).repeat(3)
function stripFences(text: string): string {
  const out: string[] = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith(FENCE)) { inFence = !inFence; continue }
    if (!inFence) out.push(line)
  }
  return out.join('\n')
}
function isProseUnit(s: string): boolean {
  if (s.length < 6) return false
  if (/^[|`\-\s#*>\[\]()0-9._]+$/.test(s)) return false
  return (s.match(/[A-Za-z\u4e00-\u9fff]/g) ?? []).length >= 4
}
const MASSIVE = 20
function worstRepeat(text: string): { n: number; sample: string } {
  const parts = stripFences(text).split(/[\n。！？!?]+/).map(s => s.trim()).filter(isProseUnit)
  const counts = new Map<string, number>()
  let n = 0, sample = ''
  for (const p of parts) { const c = (counts.get(p) ?? 0) + 1; counts.set(p, c); if (c > n) { n = c; sample = p } }
  return { n, sample }
}
type Row = { sess: string; ptc: boolean; turns: number; hit: number; note: string }
const rows: Row[] = []
for (const f of walk(ROOT)) {
  let t; try { t = decode(f) } catch { continue }
  const sess = f.split(/[\\/]/).slice(-2)[0]!
  const ptc = t.includes('tool/ptc-dispatch')
  let lastText: string | null = null, turns = 0, hit = 0, note = ''
  for (const line of t.split('\n')) {
    if (!line.trim()) continue
    let e: any; try { e = JSON.parse(line) } catch { continue }
    const ty = e?.type
    if (ty === 'turn/start') lastText = null
    else if (ty === 'assistant/message') {
      const c = e.data?.message?.content ?? []
      if (c.some((b: any) => b.type === 'tool-call')) { lastText = null; continue }
      const txt = c.filter((b: any) => b.type === 'text').map((b: any) => String(b.text ?? '')).join('').trim()
      lastText = txt.length > 0 ? txt : null
    } else if (ty === 'turn/end' && lastText !== null) {
      turns++
      const r = worstRepeat(lastText)
      if (r.n >= MASSIVE) { hit++; if (note === '') note = 'x' + r.n + ' "' + r.sample.slice(0, 40) + '"' }
    }
  }
  if (turns > 0) rows.push({ sess, ptc, turns, hit, note })
}
const g = rows.reduce((a, r) => { const k = r.ptc ? 'PTC' : 'non-PTC'; a[k] ??= { turns: 0, hit: 0, sess: 0 }; a[k].turns += r.turns; a[k].hit += r.hit; a[k].sess++; return a }, {} as Record<string, { turns: number; hit: number; sess: number }>)
console.log('massive prose repetition (>= ' + MASSIVE + 'x) in a turn-final text:')
console.log('mode      sessions   turns   hits   rate')
for (const k of ['PTC', 'non-PTC']) {
  const v = g[k]; if (v === undefined) continue
  console.log(k.padEnd(9) + String(v.sess).padStart(6) + String(v.turns).padStart(9) + String(v.hit).padStart(7) + '   ' + (100 * v.hit / v.turns).toFixed(2) + '%')
}
console.log('')
for (const r of rows.filter(r => r.hit > 0)) console.log('  ' + (r.ptc ? 'PTC    ' : 'nonPTC ') + r.sess.slice(0, 26) + '  hit=' + r.hit + '/' + r.turns + '  ' + r.note)
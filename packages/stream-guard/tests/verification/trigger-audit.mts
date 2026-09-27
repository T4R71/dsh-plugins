// Correct audit: a REAL brake notice is a plugin-sourced user message event,
// i.e. it carries source.kind='plugin' AND the summary field. Free text in the
// transcript (including this very conversation) must not count.
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
const brakes: { sess: string; summary: string }[] = []
let nudges = 0
for (const f of walk(ROOT)) {
  let t; try { t = decode(f) } catch { continue }
  const sess = f.split(/[\\/]/).slice(-2)[0]!
  for (const line of t.split('\n')) {
    if (!line.trim()) continue
    let e: any; try { e = JSON.parse(line) } catch { continue }
    if (e?.type !== 'user/message') continue
    const src = e?.data?.source
    if (src?.kind !== 'plugin' || src?.plugin !== 'stream-guard') continue
    const s = String(src.summary ?? '')
    if (s.includes('hesitation')) { nudges++; continue }
    brakes.push({ sess, summary: s })
  }
}
console.log('REAL stream-guard brake notices:', brakes.length)
console.log('REAL hesitation nudges:', nudges)
const bySess: Record<string, number> = {}
const byRule: Record<string, number> = {}
for (const b of brakes) {
  bySess[b.sess] = (bySess[b.sess] ?? 0) + 1
  const m = /braked (\w+) on (\w+)/.exec(b.summary)
  if (m) byRule[m[1] + '/' + m[2]] = (byRule[m[1] + '/' + m[2]] ?? 0) + 1
  else byRule['<unparsed> ' + b.summary.slice(0, 40)] = 1
}
console.log('by rule/channel:', JSON.stringify(byRule, null, 1))
console.log('by session:')
for (const [k, v] of Object.entries(bySess).sort((a, b) => b[1] - a[1])) console.log('  ', String(v).padStart(4), k)
// Read-only. Is the PTC excess real, or an artifact of clustering? Turns inside
// one session are not independent, and 7 of the 11 PTC hits come from ONE
// session, so a turn-level test is anti-conservative. Report all three views:
// turn-level Fisher, session-level Fisher, and a cluster permutation test.
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
const ANNOUNCE = /(让我|我来|我先|我现在|接下来我|下面我|然后我)[^。！？!?\n]{2,40}$|\b(Let me|I'?ll|I will|I'?m going to|Next,? I'?ll|Now I'?ll)\b[^.\n]{2,60}$/i
const ASKS_USER = /[?？]|要我|说一声|你觉得|你看|你选|还是先|吗[。！!]*$/
type S = { sess: string; ptc: boolean; turns: number; hits: number }
const sessions: S[] = []
for (const f of walk(ROOT)) {
  let t; try { t = decode(f) } catch { continue }
  const sess = f.split(/[\\/]/).slice(-2)[0]!
  const ptc = t.includes('tool/ptc-dispatch')
  let lastText: string | null = null, turns = 0, hits = 0
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
      const s = lastText.replace(/[。！？!?.,;；、\s]+$/, '')
      if (ANNOUNCE.test(s) && !ASKS_USER.test(s.slice(-160))) hits++
    }
  }
  if (turns > 0) sessions.push({ sess, ptc, turns, hits })
}
function lgamma(x: number): number { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp); let ser = 1.000000000190015; for (let j = 0; j < 6; j++) ser += c[j]! / ++y; return -tmp + Math.log(2.5066282746310005 * ser / x) }
function fisher(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d
  const lp = (k: number): number => lgamma(a + c + 1) - lgamma(k + 1) - lgamma(a + c - k + 1) + lgamma(b + d + 1) - lgamma(a + b - k + 1) - lgamma(c + d - a + k + 1)
  const p0 = Math.exp(lp(a))
  let sum = 0
  const lo = Math.max(0, a - d), hi = Math.min(a + b, a + c)
  for (let k = lo; k <= hi; k++) { const p = Math.exp(lp(k)); if (p <= p0 + 1e-12) sum += p }
  return Math.min(1, sum)
}
const ptc = sessions.filter(s => s.ptc)
const non = sessions.filter(s => !s.ptc)
const sum = (xs: S[], k: 'turns' | 'hits'): number => xs.reduce((n, s) => n + s[k], 0)
const pt = sum(ptc, 'turns'), ph = sum(ptc, 'hits'), nt = sum(non, 'turns'), nh = sum(non, 'hits')
console.log('PTC     sessions=' + ptc.length + '  turns=' + pt + '  hits=' + ph + '  rate=' + (100 * ph / pt).toFixed(1) + '%')
console.log('non-PTC sessions=' + non.length + '  turns=' + nt + '  hits=' + nh + '  rate=' + (100 * nh / nt).toFixed(1) + '%')
console.log('')
console.log('TURN-level Fisher (assumes independent turns, anti-conservative):')
console.log('  p =', fisher(ph, pt - ph, nh, nt - nh).toFixed(4))
const ps = ptc.filter(s => s.hits > 0).length, ns = non.filter(s => s.hits > 0).length
console.log('')
console.log('SESSION-level Fisher (any hit vs none):')
console.log('  PTC ' + ps + '/' + ptc.length + ' vs non-PTC ' + ns + '/' + non.length)
console.log('  p =', fisher(ps, ptc.length - ps, ns, non.length - ns).toFixed(4))
console.log('')
console.log('CLUSTER permutation: shuffle the PTC label across sessions, 20000 draws,')
console.log('compare the pooled turn-level hit rate difference.')
const obs = ph / pt - nh / nt
let seed = 12345
const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
let ge = 0
const labels = sessions.map(s => s.ptc)
for (let it = 0; it < 20000; it++) {
  const idx = labels.map((_, i) => i)
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const tmp = idx[i]!; idx[i] = idx[j]!; idx[j] = tmp }
  let a = 0, an = 0, b = 0, bn = 0
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]!, isP = labels[idx[i]!]!
    if (isP) { a += s.hits; an += s.turns } else { b += s.hits; bn += s.turns }
  }
  if (an === 0 || bn === 0) continue
  if (Math.abs(a / an - b / bn) >= Math.abs(obs) - 1e-12) ge++
}
console.log('  observed diff = ' + (100 * obs).toFixed(1) + ' pp')
console.log('  permutation p =', (ge / 20000).toFixed(4))
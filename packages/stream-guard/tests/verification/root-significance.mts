// Read-only. Root-conversation-level statistics, plus why 4 roots appear where
// the operator counts 2: agent-team teammates may not record parentSession.
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
type Node = { key: string; parent: string | null; origin: string; ptc: boolean; turns: number; hits: number; team: boolean }
const nodes: Node[] = []
const byId = new Map<string, Node>(), byDir = new Map<string, Node>()
for (const f of walk(ROOT)) {
  let t; try { t = decode(f) } catch { continue }
  const dir = f.split(/[\\/]/).slice(-2)[0]!
  const first = t.split('\n').find(l => l.includes('"type":"session"'))
  if (first === undefined) continue
  let meta: any; try { meta = JSON.parse(first) } catch { continue }
  const node: Node = {
    key: String(meta.id ?? dir), parent: meta.parentSession === undefined ? null : String(meta.parentSession),
    origin: String(meta.origin ?? 'unknown'), ptc: t.includes('tool/ptc-dispatch'), turns: 0, hits: 0,
    team: t.includes('agent/team') || t.includes('team/task') || t.includes('tool-agent-team'),
  }
  let lastText: string | null = null
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
      node.turns++
      const s = lastText.replace(/[。！？!?.,;；、\s]+$/, '')
      if (ANNOUNCE.test(s) && !ASKS_USER.test(s.slice(-160))) node.hits++
    }
  }
  nodes.push(node); byId.set(node.key, node); byDir.set(dir, node)
}
const resolve = (p: string): Node | undefined => byId.get(p) ?? byDir.get(p) ?? byId.get(p.replace(/^session-/, '')) ?? byDir.get(p.replace(/^session-/, ''))
const rootOf = (n: Node): Node => { let cur = n, g = 0; while (cur.parent !== null && g++ < 20) { const p = resolve(cur.parent); if (p === undefined || p === cur) break; cur = p } return cur }
const roots = new Map<string, Node[]>()
for (const n of nodes) { const r = rootOf(n); const l = roots.get(r.key) ?? []; l.push(n); roots.set(r.key, l) }
const rows = [...roots.entries()].map(([k, l]) => ({ key: k, team: l.some(n => n.team), ptc: l.some(n => n.ptc), turns: l.reduce((a, n) => a + n.turns, 0), hits: l.reduce((a, n) => a + n.hits, 0), size: l.length }))
console.log('roots with an agent-team marker:', rows.filter(r => r.team).length, 'of', rows.length)
console.log('PTC roots: ' + rows.filter(r => r.ptc).length + ', of which team-marked: ' + rows.filter(r => r.ptc && r.team).length)
console.log('non-PTC roots: ' + rows.filter(r => !r.ptc).length + ', of which team-marked: ' + rows.filter(r => !r.ptc && r.team).length)
console.log('')
function lgamma(x: number): number { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp); let ser = 1.000000000190015; for (let j = 0; j < 6; j++) ser += c[j]! / ++y; return -tmp + Math.log(2.5066282746310005 * ser / x) }
const lchoose = (n: number, k: number): number => lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1)
function fisher(a: number, b: number, c: number, d: number): number {
  const r1 = a + b, r2 = c + d, c1 = a + c, n = a + b + c + d
  const prob = (k: number): number => Math.exp(lchoose(r1, k) + lchoose(r2, c1 - k) - lchoose(n, c1))
  const p0 = prob(a); let sum = 0
  for (let k = Math.max(0, c1 - r2); k <= Math.min(r1, c1); k++) { const p = prob(k); if (p <= p0 * (1 + 1e-9)) sum += p }
  return Math.min(1, sum)
}
const pr = rows.filter(r => r.ptc), nr = rows.filter(r => !r.ptc)
const s = (xs: typeof rows, k: 'turns' | 'hits') => xs.reduce((a, r) => a + r[k], 0)
const pt = s(pr, 'turns'), ph = s(pr, 'hits'), nt = s(nr, 'turns'), nh = s(nr, 'hits')
console.log('ROOT-level rates:  PTC ' + ph + '/' + pt + ' = ' + (100 * ph / pt).toFixed(1) + '%   non-PTC ' + nh + '/' + nt + ' = ' + (100 * nh / nt).toFixed(1) + '%')
const ps = pr.filter(r => r.hits > 0).length, ns = nr.filter(r => r.hits > 0).length
console.log('ROOT-level any-hit: PTC ' + ps + '/' + pr.length + ' vs non-PTC ' + ns + '/' + nr.length)
console.log('  Fisher p = ' + fisher(ps, pr.length - ps, ns, nr.length - ns).toFixed(4))
let seed = 987654321
const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const obs = ph / pt - nh / nt
let ge = 0, iter = 0
const labels = rows.map(r => r.ptc)
for (let it = 0; it < 20000; it++) {
  const idx = labels.map((_, i) => i)
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const tmp = idx[i]!; idx[i] = idx[j]!; idx[j] = tmp }
  let a = 0, an = 0, b = 0, bn = 0
  for (let i = 0; i < rows.length; i++) { const r = rows[i]!, isP = labels[idx[i]!]!; if (isP) { a += r.hits; an += r.turns } else { b += r.hits; bn += r.turns } }
  if (an === 0 || bn === 0) continue
  iter++
  if (Math.abs(a / an - b / bn) >= Math.abs(obs) - 1e-12) ge++
}
console.log('  ROOT-level permutation p = ' + (ge / iter).toFixed(4) + '  (' + iter + ' draws)')
console.log('  observed diff = ' + (100 * obs).toFixed(1) + ' pp')
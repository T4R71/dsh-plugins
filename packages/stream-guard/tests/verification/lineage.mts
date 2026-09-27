// Read-only. Rebuild the audit with the CORRECT statistical unit: the root
// conversation (a user-started session plus every subagent it spawned), not the
// session file. Subagent sessions are nested observations, not independent ones.
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
type Node = {
  key: string; id: string; dir: string; parent: string | null; origin: string
  depth: number; ptc: boolean; turns: number; hits: number
}
const nodes: Node[] = []
const byId = new Map<string, Node>()
const byDir = new Map<string, Node>()
for (const f of walk(ROOT)) {
  let t; try { t = decode(f) } catch { continue }
  const dir = f.split(/[\\/]/).slice(-2)[0]!
  const first = t.split('\n').find(l => l.includes('"type":"session"'))
  if (first === undefined) continue
  let meta: any; try { meta = JSON.parse(first) } catch { continue }
  const id = String(meta.id ?? dir)
  const node: Node = {
    key: id, id, dir, parent: meta.parentSession === undefined ? null : String(meta.parentSession),
    origin: String(meta.origin ?? 'unknown'), depth: Number(meta.delegationDepth ?? 0),
    ptc: t.includes('tool/ptc-dispatch'), turns: 0, hits: 0,
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
  nodes.push(node)
  byId.set(id, node)
  byDir.set(dir, node)
}
const resolve = (p: string): Node | undefined => byId.get(p) ?? byDir.get(p) ?? byId.get(p.replace(/^session-/, '')) ?? byDir.get(p.replace(/^session-/, ''))
const rootOf = (n: Node): Node => { let cur = n, guard = 0; while (cur.parent !== null && guard++ < 20) { const p = resolve(cur.parent); if (p === undefined || p === cur) break; cur = p } return cur }
const roots = new Map<string, Node[]>()
for (const n of nodes) { const r = rootOf(n); const list = roots.get(r.key) ?? []; list.push(n); roots.set(r.key, list) }
console.log('session files parsed:', nodes.length)
console.log('distinct ROOT conversations:', roots.size)
console.log('')
const origins: Record<string, number> = {}
for (const n of nodes) origins[n.origin] = (origins[n.origin] ?? 0) + 1
console.log('origins:', JSON.stringify(origins))
console.log('')
type Root = { key: string; origin: string; size: number; ptc: boolean; turns: number; hits: number }
const rootRows: Root[] = []
for (const [key, list] of roots) {
  const root = list.find(n => n.key === key)!
  rootRows.push({
    key: key.slice(0, 26), origin: root.origin, size: list.length,
    ptc: list.some(n => n.ptc),
    turns: list.reduce((a, n) => a + n.turns, 0),
    hits: list.reduce((a, n) => a + n.hits, 0),
  })
}
const pr = rootRows.filter(r => r.ptc), nr = rootRows.filter(r => !r.ptc)
console.log('ROOT-level view:')
console.log('  PTC roots     = ' + pr.length + '  (subtree sessions=' + pr.reduce((a, r) => a + r.size, 0) + ', turns=' + pr.reduce((a, r) => a + r.turns, 0) + ', hits=' + pr.reduce((a, r) => a + r.hits, 0) + ')')
console.log('  non-PTC roots = ' + nr.length + '  (subtree sessions=' + nr.reduce((a, r) => a + r.size, 0) + ', turns=' + nr.reduce((a, r) => a + r.turns, 0) + ', hits=' + nr.reduce((a, r) => a + r.hits, 0) + ')')
console.log('')
console.log('PTC root conversations in full:')
for (const r of pr.sort((a, b) => b.hits - a.hits)) console.log('  ' + r.key + '  origin=' + r.origin + '  subtree=' + r.size + '  turns=' + r.turns + '  hits=' + r.hits)
console.log('')
console.log('non-PTC roots that produced any hit:')
for (const r of nr.filter(r => r.hits > 0).sort((a, b) => b.hits - a.hits)) console.log('  ' + r.key + '  origin=' + r.origin + '  subtree=' + r.size + '  turns=' + r.turns + '  hits=' + r.hits)
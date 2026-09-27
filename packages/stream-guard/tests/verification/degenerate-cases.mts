// Read-only. The two catastrophic real cases: does the SHIPPING ruleset fire on
// them? Fed one char per delta, per channel, exactly as judge() does.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { AnnounceGuard } from '../../src/announce.ts'
import { RepeatGuard } from '../../src/repeat.ts'
import { EchoGuard } from '../../src/echo.ts'
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
function isProseUnit(s: string): boolean {
  if (s.length < 6) return false
  if (/^[|`\-\s#*>\[\]()0-9._]+$/.test(s)) return false
  return (s.match(/[A-Za-z\u4e00-\u9fff]/g) ?? []).length >= 4
}
function worst(text: string): number {
  const counts = new Map<string, number>()
  let n = 0
  for (const p of text.split(/[\n。！？!?]+/).map(s => s.trim()).filter(isProseUnit)) { const c = (counts.get(p) ?? 0) + 1; counts.set(p, c); if (c > n) n = c }
  return n
}
type Case = { sess: string; text: string; worst: number }
const cases: Case[] = []
for (const f of walk(ROOT)) {
  let t; try { t = decode(f) } catch { continue }
  const sess = f.split(/[\\/]/).slice(-2)[0]!
  for (const line of t.split('\n')) {
    if (!line.trim()) continue
    let e: any; try { e = JSON.parse(line) } catch { continue }
    if (e?.type !== 'assistant/message') continue
    const c = e.data?.message?.content ?? []
    const txt = c.filter((b: any) => b.type === 'text').map((b: any) => String(b.text ?? '')).join('')
    if (txt.length < 200) continue
    const w = worst(txt)
    if (w >= 20) cases.push({ sess, text: txt, worst: w })
  }
}
cases.sort((a, b) => b.worst - a.worst)
console.log('catastrophic blocks found:', cases.length)
for (const c of cases) {
  console.log('')
  console.log('=== ' + c.sess.slice(0, 26) + '  text=' + c.text.length + ' chars  worst-repeat=' + c.worst)
  console.log('    head: ' + JSON.stringify(c.text.slice(0, 70)))
  // Feed it exactly as judge() would, on the text channel.
  const a = new AnnounceGuard()
  const r = new RepeatGuard()
  const e = new EchoGuard()
  let fired: string | null = null
  let at = 0
  for (const ch of c.text) {
    at++
    if (e.feedText(ch) !== null) { fired = 'echo @' + at; break }
    if (r.feed(ch) !== null) { fired = 'repeat @' + at; break }
    const av = a.feed(ch)
    if (av !== null) { fired = 'announce/' + av.kind + ' @' + at + ' (count=' + av.count + ')'; break }
  }
  console.log('    CURRENT RULES -> ' + (fired ?? 'NO FIRE (the block streams to completion)'))
}
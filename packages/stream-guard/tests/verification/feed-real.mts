// Faithful to the plugin: ONE guard instance PER CHANNEL, exactly as `judge()`
// builds them. The earlier version shared a single AnnounceGuard across both
// channels, which made a reasoning verdict visible on the text channel and
// produced verdicts the real plugin cannot produce.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { AnnounceGuard } from '../../src/announce.ts'
import { RepeatGuard } from '../../src/repeat.ts'
import { EchoGuard } from '../../src/echo.ts'
const ROOT = 'C:/Users/TRI/.dsh/sessions'
const BRAKE_REASONING = false
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
type Pair = { sess: string; reasoning: string; text: string }
const pairs: Pair[] = []
for (const f of walk(ROOT)) {
  let t; try { t = decode(f) } catch { continue }
  const sess = f.split(/[\\/]/).slice(-2)[0]!
  for (const line of t.split('\n')) {
    if (!line.trim()) continue
    let e: any; try { e = JSON.parse(line) } catch { continue }
    if (e?.type !== 'assistant/message') continue
    const c = e?.data?.message?.content
    if (!Array.isArray(c)) continue
    let r = '', x = ''
    for (const b of c) {
      if (b?.type === 'reasoning' && typeof b.text === 'string') r += b.text
      if (b?.type === 'text' && typeof b.text === 'string') x += b.text
    }
    if (r.length > 0 || x.length > 0) pairs.push({ sess, reasoning: r, text: x })
  }
}
let fires = 0
const byRule: Record<string, number> = {}
const detail: string[] = []
for (const p of pairs) {
  const a = { reasoning: new AnnounceGuard(), text: new AnnounceGuard() }
  const r = { reasoning: new RepeatGuard(), text: new RepeatGuard() }
  const echoes = new EchoGuard()
  let fired: string | null = null
  let chars = 0
  outer:
  for (const ch of ['reasoning', 'text'] as const) {
    const t = ch === 'reasoning' ? p.reasoning : p.text
    for (const c of t) {
      chars++
      if (ch === 'reasoning') echoes.feedReasoning(c)
      else { if (echoes.feedText(c) !== null) { fired = 'echo'; break outer } }
      if (r[ch].feed(c) !== null) { fired = 'repeat'; break outer }
      const av = a[ch].feed(c)
      if (av !== null) {
        if (ch === 'text' || BRAKE_REASONING || av.kind === 'intent') { fired = 'announce/' + av.kind; break outer }
      }
    }
  }
  if (fired !== null) {
    fires++
    byRule[fired] = (byRule[fired] ?? 0) + 1
    detail.push(fired.padEnd(16) + 'at ' + String(chars).padStart(7) + ' chars  R=' + String(p.reasoning.length).padStart(7) + ' T=' + String(p.text.length).padStart(7) + '  ' + p.sess.slice(0, 22))
  }
}
console.log('assistant messages:', pairs.length)
console.log('=== PER-CHANNEL GUARDS, shipped policy: would brake', fires, 'of', pairs.length, '===')
console.log('by rule:', JSON.stringify(byRule))
for (const d of detail) console.log('  ', d)
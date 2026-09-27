// Read-only. Is there a PRECURSOR before an announce-stop turn? If the stop
// follows a tool error, a rule can target that; if not, only text shape is left.
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
type Turn = {
  stop: boolean; errors: number; calls: number; chars: number
  lastWasError: boolean; afterErrorStep: number
}
const turns: Turn[] = []
for (const f of walk(ROOT)) {
  let t; try { t = decode(f) } catch { continue }
  let calls = 0, errors = 0, chars = 0, lastWasError = false, stepsSinceError = -1, lastText: string | null = null
  for (const line of t.split('\n')) {
    if (!line.trim()) continue
    let e: any; try { e = JSON.parse(line) } catch { continue }
    const ty = e?.type
    if (ty === 'turn/start') { calls = 0; errors = 0; chars = 0; lastWasError = false; stepsSinceError = -1; lastText = null }
    else if (ty === 'tool/call') calls++
    else if (ty === 'tool/result') {
      const c = e.data?.message?.content
      const isErr = Array.isArray(c) && c.some((b: any) => b.isError === true)
      if (isErr) { errors++; lastWasError = true; stepsSinceError = 0 } else if (stepsSinceError >= 0) stepsSinceError++
    } else if (ty === 'assistant/message') {
      const c = e.data?.message?.content ?? []
      chars += c.reduce((n: number, b: any) => n + String(b.text ?? '').length, 0)
      if (c.some((b: any) => b.type === 'tool-call')) { lastText = null; continue }
      const txt = c.filter((b: any) => b.type === 'text').map((b: any) => String(b.text ?? '')).join('').trim()
      lastText = txt.length > 0 ? txt : null
    } else if (ty === 'turn/end' && lastText !== null) {
      const s = lastText.replace(/[。！？!?.,;；、\s]+$/, '')
      const stop = ANNOUNCE.test(s) && !ASKS_USER.test(s.slice(-160))
      turns.push({ stop, errors, calls, chars, lastWasError, afterErrorStep: stepsSinceError })
    }
  }
}
const A = turns.filter(t => t.stop), B = turns.filter(t => !t.stop)
const pct = (n: number, d: number): string => (100 * n / d).toFixed(1) + '%'
console.log('turns that ended actionless:', turns.length)
console.log('  announce-stop : ' + A.length)
console.log('  other         : ' + B.length)
console.log('')
console.log('                      announce-stop     other')
console.log('had any tool error    ' + pct(A.filter(t => t.errors > 0).length, A.length).padStart(12) + pct(B.filter(t => t.errors > 0).length, B.length).padStart(10))
console.log('last step was error   ' + pct(A.filter(t => t.lastWasError).length, A.length).padStart(12) + pct(B.filter(t => t.lastWasError).length, B.length).padStart(10))
console.log('zero tool calls       ' + pct(A.filter(t => t.calls === 0).length, A.length).padStart(12) + pct(B.filter(t => t.calls === 0).length, B.length).padStart(10))
console.log('>=5 tool calls        ' + pct(A.filter(t => t.calls >= 5).length, A.length).padStart(12) + pct(B.filter(t => t.calls >= 5).length, B.length).padStart(10))
const med = (xs: number[]): number => { if (xs.length === 0) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]! }
console.log('median chars          ' + String(med(A.map(t => t.chars))).padStart(12) + String(med(B.map(t => t.chars))).padStart(10))
console.log('median tool calls     ' + String(med(A.map(t => t.calls))).padStart(12) + String(med(B.map(t => t.calls))).padStart(10))
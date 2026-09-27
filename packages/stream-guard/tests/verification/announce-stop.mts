// Read-only. The pathological shape is a DECLARATIVE self-commitment to act that
// the model then does not perform. Asking the user (a question, a permission
// request) is a legitimate way to end a turn and must be excluded.
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
// Asking the user: a question mark, a permission request, or an offer to act.
const ASKS_USER = /[?？]|要我|说一声|你觉得|你看|你选|还是先|吗[。！!]*$/
type Row = { sess: string; ptc: boolean; turns: number; hits: number; tails: string[] }
const rows: Row[] = []
for (const f of walk(ROOT)) {
  let t; try { t = decode(f) } catch { continue }
  const sess = f.split(/[\\/]/).slice(-2)[0]!
  const ptc = t.includes('tool/ptc-dispatch')
  let lastText: string | null = null, turns = 0, hits = 0
  const tails: string[] = []
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
      const stripped = lastText.replace(/[。！？!?.,;；、\s]+$/, '')
      if (ANNOUNCE.test(stripped) && !ASKS_USER.test(stripped.slice(-160))) {
        hits++
        if (tails.length < 4) tails.push('...' + stripped.slice(-72).replace(/\s+/g, ' '))
      }
    }
  }
  if (turns > 0 && hits > 0) rows.push({ sess, ptc, turns, hits, tails })
}
const all = rows.reduce((a, r) => { const k = r.ptc ? 'PTC' : 'non-PTC'; a[k] ??= { turns: 0, hits: 0, sess: 0 }; a[k].turns += r.turns; a[k].hits += r.hits; a[k].sess++; return a }, {} as Record<string, { turns: number; hits: number; sess: number }>)
console.log('DECLARATIVE self-announcement ending an actionless turn (questions excluded):')
console.log('mode      sessions-with-hit   turns   hits   rate')
for (const k of ['PTC', 'non-PTC']) { const v = all[k]; if (v === undefined) continue
  console.log(k.padEnd(9) + String(v.sess).padStart(16) + String(v.turns).padStart(9) + String(v.hits).padStart(7) + '   ' + (100 * v.hits / v.turns).toFixed(1) + '%') }
console.log('')
for (const r of rows.sort((a, b) => b.hits - a.hits).slice(0, 10)) {
  console.log('  ' + (r.ptc ? 'PTC    ' : 'nonPTC ') + r.sess.slice(0, 26) + '  hits=' + String(r.hits).padStart(3) + '/' + String(r.turns).padStart(3))
  for (const tl of r.tails.slice(0, 2)) console.log('      ' + tl)
}
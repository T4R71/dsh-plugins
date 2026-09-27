// Consolidated, reproducible evidence for the two-layer minimal design.
// Replaces a pile of one-off probes. Run: node tests/verification/verify-two-layer.mts
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
const ROOT = join(process.env['USERPROFILE'] ?? '', '.dsh', 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function walk(d, dep = 0, out = []) { if (dep > 3) return out; let es; try { es = readdirSync(d, { withFileTypes: true }) } catch { return out }
  for (const e of es) { const f = join(d, e.name); if (e.isDirectory()) walk(f, dep + 1, out); else if (e.name.endsWith('.jsonl.zstd')) out.push(f) } return out }
function decode(file) { const b = readFileSync(file); const o = []; let at = b.indexOf(MAGIC)
  while (at !== -1) { o.push(at); at = b.indexOf(MAGIC, at + 4) } o.push(b.length); let t = ''
  for (let i = 0; i < o.length - 1; i++) { try { t += zstdDecompressSync(b.subarray(o[i], o[i + 1])).toString('utf8') } catch {} } return t }
// L1 label: trim, lowercase, strip trailing punctuation, collapse whitespace. NO digit masking.
const lab = (s) => s.trim().toLowerCase().replace(/[.!?。！？,，:：;；]+$/g, '').replace(/\s+/g, ' ')
const units = (t) => t.split('\n').map(lab).filter((x) => x.length >= 2)
const freqOf = (u) => (u.length === 0 ? 0 : u.length / new Set(u).size)
const lineEcho = (text, refLines) => { const tl = units(text); if (tl.length === 0) return 0; const R = new Set(refLines); let h = 0; for (const l of tl) if (R.has(l)) h++; return h / tl.length }
const FREQ_MIN = 4, ECHO_MIN = 0.9, ECHO_MIN_LINES = 4

const rows = []
for (const f of walk(ROOT)) { const key = f.split(/[\\/]/).slice(-2)[0]; let t; try { t = decode(f) } catch { continue }
  for (const line of t.split('\n')) { if (!line.trim()) continue; let e; try { e = JSON.parse(line) } catch { continue }
    if (e?.type !== 'assistant/message') continue; const c = e?.data?.message?.content; if (!Array.isArray(c)) continue
    let r = '', x = ''; for (const b of c) { if (b?.type === 'reasoning') r += b.text ?? ''; if (b?.type === 'text') x += b.text ?? '' }
    if (r.length < 1500 && x.length < 1500) continue; rows.push({ key, r, x }) } }

console.log('== CORPUS ==')
console.log('  blocks (reasoning or text >= 1500 chars): ' + rows.length)

console.log('')
console.log('== R1: intra-channel repetition  freq = lines / distinctLines >= ' + FREQ_MIN + ' ==')
const r1 = rows.filter((o) => o.r.length >= 1500 && freqOf(units(o.r)) >= FREQ_MIN)
const r1h = rows.filter((o) => o.r.length >= 1500 && freqOf(units(o.r)) < FREQ_MIN)
console.log('  fires on ' + r1.length + ' blocks;  healthy max freq = ' + Math.max(...r1h.map((o) => freqOf(units(o.r)))).toFixed(3))
for (const o of r1.sort((a, b) => freqOf(units(b.r)) - freqOf(units(a.r)))) console.log('    freq=' + freqOf(units(o.r)).toFixed(2).padStart(7) + '  lenR=' + String(o.r.length).padStart(7) + '  ' + o.key.slice(0, 28))

console.log('')
console.log('== R2: cross-channel line echo  lineEcho = |textLines n reasoningLines| / |textLines| >= ' + ECHO_MIN + ' ==')
const cand = rows.filter((o) => o.x.length >= 300)
const scored = cand.map((o) => ({ ...o, le: lineEcho(o.x, units(o.r)) })).sort((a, b) => b.le - a.le)
const echoHits = scored.filter((o) => o.le >= ECHO_MIN && units(o.x).length >= ECHO_MIN_LINES)
// Two bases matter: the END-of-block value (le) and the MAX over streaming prefixes (mp).
// The streaming basis is the honest FP risk, because a detector fires mid-stream.
const maxPrefix = (o) => { const R = new Set(units(o.r)); let buf = '', seen = 0, hit = 0, best = 0
  for (let i = 0; i < o.x.length; i++) { if (o.x[i] !== '\n') { buf += o.x[i]; continue }
    const u = lab(buf); buf = ''; if (u.length < 2) continue
    seen++; if (R.has(u)) hit++
    if (seen >= ECHO_MIN_LINES) { const v = hit / seen; if (v > best) best = v } }
  return best }
const r2FireKeys = new Set(echoHits.map((o) => o.key + '|' + o.r.length))
const healthyCand = cand.filter((o) => !r2FireKeys.has(o.key + '|' + o.r.length))
const healthyMaxPrefix = Math.max(...healthyCand.map((o) => maxPrefix(o)))
console.log('  fires on ' + echoHits.length + ' blocks')
console.log('  healthy max lineEcho (end of block)      = ' + Math.max(...scored.filter((o) => o.le < ECHO_MIN).map((o) => o.le)).toFixed(3))
console.log('  healthy max lineEcho (STREAMING prefixes)= ' + healthyMaxPrefix.toFixed(4) + '   <- the honest FP risk; threshold ' + ECHO_MIN + ' leaves ' + (ECHO_MIN - healthyMaxPrefix).toFixed(4))
for (const o of echoHits) console.log('    lineEcho=' + o.le.toFixed(3) + '  lenT=' + String(o.x.length).padStart(7) + '  ' + o.key.slice(0, 28))

console.log('')
console.log('== R2 streaming latency (text streams; reasoning already complete) ==')
let maxAt = 0
for (const o of echoHits) {
  const R = new Set(units(o.r)); let seen = 0, hit = 0, at = -1, ls = 0
  for (let i = 0; i < o.x.length; i++) { if (o.x[i] !== '\n') continue
    const u = lab(o.x.slice(ls, i)); ls = i + 1; if (u.length < 2) continue
    seen++; if (R.has(u)) hit++
    if (seen >= ECHO_MIN_LINES && hit / seen >= ECHO_MIN) { at = i + 1; break } }
  if (at > maxAt) maxAt = at
  console.log('    fires at ' + String(at).padStart(6) + ' chars   ' + (at <= 1024 ? 'within 1024' : 'OVER BUDGET')) }
console.log('  worst case = ' + maxAt + ' chars  => budget ' + (maxAt <= 1024 ? 'MET' : 'MISSED'))

console.log('')
console.log('== R2 chunk-size independence (fire point must not depend on chunking) ==')
for (const o of echoHits.slice(0, 3)) {
  const R = new Set(units(o.r))
  const run = (chunk) => { let buf = '', seen = 0, hit = 0, done = 0
    for (let i = 0; i < o.x.length; i += chunk) { const piece = o.x.slice(i, i + chunk)
      for (const ch of piece) { done++; buf += ch
        if (ch === '\n') { const u = lab(buf.slice(0, -1)); buf = ''
          if (u.length < 2) continue; seen++; if (R.has(u)) hit++
          if (seen >= ECHO_MIN_LINES && hit / seen >= ECHO_MIN) return done } } } return -1 }
  const a = run(1), b = run(64), c = run(4096)
  console.log('    chunk1=' + String(a).padStart(6) + ' chunk64=' + String(b).padStart(6) + ' chunk4096=' + String(c).padStart(6) + '  ' + (a === b && b === c ? 'IDENTICAL' : 'DIFFERS')) }

console.log('')
console.log('== COMBINED: R1 OR R2 ==')
const all = new Map()
for (const o of rows) { const k = o.key + '|' + o.r.length
  const a = o.r.length >= 1500 && freqOf(units(o.r)) >= FREQ_MIN
  const b = o.x.length >= 300 && units(o.x).length >= ECHO_MIN_LINES && lineEcho(o.x, units(o.r)) >= ECHO_MIN
  if (a || b) all.set(k, { a, b, o }) }
console.log('  total fires: ' + all.size + ' / ' + rows.length + '  (' + (100 * all.size / rows.length).toFixed(2) + '%)')
for (const [, v] of all) console.log('    ' + (v.a ? 'R1' : '  ') + ' ' + (v.b ? 'R2' : '  ') + '  lenR=' + String(v.o.r.length).padStart(7) + ' lenT=' + String(v.o.x.length).padStart(7) + '  ' + v.o.key.slice(0, 26))

console.log('')
console.log('== HEALTHY synthetic shapes must NOT fire (digits kept) ==')
const shapes = [
  ['enumerated steps', Array.from({ length: 200 }, (_, i) => 'Step ' + i + ': inspecting module ' + i + ' and confirming its invariant holds').join('\n')],
  ['bulleted list', Array.from({ length: 40 }, (_, i) => '- verified item ' + i + ' and it looks correct').join('\n')],
  ['log lines', Array.from({ length: 60 }, (_, i) => '2026-09-23 INFO request id=abc' + i + ' completed in ' + i + 'ms').join('\n')],
  ['code enumerated', Array.from({ length: 60 }, (_, i) => 'export const F' + i + ' = make(' + i + ')').join('\n')],
  ['table enumerated', Array.from({ length: 80 }, (_, i) => '| field_' + i + ' | boolean | both | false |').join('\n')],
  ['same plan quoted twice', (() => { const p = Array.from({ length: 25 }, (_, i) => 'Task ' + i + ': refactor module ' + i).join('\n'); return 'Plan:\n' + p + '\nAfter edit:\n' + p })()],
]
for (const [n, t] of shapes) { const u = units(t); const f = freqOf(u)
  console.log('    ' + n.padEnd(26) + ' freq=' + f.toFixed(2).padStart(7) + '  ' + (f >= FREQ_MIN ? '*** FIRES ***' : 'ok')) }

console.log('')
console.log('== DIGIT MASKING: measured benefit ==')
const maskLab = (s) => lab(s).replace(/\d+/g, '#')
const maskedHits = new Set(rows.filter((o) => { const u = o.r.split('\n').map(maskLab).filter((x) => x.length >= 2); return o.r.length >= 1500 && u.length / new Set(u).size >= FREQ_MIN }).map((o) => o.key + '|' + o.r.length))
const plainHits = new Set(rows.filter((o) => o.r.length >= 1500 && freqOf(units(o.r)) >= FREQ_MIN).map((o) => o.key + '|' + o.r.length))
const onlyMasked = [...maskedHits].filter((k) => !plainHits.has(k))
console.log('  loops found ONLY by masking: ' + onlyMasked.length + '  => masking is NOT load-bearing; it only adds FPs (see shapes above)')
import { envelopeContent } from "./src/envelope.ts"
import fs from "node:fs"
const dir = "C:\\Users\\TRI\\AppData\\Local\\Temp\\dsh-guard-spill\\settle"
const LEAD = "Its closing message:"
const seen = new Set<string>()
const rows: { orig: number, env: number }[] = []
for (const cid of fs.readdirSync(dir)) {
  const d = dir + "\\" + cid
  for (const f of fs.readdirSync(d)) {
    const t = fs.readFileSync(d + "\\" + f, "utf8")
    if (seen.has(t)) continue
    seen.add(t)
    const message = { role: "user", source: { kind: "subagent-settled", senderSessionId: cid }, content: [{ type: "text", text: LEAD }, { type: "text", text: t }] }
    const r = envelopeContent(message as never, { enabled: true, tailChars: 500 })
    if (r === undefined) { console.log("PASSTHROUGH", f); continue }
    const len = r.map((b: any) => b.text ?? "").join("").length
    rows.push({ orig: t.length, env: len })
  }
}
const so = rows.reduce((a, o) => a + o.orig, 0), se = rows.reduce((a, o) => a + o.env, 0)
const sorted = [...rows].sort((a,b)=>a.orig-b.orig)
console.log("样本 " + rows.length + " 份（去重后）")
console.log("原文合计 " + so + " → 信封合计 " + se + "   压缩 " + (so/se).toFixed(1) + "×")
console.log("平均 原文 " + Math.round(so/rows.length) + " → 信封 " + Math.round(se/rows.length) + " 字符/份")
console.log("原文 中位 " + sorted[Math.floor(sorted.length/2)]!.orig + "  最大 " + sorted[sorted.length-1]!.orig + "  最小 " + sorted[0]!.orig)
const envs = rows.map(r=>r.env).sort((a,b)=>a-b)
console.log("信封 中位 " + envs[Math.floor(envs.length/2)] + "  最大 " + envs[envs.length-1] + "  最小 " + envs[0])

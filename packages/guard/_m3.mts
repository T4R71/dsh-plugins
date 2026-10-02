import { envelopeContent } from "./src/envelope.ts"
import fs from "node:fs"
const dir = "C:\\Users\\TRI\\AppData\\Local\\Temp\\dsh-guard-spill\\settle"
const LEAD = "Its closing message:"
const seen = new Set(); const bodies = []
for (const cid of fs.readdirSync(dir)) { const d = dir + "\\" + cid
  for (const f of fs.readdirSync(d)) { const t = fs.readFileSync(d + "\\" + f, "utf8")
    if (seen.has(t)) continue; seen.add(t); bodies.push([cid, t]) } }
for (const k of [0, 500]) {
  let so = 0, se = 0, n = 0, mx = 0
  for (const [cid, t] of bodies) {
    const m = { role: "user", source: { kind: "subagent-settled", senderSessionId: cid }, content: [{ type: "text", text: LEAD }, { type: "text", text: t }] }
    const r = envelopeContent(m, { enabled: true, tailChars: k })
    if (!r) continue
    const len = r.map((b) => b.text ?? "").join("").length
    so += t.length; se += len; n++; mx = Math.max(mx, len)
  }
  console.log("tailChars=" + k + "  " + n + " 份   原文 " + so + " → 信封 " + se + "   压缩 " + (so/se).toFixed(1) + "×   平均 " + Math.round(se/n) + "   最大 " + mx)
}
// 打印一份 tailChars=0 的真实信封
const m0 = { role: "user", source: { kind: "subagent-settled", senderSessionId: "demo" }, content: [{ type: "text", text: LEAD }, { type: "text", text: bodies[0][1] }] }
console.log("\n=== tailChars=0 的真实信封 ===")
console.log(envelopeContent(m0, { enabled: true, tailChars: 0 }).map((b) => b.text ?? "").join(""))

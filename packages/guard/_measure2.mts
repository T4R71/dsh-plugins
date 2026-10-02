import { envelopeContent } from "./src/envelope.ts"
import fs from "node:fs"
const dir = "C:\\Users\\TRI\\AppData\\Local\\Temp\\dsh-guard-spill\\settle"
const LEAD = "Its closing message:"
const seen = new Set()
const out = []
for (const cid of fs.readdirSync(dir)) {
  const d = dir + "\\" + cid
  for (const f of fs.readdirSync(d)) {
    const t = fs.readFileSync(d + "\\" + f, "utf8")
    if (seen.has(t)) continue
    seen.add(t)
    const message = { role: "user", source: { kind: "subagent-settled", senderSessionId: cid }, content: [{ type: "text", text: LEAD }, { type: "text", text: t }] }
    for (const decision of [{ enabled: true, sections: undefined, gistChars: 0 }, { enabled: true, sections: undefined, gistChars: 240 }]) {
      const r = envelopeContent(message, decision)
      if (r === undefined) { out.push({ cid: cid.slice(0,8), g: decision.gistChars, orig: t.length, env: -1 }); continue }
      const len = r.map((b) => b.text ?? "").join("").length
      out.push({ cid: cid.slice(0,8), g: decision.gistChars, orig: t.length, env: len })
    }
  }
}
for (const g of [0, 240]) {
  const rows = out.filter((o) => o.g === g && o.env > 0)
  const so = rows.reduce((a, o) => a + o.orig, 0), se = rows.reduce((a, o) => a + o.env, 0)
  console.log("gistChars=" + g + "  样本 " + rows.length + " 份（透传 " + out.filter((o)=>o.g===g&&o.env<0).length + " 份）")
  console.log("   原文 " + so + " → 信封 " + se + "   压缩 " + (so/se).toFixed(1) + "×   平均 " + Math.round(se/rows.length) + " 字符/份")
}
console.log("")
const s = out.filter((o) => o.g === 240 && o.env > 0).sort((a,b) => b.orig - a.orig)
for (const o of s.slice(0, 6)) console.log("   " + o.cid + "  原文 " + String(o.orig).padStart(6) + "  →  信封 " + String(o.env).padStart(5))

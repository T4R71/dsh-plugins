import { envelopeContent } from "./src/envelope.ts"
import fs from "node:fs"
const dir = "C:\\Users\\TRI\\AppData\\Local\\Temp\\dsh-guard-spill\\settle"
const out = []
for (const cid of fs.readdirSync(dir)) {
  const d = dir + "\\" + cid
  for (const f of fs.readdirSync(d)) {
    const t = fs.readFileSync(d + "\\" + f, "utf8")
    const r = envelopeContent(t, { childId: cid, label: "Background subagent " + cid + " finished and will do no further work unless you send it more.", spillPath: d + "\\" + f, digest: "x".repeat(64) })
    const len = r === undefined ? -1 : r.map((b) => b.text ?? "").join("").length
    out.push({ cid: cid.slice(0,8), orig: t.length, env: len })
  }
}
out.sort((a,b) => b.orig - a.orig)
let so = 0, se = 0
for (const o of out) { so += o.orig; if (o.env > 0) se += o.env }
console.log("样本 " + out.length + " 份结语")
console.log("原文合计 " + so + " 字符  →  信封合计 " + se + " 字符   压缩 " + (so/se).toFixed(1) + "×")
for (const o of out.slice(0, 8)) console.log("   " + o.cid + "  原文 " + String(o.orig).padStart(6) + "  →  信封 " + (o.env < 0 ? "透传(未封装)" : String(o.env).padStart(5)))

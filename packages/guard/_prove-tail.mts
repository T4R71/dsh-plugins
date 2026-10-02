import { envelopeContent } from "./src/envelope.ts"
import fs from "node:fs"
const dir = "C:\\Users\\TRI\\AppData\\Local\\Temp\\dsh-guard-spill\\settle"
const LEAD = "Its closing message:"
let shown = 0
for (const cid of fs.readdirSync(dir)) {
  for (const f of fs.readdirSync(dir + "\\" + cid)) {
    const t = fs.readFileSync(dir + "\\" + cid + "\\" + f, "utf8")
    if (!t.includes("状态：")) continue
    const message = { role: "user", source: { kind: "subagent-settled", senderSessionId: cid }, content: [{ type: "text", text: LEAD }, { type: "text", text: t }] }
    const r = envelopeContent(message as never, { enabled: true, tailChars: 500 })!
    const body = r[r.length-1]!.text as string
    const lines = t.split("\n")
    let idx = -1
    for (let i = lines.length-1; i >= 0; i--) { if (/^\s*状态\s*[:：]\s*(完成|失败)\s*$/.test(lines[i]!)) { idx = i; break } }
    const statusLine = lines[idx]!
    const summary = lines.slice(idx+1).find(l => l.trim() !== "") ?? ""
    console.log(cid.slice(0,8) + "/" + f + "  原文 " + t.length + " 字符")
    console.log("   状态行逐字在信封里: " + body.includes(statusLine) + "   " + JSON.stringify(statusLine))
    console.log("   摘要行逐字在信封里: " + (summary === "" ? "(无)" : String(body.includes(summary))) + "   " + JSON.stringify(summary))
    if (++shown >= 3) process.exit(0)
  }
}
console.log("没有找到含状态行的样本")

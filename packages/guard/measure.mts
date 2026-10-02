import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { envelopeContent as newEnvelope } from './src/envelope.ts'
import { envelopeContent as oldEnvelope } from './baseline-envelope.ts'

const root = 'C:\\Users\\TRI\\AppData\\Local\\Temp\\dsh-guard-spill\\settle'
// Verbatim from packages/task/src/index.ts:2347 and :2380/:2387.
const STATUS_LINE = /^\s*状态\s*[:：]\s*(完成|失败)\s*$/u
function readNodeReplay(body: string): { status: string, summary: string } | undefined {
  const lines = body.split(String.fromCharCode(10))
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const matched = STATUS_LINE.exec(lines[index] ?? '')
    if (matched === null) continue
    const after = lines.slice(index + 1).find(l => l.trim() !== '') ?? ''
    return { status: matched[1] as string, summary: after }
  }
  return undefined
}
function settlement(closing: string, child: string): any {
  return { id: 'm', role: 'user', content: [
    { type: 'text', text: 'Background subagent ' + child + ' finished and will do no further work unless you send it more.' },
    { type: 'text', text: 'Its closing message:' }, { type: 'text', text: closing }],
    source: { kind: 'subagent-settled', form: 'notice', summary: 's', senderSessionId: child } }
}
function bodyOf(out: any[] | undefined): string {
  return out === undefined ? '' : (out[out.length - 1] as any).text as string
}

const files: { child: string, file: string, text: string }[] = []
for (const child of readdirSync(root, { withFileTypes: true })) {
  if (!child.isDirectory() || child.name === 'child-1') continue
  for (const f of readdirSync(join(root, child.name), { withFileTypes: true })) {
    if (!f.isFile()) continue
    files.push({ child: child.name, file: f.name, text: readFileSync(join(root, child.name, f.name), 'utf8') })
  }
}

let oldSum = 0, newSum = 0, closingSum = 0, maxOld = 0, maxNew = 0
let reported = 0, preserved = 0, lost = 0, noReport = 0, bounded = 0
const losses: string[] = []
const samples: string[] = []
for (const entry of files) {
  const closing = entry.text
  const msg = settlement(closing, entry.child)
  const oldBody = bodyOf(oldEnvelope(msg as never, { enabled: true, headLines: 8 }))
  const newBody = bodyOf(newEnvelope(msg as never, { enabled: true, headLines: 8 }))
  oldSum += oldBody.length; newSum += newBody.length; closingSum += closing.length
  maxOld = Math.max(maxOld, oldBody.length); maxNew = Math.max(maxNew, newBody.length)
  const truth = readNodeReplay(closing)
  if (truth === undefined) { noReport += 1; bounded += 1 } else {
    reported += 1
    const seen = readNodeReplay(newBody)
    if (seen !== undefined && seen.status === truth.status && seen.summary === truth.summary) preserved += 1
    else { lost += 1; losses.push(entry.child.slice(0, 8) + ' truth=' + JSON.stringify(truth) + ' seen=' + JSON.stringify(seen)) }
  }
  if (samples.length < 2) samples.push('--- ' + entry.child.slice(0, 8) + ' closing=' + String(closing.length) + ' old=' + String(oldBody.length) + ' new=' + String(newBody.length) + String.fromCharCode(10) + newBody)
}
console.log('realSpillFiles=' + String(files.length))
console.log('closingChars total=' + String(closingSum) + ' avg=' + (closingSum / files.length).toFixed(1))
console.log('OLD default envelope: total=' + String(oldSum) + ' avg=' + (oldSum / files.length).toFixed(1) + ' max=' + String(maxOld))
console.log('NEW default envelope: total=' + String(newSum) + ' avg=' + (newSum / files.length).toFixed(1) + ' max=' + String(maxNew))
console.log('reduction=' + (100 * (1 - newSum / oldSum)).toFixed(1) + '%')
console.log('childrenWithReport=' + String(reported) + ' verdictPreserved=' + String(preserved) + ' LOST=' + String(lost) + ' noReport=' + String(noReport))
for (const l of losses) console.log('LOSS ' + l)
console.log(samples.join(String.fromCharCode(10)))
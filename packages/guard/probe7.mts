import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
const root = 'C:\\Users\\TRI\\AppData\\Local\\Temp\\dsh-guard-spill\\settle'
const STATUS = /^\s*状态\s*[:：]\s*(完成|失败)\s*$/u
const targets = [['d4da863e-6584-4828-b2d4-a4939738acb2','9b325959c1f0fff3.md'], ['12161a5e-344a-46d4-acea-829ec5beef1c','4bf750f11b059f77.md']]
for (const [dir, file] of targets) {
  const text = readFileSync(join(root, dir, file), 'utf8')
  const lines = text.split(String.fromCharCode(10))
  console.log('=== ' + dir + ' chars=' + String(text.length) + ' lines=' + String(lines.length))
  let last = -1
  for (let i = lines.length - 1; i >= 0; i -= 1) if (STATUS.exec(lines[i]) !== null) { last = i; break }
  console.log('lastStatusLine=' + String(last) + ' text=' + JSON.stringify(lines[last]))
  console.log('after=' + JSON.stringify(lines.slice(last + 1, last + 4)))
  console.log('tail6=' + JSON.stringify(lines.slice(-6)))
}
// corpus-wide: how many real spill files have a status line, and what follows it
let total = 0, withStatus = 0
for (const child of readdirSync(root, { withFileTypes: true })) {
  if (!child.isDirectory() || child.name === 'child-1') continue
  for (const file of readdirSync(join(root, child.name), { withFileTypes: true })) {
    if (!file.isFile()) continue
    total += 1
    const lines = readFileSync(join(root, child.name, file.name), 'utf8').split(String.fromCharCode(10))
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (STATUS.exec(lines[i]) === null) continue
      withStatus += 1
      const after = lines.slice(i + 1).find(l => l.trim() !== '')
      console.log('HIT ' + child.name.slice(0, 8) + ' line=' + String(i) + '/' + String(lines.length) + ' head=' + (lines[i] as string).trim() + ' after=' + JSON.stringify(after?.slice(0, 60)))
      break
    }
  }
}
console.log('realFiles=' + String(total) + ' withStatus=' + String(withStatus))
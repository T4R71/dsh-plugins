import { PrefixGuard } from '../../src/prefix.ts'
import { FillerGuard } from '../../src/filler.ts'

const shapes: Record<string, string> = {
  'filler lexicon (Let me write. xN)': 'Let me write.\nWriting.\nProducing.\nOK.\nLet me go.\n'.repeat(50),
  'prefix drift (short intent clauses)': 'Let me read.\nOK.\nProducing.\nLet me write.\nGo.\n'.repeat(50),
  'catastrophic copy (long lines)': 'Now I have everything I need. Let me design the event model carefully so the tool result carries the call id. '.repeat(400),
  'healthy prose': 'The parser splits tokens on whitespace and then verifies the AST shape before emitting the node. '.repeat(50),
}
for (const [name, text] of Object.entries(shapes)) {
  const fg = new FillerGuard(false, 0)
  let fireF = -1
  const chars = Array.from(text)
  for (let i = 0; i < chars.length; i++) {
    if (fg.feed(chars[i]!) !== null) { fireF = i + 1; break }
  }
  const pg = new PrefixGuard()
  let fireP = -1
  for (let i = 0; i < chars.length; i++) {
    if (pg.feed(chars[i]!) !== null) { fireP = i + 1; break }
  }
  console.log(name.padEnd(38), 'filler fires at', String(fireF).padStart(6), '| prefix fires at', String(fireP).padStart(6))
}

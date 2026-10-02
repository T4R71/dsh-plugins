/**
 * Fidelity harness for the settle envelope (throwaway; lives outside src).
 *
 * Prints the byte-exact envelope text for fixed inputs and measures the
 * envelope against every real spilled closing message under
 * `%TEMP%\\dsh-guard-spill\\settle`, so "same as before" and "capped" are both
 * numbers rather than claims.
 *
 * Run: node --import tsx/esm capture.mts
 */
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { envelopeContent, leadingSections, ENVELOPE_SECTIONS } from './src/envelope.ts'

function settlement(closing: string): any {
  return {
    id: 'm1',
    role: 'user',
    content: [
      { type: 'text', text: 'Background subagent child-1 finished and will do no further work unless you send it more.' },
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: closing },
    ],
    source: { kind: 'subagent-settled', form: 'notice', summary: 's', senderSessionId: 'child-1' },
  }
}

function whole(content: any[] | undefined): string {
  return (content ?? []).map(b => (b.type === 'text' ? b.text : '')).join('\n')
}

/** Everything after the harness lead-ins: the bounded part. */
function body(content: any[] | undefined): string {
  const blocks = content ?? []
  return blocks.length === 0 ? '' : (blocks[blocks.length - 1].text as string)
}

const FIXED: Record<string, string> = {
  sections: '## 结论\nshipped it\n\n## 证据\nsrc/a.ts:12\n\n## 判不了\nnone',
  headCapped: '## 结论\nl1\nl2\nl3\nl4\nl5\n\n## 证据\ne1\ne2\n\n## 判不了\nu1',
  prose: 'just prose, no headings at all\nsecond line\nthird line',
  inline: '结论：ok\n\n证据:\na.ts:2',
}

const EXPORT: Record<string, unknown> = {
  envDefault: whole(envelopeContent({ ...settlement(FIXED.sections) } as never,
    { enabled: true, headLines: 8 })),
  envHead2: whole(envelopeContent(settlement(FIXED.sections) as never,
    { enabled: true, headLines: 2 })),
  envProse: whole(envelopeContent(settlement(FIXED.prose) as never, { enabled: true, headLines: 4 })),
  envInline: whole(envelopeContent(settlement(FIXED.inline) as never, { enabled: true, headLines: 8 })),
  sectionsDefault: leadingSections(FIXED.sections, 8),
  sectionsHead2: leadingSections(FIXED.headCapped, 2),
  sectionsInline: leadingSections(FIXED.inline, 8),
}

const corpus = (process.env.SPILL_DIR ?? join(tmpdir(), 'dsh-guard-spill', 'settle'))
const files: string[] = []
for (const child of readdirSync(corpus, { withFileTypes: true })) {
  if (!child.isDirectory()) continue
  for (const file of readdirSync(join(corpus, child.name), { withFileTypes: true })) {
    if (file.isFile()) files.push(join(corpus, child.name, file.name))
  }
}
files.sort()

const rows: { chars: number, bytes: number, sections: number, envelopeDefault: number, bodyDefault: number, gist0body: number }[] = []
let maxDefault = 0
for (const file of files) {
  const closing = readFileSync(file, 'utf8')
  const found = leadingSections(closing, 8, ENVELOPE_SECTIONS)
  const a = envelopeContent(settlement(closing) as never, { enabled: true, headLines: 8 })
  const b = envelopeContent(settlement(closing) as never, { enabled: true, headLines: 8, gistChars: 0, sections: ENVELOPE_SECTIONS })
  const chars = closing.length
  if (chars > maxDefault) maxDefault = chars
  rows.push({
    chars, bytes: Buffer.byteLength(closing, 'utf8'), sections: found.length,
    envelopeDefault: whole(a).length, bodyDefault: body(a).length, gist0body: body(b).length,
  })
}

const sum = (pick: (r: typeof rows[number]) => number): number => rows.reduce((acc, r) => acc + pick(r), 0)
console.log('CORPUS files=' + String(rows.length) + ' totalChars=' + String(sum(r => r.chars))
  + ' totalBytes=' + String(sum(r => r.bytes)))
console.log('CORPUS closingChars avg=' + (sum(r => r.chars) / rows.length).toFixed(1)
  + ' max=' + String(maxDefault))
console.log('CORPUS envelopeDefault avg=' + (sum(r => r.envelopeDefault) / rows.length).toFixed(1)
  + ' total=' + String(sum(r => r.envelopeDefault)))
console.log('CORPUS envelopeBodyDefault avg=' + (sum(r => r.bodyDefault) / rows.length).toFixed(1)
  + ' total=' + String(sum(r => r.bodyDefault)))
console.log('CORPUS matchedSections total=' + String(sum(r => r.sections)) + ' noneMatched='
  + String(rows.filter(r => r.sections === 0).length))
console.log('CORPUS sameBodyWithGist0=' + String(rows.every(r => r.bodyDefault === r.gist0body)))
console.log('BASEJSON ' + JSON.stringify(EXPORT))
if (process.env.DUMP === '1') {
  console.log('--- envDefault ---')
  console.log(EXPORT.envDefault)
  console.log('--- envProse ---')
  console.log(EXPORT.envProse)
}

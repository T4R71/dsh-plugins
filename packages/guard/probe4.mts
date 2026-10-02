import { readFileSync } from 'node:fs'
import { envelopeContent } from './src/envelope.ts'
import assert from 'node:assert/strict'
function settlement(closing: string, childId = 'child-1'): any {
  return { id: 'm1', role: 'user', content: [
    { type: 'text', text: 'Background subagent ' + childId + ' finished and will do no further work unless you send it more.' },
    { type: 'text', text: 'Its closing message:' }, { type: 'text', text: closing } ],
    source: { kind: 'subagent-settled', form: 'notice', summary: 'x', senderSessionId: childId } }
}
function envelopeBody(content: any[] | undefined): string {
  assert.ok(content !== undefined && content.length > 0)
  return (content as any[])[(content as any[]).length - 1].text as string
}
const spec = readFileSync('tests/hooks.spec.ts', 'utf8')
const from = spec.indexOf('function gistText')
const to = spec.indexOf('test(', from)
const src = spec.slice(from, to).replace('function gistText', 'export function gistText')
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
const lines = ['## 结论', 'a'.repeat(20), 'b'.repeat(30), 'c'.repeat(30)]
const body = envelopeBody(envelopeContent(settlement(lines.join(String.fromCharCode(10))) as never, { enabled: true, headLines: 8, gistChars: 30 }))
const gist = mod.gistText(body)
console.log('GIST=' + JSON.stringify(gist))
console.log('EQUAL=' + String(gist === '## 结论' + String.fromCharCode(10) + 'a'.repeat(20)))
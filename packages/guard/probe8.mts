import { envelopeContent } from './src/envelope.ts'
function settlement(closing: string): any {
  return { id: 'm1', role: 'user', content: [
    { type: 'text', text: 'Background subagent child-1 finished.' },
    { type: 'text', text: 'Its closing message:' }, { type: 'text', text: closing } ],
    source: { kind: 'subagent-settled', form: 'notice', summary: 's', senderSessionId: 'child-1' } }
}
const closing = ['first line about the work', 'second line about the work', 'third line'].join(String.fromCharCode(10))
const out = envelopeContent(settlement(closing) as never, { enabled: true, headLines: 8, gistChars: 40 })
console.log('RAW=' + JSON.stringify(out === undefined ? null : out[out.length - 1]))
const body = (out as any[])[(out as any[]).length - 1].text as string
console.log('BODY=' + JSON.stringify(body))
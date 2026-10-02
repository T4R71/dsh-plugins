
import { stripToolDeclarations } from './src/strip.ts'
const cases = {
  'docline_after_member': [
    'interface ToolArgsMap {',
    '  a: { x: string };',
    '  /** doc for b */',
    '  b: { y: string };',
    '}',
    'interface ToolOutputMap {',
    '  a: { x: string };',
    '  b: { y: string };',
    '}',
  ].join('\n'),
  'blank_line_in_body': [
    'interface ToolArgsMap {',
    '  a: { x: string };',
    '',
    '  b: { y: string };',
    '}',
    'interface ToolOutputMap {',
    '  a: { x: string };',
    '  b: { y: string };',
    '}',
  ].join('\n'),
}
for (const [k, text] of Object.entries(cases)) {
  console.log(k, JSON.stringify(stripToolDeclarations(text, ['a'], false)))
}
